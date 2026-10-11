import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { OrderTrackerState } from "./order-tracker.ts";
import type { PositionBookState } from "./position.ts";

export type BotCheckpoint = {
  version: 1;
  symbol: string;
  positionState: PositionBookState;
  orderTrackerState: OrderTrackerState;
  nextClientOrderSequence: number;
  halted: boolean;
  lastMarkPrice: number | null;
};

export interface BotStateStore {
  load(): Promise<BotCheckpoint | null>;
  save(checkpoint: BotCheckpoint): Promise<void>;
}

export class JsonFileBotStateStore implements BotStateStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<BotCheckpoint | null> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error("invalid checkpoint JSON");
    }
    return validateCheckpoint(value);
  }

  async save(checkpoint: BotCheckpoint): Promise<void> {
    validateCheckpoint(checkpoint);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function validateCheckpoint(value: unknown): BotCheckpoint {
  if (!isRecord(value)) {
    throw new Error("invalid checkpoint shape");
  }
  if (value.version !== 1) {
    throw new Error(`unsupported checkpoint version ${String(value.version)}`);
  }
  if (
    typeof value.symbol !== "string" ||
    !isPositionState(value.positionState) ||
    !isOrderTrackerState(value.orderTrackerState) ||
    !Number.isInteger(value.nextClientOrderSequence) ||
    (value.nextClientOrderSequence as number) < 1 ||
    typeof value.halted !== "boolean" ||
    (value.lastMarkPrice !== null &&
      (typeof value.lastMarkPrice !== "number" ||
        !Number.isFinite(value.lastMarkPrice) ||
        value.lastMarkPrice <= 0))
  ) {
    throw new Error("invalid checkpoint shape");
  }
  return value as BotCheckpoint;
}

function isPositionState(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.position) || !isStringArray(value.processedFillIds)) {
    return false;
  }
  if (value.processedFundingIds !== undefined && !isStringArray(value.processedFundingIds)) {
    return false;
  }
  const position = value.position;
  return (
    typeof position.symbol === "string" &&
    (position.side === "FLAT" || position.side === "LONG" || position.side === "SHORT") &&
    isNonNegativeNumber(position.qty) &&
    isNonNegativeNumber(position.entryPrice) &&
    isFiniteNumber(position.realizedPnl)
  );
}

function isOrderTrackerState(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.orders)) {
    return false;
  }
  return value.orders.every((item) => {
    if (!isRecord(item) || !isRecord(item.order) || !isStringArray(item.processedFillIds)) {
      return false;
    }
    const order = item.order;
    return (
      typeof item.symbol === "string" &&
      typeof order.clientOrderId === "string" &&
      (order.exchangeOrderId === null || typeof order.exchangeOrderId === "string") &&
      (order.side === "BUY" || order.side === "SELL") &&
      isNonNegativeNumber(order.originalQty) &&
      isNonNegativeNumber(order.filledQty) &&
      isNonNegativeNumber(order.remainingQty) &&
      (order.cancelRequested === undefined || typeof order.cancelRequested === "boolean") &&
      [
        "SUBMITTED", "ACKED", "PARTIALLY_FILLED", "CANCEL_REQUESTED", "FILLED", "CANCELED",
        "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"
      ].includes(
        String(order.status)
      )
    );
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
