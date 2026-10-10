import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { resolveRepositoryCommit } from "../build-identity.ts";

import {
  BinanceUsdsTestnetMarketFeed,
  BinanceUsdsTestnetVenue,
  OfficialBinanceUsdsTestnetTransport
} from "../binance-testnet.ts";
import { PerpBot } from "../bot.ts";
import { ObservedExecutionVenue } from "../closure-smoke.ts";
import type { PerpSignalSource } from "../strategy.ts";
import { JsonFileBotStateStore } from "../state-store.ts";
import type { Position, Signal, Tick } from "../types.ts";
import { validateFlatPreflight } from "../perp-testnet-validation.ts";
import type { ExchangeStateSnapshot, ReconciliationReport } from "../reconciliation.ts";
import { runtimeEvidencePath, runtimeStatePath } from "../runtime-paths.ts";
import type { PriceTargetAsset } from "./price-target-admission.ts";
import {
  synchronizePriceTargetClock
} from "./price-target-collector.ts";
import {
  findFirstNewCandidate,
  type ProspectivePaperCandidate
} from "./prospective-paper-smoke.ts";
import {
  findFirstNewHourlyCandidate,
  type HourlyUpDownAsset,
  type HourlyUpDownCandidate
} from "./hourly-up-down-collector.ts";

export const TESTNET_DEMO_MAPPING_VERSION = "TESTNET_DEMO_ONLY_V1" as const;
const DEFAULT_OUTPUT_DIRECTORY = runtimeEvidencePath("price-target-v1");
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const STATUS_PATH = runtimeStatePath("prediction-testnet-demo-status.json");
const HOURLY_OUTPUT_DIRECTORY = runtimeEvidencePath("up-down-v1");
const ROUND_TRIP_TIMEOUT_MS = 90_000;
const RECONCILIATION_TIMEOUT_MS = 20_000;

export type PredictionDemoAsset = PriceTargetAsset | HourlyUpDownAsset;
export type TestnetPredictionCandidate = ProspectivePaperCandidate | HourlyUpDownCandidate;

export type TestnetDemoMapping = {
  readonly version: typeof TESTNET_DEMO_MAPPING_VERSION;
  readonly asset: PredictionDemoAsset;
  readonly canonicalSymbol: `${PredictionDemoAsset}-PERP`;
  readonly venueSymbol: `${PredictionDemoAsset}USDT`;
  readonly side: "LONG" | "SHORT";
  readonly quantity: number;
  readonly purpose: "EXECUTION_SMOKE_ONLY";
  readonly directionalEdgeClaim: false;
};

export type ProspectiveTestnetDemoReport = {
  readonly status: "ROUND_TRIP_COMPLETE";
  readonly mode: "BINANCE_FUTURES_TESTNET";
  readonly candidate: TestnetPredictionCandidate;
  readonly mapping: TestnetDemoMapping;
  readonly repositoryCommit: string;
  readonly marketTicks: number;
  readonly preflight: { readonly snapshot: ExchangeStateSnapshot; readonly reconciliation: ReconciliationReport };
  readonly submissions: ReturnType<ObservedExecutionVenue["getSubmissions"]>;
  readonly acknowledgements: ReturnType<ObservedExecutionVenue["getAcknowledgements"]>;
  readonly fills: ReturnType<ObservedExecutionVenue["getFills"]>;
  readonly openedPosition: Position;
  readonly finalLocalPosition: Position;
  readonly totalFees: number;
  readonly final: { readonly snapshot: ExchangeStateSnapshot; readonly reconciliation: ReconciliationReport };
};

export type PredictionTestnetDemoStatus = {
  readonly phase: "ARMED_WAITING_CANDIDATE" | "EXECUTING" | "ROUND_TRIP_COMPLETE" | "FAILED_REVIEW_REQUIRED";
  readonly updatedAt: number;
  readonly armedAt: number;
  readonly candidateRule: "candidateT0 > armedAt";
  readonly allowedAssets: readonly PredictionDemoAsset[];
  readonly candidateId?: string;
  readonly venueSymbol?: TestnetDemoMapping["venueSymbol"];
  readonly evidencePath?: string;
  readonly detail?: string;
};

export class CandidateTestnetDemoSignal implements PerpSignalSource {
  private exitRequested = false;
  private readonly candidateId: string;
  private readonly entryAction: "LONG" | "SHORT";

  constructor(candidateId: string, entryAction: "LONG" | "SHORT" = "LONG") {
    if (!candidateId) throw new Error("candidateId is required");
    this.candidateId = candidateId;
    this.entryAction = entryAction;
  }

  onTick(_tick: Tick): Signal {
    return this.exitRequested
      ? {
          action: "FLAT",
          shortMa: null,
          longMa: null,
          reason: `${TESTNET_DEMO_MAPPING_VERSION} deterministic FLAT after entry Fill`
        }
      : {
          action: this.entryAction,
          shortMa: null,
          longMa: null,
          reason: `${TESTNET_DEMO_MAPPING_VERSION} prospective Candidate ${this.candidateId}`
        };
  }

  requestExit(): void {
    this.exitRequested = true;
  }
}

export function testnetDemoMapping(asset: PredictionDemoAsset, side: "LONG" | "SHORT" = "LONG"): TestnetDemoMapping {
  const details = {
    BTC: { canonicalSymbol: "BTC-PERP", venueSymbol: "BTCUSDT", quantity: 0.001 },
    ETH: { canonicalSymbol: "ETH-PERP", venueSymbol: "ETHUSDT", quantity: 0.01 },
    SOL: { canonicalSymbol: "SOL-PERP", venueSymbol: "SOLUSDT", quantity: 0.1 },
    XRP: { canonicalSymbol: "XRP-PERP", venueSymbol: "XRPUSDT", quantity: 5 },
    DOGE: { canonicalSymbol: "DOGE-PERP", venueSymbol: "DOGEUSDT", quantity: 100 },
    HYPE: { canonicalSymbol: "HYPE-PERP", venueSymbol: "HYPEUSDT", quantity: 0.2 },
    BNB: { canonicalSymbol: "BNB-PERP", venueSymbol: "BNBUSDT", quantity: 0.01 },
    ADA: { canonicalSymbol: "ADA-PERP", venueSymbol: "ADAUSDT", quantity: 40 },
    LINK: { canonicalSymbol: "LINK-PERP", venueSymbol: "LINKUSDT", quantity: 1 },
    AVAX: { canonicalSymbol: "AVAX-PERP", venueSymbol: "AVAXUSDT", quantity: 1 },
    SUI: { canonicalSymbol: "SUI-PERP", venueSymbol: "SUIUSDT", quantity: 10 },
    LTC: { canonicalSymbol: "LTC-PERP", venueSymbol: "LTCUSDT", quantity: 0.1 },
    BCH: { canonicalSymbol: "BCH-PERP", venueSymbol: "BCHUSDT", quantity: 0.02 },
    DOT: { canonicalSymbol: "DOT-PERP", venueSymbol: "DOTUSDT", quantity: 5 },
    TRX: { canonicalSymbol: "TRX-PERP", venueSymbol: "TRXUSDT", quantity: 20 }
  } as const satisfies Record<PredictionDemoAsset, {
    canonicalSymbol: TestnetDemoMapping["canonicalSymbol"];
    venueSymbol: TestnetDemoMapping["venueSymbol"];
    quantity: number;
  }>;
  return {
    version: TESTNET_DEMO_MAPPING_VERSION,
    asset,
    ...details[asset],
    side,
    purpose: "EXECUTION_SMOKE_ONLY",
    directionalEdgeClaim: false
  };
}

export async function executeCandidateOnTestnet(
  candidate: TestnetPredictionCandidate,
  apiKey: string,
  apiSecret: string
): Promise<ProspectiveTestnetDemoReport> {
  const entrySide = "direction" in candidate && candidate.direction === "DOWN" ? "SHORT" : "LONG";
  const mapping = testnetDemoMapping(candidate.asset, entrySide);
  const transport = new OfficialBinanceUsdsTestnetTransport(apiKey, apiSecret);
  await transport.ensureIsolatedMarginWhenFlat(mapping.venueSymbol);
  const venue = new BinanceUsdsTestnetVenue({
    canonicalSymbol: mapping.canonicalSymbol,
    venueSymbol: mapping.venueSymbol,
    transport
  });
  const feed = new BinanceUsdsTestnetMarketFeed({
    canonicalSymbol: mapping.canonicalSymbol,
    venueSymbol: mapping.venueSymbol
  });
  const signal = new CandidateTestnetDemoSignal(candidate.candidateId, mapping.side);
  let bot: PerpBot | undefined;
  let openedPosition: Position | undefined;
  const completed = deferred();
  const observedVenue = new ObservedExecutionVenue(venue, {
    onProcessedEvent: (event) => {
      if (event.type !== "FILL" || bot === undefined) return;
      const position = bot.getPosition();
      if (openedPosition === undefined && position.side === mapping.side && approximatelyEqual(position.qty, mapping.quantity)) {
        openedPosition = position;
        signal.requestExit();
        return;
      }
      if (openedPosition !== undefined && position.side === "FLAT") completed.resolve();
    }
  });
  bot = await PerpBot.create({
    symbol: mapping.canonicalSymbol,
    signalSource: signal,
    orderQty: mapping.quantity,
    maxAbsPosition: mapping.quantity,
    margin: { collateral: 1_000, leverage: 1, maintenanceMarginRate: 0.005 },
    stateStore: new JsonFileBotStateStore(runtimeStatePath(`prediction-testnet-demo-${candidate.asset.toLowerCase()}.json`)),
    venue: observedVenue,
    logger: console.log
  });
  let venueStarted = false;
  let feedStarted = false;
  let marketTicks = 0;
  try {
    await venue.start();
    venueStarted = true;
    const preflightSnapshot = await venue.snapshot();
    const preflight = { snapshot: preflightSnapshot, reconciliation: validateFlatPreflight(bot, preflightSnapshot) };
    await feed.start(async (tick) => {
      marketTicks += 1;
      await bot!.onTick(tick);
    });
    feedStarted = true;
    await withTimeout(completed.promise, ROUND_TRIP_TIMEOUT_MS, "prospective Candidate Testnet round trip timed out");
    await feed.close();
    feedStarted = false;
    const final = await waitForFlatReconciliation(bot, venue);
    const submissions = observedVenue.getSubmissions();
    const acknowledgements = observedVenue.getAcknowledgements();
    const fills = observedVenue.getFills();
    const finalLocalPosition = bot.getPosition();
    if (
      openedPosition === undefined || submissions.length !== 2 ||
      !submissions[0]?.request.reason.startsWith(TESTNET_DEMO_MAPPING_VERSION) ||
      submissions[1]?.request.reason !== `${TESTNET_DEMO_MAPPING_VERSION} deterministic FLAT after entry Fill` ||
      acknowledgements.length < 2 || fills.length < 2 || finalLocalPosition.side !== "FLAT" ||
      !final.reconciliation.consistent
    ) throw new Error("prospective Candidate Testnet evidence is incomplete");
    return {
      status: "ROUND_TRIP_COMPLETE",
      mode: "BINANCE_FUTURES_TESTNET",
      candidate,
      mapping,
      repositoryCommit: resolveRepositoryCommit(),
      marketTicks,
      preflight,
      submissions,
      acknowledgements,
      fills,
      openedPosition,
      finalLocalPosition,
      totalFees: fills.reduce((total, event) => total + event.fill.fee, 0),
      final
    };
  } catch (error) {
    if (venueStarted) {
      const snapshot = await venue.snapshot().catch(() => null);
      if (snapshot !== null && snapshot.position.side !== "FLAT") {
        const referencePrice = snapshot.position.entryPrice > 0 ? snapshot.position.entryPrice : 1;
        await venue.emergencyFlatten(referencePrice).catch((flattenError) => {
          throw new AggregateError([error, flattenError], "Testnet smoke failed and emergency FLAT also failed");
        });
      }
    }
    throw error;
  } finally {
    if (feedStarted) await feed.close().catch(() => undefined);
    if (venueStarted) await venue.close().catch(() => undefined);
  }
}

export async function runProspectiveTestnetDemo(
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
): Promise<ProspectiveTestnetDemoReport> {
  const apiKey = requiredEnv("BINANCE_TESTNET_API_KEY");
  const apiSecret = requiredEnv("BINANCE_TESTNET_API_SECRET");
  const clock = await synchronizePriceTargetClock();
  const armedAt = configuredArmedAt(clock.now());
  const allowedAssets = configuredAllowedAssets();
  await writeStatus({
    phase: "ARMED_WAITING_CANDIDATE",
    updatedAt: Date.now(),
    armedAt,
    candidateRule: "candidateT0 > armedAt",
    allowedAssets
  });
  console.log("[PREDICTION_TESTNET_DEMO_ARMED]", JSON.stringify({
    armedAt,
    allowedAssets,
    mappingVersion: TESTNET_DEMO_MAPPING_VERSION,
    candidateRule: "candidateT0 > armedAt",
    purpose: "EXECUTION_SMOKE_ONLY",
    directionalEdgeClaim: false
  }));
  try {
    for (;;) {
      const [priceTargetCandidate, hourlyCandidate] = await Promise.all([
        findFirstNewCandidate(outputDirectory, armedAt, allowedAssets.filter(isPriceTargetAsset)),
        findFirstNewHourlyCandidate(HOURLY_OUTPUT_DIRECTORY, armedAt, allowedAssets)
      ]);
      const candidate = [priceTargetCandidate, hourlyCandidate]
        .filter((value): value is TestnetPredictionCandidate => value !== null)
        .sort((left, right) => left.candidateT0 - right.candidateT0 || left.candidateId.localeCompare(right.candidateId))[0] ?? null;
      if (candidate !== null) {
        const side = "direction" in candidate && candidate.direction === "DOWN" ? "SHORT" : "LONG";
        const mapping = testnetDemoMapping(candidate.asset, side);
        await writeStatus({
          phase: "EXECUTING",
          updatedAt: Date.now(),
          armedAt,
          candidateRule: "candidateT0 > armedAt",
          allowedAssets,
          candidateId: candidate.candidateId,
          venueSymbol: mapping.venueSymbol,
          detail: `${TESTNET_DEMO_MAPPING_VERSION}; no directional edge claim`
        });
        const report = await executeCandidateOnTestnet(candidate, apiKey, apiSecret);
        const evidencePath = resolve(outputDirectory, "testnet-demo", `${safeSegment(candidate.candidateId)}.json`);
        await writeImmutable(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
        await writeStatus({
          phase: "ROUND_TRIP_COMPLETE",
          updatedAt: Date.now(),
          armedAt,
          candidateRule: "candidateT0 > armedAt",
          allowedAssets,
          candidateId: candidate.candidateId,
          venueSymbol: mapping.venueSymbol,
          evidencePath,
          detail: "ACK / Fill / deterministic FLAT / reconciliation PASS"
        });
        console.log("[PREDICTION_TESTNET_DEMO_COMPLETE]", JSON.stringify({ ...report, evidencePath }));
        return report;
      }
      await writeStatus({
        phase: "ARMED_WAITING_CANDIDATE",
        updatedAt: Date.now(),
        armedAt,
        candidateRule: "candidateT0 > armedAt",
        allowedAssets
      });
      await sleep(pollIntervalMs);
    }
  } catch (error) {
    await writeStatus({
      phase: "FAILED_REVIEW_REQUIRED",
      updatedAt: Date.now(),
      armedAt,
      candidateRule: "candidateT0 > armedAt",
      allowedAssets,
      detail: error instanceof Error ? error.message : "unknown Testnet smoke failure"
    });
    throw error;
  }
}

function configuredArmedAt(fallback: number): number {
  const value = process.env.PREDICTION_TESTNET_ARMED_AT?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("PREDICTION_TESTNET_ARMED_AT is invalid");
  return parsed;
}

function configuredAllowedAssets(): readonly PredictionDemoAsset[] {
  const values = (process.env.PREDICTION_TESTNET_ASSETS ?? "BTC,ETH,SOL,XRP,DOGE,HYPE,BNB,ADA,LINK,AVAX,SUI,LTC,BCH,DOT,TRX")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
  const assets = [...new Set(values)] as PredictionDemoAsset[];
  if (
    assets.length === 0 ||
    assets.some((asset) => !["BTC", "ETH", "SOL", "XRP", "DOGE", "HYPE", "BNB", "ADA", "LINK", "AVAX", "SUI", "LTC", "BCH", "DOT", "TRX"].includes(asset))
  ) {
    throw new Error("PREDICTION_TESTNET_ASSETS contains an unsupported Prediction demo asset");
  }
  return assets;
}

function isPriceTargetAsset(asset: PredictionDemoAsset): asset is PriceTargetAsset {
  return asset === "BTC" || asset === "ETH" || asset === "SOL" || asset === "XRP";
}

async function writeStatus(status: PredictionTestnetDemoStatus): Promise<void> {
  await mkdir(dirname(STATUS_PATH), { recursive: true });
  await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function waitForFlatReconciliation(
  bot: PerpBot,
  venue: Pick<BinanceUsdsTestnetVenue, "snapshot">
): Promise<{ snapshot: ExchangeStateSnapshot; reconciliation: ReconciliationReport }> {
  const deadline = Date.now() + RECONCILIATION_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const snapshot = await venue.snapshot();
      const reconciliation = bot.reconcile(snapshot);
      if (
        snapshot.position.side === "FLAT" && snapshot.position.qty === 0 &&
        snapshot.openOrders.length === 0 && reconciliation.consistent
      ) return { snapshot, reconciliation };
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`prospective Candidate Testnet reconciliation timed out${suffix}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolvePromiseArgument) => { resolvePromise = resolvePromiseArgument; });
  return { promise, resolve: resolvePromise };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function writeImmutable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try { await handle.writeFile(body, "utf8"); } finally { await handle.close(); }
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("candidateId is unsafe");
  return safe;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await runProspectiveTestnetDemo(process.argv[2] ?? DEFAULT_OUTPUT_DIRECTORY);
}
