import { round } from "./math.ts";
import type { PerpSignalSource } from "./strategy.ts";
import type { Signal, Tick } from "./types.ts";
import type { TradeCandidate } from "./overlay/types.ts";

export const PERP_EXPRESSION_PROTOCOL_VERSION = "1.0.0" as const;

type PolicyCommon = {
  readonly protocolVersion: typeof PERP_EXPRESSION_PROTOCOL_VERSION;
  readonly policyId: string;
  readonly sourceMarketId: string;
  readonly underlyingSpotSymbol: string;
  readonly perpSymbol: string;
  /** Must be no later than Candidate T0, otherwise the mapping is post-hoc. */
  readonly frozenAt: number;
  readonly validUntil: number;
  readonly rationale: string;
};

export type FrozenPerpExpressionPolicy =
  | (PolicyCommon & {
      readonly mode: "SIGNAL_ONLY";
    })
  | (PolicyCommon & {
      readonly mode: "DIRECTIONAL_PROXY" | "HEDGE";
      /** Direction is explicit because BUY_YES does not imply a perp side. */
      readonly targetSide: "LONG" | "SHORT";
      readonly maxRiskQuote: number;
      readonly maxLeverage: number;
      readonly stopDistanceBps: number;
      readonly intentTtlMs: number;
    });

export type PerpSizingContext = {
  readonly referencePrice: number;
  readonly accountEquity: number;
  readonly qtyStep: number;
  readonly minQty: number;
  readonly minNotional: number;
  readonly maxAbsQty: number;
};

export type PerpIntent = {
  readonly protocolVersion: typeof PERP_EXPRESSION_PROTOCOL_VERSION;
  readonly intentId: string;
  readonly sourceCandidateId: string;
  readonly sourceMarketId: string;
  readonly expressionPolicyId: string;
  readonly expressionMode: "DIRECTIONAL_PROXY" | "HEDGE";
  readonly symbol: string;
  readonly targetSide: "LONG" | "SHORT";
  readonly targetQty: number;
  readonly referencePrice: number;
  readonly stopPrice: number;
  readonly maxRiskQuote: number;
  readonly expectedLossAtStop: number;
  readonly maxLeverage: number;
  readonly plannedLeverage: number;
  readonly activeFrom: number;
  readonly expiresAt: number;
  readonly rationale: string;
};

export type PerpExpressionResult =
  | {
      readonly status: "NO_INTENT";
      readonly reasonCode: "SIGNAL_ONLY_POLICY";
      readonly reason: string;
    }
  | {
      readonly status: "BLOCKED";
      readonly reasonCode:
        | "INVALID_POLICY"
        | "POLICY_NOT_FROZEN_AT_T0"
        | "POLICY_EXPIRED"
        | "MARKET_MISMATCH"
        | "UNDERLYING_MISMATCH"
        | "INVALID_SIZING_CONTEXT"
        | "BELOW_VENUE_MINIMUM";
      readonly reason: string;
    }
  | {
      readonly status: "INTENT";
      readonly intent: PerpIntent;
    };

export function expressCandidateAsPerp(
  candidate: TradeCandidate,
  policy: FrozenPerpExpressionPolicy,
  sizing: PerpSizingContext
): PerpExpressionResult {
  const policyError = validatePolicy(policy);
  if (policyError !== null) return blocked("INVALID_POLICY", policyError);
  if (policy.frozenAt > candidate.t0) {
    return blocked("POLICY_NOT_FROZEN_AT_T0", "expression policy was frozen after Candidate T0");
  }
  if (candidate.t0 > policy.validUntil) {
    return blocked("POLICY_EXPIRED", "expression policy expired before Candidate T0");
  }
  if (candidate.snapshot.prediction.marketId !== policy.sourceMarketId) {
    return blocked("MARKET_MISMATCH", "Candidate prediction market does not match expression policy");
  }
  if (candidate.snapshot.meme.symbol !== policy.underlyingSpotSymbol) {
    return blocked("UNDERLYING_MISMATCH", "Candidate underlying does not match expression policy");
  }
  if (policy.mode === "SIGNAL_ONLY") {
    return {
      status: "NO_INTENT",
      reasonCode: "SIGNAL_ONLY_POLICY",
      reason: "frozen policy permits research signaling but no perpetual exposure"
    };
  }
  const sizingError = validateSizing(sizing);
  if (sizingError !== null) return blocked("INVALID_SIZING_CONTEXT", sizingError);

  const stopFraction = policy.stopDistanceBps / 10_000;
  const riskLimitedQty = policy.maxRiskQuote / (sizing.referencePrice * stopFraction);
  const leverageLimitedQty = sizing.accountEquity * policy.maxLeverage / sizing.referencePrice;
  const rawTargetQty = Math.min(riskLimitedQty, leverageLimitedQty, sizing.maxAbsQty);
  const targetQty = floorToStep(rawTargetQty, sizing.qtyStep);
  if (targetQty < sizing.minQty || targetQty * sizing.referencePrice < sizing.minNotional) {
    return blocked("BELOW_VENUE_MINIMUM", "risk-bounded quantity is below venue minimums");
  }

  const stopPrice = policy.targetSide === "LONG"
    ? sizing.referencePrice * (1 - stopFraction)
    : sizing.referencePrice * (1 + stopFraction);
  const expectedLossAtStop = targetQty * Math.abs(sizing.referencePrice - stopPrice);
  const plannedLeverage = targetQty * sizing.referencePrice / sizing.accountEquity;
  return {
    status: "INTENT",
    intent: {
      protocolVersion: PERP_EXPRESSION_PROTOCOL_VERSION,
      intentId: `${policy.policyId}:${candidate.candidateId}`,
      sourceCandidateId: candidate.candidateId,
      sourceMarketId: candidate.snapshot.prediction.marketId,
      expressionPolicyId: policy.policyId,
      expressionMode: policy.mode,
      symbol: policy.perpSymbol,
      targetSide: policy.targetSide,
      targetQty,
      referencePrice: sizing.referencePrice,
      stopPrice: round(stopPrice),
      maxRiskQuote: policy.maxRiskQuote,
      expectedLossAtStop: round(expectedLossAtStop),
      maxLeverage: policy.maxLeverage,
      plannedLeverage: round(plannedLeverage),
      activeFrom: candidate.t0,
      expiresAt: Math.min(candidate.t0 + policy.intentTtlMs, policy.validUntil),
      rationale: policy.rationale
    }
  };
}

/** Converts an already-authorized PerpIntent into target-position signals only. */
export class PerpIntentSignalSource implements PerpSignalSource {
  private readonly intent: PerpIntent;
  private terminatedReason: string | null = null;

  constructor(intent: PerpIntent) {
    this.intent = structuredClone(intent);
  }

  onTick(tick: Tick): Signal {
    if (tick.symbol !== this.intent.symbol) {
      return hold(`intent symbol ${this.intent.symbol} does not match tick ${tick.symbol}`);
    }
    if (this.terminatedReason !== null) return targetFlat(this.terminatedReason);
    if (tick.ts < this.intent.activeFrom) return hold("perp intent is not active yet");
    if (tick.ts > this.intent.expiresAt) {
      this.terminatedReason = "perp intent expired";
      return targetFlat(this.terminatedReason);
    }
    const stopTriggered = this.intent.targetSide === "LONG"
      ? tick.markPrice <= this.intent.stopPrice
      : tick.markPrice >= this.intent.stopPrice;
    if (stopTriggered) {
      this.terminatedReason = "perp intent stop boundary reached";
      return targetFlat(this.terminatedReason);
    }
    return {
      action: this.intent.targetSide,
      targetQty: this.intent.targetQty,
      shortMa: null,
      longMa: null,
      reason: `perp intent ${this.intent.intentId}`
    };
  }
}

function validatePolicy(policy: FrozenPerpExpressionPolicy): string | null {
  if (policy.protocolVersion !== PERP_EXPRESSION_PROTOCOL_VERSION) return "unsupported expression protocol";
  if (!policy.policyId || !policy.sourceMarketId || !policy.underlyingSpotSymbol || !policy.perpSymbol) {
    return "expression policy identities are required";
  }
  if (!policy.rationale.trim()) return "expression policy rationale is required";
  if (!Number.isFinite(policy.frozenAt) || !Number.isFinite(policy.validUntil) || policy.validUntil < policy.frozenAt) {
    return "expression policy time bounds are invalid";
  }
  if (policy.mode === "SIGNAL_ONLY") return null;
  if (!positive(policy.maxRiskQuote)) return "maxRiskQuote must be positive";
  if (!positive(policy.maxLeverage)) return "maxLeverage must be positive";
  if (!positive(policy.stopDistanceBps) || policy.stopDistanceBps >= 10_000) {
    return "stopDistanceBps must be in (0, 10000)";
  }
  if (!positive(policy.intentTtlMs)) return "intentTtlMs must be positive";
  return null;
}

function validateSizing(sizing: PerpSizingContext): string | null {
  if (!positive(sizing.referencePrice)) return "referencePrice must be positive";
  if (!positive(sizing.accountEquity)) return "accountEquity must be positive";
  if (!positive(sizing.qtyStep)) return "qtyStep must be positive";
  if (!positive(sizing.minQty)) return "minQty must be positive";
  if (!positive(sizing.minNotional)) return "minNotional must be positive";
  if (!positive(sizing.maxAbsQty)) return "maxAbsQty must be positive";
  return null;
}

function floorToStep(value: number, step: number): number {
  return round(Math.floor((value + Number.EPSILON) / step) * step);
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function blocked(reasonCode: Extract<PerpExpressionResult, { status: "BLOCKED" }>["reasonCode"], reason: string): PerpExpressionResult {
  return { status: "BLOCKED", reasonCode, reason };
}

function hold(reason: string): Signal {
  return { action: "HOLD", shortMa: null, longMa: null, reason };
}

function targetFlat(reason: string): Signal {
  return { action: "FLAT", shortMa: null, longMa: null, reason };
}
