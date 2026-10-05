import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BinanceUsdsTestnetMarketFeed,
  BinanceUsdsTestnetVenue,
  OfficialBinanceUsdsTestnetTransport
} from "./binance-testnet.ts";
import { PerpBot } from "./bot.ts";
import type { ExecutionEventHandler, ExecutionVenue } from "./exchange.ts";
import { ExecutionValidationSignal, PERP_EXECUTION_VALIDATION_PROTOCOL_VERSION } from "./perp-execution-validation.ts";
import type { ExchangeStateSnapshot, ReconciliationReport } from "./reconciliation.ts";
import { JsonFileBotStateStore } from "./state-store.ts";
import type { BotStateStore } from "./state-store.ts";
import type { ExecutionEvent, Logger, Position, SubmitOrderCommand, Tick } from "./types.ts";

const CANONICAL_SYMBOL = "BTC-PERP";
const VENUE_SYMBOL = "BTCUSDT";
const ORDER_QTY = 0.001;
const DEFAULT_ROUND_TRIP_TIMEOUT_MS = 60_000;
const DEFAULT_RECONCILIATION_TIMEOUT_MS = 20_000;

export interface TestnetValidationVenue extends ExecutionVenue {
  start(): Promise<void>;
  snapshot(): Promise<ExchangeStateSnapshot>;
  close(): Promise<void>;
}

export interface TestnetValidationFeed {
  start(onTick: (tick: Tick) => void | Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export type TestnetValidationDependencies = {
  readonly venue: TestnetValidationVenue;
  readonly feed: TestnetValidationFeed;
  readonly stateStore?: BotStateStore;
  readonly logger?: Logger;
  readonly roundTripTimeoutMs?: number;
  readonly reconciliationTimeoutMs?: number;
};

export type TestnetPerpValidationReport = {
  readonly protocolVersion: typeof PERP_EXECUTION_VALIDATION_PROTOCOL_VERSION;
  readonly mode: "AUTHENTICATED_TESTNET";
  readonly overall: "PASS";
  readonly marketTicks: number;
  readonly preflight: {
    readonly snapshot: ExchangeStateSnapshot;
    readonly reconciliation: ReconciliationReport;
  };
  readonly execution: {
    readonly submissions: readonly SubmitOrderCommand[];
    readonly acknowledgements: readonly Extract<ExecutionEvent, { type: "ORDER_ACK" }>[];
    readonly fills: readonly Extract<ExecutionEvent, { type: "FILL" }>[];
    readonly openedPosition: Position;
    readonly finalLocalPosition: Position;
    readonly totalFees: number;
  };
  readonly final: {
    readonly snapshot: ExchangeStateSnapshot;
    readonly reconciliation: ReconciliationReport;
  };
  readonly funding: {
    readonly status: "NOT_OBSERVED";
    readonly reason: string;
  };
};

export async function runAuthenticatedTestnetPerpValidation(
  dependencies: TestnetValidationDependencies
): Promise<TestnetPerpValidationReport> {
  const signal = new ExecutionValidationSignal();
  let bot: PerpBot | undefined;
  let openedPosition: Position | undefined;
  const roundTripDone = deferred<void>();
  const observedVenue = new TestnetEvidenceVenue(dependencies.venue, (event) => {
    if (event.type !== "FILL" || bot === undefined) return;
    const position = bot.getPosition();
    if (
      event.fill.side === "BUY" &&
      position.side === "LONG" &&
      approximatelyEqual(position.qty, ORDER_QTY)
    ) {
      openedPosition ??= position;
      signal.setTarget("FLAT");
      return;
    }
    if (event.fill.side === "SELL" && position.side === "FLAT") {
      roundTripDone.resolve(undefined);
    }
  });
  bot = await PerpBot.create({
    symbol: CANONICAL_SYMBOL,
    signalSource: signal,
    orderQty: ORDER_QTY,
    maxAbsPosition: ORDER_QTY,
    margin: { collateral: 1_000, leverage: 5, maintenanceMarginRate: 0.005 },
    stateStore: dependencies.stateStore,
    venue: observedVenue,
    logger: dependencies.logger ?? (() => {})
  });

  let venueStarted = false;
  let feedStarted = false;
  let marketTicks = 0;
  try {
    await observedVenue.start();
    venueStarted = true;
    const preflightSnapshot = await observedVenue.snapshot();
    const preflightReconciliation = validateFlatPreflight(bot, preflightSnapshot);

    signal.setTarget("LONG");
    await dependencies.feed.start(async (tick) => {
      marketTicks += 1;
      await bot!.onTick(tick);
    });
    feedStarted = true;
    await withTimeout(
      roundTripDone.promise,
      dependencies.roundTripTimeoutMs ?? DEFAULT_ROUND_TRIP_TIMEOUT_MS,
      "authenticated Testnet LONG to FLAT round trip timed out"
    );

    await dependencies.feed.close();
    feedStarted = false;
    const final = await waitForFlatReconciliation(
      bot,
      observedVenue,
      dependencies.reconciliationTimeoutMs ?? DEFAULT_RECONCILIATION_TIMEOUT_MS
    );
    const submissions = observedVenue.getSubmissions();
    const acknowledgements = observedVenue.getAcknowledgements();
    const fills = observedVenue.getFills();
    const finalLocalPosition = bot.getPosition();
    if (openedPosition === undefined) throw new Error("authenticated Testnet open Position was not observed");
    validateRoundTripEvidence(
      submissions,
      acknowledgements,
      fills,
      openedPosition,
      finalLocalPosition,
      final
    );
    return {
      protocolVersion: PERP_EXECUTION_VALIDATION_PROTOCOL_VERSION,
      mode: "AUTHENTICATED_TESTNET",
      overall: "PASS",
      marketTicks,
      preflight: {
        snapshot: preflightSnapshot,
        reconciliation: preflightReconciliation
      },
      execution: {
        submissions,
        acknowledgements,
        fills,
        openedPosition,
        finalLocalPosition,
        totalFees: fills.reduce((total, event) => total + event.fill.fee, 0)
      },
      final,
      funding: {
        status: "NOT_OBSERVED",
        reason: "A short Testnet round trip does not wait for an exchange funding settlement."
      }
    };
  } finally {
    if (feedStarted) await dependencies.feed.close().catch(() => undefined);
    if (venueStarted) await observedVenue.close().catch(() => undefined);
  }
}

export function validateFlatPreflight(
  bot: Pick<PerpBot, "getPosition" | "isRecoveryRequired" | "reconcile">,
  snapshot: ExchangeStateSnapshot
): ReconciliationReport {
  const localPosition = bot.getPosition();
  const reconciliation = bot.reconcile(snapshot);
  const failures: string[] = [];
  if (!reconciliation.consistent) failures.push("local/venue reconciliation is inconsistent");
  if (localPosition.side !== "FLAT" || localPosition.qty !== 0) failures.push("local Position is not FLAT");
  if (snapshot.position.side !== "FLAT" || snapshot.position.qty !== 0) failures.push("venue Position is not FLAT");
  if (snapshot.openOrders.length !== 0) failures.push("venue openOrders is not zero");
  if (bot.isRecoveryRequired()) failures.push("recoveryRequired is true");
  if (failures.length > 0) throw new Error(`Testnet validation preflight failed: ${failures.join("; ")}`);
  return reconciliation;
}

class TestnetEvidenceVenue implements TestnetValidationVenue {
  private handler: ExecutionEventHandler | undefined;
  private readonly submissions: SubmitOrderCommand[] = [];
  private readonly events: ExecutionEvent[] = [];
  private readonly inner: TestnetValidationVenue;
  private readonly onProcessedEvent: (event: ExecutionEvent) => void;

  constructor(inner: TestnetValidationVenue, onProcessedEvent: (event: ExecutionEvent) => void) {
    this.inner = inner;
    this.onProcessedEvent = onProcessedEvent;
    inner.onExecutionEvent(async (event) => {
      if (this.handler === undefined) throw new Error("Testnet evidence venue has no downstream handler");
      await this.handler(event);
      const evidence = structuredClone(event);
      this.events.push(evidence);
      this.onProcessedEvent(evidence);
    });
  }

  onExecutionEvent(handler: ExecutionEventHandler): void {
    if (this.handler !== undefined) throw new Error("Testnet evidence venue handler is already registered");
    this.handler = handler;
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async submit(command: SubmitOrderCommand): Promise<void> {
    this.submissions.push(structuredClone(command));
    await this.inner.submit(command);
  }

  async requestCancel(clientOrderId: string): Promise<void> {
    await this.inner.requestCancel(clientOrderId);
  }

  async snapshot(): Promise<ExchangeStateSnapshot> {
    return await this.inner.snapshot();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  getSubmissions(): readonly SubmitOrderCommand[] {
    return structuredClone(this.submissions);
  }

  getAcknowledgements(): readonly Extract<ExecutionEvent, { type: "ORDER_ACK" }>[] {
    return structuredClone(this.events.filter(
      (event): event is Extract<ExecutionEvent, { type: "ORDER_ACK" }> => event.type === "ORDER_ACK"
    ));
  }

  getFills(): readonly Extract<ExecutionEvent, { type: "FILL" }>[] {
    return structuredClone(this.events.filter(
      (event): event is Extract<ExecutionEvent, { type: "FILL" }> => event.type === "FILL"
    ));
  }
}

async function waitForFlatReconciliation(
  bot: PerpBot,
  venue: Pick<TestnetValidationVenue, "snapshot">,
  timeoutMs: number
): Promise<{ snapshot: ExchangeStateSnapshot; reconciliation: ReconciliationReport }> {
  const deadline = Date.now() + timeoutMs;
  let latestSnapshot: ExchangeStateSnapshot | undefined;
  let latestReconciliation: ReconciliationReport | undefined;
  while (Date.now() <= deadline) {
    latestSnapshot = await venue.snapshot();
    latestReconciliation = bot.reconcile(latestSnapshot);
    if (
      latestSnapshot.position.side === "FLAT" &&
      latestSnapshot.position.qty === 0 &&
      latestSnapshot.openOrders.length === 0 &&
      latestReconciliation.consistent
    ) {
      return { snapshot: latestSnapshot, reconciliation: latestReconciliation };
    }
    await sleep(250);
  }
  throw new Error(
    `Testnet final reconciliation failed: side=${latestSnapshot?.position.side ?? "unknown"} ` +
    `openOrders=${latestSnapshot?.openOrders.length ?? "unknown"} ` +
    `consistent=${latestReconciliation?.consistent ?? false}`
  );
}

function validateRoundTripEvidence(
  submissions: readonly SubmitOrderCommand[],
  acknowledgements: readonly Extract<ExecutionEvent, { type: "ORDER_ACK" }>[],
  fills: readonly Extract<ExecutionEvent, { type: "FILL" }>[],
  openedPosition: Position,
  finalLocalPosition: Position,
  final: { snapshot: ExchangeStateSnapshot; reconciliation: ReconciliationReport }
): void {
  const buyQty = fills
    .filter((event) => event.fill.side === "BUY")
    .reduce((total, event) => total + event.fill.qty, 0);
  const sellQty = fills
    .filter((event) => event.fill.side === "SELL")
    .reduce((total, event) => total + event.fill.qty, 0);
  const fillIds = new Set(fills.map((event) => event.fill.fillId));
  const exchangeOrderIds = new Set(acknowledgements.map((event) => event.ack.exchangeOrderId));
  const pass =
    submissions.length === 2 &&
    submissions[0]?.request.side === "BUY" &&
    submissions[1]?.request.side === "SELL" &&
    acknowledgements.length >= 2 &&
    exchangeOrderIds.size >= 2 &&
    fills.length >= 2 &&
    fillIds.size === fills.length &&
    approximatelyEqual(buyQty, ORDER_QTY) &&
    approximatelyEqual(sellQty, ORDER_QTY) &&
    openedPosition.side === "LONG" &&
    approximatelyEqual(openedPosition.qty, ORDER_QTY) &&
    finalLocalPosition.side === "FLAT" &&
    final.snapshot.position.side === "FLAT" &&
    final.snapshot.openOrders.length === 0 &&
    final.reconciliation.consistent;
  if (!pass) throw new Error("authenticated Testnet round-trip evidence is incomplete");
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const apiKey = requiredEnv("BINANCE_TESTNET_API_KEY");
  const apiSecret = requiredEnv("BINANCE_TESTNET_API_SECRET");
  const transport = new OfficialBinanceUsdsTestnetTransport(apiKey, apiSecret);
  const venue = new BinanceUsdsTestnetVenue({
    canonicalSymbol: CANONICAL_SYMBOL,
    venueSymbol: VENUE_SYMBOL,
    transport
  });
  const feed = new BinanceUsdsTestnetMarketFeed({
    canonicalSymbol: CANONICAL_SYMBOL,
    venueSymbol: VENUE_SYMBOL
  });
  try {
    const report = await runAuthenticatedTestnetPerpValidation({
      venue,
      feed,
      stateStore: new JsonFileBotStateStore(".runtime/perp-execution-validation-testnet-state.json"),
      logger: console.log
    });
    console.log("[PERP_TESTNET_VALIDATION]", JSON.stringify(report));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "authenticated Testnet validation failed";
    console.error("[PERP_TESTNET_VALIDATION]", JSON.stringify({ overall: "FAIL", reason }));
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
