import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recordProspectiveOutcome } from "../src/overlay/prospective-outcome.ts";

test("records a Polymarket resolution after the frozen time without rewriting T0", async () => {
  const fixture = await createFixture("YES");
  const reportBefore = await readFile(fixture.reportPath, "utf8");
  const first = await recordProspectiveOutcome(
    fixture.reportPath,
    fixture.artifactPath,
    fixture.outcomePath,
    { now: () => 1_300 }
  );
  assert.equal(first.outcome.status, "MEASURED");
  assert.equal(first.outcome.result, "YES");
  assert.equal(first.outcome.resolution.winningTokenId, "YES-1");
  assert.equal(first.reused, false);
  assert.equal(await readFile(fixture.reportPath, "utf8"), reportBefore);

  const outcomeBefore = await readFile(fixture.outcomePath, "utf8");
  const second = await recordProspectiveOutcome(
    fixture.reportPath,
    fixture.artifactPath,
    fixture.outcomePath,
    { now: () => 2_000 }
  );
  assert.equal(second.reused, true);
  assert.equal(await readFile(fixture.outcomePath, "utf8"), outcomeBefore);
});

test("rejects early, forged, and conflicting attempts to replace a frozen outcome", async () => {
  const early = await createFixture("YES");
  await assert.rejects(
    recordProspectiveOutcome(early.reportPath, early.artifactPath, early.outcomePath, { now: () => 999 }),
    /before the frozen measurement time/
  );

  const checksum = await createFixture("YES");
  const checksumArtifact = JSON.parse(await readFile(checksum.artifactPath, "utf8"));
  checksumArtifact.sha256 = "0".repeat(64);
  await writeFile(checksum.artifactPath, JSON.stringify(checksumArtifact), "utf8");
  await assert.rejects(
    recordProspectiveOutcome(checksum.reportPath, checksum.artifactPath, checksum.outcomePath, { now: () => 1_300 }),
    /checksum mismatch/
  );

  const immutable = await createFixture("YES");
  await recordProspectiveOutcome(
    immutable.reportPath,
    immutable.artifactPath,
    immutable.outcomePath,
    { now: () => 1_300 }
  );
  const noRaw = resolutionRaw("NO");
  await writeFile(immutable.rawPath, noRaw, "utf8");
  const changedArtifact = JSON.parse(await readFile(immutable.artifactPath, "utf8"));
  changedArtifact.sha256 = digest(noRaw);
  await writeFile(immutable.artifactPath, JSON.stringify(changedArtifact), "utf8");
  await assert.rejects(
    recordProspectiveOutcome(
      immutable.reportPath,
      immutable.artifactPath,
      immutable.outcomePath,
      { now: () => 1_400 }
    ),
    /different immutable input/
  );
});

async function createFixture(result: "YES" | "NO") {
  const directory = await mkdtemp(join(tmpdir(), "prospective-outcome-"));
  const reportPath = join(directory, "report.json");
  const artifactPath = join(directory, "resolution-artifact.json");
  const rawPath = join(directory, "resolution.raw.json");
  const outcomePath = join(directory, "report.outcome.json");
  const raw = resolutionRaw(result);
  await writeFile(rawPath, raw, "utf8");
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: "2.1.0",
    mode: "PROSPECTIVE_PAPER_SAMPLING",
    status: "OBSERVED",
    manifestId: "MANIFEST-1",
    observationId: "OBSERVATION-1",
    inputDigest: "a".repeat(64),
    market: { marketId: "MARKET-1", yesTokenId: "YES-1" },
    formal: { status: "NO_CANDIDATE" },
    outcome: {
      measurementAt: 1_000,
      rule: "Use the frozen Polymarket market resolution.",
      rulesUrl: "https://polymarket.com/event/test",
      status: "FROZEN_TIME_REACHED_AWAITING_OUTCOME"
    }
  }), "utf8");
  await writeFile(artifactPath, JSON.stringify({
    schemaVersion: "2.1.0",
    provider: "POLYMARKET_MARKET_RESOLVED",
    sourceUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    sourceTimestamp: 1_100,
    retrievedAt: 1_200,
    rawResponsePath: "resolution.raw.json",
    sha256: digest(raw)
  }), "utf8");
  return { reportPath, artifactPath, rawPath, outcomePath };
}

function resolutionRaw(result: "YES" | "NO"): string {
  return JSON.stringify([{
    topic: "market",
    type: "market_resolved",
    payload: {
      id: "MARKET-1",
      market: "CONDITION-1",
      tokenIds: ["YES-1", "NO-1"],
      winningTokenId: result === "YES" ? "YES-1" : "NO-1",
      winningOutcome: result === "YES" ? "Yes" : "No",
      timestamp: "1100"
    }
  }]);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
