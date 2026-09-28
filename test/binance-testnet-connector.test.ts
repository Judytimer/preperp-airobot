import assert from "node:assert/strict";
import test from "node:test";

import {
  BinanceUsdsTestnetVenue,
  mapBinanceOrderUpdate,
  parseSymbolRules,
  validateMarketOrder
} from "../src/binance-testnet.ts";
import type {
  BinanceOrderTradeUpdate,
  BinanceSymbolRules,
  BinanceTestnetTransport
} from "../src/binance-testnet.ts";
import type { ExecutionEvent, OrderRequest } from "../src/types.ts";

test("maps Binance NEW, TRADE, and CANCELED updates into canonical execution facts", () => {
  const request = order();
  assert.equal(mapBinanceOrderUpdate(update("NEW", "NEW"), "BTC-PERP", "BTCUSDT", request)?.type, "ORDER_ACK");
  const fill = mapBinanceOrderUpdate(update("TRADE", "PARTIALLY_FILLED"), "BTC-PERP", "BTCUSDT", request);
  assert.deepEqual(fill, {
    type: "FILL",
    fill: {
      fillId: "BTCUSDT-TRADE-77",
      clientOrderId: "BTC-PERP-1",
      exchangeOrderId: "42",
      symbol: "BTC-PERP",
      side: "BUY",
      qty: 0.004,
      price: 100.5,
      fee: 0.01,
      ts: 3
    }
  });
  assert.equal(mapBinanceOrderUpdate(update("CANCELED", "CANCELED"), "BTC-PERP", "BTCUSDT", request)?.type, "CANCEL_ACK");
});

test("validates Binance market lot size and minimum notional without changing the core intent", () => {
  const rules = symbolRules();
  assert.doesNotThrow(() => validateMarketOrder(order(), rules));
  assert.throws(() => validateMarketOrder({ ...order(), qty: 0.0045 }, rules), /not aligned/);
  assert.throws(() => validateMarketOrder({ ...order(), qty: 0.001 }, rules), /below Binance minimum/);
});

test("parses the symbol filters used by the Testnet boundary", () => {
  assert.deepEqual(parseSymbolRules({
    symbols: [{
      symbol: "BTCUSDT",
      status: "TRADING",
      orderTypes: ["LIMIT", "MARKET"],
      filters: [
        { filterType: "MARKET_LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
        { filterType: "MIN_NOTIONAL", notional: "5" }
      ]
    }]
  }, "BTCUSDT"), symbolRules());
});

test("uses the external user stream as the only ACK and Fill fact path", async () => {
  const transport = new FakeTransport();
  const venue = new BinanceUsdsTestnetVenue({
    canonicalSymbol: "BTC-PERP",
    venueSymbol: "BTCUSDT",
    transport
  });
  const events: ExecutionEvent[] = [];
  venue.onExecutionEvent((event) => events.push(event));
  await venue.start();
  await venue.submit({ clientOrderId: "BTC-PERP-1", request: order() });
  assert.deepEqual(events, []);

  await transport.emit(update("NEW", "NEW"));
  await transport.emit(update("TRADE", "FILLED"));
  await venue.close();
  assert.deepEqual(events.map((event) => event.type), ["ORDER_ACK", "FILL"]);
});

class FakeTransport implements BinanceTestnetTransport {
  private handler: ((update: BinanceOrderTradeUpdate) => void | Promise<void>) | null = null;

  async loadSymbolRules(): Promise<BinanceSymbolRules> { return symbolRules(); }
  async validateAccountMode(): Promise<void> {}
  async connectUserData(handler: (update: BinanceOrderTradeUpdate) => void | Promise<void>): Promise<void> {
    this.handler = handler;
  }
  async submitMarketOrder(): Promise<void> {}
  async cancelOrder(): Promise<void> {}
  async loadSnapshot() {
    return {
      position: { symbol: "BTC-PERP", side: "FLAT" as const, qty: 0, entryPrice: 0, realizedPnl: 0 },
      openOrders: []
    };
  }
  async close(): Promise<void> {}
  async emit(value: BinanceOrderTradeUpdate): Promise<void> { await this.handler?.(value); }
}

function order(): OrderRequest {
  return { symbol: "BTC-PERP", side: "BUY", qty: 0.01, price: 1_000, reason: "test", ts: 1 };
}

function symbolRules(): BinanceSymbolRules {
  return {
    symbol: "BTCUSDT",
    status: "TRADING",
    marketOrderSupported: true,
    minQty: 0.001,
    maxQty: 100,
    stepSize: 0.001,
    minNotional: 5
  };
}

function update(executionType: string, status: string): BinanceOrderTradeUpdate {
  return {
    e: "ORDER_TRADE_UPDATE",
    E: 3,
    T: 3,
    o: {
      s: "BTCUSDT",
      c: "BTC-PERP-1",
      S: "BUY",
      x: executionType,
      X: status,
      i: 42,
      q: "0.01",
      p: "100",
      ap: "100.5",
      l: "0.004",
      L: "100.5",
      n: "0.01",
      T: 3,
      t: 77
    }
  };
}
