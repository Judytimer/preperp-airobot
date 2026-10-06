import { round } from "./math.ts";
import type { CancelAck, Fill, OrderAck, OrderRequest, OrderSide } from "./types.ts";

export type InFlightOrderStatus =
  | "SUBMITTED"
  | "ACKED"
  | "PARTIALLY_FILLED"
  | "CANCEL_REQUESTED"
  | "FILLED"
  | "CANCELED";

export type InFlightOrder = {
  clientOrderId: string;
  exchangeOrderId: string | null;
  side: OrderSide;
  originalQty: number;
  filledQty: number;
  remainingQty: number;
  status: InFlightOrderStatus;
};

export type FillProcessResult = { accepted: boolean; order: InFlightOrder };
type TrackedOrder = { order: InFlightOrder; symbol: string; processedFillIds: Set<string> };
export type OrderTrackerState = { orders: Array<{
  order: InFlightOrder;
  symbol: string;
  processedFillIds: string[];
}> };

export class InFlightOrderTracker {
  private readonly orders = new Map<string, TrackedOrder>();

  static fromState(state: OrderTrackerState): InFlightOrderTracker {
    const tracker = new InFlightOrderTracker();
    for (const item of state.orders) {
      if (tracker.orders.has(item.order.clientOrderId)) {
        throw new Error(`duplicate restored order ${item.order.clientOrderId}`);
      }
      tracker.orders.set(item.order.clientOrderId, {
        order: { ...item.order }, symbol: item.symbol,
        processedFillIds: new Set(item.processedFillIds)
      });
    }
    return tracker;
  }

  exportState(): OrderTrackerState {
    return { orders: [...this.orders.values()].map((tracked) => ({
      order: { ...tracked.order }, symbol: tracked.symbol,
      processedFillIds: [...tracked.processedFillIds]
    })) };
  }

  trackSubmission(clientOrderId: string, request: OrderRequest): InFlightOrder {
    if (this.orders.has(clientOrderId)) throw new Error(`order ${clientOrderId} is already tracked`);
    const order: InFlightOrder = {
      clientOrderId, exchangeOrderId: null, side: request.side,
      originalQty: request.qty, filledQty: 0, remainingQty: request.qty, status: "SUBMITTED"
    };
    this.orders.set(clientOrderId, { order, symbol: request.symbol, processedFillIds: new Set() });
    return { ...order };
  }

  processAck(ack: OrderAck): InFlightOrder {
    const tracked = this.require(ack.clientOrderId);
    if (tracked.order.status !== "SUBMITTED") {
      throw new Error(`order ${ack.clientOrderId} is not awaiting acknowledgment`);
    }
    if (ack.request.symbol !== tracked.symbol || ack.request.side !== tracked.order.side ||
        ack.request.qty !== tracked.order.originalQty) {
      throw new Error(`acknowledgment does not match order ${ack.clientOrderId}`);
    }
    tracked.order = { ...tracked.order, exchangeOrderId: ack.exchangeOrderId, status: "ACKED" };
    return { ...tracked.order };
  }

  processFill(fill: Fill): FillProcessResult {
    const tracked = this.require(fill.clientOrderId);
    if (tracked.processedFillIds.has(fill.fillId)) return { accepted: false, order: { ...tracked.order } };
    if (tracked.order.exchangeOrderId !== fill.exchangeOrderId || fill.symbol !== tracked.symbol ||
        fill.side !== tracked.order.side) {
      throw new Error(`fill ${fill.fillId} does not match order ${fill.clientOrderId}`);
    }

    const terminal = tracked.order.status === "CANCELED" || tracked.order.status === "FILLED";
    const fillBudget = terminal
      ? round(tracked.order.originalQty - tracked.order.filledQty)
      : tracked.order.remainingQty;
    if (fill.qty <= 0 || fill.qty > fillBudget) {
      throw new Error(`fill ${fill.fillId} exceeds remaining quantity`);
    }

    const filledQty = round(tracked.order.filledQty + fill.qty);
    const remainingQty = round(tracked.order.originalQty - filledQty);
    tracked.order = {
      ...tracked.order,
      filledQty,
      remainingQty,
      status: terminal
        ? tracked.order.status
        : remainingQty === 0 ? "FILLED" : "PARTIALLY_FILLED"
    };
    tracked.processedFillIds.add(fill.fillId);
    return { accepted: true, order: { ...tracked.order } };
  }

  requestCancelOpenOrders(): InFlightOrder[] {
    const requested: InFlightOrder[] = [];
    for (const tracked of this.orders.values()) {
      if (["SUBMITTED", "ACKED", "PARTIALLY_FILLED"].includes(tracked.order.status)) {
        tracked.order = { ...tracked.order, status: "CANCEL_REQUESTED" };
        requested.push({ ...tracked.order });
      }
    }
    return requested;
  }

  processCancelAck(ack: CancelAck): InFlightOrder {
    const tracked = this.require(ack.clientOrderId);
    if (tracked.order.status !== "CANCEL_REQUESTED") {
      throw new Error(`order ${ack.clientOrderId} is not awaiting cancel confirmation`);
    }
    if (
      tracked.order.exchangeOrderId !== null &&
      tracked.order.exchangeOrderId !== ack.exchangeOrderId
    ) {
      throw new Error(`cancel acknowledgment does not match order ${ack.clientOrderId}`);
    }
    tracked.order = {
      ...tracked.order,
      exchangeOrderId: ack.exchangeOrderId,
      status: "CANCELED"
    };
    return { ...tracked.order };
  }

  get(clientOrderId: string): InFlightOrder | undefined {
    const tracked = this.orders.get(clientOrderId);
    return tracked === undefined ? undefined : { ...tracked.order };
  }

  getOpenOrders(): InFlightOrder[] {
    return [...this.orders.values()]
      .filter(({ order }) => ["SUBMITTED", "ACKED", "PARTIALLY_FILLED", "CANCEL_REQUESTED"].includes(order.status))
      .map(({ order }) => ({ ...order }));
  }

  private require(clientOrderId: string): TrackedOrder {
    const tracked = this.orders.get(clientOrderId);
    if (tracked === undefined) throw new Error(`event belongs to unknown order ${clientOrderId}`);
    return tracked;
  }
}
