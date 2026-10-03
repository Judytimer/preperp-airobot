import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REST_SNAPSHOTS = [
  { name: "WalletSnapshot", target: "/v1/trading/wallet", messageType: 19 },
  { name: "OrdersSnapshot", target: "/v1/trading/orders", messageType: 23 },
  { name: "PositionsSnapshot", target: "/v1/trading/positions", messageType: 26 }
] as const;

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export type PerplProbeConfig = {
  apiUrl: string;
  wsUrl: string;
  chainId: number;
  apiKey: string;
  privateKey: Buffer;
  timeoutMs: number;
};

export type ProbeEvidence = {
  publicContext: { chainId: number; instances: number; markets: number };
  restSnapshots: Record<string, { messageType: number; received: true }>;
  websocket: { authenticated: true; snapshots: number[] };
};

export function loadPerplProbeConfig(env: NodeJS.ProcessEnv = process.env): PerplProbeConfig {
  const network = env.PERPL_NETWORK ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error("PERPL_NETWORK must be testnet or mainnet");
  }

  const defaultChainId = network === "testnet" ? 10143 : 143;
  const defaultHost = network === "testnet" ? "https://testnet.perpl.xyz" : "https://app.perpl.xyz";
  const apiUrl = stripTrailingSlash(env.PERPL_API_URL ?? `${defaultHost}/api`);
  const wsUrl = stripTrailingSlash(env.PERPL_WS_URL ?? defaultHost.replace("https://", "wss://"));
  const chainId = parsePositiveInteger(env.PERPL_CHAIN_ID ?? String(defaultChainId), "PERPL_CHAIN_ID");
  const timeoutMs = parsePositiveInteger(env.PERPL_PROBE_TIMEOUT_MS ?? "15000", "PERPL_PROBE_TIMEOUT_MS");
  const apiKey = requireSecret(env.PERPL_API_KEY, "PERPL_API_KEY");
  const privateKey = parsePrivateKey(requireSecret(env.PERPL_API_KEY_SECRET, "PERPL_API_KEY_SECRET"));

  return { apiUrl, wsUrl, chainId, apiKey, privateKey, timeoutMs };
}

export function signEd25519(message: string, privateKey: Buffer): string {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, privateKey]),
    format: "der",
    type: "pkcs8"
  });
  return sign(null, Buffer.from(message), key).toString("base64url");
}

export function buildRestAuthHeaders(
  config: Pick<PerplProbeConfig, "chainId" | "apiKey" | "privateKey">,
  target: string,
  timestamp = Date.now().toString(),
  nonce = randomBytes(16).toString("base64url")
): Record<string, string> {
  const bodyHash = createHash("sha256").update("").digest("hex");
  const canonical = [config.chainId, "GET", target, timestamp, nonce, bodyHash].join("\n");
  return {
    "X-API-Key": config.apiKey,
    "X-API-Timestamp": timestamp,
    "X-API-Nonce": nonce,
    "X-API-Signature": signEd25519(canonical, config.privateKey)
  };
}

export function buildWebSocketSignIn(
  config: Pick<PerplProbeConfig, "chainId" | "apiKey" | "privateKey">,
  timestamp = Date.now().toString(),
  nonce = randomBytes(16).toString("base64url")
): Record<string, string | number> {
  const canonical = [config.chainId, "trading-ws-signin", timestamp, nonce].join("\n");
  return {
    mt: 29,
    chain_id: config.chainId,
    api_key: config.apiKey,
    timestamp,
    nonce,
    signature: signEd25519(canonical, config.privateKey)
  };
}

export async function runPerplAccessProbe(config: PerplProbeConfig): Promise<ProbeEvidence> {
  const context = await getJson(`${config.apiUrl}/v1/pub/context`, {}, config.timeoutMs);
  const publicContext = summarizeContext(context, config.chainId);
  const restSnapshots: ProbeEvidence["restSnapshots"] = {};

  for (const snapshot of REST_SNAPSHOTS) {
    const value = await getJson(
      `${config.apiUrl}${snapshot.target}`,
      buildRestAuthHeaders(config, snapshot.target),
      config.timeoutMs
    );
    requireMessageType(value, snapshot.messageType, snapshot.name);
    restSnapshots[snapshot.name] = { messageType: snapshot.messageType, received: true };
  }

  const snapshots = await observeInitialSnapshots(config);
  return { publicContext, restSnapshots, websocket: { authenticated: true, snapshots } };
}

async function observeInitialSnapshots(config: PerplProbeConfig): Promise<number[]> {
  const expected = new Set([19, 23, 26]);
  const observed = new Set<number>();
  const socket = new WebSocket(`${config.wsUrl}/ws/v1/trading`);

  try {
    return await new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for Perpl WebSocket snapshots; received=${[...observed].join(",") || "none"}`)),
        config.timeoutMs
      );
      const finish = (operation: () => void): void => {
        clearTimeout(timer);
        operation();
      };

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify(buildWebSocketSignIn(config)));
      }, { once: true });
      socket.addEventListener("message", (event) => {
        try {
          const message = parseMessage(event.data);
          const messageType = message.mt;
          if (messageType === 3 && statusCode(message) !== 0) {
            finish(() => reject(new Error(`Perpl WebSocket sign-in failed with status ${statusCode(message)}`)));
            return;
          }
          if (typeof messageType === "number" && expected.has(messageType)) observed.add(messageType);
          if (observed.size === expected.size) finish(() => resolve([...observed].sort((a, b) => a - b)));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.addEventListener("error", () => {
        finish(() => reject(new Error("Perpl WebSocket connection failed")));
      }, { once: true });
      socket.addEventListener("close", (event) => {
        if (observed.size !== expected.size) {
          finish(() => reject(new Error(`Perpl WebSocket closed before snapshots: code=${event.code} reason=${event.reason}`)));
        }
      }, { once: true });
    });
  } finally {
    socket.close(1000, "read-only probe complete");
  }
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${new URL(url).pathname} failed with HTTP ${response.status}: ${safeExcerpt(text)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`GET ${new URL(url).pathname} returned invalid JSON`);
  }
}

function summarizeContext(value: unknown, expectedChainId: number): ProbeEvidence["publicContext"] {
  const context = requireRecord(value, "public context");
  const chain = requireRecord(context.chain, "public context chain");
  if (chain.chain_id !== expectedChainId) {
    throw new Error(`Perpl context chain ${String(chain.chain_id)} does not match configured chain ${expectedChainId}`);
  }
  if (!Array.isArray(context.instances) || !Array.isArray(context.markets)) {
    throw new Error("Perpl public context is missing instances or markets");
  }
  return { chainId: expectedChainId, instances: context.instances.length, markets: context.markets.length };
}

function requireMessageType(value: unknown, expected: number, name: string): void {
  const message = requireRecord(value, name);
  if (message.mt !== expected) throw new Error(`${name} has unexpected message type ${String(message.mt)}`);
}

function parseMessage(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("Perpl WebSocket returned a non-text frame");
  try {
    return requireRecord(JSON.parse(value), "WebSocket message");
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Perpl WebSocket returned invalid JSON");
    throw error;
  }
}

function statusCode(message: Record<string, unknown>): unknown {
  if (typeof message.code === "number") return message.code;
  return requireRecord(message.status, "WebSocket status").code;
}

function parsePrivateKey(value: string): Buffer {
  const hex = value.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("PERPL_API_KEY_SECRET must be a 32-byte hexadecimal Ed25519 private key");
  }
  return Buffer.from(hex, "hex");
}

function requireSecret(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeExcerpt(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 200) || "empty response";
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const evidence = await runPerplAccessProbe(loadPerplProbeConfig());
    console.log(JSON.stringify({ status: "READY", evidence }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ status: "BLOCKED", reason: message }, null, 2));
    process.exitCode = 1;
  }
}
