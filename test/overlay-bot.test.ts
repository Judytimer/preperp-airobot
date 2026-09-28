import assert from "node:assert/strict";
import test from "node:test";

import { MemePredictionOverlayBot } from "../src/overlay/bot.ts";
import {
  DeterministicResearchRouter,
  DeterministicStrategyReviewer,
  MockResearchContext
} from "../src/overlay/research.ts";
import type {
  ResearchSnapshot,
  ShadowResult,
  ShadowVerdict,
  StrategyReviewer
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
  assert.equal(bot.getShadowResults().length, 1, "deterministic exit must not create a review");
});

for (const verdict of ["PASS", "WOULD_BLOCK", "ABSTAIN"] satisfies ShadowVerdict[]) {
  test(`${verdict} shadow review is recorded without changing the BUY_YES order`, async () => {
    const logs: string[] = [];
    const research = new MockResearchContext([], [
      { sourceId: "MARKET-1", publishedAt: 2, summary: "deterministic market evidence" }
    ]);
    const bot = new MemePredictionOverlayBot({
      spotRiseTriggerPct: 0.5,
      exitYesPrice: 0.7,
      maxRiskBudget: 100,
      fillDelayMs: 0,
      logger: (line) => logs.push(line),
      shadow: {
        router: new DeterministicResearchRouter(),
        context: research,
        reviewer: new DeterministicStrategyReviewer(review(verdict))
      }
    });

    await bot.onSnapshot(snapshot(1, 100, 1_000, 2_000, 0.3));
    await bot.onSnapshot(snapshot(2, 160, 1_600, 2_000, 0.35));
    await bot.waitForIdle();

    const reviews = bot.getShadowResults();
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.candidate.signal.action, "BUY_YES");
    assert.equal(reviews[0]?.result.verdict, verdict);
    assert.equal(bot.getPosition().shares, 285.714285);
    assert.ok(bot.getPosition().premiumAtRisk <= 100);
    assert.equal(logs.filter((line) => line.startsWith("[OVERLAY_ACK]")).length, 1);
    assert.match(logs.join("\n"), new RegExp(`\\[SHADOW_REVIEW\\].*verdict=${verdict}`));
    assert.match(logs.join("\n"), /\[OVERLAY_RISK\] approved side=BUY/);
  });
}

test("reviewer failure records ABSTAIN without changing BUY quantity, ACK, or Fill", async () => {
  const healthyLogs: string[] = [];
  const failureLogs: string[] = [];
  const healthy = shadowBot(healthyLogs, new DeterministicStrategyReviewer(review("PASS")));
  const failing = shadowBot(failureLogs, {
    review() {
      throw new Error("reviewer unavailable");
    }
  });

  for (const bot of [healthy, failing]) {
    await bot.onSnapshot(snapshot(1, 100, 1_000, 2_000, 0.3));
    await bot.onSnapshot(snapshot(2, 160, 1_600, 2_000, 0.35));
    await bot.waitForIdle();
  }

  assert.deepEqual(failing.getPosition(), healthy.getPosition());
  assert.equal(failing.getPosition().shares, 285.714285);
  assert.equal(countLogs(failureLogs, "[OVERLAY_ACK]"), countLogs(healthyLogs, "[OVERLAY_ACK]"));
  assert.equal(countLogs(failureLogs, "[OVERLAY_FILL]"), countLogs(healthyLogs, "[OVERLAY_FILL]"));
  assert.equal(countLogs(failureLogs, "[OVERLAY_ACK]"), 1);
  assert.equal(countLogs(failureLogs, "[OVERLAY_FILL]"), 1);
  assert.equal(failing.getShadowResults()[0]?.result.verdict, "ABSTAIN");
  assert.match(failing.getShadowResults()[0]?.result.reason ?? "", /shadow error: reviewer unavailable/);
  assert.match(failureLogs.join("\n"), /\[OVERLAY_RISK\] approved side=BUY/);
});

function shadowBot(logs: string[], reviewer: StrategyReviewer) {
  return new MemePredictionOverlayBot({
    spotRiseTriggerPct: 0.5,
    exitYesPrice: 0.7,
    maxRiskBudget: 100,
    fillDelayMs: 0,
    logger: (line) => logs.push(line),
    shadow: {
      router: new DeterministicResearchRouter(),
      context: new MockResearchContext([]),
      reviewer
    }
  });
}

function countLogs(logs: readonly string[], prefix: string): number {
  return logs.filter((line) => line.startsWith(prefix)).length;
}

function review(verdict: ShadowVerdict): ShadowResult {
  return {
    verdict,
    confidence: 0.7,
    moveValidity: "SUPPORTED",
    moveDecomposition: ["MOMENTUM"],
    sourceAgreement: "AGREE",
    evidenceSourceIds: ["MARKET-1"],
    reason: `deterministic ${verdict} fixture`,
    catalystSupport: "HIGH",
    entryQuality: "MEDIUM",
    mispricingConfidence: "MEDIUM",
    resolutionRisk: "LOW",
    dataQuality: "HIGH"
  };
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
