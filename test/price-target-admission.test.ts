import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePriceTargetEpisode,
  evaluatePriceTargetManifest,
  newPriceTargetState,
  PRICE_TARGET_PRIMARY_HORIZON_MS,
  type PriceTargetEpisodeState,
  type PriceTargetManifest
} from "../src/overlay/price-target-admission.ts";

test("admits only the frozen nearest-OTM manifest and exact cutoff formula", () => {
  const value = manifest();
  assert.deepEqual(evaluatePriceTargetManifest(value), {
    status: "DATA_READY",
    manifestId: value.manifestId,
    reasons: []
  });

  const wrongStrike = structuredClone(value);
  wrongStrike.registration.selectedStrike = 120;
  wrongStrike.registration.selectedMarketId = "M-120";
  wrongStrike.registration.selectedQuestion = "BTC above 120";
  wrongStrike.registration.yesAssetId = "YES-120";
  assert.equal(evaluatePriceTargetManifest(wrongStrike).status, "INELIGIBLE");

  const inclusiveCutoff = structuredClone(value);
  inclusiveCutoff.episode.cutoffT0 += 1;
  const result = evaluatePriceTargetManifest(inclusiveCutoff);
  assert.equal(result.status, "INELIGIBLE");
  assert.match(result.reasons.join("\n"), /measurementAt - 4h exactly/);

  const inactiveNearest = structuredClone(value);
  inactiveNearest.registration.completeStrikeLadder[1].active = false;
  inactiveNearest.registration.completeStrikeLadder[1].acceptingOrders = false;
  inactiveNearest.registration.selectedStrike = 120;
  inactiveNearest.registration.selectedMarketId = "M-120";
  inactiveNearest.registration.selectedQuestion = "BTC above 120";
  inactiveNearest.registration.yesAssetId = "YES-120";
  assert.equal(evaluatePriceTargetManifest(inactiveNearest).status, "DATA_READY");
});

test("qualifies the first complete 1m upward crossing with the latest archived pre-T0 book", () => {
  const value = manifest();
  const state = evidenceState(value, 239_000);
  const result = evaluatePriceTargetEpisode(value, state, 250_000);

  assert.equal(result.status, "QUALIFIED");
  assert.equal(result.candidate?.candidateT0, 240_000);
  assert.equal(result.candidate?.selectedStrike, 110);
  assert.equal(result.candidate?.entryBestAsk, 0.42);
  assert.equal(result.candidate?.yesBookObservedAt, 239_000);
});

test("fails closed when only a post-T0 book exists or the pre-T0 book is stale", () => {
  const value = manifest();
  const postT0 = evaluatePriceTargetEpisode(value, evidenceState(value, 240_001), 250_000);
  assert.equal(postT0.status, "DATA_BLOCKED");
  assert.match(postT0.reasons.join("\n"), /no archived pre-T0 YES book/);

  const stale = evaluatePriceTargetEpisode(value, evidenceState(value, 119_999), 250_000);
  assert.equal(stale.status, "DATA_BLOCKED");
  assert.match(stale.reasons.join("\n"), /older than 120s/);
});

test("uses candidateT0 < measurementAt - 4h and rejects equality", () => {
  const value = manifest();
  value.episode.measurementAt = 240_000 + PRICE_TARGET_PRIMARY_HORIZON_MS;
  value.episode.cutoffT0 = 240_000;
  const result = evaluatePriceTargetEpisode(value, evidenceState(value, 239_000), 250_000);

  assert.equal(result.status, "NOT_TRIGGERED_BEFORE_CUTOFF");
  assert.match(result.reasons.join("\n"), /candidateT0 < measurementAt - 4h/);
});

function manifest(): PriceTargetManifest {
  const measurementAt = 20_000_000;
  return {
    schemaVersion: "1.0.0",
    protocolVersion: "PRICE_TARGET_ADMISSION_V1_0_0",
    manifestId: "PTV1-BTC-20000000",
    repositoryCommit: "a".repeat(40),
    cohortKey: "PRICE_TARGET_V1_BTC",
    discoveredAt: 120_000,
    registeredAt: 120_000,
    episode: {
      episodeKey: `BTC-BINANCE_SPOT-BTCUSDT-${measurementAt}`,
      asset: "BTC",
      resolutionVenue: "BINANCE_SPOT",
      resolutionSymbol: "BTCUSDT",
      measurementAt,
      cutoffT0: measurementAt - PRICE_TARGET_PRIMARY_HORIZON_MS
    },
    ownerEvent: {
      eventId: "100",
      slug: "bitcoin-above-on-october-6-2026",
      title: "Bitcoin above ___ on October 6?",
      rules: "Binance BTC/USDT 1m close",
      rawDiscovery: artifact("POLYMARKET_GAMMA", "raw/gamma.json", 120_000)
    },
    registration: {
      spotCandle: { openTime: 60_000, closeTime: 119_999, close: 100 },
      spotArtifact: artifact("BINANCE_SPOT_KLINES", "raw/spot.json", 120_000),
      registrationSpot: 100,
      completeStrikeLadder: [
        ladder("M-90", "BTC above 90", 90, "YES-90"),
        ladder("M-110", "BTC above 110", 110, "YES-110"),
        ladder("M-120", "BTC above 120", 120, "YES-120")
      ],
      selectedStrike: 110,
      selectedMarketId: "M-110",
      selectedQuestion: "BTC above 110",
      yesAssetId: "YES-110"
    }
  };
}

function ladder(marketId: string, question: string, strike: number, yesAssetId: string) {
  return { marketId, question, strike, yesAssetId, active: true, closed: false, acceptingOrders: true, enableOrderBook: true };
}

function evidenceState(value: PriceTargetManifest, bookObservedAt: number): PriceTargetEpisodeState {
  return {
    ...newPriceTargetState(value.manifestId, value.registeredAt),
    candles: [
      { openTime: 120_000, closeTime: 179_999, close: 105 },
      { openTime: 180_000, closeTime: 239_999, close: 111 }
    ],
    books: [{
      observedAt: bookObservedAt,
      retrievedAt: bookObservedAt,
      marketId: "M-110",
      yesAssetId: "YES-110",
      bestBid: 0.4,
      bestBidSize: 10,
      bestAsk: 0.42,
      bestAskSize: 10,
      minOrderSize: 5,
      tickSize: 0.01,
      hash: "book-hash",
      artifact: artifact("POLYMARKET_CLOB_BOOK", "raw/book.json", bookObservedAt)
    }],
    marketStatuses: [{
      observedAt: 230_000,
      marketId: "M-110",
      active: true,
      closed: false,
      acceptingOrders: true,
      enableOrderBook: true,
      artifact: artifact("POLYMARKET_GAMMA", "raw/gamma-2.json", 230_000)
    }]
  };
}

function artifact(kind: "POLYMARKET_GAMMA" | "BINANCE_SPOT_KLINES" | "POLYMARKET_CLOB_BOOK", path: string, retrievedAt: number) {
  return {
    kind,
    sourceUrl: kind === "BINANCE_SPOT_KLINES"
      ? "https://api.binance.com/api/v3/klines"
      : kind === "POLYMARKET_GAMMA"
        ? "https://gamma-api.polymarket.com/public-search?q=Bitcoin"
        : "https://clob.polymarket.com/book",
    retrievedAt,
    path,
    sha256: "b".repeat(64)
  } as const;
}
