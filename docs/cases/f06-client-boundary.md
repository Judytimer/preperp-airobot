# F06 Decision Memo｜PerpBot 收回到“交易所客户端”边界

> **SUPERSEDED FOR S1（2026-09-24）**：后续审查确认旧 F06 是 Ghost Cancel：cancel intent 从未送达 `SimulatedExchange`，本地 tracker 却直接伪造 `CANCELED`。因此 Stage 1.5 先修 cancel ownership；本 Memo 中关于真正 late-arrival Fill 的 A/B/C 判断保留给 Stage 2，不能用于把 S1 的未执行 Fill 强行记入 Position。

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
