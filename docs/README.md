# 文档阅读地图

这个目录不是开发日志的平铺列表，而是项目的**工程判断与证据层**。

如果只想快速了解项目，请先看根目录 [README](../README.md)。README 负责回答“现在做到了什么”；这里负责回答“为什么这么设计、哪些故障逼出了这些设计、哪些事情现在故意不做”。

## 面试准备

- [面试准备入口](interview/README.md) — 把项目材料串成 6 个核心工程判断，按“15 岁解释 → Failure → 设计判断 → 源码 → 面试表达 → 掌握标准”训练。

## 推荐阅读顺序

### 5 分钟快速了解

1. [关键架构决策](architecture/design-decisions.md)  
   看最重要的工程判断：Intent 与 Fact、Command/Event 分离、Projected Position、Fail-Closed Recovery、Reconciliation。

2. [Binance Testnet 验证记录](cases/testnet-validation.md)  
   看本地 Core 如何接到真实 Testnet market/user stream，以及当时已经验证和仍未验证的边界。

3. [AI Shadow：为什么 AI 只做副驾驶](research/ai-shadow.md)  
   看 AI 权限边界，以及为什么目前不允许模型直接控制下单与风控。

4. [延期设计与触发条件](roadmap/deferred-designs.md)  
   看哪些能力不是“忘了做”，而是等真实 failure / exchange evidence 出现后才值得增加复杂度。

## 深挖交易工程

### 架构

- [关键架构决策](architecture/design-decisions.md)

### 故障与交易一致性案例

- [F06：PerpBot 的交易所客户端边界](cases/f06-client-boundary.md)
- [Cancel × Fill × Reconciliation 专项审计](cases/cancel-fill-reconciliation.md)
- [Liquidation × Late Fill 复现实验](cases/liquidation-late-fill.md)
- [Binance Testnet 接管与验证记录](cases/testnet-validation.md)

这些文档保留“错误假设 → Failure Case → Invariant → 设计修正”的过程。部分文档明确标记为 SUPERSEDED，它们用于解释为什么后来改设计，不代表当前最终行为。

## AI 与策略验证

- [AI Shadow 研究边界](research/ai-shadow.md)
- [验证方法：Historical Replay / FORMAL / Prospective](research/validation-methodology.md)
- [Strategy Lab 收尾：Formal 1m Protocol × PENGU](research/strategy-lab-closeout.md)
- [Strategy Lab v1 Prospective Manifest](research/prospective-manifest-v1.md)
- [Prediction Market Overlay 实验](research/prediction-overlay.md)
- [FORMAL Case #1：候选筛选](research/formal-case-1-candidate-screen.md)
- [FORMAL Case #1：原始证据获取记录](research/formal-case-1-artifact-acquisition.md)

这里的核心原则是：**历史案例用于找漏洞，不用于包装 AI alpha；真正的前瞻结论必须来自冻结规则后的 prospective evidence。**

## 路线图

- [延期设计与触发条件](roadmap/deferred-designs.md)

它不是功能愿望清单，而是回答：什么证据出现以后，才值得重新打开 Recovery Completion、S2 late fill、EventLog、更多 Perp 风险真实度或 AI gating。

## 历史归档

[archive/](archive/) 保存早期学习报告、阶段计划、过时审计与已经被后续实现修正的材料。

**不要把 archive 里的旧口径当成当前系统事实。** 当前状态以根 README、当前源码和主阅读路径文档为准。
