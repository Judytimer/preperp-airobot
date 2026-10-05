import assert from "node:assert/strict";
import test from "node:test";

import { RiskManager } from "../src/risk.ts";
import type { Position, SignalAction } from "../src/types.ts";

const risk = new RiskManager({ orderQty: 0.01, maxAbsPosition: 0.03 });
const tick = { seq: 1, symbol: "BTC-PERP", lastPrice: 100, markPrice: 100, indexPrice: 100, ts: 1 };

function evaluate(action: SignalAction, position: Position) {
  return risk.evaluate(
    { action, shortMa: 101, longMa: 100, reason: "target-position test" },
    position,
    tick
  );
}

test("LONG 0.02 -> target SHORT 0.01 requires SELL 0.03", () => {
  const decision = evaluate("SHORT", position("LONG", 0.02));
  assert.equal(decision.approved, true);
  if (decision.approved) {
    assert.equal(decision.order.side, "SELL");
    assert.equal(decision.order.qty, 0.03);
    assert.equal(decision.order.price, tick.lastPrice);
  }
});

test("SHORT 0.02 -> target LONG 0.01 requires BUY 0.03", () => {
  const decision = evaluate("LONG", position("SHORT", 0.02));
  assert.equal(decision.approved, true);
  if (decision.approved) {
    assert.equal(decision.order.side, "BUY");
    assert.equal(decision.order.qty, 0.03);
  }
});

test("FLAT -> target LONG 0.01 requires BUY 0.01", () => {
  const decision = evaluate("LONG", position("FLAT", 0));
  assert.equal(decision.approved, true);
  if (decision.approved) {
    assert.equal(decision.order.side, "BUY");
    assert.equal(decision.order.qty, 0.01);
  }
});

test("LONG 0.01 -> target LONG 0.01 requires no order", () => {
  const decision = evaluate("LONG", position("LONG", 0.01));
  assert.deepEqual(decision, { approved: false, reason: "already LONG" });
});

test("LONG 0.01 -> target FLAT requires SELL 0.01", () => {
  const decision = evaluate("FLAT", position("LONG", 0.01));
  assert.equal(decision.approved, true);
  if (decision.approved) {
    assert.equal(decision.order.side, "SELL");
    assert.equal(decision.order.qty, 0.01);
  }
});

test("SHORT 0.01 -> target FLAT requires BUY 0.01", () => {
  const decision = evaluate("FLAT", position("SHORT", 0.01));
  assert.equal(decision.approved, true);
  if (decision.approved) {
    assert.equal(decision.order.side, "BUY");
    assert.equal(decision.order.qty, 0.01);
  }
});

test("explicit PerpIntent quantity resizes a same-side target by delta", () => {
  const decision = risk.evaluate(
    { action: "LONG", targetQty: 0.025, shortMa: null, longMa: null, reason: "authorized PerpIntent" },
    position("LONG", 0.01),
    tick
  );
  assert.equal(decision.approved, true);
  if (decision.approved) {
    assert.equal(decision.order.side, "BUY");
    assert.equal(decision.order.qty, 0.015);
  }
});

test("explicit PerpIntent quantity remains bounded by maxAbsPosition", () => {
  const decision = risk.evaluate(
    { action: "LONG", targetQty: 0.031, shortMa: null, longMa: null, reason: "oversized PerpIntent" },
    position("FLAT", 0),
    tick
  );
  assert.deepEqual(decision, {
    approved: false,
    reason: "target 0.031 exceeds maxAbsPosition 0.03"
  });
});

function position(side: Position["side"], qty: number): Position {
  return {
    symbol: "BTC-PERP",
    side,
    qty,
    entryPrice: qty === 0 ? 0 : 100,
    realizedPnl: 0
  };
}
