import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { resolveRepositoryCommit } from "../build-identity.ts";
import { runtimeEvidencePath } from "../runtime-paths.ts";

export const HOURLY_UP_DOWN_PROTOCOL = "HOURLY_UP_DOWN_V1_0_0" as const;
export const HOURLY_UP_DOWN_ASSETS = [
  "BTC", "ETH", "SOL", "XRP", "DOGE", "HYPE", "BNB",
  "ADA", "LINK", "AVAX", "SUI", "LTC", "BCH", "DOT", "TRX"
] as const;
export const HOURLY_UP_DOWN_BOOK_MAX_STALENESS_MS = 120_000;
export const HOURLY_UP_DOWN_MAX_ENTRY_ASK = 0.5;
const INTERVAL_MS = 60_000;
const HOUR_MS = 60 * INTERVAL_MS;
const SEARCH_LIMIT = 50;
const MAX_REGISTRATION_LEAD_MS = 24 * HOUR_MS;

export type HourlyUpDownAsset = typeof HOURLY_UP_DOWN_ASSETS[number];
export type HourlyUpDownDirection = "UP" | "DOWN";

const ASSET_CONFIG: Record<HourlyUpDownAsset, {
  readonly label: string;
  readonly symbol: string;
  readonly resolutionVenue: "BINANCE_SPOT" | "BINANCE_FUTURES";
}> = {
  BTC: { label: "Bitcoin", symbol: "BTCUSDT", resolutionVenue: "BINANCE_SPOT" },
  ETH: { label: "Ethereum", symbol: "ETHUSDT", resolutionVenue: "BINANCE_SPOT" },
  SOL: { label: "Solana", symbol: "SOLUSDT", resolutionVenue: "BINANCE_SPOT" },
  XRP: { label: "XRP", symbol: "XRPUSDT", resolutionVenue: "BINANCE_SPOT" },
  DOGE: { label: "Dogecoin", symbol: "DOGEUSDT", resolutionVenue: "BINANCE_SPOT" },
  HYPE: { label: "HYPE", symbol: "HYPEUSDT", resolutionVenue: "BINANCE_FUTURES" },
  BNB: { label: "BNB", symbol: "BNBUSDT", resolutionVenue: "BINANCE_SPOT" },
  ADA: { label: "Cardano", symbol: "ADAUSDT", resolutionVenue: "BINANCE_SPOT" },
  LINK: { label: "Chainlink", symbol: "LINKUSDT", resolutionVenue: "BINANCE_SPOT" },
  AVAX: { label: "Avalanche", symbol: "AVAXUSDT", resolutionVenue: "BINANCE_SPOT" },
  SUI: { label: "Sui", symbol: "SUIUSDT", resolutionVenue: "BINANCE_SPOT" },
  LTC: { label: "Litecoin", symbol: "LTCUSDT", resolutionVenue: "BINANCE_SPOT" },
  BCH: { label: "Bitcoin Cash", symbol: "BCHUSDT", resolutionVenue: "BINANCE_SPOT" },
  DOT: { label: "Polkadot", symbol: "DOTUSDT", resolutionVenue: "BINANCE_SPOT" },
  TRX: { label: "TRON", symbol: "TRXUSDT", resolutionVenue: "BINANCE_SPOT" }
};

type Artifact = {
  readonly kind: "POLYMARKET_GAMMA" | "POLYMARKET_CLOB_BOOK" | "BINANCE_1M_KLINES";
  readonly sourceUrl: string;
  readonly retrievedAt: number;
  readonly path: string;
  readonly sha256: string;
};

export type HourlyUpDownManifest = {
  readonly schemaVersion: "1.0.0";
  readonly protocolVersion: typeof HOURLY_UP_DOWN_PROTOCOL;
  readonly manifestId: string;
  readonly repositoryCommit: string;
  readonly registeredAt: number;
  readonly asset: HourlyUpDownAsset;
  readonly resolutionSymbol: string;
  readonly resolutionVenue: "BINANCE_SPOT" | "BINANCE_FUTURES";
  readonly measurementStart: number;
  readonly measurementEnd: number;
  readonly eventId: string;
  readonly slug: string;
  readonly title: string;
  readonly marketId: string;
  readonly question: string;
  readonly rules: string;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly rawDiscovery: Artifact;
};

type ClosedCandle = {
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: number;
  readonly close: number;
};

type OutcomeBook = {
  readonly outcome: HourlyUpDownDirection;
  readonly observedAt: number;
  readonly retrievedAt: number;
  readonly bestBid: number | null;
  readonly bestBidSize: number | null;
  readonly bestAsk: number | null;
  readonly bestAskSize: number | null;
  readonly artifact: Artifact;
};

export type HourlyUpDownCandidate = {
  readonly variant: "HOURLY_UP_DOWN_V1";
  readonly candidateId: string;
  readonly asset: HourlyUpDownAsset;
  readonly candidateT0: number;
  readonly direction: HourlyUpDownDirection;
  readonly question: string;
  readonly eventTitle: string;
  readonly measurementAt: number;
  readonly referenceOpen: number;
  readonly crossingPreviousClose: number;
  readonly crossingClose: number;
  readonly entryBestAsk: number;
  readonly entryBestAskSize: number;
  readonly bookObservedAt: number;
};

type HourlyState = {
  readonly schemaVersion: "1.0.0";
  readonly manifestId: string;
  readonly status: "REGISTERED_WAITING_TRIGGER" | "QUALIFIED" | "DATA_BLOCKED" | "EXPIRED_NO_SIGNAL";
  readonly updatedAt: number;
  readonly books: readonly OutcomeBook[];
  readonly candles: readonly ClosedCandle[];
  readonly artifacts: readonly Artifact[];
  readonly candidate: HourlyUpDownCandidate | null;
  readonly reasons: readonly string[];
};

type DiscoveredEpisode = Omit<HourlyUpDownManifest,
  "schemaVersion" | "protocolVersion" | "manifestId" | "repositoryCommit" | "registeredAt">;

export type HourlyUpDownSummary = {
  readonly status: "HOURLY_UP_DOWN_CYCLE_RECORDED";
  readonly recordedAt: number;
  readonly monitoredAssets: readonly HourlyUpDownAsset[];
  readonly marketSuppliedAssets: readonly HourlyUpDownAsset[];
  readonly discoveredEpisodes: number;
  readonly registeredEpisodes: number;
  readonly activeEpisodes: number;
  readonly blockedDiscoveries: number;
  readonly admission: {
    readonly waiting: number;
    readonly qualified: number;
    readonly dataBlocked: number;
    readonly expired: number;
  };
  readonly scanPath: string;
};

export async function runHourlyUpDownCollectorCycle(
  outputDirectory = runtimeEvidencePath("up-down-v1"),
  dependencies: {
    readonly fetcher?: typeof fetch;
    readonly now?: () => number;
    readonly repositoryCommit?: string;
    readonly timeoutMs?: number;
  } = {}
): Promise<HourlyUpDownSummary> {
  const fetcher = dependencies.fetcher ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? 15_000;
  const now = dependencies.now ?? await synchronizedNow(fetcher, timeoutMs);
  const repositoryCommit = dependencies.repositoryCommit ?? resolveRepositoryCommit();
  const root = resolve(outputDirectory);
  await mkdir(root, { recursive: true });

  const blocked: string[] = [];
  const discovery = await Promise.all(HOURLY_UP_DOWN_ASSETS.map(async (asset) => {
    try {
      const config = ASSET_CONFIG[asset];
      const url = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(`${config.label} Up or Down`)}&limit_per_type=${SEARCH_LIMIT}&events_status=active&page=1`;
      const { raw, retrievedAt } = await fetchRaw(url, fetcher, now, timeoutMs, `Polymarket ${asset} Up/Down discovery`);
      const artifact = await archiveRaw(root, "POLYMARKET_GAMMA", `gamma/${asset}`, url, retrievedAt, raw);
      return parseDiscovery(asset, raw, retrievedAt, artifact, blocked);
    } catch (error) {
      blocked.push(`${asset} discovery: ${errorText(error)}`);
      return [];
    }
  }));
  const episodes = discovery.flat().sort((left, right) => left.measurementStart - right.measurementStart || left.asset.localeCompare(right.asset));
  const supplied = new Set(episodes.map((episode) => episode.asset));
  const marketSuppliedAssets = HOURLY_UP_DOWN_ASSETS.filter((asset) => supplied.has(asset));
  const manifests = await loadManifests(root);
  let registeredEpisodes = 0;
  for (const episode of episodes) {
    const manifestId = `UDV1-${episode.asset}-${episode.measurementStart}`;
    if (manifests.has(manifestId)) continue;
    // A cohort must exist before its measurement candle begins. Current-hour
    // events discovered late are observable supply, never prospective samples.
    if (episode.measurementStart <= episode.rawDiscovery.retrievedAt) continue;
    const manifest: HourlyUpDownManifest = {
      schemaVersion: "1.0.0",
      protocolVersion: HOURLY_UP_DOWN_PROTOCOL,
      manifestId,
      repositoryCommit,
      registeredAt: episode.rawDiscovery.retrievedAt,
      ...episode
    };
    if (await writeImmutable(manifestPath(root, manifestId), `${JSON.stringify(manifest, null, 2)}\n`)) {
      await writeState(statePath(root, manifestId), initialState(manifest));
      manifests.set(manifestId, manifest);
      registeredEpisodes += 1;
    }
  }

  const live = await loadStates(root, manifests);
  const boundary = now();
  for (const item of live) {
    if (item.state.status !== "REGISTERED_WAITING_TRIGGER") continue;
    if (boundary >= item.manifest.measurementStart - HOURLY_UP_DOWN_BOOK_MAX_STALENESS_MS && boundary < item.manifest.measurementEnd) {
      try {
        const books = await Promise.all([
          fetchBook(root, item.manifest, "UP", item.manifest.upTokenId, fetcher, now, timeoutMs),
          fetchBook(root, item.manifest, "DOWN", item.manifest.downTokenId, fetcher, now, timeoutMs)
        ]);
        item.state = appendBooks(item.state, books);
      } catch (error) {
        blocked.push(`${item.manifest.manifestId}: ${errorText(error)}`);
      }
    }
    if (boundary >= item.manifest.measurementStart && boundary < item.manifest.measurementEnd + INTERVAL_MS) {
      try {
        const batch = await fetchCandles(root, item.manifest, boundary, fetcher, now, timeoutMs);
        item.state = appendCandles(item.state, batch.candles, batch.artifact);
      } catch (error) {
        blocked.push(`${item.manifest.manifestId}: ${errorText(error)}`);
      }
    }
    item.state = evaluate(item.manifest, item.state, boundary);
    await writeState(item.path, item.state);
  }

  const allStates = await loadStates(root, manifests);
  const counts = { waiting: 0, qualified: 0, dataBlocked: 0, expired: 0 };
  for (const item of allStates) {
    if (item.state.status === "REGISTERED_WAITING_TRIGGER") counts.waiting += 1;
    else if (item.state.status === "QUALIFIED") counts.qualified += 1;
    else if (item.state.status === "DATA_BLOCKED") counts.dataBlocked += 1;
    else counts.expired += 1;
  }
  const recordedAt = now();
  const activeEpisodes = episodes.filter((episode) => episode.measurementStart <= recordedAt && recordedAt < episode.measurementEnd).length;
  const body = {
    status: "HOURLY_UP_DOWN_CYCLE_RECORDED" as const,
    recordedAt,
    monitoredAssets: HOURLY_UP_DOWN_ASSETS,
    marketSuppliedAssets,
    discoveredEpisodes: episodes.length,
    registeredEpisodes,
    activeEpisodes,
    blockedDiscoveries: blocked.length,
    admission: counts,
    blockers: blocked
  };
  const scanPath = resolve(root, "scans", `${recordedAt}-${sha256(JSON.stringify(body)).slice(0, 12)}.json`);
  await writeImmutable(scanPath, `${JSON.stringify(body, null, 2)}\n`);
  return { ...body, scanPath };
}

export async function findFirstNewHourlyCandidate(
  outputDirectory: string,
  armedAt: number,
  allowedAssets: readonly string[]
): Promise<HourlyUpDownCandidate | null> {
  const allowed = new Set(allowedAssets);
  const candidates: HourlyUpDownCandidate[] = [];
  for (const name of await jsonFiles(resolve(outputDirectory, "states"))) {
    const state = JSON.parse(await readFile(resolve(outputDirectory, "states", name), "utf8")) as HourlyState;
    if (state.status !== "QUALIFIED" || state.candidate === null) continue;
    if (state.candidate.candidateT0 > armedAt && allowed.has(state.candidate.asset)) candidates.push(state.candidate);
  }
  return candidates.sort((left, right) => left.candidateT0 - right.candidateT0 || left.candidateId.localeCompare(right.candidateId))[0] ?? null;
}

function parseDiscovery(asset: HourlyUpDownAsset, raw: string, retrievedAt: number, artifact: Artifact, blocked: string[]): DiscoveredEpisode[] {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw new Error(`${asset} Up/Down discovery is not valid JSON`); }
  if (!record(payload) || !Array.isArray(payload.events)) throw new Error(`${asset} Up/Down discovery has no events`);
  const config = ASSET_CONFIG[asset];
  const episodes: DiscoveredEpisode[] = [];
  for (const event of payload.events) {
    if (!record(event) || typeof event.title !== "string" || !event.title.startsWith(`${config.label} Up or Down - `)) continue;
    try {
      const measurementEnd = timestamp(event.endDate, "event endDate");
      const measurementStart = measurementEnd - HOUR_MS;
      if (measurementEnd <= retrievedAt || measurementStart > retrievedAt + MAX_REGISTRATION_LEAD_MS) continue;
      const markets = Array.isArray(event.markets) ? event.markets.filter(record) : [];
      const market = markets.find((value) => value.question === event.title && value.active === true && value.closed === false && value.acceptingOrders === true && value.enableOrderBook === true);
      if (market === undefined) throw new Error("no active order-enabled market");
      const rules = requiredString(market.description ?? event.description, "rules");
      if (!/1 hour candle/i.test(rules)) continue;
      validateRules(rules, asset);
      if (timestamp(market.endDate, "market endDate") !== measurementEnd) throw new Error("market/event endDate mismatch");
      const outcomes = stringArray(market.outcomes, "outcomes");
      const tokenIds = stringArray(market.clobTokenIds, "clobTokenIds");
      const up = outcomes.findIndex((value) => value.toUpperCase() === "UP");
      const down = outcomes.findIndex((value) => value.toUpperCase() === "DOWN");
      if (up < 0 || down < 0 || tokenIds.length !== outcomes.length) throw new Error("cannot map UP/DOWN tokens");
      episodes.push({
        asset,
        resolutionSymbol: config.symbol,
        resolutionVenue: config.resolutionVenue,
        measurementStart,
        measurementEnd,
        eventId: requiredId(event.id, "event id"),
        slug: requiredString(event.slug, "event slug"),
        title: event.title,
        marketId: requiredId(market.id, "market id"),
        question: requiredString(market.question, "market question"),
        rules,
        upTokenId: tokenIds[up]!,
        downTokenId: tokenIds[down]!,
        rawDiscovery: artifact
      });
    } catch (error) {
      blocked.push(`${asset} ${String(event.id ?? "UNKNOWN")}: ${errorText(error)}`);
    }
  }
  const unique = new Map<number, DiscoveredEpisode>();
  for (const episode of episodes) {
    const prior = unique.get(episode.measurementStart);
    if (prior === undefined || BigInt(episode.eventId) < BigInt(prior.eventId)) unique.set(episode.measurementStart, episode);
  }
  return [...unique.values()];
}

function validateRules(rules: string, asset: HourlyUpDownAsset): void {
  const required = [
    /close price is greater than or equal to the open price/i,
    new RegExp(`${asset}\\/USDT 1 hour candle`, "i"),
    /resolution source.*Binance/is,
    /close.*C.*open.*O/is
  ];
  if (required.some((pattern) => !pattern.test(rules))) throw new Error("rules do not match Binance 1h Up/Down semantics");
}

function evaluate(manifest: HourlyUpDownManifest, state: HourlyState, asOf: number): HourlyState {
  if (state.status !== "REGISTERED_WAITING_TRIGGER") return state;
  const candles = [...state.candles].sort((left, right) => left.openTime - right.openTime);
  const first = candles.find((candle) => candle.openTime === manifest.measurementStart);
  if (first !== undefined) {
    const referenceOpen = first.open;
    for (let index = 1; index < candles.length; index += 1) {
      const previous = candles[index - 1]!;
      const current = candles[index]!;
      const candidateT0 = current.openTime + INTERVAL_MS;
      let direction: HourlyUpDownDirection | null = null;
      if (previous.close < referenceOpen && current.close >= referenceOpen) direction = "UP";
      else if (previous.close >= referenceOpen && current.close < referenceOpen) direction = "DOWN";
      if (direction === null) continue;
      const book = [...state.books]
        .filter((value) => value.outcome === direction && value.observedAt <= candidateT0)
        .sort((left, right) => right.observedAt - left.observedAt)[0];
      if (book === undefined || candidateT0 - book.observedAt > HOURLY_UP_DOWN_BOOK_MAX_STALENESS_MS) {
        return terminal(state, asOf, "DATA_BLOCKED", ["first direction crossing has no fresh archived pre-T0 outcome book"]);
      }
      if (book.bestAsk === null || book.bestAskSize === null || book.bestAsk <= 0 || book.bestAsk >= 1 || book.bestAskSize <= 0) {
        return terminal(state, asOf, "DATA_BLOCKED", ["outcome book is not executable"]);
      }
      if (book.bestAsk > HOURLY_UP_DOWN_MAX_ENTRY_ASK) continue;
      return {
        ...state,
        status: "QUALIFIED",
        updatedAt: asOf,
        candidate: {
          variant: "HOURLY_UP_DOWN_V1",
          candidateId: `UDV1-${manifest.asset}-${candidateT0}-${direction}`,
          asset: manifest.asset,
          candidateT0,
          direction,
          question: manifest.question,
          eventTitle: manifest.title,
          measurementAt: manifest.measurementEnd,
          referenceOpen,
          crossingPreviousClose: previous.close,
          crossingClose: current.close,
          entryBestAsk: book.bestAsk,
          entryBestAskSize: book.bestAskSize,
          bookObservedAt: book.observedAt
        },
        reasons: []
      };
    }
  }
  return asOf >= manifest.measurementEnd
    ? terminal(state, asOf, "EXPIRED_NO_SIGNAL", ["no qualifying <=50c lag crossing before the 1h candle closed"])
    : { ...state, updatedAt: asOf, reasons: [] };
}

async function fetchBook(root: string, manifest: HourlyUpDownManifest, outcome: HourlyUpDownDirection, tokenId: string, fetcher: typeof fetch, now: () => number, timeoutMs: number): Promise<OutcomeBook> {
  const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`;
  const { raw, retrievedAt } = await fetchRaw(url, fetcher, now, timeoutMs, `${manifest.asset} ${outcome} book`);
  const artifact = await archiveRaw(root, "POLYMARKET_CLOB_BOOK", `books/${manifest.manifestId}/${outcome}`, url, retrievedAt, raw);
  const value = JSON.parse(raw) as unknown;
  if (!record(value)) throw new Error("CLOB book is malformed");
  const observedAt = timestamp(value.timestamp ?? retrievedAt, "book timestamp");
  if (observedAt > retrievedAt) throw new Error("book timestamp is in the future");
  const bids = levels(value.bids);
  const asks = levels(value.asks);
  const bestBid = bids.sort((a, b) => b.price - a.price)[0] ?? null;
  const bestAsk = asks.sort((a, b) => a.price - b.price)[0] ?? null;
  return {
    outcome,
    observedAt,
    retrievedAt,
    bestBid: bestBid?.price ?? null,
    bestBidSize: bestBid?.size ?? null,
    bestAsk: bestAsk?.price ?? null,
    bestAskSize: bestAsk?.size ?? null,
    artifact
  };
}

async function fetchCandles(root: string, manifest: HourlyUpDownManifest, boundary: number, fetcher: typeof fetch, now: () => number, timeoutMs: number): Promise<{ candles: ClosedCandle[]; artifact: Artifact }> {
  const base = manifest.resolutionVenue === "BINANCE_SPOT"
    ? "https://api.binance.com/api/v3/klines"
    : "https://fapi.binance.com/fapi/v1/klines";
  const endTime = Math.min(boundary, manifest.measurementEnd) - 1;
  const url = `${base}?symbol=${manifest.resolutionSymbol}&interval=1m&startTime=${manifest.measurementStart}&endTime=${endTime}&limit=120`;
  const { raw, retrievedAt } = await fetchRaw(url, fetcher, now, timeoutMs, `${manifest.asset} 1m candles`);
  const artifact = await archiveRaw(root, "BINANCE_1M_KLINES", `candles/${manifest.asset}`, url, retrievedAt, raw);
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error("Binance klines are malformed");
  const candles = value.map((row, index) => {
    if (!Array.isArray(row) || row.length < 7) throw new Error(`kline ${index} is malformed`);
    const openTime = timestamp(row[0], `kline ${index} openTime`);
    const closeTime = timestamp(row[6], `kline ${index} closeTime`);
    if (closeTime !== openTime + INTERVAL_MS - 1) throw new Error(`kline ${index} interval is invalid`);
    return { openTime, closeTime, open: positive(row[1], "kline open"), close: positive(row[4], "kline close") };
  }).filter((candle) =>
    candle.closeTime < boundary
    && candle.openTime >= manifest.measurementStart
    && candle.openTime < manifest.measurementEnd
  );
  return { candles, artifact };
}

async function fetchRaw(url: string, fetcher: typeof fetch, now: () => number, timeoutMs: number, label: string): Promise<{ raw: string; retrievedAt: number }> {
  const response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  const raw = await response.text();
  return { raw, retrievedAt: now() };
}

async function synchronizedNow(fetcher: typeof fetch, timeoutMs: number): Promise<() => number> {
  const startedAt = Date.now();
  const response = await fetcher("https://api.binance.com/api/v3/time", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const finishedAt = Date.now();
  if (!response.ok) throw new Error(`Binance server time HTTP ${response.status}`);
  const value = await response.json() as unknown;
  if (!record(value)) throw new Error("Binance server time is malformed");
  const serverTime = timestamp(value.serverTime, "Binance serverTime");
  const offset = serverTime - (startedAt + Math.round((finishedAt - startedAt) / 2));
  return () => Date.now() + offset;
}

async function archiveRaw(root: string, kind: Artifact["kind"], family: string, sourceUrl: string, retrievedAt: number, raw: string): Promise<Artifact> {
  const digest = sha256(raw);
  const path = resolve(root, "raw", family, `${retrievedAt}-${digest.slice(0, 16)}.json`);
  await writeImmutable(path, raw);
  return { kind, sourceUrl, retrievedAt, path: relative(root, path).replaceAll("\\", "/"), sha256: digest };
}

function appendBooks(state: HourlyState, books: readonly OutcomeBook[]): HourlyState {
  const seen = new Set(state.books.map((book) => `${book.outcome}:${book.observedAt}:${book.artifact.sha256}`));
  const additions = books.filter((book) => !seen.has(`${book.outcome}:${book.observedAt}:${book.artifact.sha256}`));
  return { ...state, books: [...state.books, ...additions], artifacts: [...state.artifacts, ...additions.map((book) => book.artifact)] };
}

function appendCandles(state: HourlyState, candles: readonly ClosedCandle[], artifact: Artifact): HourlyState {
  const byOpen = new Map(state.candles.map((candle) => [candle.openTime, candle]));
  for (const candle of candles) {
    const prior = byOpen.get(candle.openTime);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(candle)) return terminal(state, Date.now(), "DATA_BLOCKED", ["Binance candle changed after archival"]);
    byOpen.set(candle.openTime, candle);
  }
  const artifacts = state.artifacts.some((value) => value.sha256 === artifact.sha256) ? state.artifacts : [...state.artifacts, artifact];
  return { ...state, candles: [...byOpen.values()].sort((a, b) => a.openTime - b.openTime), artifacts };
}

function initialState(manifest: HourlyUpDownManifest): HourlyState {
  return { schemaVersion: "1.0.0", manifestId: manifest.manifestId, status: "REGISTERED_WAITING_TRIGGER", updatedAt: manifest.registeredAt, books: [], candles: [], artifacts: [], candidate: null, reasons: [] };
}

function terminal(state: HourlyState, updatedAt: number, status: "DATA_BLOCKED" | "EXPIRED_NO_SIGNAL", reasons: readonly string[]): HourlyState {
  return { ...state, status, updatedAt, reasons };
}

async function loadManifests(root: string): Promise<Map<string, HourlyUpDownManifest>> {
  const result = new Map<string, HourlyUpDownManifest>();
  for (const name of await jsonFiles(resolve(root, "manifests"))) {
    const value = JSON.parse(await readFile(resolve(root, "manifests", name), "utf8")) as HourlyUpDownManifest;
    result.set(value.manifestId, value);
  }
  return result;
}

async function loadStates(root: string, manifests: Map<string, HourlyUpDownManifest>): Promise<Array<{ manifest: HourlyUpDownManifest; state: HourlyState; path: string }>> {
  const result: Array<{ manifest: HourlyUpDownManifest; state: HourlyState; path: string }> = [];
  for (const [id, manifest] of manifests) {
    const path = statePath(root, id);
    try { result.push({ manifest, state: JSON.parse(await readFile(path, "utf8")) as HourlyState, path }); } catch { /* manifest publication is completed by the next cycle */ }
  }
  return result;
}

async function jsonFiles(path: string): Promise<string[]> {
  try { return (await readdir(path)).filter((name) => name.endsWith(".json")).sort(); } catch { return []; }
}

function manifestPath(root: string, id: string): string { return resolve(root, "manifests", `${id}.json`); }
function statePath(root: string, id: string): string { return resolve(root, "states", `${id}.json`); }

async function writeState(path: string, value: HourlyState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await BunlessWrite(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function BunlessWrite(path: string, body: string): Promise<void> {
  const handle = await open(path, "w");
  try { await handle.writeFile(body, "utf8"); } finally { await handle.close(); }
}

async function writeImmutable(path: string, body: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx");
    await handle.writeFile(body, "utf8");
    return true;
  } catch (error) {
    if (record(error) && error.code === "EEXIST") return false;
    throw error;
  } finally { await handle?.close(); }
}

function levels(value: unknown): Array<{ price: number; size: number }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!record(item)) throw new Error("book level is malformed");
    return { price: positive(item.price, "book price"), size: positive(item.size, "book size") };
  });
}

function stringArray(value: unknown, label: string): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(`${label} is invalid`);
  return parsed;
}

function timestamp(value: unknown, label: string): number {
  const parsed = typeof value === "string" && !/^\d+$/.test(value) ? Date.parse(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function positive(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
  return value;
}

function requiredId(value: unknown, label: string): string {
  const parsed = String(value ?? "");
  if (!/^\d+$/.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : "unknown hourly collector failure"; }
