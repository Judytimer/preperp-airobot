import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runProspectiveSamplingFiles } from "../src/overlay/prospective-runner.ts";

test("formal Candidate runs frozen 50 bps primary plus 0/100 sensitivity and records unavailable Shadow", async () => {
  const fixture = await createFixture([100, 151]);
  const result = await runProspectiveSamplingFiles(
    fixture.manifestPath,
    fixture.observationPath,
    fixture.reportDirectory,
    { now: () => 500_000, env: {} }
  );

  assert.equal(result.report.status, "OBSERVED");
  assert.equal(result.report.formal?.status, "CANDIDATE");
  assert.equal(result.report.riskDecision?.approved, true);
  assert.deepEqual(result.report.paperScenarios.map((item) => item.slippageBps), [50, 0, 100]);
  assert.deepEqual(
    result.report.paperScenarios.map((item) => item.executions[0]?.fillPrice),
    [0.35175, 0.35, 0.3535]
  );
  assert.ok(result.report.paperScenarios.every((item) => item.events[0]?.type === "ORDER_ACK"));
  assert.ok(result.report.paperScenarios.every((item) => item.events[1]?.type === "FILL"));
  assert.ok(result.report.paperScenarios.every((item) => item.positions.length === 1));
  assert.equal(result.report.shadowRecord?.status, "PROVIDER_UNAVAILABLE");
  assert.equal(result.report.outcome.status, "WAITING_FOR_FROZEN_TIME");
});

test("NO_CANDIDATE records evidence without Risk, Paper, or Shadow", async () => {
  const fixture = await createFixture([100, 120, 149]);
  const result = await runProspectiveSamplingFiles(
    fixture.manifestPath,
    fixture.observationPath,
    fixture.reportDirectory,
    { now: () => 500_000, env: {} }
  );

  assert.equal(result.report.formal?.status, "NO_CANDIDATE");
  assert.equal(result.report.riskDecision, null);
  assert.deepEqual(result.report.paperScenarios, []);
  assert.equal(result.report.shadowRecord, null);
  assert.equal(result.report.rawArtifacts.length, 2);
});

test("same observation is idempotent and changed input cannot rewrite frozen T0", async () => {
  const fixture = await createFixture([100, 151]);
  const first = await runProspectiveSamplingFiles(
    fixture.manifestPath,
    fixture.observationPath,
    fixture.reportDirectory,
    { now: () => 500_000, env: {} }
  );
  const before = await readFile(first.reportPath, "utf8");
  const second = await runProspectiveSamplingFiles(
    fixture.manifestPath,
    fixture.observationPath,
    fixture.reportDirectory,
    { now: () => 900_000, env: {} }
  );
  assert.equal(second.reused, true);
  assert.equal(await readFile(first.reportPath, "utf8"), before);

  const changed = JSON.parse(await readFile(fixture.observationPath, "utf8"));
  changed.candles[1].close = 999;
  await writeFile(fixture.observationPath, JSON.stringify(changed), "utf8");
  await assert.rejects(
    runProspectiveSamplingFiles(
      fixture.manifestPath,
      fixture.observationPath,
      fixture.reportDirectory,
      { now: () => 900_000, env: {} }
    ),
    /different immutable input/
  );
  assert.equal(await readFile(first.reportPath, "utf8"), before);
});

test("checksum mismatch and candle gaps fail closed into a persisted DATA_BLOCKED report", async () => {
  const checksumFixture = await createFixture([100, 151]);
  const checksumObservation = JSON.parse(await readFile(checksumFixture.observationPath, "utf8"));
  checksumObservation.rawArtifacts[0].sha256 = "0".repeat(64);
  await writeFile(checksumFixture.observationPath, JSON.stringify(checksumObservation), "utf8");
  const checksumResult = await runProspectiveSamplingFiles(
    checksumFixture.manifestPath,
    checksumFixture.observationPath,
    checksumFixture.reportDirectory,
    { now: () => 500_000, env: {} }
  );
  assert.equal(checksumResult.report.status, "DATA_BLOCKED");
  assert.match(checksumResult.report.blockers.join("\n"), /checksum mismatch/);

  const gapFixture = await createFixture([100, 120, 151]);
  const gapObservation = JSON.parse(await readFile(gapFixture.observationPath, "utf8"));
  gapObservation.candles.splice(1, 1);
  const gapRaw = JSON.parse(await readFile(gapFixture.spotRawPath, "utf8"));
  gapRaw.splice(1, 1);
  const gapRawBody = JSON.stringify(gapRaw);
  await writeFile(gapFixture.spotRawPath, gapRawBody, "utf8");
  gapObservation.rawArtifacts[0].sha256 = digest(gapRawBody);
  await writeFile(gapFixture.observationPath, JSON.stringify(gapObservation), "utf8");
  const gapResult = await runProspectiveSamplingFiles(
    gapFixture.manifestPath,
    gapFixture.observationPath,
    gapFixture.reportDirectory,
    { now: () => 500_000, env: {} }
  );
  assert.equal(gapResult.report.status, "DATA_BLOCKED");
  assert.match(gapResult.report.blockers.join("\n"), /contiguous 1-minute/);
});

test("first-discovery raw response checksum mismatch fails closed", async () => {
  const fixture = await createFixture([100, 151]);
  const value = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  value.market.discovery.sha256 = "0".repeat(64);
  await writeFile(fixture.manifestPath, JSON.stringify(value), "utf8");
  const result = await runProspectiveSamplingFiles(
    fixture.manifestPath,
    fixture.observationPath,
    fixture.reportDirectory,
    { now: () => 500_000, env: {} }
  );
  assert.equal(result.report.status, "DATA_BLOCKED");
  assert.match(result.report.blockers.join("\n"), /POLYMARKET_GAMMA_DISCOVERY checksum mismatch/);
});

test("structured market data cannot diverge from the archived raw artifacts", async () => {
  const fixture = await createFixture([100, 151]);
  const value = JSON.parse(await readFile(fixture.observationPath, "utf8"));
  value.candles[1].close = 999;
  await writeFile(fixture.observationPath, JSON.stringify(value), "utf8");

  const result = await runProspectiveSamplingFiles(
    fixture.manifestPath,
    fixture.observationPath,
    fixture.reportDirectory,
    { now: () => 500_000, env: {} }
  );
  assert.equal(result.report.status, "DATA_BLOCKED");
  assert.match(result.report.blockers.join("\n"), /do not exactly match the archived Binance raw artifact/);
});

async function createFixture(closes: readonly number[]) {
  const directory = await mkdtemp(join(tmpdir(), "prospective-runner-"));
  const rawDiscovery = "raw Polymarket Gamma discovery response";
  const series = marketSeries(closes);
  const rawSpot = JSON.stringify(series.candles.map((candle) => [
    candle.openTs,
    String(candle.close),
    String(candle.close),
    String(candle.close),
    String(candle.close),
    "1",
    candle.closeTs,
    "1",
    1,
    "1",
    "1",
    "0"
  ]));
  const rawYes = JSON.stringify(series.yesPrices.map((point) => ({
    topic: "market",
    type: "last_trade_price",
    payload: {
      market: "CONDITION-1",
      tokenId: "YES-1",
      price: String(point.yesPrice),
      side: "BUY",
      timestamp: String(point.ts)
    }
  })));
  const spotRawPath = join(directory, "spot.raw.json");
  await Promise.all([
    writeFile(join(directory, "discovery.raw.json"), rawDiscovery, "utf8"),
    writeFile(spotRawPath, rawSpot, "utf8"),
    writeFile(join(directory, "yes.raw.json"), rawYes, "utf8")
  ]);
  const manifestPath = join(directory, "manifest.json");
  const observationPath = join(directory, "observation.json");
  const reportDirectory = join(directory, "reports");
  await writeFile(manifestPath, JSON.stringify(manifest(rawDiscovery)), "utf8");
  await writeFile(observationPath, JSON.stringify(observation(closes, rawSpot, rawYes)), "utf8");
  return { manifestPath, observationPath, reportDirectory, spotRawPath };
}

function manifest(rawDiscovery: string) {
  return {
    schemaVersion: "2.1.0",
    manifestId: "PROSPECTIVE-RUNNER-TEST",
    registeredAt: 60_000,
    repositoryCommit: "2fc1bb676b8108360a2404bb0d14350f2f231dd8",
    market: {
      marketId: "MARKET-1",
      question: "Will TEST FDV exceed the frozen target?",
      marketUrl: "https://polymarket.com/event/test",
      rulesUrl: "https://polymarket.com/event/test",
      createdAt: 400,
      openedAt: 1_000,
      rulesAvailableAtDiscovery: true,
      marketType: "FUTURE_FDV_THRESHOLD",
      targetFdv: 500_000,
      yesTokenId: "YES-1",
      discovery: {
        provider: "POLYMARKET_GAMMA",
        firstDiscoveredAt: 60_000,
        sourceUrl: "https://gamma-api.polymarket.com/markets?closed=false",
        sourceTimestamp: 55_000,
        retrievedAt: 60_000,
        rawResponsePath: "discovery.raw.json",
        sha256: digest(rawDiscovery)
      }
    },
    token: {
      symbol: "TEST",
      identifier: "solana:TEST",
      classification: "CRYPTO_ASSET",
      classificationSourceUrl: "https://project.example/token"
    },
    listing: {
      listedAt: 100,
      binanceSymbol: "TESTUSDT",
      listingSourceUrl: "https://www.binance.com/en/support/announcement/test"
    },
    supply: {
      totalSupply: 1_000,
      observedAt: 50_000,
      sourceUrl: "https://project.example/supply",
      verificationMethod: "OFFICIAL_TOKENOMICS",
      fixedThroughMeasurement: true,
      fixedThroughMeasurementSourceUrl: "https://project.example/supply"
    },
    sources: {
      spot: {
        provider: "BINANCE_SPOT",
        interval: "1m",
        klinesUrl: "https://data-api.binance.vision/api/v3/klines?symbol=TESTUSDT&interval=1m"
      },
      yes: {
        provider: "POLYMARKET_LAST_TRADE",
        marketDataUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market"
      }
    },
    protocol: {
      formalOneMinuteVersion: "2.1.0",
      strategyImplementation: "MemePredictionOverlayStrategy",
      spotRiseTriggerPct: 0.5,
      exitYesPrice: 0.7,
      riskImplementation: "OverlayRiskManager",
      maxRiskBudget: 100
    },
    execution: {
      assumptionVersion: "1.0.0",
      primarySlippageBps: 50,
      sensitivitySlippageBps: [0, 100],
      feeModel: "ZERO",
      fillSemantics: "FULL_FILL_LIMITATION"
    },
    outcome: {
      measurementAt: 1_000_000,
      rule: "Use the frozen market rule.",
      rulesCapturedAt: 50_000,
      rulesUrl: "https://polymarket.com/event/test"
    }
  };
}

function observation(closes: readonly number[], rawSpot: string, rawYes: string) {
  const { candles, yesPrices } = marketSeries(closes);
  return {
    schemaVersion: "2.1.0",
    observationId: "SCAN-1",
    retrievedAt: 400_000,
    rawArtifacts: [
      {
        kind: "BINANCE_SPOT_KLINES",
        sourceUrl: "https://data-api.binance.vision/api/v3/klines?symbol=TESTUSDT&interval=1m",
        sourceTimestamp: candles.at(-1)!.closeTs,
        retrievedAt: 300_000,
        path: "spot.raw.json",
        sha256: digest(rawSpot)
      },
      {
        kind: "POLYMARKET_LAST_TRADES",
        sourceUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
        sourceTimestamp: yesPrices.at(-1)!.ts,
        retrievedAt: 300_000,
        path: "yes.raw.json",
        sha256: digest(rawYes)
      }
    ],
    candles,
    yesPrices
  };
}

function marketSeries(closes: readonly number[]) {
  const candles = closes.map((close, index) => ({
    openTs: 60_000 + index * 60_000,
    closeTs: 119_999 + index * 60_000,
    close
  }));
  const yesPrices = [
    { ts: 90_000, yesPrice: 0.3 },
    { ts: 150_000, yesPrice: 0.35 },
    { ts: 210_000, yesPrice: 0.4 }
  ].filter((point) => point.ts <= candles.at(-1)!.closeTs);
  return { candles, yesPrices };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
