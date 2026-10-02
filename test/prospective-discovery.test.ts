import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  POLYMARKET_DISCOVERY_SOURCE_URL,
  runPolymarketDiscoveryScan
} from "../src/overlay/prospective-discovery.ts";

test("archives a public Gamma response and records all first-seen markets without triggering admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  const raw = JSON.stringify([
    market("FDV-1", "Will TEST exceed $1B FDV?", "2026-10-02T12:00:00Z"),
    market("OTHER-1", "Will BTC exceed $100K?", "2026-10-02T12:01:00Z")
  ]);
  const result = await runPolymarketDiscoveryScan(directory, {
    now: () => Date.parse("2026-10-02T12:05:00Z"),
    fetcher: ok(raw)
  });

  assert.equal(result.scan.sourceUrl, POLYMARKET_DISCOVERY_SOURCE_URL);
  assert.equal(result.scan.observedMarkets, 2);
  assert.equal(result.scan.newDiscoveries, 2);
  assert.equal(result.scan.potentialFdvReviews, 1);
  assert.equal(result.scan.coverage.exhaustive, false);
  assert.equal(createHash("sha256").update(await readFile(result.rawPath, "utf8")).digest("hex"), result.scan.sha256);

  const fdv = JSON.parse(await readFile(join(directory, "markets", "FDV-1.json"), "utf8"));
  assert.equal(fdv.disposition, "POTENTIAL_FDV_REVIEW");
  assert.equal(fdv.registeredAt, fdv.discovery.firstDiscoveredAt);
  assert.equal(fdv.discovery.firstDiscoveredAt, fdv.discovery.retrievedAt);
  assert.equal(fdv.acquisitionClock.basis, "POLYMARKET_HTTP_DATE");
  assert.equal(fdv.acquisitionClock.sourceDate, Date.parse("2026-10-02T12:05:00Z"));
  assert.match(fdv.discovery.rawResponsePath, /^\.\.\/raw\//);

  const other = JSON.parse(await readFile(join(directory, "markets", "OTHER-1.json"), "utf8"));
  assert.equal(other.disposition, "IGNORED_NON_FDV_TEXT");
});

test("a repeated fetch preserves the immutable first-discovery time and does not duplicate registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  const raw = JSON.stringify([market("FDV-1", "TEST fully diluted valuation above $1B?", "2026-10-02T12:00:00Z")]);
  await runPolymarketDiscoveryScan(directory, {
    now: () => Date.parse("2026-10-02T12:05:00Z"),
    fetcher: ok(raw)
  });
  const second = await runPolymarketDiscoveryScan(directory, {
    now: () => Date.parse("2026-10-02T12:10:00Z"),
    fetcher: ok(raw)
  });
  const record = JSON.parse(await readFile(join(directory, "markets", "FDV-1.json"), "utf8"));

  assert.equal(second.scan.newDiscoveries, 0);
  assert.equal(record.discovery.firstDiscoveredAt, Date.parse("2026-10-02T12:05:00Z"));
  assert.equal((await readdir(join(directory, "markets"))).length, 1);
});

test("future source timestamps are recorded DATA_BLOCKED and ordinary market-cap text is not called FDV", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  const raw = JSON.stringify([
    market("FUTURE-1", "Will TEST exceed $1B FDV?", "2026-10-02T12:10:00Z"),
    market("MCAP-1", "Will TEST market cap exceed $1B?", "2026-10-02T12:00:00Z")
  ]);
  await runPolymarketDiscoveryScan(directory, {
    now: () => Date.parse("2026-10-02T12:05:00Z"),
    fetcher: ok(raw)
  });
  const future = JSON.parse(await readFile(join(directory, "markets", "FUTURE-1.json"), "utf8"));
  const marketCap = JSON.parse(await readFile(join(directory, "markets", "MCAP-1.json"), "utf8"));

  assert.equal(future.disposition, "DATA_BLOCKED");
  assert.match(future.reason, /updatedAt is after retrievedAt/);
  assert.equal(marketCap.disposition, "IGNORED_NON_FDV_TEXT");
});

test("HTTP and malformed payload failures publish no scan or market records", async () => {
  const httpDirectory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  await assert.rejects(
    runPolymarketDiscoveryScan(httpDirectory, { fetcher: async () => new Response("bad", { status: 503 }) }),
    /HTTP 503/
  );
  assert.deepEqual(await readdir(httpDirectory), []);

  const jsonDirectory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  await assert.rejects(
    runPolymarketDiscoveryScan(jsonDirectory, { fetcher: ok("not json") }),
    /not valid JSON/
  );
  assert.deepEqual(await readdir(jsonDirectory), []);

  const dateDirectory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  await assert.rejects(
    runPolymarketDiscoveryScan(dateDirectory, {
      fetcher: async () => new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }),
    /Date header is missing or invalid/
  );
  assert.deepEqual(await readdir(dateDirectory), []);
});

function market(id: string, question: string, updatedAt: string) {
  return {
    id,
    question,
    slug: `market-${id.toLowerCase()}`,
    description: "Frozen resolution rules.",
    createdAt: "2026-10-02T11:00:00Z",
    updatedAt,
    startDate: "2026-10-02T11:01:00Z",
    acceptingOrdersTimestamp: "2026-10-02T11:02:00Z",
    endDate: "2026-11-02T11:00:00Z",
    active: true,
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true
  };
}

function ok(body: string, date = "Fri, 02 Oct 2026 12:05:00 GMT"): typeof fetch {
  return async () => new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", date }
  });
}
