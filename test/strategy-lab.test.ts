import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFormalOneMinuteSnapshots,
  buildFormalOneMinuteV21Snapshots,
  FORMAL_STRATEGY_LAB_CADENCE_MS,
  FORMAL_STRATEGY_LAB_PROTOCOL_VERSION,
  FORMAL_STRATEGY_LAB_V2_1_PROTOCOL_VERSION,
  latestKnownYesAtOrBefore,
  runFormalOneMinuteReplay,
  runFormalOneMinuteV21Replay,
  type FormalOneMinuteInput
} from "../src/overlay/strategy-lab.ts";

test("formal protocol uses first complete post-listing candle and last-known YES only", () => {
  const snapshots = buildFormalOneMinuteSnapshots(input({ listingAt: 30_000 }));
  assert.equal(FORMAL_STRATEGY_LAB_PROTOCOL_VERSION, "1.0.0");
  assert.equal(FORMAL_STRATEGY_LAB_CADENCE_MS, 60_000);
  assert.equal(snapshots[0].ts, 119_999);
  assert.equal(snapshots[0].meme.spotPrice, 110);
  assert.equal(snapshots[0].prediction.yesPrice, 0.3);
  assert.equal(snapshots[0].prediction.yesPriceObservedAt, 90_000);
  assert.ok(snapshots.every((snapshot) => snapshot.prediction.yesPriceObservedAt! <= snapshot.ts));
  assert.equal(snapshots[1].prediction.yesPrice, 0.4);
  assert.equal(snapshots[0].meme.fdv, 110_000);
});

test("v2.1 uses the first complete candle after archived first discovery", () => {
  const v1 = input({ listingAt: 0, closes: [100, 110, 151] });
  const { listingAt: _listingAt, ...rest } = v1;
  const v21Input = { ...rest, firstDiscoveredAt: 60_001 };
  const snapshots = buildFormalOneMinuteV21Snapshots(v21Input);
  const result = runFormalOneMinuteV21Replay(
    v21Input,
    { spotRiseTriggerPct: 0.5, exitYesPrice: 0.7 }
  );

  assert.equal(FORMAL_STRATEGY_LAB_V2_1_PROTOCOL_VERSION, "2.1.0");
  assert.equal(snapshots[0].meme.spotPrice, 151);
  assert.equal(result.protocolVersion, "2.1.0");
  assert.equal(result.status, "NO_CANDIDATE");
  assert.equal(FORMAL_STRATEGY_LAB_PROTOCOL_VERSION, "1.0.0");
});

test("last-known YES lookup never interpolates or reads the future", () => {
  const points = [
    { ts: 10, yesPrice: 0.2 },
    { ts: 20, yesPrice: 0.4 }
  ];
  assert.equal(latestKnownYesAtOrBefore(points, 9), null);
  assert.deepEqual(latestKnownYesAtOrBefore(points, 19), points[0]);
  assert.deepEqual(latestKnownYesAtOrBefore(points, 20), points[1]);
});

test("formal 1m replay returns NO_CANDIDATE without forcing downstream execution", () => {
  const result = runFormalOneMinuteReplay(
    input({
      listingAt: 0,
      closes: [100, 120, 149],
      targetFdv: 500_000
    }),
    { spotRiseTriggerPct: 0.5, exitYesPrice: 0.7 }
  );
  assert.deepEqual(result, {
    status: "NO_CANDIDATE",
    protocolVersion: "1.0.0",
    baselineTs: 59_999,
    evaluatedSnapshots: 3,
    reason: "STRATEGY_NEVER_EMITTED_BUY_YES"
  });
});

test("formal 1m replay emits the original Strategy candidate when threshold is really crossed", () => {
  const result = runFormalOneMinuteReplay(
    input({ listingAt: 0, closes: [100, 151], targetFdv: 500_000 }),
    { spotRiseTriggerPct: 0.5, exitYesPrice: 0.7 }
  );
  assert.equal(result.status, "CANDIDATE");
  if (result.status === "CANDIDATE") {
    assert.equal(result.candidate.snapshot.meme.spotPrice, 151);
    assert.equal(result.candidate.signal.action, "BUY_YES");
  }
});

test("formal protocol rejects candle gaps and future-only YES history", () => {
  const gapBase = input({ listingAt: 0 });
  const gap = { ...gapBase, candles: [gapBase.candles[0], gapBase.candles[2]] };
  assert.throws(() => buildFormalOneMinuteSnapshots(gap), /contiguous 1-minute/);

  const futureBase = input({ listingAt: 0 });
  const futureOnly = { ...futureBase, yesPrices: [{ ts: 999_999, yesPrice: 0.5 }] };
  assert.throws(() => buildFormalOneMinuteSnapshots(futureOnly), /missing historical YES/);

  const shortBase = input({ listingAt: 0 });
  const shortCandle = structuredClone(shortBase);
  shortCandle.candles[0].closeTs = 29_999;
  assert.throws(() => buildFormalOneMinuteSnapshots(shortCandle), /candle is invalid/);
});

function input(options: {
  listingAt?: number;
  closes?: number[];
  targetFdv?: number;
} = {}): FormalOneMinuteInput {
  const closes = options.closes ?? [100, 110, 120];
  return {
    listingAt: options.listingAt ?? 0,
    symbol: "TEST",
    totalSupply: 1_000,
    marketId: "TEST-FDV",
    question: "Will TEST reach the frozen target FDV?",
    targetFdv: options.targetFdv ?? 500_000,
    candles: closes.map((close, index) => ({
      openTs: index * 60_000,
      closeTs: index * 60_000 + 59_999,
      close
    })),
    yesPrices: [
      { ts: 30_000, yesPrice: 0.2 },
      { ts: 90_000, yesPrice: 0.3 },
      { ts: 150_000, yesPrice: 0.4 }
    ]
  };
}
