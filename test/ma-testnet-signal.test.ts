import assert from "node:assert/strict";
import test from "node:test";

import { MovingAverageTestnetRoundTripSignal } from "../src/testnet-index.ts";

test("uses the real MA decision for entry, freezes it until Fill, then requests FLAT", () => {
  const signal = new MovingAverageTestnetRoundTripSignal(3, 6);
  const actions = [100, 101, 102, 103, 104, 105].map((price, index) => signal.onTick({
    seq: index + 1,
    symbol: "BTC-PERP",
    lastPrice: price,
    markPrice: price,
    indexPrice: price,
    ts: index + 1
  }));

  assert.equal(actions[5]?.action, "LONG");
  assert.equal(actions[5]?.reason, "short MA > long MA");
  assert.equal(signal.onTick({ seq: 7, symbol: "BTC-PERP", lastPrice: 1, markPrice: 1, indexPrice: 1, ts: 7 }).action, "LONG");

  signal.requestExit();
  const exit = signal.onTick({ seq: 8, symbol: "BTC-PERP", lastPrice: 1, markPrice: 1, indexPrice: 1, ts: 8 });
  assert.equal(exit.action, "FLAT");
  assert.equal(exit.reason, "Testnet cleanup after MA-generated entry Fill");
});
