import assert from "node:assert/strict";
import test from "node:test";

import { SimulatedExchange } from "../src/exchange.ts";
import type { ExecutionEvent } from "../src/types.ts";

test("submit completion carries no acknowledgment fact", async () => {
  const exchange = new SimulatedExchange(20);
  const events: ExecutionEvent[] = [];
  exchange.onExecutionEvent((event) => events.push(event));

  const completion = await exchange.submit(command("CLIENT-1"));

  assert.equal(completion, undefined);
  assert.deepEqual(events.map((event) => event.type), ["ORDER_ACK"]);
  await exchange.drain();
  assert.deepEqual(events.map((event) => event.type), ["ORDER_ACK", "FILL"]);
});

test("client identity exists before the venue assigns its identity", async () => {
  const exchange = new SimulatedExchange(1);
  const seen: ExecutionEvent[] = [];
  exchange.onExecutionEvent((event) => seen.push(event));
  const submitted = command("OWNED-BEFORE-SUBMIT");

  assert.equal(submitted.clientOrderId, "OWNED-BEFORE-SUBMIT");
  await exchange.submit(submitted);
  assert.equal(seen[0]?.type === "ORDER_ACK" && seen[0].ack.clientOrderId, submitted.clientOrderId);
  assert.equal(seen[0]?.type === "ORDER_ACK" && seen[0].ack.exchangeOrderId, "SIM-1");
  await exchange.drain();
  assert.equal(seen[1]?.type === "FILL" && seen[1].fill.clientOrderId, submitted.clientOrderId);
});

test("cancel acknowledgment is an event and suppresses an unexecuted fill", async () => {
  const exchange = new SimulatedExchange(30);
  const events: ExecutionEvent[] = [];
  exchange.onExecutionEvent((event) => events.push(event));
  await exchange.submit(command("CLIENT-1"));

  await exchange.requestCancel("CLIENT-1");
  await exchange.drain();

  assert.deepEqual(events.map((event) => event.type), ["ORDER_ACK", "CANCEL_ACK"]);
});

test("partial fill remains authoritative when cancel suppresses only the remainder", async () => {
  const exchange = new SimulatedExchange(1, 0, [
    { fraction: 0.4, delayMs: 1 }, { fraction: 0.6, delayMs: 40 }
  ]);
  const events: ExecutionEvent[] = [];
  exchange.onExecutionEvent((event) => events.push(event));
  await exchange.submit(command("CLIENT-1"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await exchange.requestCancel("CLIENT-1");
  await exchange.drain();

  assert.deepEqual(events.map((event) => event.type), ["ORDER_ACK", "FILL", "CANCEL_ACK"]);
  assert.equal(events[1]?.type === "FILL" && events[1].fill.qty, 0.004);
});

function command(clientOrderId: string) {
  return { clientOrderId, request: {
    symbol: "BTC-PERP", side: "BUY" as const, qty: 0.01, price: 100, reason: "test", ts: 1
  } };
}
