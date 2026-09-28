import { ShadowProviderUnavailableError } from "./shadow-runner.ts";
import type {
  Evidence,
  LlmStrategyReviewer,
  ResearchPlan,
  ReviewAssessment,
  ShadowResult,
  TradeCandidate
} from "./types.ts";

type Fetch = typeof fetch;

export type LayaReviewerConfig = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: Fetch;
};

type ChoiceQuestion = {
  id: string;
  type: "choice";
  question: string;
  choices: readonly string[];
};

type ChoiceAnswer = {
  id: string;
  choice: string;
  confidence: number;
};

const VERDICTS = ["PASS", "WOULD_BLOCK", "ABSTAIN"] as const;
const MOVE_VALIDITIES = [
  "SUPPORTED",
  "EMOTION_AMPLIFIED",
  "INSUFFICIENT_SOURCE",
  "UNCONFIRMED"
] as const;
const MOVE_DRIVERS = [
  "FUNDAMENTAL_EVENT",
  "NARRATIVE",
  "LIQUIDITY",
  "MOMENTUM",
  "NOISE",
  "UNKNOWN"
] as const;
const SOURCE_AGREEMENTS = ["AGREE", "CONFLICT", "INSUFFICIENT"] as const;
const ASSESSMENTS = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;

const QUESTIONS: readonly ChoiceQuestion[] = [
  choice("verdict", "Should the fixed Overlay entry candidate pass shadow review?", VERDICTS),
  choice("moveValidity", "How valid is the observed move?", MOVE_VALIDITIES),
  choice("primaryDriver", "What is the primary driver of the move?", MOVE_DRIVERS),
  choice("sourceAgreement", "How well do the supplied evidence sources agree?", SOURCE_AGREEMENTS),
  choice("catalystSupport", "How strongly does the evidence support a catalyst?", ASSESSMENTS),
  choice("entryQuality", "What is the quality of the proposed entry?", ASSESSMENTS),
  choice("mispricingConfidence", "How strong is the evidence of mispricing?", ASSESSMENTS),
  choice("resolutionRisk", "How high is prediction-market resolution risk?", ASSESSMENTS),
  choice("dataQuality", "What is the quality of the supplied data?", ASSESSMENTS)
];

export class LayaReviewerAdapter implements LlmStrategyReviewer {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: Fetch;

  constructor(config: LayaReviewerConfig) {
    if (config.baseUrl.length === 0) throw new Error("Laya baseUrl is required");
    this.endpoint = `${config.baseUrl.replace(/\/$/, "")}/v1/systemone`;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.maxResponseBytes = config.maxResponseBytes ?? 64 * 1024;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Laya timeoutMs must be positive and finite");
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new Error("Laya maxResponseBytes must be a positive integer");
    }
    this.fetchImpl = config.fetch ?? fetch;
  }

  async review(
    candidate: TradeCandidate,
    plan: ResearchPlan,
    evidence: readonly Evidence[]
  ): Promise<ShadowResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          context: { candidate, researchPlan: plan, evidence },
          questions: QUESTIONS
        }),
        signal: controller.signal
      });
    } catch {
      clearTimeout(timeout);
      throw new ShadowProviderUnavailableError("Laya reviewer unavailable");
    }

    try {
      if (response.status === 503) {
        throw new ShadowProviderUnavailableError("Laya reviewer unavailable");
      }
      if (!response.ok) throw new Error("Laya reviewer request failed");

      const payload = await readBoundedJson(response, this.maxResponseBytes);
      const result = toShadowResult(payload, evidence);
      return result ?? invalidShadowResult();
    } catch (error) {
      if (error instanceof ShadowProviderUnavailableError) throw error;
      if (controller.signal.aborted) {
        throw new ShadowProviderUnavailableError("Laya reviewer unavailable");
      }
      if (error instanceof InvalidLayaResponseError) return invalidShadowResult();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey !== undefined) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }
}

function choice(
  id: string,
  question: string,
  choices: readonly string[]
): ChoiceQuestion {
  return { id, type: "choice", question, choices };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new InvalidLayaResponseError();
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new InvalidLayaResponseError();
    return parseJson(bytes);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new InvalidLayaResponseError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseJson(bytes);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InvalidLayaResponseError();
  }
}

function toShadowResult(payload: unknown, evidence: readonly Evidence[]): ShadowResult | null {
  if (!isObject(payload) || !Array.isArray(payload.answers)) return null;
  const answers = new Map<string, ChoiceAnswer>();
  for (const value of payload.answers) {
    const parsed = choiceAnswer(value);
    if (parsed === null || answers.has(parsed.id)) return null;
    answers.set(parsed.id, parsed);
  }
  if (answers.size !== QUESTIONS.length) return null;

  const verdict = answer(answers, "verdict", VERDICTS);
  const moveValidity = answer(answers, "moveValidity", MOVE_VALIDITIES);
  const primaryDriver = answer(answers, "primaryDriver", MOVE_DRIVERS);
  const sourceAgreement = answer(answers, "sourceAgreement", SOURCE_AGREEMENTS);
  const catalystSupport = answer(answers, "catalystSupport", ASSESSMENTS);
  const entryQuality = answer(answers, "entryQuality", ASSESSMENTS);
  const mispricingConfidence = answer(answers, "mispricingConfidence", ASSESSMENTS);
  const resolutionRisk = answer(answers, "resolutionRisk", ASSESSMENTS);
  const dataQuality = answer(answers, "dataQuality", ASSESSMENTS);
  if (
    verdict === null ||
    moveValidity === null ||
    primaryDriver === null ||
    sourceAgreement === null ||
    catalystSupport === null ||
    entryQuality === null ||
    mispricingConfidence === null ||
    resolutionRisk === null ||
    dataQuality === null
  ) {
    return null;
  }

  const confidence = answers.get("verdict")!.confidence;
  return {
    verdict,
    confidence,
    moveValidity,
    moveDecomposition: [primaryDriver],
    sourceAgreement,
    evidenceSourceIds: evidence.map((item) => item.sourceId),
    reason: `Laya typed review: verdict=${verdict}, moveValidity=${moveValidity}, primaryDriver=${primaryDriver}`,
    catalystSupport: catalystSupport as ReviewAssessment,
    entryQuality: entryQuality as ReviewAssessment,
    mispricingConfidence: mispricingConfidence as ReviewAssessment,
    resolutionRisk: resolutionRisk as ReviewAssessment,
    dataQuality: dataQuality as ReviewAssessment
  };
}

function answer<const T extends readonly string[]>(
  answers: ReadonlyMap<string, ChoiceAnswer>,
  id: string,
  allowed: T
): T[number] | null {
  const value = answers.get(id);
  if (value === undefined || !allowed.includes(value.choice)) return null;
  return value.choice;
}

function choiceAnswer(value: unknown): ChoiceAnswer | null {
  if (!isObject(value)) return null;
  const id = typeof value.id === "string" ? value.id : value.questionId;
  if (
    typeof id !== "string" ||
    typeof value.choice !== "string" ||
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    return null;
  }
  return { id, choice: value.choice, confidence: value.confidence };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidShadowResult(): ShadowResult {
  return { verdict: "INVALID_PROVIDER_RESPONSE" } as unknown as ShadowResult;
}

class InvalidLayaResponseError extends Error {}
