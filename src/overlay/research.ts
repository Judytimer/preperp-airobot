import type {
  Evidence,
  EvidenceSearch,
  LlmStrategyReviewer,
  ResearchContext,
  ResearchPlan,
  ResearchRouter,
  ResearchSnapshot,
  ShadowResult,
  TradeCandidate
} from "./types.ts";

export class MockResearchContext implements ResearchContext {
  private index = 0;
  private readonly snapshots: readonly ResearchSnapshot[];

  constructor(snapshots: readonly ResearchSnapshot[]) {
    this.snapshots = snapshots;
  }

  next(): ResearchSnapshot | null {
    const snapshot = this.snapshots[this.index];
    if (snapshot === undefined) {
      return null;
    }

    this.index += 1;
    return snapshot;
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

export class MockEvidenceSearch implements EvidenceSearch {
  private readonly evidence: readonly Evidence[];

  constructor(evidence: readonly Evidence[] = []) {
    this.evidence = evidence;
  }

  async search(_candidate: TradeCandidate, plan: ResearchPlan): Promise<readonly Evidence[]> {
    return this.evidence.filter(
      (item) => item.publishedAt >= plan.windowStart && item.publishedAt <= plan.windowEnd
    );
  }
}

export class DeterministicStrategyReviewer implements LlmStrategyReviewer {
  private readonly result: ShadowResult;

  constructor(result: ShadowResult) {
    this.result = result;
  }

  async review(
    _candidate: TradeCandidate,
    _plan: ResearchPlan,
    _evidence: readonly Evidence[]
  ): Promise<ShadowResult> {
    return structuredClone(this.result);
  }
}
