import assert from "node:assert/strict";
import test from "node:test";

import {
  PERP_EXECUTION_VALIDATION_PROTOCOL_VERSION,
  runPaperPerpExecutionValidation
} from "../src/perp-execution-validation.ts";

test("validates the deterministic perp execution lifecycle without an alpha strategy", async () => {
  const report = await runPaperPerpExecutionValidation();

  assert.equal(report.protocolVersion, PERP_EXECUTION_VALIDATION_PROTOCOL_VERSION);
  assert.equal(report.mode, "DETERMINISTIC_PAPER");
  assert.equal(report.overall, "PASS");
  assert.deepEqual(
    Object.values(report.checks).map((check) => check.status),
    ["PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]
  );

  assert.deepEqual(report.checks.orderLifecycle, {
    status: "PASS",
    submissions: 2,
    acknowledgements: 2,
    fills: 4,
    partialFillOrders: 2
  });
  assert.equal(report.checks.positionRoundTrip.afterOpen.side, "LONG");
  assert.equal(report.checks.positionRoundTrip.afterClose.side, "FLAT");
  assert.equal(report.checks.pnl.expectedRealizedPnl, 9.69);
  assert.equal(report.checks.pnl.actualRealizedPnl, 9.69);
  assert.equal(report.checks.funding.afterRealizedPnl, -0.2);
  assert.equal(report.checks.funding.duplicateWasIdempotent, true);
  assert.equal(report.checks.marginPreflight.submissions, 0);
  assert.equal(report.checks.marginPreflight.equity, 1);
  assert.equal(report.checks.marginPreflight.requiredInitialMargin, 50);
  assert.equal(report.checks.liquidationBoundary.safeSnapshot.liquidatable, false);
  assert.equal(report.checks.liquidationBoundary.finalPosition.side, "FLAT");
});
