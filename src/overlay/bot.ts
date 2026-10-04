import { SimulatedExchange } from "../exchange.ts";
import type { FillDelay } from "../exchange.ts";
import { round } from "../math.ts";
import type { ExecutionEvent, Logger, OrderRequest } from "../types.ts";
import {
  formatOverlayAck,
  formatOverlayFill,
  formatOverlayExecution,
  formatOverlayPosition,
  formatOverlayRisk,
  formatOverlaySignal,
  formatPending,
  formatResearch,
  formatTradeCandidate
} from "./logging.ts";
import { PredictionPositionBook } from "./position.ts";
import { OverlayRiskManager } from "./risk.ts";
import { MemePredictionOverlayStrategy } from "./strategy.ts";
import type {
  OverlayPaperExecutionRecord,
  PredictionPosition,
  ResearchSnapshot,
  ShadowRunner,
  TradeCandidate
} from "./types.ts";

export type MemePredictionOverlayBotConfig = {
  spotRiseTriggerPct: number;
  exitYesPrice: number;
  maxRiskBudget: number;
  fillDelayMs: FillDelay;
  logger?: Logger;
  shadowRunner?: ShadowRunner;
  /** Fixed adverse paper-fill stress. Zero preserves the old no-slippage mode. */
  slippageBps?: number;
};

type PendingOverlayOrder = {
  readonly order: OrderRequest;
  readonly referencePrice: number;
  readonly slippageBps: number;
  readonly signalAt: number;
  readonly submitAt: number;
};

export class MemePredictionOverlayBot {
  private readonly strategy: MemePredictionOverlayStrategy;
  private readonly risk: OverlayRiskManager;
  private readonly exchange: SimulatedExchange;
  private readonly logger: Logger;
  private readonly shadowRunner: ShadowRunner | undefined;
  private readonly pendingOrders = new Map<string, PendingOverlayOrder>();
  private readonly executionRecords: OverlayPaperExecutionRecord[] = [];
  private readonly paperEvents: ExecutionEvent[] = [];
  private readonly positionRecords: PredictionPosition[] = [];
  private readonly slippageBps: number;
  private nextClientOrderId = 1;
  private positionBook: PredictionPositionBook | null = null;

  constructor(config: MemePredictionOverlayBotConfig) {
    const slippageBps = config.slippageBps ?? 0;
    if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
      throw new Error("slippageBps must be finite and in [0, 10000)");
    }
    this.strategy = new MemePredictionOverlayStrategy(config);
    this.risk = new OverlayRiskManager({ maxRiskBudget: config.maxRiskBudget });
    // Prediction-market fees vary by venue. This paper boundary declares ZERO
    // rather than silently inheriting the perpetual simulator's default fee.
    this.exchange = new SimulatedExchange(config.fillDelayMs, 0);
    this.slippageBps = slippageBps;
    this.logger = config.logger ?? console.log;
    this.shadowRunner = config.shadowRunner;
    this.exchange.onExecutionEvent((event) => this.onExecutionEvent(event));
  }

  async onSnapshot(snapshot: ResearchSnapshot): Promise<void> {
    this.positionBook ??= new PredictionPositionBook(snapshot.prediction.marketId);
    this.logger(formatResearch(snapshot));

    const projectedShares = this.getProjectedShares();
    this.logger(
      `[OVERLAY_EXPOSURE] filled=${this.positionBook.get().shares} pending=${round(
        projectedShares - this.positionBook.get().shares,
        6
      )} projected=${projectedShares}`
    );

    const signal = this.strategy.onSnapshot(snapshot, projectedShares);
    this.logger(formatOverlaySignal(signal));
    if (signal.action === "BUY_YES") {
      const candidate: TradeCandidate = {
        candidateId: `${signal.marketId}:${snapshot.seq}`,
        t0: signal.ts,
        snapshot: structuredClone(snapshot),
        signal
      };
      this.logger(formatTradeCandidate(candidate));
      try {
        this.shadowRunner?.start(candidate);
      } catch {
        // Even a broken ShadowRunner implementation cannot block Risk or Execution.
      }
      // Current SHADOW safety boundary: AI reviews entries only and has no execution
      // authority. Deterministic exits bypass review; this is not a permanent strategy rule.
    }
    const executionPrice = stressedFillPrice(
      signal.yesPrice,
      signal.action === "SELL_YES" ? "SELL" : "BUY",
      this.slippageBps
    );
    const decision = this.risk.evaluate({ ...signal, yesPrice: executionPrice }, projectedShares);
    this.logger(formatOverlayRisk(decision));
    if (!decision.approved) {
      return;
    }

    const clientOrderId = `OVERLAY-${this.nextClientOrderId++}`;
    const submitAt = Date.now();
    const executionOrder = decision.order;
    this.pendingOrders.set(clientOrderId, {
      order: executionOrder,
      referencePrice: signal.yesPrice,
      slippageBps: this.slippageBps,
      signalAt: decision.order.ts,
      submitAt
    });
    this.logger(formatPending(clientOrderId, executionOrder));
    await this.exchange.submit({ clientOrderId, request: executionOrder });
  }

  async waitForIdle(): Promise<void> {
    await this.exchange.drain();
  }

  getPosition(): PredictionPosition {
    if (this.positionBook === null) {
      throw new Error("no research snapshot has been processed");
    }
    return this.positionBook.get();
  }

  getExecutionRecords(): readonly OverlayPaperExecutionRecord[] {
    return structuredClone(this.executionRecords);
  }

  /** Read-only audit projection; it does not participate in order handling. */
  getPaperEvents(): readonly ExecutionEvent[] {
    return structuredClone(this.paperEvents);
  }

  /** Read-only post-fill position history for prospective reports. */
  getPositionRecords(): readonly PredictionPosition[] {
    return structuredClone(this.positionRecords);
  }

  private getProjectedShares(): number {
    let shares = this.positionBook!.get().shares;
    for (const { order } of this.pendingOrders.values()) {
      shares += order.side === "BUY" ? order.qty : -order.qty;
    }
    return round(shares, 6);
  }

  private onExecutionEvent(event: ExecutionEvent): void {
    this.paperEvents.push(structuredClone(event));
    if (event.type === "ORDER_ACK") {
      this.logger(formatOverlayAck(event.ack));
      return;
    }
    if (event.type !== "FILL") return;
    this.logger(formatOverlayFill(event.fill));
    const pending = this.pendingOrders.get(event.fill.clientOrderId);
    if (pending === undefined) throw new Error(`missing pending order ${event.fill.clientOrderId}`);
    const executionRecord: OverlayPaperExecutionRecord = {
      clientOrderId: event.fill.clientOrderId,
      side: event.fill.side,
      referencePrice: pending.referencePrice,
      fillPrice: event.fill.price,
      slippageBps: pending.slippageBps,
      fee: event.fill.fee,
      signalAt: pending.signalAt,
      submitAt: pending.submitAt,
      fillAt: event.fill.ts
    };
    this.executionRecords.push(executionRecord);
    this.logger(formatOverlayExecution(executionRecord));
    this.pendingOrders.delete(event.fill.clientOrderId);
    const position = this.positionBook!.applyFill(event.fill);
    this.positionRecords.push(structuredClone(position));
    this.logger(formatOverlayPosition(position));
  }
}

function stressedFillPrice(
  referencePrice: number,
  side: OrderRequest["side"],
  slippageBps: number
): number {
  const direction = side === "BUY" ? 1 : -1;
  return round(referencePrice * (1 + direction * slippageBps / 10_000));
}
