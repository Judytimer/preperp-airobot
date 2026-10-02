import { MemePredictionOverlayStrategy, type OverlayStrategyConfig } from "./strategy.ts";
import type { ResearchSnapshot, TradeCandidate } from "./types.ts";

export const FORMAL_STRATEGY_LAB_PROTOCOL_VERSION = "1.0.0";
export const FORMAL_STRATEGY_LAB_CADENCE_MS = 60_000;

export type ClosedSpotCandle = {
  readonly openTs: number;
  readonly closeTs: number;
  readonly close: number;
};

export type TimedYesPrice = {
  readonly ts: number;
  readonly yesPrice: number;
};

export type FormalOneMinuteInput = {
  readonly listingAt: number;
  readonly symbol: string;
  readonly totalSupply: number;
  readonly marketId: string;
  readonly question: string;
  readonly targetFdv: number;
  readonly candles: readonly ClosedSpotCandle[];
  readonly yesPrices: readonly TimedYesPrice[];
};

export type FormalOneMinuteReplayResult =
  | {
      readonly status: "CANDIDATE";
      readonly protocolVersion: typeof FORMAL_STRATEGY_LAB_PROTOCOL_VERSION;
      readonly baselineTs: number;
      readonly evaluatedSnapshots: number;
      readonly candidate: TradeCandidate;
    }
  | {
      readonly status: "NO_CANDIDATE";
      readonly protocolVersion: typeof FORMAL_STRATEGY_LAB_PROTOCOL_VERSION;
      readonly baselineTs: number;
      readonly evaluatedSnapshots: number;
      readonly reason: "STRATEGY_NEVER_EMITTED_BUY_YES";
    };

/**
 * Formal Strategy Lab adapter only. It does not modify Strategy semantics.
 * - cadence: 1-minute fully closed candles
 * - baseline: first full candle whose open is at/after listingAt
 * - FDV: closed spot price * verified total supply
 * - yesPrice: latest known point at/before snapshot.ts; never interpolated
 */
export function buildFormalOneMinuteSnapshots(input: FormalOneMinuteInput): readonly ResearchSnapshot[] {
  validateInput(input);

  const baselineIndex = input.candles.findIndex((candle) => candle.openTs >= input.listingAt);
  if (baselineIndex < 0) throw new Error("no complete candle exists after listing");

  const candles = input.candles.slice(baselineIndex);
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    if (index > 0) {
      const previous = candles[index - 1];
      if (
        candle.openTs - previous.openTs !== FORMAL_STRATEGY_LAB_CADENCE_MS ||
        candle.closeTs - previous.closeTs !== FORMAL_STRATEGY_LAB_CADENCE_MS
      ) {
        throw new Error("formal candle cadence must be contiguous 1-minute closed candles");
      }
    }
  }

  return candles.map((candle, index) => {
    const yesPoint = latestKnownYesAtOrBefore(input.yesPrices, candle.closeTs);
    if (yesPoint === null) throw new Error("missing historical YES price at snapshot time");
    return {
      seq: index + 1,
      ts: candle.closeTs,
      meme: {
        symbol: input.symbol,
        spotPrice: candle.close,
        fdv: candle.close * input.totalSupply
      },
      prediction: {
        marketId: input.marketId,
        question: input.question,
        targetFdv: input.targetFdv,
        yesPrice: yesPoint.yesPrice,
        yesPriceObservedAt: yesPoint.ts
      }
    };
  });
}

export function runFormalOneMinuteReplay(
  input: FormalOneMinuteInput,
  config: OverlayStrategyConfig
): FormalOneMinuteReplayResult {
  const snapshots = buildFormalOneMinuteSnapshots(input);
  if (snapshots.length === 0) throw new Error("formal replay requires at least one snapshot");

  const strategy = new MemePredictionOverlayStrategy(config);
  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index];
    const signal = strategy.onSnapshot(snapshot, 0);
    if (signal.action === "BUY_YES") {
      return {
        status: "CANDIDATE",
        protocolVersion: FORMAL_STRATEGY_LAB_PROTOCOL_VERSION,
        baselineTs: snapshots[0].ts,
        evaluatedSnapshots: index + 1,
        candidate: {
          candidateId: `${signal.marketId}:${snapshot.seq}`,
          t0: signal.ts,
          snapshot: structuredClone(snapshot),
          signal
        }
      };
    }
  }

  return {
    status: "NO_CANDIDATE",
    protocolVersion: FORMAL_STRATEGY_LAB_PROTOCOL_VERSION,
    baselineTs: snapshots[0].ts,
    evaluatedSnapshots: snapshots.length,
    reason: "STRATEGY_NEVER_EMITTED_BUY_YES"
  };
}

export function latestKnownYesAtOrBefore(
  points: readonly TimedYesPrice[],
  snapshotTs: number
): TimedYesPrice | null {
  let latest: TimedYesPrice | null = null;
  for (const point of points) {
    if (point.ts > snapshotTs) break;
    latest = point;
  }
  return latest;
}

function isOneMinuteCandleDuration(openTs: number, closeTs: number): boolean {
  const duration = closeTs - openTs;
  return (
    duration === FORMAL_STRATEGY_LAB_CADENCE_MS - 1 ||
    duration === FORMAL_STRATEGY_LAB_CADENCE_MS
  );
}

function validateInput(input: FormalOneMinuteInput): void {
  if (!Number.isFinite(input.listingAt)) throw new Error("listingAt must be finite");
  if (!Number.isFinite(input.totalSupply) || input.totalSupply <= 0) throw new Error("totalSupply must be positive");
  if (!Number.isFinite(input.targetFdv) || input.targetFdv <= 0) throw new Error("targetFdv must be positive");
  if (input.candles.length === 0) throw new Error("formal replay candles are empty");
  if (input.yesPrices.length === 0) throw new Error("formal replay YES history is empty");

  let previousOpen = -Infinity;
  let previousClose = -Infinity;
  for (const candle of input.candles) {
    if (
      !Number.isFinite(candle.openTs) ||
      !Number.isFinite(candle.closeTs) ||
      !Number.isFinite(candle.close) ||
      candle.close <= 0 ||
      candle.openTs <= previousOpen ||
      candle.closeTs <= previousClose ||
      candle.closeTs <= candle.openTs ||
      !isOneMinuteCandleDuration(candle.openTs, candle.closeTs)
    ) {
      throw new Error("formal replay candle is invalid");
    }
    previousOpen = candle.openTs;
    previousClose = candle.closeTs;
  }

  let previousYesTs = -Infinity;
  for (const point of input.yesPrices) {
    if (
      !Number.isFinite(point.ts) ||
      point.ts <= previousYesTs ||
      !Number.isFinite(point.yesPrice) ||
      point.yesPrice <= 0 ||
      point.yesPrice > 1
    ) {
      throw new Error("formal replay YES history is invalid");
    }
    previousYesTs = point.ts;
  }
}
