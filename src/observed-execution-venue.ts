import type { ExecutionEventHandler, ExecutionVenue } from "./exchange.ts";
import type { ExecutionEvent, SubmitOrderCommand } from "./types.ts";

type ObserverHooks = {
  readonly onSubmit?: (command: SubmitOrderCommand) => void;
  readonly onProcessedEvent?: (event: ExecutionEvent) => void;
};

/**
 * Composition-only observer. It forwards the event to the state owner first,
 * waits for processing/persistence, and only then captures immutable evidence.
 */
export class ObservedExecutionVenue implements ExecutionVenue {
  private downstream: ExecutionEventHandler | undefined;
  private readonly submissions: SubmitOrderCommand[] = [];
  private readonly events: ExecutionEvent[] = [];
  private readonly inner: ExecutionVenue;
  private readonly hooks: ObserverHooks;

  constructor(inner: ExecutionVenue, hooks: ObserverHooks = {}) {
    this.inner = inner;
    this.hooks = hooks;
    inner.onExecutionEvent(async (event) => {
      if (this.downstream === undefined) {
        throw new Error("observed execution venue has no downstream handler");
      }
      await this.downstream(event);
      const evidence = structuredClone(event);
      this.events.push(evidence);
      try {
        this.hooks.onProcessedEvent?.(evidence);
      } catch {
        // Evidence observers never acquire execution authority.
      }
    });
  }

  onExecutionEvent(handler: ExecutionEventHandler): void {
    if (this.downstream !== undefined) throw new Error("observed execution venue handler is already registered");
    this.downstream = handler;
  }

  async submit(command: SubmitOrderCommand): Promise<void> {
    const evidence = structuredClone(command);
    this.submissions.push(evidence);
    try {
      this.hooks.onSubmit?.(evidence);
    } catch {
      // Evidence observers never acquire execution authority.
    }
    await this.inner.submit(command);
  }

  async requestCancel(clientOrderId: string): Promise<void> {
    await this.inner.requestCancel(clientOrderId);
  }

  getSubmissions(): readonly SubmitOrderCommand[] {
    return structuredClone(this.submissions);
  }

  getAcknowledgements(): readonly Extract<ExecutionEvent, { type: "ORDER_ACK" }>[] {
    return structuredClone(this.events.filter(
      (event): event is Extract<ExecutionEvent, { type: "ORDER_ACK" }> => event.type === "ORDER_ACK"
    ));
  }

  getFills(): readonly Extract<ExecutionEvent, { type: "FILL" }>[] {
    return structuredClone(this.events.filter(
      (event): event is Extract<ExecutionEvent, { type: "FILL" }> => event.type === "FILL"
    ));
  }

  getTerminals(): readonly Extract<ExecutionEvent, { type: "ORDER_TERMINAL" }>[] {
    return structuredClone(this.events.filter(
      (event): event is Extract<ExecutionEvent, { type: "ORDER_TERMINAL" }> => event.type === "ORDER_TERMINAL"
    ));
  }
}
