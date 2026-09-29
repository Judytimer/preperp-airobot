import assert from "node:assert/strict";
import test from "node:test";

import {
  ObservedExecutionVenue,
  readClosureConfig,
  runClosureComposition,
  runRealLayaClosure,
  validateLivePreflight
} from "../src/closure-smoke.ts";
import type {
  BinanceClosureEvidence,
  ClosureConfig,
  ClosureRunContext
} from "../src/closure-smoke.ts";
import type { ExecutionEventHandler, ExecutionVenue } from "../src/exchange.ts";
import type { ExchangeStateSnapshot } from "../src/reconciliation.ts";
import type { ExecutionEvent, SubmitOrderCommand } from "../src/types.ts";
import type { ShadowRecord } from "../src/overlay/types.ts";

test("execution observer forwards original ACK and Fill before collecting evidence", async () => {
  const inner = new FakeExecutionVenue();
  const processed: ExecutionEvent[] = [];
  const observed = new ObservedExecutionVenue(inner, {
    onProcessedEvent: (event) => {
      processed.push(event);
      throw new Error("evidence sink failure must be isolated");
    }
  });
  const forwarded: ExecutionEvent[] = [];
  observed.onExecutionEvent(async (event) => {
    forwarded.push(event);
  });
  const command = submission();
  await observed.submit(command);

  const ack = ackEvent();
  const fill = fillEvent();
  await inner.emit(ack);
  await inner.emit(fill);

  assert.strictEqual(forwarded[0], ack);
  assert.strictEqual(forwarded[1], fill);
  assert.deepEqual(observed.getSubmissions(), [command]);
  assert.deepEqual(observed.getAcknowledgements(), [ack]);
  assert.deepEqual(observed.getFills(), [fill]);
  assert.deepEqual(processed, [ack, fill]);
});

test("slow Shadow can complete after fake Binance ACK and Fill without blocking execution", async () => {
  const requestStarted = testDeferred<void>();
  const binanceFinished = testDeferred<void>();
  const releaseLayaResponse = testDeferred<Response>();
  const reportPromise = runClosureComposition({
    runBinance: async (context) => {
      await withTestTimeout(
        requestStarted.promise,
        250,
        "Laya request did not start before fake Binance execution"
      );
      context.record("BINANCE_MARKET_TICK");
      context.record("BINANCE_ACK");
      context.record("BINANCE_FILL");
      context.record("BINANCE_POSITION_PERSISTED");
      binanceFinished.resolve();
      return binanceEvidence();
    },
    runRealLaya: (context) =>
      runRealLayaClosure(closureConfig(), context, async () => {
        context.record("LAYA_REQUEST_STARTED");
        requestStarted.resolve();
        return releaseLayaResponse.promise;
      })
  });
  await withTestTimeout(binanceFinished.promise, 500, "fake Binance execution did not finish");
  releaseLayaResponse.resolve(jsonResponse(validLayaResponse("PASS")));
  const report = await reportPromise;

  assert.equal(report.overall, "PASS");
  assert.equal(report.binance.status, "PASS");
  assert.equal(report.realLaya.status, "PASS");
  assert.ok(sequence(report, "LAYA_REQUEST_STARTED") < sequence(report, "BINANCE_ACK"));
  assert.ok(sequence(report, "BINANCE_ACK") < sequence(report, "BINANCE_FILL"));
  assert.ok(sequence(report, "BINANCE_FILL") < sequence(report, "REAL_LAYA_RECORD"));
});

test("WOULD_BLOCK cannot alter fake Binance submit qty, Fill, or Position", async () => {
  const expected = binanceEvidence();
  const report = await runClosureComposition({
    runBinance: async () => structuredClone(expected),
    runRealLaya: async () => completedRecord("WOULD_BLOCK")
  });

  assert.equal(report.realLaya.verdict, "WOULD_BLOCK");
  assert.equal(report.binance.submitQty, expected.submissions[0]?.request.qty);
  assert.equal(
    report.binance.fillQty,
    expected.fills.reduce((sum, event) => sum + event.fill.qty, 0)
  );
  assert.deepEqual(report.binance.position, expected.position);
});

test("Shadow failure leaves fake Binance execution and reconciliation complete", async () => {
  const report = await runClosureComposition({
    runBinance: async () => binanceEvidence(),
    runRealLaya: async () => {
      throw new Error("fake Laya failure");
    }
  });

  assert.equal(report.overall, "FAIL");
  assert.equal(report.binance.status, "PASS");
  assert.equal(report.binance.reconciliationConsistent, true);
  assert.equal(report.realLaya.status, "FAIL");
});

test("real Laya closure path uses injected fake fetch and produces COMPLETED", async () => {
  const config = closureConfig();
  const calls: string[] = [];
  const context = resolvedContext();
  const record = await runRealLayaClosure(
    config,
    context,
    async (input) => {
      calls.push(String(input));
      return jsonResponse(validLayaResponse("WOULD_BLOCK"));
    }
  );

  assert.deepEqual(calls, ["http://laya.invalid/v1/systemone"]);
  assert.equal(record.status, "COMPLETED");
  if (record.status === "COMPLETED") assert.equal(record.shadowVerdict, "WOULD_BLOCK");
});

test("unreachable real Laya is reported FAIL without a fake-provider fallback", async () => {
  const config = closureConfig();
  const report = await runClosureComposition({
    runBinance: async () => binanceEvidence(),
    runRealLaya: (context) =>
      runRealLayaClosure(config, context, async () => {
        throw new Error("fake connection refused");
      })
  });

  assert.equal(report.binance.status, "PASS");
  assert.equal(report.realLaya.status, "FAIL");
  assert.equal(report.realLaya.recordStatus, "PROVIDER_UNAVAILABLE");
  assert.equal(report.realLaya.errorCode, "REVIEWER_UNAVAILABLE");
  assert.equal(report.overall, "FAIL");
});

test("live preflight requires consistent flat local and venue state with no recovery", () => {
  const flat = flatSnapshot();
  assert.doesNotThrow(() => validateLivePreflight(fakeBot(flat), flat));

  const unsafeCases = [
    {
      name: "inconsistent",
      bot: fakeBot(flat, { consistent: false, issues: [{ type: "POSITION_MISMATCH", localSignedQty: 0, exchangeSignedQty: 1 }] }) as never,
      snapshot: flat
    },
    {
      name: "local position",
      bot: fakeBot(flat, undefined, { symbol: "BTC-PERP", side: "LONG", qty: 1, entryPrice: 1, realizedPnl: 0 }),
      snapshot: flat
    },
    {
      name: "venue position",
      bot: fakeBot(flat),
      snapshot: { ...flat, position: { ...flat.position, side: "LONG" as const, qty: 1 } }
    },
    {
      name: "open orders",
      bot: fakeBot(flat),
      snapshot: { ...flat, openOrders: [{ orderId: "OPEN", side: "BUY" as const, remainingQty: 1 }] }
    },
    { name: "recovery", bot: fakeBot(flat, undefined, undefined, true), snapshot: flat }
  ];
  for (const unsafe of unsafeCases) {
    assert.throws(
      () => validateLivePreflight(unsafe.bot, unsafe.snapshot),
      /closure preflight failed/,
      unsafe.name
    );
  }
});

test("configuration fails closed when real Laya endpoint is missing", () => {
  assert.throws(
    () => readClosureConfig({
      BINANCE_TESTNET_API_KEY: "key",
      BINANCE_TESTNET_API_SECRET: "secret"
    }),
    /LAYA_BASE_URL is required/
  );
  assert.deepEqual(
    readClosureConfig({
      BINANCE_TESTNET_API_KEY: "key",
      BINANCE_TESTNET_API_SECRET: "secret",
      LAYA_BASE_URL: "http://127.0.0.1:8000/"
    }),
    {
      binanceApiKey: "key",
      binanceApiSecret: "secret",
      layaBaseUrl: "http://127.0.0.1:8000"
    }
  );
});

class FakeExecutionVenue implements ExecutionVenue {
  private handler: ExecutionEventHandler | undefined;

  onExecutionEvent(handler: ExecutionEventHandler): void {
    this.handler = handler;
  }

  async submit(_command: SubmitOrderCommand): Promise<void> {}
  async requestCancel(_clientOrderId: string): Promise<void> {}

  async emit(event: ExecutionEvent): Promise<void> {
    if (this.handler === undefined) throw new Error("missing fake handler");
    await this.handler(event);
  }
}

function resolvedContext(): ClosureRunContext {
  return {
    record() {}
  };
}

function testDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function withTestTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function closureConfig(): ClosureConfig {
  return {
    binanceApiKey: "fake-binance-key",
    binanceApiSecret: "fake-binance-secret",
    layaBaseUrl: "http://laya.invalid"
  };
}

function submission(): SubmitOrderCommand {
  return {
    clientOrderId: "BTC-PERP-1",
    request: {
      symbol: "BTC-PERP",
      side: "BUY",
      qty: 0.001,
      price: 80_000,
      reason: "fake closure",
      ts: 1
    }
  };
}

function ackEvent(): Extract<ExecutionEvent, { type: "ORDER_ACK" }> {
  return {
    type: "ORDER_ACK",
    ack: {
      clientOrderId: "BTC-PERP-1",
      exchangeOrderId: "FAKE-1",
      status: "ACKED",
      request: submission().request,
      ts: 2
    }
  };
}

function fillEvent(): Extract<ExecutionEvent, { type: "FILL" }> {
  return {
    type: "FILL",
    fill: {
      fillId: "FAKE-1-FILL-1",
      clientOrderId: "BTC-PERP-1",
      exchangeOrderId: "FAKE-1",
      symbol: "BTC-PERP",
      side: "BUY",
      qty: 0.001,
      price: 80_000,
      fee: 0.032,
      ts: 3
    }
  };
}

function binanceEvidence(): BinanceClosureEvidence {
  return {
    marketTicks: 7,
    submissions: [submission()],
    acknowledgements: [ackEvent()],
    fills: [fillEvent()],
    position: {
      symbol: "BTC-PERP",
      side: "LONG",
      qty: 0.001,
      entryPrice: 80_000,
      realizedPnl: 0
    },
    reconciliation: { consistent: true, issues: [] },
    venueOpenOrders: 0
  };
}

function completedRecord(verdict: "PASS" | "WOULD_BLOCK" | "ABSTAIN"): ShadowRecord {
  return {
    candidateId: "DOGE-FDV-2B:closure",
    status: "COMPLETED",
    completedAt: 4,
    shadowVerdict: verdict,
    result: {
      verdict,
      confidence: 0.8,
      moveValidity: "SUPPORTED",
      moveDecomposition: ["MOMENTUM"],
      sourceAgreement: "AGREE",
      evidenceSourceIds: ["MOCK-NEWS-CLOSURE"],
      reason: "fake result",
      catalystSupport: "HIGH",
      entryQuality: "MEDIUM",
      mispricingConfidence: "LOW",
      resolutionRisk: "LOW",
      dataQuality: "MEDIUM"
    }
  };
}

function sequence(report: { timeline: readonly { sequence: number; type: string }[] }, type: string): number {
  const event = report.timeline.find((item) => item.type === type);
  if (event === undefined) throw new Error(`missing timeline event ${type}`);
  return event.sequence;
}

function flatSnapshot(): ExchangeStateSnapshot {
  return {
    position: {
      symbol: "BTC-PERP",
      side: "FLAT",
      qty: 0,
      entryPrice: 0,
      realizedPnl: 0
    },
    openOrders: []
  };
}

function fakeBot(
  snapshot: ExchangeStateSnapshot,
  reconciliation = { consistent: true, issues: [] } as const,
  position = snapshot.position,
  recoveryRequired = false
) {
  return {
    getPosition: () => structuredClone(position),
    isRecoveryRequired: () => recoveryRequired,
    reconcile: () => structuredClone(reconciliation)
  };
}

function validLayaResponse(verdict: "PASS" | "WOULD_BLOCK" | "ABSTAIN") {
  const choices: Record<string, string> = {
    verdict,
    moveValidity: "SUPPORTED",
    primaryDriver: "MOMENTUM",
    sourceAgreement: "AGREE",
    catalystSupport: "HIGH",
    entryQuality: "MEDIUM",
    mispricingConfidence: "LOW",
    resolutionRisk: "LOW",
    dataQuality: "MEDIUM"
  };
  return {
    model: "laya-system-one",
    answers: Object.fromEntries(
      Object.entries(choices).map(([id, selected]) => {
        const allowed = layaChoices(id);
        return [
          id,
          {
            type: "choice",
            choice: selected,
            probabilities: Object.fromEntries(
              allowed.map((choice) => [choice, choice === selected ? 0.8 : 0.01])
            ),
            confidence: 0.8
          }
        ];
      })
    ),
    usage: { inputTokens: 1, outputTokens: 1 }
  };
}

function layaChoices(id: string): readonly string[] {
  if (id === "verdict") return ["PASS", "WOULD_BLOCK", "ABSTAIN"];
  if (id === "moveValidity") {
    return ["SUPPORTED", "EMOTION_AMPLIFIED", "INSUFFICIENT_SOURCE", "UNCONFIRMED"];
  }
  if (id === "primaryDriver") {
    return ["FUNDAMENTAL_EVENT", "NARRATIVE", "LIQUIDITY", "MOMENTUM", "NOISE", "UNKNOWN"];
  }
  if (id === "sourceAgreement") return ["AGREE", "CONFLICT", "INSUFFICIENT"];
  return ["HIGH", "MEDIUM", "LOW", "UNKNOWN"];
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
