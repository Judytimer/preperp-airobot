# Order State Learning Experiments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce and explain pending-order and target-position failures, then leave the smallest tested projected-position implementation.

**Architecture:** Keep `PerpBot` as the event orchestrator, `RiskManager` as target-to-delta calculator, `SimulatedExchange` as ACK/fill source, and `PositionBook` as the only filled-position ledger. Represent in-flight exposure with a small order-id keyed pending collection in `PerpBot`; derive projected position from filled position plus those pending order effects.

**Tech Stack:** TypeScript, Node.js 22 type stripping, built-in `node:test`, no external packages.

## Global Constraints

- No real money or exchange connection, UI, Python, or full backtest framework.
- Preserve each intentional failure as concise evidence in the final learning report.
- Make the final runtime stable and minimal after all experiments.
- Treat `LONG` and `SHORT` as target position states in the final implementation.

---

### Task 1: Baseline and duplicate-order experiment

**Files:**
- Modify temporarily: `src/bot.ts`
- Test: `test/bot.test.ts`

**Interfaces:**
- Consumes: `PerpBot.onTick(tick: Tick): Promise<void>` and `PerpBot.waitForIdle(): Promise<void>`
- Produces: baseline and unprotected duplicate-order logs for the report

- [ ] Run `npm test` and `npm start`; retain one representative Tick -> Signal -> Risk -> ACK -> Fill -> Position chain.
- [ ] Temporarily bypass the `pendingOrderCount` guard in `src/bot.ts` without changing risk or exchange behavior.
- [ ] Run `npm start`; retain repeated ACKs before prior fills and the final oversized position.
- [ ] Restore the file before beginning the projected-position implementation.

### Task 2: Projected position and out-of-order fills

**Files:**
- Modify: `src/bot.ts`
- Modify: `src/risk.ts`
- Modify: `src/exchange.ts`
- Modify: `src/logging.ts`
- Modify: `src/types.ts`
- Test: `test/bot.test.ts`

**Interfaces:**
- Consumes: filled `Position`, submitted `OrderRequest`, and ACK `orderId`
- Produces: `PendingOrder`, projected `Position`, and risk decisions based on projected rather than filled exposure

- [ ] First add a failing test that sends ticks faster than fills and expects only the delta needed to reach the target.
- [ ] Run `npm test` and confirm failure demonstrates stale filled-position risk input.
- [ ] Add the minimum order-id keyed pending state; calculate projected signed quantity from filled position plus all pending order quantities.
- [ ] Remove pending entries by `fill.orderId`, then apply fills to `PositionBook`.
- [ ] Run `npm test` and confirm delayed fills no longer cause unlimited repeated orders.
- [ ] Add a failing out-of-order-fill test with deterministic per-order delays.
- [ ] Implement only the exchange delay hook needed to make order 2 fill before order 1.
- [ ] Run the test and retain fill order and final-position evidence.

### Task 3: Action signal failure and target-position restoration

**Files:**
- Modify temporarily, then restore: `src/risk.ts`
- Test: `test/risk.test.ts`

**Interfaces:**
- Consumes: `RiskManager.evaluate(signal, position, tick)`
- Produces: an order equal to target signed quantity minus current/projected signed quantity

- [ ] Temporarily change LONG/SHORT handling to unconditional BUY/SELL `orderQty`; run a focused LONG-to-SHORT scenario and retain the resulting FLAT position.
- [ ] Restore target-position delta logic.
- [ ] Add focused tests first for LONG 0.02 -> SHORT 0.01, SHORT 0.02 -> LONG 0.01, FLAT -> LONG 0.01, and LONG 0.01 -> LONG 0.01.
- [ ] Run the tests and confirm exact SELL 0.03, BUY 0.03, BUY 0.01, and no-order results.

### Task 4: Partial-fill analysis, documentation, and final verification

**Files:**
- Modify: `README.md`
- Create: `docs/learning-report.md`
- Test: `test/position.test.ts`

**Interfaces:**
- Consumes: `PositionBook.applyFill(fill: Fill): Position`
- Produces: evidence for reduce, flat, and flip behavior without implementing a complete partial-fill engine

- [ ] Add a focused test applying SELL fills of 0.006, 0.006, and 0.008 to LONG 0.01; assert LONG 0.004, SHORT 0.002, and SHORT 0.01.
- [ ] Run the test and map existing branches to add, reduce, close, and reverse.
- [ ] Write `docs/learning-report.md` in the exact six-section structure from the experiment brief, including at most ten field cards and both before/after log excerpts.
- [ ] Update `README.md` only where needed to describe projected exposure and point to the report.
- [ ] Run fresh `npm test` and `npm start`; verify zero failures and a complete final event chain.

