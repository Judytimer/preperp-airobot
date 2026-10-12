import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  MAINNET_MICRO_HARD_MAX_NOTIONAL_USDT,
  MAINNET_MICRO_MAX_PRICE_DRIFT_BPS,
  MAINNET_MICRO_PLAN_TTL_MS,
  MAINNET_MICRO_PROTOCOL,
  assertMicroCapitalAccountReady,
  createMainnetMicroPlan,
  executeMainnetMicro,
  mainnetMicroArm,
  validateMainnetMicroArm,
  validateMainnetMicroPlan,
  type MainnetMicroRuntimeFeed,
  type MainnetMicroRuntimeTransport,
  type MainnetMicroPlanPayload
} from "../src/mainnet-micro.ts";
import type { BinanceOrderTradeUpdate, BinanceSymbolRules } from "../src/binance-testnet.ts";
import type { ExchangeStateSnapshot } from "../src/reconciliation.ts";
import type { BotCheckpoint, BotStateStore } from "../src/state-store.ts";
import type { Tick } from "../src/types.ts";

test("creates and verifies an expiring, content-addressed mainnet plan", () => {
  const plan = createMainnetMicroPlan(payload());
  assert.match(plan.planId, /^[a-f0-9]{64}$/);
  assert.equal(validateMainnetMicroPlan(plan, 1_500), plan);
});

test("rejects tampered and expired mainnet plans", () => {
  const plan = createMainnetMicroPlan(payload());
  assert.throws(
    () => validateMainnetMicroPlan({ ...plan, repositoryCommit: "def456" }, 1_500),
    /hash mismatch/
  );
  assert.throws(
    () => validateMainnetMicroPlan(plan, plan.expiresAt + 1),
    /invalid or expired/
  );
});

test("enforces the hard real-money cap and exact one-shot arm phrase", () => {
  assert.throws(
    () => createMainnetMicroPlan(payload({ maxNotionalUsdt: MAINNET_MICRO_HARD_MAX_NOTIONAL_USDT + 1 })),
    /invalid or expired/
  );
  const plan = createMainnetMicroPlan(payload());
  assert.doesNotThrow(() => validateMainnetMicroArm(mainnetMicroArm(plan.planId), plan.planId));
  assert.throws(() => validateMainnetMicroArm("yes", plan.planId), /must equal/);
  assert.throws(() => validateMainnetMicroArm(undefined, plan.planId), /must equal/);
  const otherPlanId = "b".repeat(64);
  assert.throws(() => validateMainnetMicroArm(mainnetMicroArm(otherPlanId), plan.planId), /must equal/);
});

test("requires a globally clean single-asset account before mainnet execution", () => {
  const clean = {
    canTrade: true,
    multiAssetsMargin: false,
    availableBalance: 100,
    nonFlatSymbols: [],
    openOrderSymbols: []
  } as const;
  assert.doesNotThrow(() => assertMicroCapitalAccountReady(clean, 10));
  assert.throws(
    () => assertMicroCapitalAccountReady({ ...clean, nonFlatSymbols: ["ETHUSDT"] }, 10),
    /non-flat positions/
  );
  assert.throws(
    () => assertMicroCapitalAccountReady({ ...clean, multiAssetsMargin: true }, 10),
    /multi-assets margin/
  );
  assert.throws(
    () => assertMicroCapitalAccountReady({ ...clean, availableBalance: 5 }, 10),
    /does not cover/
  );
});

test("executes the real runner through partial entry, expiry, reduce-only exit, and final reconciliation", async () => {
  const now = Date.now();
  const plan = createMainnetMicroPlan(payload({
    createdAt: now,
    expiresAt: now + MAINNET_MICRO_PLAN_TTL_MS,
    referenceLastPrice: 1_000,
    estimatedNotionalUsdt: 10,
    quantity: 0.01
  }));
  const transport = new MainnetRoundTripTransport();
  const feed = new RepeatingFeed(plan.canonicalSymbol, 1_000);
  let authorizations = 0;
  let persisted = 0;

  const result = await executeMainnetMicro({
    BINANCE_MAINNET_API_KEY: "test-key",
    BINANCE_MAINNET_API_SECRET: "test-secret",
    PREPERP_MAINNET_PLAN_ID: plan.planId,
    PREPERP_MAINNET_ARM: mainnetMicroArm(plan.planId)
  }, {
    transport,
    feed,
    stateStore: new MemoryStateStore(),
    logger: () => undefined,
    loadPlan: async () => plan,
    repositoryCommit: plan.repositoryCommit,
    sourceFingerprint: plan.sourceFingerprint,
    consumeAuthorization: async () => { authorizations += 1; },
    persistReport: async () => { persisted += 1; return "memory://mainnet-report"; }
  });

  assert.equal(result.path, "memory://mainnet-report");
  assert.equal(authorizations, 1);
  assert.equal(persisted, 1);
  assert.equal(transport.accountChecks, 2);
  assert.equal(transport.historyChecks, 2);
  assert.deepEqual(
    transport.submissions.map(({ quantity, reduceOnly }) => ({ quantity, reduceOnly: reduceOnly === true })),
    [{ quantity: 0.01, reduceOnly: false }, { quantity: 0.006, reduceOnly: true }]
  );
  assert.equal(result.report.openedPosition.qty, 0.006);
  assert.equal(result.report.terminals[0]?.terminal.status, "EXPIRED");
  assert.deepEqual(result.report.feeTotalsByAsset, { USDT: 0.002 });
  assert.equal(result.report.venueRealizedPnlBeforeFeesUsdt, -0.2);
  assert.equal(result.report.netPnlUsdt, -0.202);
  assert.equal(result.report.final.snapshot.position.side, "FLAT");
  assert.equal(result.report.final.reconciliation.consistent, true);
});

test("rejects a plan found in exchange history before consuming authorization", async () => {
  const now = Date.now();
  const plan = createMainnetMicroPlan(payload({
    createdAt: now,
    expiresAt: now + MAINNET_MICRO_PLAN_TTL_MS,
    referenceLastPrice: 1_000,
    estimatedNotionalUsdt: 10,
    quantity: 0.01
  }));
  const transport = new MainnetRoundTripTransport();
  transport.historicalOrderFound = true;
  let authorizations = 0;

  await assert.rejects(() => executeMainnetMicro({
    BINANCE_MAINNET_API_KEY: "test-key",
    BINANCE_MAINNET_API_SECRET: "test-secret",
    PREPERP_MAINNET_PLAN_ID: plan.planId,
    PREPERP_MAINNET_ARM: mainnetMicroArm(plan.planId)
  }, {
    transport,
    feed: new RepeatingFeed(plan.canonicalSymbol, 1_000),
    stateStore: new MemoryStateStore(),
    logger: () => undefined,
    loadPlan: async () => plan,
    repositoryCommit: plan.repositoryCommit,
    sourceFingerprint: plan.sourceFingerprint,
    consumeAuthorization: async () => { authorizations += 1; },
    persistReport: async () => "memory://must-not-write"
  }), /already reached Binance order history/);

  assert.equal(authorizations, 0);
  assert.equal(transport.submissions.length, 0);
  assert.equal(transport.historyChecks, 1);
});

function payload(overrides: Partial<MainnetMicroPlanPayload> = {}): MainnetMicroPlanPayload {
  return {
    protocolVersion: MAINNET_MICRO_PROTOCOL,
    environment: "BINANCE_USDS_MAINNET",
    purpose: "EXECUTION_REALISM_ONLY",
    profitabilityClaim: false,
    repositoryCommit: "abc123",
    sourceFingerprint: "a".repeat(64),
    createdAt: 1_000,
    expiresAt: 1_000 + MAINNET_MICRO_PLAN_TTL_MS,
    canonicalSymbol: "BTC-PERP",
    venueSymbol: "BTCUSDT",
    side: "LONG",
    quantity: 0.001,
    leverage: 1,
    maxNotionalUsdt: 25,
    referenceLastPrice: 20_000,
    estimatedNotionalUsdt: 20,
    maxPriceDriftBps: MAINNET_MICRO_MAX_PRICE_DRIFT_BPS,
    accountPreflight: {
      canTrade: true,
      oneWayAndIsolated: true,
      multiAssetsMargin: false,
      allPositionsFlat: true,
      noOpenOrders: true,
      availableBalanceCoversCap: true
    },
    ...overrides
  };
}

class MemoryStateStore implements BotStateStore {
  private checkpoint: BotCheckpoint | null = null;
  async load(): Promise<BotCheckpoint | null> { return this.checkpoint === null ? null : structuredClone(this.checkpoint); }
  async save(checkpoint: BotCheckpoint): Promise<void> { this.checkpoint = structuredClone(checkpoint); }
}

class RepeatingFeed implements MainnetMicroRuntimeFeed {
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  private sequence = 1;
  private readonly symbol: string;
  private readonly price: number;
  constructor(symbol: string, price: number) {
    this.symbol = symbol;
    this.price = price;
  }
  async start(onTick: (tick: Tick) => void | Promise<void>): Promise<void> {
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const seq = this.sequence++;
        await onTick({
          seq,
          symbol: this.symbol,
          lastPrice: this.price,
          markPrice: this.price,
          indexPrice: this.price,
          ts: Date.now()
        });
        await sleep(1);
      }
    })();
  }
  async close(): Promise<void> { this.running = false; await this.loop; }
}

class MainnetRoundTripTransport implements MainnetMicroRuntimeTransport {
  private handler: ((update: BinanceOrderTradeUpdate) => void | Promise<void>) | null = null;
  private positionQty = 0;
  private tradeId = 1;
  private readonly openOrders = new Map<string, { side: "BUY" | "SELL"; original: number; executed: number }>();
  private readonly pending = new Set<Promise<void>>();
  accountChecks = 0;
  historyChecks = 0;
  historicalOrderFound = false;
  readonly submissions: Array<{
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    clientOrderId: string;
    reduceOnly?: boolean;
  }> = [];

  async loadSymbolRules(): Promise<BinanceSymbolRules> {
    return {
      symbol: "BTCUSDT", status: "TRADING", marketOrderSupported: true,
      minQty: 0.001, maxQty: 100, stepSize: 0.001, minNotional: 5
    };
  }
  async validateAccountMode(): Promise<void> {}
  async ensureIsolatedMarginWhenFlat(): Promise<void> {}
  async ensureInitialLeverageWhenFlat(): Promise<void> {}
  async loadMicroCapitalAccountStatus() {
    this.accountChecks += 1;
    return {
      canTrade: true,
      multiAssetsMargin: false,
      availableBalance: 100,
      nonFlatSymbols: this.positionQty === 0 ? [] : ["BTCUSDT"],
      openOrderSymbols: this.openOrders.size === 0 ? [] : ["BTCUSDT"]
    };
  }
  async loadMarketSnapshot() {
    return { lastPrice: 1_000, markPrice: 1_000, indexPrice: 1_000, observedAt: Date.now() };
  }
  async hasHistoricalOrderPrefix(): Promise<boolean> {
    this.historyChecks += 1;
    return this.historicalOrderFound;
  }
  async connectUserData(handler: (update: BinanceOrderTradeUpdate) => void | Promise<void>): Promise<void> {
    this.handler = handler;
  }
  async submitMarketOrder(command: {
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    clientOrderId: string;
    reduceOnly?: boolean;
  }): Promise<void> {
    const submitted = { ...command };
    this.submissions.push(submitted);
    this.openOrders.set(command.clientOrderId, { side: command.side, original: command.quantity, executed: 0 });
    const task = command.reduceOnly === true ? this.completeExit(submitted) : this.partialThenExpire(submitted);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }
  async cancelOrder(): Promise<void> {}
  async loadSnapshot(_symbol: string, canonicalSymbol: string): Promise<ExchangeStateSnapshot> {
    return {
      position: {
        symbol: canonicalSymbol,
        side: this.positionQty > 0 ? "LONG" : this.positionQty < 0 ? "SHORT" : "FLAT",
        qty: Math.abs(this.positionQty),
        entryPrice: this.positionQty === 0 ? 0 : 1_000,
        realizedPnl: 0
      },
      openOrders: [...this.openOrders.entries()].map(([orderId, order]) => ({
        orderId,
        side: order.side,
        remainingQty: order.original - order.executed
      }))
    };
  }
  async close(): Promise<void> { await Promise.all([...this.pending]); }

  private async partialThenExpire(command: (typeof this.submissions)[number]): Promise<void> {
    await sleep(1);
    await this.emit(this.update(command, "NEW", "NEW", 0, 0, 0));
    const filled = 0.006;
    this.positionQty += command.side === "BUY" ? filled : -filled;
    this.openOrders.get(command.clientOrderId)!.executed = filled;
    await this.emit(this.update(command, "TRADE", "PARTIALLY_FILLED", filled, 1_000, 0));
    this.openOrders.delete(command.clientOrderId);
    await this.emit(this.update(command, "EXPIRED", "EXPIRED", 0, 0, 0, "9"));
  }

  private async completeExit(command: (typeof this.submissions)[number]): Promise<void> {
    await sleep(1);
    await this.emit(this.update(command, "NEW", "NEW", 0, 0, 0));
    this.positionQty += command.side === "BUY" ? command.quantity : -command.quantity;
    this.openOrders.delete(command.clientOrderId);
    await this.emit(this.update(command, "TRADE", "FILLED", command.quantity, 999, -0.2));
  }

  private update(
    command: (typeof this.submissions)[number],
    executionType: string,
    status: string,
    lastQty: number,
    lastPrice: number,
    realizedPnl: number,
    expiryReason?: string
  ): BinanceOrderTradeUpdate {
    return {
      e: "ORDER_TRADE_UPDATE",
      E: Date.now(),
      T: Date.now(),
      o: {
        s: command.symbol,
        c: command.clientOrderId,
        S: command.side,
        x: executionType,
        X: status,
        i: this.submissions.indexOf(command) + 1,
        q: String(command.quantity),
        p: "0",
        ap: lastPrice > 0 ? String(lastPrice) : "1000",
        l: String(lastQty),
        L: lastPrice > 0 ? String(lastPrice) : "0",
        N: "USDT",
        n: lastQty > 0 ? "0.001" : "0",
        rp: String(realizedPnl),
        er: expiryReason,
        T: Date.now(),
        t: this.tradeId++
      }
    };
  }

  private async emit(update: BinanceOrderTradeUpdate): Promise<void> {
    if (this.handler === null) throw new Error("user stream not connected");
    await this.handler(update);
  }
}
