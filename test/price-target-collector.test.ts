import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parsePriceTargetSearch,
  runPriceTargetCollectorCycle,
  synchronizePriceTargetClock
} from "../src/overlay/price-target-collector.ts";
import {
  isDirectionalV1_1CandidateEligible,
  PRICE_TARGET_MARK_FIRST_ARCHIVE_MAX_LAG_MS
} from "../src/overlay/price-target-perp-mark-archive.ts";

const NOW = Date.parse("2026-10-05T14:00:30Z");

test("synchronizes the evidence clock to Binance server time instead of the host clock", async () => {
  let localNow = 1_000;
  const clock = await synchronizePriceTargetClock(
    async () => {
      localNow = 1_040;
      return json(JSON.stringify({ serverTime: 10_020 }));
    },
    1_000,
    () => localNow
  );

  assert.equal(clock.evidence.source, "BINANCE_SERVER_TIME");
  assert.equal(clock.evidence.roundTripMs, 40);
  assert.equal(clock.evidence.offsetMs, 9_000);
  assert.equal(clock.now(), 10_040);
});

test("parses measurementAt from slug plus frozen ET rules and preserves the full strike ladder", () => {
  const raw = search([event("100", "bitcoin-above-on-october-6-2026")]);
  const result = parsePriceTargetSearch("BTC", raw, NOW, artifact());

  assert.equal(result.blocked.length, 0);
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0]?.measurementAt, Date.parse("2026-10-06T16:00:00Z"));
  assert.equal(result.episodes[0]?.markets.length, 2);
  assert.deepEqual(result.episodes[0]?.markets.map((market) => market.strike), [100, 110]);
});

test("discovers XRP price-target episodes under the v1.1 asset extension", () => {
  const rules = "This market resolves Yes if the Binance 1 minute candle for XRP/USDT 12:00 in the ET timezone has a final \"Close\" price higher than the price specified in the title.";
  const raw = search([{
    ...event("300", "xrp-above-on-october-6-2026"),
    title: "XRP above ___ on October 6?",
    slug: "xrp-above-on-october-6-2026",
    description: rules,
    markets: [
      { ...market("31", 2.5, "YES-XRP-25", rules), question: "Will the price of XRP be above $2.5 on October 6?" },
      { ...market("32", 3, "YES-XRP-30", rules), question: "Will the price of XRP be above $3 on October 6?" }
    ]
  }]);
  const result = parsePriceTargetSearch("XRP", raw, NOW, artifact());

  assert.equal(result.blocked.length, 0);
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0]?.asset, "XRP");
  assert.equal(result.episodes[0]?.episodeKey, `XRP-BINANCE_SPOT-XRPUSDT-${Date.parse("2026-10-06T16:00:00Z")}`);
});

test("refuses to activate a new cohort from late historical mark candles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "price-target-v1-stale-mark-"));
  await assert.rejects(
    runPriceTargetCollectorCycle(directory, {
      now: () => NOW,
      repositoryCommit: "c".repeat(40),
      fetcher: async (input) => {
        const url = String(input);
        if (url.includes("fapi.binance.com/fapi/v1/markPriceKlines")) {
          return json(JSON.stringify([
            [NOW - 240_000, "100", "102", "99", "101", "0", NOW - 180_001, "0", 60, "0", "0", "0"]
          ]));
        }
        return new Response("not found", { status: 404 });
      }
    }),
    /no prospectively admissible closed candle/
  );
  await assert.rejects(readFile(join(directory, "directional-v1.1", "activation.json")), /ENOENT/);
});

test("one real-shaped collector cycle freezes registration and starts continuous evidence state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "price-target-v1-"));
  const result = await runPriceTargetCollectorCycle(directory, {
    now: () => NOW,
    repositoryCommit: "c".repeat(40),
    fetcher: fakeFetch()
  });

  assert.equal(result.registeredEpisodes, 1);
  assert.equal(result.clock.source, "INJECTED");
  assert.equal(result.admission.waiting, 1);
  assert.equal(result.admission.qualified, 0);
  assert.equal(result.perpMarkArchive.activationCreated, true);
  assert.equal(result.perpMarkArchive.assets.length, 3);
  assert.ok(result.perpMarkArchive.assets.every((item) => item.prospectivelyAdmissibleOpenTimes.length > 0));
  const activation = JSON.parse(await readFile(join(directory, result.perpMarkArchive.activationPath), "utf8"));
  assert.equal(activation.repositoryCommit, "c".repeat(40));
  assert.equal(activation.candidateBoundary, "candidateT0 > activatedAt");
  assert.equal(activation.firstArchiveMaxLagMs, PRICE_TARGET_MARK_FIRST_ARCHIVE_MAX_LAG_MS);
  assert.equal(isDirectionalV1_1CandidateEligible(activation.activatedAt, activation), false);
  assert.equal(isDirectionalV1_1CandidateEligible(activation.activatedAt + 1, activation), true);
  for (const reference of Object.values(activation.firstArtifacts) as Array<{ path: string; sha256: string }>) {
    const body = await readFile(join(directory, "directional-v1.1", reference.path));
    assert.equal(createHash("sha256").update(body).digest("hex"), reference.sha256);
  }

  const second = await runPriceTargetCollectorCycle(directory, {
    now: () => NOW + 60_000,
    repositoryCommit: "d".repeat(40),
    fetcher: fakeFetch(NOW + 60_000)
  });
  assert.equal(second.perpMarkArchive.activationCreated, false);
  const unchangedActivation = JSON.parse(await readFile(join(directory, second.perpMarkArchive.activationPath), "utf8"));
  assert.equal(unchangedActivation.repositoryCommit, "c".repeat(40));
  assert.equal(unchangedActivation.activatedAt, activation.activatedAt);
  const manifestName = (await readdir(join(directory, "manifests")))[0];
  const manifest = JSON.parse(await readFile(join(directory, "manifests", manifestName), "utf8"));
  assert.equal(manifest.registration.registrationSpot, 105);
  assert.equal(manifest.registration.selectedStrike, 110);
  assert.equal(manifest.ownerEvent.eventId, "100");
  assert.equal(manifest.episode.cutoffT0, manifest.episode.measurementAt - 4 * 60 * 60_000);

  const stateName = (await readdir(join(directory, "states")))[0];
  const state = JSON.parse(await readFile(join(directory, "states", stateName), "utf8"));
  assert.equal(state.status, "REGISTERED_WAITING_TRIGGER");
  assert.equal(state.books.length, 1);
  assert.equal(state.marketStatuses.length, 2);
  assert.ok(state.artifacts.some((item: { kind: string }) => item.kind === "POLYMARKET_CLOB_BOOK"));
});

function fakeFetch(clock = NOW): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("gamma-api.polymarket.com")) {
      return json(url.includes("q=Bitcoin")
        ? search([event("200", "bitcoin-above-on-october-6-2026"), event("100", "bitcoin-above-on-october-6-2026")])
        : search([]));
    }
    if (url.includes("fapi.binance.com/fapi/v1/markPriceKlines")) {
      return json(JSON.stringify([
        [clock - 180_000, "100", "102", "99", "101", "0", clock - 120_001, "0", 60, "0", "0", "0"],
        [clock - 120_000, "101", "103", "100", "102", "0", clock - 60_001, "0", 60, "0", "0", "0"],
        [clock - 60_000, "102", "104", "101", "103", "0", clock - 1, "0", 60, "0", "0", "0"]
      ]));
    }
    if (url.includes("api.binance.com") && url.includes("startTime=")) return json("[]");
    if (url.includes("api.binance.com") && url.includes("endTime=")) {
      return json(JSON.stringify([[NOW - 90_000, "100", "106", "99", "105", "1", NOW - 30_001, "1", 1, "1", "1", "0"]]));
    }
    if (url.includes("clob.polymarket.com/book")) {
      return json(JSON.stringify({
        timestamp: String(NOW - 5_000),
        bids: [{ price: "0.40", size: "20" }],
        asks: [{ price: "0.42", size: "20" }],
        min_order_size: "5",
        tick_size: "0.01",
        hash: "book-hash"
      }));
    }
    return new Response("not found", { status: 404 });
  };
}

function event(id: string, slug: string) {
  const rules = "This market resolves Yes if the Binance 1 minute candle for BTC/USDT 12:00 in the ET timezone has a final \"Close\" price higher than the price specified in the title.";
  return {
    id,
    title: "Bitcoin above ___ on October 6?",
    slug,
    description: rules,
    endDate: "2026-10-06T16:00:00Z",
    tags: [{ id: "21" }],
    markets: [
      market("1", 100, "YES-100", rules),
      market("2", 110, "YES-110", rules)
    ]
  };
}

function market(id: string, strike: number, yesAssetId: string, rules: string) {
  return {
    id,
    question: `Will the price of Bitcoin be above $${strike} on October 6?`,
    description: rules,
    endDate: "2026-10-06T16:00:00Z",
    outcomes: JSON.stringify(["Yes", "No"]),
    clobTokenIds: JSON.stringify([yesAssetId, `NO-${strike}`]),
    active: true,
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true
  };
}

function search(events: readonly unknown[]): string {
  return JSON.stringify({ events, pagination: { hasMore: false, totalResults: events.length } });
}

function artifact() {
  return {
    kind: "POLYMARKET_GAMMA" as const,
    sourceUrl: "https://gamma-api.polymarket.com/public-search?q=Bitcoin",
    retrievedAt: NOW,
    path: "raw/gamma.json",
    sha256: "a".repeat(64)
  };
}

function json(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}
