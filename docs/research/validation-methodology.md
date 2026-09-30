# Validation Methodology

> This document reflects the current research contract, not only a future proposal.

## 1. Two Validation Tracks

### Trading Core

Question:

> Does the system preserve order, position, risk, recovery, and reconciliation invariants under failure?

Evidence:

- deterministic tests;
- reproducible traces;
- checkpoint state;
- before/after state;
- reconciliation output;
- failure fixtures.

### Strategy / AI Research

Question:

> Does a research rule or AI reviewer improve decision quality relative to a baseline?

Evidence must come from controlled samples, not anecdotes.

## 2. Historical Replay Status

Each replay record must explicitly classify evaluation status:

```text
DEMO
QUALITATIVE_ONLY
FORMAL
```

Outcome status:

```text
MEASURED
NOT_MEASURABLE
```

Input provenance:

```text
ARCHIVED
RECONSTRUCTED
MIXED
```

## 3. FORMAL Admission

A case should not be treated as `FORMAL` unless required evidence and outcome conditions are satisfied.

Current direction requires at least:

- archived inputs;
- known T0 boundary;
- measurable outcome;
- predefined outcome rule;
- no result leakage into decision-time evidence.

A reconstructed case may still be useful, but it should remain qualitative unless admission rules are met.

## 4. T0 Boundary

`T0` is the information cutoff available to the decision process.

The reviewer must not intentionally receive:

- later news;
- later price path;
- final event outcome;
- retrospective summaries;
- later social-media interpretation.

If T0 cannot be established, the case cannot be treated as formal evidence.

## 5. Ground Truth Independence

AI cannot define whether its own earlier decision was correct.

Each case must define before evaluation:

- outcome window;
- outcome rule;
- success / failure / neutral behavior;
- measurable vs non-measurable status.

Catalyst/evidence ground truth should remain separate from trading verdict.

```text
CONFIRMED catalyst
≠
automatic PASS trade
```

## 6. Historical Replay Is Not Prospective Alpha Proof

Historical replay is useful for discovering:

- prompt bugs;
- schema gaps;
- error categories;
- label problems;
- source-verification weaknesses.

It is not enough to prove prospective trading value.

## 7. Model-Memory Limitation

Strict T0 does not erase training-memory knowledge inside a model.

This limitation must be disclosed.

Possible later mitigation:

- anonymized replay;
- strict-T0 vs intentionally leaked comparison;
- counterfactual or renamed entities.

These are sensitivity tools, not proof that memory contamination is absent.

## 8. Prompt / Rule Patching

Historical replay should not become case-specific tuning.

Only a small number of systematic patches should be accepted, and only for:

- repeated error classes;
- missing labels;
- clear evidence-boundary mistakes;
- systematic prompt defects.

## 9. Freeze

Before prospective sampling, freeze:

- reviewer prompt;
- verdict contract;
- label definitions;
- output schema;
- ground-truth rules;
- evaluation rules.

Do not freeze:

- trading-core bug fixes;
- observability;
- unrelated infrastructure fixes.

## 10. Prospective Paper Sampling

After freeze:

```text
future candidate
→ baseline decision
→ AI shadow review
→ record before outcome
→ wait for predefined outcome window
→ evaluate
```

Do not change the reviewer contract mid-batch.

If a bug or leakage issue requires a change, split the version or restart the batch.

## 11. Counterfactual Recording

Even if AI would block a trade, the project should still record the corresponding baseline outcome when possible.

Otherwise blocked cases disappear from analysis and create selection bias.

## 12. Perp-Aware Outcome Analysis

Simple end-of-window PnL can hide path risk.

Potential later metrics:

- MFE;
- MAE;
- outcome-window sensitivity;
- liquidation/margin stress;
- mark-price path;
- funding effect.

Add them when they change interpretation.

## 13. No Alpha Claim From One Case

One profitable replay or one correct veto is not evidence of persistent alpha.

Single cases are useful for:

- failure taxonomy;
- interview examples;
- research hypotheses;
- new validation rules.

Aggregate claims require an appropriate sampling process.
