import assert from "node:assert/strict";
import test from "node:test";

import {
  DeterministicResearchRouter,
  DeterministicStrategyReviewer,
  MockEvidenceSearch
} from "../src/overlay/research.ts";
import { BoundedShadowRunner } from "../src/overlay/shadow-runner.ts";
import type {
  Evidence,
  EvidenceSearch,
  ShadowRecord,
  ShadowResult,
  TradeCandidate
} from "../src/overlay/types.ts";

test("provider failure records no shadow verdict or raw error", async () => {
  const records: ShadowRecord[] = [];
  const runner = createRunner(records, {
    async search() {
      throw new Error("secret raw provider response");
    }
  });

  runner.start(candidate("FAILED"));
  await runner.drain(100);

  assert.deepEqual(records, [
    {
      candidateId: "FAILED",
      status: "PROVIDER_FAILED",
      completedAt: records[0]?.completedAt,
      errorCode: "SEARCH_FAILED"
    }
  ]);
  assert.equal("shadowVerdict" in records[0]!, false);
  assert.doesNotMatch(JSON.stringify(records), /secret raw provider response/);
});

test("insufficient evidence is a completed ABSTAIN rather than a provider failure", async () => {
  const records: ShadowRecord[] = [];
  const result = review("ABSTAIN", "INSUFFICIENT_SOURCE");
  const runner = createRunner(records, new MockEvidenceSearch(), result);

  runner.start(candidate("INSUFFICIENT"));
  await runner.drain(100);

  assert.equal(records[0]?.status, "COMPLETED");
  if (records[0]?.status === "COMPLETED") {
    assert.equal(records[0].shadowVerdict, "ABSTAIN");
    assert.equal(records[0].result.moveValidity, "INSUFFICIENT_SOURCE");
  }
});

test("drain timeout finalizes unfinished tasks as INCOMPLETE", async () => {
  const records: ShadowRecord[] = [];
  const runner = createRunner(records, { search: () => new Promise(() => {}) });

  runner.start(candidate("SLOW"));
  await runner.drain(1);

  assert.deepEqual(records, [
    { candidateId: "SLOW", status: "INCOMPLETE", completedAt: records[0]?.completedAt }
  ]);
  assert.equal("shadowVerdict" in records[0]!, false);
});

test("runner gives providers only a defensive frozen T0 candidate", async () => {
  const records: ShadowRecord[] = [];
  const original = candidate("FROZEN");
  let received: TradeCandidate | undefined;
  const runner = createRunner(records, {
    async search(value) {
      received = value;
      return [];
    }
  });

  runner.start(original);
  (original.snapshot.meme as { spotPrice: number }).spotPrice = 999;
  await runner.drain(100);

  assert.equal(received?.snapshot.meme.spotPrice, 160);
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received?.snapshot.meme), true);
});

function createRunner(
  records: ShadowRecord[],
  search: EvidenceSearch,
  result: ShadowResult = review("PASS", "SUPPORTED")
): BoundedShadowRunner {
  return new BoundedShadowRunner({
    router: new DeterministicResearchRouter(),
    search,
    reviewer: new DeterministicStrategyReviewer(result),
    record: (record) => records.push(record),
    maxInFlight: 2
  });
}

function candidate(candidateId: string): TradeCandidate {
  return {
    candidateId,
    t0: 2,
    snapshot: {
      seq: 2,
      ts: 2,
      meme: { symbol: "DOGE", spotPrice: 160, fdv: 1_600 },
      prediction: {
        marketId: "DOGE-FDV-2B",
        question: "Will DOGE exceed $2B FDV?",
        targetFdv: 2_000,
        yesPrice: 0.35
      }
    },
    signal: {
      action: "BUY_YES",
      marketId: "DOGE-FDV-2B",
      yesPrice: 0.35,
      ts: 2,
      reason: "test candidate"
    }
  };
}

function review(
  verdict: ShadowResult["verdict"],
  moveValidity: ShadowResult["moveValidity"]
): ShadowResult {
  return {
    verdict,
    confidence: 0.7,
    moveValidity,
    moveDecomposition: ["MOMENTUM"],
    sourceAgreement: "INSUFFICIENT",
    evidenceSourceIds: [],
    reason: "deterministic fixture",
    catalystSupport: "UNKNOWN",
    entryQuality: "MEDIUM",
    mispricingConfidence: "LOW",
    resolutionRisk: "UNKNOWN",
    dataQuality: "LOW"
  };
}
