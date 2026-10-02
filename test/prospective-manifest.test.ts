import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  evaluateProspectiveManifest,
  loadProspectiveManifest,
  PROSPECTIVE_MANIFEST_SCHEMA_VERSION
} from "../src/overlay/prospective-manifest.ts";

test("admits an already-open market from an archived first public discovery", () => {
  const value = manifest();
  assert.equal(PROSPECTIVE_MANIFEST_SCHEMA_VERSION, "2.1.0");
  assert.deepEqual(evaluateProspectiveManifest(value), {
    status: "DATA_READY",
    manifestId: "PROSPECTIVE-TEST-1",
    reasons: []
  });
  assert.deepEqual(value, manifest());
});

test("blocks missing data and credential fields without using defaults", () => {
  const missing = structuredClone(manifest());
  delete (missing.token as { identifier?: string }).identifier;
  const missingResult = evaluateProspectiveManifest(missing);
  assert.equal(missingResult.status, "DATA_BLOCKED");
  assert.ok(missingResult.reasons.some((reason) => reason.includes("token.identifier")));

  const credential = { ...manifest(), apiKey: "must-not-be-recorded" };
  const credentialResult = evaluateProspectiveManifest(credential);
  assert.equal(credentialResult.status, "DATA_BLOCKED");
  assert.match(credentialResult.reasons.join("\n"), /credential fields are forbidden/);
  assert.doesNotMatch(JSON.stringify(credentialResult), /must-not-be-recorded/);
});

test("rejects assets not already listed at discovery and non-crypto scope", () => {
  const value = manifest();
  value.listing.listedAt = value.market.discovery.firstDiscoveredAt;
  value.token.classification = "UTILITY";
  const result = evaluateProspectiveManifest(value);
  assert.equal(result.status, "INELIGIBLE");
  assert.match(result.reasons.join("\n"), /not already Binance-listed at first discovery/);
  assert.match(result.reasons.join("\n"), /classification is not CRYPTO_ASSET/);
});

test("fails closed when discovery or frozen inputs are backdated", () => {
  const registration = manifest();
  registration.registeredAt = registration.market.discovery.firstDiscoveredAt - 1;
  const registrationResult = evaluateProspectiveManifest(registration);
  assert.equal(registrationResult.status, "DATA_BLOCKED");
  assert.match(registrationResult.reasons.join("\n"), /registeredAt must equal/);

  const rules = manifest();
  rules.outcome.rulesCapturedAt = rules.market.discovery.firstDiscoveredAt + 1;
  const rulesResult = evaluateProspectiveManifest(rules);
  assert.equal(rulesResult.status, "DATA_BLOCKED");
  assert.match(rulesResult.reasons.join("\n"), /rulesCapturedAt cannot be after/);
});

test("rejects source fallback and frozen parameter changes as ineligible", () => {
  const value = manifest();
  value.sources.spot.provider = "DEXSCREENER";
  value.sources.yes.provider = "POLYMARKET_MIDPOINT";
  value.protocol.spotRiseTriggerPct = 0.49;
  value.protocol.maxRiskBudget = 101;
  value.execution.primarySlippageBps = 49;
  value.supply.fixedThroughMeasurement = false;
  const result = evaluateProspectiveManifest(value);
  assert.equal(result.status, "INELIGIBLE");
  assert.match(result.reasons.join("\n"), /spot provider/);
  assert.match(result.reasons.join("\n"), /YES provider/);
  assert.match(result.reasons.join("\n"), /Strategy implementation or frozen parameters differ/);
  assert.match(result.reasons.join("\n"), /Risk implementation or frozen budget differs/);
  assert.match(result.reasons.join("\n"), /Execution assumptions differ/);
  assert.match(result.reasons.join("\n"), /not proven fixed/);
});

test("file loader returns DATA_BLOCKED for invalid JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospective-manifest-"));
  const path = join(directory, "candidate.json");
  await writeFile(path, "{ invalid", "utf8");
  assert.deepEqual(await loadProspectiveManifest(path), {
    status: "DATA_BLOCKED",
    manifestId: null,
    reasons: ["manifest is not valid JSON"]
  });
});

function manifest() {
  return {
    schemaVersion: "2.1.0",
    manifestId: "PROSPECTIVE-TEST-1",
    registeredAt: 1_000,
    repositoryCommit: "8a8420919a6016c0917108611eab17fb8fdccf0c",
    market: {
      marketId: "MARKET-1",
      question: "Will TEST FDV exceed $1B after launch?",
      marketUrl: "https://polymarket.com/event/test-fdv-after-launch",
      rulesUrl: "https://polymarket.com/event/test-fdv-after-launch",
      createdAt: 100,
      openedAt: 500,
      rulesAvailableAtDiscovery: true,
      marketType: "FUTURE_FDV_THRESHOLD",
      targetFdv: 1_000_000_000,
      yesTokenId: "YES-TOKEN-1",
      discovery: {
        provider: "POLYMARKET_GAMMA",
        firstDiscoveredAt: 1_000,
        sourceUrl: "https://gamma-api.polymarket.com/markets?closed=false",
        sourceTimestamp: 900,
        retrievedAt: 1_000,
        rawResponsePath: "raw/polymarket-gamma.json",
        sha256: "a".repeat(64)
      }
    },
    token: {
      symbol: "TEST",
      identifier: "solana:TEST-MINT",
      classification: "CRYPTO_ASSET",
      classificationSourceUrl: "https://project.example/token"
    },
    listing: {
      listedAt: 100,
      binanceSymbol: "TESTUSDT",
      listingSourceUrl: "https://www.binance.com/en/support/announcement/test"
    },
    supply: {
      totalSupply: 1_000_000_000,
      observedAt: 900,
      sourceUrl: "https://project.example/tokenomics",
      verificationMethod: "OFFICIAL_TOKENOMICS",
      fixedThroughMeasurement: true,
      fixedThroughMeasurementSourceUrl: "https://project.example/tokenomics"
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
      measurementAt: 86_402_000,
      rule: "Use the market's rule captured before launch.",
      rulesCapturedAt: 950,
      rulesUrl: "https://polymarket.com/event/test-fdv-after-launch"
    }
  };
}
