# 延期设计与触发式路线图

> 这不是普通 TODO List。只有真实证据出现时，某个设计才重新进入实现队列。

## 状态模型

`RESOLVED / PARTIAL / VALID_GAP / DEFER / FALSE_POSITIVE`

早期审计提过的问题，不代表今天仍然必须做。

## A. Recovery 与外部事实

### A1. 完整 Recovery Completion

当前已有 checkpoint、unresolved detection、`RECOVERY_REQUIRED`、只读 reconciliation、Recovery Evidence contract。

延期的是：

```text
authoritative evidence
→ 幂等补齐 missing fills
→ 收敛 OrderTracker / PositionBook
→ fresh mark
→ 重算 Risk / Margin
→ converged checkpoint
→ clear RECOVERY_REQUIRED
```

只有 authenticated Testnet/venue evidence 暴露真实 recovery case、adapter 有足够权威证据、或 JD 明确要求时再打开。

### A2. 真正的 S2 Late Fill

S1 Ghost Cancel 已修正。S2 是“先 execution → 后 cancel effective → Fill 更晚到本地”，届时再引入 `executionAt / cancelEffectiveAt / receivedAt`。

### A3. EventLog

完整 EventLog 当前不是必修。只有 snapshot 无法解释真实 recovery failure，或必须依赖事件顺序/来源才能收敛时，再加最小 append-only evidence。

## B. Failure 可重复性

Simulator 已能制造 delayed / partial / late 等场景。后续可以把它们做成声明式 `injectScenario(...)`，用于 fixture、回归和一键演示。这是低成本 hardening，不是新架构。

## C. Testnet 之后的交易所集成

当前已有 Binance USDⓈ-M Futures Testnet adapter、market feed、user-data event mapping 和只读 reconciliation。

后续重点是：

```text
authenticated venue evidence
→ ACK / CancelAck / TradeUpdate
→ Open Orders / Position / Trade History
→ Recovery Evidence
→ safe convergence decision
```

包括 ambiguous submit、user-stream gap、authoritative recovery evidence、state convergence。为了“看起来完整”不需要接真钱。

## D. Perp 风险真实度

未来可能加入 tiered maintenance margin、fees、reduce-only、leverage、exchange-grade mark、venue liquidation、multi-symbol、cross margin。

但只有 failure 或岗位要求证明有价值时才加。

## E. 策略与 AI 验证

Strategy Lab 的 Formal Candidate admission 已冻结为 1-minute closed candle protocol v1.0.0；PENGU 的逐笔 / 1m 差异归类为 `MICROSTRUCTURE_SENSITIVE` 方法发现，不通过修改 Strategy 消除。

当前主线切换为 freeze 后的 prospective sampling。更多历史案例只在能验证**尚未解决的方法问题**时重新打开；PENGU 缺少完整归档 raw artifact，因此不计作 FORMAL sample，这一点不阻塞阶段收尾。

更多 FORMAL Case 仍只接受 archived input + measurable outcome。  
MFE / MAE 只有在 final outcome 隐藏路径风险时才加。

## F. AI 研究

延期：memory-sensitivity、primary-source authentication、reviewer stability、bounded AI gating、Prediction Signal → PerpIntent。

AI gating 即使未来开启，也不能绕过 deterministic Risk。

## G. 仓库 Hardening

CI、public fixtures、runtime validation、dependency cleanup、logging、adapter fault injection、安全审查等，等真实协作/展示需求触发。

## 明确不要重新加入“当前必修”

- “缺 Fake Exchange Simulator”
- “现在必须上 EventLog”
- “PENDING_ACK 是致命 blocker”
- “只有真实 Candidate 才能验证订单生命周期”
- 没有造成 correctness failure 的 schema taste

## 重新打开路线图的触发条件

authenticated venue evidence 暴露新 gap、recovery 无法收敛、真正 cancel/fill race、FORMAL 样本成批、Reviewer freeze、Prospective 开始、仓库进入协作、岗位方向变化或 JD 明确要求。

路线图由证据触发，不按日期堆功能。
