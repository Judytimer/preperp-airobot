import { round } from "./math.ts";
import type {
  ExecutionEvent,
  OrderAck,
  OrderRequest,
  SubmitOrderCommand
} from "./types.ts";

export type ExecutionEventHandler = (event: ExecutionEvent) => void | Promise<void>;

/** Command boundary. Executions are delivered only through the registered event handler. */
export interface ExecutionVenue {
  onExecutionEvent(handler: ExecutionEventHandler): void;
  /** Completion only reports that the transport command finished; ACK is an ExecutionEvent fact. */
  submit(command: SubmitOrderCommand): Promise<void>;
  requestCancel(clientOrderId: string): Promise<void>;
}

export type FillDelay = number | ((exchangeOrderId: string, order: OrderRequest) => number);
export type FillPlanStep = { fraction: number; delayMs: number };

/** Paper adapter. drain() is deliberately simulator-only test/lifecycle control. */
export class SimulatedExchange implements ExecutionVenue {
  private readonly fillDelayMs: FillDelay;
  private readonly feeRate: number;
  private readonly fillPlan?: readonly FillPlanStep[];
  private nextExchangeOrderId = 1;
  private handler: ExecutionEventHandler | undefined;
  private readonly pending = new Set<Promise<void>>();
  private readonly orders = new Map<string, {
    exchangeOrderId: string;
    request: OrderRequest;
    executedQty: number;
    status: "OPEN" | "CANCELED" | "FILLED";
  }>();

  constructor(
    fillDelayMs: FillDelay,
    feeRate = 0.0004,
    fillPlan?: readonly FillPlanStep[]
  ) {
    this.fillDelayMs = fillDelayMs;
    this.feeRate = feeRate;
    this.fillPlan = fillPlan;
    validateFillPlan(fillPlan);
  }

  onExecutionEvent(handler: ExecutionEventHandler): void {
    this.handler = handler;
  }

  async submit(command: SubmitOrderCommand): Promise<void> {
    const exchangeOrderId = `SIM-${this.nextExchangeOrderId++}`;
    this.orders.set(command.clientOrderId, {
      exchangeOrderId,
      request: command.request,
      executedQty: 0,
      status: "OPEN"
    });
    const ack: OrderAck = {
      clientOrderId: command.clientOrderId,
      exchangeOrderId,
      status: "ACKED",
      request: command.request,
      ts: Date.now()
    };
    await this.emit({ type: "ORDER_ACK", ack });
    this.scheduleFills(command, exchangeOrderId);
  }

  async requestCancel(clientOrderId: string): Promise<void> {
    const order = this.orders.get(clientOrderId);
    if (order === undefined) throw new Error(`cannot cancel unknown order ${clientOrderId}`);
    if (order.status !== "OPEN") {
      throw new Error(`cannot cancel ${order.status.toLowerCase()} order ${clientOrderId}`);
    }
    order.status = "CANCELED";
    await this.emit({
      type: "CANCEL_ACK",
      ack: { clientOrderId, exchangeOrderId: order.exchangeOrderId, status: "CANCELED", ts: Date.now() }
    });
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private scheduleFills(command: SubmitOrderCommand, exchangeOrderId: string): void {
    const delay = typeof this.fillDelayMs === "function"
      ? this.fillDelayMs(exchangeOrderId, command.request)
      : this.fillDelayMs;
    const plan = this.fillPlan ?? [{ fraction: 1, delayMs: delay }];
    let allocatedQty = 0;
    plan.forEach((step, index) => {
      const qty = index === plan.length - 1
        ? round(command.request.qty - allocatedQty)
        : round(command.request.qty * step.fraction);
      allocatedQty = round(allocatedQty + qty);
      const task = new Promise<void>((resolve) => setTimeout(resolve, step.delayMs)).then(async () => {
        const venueOrder = this.orders.get(command.clientOrderId);
        if (venueOrder === undefined) throw new Error(`missing simulated order ${command.clientOrderId}`);
        if (venueOrder.status === "CANCELED") return;
        venueOrder.executedQty = round(venueOrder.executedQty + qty);
        if (venueOrder.executedQty === command.request.qty) venueOrder.status = "FILLED";
        await this.emit({
          type: "FILL",
          fill: {
            fillId: `${exchangeOrderId}-FILL-${index + 1}`,
            clientOrderId: command.clientOrderId,
            exchangeOrderId,
            symbol: command.request.symbol,
            side: command.request.side,
            qty,
            price: command.request.price,
            fee: qty * command.request.price * this.feeRate,
            ts: Date.now()
          }
        });
      });
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    });
  }

  private async emit(event: ExecutionEvent): Promise<void> {
    if (this.handler === undefined) throw new Error("execution event handler is not registered");
    await this.handler(event);
  }
}

function validateFillPlan(fillPlan?: readonly FillPlanStep[]): void {
  if (fillPlan === undefined) return;
  if (fillPlan.length === 0) throw new Error("fillPlan must contain at least one step");
  const total = fillPlan.reduce((sum, step) => {
    if (step.fraction <= 0 || step.delayMs < 0) {
      throw new Error("fillPlan fractions must be positive and delays must be non-negative");
    }
    return sum + step.fraction;
  }, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error("fillPlan fractions must sum to 1");
}
