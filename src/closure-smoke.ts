import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import {
  BinanceUsdsTestnetMarketFeed,
  BinanceUsdsTestnetVenue,
  OfficialBinanceUsdsTestnetTransport
} from "./binance-testnet.ts";
import { PerpBot } from "./bot.ts";
import type { ExecutionEventHandler, ExecutionVenue } from "./exchange.ts";
import type { ExchangeStateSnapshot, ReconciliationReport } from "./reconciliation.ts";
import { JsonFileBotStateStore } from "./state-store.ts";
import { runtimeStatePath } from "./runtime-paths.ts";
import type { ExecutionEvent, Position, SubmitOrderCommand } from "./types.ts";
import { LayaReviewerAdapter } from "./overlay/laya-reviewer.ts";
import {
  DeterministicResearchRouter,
  MockEvidenceSearch
} from "./overlay/research.ts";
import { BoundedShadowRunner } from "./overlay/shadow-runner.ts";
import { MemePredictionOverlayStrategy } from "./overlay/strategy.ts";
import type {
  Evidence,
  ResearchSnapshot,
  ShadowRecord,
  TradeCandidate
} from "./overlay/types.ts";

const CANONICAL_SYMBOL = "BTC-PERP";
const VENUE_SYMBOL = "BTCUSDT";
const FIRST_FILL_TIMEOUT_MS = 60_000;
const FINAL_RECONCILIATION_TIMEOUT_MS = 20_000;
const LAYA_TIMEOUT_MS = 60_000;
const LAYA_DRAIN_TIMEOUT_MS = 65_000;

export type ClosureTimelineEvent = {
  readonly sequence: number;
  readonly at: number;
  readonly type: string;
  readonly detail?: Readonly<Record<string, unknown>>;
};

export type BinanceClosureEvidence = {
  readonly marketTicks: number;
  readonly submissions: readonly SubmitOrderCommand[];
  readonly acknowledgements: readonly Extract<ExecutionEvent, { type: "ORDER_ACK" }>[];
  readonly fills: readonly Extract<ExecutionEvent, { type: "FILL" }>[];
  readonly position: Position;
  readonly reconciliation: ReconciliationReport;
  readonly venueOpenOrders: number;
};

export type ClosureReport = {
  readonly overall: "PASS" | "FAIL";
  readonly binance: {
    readonly status: "PASS" | "FAIL" | "NOT_STARTED";
    readonly marketTicks?: number;
    readonly submitQty?: number;
    readonly fillQty?: number;
    readonly position?: Position;
    readonly reconciliationConsistent?: boolean;
    readonly venueOpenOrders?: number;
    readonly reason?: string;
  };
  readonly realLaya: {
    readonly status: "PASS" | "FAIL" | "NOT_STARTED";
    readonly recordStatus?: ShadowRecord["status"];
    readonly verdict?: string;
    readonly errorCode?: string;
    readonly reason?: string;
  };
  readonly timeline: readonly ClosureTimelineEvent[];
};

export type ClosureRunContext = {
  readonly record: (type: string, detail?: Readonly<Record<string, unknown>>) => void;
};

export type ClosureDependencies = {
  readonly runBinance: (context: ClosureRunContext) => Promise<BinanceClosureEvidence>;
  readonly runRealLaya: (context: ClosureRunContext) => Promise<ShadowRecord>;
};

export type ClosureConfig = {
  readonly binanceApiKey: string;
  readonly binanceApiSecret: string;
  readonly layaBaseUrl: string;
  readonly layaApiKey?: string;
};

type ObserverHooks = {
  readonly onSubmit?: (command: SubmitOrderCommand) => void;
  readonly onProcessedEvent?: (event: ExecutionEvent) => void;
};

/**
 * Composition-only observer. It forwards the original event to PerpBot first,
 * waits for processing/persistence, and only then captures immutable evidence.
 */
export class ObservedExecutionVenue implements ExecutionVenue {
  private downstream: ExecutionEventHandler | undefined;
  private readonly submissions: SubmitOrderCommand[] = [];
  private readonly events: ExecutionEvent[] = [];
  private readonly inner: ExecutionVenue;
  private readonly hooks: ObserverHooks;

  constructor(
    inner: ExecutionVenue,
    hooks: ObserverHooks = {}
  ) {
    this.inner = inner;
    this.hooks = hooks;
    inner.onExecutionEvent(async (event) => {
      if (this.downstream === undefined) {
        throw new Error("observed execution venue has no downstream handler");
      }
      await this.downstream(event);
      const evidence = structuredClone(event);
      this.events.push(evidence);
      try {
        this.hooks.onProcessedEvent?.(evidence);
      } catch {
        // Acceptance evidence must never acquire execution authority.
      }
    });
  }

  onExecutionEvent(handler: ExecutionEventHandler): void {
    if (this.downstream !== undefined) {
      throw new Error("observed execution venue handler is already registered");
    }
    this.downstream = handler;
  }

  async submit(command: SubmitOrderCommand): Promise<void> {
    const evidence = structuredClone(command);
    this.submissions.push(evidence);
    try {
      this.hooks.onSubmit?.(evidence);
    } catch {
      // Acceptance evidence must never acquire execution authority.
    }
    await this.inner.submit(command);
  }

  async requestCancel(clientOrderId: string): Promise<void> {
    await this.inner.requestCancel(clientOrderId);
  }

  getSubmissions(): readonly SubmitOrderCommand[] {
    return structuredClone(this.submissions);
  }

  getAcknowledgements(): readonly Extract<ExecutionEvent, { type: "ORDER_ACK" }>[] {
    return structuredClone(
      this.events.filter(
        (event): event is Extract<ExecutionEvent, { type: "ORDER_ACK" }> =>
          event.type === "ORDER_ACK"
      )
    );
  }

  getFills(): readonly Extract<ExecutionEvent, { type: "FILL" }>[] {
    return structuredClone(
      this.events.filter(
        (event): event is Extract<ExecutionEvent, { type: "FILL" }> => event.type === "FILL"
      )
    );
  }
}

/** Composition-only gate that stops new market ticks after the first submit. */
export class ClosureTickGate {
  private stopForwardingTicks = false;

  stopAfterFirstSubmit(): void {
    this.stopForwardingTicks = true;
  }

  async forward(onTick: () => Promise<void>): Promise<boolean> {
    if (this.stopForwardingTicks) return false;
    await onTick();
    return true;
  }
}

export async function runClosureComposition(
  dependencies: ClosureDependencies
): Promise<ClosureReport> {
  const timeline: ClosureTimelineEvent[] = [];
  let sequence = 0;
  const record = (type: string, detail?: Readonly<Record<string, unknown>>): void => {
    timeline.push({ sequence: ++sequence, at: Date.now(), type, detail });
  };
  const context: ClosureRunContext = { record };

  const binancePromise = dependencies.runBinance(context);
  const layaPromise = dependencies.runRealLaya(context);
  const [binanceResult, layaResult] = await Promise.allSettled([
    binancePromise,
    layaPromise
  ]);

  const binance = summarizeBinance(binanceResult);
  const realLaya = summarizeLaya(layaResult);
  return {
    overall: binance.status === "PASS" && realLaya.status === "PASS" ? "PASS" : "FAIL",
    binance,
    realLaya,
    timeline
  };
}

export function readClosureConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): ClosureConfig {
  const layaBaseUrl = requiredEnv(env, "LAYA_BASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(layaBaseUrl);
  } catch {
    throw new Error("LAYA_BASE_URL must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("LAYA_BASE_URL must be a valid HTTP(S) URL");
  }
  const binanceApiKey = requiredEnv(env, "BINANCE_TESTNET_API_KEY");
  const binanceApiSecret = requiredEnv(env, "BINANCE_TESTNET_API_SECRET");
  const layaApiKey = env.LAYA_API_KEY?.trim();
  return {
    binanceApiKey,
    binanceApiSecret,
    layaBaseUrl: parsed.toString().replace(/\/$/, ""),
    ...(layaApiKey === undefined || layaApiKey.length === 0 ? {} : { layaApiKey })
  };
}

export function validateLivePreflight(
  bot: Pick<PerpBot, "getPosition" | "isRecoveryRequired" | "reconcile">,
  venueSnapshot: ExchangeStateSnapshot
): ReconciliationReport {
  const localPosition = bot.getPosition();
  const reconciliation = bot.reconcile(venueSnapshot);
  const failures: string[] = [];
  if (!reconciliation.consistent) failures.push("local/venue reconciliation is inconsistent");
  if (localPosition.side !== "FLAT" || localPosition.qty !== 0) {
    failures.push("local Position is not FLAT");
  }
  if (venueSnapshot.position.side !== "FLAT" || venueSnapshot.position.qty !== 0) {
    failures.push("venue Position is not FLAT");
  }
  if (venueSnapshot.openOrders.length !== 0) failures.push("venue openOrders is not zero");
  if (bot.isRecoveryRequired()) failures.push("recoveryRequired is true");
  if (failures.length > 0) {
    throw new Error(`closure preflight failed: ${failures.join("; ")}`);
  }
  return reconciliation;
}

export async function runLiveBinanceClosure(
  config: ClosureConfig,
  context: ClosureRunContext
): Promise<BinanceClosureEvidence> {
  const transport = new OfficialBinanceUsdsTestnetTransport(
    config.binanceApiKey,
    config.binanceApiSecret
  );
  const venue = new BinanceUsdsTestnetVenue({
    canonicalSymbol: CANONICAL_SYMBOL,
    venueSymbol: VENUE_SYMBOL,
    transport
  });
  let bot: PerpBot | undefined;
  const tickGate = new ClosureTickGate();
  const firstFillProcessed = deferred<void>();
  const observedVenue = new ObservedExecutionVenue(venue, {
    onSubmit: (command) => {
      tickGate.stopAfterFirstSubmit();
      context.record("BINANCE_SUBMIT", {
        clientOrderId: command.clientOrderId,
        side: command.request.side,
        qty: command.request.qty
      });
    },
    onProcessedEvent: (event) => {
      if (event.type === "ORDER_ACK") {
        context.record("BINANCE_ACK", {
          clientOrderId: event.ack.clientOrderId,
          qty: event.ack.request.qty
        });
        return;
      }
      if (event.type !== "FILL") return;
      context.record("BINANCE_FILL", {
        clientOrderId: event.fill.clientOrderId,
        fillId: event.fill.fillId,
        qty: event.fill.qty
      });
      context.record("BINANCE_POSITION_PERSISTED", {
        side: bot?.getPosition().side,
        qty: bot?.getPosition().qty
      });
      firstFillProcessed.resolve();
    }
  });
  bot = await PerpBot.create({
    symbol: CANONICAL_SYMBOL,
    shortWindow: 3,
    longWindow: 6,
    orderQty: 0.001,
    maxAbsPosition: 0.003,
    margin: { collateral: 1_000, leverage: 5, maintenanceMarginRate: 0.005 },
    stateStore: new JsonFileBotStateStore(runtimeStatePath("binance-testnet-state.json")),
    venue: observedVenue
  });
  const feed = new BinanceUsdsTestnetMarketFeed({
    canonicalSymbol: CANONICAL_SYMBOL,
    venueSymbol: VENUE_SYMBOL
  });
  let venueStarted = false;
  let feedStarted = false;
  let marketTicks = 0;

  try {
    venueStarted = true;
    await venue.start();
    const preflightSnapshot = await venue.snapshot();
    validateLivePreflight(bot, preflightSnapshot);
    context.record("BINANCE_PREFLIGHT_PASS", { openOrders: 0 });

    feedStarted = true;
    await feed.start(async (tick) => {
      await tickGate.forward(async () => {
        marketTicks += 1;
        context.record("BINANCE_MARKET_TICK", { seq: tick.seq });
        await bot!.onTick(tick);
      });
    });
    await withTimeout(
      firstFillProcessed.promise,
      FIRST_FILL_TIMEOUT_MS,
      "Binance first Fill was not processed before timeout"
    );
    const finalState = await waitForFinalReconciliation(bot, venue);
    context.record("BINANCE_RECONCILIATION", {
      consistent: finalState.reconciliation.consistent,
      venueOpenOrders: finalState.snapshot.openOrders.length
    });
    return {
      marketTicks,
      submissions: observedVenue.getSubmissions(),
      acknowledgements: observedVenue.getAcknowledgements(),
      fills: observedVenue.getFills(),
      position: bot.getPosition(),
      reconciliation: finalState.reconciliation,
      venueOpenOrders: finalState.snapshot.openOrders.length
    };
  } finally {
    if (feedStarted) {
      await feed.close().catch(() => undefined);
    }
    if (venueStarted) {
      await venue.close().catch(() => undefined);
    }
  }
}

export async function runRealLayaClosure(
  config: ClosureConfig,
  context: ClosureRunContext,
  fetchImpl: typeof fetch = fetch
): Promise<ShadowRecord> {
  const { candidate, evidence } = closureShadowFixture();
  const completed = deferred<ShadowRecord>();
  const runner = new BoundedShadowRunner({
    router: new DeterministicResearchRouter(),
    search: new MockEvidenceSearch(evidence),
    reviewer: new LayaReviewerAdapter({
      baseUrl: config.layaBaseUrl,
      apiKey: config.layaApiKey,
      timeoutMs: LAYA_TIMEOUT_MS,
      fetch: fetchImpl
    }),
    record: (record) => {
      context.record("REAL_LAYA_RECORD", {
        status: record.status,
        ...(record.status === "COMPLETED" ? { verdict: record.shadowVerdict } : {}),
        ...(record.status === "PROVIDER_FAILED" || record.status === "PROVIDER_UNAVAILABLE"
          ? { errorCode: record.errorCode }
          : {})
      });
      completed.resolve(record);
    },
    maxInFlight: 1
  });
  const start = runner.start(candidate);
  if (!start.accepted) throw new Error("real Laya closure task was not accepted");
  await runner.drain(LAYA_DRAIN_TIMEOUT_MS);
  return completed.promise;
}

async function waitForFinalReconciliation(
  bot: PerpBot,
  venue: BinanceUsdsTestnetVenue
): Promise<{ snapshot: ExchangeStateSnapshot; reconciliation: ReconciliationReport }> {
  const deadline = Date.now() + FINAL_RECONCILIATION_TIMEOUT_MS;
  let lastSnapshot: ExchangeStateSnapshot | undefined;
  let lastReconciliation: ReconciliationReport | undefined;
  while (Date.now() <= deadline) {
    lastSnapshot = await venue.snapshot();
    lastReconciliation = bot.reconcile(lastSnapshot);
    if (lastSnapshot.openOrders.length === 0 && lastReconciliation.consistent) {
      return { snapshot: lastSnapshot, reconciliation: lastReconciliation };
    }
    await sleep(250);
  }
  throw new Error(
    `final reconciliation failed: consistent=${lastReconciliation?.consistent ?? false} openOrders=${lastSnapshot?.openOrders.length ?? "unknown"}`
  );
}

function summarizeBinance(
  result: PromiseSettledResult<BinanceClosureEvidence>
): ClosureReport["binance"] {
  if (result.status === "rejected") {
    return { status: "FAIL", reason: safeReason(result.reason, "Binance closure failed") };
  }
  const evidence = result.value;
  const submitQty = evidence.submissions[0]?.request.qty;
  const fillQty = evidence.fills.reduce((sum, event) => sum + event.fill.qty, 0);
  const pass =
    evidence.marketTicks > 0 &&
    evidence.submissions.length === 1 &&
    evidence.acknowledgements.length > 0 &&
    evidence.fills.length > 0 &&
    evidence.position.side !== "FLAT" &&
    evidence.reconciliation.consistent &&
    evidence.venueOpenOrders === 0;
  return {
    status: pass ? "PASS" : "FAIL",
    marketTicks: evidence.marketTicks,
    submitQty,
    fillQty,
    position: evidence.position,
    reconciliationConsistent: evidence.reconciliation.consistent,
    venueOpenOrders: evidence.venueOpenOrders,
    ...(pass ? {} : { reason: "Binance closure evidence is incomplete" })
  };
}

function summarizeLaya(
  result: PromiseSettledResult<ShadowRecord>
): ClosureReport["realLaya"] {
  if (result.status === "rejected") {
    return { status: "FAIL", reason: safeReason(result.reason, "real Laya closure failed") };
  }
  const record = result.value;
  if (record.status === "COMPLETED") {
    return {
      status: "PASS",
      recordStatus: record.status,
      verdict: record.shadowVerdict
    };
  }
  return {
    status: "FAIL",
    recordStatus: record.status,
    ...(record.status === "PROVIDER_FAILED" || record.status === "PROVIDER_UNAVAILABLE"
      ? { errorCode: record.errorCode }
      : {}),
    reason: "real Laya did not produce a COMPLETED ShadowRecord"
  };
}

function closureShadowFixture(): { candidate: TradeCandidate; evidence: readonly Evidence[] } {
  const t0 = Date.now();
  const strategy = new MemePredictionOverlayStrategy({
    spotRiseTriggerPct: 0.5,
    exitYesPrice: 0.7
  });
  const first = closureSnapshot(1, t0 - 1_000, 100, 1_000, 0.3);
  const second = closureSnapshot(2, t0, 160, 1_600, 0.35);
  strategy.onSnapshot(first, 0);
  const signal = strategy.onSnapshot(second, 0);
  if (signal.action !== "BUY_YES") {
    throw new Error("closure fixture did not produce BUY_YES Candidate");
  }
  return {
    candidate: {
      candidateId: `${signal.marketId}:closure`,
      t0: signal.ts,
      snapshot: second,
      signal
    },
    evidence: [
      {
        sourceId: "MOCK-NEWS-CLOSURE",
        publishedAt: t0 - 500,
        summary: "Fixed mock evidence for closure acceptance; no real Search was used."
      }
    ]
  };
}

function closureSnapshot(
  seq: number,
  ts: number,
  spotPrice: number,
  fdv: number,
  yesPrice: number
): ResearchSnapshot {
  return {
    seq,
    ts,
    meme: { symbol: "DOGE", spotPrice, fdv },
    prediction: {
      marketId: "DOGE-FDV-2B",
      question: "Will DOGE exceed $2B FDV?",
      targetFdv: 2_000,
      yesPrice
    }
  };
}

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
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

function safeReason(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (error.message.endsWith(" is required")) return error.message;
  if (error.message.startsWith("LAYA_BASE_URL must be")) return error.message;
  if (error.message.startsWith("closure preflight failed:")) return error.message;
  if (error.message.startsWith("final reconciliation failed:")) return error.message;
  if (error.message.includes("timeout")) return error.message;
  return fallback;
}

async function main(): Promise<void> {
  let config: ClosureConfig;
  try {
    config = readClosureConfig();
  } catch (error) {
    const report: ClosureReport = {
      overall: "FAIL",
      binance: { status: "NOT_STARTED", reason: "closure configuration failed" },
      realLaya: {
        status: "FAIL",
        reason: safeReason(error, "closure configuration failed")
      },
      timeline: []
    };
    console.log("[CLOSURE_REPORT]", JSON.stringify(report));
    process.exitCode = 1;
    return;
  }

  const report = await runClosureComposition({
    runBinance: (context) => runLiveBinanceClosure(config, context),
    runRealLaya: (context) => runRealLayaClosure(config, context)
  });
  console.log("[CLOSURE_REPORT]", JSON.stringify(report));
  if (report.overall !== "PASS") process.exitCode = 1;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
