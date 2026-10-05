import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  evaluatePriceTargetEpisode,
  evaluatePriceTargetManifest,
  newPriceTargetState,
  PRICE_TARGET_BOOK_MAX_STALENESS_MS,
  PRICE_TARGET_CANDLE_INTERVAL_MS,
  PRICE_TARGET_MANIFEST_SCHEMA_VERSION,
  PRICE_TARGET_PRIMARY_HORIZON_MS,
  PRICE_TARGET_PROTOCOL_VERSION,
  type PriceTargetAsset,
  type PriceTargetBookSnapshot,
  type PriceTargetClosedCandle,
  type PriceTargetEpisodeState,
  type PriceTargetManifest,
  type PriceTargetMarketStatusSnapshot,
  type RawArtifactReference
} from "./price-target-admission.ts";

export const PRICE_TARGET_POLL_INTERVAL_MS = 60_000;
export const PRICE_TARGET_SEARCH_LIMIT = 50;
export const PRICE_TARGET_ASSETS = ["BTC", "ETH", "SOL"] as const;

const ASSET_CONFIG = {
  BTC: { query: "Bitcoin", label: "Bitcoin", symbol: "BTCUSDT", cohort: "PRICE_TARGET_V1_BTC" },
  ETH: { query: "Ethereum", label: "Ethereum", symbol: "ETHUSDT", cohort: "PRICE_TARGET_V1_ETH" },
  SOL: { query: "Solana", label: "Solana", symbol: "SOLUSDT", cohort: "PRICE_TARGET_V1_SOL" }
} as const;

type DiscoveredMarket = {
  readonly marketId: string;
  readonly question: string;
  readonly strike: number;
  readonly yesAssetId: string;
  readonly active: boolean;
  readonly closed: boolean;
  readonly acceptingOrders: boolean;
  readonly enableOrderBook: boolean;
};

export type DiscoveredPriceTargetEpisode = {
  readonly asset: PriceTargetAsset;
  readonly episodeKey: string;
  readonly eventId: string;
  readonly slug: string;
  readonly title: string;
  readonly rules: string;
  readonly measurementAt: number;
  readonly markets: readonly DiscoveredMarket[];
  readonly rawDiscovery: RawArtifactReference;
};

type DiscoveryParseResult = {
  readonly episodes: readonly DiscoveredPriceTargetEpisode[];
  readonly marketStatuses: ReadonlyMap<string, PriceTargetMarketStatusSnapshot>;
  readonly blocked: readonly string[];
};

export type PriceTargetCollectorDependencies = {
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly repositoryCommit?: string;
  readonly timeoutMs?: number;
};

export type PriceTargetCollectorSummary = {
  readonly status: "CYCLE_RECORDED";
  readonly recordedAt: number;
  readonly discoveredEpisodes: number;
  readonly registeredEpisodes: number;
  readonly blockedDiscoveries: number;
  readonly admission: {
    readonly waiting: number;
    readonly qualified: number;
    readonly dataBlocked: number;
    readonly notTriggered: number;
  };
  readonly scanPath: string;
};

export async function runPriceTargetCollectorCycle(
  outputDirectory: string,
  dependencies: PriceTargetCollectorDependencies = {}
): Promise<PriceTargetCollectorSummary> {
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.timeoutMs ?? 15_000;
  const repositoryCommit = dependencies.repositoryCommit ?? currentCommit();
  if (!/^[0-9a-f]{40}$/.test(repositoryCommit)) throw new Error("repository commit is invalid");
  const root = resolve(outputDirectory);
  await mkdir(root, { recursive: true });

  const discoveryResults = await Promise.all(PRICE_TARGET_ASSETS.map(async (asset) => {
    const url = searchUrl(asset);
    const response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Polymarket Gamma ${asset} discovery HTTP ${response.status}`);
    const raw = await response.text();
    const retrievedAt = now();
    const artifact = await archiveRaw(root, "POLYMARKET_GAMMA", `gamma/${asset}`, url, retrievedAt, raw);
    return parsePriceTargetSearch(asset, raw, retrievedAt, artifact);
  }));
  const episodes = ownerEpisodes(discoveryResults.flatMap((result) => result.episodes));
  const blockedDiscoveries = discoveryResults.flatMap((result) => result.blocked);
  const currentStatuses = new Map<string, PriceTargetMarketStatusSnapshot>();
  for (const result of discoveryResults) {
    for (const [marketId, status] of result.marketStatuses) currentStatuses.set(marketId, status);
  }

  const manifests = await loadManifests(root);
  const sharedRegistration = new Map<PriceTargetAsset, {
    candle: PriceTargetClosedCandle;
    artifact: RawArtifactReference;
  }>();
  let registeredEpisodes = 0;
  for (const episode of episodes) {
    if (manifests.byEpisode.has(episode.episodeKey)) continue;
    try {
      let registration = sharedRegistration.get(episode.asset);
      if (registration === undefined) {
        registration = await fetchRegistrationCandle(root, episode.asset, episode.rawDiscovery.retrievedAt, fetcher, now, timeoutMs);
        sharedRegistration.set(episode.asset, registration);
      }
      const manifest = buildManifest(episode, registration, repositoryCommit, now());
      const admission = evaluatePriceTargetManifest(manifest);
      if (admission.status !== "DATA_READY") {
        blockedDiscoveries.push(`${episode.episodeKey}: ${admission.reasons.join("; ")}`);
        continue;
      }
      const manifestPath = manifestFile(root, manifest.manifestId);
      if (await writeImmutable(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)) {
        await writeStateAtomically(stateFile(root, manifest.manifestId), newPriceTargetState(manifest.manifestId, manifest.registeredAt));
        manifests.values.push(manifest);
        manifests.byEpisode.set(manifest.episode.episodeKey, manifest);
        registeredEpisodes += 1;
      }
    } catch (error) {
      blockedDiscoveries.push(`${episode.episodeKey}: ${safeError(error)}`);
    }
  }

  const live = await loadManifestStates(root, manifests.values);
  const waiting = live.filter((item) => item.state.status === "REGISTERED_WAITING_TRIGGER");
  await Promise.all(waiting.map(async (item) => {
    const status = currentStatuses.get(item.manifest.registration.selectedMarketId);
    if (status !== undefined) item.state = appendMarketStatus(item.state, status);
    try {
      const book = await fetchBook(root, item.manifest, fetcher, now, timeoutMs);
      item.state = appendBook(item.state, book);
    } catch (error) {
      // A transient book read is recorded in the cycle summary but does not invent
      // evidence or terminate an episode before a crossing actually needs it.
      blockedDiscoveries.push(`${item.manifest.manifestId}: ${safeError(error)}`);
    }
  }));

  for (const asset of PRICE_TARGET_ASSETS) {
    const assetItems = waiting.filter((item) => item.manifest.episode.asset === asset);
    if (assetItems.length === 0) continue;
    const startTime = Math.min(...assetItems.map(({ manifest, state }) =>
      (state.candles.at(-1)?.openTime ?? manifest.registration.spotCandle.openTime) + PRICE_TARGET_CANDLE_INTERVAL_MS
    ));
    const batches = await fetchSpotCandleBatches(root, asset, startTime, now(), fetcher, now, timeoutMs);
    for (const item of assetItems) {
      const minimum = item.manifest.registration.spotCandle.openTime + PRICE_TARGET_CANDLE_INTERVAL_MS;
      const candles = batches.flatMap((batch) => batch.candles).filter((candle) => candle.openTime >= minimum);
      item.state = appendCandles(item.state, candles, batches.map((batch) => batch.artifact));
    }
  }

  const evaluationAt = now();
  for (const item of live) {
    item.state = evaluatePriceTargetEpisode(item.manifest, item.state, evaluationAt);
    await writeStateAtomically(item.statePath, item.state);
  }

  const counts = { waiting: 0, qualified: 0, dataBlocked: 0, notTriggered: 0 };
  for (const item of live) {
    if (item.state.status === "REGISTERED_WAITING_TRIGGER") counts.waiting += 1;
    else if (item.state.status === "QUALIFIED") counts.qualified += 1;
    else if (item.state.status === "DATA_BLOCKED") counts.dataBlocked += 1;
    else counts.notTriggered += 1;
  }
  const recordedAt = now();
  const summaryWithoutPath = {
    status: "CYCLE_RECORDED" as const,
    recordedAt,
    discoveredEpisodes: episodes.length,
    registeredEpisodes,
    blockedDiscoveries: blockedDiscoveries.length,
    admission: counts
  };
  const scanPath = resolve(root, "scans", `${recordedAt}-${sha256(JSON.stringify(summaryWithoutPath)).slice(0, 12)}.json`);
  await writeImmutable(scanPath, `${JSON.stringify({ ...summaryWithoutPath, blockers: blockedDiscoveries }, null, 2)}\n`);
  return { ...summaryWithoutPath, scanPath };
}

export function parsePriceTargetSearch(
  asset: PriceTargetAsset,
  raw: string,
  retrievedAt: number,
  rawDiscovery: RawArtifactReference
): DiscoveryParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Polymarket Gamma ${asset} response is not valid JSON`);
  }
  if (!isRecord(payload) || !Array.isArray(payload.events)) throw new Error("Gamma search response has no events array");
  if (payload.events.length > PRICE_TARGET_SEARCH_LIMIT) throw new Error("Gamma search exceeds frozen event limit");
  const config = ASSET_CONFIG[asset];
  const episodes: DiscoveredPriceTargetEpisode[] = [];
  const marketStatuses = new Map<string, PriceTargetMarketStatusSnapshot>();
  const blocked: string[] = [];
  for (const value of payload.events) {
    if (!isRecord(value)) {
      blocked.push(`${asset}: malformed event`);
      continue;
    }
    const tags = Array.isArray(value.tags) ? value.tags : [];
    const isCrypto = tags.some((tag) => isRecord(tag) && String(tag.id) === "21");
    if (!isCrypto || !nonEmptyString(value.title) || !new RegExp(`^${config.label} above ___ on `).test(value.title)) continue;
    try {
      const episode = parseEvent(asset, value, rawDiscovery);
      episodes.push(episode);
      for (const market of episode.markets) {
        marketStatuses.set(market.marketId, {
          observedAt: retrievedAt,
          marketId: market.marketId,
          active: market.active,
          closed: market.closed,
          acceptingOrders: market.acceptingOrders,
          enableOrderBook: market.enableOrderBook,
          artifact: rawDiscovery
        });
      }
    } catch (error) {
      blocked.push(`${asset} event ${String(value.id ?? "UNKNOWN")}: ${safeError(error)}`);
    }
  }
  return { episodes, marketStatuses, blocked };
}

function parseEvent(
  asset: PriceTargetAsset,
  event: Record<string, unknown>,
  rawDiscovery: RawArtifactReference
): DiscoveredPriceTargetEpisode {
  const config = ASSET_CONFIG[asset];
  const eventId = requiredNumericId(event.id, "event id");
  const slug = requiredString(event.slug, "event slug");
  const title = requiredString(event.title, "event title");
  const rules = requiredString(event.description, "event rules");
  const date = parseDateFromSlug(slug, config.query.toLowerCase());
  validateRules(rules, asset);
  const measurementAt = easternNoonUtc(date.year, date.month, date.day);
  if (dateTime(event.endDate) !== measurementAt) throw new Error("event endDate does not corroborate rule-derived measurementAt");
  if (!Array.isArray(event.markets) || event.markets.length === 0) throw new Error("event strike ladder is empty");
  const markets = event.markets.map((value, index) => parseMarket(asset, value, index, measurementAt));
  const strikes = new Set(markets.map((market) => market.strike));
  if (strikes.size !== markets.length) throw new Error("event contains duplicate strikes");
  const episodeKey = `${asset}-BINANCE_SPOT-${config.symbol}-${measurementAt}`;
  return { asset, episodeKey, eventId, slug, title, rules, measurementAt, markets, rawDiscovery };
}

function parseMarket(asset: PriceTargetAsset, value: unknown, index: number, measurementAt: number): DiscoveredMarket {
  if (!isRecord(value)) throw new Error(`market ${index} is malformed`);
  const config = ASSET_CONFIG[asset];
  const marketId = requiredNumericId(value.id, `market ${index} id`);
  const question = requiredString(value.question, `market ${index} question`);
  const pattern = new RegExp(`^Will the price of ${config.label} be above \\$([0-9,]+(?:\\.[0-9]+)?) on `);
  const match = question.match(pattern);
  if (match === null) throw new Error(`market ${marketId} is not a fixed ABOVE strike`);
  const strike = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(strike) || strike <= 0) throw new Error(`market ${marketId} strike is invalid`);
  validateRules(requiredString(value.description, `market ${marketId} rules`), asset);
  if (dateTime(value.endDate) !== measurementAt) throw new Error(`market ${marketId} endDate differs from episode`);
  const outcomes = stringArray(value.outcomes, `market ${marketId} outcomes`);
  const assetIds = value.version === "v2" && value.positionIds !== undefined
    ? stringArray(value.positionIds, `market ${marketId} positionIds`)
    : stringArray(value.clobTokenIds, `market ${marketId} clobTokenIds`);
  const yesIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "yes");
  if (yesIndex < 0 || assetIds.length !== outcomes.length || assetIds[yesIndex] === undefined) {
    throw new Error(`market ${marketId} cannot map YES outcome asset`);
  }
  return {
    marketId,
    question,
    strike,
    yesAssetId: assetIds[yesIndex],
    active: requiredBoolean(value.active, `market ${marketId} active`),
    closed: requiredBoolean(value.closed, `market ${marketId} closed`),
    acceptingOrders: requiredBoolean(value.acceptingOrders, `market ${marketId} acceptingOrders`),
    enableOrderBook: requiredBoolean(value.enableOrderBook, `market ${marketId} enableOrderBook`)
  };
}

function ownerEpisodes(values: readonly DiscoveredPriceTargetEpisode[]): DiscoveredPriceTargetEpisode[] {
  const owners = new Map<string, DiscoveredPriceTargetEpisode>();
  for (const value of values) {
    const existing = owners.get(value.episodeKey);
    if (existing === undefined || BigInt(value.eventId) < BigInt(existing.eventId)) owners.set(value.episodeKey, value);
  }
  return [...owners.values()].sort((left, right) => left.episodeKey.localeCompare(right.episodeKey));
}

function buildManifest(
  episode: DiscoveredPriceTargetEpisode,
  registration: { candle: PriceTargetClosedCandle; artifact: RawArtifactReference },
  repositoryCommit: string,
  registeredAt: number
): PriceTargetManifest {
  const config = ASSET_CONFIG[episode.asset];
  const ladder = [...episode.markets]
    .sort((left, right) => left.strike - right.strike)
    .map(({ marketId, question, strike, yesAssetId, active, closed, acceptingOrders, enableOrderBook }) => ({
      marketId,
      question,
      strike,
      yesAssetId,
      active,
      closed,
      acceptingOrders,
      enableOrderBook
    }));
  const selected = ladder.find((market) =>
    market.strike > registration.candle.close && market.active && !market.closed &&
    market.acceptingOrders && market.enableOrderBook
  );
  if (selected === undefined) throw new Error(`${episode.episodeKey} has no strictly OTM strike`);
  const manifestId = `PTV1-${episode.asset}-${episode.measurementAt}`;
  return {
    schemaVersion: PRICE_TARGET_MANIFEST_SCHEMA_VERSION,
    protocolVersion: PRICE_TARGET_PROTOCOL_VERSION,
    manifestId,
    repositoryCommit,
    cohortKey: config.cohort,
    discoveredAt: episode.rawDiscovery.retrievedAt,
    registeredAt,
    episode: {
      episodeKey: episode.episodeKey,
      asset: episode.asset,
      resolutionVenue: "BINANCE_SPOT",
      resolutionSymbol: config.symbol,
      measurementAt: episode.measurementAt,
      cutoffT0: episode.measurementAt - PRICE_TARGET_PRIMARY_HORIZON_MS
    },
    ownerEvent: {
      eventId: episode.eventId,
      slug: episode.slug,
      title: episode.title,
      rules: episode.rules,
      rawDiscovery: episode.rawDiscovery
    },
    registration: {
      spotCandle: registration.candle,
      spotArtifact: registration.artifact,
      registrationSpot: registration.candle.close,
      completeStrikeLadder: ladder,
      selectedStrike: selected.strike,
      selectedMarketId: selected.marketId,
      selectedQuestion: selected.question,
      yesAssetId: selected.yesAssetId
    }
  };
}

async function fetchRegistrationCandle(
  root: string,
  asset: PriceTargetAsset,
  discoveredAt: number,
  fetcher: typeof fetch,
  now: () => number,
  timeoutMs: number
): Promise<{ candle: PriceTargetClosedCandle; artifact: RawArtifactReference }> {
  const config = ASSET_CONFIG[asset];
  const url = `https://api.binance.com/api/v3/klines?symbol=${config.symbol}&interval=1m&endTime=${discoveredAt - 1}&limit=5`;
  const { raw, retrievedAt } = await fetchRaw(url, fetcher, now, timeoutMs, `Binance ${asset} registration`);
  const artifact = await archiveRaw(root, "BINANCE_SPOT_KLINES", `spot/${asset}`, url, retrievedAt, raw);
  const candles = parseBinanceKlines(raw).filter((candle) => candle.closeTime < discoveredAt);
  const candle = candles.at(-1);
  if (candle === undefined) throw new Error(`Binance ${asset} registration has no fully closed pre-discovery candle`);
  return { candle, artifact };
}

async function fetchSpotCandleBatches(
  root: string,
  asset: PriceTargetAsset,
  initialStartTime: number,
  boundary: number,
  fetcher: typeof fetch,
  now: () => number,
  timeoutMs: number
): Promise<readonly { candles: readonly PriceTargetClosedCandle[]; artifact: RawArtifactReference }[]> {
  const config = ASSET_CONFIG[asset];
  const batches: Array<{ candles: readonly PriceTargetClosedCandle[]; artifact: RawArtifactReference }> = [];
  let startTime = initialStartTime;
  while (startTime < boundary) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${config.symbol}&interval=1m&startTime=${startTime}&endTime=${boundary - 1}&limit=1000`;
    const { raw, retrievedAt } = await fetchRaw(url, fetcher, now, timeoutMs, `Binance ${asset} candles`);
    const artifact = await archiveRaw(root, "BINANCE_SPOT_KLINES", `spot/${asset}`, url, retrievedAt, raw);
    const candles = parseBinanceKlines(raw).filter((candle) => candle.closeTime < boundary);
    batches.push({ candles, artifact });
    const last = candles.at(-1);
    if (last === undefined) break;
    const next = last.openTime + PRICE_TARGET_CANDLE_INTERVAL_MS;
    if (next <= startTime) throw new Error("Binance candle pagination did not advance");
    startTime = next;
    if (candles.length < 1000) break;
  }
  return batches;
}

async function fetchBook(
  root: string,
  manifest: PriceTargetManifest,
  fetcher: typeof fetch,
  now: () => number,
  timeoutMs: number
): Promise<PriceTargetBookSnapshot> {
  const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(manifest.registration.yesAssetId)}`;
  const { raw, retrievedAt } = await fetchRaw(url, fetcher, now, timeoutMs, "Polymarket CLOB book");
  const artifact = await archiveRaw(root, "POLYMARKET_CLOB_BOOK", `books/${manifest.manifestId}`, url, retrievedAt, raw);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Polymarket CLOB book is not valid JSON"); }
  if (!isRecord(value)) throw new Error("Polymarket CLOB book is malformed");
  const bids = priceLevels(value.bids, "bids");
  const asks = priceLevels(value.asks, "asks");
  const bestBid = bids.sort((a, b) => b.price - a.price)[0] ?? null;
  const bestAsk = asks.sort((a, b) => a.price - b.price)[0] ?? null;
  return {
    observedAt: timestamp(value.timestamp, "book timestamp"),
    retrievedAt,
    marketId: manifest.registration.selectedMarketId,
    yesAssetId: manifest.registration.yesAssetId,
    bestBid: bestBid?.price ?? null,
    bestBidSize: bestBid?.size ?? null,
    bestAsk: bestAsk?.price ?? null,
    bestAskSize: bestAsk?.size ?? null,
    minOrderSize: positiveNumber(value.min_order_size ?? value.minOrderSize, "book minOrderSize"),
    tickSize: positiveNumber(value.tick_size ?? value.tickSize, "book tickSize"),
    hash: requiredString(value.hash, "book hash"),
    artifact
  };
}

function appendMarketStatus(state: PriceTargetEpisodeState, snapshot: PriceTargetMarketStatusSnapshot): PriceTargetEpisodeState {
  const statuses = [...state.marketStatuses.filter((item) => item.observedAt !== snapshot.observedAt), snapshot]
    .sort((a, b) => a.observedAt - b.observedAt);
  return { ...state, marketStatuses: statuses, artifacts: appendArtifacts(state.artifacts, [snapshot.artifact]) };
}

function appendBook(state: PriceTargetEpisodeState, snapshot: PriceTargetBookSnapshot): PriceTargetEpisodeState {
  const books = [...state.books.filter((item) => item.observedAt !== snapshot.observedAt), snapshot]
    .sort((a, b) => a.observedAt - b.observedAt);
  return { ...state, books, artifacts: appendArtifacts(state.artifacts, [snapshot.artifact]) };
}

function appendCandles(
  state: PriceTargetEpisodeState,
  values: readonly PriceTargetClosedCandle[],
  artifacts: readonly RawArtifactReference[]
): PriceTargetEpisodeState {
  const candles = new Map(state.candles.map((candle) => [candle.openTime, candle]));
  for (const candle of values) {
    const existing = candles.get(candle.openTime);
    if (existing !== undefined && (existing.closeTime !== candle.closeTime || existing.close !== candle.close)) {
      return { ...state, status: "DATA_BLOCKED", reasons: ["conflicting archived Binance candle"] };
    }
    candles.set(candle.openTime, candle);
  }
  return {
    ...state,
    candles: [...candles.values()].sort((a, b) => a.openTime - b.openTime),
    artifacts: appendArtifacts(state.artifacts, artifacts)
  };
}

function appendArtifacts(
  existing: readonly RawArtifactReference[],
  additions: readonly RawArtifactReference[]
): readonly RawArtifactReference[] {
  const result = new Map(existing.map((artifact) => [`${artifact.kind}:${artifact.sha256}`, artifact]));
  for (const artifact of additions) result.set(`${artifact.kind}:${artifact.sha256}`, artifact);
  return [...result.values()];
}

async function loadManifests(root: string): Promise<{
  readonly values: PriceTargetManifest[];
  readonly byEpisode: Map<string, PriceTargetManifest>;
}> {
  const directory = resolve(root, "manifests");
  const values: PriceTargetManifest[] = [];
  for (const name of await listJson(directory)) {
    const value = JSON.parse(await readFile(resolve(directory, name), "utf8")) as unknown;
    const admission = evaluatePriceTargetManifest(value);
    if (admission.status !== "DATA_READY") throw new Error(`existing manifest ${name} is invalid: ${admission.reasons.join("; ")}`);
    const manifest = value as PriceTargetManifest;
    await verifyArtifact(root, manifest.ownerEvent.rawDiscovery);
    await verifyArtifact(root, manifest.registration.spotArtifact);
    values.push(manifest);
  }
  return { values, byEpisode: new Map(values.map((manifest) => [manifest.episode.episodeKey, manifest])) };
}

async function loadManifestStates(root: string, manifests: readonly PriceTargetManifest[]): Promise<Array<{
  readonly manifest: PriceTargetManifest;
  state: PriceTargetEpisodeState;
  readonly statePath: string;
}>> {
  const result = [];
  for (const manifest of manifests) {
    const statePath = stateFile(root, manifest.manifestId);
    let state: PriceTargetEpisodeState;
    try {
      state = JSON.parse(await readFile(statePath, "utf8")) as PriceTargetEpisodeState;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      state = newPriceTargetState(manifest.manifestId, manifest.registeredAt);
    }
    for (const artifact of state.artifacts) await verifyArtifact(root, artifact);
    result.push({ manifest, state, statePath });
  }
  return result;
}

async function archiveRaw(
  root: string,
  kind: RawArtifactReference["kind"],
  subdirectory: string,
  sourceUrl: string,
  retrievedAt: number,
  raw: string
): Promise<RawArtifactReference> {
  const digest = sha256(raw);
  const path = resolve(root, "raw", subdirectory, `${retrievedAt}-${digest.slice(0, 16)}.json`);
  await writeImmutable(path, raw);
  return {
    kind,
    sourceUrl,
    retrievedAt,
    path: relative(root, path).replaceAll("\\", "/"),
    sha256: digest
  };
}

async function verifyArtifact(root: string, artifact: RawArtifactReference): Promise<void> {
  const path = resolve(root, artifact.path);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${artifact.kind} artifact path escapes collector root`);
  }
  const body = await readFile(path);
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== artifact.sha256) throw new Error(`${artifact.kind} artifact checksum mismatch`);
}

async function fetchRaw(
  url: string,
  fetcher: typeof fetch,
  now: () => number,
  timeoutMs: number,
  label: string
): Promise<{ raw: string; retrievedAt: number }> {
  const response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  const raw = await response.text();
  return { raw, retrievedAt: now() };
}

function parseBinanceKlines(raw: string): PriceTargetClosedCandle[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Binance klines are not valid JSON"); }
  if (!Array.isArray(value)) throw new Error("Binance klines must be an array");
  return value.map((row, index) => {
    if (!Array.isArray(row) || row.length < 7) throw new Error(`Binance kline ${index} is malformed`);
    return {
      openTime: timestamp(row[0], `Binance kline ${index} openTime`),
      closeTime: timestamp(row[6], `Binance kline ${index} closeTime`),
      close: positiveNumber(row[4], `Binance kline ${index} close`)
    };
  }).sort((a, b) => a.openTime - b.openTime);
}

function priceLevels(value: unknown, label: string): Array<{ price: number; size: number }> {
  if (!Array.isArray(value)) throw new Error(`book ${label} are missing`);
  return value.map((level, index) => {
    if (!isRecord(level)) throw new Error(`book ${label}[${index}] is malformed`);
    return {
      price: positiveNumber(level.price, `book ${label}[${index}].price`),
      size: positiveNumber(level.size, `book ${label}[${index}].size`)
    };
  });
}

function parseDateFromSlug(slug: string, assetSlug: string): { year: number; month: number; day: number } {
  const match = slug.match(new RegExp(`^${assetSlug}-above-on-([a-z]+)-(\\d{1,2})-(\\d{4})$`));
  if (match === null) throw new Error("event slug does not freeze month/day/year");
  const month = MONTHS.indexOf(match[1].toLowerCase()) + 1;
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || !Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(year)) {
    throw new Error("event slug date is invalid");
  }
  return { year, month, day };
}

function easternNoonUtc(year: number, month: number, day: number): number {
  const nominalUtc = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const zone = formatter.formatToParts(new Date(nominalUtc)).find((part) => part.type === "timeZoneName")?.value;
  const match = zone?.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (match === undefined || match === null) throw new Error("cannot derive America/New_York offset");
  const sign = match[1] === "+" ? 1 : -1;
  const offsetMs = sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  return nominalUtc - offsetMs;
}

function validateRules(rules: string, asset: PriceTargetAsset): void {
  const pair = asset === "BTC" ? "BTC/USDT" : asset === "ETH" ? "ETH/USDT" : "SOL/USDT";
  const required = [
    /Binance 1 minute candle/i,
    /12:00 in the ET timezone/i,
    /final ["“]Close["”] price/i,
    /higher than the price specified/i,
    new RegExp(pair.replace("/", "\\/"), "i")
  ];
  if (required.some((pattern) => !pattern.test(rules))) throw new Error("rules do not match frozen Binance 1m ABOVE semantics");
}

function searchUrl(asset: PriceTargetAsset): string {
  const query = encodeURIComponent(ASSET_CONFIG[asset].query);
  return `https://gamma-api.polymarket.com/public-search?q=${query}&limit_per_type=${PRICE_TARGET_SEARCH_LIMIT}&events_status=active&page=1`;
}

function manifestFile(root: string, manifestId: string): string {
  return resolve(root, "manifests", `${safeSegment(manifestId)}.json`);
}

function stateFile(root: string, manifestId: string): string {
  return resolve(root, "states", `${safeSegment(manifestId)}.json`);
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

async function writeStateAtomically(path: string, state: PriceTargetEpisodeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await BunlessWriteFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function BunlessWriteFile(path: string, body: string): Promise<void> {
  const handle = await open(path, "w");
  try { await handle.writeFile(body, "utf8"); } finally { await handle.close(); }
}

async function listJson(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function stringArray(value: unknown, label: string): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { throw new Error(`${label} is not valid JSON`); }
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (!nonEmptyString(value)) throw new Error(`${label} is missing`);
  return value;
}

function requiredNumericId(value: unknown, label: string): string {
  const result = String(value ?? "");
  if (!/^\d+$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is missing`);
  return value;
}

function timestamp(value: unknown, label: string): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}

function dateTime(value: unknown): number | null {
  if (!nonEmptyString(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe.length === 0 || safe === "." || safe === "..") throw new Error("identifier is unsafe");
  return safe;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown collector failure";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
] as const;

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const watch = args.has("--watch");
  const outputDirectory = process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? "work/price-target-v1";
  do {
    const cycleStartedAt = Date.now();
    const summary = await runPriceTargetCollectorCycle(outputDirectory);
    console.log(JSON.stringify(summary, null, 2));
    if (!watch) break;
    const remaining = Math.max(0, PRICE_TARGET_POLL_INTERVAL_MS - (Date.now() - cycleStartedAt));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, remaining));
  } while (true);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
