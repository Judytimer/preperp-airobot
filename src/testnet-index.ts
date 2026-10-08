import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BinanceUsdsTestnetMarketFeed,
  BinanceUsdsTestnetVenue,
  OfficialBinanceUsdsTestnetTransport
} from "./binance-testnet.ts";
import { PerpBot } from "./bot.ts";
import { ObservedExecutionVenue } from "./closure-smoke.ts";
import { validateFlatPreflight } from "./perp-testnet-validation.ts";
import { MovingAverageSignal, type PerpSignalSource } from "./strategy.ts";
import { JsonFileBotStateStore } from "./state-store.ts";
import { runtimeStatePath } from "./runtime-paths.ts";
import type { Position, Signal, Tick } from "./types.ts";

const CANONICAL_SYMBOL = "BTC-PERP";
const VENUE_SYMBOL = "BTCUSDT";
const ORDER_QTY = 0.001;
const ROUND_TRIP_TIMEOUT_MS = 90_000;
const FINAL_RECONCILIATION_TIMEOUT_MS = 20_000;

/** Entry comes from the real MA strategy; FLAT is only deterministic cleanup. */
export class MovingAverageTestnetRoundTripSignal implements PerpSignalSource {
  private readonly movingAverage: MovingAverageSignal;
  private lockedEntry: Extract<Signal["action"], "LONG" | "SHORT"> | null = null;
  private exitRequested = false;

  constructor(shortWindow: number, longWindow: number) {
    this.movingAverage = new MovingAverageSignal(shortWindow, longWindow);
  }

  onTick(tick: Tick): Signal {
    if (this.exitRequested) {
      return { action: "FLAT", shortMa: null, longMa: null, reason: "Testnet cleanup after MA-generated entry Fill" };
    }
    if (this.lockedEntry !== null) {
      return { action: this.lockedEntry, shortMa: null, longMa: null, reason: "hold frozen MA entry target until Fill" };
    }
    const signal = this.movingAverage.onTick(tick);
    if (signal.action === "LONG" || signal.action === "SHORT") this.lockedEntry = signal.action;
    return signal;
  }

  requestExit(): void {
    if (this.lockedEntry === null) throw new Error("cannot exit before an MA entry signal");
    this.exitRequested = true;
  }

  entryAction(): "LONG" | "SHORT" | null {
    return this.lockedEntry;
  }
}

async function main(): Promise<void> {
  const apiKey = requiredEnv("BINANCE_TESTNET_API_KEY");
  const apiSecret = requiredEnv("BINANCE_TESTNET_API_SECRET");
  const transport = new OfficialBinanceUsdsTestnetTransport(apiKey, apiSecret);
  const venue = new BinanceUsdsTestnetVenue({ canonicalSymbol: CANONICAL_SYMBOL, venueSymbol: VENUE_SYMBOL, transport });
  const signal = new MovingAverageTestnetRoundTripSignal(3, 6);
  let bot: PerpBot | undefined;
  let openedPosition: Position | undefined;
  const completed = deferred();
  const observedVenue = new ObservedExecutionVenue(venue, {
    onProcessedEvent: (event) => {
      if (event.type !== "FILL" || bot === undefined) return;
      const position = bot.getPosition();
      if (openedPosition === undefined && position.side !== "FLAT" && approximatelyEqual(position.qty, ORDER_QTY)) {
        openedPosition = position;
        signal.requestExit();
        return;
      }
      if (openedPosition !== undefined && position.side === "FLAT") completed.resolve();
    }
  });
  bot = await PerpBot.create({
    symbol: CANONICAL_SYMBOL,
    signalSource: signal,
    orderQty: ORDER_QTY,
    maxAbsPosition: ORDER_QTY,
    margin: { collateral: 1_000, leverage: 5, maintenanceMarginRate: 0.005 },
    stateStore: new JsonFileBotStateStore(runtimeStatePath("ma-testnet-validation-state.json")),
    venue: observedVenue,
    logger: console.log
  });
  const feed = new BinanceUsdsTestnetMarketFeed({ canonicalSymbol: CANONICAL_SYMBOL, venueSymbol: VENUE_SYMBOL });
  let venueStarted = false;
  let feedStarted = false;
  let marketTicks = 0;

  try {
    await venue.start();
    venueStarted = true;
    const preflight = validateFlatPreflight(bot, await venue.snapshot());
    await feed.start(async (tick) => {
      marketTicks += 1;
      await bot!.onTick(tick);
    });
    feedStarted = true;
    await withTimeout(completed.promise, ROUND_TRIP_TIMEOUT_MS, "MA Testnet round trip timed out");
    await feed.close();
    feedStarted = false;

    const final = await waitForFlatReconciliation(bot, venue);
    const submissions = observedVenue.getSubmissions();
    const acknowledgements = observedVenue.getAcknowledgements();
    const fills = observedVenue.getFills();
    const entry = submissions[0];
    const exit = submissions[1];
    if (
      signal.entryAction() === null || openedPosition === undefined || submissions.length !== 2 ||
      !entry?.request.reason.startsWith("short MA ") ||
      exit?.request.reason !== "Testnet cleanup after MA-generated entry Fill" ||
      acknowledgements.length < 2 || fills.length < 2 || bot.getPosition().side !== "FLAT" ||
      !final.reconciliation.consistent
    ) throw new Error("MA Testnet evidence is incomplete");

    console.log("[MA_TESTNET_VALIDATION]", JSON.stringify({
      overall: "PASS",
      strategy: "MovingAverageSignal(3,6)",
      marketTicks,
      preflight,
      entryAction: signal.entryAction(),
      submissions,
      acknowledgements,
      fills,
      openedPosition,
      finalLocalPosition: bot.getPosition(),
      totalFees: fills.reduce((total, event) => total + event.fill.fee, 0),
      final
    }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "MA Testnet validation failed";
    console.error("[MA_TESTNET_VALIDATION]", JSON.stringify({ overall: "FAIL", reason }));
    process.exitCode = 1;
  } finally {
    if (feedStarted) await feed.close().catch(() => undefined);
    if (venueStarted) await venue.close().catch(() => undefined);
  }
}

async function waitForFlatReconciliation(
  bot: PerpBot,
  venue: Pick<BinanceUsdsTestnetVenue, "snapshot">
): Promise<{ snapshot: Awaited<ReturnType<BinanceUsdsTestnetVenue["snapshot"]>>; reconciliation: ReturnType<PerpBot["reconcile"]> }> {
  const deadline = Date.now() + FINAL_RECONCILIATION_TIMEOUT_MS;
  let latestSnapshot: Awaited<ReturnType<BinanceUsdsTestnetVenue["snapshot"]>> | undefined;
  let latestReconciliation: ReturnType<PerpBot["reconcile"]> | undefined;
  let lastSnapshotError: unknown;
  while (Date.now() <= deadline) {
    try {
      latestSnapshot = await venue.snapshot();
      latestReconciliation = bot.reconcile(latestSnapshot);
      if (
        latestSnapshot.position.side === "FLAT" && latestSnapshot.position.qty === 0 &&
        latestSnapshot.openOrders.length === 0 && latestReconciliation.consistent
      ) return { snapshot: latestSnapshot, reconciliation: latestReconciliation };
    } catch (error) {
      lastSnapshotError = error;
    }
    await sleep(250);
  }
  const suffix = lastSnapshotError instanceof Error ? `: ${lastSnapshotError.message}` : "";
  throw new Error(`MA Testnet final FLAT reconciliation timed out${suffix}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
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

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) await main();
