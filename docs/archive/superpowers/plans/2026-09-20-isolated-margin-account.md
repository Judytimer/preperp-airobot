# Isolated Margin Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal paper-only isolated-margin account that marks equity, gates insufficient-margin orders, and performs deterministic simulated liquidation.

**Architecture:** `PositionBook` remains the source of filled position and PnL. A new `IsolatedMarginAccount` derives equity and margin requirements from a position and mark price without owning orders. `PerpBot` orchestrates mark checks, pre-trade margin checks, cancellation of local in-flight orders, and a synthetic liquidation fill.

**Tech Stack:** TypeScript, Node.js 22 type stripping, built-in `node:test`, no runtime dependencies.

## Global Constraints

- Paper execution only; no real exchange or money connection.
- Reuse Market -> Strategy -> Risk -> Order -> ACK -> Fill -> Position.
- Do not add funding, insurance fund, ADL, cross-margin, or exchange liquidation queues.
- New business behavior must follow verified RED -> GREEN TDD.

---

### Task 1: Isolated Margin Calculator

**Files:**
- Create: `src/margin.ts`
- Create: `test/margin.test.ts`

**Interfaces:**
- Consumes: `Position`, mark price, starting collateral, leverage, maintenance margin rate.
- Produces: `IsolatedMarginAccount.snapshot(position, markPrice)` and `canSupport(position, markPrice)`.

- [x] Write tests for long/short unrealized PnL, equity, initial margin, maintenance margin, margin ratio, liquidation state, invalid config, and insufficient initial margin.
- [x] Run `node --experimental-strip-types --test test/margin.test.ts` and confirm RED because `src/margin.ts` is missing.
- [x] Implement immutable account snapshot calculations with finite-positive input validation.
- [x] Re-run the focused test and confirm GREEN.

### Task 2: Cancellation State for Liquidation

**Files:**
- Modify: `src/order-tracker.ts`
- Modify: `test/order-tracker.test.ts`

**Interfaces:**
- Consumes: tracked ACKED or PARTIALLY_FILLED orders.
- Produces: `cancelOpenOrders()` and terminal `CANCELED` status; late fills return `accepted: false`.

- [x] Add a failing test proving cancellation removes remaining exposure and rejects a late Fill.
- [x] Run the focused test and confirm expected assertion failure.
- [x] Implement the smallest cancellation state transition.
- [x] Re-run the focused test and confirm GREEN.

### Task 3: Bot Margin Gate and Simulated Liquidation

**Files:**
- Modify: `src/bot.ts`
- Modify: `src/logging.ts`
- Modify: `src/index.ts`
- Modify: `test/bot.test.ts`

**Interfaces:**
- Consumes: account config `{ collateral, leverage, maintenanceMarginRate }` and every market Tick as mark price.
- Produces: `[ACCOUNT]`, `[MARGIN_RISK]`, and `[LIQUIDATION]` traces plus `getAccountSnapshot()`.

- [x] Add a failing integration test: establish LONG, send an adverse mark, require liquidation to FLAT and halted strategy execution; cover canceled open orders and late Fill rejection in the tracker test.
- [x] Add a failing integration test proving insufficient initial margin prevents ACK.
- [x] Run `test/bot.test.ts` and confirm failures are caused by missing margin behavior.
- [x] Integrate mark snapshots and margin gate without changing the moving-average strategy.
- [x] On liquidation, cancel open orders, apply one synthetic reduce-only Fill at mark, log final account state, and halt subsequent strategy actions.
- [x] Re-run focused tests and confirm GREEN.

### Task 4: Documentation and Verification

**Files:**
- Modify: `README.md`
- Create: `docs/isolated-margin-learning-report.md`
- Modify: this plan

**Interfaces:**
- Consumes: verified behavior and TDD command evidence.
- Produces: assumptions, ownership map, formulas, and deferred decisions.

- [x] Document formulas, synthetic liquidation semantics, state ownership, TDD evidence, and explicit non-goals.
- [x] Run fresh `npm test`, `npm start`, and `npm run overlay`; require zero exit codes.
- [x] Review `git diff --check`, commit only task-owned files, push `main`, and verify remote SHA.
