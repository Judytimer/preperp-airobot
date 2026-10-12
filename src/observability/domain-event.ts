import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const DOMAIN_EVENT_PROTOCOL_VERSION = "1.0.0" as const;

export type DomainEventType =
  | "WATCH_CYCLE_STARTED"
  | "WATCH_CYCLE_COMPLETED"
  | "WATCH_CYCLE_FAILED"
  | "CANDIDATE_QUALIFIED"
  | "LAYA_REVIEW_STARTED"
  | "LAYA_REVIEW_COMPLETED"
  | "LAYA_REVIEW_FAILED"
  | "ORDER_SUBMITTED"
  | "ORDER_ACKNOWLEDGED"
  | "ORDER_FILLED"
  | "POSITION_CHANGED"
  | "RECONCILIATION_COMPLETED"
  | "ROUND_TRIP_COMPLETED";

export type DomainEvent<TPayload extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> = {
  readonly protocolVersion: typeof DOMAIN_EVENT_PROTOCOL_VERSION;
  readonly eventId: string;
  readonly type: DomainEventType;
  readonly occurredAt: number;
  readonly correlationId: string;
  readonly payload: TPayload;
};

export interface DomainEventSink {
  publish(event: DomainEvent): Promise<void>;
}

export function domainEvent<TPayload extends Readonly<Record<string, unknown>>>(input: {
  readonly type: DomainEventType;
  readonly occurredAt?: number;
  readonly correlationId: string;
  readonly payload: TPayload;
}): DomainEvent<TPayload> {
  if (!input.correlationId.trim()) throw new Error("domain event correlationId is required");
  return Object.freeze({
    protocolVersion: DOMAIN_EVENT_PROTOCOL_VERSION,
    eventId: randomUUID(),
    type: input.type,
    occurredAt: input.occurredAt ?? Date.now(),
    correlationId: input.correlationId,
    payload: Object.freeze({ ...input.payload })
  });
}

export class JsonlDomainEventSink implements DomainEventSink {
  private pending: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) {
    if (!path.trim()) throw new Error("domain event log path is required");
    this.path = path;
  }

  publish(event: DomainEvent): Promise<void> {
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    };
    this.pending = this.pending.then(write, write);
    return this.pending;
  }
}

export class NullDomainEventSink implements DomainEventSink {
  async publish(_event: DomainEvent): Promise<void> {}
}
