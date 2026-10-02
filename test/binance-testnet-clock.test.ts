import assert from "node:assert/strict";
import test from "node:test";

import { measureBinanceTestnetClock } from "../src/binance-testnet-clock.ts";

test("measures Binance Testnet clock offset at the request midpoint", async () => {
  const times = [1_000, 1_100];
  const sample = await measureBinanceTestnetClock({
    now: () => times.shift()!,
    fetch: async () => new Response(JSON.stringify({ serverTime: 2_050 }), { status: 200 })
  });

  assert.deepEqual(sample, {
    offsetMs: 1_000,
    roundTripMs: 100,
    serverTime: 2_050
  });
});

test("fails closed on an invalid Binance Testnet clock response", async () => {
  await assert.rejects(
    measureBinanceTestnetClock({
      now: () => 1_000,
      fetch: async () => new Response(JSON.stringify({ serverTime: "invalid" }), { status: 200 })
    }),
    /invalid serverTime/
  );
});

test("fails closed when Binance Testnet clock endpoint is not successful", async () => {
  await assert.rejects(
    measureBinanceTestnetClock({
      now: () => 1_000,
      fetch: async () => new Response("unavailable", { status: 503 })
    }),
    /HTTP 503/
  );
});

test("fails closed when the clock round trip is unsafe", async () => {
  const times = [1_000, 6_001];
  await assert.rejects(
    measureBinanceTestnetClock({
      now: () => times.shift()!,
      fetch: async () => new Response(JSON.stringify({ serverTime: 3_500 }), { status: 200 })
    }),
    /round trip is unsafe/
  );
});

test("fails closed when the measured offset is unsafe", async () => {
  const times = [1_000, 1_000];
  await assert.rejects(
    measureBinanceTestnetClock({
      now: () => times.shift()!,
      fetch: async () =>
        new Response(JSON.stringify({ serverTime: 24 * 60 * 60 * 1_000 + 1_001 }), {
          status: 200
        })
    }),
    /clock offset is unsafe/
  );
});

test("rejects an invalid clock timeout before making a request", async () => {
  let called = false;
  await assert.rejects(
    measureBinanceTestnetClock({
      timeoutMs: 0,
      fetch: async () => {
        called = true;
        return new Response(JSON.stringify({ serverTime: 1_000 }), { status: 200 });
      }
    }),
    /timeout must be a positive integer/
  );
  assert.equal(called, false);
});
