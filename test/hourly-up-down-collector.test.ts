import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findFirstNewHourlyCandidate,
  runHourlyUpDownCollectorCycle
} from "../src/overlay/hourly-up-down-collector.ts";

const START = 1_200_000;
const END = START + 3_600_000;

test("prospectively registers seven-asset supply and qualifies a fresh <=50c UP lag crossing", async () => {
  const root = await mkdtemp(join(tmpdir(), "hourly-up-down-"));
  let clock = START - 60_000;
  const dependencies = {
    now: () => clock,
    repositoryCommit: "d".repeat(40),
    fetcher: fakeFetch(() => clock)
  };

  const registered = await runHourlyUpDownCollectorCycle(root, dependencies);
  assert.equal(registered.registeredEpisodes, 1);
  assert.equal(registered.admission.waiting, 1);

  clock = START + 90_000;
  const observing = await runHourlyUpDownCollectorCycle(root, dependencies);
  assert.equal(observing.admission.waiting, 1);

  clock = START + 120_001;
  const qualified = await runHourlyUpDownCollectorCycle(root, dependencies);
  assert.equal(qualified.admission.qualified, 1);

  const candidate = await findFirstNewHourlyCandidate(root, START - 1, ["BTC", "DOGE"]);
  assert.equal(candidate?.asset, "BTC");
  assert.equal(candidate?.direction, "UP");
  assert.equal(candidate?.referenceOpen, 100);
  assert.equal(candidate?.crossingPreviousClose, 99);
  assert.equal(candidate?.crossingClose, 101);
  assert.equal(candidate?.entryBestAsk, 0.45);

  const stateName = (await readdir(join(root, "states")))[0]!;
  const state = JSON.parse(await readFile(join(root, "states", stateName), "utf8"));
  assert.equal(state.status, "QUALIFIED");
  assert.ok(state.artifacts.some((value: { kind: string }) => value.kind === "POLYMARKET_CLOB_BOOK"));
  assert.ok(state.artifacts.some((value: { kind: string }) => value.kind === "BINANCE_1M_KLINES"));
});

function fakeFetch(now: () => number): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("gamma-api.polymarket.com")) {
      return json(url.includes("Bitcoin%20Up%20or%20Down") ? search([event()]) : search([]));
    }
    if (url.includes("clob.polymarket.com/book")) {
      const up = url.includes("UP-TOKEN");
      return json({
        timestamp: String(now()),
        bids: [{ price: up ? "0.43" : "0.53", size: "20" }],
        asks: [{ price: up ? "0.45" : "0.55", size: "20" }]
      });
    }
    if (url.includes("api.binance.com/api/v3/klines")) {
      const candles = [[START, "100", "101", "98", "99", "1", START + 59_999, "1", 1, "1", "1", "0"]];
      if (now() > START + 59_999) candles.push([START + 60_000, "99", "102", "98", "101", "1", START + 119_999, "1", 1, "1", "1", "0"]);
      if (now() > START + 119_999) candles.push([START + 120_000, "101", "103", "100", "102", "1", START + 179_999, "1", 1, "1", "1", "0"]);
      return json(candles);
    }
    return new Response("not found", { status: 404 });
  };
}

function event() {
  const rules = "This market will resolve to \"Up\" if the close price is greater than or equal to the open price for the BTC/USDT 1 hour candle that begins on the time and date specified in the title. Otherwise, this market will resolve to \"Down\". The resolution source for this market is information from Binance. The close « C » and open « O » will be used.";
  return {
    id: "100",
    title: "Bitcoin Up or Down - January 1, 12AM ET",
    slug: "bitcoin-up-or-down-january-1-2026-12am-et",
    endDate: new Date(END).toISOString(),
    description: rules,
    markets: [{
      id: "200",
      question: "Bitcoin Up or Down - January 1, 12AM ET",
      description: rules,
      endDate: new Date(END).toISOString(),
      outcomes: JSON.stringify(["Up", "Down"]),
      clobTokenIds: JSON.stringify(["UP-TOKEN", "DOWN-TOKEN"]),
      active: true,
      closed: false,
      acceptingOrders: true,
      enableOrderBook: true
    }]
  };
}

function search(events: readonly unknown[]) { return { events, pagination: { hasMore: false, totalResults: events.length } }; }
function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
