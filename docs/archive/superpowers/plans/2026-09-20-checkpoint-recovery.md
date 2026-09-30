# Checkpoint Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist paper bot state atomically and restore it safely after restart without duplicate orders or duplicate Fill application.

**Architecture:** Add a versioned `BotCheckpoint` behind an async `BotStateStore`; provide an atomic JSON-file implementation and allow memory stores in tests. Position, order tracker, exchange sequence, halt state, and last mark are snapshotted after ACK, accepted Fill, and liquidation. Restored open orders force `RECOVERY_REQUIRED` because this simulator cannot query an external venue.

**Tech Stack:** TypeScript, Node.js `fs/promises`, built-in `node:test`, no dependencies.

## Global Constraints

- Paper execution only; never infer the outcome of an unresolved order.
- Persist only task-owned state; no credentials or external writes beyond the configured checkpoint file.
- Preserve the current strategy and execution pipeline.
- Verify each new business behavior with RED -> GREEN TDD.

---

### Task 1: Atomic State Store

**Files:**
- Create: `src/state-store.ts`
- Create: `test/state-store.test.ts`

**Interfaces:**
- Produces: `BotCheckpoint`, `BotStateStore`, `JsonFileBotStateStore.load/save`.

- [x] Write failing round-trip, missing-file, and malformed-checkpoint tests.
- [x] Run focused tests and confirm module-not-found RED.
- [x] Implement version validation plus temp-file-and-rename atomic save.
- [x] Re-run focused tests and confirm GREEN.

### Task 2: Stateful Components Round Trip

**Files:**
- Modify: `src/position.ts`
- Modify: `src/order-tracker.ts`
- Modify: `src/exchange.ts`
- Modify: `test/position.test.ts`
- Modify: `test/order-tracker.test.ts`

**Interfaces:**
- Produces: export/restore state for PositionBook and InFlightOrderTracker; export/restore next simulated order ID.

- [x] Add failing tests proving duplicate Fill IDs remain rejected and next order ID remains monotonic after restore.
- [x] Implement minimal serializable state methods with symbol and numeric validation.
- [x] Run focused tests and confirm GREEN.

### Task 3: Bot Checkpoint and Recovery Gate

**Files:**
- Modify: `src/bot.ts`
- Modify: `src/index.ts`
- Modify: `test/bot.test.ts`

**Interfaces:**
- Consumes: optional `stateStore` in BotConfig.
- Produces: `PerpBot.create(config)`, checkpoint writes, `isRecoveryRequired()`.

- [x] Add failing integration tests for completed-position restore and unresolved-order recovery halt.
- [x] Restore before accepting ticks; save after ACK, accepted Fill, and liquidation.
- [x] Continue exchange IDs from checkpoint and halt when restored open orders exist.
- [x] Run focused tests; confirm GREEN.

### Task 4: Documentation and Release

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Create: `docs/checkpoint-recovery-learning-report.md`
- Modify: this plan

- [x] Ignore local runtime checkpoint files and document recovery semantics and limitations.
- [x] Run fresh `npm test`, `npm start`, `npm run overlay`, and `git diff --check`.
- [x] Commit task-owned files, push `main`, and verify local/remote SHA equality.
