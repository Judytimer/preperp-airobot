import type {
  EvidenceSearch,
  LlmStrategyReviewer,
  ResearchRouter,
  ShadowErrorCode,
  ShadowRecord,
  ShadowResult,
  ShadowRunner,
  ShadowStartResult,
  TradeCandidate
} from "./types.ts";

export type ShadowRecordSink = (record: ShadowRecord) => void;

export type BoundedShadowRunnerConfig = {
  router: ResearchRouter;
  search: EvidenceSearch;
  reviewer: LlmStrategyReviewer;
  record: ShadowRecordSink;
  maxInFlight?: number;
};

type ActiveTask = {
  candidateId: string;
  finalized: boolean;
  promise: Promise<void>;
};

export class ShadowProviderUnavailableError extends Error {}

export class BoundedShadowRunner implements ShadowRunner {
  private readonly router: ResearchRouter;
  private readonly search: EvidenceSearch;
  private readonly reviewer: LlmStrategyReviewer;
  private readonly recordSink: ShadowRecordSink;
  private readonly maxInFlight: number;
  private readonly tasks = new Map<number, ActiveTask>();
  private nextTaskId = 1;

  constructor(config: BoundedShadowRunnerConfig) {
    const maxInFlight = config.maxInFlight ?? 2;
    if (!Number.isInteger(maxInFlight) || maxInFlight <= 0) {
      throw new Error("maxInFlight must be a positive integer");
    }
    this.router = config.router;
    this.search = config.search;
    this.reviewer = config.reviewer;
    this.recordSink = config.record;
    this.maxInFlight = maxInFlight;
  }

  start(candidate: TradeCandidate): ShadowStartResult {
    if (this.tasks.size >= this.maxInFlight) {
      const record: ShadowRecord = {
        candidateId: candidate.candidateId,
        status: "SKIPPED_CAPACITY",
        completedAt: Date.now()
      };
      queueMicrotask(() => this.emit(record));
      return { accepted: false, status: "SKIPPED_CAPACITY" };
    }

    const frozenCandidate = deepFreeze(structuredClone(candidate));
    const taskId = this.nextTaskId++;
    let resolveTask!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    this.tasks.set(taskId, {
      candidateId: frozenCandidate.candidateId,
      finalized: false,
      promise
    });

    queueMicrotask(() => {
      void this.run(taskId, frozenCandidate).then(resolveTask, resolveTask);
    });
    return { accepted: true };
  }

  async drain(timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("timeoutMs must be finite and non-negative");
    }
    const observedTasks = [...this.tasks.entries()].filter(([, task]) => !task.finalized);
    if (observedTasks.length === 0) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled(observedTasks.map(([, task]) => task.promise)).then(() => false),
      new Promise<true>((resolve) => {
        timeout = setTimeout(() => resolve(true), timeoutMs);
      })
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (!timedOut) return;

    for (const [taskId, task] of observedTasks) {
      const active = this.tasks.get(taskId);
      if (active === undefined || active.finalized) continue;
      active.finalized = true;
      this.emit({
        candidateId: task.candidateId,
        status: "INCOMPLETE",
        completedAt: Date.now()
      });
    }
  }

  private async run(taskId: number, candidate: TradeCandidate): Promise<void> {
    let stage: "ROUTER" | "SEARCH" | "REVIEWER" = "ROUTER";
    try {
      const plan = this.router.route(candidate);
      stage = "SEARCH";
      const evidence = await this.search.search(candidate, plan);
      stage = "REVIEWER";
      const result = await this.reviewer.review(candidate, plan, evidence);
      if (!isShadowResult(result)) {
        this.finish(taskId, {
          candidateId: candidate.candidateId,
          status: "PROVIDER_FAILED",
          completedAt: Date.now(),
          errorCode: "INVALID_PROVIDER_RESPONSE"
        });
        return;
      }
      this.finish(taskId, completedRecord(candidate.candidateId, result));
    } catch (error) {
      const unavailable = stage !== "ROUTER" && error instanceof ShadowProviderUnavailableError;
      this.finish(taskId, {
        candidateId: candidate.candidateId,
        status: unavailable ? "PROVIDER_UNAVAILABLE" : "PROVIDER_FAILED",
        completedAt: Date.now(),
        errorCode: errorCode(stage, unavailable)
      });
    }
  }

  private finish(taskId: number, record: ShadowRecord): void {
    const task = this.tasks.get(taskId);
    if (task === undefined) return;
    this.tasks.delete(taskId);
    if (task.finalized) return;
    this.emit(record);
  }

  private emit(record: ShadowRecord): void {
    try {
      this.recordSink(record);
    } catch {
      // Shadow record sinks have no authority to affect execution or task cleanup.
    }
  }
}

function completedRecord(candidateId: string, result: ShadowResult): ShadowRecord {
  return {
    candidateId,
    status: "COMPLETED",
    completedAt: Date.now(),
    shadowVerdict: result.verdict,
    result: structuredClone(result)
  };
}

function errorCode(
  stage: "ROUTER" | "SEARCH" | "REVIEWER",
  unavailable: boolean
): ShadowErrorCode {
  if (stage === "ROUTER") return "INTERNAL_SHADOW_ERROR";
  if (stage === "SEARCH") return unavailable ? "SEARCH_UNAVAILABLE" : "SEARCH_FAILED";
  return unavailable ? "REVIEWER_UNAVAILABLE" : "REVIEWER_FAILED";
}

function isShadowResult(value: ShadowResult): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ["PASS", "WOULD_BLOCK", "ABSTAIN"].includes(value.verdict)
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
