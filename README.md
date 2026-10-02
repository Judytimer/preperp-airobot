# Monad / Perpl 永续合约执行实验

> 基于现有永续合约交易核心（Perp Trading Core），验证自动交易系统从 CEX 迁移到 Monad / Perpl 后，执行语义（Execution Semantics）、恢复（Recovery）与对账（Reconciliation）如何变化。

这个分支不是新的量化机器人，也不是为了 Monad 重写策略（Strategy）。

它要验证的是：

```text
Existing Perp Trading Core
        ↓
Perpl / Monad Adapter
        ↓
DEX Execution Semantics
        ↓
Failure / Recovery / Reconciliation
```

核心问题只有一个：

> **当交易场所（Venue）从 CEX 变成 Monad 上的 Perp DEX 时，本地交易意图（Trading Intent）如何安全收敛为外部权威事实（Authoritative Trading Fact）？**

---

## 为什么做这个分支

主项目已经围绕永续合约交易工程（Perpetual Futures Trading Engineering）建立了这些核心能力：

- 订单生命周期（Order Lifecycle）
- 订单身份（Order Identity）
- 仓位 / 预计仓位（Position / Projected Position）
- 确定性风控（Deterministic Risk）
- 逐仓保证金（Isolated Margin）
- 恢复（Recovery）
- 对账（Reconciliation）
- 外部权威事实来源（External Source of Truth）

在 CEX 中，典型执行链可以概括为：

```text
Command
→ ACK
→ Fill
→ Position
```

迁移到 Monad / Perpl 后，最先需要重新验证的不是策略，而是执行边界（Execution Boundary）：

```text
Trading Intent
→ Protocol Request
→ Order / Execution State
→ Authoritative Venue Fact
→ Local State Convergence
```

本分支将这个问题暂时概括为：

## 意图—事实鸿沟（Intent–Fact Gap）

> **发出了交易意图（Intent），不等于外部资金事实（Fact）已经按预期发生。**

这只是本项目的设计命题（Design Thesis），不是行业标准术语。

---

## 整体架构

策略和 AI 继续主要运行在链下（Off-chain），Monad / Perpl 负责真实执行语义。

```text
链下（Off-chain）
────────────────────────────

Strategy / Prediction Overlay
AI Shadow
Deterministic Risk
Projected Position

        ↓

Trading Intent

        ↓

执行边界（Execution Boundary）
────────────────────────────

Perpl Adapter

        ↓

Monad / Perpl
────────────────────────────

Order
Change
Cancel
Fill
Position
Margin
Liquidation

        ↓

Authoritative State

        ↓

链下（Off-chain）
────────────────────────────

Order Tracker
Position Mirror
Recovery
Reconciliation
```

AI Shadow 继续保持只读 / 研究边界（Review-only Boundary）：

- 可以解释异常；
- 可以分析执行证据（Execution Evidence）；
- 不能直接拥有交易权限；
- 不能替代协议事实（Protocol Fact）；
- 不能直接决定恢复交易。

---

## 哪些能力继续复用（KEEP）

原则上继续复用主项目现有能力：

```text
Strategy
AI Shadow
Deterministic Risk
Position / Projected Position
Isolated Margin
Checkpoint
Recovery
Reconciliation
```

这个分支的健康目标是：

```text
latest Trading Core
+
thin Monad / Perpl delta
```

也就是：**尽量只增加 Monad / Perpl 必需的那一层，而不是重新长出第二套 Trading Core。**

---

## 哪些地方必须变化（CHANGE）

真正需要重新验证的是执行场所适配（Venue Adaptation）和身份映射（Identity Mapping）。

### CEX 常见模型

```text
clientOrderId
→ submit
→ ACK
→ exchangeOrderId
→ Fill
```

### Perpl 当前接口语义

Perpl 当前官方接口中：

```text
rq
= strictly increasing request ID
= idempotency key

sn
= client-provided non-zero sequence
→ echoed by server as cid
```

因此本项目不会把内部的 `clientOrderId` 直接重命名成 `rq`。

更合理的边界是：

```text
Internal Trading Identity
        ↓
Perpl Adapter
        ├─ rq
        ├─ sn / cid
        └─ protocol order identity
```

也就是：

> **核心领域身份（Core Domain Identity）继续由 Trading Core 持有，Perpl Adapter 负责协议身份翻译（Venue Identity Mapping）。**

---

## 外部权威状态（External Source of Truth）

这个分支不会为了“更 Web3”而自己重做完整链上状态机（Blockchain State Machine）。

Perpl 已经提供认证后的 WebSocket 状态流（Authenticated WebSocket State Stream）。

建立连接后可以获得：

```text
WalletSnapshot
OrdersSnapshot
PositionsSnapshot
```

后续通过：

```text
Command Status
Order Updates
WalletFills
```

持续维护交易状态。

因此第一阶段主要使用：

```text
Perpl Snapshots
+
Order Updates
+
Fills
        ↓
Local Mirror
        ↓
Reconciliation
```

原始交易回执 / 终局性引擎（Raw Transaction / Finality Engine）暂不进入第一阶段。

---

## 第一条真实故障（First Real Failure）

本分支不为了“增加难度”人为制造复杂系统。

第一阶段只验证一个 Perpl 官方已经公开记录的 Monad 特有执行问题（Monad-specific Execution Failure）：

```text
Cancel
        ↓
separate Post transaction
        ↓
cancel 对应的 margin release 尚未完成
        ↓
new Post 做 balance / margin check
        ↓
AmountExceedsAvailableBalance
```

Perpl 官方开发建议明确指出：

- 分开的 `Cancel → Post`（two transactions）是脆弱模式；
- 问题不是简单“多等一会儿”（wait longer）；
- 更优方向是修改订单（`Change`）；
- 如果必须 cancel + post，应放在同一笔交易（same transaction / batch）中。

这个 Failure 的价值不在于“Monad 很复杂”，而在于它直接检验：

> **Trading Core 会不会错误地把“已经发出 Cancel”当成“保证金已经释放、旧订单已经消失”。**

---

## 与主项目的关系

这个问题与主项目长期研究的以下主题属于同一条业务主线：

```text
Ghost Order
Cancel / Fill Race
Order Identity
Projected Position
Recovery
Reconciliation
External Source of Truth
```

区别在于：

```text
CEX
→ exchange-side execution uncertainty

Monad / DEX
→ protocol / asynchronous execution uncertainty
```

所以 Monad 分支不是离开永续合约交易开发去“重新学 Web3”。

它是在同一套 Perp Trading Core 上验证：

> **交易场所发生变化以后，哪些业务不变量（Invariant）仍然成立。**

---

## 保证金（Margin）

当前继续使用逐仓保证金（Isolated Margin）。

Perpl 当前官方文档明确采用 isolated margin：

- 每个仓位（Position）有自己的保证金；
- 账户空闲余额不会自动为其他仓位补充保证金；
- 当前没有已确认上线的 Cross Margin。

因此：

```text
KEEP Isolated Margin
DEFER Cross Margin
```

只有未来接入真实使用全仓保证金（Cross Margin）的 Venue 时，才让真实协议差异推动新的抽象。

---

## 第一阶段里程碑（First Milestone）

第一阶段不追求完整 DEX Trading Platform。

只完成：

```text
1. Perpl authentication / connection

2. Internal identity
   ↔ rq / sn / cid / protocol identity mapping

3. Initial snapshots

4. One real Order Lifecycle

5. Cancel → independent Post failure

6. Change / atomic operation comparison

7. Recovery / Reconciliation
```

成功标准不是代码量，而是完整证明一次：

```text
Intent
→ Execution
→ Failure
→ Safe Halt
→ Authoritative Evidence
→ Reconciliation
```

---

## Demo 叙事

Hackathon Demo 不重点展示：

- 复杂 K 线 UI；
- 新交易策略；
- AI 猜涨跌；
- 完整交易终端。

重点展示：

```text
Trading Intent created
        ↓
Execution enters uncertain state
        ↓
Local system refuses to invent venue truth
        ↓
Risk expansion is stopped
        ↓
Perpl authoritative state arrives
        ↓
Reconciliation
        ↓
Trading Core returns to a known-safe state
```

核心问题是：

> **自动交易系统如何避免把自己的意图（Intent）错当成资金事实（Financial Fact）。**

---

## AI Shadow 的角色

AI 在这个分支里可以读取：

```text
Execution Trace
Position
Margin
Protocol Evidence
Reconciliation Report
```

并解释：

- 为什么系统进入暂停（HALT）；
- 哪个业务不变量（Invariant）被破坏；
- 当前是否存在未解决风险敞口（Unresolved Exposure）；
- 还缺什么执行证据（Execution Evidence）。

但：

```text
ALLOW
HALT
RECOVERY_REQUIRED
```

仍由确定性规则（Deterministic Rules）和协议事实（Protocol Facts）决定。

一句话：

> **AI 负责调查（Investigate），协议事实负责裁决（Decide）。**

---

## Monad Metropolis 定位

这个项目不把自己描述成：

> AI Trading Bot on Monad

当前更准确的定位是：

> **在 Monad 上验证自动化永续合约交易的执行安全（Execution Safety），并使用 Perpl 作为真实协议场景。**

更进一步的叙事是：

```text
AI / Strategy
creates Intent

Monad
executes finance at high speed

Trading Core
must safely converge Intent
into verifiable financial Fact
```

“通用自主金融基础设施（Autonomous Finance Infrastructure）”目前仍然只是愿景，不是已经完成的产品能力。

---

## 范围边界（Scope）

### 本阶段包含（In Scope）

```text
Perpl Adapter
Identity Mapping
Order Lifecycle
Execution Failure
State Snapshot
Recovery
Reconciliation
Minimal Demo
```

### 本阶段暂缓（DEFER）

```text
Cross Margin
Multi-DEX Framework
Raw Finality Engine
New Strategy
Complex Frontend
Generic Agent Platform
MCP / Multi-Agent Orchestration
Event Sourcing Rewrite
```

原则：

> **没有真实 Failure 或协议约束，就不增加复杂度。**

---

## 当前状态（Current Status）

已完成：

```text
✓ hackathon/monad branch
✓ Monad / Perpl 方向冻结
✓ Perpl API / WebSocket 事实核查
✓ Isolated Margin 语义核查
✓ rq / sn / cid 身份语义核查
✓ authoritative snapshot 路径核查
✓ Cancel → Post Failure 官方证据核查
```

下一阶段：

```text
Perpl Integration Reality Check
        ↓
Minimal Adapter
        ↓
One Order Lifecycle
```

---

## 参考资料（References）

- [Perpl Developer Docs](https://docs.perpl.xyz/)
- [Perpl API Docs](https://github.com/PerplFoundation/api-docs)
- [Monad Developer Docs](https://docs.monad.xyz/)
- [Monad Metropolis](https://monad.xyz/metropolis)

---

## 一句话

> **把交易智能（Trading Intelligence）留在链下，把执行适配到 Perpl，并证明机器人永远不会把自己的交易意图（Intent）误认为外部权威资金事实（Authoritative Financial Fact）。**
