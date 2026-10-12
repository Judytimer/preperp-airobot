import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PerpBot } from "./bot.ts";
import { SimulatedExchange } from "./exchange.ts";
import type { ExecutionEventHandler, ExecutionVenue } from "./exchange.ts";
import type { MarginSnapshot } from "./margin.ts";
import { round } from "./math.ts";
import type { PerpSignalSource } from "./strategy.ts";
import type {
  ExecutionEvent,
  Position,
  Signal,
  SignalAction,
  SubmitOrderCommand,
  Tick
} from "./types.ts";

export const PERP_EXECUTION_VALIDATION_PROTOCOL_VERSION = "1.0.0";

type CheckStatus = "PASS" | "FAIL";

export type PerpExecutionValidationReport = {
  readonly protocolVersion: typeof PERP_EXECUTION_VALIDATION_PROTOCOL_VERSION;
  readonly mode: "DETERMINISTIC_PAPER";
  readonly overall: CheckStatus;
  readonly checks: {
    readonly orderLifecycle: {
      readonly status: CheckStatus;
      readonly submissions: number;
      readonly acknowledgements: number;
      readonly fills: number;
      readonly partialFillOrders: number;
    };
    readonly positionRoundTrip: {
      readonly status: CheckStatus;
      readonly afterOpen: Position;
      readonly afterClose: Position;
    };
    readonly pnl: {
      readonly status: CheckStatus;
      readonly grossTradingPnl: number;
      readonly fees: number;
      readonly fundingPayment: number;
      readonly expectedRealizedPnl: number;
      readonly actualRealizedPnl: number;
    };
    readonly funding: {
      readonly status: CheckStatus;
      readonly beforeRealizedPnl: number;
      readonly afterRealizedPnl: number;
      readonly duplicateWasIdempotent: boolean;
    };
    readonly marginPreflight: {
      readonly status: CheckStatus;
      readonly submissions: number;
      readonly position: Position;
      readonly equity: number;
      readonly requiredInitialMargin: number;
    };
    readonly liquidationBoundary: {
      readonly status: CheckStatus;
      readonly theoreticalBoundaryMark: number;
      readonly safeMark: number;
      readonly safeSnapshot: MarginSnapshot;
      readonly triggerMark: number;
      readonly finalPosition: Position;
      readonly liquidationObserved: boolean;
    };
  };
  readonly limitations: readonly string[];
};

/**
 * Explicit execution target used only by the validation harness. It is not an
 * alpha model: the runner owns when LONG, FLAT, or HOLD is emitted.
 */
export class ExecutionValidationSignal implements PerpSignalSource {
  private action: SignalAction = "HOLD";

  setTarget(action: Extract<SignalAction, "HOLD" | "LONG" | "SHORT" | "FLAT">): void {
    this.action = action;
  }

  onTick(_tick: Tick): Signal {
    return {
      action: this.action,
      shortMa: null,
      longMa: null,
      reason: `execution validation target ${this.action}`
    };
  }
}

export async function runPaperPerpExecutionValidation(): Promise<PerpExecutionValidationReport> {
  const roundTrip = await validateRoundTrip();
  const marginPreflight = await validateMarginPreflight();
  const liquidationBoundary = await validateLiquidationBoundary();
  const checks = {
    orderLifecycle: roundTrip.orderLifecycle,
    positionRoundTrip: roundTrip.positionRoundTrip,
    pnl: roundTrip.pnl,
    funding: roundTrip.funding,
    marginPreflight,
    liquidationBoundary
  };
  const overall = Object.values(checks).every((check) => check.status === "PASS")
    ? "PASS"
    : "FAIL";
  return {
    protocolVersion: PERP_EXECUTION_VALIDATION_PROTOCOL_VERSION,
    mode: "DETERMINISTIC_PAPER",
    overall,
    checks,
    limitations: [
      "This phase validates deterministic Core semantics, not exchange connectivity.",
      "Simulated fills do not prove real spread, depth, latency, fees, funding delivery, or venue liquidation.",
      "Authenticated Testnet and explicitly authorized micro-capital runs require separate evidence reports."
    ]
  };
}

async function validateRoundTrip(): Promise<Pick<PerpExecutionValidationReport["checks"],
  "orderLifecycle" | "positionRoundTrip" | "pnl" | "funding">> {
  const signal = new ExecutionValidationSignal();
  const venue = new RecordingExecutionVenue(
    new SimulatedExchange(0, 0.001, [
      { fraction: 0.4, delayMs: 0 },
      { fraction: 0.6, delayMs: 1 }
    ])
  );
  const bot = new PerpBot({
    symbol: "BTC-PERP",
    signalSource: signal,
    orderQty: 1,
    maxAbsPosition: 1,
    margin: { collateral: 100, leverage: 5, maintenanceMarginRate: 0.05 },
    venue,
    logger: () => {}
  });

  signal.setTarget("LONG");
  await bot.onTick(tick(1, 100));
  await venue.drain();
  const afterOpen = bot.getPosition();
  const beforeFunding = afterOpen.realizedPnl;

  const funding = {
    fundingId: "VALIDATION-FUNDING-1",
    symbol: "BTC-PERP",
    rate: 0.001,
    markPrice: 100,
    ts: 2
  } as const;
  await bot.onFunding(funding);
  const afterFunding = bot.getPosition().realizedPnl;
  await bot.onFunding(funding);
  const afterDuplicateFunding = bot.getPosition().realizedPnl;

  signal.setTarget("FLAT");
  await bot.onTick(tick(2, 110, 108, 109));
  await venue.drain();
  const afterClose = bot.getPosition();

  const submissions = venue.getSubmissions();
  const events = venue.getEvents();
  const acknowledgements = events.filter((event) => event.type === "ORDER_ACK");
  const fills = events.filter((event): event is Extract<ExecutionEvent, { type: "FILL" }> =>
    event.type === "FILL"
  );
  const partialFillOrders = submissions.filter((submission) => {
    const orderFills = fills.filter((event) => event.fill.clientOrderId === submission.clientOrderId);
    const filledQty = sum(orderFills.map((event) => event.fill.qty));
    return orderFills.length > 1 && approximatelyEqual(filledQty, submission.request.qty);
  }).length;
  const orderLifecyclePass =
    submissions.length === 2 &&
    acknowledgements.length === 2 &&
    fills.length === 4 &&
    partialFillOrders === 2;

  const grossTradingPnl = 10;
  const fees = round(sum(fills.map((event) => event.fill.fee)));
  const fundingPayment = afterFunding - beforeFunding;
  const expectedRealizedPnl = grossTradingPnl - fees + fundingPayment;
  const actualRealizedPnl = afterClose.realizedPnl;
  const positionPass =
    afterOpen.side === "LONG" &&
    afterOpen.qty === 1 &&
    afterOpen.entryPrice === 100 &&
    afterClose.side === "FLAT" &&
    afterClose.qty === 0;
  const fundingPass =
    approximatelyEqual(fundingPayment, -0.1) &&
    approximatelyEqual(afterFunding, afterDuplicateFunding);
  const pnlPass = approximatelyEqual(expectedRealizedPnl, actualRealizedPnl);

  return {
    orderLifecycle: {
      status: status(orderLifecyclePass),
      submissions: submissions.length,
      acknowledgements: acknowledgements.length,
      fills: fills.length,
      partialFillOrders
    },
    positionRoundTrip: {
      status: status(positionPass),
      afterOpen,
      afterClose
    },
    pnl: {
      status: status(pnlPass),
      grossTradingPnl,
      fees,
      fundingPayment,
      expectedRealizedPnl,
      actualRealizedPnl
    },
    funding: {
      status: status(fundingPass),
      beforeRealizedPnl: beforeFunding,
      afterRealizedPnl: afterFunding,
      duplicateWasIdempotent: approximatelyEqual(afterFunding, afterDuplicateFunding)
    }
  };
}

async function validateMarginPreflight(): Promise<PerpExecutionValidationReport["checks"]["marginPreflight"]> {
  const signal = new ExecutionValidationSignal();
  const venue = new RecordingExecutionVenue(new SimulatedExchange(0, 0));
  const bot = new PerpBot({
    symbol: "BTC-PERP",
    signalSource: signal,
    orderQty: 1,
    maxAbsPosition: 1,
    margin: { collateral: 1, leverage: 2, maintenanceMarginRate: 0.05 },
    venue,
    logger: () => {}
  });
  signal.setTarget("LONG");
  await bot.onTick(tick(1, 100));
  const position = bot.getPosition();
  const account = requiredAccount(bot);
  const requiredInitialMargin = 50;
  const pass =
    venue.getSubmissions().length === 0 &&
    position.side === "FLAT" &&
    account.equity < requiredInitialMargin;
  return {
    status: status(pass),
    submissions: venue.getSubmissions().length,
    position,
    equity: account.equity,
    requiredInitialMargin
  };
}

async function validateLiquidationBoundary(): Promise<PerpExecutionValidationReport["checks"]["liquidationBoundary"]> {
  const logs: string[] = [];
  const signal = new ExecutionValidationSignal();
  const venue = new RecordingExecutionVenue(new SimulatedExchange(0, 0));
  const bot = new PerpBot({
    symbol: "BTC-PERP",
    signalSource: signal,
    orderQty: 1,
    maxAbsPosition: 1,
    margin: { collateral: 10, leverage: 10, maintenanceMarginRate: 0.05 },
    venue,
    logger: (line) => logs.push(line)
  });
  signal.setTarget("LONG");
  await bot.onTick(tick(1, 100));
  await venue.drain();

  const theoreticalBoundaryMark = 90 / 0.95;
  const safeMark = 94.74;
  signal.setTarget("HOLD");
  await bot.onTick(tick(2, 100, safeMark, safeMark));
  const safeSnapshot = requiredAccount(bot);

  const triggerMark = 94.73;
  await bot.onTick(tick(3, 100, triggerMark, triggerMark));
  const finalPosition = bot.getPosition();
  const liquidationObserved = logs.some((line) => line.startsWith("[LIQUIDATION]"));
  const pass =
    safeMark > theoreticalBoundaryMark &&
    !safeSnapshot.liquidatable &&
    triggerMark < theoreticalBoundaryMark &&
    liquidationObserved &&
    finalPosition.side === "FLAT";
  return {
    status: status(pass),
    theoreticalBoundaryMark,
    safeMark,
    safeSnapshot,
    triggerMark,
    finalPosition,
    liquidationObserved
  };
}

class RecordingExecutionVenue implements ExecutionVenue {
  private handler: ExecutionEventHandler | undefined;
  private readonly submissions: SubmitOrderCommand[] = [];
  private readonly events: ExecutionEvent[] = [];
  private readonly inner: SimulatedExchange;

  constructor(inner: SimulatedExchange) {
    this.inner = inner;
    inner.onExecutionEvent(async (event) => {
      if (this.handler === undefined) throw new Error("validation venue has no execution handler");
      await this.handler(event);
      this.events.push(structuredClone(event));
    });
  }

  onExecutionEvent(handler: ExecutionEventHandler): void {
    if (this.handler !== undefined) throw new Error("validation venue handler is already registered");
    this.handler = handler;
  }

  async submit(command: SubmitOrderCommand): Promise<void> {
    this.submissions.push(structuredClone(command));
    await this.inner.submit(command);
  }

  async requestCancel(clientOrderId: string): Promise<void> {
    await this.inner.requestCancel(clientOrderId);
  }

  async drain(): Promise<void> {
    await this.inner.drain();
  }

  getSubmissions(): readonly SubmitOrderCommand[] {
    return structuredClone(this.submissions);
  }

  getEvents(): readonly ExecutionEvent[] {
    return structuredClone(this.events);
  }
}

function tick(seq: number, lastPrice: number, markPrice = lastPrice, indexPrice = markPrice): Tick {
  return { seq, symbol: "BTC-PERP", lastPrice, markPrice, indexPrice, ts: seq };
}

function requiredAccount(bot: PerpBot): MarginSnapshot {
  const snapshot = bot.getAccountSnapshot();
  if (snapshot === null) throw new Error("validation account snapshot is missing");
  return snapshot;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

function status(pass: boolean): CheckStatus {
  return pass ? "PASS" : "FAIL";
}

async function main(): Promise<void> {
  const report = await runPaperPerpExecutionValidation();
  console.log("[PERP_EXECUTION_VALIDATION]", JSON.stringify(report));
  if (report.overall !== "PASS") process.exitCode = 1;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
