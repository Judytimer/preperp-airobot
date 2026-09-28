import type { OrderRequest } from "../types.ts";
import type {
  MoveDriver,
  MoveValidity,
  ReplayEvidence,
  ShadowReviewRecord,
  ShadowVerdict
} from "../historical-replay.ts";

export type { MoveDriver, MoveValidity, ShadowVerdict };

export type ResearchSnapshot = {
  seq: number;
  ts: number;
  meme: {
    symbol: string;
    spotPrice: number;
    fdv: number;
  };
  prediction: {
    marketId: string;
    question: string;
    targetFdv: number;
    yesPrice: number;
  };
};

export interface ResearchContext {
  next(): ResearchSnapshot | null;
  research(plan: ResearchPlan): readonly Evidence[];
}

export type TradeCandidate = {
  candidateId: string;
  t0: number;
  snapshot: ResearchSnapshot;
  signal: OverlaySignal & { action: "BUY_YES" };
};

export type ResearchSource = "NEWS" | "X" | "REDDIT" | "PREDICTION_MARKET";

export type ResearchPlan = {
  candidateId: string;
  sources: readonly ResearchSource[];
  windowStart: number;
  windowEnd: number;
  validEvidence: string;
};

export type Evidence = ReplayEvidence;

export interface ResearchRouter {
  route(candidate: TradeCandidate): ResearchPlan;
}

export type ReviewAssessment = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export type ShadowResult = ShadowReviewRecord & {
  catalystSupport: ReviewAssessment;
  entryQuality: ReviewAssessment;
  mispricingConfidence: ReviewAssessment;
  resolutionRisk: ReviewAssessment;
  dataQuality: ReviewAssessment;
};

export interface StrategyReviewer {
  review(
    candidate: TradeCandidate,
    plan: ResearchPlan,
    evidence: readonly Evidence[]
  ): ShadowResult;
}

export type OverlayAction = "HOLD" | "BUY_YES" | "SELL_YES";

export type OverlaySignal = {
  action: OverlayAction;
  marketId: string;
  yesPrice: number;
  ts: number;
  reason: string;
};

export type OverlayRiskDecision =
  | { approved: false; reason: string }
  | { approved: true; order: OrderRequest };

export type PredictionPosition = {
  marketId: string;
  shares: number;
  averageEntryPrice: number;
  premiumAtRisk: number;
  realizedPnl: number;
};
