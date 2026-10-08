import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runtimeEvidencePath } from "../runtime-paths.ts";

export const POLYMARKET_LEGACY_DISCOVERY_SOURCE_URL =
  "https://gamma-api.polymarket.com/markets?closed=false&limit=100&order=createdAt&ascending=false";
export const POLYMARKET_DISCOVERY_SOURCE_URL =
  "https://gamma-api.polymarket.com/public-search?q=FDV&limit_per_type=50&events_status=active&page=1";
export const POLYMARKET_CRYPTO_TAG_ID = "21";
export const PROSPECTIVE_DISCOVERY_SCHEMA_VERSION = "2.1.1";
export const PROSPECTIVE_DISCOVERY_LEGACY_SCHEMA_VERSION = "2.1.0";

type DiscoverySchemaVersion =
  | typeof PROSPECTIVE_DISCOVERY_SCHEMA_VERSION
  | typeof PROSPECTIVE_DISCOVERY_LEGACY_SCHEMA_VERSION;
type DiscoverySourceUrl =
  | typeof POLYMARKET_DISCOVERY_SOURCE_URL
  | typeof POLYMARKET_LEGACY_DISCOVERY_SOURCE_URL;

type LegacyAcquisitionClock = {
  readonly basis: "POLYMARKET_HTTP_DATE";
  readonly sourceDate: number;
  readonly localRequestStartedAt: number;
  readonly localResponseReceivedAt: number;
  readonly midpointOffsetMs: number;
};

type ActiveAcquisitionClock = {
  readonly basis: "POLYMARKET_HTTP_DATE_PLUS_AGE";
  readonly sourceDate: number;
  readonly responseAgeSeconds: number;
  readonly localRequestStartedAt: number;
  readonly localResponseReceivedAt: number;
  readonly midpointOffsetMs: number;
};

export type DiscoveryDisposition =
  | "POTENTIAL_FDV_REVIEW"
  | "IGNORED_NON_FDV_TEXT"
  | "DATA_BLOCKED";

export type MarketDiscoveryRecord = {
  readonly schemaVersion: DiscoverySchemaVersion;
  readonly marketId: string;
  readonly question: string;
  readonly slug: string | null;
  readonly disposition: DiscoveryDisposition;
  readonly reason: string;
  readonly registeredAt: number;
  readonly market: {
    readonly createdAt: number | null;
    readonly openedAt: number | null;
    readonly updatedAt: number | null;
    readonly active: boolean | null;
    readonly closed: boolean | null;
    readonly acceptingOrders: boolean | null;
    readonly enableOrderBook: boolean | null;
    readonly endDate: number | null;
  };
  readonly discovery: {
    readonly provider: "POLYMARKET_GAMMA";
    readonly firstDiscoveredAt: number;
    readonly sourceUrl: DiscoverySourceUrl;
    readonly sourceTimestamp: number | null;
    readonly retrievedAt: number;
    readonly rawResponsePath: string;
    readonly sha256: string;
  };
  readonly acquisitionClock?: LegacyAcquisitionClock | ActiveAcquisitionClock;
};

export type DiscoveryScanRecord = {
  readonly schemaVersion: typeof PROSPECTIVE_DISCOVERY_SCHEMA_VERSION;
  readonly mode: "POLYMARKET_GAMMA_FDV_CRYPTO_DISCOVERY";
  readonly scanId: string;
  readonly sourceUrl: typeof POLYMARKET_DISCOVERY_SOURCE_URL;
  readonly retrievedAt: number;
  readonly rawResponsePath: string;
  readonly sha256: string;
  readonly acquisitionClock: ActiveAcquisitionClock;
  readonly coverage: {
    readonly ordering: "POLYMARKET_SEARCH_RELEVANCE";
    readonly limit: 50;
    readonly exhaustive: false;
  };
  readonly observedMarkets: number;
  readonly newDiscoveries: number;
  readonly potentialFdvReviews: number;
  readonly blockedDiscoveries: number;
  readonly markets: readonly {
    readonly marketId: string;
    readonly isNew: boolean;
    readonly disposition: DiscoveryDisposition;
    readonly recordPath: string;
  }[];
};

export type DiscoveryScanResult = {
  readonly scanPath: string;
  readonly rawPath: string;
  readonly scan: DiscoveryScanRecord;
};

export type DiscoveryDependencies = {
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly scanIdFactory?: () => string;
};

export async function runPolymarketDiscoveryScan(
  outputDirectory: string,
  dependencies: DiscoveryDependencies = {}
): Promise<DiscoveryScanResult> {
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.timeoutMs ?? 15_000;
  const scanIdFactory = dependencies.scanIdFactory ?? randomUUID;
  const localRequestStartedAt = now();
  const response = await fetcher(POLYMARKET_DISCOVERY_SOURCE_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Polymarket Gamma discovery HTTP ${response.status}`);
  const raw = await response.text();
  const localResponseReceivedAt = now();
  if (!Number.isFinite(localRequestStartedAt) || !Number.isFinite(localResponseReceivedAt)) {
    throw new Error("local discovery clock is invalid");
  }
  if (localResponseReceivedAt < localRequestStartedAt) throw new Error("local discovery clock moved backward");
  const sourceDate = httpDate(response.headers.get("date"));
  if (sourceDate === null) throw new Error("Polymarket Gamma response Date header is missing or invalid");
  const responseAgeSeconds = httpAge(response.headers.get("age"));
  if (responseAgeSeconds === null) throw new Error("Polymarket Gamma response Age header is invalid");
  const retrievedAt = sourceDate + (responseAgeSeconds * 1_000);
  if (!Number.isSafeInteger(retrievedAt)) throw new Error("Polymarket Gamma effective response time is invalid");
  const acquisitionClock: ActiveAcquisitionClock = {
    basis: "POLYMARKET_HTTP_DATE_PLUS_AGE",
    sourceDate,
    responseAgeSeconds,
    localRequestStartedAt,
    localResponseReceivedAt,
    midpointOffsetMs: retrievedAt - ((localRequestStartedAt + localResponseReceivedAt) / 2)
  };
  const payload = parseFdvCryptoSearch(raw);
  const digest = sha256(raw);
  const root = resolve(outputDirectory);
  const rawPath = resolve(root, "raw", `${retrievedAt}-${digest.slice(0, 16)}.json`);

  // Validate the complete provider payload before publishing any first-discovery
  // record. A malformed later row must not leave a partially admitted scan.
  const parsedMarkets = payload.map((value) =>
    parseMarket(value, retrievedAt, rawPath, root, digest, acquisitionClock)
  );
  await writeImmutable(rawPath, raw);

  const markets: Array<DiscoveryScanRecord["markets"][number]> = [];
  let newDiscoveries = 0;
  let potentialFdvReviews = 0;
  let blockedDiscoveries = 0;
  for (const parsed of parsedMarkets) {
    const recordPath = resolve(root, "markets", `${safeSegment(parsed.marketId)}.json`);
    const existing = await readDiscovery(recordPath);
    let record: MarketDiscoveryRecord;
    let isNew = false;
    if (existing === null) {
      const created = await writeImmutable(recordPath, `${JSON.stringify(parsed, null, 2)}\n`);
      if (created) {
        record = parsed;
        isNew = true;
        newDiscoveries += 1;
      } else {
        record = await requireDiscovery(recordPath);
      }
    } else {
      record = existing;
    }
    if (record.disposition === "POTENTIAL_FDV_REVIEW") potentialFdvReviews += 1;
    if (record.disposition === "DATA_BLOCKED") blockedDiscoveries += 1;
    markets.push({
      marketId: record.marketId,
      isNew,
      disposition: record.disposition,
      recordPath: relative(root, recordPath).replaceAll("\\", "/")
    });
  }

  const scanNonce = safeSegment(scanIdFactory());
  const scanId = `${retrievedAt}-${scanNonce}`;
  const scanPath = resolve(root, "scans", `${scanId}.json`);
  const scan: DiscoveryScanRecord = {
    schemaVersion: PROSPECTIVE_DISCOVERY_SCHEMA_VERSION,
    mode: "POLYMARKET_GAMMA_FDV_CRYPTO_DISCOVERY",
    scanId,
    sourceUrl: POLYMARKET_DISCOVERY_SOURCE_URL,
    retrievedAt,
    rawResponsePath: relative(dirname(scanPath), rawPath).replaceAll("\\", "/"),
    sha256: digest,
    acquisitionClock,
    coverage: { ordering: "POLYMARKET_SEARCH_RELEVANCE", limit: 50, exhaustive: false },
    observedMarkets: payload.length,
    newDiscoveries,
    potentialFdvReviews,
    blockedDiscoveries,
    markets
  };
  const created = await writeImmutable(scanPath, `${JSON.stringify(scan, null, 2)}\n`);
  if (!created) throw new Error(`discovery scan id collision: ${scanId}`);
  return { scanPath, rawPath, scan };
}

function parseMarket(
  value: unknown,
  retrievedAt: number,
  rawPath: string,
  root: string,
  digest: string,
  acquisitionClock: ActiveAcquisitionClock
): MarketDiscoveryRecord {
  if (!isRecord(value) || !nonEmptyString(value.id)) {
    throw new Error("Gamma response contains a market without an id");
  }
  const question = nonEmptyString(value.question) ? value.question : "UNAVAILABLE";
  const slug = nonEmptyString(value.slug) ? value.slug : null;
  const createdAt = dateTime(value.createdAt);
  const updatedAt = dateTime(value.updatedAt);
  const openedAt = dateTime(value.acceptingOrdersTimestamp) ?? dateTime(value.startDate);
  const endDate = dateTime(value.endDate);
  const blockers: string[] = [];
  if (question === "UNAVAILABLE") blockers.push("question is missing");
  if (createdAt === null) blockers.push("createdAt is missing or invalid");
  if (updatedAt === null) blockers.push("updatedAt is missing or invalid");
  if (updatedAt !== null && updatedAt > retrievedAt) blockers.push("updatedAt is after retrievedAt");
  const fdvText = `${question}\n${nonEmptyString(value.description) ? value.description : ""}`;
  const isPotentialFdv = /\bfdv\b|fully[ -]diluted (?:valuation|value)/i.test(fdvText);
  const disposition: DiscoveryDisposition = blockers.length > 0
    ? "DATA_BLOCKED"
    : isPotentialFdv
      ? "POTENTIAL_FDV_REVIEW"
      : "IGNORED_NON_FDV_TEXT";
  const reason = blockers.length > 0
    ? blockers.join("; ")
    : isPotentialFdv
      ? "question or rules contain an explicit FDV phrase; manual v2.1 admission review required"
      : "no explicit FDV phrase in question or rules";
  return {
    schemaVersion: PROSPECTIVE_DISCOVERY_SCHEMA_VERSION,
    marketId: value.id,
    question,
    slug,
    disposition,
    reason,
    registeredAt: retrievedAt,
    market: {
      createdAt,
      openedAt,
      updatedAt,
      active: nullableBoolean(value.active),
      closed: nullableBoolean(value.closed),
      acceptingOrders: nullableBoolean(value.acceptingOrders),
      enableOrderBook: nullableBoolean(value.enableOrderBook),
      endDate
    },
    discovery: {
      provider: "POLYMARKET_GAMMA",
      firstDiscoveredAt: retrievedAt,
      sourceUrl: POLYMARKET_DISCOVERY_SOURCE_URL,
      sourceTimestamp: updatedAt,
      retrievedAt,
      rawResponsePath: relative(resolve(root, "markets"), rawPath).replaceAll("\\", "/"),
      sha256: digest
    },
    acquisitionClock
  };
}

function parseFdvCryptoSearch(raw: string): readonly unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Polymarket Gamma discovery response is not valid JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new Error("Polymarket Gamma FDV search response must contain an events array");
  }
  if (value.events.length > 50) throw new Error("Polymarket Gamma FDV search exceeds frozen event limit");

  const markets: unknown[] = [];
  for (const event of value.events) {
    if (!isRecord(event) || !Array.isArray(event.tags) || !Array.isArray(event.markets)) {
      throw new Error("Polymarket Gamma FDV search contains a malformed event");
    }
    const isCrypto = event.tags.some((tag) =>
      isRecord(tag) && String(tag.id) === POLYMARKET_CRYPTO_TAG_ID
    );
    if (!isCrypto) continue;
    markets.push(...event.markets);
  }
  return markets;
}

async function readDiscovery(path: string): Promise<MarketDiscoveryRecord | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      !isRecord(value) ||
      !isDiscoverySchemaVersion(value.schemaVersion) ||
      !nonEmptyString(value.marketId) ||
      !isRecord(value.discovery) ||
      !nonNegativeFinite(value.discovery.firstDiscoveredAt) ||
      !isDiscoverySourceUrl(value.discovery.sourceUrl)
    ) {
      throw new Error("invalid discovery record");
    }
    return value as MarketDiscoveryRecord;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw new Error(`existing discovery record is invalid: ${path}`);
  }
}

async function requireDiscovery(path: string): Promise<MarketDiscoveryRecord> {
  const value = await readDiscovery(path);
  if (value === null) throw new Error("discovery record race did not produce a readable record");
  return value;
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

function dateTime(value: unknown): number | null {
  if (!nonEmptyString(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function httpDate(value: string | null): number | null {
  if (value === null) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function httpAge(value: string | null): number | null {
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe.length === 0 || safe === "." || safe === "..") throw new Error("market id is unsafe");
  return safe;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDiscoverySchemaVersion(value: unknown): value is DiscoverySchemaVersion {
  return value === PROSPECTIVE_DISCOVERY_SCHEMA_VERSION ||
    value === PROSPECTIVE_DISCOVERY_LEGACY_SCHEMA_VERSION;
}

function isDiscoverySourceUrl(value: unknown): value is DiscoverySourceUrl {
  return value === POLYMARKET_DISCOVERY_SOURCE_URL ||
    value === POLYMARKET_LEGACY_DISCOVERY_SOURCE_URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function main(): Promise<void> {
  const outputDirectory = process.argv[2] ?? runtimeEvidencePath("prospective-v2.1", "discovery");
  const result = await runPolymarketDiscoveryScan(outputDirectory);
  console.log(JSON.stringify({
    status: "SCAN_RECORDED",
    scanPath: result.scanPath,
    rawPath: result.rawPath,
    observedMarkets: result.scan.observedMarkets,
    newDiscoveries: result.scan.newDiscoveries,
    potentialFdvReviews: result.scan.potentialFdvReviews,
    blockedDiscoveries: result.scan.blockedDiscoveries
  }, null, 2));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
