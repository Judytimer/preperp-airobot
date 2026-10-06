# 延期设计与触发式路线图

> 更新时间：2026-10-06  
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

### A2. S2 Late Fill：本地 correctness 已修，venue 时间语义仍延期

2026-10-06 已用确定性事件流复现并修复 `partial fill → CancelAck / CANCELED → unique late fill`：旧实现会 `accepted:false` 并少记成交；当前实现允许在 originalQty 预算内补记成交，同时保持 `CANCELED`，且 duplicate fillId 仍幂等。

仍延期的是交易所级时间语义：只有 authenticated venue evidence 证明需要区分“先 execution、后 cancel effective、Fill 更晚 received”时，再引入 `executionAt / cancelEffectiveAt / receivedAt`。

另一个独立失败仍保留：订单已 `FILLED` 后如果出现全新 fillId，当前仍会以 quantity overflow 抛错。它不与本次修复混在一起。

### A3. EventLog

完整 EventLog 当前不是必修。只有 snapshot 无法解释真实 recovery failure，或必须依赖事件顺序/来源才能收敛时，再加最小 append-only evidence。

## B. Failure 可重复性

Simulator 已能制造 delayed / partial / late 等场景。后续可以把它们做成声明式 `injectScenario(...)`，用于 fixture、回归和一键演示。这是低成本 hardening，不是新架构。

## C. Testnet 之后的交易所集成

当前已有 Binance USDⓈ-M Futures Testnet adapter、market feed、user-data event mapping 和只读 reconciliation。

`Perp Execution Validation v1.0.0` 的 P0 deterministic paper gate 已完成，并用显式 `LONG → FLAT` target 取代 MA crossover 作为验收触发器。P1 authenticated Testnet 也已完成真实 `FLAT → LONG 0.001 → FLAT`、ACK / Fill、fee 与权威 FLAT reconciliation；本次短时往返未跨 funding settlement，但只读历史 endpoint 已观察到 10 条交易所权威 `FUNDING_FEE` 流水。P2 live micro-capital 必须另行明确授权。

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

主项目已用一条 MA Paper lifecycle 和一条 Prediction `BUY_YES → SELL_YES` Paper round trip 完成作品验收。Prospective sampling、Stage A/B 与 alpha 判断全部转为 Optional / Future Research；只有未来明确需要回答方向证据时才恢复 collector。PENGU 缺少完整归档 raw artifact，因此不计作 FORMAL sample，这一点不影响主项目完成。

更多 FORMAL Case 仍只接受 archived input + measurable outcome。  
MFE / MAE 只有在 final outcome 隐藏路径风险时才加。

## F. AI 研究

延期：memory-sensitivity、primary-source authentication、reviewer stability、bounded AI gating、Stage A/B，以及用 prospective evidence 激活某个具体的 Prediction → Perp mapping。

`Prediction Signal → PerpIntent` 的通用语义桥已由 `Perp Expression v1.0.0` 实现：pre-T0 frozen policy、market/symbol admission、`SIGNAL_ONLY / DIRECTIONAL_PROXY / HEDGE`、risk/leverage/position-bounded sizing，以及 stop/expiry latch。当前 FDV Variant 没有 active directional/hedge policy；这项业务选择继续由证据触发，不从 `BUY_YES` 自动推断。

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
