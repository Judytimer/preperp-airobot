# 文档阅读地图

> 更新时间：2026-10-06

这个目录不是开发日志的平铺列表，而是项目的**工程判断与证据层**。

如果只想快速了解项目，请先看根目录 [README](../README.md)。README 负责回答“现在做到了什么”；这里负责回答“为什么这么设计、哪些故障逼出了这些设计、哪些事情现在故意不做”。

## 面试准备（2026-10-06 当前最高优先级）

- [面试冲刺入口](interview/README.md) — **先看这个。** 已按“一个真 Failure → 真实输出 → 修正判断 → 设计决策 → 抽象 → 90 秒表达 → 追问边界”重新整理，不要求先把整个仓库读完。
- [OrderTracker 终态迟到成交](cases/order-tracker-late-fill.md) — 当前最完整的主技术故事：确定性复现、最小修复、回归边界和未解决 Failure。

## 推荐阅读顺序

### 面试前时间很少：只按这个顺序

1. [面试冲刺入口](interview/README.md)  
   先吃透 P0 主故事，再补 Projected Position、Ambiguous Submit、Recovery ≠ Reconciliation 三个支撑判断。

2. [OrderTracker 终态迟到成交](cases/order-tracker-late-fill.md)  
   对照 A/B/C/D 四个场景，把“哪些已修、哪些没修”说准确。

3. [关键架构决策](architecture/design-decisions.md)  
   只看 Intent vs Fact、权威成交事实、Projected Position、Recovery / Reconciliation。

4. [Perp Execution Validation](cases/perp-execution-validation.md)  
   用来校准 Testnet 到底验证了什么、没验证什么。

其余 Strategy Lab / AI Shadow / Prospective 文档只有在前四项能脱离文档讲清以后再展开。

## 深挖交易工程

### 架构

- [关键架构决策](architecture/design-decisions.md)

### 故障与交易一致性案例

- [Perp Execution Validation](cases/perp-execution-validation.md) — 用显式 validation target 验证 Order / Margin / Position / PnL / Funding / Liquidation，不把双均线当 alpha 或验证对象。
- [Strategy Signal → Perp Position Expression](research/perp-position-expression.md) — 用 pre-T0 frozen policy 显式桥接 Prediction Candidate 与 PerpIntent；默认不从 BUY_YES 推导方向。
- [F06：PerpBot 的交易所客户端边界](cases/f06-client-boundary.md)
- [Cancel × Fill × Reconciliation 专项审计](cases/cancel-fill-reconciliation.md)
- [Liquidation × Late Fill 复现实验](cases/liquidation-late-fill.md)
- [OrderTracker 终态迟到成交：复现、修复与抽象](cases/order-tracker-late-fill.md) — 2026-10-06 真实复现 `CANCELED` 后 unique late fill 被静默拒绝；修复后保持终态但补齐成交记账，并保留 FILLED 后新 fillId throw 作为独立 failure。
- [Binance Testnet 接管与验证记录](cases/testnet-validation.md)

这些文档保留“错误假设 → Failure Case → Invariant → 设计修正”的过程。部分文档明确标记为 SUPERSEDED，它们用于解释为什么后来改设计，不代表当前最终行为。

## AI 与策略验证

- [Strategy Thesis × Variant × Formal Batch：策略边界纠偏说明](research/strategy-thesis-boundary-correction.md) — 先分清“上层研究假设、当前具体策略、当前冻结实验批次”，避免把 Crypto-FDV v2.1 误当成整个策略定义。
- [Directional Study v1.1：分级授权预注册协议](research/directional-study-v1.md) — 3 个样本只解锁 Testnet review，10 个样本才解锁 Micro-Capital review；两级都不自动交易。
- [Concrete Variant 2：Crypto Price-Target Feasibility](research/price-target-variant-feasibility.md) — 真实核查 BTC/ETH/SOL fixed-time price contracts 的样本供给与独立性风险；feasibility 已完成，admission v1 已冻结，不写执行代码。
- [Concrete Variant 2：Price-Target Admission Protocol v1.0.0](research/price-target-variant-admission-v1.md) — 冻结 episode 去重、nearest-OTM strike、首次 1m upward crossing、Candidate T0 与 fail-closed evidence admission；collector 已实现，但没有执行权限。
- [Price-Target Variant v1：Prospective Admission Collector](research/price-target-collector-v1.md) — 最小 manifest/schema/collector 实现；持续归档 pre-T0 YES book 与 Spot 1m，只推进 research admission state，不连接 Strategy 或 Execution。
- [Price-Target Variant 2：Study Independence Rule v1.0.1](research/price-target-variant-study-independence-v1.md) — 冻结 `asset + candidateT0` trigger cluster；先按 T0 锁定最早 3/10 个 qualified clusters，blocked 永久占位且不得由后样本替换。
- [Price-Target Variant 2：BTC Trigger Cluster #1 Outcome](research/evidence/price-target-btc-cluster-001.md) — 首个 locked BTC cluster 因缺少预先归档的 Perp mark path 永久 `DATA_BLOCKED`；32 个已有 raw artifact checksums 全部通过，禁止历史补抓修复。
- [AI Shadow 研究边界](research/ai-shadow.md)
- [验证方法：Historical Replay / FORMAL / Prospective](research/validation-methodology.md)
- [Strategy Lab 收尾：Formal 1m Protocol × PENGU](research/strategy-lab-closeout.md)
- [Strategy Lab v1 Prospective Manifest](research/prospective-manifest-v1.md)
- [Strategy Lab v2.1 Prospective Manifest（当前）](research/prospective-manifest-v2.md)
- [Prediction Market Overlay 实验](research/prediction-overlay.md)
- [FORMAL Case #1：候选筛选](research/formal-case-1-candidate-screen.md)
- [FORMAL Case #1：原始证据获取记录](research/formal-case-1-artifact-acquisition.md)

这里的核心原则是：**历史案例用于找漏洞，不用于包装 AI alpha；真正的前瞻结论必须来自冻结规则后的 prospective evidence。**

## 路线图

- [延期设计与触发条件](roadmap/deferred-designs.md)

它不是功能愿望清单，而是回答：什么证据出现以后，才值得重新打开 Recovery Completion、S2 的 venue 时间语义、EventLog、更多 Perp 风险真实度或 AI gating。

## 历史归档

[archive/](archive/) 保存早期学习报告、阶段计划、过时审计与已经被后续实现修正的材料。

**不要把 archive 里的旧口径当成当前系统事实。** 当前状态以根 README、当前源码和主阅读路径文档为准。
