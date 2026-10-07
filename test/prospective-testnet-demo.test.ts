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
