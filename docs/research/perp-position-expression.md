# Strategy Signal → Perp Position Expression

日期：2026-10-04  
协议：`Perp Expression v1.0.0`  
状态：**CONTRACT + DETERMINISTIC PAPER PATH COMPLETE / ACTIVE FDV→PERP POLICY NOT FROZEN**

## 1. 解决的问题

Prediction `BUY_YES` 与 perpetual position 不是同一种交易语义：

```text
TradeCandidate
→ FrozenPerpExpressionPolicy
→ NO_INTENT / BLOCKED / PerpIntent
→ Deterministic Risk
→ Order / Fill / Position
```

`BUY_YES` 不会自动变成 `LONG`，AI Reviewer 的 confidence 也不会直接决定仓位。表达方向、风险预算、杠杆上限和止损距离必须来自一个在 Candidate T0 之前冻结的 policy。

## 2. 三种显式模式

| Mode | Meaning | Execution result |
| --- | --- | --- |
| `SIGNAL_ONLY` | 只把 Candidate 当研究信号 | `NO_INTENT`，不进入 Risk / Execution |
| `DIRECTIONAL_PROXY` | 用 perp 表达显式方向性代理 | 按 policy 指定的 `LONG` 或 `SHORT` 生成 intent |
| `HEDGE` | 用 perp 表达显式对冲腿 | 按 policy 指定的 `LONG` 或 `SHORT` 生成 intent |

方向不能从模式名或 `BUY_YES` 猜测。即使是 `HEDGE`，也必须显式写出 perp target side。

## 3. Fail-closed admission

映射只有在以下条件同时成立时才生成 `PerpIntent`：

- policy protocol、ID、时间窗与 rationale 有效；
- `policy.frozenAt <= candidate.t0 <= policy.validUntil`；
- Candidate 的 prediction market 与 policy 完全匹配；
- Candidate 的 underlying spot symbol 与 policy 完全匹配；
- reference price、equity、quantity step、venue minimums 与 max position 均有效；
- 风险约束后的数量仍满足 venue minimums。

任何 post-hoc mapping、市场错配、底层错配、过期 policy 或过小仓位都返回 `BLOCKED`，不产生订单。

## 4. Position sizing

执行模式的 target quantity 取三项最小值后向下对齐 quantity step：

```text
riskLimitedQty     = maxRiskQuote / (referencePrice × stopDistance)
leverageLimitedQty = accountEquity × maxLeverage / referencePrice
targetQty          = floorToStep(min(riskLimitedQty,
                                     leverageLimitedQty,
                                     maxAbsQty))
```

生成的 `PerpIntent` 固定记录：source Candidate、policy、symbol、target side/qty、reference/stop price、最大风险、stop 预期损失、计划杠杆和有效期。

这只是 sizing contract；交易所的实际 leverage setting、reduce-only/conditional stop order 与滑点仍需单独的 adapter 语义，不能由字段名冒充已经实现。

## 5. Execution bridge

`PerpIntentSignalSource` 只消费已经授权的 intent：

- 未到 active time：`HOLD`；
- active：输出带 `targetQty` 的 `LONG / SHORT`；
- stop boundary 或 expiry：输出 `FLAT`；
- stop/expiry 首次触发后 latch 为 terminated，价格反弹不会重新开仓；
- symbol 不一致：`HOLD`，不把 intent 路由到错误合约。

`RiskManager` 继续拥有确定性 order delta 与 `maxAbsPosition` gate。表达层不能直接 submit，也不能绕过 margin、recovery、liquidation 或 reconciliation。

当前 stop/expiry latch 是进程内 paper-path 状态。把某个 policy 激活到 Testnet 或真钱之前，还必须持久化 intent lifecycle/terminal state，并实现交易所侧 reduce-only conditional stop；否则进程在本地 stop 后、intent 过期前重启，不能证明不会重新表达旧 intent。

## 6. 当前验证

自动化测试覆盖：

- `SIGNAL_ONLY` 不生成 intent；
- post-hoc、market mismatch 与 venue minimum failure 被阻止；
- directional proxy 和 hedge 必须显式选择方向；
- risk/leverage/max-position 三重 sizing；
- stop/expiry latch；
- `Candidate → PerpIntent → Signal → Risk → paper ACK/Fill → LONG → stop → FLAT`。

## 7. 尚未做出的业务决定

当前 Crypto FDV Variant 的正式 policy 仍然是 `SIGNAL_ONLY` 语义；仓库没有把它激活为 perp strategy。要启用 `DIRECTIONAL_PROXY` 或 `HEDGE`，必须先用 prospective evidence 冻结：

- 为什么这个 Prediction contract 对 underlying perp 有可交易的方向含义；
- 是方向代理还是已有 YES/spot exposure 的 hedge；
- symbol mapping、有效期和失效条件；
- 风险预算、stop distance、杠杆上限；
- basis、funding、liquidity 与 liquidation 对 thesis 的影响。

所以当前能准确声称的是：

> 已实现并验证 signal semantics 与 venue execution semantics 之间的显式桥接协议；尚未声称 Crypto FDV Prediction Overlay 已形成经证据授权的 perp alpha。
