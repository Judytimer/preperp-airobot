# Cancel × Late Fill：语义冻结与 Hummingbot 专项对账

日期：2026-09-23  
范围：只回答 Cancel、OrderUpdate、TradeUpdate 与 reconciliation；不修改状态机，不迁移外部策略。

## 1. 本项目先冻结的判断

> 本地 Cancel 状态不能单独否定一个具有有效 `tradeId` / `fillId` 的交易所成交事实；Cancel 和 Fill 的最终处理必须依据交易所确认、成交事实与 reconciliation。

必须分开的四个时间点：

```text
cancel intent time
≠ cancel acknowledgement time
≠ exchange match time
≠ fill event arrival time
```

上一轮实验只证明了当前实现会在本地 `CANCELED` 后拒绝 delayed Fill；它没有证明该行为符合交易所事实。

## 2. Hummingbot 专项对账

### Q1：在哪里区分 OrderUpdate 和 TradeUpdate？

Binance Perpetual connector 的用户流处理将成交字段构造成 `TradeUpdate`，交给 `ClientOrderTracker.process_trade_update()`；订单状态则独立构造成 `OrderUpdate`，交给 `process_order_update()`。两者不是一个“最终订单状态”对象：

- `TradeUpdate` 携带 `trade_id`、fill timestamp、fill price 和 fill amount，回答“发生了哪笔成交”；
- `OrderUpdate` 携带订单状态及更新时间，回答“交易所如何报告订单生命周期”。

源码入口：

- [Binance Perpetual connector](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/connector/derivative/binance_perpetual/binance_perpetual_derivative.py)
- [ClientOrderTracker](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/connector/client_order_tracker.py)
- [InFlightOrder](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/core/data_type/in_flight_order.py)

对本项目的含义：不能再让一个 `status === CANCELED` 分支同时回答“订单终态”和“这笔 fill 是否真实”。

### Q2：已取消或已终态订单，后到 Fill 为什么还能被处理？

Hummingbot 的关键设计不是“所有 CANCELED 后 Fill 都无条件接受”，而是保留可按 client/exchange order ID 找回的订单与按 `trade_id` 去重的成交记录。终态订单会进入短期缓存，而不是立即失去身份；trade update 因此仍有机会关联订单，并由成交 ID 判断是否已经处理。

这解决的是两个独立问题：

1. **关联性**：terminal order 仍能被 late event 找到；
2. **幂等性**：相同 trade update 不会重复改变累计成交。

它并不意味着本项目现在就应“无条件接受 late Fill”。最小结论只是：

> Fill 是否有效应由成交身份与交易所事实决定，不能只由本地订单终态否决。

真实事故佐证：[Hummingbot issue #7139](https://github.com/hummingbot/hummingbot/issues/7139) 记录了取消进行中订单实际成交、随后 cancel 返回 order not found 的竞态。这说明 cancel request 与 exchange match 可以交错。

### Q3：状态不一致时，谁负责 reconciliation？

职责分为两层：

- Connector 负责从用户流和 REST/order-status/trade 查询取得交易所事实，并把协议字段翻译成 `OrderUpdate` / `TradeUpdate`；
- `ClientOrderTracker` 负责本地订单关联、累计成交、终态缓存、重复成交保护，以及连续 not-found 后的 lost-order 生命周期。

因此 reconciliation 不是 PositionBook 猜测，也不是 Strategy 修正。它位于 connector + order tracker 边界：重新查询订单与成交事实，再驱动本地订单和仓位账本收敛。

## 3. 对本项目的最小必要复杂度

当前不照搬 Hummingbot 的完整状态集合。下一轮设计只评估：

```text
ACKED
PARTIALLY_FILLED
CANCEL_PENDING
CANCELED
FILLED
```

以及一个独立运行状态：

```text
RECONCILIATION_REQUIRED
```

`CANCEL_PENDING` 的价值是表达“已发出取消意图，但交易所尚未确认”；`RECONCILIATION_REQUIRED` 的价值是承认本地状态不足以裁决，而不是把不确定性伪装成 `CANCELED`。

本轮不决定是否一定加入它们，也不写 transition。下一轮仍需为每个状态回答：谁产生、哪个事件确认、是否仍允许 TradeUpdate、何时可从 projected exposure 移除。

## 4. Passivbot 与 Hummingbot 的参考边界

- **Passivbot**：后续 Perp-native 主参考，只研究仓位、挂单、风险和交易所差异；不迁移其 contrarian / market-making 策略。
- **Hummingbot**：本题的专项参考，用于 OrderUpdate / TradeUpdate、in-flight order、connector 与 reconciliation。
- **交易所或协议源码/文档**：后续 Margin、Maintenance Margin、Funding、Liquidation 的最终业务语义参考。

本轮没有因为参考实现而修改 Baseline，也没有引入任何外部策略。

## 5. 下一刀的 Review Gate

在修复 late Fill 前，最小设计必须通过以下问题：

1. Cancel request 与 Cancel ACK 是否是两个事件？
2. `CANCELED` 是本地意图还是交易所确认事实？
3. 一个新 `fillId` 到达 terminal order 时，谁验证其交易所真实性？
4. late Fill 导致 liquidation 后重新出现 exposure 时，是立即再次清算，还是先进入 reconciliation？
5. checkpoint 是否同时保存 cancel phase、processed fill IDs 与 reconciliation reason？

未回答这些问题前，不把当前实验中的 late Fill 改成“总是接受”或“总是拒绝”。

## 6. 证据边界

本仓库此前在 2026-09-19 已对 Hummingbot 官方源码的 `InFlightOrder`、`ClientOrderTracker` 和 Binance connector 做过源码审计，记录在 `docs/stage3-hummingbot-audit.md`。本轮沿用这些源码入口并针对 Cancel × Fill 重新组织结论。

当前执行环境访问 GitHub 时返回 HTTP 403，无法在本轮把 `master` 固定到新的 commit SHA。因此本文只冻结设计判断，不声称已验证 2026-09-23 的最新实现；正式状态机 Patch 前必须重新访问官方仓库并固定 SHA。
