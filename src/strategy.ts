import { sma } from "./math.ts";
import type { Signal, Tick } from "./types.ts";

export interface PerpSignalSource {
  onTick(tick: Tick): Signal;
}

export class MovingAverageSignal implements PerpSignalSource {
  private readonly prices: number[] = [];
  private readonly shortWindow: number;
  private readonly longWindow: number;

  constructor(shortWindow: number, longWindow: number) {
    if (shortWindow >= longWindow) {
      throw new Error("shortWindow must be smaller than longWindow");
    }

    this.shortWindow = shortWindow;
    this.longWindow = longWindow;
  }

  onTick(tick: Tick): Signal {
    this.prices.push(tick.lastPrice);

    const shortMa = sma(this.prices, this.shortWindow);
    const longMa = sma(this.prices, this.longWindow);

    if (shortMa === null || longMa === null) {
      return {
        action: "HOLD",
        shortMa,
        longMa,
        reason: `warming up (${this.prices.length}/${this.longWindow})`
      };
    }

    if (shortMa > longMa) {
      return { action: "LONG", shortMa, longMa, reason: "short MA > long MA" };
    }

    if (shortMa < longMa) {
      return { action: "SHORT", shortMa, longMa, reason: "short MA < long MA" };
    }

    return { action: "HOLD", shortMa, longMa, reason: "MAs equal" };
  }
}
