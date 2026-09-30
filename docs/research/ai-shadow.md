# AI Shadow Research

> Status: implemented research boundary; not execution authority.

## Purpose

The AI layer asks a narrow question:

> Can a reviewer improve evidence quality or reduce obvious false opportunities without being granted control over execution?

It is intentionally separated from the trading core.

## Current Role

```text
Candidate / Research Snapshot
        ↓
Baseline Decision
        ↓
AI Shadow Reviewer
        ↓
Review / Evidence / Labels
        ↓
Research Record
```

The reviewer can produce a single research verdict such as:

- PASS;
- WOULD_BLOCK;
- ABSTAIN.

It can also record:

- reason;
- confidence;
- reviewer identity;
- prompt version;
- run identity.

## No Execution Authority

The AI reviewer does not directly:

- submit orders;
- set leverage;
- size positions;
- bypass risk;
- reverse positions;
- clear recovery state.

## Historical Replay Role

Historical replay is primarily for:

- finding prompt weaknesses;
- finding missing fields;
- discovering error patterns;
- testing label definitions;
- testing evidence boundaries.

It is **not** treated as proof of prospective alpha.

## Known Limitation: Model Memory

Strict T0 input filtering cannot remove information already embedded in model weights from famous historical events.

Therefore historical replay has a known memory/hindsight limitation.

The correct response is:

- disclose it;
- optionally run memory-sensitivity tests;
- avoid treating replay performance as prospective proof.

## Reviewer Stability

Reviewer stability remains a real research question.

Useful metadata includes:

```text
reviewerId
verdict
reason
confidence
promptVersion
runId
```

Possible later stability analysis:

- repeated runs;
- model changes;
- prompt changes;
- flip rate;
- disagreement analysis.

## External Signals

Prediction markets, news, event-search systems, or alternative data may contribute:

- evidence;
- catalyst confirmation;
- research context;
- candidate generation.

They do not automatically become executable perpetual intent.

## Required Semantic Bridge

```text
External Evidence
→ Research Signal
→ Trading Thesis
→ PerpIntent
→ Deterministic Risk
→ Execution
```

`Trading Thesis → PerpIntent` remains an explicit business decision.

## Future Authority

A possible future progression is:

```text
Shadow only
→ bounded candidate gating
```

Only after prospective evidence exists.

Deterministic risk remains downstream and non-bypassable.

## Deferred Research Questions

- memory-sensitivity A/B;
- first-party source authentication;
- reviewer attribution;
- reviewer stability;
- false-block analysis;
- evidence-availability bias;
- prospective paper validation;
- more complex multi-source research.

These are research questions, not current execution features.
