# Directional Study v1.1：分级授权预注册协议

日期：2026-10-05
状态：**FROZEN / COLLECTING 0/10 / SIGNAL_ONLY**

v1.0 在尚未产生任何 observation 时由 v1.1 取代。变更依据不是“等待太慢”，而是首次真实 FDV discovery 得到 `426 observed / 33 new potential / 0 qualified`，证明当前 Formal Batch 的样本供给稀疏。v1.1 不降低 10-sample formal gate，而是在首 3 个样本冻结一个权限严格受限的 provisional stage。

## 1. 唯一研究问题

本协议只回答：

> Strategy Lab v2.1.1 产生 qualified prospective Candidate 后，underlying perpetual 在固定 4h horizon 上是否呈现稳定、可复现的同向价格收益？

它不验证原 Prediction 策略的 `BUY_YES` 收益，也不重复验证 Perp order lifecycle。三者保持独立：

```text
原策略验证          Candidate → BUY_YES → YES outcome / PnL
Perp 工程验证       P0/P1（已完成）
Directional Study  Candidate → underlying perp direction hypothesis
```

`SIGNAL_ONLY` 不是收益方向。研究只比较 `LONG hypothesis` 与 `SHORT hypothesis`；如果两者均未通过 gate，控制结论才是 `NO_DIRECTIONAL_EVIDENCE → SIGNAL_ONLY`。

## 2. 冻结 cohort

- 输入只接受 Strategy Lab v2.1.1 的 qualified prospective Candidate。
- 按 Candidate T0 升序，取首批 **10 个**唯一 Candidate；不是历史回填样本。
- Stage A 只使用首 3 个完整 observation，并在第三个样本到达时永久冻结；第 4～9 个样本不得重算 Stage A。
- Stage B 使用完整 10 个 observation，随后关闭该 cohort；禁止通过继续加样本让结论翻转。
- 缺少 raw artifact、未来边界价格或 4h 路径数据的 Candidate 不能由手填、插值或未来值补齐，也不能静默换成“更好”的 Candidate。
- 同一 Candidate 只贡献一个 observation。

## 3. 冻结时间与数据口径

```yaml
primary_horizon: T0 + 4h
secondary_horizon: T0 + 1h
provisional_sample_size: 3
provisional_hit_rate_threshold: 2/3
primary_sample_size: 10
primary_hit_rate_threshold: 0.70
```

边界价格使用 raw artifact 中 `observedAt <= boundary` 的 latest-known 值；禁止插值和读取未来。4h `highMark` / `lowMark` 来自 `[T0, T0+4h]` 内归档的 mark observations，并必须覆盖 T0 与 4h 边界值。

Primary gate 只使用：

1. 4h directional median return；
2. 4h directional hit rate；
3. 4h median MFE 与 median MAE。

以下只作 secondary reporting，不进入 primary gate：

- 1h return；
- YES price change at 1h / 4h；
- 跨 `(T0, T0+4h]` funding settlement 的 funding return；
- contract `measurementAt` 的 perp return 与 YES change。

`measurementAt` 独立报告，不与 4h primary 样本混合。

## 4. 两级 gate

对 LONG 和 SHORT 分别把 4h raw return 转成 directional return。两个 stage 使用相同的方向、return 和 path 定义，但授权级别不同。

### Stage A：3-sample provisional

```text
首 3 个样本
AND median directional 4h return > 0
AND hit rate >= 2/3
AND median MFE > median MAE
```

结果只能是：

```text
PROVISIONAL_LONG_SUPPORTED
PROVISIONAL_SHORT_SUPPORTED
NO_PROVISIONAL_DIRECTIONAL_EVIDENCE
```

前两个结果只产生 `strategyGeneratedTestnet = ELIGIBLE_FOR_EXPLICIT_REVIEW`。它允许另开显式审核，决定是否运行 strategy-generated Testnet；不生成订单、不代表 alpha、不允许真钱。未通过 Stage A 仍继续收集到 10，但第 4～9 个样本不能补做 provisional activation。

### Stage B：10-sample formal

```text
median directional 4h return > 0
AND hit rate >= 70%（固定 cohort 即至少 7/10）
AND median MFE > median MAE
```

可能结果只有：

```text
DIRECTIONAL_LONG_SUPPORTED
DIRECTIONAL_SHORT_SUPPORTED
NO_DIRECTIONAL_EVIDENCE
```

前两个结果只产生 `microCapital = ELIGIBLE_FOR_EXPLICIT_REVIEW`，表示允许重新打开 Micro-Capital 审核，不代表自动获得真钱权限。`NO_DIRECTIONAL_EVIDENCE → SIGNAL_ONLY → STOP`。

第 10 个 observation 之前，formal stage 始终为 `null`；Stage A 的 provisional hypothesis 不得写成 formal direction 或 alpha 结论。

## 5. 权限边界

`src/directional-study.ts` 是纯 evaluator：

- 不导入 Execution、Risk 或 `perp-expression.ts`；
- 不生成 `PerpIntent`；
- 不下单，不连接交易所；
- 不因研究输出自动改写 `FrozenPerpExpressionPolicy`。

Stage A support 只解锁 Testnet review；Stage B support 才解锁 Micro-Capital review。两个 review 都必须是新的显式工程决策，evaluator 本身永不自动激活 `DIRECTIONAL_PROXY`。

如果输出 `NO_DIRECTIONAL_EVIDENCE`：

```text
SIGNAL_ONLY
→ STOP
```

## 6. 明确不做

Directional Study v1.1 本身不引入：

- Sharpe、回归、feature importance、regime classification；
- basis model、liquidity score；
- stop / leverage / sizing 优化；
- intent persistence、conditional order、recovery；
- strategy-generated Testnet execution code；
- Micro-Capital execution 或真钱权限。

这些工作只有在方向证据真正改变工程判断后，才有重新开启的理由。
