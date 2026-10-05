import assert from "node:assert/strict";
import test from "node:test";

import {
  runAuthenticatedTestnetPerpValidation,
  validateFlatPreflight
} from "../src/perp-testnet-validation.ts";
import type {
  TestnetValidationFeed,
  TestnetValidationVenue
} from "../src/perp-testnet-validation.ts";
import type { ExecutionEventHandler } from "../src/exchange.ts";
import type { ExchangeStateSnapshot } from "../src/reconciliation.ts";
import type { SubmitOrderCommand, Tick } from "../src/types.ts";

test("orchestrates an explicit LONG to FLAT authenticated-venue round trip", async () => {
  const venue = new FakeTestnetVenue(flatSnapshot());
  const feed = new FakeTestnetFeed();
  const report = await runAuthenticatedTestnetPerpValidation({
    venue,
    feed,
    roundTripTimeoutMs: 500,
    reconciliationTimeoutMs: 500
  });

  assert.equal(report.overall, "PASS");
  assert.equal(report.mode, "AUTHENTICATED_TESTNET");
  assert.deepEqual(report.execution.submissions.map((item) => item.request.side), ["BUY", "SELL"]);
  assert.equal(report.execution.acknowledgements.length, 2);
  assert.equal(report.execution.fills.length, 2);
  assert.equal(report.execution.openedPosition.side, "LONG");
  assert.equal(report.execution.finalLocalPosition.side, "FLAT");
  assert.equal(report.final.snapshot.position.side, "FLAT");
  assert.equal(report.final.reconciliation.consistent, true);
  assert.equal(report.funding.status, "NOT_OBSERVED");
});

test("authenticated validation preflight rejects a non-flat venue without submitting", async () => {
  const nonFlat = {
    position: { symbol: "BTC-PERP", side: "SHORT" as const, qty: 0.001, entryPrice: 80_000, realizedPnl: 0 },
    openOrders: []
  };
  const venue = new FakeTestnetVenue(nonFlat);
  const feed = new FakeTestnetFeed();

  await assert.rejects(
    runAuthenticatedTestnetPerpValidation({
      venue,
      feed,
      roundTripTimeoutMs: 100,
      reconciliationTimeoutMs: 100
    }),
    /preflight failed/
  );
  assert.equal(venue.submissions.length, 0);
  assert.equal(feed.started, false);
});

test("flat preflight also rejects local recovery state", () => {
  const snapshot = flatSnapshot();
  assert.throws(
    () => validateFlatPreflight({
      getPosition: () => snapshot.position,
      isRecoveryRequired: () => true,
      reconcile: () => ({ consistent: true, issues: [] })
    }, snapshot),
    /recoveryRequired is true/
  );
});

class FakeTestnetVenue implements TestnetValidationVenue {
  readonly submissions: SubmitOrderCommand[] = [];
  private handler: ExecutionEventHandler | undefined;
  private state: ExchangeStateSnapshot;
  private nextOrderId = 1;

  constructor(initial: ExchangeStateSnapshot) {
    this.state = structuredClone(initial);
  }

  onExecutionEvent(handler: ExecutionEventHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {}

  async submit(command: SubmitOrderCommand): Promise<void> {
    if (this.handler === undefined) throw new Error("fake Testnet handler is missing");
    this.submissions.push(structuredClone(command));
    const exchangeOrderId = `TESTNET-${this.nextOrderId++}`;
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
    const currentSigned = this.state.position.side === "LONG"
      ? this.state.position.qty
      : this.state.position.side === "SHORT"
        ? -this.state.position.qty
        : 0;
    const fillSigned = command.request.side === "BUY" ? command.request.qty : -command.request.qty;
    const nextSigned = currentSigned + fillSigned;
    this.state = {
      position: {
        symbol: "BTC-PERP",
        side: nextSigned > 0 ? "LONG" : nextSigned < 0 ? "SHORT" : "FLAT",
        qty: Math.abs(nextSigned),
        entryPrice: nextSigned === 0 ? 0 : command.request.price,
        realizedPnl: 0
      },
      openOrders: []
    };
    await this.handler({
      type: "FILL",
      fill: {
        fillId: `${exchangeOrderId}-FILL`,
        clientOrderId: command.clientOrderId,
        exchangeOrderId,
        symbol: command.request.symbol,
        side: command.request.side,
        qty: command.request.qty,
        price: command.request.price,
        fee: command.request.qty * command.request.price * 0.0004,
        ts: command.request.ts
      }
    });
  }

  async requestCancel(_clientOrderId: string): Promise<void> {}

  async snapshot(): Promise<ExchangeStateSnapshot> {
    return structuredClone(this.state);
  }

  async close(): Promise<void> {}
}

class FakeTestnetFeed implements TestnetValidationFeed {
  started = false;
  private tail: Promise<void> = Promise.resolve();

  async start(onTick: (tick: Tick) => void | Promise<void>): Promise<void> {
    this.started = true;
    this.tail = (async () => {
      await onTick(tick(1, 80_000));
      await onTick(tick(2, 80_100));
    })();
  }

  async close(): Promise<void> {
    await this.tail;
  }
}

function flatSnapshot(): ExchangeStateSnapshot {
  return {
    position: { symbol: "BTC-PERP", side: "FLAT", qty: 0, entryPrice: 0, realizedPnl: 0 },
    openOrders: []
  };
}

function tick(seq: number, price: number): Tick {
  return {
    seq,
    symbol: "BTC-PERP",
    lastPrice: price,
    markPrice: price,
    indexPrice: price,
    ts: seq
  };
}
