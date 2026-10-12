import { round } from "./math.ts";

export const DIRECTIONAL_STUDY_PROTOCOL_VERSION = "1.1.0" as const;
export const DIRECTIONAL_STUDY_QUALIFICATION =
  "STRATEGY_LAB_V2_1_1_QUALIFIED_PROSPECTIVE_CANDIDATE" as const;
export const DIRECTIONAL_STUDY_SECONDARY_HORIZON_MS = 60 * 60_000;
export const DIRECTIONAL_STUDY_PRIMARY_HORIZON_MS = 4 * 60 * 60_000;
export const DIRECTIONAL_STUDY_PROVISIONAL_SAMPLE_SIZE = 3;
export const DIRECTIONAL_STUDY_PRIMARY_SAMPLE_SIZE = 10;
export const DIRECTIONAL_STUDY_PROVISIONAL_MIN_HIT_RATE = 2 / 3;
export const DIRECTIONAL_STUDY_MIN_HIT_RATE = 0.7;

export const DIRECTIONAL_STUDY_V1 = Object.freeze({
  protocolVersion: DIRECTIONAL_STUDY_PROTOCOL_VERSION,
  primaryHorizonMs: DIRECTIONAL_STUDY_PRIMARY_HORIZON_MS,
  secondaryHorizonMs: DIRECTIONAL_STUDY_SECONDARY_HORIZON_MS,
  provisionalSampleSize: DIRECTIONAL_STUDY_PROVISIONAL_SAMPLE_SIZE,
  provisionalMinimumHitRate: DIRECTIONAL_STUDY_PROVISIONAL_MIN_HIT_RATE,
  primarySampleSize: DIRECTIONAL_STUDY_PRIMARY_SAMPLE_SIZE,
  minimumPrimaryHitRate: DIRECTIONAL_STUDY_MIN_HIT_RATE,
  primaryGateUsesFunding: false,
  primaryGateUsesYesChange: false,
  primaryGateUsesMeasurementAt: false
});

export type StudyPricePoint = {
  /** Frozen evaluation boundary, not necessarily the source event timestamp. */
  readonly asOf: number;
  /** Timestamp of the latest archived observation at or before asOf. */
  readonly observedAt: number;
  readonly value: number;
};

export type FundingSettlementObservation = {
  readonly settledAt: number;
  readonly markPrice: number;
  readonly rate: number;
};

export type DirectionalStudyObservation = {
  readonly protocolVersion: typeof DIRECTIONAL_STUDY_PROTOCOL_VERSION;
  readonly qualification: typeof DIRECTIONAL_STUDY_QUALIFICATION;
  readonly candidateId: string;
  readonly candidateT0: number;
  readonly perpSymbol: string;
  readonly t0Mark: StudyPricePoint;
  readonly mark1h: StudyPricePoint;
  readonly mark4h: StudyPricePoint;
  /** Highest and lowest archived mark observations in [T0, T0+4h]. */
  readonly highMark4h: number;
  readonly lowMark4h: number;
  readonly yesT0: StudyPricePoint;
  readonly yes1h: StudyPricePoint;
  readonly yes4h: StudyPricePoint;
  readonly fundingSettlements: readonly FundingSettlementObservation[];
  /** Reported independently and excluded from the primary direction gate. */
  readonly measurement?: {
    readonly mark: StudyPricePoint;
    readonly yes: StudyPricePoint;
  };
};

export type DirectionMetrics = {
  readonly side: "LONG" | "SHORT";
  readonly medianPrimaryReturnBps: number;
  readonly primaryHitRate: number;
  readonly medianMfeBps: number;
  readonly medianMaeBps: number;
};

export type DirectionalSampleScore = {
  readonly candidateId: string;
  readonly candidateT0: number;
  readonly perpSymbol: string;
  readonly return1hBps: number;
  readonly return4hBps: number;
  readonly longMfeBps: number;
  readonly longMaeBps: number;
  readonly shortMfeBps: number;
  readonly shortMaeBps: number;
  /** Price-return contribution for a one-unit LONG; SHORT is its inverse. */
  readonly longFundingReturnBps: number;
  readonly yesChange1h: number;
  readonly yesChange4h: number;
  readonly measurementReturnBps: number | null;
  readonly measurementYesChange: number | null;
};

export type ProvisionalDirectionalOutcome =
  | "PROVISIONAL_LONG_SUPPORTED"
  | "PROVISIONAL_SHORT_SUPPORTED"
  | "NO_PROVISIONAL_DIRECTIONAL_EVIDENCE";

export type FormalDirectionalOutcome =
  | "DIRECTIONAL_LONG_SUPPORTED"
  | "DIRECTIONAL_SHORT_SUPPORTED"
  | "NO_DIRECTIONAL_EVIDENCE";

export type DirectionalStageEvaluation<Outcome extends string> = {
  readonly sampleCount: number;
  readonly outcome: Outcome;
  readonly long: DirectionMetrics;
  readonly short: DirectionMetrics;
};

export type DirectionalStudyResult = {
  readonly status: "COLLECTING" | "EVALUATED";
  readonly sampleCount: number;
  readonly requiredSampleCount: typeof DIRECTIONAL_STUDY_PRIMARY_SAMPLE_SIZE;
  /** Frozen exactly once from the first three observations. */
  readonly provisional: DirectionalStageEvaluation<ProvisionalDirectionalOutcome> | null;
  /** Present only when all ten observations exist. */
  readonly formal: DirectionalStageEvaluation<FormalDirectionalOutcome> | null;
  readonly authorization: {
    readonly strategyGeneratedTestnet:
      | "LOCKED_PENDING_PROVISIONAL_GATE"
      | "ELIGIBLE_FOR_EXPLICIT_REVIEW"
      | "NOT_ELIGIBLE";
    readonly microCapital:
      | "LOCKED_PENDING_FORMAL_GATE"
      | "ELIGIBLE_FOR_EXPLICIT_REVIEW"
      | "NOT_ELIGIBLE";
  };
  readonly samples: readonly DirectionalSampleScore[];
};

/**
 * Pure research evaluator. It has no execution dependency and never emits a
 * PerpIntent. v1.1 freezes a provisional hypothesis at 3 observations and the
 * formal result at 10; neither result automatically activates trading.
 */
export function evaluateDirectionalStudyV1(
  observations: readonly DirectionalStudyObservation[]
): DirectionalStudyResult {
  if (observations.length > DIRECTIONAL_STUDY_PRIMARY_SAMPLE_SIZE) {
    throw new Error("Directional Study v1.1 primary cohort is already closed at 10 observations");
  }

  const candidateIds = new Set<string>();
  let previousT0 = -Infinity;
  const samples = observations.map((observation) => {
    validateObservation(observation, candidateIds, previousT0);
    candidateIds.add(observation.candidateId);
    previousT0 = observation.candidateT0;
    return scoreObservation(observation);
  });

  const provisional = samples.length >= DIRECTIONAL_STUDY_PROVISIONAL_SAMPLE_SIZE
    ? evaluateProvisional(samples.slice(0, DIRECTIONAL_STUDY_PROVISIONAL_SAMPLE_SIZE))
    : null;
  const formal = samples.length === DIRECTIONAL_STUDY_PRIMARY_SAMPLE_SIZE
    ? evaluateFormal(samples)
    : null;
  const provisionalSupported = provisional !== null
    && provisional.outcome !== "NO_PROVISIONAL_DIRECTIONAL_EVIDENCE";
  const formalSupported = formal !== null && formal.outcome !== "NO_DIRECTIONAL_EVIDENCE";

  return {
    status: formal === null ? "COLLECTING" : "EVALUATED",
    sampleCount: samples.length,
    requiredSampleCount: DIRECTIONAL_STUDY_PRIMARY_SAMPLE_SIZE,
    provisional,
    formal,
    authorization: {
      strategyGeneratedTestnet: provisional === null
        ? "LOCKED_PENDING_PROVISIONAL_GATE"
        : provisionalSupported || formalSupported
          ? "ELIGIBLE_FOR_EXPLICIT_REVIEW"
          : "NOT_ELIGIBLE",
      microCapital: formal === null
        ? "LOCKED_PENDING_FORMAL_GATE"
        : formalSupported
          ? "ELIGIBLE_FOR_EXPLICIT_REVIEW"
          : "NOT_ELIGIBLE"
    },
    samples
  };
}

function evaluateProvisional(
  samples: readonly DirectionalSampleScore[]
): DirectionalStageEvaluation<ProvisionalDirectionalOutcome> {
  const { long, short } = directionMetrics(samples);
  const outcome = supportsDirection(long, DIRECTIONAL_STUDY_PROVISIONAL_MIN_HIT_RATE)
    ? "PROVISIONAL_LONG_SUPPORTED"
    : supportsDirection(short, DIRECTIONAL_STUDY_PROVISIONAL_MIN_HIT_RATE)
      ? "PROVISIONAL_SHORT_SUPPORTED"
      : "NO_PROVISIONAL_DIRECTIONAL_EVIDENCE";
  return { sampleCount: DIRECTIONAL_STUDY_PROVISIONAL_SAMPLE_SIZE, outcome, long, short };
}

function evaluateFormal(
  samples: readonly DirectionalSampleScore[]
): DirectionalStageEvaluation<FormalDirectionalOutcome> {
  const { long, short } = directionMetrics(samples);
  const outcome = supportsDirection(long, DIRECTIONAL_STUDY_MIN_HIT_RATE)
    ? "DIRECTIONAL_LONG_SUPPORTED"
    : supportsDirection(short, DIRECTIONAL_STUDY_MIN_HIT_RATE)
      ? "DIRECTIONAL_SHORT_SUPPORTED"
      : "NO_DIRECTIONAL_EVIDENCE";
  return { sampleCount: DIRECTIONAL_STUDY_PRIMARY_SAMPLE_SIZE, outcome, long, short };
}

function directionMetrics(samples: readonly DirectionalSampleScore[]): {
  readonly long: DirectionMetrics;
  readonly short: DirectionMetrics;
} {
  return {
    long: aggregateDirection("LONG", samples),
    short: aggregateDirection("SHORT", samples)
  };
}

function scoreObservation(observation: DirectionalStudyObservation): DirectionalSampleScore {
  const entry = observation.t0Mark.value;
  const return1hBps = returnBps(entry, observation.mark1h.value);
  const return4hBps = returnBps(entry, observation.mark4h.value);
  const longMfeBps = Math.max(0, returnBps(entry, observation.highMark4h));
  const longMaeBps = Math.max(0, -returnBps(entry, observation.lowMark4h));
  const shortMfeBps = longMaeBps;
  const shortMaeBps = longMfeBps;
  const longFundingReturnBps = observation.fundingSettlements.reduce(
    (total, settlement) => total - settlement.markPrice * settlement.rate / entry * 10_000,
    0
  );

  return {
    candidateId: observation.candidateId,
    candidateT0: observation.candidateT0,
    perpSymbol: observation.perpSymbol,
    return1hBps: round(return1hBps),
    return4hBps: round(return4hBps),
    longMfeBps: round(longMfeBps),
    longMaeBps: round(longMaeBps),
    shortMfeBps: round(shortMfeBps),
    shortMaeBps: round(shortMaeBps),
    longFundingReturnBps: round(longFundingReturnBps),
    yesChange1h: round(observation.yes1h.value - observation.yesT0.value),
    yesChange4h: round(observation.yes4h.value - observation.yesT0.value),
    measurementReturnBps: observation.measurement
      ? round(returnBps(entry, observation.measurement.mark.value))
      : null,
    measurementYesChange: observation.measurement
      ? round(observation.measurement.yes.value - observation.yesT0.value)
      : null
  };
}

function aggregateDirection(
  side: "LONG" | "SHORT",
  samples: readonly DirectionalSampleScore[]
): DirectionMetrics {
  const sign = side === "LONG" ? 1 : -1;
  const returns = samples.map((sample) => sign * sample.return4hBps);
  const mfes = samples.map((sample) => side === "LONG" ? sample.longMfeBps : sample.shortMfeBps);
  const maes = samples.map((sample) => side === "LONG" ? sample.longMaeBps : sample.shortMaeBps);
  return {
    side,
    medianPrimaryReturnBps: round(median(returns)),
    primaryHitRate: round(returns.filter((value) => value > 0).length / returns.length),
    medianMfeBps: round(median(mfes)),
    medianMaeBps: round(median(maes))
  };
}

function supportsDirection(metrics: DirectionMetrics, minimumHitRate: number): boolean {
  return metrics.medianPrimaryReturnBps > 0
    && metrics.primaryHitRate >= minimumHitRate
    && metrics.medianMfeBps > metrics.medianMaeBps;
}

function validateObservation(
  observation: DirectionalStudyObservation,
  candidateIds: Set<string>,
  previousT0: number
): void {
  if (observation.protocolVersion !== DIRECTIONAL_STUDY_PROTOCOL_VERSION) {
    throw new Error("unsupported Directional Study protocol");
  }
  if (observation.qualification !== DIRECTIONAL_STUDY_QUALIFICATION) {
    throw new Error("observation is not a qualified prospective Candidate");
  }
  if (!observation.candidateId || !observation.perpSymbol) {
    throw new Error("candidateId and perpSymbol are required");
  }
  if (candidateIds.has(observation.candidateId)) {
    throw new Error(`duplicate candidateId ${observation.candidateId}`);
  }
  finiteTimestamp(observation.candidateT0, "candidateT0");
  if (observation.candidateT0 < previousT0) {
    throw new Error("observations must be ordered by Candidate T0");
  }

  validatePoint(observation.t0Mark, observation.candidateT0, "t0Mark", positivePrice);
  validatePoint(
    observation.mark1h,
    observation.candidateT0 + DIRECTIONAL_STUDY_SECONDARY_HORIZON_MS,
    "mark1h",
    positivePrice
  );
  validatePoint(
    observation.mark4h,
    observation.candidateT0 + DIRECTIONAL_STUDY_PRIMARY_HORIZON_MS,
    "mark4h",
    positivePrice
  );
  validatePoint(observation.yesT0, observation.candidateT0, "yesT0", validYesPrice);
  validatePoint(
    observation.yes1h,
    observation.candidateT0 + DIRECTIONAL_STUDY_SECONDARY_HORIZON_MS,
    "yes1h",
    validYesPrice
  );
  validatePoint(
    observation.yes4h,
    observation.candidateT0 + DIRECTIONAL_STUDY_PRIMARY_HORIZON_MS,
    "yes4h",
    validYesPrice
  );

  positivePrice(observation.highMark4h, "highMark4h");
  positivePrice(observation.lowMark4h, "lowMark4h");
  const observedHigh = Math.max(observation.t0Mark.value, observation.mark4h.value);
  const observedLow = Math.min(observation.t0Mark.value, observation.mark4h.value);
  if (observation.highMark4h < observedHigh || observation.lowMark4h > observedLow) {
    throw new Error("4h mark extrema do not contain the T0 and 4h boundary marks");
  }
  if (observation.lowMark4h > observation.highMark4h) {
    throw new Error("lowMark4h must not exceed highMark4h");
  }

  for (const settlement of observation.fundingSettlements) {
    finiteTimestamp(settlement.settledAt, "funding settledAt");
    positivePrice(settlement.markPrice, "funding markPrice");
    if (!Number.isFinite(settlement.rate)) throw new Error("funding rate must be finite");
    if (
      settlement.settledAt <= observation.candidateT0 ||
      settlement.settledAt > observation.candidateT0 + DIRECTIONAL_STUDY_PRIMARY_HORIZON_MS
    ) {
      throw new Error("funding settlement must fall inside (T0, T0+4h]");
    }
  }

  if (observation.measurement) {
    const measurementAt = observation.measurement.mark.asOf;
    if (measurementAt <= observation.candidateT0 + DIRECTIONAL_STUDY_PRIMARY_HORIZON_MS) {
      throw new Error("measurementAt must be later than the primary horizon");
    }
    validatePoint(observation.measurement.mark, measurementAt, "measurement mark", positivePrice);
    validatePoint(observation.measurement.yes, measurementAt, "measurement YES", validYesPrice);
  }
}

function validatePoint(
  point: StudyPricePoint,
  expectedAsOf: number,
  label: string,
  valueValidator: (value: number, label: string) => void
): void {
  finiteTimestamp(point.asOf, `${label} asOf`);
  finiteTimestamp(point.observedAt, `${label} observedAt`);
  if (point.asOf !== expectedAsOf) throw new Error(`${label} has the wrong frozen boundary`);
  if (point.observedAt > point.asOf) throw new Error(`${label} reads a future observation`);
  valueValidator(point.value, `${label} value`);
}

function finiteTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite timestamp`);
}

function positivePrice(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive and finite`);
}

function validYesPrice(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be in [0, 1]`);
}

function returnBps(entry: number, exit: number): number {
  return (exit - entry) / entry * 10_000;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[Math.floor(middle)];
}
