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

test("admits a complete manual pre-listing manifest as acquisition-ready only", () => {
  const value = manifest();
  assert.equal(PROSPECTIVE_MANIFEST_SCHEMA_VERSION, "1.0.0");
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

test("rejects post-listing registration and non-meme scope as ineligible", () => {
  const value = manifest();
  value.registeredAt = value.listing.listingAt;
  value.token.classification = "UTILITY";
  const result = evaluateProspectiveManifest(value);
  assert.equal(result.status, "INELIGIBLE");
  assert.match(result.reasons.join("\n"), /not registered before listingAt/);
  assert.match(result.reasons.join("\n"), /classification is not MEME/);
});

test("rejects source fallback and frozen parameter changes as ineligible", () => {
  const value = manifest();
  value.sources.spot.provider = "DEXSCREENER";
  value.sources.yes.provider = "POLYMARKET_MIDPOINT";
  value.protocol.spotRiseTriggerPct = 0.49;
  value.protocol.maxRiskBudget = 101;
  value.execution.primarySlippageBps = 49;
  const result = evaluateProspectiveManifest(value);
  assert.equal(result.status, "INELIGIBLE");
  assert.match(result.reasons.join("\n"), /spot provider/);
  assert.match(result.reasons.join("\n"), /YES provider/);
  assert.match(result.reasons.join("\n"), /Strategy implementation or frozen parameters differ/);
  assert.match(result.reasons.join("\n"), /Risk implementation or frozen budget differs/);
  assert.match(result.reasons.join("\n"), /Execution assumptions differ/);
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
    schemaVersion: "1.0.0",
    manifestId: "PROSPECTIVE-TEST-1",
    registeredAt: 1_000,
    repositoryCommit: "8a8420919a6016c0917108611eab17fb8fdccf0c",
    market: {
      marketId: "MARKET-1",
      question: "Will TEST FDV exceed $1B after launch?",
      marketUrl: "https://polymarket.com/event/test-fdv-after-launch",
      rulesUrl: "https://polymarket.com/event/test-fdv-after-launch",
      createdAt: 800,
      activeAtRegistration: true,
      marketType: "FDV_AFTER_LAUNCH",
      targetFdv: 1_000_000_000,
      yesTokenId: "YES-TOKEN-1"
    },
    token: {
      symbol: "TEST",
      identifier: "solana:TEST-MINT",
      classification: "MEME",
      classificationSourceUrl: "https://project.example/token"
    },
    listing: {
      listingAt: 2_000,
      binanceSymbol: "TESTUSDT",
      announcementUrl: "https://www.binance.com/en/support/announcement/test"
    },
    supply: {
      totalSupply: 1_000_000_000,
      observedAt: 900,
      sourceUrl: "https://project.example/tokenomics",
      verificationMethod: "OFFICIAL_TOKENOMICS"
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
      formalOneMinuteVersion: "1.0.0",
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
