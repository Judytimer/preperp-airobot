import type { ClosedSpotCandle, TimedYesPrice } from "./strategy-lab.ts";

export type PolymarketResolution = {
  readonly marketId: string;
  readonly yesTokenId: string;
  readonly winningTokenId: string;
  readonly winningOutcome: string | null;
  readonly sourceTimestamp: number;
  readonly result: "YES" | "NO";
};

/** Decode the frozen Binance Spot /api/v3/klines tuple response. */
export function parseBinanceSpotKlines(raw: string | Uint8Array): readonly ClosedSpotCandle[] {
  const value = parseJson(text(raw), "Binance Spot Kline artifact");
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Binance Spot Kline artifact must be a non-empty JSON array");
  }
  return value.map((row, index) => {
    if (!Array.isArray(row) || row.length < 7) {
      throw new Error(`Binance Spot Kline row ${index} is invalid`);
    }
    return {
      openTs: timestamp(row[0], `Binance Spot Kline row ${index} open time`),
      closeTs: timestamp(row[6], `Binance Spot Kline row ${index} close time`),
      close: positiveDecimal(row[4], `Binance Spot Kline row ${index} close`)
    };
  });
}

/** Decode archived public market-stream messages and retain only the frozen YES token trades. */
export function parsePolymarketLastTrades(
  raw: string | Uint8Array,
  yesTokenId: string
): readonly TimedYesPrice[] {
  const points: TimedYesPrice[] = [];
  for (const [index, value] of parseJsonMessages(text(raw), "Polymarket last-trade artifact").entries()) {
    const payload = marketEventPayload(value, "last_trade_price");
    if (payload === null) continue;
    const tokenId = requiredString(
      payload.tokenId ?? payload.token_id ?? payload.asset_id,
      `Polymarket last-trade message ${index} token id`
    );
    if (tokenId !== yesTokenId) continue;
    points.push({
      ts: eventTimestamp(payload.timestamp, `Polymarket last-trade message ${index} timestamp`),
      yesPrice: probability(payload.price, `Polymarket last-trade message ${index} price`)
    });
  }
  if (points.length === 0) throw new Error("Polymarket artifact contains no last trade for the frozen YES token");
  points.sort((left, right) => left.ts - right.ts);
  return deduplicateTimedPrices(points);
}

/** Decode the public Polymarket market_resolved event; no hand-entered verdict is accepted. */
export function parsePolymarketResolution(
  raw: string | Uint8Array,
  marketId: string,
  yesTokenId: string
): PolymarketResolution {
  const matches: PolymarketResolution[] = [];
  for (const [index, value] of parseJsonMessages(text(raw), "Polymarket resolution artifact").entries()) {
    const payload = marketEventPayload(value, "market_resolved");
    if (payload === null) continue;
    const observedMarketId = requiredString(
      payload.id ?? payload.market_id,
      `Polymarket resolution message ${index} market id`
    );
    if (observedMarketId !== marketId) continue;
    const tokenIdsValue = payload.tokenIds ?? payload.token_ids;
    if (!Array.isArray(tokenIdsValue) || !tokenIdsValue.every((item) => typeof item === "string")) {
      throw new Error(`Polymarket resolution message ${index} token ids are invalid`);
    }
    if (!tokenIdsValue.includes(yesTokenId)) {
      throw new Error("Polymarket resolution does not include the frozen YES token");
    }
    const winningTokenId = requiredString(
      payload.winningTokenId ?? payload.winning_token_id,
      `Polymarket resolution message ${index} winning token id`
    );
    if (!tokenIdsValue.includes(winningTokenId)) {
      throw new Error("Polymarket resolution winning token is not part of the market");
    }
    const winningOutcomeValue = payload.winningOutcome ?? payload.winning_outcome;
    const winningOutcome = winningOutcomeValue === null || winningOutcomeValue === undefined
      ? null
      : requiredString(winningOutcomeValue, `Polymarket resolution message ${index} winning outcome`);
    const result = winningTokenId === yesTokenId ? "YES" : "NO";
    if (winningOutcome !== null && /^(yes|no)$/i.test(winningOutcome)) {
      const namedResult = winningOutcome.toUpperCase() as "YES" | "NO";
      if (namedResult !== result) throw new Error("Polymarket resolution token and named outcome disagree");
    }
    matches.push({
      marketId,
      yesTokenId,
      winningTokenId,
      winningOutcome,
      sourceTimestamp: eventTimestamp(
        payload.timestamp,
        `Polymarket resolution message ${index} timestamp`
      ),
      result
    });
  }
  if (matches.length === 0) throw new Error("Polymarket artifact contains no resolution for the frozen market");
  const first = matches[0];
  if (matches.some((item) => item.result !== first.result || item.winningTokenId !== first.winningTokenId)) {
    throw new Error("Polymarket artifact contains conflicting market resolutions");
  }
  return matches.reduce((earliest, item) =>
    item.sourceTimestamp < earliest.sourceTimestamp ? item : earliest
  );
}

function parseJsonMessages(raw: string, label: string): readonly unknown[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error(`${label} is empty`);
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
    try {
      return lines.map((line) => JSON.parse(line) as unknown);
    } catch {
      throw new Error(`${label} is neither JSON nor newline-delimited JSON`);
    }
  }
}

function marketEventPayload(value: unknown, eventType: string): Record<string, unknown> | null {
  if (!isRecord(value)) throw new Error("Polymarket market-stream message must be an object");
  const actualType = value.type ?? value.event_type;
  if (actualType !== eventType) return null;
  if (value.topic !== undefined && value.topic !== "market") {
    throw new Error("Polymarket event topic is not market");
  }
  const payload = value.payload === undefined ? value : value.payload;
  if (!isRecord(payload)) throw new Error(`Polymarket ${eventType} payload is invalid`);
  return payload;
}

function deduplicateTimedPrices(points: readonly TimedYesPrice[]): readonly TimedYesPrice[] {
  const result: TimedYesPrice[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous?.ts === point.ts) {
      if (previous.yesPrice !== point.yesPrice) {
        throw new Error("Polymarket artifact contains conflicting trades at one timestamp");
      }
      continue;
    }
    result.push(point);
  }
  return result;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function eventTimestamp(value: unknown, label: string): number {
  if (typeof value === "number") return timestamp(value, label);
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  if (/^\d+$/.test(value)) return timestamp(Number(value), label);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function positiveDecimal(value: unknown, label: string): number {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function probability(value: unknown, label: string): number {
  const parsed = positiveDecimal(value, label);
  if (parsed > 1) throw new Error(`${label} is outside (0, 1]`);
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function text(value: string | Uint8Array): string {
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
