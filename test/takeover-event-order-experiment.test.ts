import assert from "node:assert/strict";
import test from "node:test";

import { InFlightOrderTracker } from "../src/order-tracker.ts";
import type { CancelAck, OrderAck, OrderRequest } from "../src/types.ts";

test("takeover experiment: late ACK is rejected without blocking the following CancelAck", () => {
  const tracker = new InFlightOrderTracker();
  tracker.trackSubmission("CLIENT-EXPERIMENT-1", request());

  assert.deepEqual(statuses(tracker), ["SUBMITTED"]);
  assert.equal(tracker.requestCancelOpenOrders()[0]?.status, "CANCEL_REQUESTED");

  assert.throws(() => tracker.processAck(orderAck()), /not awaiting acknowledgment/);
  assert.equal(tracker.get("CLIENT-EXPERIMENT-1")?.status, "CANCEL_REQUESTED");

  const canceled = tracker.processCancelAck(cancelAck());
  assert.equal(canceled.exchangeOrderId, "VENUE-EXPERIMENT-1");
  assert.equal(canceled.status, "CANCELED");
});

function statuses(tracker: InFlightOrderTracker): string[] {
  return tracker.getOpenOrders().map((order) => order.status);
}

function request(): OrderRequest {
  return {
    symbol: "BTC-PERP",
    side: "BUY",
    qty: 0.01,
    price: 100,
    reason: "takeover event-order experiment",
    ts: 1
  };
}

function orderAck(): OrderAck {
  return {
    clientOrderId: "CLIENT-EXPERIMENT-1",
    exchangeOrderId: "VENUE-EXPERIMENT-1",
    status: "ACKED",
    request: request(),
    ts: 2
  };
}

function cancelAck(): CancelAck {
  return {
    clientOrderId: "CLIENT-EXPERIMENT-1",
    exchangeOrderId: "VENUE-EXPERIMENT-1",
    status: "CANCELED",
    ts: 3
  };
}
