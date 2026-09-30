# 永续合约模拟机器人学习报告

## 1. 今天真正理解的 5 个业务概念

1. **Signal 是目标意图，不是成交事实。** 本项目的 `LONG`/`SHORT` 表示最终想持有 LONG 0.01/SHORT 0.01；它既不是订单，也不保证会成交。
2. **ACK 是交易所已接单，Fill 才是成交。** ACK 后订单已经成为真实在途风险，但 Position 必须等 Fill 才能改变。
3. **Position 只记录已成交结果。** 它回答“现在已经持有什么”，不能单独回答“所有在途订单成交后会持有什么”。
4. **Pending Order 是独立业务状态。** 它始于 ACK，终于对应的 Fill；只记数量不够，还要知道 `orderId`、方向和数量。
5. **风控应看 projected position。** 已成交仓位加上全部在途订单的潜在影响，才是下一次决策所面对的预计风险。

基线的一条完整反手链路：

```text
[TICK] seq=10 price=65097.02
[SIGNAL] action=SHORT reason="short MA < long MA"
[RISK] approved side=SELL qty=0.02 price=65097.02
[ACK] orderId=SIM-2 side=SELL qty=0.02 price=65097.02
[FILL] orderId=SIM-2 side=SELL qty=0.02 price=65097.02
[POSITION] side=SHORT qty=0.01 entry=65097.02
```

- Signal：策略希望机器人最终处于什么仓位。
- ACK：模拟交易所已接受订单，但尚未说明成交。
- Fill：订单中有多少、以什么价格真实成交。
- Position：累计所有 Fill 后已经成立的持仓事实。

## 2. 实验 2 的事故链

**初始假设：** Risk 读取 Position 就足以避免重复下单。

**实际事故日志：**

```text
[ACK] orderId=SIM-1 side=BUY qty=0.01
[ACK] orderId=SIM-2 side=BUY qty=0.01
[ACK] orderId=SIM-3 side=BUY qty=0.01
[FILL] orderId=SIM-1 side=BUY qty=0.01
[POSITION] side=LONG qty=0.01
[FILL] orderId=SIM-2 side=BUY qty=0.01
[POSITION] side=LONG qty=0.02
[FILL] orderId=SIM-3 side=BUY qty=0.01
[POSITION] side=LONG qty=0.03
```

完整运行继续放大，最终得到 SHORT 0.45，而策略目标只是 SHORT 0.01。

**事故链：** FLAT Position → LONG Signal → SIM-1 已 ACK 未 Fill → 新 Tick 仍读取 FLAT → SIM-2/SIM-3 再次获批 → Position 远超目标。

**业务判断：** Strategy 没要求大仓位；重复订单来自 ACK 与 Fill 之间的时间窗。已经发生但 Position 尚未表达的是“交易所已接收在途订单”。所以只读 Position 等于忽略尚未成交但可能成交的风险。

**最小修复：** 用 `Map<orderId, OrderRequest>` 保存 Pending。每次 Risk 前计算：

```text
projected signed qty = filled signed qty + Σ(pending BUY qty) - Σ(pending SELL qty)
```

已经发生的事实是 Tick、Signal、ACK 和 Fill；在途状态是 ACK 后尚未 Fill 的订单；`projectedPosition` 是由 Position 与 Pending 计算出的预测值，不是成交事实。

修复后的关键日志：

```text
[EXPOSURE] filled=0 pending=0 projected=0
[ACK] orderId=SIM-1 side=BUY qty=0.01
[EXPOSURE] filled=0 pending=0.01 projected=0.01
[RISK] blocked reason="already LONG"
[FILL] orderId=SIM-1 side=BUY qty=0.01
[POSITION] side=LONG qty=0.01
```

乱序实验中 SIM-2 先 Fill、SIM-1 后 Fill，最终仍为 SHORT 0.01。`PositionBook.applyFill()` 只消费每次 Fill，因此不要求提交顺序等于成交顺序；Pending 删除却必须按 `orderId`。旧 `pendingOrderCount` 只能说“还有几张”，不能说剩下哪张、方向和数量，无法计算 projected exposure。

## 3. 实验 3 的事故链

**初始假设：** `SHORT` 可以直接翻译为“SELL 0.01”。

**错误运行：**

```text
Current Position  LONG 0.01
Signal            SHORT
Delta Order       SELL 0.01
Fill              SELL 0.01
New Position      FLAT
```

这是 Action Signal 的正确执行，却不是 Target Position 的正确执行。项目采用目标语义：

```text
Current Position  +0.01
Target Position   -0.01
Delta Order       -0.02 = SELL 0.02
Fill              SELL 0.02
New Position      -0.01 = SHORT 0.01
```

其中第一段 SELL 0.01 平掉 LONG，第二段 SELL 0.01 才建立 SHORT。四组测试结果为：LONG 0.02→SHORT 0.01 发 SELL 0.03；SHORT 0.02→LONG 0.01 发 BUY 0.03；FLAT→LONG 0.01 发 BUY 0.01；LONG 0.01→LONG 0.01 不下单。

- `targetSignedQty`：我想去哪。
- `currentSignedQty`：我现在在哪；在机器人主链路中传入 Risk 的是预计位置。
- `deltaQty`：为了抵达目标还需要移动多少。

Partial Fill 思考实验：SELL 0.006 后为 LONG 0.004；再 SELL 0.006 后为 SHORT 0.002；最后 SELL 0.008 后为 SHORT 0.01。同一 SELL Fill 可以先减 LONG、恰好时归零、超过剩余 LONG 后进入 SHORT。

`PositionBook.applyFill()` 中：旧仓位为零或 Fill 同方向的分支处理加仓；反方向分支用 `closedQty` 处理减仓；`newSignedQty === 0` 处理平仓；新旧符号不同时处理反手并把剩余新仓的成本设为 Fill 价格。

## 4. 最重要的业务字段表

### `signal.action`

业务事实：策略想去的目标方向。  
谁产生：`MovingAverageSignal`。  
谁消费：`RiskManager`。  
生命周期：当前 Tick 的一次决策。  
由哪个事件改变：新 Tick 改变均线关系。  
如果这个字段滞后/错误：订单会朝错误目标移动。  
为什么不能被另一个字段替代：Position 是现状，不是意图。

### `decision.approved`

业务事实：本次目标移动是否获准。  
谁产生：`RiskManager`。  
谁消费：`PerpBot`。  
生命周期：一次风控判断。  
由哪个事件改变：Signal 或预计仓位变化。  
如果这个字段滞后/错误：该拦的订单会提交，或合法订单被漏掉。  
为什么不能被另一个字段替代：Signal 没有包含风险结论。

### `orderId`

业务事实：交易所为一张已接收订单给出的唯一身份。  
谁产生：`SimulatedExchange`。  
谁消费：Pending 状态与 Fill 处理。  
生命周期：ACK 后至少持续到最终 Fill。  
由哪个事件改变：不改变；新订单获得新 ID。  
如果这个字段滞后/错误：乱序 Fill 会清掉错误 Pending。  
为什么不能被另一个字段替代：方向和数量都可能重复，不能唯一关联事件。

### `ack.status`

业务事实：交易所已接受订单，本项目固定为 `ACKED`。  
谁产生：`SimulatedExchange.submit()`。  
谁消费：编排与日志。  
生命周期：从接单开始，是订单历史事实。  
由哪个事件改变：submit 接受订单。  
如果这个字段滞后/错误：系统会误判订单是否已进入交易所。  
为什么不能被另一个字段替代：Fill 表示成交，不表示此前是否已接单。

### `order.side`

业务事实：这张订单增加有符号仓位还是减少它。  
谁产生：`RiskManager`。  
谁消费：交易所、projected exposure、PositionBook。  
生命周期：整张订单。  
由哪个事件改变：订单创建后不应改变。  
如果这个字段滞后/错误：风险和持仓都会向反方向移动。  
为什么不能被另一个字段替代：Signal 是目标，订单方向是抵达目标的动作。

### `order.qty`

业务事实：订单计划移动多少仓位。  
谁产生：`RiskManager` 的 delta 计算。  
谁消费：交易所与 projected exposure。  
生命周期：整张订单。  
由哪个事件改变：新决策创建新订单。  
如果这个字段滞后/错误：预计和最终仓位都会偏离目标。  
为什么不能被另一个字段替代：Position 数量是累计结果，不是本次移动量。

### `pendingOrders`（替代旧 `pendingOrderCount`）

业务事实：已 ACK、尚未 Fill 的具体订单集合。  
谁产生：`PerpBot` 收到 ACK 时登记。  
谁消费：projected exposure 与 Fill 关联。  
生命周期：ACK 到对应 `orderId` 的 Fill。  
由哪个事件改变：ACK 增加，Fill 删除。  
如果这个字段滞后/错误：重复下单或预计风险错误。  
为什么不能被另一个字段替代：计数和 Position 都缺少每张在途订单的方向、数量与身份。

### `projectedPosition`

业务事实：假设全部 Pending 成交后的预计仓位。  
谁产生：`PerpBot` 从 Position 与 Pending 计算。  
谁消费：`RiskManager`。  
生命周期：一次 Tick 的即时计算结果。  
由哪个事件改变：Fill、ACK 或 Position 变化。  
如果这个字段滞后/错误：风控会重复或漏下 delta 订单。  
为什么不能被另一个字段替代：Position 不含在途风险，Pending 不含已成交基础。

### `position.side`

业务事实：已成交净仓位位于零点哪一侧。  
谁产生：`PositionBook.applyFill()`。  
谁消费：日志、查询和 projected exposure。  
生命周期：持续到下一次 Fill。  
由哪个事件改变：Fill。  
如果这个字段滞后/错误：现有仓位方向被误读。  
为什么不能被另一个字段替代：订单与 Signal 都不是已成交净结果。

### `position.qty`

业务事实：已成交净仓位的绝对数量。  
谁产生：`PositionBook.applyFill()`。  
谁消费：Risk 的当前位置计算和日志。  
生命周期：持续到下一次 Fill。  
由哪个事件改变：Fill。  
如果这个字段滞后/错误：delta、盈亏和风险敞口都会错误。  
为什么不能被另一个字段替代：Fill 只是一段变化，不是累计余额。

## 5. 现在仍然没解决的问题

- Partial Fill 只有 Position 计算实验，没有订单剩余量和订单最终状态。
- 没有 Reject、Cancel、Cancel ACK、过期和重试。
- 乱序 Fill 已能关联，但没有重复事件、丢事件与幂等处理。
- 没有滑点、资金费、保证金、强平、精度和最小下单量规则。
- 进程重启会丢失 Position 与 Pending，尚无交易所对账。

## 6. 不建议现在继续扩展的功能

暂不接真实交易所、真钱、WebSocket、数据库、UI、完整回测、复杂指标、杠杆保证金和多品种并发。它们会同时引入连接、持久化、时钟、精度和恢复问题，反而遮住本轮最重要的订单状态与仓位语义。

如果只再深入两个函数，应选：

1. `RiskManager.evaluate()`：这里把“目标在哪里、预计现在在哪里、还需移动多少”变成订单，是 Signal、风险与订单语义的交界。
2. `PositionBook.applyFill()`：这里把每次成交变成真实仓位，涵盖加仓、减仓、平仓、反手和已实现盈亏，是账本正确性的核心。
