import { pathToFileURL } from "node:url";

import { JsonlDomainEventSink } from "../observability/domain-event.ts";
import { runtimeEvidencePath, runtimeLogPath } from "../runtime-paths.ts";
import { runLayaCandidateReviewCycle } from "./laya-candidate-review.ts";

async function main(): Promise<void> {
  const eventSink = new JsonlDomainEventSink(runtimeLogPath("domain-events.jsonl"));
  const result = await runLayaCandidateReviewCycle(runtimeEvidencePath("price-target-v1"), { eventSink });
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
