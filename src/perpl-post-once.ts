import { randomInt } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildRestAuthHeaders,
  buildWebSocketSignIn,
  loadPerplProbeConfig,
  type PerplProbeConfig
} from "./perpl-access-probe.ts";

export type PerplPostConfig = PerplProbeConfig & {
  accountId: number;
  marketId: number;
  orderType: 1 | 2;
  humanPrice: string;
  humanQty: string;
  leverage: number;
};

export type PerplMarketScale = {
  symbol: string;
  priceDecimals: number;
  sizeDecimals: number;
};

export type PerplPostPreview = {
  market: string;
  side: "LONG" | "SHORT";
  humanQty: string;
  humanPrice: string;
  scaledQty: number;
  scaledPrice: number;
  leverage: number;
};

export type PerplPostRequest = {
  mt: 22;
  sn: number;
  rq: number;
  mkt: number;
  acc: number;
  t: 1 | 2;
  p: number;
  s: number;
  fl: 1;
  lv: number;
  lb: 0;
};

export function loadPerplPostConfig(env: NodeJS.ProcessEnv = process.env): PerplPostConfig {
  const base = loadPerplProbeConfig(env);
  if ((env.PERPL_NETWORK ?? "testnet") !== "testnet" || base.chainId !== 10143) {
    throw new Error("the one-shot Post is testnet-only");
  }
  if (env.PERPL_CONFIRM_POST !== "TESTNET_POST_ONCE") {
    throw new Error("set PERPL_CONFIRM_POST=TESTNET_POST_ONCE to enable one testnet Post");
  }
  const orderType = positiveInteger(env.PERPL_ORDER_TYPE, "PERPL_ORDER_TYPE");
  if (orderType !== 1 && orderType !== 2) throw new Error("PERPL_ORDER_TYPE must be 1 (long) or 2 (short)");
  return {
    ...base,
    accountId: positiveInteger(env.PERPL_ACCOUNT_ID, "PERPL_ACCOUNT_ID"),
    marketId: positiveInteger(env.PERPL_MARKET_ID, "PERPL_MARKET_ID"),
    orderType,
    humanPrice: positiveDecimal(env.PERPL_ORDER_PRICE, "PERPL_ORDER_PRICE"),
    humanQty: positiveDecimal(env.PERPL_ORDER_QTY, "PERPL_ORDER_QTY"),
    leverage: positiveInteger(env.PERPL_ORDER_LEVERAGE ?? "100", "PERPL_ORDER_LEVERAGE")
  };
}

export function buildPostRequest(
  config: Pick<PerplPostConfig, "accountId" | "marketId" | "orderType" | "leverage"> & {
    price: number;
    size: number;
  },
  lfr: number,
  sequence: number
): PerplPostRequest {
  if (!Number.isSafeInteger(lfr) || lfr < 0) throw new Error("account lfr must be a non-negative integer");
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error("sequence must be a positive integer");
  return {
    mt: 22,
    sn: sequence,
    rq: lfr + 1,
    mkt: config.marketId,
    acc: config.accountId,
    t: config.orderType,
    p: config.price,
    s: config.size,
    fl: 1,
    lv: config.leverage,
    lb: 0
  };
}

export async function postOnce(config: PerplPostConfig): Promise<Record<string, unknown>> {
  const context = await publicGet(config, "/v1/pub/context");
  const market = findMarketScale(context, config.marketId);
  const preview = buildPostPreview(config, market);
  console.log(JSON.stringify({ status: "POST_PREVIEW", preview }, null, 2));
  const wallet = await signedGet(config, "/v1/trading/wallet");
  const lfr = findAccountLfr(wallet, config.accountId);
  const sequence = randomInt(1, 0x7fffffff);
  // Phase 1A is deliberately a single-process/single-writer experiment. A real
  // allocator must also persist a local counter and retry the same command with
  // its original rq according to Perpl's idempotency rules.
  const request = buildPostRequest({
    ...config,
    price: preview.scaledPrice,
    size: preview.scaledQty
  }, lfr, sequence);
  const socket = new WebSocket(`${config.wsUrl}/ws/v1/trading`);

  try {
    return await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      let sent = false;
      let accepted = false;
      const timer = setTimeout(() => reject(new Error("timed out waiting for authoritative Perpl Order Update")), config.timeoutMs);
      const finish = (operation: () => void): void => {
        clearTimeout(timer);
        operation();
      };

      socket.addEventListener("open", () => socket.send(JSON.stringify(buildWebSocketSignIn(config))), { once: true });
      socket.addEventListener("message", (event) => {
        try {
          if (typeof event.data !== "string") throw new Error("Perpl WebSocket returned a non-text frame");
          const message = record(JSON.parse(event.data), "WebSocket message");
          if (message.mt === 19 && !sent) {
            sent = true;
            socket.send(JSON.stringify(request));
            return;
          }
          if (message.mt === 3 && message.cid === sequence) {
            const status = record(message.status, "Command Status");
            if (status.code !== 0) {
              finish(() => reject(new Error(`Perpl rejected Post command: ${String(status.code)} ${String(status.error ?? "")}`)));
              return;
            }
            accepted = true;
            return;
          }
          if (message.mt === 24) {
            const orders = Array.isArray(message.d) ? message.d : [];
            const order = orders.find((value) => {
              const candidate = record(value, "Order Update");
              return candidate.rq === request.rq && candidate.acc === request.acc;
            });
            if (order !== undefined) {
              const fact = record(order, "Order Update");
              finish(() => resolvePromise({
                commandAccepted: accepted,
                rq: request.rq,
                sn: request.sn,
                accountId: request.acc,
                marketId: request.mkt,
                orderId: fact.oid,
                smartContractOrderId: fact.scid,
                status: fact.st,
                statusReason: fact.sr,
                failureReason: fact.fr
              }));
            }
          }
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.addEventListener("error", () => finish(() => reject(new Error("Perpl WebSocket connection failed"))), { once: true });
      socket.addEventListener("close", (event) => {
        finish(() => reject(new Error(`Perpl WebSocket closed before Order Update: code=${event.code} reason=${event.reason}`)));
      }, { once: true });
    });
  } finally {
    socket.close(1000, "one-shot Post complete");
  }
}

export function scaleDecimal(value: string, decimals: number, name: string): number {
  if (!Number.isSafeInteger(decimals) || decimals < 0) throw new Error(`${name} decimals are invalid`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`${name} has more than ${decimals} decimal places`);
  const scaled = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (scaled <= 0n || scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} is outside the safe scaled range`);
  return Number(scaled);
}

export function buildPostPreview(
  config: Pick<PerplPostConfig, "orderType" | "humanPrice" | "humanQty" | "leverage">,
  market: PerplMarketScale
): PerplPostPreview {
  return {
    market: market.symbol,
    side: config.orderType === 1 ? "LONG" : "SHORT",
    humanQty: config.humanQty,
    humanPrice: config.humanPrice,
    scaledQty: scaleDecimal(config.humanQty, market.sizeDecimals, "PERPL_ORDER_QTY"),
    scaledPrice: scaleDecimal(config.humanPrice, market.priceDecimals, "PERPL_ORDER_PRICE"),
    leverage: config.leverage
  };
}

async function publicGet(config: PerplProbeConfig, target: string): Promise<unknown> {
  const response = await fetch(`${config.apiUrl}${target}`, {
    method: "GET",
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${target} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as unknown;
}

async function signedGet(config: PerplProbeConfig, target: string): Promise<unknown> {
  const response = await fetch(`${config.apiUrl}${target}`, {
    method: "GET",
    headers: buildRestAuthHeaders(config, target),
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${target} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as unknown;
}

function findAccountLfr(value: unknown, accountId: number): number {
  const wallet = record(value, "WalletSnapshot");
  if (wallet.mt !== 19) throw new Error(`WalletSnapshot has unexpected message type ${String(wallet.mt)}`);
  const accounts = Array.isArray(wallet.as) ? wallet.as : [];
  const account = accounts.map((item) => record(item, "account")).find((item) => item.id === accountId);
  if (account === undefined) throw new Error(`account ${accountId} is absent from WalletSnapshot`);
  if (account.fw !== true) throw new Error(`account ${accountId} does not allow order forwarding`);
  if (!Number.isSafeInteger(account.lfr) || (account.lfr as number) < 0) throw new Error(`account ${accountId} has invalid lfr`);
  return account.lfr as number;
}

function findMarketScale(value: unknown, marketId: number): PerplMarketScale {
  const context = record(value, "public context");
  const markets = Array.isArray(context.markets) ? context.markets : [];
  const market = markets.map((item) => record(item, "market")).find((item) => item.id === marketId);
  if (market === undefined) throw new Error(`market ${marketId} is absent from public context`);
  const marketConfig = record(market.config, "market config");
  if (marketConfig.is_open !== true) throw new Error(`market ${marketId} is not open`);
  if (typeof market.symbol !== "string" || market.symbol.length === 0) throw new Error(`market ${marketId} has no symbol`);
  if (!Number.isSafeInteger(marketConfig.price_decimals) || !Number.isSafeInteger(marketConfig.size_decimals)) {
    throw new Error(`market ${marketId} has invalid scaling configuration`);
  }
  return {
    symbol: market.symbol,
    priceDecimals: marketConfig.price_decimals as number,
    sizeDecimals: marketConfig.size_decimals as number
  };
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function positiveDecimal(value: string | undefined, name: string): string {
  if (value === undefined || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive decimal string`);
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const evidence = await postOnce(loadPerplPostConfig());
    console.log(JSON.stringify({ status: "ORDER_FACT_OBSERVED", evidence }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: "BLOCKED", reason: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}
