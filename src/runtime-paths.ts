import { isAbsolute, join, resolve } from "node:path";

export type RuntimePaths = {
  readonly dataRoot: string;
  readonly evidenceRoot: string;
  readonly stateRoot: string;
  readonly logRoot: string;
};

/**
 * Resolves every mutable runtime path from one explicit root.
 *
 * CLI development remains backward compatible with the repository layout.
 * A packaged host must set PREPERP_DATA_ROOT to its per-user application-data
 * directory so evidence and state are never written beside the executable.
 */
export function resolveRuntimePaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd()
): RuntimePaths {
  const configured = env.PREPERP_DATA_ROOT?.trim();
  const packaged = configured !== undefined && configured.length > 0;
  const dataRoot = packaged
    ? (isAbsolute(configured) ? resolve(configured) : resolve(cwd, configured))
    : resolve(cwd);

  return Object.freeze({
    dataRoot,
    evidenceRoot: join(dataRoot, "work"),
    stateRoot: packaged ? join(dataRoot, "state") : join(dataRoot, ".runtime"),
    logRoot: packaged ? join(dataRoot, "logs") : join(dataRoot, ".runtime", "logs")
  });
}

export function runtimeEvidencePath(...segments: readonly string[]): string {
  return join(resolveRuntimePaths().evidenceRoot, ...segments);
}

export function runtimeStatePath(...segments: readonly string[]): string {
  return join(resolveRuntimePaths().stateRoot, ...segments);
}

export function runtimeLogPath(...segments: readonly string[]): string {
  return join(resolveRuntimePaths().logRoot, ...segments);
}
