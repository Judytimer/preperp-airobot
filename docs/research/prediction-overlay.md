# Meme Spot + Prediction Market Overlay Learning Report

## 1. 原型做了什么

原型观察 mock Meme 现货价格、当前 FDV 和一个更高 FDV 目标的 YES 报价。当现货相对第一条快照上涨至少 50%、目标 FDV 严格高于当前 FDV、且没有已有或在途 YES 暴露时，策略不追加现货，而用最多 100 个模拟货币单位购买 YES。YES 报价达到 0.70 后，系统 paper SELL 全部 YES 份额并记录已实现 PnL。

它只证明状态流可以运行，不证明这套策略盈利，也没有连接真钱或真实市场。

## 2. 新增的业务对象

- `ResearchSnapshot`：同一观察时点的 Meme 现货价格/FDV 与 Prediction Market YES 报价/目标 FDV。
- `ResearchContext`：未来接入 News、X、Reddit、Prediction Market 信息的读取接口；本轮只有按顺序返回固定快照的 `MockResearchContext`。
- `OverlaySignal`：`HOLD | BUY_YES | SELL_YES`，表达 Overlay 想采取的目标动作及原因。
- `PredictionPosition`：已成交 YES 份额、平均入场价、仍处于风险中的 premium 和已实现 PnL。
- `projectedShares`：已成交份额加上所有 Pending BUY、减去所有 Pending SELL 后的预计份额。

固定风险预算控制的是最坏情况下可能损失的买入 premium，而不是永续合约的净仓位数量：

```text
YES shares = floor(maxRiskBudget / yesPrice, 6 decimals)
entry premium = shares * yesPrice <= maxRiskBudget
```

## 3. 复用了原架构的地方

完整链路仍然是：

```text
Mock Market/Research
  -> Strategy
  -> Risk
  -> OrderRequest
  -> SimulatedExchange.submit()
  -> ACK
  -> Pending Map<orderId, OrderRequest>
  -> delayed Fill
  -> Position update
  -> logs
```

直接复用了 `OrderRequest`、`OrderAck`、`Fill`、`SimulatedExchange` 和按 `orderId` 管理 Pending 的模式。Fill 延迟期间，Risk 读取 `projectedShares`，因此同一入场或退出信号不会重复下单。原 Perp Bot、双均线策略、风控和持仓测试均未改动。

## 4. Prediction Market 为什么必须新增模块

### `MemePredictionOverlayStrategy`

原 `MovingAverageSignal` 只消费单一价格并输出永续目标方向，无法表达“现货涨幅 + 当前 FDV + 目标 FDV + YES 报价”的联合条件。

### `OverlayRiskManager`

原 `RiskManager` 计算 LONG/SHORT 目标仓位的 delta。YES 风险是全额支付 premium、long-only，数量取决于 `预算 / 概率价格`；套用永续数量上限会把两种风险单位混在一起。

### `PredictionPositionBook`

原 `PositionBook` 允许正负净仓位和穿零反手。YES 原型禁止卖空，账本需要保存 shares、average entry、premium at risk，并在退出时兑现 PnL。强行复用会允许不存在的 SHORT YES 状态。

### `ResearchContext`

原 Market 只产生 Tick。Overlay 需要把多个研究来源在同一时点组织成业务快照，因此增加只读接口；mock 实现让本轮不承担外部 API、鉴权、延迟与可信度问题。

这些新增模块解决的是业务语义不兼容，不是为了抽象而重构。执行协议和事件顺序仍沿用原骨架。

## 5. 关键运行状态

```text
[OVERLAY_SIGNAL] action=BUY_YES yes=0.35
[OVERLAY_RISK] approved side=BUY ... premium=100.000000
[OVERLAY_ACK] orderId=SIM-1 side=BUY
[OVERLAY_PENDING] orderId=SIM-1 side=BUY
[OVERLAY_EXPOSURE] filled=0 pending=285.714285 projected=285.714285
[OVERLAY_FILL] orderId=SIM-1 side=BUY
[OVERLAY_POSITION] shares=285.714285 premiumAtRisk=100

[OVERLAY_SIGNAL] action=SELL_YES yes=0.72
[OVERLAY_ACK] orderId=SIM-2 side=SELL
[OVERLAY_FILL] orderId=SIM-2 side=SELL
[OVERLAY_POSITION] shares=0 premiumAtRisk=0 realizedPnl=...
```

ACK 后、Fill 前，真实 Position 仍为零，但 Pending 已经占用了预算和预计份额。退出时同理：Pending SELL 使 projected shares 变为零，从而阻止第二张退出单。

## 6. 当前未经验证的策略假设

- Meme 已上涨 50% 后，更高 FDV 的 YES 仍具有正期望，而不是已经被价格充分反映。
- YES 报价可以按显示价格成交任意计算出的份额，没有深度、滑点和限额约束。
- 现货价格、FDV 与预测市场问题定义在时间和口径上可以可靠对齐。
- 固定 premium 预算足以代表组合层面的风险；当前没有计算已有现货、相关资产或其他预测仓位。
- 0.70 固定止盈优于持有到结算或动态退出。
- mock research 数据没有噪声、操纵、延迟、重复或缺失。

## 7. Assumptions / Deferred Decisions

- **自行选择：** 退出采用 YES 价格止盈，因为它以最少状态完成买入到兑现闭环。
- **自行选择：** 每个 Bot 实例只执行一次 Overlay 交易周期，避免止盈后在同一批 mock 数据中自动重新入场。
- **自行选择：** “明显上涨”以第一条快照为基准；生产系统需要明确滚动窗口、时间跨度和异常价格处理。
- **暂缓：** 到期按 `1/0` 结算；它需要 market status、resolution event 和结算幂等状态。
- **暂缓：** NO 合约、YES 卖空、stop loss、部分成交、Reject、Cancel、订单过期与重试。
- **暂缓：** News/X/Reddit/Prediction Market 真实适配器；本轮只保留 `ResearchContext` 接口。
- **暂缓：** 真实现货订单。现货只作为观察信号，不产生任何 Spot Order。
- **跳过方案：** 没有把 `PerpBot` 泛化成通用多资产引擎，因为这会扩大回归面，且无法消除两种 Position 的业务差异。

## 8. 下一步最值得验证什么

先验证数据定义而不是增加指标：同一个 FDV 目标在现货供应量变化、市场问题措辞和结算来源下是否仍然可比。随后再给模拟交易所加入有限盘口与滑点，观察固定 100 premium 是否真的能按预期价格完成入场和退出。
