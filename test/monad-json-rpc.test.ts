import assert from "node:assert/strict";
import test from "node:test";

import { HttpMonadRpc, MonadRpcError, parseRpcQuantity, toRpcQuantity } from "../src/monad/json-rpc.ts";

test("Monad RPC client preserves method errors instead of inventing results", async () => {
  const rpc = new HttpMonadRpc("https://rpc.invalid", async () => new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32_000, message: "execution reverted", data: "0xdead" }
  }), { status: 200, headers: { "content-type": "application/json" } }));

  await assert.rejects(
    rpc.request("eth_call", [{ to: "0x0000000000000000000000000000000000000001" }]),
    (error: unknown) => error instanceof MonadRpcError &&
      error.method === "eth_call" &&
      error.code === -32_000 &&
      error.message.includes("execution reverted")
  );
});

test("RPC quantities reject padded or negative values", () => {
  assert.equal(parseRpcQuantity("0x0", "zero"), 0n);
  assert.equal(parseRpcQuantity("0x279f", "chain"), 10_143n);
  assert.equal(toRpcQuantity(10_143n), "0x279f");
  assert.throws(() => parseRpcQuantity("0x00", "padded"), /canonical/);
  assert.throws(() => toRpcQuantity(-1n), /negative/);
});
