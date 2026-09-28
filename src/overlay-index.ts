import { setTimeout as sleep } from "node:timers/promises";

import { MemePredictionOverlayBot } from "./overlay/bot.ts";
import {
  DeterministicResearchRouter,
  DeterministicStrategyReviewer,
  MockResearchContext
} from "./overlay/research.ts";
import type { ResearchSnapshot } from "./overlay/types.ts";

const snapshots: ResearchSnapshot[] = [
  snapshot(1, 0.1, 1_000_000_000, 2_000_000_000, 0.3),
  snapshot(2, 0.14, 1_400_000_000, 2_000_000_000, 0.32),
  snapshot(3, 0.155, 1_550_000_000, 2_000_000_000, 0.35),
  snapshot(4, 0.16, 1_600_000_000, 2_000_000_000, 0.36),
  snapshot(5, 0.17, 1_700_000_000, 2_000_000_000, 0.72),
  snapshot(6, 0.172, 1_720_000_000, 2_000_000_000, 0.75)
];

const research = new MockResearchContext(snapshots);
const bot = new MemePredictionOverlayBot({
  spotRiseTriggerPct: 0.5,
  exitYesPrice: 0.7,
  maxRiskBudget: 100,
  fillDelayMs: 120,
  shadow: {
    router: new DeterministicResearchRouter(),
    context: research,
    reviewer: new DeterministicStrategyReviewer({
      verdict: "ABSTAIN",
      confidence: 0.4,
      moveValidity: "INSUFFICIENT_SOURCE",
      moveDecomposition: ["MOMENTUM", "UNKNOWN"],
      sourceAgreement: "INSUFFICIENT",
      evidenceSourceIds: [],
      reason: "deterministic demo has no external evidence",
      catalystSupport: "UNKNOWN",
      entryQuality: "MEDIUM",
      mispricingConfidence: "LOW",
      resolutionRisk: "UNKNOWN",
      dataQuality: "LOW"
    })
  }
});

for (let index = 0; index < 4; index++) {
  await processNextSnapshot();
}
await bot.waitForIdle();

while (await processNextSnapshot()) {
  // Consume the remaining mock research snapshots.
}
await bot.waitForIdle();

console.log("[OVERLAY_DONE]", bot.getPosition());

async function processNextSnapshot(): Promise<boolean> {
  const next = research.next();
  if (next === null) {
    return false;
  }

  await bot.onSnapshot(next);
  await sleep(35);
  return true;
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
