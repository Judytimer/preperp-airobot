# Local Takeover + Testnet Step — 2026-09-27

## Environment and source

- Repository: `https://github.com/Judytimer/preperp-airobot.git`
- Branch: `main`
- Pulled HEAD: `b81cbd0`
- Node: `v22.15.0`; npm: `10.9.2`
- The pre-existing local architecture validation lab was preserved; before GitHub handoff, its stale pre-`b81cbd0` SUBMITTED-cancel assertion was synchronized with current Core semantics.

## Local proof

- `npm run demo`: exit 0. Observed Signal → Risk → ACK → partial Fill → Position; CancelAck → CANCELED → liquidation; restart → reconciliation report.
- Clean `npm start`: exit 0. The previous runtime checkpoint was moved, not deleted, to `.runtime/perp-bot-state.pre-takeover-20260927.json`. The clean run produced four terminal orders, final `SHORT 0.01`, `nextClientOrderSequence=5`, and a new atomic `.runtime/perp-bot-state.json`.
- Tracked trading/research tests excluding the known Bash portability file: 68/68 passed before this change.
- Full `npm test` on this checkout is not green for two independent local reasons:
  - `test/artifact-acquisition-script.test.ts` passes Windows URL/temp paths directly to Bash/WSL. This remains a recorded path-portability issue and was not repaired.
  - The local `test/architecture-validation.test.ts` initially described the pre-`b81cbd0` rule that SUBMITTED cannot enter CANCEL_REQUESTED. Before GitHub handoff, that stale assertion was updated to the current rule while keeping the two deferred race specimens explicit.

## One-order source walk

1. `PerpBot.onTick()` receives a Tick, runs `MovingAverageSignal`, projects filled Position plus unresolved remaining order quantity, then asks `RiskManager` for an order.
2. `PerpBot` creates the client-owned ID from symbol plus `nextClientOrderSequence`, calls `InFlightOrderTracker.trackSubmission()`, and persists `SUBMITTED` before crossing `ExecutionVenue.submit()`.
3. `InFlightOrderTracker` alone owns order status transitions and venue identity binding.
4. `PerpBot.onExecutionEvent()` routes ACK/CancelAck/Fill. An accepted Fill first updates the tracker, then calls `PositionBook.applyFill()`, logs Position/account, and persists the checkpoint.
5. `JsonFileBotStateStore.save()` writes a unique temporary file and atomically renames it to the checkpoint path.

## Minimal event-order experiment

`test/takeover-event-order-experiment.test.ts` changes only the event order:

```text
SUBMITTED → CANCEL_REQUESTED → late ACK → CancelAck → CANCELED
```

Prediction and observed result: the late ACK throws `not awaiting acknowledgment` but leaves the state at `CANCEL_REQUESTED`; the following CancelAck binds the venue ID and reaches `CANCELED`. The focused test passed 1/1.

## Testnet step

- Added Binance's current official modular package `@binance/derivatives-trading-usds-futures`.
- Added a Testnet-only execution transport and `ExecutionVenue` adapter. Production URLs are not configurable through this adapter.
- Disabled SDK retries for signed execution requests so an ambiguous `newOrder` is not sent again automatically.
- Added exchange-info parsing and MARKET_LOT_SIZE/MIN_NOTIONAL preflight. The adapter validates but does not silently rewrite Core quantity.
- Added real Testnet market feed mapping aggregate trade + mark price/index into canonical Tick.
- Added user-data mapping: `NEW → ORDER_ACK`, `TRADE → FILL`, `CANCELED → CANCEL_ACK`. Manual/unowned client IDs are ignored.
- Added a credentialed 12-tick runner with an isolated Testnet checkpoint.
- The credentialed runner ends with an authoritative Testnet position/open-orders snapshot and the existing read-only reconciliation report.
- Connector/experiment tests: 5/5 passed.
- `npm run testnet:market`: exit 0 and received three live Testnet ticks from `wss://fstream.binancefuture.com`.

## Honest remaining boundary

No Testnet API key was present, so no authenticated order was submitted in this validation. The code path from real market data through Signal/Risk to Testnet submit is ready, but exchange ACK, Fill, local Position, and account reconciliation must still be observed with the user's Testnet account before claiming the authenticated closed loop.

The clean restart also exposed a simulator-only identity collision risk: `SimulatedExchange` resets its `SIM-*`/fill sequence after process restart while processed fill IDs survive in the checkpoint. This was recorded rather than folded into the Testnet change.
