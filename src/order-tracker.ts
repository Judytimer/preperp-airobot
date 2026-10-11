import { round } from "./math.ts";
import type { Fill, OrderAck, OrderRequest, OrderSide, OrderTerminal } from "./types.ts";

export type InFlightOrderStatus =
  | "SUBMITTED"
  | "ACKED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "EXPIRED"
  | "EXPIRED_IN_MATCH"
  | "REJECTED";

export type InFlightOrder = {
  clientOrderId: string;
  exchangeOrderId: string | null;
  side: OrderSide;
  originalQty: number;
  filledQty: number;
  remainingQty: number;
  status: InFlightOrderStatus;
  /** Orthogonal intent: fills and late ACKs must not erase a requested cancellation. */
  cancelRequested: boolean;
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
      const legacy = item.order as InFlightOrder & { cancelRequested?: boolean };
      const legacyStatus = String(item.order.status);
      const cancelRequested = legacy.cancelRequested === true || legacyStatus === "CANCEL_REQUESTED";
      const status = legacyStatus === "CANCEL_REQUESTED"
        ? (legacy.filledQty > 0 ? "PARTIALLY_FILLED" : legacy.exchangeOrderId === null ? "SUBMITTED" : "ACKED")
        : legacyStatus as InFlightOrderStatus;
      tracker.orders.set(item.order.clientOrderId, {
        order: { ...item.order, status, cancelRequested }, symbol: item.symbol,
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
      originalQty: request.qty, filledQty: 0, remainingQty: request.qty, status: "SUBMITTED",
      cancelRequested: false
    };
    this.orders.set(clientOrderId, { order, symbol: request.symbol, processedFillIds: new Set() });
    return { ...order };
  }

  processAck(ack: OrderAck): InFlightOrder {
    const tracked = this.require(ack.clientOrderId);
    if (ack.request.symbol !== tracked.symbol || ack.request.side !== tracked.order.side ||
        ack.request.qty !== tracked.order.originalQty) {
      throw new Error(`acknowledgment does not match order ${ack.clientOrderId}`);
    }
    if (tracked.order.exchangeOrderId !== null && tracked.order.exchangeOrderId !== ack.exchangeOrderId) {
      throw new Error(`acknowledgment venue identity does not match order ${ack.clientOrderId}`);
    }
    tracked.order = {
      ...tracked.order,
      exchangeOrderId: ack.exchangeOrderId,
      status: tracked.order.status === "SUBMITTED" ? "ACKED" : tracked.order.status
    };
    return { ...tracked.order };
  }

  processFill(fill: Fill): FillProcessResult {
    const tracked = this.require(fill.clientOrderId);
    if (tracked.processedFillIds.has(fill.fillId)) return { accepted: false, order: { ...tracked.order } };
    if ((tracked.order.exchangeOrderId !== null && tracked.order.exchangeOrderId !== fill.exchangeOrderId) ||
        fill.symbol !== tracked.symbol ||
        fill.side !== tracked.order.side) {
      throw new Error(`fill ${fill.fillId} does not match order ${fill.clientOrderId}`);
    }

    const terminal = isTerminal(tracked.order.status);
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
      exchangeOrderId: fill.exchangeOrderId,
      filledQty,
      remainingQty,
      status: fill.terminalStatus ?? (terminal
        ? tracked.order.status
        : remainingQty === 0 ? "FILLED" : "PARTIALLY_FILLED")
    };
    tracked.processedFillIds.add(fill.fillId);
    return { accepted: true, order: { ...tracked.order } };
  }

  requestCancelOpenOrders(): InFlightOrder[] {
    const requested: InFlightOrder[] = [];
    for (const tracked of this.orders.values()) {
      if (!isTerminal(tracked.order.status) && !tracked.order.cancelRequested) {
        tracked.order = { ...tracked.order, cancelRequested: true };
        requested.push({ ...tracked.order });
      }
    }
    return requested;
  }

  processTerminal(terminal: OrderTerminal): InFlightOrder {
    const tracked = this.require(terminal.clientOrderId);
    if (
      tracked.order.exchangeOrderId !== null &&
      tracked.order.exchangeOrderId !== terminal.exchangeOrderId
    ) {
      throw new Error(`terminal event does not match order ${terminal.clientOrderId}`);
    }
    if (tracked.order.status === "FILLED") {
      throw new Error(`filled order ${terminal.clientOrderId} cannot become ${terminal.status}`);
    }
    if (isTerminal(tracked.order.status) && tracked.order.status !== terminal.status) {
      throw new Error(`order ${terminal.clientOrderId} has conflicting terminal states`);
    }
    tracked.order = {
      ...tracked.order,
      exchangeOrderId: terminal.exchangeOrderId,
      status: terminal.status
    };
    return { ...tracked.order };
  }

  get(clientOrderId: string): InFlightOrder | undefined {
    const tracked = this.orders.get(clientOrderId);
    return tracked === undefined ? undefined : { ...tracked.order };
  }

  getOpenOrders(): InFlightOrder[] {
    return [...this.orders.values()]
      .filter(({ order }) => !isTerminal(order.status))
      .map(({ order }) => ({ ...order }));
  }

  private require(clientOrderId: string): TrackedOrder {
    const tracked = this.orders.get(clientOrderId);
    if (tracked === undefined) throw new Error(`event belongs to unknown order ${clientOrderId}`);
    return tracked;
  }
}

function isTerminal(status: InFlightOrderStatus): boolean {
  return ["FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"].includes(status);
}
