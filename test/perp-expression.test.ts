import assert from "node:assert/strict";
import test from "node:test";

import {
  expressCandidateAsPerp,
  PERP_EXPRESSION_PROTOCOL_VERSION,
  PerpIntentSignalSource
} from "../src/perp-expression.ts";
import { PerpBot } from "../src/bot.ts";
import { SimulatedExchange } from "../src/exchange.ts";
import type {
  FrozenPerpExpressionPolicy,
  PerpSizingContext
} from "../src/perp-expression.ts";
import type { TradeCandidate } from "../src/overlay/types.ts";

test("keeps BUY_YES research-only when the frozen policy is SIGNAL_ONLY", () => {
  const result = expressCandidateAsPerp(candidate(), signalOnlyPolicy(), sizing());

  assert.deepEqual(result, {
    status: "NO_INTENT",
    reasonCode: "SIGNAL_ONLY_POLICY",
    reason: "frozen policy permits research signaling but no perpetual exposure"
  });
});

test("blocks a post-hoc or semantically mismatched expression policy", () => {
  const postHoc = expressCandidateAsPerp(candidate(), {
    ...directionalPolicy(),
    frozenAt: 1_001
  }, sizing());
  assert.equal(postHoc.status, "BLOCKED");
  if (postHoc.status === "BLOCKED") assert.equal(postHoc.reasonCode, "POLICY_NOT_FROZEN_AT_T0");

  const mismatched = expressCandidateAsPerp(candidate(), {
    ...directionalPolicy(),
    sourceMarketId: "OTHER-MARKET"
  }, sizing());
  assert.equal(mismatched.status, "BLOCKED");
  if (mismatched.status === "BLOCKED") assert.equal(mismatched.reasonCode, "MARKET_MISMATCH");
});

test("sizes an explicit directional proxy within risk, leverage, and position caps", () => {
  const result = expressCandidateAsPerp(candidate(), directionalPolicy(), sizing());

  assert.equal(result.status, "INTENT");
  if (result.status !== "INTENT") return;
  assert.equal(result.intent.targetSide, "LONG");
  assert.equal(result.intent.targetQty, 10);
  assert.equal(result.intent.stopPrice, 95);
  assert.equal(result.intent.expectedLossAtStop, 50);
  assert.equal(result.intent.plannedLeverage, 1);
  assert.equal(result.intent.expiresAt, 2_000);
  assert.equal(result.intent.sourceCandidateId, "TEST-FDV:1000");
});

test("an explicit hedge policy can choose SHORT without changing the Candidate", () => {
  const result = expressCandidateAsPerp(candidate(), {
    ...directionalPolicy(),
    mode: "HEDGE",
    targetSide: "SHORT"
  }, sizing());

  assert.equal(result.status, "INTENT");
  if (result.status !== "INTENT") return;
  assert.equal(result.intent.expressionMode, "HEDGE");
  assert.equal(result.intent.targetSide, "SHORT");
  assert.equal(result.intent.stopPrice, 105);
});

test("blocks an intent whose risk-bounded size is below venue minimums", () => {
  const result = expressCandidateAsPerp(candidate(), {
    ...directionalPolicy(),
    maxRiskQuote: 0.001
  }, sizing());

  assert.equal(result.status, "BLOCKED");
  if (result.status === "BLOCKED") assert.equal(result.reasonCode, "BELOW_VENUE_MINIMUM");
});

test("intent signal source targets quantity, exits at stop, and exits after expiry", () => {
  const result = expressCandidateAsPerp(candidate(), directionalPolicy(), sizing());
  assert.equal(result.status, "INTENT");
  if (result.status !== "INTENT") return;
  const source = new PerpIntentSignalSource(result.intent);

  assert.equal(source.onTick(tick(999, 100)).action, "HOLD");
  assert.deepEqual(source.onTick(tick(1_001, 100)), {
    action: "LONG",
    targetQty: 10,
    shortMa: null,
    longMa: null,
    reason: "perp intent PERP-POLICY-1:TEST-FDV:1000"
  });
  assert.equal(source.onTick(tick(1_002, 95)).action, "FLAT");
  assert.equal(source.onTick(tick(1_003, 101)).action, "FLAT");

  const expiringSource = new PerpIntentSignalSource(result.intent);
  assert.equal(expiringSource.onTick(tick(2_001, 100)).action, "FLAT");
  assert.equal(expiringSource.onTick(tick(2_002, 101)).action, "FLAT");
});

test("authorized PerpIntent reaches deterministic Risk and round-trips through execution", async () => {
  const result = expressCandidateAsPerp(candidate(), directionalPolicy(), sizing());
  assert.equal(result.status, "INTENT");
  if (result.status !== "INTENT") return;
  const venue = new SimulatedExchange(0, 0);
  const bot = new PerpBot({
    symbol: "TEST-PERP",
    signalSource: new PerpIntentSignalSource(result.intent),
    orderQty: 1,
    maxAbsPosition: 10,
    margin: { collateral: 1_000, leverage: 2, maintenanceMarginRate: 0.005 },
    venue,
    logger: () => {}
  });

  await bot.onTick(tick(1_001, 100));
  await venue.drain();
  assert.deepEqual(bot.getPosition(), {
    symbol: "TEST-PERP",
    side: "LONG",
    qty: 10,
    entryPrice: 100,
    realizedPnl: 0
  });

  await bot.onTick(tick(1_002, 95));
  await venue.drain();
  assert.equal(bot.getPosition().side, "FLAT");
  assert.equal(bot.getPosition().realizedPnl, -50);
});

function candidate(): TradeCandidate {
  return {
    candidateId: "TEST-FDV:1000",
    t0: 1_000,
    snapshot: {
      seq: 1,
      ts: 1_000,
      meme: { symbol: "TESTUSDT", spotPrice: 1, fdv: 1_000_000 },
      prediction: {
        marketId: "FDV-MARKET-1",
        question: "Will TEST exceed the target FDV?",
        targetFdv: 2_000_000,
        yesPrice: 0.35
      }
    },
    signal: {
      action: "BUY_YES",
      marketId: "FDV-MARKET-1",
      yesPrice: 0.35,
      ts: 1_000,
      reason: "frozen Strategy Candidate"
    }
  };
}

function signalOnlyPolicy(): FrozenPerpExpressionPolicy {
  return {
    protocolVersion: PERP_EXPRESSION_PROTOCOL_VERSION,
    policyId: "SIGNAL-ONLY-1",
    mode: "SIGNAL_ONLY",
    sourceMarketId: "FDV-MARKET-1",
    underlyingSpotSymbol: "TESTUSDT",
    perpSymbol: "TEST-PERP",
    frozenAt: 900,
    validUntil: 5_000,
    rationale: "research observation only"
  };
}

function directionalPolicy(): FrozenPerpExpressionPolicy {
  return {
    protocolVersion: PERP_EXPRESSION_PROTOCOL_VERSION,
    policyId: "PERP-POLICY-1",
    mode: "DIRECTIONAL_PROXY",
    sourceMarketId: "FDV-MARKET-1",
    underlyingSpotSymbol: "TESTUSDT",
    perpSymbol: "TEST-PERP",
    targetSide: "LONG",
    maxRiskQuote: 100,
    maxLeverage: 2,
    stopDistanceBps: 500,
    intentTtlMs: 1_000,
    frozenAt: 900,
    validUntil: 5_000,
    rationale: "explicit directional proxy for contract test"
  };
}

function sizing(): PerpSizingContext {
  return {
    referencePrice: 100,
    accountEquity: 1_000,
    qtyStep: 0.001,
    minQty: 0.001,
    minNotional: 5,
    maxAbsQty: 10
  };
}

function tick(ts: number, markPrice: number) {
  return {
    seq: ts,
    symbol: "TEST-PERP",
    lastPrice: markPrice,
    markPrice,
    indexPrice: markPrice,
    ts
  };
}
