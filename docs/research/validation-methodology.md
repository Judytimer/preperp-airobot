# 验证方法：怎样避免“自己证明自己”

> 这里记录已经落到代码与研究记录里的验证边界，不只是未来计划。

## 1. 两条验证线

**Trading Core**：验证订单、仓位、Risk、Recovery、Reconciliation 在 failure 下是否守住 invariant。证据来自 deterministic test、trace、checkpoint、before/after state、reconciliation output。

**Strategy / AI Research**：验证研究规则或 AI Reviewer 相比 Baseline 是否真的改善判断。不能靠挑漂亮案例。

## 2. Historical Replay 状态

```text
DEMO / QUALITATIVE_ONLY / FORMAL
MEASURED / NOT_MEASURABLE
ARCHIVED / RECONSTRUCTED / MIXED
```

## 3. FORMAL Admission

至少需要：归档输入、明确 T0、可测 Outcome、预先定义 Outcome Rule、决策输入不泄漏未来结果。

重建材料可以学习，但不能为了凑数量强行升级 FORMAL。

## 4. T0

Reviewer 不应看到后续新闻、后续价格、最终结果、事后总结或后续社媒解释。T0 说不清，就不能算正式证据。

## 5. Ground Truth 不能让 AI 自己判

```text
AI 判断
→ 看结果
→ 自己解释
→ 宣布自己当时正确
```

这种评估无效。Outcome window / rule / SUCCESS-FAILURE-NEUTRAL 必须事先定义。

而且 `Catalyst CONFIRMED ≠ Trade PASS`。

## 6. Historical Replay 不是 Alpha 证明

它适合找 Prompt bug、schema gap、error category、label problem、source-verification weakness，不足以证明未来持续交易价值。

## 7. 模型记忆污染

严格 T0 不能删除模型权重中的历史知识。匿名化、重命名、strict-T0 vs leaked 只能做 sensitivity check。

## 8. 不逐案例调 Prompt

只接受少量系统性 Patch：重复错误类、缺失标签、证据边界错误、系统性 Prompt 漏洞。

## 9. Freeze

Prospective 前冻结 Reviewer Prompt、Verdict contract、Label、Output schema、Ground Truth rule、Evaluation rule；不冻结 Trading Core bug fix、Observability 和无关基础设施。

## 10. Prospective Paper Sampling

```text
未来 Candidate
→ Baseline 先记录
→ AI Shadow 先记录
→ Outcome 前不回改
→ 等预设窗口
→ Evaluate
```

中途因 bug/leakage 必须改规则，就切新版本或重启 batch。

## 11. Counterfactual 也记录

即使 AI WOULD_BLOCK，也尽量记录原 Baseline 如果执行会得到什么结果，避免 selection bias。

## 12. Perp Outcome 不只看最终 PnL

有需要时再加入 MFE、MAE、window sensitivity、liquidation/margin stress、mark-price path、funding effect。

## 13. 一个案例不能证明 Alpha

单个案例适合做 failure taxonomy、面试案例、研究假设和新验证规则；持续 Alpha 必须依赖合适的样本过程。
