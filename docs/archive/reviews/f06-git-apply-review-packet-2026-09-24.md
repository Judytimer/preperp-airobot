# F06 Git Apply Review Packet｜Perpetual Client Boundary

> 生成日期：2026-09-24  
> 仓库：`Judytimer/typescript-node-js-signal-ack-fill`  
> 当前分支：`work`  
> Base：`5770dbe`（checkpoint recovery 文档完成）  
> Review commit：`f8c20d0`  
> 用途：下载本文件后，可直接提供给 GPT / 元宝进行独立代码审查。  
> 注意：本文是上下文与补丁审查包，不代表 F06 late-Fill 修复已经实施。

## 1. 给外部 Reviewer 的任务

请只审查以下问题：

1. 当前实现是否混淆了 cancel intent、local order state、exchange Cancel ACK 与 exchange execution fact？
2. `SimulatedExchange` 已排队并最终发出的唯一 Fill，是否应被本地 `CANCELED` 静默拒绝？
3. F06 deterministic trace 中，Order / Position / Bot / reconciliation 的推荐最终状态是否合理？
4. Decision Memo 推荐的“A 为 simulator 账本结论、B 为异常保护、C 为未来 connector contract”是否成立？
5. 在写 Patch 前，还缺少哪些必须明确的 invariant 或 exchange evidence？

请不要建议：

- 修改 Baseline Strategy；
- 让 AI Shadow 获得交易权；
- 引入 Hummingbot / Passivbot 策略；
- 扩展 Funding、Cross Margin、大型回测或 UI；
- 在没有 exchange evidence 时把所有 late Fill 一律接受或一律拒绝。

## 2. 当前事故摘要

```text
Position LONG 0.01
→ SIM-2 SELL 0.02 ACK
→ SIM-2 Fill 仍在延迟
→ mark 暴跌触发 liquidation
→ 本地 tracker 把 SIM-2 写成 CANCELED
→ local liquidation Fill 把 Position 打成 FLAT
→ delayed SIM-2 Fill 到达
→ processFill() 因 status=CANCELED 返回 accepted=false
→ Position 保持 FLAT
```

核心疑问：本地 `CANCELED` 是否有权否定一个由 exchange side 产生、具有唯一 `fillId` 的 execution fact？

## 3. 变更规模

```text
 README.md                                          |   4 +-
 ...ual_Client_Boundary_Decision_Memo_2026-09-24.md | 175 +++++++++++++++++++++
 docs/cancel-fill-reconciliation-audit.md           | 108 +++++++++++++
 docs/liquidation-late-fill-experiment.md           |  42 +++++
 src/bot.ts                                         |  69 +++++---
 src/liquidation.ts                                 |  33 ++++
 src/logging.ts                                     |   8 +-
 src/market.ts                                      |  18 ++-
 src/position.ts                                    |  43 ++++-
 src/risk.ts                                        |   2 +-
 src/state-store.ts                                 |   3 +
 src/strategy.ts                                    |   2 +-
 src/types.ts                                       |  15 +-
 test/bot.test.ts                                   | 155 +++++++++++++++---
 test/liquidation.test.ts                           |  15 ++
 test/market.test.ts                                |  18 +++
 test/position.test.ts                              |  26 +++
 test/risk.test.ts                                  |   3 +-
 18 files changed, 691 insertions(+), 48 deletions(-)
```

## 4. F06 Decision Memo（完整）

# F06 Decision Memo｜PerpBot 收回到“交易所客户端”边界

日期：2026-09-24  
状态：Decision only；本轮不修改生产代码、状态机或测试预期。

## 1. Prediction

在未来接入 Binance Perpetual REST / WebSocket 时，`PerpBot` 应是策略意图与客户端编排者，而不是 execution fact 的制造者：

```text
Strategy / Risk
  -> submit or cancel intent
Exchange client / adapter
  -> authoritative ACK / Cancel ACK / Fill / Liquidation event
OrderTracker
  -> local mirror of exchange order facts
PositionBook
  -> applies accepted authoritative execution facts exactly once
```

F06 的问题不是“怎样消灭 late Fill”，而是“谁有权声明订单已取消、成交已发生、强平已执行”。

## 2. Ownership audit

| 对象 / 行为 | 当前 owner | 理想 owner | 当前是否越界 | 证据与判断 |
| --- | --- | --- | --- | --- |
| Strategy target | `MovingAverageSignal`，由 `PerpBot` 调用 | Strategy | 否 | 策略只产生目标方向，不制造成交事实。 |
| Risk decision | `RiskManager` + `PerpBot` 的 margin gate | Risk / Margin side | 否 | 它决定是否允许 intent，不应决定交易所是否成交。 |
| Submit intent | `PerpBot` | `PerpBot` / execution client | 否 | `PerpBot` 调用 `SimulatedExchange.submit()` 是客户端职责。 |
| Order ACK fact | `SimulatedExchange.submit()` | Exchange adapter | 否 | ACK 由模拟 venue 返回，再由 tracker 镜像。 |
| Cancel request | `PerpBot.liquidate()` 直接调用 `orderTracker.cancelOpenOrders()` | `PerpBot` 发 intent；Exchange adapter 执行 | **是** | 当前没有向 exchange 发 cancel request。 |
| Cancel effective / Cancel ACK | `InFlightOrderTracker.cancelOpenOrders()` 本地直接制造 | Exchange adapter | **是** | 本地 mirror 把意图写成了交易所确认事实。 |
| Fill / Trade fact | `SimulatedExchange` 的 delayed promise | Exchange adapter / user stream | 否 | 该 Fill 是当前模拟 venue 唯一的 execution fact。 |
| Liquidation trigger | `PerpBot` + `IsolatedMarginAccount` | Risk / margin side | 基本否 | Mark 只判断应否强平。 |
| Liquidation execution fact | `PerpBot` 内的 `PaperLiquidationExecutor` | Exchange-side liquidation adapter | **是** | Bot 直接制造 liquidation Fill；这是 paper simplification，不是未来客户端边界。 |
| Local order mirror | `InFlightOrderTracker` | OrderTracker | 否 | 但它只能镜像 exchange fact，不能自行宣布 cancel effective。 |
| Position mutation | `PositionBook.applyFill()` | PositionBook from accepted fills | 否 | PositionBook 应消费 execution fact，不判断 exchange order truth。 |

### 当前最大的 ownership mistake

`PerpBot.liquidate()` 调用 `orderTracker.cancelOpenOrders()`，把“系统想取消在途订单”直接改写成 `CANCELED`。之后 `processFill()` 又仅凭这个本地状态拒绝 Fill。于是客户端本地 mirror 同时扮演：

1. cancel intent producer；
2. exchange Cancel ACK producer；
3. execution fact validator。

这三个职责不能由一个本地状态赋值合并。

## 3. Source of truth

本项目进入真实 Perp client 形态后，事实优先级应是：

1. **Exchange execution fact**：具有唯一 `tradeId` / `fillId` 的成交或强平事件；
2. **Exchange order fact**：ACK、Cancel ACK、Reject、expired 等状态更新；
3. **Local mirror**：OrderTracker 根据上述事件得到的可恢复视图；
4. **Intent**：submit / cancel / liquidation request，本身不是交易所结果。

当前 `SimulatedExchange` 发出的 delayed `Fill` 是实验中最接近 exchange execution fact 的对象。`cancelOpenOrders()` 只改了本地 tracker，既没有调用 exchange cancel，也没有收到 Cancel ACK，因此不能覆盖随后到达的唯一 Fill。

## 4. Invariant

> **Local order state must not silently erase an authoritative execution fact.**

更具体地说：

* 一个新且有效的 exchange-reported `fillId` 不能只因 local status 为 `CANCELED` 而被静默丢弃；
* Cancel intent 不能等同于 Cancel ACK；
* Cancel ACK 也不能反向证明在其 effective time 之前没有发生撮合；
* Event arrival time 不能替代 exchange execution time；
* 证据不足时必须显式进入 reconciliation，而不是猜测 `FLAT`。

## 5. F06 trace：当前状态预测

现有 deterministic trace：

```text
Position LONG 0.01
-> SIM-2 SELL 0.02 ACK
-> SIM-2 Fill delayed
-> mark triggers liquidation
-> local tracker writes SIM-2 CANCELED
-> local liquidation Fill makes Position FLAT
-> delayed SIM-2 Fill arrives
-> tracker returns accepted=false
-> Position incorrectly remains FLAT if the Fill is authoritative
```

当前代码的 observable prediction 是：Order=`CANCELED`、Position=`FLAT`、Bot=`halted`，并且没有 reconciliation reason。这不是经过 exchange evidence 证明的最终状态，只是本地拒绝事件后的结果。

## 6. 三个最小候选方案

### A. 接受 exchange-reported unique Fill

规则：通过来源、订单关联、side/symbol/remaining quantity 与新 `fillId` 验证后，即使 local mirror 为 `CANCELED`，仍将 Fill 作为成交事实记入订单累计与 Position。

F06 结果：

```text
Order: FILLED (SIM-2 executed 0.02)
Position: SHORT 0.02 after the earlier liquidation made it FLAT
Bot: halted + RECONCILIATION_REQUIRED
```

优点：不抹除 execution fact；Position 暴露真实风险。  
风险：如果事件来源并不权威或是伪造/错误映射，可能接受错误 Fill。

### B. UNKNOWN / QUARANTINE Fill

规则：既不改 Position，也不把事件当作无效；持久化 quarantine evidence，并将 Bot 置为 `RECONCILIATION_REQUIRED`，等待 trade history / order query。

优点：证据不足时不猜测。  
风险：真实 exposure 在 reconciliation 完成前仍未进入本地 Position；Risk 必须使用保守 exposure，不能继续认为 `FLAT`。

### C. 用明确的 exchange event-ordering contract 判定

规则：只有 connector 能证明 `executionTime < cancelEffectiveTime` 或相反关系时才裁决；arrival time 不参与事实优先级。

优点：最接近真实 venue 语义。  
风险：当前 simulator 没有 match time、cancel effective time 或 Cancel ACK，现阶段无法执行该判定。

## 7. Recommendation

推荐 **A 为本次 simulator 的账本结论，B 为异常保护，C 为未来 connector contract**：

1. `SimulatedExchange` 已经生成一个新、可关联且尚未处理的 Fill；在当前模型内，它就是 authoritative exchange execution fact；
2. 本地 `CANCELED` 没有对应 exchange cancel request / Cancel ACK，因此不能否定该 Fill；
3. 接受后 Position 必须从 `FLAT` 变为 `SHORT 0.02`，不能隐藏 reopened exposure；
4. 因为 Bot 已完成 liquidation 且处于 halted，late Fill 接受后必须进入 `RECONCILIATION_REQUIRED`，不能恢复策略交易；
5. 若未来 adapter 无法验证 Fill 来源、订单关联或数量，则走 B：quarantine + conservative exposure + reconciliation；
6. Binance connector 可提供 execution time、trade ID 与 Cancel ACK 后，再用 C 细化 transition。

### Recommended state

| Domain | F06 推荐状态 |
| --- | --- |
| Order | `FILLED`, `filledQty=0.02`, `remainingQty=0`; 保留曾发生 cancel intent 的审计信息 |
| Position | `SHORT 0.02`; liquidation 后重新出现的真实 exposure 不得隐藏 |
| Bot state | `halted=true`, `reconciliationRequired=true` |
| Reconciliation | 查询 trade history、order final status、position snapshot；本地状态收敛前禁止策略下单 |

这不是“所有 late Fill 都接受”的通用规则。它依赖本轮 simulator 中 Fill 由 exchange side 产生、ID 唯一且能匹配原订单的证据。

## 8. What would make this recommendation wrong?

以下任一证据成立，都可能推翻方案 A 或要求走 B/C：

1. 交易所 trade history 明确不存在该 `tradeId` / `fillId`，证明事件不是 authoritative execution fact；
2. Fill 的 symbol、side、exchange order ID、数量或账户不匹配，证明关联错误；
3. 交易所协议保证 Cancel ACK 的 effective time 早于该事件的 execution time，且该状态下不可能再发生合法成交；
4. WebSocket 事件只是非最终预览，必须由 REST trade query 确认后才能记账；
5. 本地已经处理同一 `tradeId`，该消息只是 replay；
6. Liquidation engine 已在交易所侧将该订单排除或替换，且 connector 能提供可验证的最终快照。

## 9. 下一轮 Patch gate

进入 Patch 前仍需明确：

* `CANCEL_REQUESTED` 与 exchange-confirmed `CANCELED` 的 transition owner；
* simulator 是否增加 cancel request / Cancel ACK，而不是 tracker 自行 cancel；
* accepted late Fill 如何触发 `RECONCILIATION_REQUIRED`；
* projected exposure 在 quarantine 时如何保守计算；
* checkpoint 如何保存 cancel intent、exchange status、quarantined event 与 reconciliation reason；
* liquidation 后 reopened exposure 是立即二次 liquidation，还是先等待 exchange position snapshot。

这些问题未形成一个最小 deterministic patch 前，不修改 `processFill()` 的当前行为。

## 10. Stop condition

本轮到此停止：

- 已完成 Decision Memo；
- 已完成 current / ideal ownership audit；
- 已指出 client boundary 的实际越界点；
- 已给出 A/B/C、推荐状态与反证条件；
- 未修改 Baseline、AI、Funding、Margin、订单状态机或 late-Fill 行为。

---

## 5. Cancel × Fill Reconciliation Audit（完整）

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

---

## 6. Liquidation × Late Fill Experiment（完整）

# Liquidation × Late Fill：复现实验

## Scope

本轮只复现事故，不修改订单或持仓处理规则。

## Deterministic event order

```text
SIM-1 BUY fill
→ Position LONG 0.01
→ SIM-2 reversal SELL 0.02 ACK
→ SIM-2 fill remains delayed
→ mark falls to liquidation threshold
→ SIM-2 locally becomes CANCELED
→ liquidation fill closes LONG
→ Position FLAT
→ delayed SIM-2 fill arrives
→ InFlightOrderTracker returns accepted=false because status=CANCELED
→ Position remains FLAT
```

覆盖该交错的测试是 `documents current cancel-then-late-fill behavior after liquidation`。

## Observed ownership and state

| Moment | SIM-2 order state | Position |
| --- | --- | --- |
| reversal ACK | `ACKED` | `LONG 0.01` |
| local liquidation cancel | `CANCELED` | `LONG 0.01` |
| liquidation fill | `CANCELED` | `FLAT` |
| delayed exchange fill | `CANCELED` | `FLAT` |

`SimulatedExchange` 已经创建并排队的 Fill promise 不会因本地 `cancelOpenOrders()` 而消失。Fill 仍会到达 Bot；当前 `InFlightOrderTracker.processFill()` 因订单已是 `CANCELED` 而返回 `accepted=false`，所以该 Fill 不进入 `PositionBook`。

## Broken invariant / unresolved semantic

> 本地 `CANCELED` 状态不能证明交易所侧没有发生成交。

当前实现把本地取消状态当成拒绝后续 Fill 的充分条件。如果这个 late Fill 代表交易所已经发生且随后才送达的成交事实，系统会漏记真实 exposure，并错误地保持 `FLAT`。

本实验不决定 late Fill 应被接受还是拒绝。下一步必须先明确 Cancel ACK、撮合时间与事件到达时间的语义，再决定状态机和 reconciliation 规则。

---

## 7. 可直接 `git apply` 的完整 Patch

下面是 `5770dbe..f8c20d0` 的精确 unified diff。若需要复现，可将代码块内容另存为 `.patch` 后执行 `git apply --check <file>.patch`；本项目当前不要求 Reviewer 实际应用它。

```diff
diff --git a/README.md b/README.md
index f2dc0c4b7f22142ef5428775941a742afa4b52c8..0c7893c6bc28d2f6ac52282fe83c07676f6419eb 100644
--- a/README.md
+++ b/README.md
@@ -18,10 +18,12 @@ simulateMarket
 
 订单生命周期由 `InFlightOrderTracker` 持有：`ACKED -> PARTIALLY_FILLED -> FILLED`。发生 Partial Fill 后，预计仓位使用已成交 Position 加订单 `remainingQty`，不会把整张原始订单重复计入，也不会过早移除 Pending。
 
-第二轮加入了最小逐仓保证金账户。每个 Tick 都作为 mark price 更新 `equity / unrealizedPnl / initialMargin / maintenanceMargin / availableMargin`；下单前检查目标仓位初始保证金，`equity <= maintenanceMargin` 时模拟强平、取消本地在途订单并停止策略继续下单。它仍然只是 paper model，不代表真实交易所清算流程。
+第二轮加入了最小逐仓保证金账户。行情明确区分 `lastPrice / markPrice / indexPrice`：Baseline 双均线和模拟订单价格只使用 last，逐仓账户、未实现盈亏与强平触发只使用 mark，index 目前仅代表外部参考输入；本模拟器没有实现交易所级 mark-price 推导。强平触发与执行已分开建模，但当前 paper simplification 仍假设 `liquidation execution price = mark price`，日志会同时记录 trigger mark 与 execution price。下单前检查目标仓位初始保证金，`equity <= maintenanceMargin` 时模拟强平、取消本地在途订单并停止策略继续下单。它仍然只是 paper model，不代表真实交易所清算流程。
 
 第三轮加入版本化 checkpoint。ACK、有效 Fill 和模拟强平后会原子写入 `.runtime/perp-bot-state.json`，保存仓位、Fill 幂等集合、订单状态和下一模拟订单编号。正常完成的状态可恢复；如果重启时仍有 unresolved order，机器人进入 `RECOVERY_REQUIRED` 并停止下单，不猜测该订单最终是否成交。
 
+Funding 作为独立结算事件输入：事件携带 `fundingId / rate / markPrice / ts`，正费率下多仓支付、空仓收取，负费率方向相反。Funding 修改 realized equity，但无权覆盖最新 market mark；`fundingId` 会进入 checkpoint，以保证重启后的重复结算仍然幂等。当前不包含 funding alpha 或交易所费率预测。
+
 ## 运行
 
 ```bash
diff --git a/docs/F06_Perpetual_Client_Boundary_Decision_Memo_2026-09-24.md b/docs/F06_Perpetual_Client_Boundary_Decision_Memo_2026-09-24.md
new file mode 100644
index 0000000000000000000000000000000000000000..8ab0bc5b940514a0493bfe244a4e33678748c8dc
--- /dev/null
+++ b/docs/F06_Perpetual_Client_Boundary_Decision_Memo_2026-09-24.md
@@ -0,0 +1,175 @@
+# F06 Decision Memo｜PerpBot 收回到“交易所客户端”边界
+
+日期：2026-09-24  
+状态：Decision only；本轮不修改生产代码、状态机或测试预期。
+
+## 1. Prediction
+
+在未来接入 Binance Perpetual REST / WebSocket 时，`PerpBot` 应是策略意图与客户端编排者，而不是 execution fact 的制造者：
+
+```text
+Strategy / Risk
+  -> submit or cancel intent
+Exchange client / adapter
+  -> authoritative ACK / Cancel ACK / Fill / Liquidation event
+OrderTracker
+  -> local mirror of exchange order facts
+PositionBook
+  -> applies accepted authoritative execution facts exactly once
+```
+
+F06 的问题不是“怎样消灭 late Fill”，而是“谁有权声明订单已取消、成交已发生、强平已执行”。
+
+## 2. Ownership audit
+
+| 对象 / 行为 | 当前 owner | 理想 owner | 当前是否越界 | 证据与判断 |
+| --- | --- | --- | --- | --- |
+| Strategy target | `MovingAverageSignal`，由 `PerpBot` 调用 | Strategy | 否 | 策略只产生目标方向，不制造成交事实。 |
+| Risk decision | `RiskManager` + `PerpBot` 的 margin gate | Risk / Margin side | 否 | 它决定是否允许 intent，不应决定交易所是否成交。 |
+| Submit intent | `PerpBot` | `PerpBot` / execution client | 否 | `PerpBot` 调用 `SimulatedExchange.submit()` 是客户端职责。 |
+| Order ACK fact | `SimulatedExchange.submit()` | Exchange adapter | 否 | ACK 由模拟 venue 返回，再由 tracker 镜像。 |
+| Cancel request | `PerpBot.liquidate()` 直接调用 `orderTracker.cancelOpenOrders()` | `PerpBot` 发 intent；Exchange adapter 执行 | **是** | 当前没有向 exchange 发 cancel request。 |
+| Cancel effective / Cancel ACK | `InFlightOrderTracker.cancelOpenOrders()` 本地直接制造 | Exchange adapter | **是** | 本地 mirror 把意图写成了交易所确认事实。 |
+| Fill / Trade fact | `SimulatedExchange` 的 delayed promise | Exchange adapter / user stream | 否 | 该 Fill 是当前模拟 venue 唯一的 execution fact。 |
+| Liquidation trigger | `PerpBot` + `IsolatedMarginAccount` | Risk / margin side | 基本否 | Mark 只判断应否强平。 |
+| Liquidation execution fact | `PerpBot` 内的 `PaperLiquidationExecutor` | Exchange-side liquidation adapter | **是** | Bot 直接制造 liquidation Fill；这是 paper simplification，不是未来客户端边界。 |
+| Local order mirror | `InFlightOrderTracker` | OrderTracker | 否 | 但它只能镜像 exchange fact，不能自行宣布 cancel effective。 |
+| Position mutation | `PositionBook.applyFill()` | PositionBook from accepted fills | 否 | PositionBook 应消费 execution fact，不判断 exchange order truth。 |
+
+### 当前最大的 ownership mistake
+
+`PerpBot.liquidate()` 调用 `orderTracker.cancelOpenOrders()`，把“系统想取消在途订单”直接改写成 `CANCELED`。之后 `processFill()` 又仅凭这个本地状态拒绝 Fill。于是客户端本地 mirror 同时扮演：
+
+1. cancel intent producer；
+2. exchange Cancel ACK producer；
+3. execution fact validator。
+
+这三个职责不能由一个本地状态赋值合并。
+
+## 3. Source of truth
+
+本项目进入真实 Perp client 形态后，事实优先级应是：
+
+1. **Exchange execution fact**：具有唯一 `tradeId` / `fillId` 的成交或强平事件；
+2. **Exchange order fact**：ACK、Cancel ACK、Reject、expired 等状态更新；
+3. **Local mirror**：OrderTracker 根据上述事件得到的可恢复视图；
+4. **Intent**：submit / cancel / liquidation request，本身不是交易所结果。
+
+当前 `SimulatedExchange` 发出的 delayed `Fill` 是实验中最接近 exchange execution fact 的对象。`cancelOpenOrders()` 只改了本地 tracker，既没有调用 exchange cancel，也没有收到 Cancel ACK，因此不能覆盖随后到达的唯一 Fill。
+
+## 4. Invariant
+
+> **Local order state must not silently erase an authoritative execution fact.**
+
+更具体地说：
+
+* 一个新且有效的 exchange-reported `fillId` 不能只因 local status 为 `CANCELED` 而被静默丢弃；
+* Cancel intent 不能等同于 Cancel ACK；
+* Cancel ACK 也不能反向证明在其 effective time 之前没有发生撮合；
+* Event arrival time 不能替代 exchange execution time；
+* 证据不足时必须显式进入 reconciliation，而不是猜测 `FLAT`。
+
+## 5. F06 trace：当前状态预测
+
+现有 deterministic trace：
+
+```text
+Position LONG 0.01
+-> SIM-2 SELL 0.02 ACK
+-> SIM-2 Fill delayed
+-> mark triggers liquidation
+-> local tracker writes SIM-2 CANCELED
+-> local liquidation Fill makes Position FLAT
+-> delayed SIM-2 Fill arrives
+-> tracker returns accepted=false
+-> Position incorrectly remains FLAT if the Fill is authoritative
+```
+
+当前代码的 observable prediction 是：Order=`CANCELED`、Position=`FLAT`、Bot=`halted`，并且没有 reconciliation reason。这不是经过 exchange evidence 证明的最终状态，只是本地拒绝事件后的结果。
+
+## 6. 三个最小候选方案
+
+### A. 接受 exchange-reported unique Fill
+
+规则：通过来源、订单关联、side/symbol/remaining quantity 与新 `fillId` 验证后，即使 local mirror 为 `CANCELED`，仍将 Fill 作为成交事实记入订单累计与 Position。
+
+F06 结果：
+
+```text
+Order: FILLED (SIM-2 executed 0.02)
+Position: SHORT 0.02 after the earlier liquidation made it FLAT
+Bot: halted + RECONCILIATION_REQUIRED
+```
+
+优点：不抹除 execution fact；Position 暴露真实风险。  
+风险：如果事件来源并不权威或是伪造/错误映射，可能接受错误 Fill。
+
+### B. UNKNOWN / QUARANTINE Fill
+
+规则：既不改 Position，也不把事件当作无效；持久化 quarantine evidence，并将 Bot 置为 `RECONCILIATION_REQUIRED`，等待 trade history / order query。
+
+优点：证据不足时不猜测。  
+风险：真实 exposure 在 reconciliation 完成前仍未进入本地 Position；Risk 必须使用保守 exposure，不能继续认为 `FLAT`。
+
+### C. 用明确的 exchange event-ordering contract 判定
+
+规则：只有 connector 能证明 `executionTime < cancelEffectiveTime` 或相反关系时才裁决；arrival time 不参与事实优先级。
+
+优点：最接近真实 venue 语义。  
+风险：当前 simulator 没有 match time、cancel effective time 或 Cancel ACK，现阶段无法执行该判定。
+
+## 7. Recommendation
+
+推荐 **A 为本次 simulator 的账本结论，B 为异常保护，C 为未来 connector contract**：
+
+1. `SimulatedExchange` 已经生成一个新、可关联且尚未处理的 Fill；在当前模型内，它就是 authoritative exchange execution fact；
+2. 本地 `CANCELED` 没有对应 exchange cancel request / Cancel ACK，因此不能否定该 Fill；
+3. 接受后 Position 必须从 `FLAT` 变为 `SHORT 0.02`，不能隐藏 reopened exposure；
+4. 因为 Bot 已完成 liquidation 且处于 halted，late Fill 接受后必须进入 `RECONCILIATION_REQUIRED`，不能恢复策略交易；
+5. 若未来 adapter 无法验证 Fill 来源、订单关联或数量，则走 B：quarantine + conservative exposure + reconciliation；
+6. Binance connector 可提供 execution time、trade ID 与 Cancel ACK 后，再用 C 细化 transition。
+
+### Recommended state
+
+| Domain | F06 推荐状态 |
+| --- | --- |
+| Order | `FILLED`, `filledQty=0.02`, `remainingQty=0`; 保留曾发生 cancel intent 的审计信息 |
+| Position | `SHORT 0.02`; liquidation 后重新出现的真实 exposure 不得隐藏 |
+| Bot state | `halted=true`, `reconciliationRequired=true` |
+| Reconciliation | 查询 trade history、order final status、position snapshot；本地状态收敛前禁止策略下单 |
+
+这不是“所有 late Fill 都接受”的通用规则。它依赖本轮 simulator 中 Fill 由 exchange side 产生、ID 唯一且能匹配原订单的证据。
+
+## 8. What would make this recommendation wrong?
+
+以下任一证据成立，都可能推翻方案 A 或要求走 B/C：
+
+1. 交易所 trade history 明确不存在该 `tradeId` / `fillId`，证明事件不是 authoritative execution fact；
+2. Fill 的 symbol、side、exchange order ID、数量或账户不匹配，证明关联错误；
+3. 交易所协议保证 Cancel ACK 的 effective time 早于该事件的 execution time，且该状态下不可能再发生合法成交；
+4. WebSocket 事件只是非最终预览，必须由 REST trade query 确认后才能记账；
+5. 本地已经处理同一 `tradeId`，该消息只是 replay；
+6. Liquidation engine 已在交易所侧将该订单排除或替换，且 connector 能提供可验证的最终快照。
+
+## 9. 下一轮 Patch gate
+
+进入 Patch 前仍需明确：
+
+* `CANCEL_REQUESTED` 与 exchange-confirmed `CANCELED` 的 transition owner；
+* simulator 是否增加 cancel request / Cancel ACK，而不是 tracker 自行 cancel；
+* accepted late Fill 如何触发 `RECONCILIATION_REQUIRED`；
+* projected exposure 在 quarantine 时如何保守计算；
+* checkpoint 如何保存 cancel intent、exchange status、quarantined event 与 reconciliation reason；
+* liquidation 后 reopened exposure 是立即二次 liquidation，还是先等待 exchange position snapshot。
+
+这些问题未形成一个最小 deterministic patch 前，不修改 `processFill()` 的当前行为。
+
+## 10. Stop condition
+
+本轮到此停止：
+
+- 已完成 Decision Memo；
+- 已完成 current / ideal ownership audit；
+- 已指出 client boundary 的实际越界点；
+- 已给出 A/B/C、推荐状态与反证条件；
+- 未修改 Baseline、AI、Funding、Margin、订单状态机或 late-Fill 行为。
diff --git a/docs/cancel-fill-reconciliation-audit.md b/docs/cancel-fill-reconciliation-audit.md
new file mode 100644
index 0000000000000000000000000000000000000000..dbba8accf6bf5cf2989b49156cd93b40ba2ab6b9
--- /dev/null
+++ b/docs/cancel-fill-reconciliation-audit.md
@@ -0,0 +1,108 @@
+# Cancel × Late Fill：语义冻结与 Hummingbot 专项对账
+
+日期：2026-09-23  
+范围：只回答 Cancel、OrderUpdate、TradeUpdate 与 reconciliation；不修改状态机，不迁移外部策略。
+
+## 1. 本项目先冻结的判断
+
+> 本地 Cancel 状态不能单独否定一个具有有效 `tradeId` / `fillId` 的交易所成交事实；Cancel 和 Fill 的最终处理必须依据交易所确认、成交事实与 reconciliation。
+
+必须分开的四个时间点：
+
+```text
+cancel intent time
+≠ cancel acknowledgement time
+≠ exchange match time
+≠ fill event arrival time
+```
+
+上一轮实验只证明了当前实现会在本地 `CANCELED` 后拒绝 delayed Fill；它没有证明该行为符合交易所事实。
+
+## 2. Hummingbot 专项对账
+
+### Q1：在哪里区分 OrderUpdate 和 TradeUpdate？
+
+Binance Perpetual connector 的用户流处理将成交字段构造成 `TradeUpdate`，交给 `ClientOrderTracker.process_trade_update()`；订单状态则独立构造成 `OrderUpdate`，交给 `process_order_update()`。两者不是一个“最终订单状态”对象：
+
+- `TradeUpdate` 携带 `trade_id`、fill timestamp、fill price 和 fill amount，回答“发生了哪笔成交”；
+- `OrderUpdate` 携带订单状态及更新时间，回答“交易所如何报告订单生命周期”。
+
+源码入口：
+
+- [Binance Perpetual connector](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/connector/derivative/binance_perpetual/binance_perpetual_derivative.py)
+- [ClientOrderTracker](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/connector/client_order_tracker.py)
+- [InFlightOrder](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/core/data_type/in_flight_order.py)
+
+对本项目的含义：不能再让一个 `status === CANCELED` 分支同时回答“订单终态”和“这笔 fill 是否真实”。
+
+### Q2：已取消或已终态订单，后到 Fill 为什么还能被处理？
+
+Hummingbot 的关键设计不是“所有 CANCELED 后 Fill 都无条件接受”，而是保留可按 client/exchange order ID 找回的订单与按 `trade_id` 去重的成交记录。终态订单会进入短期缓存，而不是立即失去身份；trade update 因此仍有机会关联订单，并由成交 ID 判断是否已经处理。
+
+这解决的是两个独立问题：
+
+1. **关联性**：terminal order 仍能被 late event 找到；
+2. **幂等性**：相同 trade update 不会重复改变累计成交。
+
+它并不意味着本项目现在就应“无条件接受 late Fill”。最小结论只是：
+
+> Fill 是否有效应由成交身份与交易所事实决定，不能只由本地订单终态否决。
+
+真实事故佐证：[Hummingbot issue #7139](https://github.com/hummingbot/hummingbot/issues/7139) 记录了取消进行中订单实际成交、随后 cancel 返回 order not found 的竞态。这说明 cancel request 与 exchange match 可以交错。
+
+### Q3：状态不一致时，谁负责 reconciliation？
+
+职责分为两层：
+
+- Connector 负责从用户流和 REST/order-status/trade 查询取得交易所事实，并把协议字段翻译成 `OrderUpdate` / `TradeUpdate`；
+- `ClientOrderTracker` 负责本地订单关联、累计成交、终态缓存、重复成交保护，以及连续 not-found 后的 lost-order 生命周期。
+
+因此 reconciliation 不是 PositionBook 猜测，也不是 Strategy 修正。它位于 connector + order tracker 边界：重新查询订单与成交事实，再驱动本地订单和仓位账本收敛。
+
+## 3. 对本项目的最小必要复杂度
+
+当前不照搬 Hummingbot 的完整状态集合。下一轮设计只评估：
+
+```text
+ACKED
+PARTIALLY_FILLED
+CANCEL_PENDING
+CANCELED
+FILLED
+```
+
+以及一个独立运行状态：
+
+```text
+RECONCILIATION_REQUIRED
+```
+
+`CANCEL_PENDING` 的价值是表达“已发出取消意图，但交易所尚未确认”；`RECONCILIATION_REQUIRED` 的价值是承认本地状态不足以裁决，而不是把不确定性伪装成 `CANCELED`。
+
+本轮不决定是否一定加入它们，也不写 transition。下一轮仍需为每个状态回答：谁产生、哪个事件确认、是否仍允许 TradeUpdate、何时可从 projected exposure 移除。
+
+## 4. Passivbot 与 Hummingbot 的参考边界
+
+- **Passivbot**：后续 Perp-native 主参考，只研究仓位、挂单、风险和交易所差异；不迁移其 contrarian / market-making 策略。
+- **Hummingbot**：本题的专项参考，用于 OrderUpdate / TradeUpdate、in-flight order、connector 与 reconciliation。
+- **交易所或协议源码/文档**：后续 Margin、Maintenance Margin、Funding、Liquidation 的最终业务语义参考。
+
+本轮没有因为参考实现而修改 Baseline，也没有引入任何外部策略。
+
+## 5. 下一刀的 Review Gate
+
+在修复 late Fill 前，最小设计必须通过以下问题：
+
+1. Cancel request 与 Cancel ACK 是否是两个事件？
+2. `CANCELED` 是本地意图还是交易所确认事实？
+3. 一个新 `fillId` 到达 terminal order 时，谁验证其交易所真实性？
+4. late Fill 导致 liquidation 后重新出现 exposure 时，是立即再次清算，还是先进入 reconciliation？
+5. checkpoint 是否同时保存 cancel phase、processed fill IDs 与 reconciliation reason？
+
+未回答这些问题前，不把当前实验中的 late Fill 改成“总是接受”或“总是拒绝”。
+
+## 6. 证据边界
+
+本仓库此前在 2026-09-19 已对 Hummingbot 官方源码的 `InFlightOrder`、`ClientOrderTracker` 和 Binance connector 做过源码审计，记录在 `docs/stage3-hummingbot-audit.md`。本轮沿用这些源码入口并针对 Cancel × Fill 重新组织结论。
+
+当前执行环境访问 GitHub 时返回 HTTP 403，无法在本轮把 `master` 固定到新的 commit SHA。因此本文只冻结设计判断，不声称已验证 2026-09-23 的最新实现；正式状态机 Patch 前必须重新访问官方仓库并固定 SHA。
diff --git a/docs/liquidation-late-fill-experiment.md b/docs/liquidation-late-fill-experiment.md
new file mode 100644
index 0000000000000000000000000000000000000000..3925401fa5bf05657ab3519075bed50ddf65241e
--- /dev/null
+++ b/docs/liquidation-late-fill-experiment.md
@@ -0,0 +1,42 @@
+# Liquidation × Late Fill：复现实验
+
+## Scope
+
+本轮只复现事故，不修改订单或持仓处理规则。
+
+## Deterministic event order
+
+```text
+SIM-1 BUY fill
+→ Position LONG 0.01
+→ SIM-2 reversal SELL 0.02 ACK
+→ SIM-2 fill remains delayed
+→ mark falls to liquidation threshold
+→ SIM-2 locally becomes CANCELED
+→ liquidation fill closes LONG
+→ Position FLAT
+→ delayed SIM-2 fill arrives
+→ InFlightOrderTracker returns accepted=false because status=CANCELED
+→ Position remains FLAT
+```
+
+覆盖该交错的测试是 `documents current cancel-then-late-fill behavior after liquidation`。
+
+## Observed ownership and state
+
+| Moment | SIM-2 order state | Position |
+| --- | --- | --- |
+| reversal ACK | `ACKED` | `LONG 0.01` |
+| local liquidation cancel | `CANCELED` | `LONG 0.01` |
+| liquidation fill | `CANCELED` | `FLAT` |
+| delayed exchange fill | `CANCELED` | `FLAT` |
+
+`SimulatedExchange` 已经创建并排队的 Fill promise 不会因本地 `cancelOpenOrders()` 而消失。Fill 仍会到达 Bot；当前 `InFlightOrderTracker.processFill()` 因订单已是 `CANCELED` 而返回 `accepted=false`，所以该 Fill 不进入 `PositionBook`。
+
+## Broken invariant / unresolved semantic
+
+> 本地 `CANCELED` 状态不能证明交易所侧没有发生成交。
+
+当前实现把本地取消状态当成拒绝后续 Fill 的充分条件。如果这个 late Fill 代表交易所已经发生且随后才送达的成交事实，系统会漏记真实 exposure，并错误地保持 `FLAT`。
+
+本实验不决定 late Fill 应被接受还是拒绝。下一步必须先明确 Cancel ACK、撮合时间与事件到达时间的语义，再决定状态机和 reconciliation 规则。
diff --git a/src/bot.ts b/src/bot.ts
index d393ee29ff87a173d2f443456f3608b9ef40c76a..8802f4eed715f1817bf83dab167971683c75f94d 100644
--- a/src/bot.ts
+++ b/src/bot.ts
@@ -4,6 +4,7 @@ import {
   formatAck,
   formatAccount,
   formatFill,
+  formatFunding,
   formatOrderState,
   formatPosition,
   formatRisk,
@@ -18,8 +19,9 @@ import { MovingAverageSignal } from "./strategy.ts";
 import { round } from "./math.ts";
 import { IsolatedMarginAccount } from "./margin.ts";
 import type { MarginConfig, MarginSnapshot } from "./margin.ts";
-import type { Logger, OrderRequest, Position, PositionSide, Tick } from "./types.ts";
+import type { FundingSettlement, Logger, OrderRequest, Position, PositionSide, Tick } from "./types.ts";
 import type { BotCheckpoint, BotStateStore } from "./state-store.ts";
+import { PaperLiquidationExecutor } from "./liquidation.ts";
 
 export type BotConfig = {
   symbol: string;
@@ -43,7 +45,9 @@ export class PerpBot {
   private readonly pendingFills: Promise<void>[] = [];
   private orderTracker = new InFlightOrderTracker();
   private readonly margin: IsolatedMarginAccount;
+  private readonly liquidationExecutor = new PaperLiquidationExecutor();
   private lastAccountSnapshot: MarginSnapshot | null = null;
+  private lastMarkPrice: number | null = null;
   private halted = false;
   private recoveryRequired = false;
   private readonly stateStore?: BotStateStore;
@@ -71,10 +75,12 @@ export class PerpBot {
   }
 
   async onTick(tick: Tick): Promise<void> {
+    validateTickPrices(tick);
     this.logger(formatTick(tick));
 
     const markedPosition = this.positions.get();
-    this.lastAccountSnapshot = this.margin.snapshot(markedPosition, tick.price);
+    this.lastMarkPrice = tick.markPrice;
+    this.lastAccountSnapshot = this.margin.snapshot(markedPosition, tick.markPrice);
     this.logger(formatAccount(this.lastAccountSnapshot));
 
     if (this.recoveryRequired) {
@@ -111,7 +117,7 @@ export class PerpBot {
     }
 
     const postOrderPosition = projectOrder(projectedPosition, decision.order);
-    const postOrderAccount = this.margin.snapshot(postOrderPosition, tick.price);
+    const postOrderAccount = this.margin.snapshot(postOrderPosition, tick.markPrice);
     if (postOrderAccount.initialMargin > this.lastAccountSnapshot.equity) {
       this.logger(
         `[MARGIN_RISK] blocked requiredInitialMargin=${postOrderAccount.initialMargin} equity=${this.lastAccountSnapshot.equity}`
@@ -137,7 +143,8 @@ export class PerpBot {
         }
         const position = this.positions.applyFill(fill);
         this.logger(formatPosition(position));
-        this.lastAccountSnapshot = this.margin.snapshot(position, fill.price);
+        // A trade fill changes the position, but it does not own the market mark.
+        this.lastAccountSnapshot = this.margin.snapshot(position, this.requireLatestMarkPrice());
         this.logger(formatAccount(this.lastAccountSnapshot));
         await this.persist();
       })
@@ -151,6 +158,22 @@ export class PerpBot {
     await this.persistTail;
   }
 
+  async onFunding(settlement: FundingSettlement): Promise<void> {
+    const latestMarkPrice = this.requireLatestMarkPrice();
+    const result = this.positions.applyFunding(settlement);
+    if (!result.accepted) {
+      this.logger(`[FUNDING] fundingId=${settlement.fundingId} ignored=duplicate`);
+      return;
+    }
+
+    this.logger(formatFunding(settlement, result.payment));
+    // Funding changes realized equity, but a funding event does not own the live market mark.
+    this.lastAccountSnapshot = this.margin.snapshot(result.position, latestMarkPrice);
+    this.logger(formatPosition(result.position));
+    this.logger(formatAccount(this.lastAccountSnapshot));
+    await this.persist();
+  }
+
   getPosition(): Position {
     return this.positions.get();
   }
@@ -168,28 +191,25 @@ export class PerpBot {
       this.logger(formatOrderState(canceled));
     }
 
-    const side = position.side === "LONG" ? "SELL" : "BUY";
-    const fill = {
-      fillId: `LIQ-${tick.seq}-FILL-1`,
-      orderId: `LIQ-${tick.seq}`,
-      symbol: position.symbol,
-      side,
-      qty: position.qty,
-      price: tick.price,
-      fee: 0,
-      ts: tick.ts
-    } as const;
+    const execution = this.liquidationExecutor.execute(position, tick);
     this.logger(
-      `[LIQUIDATION] side=${side} qty=${position.qty} mark=${tick.price} equity=${snapshot.equity} maintenanceMargin=${snapshot.maintenanceMargin}`
+      `[LIQUIDATION] side=${execution.fill.side} qty=${position.qty} triggerMark=${execution.triggerMarkPrice} executionPrice=${execution.executionPrice} assumption=EXECUTION_AT_MARK equity=${snapshot.equity} maintenanceMargin=${snapshot.maintenanceMargin}`
     );
-    const closedPosition = this.positions.applyFill(fill);
+    const closedPosition = this.positions.applyFill(execution.fill);
     this.logger(formatPosition(closedPosition));
-    this.lastAccountSnapshot = this.margin.snapshot(closedPosition, tick.price);
+    this.lastAccountSnapshot = this.margin.snapshot(closedPosition, tick.markPrice);
     this.logger(formatAccount(this.lastAccountSnapshot));
     this.halted = true;
     await this.persist();
   }
 
+  private requireLatestMarkPrice(): number {
+    if (this.lastMarkPrice === null) {
+      throw new Error("invariant violation: cannot value a fill without a latest mark price");
+    }
+    return this.lastMarkPrice;
+  }
+
   private async restore(): Promise<void> {
     if (this.stateStore === undefined) {
       return;
@@ -210,6 +230,7 @@ export class PerpBot {
     this.halted = checkpoint.halted;
     this.recoveryRequired = this.orderTracker.getOpenOrders().length > 0;
     if (checkpoint.lastMarkPrice !== null) {
+      this.lastMarkPrice = checkpoint.lastMarkPrice;
       this.lastAccountSnapshot = this.margin.snapshot(this.positions.get(), checkpoint.lastMarkPrice);
     }
     this.logger(
@@ -238,6 +259,18 @@ export class PerpBot {
   }
 }
 
+function validateTickPrices(tick: Tick): void {
+  for (const [name, price] of [
+    ["lastPrice", tick.lastPrice],
+    ["markPrice", tick.markPrice],
+    ["indexPrice", tick.indexPrice]
+  ] as const) {
+    if (!Number.isFinite(price) || price <= 0) {
+      throw new Error(`${name} must be positive`);
+    }
+  }
+}
+
 function projectPosition(position: Position, pendingOrders: Iterable<InFlightOrder>): Position {
   let projectedQty = signedQty(position);
 
diff --git a/src/liquidation.ts b/src/liquidation.ts
new file mode 100644
index 0000000000000000000000000000000000000000..5c0c1f1bdd1949c1f6e50c4dd6798ca6fcbaaa3e
--- /dev/null
+++ b/src/liquidation.ts
@@ -0,0 +1,33 @@
+import type { Fill, Position, Tick } from "./types.ts";
+
+export type LiquidationExecution = {
+  triggerMarkPrice: number;
+  executionPrice: number;
+  fill: Fill;
+};
+
+/**
+ * Minimal paper executor boundary. The mark decides whether liquidation is
+ * required; this component owns the resulting execution fact.
+ *
+ * Paper simplification: liquidation execution is currently assumed at mark.
+ * A venue adapter may later model slippage without changing trigger semantics.
+ */
+export class PaperLiquidationExecutor {
+  execute(position: Position, tick: Tick): LiquidationExecution {
+    const executionPrice = tick.markPrice;
+    const side = position.side === "LONG" ? "SELL" : "BUY";
+    const fill: Fill = {
+      fillId: `LIQ-${tick.seq}-FILL-1`,
+      orderId: `LIQ-${tick.seq}`,
+      symbol: position.symbol,
+      side,
+      qty: position.qty,
+      price: executionPrice,
+      fee: 0,
+      ts: tick.ts
+    };
+
+    return { triggerMarkPrice: tick.markPrice, executionPrice, fill };
+  }
+}
diff --git a/src/logging.ts b/src/logging.ts
index 66c894950545be02994b662470ce70b776595e87..36c5038adb8da966b13fa3379a7ac81124274952 100644
--- a/src/logging.ts
+++ b/src/logging.ts
@@ -1,9 +1,9 @@
-import type { Fill, OrderAck, Position, RiskDecision, Signal, Tick } from "./types.ts";
+import type { Fill, FundingSettlement, OrderAck, Position, RiskDecision, Signal, Tick } from "./types.ts";
 import type { InFlightOrder } from "./order-tracker.ts";
 import type { MarginSnapshot } from "./margin.ts";
 
 export function formatTick(tick: Tick): string {
-  return `[TICK] seq=${tick.seq} symbol=${tick.symbol} price=${tick.price}`;
+  return `[TICK] seq=${tick.seq} symbol=${tick.symbol} last=${tick.lastPrice} mark=${tick.markPrice} index=${tick.indexPrice}`;
 }
 
 export function formatSignal(signal: Signal): string {
@@ -30,6 +30,10 @@ export function formatFill(fill: Fill): string {
   )}`;
 }
 
+export function formatFunding(settlement: FundingSettlement, payment: number): string {
+  return `[FUNDING] fundingId=${settlement.fundingId} rate=${settlement.rate} settlementMark=${settlement.markPrice} payment=${payment} ts=${settlement.ts}`;
+}
+
 export function formatOrderState(order: InFlightOrder): string {
   return `[ORDER] orderId=${order.orderId} status=${order.status} filled=${order.filledQty} remaining=${order.remainingQty}`;
 }
diff --git a/src/market.ts b/src/market.ts
index 752dc2a22b380bc20132597f4209ee3767abd3ab..45f64cdb9f3a9b8574b210f018dd72d74a50e57a 100644
--- a/src/market.ts
+++ b/src/market.ts
@@ -7,19 +7,31 @@ export type MarketConfig = {
 };
 
 export function* simulateMarket(config: MarketConfig): Generator<Tick> {
-  let price = config.startPrice;
+  let lastPrice = config.startPrice;
+  let indexPrice = config.startPrice;
 
   for (let seq = 1; seq <= config.ticks; seq++) {
     const trend = seq < config.ticks / 2 ? 8 : -5;
     const wave = Math.sin(seq / 2) * 18;
     const noise = Math.sin(seq * 1.7) * 5;
-    price = Math.max(1, price + trend + wave + noise);
+    lastPrice = roundPrice(Math.max(1, lastPrice + trend + wave + noise));
+
+    // A deliberately small deterministic reference move makes price roles
+    // observable. This is a scenario generator, not an exchange mark engine.
+    indexPrice = roundPrice(Math.max(1, indexPrice + trend * 0.25));
+    const markPrice = roundPrice(indexPrice + (lastPrice - indexPrice) * 0.25);
 
     yield {
       seq,
       symbol: config.symbol,
-      price: Math.round(price * 100) / 100,
+      lastPrice,
+      markPrice,
+      indexPrice,
       ts: Date.now()
     };
   }
 }
+
+function roundPrice(price: number): number {
+  return Math.round(price * 100) / 100;
+}
diff --git a/src/position.ts b/src/position.ts
index 7fed73bdafffce6c2b5d76efc4a2712474d1ee23..d8c5ebeb7d0edb7576396a32a0777f1349ee0aa4 100644
--- a/src/position.ts
+++ b/src/position.ts
@@ -1,14 +1,22 @@
 import { round } from "./math.ts";
-import type { Fill, Position, PositionSide } from "./types.ts";
+import type { Fill, FundingSettlement, Position, PositionSide } from "./types.ts";
 
 export type PositionBookState = {
   position: Position;
   processedFillIds: string[];
+  processedFundingIds?: string[];
+};
+
+export type FundingResult = {
+  accepted: boolean;
+  payment: number;
+  position: Position;
 };
 
 export class PositionBook {
   private position: Position;
   private readonly processedFillIds = new Set<string>();
+  private readonly processedFundingIds = new Set<string>();
 
   constructor(symbol: string) {
     this.position = {
@@ -30,13 +38,17 @@ export class PositionBook {
     for (const fillId of state.processedFillIds) {
       book.processedFillIds.add(fillId);
     }
+    for (const fundingId of state.processedFundingIds ?? []) {
+      book.processedFundingIds.add(fundingId);
+    }
     return book;
   }
 
   exportState(): PositionBookState {
     return {
       position: this.get(),
-      processedFillIds: [...this.processedFillIds]
+      processedFillIds: [...this.processedFillIds],
+      processedFundingIds: [...this.processedFundingIds]
     };
   }
 
@@ -79,6 +91,33 @@ export class PositionBook {
 
     return this.get();
   }
+
+  applyFunding(settlement: FundingSettlement): FundingResult {
+    if (settlement.symbol !== this.position.symbol) {
+      throw new Error(`funding symbol ${settlement.symbol} does not match ${this.position.symbol}`);
+    }
+    if (
+      settlement.fundingId.length === 0 ||
+      !Number.isFinite(settlement.rate) ||
+      !Number.isFinite(settlement.markPrice) ||
+      settlement.markPrice <= 0 ||
+      !Number.isFinite(settlement.ts)
+    ) {
+      throw new Error("invalid funding settlement");
+    }
+    if (this.processedFundingIds.has(settlement.fundingId)) {
+      return { accepted: false, payment: 0, position: this.get() };
+    }
+
+    // Positive rates transfer value from longs to shorts; negative rates reverse it.
+    const payment = round(-toSignedQty(this.position) * settlement.markPrice * settlement.rate);
+    this.position = {
+      ...this.position,
+      realizedPnl: round(this.position.realizedPnl + payment)
+    };
+    this.processedFundingIds.add(settlement.fundingId);
+    return { accepted: true, payment, position: this.get() };
+  }
 }
 
 function toSignedQty(position: Position): number {
diff --git a/src/risk.ts b/src/risk.ts
index 1762d3234ca70c0695056f150f21f23ab2dd93c3..eeb8c1934fb00baf2d946f52ee7643ac42267c5c 100644
--- a/src/risk.ts
+++ b/src/risk.ts
@@ -54,7 +54,7 @@ export class RiskManager {
         symbol: tick.symbol,
         side,
         qty: Math.abs(deltaQty),
-        price: tick.price,
+        price: tick.lastPrice,
         reason: signal.reason,
         ts: tick.ts
       }
diff --git a/src/state-store.ts b/src/state-store.ts
index 4f96a0f9cde17974593fb5d0352abdd8403eb052..358a392c1ed7e2193c8f2f2da4bdf4a0c7fad423 100644
--- a/src/state-store.ts
+++ b/src/state-store.ts
@@ -88,6 +88,9 @@ function isPositionState(value: unknown): boolean {
   if (!isRecord(value) || !isRecord(value.position) || !isStringArray(value.processedFillIds)) {
     return false;
   }
+  if (value.processedFundingIds !== undefined && !isStringArray(value.processedFundingIds)) {
+    return false;
+  }
   const position = value.position;
   return (
     typeof position.symbol === "string" &&
diff --git a/src/strategy.ts b/src/strategy.ts
index 2de0a6fc23255a0b4e8b49c184ac2304f4079399..b7176c22a4f367d272455a562a8f4d2272521318 100644
--- a/src/strategy.ts
+++ b/src/strategy.ts
@@ -16,7 +16,7 @@ export class MovingAverageSignal {
   }
 
   onTick(tick: Tick): Signal {
-    this.prices.push(tick.price);
+    this.prices.push(tick.lastPrice);
 
     const shortMa = sma(this.prices, this.shortWindow);
     const longMa = sma(this.prices, this.longWindow);
diff --git a/src/types.ts b/src/types.ts
index 7babe58e5d020c9e003dc1cf05c1df987ce4bcce..9e7c95ef837ee2b668fa6f35e48dff1a1fec9cae 100644
--- a/src/types.ts
+++ b/src/types.ts
@@ -5,7 +5,12 @@ export type SignalAction = "HOLD" | "LONG" | "SHORT";
 export type Tick = {
   seq: number;
   symbol: string;
-  price: number;
+  /** Most recent trade price; strategy signals and simulated limit orders use this. */
+  lastPrice: number;
+  /** Fair price used for unrealized PnL, margin, and liquidation checks. */
+  markPrice: number;
+  /** External spot-basket reference price; recorded but not traded directly. */
+  indexPrice: number;
   ts: number;
 };
 
@@ -43,6 +48,14 @@ export type Fill = {
   ts: number;
 };
 
+export type FundingSettlement = {
+  fundingId: string;
+  symbol: string;
+  rate: number;
+  markPrice: number;
+  ts: number;
+};
+
 export type Position = {
   symbol: string;
   side: PositionSide;
diff --git a/test/bot.test.ts b/test/bot.test.ts
index 06c9d66d519b0d27f10007203d0239d3a061e66f..02b26c8645c2e64874fe35040f4d10271bc4c28d 100644
--- a/test/bot.test.ts
+++ b/test/bot.test.ts
@@ -8,11 +8,11 @@ import type { Tick } from "../src/types.ts";
 
 test("runs signal -> risk -> ack -> delayed fill -> position update", async () => {
   const ticks: Tick[] = [
-    { seq: 1, symbol: "BTC-PERP", price: 100, ts: 1 },
-    { seq: 2, symbol: "BTC-PERP", price: 101, ts: 2 },
-    { seq: 3, symbol: "BTC-PERP", price: 102, ts: 3 },
-    { seq: 4, symbol: "BTC-PERP", price: 103, ts: 4 },
-    { seq: 5, symbol: "BTC-PERP", price: 104, ts: 5 }
+    { seq: 1, symbol: "BTC-PERP", lastPrice: 100, markPrice: 100, indexPrice: 100, ts: 1 },
+    { seq: 2, symbol: "BTC-PERP", lastPrice: 101, markPrice: 101, indexPrice: 101, ts: 2 },
+    { seq: 3, symbol: "BTC-PERP", lastPrice: 102, markPrice: 102, indexPrice: 102, ts: 3 },
+    { seq: 4, symbol: "BTC-PERP", lastPrice: 103, markPrice: 103, indexPrice: 103, ts: 4 },
+    { seq: 5, symbol: "BTC-PERP", lastPrice: 104, markPrice: 104, indexPrice: 104, ts: 5 }
   ];
 
   const logs: string[] = [];
@@ -53,7 +53,7 @@ test("uses pending orders as projected position while fills are delayed", async
   });
 
   for (const [index, price] of [100, 101, 102, 103, 104, 105].entries()) {
-    await bot.onTick({ seq: index + 1, symbol: "BTC-PERP", price, ts: index + 1 });
+    await bot.onTick(tick(index + 1, price));
   }
 
   await bot.waitForIdle();
@@ -83,7 +83,7 @@ test("matches out-of-order fills to pending orders by orderId", async () => {
   });
 
   for (const [index, price] of [100, 101, 102, 103, 80].entries()) {
-    await bot.onTick({ seq: index + 1, symbol: "BTC-PERP", price, ts: index + 1 });
+    await bot.onTick(tick(index + 1, price));
   }
 
   await bot.waitForIdle();
@@ -113,11 +113,11 @@ test("keeps remaining exposure pending until all partial fills complete", async
   });
 
   for (const [index, price] of [100, 101, 102, 103].entries()) {
-    await bot.onTick({ seq: index + 1, symbol: "BTC-PERP", price, ts: index + 1 });
+    await bot.onTick(tick(index + 1, price));
   }
   await sleep(10);
-  await bot.onTick({ seq: 5, symbol: "BTC-PERP", price: 104, ts: 5 });
-  await bot.onTick({ seq: 6, symbol: "BTC-PERP", price: 105, ts: 6 });
+  await bot.onTick(tick(5, 104));
+  await bot.onTick(tick(6, 105));
   await bot.waitForIdle();
 
   assert.equal(logs.filter((line) => line.startsWith("[ACK]")).length, 1);
@@ -142,19 +142,80 @@ test("liquidates an under-margined position at mark and halts new strategy order
   });
 
   for (const [index, price] of [100, 101, 102, 103].entries()) {
-    await bot.onTick({ seq: index + 1, symbol: "BTC-PERP", price, ts: index + 1 });
+    await bot.onTick(tick(index + 1, price));
   }
   await bot.waitForIdle();
 
-  await bot.onTick({ seq: 5, symbol: "BTC-PERP", price: 90, ts: 5 });
-  await bot.onTick({ seq: 6, symbol: "BTC-PERP", price: 110, ts: 6 });
+  await bot.onTick(tick(5, 110, 90, 100));
+  await bot.onTick(tick(6, 110));
 
   assert.equal(bot.getPosition().side, "FLAT");
   assert.equal(logs.filter((line) => line.startsWith("[ACK]")).length, 1);
-  assert.match(logs.join("\n"), /\[LIQUIDATION\].*mark=90/);
+  assert.match(
+    logs.join("\n"),
+    /\[LIQUIDATION\].*triggerMark=90 executionPrice=90 assumption=EXECUTION_AT_MARK/
+  );
   assert.match(logs.join("\n"), /halted after liquidation/);
 });
 
+test("documents current cancel-then-late-fill behavior after liquidation", async () => {
+  const logs: string[] = [];
+  const bot = new PerpBot({
+    symbol: "BTC-PERP",
+    shortWindow: 2,
+    longWindow: 4,
+    orderQty: 0.01,
+    maxAbsPosition: 0.03,
+    fillDelayMs: 40,
+    margin: { collateral: 0.1, leverage: 20, maintenanceMarginRate: 0.01 },
+    logger: (line) => logs.push(line)
+  });
+
+  for (const [index, price] of [100, 101, 102, 103].entries()) {
+    await bot.onTick(tick(index + 1, price));
+  }
+  await bot.waitForIdle();
+  assert.deepEqual(bot.getPosition(), {
+    symbol: "BTC-PERP",
+    side: "LONG",
+    qty: 0.01,
+    entryPrice: 103,
+    realizedPnl: -0.000412
+  });
+
+  // The reversal order is ACKED at a healthy mark, but its fill remains delayed.
+  await bot.onTick(tick(5, 80, 103, 100));
+  assert.match(logs.join("\n"), /\[ACK\] orderId=SIM-2 side=SELL qty=0\.02/);
+
+  // A later mark triggers liquidation and locally cancels the ACKED reversal.
+  await bot.onTick(tick(6, 80, 90, 95));
+  assert.equal(bot.getPosition().side, "FLAT");
+
+  // The already scheduled exchange fill still arrives after local cancellation.
+  await bot.waitForIdle();
+  const trace = logs.filter(
+    (line) =>
+      line.includes("orderId=SIM-2") ||
+      line.startsWith("[LIQUIDATION]") ||
+      line.startsWith("[POSITION]")
+  );
+  const ackIndex = trace.findIndex((line) => line.startsWith("[ACK] orderId=SIM-2"));
+  const canceledIndex = trace.findIndex(
+    (line) => line.startsWith("[ORDER] orderId=SIM-2 status=CANCELED")
+  );
+  const liquidationIndex = trace.findIndex((line) => line.startsWith("[LIQUIDATION]"));
+  const lateFillIndex = trace.findIndex((line) => line.startsWith("[FILL]") && line.includes("SIM-2"));
+
+  assert.ok(ackIndex < canceledIndex);
+  assert.ok(canceledIndex < liquidationIndex);
+  assert.ok(liquidationIndex < lateFillIndex);
+  assert.match(trace[lateFillIndex + 1] ?? "", /status=CANCELED/);
+
+  // Observation only: the tracker rejects the late fill, so Position stays FLAT.
+  // Whether an exchange-reported fill may be discarded is intentionally unresolved.
+  assert.equal(bot.getPosition().side, "FLAT");
+});
+
 test("blocks an order when initial margin exceeds marked equity", async () => {
   const logs: string[] = [];
   const bot = new PerpBot({
@@ -169,7 +230,7 @@ test("blocks an order when initial margin exceeds marked equity", async () => {
   });
 
   for (const [index, price] of [100, 101, 102, 103].entries()) {
-    await bot.onTick({ seq: index + 1, symbol: "BTC-PERP", price, ts: index + 1 });
+    await bot.onTick(tick(index + 1, price));
   }
 
   assert.equal(logs.filter((line) => line.startsWith("[ACK]")).length, 0);
@@ -190,7 +251,7 @@ test("restores a filled position and continues monotonic exchange order ids", as
   } as const;
   const first = await PerpBot.create(config);
   for (const [index, price] of [100, 101, 102, 103].entries()) {
-    await first.onTick({ seq: index + 1, symbol: "BTC-PERP", price, ts: index + 1 });
+    await first.onTick(tick(index + 1, price));
   }
   await first.waitForIdle();
 
@@ -200,7 +261,7 @@ test("restores a filled position and continues monotonic exchange order ids", as
   assert.equal(restored.isRecoveryRequired(), false);
 
   for (const [index, price] of [103, 102, 101, 100].entries()) {
-    await restored.onTick({ seq: index + 5, symbol: "BTC-PERP", price, ts: index + 5 });
+    await restored.onTick(tick(index + 5, price));
   }
   await restored.waitForIdle();
 
@@ -223,12 +284,66 @@ test("halts on restart when the checkpoint contains an unresolved order", async
   });
 
   assert.equal(bot.isRecoveryRequired(), true);
-  await bot.onTick({ seq: 10, symbol: "BTC-PERP", price: 110, ts: 10 });
+  await bot.onTick(tick(10, 110));
 
   assert.match(logs.join("\n"), /\[RECOVERY\] blocked openOrders=1/);
   assert.equal(logs.filter((line) => line.startsWith("[ACK]")).length, 0);
 });
 
+test("keeps the latest mark when a delayed fill arrives at the last trade price", async () => {
+  const bot = new PerpBot({
+    symbol: "BTC-PERP",
+    shortWindow: 2,
+    longWindow: 4,
+    orderQty: 0.01,
+    maxAbsPosition: 0.03,
+    fillDelayMs: 20,
+    logger: () => {}
+  });
+
+  for (const [index, price] of [100, 101, 102, 103].entries()) {
+    await bot.onTick(tick(index + 1, price));
+  }
+  await bot.onTick(tick(5, 104, 95, 97));
+  await bot.waitForIdle();
+
+  assert.equal(bot.getAccountSnapshot()?.markPrice, 95);
+  assert.equal(bot.getPosition().entryPrice, 103);
+});
+
+test("funding changes equity without taking ownership of the latest market mark", async () => {
+  const logs: string[] = [];
+  const bot = new PerpBot({
+    symbol: "BTC-PERP",
+    shortWindow: 2,
+    longWindow: 4,
+    orderQty: 1,
+    maxAbsPosition: 1,
+    fillDelayMs: 1,
+    logger: (line) => logs.push(line)
+  });
+  for (const [index, price] of [100, 101, 102, 103].entries()) {
+    await bot.onTick(tick(index + 1, price));
+  }
+  await bot.waitForIdle();
+  await bot.onTick(tick(5, 104, 95, 97));
+
+  const settlement = {
+    fundingId: "BTC-1000",
+    symbol: "BTC-PERP",
+    rate: 0.001,
+    markPrice: 100,
+    ts: 1_000
+  } as const;
+  await bot.onFunding(settlement);
+  await bot.onFunding(settlement);
+
+  assert.equal(bot.getAccountSnapshot()?.markPrice, 95);
+  assert.equal(bot.getPosition().realizedPnl, -0.1412);
+  assert.match(logs.join("\n"), /settlementMark=100 payment=-0\.1/);
+  assert.match(logs.join("\n"), /fundingId=BTC-1000 ignored=duplicate/);
+});
+
 class MemoryStateStore implements BotStateStore {
   private checkpoint: BotCheckpoint | null;
 
@@ -274,3 +389,7 @@ function unresolvedCheckpoint(): BotCheckpoint {
     lastMarkPrice: 100
   };
 }
+
+function tick(seq: number, lastPrice: number, markPrice = lastPrice, indexPrice = markPrice): Tick {
+  return { seq, symbol: "BTC-PERP", lastPrice, markPrice, indexPrice, ts: seq };
+}
diff --git a/test/liquidation.test.ts b/test/liquidation.test.ts
new file mode 100644
index 0000000000000000000000000000000000000000..e9e7643e396210ab169f2bab8d9f917c6786575a
--- /dev/null
+++ b/test/liquidation.test.ts
@@ -0,0 +1,15 @@
+import assert from "node:assert/strict";
+import test from "node:test";
+
+import { PaperLiquidationExecutor } from "../src/liquidation.ts";
+
+test("paper liquidation records trigger mark separately from execution price", () => {
+  const execution = new PaperLiquidationExecutor().execute(
+    { symbol: "BTC-PERP", side: "LONG", qty: 1, entryPrice: 100, realizedPnl: 0 },
+    { seq: 7, symbol: "BTC-PERP", lastPrice: 88, markPrice: 90, indexPrice: 92, ts: 7 }
+  );
+
+  assert.equal(execution.triggerMarkPrice, 90);
+  assert.equal(execution.executionPrice, 90);
+  assert.equal(execution.fill.price, execution.executionPrice);
+});
diff --git a/test/market.test.ts b/test/market.test.ts
new file mode 100644
index 0000000000000000000000000000000000000000..1ef62864c17c30a52a76ed30e417b37818380c63
--- /dev/null
+++ b/test/market.test.ts
@@ -0,0 +1,18 @@
+import assert from "node:assert/strict";
+import test from "node:test";
+
+import { simulateMarket } from "../src/market.ts";
+
+test("simulation exposes deterministic last, mark, and index divergence", () => {
+  const ticks = [...simulateMarket({ symbol: "BTC-PERP", startPrice: 100, ticks: 4 })];
+
+  assert.deepEqual(
+    ticks.map(({ lastPrice, markPrice, indexPrice }) => ({ lastPrice, markPrice, indexPrice })),
+    [
+      { lastPrice: 121.59, markPrice: 106.9, indexPrice: 102 },
+      { lastPrice: 130.46, markPrice: 108.18, indexPrice: 100.75 },
+      { lastPrice: 138.79, markPrice: 109.32, indexPrice: 99.5 },
+      { lastPrice: 152.63, markPrice: 111.85, indexPrice: 98.25 }
+    ]
+  );
+});
diff --git a/test/position.test.ts b/test/position.test.ts
index eb991a400ed60396f60fb12b1ce92e4a2eb784ee..699fe33f83c481c1b0c1b8c9977715c601add068 100644
--- a/test/position.test.ts
+++ b/test/position.test.ts
@@ -64,6 +64,32 @@ test("restores position and processed fill ids without applying a duplicate agai
   assert.deepEqual(restored.exportState(), original.exportState());
 });
 
+test("funding debits longs, credits shorts, and is idempotent", () => {
+  const long = new PositionBook("BTC-PERP");
+  long.applyFill(fill("LONG", "BUY", 1));
+  const settlement = {
+    fundingId: "BTC-1000",
+    symbol: "BTC-PERP",
+    rate: 0.001,
+    markPrice: 110,
+    ts: 1_000
+  };
+
+  assert.equal(long.applyFunding(settlement).payment, -0.11);
+  assert.deepEqual(long.applyFunding(settlement), {
+    accepted: false,
+    payment: 0,
+    position: long.get()
+  });
+
+  const restored = PositionBook.fromState(long.exportState());
+  assert.equal(restored.applyFunding(settlement).accepted, false);
+
+  const short = new PositionBook("BTC-PERP");
+  short.applyFill(fill("SHORT", "SELL", 1));
+  assert.equal(short.applyFunding({ ...settlement, fundingId: "BTC-2000" }).payment, 0.11);
+});
+
 function fill(orderId: string, side: Fill["side"], qty: number): Fill {
   return {
     fillId: `${orderId}-FILL-1`,
diff --git a/test/risk.test.ts b/test/risk.test.ts
index dfbbce7b898c38b1d44b18dca22d376c682170e4..2e2840d86447c7598a0e47646e4b269d55ae82b3 100644
--- a/test/risk.test.ts
+++ b/test/risk.test.ts
@@ -5,7 +5,7 @@ import { RiskManager } from "../src/risk.ts";
 import type { Position, SignalAction } from "../src/types.ts";
 
 const risk = new RiskManager({ orderQty: 0.01, maxAbsPosition: 0.03 });
-const tick = { seq: 1, symbol: "BTC-PERP", price: 100, ts: 1 };
+const tick = { seq: 1, symbol: "BTC-PERP", lastPrice: 100, markPrice: 100, indexPrice: 100, ts: 1 };
 
 function evaluate(action: SignalAction, position: Position) {
   return risk.evaluate(
@@ -21,6 +21,7 @@ test("LONG 0.02 -> target SHORT 0.01 requires SELL 0.03", () => {
   if (decision.approved) {
     assert.equal(decision.order.side, "SELL");
     assert.equal(decision.order.qty, 0.03);
+    assert.equal(decision.order.price, tick.lastPrice);
   }
 });
 
```

## 8. Review 输出模板

```text
Prediction:

Current ownership mistake:

Source of truth:

Invariant:

Candidate A / B / C assessment:

Recommended Order state:

Recommended Position state:

Recommended Bot state:

Recommended reconciliation behavior:

What evidence would make this recommendation wrong:
1.
2.

Patch now? YES / NO
Reason:
```
