import {
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL,
  DerivativesTradingUsdsFutures,
  DerivativesTradingUsdsFuturesRestAPI
} from "@binance/derivatives-trading-usds-futures";

import type { ExecutionEvent, OrderRequest, SubmitOrderCommand, Tick } from "./types.ts";
import type { ExecutionEventHandler, ExecutionVenue } from "./exchange.ts";
import type { ExchangeStateSnapshot } from "./reconciliation.ts";
import { round } from "./math.ts";

type ErrorHandler = (error: unknown) => void;

export type BinanceUsdsEnvironment = "TESTNET" | "MAINNET";

export type BinanceUsdsEndpoints = {
  readonly rest: string;
  readonly websocketStreams: string;
};

export function binanceUsdsEndpoints(environment: BinanceUsdsEnvironment): BinanceUsdsEndpoints {
  return environment === "MAINNET"
    ? {
        rest: DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL,
        websocketStreams: DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL
      }
    : {
        rest: DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
        websocketStreams: DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL
      };
}

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
    z?: string;
    l?: string;
    L?: string;
    N?: string;
    n?: string;
    rp?: string;
    er?: string | number;
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

export interface BinanceUsdsTransport {
  loadSymbolRules(symbol: string): Promise<BinanceSymbolRules>;
  validateAccountMode(symbol: string): Promise<void>;
  connectUserData(handler: (update: BinanceOrderTradeUpdate) => void | Promise<void>): Promise<void>;
  submitMarketOrder(command: {
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    clientOrderId: string;
    reduceOnly?: boolean;
  }): Promise<void>;
  cancelOrder(command: { symbol: string; clientOrderId: string }): Promise<void>;
  loadSnapshot(symbol: string, canonicalSymbol: string): Promise<ExchangeStateSnapshot>;
  close(): Promise<void>;
}

export type BinanceMicroCapitalAccountStatus = {
  readonly canTrade: boolean;
  readonly multiAssetsMargin: boolean;
  readonly availableBalance: number;
  readonly nonFlatSymbols: readonly string[];
  readonly openOrderSymbols: readonly string[];
};

export type BinanceMarketSnapshot = {
  readonly lastPrice: number;
  readonly markPrice: number;
  readonly indexPrice: number;
  readonly observedAt: number;
};

export const AMBIGUOUS_SUBMIT_QUARANTINE_MS = 60_000;

export class AmbiguousOrderResultError extends Error {
  readonly clientOrderId: string;
  readonly cause: unknown;

  constructor(clientOrderId: string, cause: unknown) {
    super(`Binance market-order ${clientOrderId} remains UNKNOWN after quarantine; manual reconciliation is required`);
    this.name = "AmbiguousOrderResultError";
    this.clientOrderId = clientOrderId;
    this.cause = cause;
  }
}

export class OfficialBinanceUsdsTransport implements BinanceUsdsTransport {
  private readonly client: DerivativesTradingUsdsFutures;
  private readonly onError: ErrorHandler;
  readonly environment: BinanceUsdsEnvironment;
  private connection: any = null;
  private stream: any = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private userDataStreamOpen = false;

  constructor(config: {
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly environment: BinanceUsdsEnvironment;
    readonly onError?: ErrorHandler;
  }) {
    const { apiKey, apiSecret, environment } = config;
    if (apiKey.length === 0 || apiSecret.length === 0) {
      throw new Error(`Binance ${environment} API key and secret are required`);
    }
    this.environment = environment;
    this.onError = config.onError ?? console.error;
    const endpoints = binanceUsdsEndpoints(environment);
    this.client = new DerivativesTradingUsdsFutures({
      configurationRestAPI: {
        apiKey,
        apiSecret,
        basePath: endpoints.rest,
        timeout: 5_000,
        // A timed-out createOrder is ambiguous. Core must reconcile it; transport must not retry it.
        retries: 0
      },
      configurationWebsocketStreams: {
        wsURL: endpoints.websocketStreams,
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
      throw new Error(`Binance ${this.environment} account must use One-way Mode`);
    }
    const symbolConfig = (await symbolConfigResponse.data()).find((item) => item.symbol === symbol);
    if (String(symbolConfig?.marginType).toUpperCase() !== "ISOLATED") {
      throw new Error(`Binance ${this.environment} ${symbol} must use isolated margin`);
    }
  }

  async ensureIsolatedMarginWhenFlat(symbol: string): Promise<void> {
    const [positionModeResponse, symbolConfigResponse] = await Promise.all([
      this.client.restAPI.getCurrentPositionMode(),
      this.client.restAPI.symbolConfiguration({ symbol })
    ]);
    const positionMode = await positionModeResponse.data();
    if (positionMode.dualSidePosition !== false) {
      throw new Error(`Binance ${this.environment} account must use One-way Mode`);
    }
    const symbolConfig = (await symbolConfigResponse.data()).find((item) => item.symbol === symbol);
    if (String(symbolConfig?.marginType).toUpperCase() === "ISOLATED") return;

    const [positionsResponse, ordersResponse] = await Promise.all([
      this.client.restAPI.positionInformationV3({ symbol }),
      this.client.restAPI.currentAllOpenOrders({ symbol })
    ]);
    const positions = await positionsResponse.data();
    const orders = await ordersResponse.data();
    const hasPosition = positions.some((position) => position.symbol === symbol && Number(position.positionAmt) !== 0);
    const hasOpenOrders = orders.some((order) => order.symbol === symbol);
    if (hasPosition || hasOpenOrders) {
      throw new Error(`Binance ${this.environment} ${symbol} cannot switch to isolated margin with exposure or open orders`);
    }
    await this.client.restAPI.changeMarginType({ symbol, marginType: "ISOLATED" as never });
    await this.validateAccountMode(symbol);
  }

  async ensureInitialLeverageWhenFlat(symbol: string, leverage: number): Promise<void> {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
      throw new Error("Binance leverage must be an integer in 1..125");
    }
    const [positionsResponse, ordersResponse] = await Promise.all([
      this.client.restAPI.positionInformationV3({ symbol }),
      this.client.restAPI.currentAllOpenOrders({ symbol })
    ]);
    const positions = await positionsResponse.data();
    const orders = await ordersResponse.data();
    if (
      positions.some((position) => position.symbol === symbol && Number(position.positionAmt) !== 0) ||
      orders.some((order) => order.symbol === symbol)
    ) {
      throw new Error(`Binance ${this.environment} ${symbol} leverage cannot change with exposure or open orders`);
    }
    await this.client.restAPI.changeInitialLeverage({ symbol, leverage });
    const configs = await (await this.client.restAPI.symbolConfiguration({ symbol })).data();
    const actual = Number(configs.find((item) => item.symbol === symbol)?.leverage);
    if (actual !== leverage) {
      throw new Error(`Binance ${this.environment} ${symbol} leverage is ${actual}, expected ${leverage}`);
    }
  }

  async loadMicroCapitalAccountStatus(): Promise<BinanceMicroCapitalAccountStatus> {
    const [accountResponse, positionsResponse, ordersResponse] = await Promise.all([
      this.client.restAPI.accountInformationV2(),
      this.client.restAPI.positionInformationV3(),
      this.client.restAPI.currentAllOpenOrders()
    ]);
    const account = await accountResponse.data();
    const positions = await positionsResponse.data();
    const orders = await ordersResponse.data();
    return {
      canTrade: account.canTrade === true,
      multiAssetsMargin: account.multiAssetsMargin === true,
      availableBalance: nonNegativeNumber(account.availableBalance ?? "0", "available balance"),
      nonFlatSymbols: [...new Set(positions
        .filter((position) => Number(position.positionAmt) !== 0)
        .map((position) => requiredString(position.symbol, "position symbol")))].sort(),
      openOrderSymbols: [...new Set(orders
        .map((order) => requiredString(order.symbol, "open-order symbol")))].sort()
    };
  }

  async loadMarketSnapshot(symbol: string): Promise<BinanceMarketSnapshot> {
    const [lastResponse, markResponse] = await Promise.all([
      this.client.restAPI.symbolPriceTicker({ symbol }),
      this.client.restAPI.markPrice({ symbol })
    ]);
    const last = await lastResponse.data();
    const mark = await markResponse.data();
    if (Array.isArray(last) || Array.isArray(mark)) {
      throw new Error(`Binance ${this.environment} expected single-symbol market snapshots`);
    }
    return {
      lastPrice: positiveNumber(last.price, "last price"),
      markPrice: positiveNumber(mark.markPrice, "mark price"),
      indexPrice: positiveNumber(mark.indexPrice, "index price"),
      observedAt: Date.now()
    };
  }

  async hasHistoricalOrderPrefix(symbol: string, clientOrderPrefix: string, startTime: number): Promise<boolean> {
    const response = await this.client.restAPI.allOrders({ symbol, startTime, limit: 1_000 });
    const orders = await response.data();
    return orders.some((order) => String(order.clientOrderId ?? "").startsWith(clientOrderPrefix));
  }

  async connectUserData(handler: (update: BinanceOrderTradeUpdate) => void | Promise<void>): Promise<void> {
    if (this.connection !== null) throw new Error(`Binance ${this.environment} user stream is already connected`);
    const response = await this.client.restAPI.startUserDataStream();
    const { listenKey } = await response.data();
    if (typeof listenKey !== "string" || listenKey.length === 0) {
      throw new Error(`Binance ${this.environment} did not return a listen key`);
    }
    this.userDataStreamOpen = true;

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
    reduceOnly?: boolean;
  }): Promise<void> {
    try {
      await this.client.restAPI.newOrder({
        symbol: command.symbol,
        side: command.side === "BUY"
          ? DerivativesTradingUsdsFuturesRestAPI.NewOrderSideEnum.BUY
          : DerivativesTradingUsdsFuturesRestAPI.NewOrderSideEnum.SELL,
        type: DerivativesTradingUsdsFuturesRestAPI.NewOrderTypeEnum.MARKET,
        quantity: command.quantity,
        newClientOrderId: command.clientOrderId,
        newOrderRespType: DerivativesTradingUsdsFuturesRestAPI.NewOrderNewOrderRespTypeEnum.ACK,
        reduceOnly: command.reduceOnly === undefined
          ? undefined
          : command.reduceOnly
            ? DerivativesTradingUsdsFuturesRestAPI.NewOrderReduceOnlyEnum.TRUE
            : DerivativesTradingUsdsFuturesRestAPI.NewOrderReduceOnlyEnum.FALSE
      });
    } catch (error) {
      if (!isPotentiallyAmbiguousSubmitError(error)) throw error;
      let latestQueryError: unknown;
      const deadline = Date.now() + AMBIGUOUS_SUBMIT_QUARANTINE_MS;
      while (Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        try {
          await this.client.restAPI.queryOrder({
            symbol: command.symbol,
            origClientOrderId: command.clientOrderId
          });
          // The submit did reach Binance. ACK/Fill still come only from the user stream.
          return;
        } catch (queryError) {
          latestQueryError = queryError;
        }
      }
      throw new AmbiguousOrderResultError(command.clientOrderId, new AggregateError([error, latestQueryError]));
    }
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
    if (this.userDataStreamOpen) {
      this.userDataStreamOpen = false;
      await this.client.restAPI.closeUserDataStream().catch(this.onError);
    }
  }
}

export class BinanceUsdsVenue implements ExecutionVenue {
  private readonly canonicalSymbol: string;
  private readonly venueSymbol: string;
  private readonly transport: BinanceUsdsTransport;
  private readonly onError: ErrorHandler;
  private readonly submitted = new Map<string, OrderRequest>();
  private readonly emergencyClientOrderIds = new Set<string>();
  private handler: ExecutionEventHandler | null = null;
  private rules: BinanceSymbolRules | null = null;
  private eventTail: Promise<void> = Promise.resolve();

  constructor(config: {
    canonicalSymbol: string;
    venueSymbol: string;
    transport: BinanceUsdsTransport;
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
    if (this.rules === null) throw new Error("Binance venue must be started before submit");
    if (!/^[.A-Z:/a-z0-9_-]{1,36}$/.test(command.clientOrderId)) {
      throw new Error("Binance clientOrderId must match the exchange 1..36 character contract");
    }
    validateMarketOrder(command.request, this.rules);
    this.submitted.set(command.clientOrderId, command.request);
    await this.transport.submitMarketOrder({
      symbol: this.venueSymbol,
      side: command.request.side,
      quantity: command.request.qty,
      clientOrderId: command.clientOrderId,
      reduceOnly: command.request.reduceOnly
    });
  }

  async requestCancel(clientOrderId: string): Promise<void> {
    await this.transport.cancelOrder({ symbol: this.venueSymbol, clientOrderId });
  }

  async snapshot(): Promise<ExchangeStateSnapshot> {
    return this.transport.loadSnapshot(this.venueSymbol, this.canonicalSymbol);
  }

  /** Last-resort cleanup, sized from the authoritative venue snapshot. */
  async emergencyFlatten(referencePrice: number): Promise<ExchangeStateSnapshot> {
    const snapshot = await this.snapshot();
    if (snapshot.position.side === "FLAT") return snapshot;
    if (snapshot.openOrders.length > 0) {
      throw new Error("emergency flatten requires zero open orders; manual reconciliation required");
    }
    if (this.rules === null) throw new Error("Binance venue must be started before emergency flatten");
    const request: OrderRequest = {
      symbol: this.canonicalSymbol,
      side: snapshot.position.side === "LONG" ? "SELL" : "BUY",
      qty: snapshot.position.qty,
      price: referencePrice,
      reason: "BINANCE_EMERGENCY_REDUCE_ONLY_FLAT",
      ts: Date.now(),
      reduceOnly: true
    };
    validateMarketOrder(request, this.rules);
    const clientOrderId = `${safeSymbol(this.canonicalSymbol).slice(0, 8)}-E-${Date.now().toString(36)}`;
    this.submitted.set(clientOrderId, request);
    this.emergencyClientOrderIds.add(clientOrderId);
    await this.transport.submitMarketOrder({
      symbol: this.venueSymbol,
      side: request.side,
      quantity: request.qty,
      clientOrderId,
      reduceOnly: true
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() <= deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      const current = await this.snapshot();
      if (current.position.side === "FLAT" && current.openOrders.length === 0) return current;
    }
    throw new Error("emergency reduce-only flatten did not reconcile FLAT");
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
    if (this.emergencyClientOrderIds.has(clientOrderId)) {
      if (event.type === "ORDER_TERMINAL" || (event.type === "FILL" && update.o?.X === "FILLED")) {
        this.emergencyClientOrderIds.delete(clientOrderId);
        this.submitted.delete(clientOrderId);
      }
      return;
    }
    await this.handler?.(event);
    if (event.type === "ORDER_TERMINAL" || (event.type === "FILL" && update.o?.X === "FILLED")) {
      this.submitted.delete(clientOrderId);
    }
  }

  private owns(clientOrderId: string): boolean {
    return this.submitted.has(clientOrderId) || this.emergencyClientOrderIds.has(clientOrderId);
  }
}

export class BinanceUsdsMarketFeed {
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

  constructor(config: {
    canonicalSymbol: string;
    venueSymbol: string;
    environment: BinanceUsdsEnvironment;
    onError?: ErrorHandler;
  }) {
    this.canonicalSymbol = config.canonicalSymbol;
    this.venueSymbol = config.venueSymbol.toUpperCase();
    this.onError = config.onError ?? console.error;
    const endpoints = binanceUsdsEndpoints(config.environment);
    this.client = new DerivativesTradingUsdsFutures({
      configurationRestAPI: {
        apiKey: "",
        apiSecret: "",
        basePath: endpoints.rest,
        timeout: 5_000,
        retries: 2
      },
      configurationWebsocketStreams: {
        wsURL: endpoints.websocketStreams,
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
      reason: "restored from Binance user stream",
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
        ...(typeof order.N === "string" && order.N.length > 0 ? { feeAsset: order.N } : {}),
        ...(order.rp !== undefined ? { venueRealizedPnl: finiteNumber(order.rp, "realized profit") } : {}),
        ...(["CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"].includes(String(order.X))
          ? {
              terminalStatus: order.X as "CANCELED" | "EXPIRED" | "EXPIRED_IN_MATCH" | "REJECTED",
              ...(order.er !== undefined ? { terminalReason: String(order.er) } : {})
            }
          : {}),
        ts
      }
    };
  }

  if (["CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"].includes(String(order.X))) {
    const status = order.X as "CANCELED" | "EXPIRED" | "EXPIRED_IN_MATCH" | "REJECTED";
    return {
      type: "ORDER_TERMINAL",
      terminal: {
        clientOrderId,
        exchangeOrderId,
        status,
        ...(order.er !== undefined ? { reason: String(order.er) } : {}),
        ts
      }
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

function isPotentiallyAmbiguousSubmitError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const response = isRecord(error.response) ? error.response : undefined;
  const status = Number(response?.status ?? error.status);
  const code = String(error.code ?? "").toUpperCase();
  const message = String(error.message ?? "").toLowerCase();
  return status === 503 ||
    ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH"].includes(code) ||
    message.includes("timeout") || message.includes("timed out") || message.includes("socket hang up");
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

function finiteNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid Binance ${label}`);
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
