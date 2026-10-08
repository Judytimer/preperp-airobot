import { execFileSync } from "node:child_process";

export type BuildIdentity = {
  readonly version: string;
  readonly repositoryCommit: string;
  readonly source: "INJECTED" | "GIT_WORKTREE";
};

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Packaged runtimes must inject PREPERP_BUILD_COMMIT. Git lookup is retained
 * only for repository development and deliberately fails closed otherwise.
 */
export function resolveBuildIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd()
): BuildIdentity {
  const injected = env.PREPERP_BUILD_COMMIT?.trim().toLowerCase();
  if (injected !== undefined && injected.length > 0) {
    assertCommit(injected, "PREPERP_BUILD_COMMIT");
    return Object.freeze({
      version: env.PREPERP_BUILD_VERSION?.trim() || "0.1.0",
      repositoryCommit: injected,
      source: "INJECTED"
    });
  }

  let repositoryCommit: string;
  try {
    repositoryCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().toLowerCase();
  } catch {
    throw new Error("build identity unavailable; set PREPERP_BUILD_COMMIT for packaged runtime");
  }
  assertCommit(repositoryCommit, "git repository commit");
  return Object.freeze({
    version: env.PREPERP_BUILD_VERSION?.trim() || "0.1.0-dev",
    repositoryCommit,
    source: "GIT_WORKTREE"
  });
}

export function resolveRepositoryCommit(): string {
  return resolveBuildIdentity().repositoryCommit;
}

function assertCommit(value: string, label: string): void {
  if (!COMMIT_PATTERN.test(value)) throw new Error(`${label} must be a 40-character lowercase Git commit`);
}
