import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBuildIdentity } from "../src/build-identity.ts";
import {
  DOMAIN_EVENT_PROTOCOL_VERSION,
  domainEvent,
  JsonlDomainEventSink
} from "../src/observability/domain-event.ts";
import { resolveRuntimePaths } from "../src/runtime-paths.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("packaged runtime paths stay under the explicitly configured data root", () => {
  const paths = resolveRuntimePaths({ PREPERP_DATA_ROOT: "app-data" }, "C:\\workspace");
  assert.equal(paths.dataRoot, "C:\\workspace\\app-data");
  assert.equal(paths.evidenceRoot, "C:\\workspace\\app-data\\work");
  assert.equal(paths.stateRoot, "C:\\workspace\\app-data\\state");
  assert.equal(paths.logRoot, "C:\\workspace\\app-data\\logs");
});

test("repository development retains the existing work and .runtime layout", () => {
  const paths = resolveRuntimePaths({}, "C:\\workspace");
  assert.equal(paths.evidenceRoot, "C:\\workspace\\work");
  assert.equal(paths.stateRoot, "C:\\workspace\\.runtime");
  assert.equal(paths.logRoot, "C:\\workspace\\.runtime\\logs");
});

test("packaged build identity accepts only an explicit full commit", () => {
  assert.deepEqual(resolveBuildIdentity({
    PREPERP_BUILD_COMMIT: COMMIT,
    PREPERP_BUILD_VERSION: "0.2.0"
  }), {
    version: "0.2.0",
    repositoryCommit: COMMIT,
    source: "INJECTED"
  });
  assert.throws(
    () => resolveBuildIdentity({ PREPERP_BUILD_COMMIT: "short" }),
    /40-character lowercase Git commit/
  );
});

test("JSONL event sink serializes concurrent publishers without losing records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preperp-events-"));
  try {
    const path = join(directory, "events.jsonl");
    const sink = new JsonlDomainEventSink(path);
    await Promise.all([
      sink.publish(domainEvent({
        type: "WATCH_CYCLE_STARTED",
        correlationId: "cycle-1",
        payload: { watch: true }
      })),
      sink.publish(domainEvent({
        type: "WATCH_CYCLE_COMPLETED",
        correlationId: "cycle-1",
        payload: { qualified: 0 }
      }))
    ]);
    const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.equal(records[0].protocolVersion, DOMAIN_EVENT_PROTOCOL_VERSION);
    assert.deepEqual(records.map((record) => record.type), ["WATCH_CYCLE_STARTED", "WATCH_CYCLE_COMPLETED"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
