import type { Fill, OrderAck, OrderRequest } from "../types.ts";
import type {
  OverlayRiskDecision,
  OverlaySignal,
  PredictionPosition,
  ResearchSnapshot,
  ShadowRecord,
  TradeCandidate
} from "./types.ts";

export function formatResearch(snapshot: ResearchSnapshot): string {
  return `[RESEARCH] seq=${snapshot.seq} meme=${snapshot.meme.symbol} spot=${snapshot.meme.spotPrice} fdv=${snapshot.meme.fdv} market=${snapshot.prediction.marketId} yes=${snapshot.prediction.yesPrice} targetFdv=${snapshot.prediction.targetFdv}`;
}

export function formatOverlaySignal(signal: OverlaySignal): string {
  return `[OVERLAY_SIGNAL] action=${signal.action} yes=${signal.yesPrice} reason="${signal.reason}"`;
}

export function formatTradeCandidate(candidate: TradeCandidate): string {
  return `[TRADE_CANDIDATE] id=${candidate.candidateId} t0=${candidate.t0} market=${candidate.signal.marketId} action=${candidate.signal.action}`;
}

export function formatShadowRecord(record: ShadowRecord): string {
  if (record.status === "COMPLETED") {
    return `[SHADOW_RECORD] mode=SHADOW executionAuthority=false candidateId=${record.candidateId} status=${record.status} verdict=${record.shadowVerdict} moveValidity=${record.result.moveValidity} sourceAgreement=${record.result.sourceAgreement} evidenceSourceIds=${record.result.evidenceSourceIds.join(",")}`;
  }
  if (record.status === "PROVIDER_UNAVAILABLE" || record.status === "PROVIDER_FAILED") {
    return `[SHADOW_RECORD] mode=SHADOW executionAuthority=false candidateId=${record.candidateId} status=${record.status} errorCode=${record.errorCode}`;
  }
  return `[SHADOW_RECORD] mode=SHADOW executionAuthority=false candidateId=${record.candidateId} status=${record.status}`;
}

export function formatOverlayRisk(decision: OverlayRiskDecision): string {
  return decision.approved
    ? `[OVERLAY_RISK] approved side=${decision.order.side} qty=${decision.order.qty} premium=${(
        decision.order.qty * decision.order.price
      ).toFixed(6)}`
    : `[OVERLAY_RISK] blocked reason="${decision.reason}"`;
}

export function formatOverlayAck(ack: OrderAck): string {
  return `[OVERLAY_ACK] clientOrderId=${ack.clientOrderId} exchangeOrderId=${ack.exchangeOrderId} side=${ack.request.side} qty=${ack.request.qty} price=${ack.request.price}`;
}

export function formatPending(orderId: string, order: OrderRequest): string {
  return `[OVERLAY_PENDING] orderId=${orderId} side=${order.side} qty=${order.qty}`;
}

export function formatOverlayFill(fill: Fill): string {
  return `[OVERLAY_FILL] fillId=${fill.fillId} clientOrderId=${fill.clientOrderId} exchangeOrderId=${fill.exchangeOrderId} side=${fill.side} qty=${fill.qty} price=${fill.price}`;
}

export function formatOverlayPosition(position: PredictionPosition): string {
  return `[OVERLAY_POSITION] shares=${position.shares} averageEntry=${position.averageEntryPrice} premiumAtRisk=${position.premiumAtRisk} realizedPnl=${position.realizedPnl}`;
}
