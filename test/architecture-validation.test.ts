import assert from "node:assert/strict";
import test from "node:test";

import { PerpBot } from "../src/bot.ts";
import type { ExecutionEventHandler, ExecutionVenue } from "../src/exchange.ts";
import { InFlightOrderTracker } from "../src/order-tracker.ts";
import type { BotCheckpoint, BotStateStore } from "../src/state-store.ts";
import type { CancelAck, Fill, OrderAck, SubmitOrderCommand, Tick } from "../src/types.ts";

test("persists a client-owned SUBMITTED identity before crossing the venue boundary", async () => {
  const store = new MemoryStateStore();
  const venue = new InspectingVenue(() => {
    const checkpoint = store.get();
    assert.equal(checkpoint?.nextClientOrderSequence, 2);
    assert.deepEqual(checkpoint?.orderTrackerState.orders[0]?.order, {
      clientOrderId: "BTC-PERP-1",
      exchangeOrderId: null,
      side: "BUY",
      originalQty: 0.01,
      filledQty: 0,
      remainingQty: 0.01,
      status: "SUBMITTED"
    });
  });
  const bot = await PerpBot.create(config(venue, store));

  for (const [index, price] of [100, 101, 102, 103].entries()) {
    await bot.onTick(tick(index + 1, price));
  }

  assert.equal(venue.submitCount, 1);
});

test("restarts fail-closed from SUBMITTED without an exchange identity", async () => {
  const checkpoint = submittedCheckpoint();
  const store = new MemoryStateStore(checkpoint);
  const venue = new InspectingVenue(() => {});
  const logs: string[] = [];
  const bot = await PerpBot.create({ ...config(venue, store), logger: (line) => logs.push(line) });

  assert.equal(bot.isRecoveryRequired(), true);
  await bot.onTick(tick(10, 110));

  assert.equal(venue.submitCount, 0);
  assert.match(logs.join("\n"), /\[RECOVERY\] blocked openOrders=1/);
  assert.deepEqual(store.get(), checkpoint);
});

test("documents that a late ACK after SUBMITTED cancel intent is rejected without clearing cancel intent", () => {
  const tracker = submittedTracker();

  assert.equal(tracker.requestCancelOpenOrders()[0]?.status, "CANCEL_REQUESTED");
  assert.throws(() => tracker.processAck(orderAck()), /not awaiting acknowledgment/);
  assert.equal(tracker.get("CLIENT-1")?.status, "CANCEL_REQUESTED");
  tracker.processCancelAck(cancelAck());
  assert.equal(tracker.get("CLIENT-1")?.status, "CANCELED");
});

test("documents that a fill during cancel intent makes the following CANCEL_ACK throw", () => {
  const tracker = submittedTracker();
  tracker.processAck(orderAck());
  tracker.requestCancelOpenOrders();

  assert.equal(tracker.processFill(partialFill()).accepted, true);
  assert.equal(tracker.get("CLIENT-1")?.status, "PARTIALLY_FILLED");
  assert.throws(() => tracker.processCancelAck(cancelAck()), /not awaiting cancel confirmation/);
});

class InspectingVenue implements ExecutionVenue {
  submitCount = 0;
  private readonly inspect: () => void;

  constructor(inspect: () => void) {
    this.inspect = inspect;
  }

  onExecutionEvent(_handler: ExecutionEventHandler): void {}

  async submit(_command: SubmitOrderCommand): Promise<void> {
    this.submitCount += 1;
    this.inspect();
  }

  async requestCancel(_clientOrderId: string): Promise<void> {}
}

class MemoryStateStore implements BotStateStore {
  private checkpoint: BotCheckpoint | null;

  constructor(checkpoint: BotCheckpoint | null = null) {
    this.checkpoint = checkpoint;
  }

  async load(): Promise<BotCheckpoint | null> {
    return this.get();
  }

  async save(checkpoint: BotCheckpoint): Promise<void> {
    this.checkpoint = structuredClone(checkpoint);
  }

  get(): BotCheckpoint | null {
    return this.checkpoint === null ? null : structuredClone(this.checkpoint);
  }
}

function config(venue: ExecutionVenue, stateStore: BotStateStore) {
  return {
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    venue,
    stateStore,
    logger: () => {}
  };
}

function submittedCheckpoint(): BotCheckpoint {
  return {
    version: 1,
    symbol: "BTC-PERP",
    positionState: {
      position: { symbol: "BTC-PERP", side: "FLAT", qty: 0, entryPrice: 0, realizedPnl: 0 },
      processedFillIds: []
    },
    orderTrackerState: {
      orders: [{
        order: {
          clientOrderId: "BTC-PERP-1",
          exchangeOrderId: null,
          side: "BUY",
          originalQty: 0.01,
          filledQty: 0,
          remainingQty: 0.01,
          status: "SUBMITTED"
        },
        symbol: "BTC-PERP",
        processedFillIds: []
      }]
    },
    nextClientOrderSequence: 2,
    halted: false,
    lastMarkPrice: 100
  };
}

function tick(seq: number, price: number): Tick {
  return { seq, symbol: "BTC-PERP", lastPrice: price, markPrice: price, indexPrice: price, ts: seq };
}

function submittedTracker(): InFlightOrderTracker {
  const tracker = new InFlightOrderTracker();
  tracker.trackSubmission("CLIENT-1", orderAck().request);
  return tracker;
}

function orderAck(): OrderAck {
  return {
    clientOrderId: "CLIENT-1",
    exchangeOrderId: "VENUE-1",
    status: "ACKED",
    request: { symbol: "BTC-PERP", side: "BUY", qty: 0.01, price: 100, reason: "test", ts: 1 },
    ts: 2
  };
}

function partialFill(): Fill {
  return {
    fillId: "FILL-1",
    clientOrderId: "CLIENT-1",
    exchangeOrderId: "VENUE-1",
    symbol: "BTC-PERP",
    side: "BUY",
    qty: 0.004,
    price: 100,
    fee: 0,
    ts: 3
  };
}

function cancelAck(): CancelAck {
  return {
    clientOrderId: "CLIENT-1",
    exchangeOrderId: "VENUE-1",
    status: "CANCELED",
    ts: 4
  };
}
