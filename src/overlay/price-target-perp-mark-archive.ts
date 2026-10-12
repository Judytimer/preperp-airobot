import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { PriceTargetAsset } from "./price-target-admission.ts";

export const PRICE_TARGET_DIRECTIONAL_STUDY_VERSION = "1.1.0" as const;
export const PRICE_TARGET_DIRECTIONAL_PROTOCOL = "PRICE_TARGET_DIRECTIONAL_STUDY_V1_1_0" as const;
export const PRICE_TARGET_MARK_INTERVAL_MS = 60_000;
export const PRICE_TARGET_MARK_FIRST_ARCHIVE_MAX_LAG_MS = 180_000;
export const PRICE_TARGET_MARK_FETCH_LIMIT = 5;

const STUDY_DIRECTORY = "directional-v1.1";
const MARK_SOURCE = "https://fapi.binance.com/fapi/v1/markPriceKlines";
const ASSETS: readonly PriceTargetAsset[] = ["BTC", "ETH", "SOL"];
const SYMBOLS = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT"
} as const;
const COHORTS = {
  BTC: "PRICE_TARGET_DIRECTIONAL_V1_1_BTC",
  ETH: "PRICE_TARGET_DIRECTIONAL_V1_1_ETH",
  SOL: "PRICE_TARGET_DIRECTIONAL_V1_1_SOL"
} as const;

export type PerpMarkArtifactReference = {
  readonly kind: "BINANCE_PERP_MARK_KLINES";
  readonly sourceUrl: string;
  readonly retrievedAt: number;
  readonly path: string;
  readonly sha256: string;
};

export type PerpMarkActivationManifest = {
  readonly schemaVersion: "1.0.0";
  readonly protocolVersion: typeof PRICE_TARGET_DIRECTIONAL_PROTOCOL;
  readonly studyVersion: typeof PRICE_TARGET_DIRECTIONAL_STUDY_VERSION;
  readonly repositoryCommit: string;
  readonly activatedAt: number;
  readonly candidateBoundary: "candidateT0 > activatedAt";
  readonly markSource: typeof MARK_SOURCE;
  readonly interval: "1m";
  readonly firstArchiveMaxLagMs: typeof PRICE_TARGET_MARK_FIRST_ARCHIVE_MAX_LAG_MS;
  readonly cohorts: typeof COHORTS;
  readonly firstArtifacts: Readonly<Record<PriceTargetAsset, PerpMarkArtifactReference>>;
};

type MarkKline = {
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly closeTime: number;
};

type ArchivedAsset = {
  readonly asset: PriceTargetAsset;
  readonly symbol: string;
  readonly artifact: PerpMarkArtifactReference;
  readonly candleCount: number;
  readonly firstOpenTime: number;
  readonly lastOpenTime: number;
  readonly prospectivelyAdmissibleOpenTimes: readonly number[];
};

export type PerpMarkArchiveSummary = {
  readonly status: "PERP_MARK_CYCLE_RECORDED";
  readonly studyVersion: typeof PRICE_TARGET_DIRECTIONAL_STUDY_VERSION;
  readonly activatedAt: number;
  readonly activationCreated: boolean;
  readonly activationPath: string;
  readonly cyclePath: string;
  readonly assets: readonly ArchivedAsset[];
};

export async function archivePriceTargetPerpMarks(
  collectorRoot: string,
  dependencies: {
    readonly fetcher: typeof fetch;
    readonly now: () => number;
    readonly timeoutMs: number;
    readonly repositoryCommit: string;
  }
): Promise<PerpMarkArchiveSummary> {
  if (!/^[0-9a-f]{40}$/.test(dependencies.repositoryCommit)) throw new Error("repository commit is invalid");
  const root = resolve(collectorRoot, STUDY_DIRECTORY);
  await mkdir(root, { recursive: true });

  const existingActivation = await loadActivation(root);
  const boundary = Math.floor(dependencies.now() / PRICE_TARGET_MARK_INTERVAL_MS) * PRICE_TARGET_MARK_INTERVAL_MS;
  const archived = await Promise.all(ASSETS.map((asset) => archiveAsset(root, asset, boundary, dependencies)));
  if (archived.some((item) => item.prospectivelyAdmissibleOpenTimes.length === 0)) {
    throw new Error("Perp mark cycle has no prospectively admissible closed candle for every asset");
  }

  let activation = existingActivation;
  let activationCreated = false;
  if (activation === null) {
    const activatedAt = Math.max(...archived.map((item) => item.artifact.retrievedAt));
    activation = {
      schemaVersion: "1.0.0",
      protocolVersion: PRICE_TARGET_DIRECTIONAL_PROTOCOL,
      studyVersion: PRICE_TARGET_DIRECTIONAL_STUDY_VERSION,
      repositoryCommit: dependencies.repositoryCommit,
      activatedAt,
      candidateBoundary: "candidateT0 > activatedAt",
      markSource: MARK_SOURCE,
      interval: "1m",
      firstArchiveMaxLagMs: PRICE_TARGET_MARK_FIRST_ARCHIVE_MAX_LAG_MS,
      cohorts: COHORTS,
      firstArtifacts: Object.fromEntries(archived.map((item) => [item.asset, item.artifact])) as Record<PriceTargetAsset, PerpMarkArtifactReference>
    };
    activationCreated = await writeImmutable(activationFile(root), `${JSON.stringify(activation, null, 2)}\n`);
    if (!activationCreated) activation = await requireActivation(root);
  }

  const recordedAt = Math.max(...archived.map((item) => item.artifact.retrievedAt));
  const cycle = {
    schemaVersion: "1.0.0",
    protocolVersion: PRICE_TARGET_DIRECTIONAL_PROTOCOL,
    recordedAt,
    activatedAt: activation.activatedAt,
    repositoryCommit: dependencies.repositoryCommit,
    assets: archived
  };
  const cycleBody = `${JSON.stringify(cycle, null, 2)}\n`;
  const cyclePath = resolve(root, "cycles", `${recordedAt}-${sha256(cycleBody).slice(0, 16)}.json`);
  await writeImmutable(cyclePath, cycleBody);

  return {
    status: "PERP_MARK_CYCLE_RECORDED",
    studyVersion: PRICE_TARGET_DIRECTIONAL_STUDY_VERSION,
    activatedAt: activation.activatedAt,
    activationCreated,
    activationPath: relative(resolve(collectorRoot), activationFile(root)).replaceAll("\\", "/"),
    cyclePath: relative(resolve(collectorRoot), cyclePath).replaceAll("\\", "/"),
    assets: archived
  };
}

export function isDirectionalV1_1CandidateEligible(
  candidateT0: number,
  activation: Pick<PerpMarkActivationManifest, "activatedAt">
): boolean {
  return Number.isSafeInteger(candidateT0) && candidateT0 > activation.activatedAt;
}

async function archiveAsset(
  root: string,
  asset: PriceTargetAsset,
  boundary: number,
  dependencies: {
    readonly fetcher: typeof fetch;
    readonly now: () => number;
    readonly timeoutMs: number;
  }
): Promise<ArchivedAsset> {
  const symbol = SYMBOLS[asset];
  const url = `${MARK_SOURCE}?symbol=${symbol}&interval=1m&endTime=${boundary - 1}&limit=${PRICE_TARGET_MARK_FETCH_LIMIT}`;
  const response = await dependencies.fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(dependencies.timeoutMs)
  });
  if (!response.ok) throw new Error(`Binance Futures ${asset} mark klines HTTP ${response.status}`);
  const raw = await response.text();
  const retrievedAt = dependencies.now();
  const candles = parseMarkKlines(raw, retrievedAt);
  if (candles.length === 0) throw new Error(`Binance Futures ${asset} mark klines are empty`);
  const digest = sha256(raw);
  const path = resolve(root, "raw", "perp-mark", asset, `${retrievedAt}-${digest.slice(0, 16)}.json`);
  await writeImmutable(path, raw);
  const artifact: PerpMarkArtifactReference = {
    kind: "BINANCE_PERP_MARK_KLINES",
    sourceUrl: url,
    retrievedAt,
    path: relative(root, path).replaceAll("\\", "/"),
    sha256: digest
  };
  return {
    asset,
    symbol,
    artifact,
    candleCount: candles.length,
    firstOpenTime: candles[0]!.openTime,
    lastOpenTime: candles.at(-1)!.openTime,
    prospectivelyAdmissibleOpenTimes: candles
      .filter((candle) => {
        const lag = retrievedAt - candle.closeTime;
        return lag >= 0 && lag <= PRICE_TARGET_MARK_FIRST_ARCHIVE_MAX_LAG_MS;
      })
      .map((candle) => candle.openTime)
  };
}

function parseMarkKlines(raw: string, retrievedAt: number): MarkKline[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Binance Futures mark klines are not valid JSON"); }
  if (!Array.isArray(value)) throw new Error("Binance Futures mark klines must be an array");
  const candles = value.map((row, index) => {
    if (!Array.isArray(row) || row.length < 7) throw new Error(`mark kline ${index} is malformed`);
    const openTime = timestamp(row[0], `mark kline ${index} openTime`);
    const closeTime = timestamp(row[6], `mark kline ${index} closeTime`);
    const candle = {
      openTime,
      open: positiveNumber(row[1], `mark kline ${index} open`),
      high: positiveNumber(row[2], `mark kline ${index} high`),
      low: positiveNumber(row[3], `mark kline ${index} low`),
      close: positiveNumber(row[4], `mark kline ${index} close`),
      closeTime
    };
    if (closeTime !== openTime + PRICE_TARGET_MARK_INTERVAL_MS - 1) throw new Error(`mark kline ${index} is not a closed 1m candle`);
    if (closeTime >= retrievedAt) throw new Error(`mark kline ${index} was not closed before retrieval`);
    if (candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close) || candle.low > candle.high) {
      throw new Error(`mark kline ${index} OHLC is inconsistent`);
    }
    return candle;
  }).sort((left, right) => left.openTime - right.openTime);
  const seen = new Set<number>();
  for (const candle of candles) {
    if (seen.has(candle.openTime)) throw new Error("mark klines contain duplicate openTime");
    seen.add(candle.openTime);
  }
  return candles;
}

async function loadActivation(root: string): Promise<PerpMarkActivationManifest | null> {
  try {
    const activation = JSON.parse(await readFile(activationFile(root), "utf8")) as unknown;
    return await validateActivation(root, activation);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function requireActivation(root: string): Promise<PerpMarkActivationManifest> {
  const activation = await loadActivation(root);
  if (activation === null) throw new Error("Perp mark activation manifest disappeared");
  return activation;
}

async function validateActivation(root: string, value: unknown): Promise<PerpMarkActivationManifest> {
  if (!isRecord(value)) throw new Error("Perp mark activation manifest is malformed");
  if (
    value.schemaVersion !== "1.0.0" || value.protocolVersion !== PRICE_TARGET_DIRECTIONAL_PROTOCOL ||
    value.studyVersion !== PRICE_TARGET_DIRECTIONAL_STUDY_VERSION || value.candidateBoundary !== "candidateT0 > activatedAt" ||
    value.markSource !== MARK_SOURCE || value.interval !== "1m" ||
    value.firstArchiveMaxLagMs !== PRICE_TARGET_MARK_FIRST_ARCHIVE_MAX_LAG_MS ||
    !Number.isSafeInteger(value.activatedAt) || !/^[0-9a-f]{40}$/.test(String(value.repositoryCommit)) ||
    !isRecord(value.cohorts) || value.cohorts.BTC !== COHORTS.BTC || value.cohorts.ETH !== COHORTS.ETH ||
    value.cohorts.SOL !== COHORTS.SOL || !isRecord(value.firstArtifacts)
  ) throw new Error("Perp mark activation manifest violates frozen v1.1.0");
  const retrievals: number[] = [];
  for (const asset of ASSETS) retrievals.push(await verifyArtifact(root, asset, value.firstArtifacts[asset]));
  if (value.activatedAt !== Math.max(...retrievals)) throw new Error("Perp mark activation timestamp does not match first artifacts");
  return value as PerpMarkActivationManifest;
}

async function verifyArtifact(root: string, asset: PriceTargetAsset, value: unknown): Promise<number> {
  if (
    !isRecord(value) || value.kind !== "BINANCE_PERP_MARK_KLINES" || typeof value.path !== "string" ||
    typeof value.sourceUrl !== "string" || !value.sourceUrl.startsWith(`${MARK_SOURCE}?symbol=${SYMBOLS[asset]}&interval=1m&`) ||
    !Number.isSafeInteger(value.retrievedAt) || !/^[0-9a-f]{64}$/.test(String(value.sha256))
  ) {
    throw new Error("Perp mark activation artifact is malformed");
  }
  const path = resolve(root, value.path);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("Perp mark artifact path escapes study root");
  const raw = await readFile(path);
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== value.sha256) throw new Error("Perp mark artifact checksum mismatch");
  const candles = parseMarkKlines(raw.toString("utf8"), value.retrievedAt as number);
  const timely = candles.some((candle) => {
    const lag = (value.retrievedAt as number) - candle.closeTime;
    return lag >= 0 && lag <= PRICE_TARGET_MARK_FIRST_ARCHIVE_MAX_LAG_MS;
  });
  if (!timely) throw new Error("Perp mark activation artifact has no timely candle");
  return value.retrievedAt as number;
}

function activationFile(root: string): string {
  return resolve(root, "activation.json");
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

function positiveNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function timestamp(value: unknown, label: string): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
