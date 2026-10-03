import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import test from "node:test";

import {
  buildRestAuthHeaders,
  buildWebSocketSignIn,
  loadPerplProbeConfig,
  signEd25519
} from "../src/perpl-access-probe.ts";

const secret = Buffer.from("1f".repeat(32), "hex");

test("defaults the read-only probe to Perpl testnet and requires credentials", () => {
  assert.throws(() => loadPerplProbeConfig({}), /PERPL_API_KEY is required/);
  const config = loadPerplProbeConfig({
    PERPL_API_KEY: "opaque-key",
    PERPL_API_KEY_SECRET: secret.toString("hex")
  });
  assert.equal(config.apiUrl, "https://testnet.perpl.xyz/api");
  assert.equal(config.wsUrl, "wss://testnet.perpl.xyz");
  assert.equal(config.chainId, 10143);
});

test("builds the documented signed GET headers without exposing the secret", () => {
  const headers = buildRestAuthHeaders(
    { chainId: 10143, apiKey: "opaque-key", privateKey: secret },
    "/v1/trading/wallet",
    "1700000000000",
    "fixed-nonce"
  );
  assert.deepEqual(Object.keys(headers).sort(), [
    "X-API-Key", "X-API-Nonce", "X-API-Signature", "X-API-Timestamp"
  ]);
  assert.equal(headers["X-API-Key"], "opaque-key");
  assert.equal(headers["X-API-Nonce"], "fixed-nonce");
  assert.equal(headers["X-API-Timestamp"], "1700000000000");
  assert.doesNotMatch(JSON.stringify(headers), new RegExp(secret.toString("hex")));
});

test("builds an authenticated WebSocket sign-in frame and no trading frame", () => {
  const frame = buildWebSocketSignIn(
    { chainId: 10143, apiKey: "opaque-key", privateKey: secret },
    "1700000000000",
    "fixed-nonce"
  );
  assert.equal(frame.mt, 29);
  assert.equal(frame.chain_id, 10143);
  assert.equal(frame.api_key, "opaque-key");
  assert.equal(frame.timestamp, "1700000000000");
  assert.equal(frame.nonce, "fixed-nonce");
  assert.equal("rq" in frame, false);
});

test("creates valid Ed25519 signatures with the Node runtime", () => {
  const message = "perpl-probe";
  const signature = Buffer.from(signEd25519(message, secret), "base64url");
  const privateDer = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"), secret
  ]);
  const publicKey = createPublicKey({ key: privateDer, format: "der", type: "pkcs8" });
  assert.equal(verify(null, Buffer.from(message), publicKey, signature), true);
});
