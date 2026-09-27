import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { PerpBot } from "../src/bot.ts";
import { SimulatedExchange } from "../src/exchange.ts";
import type { ExecutionEventHandler, ExecutionVenue, FillDelay, FillPlanStep } from "../src/exchange.ts";
import type { BotCheckpoint, BotStateStore } from "../src/state-store.ts";
import type { SubmitOrderCommand, Tick } from "../src/types.ts";

test("persists SUBMITTED before crossing the venue boundary", async () => {
  const store = new DeferredSaveStateStore();
  const venue = new ManualAckVenue();
  const bot = new PerpBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    stateStore: store,
    venue,
    logger: () => {}
  });

  for (const [index, price] of [100, 101, 102].entries()) {
    await bot.onTick(tick(index + 1, price));
  }
  const actionableTick = bot.onTick(tick(4, 103));
  await store.saveStarted;

  assert.equal(venue.submissions.length, 0);
  assert.equal(store.pendingCheckpoint?.orderTrackerState.orders[0]?.order.status, "SUBMITTED");
  assert.equal(store.pendingCheckpoint?.orderTrackerState.orders[0]?.order.exchangeOrderId, null);

  store.releaseSave();
  await actionableTick;
  assert.equal(venue.submissions.length, 1);
});

test("submit command completion does not acknowledge the order", async () => {
  const store = new MemoryStateStore();
  const venue = new ManualAckVenue();
  const bot = new PerpBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    stateStore: store,
    venue,
    logger: () => {}
  });

  for (const [index, price] of [100, 101, 102, 103].entries()) {
    await bot.onTick(tick(index + 1, price));
  }

  assert.equal(venue.submissions.length, 1);
  assert.equal(store.get()?.orderTrackerState.orders[0]?.order.status, "SUBMITTED");
  assert.equal(store.get()?.orderTrackerState.orders[0]?.order.exchangeOrderId, null);

  await venue.publishAck("VENUE-1");
  assert.equal(store.get()?.orderTrackerState.orders[0]?.order.status, "ACKED");
  assert.equal(store.get()?.orderTrackerState.orders[0]?.order.exchangeOrderId, "VENUE-1");
});

test("runs signal -> risk -> ack -> delayed fill -> position update", async () => {
  const ticks: Tick[] = [
    { seq: 1, symbol: "BTC-PERP", lastPrice: 100, markPrice: 100, indexPrice: 100, ts: 1 },
    { seq: 2, symbol: "BTC-PERP", lastPrice: 101, markPrice: 101, indexPrice: 101, ts: 2 },
    { seq: 3, symbol: "BTC-PERP", lastPrice: 102, markPrice: 102, indexPrice: 102, ts: 3 },
    { seq: 4, symbol: "BTC-PERP", lastPrice: 103, markPrice: 103, indexPrice: 103, ts: 4 },
    { seq: 5, symbol: "BTC-PERP", lastPrice: 104, markPrice: 104, indexPrice: 104, ts: 5 }
  ];

  const logs: string[] = [];
  const bot = makeBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 1,
    logger: (line) => logs.push(line)
  });

  for (const tick of ticks) {
    await bot.onTick(tick);
  }

  await drain(bot);

  assert.equal(bot.getPosition().side, "LONG");
  assert.equal(bot.getPosition().qty, 0.01);
  assert.match(logs.join("\n"), /SIGNAL/);
  assert.match(logs.join("\n"), /ACK/);
  assert.match(logs.join("\n"), /FILL/);
  assert.match(logs.join("\n"), /POSITION/);
});

test("uses pending orders as projected position while fills are delayed", async () => {
  const logs: string[] = [];
  const bot = makeBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 20,
    logger: (line) => logs.push(line)
  });

  for (const [index, price] of [100, 101, 102, 103, 104, 105].entries()) {
    await bot.onTick(tick(index + 1, price));
  }

  await drain(bot);

  assert.equal(logs.filter((line) => line.startsWith("[ACK]")).length, 1);
  assert.doesNotMatch(logs.join("\n"), /waiting for .* pending fill/);
  assert.match(logs.join("\n"), /already LONG/);
  assert.deepEqual(bot.getPosition(), {
    symbol: "BTC-PERP",
    side: "LONG",
    qty: 0.01,
    entryPrice: 103,
    realizedPnl: -0.000412
  });
});

test("matches out-of-order fills to pending orders by orderId", async () => {
  const logs: string[] = [];
  const bot = makeBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: (orderId: string) => (orderId === "SIM-1" ? 30 : 5),
    logger: (line) => logs.push(line)
  });

  for (const [index, price] of [100, 101, 102, 103, 80].entries()) {
    await bot.onTick(tick(index + 1, price));
  }

  await drain(bot);

  const fillOrder = logs
    .filter((line) => line.startsWith("[FILL]"))
    .map((line) => line.match(/exchangeOrderId=(SIM-\d+)/)?.[1]);
  assert.deepEqual(fillOrder, ["SIM-2", "SIM-1"]);
  assert.equal(bot.getPosition().side, "SHORT");
  assert.equal(bot.getPosition().qty, 0.01);
});

test("keeps remaining exposure pending until all partial fills complete", async () => {
  const logs: string[] = [];
  const bot = makeBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 1,
    fillPlan: [
      { fraction: 0.4, delayMs: 1 },
      { fraction: 0.6, delayMs: 50 }
    ],
    logger: (line) => logs.push(line)
  });

  for (const [index, price] of [100, 101, 102, 103].entries()) {
    await bot.onTick(tick(index + 1, price));
  }
  await sleep(10);
  await bot.onTick(tick(5, 104));
  await bot.onTick(tick(6, 105));
  await drain(bot);

  assert.equal(logs.filter((line) => line.startsWith("[ACK]")).length, 1);
  assert.match(logs.join("\n"), /status=PARTIALLY_FILLED filled=0\.004 remaining=0\.006/);
  assert.match(logs.join("\n"), /status=FILLED filled=0\.01 remaining=0/);
  assert.match(logs.join("\n"), /filled=0\.004 pending=0\.006 projected=0\.01/);
  assert.equal(bot.getPosition().side, "LONG");
  assert.equal(bot.getPosition().qty, 0.01);
});

test("liquidates an under-margined position at mark and halts new strategy orders", async () => {
  const logs: string[] = [];
  const bot = makeBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 1,
    margin: { collateral: 0.1, leverage: 20, maintenanceMarginRate: 0.01 },
    logger: (line) => logs.push(line)
  });

  for (const [index, price] of [100, 101, 102, 103].entries()) {
    await bot.onTick(tick(index + 1, price));
  }
  await drain(bot);

  await bot.onTick(tick(5, 110, 90, 100));
  await bot.onTick(tick(6, 110));

  assert.equal(bot.getPosition().side, "FLAT");
  assert.equal(logs.filter((line) => line.startsWith("[ACK]")).length, 1);
  assert.match(
    logs.join("\n"),
    /\[LIQUIDATION\].*triggerMark=90 executionPrice=90 assumption=EXECUTION_AT_MARK/
  );
  assert.match(logs.join("\n"), /halted after liquidation/);
});

test("exchange-confirmed cancel prevents the ghost fill after liquidation", async () => {
  const logs: string[] = [];
  const bot = makeBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 40,
    margin: { collateral: 0.1, leverage: 20, maintenanceMarginRate: 0.01 },
    logger: (line) => logs.push(line)
  });

  for (const [index, price] of [100, 101, 102, 103].entries()) {
    await bot.onTick(tick(index + 1, price));
  }
  await drain(bot);
  assert.deepEqual(bot.getPosition(), {
    symbol: "BTC-PERP",
    side: "LONG",
    qty: 0.01,
    entryPrice: 103,
    realizedPnl: -0.000412
  });

  // The reversal order is ACKED at a healthy mark, but its fill remains delayed.
  await bot.onTick(tick(5, 80, 103, 100));
  assert.match(logs.join("\n"), /\[ACK\] clientOrderId=BTC-PERP-2 exchangeOrderId=SIM-2 side=SELL qty=0\.02/);

  // A later mark triggers a cancel intent which the exchange confirms before liquidation proceeds.
  await bot.onTick(tick(6, 80, 90, 95));
  assert.equal(bot.getPosition().side, "FLAT");

  // The venue-side cancel suppresses the still-unexecuted scheduled fill.
  await drain(bot);
  const trace = logs.filter(
    (line) =>
      line.includes("clientOrderId=BTC-PERP-2") ||
      line.startsWith("[LIQUIDATION]") ||
      line.startsWith("[POSITION]")
  );
  const ackIndex = trace.findIndex((line) => line.startsWith("[ACK] clientOrderId=BTC-PERP-2"));
  const cancelRequestedIndex = trace.findIndex(
    (line) => line.includes("clientOrderId=BTC-PERP-2") && line.includes("status=CANCEL_REQUESTED")
  );
  const cancelAckIndex = trace.findIndex((line) => line.startsWith("[CANCEL_ACK] clientOrderId=BTC-PERP-2"));
  const canceledIndex = trace.findIndex(
    (line) => line.startsWith("[ORDER]") && line.includes("clientOrderId=BTC-PERP-2") && line.includes("status=CANCELED")
  );
  const liquidationIndex = trace.findIndex((line) => line.startsWith("[LIQUIDATION]"));
  const lateFillIndex = trace.findIndex((line) => line.startsWith("[FILL]") && line.includes("SIM-2"));

  assert.ok(ackIndex < cancelRequestedIndex);
  assert.ok(cancelRequestedIndex < cancelAckIndex);
  assert.ok(cancelAckIndex < canceledIndex);
  assert.ok(canceledIndex < liquidationIndex);
  assert.equal(lateFillIndex, -1);
  assert.equal(bot.getPosition().side, "FLAT");
});

test("blocks an order when initial margin exceeds marked equity", async () => {
  const logs: string[] = [];
  const bot = makeBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 1,
    margin: { collateral: 0.01, leverage: 2, maintenanceMarginRate: 0.005 },
    logger: (line) => logs.push(line)
  });

  for (const [index, price] of [100, 101, 102, 103].entries()) {
    await bot.onTick(tick(index + 1, price));
  }

  assert.equal(logs.filter((line) => line.startsWith("[ACK]")).length, 0);
  assert.match(logs.join("\n"), /\[MARGIN_RISK\] blocked/);
});

test("restores a filled position and continues client ids without checkpointing venue sequence", async () => {
  const store = new MemoryStateStore();
  const config = {
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 1,
    stateStore: store,
    logger: () => {}
  } as const;
  const first = await createBot(config);
  for (const [index, price] of [100, 101, 102, 103].entries()) {
    await first.onTick(tick(index + 1, price));
  }
  await drain(first);
  const checkpoint = store.get();
  assert.equal(checkpoint?.nextClientOrderSequence, 2);
  assert.equal(checkpoint?.orderTrackerState.orders[0]?.order.clientOrderId, "BTC-PERP-1");
  assert.equal("nextOrderId" in (checkpoint ?? {}), false);

  const logs: string[] = [];
  const restored = await createBot({ ...config, logger: (line: string) => logs.push(line) });
  assert.deepEqual(restored.getPosition(), first.getPosition());
  assert.equal(restored.isRecoveryRequired(), false);

  for (const [index, price] of [103, 102, 101, 100].entries()) {
    await restored.onTick(tick(index + 5, price));
  }
  await drain(restored);

  assert.match(logs.join("\n"), /\[RECOVERY\] restored/);
  assert.match(logs.join("\n"), /\[ACK\] clientOrderId=BTC-PERP-2/);
});

test("halts on restart when the checkpoint contains an unresolved order", async () => {
  const store = new MemoryStateStore(unresolvedCheckpoint());
  const logs: string[] = [];
  const bot = await createBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 1,
    stateStore: store,
    logger: (line) => logs.push(line)
  });

  assert.equal(bot.isRecoveryRequired(), true);
  await bot.onTick(tick(10, 110));

  assert.match(logs.join("\n"), /\[RECOVERY\] blocked openOrders=1/);
  assert.equal(logs.filter((line) => line.startsWith("[ACK]")).length, 0);

  assert.deepEqual(
    bot.reconcile({
      position: { symbol: "BTC-PERP", side: "FLAT", qty: 0, entryPrice: 0, realizedPnl: 0 },
      openOrders: []
    }),
    {
      consistent: false,
      issues: [{ type: "MISSING_EXCHANGE_ORDER", orderId: "BTC-PERP-1" }]
    }
  );
});

test("keeps the latest mark when a delayed fill arrives at the last trade price", async () => {
  const bot = makeBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 20,
    logger: () => {}
  });

  for (const [index, price] of [100, 101, 102, 103].entries()) {
    await bot.onTick(tick(index + 1, price));
  }
  await bot.onTick(tick(5, 104, 95, 97));
  await drain(bot);

  assert.equal(bot.getAccountSnapshot()?.markPrice, 95);
  assert.equal(bot.getPosition().entryPrice, 103);
});

test("funding changes equity without taking ownership of the latest market mark", async () => {
  const logs: string[] = [];
  const bot = makeBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 1,
    maxAbsPosition: 1,
    fillDelayMs: 1,
    logger: (line) => logs.push(line)
  });
  for (const [index, price] of [100, 101, 102, 103].entries()) {
    await bot.onTick(tick(index + 1, price));
  }
  await drain(bot);
  await bot.onTick(tick(5, 104, 95, 97));

  const settlement = {
    fundingId: "BTC-1000",
    symbol: "BTC-PERP",
    rate: 0.001,
    markPrice: 100,
    ts: 1_000
  } as const;
  await bot.onFunding(settlement);
  await bot.onFunding(settlement);

  assert.equal(bot.getAccountSnapshot()?.markPrice, 95);
  assert.equal(bot.getPosition().realizedPnl, -0.1412);
  assert.match(logs.join("\n"), /settlementMark=100 payment=-0\.1/);
  assert.match(logs.join("\n"), /fundingId=BTC-1000 ignored=duplicate/);
});

class MemoryStateStore implements BotStateStore {
  private checkpoint: BotCheckpoint | null;

  constructor(checkpoint: BotCheckpoint | null = null) {
    this.checkpoint = checkpoint;
  }

  async load(): Promise<BotCheckpoint | null> {
    return this.checkpoint === null ? null : structuredClone(this.checkpoint);
  }

  async save(checkpoint: BotCheckpoint): Promise<void> {
    this.checkpoint = structuredClone(checkpoint);
  }

  get(): BotCheckpoint | null {
    return this.checkpoint === null ? null : structuredClone(this.checkpoint);
  }
}

class DeferredSaveStateStore implements BotStateStore {
  pendingCheckpoint: BotCheckpoint | null = null;
  private readonly saveStartedGate = deferred();
  private readonly saveReleaseGate = deferred();
  readonly saveStarted = this.saveStartedGate.promise;

  async load(): Promise<BotCheckpoint | null> {
    return null;
  }

  async save(checkpoint: BotCheckpoint): Promise<void> {
    this.pendingCheckpoint = structuredClone(checkpoint);
    this.saveStartedGate.resolve();
    await this.saveReleaseGate.promise;
  }

  releaseSave(): void {
    this.saveReleaseGate.resolve();
  }
}

class ManualAckVenue implements ExecutionVenue {
  readonly submissions: SubmitOrderCommand[] = [];
  private handler: ExecutionEventHandler | undefined;

  onExecutionEvent(handler: ExecutionEventHandler): void {
    this.handler = handler;
  }

  async submit(command: SubmitOrderCommand): Promise<void> {
    this.submissions.push(structuredClone(command));
  }

  async requestCancel(): Promise<void> {}

  async publishAck(exchangeOrderId: string): Promise<void> {
    const command = this.submissions[0];
    if (command === undefined || this.handler === undefined) {
      throw new Error("cannot publish ACK before submission and handler registration");
    }
    await this.handler({
      type: "ORDER_ACK",
      ack: {
        clientOrderId: command.clientOrderId,
        exchangeOrderId,
        status: "ACKED",
        request: command.request,
        ts: command.request.ts
      }
    });
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function unresolvedCheckpoint(): BotCheckpoint {
  return {
    version: 1,
    symbol: "BTC-PERP",
    positionState: {
      position: { symbol: "BTC-PERP", side: "FLAT", qty: 0, entryPrice: 0, realizedPnl: 0 },
      processedFillIds: []
    },
    orderTrackerState: {
      orders: [
        {
          order: {
            clientOrderId: "BTC-PERP-1",
            exchangeOrderId: "SIM-1",
            side: "BUY",
            originalQty: 0.01,
            filledQty: 0,
            remainingQty: 0.01,
            status: "ACKED"
          },
          symbol: "BTC-PERP",
          processedFillIds: []
        }
      ]
    },
    nextClientOrderSequence: 2,
    halted: false,
    lastMarkPrice: 100
  };
}

function tick(seq: number, lastPrice: number, markPrice = lastPrice, indexPrice = markPrice): Tick {
  return { seq, symbol: "BTC-PERP", lastPrice, markPrice, indexPrice, ts: seq };
}


type TestBotConfig = Omit<ConstructorParameters<typeof PerpBot>[0], "venue"> & {
  fillDelayMs: FillDelay;
  fillPlan?: readonly FillPlanStep[];
};
const venues = new WeakMap<PerpBot, SimulatedExchange>();
function makeBot(config: TestBotConfig): PerpBot {
  const { fillDelayMs, fillPlan, ...core } = config;
  const venue = new SimulatedExchange(fillDelayMs, 0.0004, fillPlan);
  const bot = new PerpBot({ ...core, venue });
  venues.set(bot, venue);
  return bot;
}
async function createBot(config: TestBotConfig): Promise<PerpBot> {
  const { fillDelayMs, fillPlan, ...core } = config;
  const venue = new SimulatedExchange(fillDelayMs, 0.0004, fillPlan);
  const bot = await PerpBot.create({ ...core, venue });
  venues.set(bot, venue);
  return bot;
}
async function drain(bot: PerpBot): Promise<void> {
  await venues.get(bot)?.drain();
}
