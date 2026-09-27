import assert from "node:assert/strict";
import test from "node:test";
import { InFlightOrderTracker } from "../src/order-tracker.ts";
import type { CancelAck, Fill, OrderAck, OrderSide } from "../src/types.ts";

test("tracks client identity before ack, partial fills, and duplicate fill ids", () => {
  const tracker = submitted();
  assert.deepEqual(tracker.get("CLIENT-1"), order(null, "SUBMITTED", 0, 0.01));
  tracker.processAck(ack());
  assert.deepEqual(tracker.get("CLIENT-1"), order("SIM-1", "ACKED", 0, 0.01));

  assert.equal(tracker.processFill(fill("FILL-1", 0.004)).accepted, true);
  assert.deepEqual(tracker.get("CLIENT-1"), order("SIM-1", "PARTIALLY_FILLED", 0.004, 0.006));
  assert.equal(tracker.processFill(fill("FILL-1", 0.004)).accepted, false);
  assert.equal(tracker.processFill(fill("FILL-2", 0.006)).accepted, true);
  assert.deepEqual(tracker.get("CLIENT-1"), order("SIM-1", "FILLED", 0.01, 0));
});

test("ACKED reaches CANCELED after a matching venue cancel acknowledgment", () => {
  const tracker = submitted();
  tracker.processAck(ack());
  assert.equal(tracker.requestCancelOpenOrders()[0]?.status, "CANCEL_REQUESTED");
  tracker.processCancelAck(cancelAck());
  assert.equal(tracker.get("CLIENT-1")?.status, "CANCELED");
  assert.equal(tracker.processFill(fill("LATE", 0.01)).accepted, false);
});

test("SUBMITTED cancel acknowledgment binds venue identity before CANCELED", () => {
  const tracker = submitted();
  assert.equal(tracker.get("CLIENT-1")?.exchangeOrderId, null);
  assert.equal(tracker.requestCancelOpenOrders()[0]?.status, "CANCEL_REQUESTED");
  tracker.processCancelAck(cancelAck());
  assert.equal(tracker.get("CLIENT-1")?.exchangeOrderId, "SIM-1");
  assert.equal(tracker.get("CLIENT-1")?.status, "CANCELED");
});

test("restores client and venue identities with fill idempotency", () => {
  const original = submitted();
  original.processAck(ack());
  original.processFill(fill("FILL-1", 0.004));
  const restored = InFlightOrderTracker.fromState(original.exportState());
  assert.equal(restored.processFill(fill("FILL-1", 0.004)).accepted, false);
  assert.deepEqual(restored.get("CLIENT-1"), original.get("CLIENT-1"));
});

function submitted(): InFlightOrderTracker {
  const tracker = new InFlightOrderTracker();
  tracker.trackSubmission("CLIENT-1", ack().request);
  return tracker;
}
function ack(): OrderAck {
  return { clientOrderId: "CLIENT-1", exchangeOrderId: "SIM-1", status: "ACKED",
    request: { symbol: "BTC-PERP", side: "BUY", qty: 0.01, price: 100, reason: "test", ts: 1 }, ts: 1 };
}
function cancelAck(): CancelAck {
  return { clientOrderId: "CLIENT-1", exchangeOrderId: "SIM-1", status: "CANCELED", ts: 2 };
}
function fill(fillId: string, qty: number): Fill {
  return { fillId, clientOrderId: "CLIENT-1", exchangeOrderId: "SIM-1", symbol: "BTC-PERP",
    side: "BUY", qty, price: 100, fee: 0, ts: 1 };
}
function order(exchangeOrderId: string | null, status: string, filledQty: number, remainingQty: number) {
  return { clientOrderId: "CLIENT-1", exchangeOrderId, side: "BUY" as OrderSide,
    originalQty: 0.01, filledQty, remainingQty, status };
}
