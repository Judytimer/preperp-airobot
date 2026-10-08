import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const PRICE_TARGET_MANIFEST_SCHEMA_VERSION = "1.0.0" as const;
export const PRICE_TARGET_STATE_SCHEMA_VERSION = "1.0.0" as const;
export const PRICE_TARGET_PROTOCOL_VERSION = "PRICE_TARGET_ADMISSION_V1_1_0" as const;
export const PRICE_TARGET_LEGACY_PROTOCOL_VERSION = "PRICE_TARGET_ADMISSION_V1_0_0" as const;
export const PRICE_TARGET_PRIMARY_HORIZON_MS = 4 * 60 * 60_000;
export const PRICE_TARGET_BOOK_MAX_STALENESS_MS = 120_000;
export const PRICE_TARGET_CANDLE_INTERVAL_MS = 60_000;

export type PriceTargetAsset = "BTC" | "ETH" | "SOL" | "XRP";
export type PriceTargetCohort =
  | "PRICE_TARGET_V1_BTC"
  | "PRICE_TARGET_V1_ETH"
  | "PRICE_TARGET_V1_SOL"
  | "PRICE_TARGET_V1_XRP";
export type PriceTargetResolutionSymbol = "BTCUSDT" | "ETHUSDT" | "SOLUSDT" | "XRPUSDT";
export type PriceTargetProtocolVersion =
  | typeof PRICE_TARGET_PROTOCOL_VERSION
  | typeof PRICE_TARGET_LEGACY_PROTOCOL_VERSION;
export type PriceTargetAdmissionStatus =
  | "REGISTERED_WAITING_TRIGGER"
  | "QUALIFIED"
  | "DATA_BLOCKED"
  | "NOT_TRIGGERED_BEFORE_CUTOFF";

export type RawArtifactReference = {
  readonly kind: "POLYMARKET_GAMMA" | "BINANCE_SPOT_KLINES" | "POLYMARKET_CLOB_BOOK";
  readonly sourceUrl: string;
  readonly retrievedAt: number;
  readonly path: string;
  readonly sha256: string;
};

export type PriceTargetClosedCandle = {
  readonly openTime: number;
  readonly closeTime: number;
  readonly close: number;
};

export type PriceTargetBookSnapshot = {
  readonly observedAt: number;
  readonly retrievedAt: number;
  readonly marketId: string;
  readonly yesAssetId: string;
  readonly bestBid: number | null;
  readonly bestBidSize: number | null;
  readonly bestAsk: number | null;
  readonly bestAskSize: number | null;
  readonly minOrderSize: number;
  readonly tickSize: number;
  readonly hash: string;
  readonly artifact: RawArtifactReference;
};

export type PriceTargetMarketStatusSnapshot = {
  readonly observedAt: number;
  readonly marketId: string;
  readonly active: boolean;
  readonly closed: boolean;
  readonly acceptingOrders: boolean;
  readonly enableOrderBook: boolean;
  readonly artifact: RawArtifactReference;
};

export type PriceTargetManifest = {
  readonly schemaVersion: typeof PRICE_TARGET_MANIFEST_SCHEMA_VERSION;
  readonly protocolVersion: PriceTargetProtocolVersion;
  readonly manifestId: string;
  readonly repositoryCommit: string;
  readonly cohortKey: PriceTargetCohort;
  readonly discoveredAt: number;
  readonly registeredAt: number;
  readonly episode: {
    readonly episodeKey: string;
    readonly asset: PriceTargetAsset;
    readonly resolutionVenue: "BINANCE_SPOT";
    readonly resolutionSymbol: PriceTargetResolutionSymbol;
    readonly measurementAt: number;
    readonly cutoffT0: number;
  };
  readonly ownerEvent: {
    readonly eventId: string;
    readonly slug: string;
    readonly title: string;
    readonly rules: string;
    readonly rawDiscovery: RawArtifactReference;
  };
  readonly registration: {
    readonly spotCandle: PriceTargetClosedCandle;
    readonly spotArtifact: RawArtifactReference;
    readonly registrationSpot: number;
    readonly completeStrikeLadder: readonly {
      readonly marketId: string;
      readonly question: string;
      readonly strike: number;
      readonly yesAssetId: string;
      readonly active: boolean;
      readonly closed: boolean;
      readonly acceptingOrders: boolean;
      readonly enableOrderBook: boolean;
    }[];
    readonly selectedStrike: number;
    readonly selectedMarketId: string;
    readonly selectedQuestion: string;
    readonly yesAssetId: string;
  };
};

export type PriceTargetEpisodeState = {
  readonly schemaVersion: typeof PRICE_TARGET_STATE_SCHEMA_VERSION;
  readonly manifestId: string;
  readonly status: PriceTargetAdmissionStatus;
  readonly updatedAt: number;
  readonly candles: readonly PriceTargetClosedCandle[];
  readonly books: readonly PriceTargetBookSnapshot[];
  readonly marketStatuses: readonly PriceTargetMarketStatusSnapshot[];
  readonly artifacts: readonly RawArtifactReference[];
  readonly candidate: null | {
    readonly candidateId: string;
    readonly candidateT0: number;
    readonly crossingPreviousClose: number;
    readonly crossingClose: number;
    readonly selectedStrike: number;
    readonly entryBestAsk: number;
    readonly entryBestAskSize: number;
    readonly yesBookObservedAt: number;
  };
  readonly reasons: readonly string[];
};

export type PriceTargetManifestAdmission = {
  readonly status: "DATA_READY" | "DATA_BLOCKED" | "INELIGIBLE";
  readonly manifestId: string | null;
  readonly reasons: readonly string[];
};

export function evaluatePriceTargetManifest(value: unknown): PriceTargetManifestAdmission {
  if (!isRecord(value)) return blocked(null, ["manifest must be a JSON object"]);
  const manifestId = nonEmptyString(value.manifestId) ? value.manifestId : null;
  const dataReasons: string[] = [];
  const eligibilityReasons: string[] = [];
  const credentialFields = findCredentialFields(value);
  if (credentialFields.length > 0) {
    dataReasons.push(`credential fields are forbidden: ${credentialFields.join(", ")}`);
  }
  if (value.schemaVersion !== PRICE_TARGET_MANIFEST_SCHEMA_VERSION) dataReasons.push("unsupported schemaVersion");
  if (
    value.protocolVersion !== PRICE_TARGET_PROTOCOL_VERSION &&
    value.protocolVersion !== PRICE_TARGET_LEGACY_PROTOCOL_VERSION
  ) eligibilityReasons.push("protocolVersion is not a supported frozen Price-Target protocol");
  if (!manifestId || !/^[A-Za-z0-9._-]+$/.test(manifestId)) dataReasons.push("manifestId is invalid");
  if (!nonEmptyString(value.repositoryCommit) || !/^[0-9a-f]{40}$/.test(value.repositoryCommit)) {
    dataReasons.push("repositoryCommit must be a 40-character lowercase commit SHA");
  }
  if (!nonNegativeFinite(value.discoveredAt) || !nonNegativeFinite(value.registeredAt)) {
    dataReasons.push("discoveredAt and registeredAt must be non-negative timestamps");
  } else if (value.registeredAt < value.discoveredAt) {
    dataReasons.push("registeredAt cannot precede discoveredAt");
  }
  if (!isRecord(value.episode)) {
    dataReasons.push("episode is missing");
  } else {
    validateEpisode(value.episode, value.cohortKey, value.protocolVersion, dataReasons, eligibilityReasons);
  }
  if (!isRecord(value.ownerEvent)) {
    dataReasons.push("ownerEvent is missing");
  } else {
    if (!numericId(value.ownerEvent.eventId)) dataReasons.push("ownerEvent.eventId must be numeric");
    for (const field of ["slug", "title", "rules"] as const) {
      if (!nonEmptyString(value.ownerEvent[field])) dataReasons.push(`ownerEvent.${field} is required`);
    }
    validateArtifact(value.ownerEvent.rawDiscovery, "POLYMARKET_GAMMA", dataReasons);
  }
  if (!isRecord(value.registration)) {
    dataReasons.push("registration is missing");
  } else {
    validateRegistration(value.registration, value.discoveredAt, dataReasons, eligibilityReasons);
  }
  if (dataReasons.length > 0) return blocked(manifestId, dataReasons);
  if (eligibilityReasons.length > 0) return { status: "INELIGIBLE", manifestId, reasons: eligibilityReasons };
  return { status: "DATA_READY", manifestId, reasons: [] };
}

export async function loadPriceTargetManifest(path: string): Promise<PriceTargetManifestAdmission> {
  try {
    return evaluatePriceTargetManifest(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return blocked(null, ["manifest is not valid JSON"]);
  }
}

export function evaluatePriceTargetEpisode(
  manifest: PriceTargetManifest,
  state: PriceTargetEpisodeState,
  asOf: number
): PriceTargetEpisodeState {
  const manifestAdmission = evaluatePriceTargetManifest(manifest);
  if (manifestAdmission.status !== "DATA_READY") {
    return terminalState(state, asOf, "DATA_BLOCKED", manifestAdmission.reasons);
  }
  if (state.manifestId !== manifest.manifestId) {
    return terminalState(state, asOf, "DATA_BLOCKED", ["state manifestId does not match manifest"]);
  }
  if (
    state.schemaVersion !== PRICE_TARGET_STATE_SCHEMA_VERSION || !Array.isArray(state.candles) ||
    !Array.isArray(state.books) || !Array.isArray(state.marketStatuses) || !Array.isArray(state.artifacts) ||
    !Array.isArray(state.reasons)
  ) {
    return terminalState(state, asOf, "DATA_BLOCKED", ["state shape or schemaVersion is invalid"]);
  }
  if (isTerminal(state.status)) return state;
  if (!nonNegativeFinite(asOf) || asOf < manifest.registeredAt) {
    return terminalState(state, asOf, "DATA_BLOCKED", ["collector asOf is before registration"]);
  }

  const candles = canonicalCandles(manifest, state.candles);
  if (candles.error !== null) {
    return terminalState(state, asOf, "DATA_BLOCKED", [candles.error]);
  }
  const strike = manifest.registration.selectedStrike;
  let crossing: { previous: PriceTargetClosedCandle; current: PriceTargetClosedCandle } | null = null;
  for (let index = 1; index < candles.values.length; index += 1) {
    const previous = candles.values[index - 1];
    const current = candles.values[index];
    const candidateT0 = current.openTime + PRICE_TARGET_CANDLE_INTERVAL_MS;
    if (candidateT0 <= manifest.registeredAt) continue;
    if (previous.close < strike && current.close >= strike) {
      crossing = { previous, current };
      break;
    }
  }

  if (crossing === null) {
    return asOf >= manifest.episode.cutoffT0
      ? terminalState(state, asOf, "NOT_TRIGGERED_BEFORE_CUTOFF", ["no upward crossing before cutoffT0"])
      : { ...state, updatedAt: asOf, reasons: [] };
  }

  const candidateT0 = crossing.current.openTime + PRICE_TARGET_CANDLE_INTERVAL_MS;
  // This is the only cutoff formula. Equality is deliberately not admitted.
  if (!(candidateT0 < manifest.episode.cutoffT0)) {
    return terminalState(state, asOf, "NOT_TRIGGERED_BEFORE_CUTOFF", [
      "first upward crossing does not satisfy candidateT0 < measurementAt - 4h"
    ]);
  }
  const book = latestAtOrBefore(state.books, candidateT0, (item) => item.observedAt);
  if (book === null) return terminalState(state, asOf, "DATA_BLOCKED", ["no archived pre-T0 YES book"]);
  if (candidateT0 - book.observedAt > PRICE_TARGET_BOOK_MAX_STALENESS_MS) {
    return terminalState(state, asOf, "DATA_BLOCKED", ["latest archived pre-T0 YES book is older than 120s"]);
  }
  const bookReasons = validateExecutableBook(book, manifest);
  if (bookReasons.length > 0) return terminalState(state, asOf, "DATA_BLOCKED", bookReasons);
  const marketStatus = latestAtOrBefore(state.marketStatuses, candidateT0, (item) => item.observedAt);
  if (marketStatus === null) {
    return terminalState(state, asOf, "DATA_BLOCKED", ["no archived pre-T0 market status"]);
  }
  if (
    marketStatus.marketId !== manifest.registration.selectedMarketId ||
    !marketStatus.active || marketStatus.closed || !marketStatus.acceptingOrders || !marketStatus.enableOrderBook
  ) {
    return terminalState(state, asOf, "DATA_BLOCKED", ["selected market was not active and order-enabled at T0"]);
  }

  return {
    ...state,
    status: "QUALIFIED",
    updatedAt: asOf,
    candidate: {
      candidateId: `PTV1-${manifest.episode.asset}-${candidateT0}-${manifest.registration.selectedMarketId}`,
      candidateT0,
      crossingPreviousClose: crossing.previous.close,
      crossingClose: crossing.current.close,
      selectedStrike: strike,
      entryBestAsk: book.bestAsk as number,
      entryBestAskSize: book.bestAskSize as number,
      yesBookObservedAt: book.observedAt
    },
    reasons: []
  };
}

export function newPriceTargetState(manifestId: string, registeredAt: number): PriceTargetEpisodeState {
  return {
    schemaVersion: PRICE_TARGET_STATE_SCHEMA_VERSION,
    manifestId,
    status: "REGISTERED_WAITING_TRIGGER",
    updatedAt: registeredAt,
    candles: [],
    books: [],
    marketStatuses: [],
    artifacts: [],
    candidate: null,
    reasons: []
  };
}

function validateEpisode(
  episode: Record<string, unknown>,
  cohort: unknown,
  protocolVersion: unknown,
  dataReasons: string[],
  eligibilityReasons: string[]
): void {
  const asset = episode.asset;
  const expected = asset === "BTC"
    ? { symbol: "BTCUSDT", cohort: "PRICE_TARGET_V1_BTC" }
    : asset === "ETH"
      ? { symbol: "ETHUSDT", cohort: "PRICE_TARGET_V1_ETH" }
      : asset === "SOL"
        ? { symbol: "SOLUSDT", cohort: "PRICE_TARGET_V1_SOL" }
        : asset === "XRP"
          ? { symbol: "XRPUSDT", cohort: "PRICE_TARGET_V1_XRP" }
          : null;
  if (expected === null) eligibilityReasons.push("asset is outside the registered Price-Target asset universe");
  if (asset === "XRP" && protocolVersion === PRICE_TARGET_LEGACY_PROTOCOL_VERSION) {
    eligibilityReasons.push("XRP requires Price-Target Admission v1.1 or later");
  }
  if (episode.resolutionVenue !== "BINANCE_SPOT") eligibilityReasons.push("resolutionVenue must be BINANCE_SPOT");
  if (expected !== null && episode.resolutionSymbol !== expected.symbol) eligibilityReasons.push("resolutionSymbol does not match asset");
  if (expected !== null && cohort !== expected.cohort) eligibilityReasons.push("cohortKey does not match asset");
  if (!nonEmptyString(episode.episodeKey)) dataReasons.push("episode.episodeKey is required");
  if (!nonNegativeFinite(episode.measurementAt) || !nonNegativeFinite(episode.cutoffT0)) {
    dataReasons.push("measurementAt and cutoffT0 must be timestamps");
  } else if (episode.cutoffT0 !== episode.measurementAt - PRICE_TARGET_PRIMARY_HORIZON_MS) {
    eligibilityReasons.push("cutoffT0 must equal measurementAt - 4h exactly");
  }
}

function validateRegistration(
  registration: Record<string, unknown>,
  discoveredAt: unknown,
  dataReasons: string[],
  eligibilityReasons: string[]
): void {
  if (!isRecord(registration.spotCandle)) {
    dataReasons.push("registration.spotCandle is missing");
  } else {
    validateCandle(registration.spotCandle, dataReasons, "registration.spotCandle");
    if (
      nonNegativeFinite(discoveredAt) && nonNegativeFinite(registration.spotCandle.closeTime) &&
      registration.spotCandle.closeTime >= discoveredAt
    ) {
      eligibilityReasons.push("registration Spot candle must be fully closed before discoveredAt");
    }
    if (positiveFinite(registration.registrationSpot) && registration.registrationSpot !== registration.spotCandle.close) {
      dataReasons.push("registrationSpot does not equal registration candle close");
    }
  }
  validateArtifact(registration.spotArtifact, "BINANCE_SPOT_KLINES", dataReasons);
  if (!Array.isArray(registration.completeStrikeLadder) || registration.completeStrikeLadder.length === 0) {
    dataReasons.push("completeStrikeLadder must be non-empty");
    return;
  }
  const ladder: Array<{
    marketId: string;
    question: string;
    strike: number;
    yesAssetId: string;
    active: boolean;
    closed: boolean;
    acceptingOrders: boolean;
    enableOrderBook: boolean;
  }> = [];
  for (const [index, item] of registration.completeStrikeLadder.entries()) {
    if (!isRecord(item) || !nonEmptyString(item.marketId) || !nonEmptyString(item.question) ||
      !positiveFinite(item.strike) || !nonEmptyString(item.yesAssetId) ||
      typeof item.active !== "boolean" || typeof item.closed !== "boolean" ||
      typeof item.acceptingOrders !== "boolean" || typeof item.enableOrderBook !== "boolean") {
      dataReasons.push(`completeStrikeLadder[${index}] is invalid`);
      continue;
    }
    ladder.push({
      marketId: item.marketId,
      question: item.question,
      strike: item.strike,
      yesAssetId: item.yesAssetId,
      active: item.active,
      closed: item.closed,
      acceptingOrders: item.acceptingOrders,
      enableOrderBook: item.enableOrderBook
    });
  }
  const uniqueStrikes = new Set(ladder.map((item) => item.strike));
  if (uniqueStrikes.size !== ladder.length) dataReasons.push("completeStrikeLadder contains duplicate strikes");
  if (!positiveFinite(registration.registrationSpot)) dataReasons.push("registrationSpot must be positive");
  const nearest = positiveFinite(registration.registrationSpot)
    ? ladder.filter((item) =>
      item.strike > registration.registrationSpot && item.active && !item.closed &&
      item.acceptingOrders && item.enableOrderBook
    ).sort((a, b) => a.strike - b.strike)[0]
    : undefined;
  if (nearest === undefined) {
    eligibilityReasons.push("no strictly OTM ABOVE strike exists at registration");
  } else if (
    registration.selectedStrike !== nearest.strike ||
    registration.selectedMarketId !== nearest.marketId ||
    registration.selectedQuestion !== nearest.question ||
    registration.yesAssetId !== nearest.yesAssetId
  ) {
    eligibilityReasons.push("selected contract is not the frozen nearest-OTM strike");
  }
}

function canonicalCandles(
  manifest: PriceTargetManifest,
  values: readonly PriceTargetClosedCandle[]
): { readonly values: readonly PriceTargetClosedCandle[]; readonly error: string | null } {
  const sorted = [manifest.registration.spotCandle, ...values]
    .map((item) => ({ ...item }))
    .sort((a, b) => a.openTime - b.openTime);
  const deduplicated: PriceTargetClosedCandle[] = [];
  for (const candle of sorted) {
    const reasons: string[] = [];
    validateCandle(candle as unknown as Record<string, unknown>, reasons, "candle");
    if (reasons.length > 0) return { values: [], error: reasons.join("; ") };
    const previous = deduplicated.at(-1);
    if (previous?.openTime === candle.openTime) {
      if (previous.closeTime !== candle.closeTime || previous.close !== candle.close) {
        return { values: [], error: "conflicting duplicate Spot candle" };
      }
      continue;
    }
    if (previous !== undefined && candle.openTime !== previous.openTime + PRICE_TARGET_CANDLE_INTERVAL_MS) {
      return { values: [], error: "Spot 1m archive has a gap before trigger evaluation" };
    }
    deduplicated.push(candle);
  }
  return { values: deduplicated, error: null };
}

function validateCandle(value: Record<string, unknown>, reasons: string[], label: string): void {
  if (!nonNegativeFinite(value.openTime) || !nonNegativeFinite(value.closeTime) || !positiveFinite(value.close)) {
    reasons.push(`${label} fields are invalid`);
    return;
  }
  if (value.closeTime !== value.openTime + PRICE_TARGET_CANDLE_INTERVAL_MS - 1) {
    reasons.push(`${label} is not an exact closed 1m candle`);
  }
}

function validateExecutableBook(book: PriceTargetBookSnapshot, manifest: PriceTargetManifest): string[] {
  const reasons: string[] = [];
  if (book.marketId !== manifest.registration.selectedMarketId || book.yesAssetId !== manifest.registration.yesAssetId) {
    reasons.push("YES book identity differs from frozen selected market");
  }
  if (
    book.bestBid === null || book.bestAsk === null || book.bestBidSize === null || book.bestAskSize === null ||
    !positiveFinite(book.bestBid) || !positiveFinite(book.bestAsk) ||
    book.bestBid >= 1 || book.bestAsk >= 1 || book.bestBid > book.bestAsk
  ) {
    reasons.push("YES book is not two-sided inside (0,1)");
  }
  if (!positiveFinite(book.minOrderSize) || !positiveFinite(book.tickSize)) reasons.push("YES book trading constraints are invalid");
  if (book.bestAskSize === null || book.bestAskSize < book.minOrderSize) {
    reasons.push("best ask cannot execute venue minOrderSize");
  }
  return reasons;
}

function validateArtifact(value: unknown, kind: RawArtifactReference["kind"], reasons: string[]): void {
  if (!isRecord(value)) {
    reasons.push(`${kind} artifact is missing`);
    return;
  }
  if (value.kind !== kind || !nonEmptyString(value.sourceUrl) || !nonNegativeFinite(value.retrievedAt) ||
    !nonEmptyString(value.path) || !nonEmptyString(value.sha256) || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    reasons.push(`${kind} artifact is invalid`);
    return;
  }
  try {
    const url = new URL(value.sourceUrl);
    const valid = kind === "POLYMARKET_GAMMA"
      ? url.protocol === "https:" && url.hostname === "gamma-api.polymarket.com"
      : kind === "BINANCE_SPOT_KLINES"
        ? url.protocol === "https:" && url.hostname === "api.binance.com" && url.pathname === "/api/v3/klines"
        : url.protocol === "https:" && url.hostname === "clob.polymarket.com" && url.pathname === "/book";
    if (!valid) reasons.push(`${kind} artifact source URL is not the frozen public endpoint`);
  } catch {
    reasons.push(`${kind} artifact source URL is invalid`);
  }
}

function latestAtOrBefore<T>(values: readonly T[], boundary: number, timestamp: (value: T) => number): T | null {
  return values.reduce<T | null>((latest, value) => {
    const observedAt = timestamp(value);
    if (observedAt > boundary) return latest;
    return latest === null || timestamp(latest) < observedAt ? value : latest;
  }, null);
}

function terminalState(
  state: PriceTargetEpisodeState,
  updatedAt: number,
  status: Exclude<PriceTargetAdmissionStatus, "REGISTERED_WAITING_TRIGGER" | "QUALIFIED">,
  reasons: readonly string[]
): PriceTargetEpisodeState {
  return { ...state, status, updatedAt, candidate: null, reasons: [...reasons] };
}

function isTerminal(status: PriceTargetAdmissionStatus): boolean {
  return status !== "REGISTERED_WAITING_TRIGGER";
}

function blocked(manifestId: string | null, reasons: readonly string[]): PriceTargetManifestAdmission {
  return { status: "DATA_BLOCKED", manifestId, reasons };
}

function numericId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CREDENTIAL_FIELDS = new Set([
  "apikey", "apisecret", "authorization", "password", "passphrase", "privatekey", "secret", "token"
]);

function findCredentialFields(value: unknown, path = "$", found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findCredentialFields(item, `${path}[${index}]`, found));
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
  const path = process.argv[2];
  const result = path === undefined
    ? blocked(null, ["usage: npm run price-target:manifest -- <manifest.json>"])
    : await loadPriceTargetManifest(path);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "DATA_READY") process.exitCode = 2;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
