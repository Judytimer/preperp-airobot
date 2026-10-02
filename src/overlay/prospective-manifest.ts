import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const PROSPECTIVE_MANIFEST_SCHEMA_VERSION = "1.0.0";
export const PROSPECTIVE_EXECUTION_ASSUMPTION_VERSION = "1.0.0";
export const PROSPECTIVE_PRIMARY_SLIPPAGE_BPS = 50;
export const PROSPECTIVE_SENSITIVITY_SLIPPAGE_BPS = [0, 100] as const;

export type ProspectiveManifestAdmissionStatus =
  | "DATA_READY"
  | "DATA_BLOCKED"
  | "INELIGIBLE";

export type ProspectiveManifestAdmission = {
  readonly status: ProspectiveManifestAdmissionStatus;
  readonly manifestId: string | null;
  readonly reasons: readonly string[];
};

export type ProspectiveManifest = {
  readonly schemaVersion: string;
  readonly manifestId: string;
  readonly registeredAt: number;
  readonly repositoryCommit: string;
  readonly market: {
    readonly marketId: string;
    readonly question: string;
    readonly marketUrl: string;
    readonly rulesUrl: string;
    readonly createdAt: number;
    readonly activeAtRegistration: boolean;
    readonly marketType: string;
    readonly targetFdv: number;
    readonly yesTokenId: string;
  };
  readonly token: {
    readonly symbol: string;
    readonly identifier: string;
    readonly classification: string;
    readonly classificationSourceUrl: string;
  };
  readonly listing: {
    readonly listingAt: number;
    readonly binanceSymbol: string;
    readonly announcementUrl: string;
  };
  readonly supply: {
    readonly totalSupply: number;
    readonly observedAt: number;
    readonly sourceUrl: string;
    readonly verificationMethod: string;
  };
  readonly sources: {
    readonly spot: {
      readonly provider: string;
      readonly interval: string;
      readonly klinesUrl: string;
    };
    readonly yes: {
      readonly provider: string;
      readonly marketDataUrl: string;
    };
  };
  readonly protocol: {
    readonly formalOneMinuteVersion: string;
    readonly strategyImplementation: string;
    readonly spotRiseTriggerPct: number;
    readonly exitYesPrice: number;
    readonly riskImplementation: string;
    readonly maxRiskBudget: number;
  };
  readonly execution: {
    readonly assumptionVersion: string;
    readonly primarySlippageBps: number;
    readonly sensitivitySlippageBps: readonly number[];
    readonly feeModel: string;
    readonly fillSemantics: string;
  };
  readonly outcome: {
    readonly measurementAt: number;
    readonly rule: string;
    readonly rulesCapturedAt: number;
    readonly rulesUrl: string;
  };
};

type FieldRule = {
  path: string;
  valid: (value: unknown) => boolean;
  reason: string;
};

const REQUIRED_FIELDS: readonly FieldRule[] = [
  stringField("schemaVersion"),
  stringField("manifestId"),
  timestampField("registeredAt"),
  { path: "repositoryCommit", valid: (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value), reason: "repositoryCommit must be a full lowercase git commit" },
  stringField("market.marketId"),
  stringField("market.question"),
  httpsField("market.marketUrl"),
  httpsField("market.rulesUrl"),
  timestampField("market.createdAt"),
  { path: "market.activeAtRegistration", valid: (value) => typeof value === "boolean", reason: "market.activeAtRegistration must be boolean" },
  stringField("market.marketType"),
  positiveField("market.targetFdv"),
  stringField("market.yesTokenId"),
  stringField("token.symbol"),
  stringField("token.identifier"),
  stringField("token.classification"),
  httpsField("token.classificationSourceUrl"),
  timestampField("listing.listingAt"),
  { path: "listing.binanceSymbol", valid: (value) => typeof value === "string" && /^[A-Z0-9]+USDT$/.test(value), reason: "listing.binanceSymbol must be an uppercase USDT spot symbol" },
  httpsField("listing.announcementUrl"),
  positiveField("supply.totalSupply"),
  timestampField("supply.observedAt"),
  httpsField("supply.sourceUrl"),
  stringField("supply.verificationMethod"),
  stringField("sources.spot.provider"),
  stringField("sources.spot.interval"),
  httpsField("sources.spot.klinesUrl"),
  stringField("sources.yes.provider"),
  { path: "sources.yes.marketDataUrl", valid: isWssUrl, reason: "sources.yes.marketDataUrl must be a valid wss URL" },
  stringField("protocol.formalOneMinuteVersion"),
  stringField("protocol.strategyImplementation"),
  positiveField("protocol.spotRiseTriggerPct"),
  positiveField("protocol.exitYesPrice"),
  stringField("protocol.riskImplementation"),
  positiveField("protocol.maxRiskBudget"),
  stringField("execution.assumptionVersion"),
  nonNegativeField("execution.primarySlippageBps"),
  {
    path: "execution.sensitivitySlippageBps",
    valid: (value) => Array.isArray(value) && value.every(nonNegativeFinite),
    reason: "execution.sensitivitySlippageBps must be an array of non-negative finite numbers"
  },
  stringField("execution.feeModel"),
  stringField("execution.fillSemantics"),
  timestampField("outcome.measurementAt"),
  stringField("outcome.rule"),
  timestampField("outcome.rulesCapturedAt"),
  httpsField("outcome.rulesUrl")
];

const CREDENTIAL_FIELD_NAMES = new Set([
  "apikey",
  "apisecret",
  "authorization",
  "password",
  "passphrase",
  "privatekey",
  "secret"
]);

export function evaluateProspectiveManifest(value: unknown): ProspectiveManifestAdmission {
  const manifestId = isRecord(value) && nonEmptyString(value.manifestId)
    ? value.manifestId
    : null;
  if (!isRecord(value)) {
    return blocked(manifestId, ["manifest must be a JSON object"]);
  }

  const blockedReasons = REQUIRED_FIELDS
    .filter((rule) => !rule.valid(readPath(value, rule.path)))
    .map((rule) => rule.reason);
  const credentialPaths = findCredentialFields(value);
  if (credentialPaths.length > 0) {
    blockedReasons.push(`credential fields are forbidden: ${credentialPaths.join(", ")}`);
  }
  if (blockedReasons.length > 0) return blocked(manifestId, blockedReasons);

  const manifest = value as unknown as ProspectiveManifest;
  const contradictions = chronologicalContradictions(manifest);
  if (contradictions.length > 0) return blocked(manifestId, contradictions);

  const ineligibleReasons = eligibilityReasons(manifest);
  if (ineligibleReasons.length > 0) {
    return { status: "INELIGIBLE", manifestId, reasons: ineligibleReasons };
  }

  return { status: "DATA_READY", manifestId, reasons: [] };
}

export async function loadProspectiveManifest(path: string): Promise<ProspectiveManifestAdmission> {
  try {
    const raw = await readFile(path, "utf8");
    return evaluateProspectiveManifest(JSON.parse(raw));
  } catch (error) {
    return blocked(null, [error instanceof SyntaxError
      ? "manifest is not valid JSON"
      : "manifest file could not be read"]);
  }
}

function chronologicalContradictions(manifest: ProspectiveManifest): string[] {
  const reasons: string[] = [];
  if (manifest.market.createdAt > manifest.registeredAt) {
    reasons.push("market.createdAt cannot be after registeredAt");
  }
  if (manifest.supply.observedAt > manifest.registeredAt) {
    reasons.push("supply.observedAt cannot be after registeredAt");
  }
  if (manifest.outcome.rulesCapturedAt > manifest.registeredAt) {
    reasons.push("outcome.rulesCapturedAt cannot be after registeredAt");
  }
  return reasons;
}

function eligibilityReasons(manifest: ProspectiveManifest): string[] {
  const reasons: string[] = [];
  if (manifest.schemaVersion !== PROSPECTIVE_MANIFEST_SCHEMA_VERSION) {
    reasons.push("unsupported manifest schemaVersion");
  }
  if (manifest.registeredAt >= manifest.listing.listingAt) {
    reasons.push("manifest was not registered before listingAt");
  }
  if (!manifest.market.activeAtRegistration) {
    reasons.push("market was not active at registration");
  }
  if (manifest.market.marketType !== "FDV_AFTER_LAUNCH") {
    reasons.push("marketType is not FDV_AFTER_LAUNCH");
  }
  if (manifest.token.classification !== "MEME") {
    reasons.push("token classification is not MEME");
  }
  if (!isAllowedSupplyMethod(manifest.supply.verificationMethod)) {
    reasons.push("supply verification method is not allowed");
  }
  if (manifest.sources.spot.provider !== "BINANCE_SPOT") {
    reasons.push("spot provider is not BINANCE_SPOT");
  }
  if (manifest.sources.spot.interval !== "1m") {
    reasons.push("spot interval is not 1m");
  }
  if (!isMatchingBinanceKlinesUrl(manifest.sources.spot.klinesUrl, manifest.listing.binanceSymbol)) {
    reasons.push("spot kline locator is not the frozen Binance 1m request");
  }
  if (manifest.sources.yes.provider !== "POLYMARKET_LAST_TRADE") {
    reasons.push("YES provider is not POLYMARKET_LAST_TRADE");
  }
  if (manifest.sources.yes.marketDataUrl !== "wss://ws-subscriptions-clob.polymarket.com/ws/market") {
    reasons.push("YES market data locator is not the public Polymarket market stream");
  }
  if (!isPolymarketUrl(manifest.market.marketUrl) || !isPolymarketUrl(manifest.market.rulesUrl)) {
    reasons.push("market and rules URLs must be Polymarket URLs");
  }
  if (manifest.protocol.formalOneMinuteVersion !== "1.0.0") {
    reasons.push("Formal 1m protocol version is not 1.0.0");
  }
  if (
    manifest.protocol.strategyImplementation !== "MemePredictionOverlayStrategy" ||
    manifest.protocol.spotRiseTriggerPct !== 0.5 ||
    manifest.protocol.exitYesPrice !== 0.7
  ) {
    reasons.push("Strategy implementation or frozen parameters differ");
  }
  if (
    manifest.protocol.riskImplementation !== "OverlayRiskManager" ||
    manifest.protocol.maxRiskBudget !== 100
  ) {
    reasons.push("Risk implementation or frozen budget differs");
  }
  if (
    manifest.execution.assumptionVersion !== PROSPECTIVE_EXECUTION_ASSUMPTION_VERSION ||
    manifest.execution.primarySlippageBps !== PROSPECTIVE_PRIMARY_SLIPPAGE_BPS ||
    !sameNumbers(
      manifest.execution.sensitivitySlippageBps,
      PROSPECTIVE_SENSITIVITY_SLIPPAGE_BPS
    ) ||
    manifest.execution.feeModel !== "ZERO" ||
    manifest.execution.fillSemantics !== "FULL_FILL_LIMITATION"
  ) {
    reasons.push("Execution assumptions differ from frozen prospective profile");
  }
  if (manifest.outcome.measurementAt <= manifest.listing.listingAt) {
    reasons.push("outcome measurementAt must be after listingAt");
  }
  if (manifest.outcome.rulesCapturedAt >= manifest.listing.listingAt) {
    reasons.push("outcome rule was not captured before listingAt");
  }
  return reasons;
}

function isMatchingBinanceKlinesUrl(value: string, symbol: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["api.binance.com", "data-api.binance.vision"].includes(url.hostname) &&
      url.pathname === "/api/v3/klines" &&
      url.searchParams.get("symbol") === symbol &&
      url.searchParams.get("interval") === "1m"
    );
  } catch {
    return false;
  }
}

function isPolymarketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "polymarket.com" || url.hostname.endsWith(".polymarket.com"));
  } catch {
    return false;
  }
}

function isAllowedSupplyMethod(value: string): boolean {
  return value === "ONCHAIN_TOTAL_SUPPLY" || value === "OFFICIAL_TOKENOMICS";
}

function findCredentialFields(value: unknown, path = "$", found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((child, index) => findCredentialFields(child, `${path}[${index}]`, found));
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_FIELD_NAMES.has(key.toLowerCase())) found.push(`${path}.${key}`);
    findCredentialFields(child, `${path}.${key}`, found);
  }
  return found;
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function stringField(path: string): FieldRule {
  return { path, valid: nonEmptyString, reason: `${path} must be a non-empty string` };
}

function timestampField(path: string): FieldRule {
  return { path, valid: nonNegativeFinite, reason: `${path} must be a non-negative finite timestamp` };
}

function positiveField(path: string): FieldRule {
  return { path, valid: positiveFinite, reason: `${path} must be positive and finite` };
}

function nonNegativeField(path: string): FieldRule {
  return { path, valid: nonNegativeFinite, reason: `${path} must be non-negative and finite` };
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function httpsField(path: string): FieldRule {
  return { path, valid: isHttpsUrl, reason: `${path} must be a valid https URL` };
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

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isWssUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "wss:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocked(manifestId: string | null, reasons: readonly string[]): ProspectiveManifestAdmission {
  return { status: "DATA_BLOCKED", manifestId, reasons };
}

async function main(): Promise<void> {
  const path = process.argv[2];
  const result = path === undefined
    ? blocked(null, ["usage: npm run manifest:check -- <candidate.json>"])
    : await loadProspectiveManifest(path);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "DATA_READY") process.exitCode = 2;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
