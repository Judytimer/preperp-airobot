export type PositionSide = "FLAT" | "LONG" | "SHORT";
export type OrderSide = "BUY" | "SELL";
export type SignalAction = "HOLD" | PositionSide;

export type Tick = {
  seq: number;
  symbol: string;
  /** Most recent trade price; strategy signals and simulated limit orders use this. */
  lastPrice: number;
  /** Fair price used for unrealized PnL, margin, and liquidation checks. */
  markPrice: number;
  /** External spot-basket reference price; recorded but not traded directly. */
  indexPrice: number;
  ts: number;
};

export type Signal = {
  action: SignalAction;
  /** Optional target quantity from an explicitly authorized PerpIntent. */
  targetQty?: number;
  shortMa: number | null;
  longMa: number | null;
  reason: string;
};

export type OrderRequest = {
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  /** Venue-enforced exposure reduction. Never inferred from an order reason. */
  reduceOnly?: boolean;
  reason: string;
  ts: number;
};

export type SubmitOrderCommand = {
  /** Generated and persisted by the client before the command crosses the venue boundary. */
  clientOrderId: string;
  request: OrderRequest;
};

export type OrderAck = {
  clientOrderId: string;
  exchangeOrderId: string;
  status: "ACKED";
  request: OrderRequest;
  ts: number;
};

export type OrderTerminalStatus = "CANCELED" | "EXPIRED" | "EXPIRED_IN_MATCH" | "REJECTED";

export type OrderTerminal = {
  clientOrderId: string;
  exchangeOrderId: string;
  status: OrderTerminalStatus;
  /** Venue-provided reason code, when one exists (for example Binance expiry reason). */
  reason?: string;
  ts: number;
};

export type Fill = {
  fillId: string;
  clientOrderId: string;
  exchangeOrderId: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  fee: number;
  /** The fee amount is only meaningful together with its asset. */
  feeAsset?: string;
  /** Venue-reported realized PnL for this fill, before commission. */
  venueRealizedPnl?: number;
  /** Some venues attach a terminal order status to the final trade event. */
  terminalStatus?: OrderTerminalStatus;
  terminalReason?: string;
  ts: number;
};

export type ExecutionEvent =
  | { type: "ORDER_ACK"; ack: OrderAck }
  | { type: "FILL"; fill: Fill }
  | { type: "ORDER_TERMINAL"; terminal: OrderTerminal };

export type FundingSettlement = {
  fundingId: string;
  symbol: string;
  rate: number;
  markPrice: number;
  ts: number;
};

export type Position = {
  symbol: string;
  side: PositionSide;
  qty: number;
  entryPrice: number;
  realizedPnl: number;
};

export type RiskDecision =
  | { approved: false; reason: string }
  | { approved: true; order: OrderRequest };

export type Logger = (line: string) => void;
