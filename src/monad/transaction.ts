import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  normalizeAddress,
  normalizeHash,
  parseRpcQuantity,
  toRpcQuantity,
  type MonadRpcClient
} from "./json-rpc.ts";

export type MonadTransactionStatus =
  | "PLANNED"
  | "NONCE_RESERVED"
  | "SIMULATION_REJECTED"
  | "SIMULATED"
  | "SIGNING_REJECTED"
  | "SIGNED"
  | "BROADCAST"
  | "INCLUDED"
  | "FINALIZED"
  | "REVERTED"
  | "ABANDONED"
  | "UNKNOWN";

export type MonadTransactionIntent = {
  /** Stable internal identity, allocated before any external call. */
  readonly intentId: string;
  /** Optional Core order identity. It is correlation only, never a protocol order ID. */
  readonly clientOrderId?: string;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly valueWei?: string;
  readonly createdAt: number;
};

export type MonadTransactionRecord = {
  readonly intent: MonadTransactionIntent;
  readonly chainId: number;
  readonly status: MonadTransactionStatus;
  readonly nonce: string | null;
  readonly gasLimit: string | null;
  readonly transactionHash: string | null;
  readonly blockNumber: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly detail: string | null;
};

export type MonadTransactionJournal = {
  readonly version: 1;
  readonly records: readonly MonadTransactionRecord[];
};

export interface MonadTransactionStore {
  load(): Promise<MonadTransactionJournal>;
  save(journal: MonadTransactionJournal): Promise<void>;
}

export class InMemoryMonadTransactionStore implements MonadTransactionStore {
  private journal: MonadTransactionJournal = { version: 1, records: [] };

  async load(): Promise<MonadTransactionJournal> {
    return structuredClone(this.journal);
  }

  async save(journal: MonadTransactionJournal): Promise<void> {
    validateJournal(journal);
    this.journal = structuredClone(journal);
  }
}

export class JsonFileMonadTransactionStore implements MonadTransactionStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<MonadTransactionJournal> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { version: 1, records: [] };
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error("invalid Monad transaction journal JSON");
    }
    return validateJournal(value);
  }

  async save(journal: MonadTransactionJournal): Promise<void> {
    validateJournal(journal);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

export type SignableMonadTransaction = {
  readonly chainId: number;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly value: string;
  readonly nonce: string;
  readonly gasLimit: string;
};

export interface MonadTransactionSigner {
  readonly address: string;
  sign(transaction: SignableMonadTransaction): Promise<{
    readonly rawTransaction: string;
    readonly transactionHash: string;
  }>;
}

type RpcReceipt = {
  readonly transactionHash: string;
  readonly blockNumber: string;
  readonly status: string;
};

type RpcBlock = { readonly number: string };

export type MonadTransactionCoordinatorConfig = {
  readonly chainId: number;
  readonly receiptPolls?: number;
  readonly finalityPolls?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
};

/**
 * Owns EVM transaction truth only. It never emits ORDER_ACK or FILL: a receipt
 * proves contract execution, while Perpl order/fill facts prove trading state.
 *
 * One signer is serialized by default. Multi-order on-chain actions should be
 * encoded as one protocol batch (`execOrders`) instead of racing independent
 * nonces whose simulations cannot observe each other's pending state.
 */
export class MonadTransactionCoordinator {
  private readonly accountTails = new Map<string, Promise<void>>();
  private journalTail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly receiptPolls: number;
  private readonly finalityPolls: number;
  private readonly pollIntervalMs: number;
  private readonly rpc: MonadRpcClient;
  private readonly store: MonadTransactionStore;
  private readonly config: MonadTransactionCoordinatorConfig;

  constructor(
    rpc: MonadRpcClient,
    store: MonadTransactionStore,
    config: MonadTransactionCoordinatorConfig
  ) {
    if (!Number.isInteger(config.chainId) || config.chainId <= 0) throw new Error("chainId must be positive");
    this.receiptPolls = positiveInteger(config.receiptPolls ?? 60, "receiptPolls");
    this.finalityPolls = positiveInteger(config.finalityPolls ?? 30, "finalityPolls");
    this.pollIntervalMs = nonNegativeInteger(config.pollIntervalMs ?? 1_000, "pollIntervalMs");
    this.now = config.now ?? Date.now;
    this.wait = config.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.rpc = rpc;
    this.store = store;
    this.config = config;
  }

  execute(intent: MonadTransactionIntent, signer: MonadTransactionSigner): Promise<MonadTransactionRecord> {
    validateIntent(intent);
    const account = normalizeAddress(intent.from, "intent.from");
    if (normalizeAddress(signer.address, "signer.address") !== account) {
      return Promise.reject(new Error("signer address does not match transaction intent"));
    }
    return this.withAccountLock(account, () => this.executeLocked({ ...intent, from: account }, signer));
  }

  async recover(transactionHash: string): Promise<MonadTransactionRecord> {
    const hash = normalizeHash(transactionHash);
    const journal = await this.store.load();
    const record = journal.records.find((item) => item.transactionHash?.toLowerCase() === hash);
    if (record === undefined) throw new Error(`unknown Monad transaction ${hash}`);
    if (record.chainId !== this.config.chainId) {
      throw new Error(`transaction belongs to chain ${record.chainId}, coordinator is ${this.config.chainId}`);
    }
    if (["FINALIZED", "REVERTED", "SIMULATION_REJECTED", "SIGNING_REJECTED", "ABANDONED"].includes(record.status)) {
      return record;
    }
    const receipt = await this.rpc.request<RpcReceipt | null>("eth_getTransactionReceipt", [hash]);
    if (receipt === null) {
      const visible = await this.rpc.request<unknown | null>("eth_getTransactionByHash", [hash]);
      return this.replaceRecord(record.intent.intentId, {
        status: "UNKNOWN",
        detail: visible === null
          ? "transaction is not visible and has no receipt; do not resubmit without nonce reconciliation"
          : "transaction remains visible without a receipt"
      });
    }
    return this.admitReceipt(record.intent.intentId, receipt);
  }

  async abandonUnbroadcast(intentId: string): Promise<MonadTransactionRecord> {
    const journal = await this.store.load();
    const record = requireRecord(journal, intentId);
    if (record.chainId !== this.config.chainId) {
      throw new Error(`transaction belongs to chain ${record.chainId}, coordinator is ${this.config.chainId}`);
    }
    if (!["NONCE_RESERVED", "SIMULATED"].includes(record.status) || record.nonce === null) {
      throw new Error(`transaction ${intentId} is not an unbroadcast nonce reservation`);
    }
    if (record.transactionHash !== null) throw new Error(`transaction ${intentId} has a signed hash and cannot be abandoned`);
    const pendingNonce = parseRpcQuantity(
      await this.rpc.request<string>("eth_getTransactionCount", [record.intent.from, "pending"]),
      "pending nonce"
    );
    if (pendingNonce > BigInt(record.nonce)) {
      throw new Error(`nonce ${record.nonce} may already be consumed; transaction requires reconciliation`);
    }
    return this.replaceRecord(intentId, {
      status: "ABANDONED",
      detail: "unbroadcast nonce reservation explicitly abandoned after pending-nonce verification"
    });
  }

  private async executeLocked(
    intent: MonadTransactionIntent,
    signer: MonadTransactionSigner
  ): Promise<MonadTransactionRecord> {
    const observedChainId = parseRpcQuantity(
      await this.rpc.request<string>("eth_chainId"),
      "eth_chainId"
    );
    if (observedChainId !== BigInt(this.config.chainId)) {
      throw new Error(`Monad chain mismatch: expected ${this.config.chainId}, observed ${observedChainId}`);
    }

    const planned: MonadTransactionRecord = {
      intent,
      chainId: this.config.chainId,
      status: "PLANNED",
      nonce: null,
      gasLimit: null,
      transactionHash: null,
      blockNumber: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      detail: null
    };
    const journal = await this.withJournalLock(async () => {
      const current = await this.store.load();
      if (current.records.some((record) => record.intent.intentId === intent.intentId)) {
        throw new Error(`duplicate Monad transaction intent ${intent.intentId}`);
      }
      const unresolved = current.records.find((record) =>
        record.chainId === this.config.chainId &&
        normalizeAddress(record.intent.from) === intent.from &&
        ["NONCE_RESERVED", "SIMULATED", "SIGNED", "BROADCAST", "INCLUDED", "UNKNOWN"].includes(record.status)
      );
      if (unresolved !== undefined) {
        throw new Error(
          `signer has unresolved transaction ${unresolved.intent.intentId} (${unresolved.status}); reconcile before new risk`
        );
      }
      const next = appendRecord(current, planned);
      await this.store.save(next);
      return next;
    });

    const remoteNonce = parseRpcQuantity(
      await this.rpc.request<string>("eth_getTransactionCount", [intent.from, "pending"]),
      "pending nonce"
    );
    const consumedNonceFloor = journal.records.reduce((highest, record) => {
      if (
        normalizeAddress(record.intent.from) !== intent.from ||
        record.chainId !== this.config.chainId ||
        record.nonce === null ||
        !["SIGNED", "BROADCAST", "INCLUDED", "FINALIZED", "REVERTED", "UNKNOWN"].includes(record.status)
      ) return highest;
      const nonce = BigInt(record.nonce);
      return nonce >= highest ? nonce + 1n : highest;
    }, 0n);
    const nonce = remoteNonce > consumedNonceFloor ? remoteNonce : consumedNonceFloor;
    let record = await this.replaceRecord(intent.intentId, {
      status: "NONCE_RESERVED",
      nonce: nonce.toString(),
      detail: null
    });

    const call = transactionCall(intent, nonce);
    try {
      await this.rpc.request<string>("eth_call", [call, "pending"]);
      const gasLimit = parseRpcQuantity(
        await this.rpc.request<string>("eth_estimateGas", [call]),
        "estimated gas"
      );
      record = await this.replaceRecord(intent.intentId, {
        status: "SIMULATED",
        gasLimit: gasLimit.toString(),
        detail: null
      });
    } catch (error) {
      return this.replaceRecord(intent.intentId, {
        status: "SIMULATION_REJECTED",
        detail: error instanceof Error ? error.message : String(error)
      });
    }

    let signed: Awaited<ReturnType<MonadTransactionSigner["sign"]>>;
    try {
      signed = await signer.sign({
        chainId: this.config.chainId,
        from: intent.from,
        to: normalizeAddress(intent.to, "intent.to"),
        data: intent.data,
        value: toRpcQuantity(BigInt(intent.valueWei ?? "0")),
        nonce: toRpcQuantity(BigInt(record.nonce!)),
        gasLimit: toRpcQuantity(BigInt(record.gasLimit!))
      });
    } catch (error) {
      return this.replaceRecord(intent.intentId, {
        status: "SIGNING_REJECTED",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    const expectedHash = normalizeHash(signed.transactionHash, "signer transaction hash");
    record = await this.replaceRecord(intent.intentId, {
      status: "SIGNED",
      transactionHash: expectedHash,
      detail: null
    });

    let broadcastHash: string;
    try {
      broadcastHash = normalizeHash(
        await this.rpc.request<string>("eth_sendRawTransaction", [signed.rawTransaction]),
        "broadcast transaction hash"
      );
    } catch (error) {
      return this.replaceRecord(intent.intentId, {
        status: "UNKNOWN",
        detail: `broadcast outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`
      });
    }
    if (broadcastHash !== expectedHash) {
      return this.replaceRecord(intent.intentId, {
        status: "UNKNOWN",
        detail: `RPC returned hash ${broadcastHash}, signer expected ${expectedHash}`
      });
    }
    record = await this.replaceRecord(intent.intentId, { status: "BROADCAST", detail: null });

    for (let attempt = 0; attempt < this.receiptPolls; attempt += 1) {
      const receipt = await this.rpc.request<RpcReceipt | null>("eth_getTransactionReceipt", [expectedHash]);
      if (receipt !== null) return this.admitReceipt(intent.intentId, receipt);
      if (attempt + 1 < this.receiptPolls) await this.wait(this.pollIntervalMs);
    }
    const visible = await this.rpc.request<unknown | null>("eth_getTransactionByHash", [expectedHash]);
    return this.replaceRecord(intent.intentId, {
      status: "UNKNOWN",
      detail: visible === null
        ? "receipt timeout and transaction is not visible; do not resubmit without nonce reconciliation"
        : "receipt timeout while transaction remains visible"
    });
  }

  private async admitReceipt(intentId: string, receipt: RpcReceipt): Promise<MonadTransactionRecord> {
    const hash = normalizeHash(receipt.transactionHash);
    const status = parseRpcQuantity(receipt.status, "receipt status");
    const blockNumber = parseRpcQuantity(receipt.blockNumber, "receipt block number");
    const journal = await this.store.load();
    const current = requireRecord(journal, intentId);
    if (current.transactionHash !== null && current.transactionHash !== hash) {
      return this.replaceRecord(intentId, {
        status: "UNKNOWN",
        detail: `receipt hash ${hash} conflicts with ${current.transactionHash}`
      });
    }
    if (status === 0n) {
      return this.replaceRecord(intentId, {
        status: "REVERTED",
        transactionHash: hash,
        blockNumber: blockNumber.toString(),
        detail: "transaction was included but EVM execution reverted"
      });
    }
    if (status !== 1n) {
      return this.replaceRecord(intentId, {
        status: "UNKNOWN",
        transactionHash: hash,
        blockNumber: blockNumber.toString(),
        detail: `unsupported receipt status ${receipt.status}`
      });
    }
    let record = await this.replaceRecord(intentId, {
      status: "INCLUDED",
      transactionHash: hash,
      blockNumber: blockNumber.toString(),
      detail: "receipt proves EVM inclusion, not a Perpl order or fill"
    });
    for (let attempt = 0; attempt < this.finalityPolls; attempt += 1) {
      let finalized: RpcBlock | null = null;
      try {
        finalized = await this.rpc.request<RpcBlock | null>("eth_getBlockByNumber", ["finalized", false]);
      } catch {
        return record;
      }
      if (finalized !== null && parseRpcQuantity(finalized.number, "finalized block") >= blockNumber) {
        record = await this.replaceRecord(intentId, {
          status: "FINALIZED",
          detail: "EVM transaction finalized; Perpl order/fill facts still require protocol evidence"
        });
        return record;
      }
      if (attempt + 1 < this.finalityPolls) await this.wait(this.pollIntervalMs);
    }
    return record;
  }

  private async replaceRecord(
    intentId: string,
    patch: Partial<Omit<MonadTransactionRecord, "intent" | "chainId" | "createdAt" | "updatedAt">>
  ): Promise<MonadTransactionRecord> {
    return this.withJournalLock(async () => {
      const journal = await this.store.load();
      const current = requireRecord(journal, intentId);
      const next: MonadTransactionRecord = { ...current, ...patch, updatedAt: this.now() };
      validateTransition(current.status, next.status);
      await this.store.save({
        version: 1,
        records: journal.records.map((record) => record.intent.intentId === intentId ? next : record)
      });
      return next;
    });
  }

  private withAccountLock<T>(account: string, work: () => Promise<T>): Promise<T> {
    const previous = this.accountTails.get(account) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.accountTails.set(account, tail);
    return previous.then(work).finally(() => {
      release();
      if (this.accountTails.get(account) === tail) this.accountTails.delete(account);
    });
  }

  private withJournalLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.journalTail.then(work, work);
    this.journalTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function transactionCall(intent: MonadTransactionIntent, nonce: bigint): Record<string, string> {
  return {
    from: normalizeAddress(intent.from, "intent.from"),
    to: normalizeAddress(intent.to, "intent.to"),
    data: normalizeData(intent.data),
    value: toRpcQuantity(BigInt(intent.valueWei ?? "0")),
    nonce: toRpcQuantity(nonce)
  };
}

function validateIntent(intent: MonadTransactionIntent): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(intent.intentId)) {
    throw new Error("intentId must contain 1..128 safe characters");
  }
  normalizeAddress(intent.from, "intent.from");
  normalizeAddress(intent.to, "intent.to");
  normalizeData(intent.data);
  if (intent.clientOrderId !== undefined && typeof intent.clientOrderId !== "string") {
    throw new Error("clientOrderId must be a string when present");
  }
  if (intent.valueWei !== undefined && (!/^\d+$/.test(intent.valueWei) || BigInt(intent.valueWei) < 0n)) {
    throw new Error("valueWei must be a non-negative decimal integer");
  }
  if (!Number.isInteger(intent.createdAt) || intent.createdAt <= 0) throw new Error("createdAt must be a timestamp");
}

function normalizeData(value: string): string {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error("transaction data must be even-length hex");
  return value.toLowerCase();
}

function appendRecord(journal: MonadTransactionJournal, record: MonadTransactionRecord): MonadTransactionJournal {
  return { version: 1, records: [...journal.records, record] };
}

function requireRecord(journal: MonadTransactionJournal, intentId: string): MonadTransactionRecord {
  const record = journal.records.find((item) => item.intent.intentId === intentId);
  if (record === undefined) throw new Error(`unknown Monad transaction intent ${intentId}`);
  return record;
}

function validateTransition(from: MonadTransactionStatus, to: MonadTransactionStatus): void {
  if (from === to) return;
  const allowed: Record<MonadTransactionStatus, readonly MonadTransactionStatus[]> = {
    PLANNED: ["NONCE_RESERVED"],
    NONCE_RESERVED: ["SIMULATION_REJECTED", "SIMULATED", "ABANDONED", "UNKNOWN"],
    SIMULATION_REJECTED: [],
    SIMULATED: ["SIGNING_REJECTED", "SIGNED", "ABANDONED", "UNKNOWN"],
    SIGNING_REJECTED: [],
    SIGNED: ["BROADCAST", "UNKNOWN"],
    BROADCAST: ["INCLUDED", "REVERTED", "UNKNOWN"],
    INCLUDED: ["FINALIZED", "REVERTED", "UNKNOWN"],
    FINALIZED: [],
    REVERTED: [],
    ABANDONED: [],
    UNKNOWN: ["INCLUDED", "REVERTED", "FINALIZED"]
  };
  if (!allowed[from].includes(to)) throw new Error(`invalid Monad transaction transition ${from} -> ${to}`);
}

function validateJournal(value: unknown): MonadTransactionJournal {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) {
    throw new Error("invalid Monad transaction journal shape");
  }
  const identities = new Set<string>();
  for (const item of value.records) {
    if (!isRecord(item) || !isRecord(item.intent) || typeof item.intent.intentId !== "string") {
      throw new Error("invalid Monad transaction record");
    }
    validateIntent(item.intent as MonadTransactionIntent);
    if (
      !Number.isInteger(item.chainId) || (item.chainId as number) <= 0 ||
      !TRANSACTION_STATUSES.has(String(item.status)) ||
      !isDecimalOrNull(item.nonce) ||
      !isDecimalOrNull(item.gasLimit) ||
      !isHashOrNull(item.transactionHash) ||
      !isDecimalOrNull(item.blockNumber) ||
      !isPositiveTimestamp(item.createdAt) ||
      !isPositiveTimestamp(item.updatedAt) ||
      (item.detail !== null && typeof item.detail !== "string")
    ) {
      throw new Error(`invalid Monad transaction record ${item.intent.intentId}`);
    }
    if (identities.has(item.intent.intentId)) throw new Error(`duplicate Monad intent ${item.intent.intentId}`);
    identities.add(item.intent.intentId);
  }
  return value as MonadTransactionJournal;
}

const TRANSACTION_STATUSES: ReadonlySet<string> = new Set([
  "PLANNED", "NONCE_RESERVED", "SIMULATION_REJECTED", "SIMULATED", "SIGNING_REJECTED",
  "SIGNED", "BROADCAST", "INCLUDED", "FINALIZED", "REVERTED", "ABANDONED", "UNKNOWN"
]);

function isDecimalOrNull(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^\d+$/.test(value));
}

function isHashOrNull(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value));
}

function isPositiveTimestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
