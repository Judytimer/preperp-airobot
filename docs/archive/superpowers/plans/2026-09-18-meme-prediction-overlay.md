# Meme Prediction Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runnable, paper-only meme spot plus prediction-market YES overlay with fixed premium risk and price-based exit.

**Architecture:** Preserve the perpetual bot. Add a sibling `src/overlay/` slice that shares the current order/ACK/fill types and `SimulatedExchange`, while using prediction-specific strategy, risk, and long-only position accounting.

**Tech Stack:** TypeScript, Node.js 22 type stripping, built-in `node:test`, no external dependencies.

## Global Constraints

- Pure simulation and paper execution only; no real exchange, money, UI, or profitability claim.
- Default exit is YES price take-profit; resolution is deferred.
- `ResearchContext` has a mock implementation only.
- Do not refactor the existing perpetual strategy to accommodate prediction semantics.

---

### Task 1: Overlay Strategy and Risk

**Files:**
- Create: `src/overlay/types.ts`
- Create: `src/overlay/research.ts`
- Create: `src/overlay/strategy.ts`
- Create: `src/overlay/risk.ts`
- Test: `test/overlay-strategy.test.ts`

**Interfaces:**
- Produces: `ResearchContext.next(): ResearchSnapshot | null`, `MemePredictionOverlayStrategy.onSnapshot(snapshot, projectedShares): OverlaySignal`, and `OverlayRiskManager.evaluate(signal, projectedShares): OverlayRiskDecision`.

- [ ] Write failing tests proving the strategy holds below the rise threshold, requires a strictly higher target FDV, emits one BUY target when flat, and emits SELL at the take-profit quote.
- [ ] Run `npm test` and verify module-not-found RED.
- [ ] Add the domain types, deterministic mock research source, strategy, and fixed-budget risk calculation.
- [ ] Run `npm test` and verify exact actions and `premium <= maxRiskBudget`.

### Task 2: YES Position Accounting and Full Bot Loop

**Files:**
- Create: `src/overlay/position.ts`
- Create: `src/overlay/bot.ts`
- Create: `src/overlay/logging.ts`
- Test: `test/overlay-bot.test.ts`

**Interfaces:**
- Consumes: existing `SimulatedExchange.submit(order)` and shared `OrderRequest`/`Fill`.
- Produces: `PredictionPositionBook.applyFill(fill)`, `MemePredictionOverlayBot.onSnapshot(snapshot)`, `waitForIdle()`, and `getPosition()`.

- [ ] Write a failing end-to-end test with snapshots that hold, enter YES, avoid duplicate entry while pending, exit at the threshold, and avoid duplicate exit while pending.
- [ ] Run `npm test` and verify missing bot RED.
- [ ] Implement order-id keyed Pending, projected shares, standard ACK/delayed Fill reuse, and long-only YES accounting.
- [ ] Run `npm test` and verify one BUY ACK, one SELL ACK, zero final shares, and positive realized paper PnL in the controlled fixture.

### Task 3: Runnable Demo and Learning Report

**Files:**
- Create: `src/overlay-index.ts`
- Modify: `package.json`
- Modify: `README.md`
- Create: `docs/overlay-learning-report.md`

**Interfaces:**
- Produces: `npm run overlay` as the deterministic demonstration command.

- [ ] Add a mock snapshot sequence that shows HOLD -> BUY_YES -> ACK -> Pending -> Fill -> Position -> SELL_YES -> ACK -> Fill -> realized Position.
- [ ] Add the `overlay` package script and concise README usage.
- [ ] Write the report covering new business objects, reused modules, required prediction-specific modules, assumptions, deferred decisions, and unverified hypotheses.
- [ ] Run fresh `npm test`, `npm start`, and `npm run overlay`; require all commands to exit zero.
