import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECTIONAL_STUDY_PRIMARY_HORIZON_MS,
  DIRECTIONAL_STUDY_PROTOCOL_VERSION,
  DIRECTIONAL_STUDY_QUALIFICATION,
  DIRECTIONAL_STUDY_SECONDARY_HORIZON_MS,
  evaluateDirectionalStudyV1
} from "../src/directional-study.ts";
import type { DirectionalStudyObservation } from "../src/directional-study.ts";

test("collects fewer than ten qualified prospective Candidates without a direction verdict", () => {
  const result = evaluateDirectionalStudyV1(Array.from({ length: 9 }, (_, index) => observation(index, 100)));

  assert.equal(result.status, "COLLECTING");
  assert.equal(result.outcome, null);
  assert.equal(result.sampleCount, 9);
  assert.equal(result.requiredSampleCount, 10);
});

test("supports LONG only when the frozen 4h gate passes all three checks", () => {
  const returns = [4, 3, 2, 2, 1, 1, 1, -1, -1, -2];
  const result = evaluateDirectionalStudyV1(returns.map((value, index) => observation(index, 100 + value)));

  assert.equal(result.status, "EVALUATED");
  if (result.status !== "EVALUATED") return;
  assert.equal(result.outcome, "DIRECTIONAL_LONG_SUPPORTED");
  assert.equal(result.long.primaryHitRate, 0.7);
  assert.equal(result.long.medianPrimaryReturnBps, 100);
  assert.ok(result.long.medianMfeBps > result.long.medianMaeBps);
});

test("supports SHORT using the same symmetric primary gate", () => {
  const returns = [-4, -3, -2, -2, -1, -1, -1, 1, 1, 2];
  const result = evaluateDirectionalStudyV1(
    returns.map((value, index) => observation(index, 100 + value, "SHORT"))
  );

  assert.equal(result.status, "EVALUATED");
  if (result.status !== "EVALUATED") return;
  assert.equal(result.outcome, "DIRECTIONAL_SHORT_SUPPORTED");
  assert.equal(result.short.primaryHitRate, 0.7);
  assert.equal(result.short.medianPrimaryReturnBps, 100);
});

test("returns NO_DIRECTIONAL_EVIDENCE when hit rate is below the frozen threshold", () => {
  const returns = [5, 4, 3, 2, 1, 1, -1, -2, -3, -4];
  const result = evaluateDirectionalStudyV1(returns.map((value, index) => observation(index, 100 + value)));

  assert.equal(result.status, "EVALUATED");
  if (result.status !== "EVALUATED") return;
  assert.equal(result.long.primaryHitRate, 0.6);
  assert.equal(result.outcome, "NO_DIRECTIONAL_EVIDENCE");
});

test("does not support a direction when its 4h path has larger median MAE than MFE", () => {
  const returns = [4, 3, 2, 2, 1, 1, 1, -1, -1, -2];
  const observations = returns.map((value, index) => ({
    ...observation(index, 100 + value),
    highMark4h: Math.max(104, 100 + value),
    lowMark4h: 90
  }));
  const result = evaluateDirectionalStudyV1(observations);

  assert.equal(result.status, "EVALUATED");
  if (result.status !== "EVALUATED") return;
  assert.ok(result.long.medianMfeBps < result.long.medianMaeBps);
  assert.equal(result.outcome, "NO_DIRECTIONAL_EVIDENCE");
});

test("reports secondary, funding, YES, and measurement fields without putting them in the primary gate", () => {
  const observations = Array.from({ length: 10 }, (_, index) => ({
    ...observation(index, index < 7 ? 101 : 99),
    fundingSettlements: [{
      settledAt: t0(index) + 2 * 60 * 60_000,
      markPrice: 101,
      rate: 0.0001
    }],
    measurement: {
      mark: point(t0(index) + 24 * 60 * 60_000, 110),
      yes: point(t0(index) + 24 * 60 * 60_000, 0.7)
    }
  }));
  const result = evaluateDirectionalStudyV1(observations);

  assert.equal(result.status, "EVALUATED");
  assert.equal(result.outcome, "DIRECTIONAL_LONG_SUPPORTED");
  assert.equal(result.samples[0].longFundingReturnBps, -1.01);
  assert.equal(result.samples[0].yesChange1h, 0.05);
  assert.equal(result.samples[0].yesChange4h, 0.1);
  assert.equal(result.samples[0].measurementReturnBps, 1_000);
  assert.equal(result.samples[0].measurementYesChange, 0.3);
});

test("rejects post-boundary data, duplicate Candidates, and optional stopping past ten", () => {
  const futureRead = {
    ...observation(0, 101),
    mark4h: {
      ...observation(0, 101).mark4h,
      observedAt: t0(0) + DIRECTIONAL_STUDY_PRIMARY_HORIZON_MS + 1
    }
  };
  assert.throws(() => evaluateDirectionalStudyV1([futureRead]), /future observation/);

  const duplicate = observation(0, 101);
  assert.throws(() => evaluateDirectionalStudyV1([duplicate, duplicate]), /duplicate candidateId/);
  assert.throws(
    () => evaluateDirectionalStudyV1(Array.from({ length: 11 }, (_, index) => observation(index, 101))),
    /cohort is already closed/
  );
});

function observation(
  index: number,
  mark4h: number,
  pathBias: "LONG" | "SHORT" = "LONG"
): DirectionalStudyObservation {
  const candidateT0 = t0(index);
  return {
    protocolVersion: DIRECTIONAL_STUDY_PROTOCOL_VERSION,
    qualification: DIRECTIONAL_STUDY_QUALIFICATION,
    candidateId: `candidate-${index}`,
    candidateT0,
    perpSymbol: "TESTUSDT",
    t0Mark: point(candidateT0, 100),
    mark1h: point(candidateT0 + DIRECTIONAL_STUDY_SECONDARY_HORIZON_MS, 100.5),
    mark4h: point(candidateT0 + DIRECTIONAL_STUDY_PRIMARY_HORIZON_MS, mark4h),
    highMark4h: Math.max(pathBias === "LONG" ? 106 : 101, mark4h),
    lowMark4h: Math.min(pathBias === "LONG" ? 99 : 94, mark4h),
    yesT0: point(candidateT0, 0.4),
    yes1h: point(candidateT0 + DIRECTIONAL_STUDY_SECONDARY_HORIZON_MS, 0.45),
    yes4h: point(candidateT0 + DIRECTIONAL_STUDY_PRIMARY_HORIZON_MS, 0.5),
    fundingSettlements: []
  };
}

function point(asOf: number, value: number) {
  return { asOf, observedAt: asOf, value };
}

function t0(index: number): number {
  return 1_000_000 + index * 24 * 60 * 60_000;
}
