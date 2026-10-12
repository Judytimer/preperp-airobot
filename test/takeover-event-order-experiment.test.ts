import assert from "node:assert/strict";
import test from "node:test";

import { InFlightOrderTracker } from "../src/order-tracker.ts";
import type { OrderAck, OrderRequest, OrderTerminal } from "../src/types.ts";

test("takeover experiment: late ACK and terminal preserve the cancel intent", () => {
  const tracker = new InFlightOrderTracker();
  tracker.trackSubmission("CLIENT-EXPERIMENT-1", request());

  assert.deepEqual(statuses(tracker), ["SUBMITTED"]);
  assert.equal(tracker.requestCancelOpenOrders()[0]?.cancelRequested, true);

  tracker.processAck(orderAck());
  assert.equal(tracker.get("CLIENT-EXPERIMENT-1")?.status, "ACKED");
  assert.equal(tracker.get("CLIENT-EXPERIMENT-1")?.cancelRequested, true);

  const canceled = tracker.processTerminal(terminal());
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

function terminal(): OrderTerminal {
  return {
    clientOrderId: "CLIENT-EXPERIMENT-1",
    exchangeOrderId: "VENUE-EXPERIMENT-1",
    status: "CANCELED",
    ts: 3
  };
}
