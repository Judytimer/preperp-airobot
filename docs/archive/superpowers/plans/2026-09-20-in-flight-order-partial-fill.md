# In-Flight Order Partial Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep projected exposure correct across multiple partial fills by introducing a minimal in-flight order lifecycle.

**Architecture:** Add an `InFlightOrderTracker` as the single source of truth for ACKed orders, cumulative fills, remaining quantity, status, and fill-id idempotency. `PerpBot` reads open orders from the tracker; `PositionBook` remains the filled-position ledger. `SimulatedExchange` gains an optional deterministic partial-fill plan while retaining one full fill by default.

**Tech Stack:** TypeScript, Node.js 22 type stripping, built-in `node:test`, no dependencies.

## Global Constraints

- Keep the existing Strategy and Risk semantics unchanged.
- Do not add leverage, margin, liquidation, real connectors, persistence, Cancel, or Reject.
- Existing Perp and Prediction Overlay demos must continue to run.

---

### Task 1: In-Flight Order Lifecycle

**Files:**
- Create: `src/order-tracker.ts`
- Modify: `src/types.ts`
- Test: `test/order-tracker.test.ts`

**Interfaces:**
- Produces: `trackAck(ack)`, `processFill(fill)`, `getOpenOrders()`, and `get(orderId)`.
- Order state: `ACKED | PARTIALLY_FILLED | FILLED` with `originalQty`, `filledQty`, `remainingQty`, and processed fill IDs.

- [x] Write a failing test that tracks an ACK, applies BUY fills of 0.004 and 0.006, verifies the intermediate and terminal states, and rejects a duplicate fill ID.
- [x] Run the focused test and confirm module-not-found RED.
- [x] Implement the smallest tracker that validates order identity and prevents overfill.
- [x] Run the focused test and confirm GREEN.

### Task 2: Partial-Fill Execution Path

**Files:**
- Modify: `src/exchange.ts`
- Modify: `src/bot.ts`
- Modify: `src/overlay/bot.ts`
- Modify: `src/logging.ts`
- Test: `test/bot.test.ts`

**Interfaces:**
- `SimulatedExchange.submit()` produces `fills: Promise<Fill>[]`.
- Optional `fillPlan` contains ordered `{ fraction, delayMs }` steps whose fractions sum to 1.
- `PerpBot` applies each accepted fill and keeps the order open until `remainingQty` is zero.

- [x] Add a failing bot test configured with 40% and 60% fills; require one ACK, PARTIALLY_FILLED then FILLED traces, and final LONG 0.01.
- [x] Implement fill-plan validation and multiple fill promises with unique fill IDs.
- [x] Replace PerpBot's pending map with the tracker and derive projected exposure from remaining quantities.
- [x] Update Overlay Bot to consume the default one-or-more fill promises without adding an overlay tracker.
- [x] Run all tests and verify no duplicate order is submitted while an order is partially filled.

### Task 3: Documentation and Verification

**Files:**
- Modify: `README.md`
- Create: `docs/partial-fill-learning-report.md`

**Interfaces:**
- Produces: a concise ownership and state-transition report.

- [x] Document ACKED -> PARTIALLY_FILLED -> FILLED, projected exposure, ownership changes, and explicitly deferred features.
- [x] Run fresh `npm test`, `npm start`, and `npm run overlay`; require all commands to exit zero.
