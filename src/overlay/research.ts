import type {
  Evidence,
  ResearchContext,
  ResearchPlan,
  ResearchRouter,
  ResearchSnapshot,
  ShadowResult,
  StrategyReviewer,
  TradeCandidate
} from "./types.ts";

export class MockResearchContext implements ResearchContext {
  private index = 0;
  private readonly snapshots: readonly ResearchSnapshot[];
  private readonly evidence: readonly Evidence[];

  constructor(snapshots: readonly ResearchSnapshot[], evidence: readonly Evidence[] = []) {
    this.snapshots = snapshots;
    this.evidence = evidence;
  }

  next(): ResearchSnapshot | null {
    const snapshot = this.snapshots[this.index];
    if (snapshot === undefined) {
      return null;
    }

    this.index += 1;
    return snapshot;
  }

  research(plan: ResearchPlan): readonly Evidence[] {
    return this.evidence.filter(
      (item) => item.publishedAt >= plan.windowStart && item.publishedAt <= plan.windowEnd
    );
  }
}

export class DeterministicResearchRouter implements ResearchRouter {
  private readonly lookbackMs: number;

  constructor(lookbackMs = 24 * 60 * 60_000) {
    this.lookbackMs = lookbackMs;
  }

  route(candidate: TradeCandidate): ResearchPlan {
    return {
      candidateId: candidate.candidateId,
      sources: ["NEWS", "X", "REDDIT", "PREDICTION_MARKET"],
      windowStart: candidate.t0 - this.lookbackMs,
      windowEnd: candidate.t0,
      validEvidence: "published by candidate T0 and attributable to a named source"
    };
  }
}

export class DeterministicStrategyReviewer implements StrategyReviewer {
  private readonly result: ShadowResult;

  constructor(result: ShadowResult) {
    this.result = result;
  }

  review(
    _candidate: TradeCandidate,
    _plan: ResearchPlan,
    _evidence: readonly Evidence[]
  ): ShadowResult {
    return structuredClone(this.result);
  }
}
