import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  POLYMARKET_DISCOVERY_SOURCE_URL,
  POLYMARKET_LEGACY_DISCOVERY_SOURCE_URL,
  runPolymarketDiscoveryScan
} from "../src/overlay/prospective-discovery.ts";

test("FDV search records only crypto-tagged markets without triggering admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  const raw = search([
    event("CRYPTO-FDV", [
      market("FDV-1", "Will TEST exceed $1B FDV?", "2026-10-02T12:00:00Z"),
      market("OTHER-1", "Will BTC exceed $100K?", "2026-10-02T12:01:00Z")
    ], true),
    event("NON-CRYPTO-FDV", [
      market("IGNORED-1", "Will COMPANY exceed $1B FDV?", "2026-10-02T12:02:00Z")
    ], false)
  ]);
  const result = await runPolymarketDiscoveryScan(directory, {
    now: () => Date.parse("2026-10-02T12:05:00Z"),
    fetcher: ok(raw, "Fri, 02 Oct 2026 12:05:00 GMT", "120")
  });

  assert.equal(result.scan.sourceUrl, POLYMARKET_DISCOVERY_SOURCE_URL);
  assert.equal(result.scan.schemaVersion, "2.1.1");
  assert.equal(result.scan.observedMarkets, 2);
  assert.equal(result.scan.newDiscoveries, 2);
  assert.equal(result.scan.potentialFdvReviews, 1);
  assert.equal(result.scan.coverage.exhaustive, false);
  assert.equal(createHash("sha256").update(await readFile(result.rawPath, "utf8")).digest("hex"), result.scan.sha256);

  const fdv = JSON.parse(await readFile(join(directory, "markets", "FDV-1.json"), "utf8"));
  assert.equal(fdv.disposition, "POTENTIAL_FDV_REVIEW");
  assert.equal(fdv.schemaVersion, "2.1.1");
  assert.equal(fdv.registeredAt, fdv.discovery.firstDiscoveredAt);
  assert.equal(fdv.discovery.firstDiscoveredAt, fdv.discovery.retrievedAt);
  assert.equal(fdv.discovery.sourceUrl, POLYMARKET_DISCOVERY_SOURCE_URL);
  assert.equal(fdv.acquisitionClock.basis, "POLYMARKET_HTTP_DATE_PLUS_AGE");
  assert.equal(fdv.acquisitionClock.sourceDate, Date.parse("2026-10-02T12:05:00Z"));
  assert.equal(fdv.acquisitionClock.responseAgeSeconds, 120);
  assert.equal(fdv.discovery.retrievedAt, Date.parse("2026-10-02T12:07:00Z"));
  assert.match(fdv.discovery.rawResponsePath, /^\.\.\/raw\//);

  const other = JSON.parse(await readFile(join(directory, "markets", "OTHER-1.json"), "utf8"));
  assert.equal(other.disposition, "IGNORED_NON_FDV_TEXT");
  await assert.rejects(readFile(join(directory, "markets", "IGNORED-1.json"), "utf8"), { code: "ENOENT" });
});

test("a repeated active discovery preserves a legacy first-discovery record exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  const raw = search([event("CRYPTO-FDV", [
    market("FDV-1", "TEST fully diluted valuation above $1B?", "2026-10-02T12:00:00Z")
  ], true)]);
  await runPolymarketDiscoveryScan(directory, {
    now: () => Date.parse("2026-10-02T12:05:00Z"),
    fetcher: ok(raw)
  });

  const recordPath = join(directory, "markets", "FDV-1.json");
  const legacy = JSON.parse(await readFile(recordPath, "utf8"));
  legacy.schemaVersion = "2.1.0";
  legacy.discovery.sourceUrl = POLYMARKET_LEGACY_DISCOVERY_SOURCE_URL;
  delete legacy.acquisitionClock;
  await writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  const before = await readFile(recordPath, "utf8");

  const second = await runPolymarketDiscoveryScan(directory, {
    now: () => Date.parse("2026-10-02T12:10:00Z"),
    fetcher: ok(raw)
  });
  const after = await readFile(recordPath, "utf8");
  const record = JSON.parse(after);

  assert.equal(second.scan.newDiscoveries, 0);
  assert.equal(record.discovery.firstDiscoveredAt, Date.parse("2026-10-02T12:05:00Z"));
  assert.equal(record.schemaVersion, "2.1.0");
  assert.equal(record.discovery.sourceUrl, POLYMARKET_LEGACY_DISCOVERY_SOURCE_URL);
  assert.equal(record.acquisitionClock, undefined);
  assert.equal(after, before);
  assert.equal((await readdir(join(directory, "markets"))).length, 1);
});

test("scan summaries are append-only and a scan id collision cannot rewrite evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  const raw = search([event("CRYPTO-FDV", [
    market("FDV-1", "Will TEST exceed $1B FDV?", "2026-10-02T12:00:00Z")
  ], true)]);
  const first = await runPolymarketDiscoveryScan(directory, {
    now: () => Date.parse("2026-10-02T12:05:00Z"),
    fetcher: ok(raw),
    scanIdFactory: () => "fixed-scan"
  });
  const before = await readFile(first.scanPath, "utf8");
  await assert.rejects(
    runPolymarketDiscoveryScan(directory, {
      now: () => Date.parse("2026-10-02T12:10:00Z"),
      fetcher: ok(raw),
      scanIdFactory: () => "fixed-scan"
    }),
    /scan id collision/
  );
  assert.equal(await readFile(first.scanPath, "utf8"), before);
});

test("future source timestamps are DATA_BLOCKED and ordinary market-cap text is not FDV", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  const raw = search([event("CRYPTO-FDV", [
    market("FUTURE-1", "Will TEST exceed $1B FDV?", "2026-10-02T12:10:00Z"),
    market("MCAP-1", "Will TEST market cap exceed $1B?", "2026-10-02T12:00:00Z")
  ], true)]);
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

  const partialDirectory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  const partiallyMalformed = search([event("CRYPTO-FDV", [
    market("VALID-1", "Will TEST exceed $1B FDV?", "2026-10-02T12:00:00Z"),
    { question: "missing market id" }
  ], true)]);
  await assert.rejects(
    runPolymarketDiscoveryScan(partialDirectory, { fetcher: ok(partiallyMalformed) }),
    /without an id/
  );
  assert.deepEqual(await readdir(partialDirectory), []);

  const dateDirectory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  await assert.rejects(
    runPolymarketDiscoveryScan(dateDirectory, {
      fetcher: async () => new Response(search([]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }),
    /Date header is missing or invalid/
  );
  assert.deepEqual(await readdir(dateDirectory), []);

  const ageDirectory = await mkdtemp(join(tmpdir(), "prospective-discovery-"));
  await assert.rejects(
    runPolymarketDiscoveryScan(ageDirectory, {
      fetcher: ok(search([]), "Fri, 02 Oct 2026 12:05:00 GMT", "1.5")
    }),
    /Age header is invalid/
  );
  assert.deepEqual(await readdir(ageDirectory), []);
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

function event(id: string, markets: readonly unknown[], crypto: boolean) {
  return {
    id,
    title: `Event ${id}`,
    tags: [{ id: crypto ? "21" : "999", slug: crypto ? "crypto" : "business" }],
    markets
  };
}

function search(events: readonly unknown[]) {
  return JSON.stringify({
    events,
    pagination: { hasMore: false, totalResults: events.length }
  });
}

function ok(
  body: string,
  date = "Fri, 02 Oct 2026 12:05:00 GMT",
  age?: string
): typeof fetch {
  return async () => new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      date,
      ...(age === undefined ? {} : { age })
    }
  });
}
