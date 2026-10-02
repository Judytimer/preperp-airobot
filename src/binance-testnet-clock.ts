const BINANCE_TESTNET_TIME_URL = "https://testnet.binancefuture.com/fapi/v1/time";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_ROUND_TRIP_MS = 5_000;
const MAX_ABSOLUTE_OFFSET_MS = 24 * 60 * 60 * 1_000;

export type BinanceClockSample = {
  readonly offsetMs: number;
  readonly roundTripMs: number;
  readonly serverTime: number;
};

export async function measureBinanceTestnetClock(
  options: {
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    readonly timeoutMs?: number;
  } = {}
): Promise<BinanceClockSample> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Binance Testnet clock timeout must be a positive integer");
  }
  const startedAt = now();
  const response = await fetchImpl(BINANCE_TESTNET_TIME_URL, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  const finishedAt = now();
  if (!response.ok) {
    throw new Error(`Binance Testnet clock sync failed with HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  const serverTime = isRecord(payload) ? payload.serverTime : undefined;
  if (typeof serverTime !== "number" || !Number.isSafeInteger(serverTime) || serverTime <= 0) {
    throw new Error("Binance Testnet clock sync returned an invalid serverTime");
  }

  const roundTripMs = finishedAt - startedAt;
  if (!Number.isFinite(roundTripMs) || roundTripMs < 0 || roundTripMs > MAX_ROUND_TRIP_MS) {
    throw new Error(`Binance Testnet clock sync round trip is unsafe: ${roundTripMs}ms`);
  }

  const midpoint = startedAt + roundTripMs / 2;
  const offsetMs = Math.round(serverTime - midpoint);
  if (Math.abs(offsetMs) > MAX_ABSOLUTE_OFFSET_MS) {
    throw new Error(`Binance Testnet clock offset is unsafe: ${offsetMs}ms`);
  }
  return { offsetMs, roundTripMs, serverTime };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
