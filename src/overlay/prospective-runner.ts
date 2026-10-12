import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExecutionEvent } from "../types.ts";
import { MemePredictionOverlayBot } from "./bot.ts";
import { LayaReviewerAdapter } from "./laya-reviewer.ts";
import {
  parseBinanceSpotKlines,
  parsePolymarketLastTrades
} from "./prospective-artifacts.ts";
import {
  evaluateProspectiveManifest,
  PROSPECTIVE_EXECUTION_ASSUMPTION_VERSION,
  PROSPECTIVE_PRIMARY_SLIPPAGE_BPS,
  PROSPECTIVE_SENSITIVITY_SLIPPAGE_BPS,
  type ProspectiveManifest
} from "./prospective-manifest.ts";
import { DeterministicResearchRouter } from "./research.ts";
import { OverlayRiskManager } from "./risk.ts";
import { BoundedShadowRunner } from "./shadow-runner.ts";
import {
  buildFormalOneMinuteV21Snapshots,
  runFormalOneMinuteV21Replay,
  type ClosedSpotCandle,
  type FormalOneMinuteV21ReplayResult,
  type TimedYesPrice
} from "./strategy-lab.ts";
import type {
  Evidence,
  EvidenceSearch,
  OverlayPaperExecutionRecord,
  OverlayRiskDecision,
  PredictionPosition,
  ResearchPlan,
  ShadowRecord,
  ShadowRunner,
  ShadowStartResult,
  TradeCandidate
} from "./types.ts";

export const PROSPECTIVE_OBSERVATION_SCHEMA_VERSION = "2.1.0";
export const PROSPECTIVE_REPORT_SCHEMA_VERSION = "2.1.0";

export type RawArtifactKind = "BINANCE_SPOT_KLINES" | "POLYMARKET_LAST_TRADES";

export type RawArtifactEvidence = {
  readonly kind: RawArtifactKind;
  readonly sourceUrl: string;
  readonly sourceTimestamp: number;
  readonly retrievedAt: number;
  readonly path: string;
  readonly sha256: string;
};

export type ProspectiveObservation = {
  readonly schemaVersion: string;
  readonly observationId: string;
  readonly retrievedAt: number;
  readonly rawArtifacts: readonly RawArtifactEvidence[];
  readonly candles: readonly ClosedSpotCandle[];
  readonly yesPrices: readonly TimedYesPrice[];
  readonly evidence?: readonly Evidence[];
};

export type PaperScenarioRecord = {
  readonly role: "PRIMARY" | "SENSITIVITY";
  readonly slippageBps: number;
  readonly feeModel: "ZERO";
  readonly fillSemantics: "FULL_FILL_LIMITATION";
  readonly events: readonly ExecutionEvent[];
  readonly executions: readonly OverlayPaperExecutionRecord[];
  readonly positions: readonly PredictionPosition[];
};

export type ProspectiveSamplingReport = {
  readonly schemaVersion: typeof PROSPECTIVE_REPORT_SCHEMA_VERSION;
  readonly mode: "PROSPECTIVE_PAPER_SAMPLING";
  readonly status: "OBSERVED" | "DATA_BLOCKED";
  readonly observationId: string;
  readonly manifestId: string;
  readonly recordedAt: number;
  readonly inputDigest: string;
  readonly repositoryCommit: string;
  readonly market: ProspectiveManifest["market"];
  readonly token: ProspectiveManifest["token"];
  readonly sources: ProspectiveManifest["sources"];
  readonly rawArtifacts: readonly RawArtifactEvidence[];
  readonly protocol: {
    readonly formalOneMinuteVersion: string;
    readonly strategyParameters: {
      readonly spotRiseTriggerPct: number;
      readonly exitYesPrice: number;
    };
    readonly riskParameters: { readonly maxRiskBudget: number };
    readonly executionAssumptionVersion: string;
    readonly primarySlippageBps: number;
    readonly sensitivitySlippageBps: readonly number[];
    readonly feeModel: "ZERO";
    readonly fillSemantics: "FULL_FILL_LIMITATION";
  };
  readonly formal: FormalOneMinuteV21ReplayResult | null;
  readonly riskDecision: OverlayRiskDecision | null;
  readonly paperScenarios: readonly PaperScenarioRecord[];
  readonly shadowRecord: ShadowRecord | null;
  readonly outcome: {
    readonly measurementAt: number;
    readonly rule: string;
    readonly rulesUrl: string;
    readonly status: "WAITING_FOR_FROZEN_TIME" | "FROZEN_TIME_REACHED_AWAITING_OUTCOME";
  };
  readonly blockers: readonly string[];
};

export type ProspectiveRunResult = {
  readonly reportPath: string;
  readonly report: ProspectiveSamplingReport;
  readonly reused: boolean;
};

export type ProspectiveRunnerDependencies = {
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
  readonly shadowRunnerFactory?: (record: (value: ShadowRecord) => void) => ShadowRunner;
  readonly shadowDrainTimeoutMs?: number;
};

export async function runProspectiveSamplingFiles(
  manifestPath: string,
  observationPath: string,
  reportDirectory: string,
  dependencies: ProspectiveRunnerDependencies = {}
): Promise<ProspectiveRunResult> {
  const now = dependencies.now ?? Date.now;
  const [manifestRaw, observationRaw] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(observationPath, "utf8")
  ]);
  const manifestValue = parseJson(manifestRaw, "manifest");
  const admission = evaluateProspectiveManifest(manifestValue);
  if (admission.status !== "DATA_READY") {
    throw new Error(`manifest ${admission.status}: ${admission.reasons.join("; ")}`);
  }
  const manifest = manifestValue as ProspectiveManifest;
  const observationValue = parseJson(observationRaw, "observation");
  const observation = validateObservationShape(observationValue);
  const inputDigest = sha256([
    manifestRaw,
    observationRaw,
    ...observation.rawArtifacts.map((artifact) => `${artifact.kind}:${artifact.sha256}`).sort()
  ].join("\0"));
  const reportPath = resolve(
    reportDirectory,
    safeSegment(manifest.manifestId),
    `${safeSegment(observation.observationId)}.json`
  );
  const existing = await readExistingReport(reportPath);
  if (existing !== null) {
    if (existing.inputDigest !== inputDigest) {
      throw new Error("observationId already exists with different immutable input");
    }
    return { reportPath, report: existing, reused: true };
  }
  await mkdir(dirname(reportPath), { recursive: true });
  const lockPath = `${reportPath}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error("observation run is already in progress");
    }
    throw error;
  }
  try {
    const racedExisting = await readExistingReport(reportPath);
    if (racedExisting !== null) {
      if (racedExisting.inputDigest !== inputDigest) {
        throw new Error("observationId already exists with different immutable input");
      }
      return { reportPath, report: racedExisting, reused: true };
    }
    let report: ProspectiveSamplingReport;
    try {
      await verifyDiscoveryArtifact(manifest, manifestPath);
      const derived = await verifyArtifacts(observation, observationPath, manifest);
      const boundObservation: ProspectiveObservation = {
        ...observation,
        candles: derived.candles,
        yesPrices: derived.yesPrices
      };
      validateObservationTimeline(boundObservation, manifest, now());
      report = await executeObservation(
        manifest,
        boundObservation,
        inputDigest,
        now,
        dependencies
      );
    } catch (error) {
      report = baseReport(
        manifest,
        observation,
        inputDigest,
        now(),
        "DATA_BLOCKED",
        [safeError(error)]
      );
    }
    await writeReportAtomically(reportPath, report);
    return { reportPath, report, reused: false };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function executeObservation(
  manifest: ProspectiveManifest,
  observation: ProspectiveObservation,
  inputDigest: string,
  now: () => number,
  dependencies: ProspectiveRunnerDependencies
): Promise<ProspectiveSamplingReport> {
  const candles = observation.candles.filter(
    (candle) => candle.closeTs <= manifest.outcome.measurementAt
  );
  const input = {
    firstDiscoveredAt: manifest.market.discovery.firstDiscoveredAt,
    symbol: manifest.token.symbol,
    totalSupply: manifest.supply.totalSupply,
    marketId: manifest.market.marketId,
    question: manifest.market.question,
    targetFdv: manifest.market.targetFdv,
    candles,
    yesPrices: observation.yesPrices
  };
  const strategyConfig = {
    spotRiseTriggerPct: manifest.protocol.spotRiseTriggerPct,
    exitYesPrice: manifest.protocol.exitYesPrice
  };
  const formal = runFormalOneMinuteV21Replay(input, strategyConfig);
  const report = baseReport(manifest, observation, inputDigest, now(), "OBSERVED", []);
  if (formal.status === "NO_CANDIDATE") {
    return { ...report, formal };
  }

  const riskDecision = new OverlayRiskManager({
    maxRiskBudget: manifest.protocol.maxRiskBudget
  }).evaluate(formal.candidate.signal, 0);
  const snapshots = buildFormalOneMinuteV21Snapshots(input).slice(0, formal.evaluatedSnapshots);
  const shadowRecords: ShadowRecord[] = [];
  const shadowRunner = dependencies.shadowRunnerFactory?.((record) => shadowRecords.push(record)) ??
    createShadowRunner(observation.evidence ?? [], shadowRecords, dependencies.env ?? process.env);

  const primary = await runPaperScenario(
    manifest,
    snapshots,
    PROSPECTIVE_PRIMARY_SLIPPAGE_BPS,
    "PRIMARY",
    shadowRunner
  );
  await shadowRunner.drain(dependencies.shadowDrainTimeoutMs ?? 65_000);
  const sensitivity: PaperScenarioRecord[] = [];
  for (const slippageBps of PROSPECTIVE_SENSITIVITY_SLIPPAGE_BPS) {
    sensitivity.push(await runPaperScenario(
      manifest,
      snapshots,
      slippageBps,
      "SENSITIVITY"
    ));
  }
  return {
    ...report,
    formal,
    riskDecision,
    paperScenarios: [primary, ...sensitivity],
    shadowRecord: shadowRecords[0] ?? unavailableRecord(formal.candidate)
  };
}

async function runPaperScenario(
  manifest: ProspectiveManifest,
  snapshots: ReturnType<typeof buildFormalOneMinuteV21Snapshots>,
  slippageBps: number,
  role: PaperScenarioRecord["role"],
  shadowRunner?: ShadowRunner
): Promise<PaperScenarioRecord> {
  const bot = new MemePredictionOverlayBot({
    spotRiseTriggerPct: manifest.protocol.spotRiseTriggerPct,
    exitYesPrice: manifest.protocol.exitYesPrice,
    maxRiskBudget: manifest.protocol.maxRiskBudget,
    fillDelayMs: 0,
    slippageBps,
    logger: () => undefined,
    shadowRunner
  });
  for (const snapshot of snapshots) await bot.onSnapshot(snapshot);
  await bot.waitForIdle();
  return {
    role,
    slippageBps,
    feeModel: "ZERO",
    fillSemantics: "FULL_FILL_LIMITATION",
    events: bot.getPaperEvents(),
    executions: bot.getExecutionRecords(),
    positions: bot.getPositionRecords()
  };
}

function createShadowRunner(
  evidence: readonly Evidence[],
  records: ShadowRecord[],
  env: NodeJS.ProcessEnv
): ShadowRunner {
  const baseUrl = env.LAYA_BASE_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    return new UnavailableShadowRunner((record) => records.push(record));
  }
  return new BoundedShadowRunner({
    router: new DeterministicResearchRouter(),
    search: new ArchivedEvidenceSearch(evidence),
    reviewer: new LayaReviewerAdapter({
      baseUrl,
      apiKey: env.LAYA_API_KEY?.trim() || undefined,
      timeoutMs: 60_000
    }),
    record: (record) => records.push(record),
    maxInFlight: 1
  });
}

class ArchivedEvidenceSearch implements EvidenceSearch {
  private readonly evidence: readonly Evidence[];

  constructor(evidence: readonly Evidence[]) {
    this.evidence = evidence;
  }

  async search(_candidate: TradeCandidate, plan: ResearchPlan): Promise<readonly Evidence[]> {
    return this.evidence.filter(
      (item) => item.publishedAt >= plan.windowStart && item.publishedAt <= plan.windowEnd
    );
  }
}

class UnavailableShadowRunner implements ShadowRunner {
  private readonly recordSink: (value: ShadowRecord) => void;

  constructor(record: (value: ShadowRecord) => void) {
    this.recordSink = record;
  }

  start(candidate: TradeCandidate): ShadowStartResult {
    this.recordSink(unavailableRecord(candidate));
    return { accepted: true };
  }

  async drain(_timeoutMs: number): Promise<void> {}
}

function unavailableRecord(candidate: TradeCandidate): ShadowRecord {
  return {
    candidateId: candidate.candidateId,
    status: "PROVIDER_UNAVAILABLE",
    completedAt: Date.now(),
    errorCode: "REVIEWER_UNAVAILABLE"
  };
}

function baseReport(
  manifest: ProspectiveManifest,
  observation: ProspectiveObservation,
  inputDigest: string,
  recordedAt: number,
  status: ProspectiveSamplingReport["status"],
  blockers: readonly string[]
): ProspectiveSamplingReport {
  return {
    schemaVersion: PROSPECTIVE_REPORT_SCHEMA_VERSION,
    mode: "PROSPECTIVE_PAPER_SAMPLING",
    status,
    observationId: observation.observationId,
    manifestId: manifest.manifestId,
    recordedAt,
    inputDigest,
    repositoryCommit: manifest.repositoryCommit,
    market: structuredClone(manifest.market),
    token: structuredClone(manifest.token),
    sources: structuredClone(manifest.sources),
    rawArtifacts: structuredClone(observation.rawArtifacts),
    protocol: {
      formalOneMinuteVersion: manifest.protocol.formalOneMinuteVersion,
      strategyParameters: {
        spotRiseTriggerPct: manifest.protocol.spotRiseTriggerPct,
        exitYesPrice: manifest.protocol.exitYesPrice
      },
      riskParameters: { maxRiskBudget: manifest.protocol.maxRiskBudget },
      executionAssumptionVersion: PROSPECTIVE_EXECUTION_ASSUMPTION_VERSION,
      primarySlippageBps: PROSPECTIVE_PRIMARY_SLIPPAGE_BPS,
      sensitivitySlippageBps: [...PROSPECTIVE_SENSITIVITY_SLIPPAGE_BPS],
      feeModel: "ZERO",
      fillSemantics: "FULL_FILL_LIMITATION"
    },
    formal: null,
    riskDecision: null,
    paperScenarios: [],
    shadowRecord: null,
    outcome: {
      measurementAt: manifest.outcome.measurementAt,
      rule: manifest.outcome.rule,
      rulesUrl: manifest.outcome.rulesUrl,
      status: recordedAt < manifest.outcome.measurementAt
        ? "WAITING_FOR_FROZEN_TIME"
        : "FROZEN_TIME_REACHED_AWAITING_OUTCOME"
    },
    blockers
  };
}

function validateObservationShape(value: unknown): ProspectiveObservation {
  if (!isRecord(value)) throw new Error("observation must be a JSON object");
  const credentialPaths = findCredentialFields(value);
  if (credentialPaths.length > 0) {
    throw new Error(`credential fields are forbidden: ${credentialPaths.join(", ")}`);
  }
  if (value.schemaVersion !== PROSPECTIVE_OBSERVATION_SCHEMA_VERSION) {
    throw new Error("unsupported observation schemaVersion");
  }
  if (typeof value.observationId !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.observationId)) {
    throw new Error("observationId must use letters, numbers, dot, underscore, or hyphen");
  }
  if (!nonNegativeFinite(value.retrievedAt)) throw new Error("retrievedAt is invalid");
  if (!Array.isArray(value.rawArtifacts) || !Array.isArray(value.candles) || !Array.isArray(value.yesPrices)) {
    throw new Error("observation arrays are missing");
  }
  const rawArtifacts = value.rawArtifacts.map(validateArtifact);
  const candles = value.candles.map((item) => {
    if (!isRecord(item)) throw new Error("candle is invalid");
    return {
      openTs: nonNegative(item.openTs, "candle.openTs"),
      closeTs: nonNegative(item.closeTs, "candle.closeTs"),
      close: finite(item.close, "candle.close")
    };
  });
  const yesPrices = value.yesPrices.map((item) => {
    if (!isRecord(item)) throw new Error("YES observation is invalid");
    return {
      ts: nonNegative(item.ts, "yesPrice.ts"),
      yesPrice: finite(item.yesPrice, "yesPrice.yesPrice")
    };
  });
  const evidence = value.evidence === undefined ? undefined : validateEvidence(value.evidence);
  return {
    schemaVersion: value.schemaVersion,
    observationId: value.observationId,
    retrievedAt: value.retrievedAt,
    rawArtifacts,
    candles,
    yesPrices,
    evidence
  };
}

function validateArtifact(value: unknown): RawArtifactEvidence {
  if (!isRecord(value)) throw new Error("raw artifact is invalid");
  if (value.kind !== "BINANCE_SPOT_KLINES" && value.kind !== "POLYMARKET_LAST_TRADES") {
    throw new Error("raw artifact kind is invalid");
  }
  if (typeof value.sourceUrl !== "string" || typeof value.path !== "string" || value.path.length === 0) {
    throw new Error("raw artifact locator is invalid");
  }
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error("raw artifact sha256 is invalid");
  }
  return {
    kind: value.kind,
    sourceUrl: value.sourceUrl,
    sourceTimestamp: nonNegative(value.sourceTimestamp, "artifact.sourceTimestamp"),
    retrievedAt: nonNegative(value.retrievedAt, "artifact.retrievedAt"),
    path: value.path,
    sha256: value.sha256
  };
}

function validateEvidence(value: unknown): readonly Evidence[] {
  if (!Array.isArray(value)) throw new Error("evidence must be an array");
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.sourceId !== "string" ||
      typeof item.summary !== "string"
    ) {
      throw new Error("evidence item is invalid");
    }
    return {
      sourceId: item.sourceId,
      publishedAt: finite(item.publishedAt, "evidence.publishedAt"),
      summary: item.summary
    };
  });
}

function validateObservationTimeline(
  observation: ProspectiveObservation,
  manifest: ProspectiveManifest,
  currentTime: number
): void {
  if (observation.retrievedAt > currentTime) throw new Error("observation retrievedAt is in the future");
  if (manifest.registeredAt > currentTime) throw new Error("manifest registeredAt is in the future");
  if (manifest.market.discovery.retrievedAt > currentTime) throw new Error("market discovery retrievedAt is in the future");
  if (observation.retrievedAt < manifest.market.discovery.firstDiscoveredAt) {
    throw new Error("observation retrievedAt is before first market discovery");
  }
  if (observation.candles.some((candle) => candle.closeTs > observation.retrievedAt)) {
    throw new Error("spot candle is later than retrievedAt");
  }
  if (observation.yesPrices.some((point) => point.ts > observation.retrievedAt)) {
    throw new Error("YES observation is later than retrievedAt");
  }
  const spot = artifactByKind(observation, "BINANCE_SPOT_KLINES");
  const yes = artifactByKind(observation, "POLYMARKET_LAST_TRADES");
  if (spot.sourceUrl !== manifest.sources.spot.klinesUrl) throw new Error("spot source URL differs from manifest");
  if (yes.sourceUrl !== manifest.sources.yes.marketDataUrl) throw new Error("YES source URL differs from manifest");
  for (const artifact of observation.rawArtifacts) {
    if (artifact.sourceTimestamp > artifact.retrievedAt || artifact.retrievedAt > observation.retrievedAt) {
      throw new Error(`${artifact.kind} timestamps move backward or into the future`);
    }
  }
  if (Math.max(...observation.candles.map((candle) => candle.closeTs)) > spot.sourceTimestamp) {
    throw new Error("spot artifact source timestamp does not cover candles");
  }
  if (Math.max(...observation.yesPrices.map((point) => point.ts)) > yes.sourceTimestamp) {
    throw new Error("YES artifact source timestamp does not cover observations");
  }
}

async function verifyDiscoveryArtifact(
  manifest: ProspectiveManifest,
  manifestPath: string
): Promise<void> {
  const discovery = manifest.market.discovery;
  const path = isAbsolute(discovery.rawResponsePath)
    ? discovery.rawResponsePath
    : resolve(dirname(resolve(manifestPath)), discovery.rawResponsePath);
  const body = await readFile(path);
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== discovery.sha256) throw new Error("POLYMARKET_GAMMA_DISCOVERY checksum mismatch");
}

async function verifyArtifacts(
  observation: ProspectiveObservation,
  observationPath: string,
  manifest: ProspectiveManifest
): Promise<{
  readonly candles: readonly ClosedSpotCandle[];
  readonly yesPrices: readonly TimedYesPrice[];
}> {
  const spot = artifactByKind(observation, "BINANCE_SPOT_KLINES");
  const yes = artifactByKind(observation, "POLYMARKET_LAST_TRADES");
  const base = dirname(resolve(observationPath));
  const bodies = new Map<RawArtifactKind, Uint8Array>();
  for (const artifact of observation.rawArtifacts) {
    const path = isAbsolute(artifact.path) ? artifact.path : resolve(base, artifact.path);
    const body = await readFile(path);
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== artifact.sha256) throw new Error(`${artifact.kind} checksum mismatch`);
    bodies.set(artifact.kind, body);
  }
  if (manifest.sources.spot.provider !== "BINANCE_SPOT" || manifest.sources.yes.provider !== "POLYMARKET_LAST_TRADE") {
    throw new Error("manifest source providers differ from frozen protocol");
  }
  const candles = parseBinanceSpotKlines(requireBody(bodies, spot.kind));
  const yesPrices = parsePolymarketLastTrades(
    requireBody(bodies, yes.kind),
    manifest.market.yesTokenId
  );
  if (!sameCandles(candles, observation.candles)) {
    throw new Error("structured candles do not exactly match the archived Binance raw artifact");
  }
  if (!sameYesPrices(yesPrices, observation.yesPrices)) {
    throw new Error("structured YES prices do not exactly match the archived Polymarket raw artifact");
  }
  if (candles.at(-1)?.closeTs !== spot.sourceTimestamp) {
    throw new Error("Binance artifact sourceTimestamp does not equal its final raw candle close");
  }
  if (yesPrices.at(-1)?.ts !== yes.sourceTimestamp) {
    throw new Error("Polymarket artifact sourceTimestamp does not equal its final raw YES trade");
  }
  return { candles, yesPrices };
}

function requireBody(
  bodies: ReadonlyMap<RawArtifactKind, Uint8Array>,
  kind: RawArtifactKind
): Uint8Array {
  const body = bodies.get(kind);
  if (body === undefined) throw new Error(`${kind} raw artifact body is missing`);
  return body;
}

function sameCandles(
  left: readonly ClosedSpotCandle[],
  right: readonly ClosedSpotCandle[]
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index];
    return other !== undefined &&
      value.openTs === other.openTs &&
      value.closeTs === other.closeTs &&
      value.close === other.close;
  });
}

function sameYesPrices(
  left: readonly TimedYesPrice[],
  right: readonly TimedYesPrice[]
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index];
    return other !== undefined && value.ts === other.ts && value.yesPrice === other.yesPrice;
  });
}

function artifactByKind(observation: ProspectiveObservation, kind: RawArtifactKind): RawArtifactEvidence {
  const matches = observation.rawArtifacts.filter((artifact) => artifact.kind === kind);
  if (matches.length !== 1) throw new Error(`exactly one ${kind} artifact is required`);
  return matches[0];
}

async function readExistingReport(path: string): Promise<ProspectiveSamplingReport | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      !isRecord(value) ||
      value.schemaVersion !== PROSPECTIVE_REPORT_SCHEMA_VERSION ||
      typeof value.inputDigest !== "string"
    ) {
      throw new Error("invalid report shape");
    }
    return value as ProspectiveSamplingReport;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw new Error("existing prospective report is invalid or unreadable");
  }
}

async function writeReportAtomically(path: string, report: ProspectiveSamplingReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid`);
  return value;
}

function nonNegative(value: unknown, label: string): number {
  const result = finite(value, label);
  if (result < 0) throw new Error(`${label} is invalid`);
  return result;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe.length === 0 || safe === "." || safe === "..") throw new Error("record identifier is unsafe");
  return safe;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown data validation failure";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const CREDENTIAL_FIELDS = new Set([
  "apikey",
  "apisecret",
  "authorization",
  "password",
  "passphrase",
  "privatekey",
  "secret"
]);

function findCredentialFields(value: unknown, path = "$", found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((child, index) => findCredentialFields(child, `${path}[${index}]`, found));
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_FIELDS.has(key.toLowerCase())) found.push(`${path}.${key}`);
    findCredentialFields(child, `${path}.${key}`, found);
  }
  return found;
}

async function main(): Promise<void> {
  const [manifestPath, observationPath, reportDirectory = "reports/prospective-v2.1"] = process.argv.slice(2);
  if (manifestPath === undefined || observationPath === undefined) {
    console.error("usage: npm run strategy-lab:replay -- <manifest.json> <observation.json> [report-directory]");
    process.exitCode = 2;
    return;
  }
  const result = await runProspectiveSamplingFiles(manifestPath, observationPath, reportDirectory);
  console.log(JSON.stringify({
    status: result.report.status,
    formalStatus: result.report.formal?.status ?? null,
    reportPath: result.reportPath,
    reused: result.reused,
    blockers: result.report.blockers
  }, null, 2));
  if (result.report.status === "DATA_BLOCKED") process.exitCode = 2;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
