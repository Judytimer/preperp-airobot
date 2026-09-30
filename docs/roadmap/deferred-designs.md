# Deferred Designs and Triggered Roadmap

> This is not a generic TODO list.  
> Items enter the implementation path only when a concrete trigger justifies them.

## Status Model

Use these labels when revisiting old audit findings:

```text
RESOLVED
PARTIAL
VALID_GAP
DEFER
FALSE_POSITIVE
```

Do not carry forward an old issue merely because an earlier review mentioned it.

---

# Track A — Recovery and External Truth

## A1. Full Recovery Completion

Current repository state already has:

- checkpoint;
- unresolved detection;
- `RECOVERY_REQUIRED`;
- read-oriented reconciliation;
- Recovery Evidence contract.

Deferred work is the actual convergence step:

```text
authoritative evidence
→ idempotently apply missing fills
→ converge OrderTracker / PositionBook
→ obtain fresh mark
→ recompute Risk / Margin
→ persist converged checkpoint
→ clear RECOVERY_REQUIRED
```

### Trigger

Revisit when:

- authenticated Testnet evidence exposes a recovery case that read-only reconciliation cannot safely resolve;
- the adapter can provide authoritative terminal order/trade/position evidence for the unresolved intent;
- a target role explicitly requires recovery convergence.

---

## A2. True S2 Late Fill / Cancel-Fill Race

Current system already fixed the simpler Ghost Cancel class:

```text
cancel intent
≠
CANCELED
```

A deeper future race is:

```text
execution happens
→ cancel later becomes effective
→ fill notification arrives even later
```

This may require:

- `executionAt`;
- `cancelEffectiveAt`;
- `receivedAt`.

### Trigger

Revisit when a connector or real testnet case exposes this ambiguity.

---

## A3. Event Evidence / EventLog

A full EventLog is **not** a current required capability.

Earlier audits overstated this gap.

Current approach is acceptable:

```text
Atomic Snapshot
+
Processed IDs
+
Unresolved Detection
+
Fail Closed
+
Reconciliation
```

### Trigger

Add minimal append-only event evidence only when:

- snapshot state cannot explain a real recovery failure;
- provenance is required to apply authoritative facts safely;
- true late-event ordering cannot be resolved otherwise.

Do not jump directly to full Event Sourcing.

---

# Track B — Failure Reproducibility

## B1. Standardized Failure Injection

The simulator already exists and already reproduces useful failures.

The remaining low-cost gap is making scenarios declarative and repeatable.

Potential shape:

```text
injectScenario({
  ackDelayMs,
  fillDelayMs,
  partialFillRatio,
  duplicateFill,
  outOfOrderSeq,
  lateFillAfterCancel,
  restWsMismatch
})
```

### Why useful

It would make failure cases:

- fixture-able;
- regressable;
- easier to demo;
- easier to compare across patches.

### Priority

Low-cost hardening, not a new architecture.

---

# Track C — Exchange Integration Beyond the Current Testnet Adapter

## C1. Authenticated Evidence and Recovery Integration

The repository already contains a Binance USDⓈ-M Futures Testnet adapter, market feed, user-data event mapping, and read-only end-of-run reconciliation.

The deferred boundary is therefore no longer “build a Testnet connector”. It is:

```text
authenticated Testnet / venue evidence
→ ACK / CancelAck / TradeUpdate
→ Open Orders / Position / Trade History
→ Recovery Evidence
→ safe convergence decision
```

Future work should focus on ambiguous submit handling, authoritative recovery evidence, user-stream gap recovery, and state convergence.

A real-money connector is not required merely to make the repository appear more complete.

---

# Track D — Perpetual Risk Realism

Potential future enhancements:

- tiered maintenance margin;
- more realistic fees;
- liquidation fees;
- explicit leverage constraints;
- reduce-only semantics;
- close/reverse policy fields;
- exchange-grade mark derivation;
- richer funding attribution;
- venue liquidation events;
- post-liquidation reopened-exposure recovery;
- multi-symbol convergence;
- cross-margin modeling.

### Important correction

Earlier reviews that treated Margin/Funding/Liquidation depth as generally missing are outdated.

Current repository already has meaningful isolated-margin, mark-trigger, funding-settlement, and idempotency behavior.

Only add further realism when a concrete failure or target role requires it.

---

# Track E — Research Validation

## E1. More FORMAL Cases

Grow the formal dataset only when archived inputs and measurable outcomes are available.

Do not convert reconstructed cases into formal evidence for convenience.

## E2. Prospective Paper Sampling

After reviewer/evidence rules are frozen:

```text
future event
→ capture decision-time evidence
→ baseline
→ shadow review
→ no mid-batch prompt changes
→ outcome window
→ evaluate
```

## E3. MFE / MAE and Window Sensitivity

Add if final outcome alone hides path-dependent risk.

---

# Track F — AI Research

## F1. Memory-Sensitivity Tests

Use anonymized or renamed versions of replay cases to test sensitivity to famous historical context.

This is not proof that memory contamination is absent.

## F2. Primary-Source Authentication

Shift from:

> How many sources agree?

to:

> Is the key fact confirmed by a predefined first-party channel?

## F3. Reviewer Stability

Possible later analysis:

- repeat runs;
- prompt-version drift;
- model-version drift;
- disagreement;
- flip rate.

## F4. Bounded AI Gating

Reconsider only after prospective evidence exists.

AI remains unable to bypass deterministic risk.

## F5. Prediction Signal → PerpIntent

Still unresolved.

Do not encode a convenient mapping without an explicit trading thesis.

---

# Track G — Repository Hardening

Potential later work:

- runtime validation;
- public fixtures;
- CI;
- dependency cleanup;
- logging;
- docs cleanup;
- adapter fault injection;
- security review.

Prioritize when the repository becomes public-facing or collaborative.

---

# Explicitly Do Not Re-Add as Mandatory Work

The following were previously overstated or are not yet proven as engineering debt:

- “Fake Exchange Simulator is missing”;
- “EventLog is mandatory now”;
- “PENDING_ACK representation is a critical blocker”;
- “candidate realism is required to validate order lifecycle”;
- every schema-style criticism that has not produced a correctness failure.

---

# Revisit Triggers

Re-open this document when:

1. authenticated Testnet/venue evidence exposes a gap that the current adapter or reconciliation path cannot resolve;
2. a recovery case cannot be resolved with current evidence;
3. a true cancel/fill timing race appears;
4. FORMAL cases reach a meaningful batch size;
5. reviewer rules reach freeze;
6. prospective paper sampling starts;
7. the repository is prepared for public release;
8. the target role shifts toward Quant / AI Trading Research;
9. a job requirement explicitly asks for connector/recovery behavior.

The roadmap is condition-driven, not date-driven.
