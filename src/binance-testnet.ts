import {
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL,
  DerivativesTradingUsdsFutures
} from "@binance/derivatives-trading-usds-futures";

import type { ExecutionEvent, OrderRequest, SubmitOrderCommand, Tick } from "./types.ts";
import type { ExecutionEventHandler, ExecutionVenue } from "./exchange.ts";
import type { ExchangeStateSnapshot } from "./reconciliation.ts";
import { round } from "./math.ts";

type ErrorHandler = (error: unknown) => void;

export type BinanceOrderTradeUpdate = {
  e: "ORDER_TRADE_UPDATE";
  E?: number | bigint;
  T?: number | bigint;
  o?: {
    s?: string;
    c?: string;
    S?: string;
    x?: string;
    X?: string;
    i?: number | bigint;
    q?: string;
    p?: string;
    ap?: string;
    l?: string;
    L?: string;
    n?: string;
    T?: number | bigint;
    t?: number | bigint;
  };
};

export type BinanceSymbolRules = {
  symbol: string;
  status: string;
  marketOrderSupported: boolean;
  minQty: number;
  maxQty: number;
  stepSize: number;
  minNotional: number | null;
};

export interface BinanceTestnetTransport {
  loadSymbolRules(symbol: string): Promise<BinanceSymbolRules>;
  validateAccountMode(symbol: string): Promise<void>;
  connectUserData(handler: (update: BinanceOrderTradeUpdate) => void | Promise<void>): Promise<void>;
  submitMarketOrder(command: {
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    clientOrderId: string;
  }): Promise<void>;
  cancelOrder(command: { symbol: string; clientOrderId: string }): Promise<void>;
  loadSnapshot(symbol: string, canonicalSymbol: string): Promise<ExchangeStateSnapshot>;
  close(): Promise<void>;
}

export class OfficialBinanceUsdsTestnetTransport implements BinanceTestnetTransport {
  private readonly client: DerivativesTradingUsdsFutures;
  private readonly onError: ErrorHandler;
  private connection: any = null;
  private stream: any = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;

  constructor(apiKey: string, apiSecret: string, onError: ErrorHandler = console.error) {
    if (apiKey.length === 0 || apiSecret.length === 0) {
      throw new Error("Binance Testnet API key and secret are required");
    }
    this.onError = onError;
    this.client = new DerivativesTradingUsdsFutures({
      configurationRestAPI: {
        apiKey,
        apiSecret,
        basePath: DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
        timeout: 5_000,
        // A timed-out createOrder is ambiguous. Core must reconcile it; transport must not retry it.
        retries: 0
      },
      configurationWebsocketStreams: {
        wsURL: DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL,
        reconnectDelay: 5_000
      }
    });
  }

  async loadSymbolRules(symbol: string): Promise<BinanceSymbolRules> {
    const response = await this.client.restAPI.exchangeInformation();
    return parseSymbolRules(await response.data(), symbol);
  }

  async validateAccountMode(symbol: string): Promise<void> {
    const [positionModeResponse, symbolConfigResponse] = await Promise.all([
      this.client.restAPI.getCurrentPositionMode(),
      this.client.restAPI.symbolConfiguration({ symbol })
    ]);
    const positionMode = await positionModeResponse.data();
    if (positionMode.dualSidePosition !== false) {
      throw new Error("Binance Testnet account must use One-way Mode");
    }
    const symbolConfig = (await symbolConfigResponse.data()).find((item) => item.symbol === symbol);
    if (String(symbolConfig?.marginType).toUpperCase() !== "ISOLATED") {
      throw new Error(`Binance Testnet ${symbol} must use isolated margin`);
    }
  }

  async connectUserData(handler: (update: BinanceOrderTradeUpdate) => void | Promise<void>): Promise<void> {
    if (this.connection !== null) throw new Error("Binance Testnet user stream is already connected");
    const response = await this.client.restAPI.startUserDataStream();
    const { listenKey } = await response.data();
    if (typeof listenKey !== "string" || listenKey.length === 0) {
      throw new Error("Binance Testnet did not return a listen key");
    }

    this.connection = await this.client.websocketStreams.connect();
    this.stream = this.connection.userData(listenKey);
    this.stream.on("message", (data: unknown) => {
      if (isOrderTradeUpdate(data)) return handler(data);
    });
    this.keepaliveTimer = setInterval(() => {
      void this.client.restAPI.keepaliveUserDataStream().catch(this.onError);
    }, 45 * 60 * 1_000);
  }

  async submitMarketOrder(command: {
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    clientOrderId: string;
  }): Promise<void> {
    await this.client.restAPI.newOrder({
      symbol: command.symbol,
      side: command.side,
      type: "MARKET",
      quantity: command.quantity,
      newClientOrderId: command.clientOrderId,
      newOrderRespType: "ACK"
    });
  }

  async cancelOrder(command: { symbol: string; clientOrderId: string }): Promise<void> {
    await this.client.restAPI.cancelOrder({
      symbol: command.symbol,
      origClientOrderId: command.clientOrderId
    });
  }

  async loadSnapshot(symbol: string, canonicalSymbol: string): Promise<ExchangeStateSnapshot> {
    const [positionsResponse, ordersResponse] = await Promise.all([
      this.client.restAPI.positionInformationV3({ symbol }),
      this.client.restAPI.currentAllOpenOrders({ symbol })
    ]);
    const positions = await positionsResponse.data();
    const openOrders = await ordersResponse.data();
    const signedQty = round(positions.reduce((total, position) => {
      if (position.symbol !== symbol) return total;
      const qty = Number(position.positionAmt);
      if (!Number.isFinite(qty)) throw new Error("invalid Binance position amount");
      return total + qty;
    }, 0));
    const nonZero = positions.find((position) => position.symbol === symbol && Number(position.positionAmt) !== 0);
    return {
      position: {
        symbol: canonicalSymbol,
        side: signedQty > 0 ? "LONG" : signedQty < 0 ? "SHORT" : "FLAT",
        qty: Math.abs(signedQty),
        entryPrice: signedQty === 0 ? 0 : nonNegativeNumber(nonZero?.entryPrice ?? "0", "entry price"),
        realizedPnl: 0
      },
      openOrders: openOrders
        .filter((order) => order.symbol === symbol)
        .map((order) => {
          const original = positiveNumber(order.origQty, "original quantity");
          const executed = nonNegativeNumber(order.executedQty ?? "0", "executed quantity");
          const side = order.side === "BUY" || order.side === "SELL" ? order.side : fail("invalid Binance order side");
          return {
            orderId: requiredString(order.clientOrderId, "client order id"),
            side,
            remainingQty: Math.max(0, round(original - executed))
          };
        })
    };
  }

  async close(): Promise<void> {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.stream?.unsubscribe();
    this.stream = null;
    if (this.connection !== null) {
      await this.connection.disconnect();
      this.connection = null;
    }
    await this.client.restAPI.closeUserDataStream().catch(this.onError);
  }
}

export class BinanceUsdsTestnetVenue implements ExecutionVenue {
  private readonly canonicalSymbol: string;
  private readonly venueSymbol: string;
  private readonly transport: BinanceTestnetTransport;
  private readonly onError: ErrorHandler;
  private readonly submitted = new Map<string, OrderRequest>();
  private handler: ExecutionEventHandler | null = null;
  private rules: BinanceSymbolRules | null = null;
  private eventTail: Promise<void> = Promise.resolve();

  constructor(config: {
    canonicalSymbol: string;
    venueSymbol: string;
    transport: BinanceTestnetTransport;
    onError?: ErrorHandler;
  }) {
    this.canonicalSymbol = config.canonicalSymbol;
    this.venueSymbol = config.venueSymbol.toUpperCase();
    this.transport = config.transport;
    this.onError = config.onError ?? console.error;
  }

  onExecutionEvent(handler: ExecutionEventHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.handler === null) throw new Error("execution event handler must be registered before start");
    this.rules = await this.transport.loadSymbolRules(this.venueSymbol);
    await this.transport.validateAccountMode(this.venueSymbol);
    await this.transport.connectUserData((update) => {
      this.eventTail = this.eventTail
        .then(() => this.handleUpdate(update))
        .catch((error) => this.onError(error));
      return this.eventTail;
    });
  }

  async submit(command: SubmitOrderCommand): Promise<void> {
    if (command.request.symbol !== this.canonicalSymbol) {
      throw new Error(`order symbol ${command.request.symbol} does not match ${this.canonicalSymbol}`);
    }
    if (this.rules === null) throw new Error("Binance Testnet venue must be started before submit");
    validateMarketOrder(command.request, this.rules);
    this.submitted.set(command.clientOrderId, command.request);
    await this.transport.submitMarketOrder({
      symbol: this.venueSymbol,
      side: command.request.side,
      quantity: command.request.qty,
      clientOrderId: command.clientOrderId
    });
  }

  async requestCancel(clientOrderId: string): Promise<void> {
    await this.transport.cancelOrder({ symbol: this.venueSymbol, clientOrderId });
  }

  async snapshot(): Promise<ExchangeStateSnapshot> {
    return this.transport.loadSnapshot(this.venueSymbol, this.canonicalSymbol);
  }

  async close(): Promise<void> {
    await this.eventTail;
    await this.transport.close();
  }

  private async handleUpdate(update: BinanceOrderTradeUpdate): Promise<void> {
    const clientOrderId = update.o?.c;
    if (clientOrderId === undefined || !this.owns(clientOrderId)) return;
    const event = mapBinanceOrderUpdate(
      update,
      this.canonicalSymbol,
      this.venueSymbol,
      this.submitted.get(clientOrderId)
    );
    if (event === null) return;
    await this.handler?.(event);
    if (event.type === "CANCEL_ACK" || (event.type === "FILL" && update.o?.X === "FILLED")) {
      this.submitted.delete(clientOrderId);
    }
  }

  private owns(clientOrderId: string): boolean {
    return clientOrderId.startsWith(`${safeSymbol(this.canonicalSymbol)}-`);
  }
}

export class BinanceUsdsTestnetMarketFeed {
  private readonly canonicalSymbol: string;
  private readonly venueSymbol: string;
  private readonly client: DerivativesTradingUsdsFutures;
  private readonly onError: ErrorHandler;
  private connection: any = null;
  private streams: any[] = [];
  private lastPrice: number | null = null;
  private markPrice: number | null = null;
  private indexPrice: number | null = null;
  private nextSequence = 1;
  private tickTail: Promise<void> = Promise.resolve();

  constructor(config: { canonicalSymbol: string; venueSymbol: string; onError?: ErrorHandler }) {
    this.canonicalSymbol = config.canonicalSymbol;
    this.venueSymbol = config.venueSymbol.toUpperCase();
    this.onError = config.onError ?? console.error;
    this.client = new DerivativesTradingUsdsFutures({
      configurationRestAPI: {
        basePath: DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
        timeout: 5_000,
        retries: 2
      },
      configurationWebsocketStreams: {
        wsURL: DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL,
        reconnectDelay: 5_000
      }
    });
  }

  async start(onTick: (tick: Tick) => void | Promise<void>): Promise<void> {
    const [lastResponse, markResponse] = await Promise.all([
      this.client.restAPI.symbolPriceTicker({ symbol: this.venueSymbol }),
      this.client.restAPI.markPrice({ symbol: this.venueSymbol })
    ]);
    const last = await lastResponse.data();
    const mark = await markResponse.data();
    if (Array.isArray(last) || Array.isArray(mark)) throw new Error("expected single-symbol Binance market snapshots");
    this.lastPrice = positiveNumber(last.price, "last price");
    this.markPrice = positiveNumber(mark.markPrice, "mark price");
    this.indexPrice = positiveNumber(mark.indexPrice, "index price");

    this.connection = await this.client.websocketStreams.connect();
    const aggregateTrades = this.connection.aggregateTradeStreams({ symbol: this.venueSymbol.toLowerCase() });
    const markPrices = this.connection.markPriceStream({
      symbol: this.venueSymbol.toLowerCase(),
      updateSpeed: "1s"
    });
    this.streams = [aggregateTrades, markPrices];

    aggregateTrades.on("message", (data: any) => {
      if (data.s === this.venueSymbol) this.lastPrice = positiveNumber(data.p, "last price");
    });
    markPrices.on("message", (data: any) => {
      if (data.s !== this.venueSymbol) return;
      this.markPrice = positiveNumber(data.p, "mark price");
      this.indexPrice = positiveNumber(data.i, "index price");
      const tick: Tick = {
        seq: this.nextSequence++,
        symbol: this.canonicalSymbol,
        lastPrice: this.lastPrice!,
        markPrice: this.markPrice,
        indexPrice: this.indexPrice,
        ts: finiteTimestamp(data.E)
      };
      this.tickTail = this.tickTail.then(() => onTick(tick)).catch((error) => this.onError(error));
      return this.tickTail;
    });
  }

  async close(): Promise<void> {
    for (const stream of this.streams) stream.unsubscribe();
    this.streams = [];
    await this.tickTail;
    if (this.connection !== null) {
      await this.connection.disconnect();
      this.connection = null;
    }
  }
}

export function mapBinanceOrderUpdate(
  update: BinanceOrderTradeUpdate,
  canonicalSymbol: string,
  venueSymbol: string,
  submitted?: OrderRequest
): ExecutionEvent | null {
  const order = update.o;
  if (order === undefined || order.s !== venueSymbol) return null;
  const clientOrderId = requiredString(order.c, "client order id");
  const exchangeOrderId = String(order.i ?? "");
  if (exchangeOrderId.length === 0) throw new Error("Binance order update is missing order id");
  const side = order.S === "BUY" || order.S === "SELL" ? order.S : fail("invalid Binance order side");
  const ts = finiteTimestamp(order.T ?? update.T ?? update.E);

  if (order.x === "NEW" && order.X === "NEW") {
    const qty = positiveNumber(order.q, "original quantity");
    const request = submitted ?? {
      symbol: canonicalSymbol,
      side,
      qty,
      price: firstPositive(order.p, order.ap),
      reason: "restored from Binance Testnet user stream",
      ts
    };
    return {
      type: "ORDER_ACK",
      ack: { clientOrderId, exchangeOrderId, status: "ACKED", request, ts }
    };
  }

  if (order.x === "TRADE" && positiveNumber(order.l, "last filled quantity") > 0) {
    const tradeId = order.t;
    if (tradeId === undefined) throw new Error("Binance trade update is missing trade id");
    return {
      type: "FILL",
      fill: {
        fillId: `${venueSymbol}-TRADE-${String(tradeId)}`,
        clientOrderId,
        exchangeOrderId,
        symbol: canonicalSymbol,
        side,
        qty: positiveNumber(order.l, "last filled quantity"),
        price: positiveNumber(order.L, "last filled price"),
        fee: nonNegativeNumber(order.n ?? "0", "commission"),
        ts
      }
    };
  }

  if (order.x === "CANCELED" && order.X === "CANCELED") {
    return {
      type: "CANCEL_ACK",
      ack: { clientOrderId, exchangeOrderId, status: "CANCELED", ts }
    };
  }

  return null;
}

export function parseSymbolRules(exchangeInfo: unknown, symbol: string): BinanceSymbolRules {
  if (!isRecord(exchangeInfo) || !Array.isArray(exchangeInfo.symbols)) {
    throw new Error("invalid Binance exchange information");
  }
  const entry = exchangeInfo.symbols.find((item) => isRecord(item) && item.symbol === symbol);
  if (!isRecord(entry) || !Array.isArray(entry.filters)) throw new Error(`Binance symbol ${symbol} was not found`);
  const filters = entry.filters.filter(isRecord);
  const lot = filters.find((filter) => filter.filterType === "MARKET_LOT_SIZE") ??
    filters.find((filter) => filter.filterType === "LOT_SIZE");
  if (!isRecord(lot)) throw new Error(`Binance symbol ${symbol} has no market lot-size filter`);
  const notional = filters.find((filter) => filter.filterType === "MIN_NOTIONAL");
  const orderTypes = Array.isArray(entry.orderTypes) ? entry.orderTypes : [];
  return {
    symbol,
    status: requiredString(entry.status, "symbol status"),
    marketOrderSupported: orderTypes.includes("MARKET"),
    minQty: positiveNumber(lot.minQty, "minimum quantity"),
    maxQty: positiveNumber(lot.maxQty, "maximum quantity"),
    stepSize: positiveNumber(lot.stepSize, "quantity step size"),
    minNotional: isRecord(notional) ? positiveNumber(notional.notional, "minimum notional") : null
  };
}

export function validateMarketOrder(order: OrderRequest, rules: BinanceSymbolRules): void {
  if (rules.status !== "TRADING") throw new Error(`Binance symbol ${rules.symbol} is not TRADING`);
  if (!rules.marketOrderSupported) throw new Error(`Binance symbol ${rules.symbol} does not support MARKET orders`);
  if (order.qty < rules.minQty || order.qty > rules.maxQty) {
    throw new Error(`quantity ${order.qty} is outside Binance range ${rules.minQty}..${rules.maxQty}`);
  }
  const steps = order.qty / rules.stepSize;
  if (Math.abs(steps - Math.round(steps)) > 1e-8) {
    throw new Error(`quantity ${order.qty} is not aligned to Binance step ${rules.stepSize}`);
  }
  if (rules.minNotional !== null && order.qty * order.price < rules.minNotional) {
    throw new Error(`estimated notional ${order.qty * order.price} is below Binance minimum ${rules.minNotional}`);
  }
}

function isOrderTradeUpdate(value: unknown): value is BinanceOrderTradeUpdate {
  return isRecord(value) && value.e === "ORDER_TRADE_UPDATE";
}

function safeSymbol(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9_-]/g, "_");
}

function finiteTimestamp(value: unknown): number {
  const timestamp = typeof value === "bigint" ? Number(value) : value;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.now();
}

function firstPositive(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  throw new Error("Binance order update has no positive reference price");
}

function positiveNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid Binance ${label}`);
  return parsed;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid Binance ${label}`);
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid Binance ${label}`);
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
