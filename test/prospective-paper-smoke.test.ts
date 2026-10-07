import assert from "node:assert/strict";
import test from "node:test";

import {
  executeProspectivePaperRoundTrip,
  selectFirstNewCandidate,
  type ProspectivePaperCandidate
} from "../src/overlay/prospective-paper-smoke.ts";

test("a new prospective Candidate drives one BUY_YES paper round trip and stops FLAT", async () => {
  const candidate = prospectiveCandidate("NEW", 2_000);
  const report = await executeProspectivePaperRoundTrip(candidate, 10);

  assert.equal(report.status, "ROUND_TRIP_COMPLETE");
  assert.equal(report.signalOrigin, "PRICE_TARGET_V1_QUALIFIED_PROSPECTIVE_CANDIDATE");
  assert.equal(report.closePolicy, "DETERMINISTIC_ENTRY_PRICE_LOOPBACK");
  assert.equal(report.alphaClaim, false);
  assert.equal(report.events.filter((event) => event.type === "ORDER_ACK").length, 2);
  assert.deepEqual(
    report.events.filter((event) => event.type === "FILL").map((event) => event.type === "FILL" && event.fill.side),
    ["BUY", "SELL"]
  );
  assert.ok(report.openedPosition.shares > 0);
  assert.equal(report.finalPosition.shares, 0);
  assert.equal(report.finalPosition.premiumAtRisk, 0);
  assert.equal(report.finalPosition.realizedPnl, 0);
});

test("the smoke boundary ignores all Candidates at or before arming", () => {
  const selected = selectFirstNewCandidate([
    prospectiveCandidate("OLD", 1_000),
    prospectiveCandidate("EQUAL", 1_500),
    prospectiveCandidate("LATER", 2_500),
    prospectiveCandidate("FIRST", 2_000)
  ], 1_500);

  assert.equal(selected?.candidateId, "FIRST");
  assert.equal(selectFirstNewCandidate([prospectiveCandidate("OLD", 1_000)], 1_500), null);
});

function prospectiveCandidate(candidateId: string, candidateT0: number): ProspectivePaperCandidate {
  return {
    manifestId: `MANIFEST-${candidateId}`,
    candidateId,
    candidateT0,
    asset: "BTC",
    marketId: "POLYMARKET-YES-1",
    entryBestAsk: 0.4,
    entryBestAskSize: 100,
    yesBookObservedAt: candidateT0 - 1
  };
}
