# Stage 3｜Hummingbot 架构对账与首个实验

日期：2026-09-19  
范围：只审计当前 TypeScript Perp 主链路，只实施一个 Fill 幂等 Patch；不迁移 Hummingbot。

## 1. 当前真实数据流

```text
Tick
  -> MovingAverageSignal.onTick()
  -> Signal(HOLD | LONG | SHORT)
  -> PerpBot 读取 filled Position + pending OrderRequest
  -> projectedPosition
  -> RiskManager.evaluate()
  -> OrderRequest
  -> SimulatedExchange.submit()
  -> OrderAck(orderId, ACKED)
  -> pendingOrders.set(orderId, request)
  -> delayed Fill(fillId, orderId, side, qty, price, fee)
  -> pendingOrders.delete(orderId)
  -> PositionBook.applyFill()
  -> 下一次 Tick 再读取 Position 与 Pending
```

### 状态所有权

| 状态 | 创建者 | 持有者 | 修改者 | 生命周期 |
|---|---|---|---|---|
| `Signal` | `MovingAverageSignal` | 当前 `onTick()` 调用 | 每个 Tick 重新创建 | 单次决策 |
| `RiskDecision` / `OrderRequest` | `RiskManager` | `PerpBot`、随后 ACK/Pending | 创建后不修改 | 单次下单及其后续关联 |
| `OrderAck` | `SimulatedExchange` | `PerpBot` 日志；没有独立订单实体 | 不修改 | 接单事实 |
| `pendingOrders` | `PerpBot` 收到同步 ACK 后登记 | `PerpBot` | ACK 增加，Fill 按 `orderId` 删除 | ACK 到第一个 Fill |
| `Fill` | `SimulatedExchange` | Fill callback | 创建后不修改 | 成交事件 |
| `Position` | `PositionBook` | `PositionBook` | 每个接受的 Fill | 持续到下一次 Fill |
| `processedFillIds` | `PositionBook`（本 Patch） | `PositionBook` | 成功应用 Fill 后增加 | 当前进程生命周期 |

代码证据：`src/bot.ts:47-79` 负责 Strategy、Risk、submit、Pending 和 Fill 编排；`src/position.ts:22-59` 负责成交记账；`src/risk.ts:26-61` 只读取 Signal、projected Position 和 Tick。

### Pending 当前表达能力

Pending 不是简单布尔值，也不是旧版 count；当前是：

```ts
Map<string, OrderRequest> // key = orderId
```

它能表达 `orderId / side / original qty / requested price`，足以计算 projected exposure，也能支持不同订单的乱序 Fill。

它不能表达：

- `filledQty`；
- `remainingQty`；
- `PARTIALLY_FILLED / FILLED / CANCELED / FAILED` 等状态；
- 一张订单的多个 Fill；
- 已处理的成交事件身份；
- terminal order 在一段时间内继续接收 late trade 的能力。

ACK 的 `status: ACKED` 只存在于事件对象中，并没有更新一个持续存在的 order state。Fill 到来时，Bot 无条件删除整张 Pending，然后无条件记账；Patch 前重复 Fill 会再次改变 Position。

## 2. 与 Hummingbot 的三个最高价值差距

### 差距 1：成交事件与 In-Flight Order 没有独立身份和累计状态

【我的当前实现】

Pending 只保存原始 `OrderRequest`。Patch 前 Fill 只有 `orderId`，`PositionBook.applyFill()` 每调用一次就累加仓位和手续费。

【Hummingbot 对应实现 / 源码位置】

- [`InFlightOrder` 与 `update_with_trade_update()`](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/core/data_type/in_flight_order.py#L1132-L1602)
- [`ClientOrderTracker.process_trade_update()`](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/connector/client_order_tracker.py#L1401-L1430)

Hummingbot 的 `TradeUpdate` 有 `trade_id`。`InFlightOrder` 用 `order_fills` 按 trade ID 保存各次成交；重复 trade ID 返回 `False`，只有真实新增成交才累计 `executed_amount_base/quote`。Tracker 只有在更新成功时才触发后续 fill 事件。

【关键差异】

Hummingbot 将“订单身份、订单状态、累计成交、单次成交身份”放在持续存在的 InFlightOrder/Tracker 中；当前项目只有原始请求和最终 Position，中间订单状态被压扁。

【为什么成熟系统需要它】

REST 轮询与 WebSocket 可能报告同一成交；重连后也可能重放。没有 trade identity，Position、手续费和 PnL 会被重复计算。

【这是生产复杂度，还是我当前已经暴露的问题】

当前已暴露。确定性测试证明同一个 Fill 两次调用会把 LONG 0.01 变成 LONG 0.02，并把手续费从 -0.4 变成 -0.8。

【如果现在不改，会发生什么】

任何重复成交事件都会污染本地账本；下一次 Risk 再基于错误 Position 产生错误 delta order。

【建议】A. 立即实验。本轮唯一 Patch。

### 差距 2：Controller 与 Executor 生命周期仍集中在 Bot

【我的当前实现】

`PerpBot.onTick()` 同时编排 Signal、projected exposure、Risk、submit、Pending、Fill 和日志。Strategy 产生目标，Bot 也承担执行生命周期。

【Hummingbot 对应实现 / 源码位置】

- [`ControllerBase.control_task()` / `determine_executor_actions()`](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/strategy_v2/controllers/controller_base.py#L2370-L2389)
- [`ExecutorBase` 的具体使用示例](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/strategy_v2/executors/arbitrage_executor/arbitrage_executor.py)

Controller 生成 Create/Stop Executor actions，通过队列交给执行层；Executor 独立维护一次交易任务的生命周期与结果。

【关键差异】

当前没有 Intent/Action 与长期 Execution task 的独立边界。

【为什么成熟系统需要它】

订单修改、取消、超时、分批成交和退出逻辑不能可靠地塞进一次策略 Tick。

【这是生产复杂度，还是我当前已经暴露的问题】

部分暴露：Bot 已持有 Pending，并直接处理异步 Fill；但当前只有单订单、全量成交，尚未证明需要完整 Executor。

【如果现在不改，会发生什么】

继续加入 Cancel/Retry/Partial Fill 会使 `PerpBot` 同时拥有越来越多策略和执行状态，边界会变模糊。

【建议】B. 保留认知，暂不实现。当前实验不需要 Executor 层。

### 差距 3：Connector 是具体模拟类，不是可替换边界

【我的当前实现】

`PerpBot` 直接构造 `SimulatedExchange`；`submit()` 同步返回 ACK 和单个延迟 Promise Fill。外部事件无法独立进入系统。

【Hummingbot 对应实现 / 源码位置】

- [`ConnectorBase`](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/connector/connector_base.py)
- [Binance connector 将 exchange trade 转成 `TradeUpdate` 后交给 tracker](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/connector/exchange/binance/binance_exchange.py)

【关键差异】

成熟 Connector 负责交易所协议、client/exchange order ID 映射和异步 Order/Trade updates；当前模拟类把 ACK 与唯一 Fill 都绑定在一次函数返回值中。

【为什么成熟系统需要它】

真实交易所事件可能乱序、重复、丢失或来自不同通道，不能假设 submit Promise 是唯一事件源。

【这是生产复杂度，还是我当前已经暴露的问题】

接口不足已经可见，但真实重连、对账和失败尚未进入本项目。

【如果现在不改，会发生什么】

无法自然模拟 duplicate/late/partial events；每次实验都可能需要给 `SimulatedExchange` 增加特例。

【建议】B. 保留认知，暂不实现。先观察第二个真实需求再抽象 Connector。

## 3. 本轮唯一实验

### Broken Invariant

> 同一个可唯一识别的 Fill 事件，无论被交付多少次，对 Position 与手续费只能生效一次。

### 失败场景

1. 本地收到 `fillId=SIM-1-FILL-1`，BUY 0.01，fee 0.4。
2. Position 正确变成 LONG 0.01，realizedPnl -0.4。
3. 同一事件因重放再次到达。
4. Patch 前 Position 错误变成 LONG 0.02，realizedPnl -0.8。

测试直接调用生产记账路径 `PositionBook.applyFill()`；没有 sleep、mock 竞态或人为抛异常。

### Failing test before

命令：

```bash
node --experimental-strip-types --test test/position.test.ts
```

关键证据：

```text
not ok - applying the same identifiable fill twice changes position only once
expected qty: 0.01    actual qty: 0.02
expected realizedPnl: -0.4    actual realizedPnl: -0.8
```

### 唯一 Patch

```diff
 type Fill = {
+  fillId: string;
   orderId: string;
 }

 class SimulatedExchange {
   resolve({
+    fillId: `${orderId}-FILL-1`,
     orderId,
   })
 }

 class PositionBook {
+  private readonly processedFillIds = new Set<string>();

   applyFill(fill: Fill): Position {
+    if (this.processedFillIds.has(fill.fillId)) return this.get();
     // existing position calculation
+    this.processedFillIds.add(fill.fillId);
   }
 }
```

`fillId` 是成交事件身份，不能用 `orderId` 替代：未来一张订单可能有多个合法 Partial Fill，它们共享 orderId，但必须拥有不同 fill IDs。

已处理 ID 只在成交成功应用后写入 Set，避免一次处理在中途失败后被错误标记为完成。

### Passing test after

同一命令的关键证据：

```text
ok - partial SELL fills can reduce LONG and cross zero into SHORT
ok - applying the same identifiable fill twice changes position only once
tests 2, pass 2, fail 0
```

### 关键状态证据

```text
first Fill:     fillId=SIM-1-FILL-1 -> qty=0.01, realizedPnl=-0.4
duplicate Fill: fillId=SIM-1-FILL-1 -> qty=0.01, realizedPnl=-0.4
```

## 4. Review Gate

【本 Patch 守住了什么 Invariant】

Perp `PositionBook` 对相同 `fillId` 幂等；仓位、手续费和 PnL 不会因同一成交事件重放而重复变化。

【仍然没有解决什么】

- Pending 仍没有 `filledQty / remainingQty / status`；
- 第一个 Partial Fill 仍会让 Bot 删除整张 Pending；
- 没有 Cancel、Reject、late fill、lost order、重启恢复或外部对账；
- `processedFillIds` 只在内存中，重启后丢失；
- Overlay 的 `PredictionPositionBook` 尚未增加同样的幂等边界；
- 模拟交易所仍只产生每单一个完整 Fill。

【是否引入新的状态所有权 / single source of truth】

是。`PositionBook.processedFillIds` 成为“哪些 Perp Fill 已进入仓位账本”的单一内存事实源。它只保护账本，不是完整订单 tracker。`pendingOrders` 仍由 `PerpBot` 持有，因此订单生命周期状态仍然分散。

【和 Hummingbot 的差异还剩什么】

Hummingbot 在 InFlightOrder/ClientOrderTracker 层按 trade ID 去重，同时累计每张订单的 executed amounts、fills 和 status；当前 Patch 只在最终账本入口挡重复事件，没有建立 InFlightOrder，也没有处理 Partial Fill 生命周期。

【是否建议合入主线】

建议。它是小而可逆的正确性保护，且 `fillId` 是后续 Partial Fill/Tracker 必需的基础字段。但当前目录不是 Git 仓库，无法实际生成 commit、branch diff 或执行 merge；本文 diff 是本轮真实修改的人工统一摘要。

【下一步候选】

为一张订单模拟两次不同 `fillId` 的 Partial Fill，证明当前 Bot 在第一次 Fill 后过早删除 Pending，导致 projected exposure 暂时错误。

【为什么现在应该 / 不应该继续】

现在不自动继续。这个候选会迫使系统决定 `filledQty / remainingQty / order status` 的所有权，正是是否引入最小 InFlightOrder 的 Review 决策点。应等待 Go / No-Go。

## 5. 官方源码证据边界

本轮网络可访问 Hummingbot 官方 GitHub 仓库，以上源码位置均来自 `hummingbot/hummingbot` 的 `master` 分支，访问日期为 2026-09-19。没有用记忆伪造路径。Master 会继续变化，后续正式实现前应固定 commit SHA 再做精确版本对账。
