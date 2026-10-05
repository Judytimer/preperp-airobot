import { round } from "./math.ts";
import type { OrderSide, Position, RiskDecision, Signal, Tick } from "./types.ts";

export type RiskConfig = {
  orderQty: number;
  maxAbsPosition: number;
};

export class RiskManager {
  private readonly orderQty: number;
  private readonly maxAbsPosition: number;

  constructor(config: RiskConfig) {
    if (config.orderQty <= 0) {
      throw new Error("orderQty must be positive");
    }

    if (config.maxAbsPosition < config.orderQty) {
      throw new Error("maxAbsPosition must be at least orderQty");
    }

    this.orderQty = config.orderQty;
    this.maxAbsPosition = config.maxAbsPosition;
  }

  evaluate(signal: Signal, position: Position, tick: Tick): RiskDecision {
    if (signal.action === "HOLD") {
      return { approved: false, reason: signal.reason };
    }

    const targetQty = signal.targetQty ?? this.orderQty;
    if ((signal.action === "LONG" || signal.action === "SHORT") &&
        (!Number.isFinite(targetQty) || targetQty <= 0)) {
      return { approved: false, reason: "target quantity must be positive" };
    }
    const targetSignedQty = signal.action === "LONG"
      ? targetQty
      : signal.action === "SHORT"
        ? -targetQty
        : 0;
    const currentSignedQty = signedPosition(position);
    const deltaQty = round(targetSignedQty - currentSignedQty);

    if (deltaQty === 0) {
      return {
        approved: false,
        reason: signal.targetQty === undefined && signal.action === position.side
          ? `already ${position.side}`
          : "target position already reached"
      };
    }

    if (Math.abs(targetSignedQty) > this.maxAbsPosition) {
      return {
        approved: false,
        reason: `target ${Math.abs(targetSignedQty)} exceeds maxAbsPosition ${this.maxAbsPosition}`
      };
    }

    const side: OrderSide = deltaQty > 0 ? "BUY" : "SELL";
    return {
      approved: true,
      order: {
        symbol: tick.symbol,
        side,
        qty: Math.abs(deltaQty),
        price: tick.lastPrice,
        reason: signal.reason,
        ts: tick.ts
      }
    };
  }
}

function signedPosition(position: Position): number {
  if (position.side === "LONG") {
    return position.qty;
  }

  if (position.side === "SHORT") {
    return -position.qty;
  }

  return 0;
}
