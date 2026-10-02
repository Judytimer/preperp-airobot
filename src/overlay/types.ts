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
  readonly seq: number;
  readonly ts: number;
  readonly meme: {
    readonly symbol: string;
    readonly spotPrice: number;
    readonly fdv: number;
  };
  readonly prediction: {
    readonly marketId: string;
    readonly question: string;
    readonly targetFdv: number;
    readonly yesPrice: number;
    /** Source observation time when provenance is available. */
    readonly yesPriceObservedAt?: number;
  };
};

export interface ResearchContext {
  next(): ResearchSnapshot | null;
}

export type TradeCandidate = {
  readonly candidateId: string;
  readonly t0: number;
  readonly snapshot: ResearchSnapshot;
  readonly signal: Readonly<OverlaySignal & { action: "BUY_YES" }>;
};

export type ResearchSource = "NEWS" | "X" | "REDDIT" | "PREDICTION_MARKET";

export type ResearchPlan = {
  readonly candidateId: string;
  readonly sources: readonly ResearchSource[];
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly validEvidence: string;
};

export type Evidence = ReplayEvidence;

export interface ResearchRouter {
  route(candidate: TradeCandidate): ResearchPlan;
}

export interface EvidenceSearch {
  search(candidate: TradeCandidate, plan: ResearchPlan): Promise<readonly Evidence[]>;
}

export type ReviewAssessment = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export type ShadowResult = ShadowReviewRecord & {
  catalystSupport: ReviewAssessment;
  entryQuality: ReviewAssessment;
  mispricingConfidence: ReviewAssessment;
  resolutionRisk: ReviewAssessment;
  dataQuality: ReviewAssessment;
};

export interface LlmStrategyReviewer {
  review(
    candidate: TradeCandidate,
    plan: ResearchPlan,
    evidence: readonly Evidence[]
  ): Promise<ShadowResult>;
}

export type ShadowErrorCode =
  | "SEARCH_UNAVAILABLE"
  | "SEARCH_FAILED"
  | "REVIEWER_UNAVAILABLE"
  | "REVIEWER_FAILED"
  | "INVALID_PROVIDER_RESPONSE"
  | "INTERNAL_SHADOW_ERROR";

export type ShadowRecord =
  | {
      readonly candidateId: string;
      readonly status: "COMPLETED";
      readonly completedAt: number;
      readonly shadowVerdict: ShadowVerdict;
      readonly result: ShadowResult;
    }
  | {
      readonly candidateId: string;
      readonly status: "PROVIDER_UNAVAILABLE" | "PROVIDER_FAILED";
      readonly completedAt: number;
      readonly errorCode: ShadowErrorCode;
    }
  | {
      readonly candidateId: string;
      readonly status: "INCOMPLETE" | "SKIPPED_CAPACITY";
      readonly completedAt: number;
    };

export type ShadowStartResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly status: "SKIPPED_CAPACITY" };

export interface ShadowRunner {
  start(candidate: TradeCandidate): ShadowStartResult;
  /** Lifecycle control for tests and graceful shutdown only; never call from execution. */
  drain(timeoutMs: number): Promise<void>;
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

/** Observable boundary between a research price and a paper fill. */
export type OverlayPaperExecutionRecord = {
  readonly clientOrderId: string;
  readonly side: "BUY" | "SELL";
  readonly referencePrice: number;
  readonly fillPrice: number;
  readonly slippageBps: number;
  readonly fee: number;
  readonly signalAt: number;
  readonly submitAt: number;
  readonly fillAt: number;
};
