# Binance Testnet 接管与验证记录

日期：2026-09-27  
性质：阶段性验证记录；当前最终状态仍以根 README、Perp Execution Validation case 与源码为准。

## 1. 本地接管验证

当时已验证：

- `npm run demo`：Signal → Risk → ACK → Partial Fill → Position → CancelAck → Liquidation → Reconciliation；
- clean `npm start`：正常运行并生成新的 atomic checkpoint；
- 主交易/研究 focused tests 当时通过 68/68（不含已知 Bash 路径可移植性测试）。

## 2. 一张订单的核心源码路径

`onTick → MovingAverageSignal → projected exposure → RiskManager → clientOrderId → trackSubmission/persist SUBMITTED → ExecutionVenue.submit → ACK/CancelAck/Fill event → OrderTracker → PositionBook → atomic checkpoint`。

## 3. 最小事件顺序实验

```text
SUBMITTED
→ CANCEL_REQUESTED
→ late ACK
→ CancelAck
→ CANCELED
```

late ACK 不会把状态倒退；后续 CancelAck 仍可完成 venue identity 绑定并进入 CANCELED。

## 4. Binance USDⓈ-M Futures Testnet 接入

当轮加入：

- 官方 `@binance/derivatives-trading-usds-futures`
- Testnet-only ExecutionVenue adapter
- signed execution request 关闭自动 retry
- MARKET_LOT_SIZE / MIN_NOTIONAL preflight
- aggregate trade + mark/index → canonical Tick
- user-data mapping：`NEW → ORDER_ACK`、`TRADE → FILL`、`CANCELED → CANCEL_ACK`
- 独立 Testnet checkpoint
- 结束时读取 authoritative position/open-orders snapshot 并执行只读 reconciliation

`npm run testnet:market` 当时已经收到真实 Testnet market ticks。

## 5. 当时还不能声称什么

2026-09-27 这轮没有 Testnet API Key，因此当时不能声称 authenticated order closed loop 已经真实观察完成。

能诚实声称的是：真实行情到 Strategy/Risk/Testnet submit 的代码路径已准备；exchange ACK、Fill、本地 Position 与 authoritative account reconciliation 仍需要带凭证环境验证。

后续状态以根 README 和最新代码为准。

### 2026-10-04 更新

`Perp Execution Validation v1.0.0` 的 P0 deterministic paper gate 已通过。随后使用已配置凭证做只读 Testnet preflight：权威状态为 `SHORT 0.001 BTC-PERP @ 83932.5`、open orders 为 0；旧本地 checkpoint 同样记录 `SHORT 0.001`，但仍保留 1 个未决订单。因为状态非 FLAT 且 reconciliation 不能收敛，P1 首次启动被正确阻止。

获得用户明确授权后，guarded recovery 以一张 `BUY 0.001 BTCUSDT MARKET` 将 Testnet 权威仓位收敛至 FLAT，并保留旧 checkpoint 作为 recovery evidence。随后独立 P1 runner 用显式 validation target 完成真实 `FLAT → LONG 0.001 → FLAT`：两张订单均观察到 exchange ACK 与唯一 Fill，合计手续费 `0.06907936 USDT`，本地 realized PnL `-0.10727936 USDT`；最终权威仓位 FLAT、open orders 为 0、reconciliation consistent。

本次短时往返未跨 funding settlement，报告为 `NOT_OBSERVED`。只读历史查询另观察到此前仓位产生的 10 条 BTCUSDT `FUNDING_FEE` 权威流水；这些记录不归因于本次往返。完整证据与 ID 见 [Perp Execution Validation](perp-execution-validation.md)。

## 6. 额外暴露的问题

clean restart 还暴露过 simulator-only identity collision：Simulator 的 `SIM-*` / fill sequence 可能重置，而 processed fill IDs 仍存在 checkpoint。该问题只被记录，没有为了 Testnet 接入扩大修改范围。
