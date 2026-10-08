import assert from "node:assert/strict";
import test from "node:test";

import {
  CandidateTestnetDemoSignal,
  TESTNET_DEMO_MAPPING_VERSION,
  testnetDemoMapping
} from "../src/overlay/prospective-testnet-demo.ts";

test("freezes an explicit same-asset LONG mapping for Testnet execution smoke only", () => {
  assert.deepEqual(testnetDemoMapping("BTC"), {
    version: TESTNET_DEMO_MAPPING_VERSION,
    asset: "BTC",
    canonicalSymbol: "BTC-PERP",
    venueSymbol: "BTCUSDT",
    quantity: 0.001,
    side: "LONG",
    purpose: "EXECUTION_SMOKE_ONLY",
    directionalEdgeClaim: false
  });
  assert.equal(testnetDemoMapping("ETH").venueSymbol, "ETHUSDT");
  assert.equal(testnetDemoMapping("SOL").venueSymbol, "SOLUSDT");
  assert.deepEqual(testnetDemoMapping("XRP"), {
    version: TESTNET_DEMO_MAPPING_VERSION,
    asset: "XRP",
    canonicalSymbol: "XRP-PERP",
    venueSymbol: "XRPUSDT",
    quantity: 5,
    side: "LONG",
    purpose: "EXECUTION_SMOKE_ONLY",
    directionalEdgeClaim: false
  });
  assert.deepEqual(testnetDemoMapping("DOGE", "SHORT"), {
    version: TESTNET_DEMO_MAPPING_VERSION,
    asset: "DOGE",
    canonicalSymbol: "DOGE-PERP",
    venueSymbol: "DOGEUSDT",
    quantity: 100,
    side: "SHORT",
    purpose: "EXECUTION_SMOKE_ONLY",
    directionalEdgeClaim: false
  });
  assert.equal(testnetDemoMapping("HYPE").venueSymbol, "HYPEUSDT");
  assert.equal(testnetDemoMapping("BNB").venueSymbol, "BNBUSDT");
});

test("Hourly DOWN Candidate requests SHORT until Fill, then deterministic FLAT", () => {
  const signal = new CandidateTestnetDemoSignal("HOURLY-DOWN", "SHORT");
  const tick = { seq: 1, symbol: "DOGE-PERP", lastPrice: 1, markPrice: 1, indexPrice: 1, ts: 1 };
  assert.equal(signal.onTick(tick).action, "SHORT");
  signal.requestExit();
  assert.equal(signal.onTick({ ...tick, seq: 2 }).action, "FLAT");
});

test("Candidate signal requests LONG until Fill, then deterministic FLAT", () => {
  const signal = new CandidateTestnetDemoSignal("CANDIDATE-1");
  const tick = { seq: 1, symbol: "BTC-PERP", lastPrice: 1, markPrice: 1, indexPrice: 1, ts: 1 };

  const entry = signal.onTick(tick);
  assert.equal(entry.action, "LONG");
  assert.match(entry.reason, /^TESTNET_DEMO_ONLY_V1 prospective Candidate CANDIDATE-1$/);

  signal.requestExit();
  const exit = signal.onTick({ ...tick, seq: 2 });
  assert.equal(exit.action, "FLAT");
  assert.equal(exit.reason, "TESTNET_DEMO_ONLY_V1 deterministic FLAT after entry Fill");
});
