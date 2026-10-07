import { execFileSync } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

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
import type { PriceTargetAsset } from "./price-target-admission.ts";
import {
  PRICE_TARGET_POLL_INTERVAL_MS,
  runPriceTargetCollectorCycle,
  synchronizePriceTargetClock
} from "./price-target-collector.ts";
import {
  findFirstNewCandidate,
  type ProspectivePaperCandidate
} from "./prospective-paper-smoke.ts";

export const TESTNET_DEMO_MAPPING_VERSION = "TESTNET_DEMO_ONLY_V1" as const;
const DEFAULT_OUTPUT_DIRECTORY = "work/price-target-v1";
const ROUND_TRIP_TIMEOUT_MS = 90_000;
const RECONCILIATION_TIMEOUT_MS = 20_000;

export type TestnetDemoMapping = {
  readonly version: typeof TESTNET_DEMO_MAPPING_VERSION;
  readonly asset: PriceTargetAsset;
  readonly canonicalSymbol: "BTC-PERP" | "ETH-PERP" | "SOL-PERP";
  readonly venueSymbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
  readonly side: "LONG";
  readonly quantity: number;
  readonly purpose: "EXECUTION_SMOKE_ONLY";
  readonly directionalEdgeClaim: false;
};

export type ProspectiveTestnetDemoReport = {
  readonly status: "ROUND_TRIP_COMPLETE";
  readonly mode: "BINANCE_FUTURES_TESTNET";
  readonly candidate: ProspectivePaperCandidate;
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

export class CandidateTestnetDemoSignal implements PerpSignalSource {
  private exitRequested = false;
  private readonly candidateId: string;

  constructor(candidateId: string) {
    if (!candidateId) throw new Error("candidateId is required");
    this.candidateId = candidateId;
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
          action: "LONG",
          shortMa: null,
          longMa: null,
          reason: `${TESTNET_DEMO_MAPPING_VERSION} prospective Candidate ${this.candidateId}`
        };
  }

  requestExit(): void {
    this.exitRequested = true;
  }
}

export function testnetDemoMapping(asset: PriceTargetAsset): TestnetDemoMapping {
  const details = asset === "BTC"
    ? { canonicalSymbol: "BTC-PERP" as const, venueSymbol: "BTCUSDT" as const, quantity: 0.001 }
    : asset === "ETH"
      ? { canonicalSymbol: "ETH-PERP" as const, venueSymbol: "ETHUSDT" as const, quantity: 0.01 }
      : { canonicalSymbol: "SOL-PERP" as const, venueSymbol: "SOLUSDT" as const, quantity: 0.1 };
  return {
    version: TESTNET_DEMO_MAPPING_VERSION,
    asset,
    ...details,
    side: "LONG",
    purpose: "EXECUTION_SMOKE_ONLY",
    directionalEdgeClaim: false
  };
}

export async function executeCandidateOnTestnet(
  candidate: ProspectivePaperCandidate,
  apiKey: string,
  apiSecret: string
): Promise<ProspectiveTestnetDemoReport> {
  const mapping = testnetDemoMapping(candidate.asset);
  const transport = new OfficialBinanceUsdsTestnetTransport(apiKey, apiSecret);
  const venue = new BinanceUsdsTestnetVenue({
    canonicalSymbol: mapping.canonicalSymbol,
    venueSymbol: mapping.venueSymbol,
    transport
  });
  const feed = new BinanceUsdsTestnetMarketFeed({
    canonicalSymbol: mapping.canonicalSymbol,
    venueSymbol: mapping.venueSymbol
  });
  const signal = new CandidateTestnetDemoSignal(candidate.candidateId);
  let bot: PerpBot | undefined;
  let openedPosition: Position | undefined;
  const completed = deferred();
  const observedVenue = new ObservedExecutionVenue(venue, {
    onProcessedEvent: (event) => {
      if (event.type !== "FILL" || bot === undefined) return;
      const position = bot.getPosition();
      if (openedPosition === undefined && position.side === "LONG" && approximatelyEqual(position.qty, mapping.quantity)) {
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
    stateStore: new JsonFileBotStateStore(`.runtime/prediction-testnet-demo-${candidate.asset.toLowerCase()}.json`),
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
      repositoryCommit: currentCommit(),
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
  } finally {
    if (feedStarted) await feed.close().catch(() => undefined);
    if (venueStarted) await venue.close().catch(() => undefined);
  }
}

export async function runProspectiveTestnetDemo(
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  pollIntervalMs = PRICE_TARGET_POLL_INTERVAL_MS
): Promise<ProspectiveTestnetDemoReport> {
  const apiKey = requiredEnv("BINANCE_TESTNET_API_KEY");
  const apiSecret = requiredEnv("BINANCE_TESTNET_API_SECRET");
  const clock = await synchronizePriceTargetClock();
  const armedAt = clock.now();
  console.log("[PREDICTION_TESTNET_DEMO_ARMED]", JSON.stringify({
    armedAt,
    mappingVersion: TESTNET_DEMO_MAPPING_VERSION,
    candidateRule: "candidateT0 > armedAt",
    purpose: "EXECUTION_SMOKE_ONLY",
    directionalEdgeClaim: false
  }));
  for (;;) {
    const cycleStartedAt = Date.now();
    let collector;
    try {
      collector = await runPriceTargetCollectorCycle(outputDirectory);
    } catch (error) {
      // Public evidence collection may resume after a transient read failure.
      // Testnet order submission is deliberately outside this retry boundary.
      console.error("[PREDICTION_TESTNET_DEMO_COLLECTION_RETRY]", JSON.stringify({
        reason: error instanceof Error ? error.message : "unknown collection failure",
        orderRetry: false
      }));
      const remaining = Math.max(0, pollIntervalMs - (Date.now() - cycleStartedAt));
      await sleep(remaining);
      continue;
    }
    console.log("[PREDICTION_TESTNET_DEMO_COLLECTOR]", JSON.stringify({
      recordedAt: collector.recordedAt,
      admission: collector.admission
    }));
    const candidate = await findFirstNewCandidate(outputDirectory, armedAt);
    if (candidate !== null) {
      const report = await executeCandidateOnTestnet(candidate, apiKey, apiSecret);
      const evidencePath = resolve(outputDirectory, "testnet-demo", `${safeSegment(candidate.candidateId)}.json`);
      await writeImmutable(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
      console.log("[PREDICTION_TESTNET_DEMO_COMPLETE]", JSON.stringify({ ...report, evidencePath }));
      return report;
    }
    const remaining = Math.max(0, pollIntervalMs - (Date.now() - cycleStartedAt));
    await sleep(remaining);
  }
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

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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
