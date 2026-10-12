# Durable Research Runtime：面向 Strategy Lab 的长期研究与恢复层

> 状态：**FUTURE RESEARCH / DEFERRED**  
> 日期：2026-10-07  
> 实现授权：**NO IMPLEMENTATION AUTHORIZATION**  
> 触发原则：只有 prospective sampling、跨源验证或 restart/recovery 的真实研究问题证明有价值时，才重新打开实现。

## 1. 方向定位

这个方向借鉴 Comma / Salix 的长期 Agent 运行时思想，但**不把当前量化机器人重构成 Personal Agent，也不修改已经冻结的交易核心**。

目标不是“让 AI 24 小时一直思考”，而是把已经冻结的策略研究变成一个可以长期存活、低成本观察、断点恢复、按证据唤醒 AI 的研究系统：

```text
Research Goal
  ↓
Source Watchers
  ↓
Candidate Registry
  ↓
Admission / Validation
  ↓
T0 Freeze
  ↓
Append-only Evidence
  ↓
Long-term Tracking
  ↓
Outcome / Research Verdict
```

其中普通程序负责持续在线和状态推进，AI 只在需要判断时被唤醒。

## 2. 它具体助力量化机器人的哪个模块

### Primary：Strategy Lab / Prospective Research

这是本方向的**主要目标模块**。

当前 Strategy / Risk / Execution / Position 已经完成作品级闭环并冻结；后续仍需要继续回答的是研究问题：

- 新 Candidate 何时真实出现；
- Candidate 是否满足冻结的 Admission Protocol；
- 多个来源是否互相支持或冲突；
- T0 前证据是否完整；
- T0 后价格路径与 Outcome 如何持续归档；
- 研究样本是否因重启、重复发现、历史补抓而被污染；
- 样本积累到什么程度，才允许重新讨论方向性映射或下一阶段授权。

因此 Durable Research Runtime 服务的是：

```text
Prospective Discovery
→ Admission
→ Candidate / Cluster identity
→ T0 Freeze
→ Evidence Archive
→ Outcome Tracking
```

而不是：

```text
Strategy
→ Risk
→ Execution
→ Position
```

### Secondary：Research Evidence / Recovery

这个方向第二个作用，是把现有 prospective evidence 从“一次脚本运行”提升成“可恢复的长期研究状态”。

重点包括：

- Candidate 的稳定身份；
- firstDiscoveredAt 不因重启改变；
- 已冻结 T0 不允许重新计算；
- evidence cursor / lastObservedAt 可恢复；
- 已归档 raw artifact 不重复写入；
- blocked sample 不因后续重跑被替换；
- restart 后先 reconciliation，再继续观察。

它复用了交易执行层已经学过的 checkpoint / recovery / reconciliation 思想，但研究状态与交易状态必须继续保持隔离。

## 3. 为什么现在适合研究，而不是继续改 Frozen Core

当前主项目已经完成交易核心闭环，后续研究价值主要来自**真实时间流中的 prospective evidence**，而不是继续给核心模块加功能。

Strategy Lab 的现实问题天然不是一次性任务：

```text
Day 1   NO_CANDIDATE
Day 2   Candidate A discovered
Day 2   Admission → T0 Frozen
Day 3   Candidate B discovered
Day 5   Candidate A evidence updated
Day 10  Candidate A outcome available
...
```

因此它更接近一个长期存在的 research goal，而不是：

```text
run strategy-lab
→ finish
→ process exit
```

长期运行时最关键的问题也随之改变：

> 系统重新启动后，怎样知道过去已经发生过什么，并保证自己不会因为失忆而重写研究历史？

这正好与当前 prospective protocol 对“pre-T0、不可回填、append-only、blocked 永久占位”的要求一致。

## 4. 借鉴 Comma / Salix 的哪些设计

这里只吸收与本项目直接相关的运行时思想，不复制其技术栈。

### 4.1 Durable Task → Durable Candidate

Comma 把长期任务状态从聊天 Session 中独立出来。

对应到本项目：

```text
Candidate / Trigger Cluster
= 一个长期存在的研究对象
```

建议未来每个 Candidate 至少持有稳定身份和研究状态，例如：

```text
candidateId
variantVersion
clusterId
firstDiscoveredAt
stage
t0
evidenceCursor
lastObservedAt
outcomeStatus
```

重点不是字段本身，而是这些事实不能依赖某次进程内存。

### 4.2 Background Loop → Source Watcher

长期观察不应该让 LLM 一直运行。

未来可以由普通 TypeScript / Node watcher 负责：

```text
Polymarket source
Binance Spot / Futures mark
FDV / project evidence
其他预先批准的数据源
        ↓
    cheap watch
        ↓
meaningful change?
   no       yes
   ↓         ↓
 sleep     wake judgment
```

AI 只处理高价值判断：

- 是否形成新 Candidate；
- 多源 evidence 是否冲突；
- Admission 是否满足；
- 是否出现缺证据；
- 新 evidence 是否改变研究判断。

### 4.3 Checkpoint → Research Checkpoint

Checkpoint 用来记录“研究推进到哪一步”，而不是缓存模型上下文。

例如：

```json
{
  "candidateId": "stable-id",
  "stage": "T0_FROZEN",
  "firstDiscoveredAt": "...",
  "t0": "...",
  "evidenceCursor": "...",
  "lastObservedAt": "..."
}
```

重启后从 durable checkpoint 继续，而不是重新发现、重新 Admission、重新生成 T0。

### 4.4 Wake → Evidence-triggered AI

AI 不负责持续在线。

只有以下事件才值得唤醒高成本判断：

- 新 Candidate 首次出现；
- Admission 所需证据齐备；
- 两个权威来源发生冲突；
- 关键 evidence 缺失或出现异常；
- T0 后规定观察窗口到期；
- Outcome 可以结算；
- 样本数量达到预注册 review gate。

### 4.5 Dedup / Reconciliation → 防止研究历史污染

未来每次 restart 后，应优先回答：

```text
durable state 里已经确认了什么？
外部世界现在观察到什么？
有哪些是新事实？
有哪些只是重复事件？
是否存在缺口？
```

再决定是否继续推进。

关键 invariant：

1. 同一 Candidate 不因进程重启变成新 Candidate。
2. `firstDiscoveredAt` 一旦成立不得后移。
3. T0 Freeze 后不得重新 Admission。
4. 已存在 raw artifact 不因 retry 被覆盖。
5. 历史缺失不能通过事后联网补抓伪装成 prospective evidence。
6. DATA_BLOCKED / NOT_ADMITTED 等研究结果不能因为重新运行而自动消失。

## 5. 与当前已有模块的边界

### 不修改

以下仍保持当前冻结口径：

- Strategy
- Risk
- Execution
- Position
- 已冻结的 Admission / Study Independence 规则
- 已归档 Candidate / Cluster 的历史结论
- 旧样本的 T0 与 raw evidence

### 可以在未来新增

如果真实研究需求触发，可独立增加：

```text
research-runtime/
  source-watchers/
  candidate-registry/
  checkpoint/
  evidence-ledger/
  admission-worker/
  tracking-worker/
```

这只是概念边界，不代表当前目录结构必须如此。

原则是：

> Research Runtime 可以给 Frozen Strategy 提供经过协议验证的输入，但不能反向修改 Strategy 的定义。

## 6. 与执行层 Recovery 的关系

这个方向和交易执行层的 Recovery 有共同抽象，但不能混成同一个状态机。

执行层关注：

```text
Submission
→ ACK
→ Fill
→ Position
→ Restart
→ Venue Reconciliation
```

研究层关注：

```text
Discovery
→ Admission
→ T0
→ Evidence
→ Restart
→ Research Reconciliation
```

共同问题都是：

> 动作或事实已经发生后进程突然退出，重新启动时如何避免重复执行、覆盖历史或把旧事实误认成新事实？

因此可以复用设计思想：

- stable identity；
- append-only evidence；
- checkpoint；
- dedup；
- recovery；
- reconciliation；
- bounded retry。

但权威来源不同：

- Execution 以 venue / exchange authoritative facts 为主；
- Research 以 frozen protocol + archived raw evidence 为主。

## 7. 为什么暂时不吸收 Comma 的其余复杂度

当前不需要：

- Elixir / OTP 迁移；
- C / eBPF background loop；
- Lean / TLA+；
- 通用 Agent Swarm；
- 自动异构模型路由；
- Personal Agent UI；
- 支付 / 身份代理；
- 给交易执行层增加长期自主写权限。

这些都不是当前 Strategy Lab 的最小问题。

第一阶段如果未来启动，只需要验证四件事：

```text
stable Candidate identity
+ durable checkpoint
+ restart recovery
+ evidence dedup
```

这四项成立后，再判断是否真的需要 source watcher、AI wake、multi-source verifier 或多 Agent。

## 8. 重新打开这个方向的触发条件

满足以下任一真实条件时，才从 Future Research 进入设计/实现：

1. prospective collector 需要跨天、跨重启持续运行；
2. restart 导致 Candidate 重复、T0 漂移或 evidence 重复；
3. 多数据源需要长期独立采集后再交叉验证；
4. Candidate / Cluster 数量开始积累，人工维护状态明显不可靠；
5. Outcome 必须等待数天或数周，现有一次性脚本无法可靠续跑；
6. AI 判断成本开始显著高于普通 watcher，需要“事件触发才唤醒”；
7. 新 variant 明确需要长期研究，但 Frozen Core 不应被重新打开。

如果没有这些证据，就继续保持 DEFER。

## 9. 最终边界

这个方向的目标不是：

> 做一个更复杂、更自主的 AI 交易机器人。

而是：

> **让 Strategy Lab 成为一个能够长期、可恢复、可审计地积累 prospective evidence 的研究系统。**

最终结构应保持：

```text
Durable Research Runtime
        ↓
verified / frozen research facts
        ↓
Frozen Strategy Core
        ↓
Risk
        ↓
Execution
        ↓
Position
```

研究层负责“事实从哪里来、有没有偷看未来、研究进行到哪里”。

Frozen Core 负责“给定这些事实，系统如何表达交易意图并执行”。

两者不混在一起。
