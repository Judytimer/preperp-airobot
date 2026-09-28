import assert from "node:assert/strict";
import test from "node:test";

import { LayaReviewerAdapter } from "../src/overlay/laya-reviewer.ts";
import { MemePredictionOverlayBot } from "../src/overlay/bot.ts";
import { DeterministicResearchRouter, MockEvidenceSearch } from "../src/overlay/research.ts";
import {
  BoundedShadowRunner,
  ShadowProviderUnavailableError
} from "../src/overlay/shadow-runner.ts";
import type {
  Evidence,
  ResearchPlan,
  ShadowRecord,
  TradeCandidate
} from "../src/overlay/types.ts";

test("maps one multi-question choice response into ShadowResult", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const adapter = new LayaReviewerAdapter({
    baseUrl: "http://laya.local:8000/",
    apiKey: "test-key",
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return jsonResponse(validResponse());
    }
  });

  const result = await adapter.review(candidate(), plan(), evidence());

  assert.equal(requestUrl, "http://laya.local:8000/v1/systemone");
  assert.equal(requestInit?.method, "POST");
  assert.equal((requestInit?.headers as Record<string, string>).authorization, "Bearer test-key");
  const body = JSON.parse(String(requestInit?.body));
  assert.equal("context" in body, false);
  assert.deepEqual(Object.keys(body.state), ["candidate", "researchPlan", "evidence"]);
  assert.equal(Object.keys(body.questions).length, 9);
  for (const question of Object.values(body.questions) as Array<Record<string, unknown>>) {
    assert.equal(question.type, "choice");
    assert.equal(typeof question.instructions, "string");
    assert.equal(typeof question.criteria, "object");
    assert.equal("question" in question || "choices" in question, false);
  }
  assert.equal(result.verdict, "WOULD_BLOCK");
  assert.equal(result.confidence, 0.82);
  assert.equal(result.moveValidity, "SUPPORTED");
  assert.deepEqual(result.moveDecomposition, ["MOMENTUM"]);
  assert.equal(result.sourceAgreement, "AGREE");
  assert.deepEqual(result.evidenceSourceIds, ["NEWS-1", "MARKET-1"]);
  assert.equal(
    result.reason,
    "Laya typed review: verdict=WOULD_BLOCK, moveValidity=SUPPORTED, primaryDriver=MOMENTUM"
  );
  assert.equal(result.catalystSupport, "HIGH");
  assert.equal(result.entryQuality, "MEDIUM");
  assert.equal(result.mispricingConfidence, "HIGH");
  assert.equal(result.resolutionRisk, "LOW");
  assert.equal(result.dataQuality, "MEDIUM");
});

test("missing or malformed answers become INVALID_PROVIDER_RESPONSE without raw data", async () => {
  for (const [name, response] of [
    [
      "missing",
      jsonResponse({
        ...validResponse(),
        answers: Object.fromEntries(Object.entries(validResponse().answers).slice(0, 8))
      })
    ],
    ["invalid choice", jsonResponse(validResponse({ verdict: "BUY_YES" }))],
    ["malformed", new Response("secret raw provider body", { status: 200 })],
    ["unprocessable", new Response(null, { status: 422 })],
    [
      "oversized",
      new Response(JSON.stringify(validResponse()) + " ".repeat(2_000), {
        status: 200,
        headers: { "content-length": "99999" }
      })
    ]
  ] as const) {
    const records: ShadowRecord[] = [];
    const reviewer = new LayaReviewerAdapter({
      baseUrl: "http://laya.local:8000",
      maxResponseBytes: 1_024,
      fetch: async () => response
    });
    const runner = new BoundedShadowRunner({
      router: new DeterministicResearchRouter(),
      search: new MockEvidenceSearch(evidence()),
      reviewer,
      record: (record) => records.push(record)
    });

    runner.start(candidate(name));
    await runner.drain(100);

    assert.equal(records[0]?.status, "PROVIDER_FAILED", name);
    if (records[0]?.status === "PROVIDER_FAILED") {
      assert.equal(records[0].errorCode, "INVALID_PROVIDER_RESPONSE", name);
    }
    assert.equal("shadowVerdict" in records[0]!, false, name);
    assert.doesNotMatch(JSON.stringify(records), /secret raw provider body|BUY_YES/, name);
  }
});

test("503, connection failure, and timeout report reviewer unavailable", async () => {
  const unavailableAdapters = [
    new LayaReviewerAdapter({
      baseUrl: "http://laya.local:8000",
      fetch: async () => new Response(null, { status: 503 })
    }),
    new LayaReviewerAdapter({
      baseUrl: "http://laya.local:8000",
      fetch: async () => {
        throw new Error("raw connection failure");
      }
    }),
    new LayaReviewerAdapter({
      baseUrl: "http://laya.local:8000",
      timeoutMs: 2,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("raw timeout")));
        })
    })
  ];

  for (const adapter of unavailableAdapters) {
    await assert.rejects(
      adapter.review(candidate(), plan(), evidence()),
      ShadowProviderUnavailableError
    );
  }
});

test("slow Laya HTTP response stays off the Risk, ACK, and Fill path", async () => {
  const response = deferred<Response>();
  const records: ShadowRecord[] = [];
  const logs: string[] = [];
  const runner = new BoundedShadowRunner({
    router: new DeterministicResearchRouter(),
    search: new MockEvidenceSearch(evidence()),
    reviewer: new LayaReviewerAdapter({
      baseUrl: "http://laya.local:8000",
      fetch: () => response.promise
    }),
    record: (record) => records.push(record)
  });
  const bot = new MemePredictionOverlayBot({
    spotRiseTriggerPct: 0.5,
    exitYesPrice: 0.7,
    maxRiskBudget: 100,
    fillDelayMs: 0,
    logger: (line) => logs.push(line),
    shadowRunner: runner
  });

  await bot.onSnapshot(snapshot(1, 100, 1_000, 0.3));
  await bot.onSnapshot(snapshot(2, 160, 1_600, 0.35));
  await bot.waitForIdle();

  assert.equal(records.length, 0);
  assert.equal(bot.getPosition().shares, 285.714285);
  assert.equal(logs.filter((line) => line.startsWith("[OVERLAY_RISK] approved")).length, 1);
  assert.equal(logs.filter((line) => line.startsWith("[OVERLAY_ACK]")).length, 1);
  assert.equal(logs.filter((line) => line.startsWith("[OVERLAY_FILL]")).length, 1);

  response.resolve(jsonResponse(validResponse()));
  await runner.drain(100);
  assert.equal(records[0]?.status, "COMPLETED");
});

function validResponse(overrides: Record<string, string> = {}) {
  const choices: Record<string, string> = {
    verdict: "WOULD_BLOCK",
    moveValidity: "SUPPORTED",
    primaryDriver: "MOMENTUM",
    sourceAgreement: "AGREE",
    catalystSupport: "HIGH",
    entryQuality: "MEDIUM",
    mispricingConfidence: "HIGH",
    resolutionRisk: "LOW",
    dataQuality: "MEDIUM",
    ...overrides
  };
  return {
    model: "laya-system-one",
    answers: Object.fromEntries(
      Object.entries(choices).map(([id, selectedChoice]) => {
        const allowed = questionChoices(id);
        return [
          id,
          {
            type: "choice",
            choice: selectedChoice,
            probabilities: Object.fromEntries(
              allowed.map((choice) => [choice, choice === selectedChoice ? 0.82 : 0.01])
            ),
            confidence: id === "verdict" ? 0.82 : 0.7
          }
        ];
      })
    ),
    usage: { inputTokens: 100, outputTokens: 20 }
  };
}

function questionChoices(id: string): readonly string[] {
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

function evidence(): readonly Evidence[] {
  return [
    { sourceId: "NEWS-1", publishedAt: 1, summary: "fixed news evidence" },
    { sourceId: "MARKET-1", publishedAt: 2, summary: "fixed market evidence" }
  ];
}

function candidate(candidateId = "DOGE-FDV-2B:2"): TradeCandidate {
  return {
    candidateId,
    t0: 2,
    snapshot: {
      seq: 2,
      ts: 2,
      meme: { symbol: "DOGE", spotPrice: 160, fdv: 1_600 },
      prediction: {
        marketId: "DOGE-FDV-2B",
        question: "Will DOGE exceed $2B FDV?",
        targetFdv: 2_000,
        yesPrice: 0.35
      }
    },
    signal: {
      action: "BUY_YES",
      marketId: "DOGE-FDV-2B",
      yesPrice: 0.35,
      ts: 2,
      reason: "test candidate"
    }
  };
}

function plan(): ResearchPlan {
  return new DeterministicResearchRouter().route(candidate());
}

function snapshot(seq: number, spotPrice: number, fdv: number, yesPrice: number) {
  return {
    seq,
    ts: seq,
    meme: { symbol: "DOGE", spotPrice, fdv },
    prediction: {
      marketId: "DOGE-FDV-2B",
      question: "Will DOGE exceed $2B FDV?",
      targetFdv: 2_000,
      yesPrice
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
