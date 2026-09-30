# Design Decisions

> This document records deliberate decisions confirmed by repository reality, failure traces, and later audit corrections.

## 1. Repository Reality Overrides Planning Documents

Architecture claims are based on the latest repository behavior, deterministic traces, and implementation diffs.

Priority of evidence:

```text
latest repo / deterministic trace
>
Repo Reality audit
>
final planning spec
>
older architecture audit
>
early ideas
```

A document being silent does not prove the code lacks a capability.

A class existing also does not prove an engineering invariant is solved.

## 2. Perpetual Core Before Strategy Complexity

Engineering priority:

1. Order Lifecycle
2. Position / Projected Position
3. Risk
4. Margin
5. Funding
6. Liquidation
7. Failure / Recovery
8. Reconciliation

Strategy complexity must not weaken these boundaries.

## 3. Engineering Alignment Is Not Strategy Migration

Open-source projects are references for:

- connector boundaries;
- order state;
- execution semantics;
- recovery;
- reconciliation;
- perpetual-domain behavior.

Their strategies are not copied into this project by default.

## 4. Intent Is Not Fact

These are not equivalent:

```text
cancel requested = canceled
submit timeout = order absent
local state = venue truth
```

Execution facts and order facts outrank local mirror and intent.

## 5. Local State Must Not Erase Authoritative Execution

A new valid exchange-reported fill cannot be silently discarded solely because local state says `CANCELED`.

This invariant came from the Liquidation × Late Fill failure reproduction.

## 6. Submit Completion Is Not ACK

A submit command returning does not imply that an ACK has already been established as an independent execution fact.

Command and event must remain separate.

## 7. Ambiguous Submit Is Not a Generic Retry Problem

A generic retry helper can be unsafe:

```text
submit
→ timeout
→ venue may have accepted
→ blind retry
→ duplicate order
```

Order identity, ambiguity, recovery, and reconciliation remain domain concerns.

## 8. Core Owns clientOrderId

The core creates and persists client order identity before submit.

The venue owns venue-side identity and internal sequence.

This avoids making local recoverability depend on a venue response that may never arrive.

## 9. Projected Exposure Belongs in Risk

Risk evaluates filled position plus unresolved order exposure.

A delayed fill must not create false available risk capacity.

## 10. Reconciliation Is Not Recovery

Reconciliation answers:

> Where do local and external facts disagree?

Recovery answers:

> Given sufficient authoritative evidence, how do we safely converge state and reopen trading?

The current project has reconciliation and a recovery-evidence contract.

Full recovery mutation is deferred.

## 11. Fail Closed on Unknown Execution State

When the external truth cannot be proven after restart or ambiguity, the system stops trading.

`RECOVERY_REQUIRED` is intentionally conservative.

## 12. Snapshot Is Not Event Provenance

Checkpoint answers:

> What state do we currently believe?

It does not fully explain every event ordering.

A complete EventLog is deferred because current failures have not proved it necessary.

The current alternative is:

```text
Atomic Snapshot
+
Processed IDs
+
Unresolved Order Detection
+
RECOVERY_REQUIRED
+
Future Exchange Reconciliation
```

## 13. Event Arrival Time Is Not Execution Time

A late-arriving event may describe an earlier venue execution.

Therefore:

```text
receivedAt
```

must not automatically be treated as:

```text
executionAt
```

This becomes especially important in true cancel/fill races.

## 14. Schema Taste Is Not Decision Debt

Architecture review must distinguish:

```text
schema taste
```

from:

```text
a correctness problem proven by a failure
```

Examples such as side/qty representation, single entryPrice shape, or event sequence fields should not become mandatory work unless they alter an actual invariant or recovery decision.

## 15. Simulator Already Exists

Earlier audits that treated “missing fake exchange simulator” as a major gap were incorrect.

The actual lower-cost gap is reproducibility and fixture quality, not simulator existence.

## 16. Failure-Driven Complexity

Add complexity when one of these is true:

- a reproducible failure requires it;
- a connector introduces it;
- reconciliation cannot converge without it;
- a target role explicitly requires it;
- testnet/paper evidence exposes the gap.

Do not add architecture because a mature framework has it.

## 17. AI Cannot Bypass Deterministic Risk

AI currently remains research/review only.

It may:

- observe;
- label;
- attach evidence;
- return a review verdict;
- create research records.

It may not directly control:

- order submission;
- leverage;
- size;
- stop loss;
- risk bypass;
- automatic reversal.

## 18. Prediction Signal Is Not Automatically PerpIntent

A prediction-market or external signal may be:

- research signal;
- evidence;
- external context;
- catalyst confirmation.

But:

```text
YES appears underpriced
```

does not automatically imply:

```text
LONG a perpetual
```

The bridge remains explicit:

```text
Research Signal
→ Trading Thesis
→ PerpIntent
```

This is unresolved business semantics and must not be invented by code generation.
