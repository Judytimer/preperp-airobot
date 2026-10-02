import assert from "node:assert/strict";
import test from "node:test";

import { MemePredictionOverlayBot } from "../src/overlay/bot.ts";
import {
  DeterministicResearchRouter,
  DeterministicStrategyReviewer
} from "../src/overlay/research.ts";
import { BoundedShadowRunner } from "../src/overlay/shadow-runner.ts";
import type {
  Evidence,
  EvidenceSearch,
  ResearchSnapshot,
  ShadowRecord,
  ShadowResult,
  TradeCandidate
} from "../src/overlay/types.ts";

test("runs meme research -> YES signal -> risk -> ACK -> pending -> fill -> exit", async () => {
  const logs: string[] = [];
  const bot = new MemePredictionOverlayBot({
    spotRiseTriggerPct: 0.5,
    exitYesPrice: 0.7,
    maxRiskBudget: 100,
    fillDelayMs: 15,
    logger: (line) => logs.push(line)
  });

  await bot.onSnapshot(snapshot(1, 100, 1_000, 2_000, 0.3));
  await bot.onSnapshot(snapshot(2, 160, 1_600, 2_000, 0.35));
  await bot.onSnapshot(snapshot(3, 165, 1_650, 2_000, 0.36));
  await bot.waitForIdle();

  assert.ok(bot.getPosition().shares > 0);
  assert.ok(bot.getPosition().premiumAtRisk <= 100);

  await bot.onSnapshot(snapshot(4, 170, 1_700, 2_000, 0.75));
  await bot.onSnapshot(snapshot(5, 172, 1_720, 2_000, 0.76));
  await bot.waitForIdle();

  const ackLines = logs.filter((line) => line.startsWith("[OVERLAY_ACK]"));
  assert.equal(ackLines.length, 2);
  assert.match(ackLines[0], /side=BUY/);
  assert.match(ackLines[1], /side=SELL/);
  assert.match(logs.join("\n"), /\[OVERLAY_PENDING\]/);
  assert.match(logs.join("\n"), /\[OVERLAY_FILL\]/);
  assert.equal(bot.getPosition().shares, 0);
  assert.equal(bot.getPosition().premiumAtRisk, 0);
  assert.ok(bot.getPosition().realizedPnl > 0);
});

test("slow Shadow provider does not delay Risk, ACK, or Fill", async () => {
  const logs: string[] = [];
  const records: ShadowRecord[] = [];
  const pendingSearch = deferred<readonly Evidence[]>();
  const runner = shadowRunner(records, { search: () => pendingSearch.promise });
  const bot = overlayBot(logs, runner);

  await enter(bot);
  await bot.waitForIdle();

  assert.equal(records.length, 0);
  assert.equal(bot.getPosition().shares, 285.714285);
  assert.equal(countLogs(logs, "[OVERLAY_RISK] approved"), 1);
  assert.equal(countLogs(logs, "[OVERLAY_ACK]"), 1);
  assert.equal(countLogs(logs, "[OVERLAY_FILL]"), 1);

  pendingSearch.resolve([]);
  await runner.drain(100);
  assert.equal(records[0]?.status, "COMPLETED");
});

test("full Shadow capacity skips without changing BUY, ACK, or Fill", async () => {
  const shadowLogs: string[] = [];
  const controlLogs: string[] = [];
  const records: ShadowRecord[] = [];
  const pendingSearch = deferred<readonly Evidence[]>();
  const runner = shadowRunner(records, { search: () => pendingSearch.promise });
  runner.start(candidate("CAPACITY-1", 1));
  runner.start(candidate("CAPACITY-2", 2));

  const withFullShadow = overlayBot(shadowLogs, runner);
  const withoutShadow = overlayBot(controlLogs);
  await enter(withFullShadow);
  await enter(withoutShadow);
  await Promise.all([withFullShadow.waitForIdle(), withoutShadow.waitForIdle()]);
  await Promise.resolve();

  assert.deepEqual(withFullShadow.getPosition(), withoutShadow.getPosition());
  assert.equal(countLogs(shadowLogs, "[OVERLAY_ACK]"), countLogs(controlLogs, "[OVERLAY_ACK]"));
  assert.equal(countLogs(shadowLogs, "[OVERLAY_FILL]"), countLogs(controlLogs, "[OVERLAY_FILL]"));
  assert.equal(records.find((record) => record.status === "SKIPPED_CAPACITY")?.candidateId, "DOGE-FDV-2B:2");

  pendingSearch.resolve([]);
  await runner.drain(100);
});

test("paper execution records adverse fixed-bps slippage, zero fees, and timestamp chain", async () => {
  const bot = new MemePredictionOverlayBot({
    spotRiseTriggerPct: 0.5,
    exitYesPrice: 0.7,
    maxRiskBudget: 100,
    fillDelayMs: 0,
    slippageBps: 100,
    logger: () => undefined
  });

  await enter(bot);
  await bot.waitForIdle();
  await bot.onSnapshot(snapshot(3, 170, 1_700, 2_000, 0.75));
  await bot.waitForIdle();

  const [entry, exit] = bot.getExecutionRecords();
  assert.equal(entry.referencePrice, 0.35);
  assert.equal(entry.fillPrice, 0.3535);
  assert.equal(exit.referencePrice, 0.75);
  assert.equal(exit.fillPrice, 0.7425);
  assert.equal(entry.slippageBps, 100);
  assert.equal(entry.fee, 0);
  assert.ok(entry.signalAt <= entry.submitAt);
  assert.ok(entry.submitAt <= entry.fillAt);
});

function overlayBot(logs: string[], shadowRunner?: BoundedShadowRunner) {
  return new MemePredictionOverlayBot({
    spotRiseTriggerPct: 0.5,
    exitYesPrice: 0.7,
    maxRiskBudget: 100,
    fillDelayMs: 0,
    logger: (line) => logs.push(line),
    shadowRunner
  });
}

function shadowRunner(records: ShadowRecord[], search: EvidenceSearch): BoundedShadowRunner {
  return new BoundedShadowRunner({
    router: new DeterministicResearchRouter(),
    search,
    reviewer: new DeterministicStrategyReviewer(review()),
    record: (record) => records.push(record),
    maxInFlight: 2
  });
}

async function enter(bot: MemePredictionOverlayBot): Promise<void> {
  await bot.onSnapshot(snapshot(1, 100, 1_000, 2_000, 0.3));
  await bot.onSnapshot(snapshot(2, 160, 1_600, 2_000, 0.35));
}

function countLogs(logs: readonly string[], prefix: string): number {
  return logs.filter((line) => line.startsWith(prefix)).length;
}

function review(): ShadowResult {
  return {
    verdict: "ABSTAIN",
    confidence: 0.7,
    moveValidity: "SUPPORTED",
    moveDecomposition: ["MOMENTUM"],
    sourceAgreement: "AGREE",
    evidenceSourceIds: [],
    reason: "deterministic fixture",
    catalystSupport: "HIGH",
    entryQuality: "MEDIUM",
    mispricingConfidence: "MEDIUM",
    resolutionRisk: "LOW",
    dataQuality: "HIGH"
  };
}

function candidate(candidateId: string, t0: number): TradeCandidate {
  const candidateSnapshot = snapshot(t0, 160, 1_600, 2_000, 0.35);
  return {
    candidateId,
    t0,
    snapshot: candidateSnapshot,
    signal: {
      action: "BUY_YES",
      marketId: candidateSnapshot.prediction.marketId,
      yesPrice: candidateSnapshot.prediction.yesPrice,
      ts: t0,
      reason: "test candidate"
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function snapshot(
  seq: number,
  spotPrice: number,
  fdv: number,
  targetFdv: number,
  yesPrice: number
): ResearchSnapshot {
  return {
    seq,
    ts: seq,
    meme: { symbol: "DOGE", spotPrice, fdv },
    prediction: {
      marketId: "DOGE-FDV-2B",
      question: "Will DOGE exceed $2B FDV?",
      targetFdv,
      yesPrice
    }
  };
}
