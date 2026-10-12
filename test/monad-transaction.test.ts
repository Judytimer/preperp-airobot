import assert from "node:assert/strict";
import test from "node:test";

import type { MonadRpcClient } from "../src/monad/json-rpc.ts";
import {
  InMemoryMonadTransactionStore,
  MonadTransactionCoordinator,
  type MonadTransactionIntent,
  type MonadTransactionSigner,
  type SignableMonadTransaction
} from "../src/monad/transaction.ts";

const account = "0x1111111111111111111111111111111111111111";
const exchange = "0x2222222222222222222222222222222222222222";
const hashes = [
  `0x${"a".repeat(64)}`,
  `0x${"b".repeat(64)}`,
  `0x${"c".repeat(64)}`
];

class ScriptedRpc implements MonadRpcClient {
  readonly calls: Array<{ method: string; params: readonly unknown[] }> = [];
  private receiptHash = hashes[0];
  private sendIndex = 0;
  private callErrorUsed = false;
  private readonly options: {
    chainId?: string;
    receiptStatus?: string;
    receiptVisible?: boolean;
    finalizedBlock?: string | null;
    sendError?: Error;
    callError?: Error;
  };

  constructor(
    options: {
      chainId?: string;
      receiptStatus?: string;
      receiptVisible?: boolean;
      finalizedBlock?: string | null;
      sendError?: Error;
      callError?: Error;
    } = {}
  ) {
    this.options = options;
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case "eth_chainId": return (this.options.chainId ?? "0x279f") as T;
      case "eth_getTransactionCount": return "0x0" as T;
      case "eth_call": {
        if (this.options.callError && !this.callErrorUsed) {
          this.callErrorUsed = true;
          throw this.options.callError;
        }
        return "0x" as T;
      }
      case "eth_estimateGas": return "0x5208" as T;
      case "eth_sendRawTransaction": {
        if (this.options.sendError) throw this.options.sendError;
        this.receiptHash = hashes[this.sendIndex++] ?? hashes[2];
        return this.receiptHash as T;
      }
      case "eth_getTransactionReceipt":
        if (this.options.receiptVisible === false) return null as T;
        return {
          transactionHash: this.receiptHash,
          blockNumber: "0x64",
          status: this.options.receiptStatus ?? "0x1"
        } as T;
      case "eth_getBlockByNumber":
        return (this.options.finalizedBlock === null
          ? null
          : { number: this.options.finalizedBlock ?? "0x64" }) as T;
      case "eth_getTransactionByHash": return null as T;
      default: throw new Error(`unexpected RPC method ${method}`);
    }
  }
}

class RecordingSigner implements MonadTransactionSigner {
  readonly address = account;
  readonly signed: SignableMonadTransaction[] = [];

  async sign(transaction: SignableMonadTransaction) {
    const index = this.signed.length;
    this.signed.push(transaction);
    return { rawTransaction: `0xraw${index}`, transactionHash: hashes[index] };
  }
}

function intent(id: string, from = account): MonadTransactionIntent {
  return {
    intentId: id,
    clientOrderId: `CORE-${id}`,
    from,
    to: exchange,
    data: "0x1234",
    createdAt: 1_700_000_000_000
  };
}

function coordinator(rpc: MonadRpcClient, store = new InMemoryMonadTransactionStore()) {
  return {
    store,
    value: new MonadTransactionCoordinator(rpc, store, {
      chainId: 10_143,
      receiptPolls: 1,
      finalityPolls: 1,
      pollIntervalMs: 0,
      now: () => 1_700_000_000_001,
      wait: async () => undefined
    })
  };
}

test("concurrent transactions from one signer are serialized with distinct durable nonces", async () => {
  const rpc = new ScriptedRpc();
  const signer = new RecordingSigner();
  const { value, store } = coordinator(rpc);

  const [first, second] = await Promise.all([
    value.execute(intent("one"), signer),
    value.execute(intent("two"), signer)
  ]);

  assert.equal(first.status, "FINALIZED");
  assert.equal(second.status, "FINALIZED");
  assert.deepEqual(signer.signed.map((transaction) => transaction.nonce), ["0x0", "0x1"]);
  const journal = await store.load();
  assert.deepEqual(journal.records.map((record) => record.intent.intentId), ["one", "two"]);
  assert.deepEqual(journal.records.map((record) => record.nonce), ["0", "1"]);
});

test("a successful receipt remains transaction evidence and never becomes an order fact", async () => {
  const { value, store } = coordinator(new ScriptedRpc());
  const result = await value.execute(intent("receipt-only"), new RecordingSigner());

  assert.equal(result.status, "FINALIZED");
  assert.match(result.detail ?? "", /Perpl order\/fill facts/);
  const serialized = JSON.stringify(await store.load());
  assert.doesNotMatch(serialized, /ORDER_ACK|FILL/);
});

test("an EVM revert is terminal and preserves the consumed nonce", async () => {
  const { value, store } = coordinator(new ScriptedRpc({ receiptStatus: "0x0" }));
  const result = await value.execute(intent("revert"), new RecordingSigner());

  assert.equal(result.status, "REVERTED");
  assert.equal(result.nonce, "0");
  assert.equal((await store.load()).records[0].status, "REVERTED");
});

test("an ambiguous broadcast fails closed and blocks later risk", async () => {
  const rpc = new ScriptedRpc({ sendError: new Error("connection reset") });
  const { value } = coordinator(rpc);
  const first = await value.execute(intent("ambiguous"), new RecordingSigner());
  assert.equal(first.status, "UNKNOWN");
  assert.match(first.detail ?? "", /ambiguous/);

  await assert.rejects(
    value.execute(intent("must-block"), new RecordingSigner()),
    /unresolved transaction ambiguous \(UNKNOWN\)/
  );
  assert.equal(rpc.calls.filter((call) => call.method === "eth_sendRawTransaction").length, 1);
});

test("chain mismatch stops before nonce allocation or signing", async () => {
  const rpc = new ScriptedRpc({ chainId: "0x8f" });
  const signer = new RecordingSigner();
  const { value, store } = coordinator(rpc);

  await assert.rejects(value.execute(intent("wrong-chain"), signer), /chain mismatch/);
  assert.equal(signer.signed.length, 0);
  assert.equal((await store.load()).records.length, 0);
});

test("lack of finalized block support keeps a successful transaction INCLUDED", async () => {
  const { value } = coordinator(new ScriptedRpc({ finalizedBlock: null }));
  const result = await value.execute(intent("included"), new RecordingSigner());
  assert.equal(result.status, "INCLUDED");
});

test("simulation rejection does not burn a local nonce", async () => {
  const rpc = new ScriptedRpc({ callError: new Error("insufficient collateral") });
  const signer = new RecordingSigner();
  const { value } = coordinator(rpc);
  const rejected = await value.execute(intent("rejected"), signer);
  assert.equal(rejected.status, "SIMULATION_REJECTED");
  assert.equal(signer.signed.length, 0);

  const accepted = await value.execute(intent("after-rejection"), signer);
  assert.equal(accepted.status, "FINALIZED");
  assert.equal(accepted.nonce, "0");
});

test("wallet signing rejection is terminal without pretending a broadcast happened", async () => {
  const rpc = new ScriptedRpc();
  const signer: MonadTransactionSigner = {
    address: account,
    async sign() { throw new Error("wallet rejected"); }
  };
  const { value } = coordinator(rpc);
  const rejected = await value.execute(intent("wallet-rejected"), signer);
  assert.equal(rejected.status, "SIGNING_REJECTED");
  assert.equal(rejected.transactionHash, null);
  assert.equal(rpc.calls.filter((call) => call.method === "eth_sendRawTransaction").length, 0);
});

test("different signers can progress concurrently without losing journal records", async () => {
  const secondAccount = "0x3333333333333333333333333333333333333333";
  const rawToHash = new Map<string, string>([["0xaaaa", hashes[0]], ["0xbbbb", hashes[1]]]);
  const rpc: MonadRpcClient = {
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      if (method === "eth_chainId") return "0x279f" as T;
      if (method === "eth_getTransactionCount") return "0x0" as T;
      if (method === "eth_call") return "0x" as T;
      if (method === "eth_estimateGas") return "0x5208" as T;
      if (method === "eth_sendRawTransaction") return rawToHash.get(String(params[0])) as T;
      if (method === "eth_getTransactionReceipt") {
        return { transactionHash: String(params[0]), blockNumber: "0x64", status: "0x1" } as T;
      }
      if (method === "eth_getBlockByNumber") return { number: "0x64" } as T;
      throw new Error(`unexpected RPC method ${method}`);
    }
  };
  const store = new InMemoryMonadTransactionStore();
  const { value } = coordinator(rpc, store);
  const signer = (address: string, rawTransaction: string, transactionHash: string): MonadTransactionSigner => ({
    address,
    async sign() { return { rawTransaction, transactionHash }; }
  });

  const [first, second] = await Promise.all([
    value.execute(intent("account-a"), signer(account, "0xaaaa", hashes[0])),
    value.execute(intent("account-b", secondAccount), signer(secondAccount, "0xbbbb", hashes[1]))
  ]);
  assert.equal(first.status, "FINALIZED");
  assert.equal(second.status, "FINALIZED");
  assert.deepEqual((await store.load()).records.map((record) => record.intent.intentId).sort(), ["account-a", "account-b"]);
});
