# PrePerp Control Room

The desktop is a local Tauri observability and supervision shell. It can:

- resolve an explicit per-user runtime boundary;
- check and start the loopback Laya service;
- distinguish a cold Laya service from a loaded model;
- supervise the fixed prospective watcher entry point and restart it after exit;
- read the latest immutable daily Price Target and hourly Up/Down scans;
- display both watcher lanes, monitored assets, staleness, and admission counts;
- display the latest immutable Laya Candidate shadow review;
- display the frozen authority boundary.
- arm one multi-asset `TESTNET_DEMO_ONLY_V1` consumer that waits for a new
  prospective Candidate, executes a minimal Binance Futures Testnet round trip,
  reconciles FLAT, writes immutable evidence, and exits.

It cannot place Mainnet orders, alter admission, infer a directional edge, or
grant Laya execution authority. The Testnet consumer never runs a second
collector; the supervised watcher remains the single evidence writer.

## Development

From the repository root:

```powershell
npm run desktop:install
npm run desktop:dev
```

The development build reads the repository's existing `work/` and `.runtime/` directories. A packaged host must set `PREPERP_DATA_ROOT`; release builds otherwise use the Tauri application-data directory.

Optional runtime overrides:

```text
PREPERP_WORKSPACE_ROOT
PREPERP_DATA_ROOT
PREPERP_BUILD_COMMIT
LAYA_HOME
LAYA_BASE_URL
```

`LAYA_BASE_URL` must point to loopback for automatic startup. The renderer receives only the fixed Tauri commands `ensure_laya`, `ensure_watcher`, `ensure_prediction_testnet`, and `system_status`; it has no shell permission and cannot provide arbitrary process arguments.

The one-shot consumer listens to BTC, ETH, SOL, XRP, DOGE, HYPE, and BNB Candidates.
Daily Price Target currently covers BTC/ETH/SOL/XRP; hourly Up/Down covers all seven.
An hourly `UP` Candidate maps to Testnet `LONG`, and `DOWN` maps to Testnet `SHORT`,
strictly under the `TESTNET_DEMO_ONLY_V1` execution-smoke boundary. This is not a
directional-edge or alpha claim. Before an asset
can execute, the Testnet account must be One-way and FLAT with no open orders.
If the symbol is Cross while flat, the runner switches that Testnet symbol to
Isolated and verifies the result before submitting. It never changes a symbol
that already has exposure or open orders.

## Shadow review boundary

After each successful watcher cycle, at most one previously unreviewed `QUALIFIED` Candidate is sent to the loopback Laya service. The bounded snapshot excludes strategy mutation and asks only for an evidence-consistency classification. Results are append-only under:

```text
work/price-target-v1/laya-shadow-v1/reviews/
```

Laya failure never changes Admission and does not terminate watch mode. Every result records that Laya cannot mutate Admission, Strategy, Risk, or submit orders. Service-reported scores are displayed as model scores and are not used for authorization.
