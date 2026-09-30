# AI Shadow：为什么 AI 只做副驾驶

> 当前状态：AI 是研究与审查层，不拥有交易执行权。

## 1. 研究问题

> 在不控制真实交易的前提下，AI Reviewer 能不能提高证据质量，或者减少一部分明显的假机会？

## 2. 当前链路

```text
Candidate / Research Snapshot
→ Baseline Decision
→ AI Shadow Reviewer
→ Review / Evidence / Labels
→ Research Record
```

Reviewer 可以输出 `PASS / WOULD_BLOCK / ABSTAIN`，并记录 reason、confidence、reviewerId、promptVersion、runId。

## 3. AI 没有 Execution Authority

不能直接 submit order、设置 leverage、调整 position size、绕过 deterministic risk、自动反手或清除 `RECOVERY_REQUIRED`。

## 4. Historical Replay 的正确用途

主要用于找 Prompt 漏洞、字段遗漏、重复 error pattern、标签问题和 evidence boundary，**不单独证明 prospective alpha**。

## 5. 已知限制：模型可能“记得历史答案”

严格 T0 只能限制输入，不能删除模型权重里的历史知识。因此要明确披露，并把真正前瞻证据留给 prospective sampling。

## 6. Reviewer Stability

至少记录：

```text
reviewerId
verdict
reason
confidence
promptVersion
runId
```

后续才有资格分析重复运行、模型/Prompt 版本变化、disagreement 与 flip rate。

## 7. 外部信号的定位

Prediction Market、新闻、事件搜索可以提供 Evidence、Catalyst Confirmation、Research Context 和 Candidate Generation，但不会自动变成可执行 PerpIntent。

## 8. 必须保留的语义桥

```text
External Evidence
→ Research Signal
→ Trading Thesis
→ PerpIntent
→ Deterministic Risk
→ Execution
```

## 9. 未来什么时候可以升级权限

可能从 Shadow only 升级到 bounded candidate gating，但必须先有冻结规则后的 prospective evidence。deterministic Risk 仍不可绕过。

## 10. 延期研究

memory-sensitivity A/B、first-party source authentication、reviewer stability、false-block、evidence bias、prospective validation、multi-source research。
