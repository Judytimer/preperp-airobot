export type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
};

type JsonRpcResponse<T> = {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly result?: T;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
};

export interface MonadRpcClient {
  request<T>(method: string, params?: readonly unknown[]): Promise<T>;
}

export class MonadRpcError extends Error {
  readonly method: string;
  readonly code: number | null;
  readonly data: unknown;

  constructor(method: string, message: string, code: number | null = null, data?: unknown) {
    super(`${method}: ${message}`);
    this.name = "MonadRpcError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export class HttpMonadRpc implements MonadRpcClient {
  private nextId = 1;
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    url: string,
    fetchImpl: typeof fetch = fetch,
    timeoutMs = 10_000
  ) {
    if (!/^https?:\/\//i.test(url)) throw new Error("Monad RPC URL must use HTTP(S)");
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params
    };
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new MonadRpcError(method, error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      throw new MonadRpcError(method, `HTTP ${response.status}`);
    }
    let payload: JsonRpcResponse<T>;
    try {
      payload = await response.json() as JsonRpcResponse<T>;
    } catch {
      throw new MonadRpcError(method, "invalid JSON response");
    }
    if (payload.error !== undefined) {
      throw new MonadRpcError(
        method,
        payload.error.message ?? "JSON-RPC error",
        payload.error.code ?? null,
        payload.error.data
      );
    }
    if (!("result" in payload)) throw new MonadRpcError(method, "response has no result");
    return payload.result as T;
  }
}

export function parseRpcQuantity(value: string, label: string): bigint {
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new Error(`${label} is not a canonical RPC quantity`);
  }
  return BigInt(value);
}

export function toRpcQuantity(value: bigint): string {
  if (value < 0n) throw new Error("RPC quantity cannot be negative");
  return `0x${value.toString(16)}`;
}

export function normalizeAddress(value: string, label = "address"): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be a 20-byte hex address`);
  return value.toLowerCase();
}

export function normalizeHash(value: string, label = "transaction hash"): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be a 32-byte hex hash`);
  return value.toLowerCase();
}
