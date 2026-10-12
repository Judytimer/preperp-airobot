import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parsePolymarketResolution, type PolymarketResolution } from "./prospective-artifacts.ts";
import {
  PROSPECTIVE_REPORT_SCHEMA_VERSION,
  type ProspectiveSamplingReport
} from "./prospective-runner.ts";

export const PROSPECTIVE_OUTCOME_SCHEMA_VERSION = "2.1.0";
export const POLYMARKET_MARKET_STREAM_URL =
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export type ProspectiveOutcomeArtifact = {
  readonly schemaVersion: typeof PROSPECTIVE_OUTCOME_SCHEMA_VERSION;
  readonly provider: "POLYMARKET_MARKET_RESOLVED";
  readonly sourceUrl: typeof POLYMARKET_MARKET_STREAM_URL;
  readonly sourceTimestamp: number;
  readonly retrievedAt: number;
  readonly rawResponsePath: string;
  readonly sha256: string;
};

export type ProspectiveOutcomeRecord = {
  readonly schemaVersion: typeof PROSPECTIVE_OUTCOME_SCHEMA_VERSION;
  readonly mode: "PROSPECTIVE_OUTCOME";
  readonly status: "MEASURED";
  readonly manifestId: string;
  readonly observationId: string;
  readonly recordedAt: number;
  readonly reportInputDigest: string;
  readonly reportSha256: string;
  readonly inputDigest: string;
  readonly measurementAt: number;
  readonly rule: string;
  readonly rulesUrl: string;
  readonly result: "YES" | "NO";
  readonly source: ProspectiveOutcomeArtifact;
  readonly resolution: PolymarketResolution;
};

export type ProspectiveOutcomeResult = {
  readonly outcomePath: string;
  readonly outcome: ProspectiveOutcomeRecord;
  readonly reused: boolean;
};

export async function recordProspectiveOutcome(
  reportPath: string,
  artifactPath: string,
  outputPath = `${reportPath}.outcome.json`,
  dependencies: { readonly now?: () => number } = {}
): Promise<ProspectiveOutcomeResult> {
  const now = dependencies.now ?? Date.now;
  const [reportRaw, artifactRaw] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(artifactPath, "utf8")
  ]);
  const report = validateReport(parseJson(reportRaw, "prospective report"));
  const artifact = validateOutcomeArtifact(parseJson(artifactRaw, "outcome artifact"));
  const recordedAt = now();
  if (!Number.isFinite(recordedAt) || recordedAt < 0) throw new Error("outcome recording clock is invalid");
  if (recordedAt < report.outcome.measurementAt) {
    throw new Error("outcome cannot be recorded before the frozen measurement time");
  }
  if (artifact.sourceTimestamp < report.outcome.measurementAt) {
    throw new Error("Polymarket resolution predates the frozen measurement time");
  }
  if (artifact.sourceTimestamp > artifact.retrievedAt || artifact.retrievedAt > recordedAt) {
    throw new Error("outcome artifact timestamps move backward or into the future");
  }

  const rawPath = isAbsolute(artifact.rawResponsePath)
    ? artifact.rawResponsePath
    : resolve(dirname(resolve(artifactPath)), artifact.rawResponsePath);
  const raw = await readFile(rawPath);
  const actualSha256 = digest(raw);
  if (actualSha256 !== artifact.sha256) throw new Error("POLYMARKET_MARKET_RESOLVED checksum mismatch");
  const resolution = parsePolymarketResolution(
    raw,
    report.market.marketId,
    report.market.yesTokenId
  );
  if (resolution.sourceTimestamp !== artifact.sourceTimestamp) {
    throw new Error("outcome sourceTimestamp does not match the archived resolution event");
  }

  const reportSha256 = digest(reportRaw);
  const inputDigest = digest([reportRaw, artifactRaw, raw].map(asDigestInput).join("\0"));
  const outcome: ProspectiveOutcomeRecord = {
    schemaVersion: PROSPECTIVE_OUTCOME_SCHEMA_VERSION,
    mode: "PROSPECTIVE_OUTCOME",
    status: "MEASURED",
    manifestId: report.manifestId,
    observationId: report.observationId,
    recordedAt,
    reportInputDigest: report.inputDigest,
    reportSha256,
    inputDigest,
    measurementAt: report.outcome.measurementAt,
    rule: report.outcome.rule,
    rulesUrl: report.outcome.rulesUrl,
    result: resolution.result,
    source: artifact,
    resolution
  };

  const resolvedOutputPath = resolve(outputPath);
  const existing = await readExistingOutcome(resolvedOutputPath);
  if (existing !== null) {
    if (existing.inputDigest !== inputDigest) {
      throw new Error("prospective outcome already exists with different immutable input");
    }
    return { outcomePath: resolvedOutputPath, outcome: existing, reused: true };
  }
  const created = await writeImmutable(resolvedOutputPath, `${JSON.stringify(outcome, null, 2)}\n`);
  if (!created) {
    const raced = await readExistingOutcome(resolvedOutputPath);
    if (raced === null || raced.inputDigest !== inputDigest) {
      throw new Error("prospective outcome was concurrently created with different immutable input");
    }
    return { outcomePath: resolvedOutputPath, outcome: raced, reused: true };
  }
  return { outcomePath: resolvedOutputPath, outcome, reused: false };
}

function validateReport(value: unknown): ProspectiveSamplingReport {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PROSPECTIVE_REPORT_SCHEMA_VERSION ||
    value.mode !== "PROSPECTIVE_PAPER_SAMPLING" ||
    value.status !== "OBSERVED" ||
    typeof value.manifestId !== "string" ||
    typeof value.observationId !== "string" ||
    typeof value.inputDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.inputDigest) ||
    !isRecord(value.formal) ||
    !isRecord(value.market) ||
    typeof value.market.marketId !== "string" ||
    typeof value.market.yesTokenId !== "string" ||
    !isRecord(value.outcome) ||
    !nonNegativeFinite(value.outcome.measurementAt) ||
    typeof value.outcome.rule !== "string" ||
    typeof value.outcome.rulesUrl !== "string"
  ) {
    throw new Error("prospective report is not eligible for outcome recording");
  }
  return value as unknown as ProspectiveSamplingReport;
}

function validateOutcomeArtifact(value: unknown): ProspectiveOutcomeArtifact {
  const allowed = new Set([
    "schemaVersion",
    "provider",
    "sourceUrl",
    "sourceTimestamp",
    "retrievedAt",
    "rawResponsePath",
    "sha256"
  ]);
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("outcome artifact contains unknown fields");
  }
  if (
    value.schemaVersion !== PROSPECTIVE_OUTCOME_SCHEMA_VERSION ||
    value.provider !== "POLYMARKET_MARKET_RESOLVED" ||
    value.sourceUrl !== POLYMARKET_MARKET_STREAM_URL ||
    !nonNegativeFinite(value.sourceTimestamp) ||
    !nonNegativeFinite(value.retrievedAt) ||
    typeof value.rawResponsePath !== "string" ||
    value.rawResponsePath.length === 0 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error("outcome artifact does not match the frozen Polymarket resolution format");
  }
  return value as unknown as ProspectiveOutcomeArtifact;
}

async function readExistingOutcome(path: string): Promise<ProspectiveOutcomeRecord | null> {
  try {
    const value = parseJson(await readFile(path, "utf8"), "existing prospective outcome");
    if (
      !isRecord(value) ||
      value.schemaVersion !== PROSPECTIVE_OUTCOME_SCHEMA_VERSION ||
      value.mode !== "PROSPECTIVE_OUTCOME" ||
      value.status !== "MEASURED" ||
      typeof value.inputDigest !== "string"
    ) {
      throw new Error("existing prospective outcome is invalid");
    }
    return value as unknown as ProspectiveOutcomeRecord;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeImmutable(path: string, body: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx");
    await handle.writeFile(body, "utf8");
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function asDigestInput(value: string | Uint8Array): string {
  return typeof value === "string" ? value : Buffer.from(value).toString("base64");
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function main(): Promise<void> {
  const [reportPath, artifactPath, outputPath] = process.argv.slice(2);
  if (reportPath === undefined || artifactPath === undefined) {
    console.error("usage: npm run prospective:outcome -- <report.json> <resolution-artifact.json> [outcome.json]");
    process.exitCode = 2;
    return;
  }
  const result = await recordProspectiveOutcome(reportPath, artifactPath, outputPath);
  console.log(JSON.stringify({
    status: result.outcome.status,
    result: result.outcome.result,
    outcomePath: result.outcomePath,
    reused: result.reused
  }, null, 2));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
