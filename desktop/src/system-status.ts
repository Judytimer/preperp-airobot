import { invoke } from "@tauri-apps/api/core";

export type ServicePhase = "OFFLINE" | "SERVICE_STARTING" | "SERVICE_READY_MODEL_COLD" | "MODEL_READY" | "FAILED";

export type SystemStatus = {
  readonly observedAt: number;
  readonly build: {
    readonly version: string;
    readonly commit: string;
  };
  readonly runtime: {
    readonly mode: "DEVELOPMENT" | "LOCAL_WORKSPACE" | "PACKAGED";
    readonly dataRoot: string;
    readonly evidenceRoot: string;
    readonly stateRoot: string;
    readonly logRoot: string;
  };
  readonly laya: {
    readonly phase: ServicePhase;
    readonly endpoint: string;
    readonly loadedModels: readonly string[];
    readonly device: string | null;
    readonly detail: string | null;
  };
  readonly layaReview: {
    readonly phase: "NO_REVIEW" | "COMPLETED" | "FAILED";
    readonly reviewedAt: number | null;
    readonly candidateId: string | null;
    readonly choice: "consistent" | "manual_review" | "insufficient" | null;
    readonly confidence: number | null;
    readonly answerConfidence: number | null;
    readonly inferenceMs: number | null;
    readonly model: string | null;
    readonly artifactPath: string | null;
    readonly detail: string | null;
  };
  readonly watcher: {
    readonly phase: "RUNNING" | "STALE" | "NEVER_RUN" | "FAILED";
    readonly processAlive: boolean;
    readonly latestCycleAt: number | null;
    readonly latestScanPath: string | null;
    readonly discoveredEpisodes: number;
    readonly registeredEpisodes: number;
    readonly admission: {
      readonly waiting: number;
      readonly qualified: number;
      readonly dataBlocked: number;
      readonly notTriggered: number;
    } | null;
  };
  readonly hourlyWatcher: {
    readonly phase: "RUNNING" | "STALE" | "NEVER_RUN" | "FAILED";
    readonly processAlive: boolean;
    readonly latestCycleAt: number | null;
    readonly latestScanPath: string | null;
    readonly monitoredAssets: readonly string[];
    readonly marketSuppliedAssets: readonly string[];
    readonly discoveredEpisodes: number;
    readonly activeEpisodes: number;
    readonly admission: {
      readonly waiting: number;
      readonly qualified: number;
      readonly dataBlocked: number;
      readonly expired: number;
    } | null;
  };
  readonly predictionTestnet: {
    readonly phase: "DISARMED" | "STARTING" | "ARMED_WAITING_CANDIDATE" | "EXECUTING" | "ROUND_TRIP_COMPLETE" | "FAILED_REVIEW_REQUIRED";
    readonly processAlive: boolean;
    readonly updatedAt: number | null;
    readonly armedAt: number | null;
    readonly allowedAssets: readonly string[];
    readonly candidateId: string | null;
    readonly venueSymbol: string | null;
    readonly evidencePath: string | null;
    readonly detail: string | null;
  };
  readonly supervisor: {
    readonly resident: boolean;
    readonly startedAt: number;
    readonly cadenceMs: number;
    readonly cloudAiRequired: boolean;
    readonly layaLocalOnly: boolean;
    readonly testnetAutoArm: boolean;
  };
  readonly latestCandidate: {
    readonly variant: "PRICE_TARGET_V1" | "HOURLY_UP_DOWN_V1";
    readonly candidateId: string;
    readonly asset: string;
    readonly direction: "UP" | "DOWN" | null;
    readonly question: string;
    readonly eventTitle: string;
    readonly candidateT0: number;
    readonly measurementAt: number;
    readonly selectedStrike: number | null;
    readonly referenceOpen: number | null;
    readonly crossingPreviousClose: number;
    readonly crossingClose: number;
    readonly entryBestAsk: number;
    readonly entryBestAskSize: number;
  } | null;
  readonly authority: {
    readonly executionEnabled: boolean;
    readonly testnetDemoArmed: boolean;
    readonly mainnetEnabled: false;
    readonly layaExecutionAuthority: false;
    readonly statement: string;
  };
};

export async function fetchSystemStatus(): Promise<SystemStatus> {
  return invoke<SystemStatus>("system_status");
}
