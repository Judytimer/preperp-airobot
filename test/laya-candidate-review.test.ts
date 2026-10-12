import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runLayaCandidateReviewCycle } from "../src/overlay/laya-candidate-review.ts";
import type { DomainEvent, DomainEventSink } from "../src/observability/domain-event.ts";

test("reviews one qualified Candidate through loopback Laya and freezes read-only evidence", async () => {
  const root = await fixture();
  const events: DomainEvent[] = [];
  const bodies: unknown[] = [];
  let clock = 1_800_000_000_000;
  const result = await runLayaCandidateReviewCycle(root, {
    now: () => (clock += 25),
    eventSink: collectingSink(events),
    fetcher: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(layaResponse()), {
        status: 200,
        headers: { "content-type": "application/json", "x-inference-time-ms": "12.5" }
      });
    }
  });

  assert.equal(result.discoveredQualified, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(bodies.length, 1);
  assert.equal((bodies[0] as { max_len: number }).max_len, 512);
  assert.deepEqual(events.map((event) => event.type), [
    "CANDIDATE_QUALIFIED",
    "LAYA_REVIEW_STARTED",
    "LAYA_REVIEW_COMPLETED"
  ]);
  const evidence = JSON.parse(await readFile(result.latestReviewPath!, "utf8"));
  assert.equal(evidence.mode, "SHADOW_READ_ONLY");
  assert.equal(evidence.result.choice, "consistent");
  assert.equal(evidence.result.inferenceMs, 12.5);
  assert.equal(evidence.result.confidenceSemantics, "SERVICE_REPORTED_NOT_USED_FOR_AUTHORIZATION");
  assert.equal(evidence.authority.canSubmitOrders, false);
  assert.equal(evidence.input.deterministicChecks.upwardCrossing, true);

  const second = await runLayaCandidateReviewCycle(root, {
    fetcher: async () => { throw new Error("idempotent review must not call Laya twice"); }
  });
  assert.equal(second.alreadyReviewed, 1);
  assert.equal(second.completed, 0);
  assert.equal(second.failed, 0);
});

test("Laya failure is observable and does not mutate Candidate evidence", async () => {
  const root = await fixture();
  const events: DomainEvent[] = [];
  const result = await runLayaCandidateReviewCycle(root, {
    eventSink: collectingSink(events),
    fetcher: async () => new Response("offline", { status: 503 })
  });

  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.latestReviewPath, null);
  assert.equal(events.at(-1)?.type, "LAYA_REVIEW_FAILED");
  const state = JSON.parse(await readFile(join(root, "states", "PTV1-BTC-1.json"), "utf8"));
  assert.equal(state.status, "QUALIFIED");
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "laya-shadow-review-"));
  await mkdir(join(root, "manifests"), { recursive: true });
  await mkdir(join(root, "states"), { recursive: true });
  const candidateT0 = 1_799_999_000_000;
  await writeFile(join(root, "manifests", "PTV1-BTC-1.json"), JSON.stringify({
    schemaVersion: "1.0.0",
    protocolVersion: "PRICE_TARGET_ADMISSION_V1_0_0",
    manifestId: "PTV1-BTC-1",
    repositoryCommit: "a".repeat(40),
    cohortKey: "PRICE_TARGET_V1_BTC",
    discoveredAt: candidateT0 - 100_000,
    registeredAt: candidateT0 - 90_000,
    episode: {
      episodeKey: "BTC-1",
      asset: "BTC",
      resolutionVenue: "BINANCE_SPOT",
      resolutionSymbol: "BTCUSDT",
      measurementAt: candidateT0 + 8 * 60 * 60_000,
      cutoffT0: candidateT0 + 4 * 60 * 60_000
    },
    ownerEvent: {},
    registration: {}
  }));
  await writeFile(join(root, "states", "PTV1-BTC-1.json"), JSON.stringify({
    schemaVersion: "1.0.0",
    manifestId: "PTV1-BTC-1",
    status: "QUALIFIED",
    updatedAt: candidateT0,
    candles: [],
    books: [],
    marketStatuses: [],
    artifacts: [],
    candidate: {
      candidateId: "PTV1-BTC-CANDIDATE-1",
      candidateT0,
      crossingPreviousClose: 99,
      crossingClose: 101,
      selectedStrike: 100,
      entryBestAsk: 0.45,
      entryBestAskSize: 20,
      yesBookObservedAt: candidateT0 - 30_000
    },
    reasons: []
  }));
  return root;
}

function collectingSink(events: DomainEvent[]): DomainEventSink {
  return { async publish(event) { events.push(event); } };
}

function layaResponse(): unknown {
  return {
    model: "laya-rl-agent",
    answers: {
      evidence_posture: {
        type: "choice",
        choice: "consistent",
        probabilities: { consistent: 0.72, manual_review: 0.18, insufficient: 0.1 },
        confidence: 0.3,
        answer_confidence: 0.72
      }
    },
    usage: { input_tokens: 120, output_tokens: 0, truncated: false },
    routing: { model: "english" }
  };
}
