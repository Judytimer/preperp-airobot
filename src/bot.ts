import type { ExecutionVenue } from "./exchange.ts";
import {
  formatAck,
  formatAccount,
  formatCancelAck,
  formatFill,
  formatFunding,
  formatOrderState,
  formatPosition,
  formatRisk,
  formatSignal,
  formatTick
} from "./logging.ts";
import { PositionBook } from "./position.ts";
import { InFlightOrderTracker } from "./order-tracker.ts";
import type { InFlightOrder } from "./order-tracker.ts";
import { RiskManager } from "./risk.ts";
import { MovingAverageSignal } from "./strategy.ts";
import type { PerpSignalSource } from "./strategy.ts";
import { round } from "./math.ts";
import { IsolatedMarginAccount } from "./margin.ts";
import type { MarginConfig, MarginSnapshot } from "./margin.ts";
import type { ExecutionEvent, FundingSettlement, Logger, OrderRequest, Position, PositionSide, Tick } from "./types.ts";
import type { BotCheckpoint, BotStateStore } from "./state-store.ts";
import { PaperLiquidationExecutor } from "./liquidation.ts";
import { reconcileState } from "./reconciliation.ts";
import type { ExchangeStateSnapshot, ReconciliationReport } from "./reconciliation.ts";

type CommonBotConfig = {
  symbol: string;
  orderQty: number;
  maxAbsPosition: number;
  venue: ExecutionVenue;
  margin?: MarginConfig;
  stateStore?: BotStateStore;
  logger?: Logger;
};

export type BotConfig = CommonBotConfig & (
  | {
      shortWindow: number;
      longWindow: number;
      signalSource?: never;
    }
  | {
      signalSource: PerpSignalSource;
      shortWindow?: never;
      longWindow?: never;
    }
);

export class PerpBot {
  private readonly strategy: PerpSignalSource;
  private readonly risk: RiskManager;
  private readonly venue: ExecutionVenue;
  private positions: PositionBook;
  private readonly logger: Logger;
  private orderTracker = new InFlightOrderTracker();
  private readonly margin: IsolatedMarginAccount;
  private readonly liquidationExecutor = new PaperLiquidationExecutor();
  private lastAccountSnapshot: MarginSnapshot | null = null;
  private lastMarkPrice: number | null = null;
  private halted = false;
  private recoveryRequired = false;
  private readonly stateStore?: BotStateStore;
  private persistTail: Promise<void> = Promise.resolve();
  private nextClientOrderSequence = 1;
  private readonly cancelConfirmations = new Map<string, () => void>();

  constructor(config: BotConfig) {
    this.strategy = "signalSource" in config && config.signalSource !== undefined
      ? config.signalSource
      : new MovingAverageSignal(config.shortWindow, config.longWindow);
    this.risk = new RiskManager({
      orderQty: config.orderQty,
      maxAbsPosition: config.maxAbsPosition
    });
    this.venue = config.venue;
    this.positions = new PositionBook(config.symbol);
    this.margin = new IsolatedMarginAccount(
      config.margin ?? { collateral: 10_000, leverage: 5, maintenanceMarginRate: 0.005 }
    );
    this.logger = config.logger ?? console.log;
    this.stateStore = config.stateStore;
    this.venue.onExecutionEvent((event) => this.onExecutionEvent(event));
  }

  static async create(config: BotConfig): Promise<PerpBot> {
    const bot = new PerpBot(config);
    await bot.restore();
    return bot;
  }

  async onTick(tick: Tick): Promise<void> {
    validateTickPrices(tick);
    this.logger(formatTick(tick));

    const markedPosition = this.positions.get();
    this.lastMarkPrice = tick.markPrice;
    this.lastAccountSnapshot = this.margin.snapshot(markedPosition, tick.markPrice);
    this.logger(formatAccount(this.lastAccountSnapshot));

    if (this.recoveryRequired) {
      this.logger(`[RECOVERY] blocked openOrders=${this.orderTracker.getOpenOrders().length}`);
      return;
    }

    if (this.halted) {
      this.logger('[MARGIN_RISK] blocked reason="halted after liquidation"');
      return;
    }

    if (this.lastAccountSnapshot.liquidatable) {
      await this.liquidate(markedPosition, tick, this.lastAccountSnapshot);
      return;
    }

    const signal = this.strategy.onTick(tick);
    this.logger(formatSignal(signal));

    const filledPosition = this.positions.get();
    const projectedPosition = projectPosition(filledPosition, this.orderTracker.getOpenOrders());
    this.logger(
      `[EXPOSURE] filled=${signedQty(filledPosition)} pending=${round(
        signedQty(projectedPosition) - signedQty(filledPosition)
      )} projected=${signedQty(projectedPosition)}`
    );

    const decision = this.risk.evaluate(signal, projectedPosition, tick);
    this.logger(formatRisk(decision));

    if (!decision.approved) {
      return;
    }

    const postOrderPosition = projectOrder(projectedPosition, decision.order);
    const postOrderAccount = this.margin.snapshot(postOrderPosition, tick.markPrice);
    if (postOrderAccount.initialMargin > this.lastAccountSnapshot.equity) {
      this.logger(
        `[MARGIN_RISK] blocked requiredInitialMargin=${postOrderAccount.initialMargin} equity=${this.lastAccountSnapshot.equity}`
      );
      return;
    }
    this.logger(
      `[MARGIN_RISK] approved requiredInitialMargin=${postOrderAccount.initialMargin} equity=${this.lastAccountSnapshot.equity}`
    );

    const clientOrderId = `${configSafeSymbol(decision.order.symbol)}-${this.nextClientOrderSequence++}`;
    this.orderTracker.trackSubmission(clientOrderId, decision.order);
    // Persist client-owned identity before sending. A crash after this point remains unresolved,
    // rather than being incorrectly treated as proof that no venue order exists.
    await this.persist();
    await this.venue.submit({ clientOrderId, request: decision.order });
  }

  async onFunding(settlement: FundingSettlement): Promise<void> {
    const latestMarkPrice = this.requireLatestMarkPrice();
    const result = this.positions.applyFunding(settlement);
    if (!result.accepted) {
      this.logger(`[FUNDING] fundingId=${settlement.fundingId} ignored=duplicate`);
      return;
    }

    this.logger(formatFunding(settlement, result.payment));
    // Funding changes realized equity, but a funding event does not own the live market mark.
    this.lastAccountSnapshot = this.margin.snapshot(result.position, latestMarkPrice);
    this.logger(formatPosition(result.position));
    this.logger(formatAccount(this.lastAccountSnapshot));
    await this.persist();
  }

  getPosition(): Position {
    return this.positions.get();
  }

  getAccountSnapshot(): MarginSnapshot | null {
    return this.lastAccountSnapshot === null ? null : { ...this.lastAccountSnapshot };
  }

  isRecoveryRequired(): boolean {
    return this.recoveryRequired;
  }

  reconcile(exchange: ExchangeStateSnapshot): ReconciliationReport {
    return reconcileState(this.positions.get(), this.orderTracker.getOpenOrders(), exchange);
  }

  private async liquidate(position: Position, tick: Tick, snapshot: MarginSnapshot): Promise<void> {
    for (const cancelRequested of this.orderTracker.requestCancelOpenOrders()) {
      this.logger(formatOrderState(cancelRequested));
      const confirmed = new Promise<void>((resolve) => {
        this.cancelConfirmations.set(cancelRequested.clientOrderId, resolve);
      });
      await this.venue.requestCancel(cancelRequested.clientOrderId);
      await confirmed;
    }

    const execution = this.liquidationExecutor.execute(position, tick);
    this.logger(
      `[LIQUIDATION] side=${execution.fill.side} qty=${position.qty} triggerMark=${execution.triggerMarkPrice} executionPrice=${execution.executionPrice} assumption=EXECUTION_AT_MARK equity=${snapshot.equity} maintenanceMargin=${snapshot.maintenanceMargin}`
    );
    const closedPosition = this.positions.applyFill(execution.fill);
    this.logger(formatPosition(closedPosition));
    this.lastAccountSnapshot = this.margin.snapshot(closedPosition, tick.markPrice);
    this.logger(formatAccount(this.lastAccountSnapshot));
    this.halted = true;
    await this.persist();
  }

  private requireLatestMarkPrice(): number {
    if (this.lastMarkPrice === null) {
      throw new Error("invariant violation: cannot value a fill without a latest mark price");
    }
    return this.lastMarkPrice;
  }

  private async restore(): Promise<void> {
    if (this.stateStore === undefined) {
      return;
    }
    const checkpoint = await this.stateStore.load();
    if (checkpoint === null) {
      return;
    }
    if (checkpoint.symbol !== this.positions.get().symbol) {
      throw new Error(
        `checkpoint symbol ${checkpoint.symbol} does not match bot symbol ${this.positions.get().symbol}`
      );
    }

    this.positions = PositionBook.fromState(checkpoint.positionState);
    this.orderTracker = InFlightOrderTracker.fromState(checkpoint.orderTrackerState);
    this.nextClientOrderSequence = checkpoint.nextClientOrderSequence;
    this.halted = checkpoint.halted;
    this.recoveryRequired = this.orderTracker.getOpenOrders().length > 0;
    if (checkpoint.lastMarkPrice !== null) {
      this.lastMarkPrice = checkpoint.lastMarkPrice;
      this.lastAccountSnapshot = this.margin.snapshot(this.positions.get(), checkpoint.lastMarkPrice);
    }
    this.logger(
      `[RECOVERY] restored position=${this.positions.get().side} openOrders=${this.orderTracker.getOpenOrders().length} nextClientOrderSequence=${checkpoint.nextClientOrderSequence}`
    );
  }

  private persist(): Promise<void> {
    if (this.stateStore === undefined) {
      return Promise.resolve();
    }
    this.persistTail = this.persistTail.then(() => this.stateStore?.save(this.buildCheckpoint()));
    return this.persistTail;
  }

  private buildCheckpoint(): BotCheckpoint {
    return {
      version: 1,
      symbol: this.positions.get().symbol,
      positionState: this.positions.exportState(),
      orderTrackerState: this.orderTracker.exportState(),
      nextClientOrderSequence: this.nextClientOrderSequence,
      halted: this.halted,
      lastMarkPrice: this.lastAccountSnapshot?.markPrice ?? null
    };
  }

  private async onExecutionEvent(event: ExecutionEvent): Promise<void> {
    if (event.type === "ORDER_ACK") {
      const order = this.orderTracker.processAck(event.ack);
      this.logger(formatAck(event.ack));
      this.logger(formatOrderState(order));
      await this.persist();
      return;
    }
    if (event.type === "CANCEL_ACK") {
      this.logger(formatCancelAck(event.ack));
      this.logger(formatOrderState(this.orderTracker.processCancelAck(event.ack)));
      await this.persist();
      this.cancelConfirmations.get(event.ack.clientOrderId)?.();
      this.cancelConfirmations.delete(event.ack.clientOrderId);
      return;
    }
    const fill = event.fill;
    this.logger(formatFill(fill));
    const result = this.orderTracker.processFill(fill);
    this.logger(formatOrderState(result.order));
    if (!result.accepted) return;
    const position = this.positions.applyFill(fill);
    this.logger(formatPosition(position));
    this.lastAccountSnapshot = this.margin.snapshot(position, this.requireLatestMarkPrice());
    this.logger(formatAccount(this.lastAccountSnapshot));
    await this.persist();
  }
}

function configSafeSymbol(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9_-]/g, "_");
}

function validateTickPrices(tick: Tick): void {
  for (const [name, price] of [
    ["lastPrice", tick.lastPrice],
    ["markPrice", tick.markPrice],
    ["indexPrice", tick.indexPrice]
  ] as const) {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`${name} must be positive`);
    }
  }
}

function projectPosition(position: Position, pendingOrders: Iterable<InFlightOrder>): Position {
  let projectedQty = signedQty(position);

  for (const order of pendingOrders) {
    projectedQty += order.side === "BUY" ? order.remainingQty : -order.remainingQty;
  }

  projectedQty = round(projectedQty);
  return {
    ...position,
    side: sideFromSignedQty(projectedQty),
    qty: Math.abs(projectedQty)
  };
}

function signedQty(position: Position): number {
  return position.side === "LONG" ? position.qty : position.side === "SHORT" ? -position.qty : 0;
}

function sideFromSignedQty(qty: number): PositionSide {
  return qty > 0 ? "LONG" : qty < 0 ? "SHORT" : "FLAT";
}

function projectOrder(position: Position, order: OrderRequest): Position {
  const oldQty = signedQty(position);
  const orderQty = order.side === "BUY" ? order.qty : -order.qty;
  const nextQty = round(oldQty + orderQty);
  let entryPrice = position.entryPrice;

  if (nextQty === 0) {
    entryPrice = 0;
  } else if (oldQty === 0 || Math.sign(oldQty) !== Math.sign(nextQty)) {
    entryPrice = order.price;
  } else if (Math.sign(oldQty) === Math.sign(orderQty)) {
    entryPrice = round(
      (Math.abs(oldQty) * position.entryPrice + Math.abs(orderQty) * order.price) / Math.abs(nextQty)
    );
  }

  return {
    ...position,
    side: sideFromSignedQty(nextQty),
    qty: Math.abs(nextQty),
    entryPrice
  };
}
