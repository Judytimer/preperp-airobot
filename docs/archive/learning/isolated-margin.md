# Isolated Margin Account Learning Report

## 1. Why A New Module Was Required

原有 `PositionBook` 只回答“成交后持有什么仓位、已实现盈亏是多少”，无法回答永续合约特有的账户问题：当前标记权益、初始保证金、维持保证金以及是否达到强平线。把这些计算塞进 Strategy 或 Position 会混淆业务事实，因此新增纯计算模块 `IsolatedMarginAccount`，原有 Market -> Strategy -> Risk -> Order -> ACK -> Fill -> Position 骨架不变。

## 2. Ownership

- `PositionBook`：已成交仓位、开仓均价、累计已实现 PnL。
- `InFlightOrderTracker`：ACK、部分成交、剩余数量、完成或取消状态。
- `IsolatedMarginAccount`：根据 Position 和 mark price 派生账户快照，不保存订单。
- `PerpBot`：决定事件顺序，执行保证金门槛和 paper liquidation。

## 3. Formulas

```text
unrealizedPnl = signedQty * (markPrice - entryPrice)
equity = collateral + realizedPnl + unrealizedPnl
initialMargin = abs(qty) * entryPrice / leverage
maintenanceMargin = abs(qty) * markPrice * maintenanceMarginRate
availableMargin = equity - initialMargin
liquidatable = position is open AND equity <= maintenanceMargin
```

下单前使用当前 Tick 的 marked equity 与目标仓位 initial margin 比较。这样反向开仓时不会因为忽略原仓位的浮亏而高估可用权益。

## 4. Simulated Liquidation Semantics

触发后 Bot：

1. 将所有本地 `ACKED / PARTIALLY_FILLED` 订单转为 `CANCELED`；
2. 用当前 mark price 创建一笔零额外手续费的 synthetic reduce-only Fill；
3. 将仓位平为 FLAT；
4. 设置 halted，后续 Tick 只更新账户日志，不再运行策略和下单。

迟到 Fill 会由 tracker 拒绝，但底层模拟 Exchange 的 Promise 仍会到达。这是最小 paper execution 语义，不是交易所 cancel ACK 或撮合撤单保证。

## 5. TDD Evidence

- Margin RED：`test/margin.test.ts` 首次运行因 `src/margin.ts` 不存在而得到 `ERR_MODULE_NOT_FOUND`。
- Cancellation RED：`cancelOpenOrders is not a function`。
- Bot RED：保证金不足时旧实现仍产生 1 个 ACK；不利 mark 后仓位仍为 LONG 而非 FLAT。
- GREEN：实现后 focused margin、tracker 和 bot 测试全部通过，再执行全量验证。

## 6. Assumptions / Deferred Decisions

- collateral 固定，不支持充值、提现或多仓位共享余额。
- 只有 isolated margin；没有 cross margin。
- mark price 直接使用模拟 Tick，没有 index price、premium index 或异常价格保护。
- 强平没有 liquidation fee、滑点、破产价、保险基金、ADL 或清算队列。
- 强平后不自动恢复；需要未来显式 reset/reconciliation 机制。
- funding payment、手续费分层和 maker/taker 差异未实现。
- 本轮不接真钱，不连接真实交易所。

下一轮应优先做事件持久化与重启 reconciliation，再考虑真实 connector；否则订单与账户状态在进程重启后无法可靠恢复。
