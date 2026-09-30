# Meme Spot + Prediction Market Overlay Design

## Goal

Build a paper-only prototype that observes a rising meme spot asset and buys a higher-FDV YES contract with a fixed maximum loss budget instead of adding more spot exposure. Sell all YES shares when the mock YES quote reaches a configured take-profit price.

## Chosen Interpretation

- “Meme has clearly risen” means spot return from the first observed price is at least `spotRiseTriggerPct`.
- “Higher FDV target” means the prediction market's `targetFdv` is strictly greater than current mock meme `fdv`.
- “Fixed maximum risk budget” means the entry premium `shares * yesPrice` cannot exceed `maxRiskBudget`; no leverage and no averaging in.
- “Exit and realize” means paper SELL all YES shares when `yesPrice >= exitYesPrice`.
- Market resolution at `1/0` is deferred.

## Architecture

Keep the existing perpetual bot unchanged. Add a sibling `src/overlay/` vertical slice with its own domain types, strategy, risk policy, long-only YES position book, mock research context, and orchestrator.

Reuse the existing generic-enough `OrderRequest`, `OrderAck`, `Fill`, and `SimulatedExchange`. Reuse the ACK -> order-id keyed Pending -> delayed Fill orchestration pattern. Do not generalize `PerpBot`, `RiskManager`, or `PositionBook` because their LONG/SHORT target and signed perpetual-position semantics do not safely represent a fully-paid, long-only YES claim.

## Data Flow

```text
MockResearchContext snapshot
  -> MemePredictionOverlayStrategy
  -> OverlayRiskManager
  -> OrderRequest
  -> SimulatedExchange
  -> ACK
  -> Pending Map<orderId, OrderRequest>
  -> delayed Fill
  -> PredictionPositionBook
  -> overlay logs
```

## Business Objects

- `ResearchSnapshot`: mock time, meme spot price/FDV, and prediction YES quote/target FDV.
- `ResearchContext`: future-facing interface returning snapshots; this round uses `MockResearchContext` only.
- `OverlaySignal`: `HOLD`, `BUY_YES`, or `SELL_YES`, with reason and observed quote.
- `PredictionPosition`: long-only YES shares, average entry, premium at risk, and realized PnL.
- `OverlayRiskDecision`: approve/deny plus a standard `OrderRequest` when approved.

## State and Risk

Before each decision, projected YES shares equal filled shares plus pending BUY quantities minus pending SELL quantities. Entry is blocked if projected shares are already positive. Exit sells projected shares only once, preventing duplicate orders while Fill is delayed.

Entry quantity is `floor(maxRiskBudget / yesPrice, 6 decimals)`. The actual premium is therefore less than or equal to the fixed budget. A BUY Fill increases average entry and premium at risk. A SELL Fill cannot exceed held shares and realizes `(sellPrice - averageEntryPrice) * shares`, minus simulated fees from both sides as recorded by the book.

## Error Boundaries

Reject invalid YES prices outside `(0, 1]`, negative budgets, target FDV not above current FDV, duplicate entry while projected exposure exists, and exit without projected shares. No external I/O or irreversible action exists.

## Testing

- Strategy holds before the spot-rise threshold and buys only for a higher target FDV.
- Risk caps premium at the fixed budget.
- End-to-end flow logs Signal -> Risk -> ACK -> Pending -> Fill -> Position for entry and exit.
- Delayed fills do not create duplicate entry or exit orders.
- Existing perpetual tests remain unchanged and passing.

## Assumptions / Deferred Decisions

- Price take-profit is selected because it completes the requested entry/exit loop with the least state.
- Resolution settlement, NO contracts, stop loss, cancellation, rejection, partial fill, slippage, liquidity, fees specific to prediction venues, spot order execution, correlated exposure, and external News/X/Reddit feeds are deferred.
- `ResearchContext` is an interface boundary only; mock snapshots are deterministic and are not evidence that research signals are predictive.
