import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { HttpMonadRpc, normalizeAddress, parseRpcQuantity } from "./json-rpc.ts";
import { resolveMonadNetwork } from "./network.ts";
import { runtimeStatePath } from "../runtime-paths.ts";

export type MonadReadinessReport = {
  readonly version: 1;
  readonly phase: "OBSERVE_ONLY" | "READY_FOR_EXTERNAL_SIGNER" | "BLOCKED";
  readonly checkedAt: number;
  readonly network: "mainnet" | "testnet";
  readonly rpcUrl: string;
  readonly expectedChainId: number;
  readonly observedChainId: number | null;
  readonly latestBlock: string | null;
  readonly exchangeAddress: string;
  readonly exchangeCodePresent: boolean;
  readonly walletAddress: string | null;
  readonly nativeBalanceWei: string | null;
  readonly pendingNonce: string | null;
  readonly authority: "READ_ONLY";
  readonly blockers: readonly string[];
};

export async function probeMonadReadiness(): Promise<MonadReadinessReport> {
  const network = resolveMonadNetwork();
  const rpc = new HttpMonadRpc(network.rpcUrl);
  const wallet = process.env.MONAD_WALLET_ADDRESS?.trim();
  const blockers: string[] = [];
  let observedChainId: number | null = null;
  let latestBlock: string | null = null;
  let exchangeCodePresent = false;
  let walletAddress: string | null = null;
  let nativeBalanceWei: string | null = null;
  let pendingNonce: string | null = null;

  try {
    const chainId = parseRpcQuantity(await rpc.request<string>("eth_chainId"), "eth_chainId");
    observedChainId = Number(chainId);
    if (chainId !== BigInt(network.chainId)) {
      blockers.push(`RPC chain mismatch: expected ${network.chainId}, observed ${chainId}`);
    }
    latestBlock = parseRpcQuantity(
      await rpc.request<string>("eth_blockNumber"),
      "latest block"
    ).toString();
    const code = await rpc.request<string>("eth_getCode", [network.perplExchangeAddress, "latest"]);
    exchangeCodePresent = /^0x[0-9a-f]+$/i.test(code) && code !== "0x" && code !== "0x0";
    if (!exchangeCodePresent) blockers.push("Perpl Exchange bytecode is absent at the pinned address");
  } catch (error) {
    blockers.push(`RPC probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (wallet) {
    try {
      walletAddress = normalizeAddress(wallet, "MONAD_WALLET_ADDRESS");
      nativeBalanceWei = parseRpcQuantity(
        await rpc.request<string>("eth_getBalance", [walletAddress, "latest"]),
        "native balance"
      ).toString();
      pendingNonce = parseRpcQuantity(
        await rpc.request<string>("eth_getTransactionCount", [walletAddress, "pending"]),
        "pending nonce"
      ).toString();
    } catch (error) {
      blockers.push(`wallet probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const phase = blockers.length > 0
    ? "BLOCKED"
    : walletAddress === null
      ? "OBSERVE_ONLY"
      : "READY_FOR_EXTERNAL_SIGNER";
  return {
    version: 1,
    phase,
    checkedAt: Date.now(),
    network: network.name,
    rpcUrl: network.rpcUrl,
    expectedChainId: network.chainId,
    observedChainId,
    latestBlock,
    exchangeAddress: network.perplExchangeAddress,
    exchangeCodePresent,
    walletAddress,
    nativeBalanceWei,
    pendingNonce,
    authority: "READ_ONLY",
    blockers
  };
}

async function main(): Promise<void> {
  const report = await probeMonadReadiness();
  const outputPath = runtimeStatePath("monad-readiness.json");
  await writeJsonAtomic(outputPath, report);
  console.log(JSON.stringify({ ...report, artifactPath: outputPath }, null, 2));
  if (report.phase === "BLOCKED") process.exitCode = 1;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
