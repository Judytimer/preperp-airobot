# 关键架构决策

> 更新时间：2026-10-06  
> 只记录经过当前源码、确定性 Failure Case 和后期 Repo Reality 审计仍然成立的稳定判断。

## 1. 当前代码事实优先于旧计划

```text
当前源码 / deterministic trace
>
后期 Repo Reality 审计
>
最终推进规范
>
早期架构审计
>
最初设想
```

文档没写，不代表代码没做；代码里出现一个类，也不代表问题已经真正解决。

## 2. 永续交易 Core 优先于策略复杂度

优先级：Order Lifecycle → Position / Projected Position → Risk → Margin → Funding → Liquidation → Failure / Recovery → Reconciliation。

策略可以替换，但这些交易语义不能因为策略变复杂而变模糊。

## 3. 工程对齐不等于搬运别人的策略

Hummingbot、NautilusTrader、Passivbot 主要用于参考 Connector 边界、订单生命周期、Execution 语义、Recovery / Reconciliation 和 Perp 领域建模，不搬运它们的交易策略。

## 4. Intent 不是 Fact

```text
发出 cancel request ≠ 已取消
submit timeout ≠ 交易所没收到订单
本地状态 ≠ 交易所事实
```

事实优先级：

```text
Exchange execution fact
>
Exchange order fact
>
Local mirror
>
Intent
```

## 5. 本地状态不能抹掉权威成交事实

Liquidation × Late Fill 实验暴露的核心 invariant：

> 本地订单状态不能静默抹掉一个有效、唯一、来自交易所侧的成交事实。

2026-10-06 的确定性复现证明了一个更具体的实现问题：旧 `processFill` 在 `CANCELED` 分支先返回，导致 unique late fill 被静默丢弃，且 fillId 去重不变量也会被终态分支短路。当前实现先做 fillId 幂等，再做身份与数量校验；`CANCELED` 在 `originalQty - filledQty` 预算内继续修正成交记账，但保持终态，因此不会重新进入 `getOpenOrders()`。

## 6. Command 完成不等于 ACK

`submit()` 返回只表示命令调用完成。ACK / Fill / CancelAck 必须通过独立 execution event 推进状态。

## 7. Ambiguous Submit 不能靠通用 Retry

```text
submit
→ timeout
→ 交易所可能已接单
→ 无脑 retry
→ 重复订单
```

因此 signed order submit 不使用普通自动重试；必须依赖 clientOrderId、交易所证据和 reconciliation。

## 8. clientOrderId 由 Core 提前拥有

Core 在越过 venue boundary 前生成并持久化 `clientOrderId`，Exchange/venue 再绑定 `exchangeOrderId`。即使 ACK 丢失，本地仍知道自己刚刚提交的是哪张订单。

## 9. Risk 必须看 Projected Position

风控读取 filled Position + unresolved order remaining quantity，避免 Fill 延迟期间误判“还有仓位空间”并重复下单。

## 10. Reconciliation 不等于 Recovery

Reconciliation：本地和交易所哪里不一致？  
Recovery：拿到足够权威证据后，怎样安全收敛并重新允许交易？

当前已有只读 reconciliation 和 Recovery Evidence contract；完整 recovery mutation 仍延期。

## 11. 不确定时 Fail Closed

重启或网络异常后，如果不能证明 unresolved order 的最终状态，进入 `RECOVERY_REQUIRED` 并停止新交易。

## 12. Checkpoint 不等于完整事件历史

当前证据还没有证明必须上完整 EventLog / Event Sourcing。现阶段采用：

```text
Atomic Snapshot
+
Processed IDs
+
Unresolved Detection
+
RECOVERY_REQUIRED
+
Exchange Reconciliation
```

## 13. 到达时间不等于撮合时间

2026-10-06 已用本地确定性事件序列复现并修复“CancelAck 后 unique Fill 晚到”的 OrderTracker correctness failure。但这不等于已经完整建模交易所时间语义：真实 S2 cancel/fill race 仍可能是先撮合、后取消生效、Fill 更晚才到本地；只有 authenticated venue evidence 证明需要时，才引入 `executionAt`、`cancelEffectiveAt`、`receivedAt`。

## 14. Schema Taste 不等于工程债

字段“不够漂亮”不代表必须重构。只有它破坏 invariant、导致 failure、或阻碍 recovery / reconciliation，才升级为当前 Decision Debt。

## 15. Simulator 已经存在

早期“缺 Fake Exchange Simulator”的审计结论已被 Repo Reality 推翻。真正的小缺口是故障场景是否足够 fixture 化和可重复回归。

## 16. 复杂度由 Failure 驱动

只有可复现 failure、新 connector 约束、reconciliation 无法安全收敛、Testnet/venue evidence 或明确 JD 要求出现时，才增加架构。

## 17. AI 不能绕过确定性 Risk

AI 可以观察、找证据、打标签、输出 review verdict；不能直接下单、改杠杆/仓位、绕过 Risk、自动反手或清除 Recovery gate。

## 18. Prediction Signal 不等于 PerpIntent

```text
Research Signal
→ Trading Thesis
→ PerpIntent
→ Deterministic Risk
→ Execution
```

`Trading Thesis → PerpIntent` 仍是业务语义，不允许代码生成工具自行补全。

`Perp Expression v1.0.0` 已把该边界实现成显式 admission contract。一个在 Candidate T0 之前冻结的 policy 必须选择 `SIGNAL_ONLY / DIRECTIONAL_PROXY / HEDGE`，并在执行模式下显式给出 side、风险预算、杠杆上限、stop distance 和有效期。没有 policy、post-hoc policy 或 symbol/market mismatch 都不生成 intent。

这只解决“如何安全表达已批准的业务语义”，不替业务研究决定方向。当前 Crypto FDV Variant 没有 active perp policy，因此仍不能声称 `BUY_YES → LONG perp`。
