import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { SimulatedExchange } from "../exchange.ts";
import { runtimeEvidencePath } from "../runtime-paths.ts";
import type { ExecutionEvent } from "../types.ts";
import { PredictionPositionBook } from "./position.ts";
import {
  PRICE_TARGET_POLL_INTERVAL_MS,
  runPriceTargetCollectorCycle,
  synchronizePriceTargetClock
} from "./price-target-collector.ts";
import type { PriceTargetAsset, PriceTargetEpisodeState, PriceTargetManifest } from "./price-target-admission.ts";
import { OverlayRiskManager } from "./risk.ts";
import type { OverlaySignal, PredictionPosition } from "./types.ts";

const DEFAULT_OUTPUT_DIRECTORY = runtimeEvidencePath("price-target-v1");
const DEFAULT_MAX_RISK_BUDGET = 10;

export type ProspectivePaperCandidate = {
  readonly manifestId: string;
  readonly candidateId: string;
  readonly candidateT0: number;
  readonly asset: PriceTargetAsset;
  readonly marketId: string;
  readonly entryBestAsk: number;
  readonly entryBestAskSize: number;
  readonly yesBookObservedAt: number;
};

export type ProspectivePaperSmokeReport = {
  readonly status: "ROUND_TRIP_COMPLETE";
  readonly mode: "PREDICTION_PAPER";
  readonly signalOrigin: "PRICE_TARGET_V1_QUALIFIED_PROSPECTIVE_CANDIDATE";
  readonly closePolicy: "DETERMINISTIC_ENTRY_PRICE_LOOPBACK";
  readonly alphaClaim: false;
  readonly candidate: ProspectivePaperCandidate;
  readonly events: readonly ExecutionEvent[];
  readonly openedPosition: PredictionPosition;
  readonly finalPosition: PredictionPosition;
};

export async function executeProspectivePaperRoundTrip(
  candidate: ProspectivePaperCandidate,
  maxRiskBudget = DEFAULT_MAX_RISK_BUDGET
): Promise<ProspectivePaperSmokeReport> {
  validateCandidate(candidate);
  if (!Number.isFinite(maxRiskBudget) || maxRiskBudget <= 0) throw new Error("maxRiskBudget must be positive");

  const executableBudget = Math.min(maxRiskBudget, candidate.entryBestAsk * candidate.entryBestAskSize);
  const risk = new OverlayRiskManager({ maxRiskBudget: executableBudget });
  const positionBook = new PredictionPositionBook(candidate.marketId);
  const exchange = new SimulatedExchange(0, 0);
  const events: ExecutionEvent[] = [];
  let openedPosition: PredictionPosition | undefined;

  exchange.onExecutionEvent((event) => {
    events.push(structuredClone(event));
    if (event.type !== "FILL") return;
    const position = positionBook.applyFill(event.fill);
    if (event.fill.side === "BUY") openedPosition = position;
  });

  const buySignal: OverlaySignal = {
    action: "BUY_YES",
    marketId: candidate.marketId,
    yesPrice: candidate.entryBestAsk,
    ts: candidate.candidateT0,
    reason: "qualified prospective Price-Target Candidate"
  };
  const entryDecision = risk.evaluate(buySignal, 0);
  if (!entryDecision.approved) throw new Error(`paper entry rejected: ${entryDecision.reason}`);
  await exchange.submit({ clientOrderId: `${candidate.candidateId}-BUY`, request: entryDecision.order });
  await exchange.drain();
  if (openedPosition === undefined || openedPosition.shares <= 0) throw new Error("paper BUY did not open YES exposure");

  const closeSignal: OverlaySignal = {
    action: "SELL_YES",
    marketId: candidate.marketId,
    // This loopback close tests lifecycle only. It deliberately makes no claim
    // about a future executable price or Prediction alpha.
    yesPrice: candidate.entryBestAsk,
    ts: Date.now(),
    reason: "deterministic paper-smoke close; no alpha claim"
  };
  const exitDecision = risk.evaluate(closeSignal, openedPosition.shares);
  if (!exitDecision.approved) throw new Error(`paper exit rejected: ${exitDecision.reason}`);
  await exchange.submit({ clientOrderId: `${candidate.candidateId}-SELL`, request: exitDecision.order });
  await exchange.drain();

  const finalPosition = positionBook.get();
  const acknowledgements = events.filter((event) => event.type === "ORDER_ACK");
  const fills = events.filter((event) => event.type === "FILL");
  if (
    acknowledgements.length !== 2 || fills.length !== 2 || fills[0]?.fill.side !== "BUY" ||
    fills[1]?.fill.side !== "SELL" || finalPosition.shares !== 0 || finalPosition.premiumAtRisk !== 0
  ) throw new Error("prospective Prediction paper round-trip evidence is incomplete");

  return {
    status: "ROUND_TRIP_COMPLETE",
    mode: "PREDICTION_PAPER",
    signalOrigin: "PRICE_TARGET_V1_QUALIFIED_PROSPECTIVE_CANDIDATE",
    closePolicy: "DETERMINISTIC_ENTRY_PRICE_LOOPBACK",
    alphaClaim: false,
    candidate,
    events,
    openedPosition,
    finalPosition
  };
}

export function selectFirstNewCandidate(
  candidates: readonly ProspectivePaperCandidate[],
  armedAt: number,
  allowedAssets: readonly PriceTargetAsset[] = ["BTC", "ETH", "SOL", "XRP"]
): ProspectivePaperCandidate | null {
  if (!Number.isSafeInteger(armedAt) || armedAt < 0) throw new Error("armedAt is invalid");
  const allowed = new Set(allowedAssets);
  return [...candidates]
    .filter((candidate) => candidate.candidateT0 > armedAt && allowed.has(candidate.asset))
    .sort((left, right) => left.candidateT0 - right.candidateT0 || left.candidateId.localeCompare(right.candidateId))[0] ?? null;
}

export async function findFirstNewCandidate(
  outputDirectory: string,
  armedAt: number,
  allowedAssets?: readonly PriceTargetAsset[]
): Promise<ProspectivePaperCandidate | null> {
  const root = resolve(outputDirectory);
  const stateNames = await listJson(resolve(root, "states"));
  const candidates: ProspectivePaperCandidate[] = [];
  for (const stateName of stateNames) {
    const state = JSON.parse(await readFile(resolve(root, "states", stateName), "utf8")) as PriceTargetEpisodeState;
    if (state.status !== "QUALIFIED" || state.candidate === null) continue;
    const manifest = JSON.parse(
      await readFile(resolve(root, "manifests", `${state.manifestId}.json`), "utf8")
    ) as PriceTargetManifest;
    candidates.push({
      manifestId: state.manifestId,
      candidateId: state.candidate.candidateId,
      candidateT0: state.candidate.candidateT0,
      asset: manifest.episode.asset,
      marketId: manifest.registration.selectedMarketId,
      entryBestAsk: state.candidate.entryBestAsk,
      entryBestAskSize: state.candidate.entryBestAskSize,
      yesBookObservedAt: state.candidate.yesBookObservedAt
    });
  }
  return selectFirstNewCandidate(candidates, armedAt, allowedAssets);
}

export async function runProspectivePaperSmoke(
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  pollIntervalMs = PRICE_TARGET_POLL_INTERVAL_MS
): Promise<ProspectivePaperSmokeReport> {
  const clock = await synchronizePriceTargetClock();
  const armedAt = clock.now();
  console.log("[PREDICTION_PAPER_SMOKE_ARMED]", JSON.stringify({
    armedAt,
    source: clock.evidence.source,
    rule: "candidateT0 > armedAt",
    mode: "PREDICTION_PAPER",
    alphaClaim: false
  }));

  for (;;) {
    const cycleStartedAt = Date.now();
    const collector = await runPriceTargetCollectorCycle(outputDirectory);
    console.log("[PREDICTION_PAPER_SMOKE_COLLECTOR]", JSON.stringify({
      recordedAt: collector.recordedAt,
      admission: collector.admission
    }));
    const candidate = await findFirstNewCandidate(outputDirectory, armedAt);
    if (candidate !== null) {
      const report = await executeProspectivePaperRoundTrip(candidate);
      const evidencePath = resolve(outputDirectory, "paper-smoke", `${safeSegment(candidate.candidateId)}.json`);
      await writeImmutable(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
      console.log("[PREDICTION_PAPER_SMOKE_COMPLETE]", JSON.stringify({ ...report, evidencePath }));
      return report;
    }
    const remaining = Math.max(0, pollIntervalMs - (Date.now() - cycleStartedAt));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, remaining));
  }
}

function validateCandidate(candidate: ProspectivePaperCandidate): void {
  if (!candidate.candidateId || !candidate.marketId || !candidate.manifestId) throw new Error("candidate identity is incomplete");
  if (!Number.isSafeInteger(candidate.candidateT0) || candidate.candidateT0 < 0) throw new Error("candidateT0 is invalid");
  if (
    !Number.isFinite(candidate.entryBestAsk) || candidate.entryBestAsk <= 0 || candidate.entryBestAsk >= 1 ||
    !Number.isFinite(candidate.entryBestAskSize) || candidate.entryBestAskSize <= 0
  ) throw new Error("candidate YES entry book is invalid");
  if (!Number.isSafeInteger(candidate.yesBookObservedAt) || candidate.yesBookObservedAt > candidate.candidateT0) {
    throw new Error("candidate YES book is not pre-T0 evidence");
  }
}

async function listJson(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeImmutable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try { await handle.writeFile(body, "utf8"); } finally { await handle.close(); }
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe.length === 0 || safe === "." || safe === "..") throw new Error("candidateId is unsafe");
  return safe;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const outputDirectory = process.argv[2] ?? DEFAULT_OUTPUT_DIRECTORY;
  await runProspectivePaperSmoke(outputDirectory);
}
