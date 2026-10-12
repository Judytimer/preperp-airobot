import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { domainEvent, NullDomainEventSink, type DomainEventSink } from "../observability/domain-event.ts";
import type { PriceTargetEpisodeState, PriceTargetManifest } from "./price-target-admission.ts";

export const LAYA_SHADOW_REVIEW_SCHEMA_VERSION = "1.0.0" as const;
export const LAYA_SHADOW_REVIEW_MODE = "SHADOW_READ_ONLY" as const;

const REVIEW_QUESTION = Object.freeze({
  evidence_posture: Object.freeze({
    type: "choice",
    instructions:
      "Classify whether this frozen-admission candidate snapshot is internally coherent. " +
      "Do not predict price direction, profitability, or whether an order should be placed.",
    criteria: Object.freeze({
      consistent: "The snapshot is coherent with a completed upward crossing and usable pre-trigger entry evidence",
      manual_review: "The snapshot is plausible but contains ambiguity that requires human review",
      insufficient: "The snapshot lacks enough evidence to review"
    })
  })
});

const REVIEW_CHOICES = new Set(["consistent", "manual_review", "insufficient"]);

type ReviewCandidate = {
  readonly manifest: PriceTargetManifest;
  readonly state: PriceTargetEpisodeState & { readonly candidate: NonNullable<PriceTargetEpisodeState["candidate"]> };
};

export type LayaShadowReviewEvidence = {
  readonly schemaVersion: typeof LAYA_SHADOW_REVIEW_SCHEMA_VERSION;
  readonly mode: typeof LAYA_SHADOW_REVIEW_MODE;
  readonly reviewedAt: number;
  readonly candidateId: string;
  readonly manifestId: string;
  readonly candidateT0: number;
  readonly inputSha256: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: {
    readonly choice: "consistent" | "manual_review" | "insufficient";
    readonly probabilities: Readonly<Record<string, number>>;
    readonly confidence: number;
    readonly answerConfidence: number;
    readonly confidenceSemantics: "SERVICE_REPORTED_NOT_USED_FOR_AUTHORIZATION";
    readonly serviceModel: string;
    readonly routedModel: string;
    readonly inferenceMs: number | null;
    readonly usage: Readonly<Record<string, unknown>>;
  };
  readonly authority: {
    readonly canMutateAdmission: false;
    readonly canMutateStrategy: false;
    readonly canSubmitOrders: false;
    readonly statement: string;
  };
};

export type LayaCandidateReviewCycle = {
  readonly status: "REVIEW_CYCLE_COMPLETED";
  readonly discoveredQualified: number;
  readonly alreadyReviewed: number;
  readonly completed: number;
  readonly failed: number;
  readonly latestReviewPath: string | null;
};

export type LayaCandidateReviewDependencies = {
  readonly endpoint?: string;
  readonly eventSink?: DomainEventSink;
  readonly fetcher?: typeof fetch;
  readonly maxReviews?: number;
  readonly now?: () => number;
  readonly timeoutMs?: number;
};

export async function runLayaCandidateReviewCycle(
  evidenceRoot: string,
  dependencies: LayaCandidateReviewDependencies = {}
): Promise<LayaCandidateReviewCycle> {
  const root = resolve(evidenceRoot);
  const reviewsRoot = join(root, "laya-shadow-v1", "reviews");
  const fetcher = dependencies.fetcher ?? fetch;
  const endpoint = (dependencies.endpoint ?? process.env.LAYA_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const eventSink = dependencies.eventSink ?? new NullDomainEventSink();
  const now = dependencies.now ?? Date.now;
  const maxReviews = dependencies.maxReviews ?? 1;
  const timeoutMs = dependencies.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(maxReviews) || maxReviews < 0) throw new Error("maxReviews must be a non-negative integer");
  if (!isLoopbackEndpoint(endpoint)) throw new Error("Laya shadow review requires a loopback endpoint");
  await mkdir(reviewsRoot, { recursive: true });

  const candidates = await loadQualifiedCandidates(root);
  let alreadyReviewed = 0;
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let latestReviewPath: string | null = null;

  for (const candidate of candidates) {
    const reviewPath = join(reviewsRoot, `${safeSegment(candidate.state.candidate.candidateId)}.json`);
    if (await fileExists(reviewPath)) {
      alreadyReviewed += 1;
      continue;
    }
    if (attempted >= maxReviews) continue;
    attempted += 1;

    const correlationId = `laya-shadow-${candidate.state.candidate.candidateId}`;
    await eventSink.publish(domainEvent({
      type: "CANDIDATE_QUALIFIED",
      occurredAt: candidate.state.candidate.candidateT0,
      correlationId,
      payload: {
        candidateId: candidate.state.candidate.candidateId,
        manifestId: candidate.manifest.manifestId,
        mode: LAYA_SHADOW_REVIEW_MODE
      }
    }));
    await eventSink.publish(domainEvent({
      type: "LAYA_REVIEW_STARTED",
      correlationId,
      payload: { candidateId: candidate.state.candidate.candidateId, endpoint }
    }));

    try {
      const input = buildReviewInput(candidate.manifest, candidate.state);
      const inputSha256 = sha256(JSON.stringify(input));
      const startedAt = now();
      const response = await fetcher(`${endpoint}/v1/systemone`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ state: input, questions: REVIEW_QUESTION, model: "english", max_len: 512 }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const finishedAt = now();
      if (!response.ok) throw new Error(`Laya review HTTP ${response.status}`);
      const raw: unknown = await response.json();
      const result = parseLayaResult(raw, response.headers.get("x-inference-time-ms"));
      const evidence: LayaShadowReviewEvidence = Object.freeze({
        schemaVersion: LAYA_SHADOW_REVIEW_SCHEMA_VERSION,
        mode: LAYA_SHADOW_REVIEW_MODE,
        reviewedAt: finishedAt,
        candidateId: candidate.state.candidate.candidateId,
        manifestId: candidate.manifest.manifestId,
        candidateT0: candidate.state.candidate.candidateT0,
        inputSha256,
        input,
        result: {
          ...result,
          confidenceSemantics: "SERVICE_REPORTED_NOT_USED_FOR_AUTHORIZATION",
          inferenceMs: result.inferenceMs ?? Math.max(0, finishedAt - startedAt)
        },
        authority: {
          canMutateAdmission: false,
          canMutateStrategy: false,
          canSubmitOrders: false,
          statement: "Laya is advisory shadow evidence only; deterministic frozen rules remain authoritative."
        }
      });
      await writeImmutable(reviewPath, `${JSON.stringify(evidence, null, 2)}\n`);
      completed += 1;
      latestReviewPath = reviewPath;
      await eventSink.publish(domainEvent({
        type: "LAYA_REVIEW_COMPLETED",
        occurredAt: finishedAt,
        correlationId,
        payload: {
          candidateId: evidence.candidateId,
          choice: evidence.result.choice,
          confidence: evidence.result.confidence,
          answerConfidence: evidence.result.answerConfidence,
          reviewPath
        }
      }));
    } catch (error) {
      failed += 1;
      await eventSink.publish(domainEvent({
        type: "LAYA_REVIEW_FAILED",
        correlationId,
        payload: { candidateId: candidate.state.candidate.candidateId, reason: safeError(error) }
      }));
    }
  }

  return Object.freeze({
    status: "REVIEW_CYCLE_COMPLETED",
    discoveredQualified: candidates.length,
    alreadyReviewed,
    completed,
    failed,
    latestReviewPath
  });
}

export function buildReviewInput(
  manifest: PriceTargetManifest,
  state: PriceTargetEpisodeState & { readonly candidate: NonNullable<PriceTargetEpisodeState["candidate"]> }
): Readonly<Record<string, unknown>> {
  const candidate = state.candidate;
  const bookAgeMs = candidate.candidateT0 - candidate.yesBookObservedAt;
  return Object.freeze({
    reviewPurpose: "evidence_consistency_only",
    admissionStatus: state.status,
    protocolVersion: manifest.protocolVersion,
    candidateId: candidate.candidateId,
    manifestId: manifest.manifestId,
    cohortKey: manifest.cohortKey,
    asset: manifest.episode.asset,
    measurementAt: manifest.episode.measurementAt,
    cutoffT0: manifest.episode.cutoffT0,
    candidateT0: candidate.candidateT0,
    selectedStrike: candidate.selectedStrike,
    crossingPreviousClose: candidate.crossingPreviousClose,
    crossingClose: candidate.crossingClose,
    entryBestAsk: candidate.entryBestAsk,
    entryBestAskSize: candidate.entryBestAskSize,
    yesBookObservedAt: candidate.yesBookObservedAt,
    bookAgeMs,
    deterministicChecks: Object.freeze({
      upwardCrossing: candidate.crossingPreviousClose < candidate.selectedStrike && candidate.crossingClose >= candidate.selectedStrike,
      beforeCutoff: candidate.candidateT0 < manifest.episode.cutoffT0,
      preT0Book: bookAgeMs >= 0,
      bookFreshWithin120s: bookAgeMs <= 120_000,
      usableAsk: candidate.entryBestAsk > 0 && candidate.entryBestAsk < 1 && candidate.entryBestAskSize > 0
    })
  });
}

async function loadQualifiedCandidates(root: string): Promise<readonly ReviewCandidate[]> {
  const statesRoot = join(root, "states");
  const manifestsRoot = join(root, "manifests");
  const names = await readdir(statesRoot).catch(() => [] as string[]);
  const candidates: ReviewCandidate[] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const state = await readJson(join(statesRoot, name));
    if (!isReviewableState(state)) continue;
    const manifest = await readJson(join(manifestsRoot, `${safeSegment(state.manifestId)}.json`));
    if (!isReviewableManifest(manifest, state.manifestId)) continue;
    candidates.push({ manifest, state });
  }
  return candidates.sort((left, right) => left.state.candidate.candidateT0 - right.state.candidate.candidateT0);
}

function parseLayaResult(raw: unknown, inferenceHeader: string | null): LayaShadowReviewEvidence["result"] {
  if (!isRecord(raw) || !isRecord(raw.answers) || !isRecord(raw.answers.evidence_posture)) {
    throw new Error("Laya review response is malformed");
  }
  const answer = raw.answers.evidence_posture;
  if (typeof answer.choice !== "string" || !REVIEW_CHOICES.has(answer.choice)) {
    throw new Error("Laya review choice is invalid");
  }
  const probabilities = numberRecord(answer.probabilities, "Laya probabilities");
  const confidence = finiteNumber(answer.confidence, "Laya confidence");
  const answerConfidence = finiteNumber(answer.answer_confidence, "Laya answer confidence");
  const routing = isRecord(raw.routing) ? raw.routing : {};
  const usage = isRecord(raw.usage) ? Object.freeze({ ...raw.usage }) : Object.freeze({});
  if (usage.truncated === true) throw new Error("Laya review input was truncated");
  return Object.freeze({
    choice: answer.choice as LayaShadowReviewEvidence["result"]["choice"],
    probabilities,
    confidence,
    answerConfidence,
    confidenceSemantics: "SERVICE_REPORTED_NOT_USED_FOR_AUTHORIZATION",
    serviceModel: typeof raw.model === "string" ? raw.model : "unknown",
    routedModel: typeof routing.model === "string" ? routing.model : "unknown",
    inferenceMs: optionalNonNegativeNumber(inferenceHeader),
    usage
  });
}

function isReviewableState(value: unknown): value is ReviewCandidate["state"] {
  if (!isRecord(value) || value.status !== "QUALIFIED" || !isRecord(value.candidate)) return false;
  return typeof value.manifestId === "string" &&
    typeof value.candidate.candidateId === "string" &&
    Number.isFinite(value.candidate.candidateT0) &&
    Number.isFinite(value.candidate.crossingPreviousClose) &&
    Number.isFinite(value.candidate.crossingClose) &&
    Number.isFinite(value.candidate.selectedStrike) &&
    Number.isFinite(value.candidate.entryBestAsk) &&
    Number.isFinite(value.candidate.entryBestAskSize) &&
    Number.isFinite(value.candidate.yesBookObservedAt);
}

function isReviewableManifest(value: unknown, manifestId: string): value is PriceTargetManifest {
  return isRecord(value) && value.manifestId === manifestId && isRecord(value.episode) &&
    typeof value.protocolVersion === "string" && typeof value.cohortKey === "string" &&
    typeof value.episode.asset === "string" && Number.isFinite(value.episode.measurementAt) &&
    Number.isFinite(value.episode.cutoffT0);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function writeImmutable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("unsafe candidate identifier");
  return safe;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isLoopbackEndpoint(endpoint: string): boolean {
  return endpoint.startsWith("http://127.0.0.1:") || endpoint.startsWith("http://localhost:");
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid`);
  return value;
}

function optionalNonNegativeNumber(value: string | null): number | null {
  if (value === null || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function numberRecord(value: unknown, label: string): Readonly<Record<string, number>> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([, item]) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, number>);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown Laya review failure";
}
