import { SimulatedExchange } from "../exchange.ts";
import type { FillDelay } from "../exchange.ts";
import { round } from "../math.ts";
import type { ExecutionEvent, Logger, OrderRequest } from "../types.ts";
import {
  formatOverlayAck,
  formatOverlayFill,
  formatOverlayPosition,
  formatOverlayRisk,
  formatOverlaySignal,
  formatPending,
  formatResearch,
  formatResearchPlan,
  formatShadowResult,
  formatTradeCandidate
} from "./logging.ts";
import { PredictionPositionBook } from "./position.ts";
import {
  DeterministicResearchRouter,
  DeterministicStrategyReviewer,
  MockResearchContext
} from "./research.ts";
import { OverlayRiskManager } from "./risk.ts";
import { MemePredictionOverlayStrategy } from "./strategy.ts";
import type {
  PredictionPosition,
  ResearchContext,
  ResearchRouter,
  ResearchSnapshot,
  ShadowResult,
  StrategyReviewer,
  TradeCandidate
} from "./types.ts";

export type MemePredictionOverlayBotConfig = {
  spotRiseTriggerPct: number;
  exitYesPrice: number;
  maxRiskBudget: number;
  fillDelayMs: FillDelay;
  logger?: Logger;
  shadow?: {
    router: ResearchRouter;
    context: ResearchContext;
    reviewer: StrategyReviewer;
  };
};

export class MemePredictionOverlayBot {
  private readonly strategy: MemePredictionOverlayStrategy;
  private readonly risk: OverlayRiskManager;
  private readonly exchange: SimulatedExchange;
  private readonly logger: Logger;
  private readonly router: ResearchRouter;
  private readonly researchContext: ResearchContext;
  private readonly reviewer: StrategyReviewer;
  private readonly shadowResults: Array<{ candidate: TradeCandidate; result: ShadowResult }> = [];
  private readonly pendingOrders = new Map<string, OrderRequest>();
  private nextClientOrderId = 1;
  private positionBook: PredictionPositionBook | null = null;

  constructor(config: MemePredictionOverlayBotConfig) {
    this.strategy = new MemePredictionOverlayStrategy(config);
    this.risk = new OverlayRiskManager({ maxRiskBudget: config.maxRiskBudget });
    this.exchange = new SimulatedExchange(config.fillDelayMs);
    this.logger = config.logger ?? console.log;
    this.router = config.shadow?.router ?? new DeterministicResearchRouter();
    this.researchContext = config.shadow?.context ?? new MockResearchContext([]);
    this.reviewer =
      config.shadow?.reviewer ??
      new DeterministicStrategyReviewer({
        verdict: "ABSTAIN",
        confidence: 0,
        moveValidity: "INSUFFICIENT_SOURCE",
        moveDecomposition: ["UNKNOWN"],
        sourceAgreement: "INSUFFICIENT",
        evidenceSourceIds: [],
        reason: "no shadow reviewer configured",
        catalystSupport: "UNKNOWN",
        entryQuality: "UNKNOWN",
        mispricingConfidence: "UNKNOWN",
        resolutionRisk: "UNKNOWN",
        dataQuality: "UNKNOWN"
      });
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
      let result: ShadowResult;
      try {
        const plan = this.router.route(candidate);
        const evidence = this.researchContext.research(plan);
        this.logger(formatResearchPlan(plan, evidence.length));
        result = this.reviewer.review(candidate, plan, evidence);
      } catch (error) {
        result = shadowErrorResult(error);
      }
      this.shadowResults.push({ candidate, result });
      this.logger(formatShadowResult(candidate.candidateId, result));
      // Current SHADOW safety boundary: AI reviews entries only and has no execution
      // authority. Deterministic exits bypass review; this is not a permanent strategy rule.
    }
    const decision = this.risk.evaluate(signal, projectedShares);
    this.logger(formatOverlayRisk(decision));
    if (!decision.approved) {
      return;
    }

    const clientOrderId = `OVERLAY-${this.nextClientOrderId++}`;
    this.pendingOrders.set(clientOrderId, decision.order);
    this.logger(formatPending(clientOrderId, decision.order));
    await this.exchange.submit({ clientOrderId, request: decision.order });
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

  getShadowResults(): readonly { candidate: TradeCandidate; result: ShadowResult }[] {
    return structuredClone(this.shadowResults);
  }

  private getProjectedShares(): number {
    let shares = this.positionBook!.get().shares;
    for (const order of this.pendingOrders.values()) {
      shares += order.side === "BUY" ? order.qty : -order.qty;
    }
    return round(shares, 6);
  }

  private onExecutionEvent(event: ExecutionEvent): void {
    if (event.type === "ORDER_ACK") {
      this.logger(formatOverlayAck(event.ack));
      return;
    }
    if (event.type !== "FILL") return;
    this.logger(formatOverlayFill(event.fill));
    this.pendingOrders.delete(event.fill.clientOrderId);
    const position = this.positionBook!.applyFill(event.fill);
    this.logger(formatOverlayPosition(position));
  }
}

function shadowErrorResult(error: unknown): ShadowResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    verdict: "ABSTAIN",
    confidence: 0,
    moveValidity: "INSUFFICIENT_SOURCE",
    moveDecomposition: ["UNKNOWN"],
    sourceAgreement: "INSUFFICIENT",
    evidenceSourceIds: [],
    reason: `shadow error: ${message}`,
    catalystSupport: "UNKNOWN",
    entryQuality: "UNKNOWN",
    mispricingConfidence: "UNKNOWN",
    resolutionRisk: "UNKNOWN",
    dataQuality: "UNKNOWN"
  };
}
