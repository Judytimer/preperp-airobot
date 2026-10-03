import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPostPreview,
  buildPostRequest,
  loadPerplPostConfig,
  scaleDecimal
} from "../src/perpl-post-once.ts";

const secret = "1f".repeat(32);

test("one-shot Post is testnet-only and requires explicit confirmation", () => {
  const base = { PERPL_API_KEY: "key", PERPL_API_KEY_SECRET: secret };
  assert.throws(() => loadPerplPostConfig(base), /PERPL_CONFIRM_POST/);
  assert.throws(() => loadPerplPostConfig({
    ...base,
    PERPL_NETWORK: "mainnet",
    PERPL_CONFIRM_POST: "TESTNET_POST_ONCE"
  }), /testnet-only/);
});

test("builds one PostOnly request from the authoritative account lfr", () => {
  const request = buildPostRequest({
    accountId: 7,
    marketId: 16,
    orderType: 1,
    price: 950000,
    size: 100,
    leverage: 100
  }, 41, 9);
  assert.deepEqual(request, {
    mt: 22,
    sn: 9,
    rq: 42,
    mkt: 16,
    acc: 7,
    t: 1,
    p: 950000,
    s: 100,
    fl: 1,
    lv: 100,
    lb: 0
  });
});

test("scales human price and quantity exactly from market configuration", () => {
  const preview = buildPostPreview({
    orderType: 1,
    humanPrice: "95000.1",
    humanQty: "0.00125",
    leverage: 100
  }, { symbol: "BTC", priceDecimals: 1, sizeDecimals: 5 });
  assert.deepEqual(preview, {
    market: "BTC",
    side: "LONG",
    humanQty: "0.00125",
    humanPrice: "95000.1",
    scaledQty: 125,
    scaledPrice: 950001,
    leverage: 100
  });
  assert.throws(() => scaleDecimal("0.000001", 5, "qty"), /more than 5/);
});
