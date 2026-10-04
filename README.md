# Perp AI Trading Bot

一个基于 TypeScript + Node.js 的永续合约交易工程项目，覆盖 **paper trading、Binance Futures Testnet、执行可靠性研究与 AI 辅助策略评估**。

这个项目不是一个“只会跑策略 Demo”的量化机器人。

它重点解决的是永续合约交易系统里更接近真实工程的问题：

- 异步订单生命周期：`Submit → ACK → Partial Fill → Fill / Cancel`
- Fill 延迟期间的预计仓位与重复下单问题
- Partial Fill、乱序事件与 Fill 幂等
- Isolated Margin、Mark Price、Maintenance Margin 与模拟强平
- 本地状态持久化、异常重启与订单恢复
- 本地状态与交易所权威状态的 Reconciliation
- Binance USDⓈ-M Futures Testnet 接入
- AI Shadow Reviewer：AI 可以辅助判断，但不能直接控制真实交易执行
- Historical Replay：用于验证策略假设，而不是事后包装收益

当前默认模式仍然是 **Paper Trading / Binance Futures Testnet**。  
仓库当前主线不启用真钱自动交易；在 Paper / Testnet 工程闭环稳定后，项目允许进入受控的 **小额真实资金验证（Live Micro-Capital Validation）**，用于验证模拟环境难以完全覆盖的真实交易行为。

小额真实资金验证的目标是验证关键业务假设，而不是把研究系统包装成生产级实盘系统。即使完成真实资金验证，项目也不会因此宣称具备 7×24 无人值守、高可用、机构级风控或大资金安全能力。

---

## 架构

```text
Market
  ↓
Strategy
  ↓
Risk Manager
  ↓
Execution Command
  ↓
Exchange / Simulator
  ↓
ACK / Partial Fill / Fill / CancelAck
  ↓
Order Tracker
  ↓
Position / Margin
  ↓
Checkpoint
  ↓
Reconciliation
```

AI Research Path 与交易执行链保持隔离：

```text
Strategy Candidate
  ↓
AI Shadow Reviewer
  ↓
PASS / WOULD_BLOCK / ABSTAIN
  ↓
Research Record

        ✕
不会直接修改真实交易执行
```

---

## 工程亮点

### 1. 异步订单生命周期

订单不是 `submit()` 成功就等于成交。

Core 将交易命令和交易事件分开建模：

```text
SUBMITTED
  ↓
ACKED
  ↓
PARTIALLY_FILLED
  ↓
FILLED
```

撤单同样必须等待交易所事件确认：

```text
ACKED / PARTIALLY_FILLED
  ↓
CANCEL_REQUESTED
  ↓
CancelAck
  ↓
CANCELED
```

REST 请求成功不会被直接当成 ACK，Fill 和 CancelAck 只通过 execution event 推进订单状态。

---

### 2. 预计仓位（Projected Position）

真实交易中，订单提交以后到 Fill 到达之前存在时间窗口。

如果只根据已成交仓位计算风险，机器人可能在 Fill 延迟期间重复下单。

因此风控使用：

```text
Projected Position
=
Filled Position
+
Unresolved Order Remaining Qty
```

Partial Fill 后只计算剩余未成交数量，不会重复计算整张原始订单。

---

### 3. 部分成交与幂等

系统显式处理：

- Partial Fill
- 延迟 Fill
- Fill-before-ACK 异常
- 重复 Fill
- 乱序事件
- 跨零仓位更新

有效 Fill 会进入 checkpoint 的幂等集合，避免重启或事件重放造成重复加仓。

---

### 4. 逐仓保证金与强平模型

行情区分：

```text
lastPrice
markPrice
indexPrice
```

其中：

- Strategy / simulated execution 使用 `lastPrice`
- Unrealized PnL / Margin / Liquidation 使用 `markPrice`
- `indexPrice` 仅作为外部参考输入

系统实现最小逐仓模型：

```text
Position
→ Initial Margin
→ Maintenance Margin
→ Equity
→ Liquidation Trigger
```

当前 paper model 为了保持边界清晰，模拟强平价格直接使用 mark price，不宣称复刻真实交易所清算引擎。

---

### 5. 检查点与故障关闭恢复（Checkpoint / Fail-Closed Recovery）

Core 将以下状态原子写入：

```text
.runtime/perp-bot-state.json
```

包括：

- client order identity
- order sequence
- position
- order state
- processed fills
- funding events

如果程序重启时存在 unresolved order：

```text
SUBMITTED
ACKED
PARTIALLY_FILLED
CANCEL_REQUESTED
```

系统不会猜测订单最终状态，而是进入：

```text
RECOVERY_REQUIRED
```

并停止继续下单。

---

### 6. 对账与状态收敛（Reconciliation）

恢复时，本地状态不能直接假设自己是正确的。

系统支持只读比较：

```text
Local Position
vs
Exchange Position

Local Open Orders
vs
Exchange Open Orders
```

检测：

- position mismatch
- missing order
- unexpected order
- remaining quantity mismatch

当前版本采取 **fail-closed**：

发现不一致后停止交易，不自动覆盖本地状态，也不擅自重发订单。

---

### 7. Binance Futures Testnet

项目提供 Binance USDⓈ-M Futures Testnet adapter。

策略和 Core 不依赖 Binance SDK，adapter 只负责：

```text
Market Data
Order Submit
Order Cancel
User Data Stream
Exchange Event Translation
```

交易所事件会被翻译为项目内部统一事件：

```text
ACK
Fill
CancelAck
```

Testnet runner 要求：

- One-way Mode
- BTCUSDT
- Isolated Margin

REST 下单请求关闭自动 retry，避免网络超时情况下生成潜在重复订单。

---

### 8. AI 影子评审（AI Shadow Reviewer）

AI 当前不是交易决策者。

它只能在独立 Shadow Path 中对策略 Candidate 做研究性判断：

```text
PASS
WOULD_BLOCK
ABSTAIN
```

但 Shadow 结果不能：

- 修改原 Strategy Signal
- 修改 Risk Decision
- 阻止确定性退出逻辑
- 直接生成 Perp Order
- 直接控制交易所

这是刻意设计的权限边界：

> 先验证 AI 有没有稳定的信息增益，再讨论是否允许它影响交易。

---

### 9. 历史回放（Historical Replay）

Historical Replay 用于验证策略判断，而不是制造“AI 好像预测成功”的案例。

每个案例明确记录：

```text
T0
Input Provenance
Ground Truth Rule
Outcome Window
Baseline Result
Shadow Result
```

并区分：

```text
DEMO
QUALITATIVE_ONLY
FORMAL
```

只有满足：

- T0 前已存在的输入
- 可验证的历史原始数据
- 预先定义的 Ground Truth
- 可测量 Outcome

才允许进入 `FORMAL`。

这可以避免典型的 hindsight bias：

> 事件发生以后重新搜资料，再声称 AI 当时能够判断出来。

---

## 快速开始

### 环境

```text
Node.js 22+
npm
```

项目使用 Node.js `--experimental-strip-types`，无需额外 TypeScript 编译步骤。

安装依赖：

```bash
npm install
```

运行默认 paper bot：

```bash
npm start
```

运行完整工程 Demo：

```bash
npm run demo
```

Demo 会展示：

```text
Market Tick
→ Signal
→ Risk
→ Submit
→ ACK
→ Partial Fill
→ Fill
→ Position
→ Margin
→ Checkpoint
→ Reconciliation
```

---

## 测试

```bash
npm test
```

测试覆盖核心交易边界，包括：

- Signal → Order → ACK → Fill
- Projected Position
- Partial Fill
- Fill idempotency
- Out-of-order Fill
- Target position delta
- Cross-zero position
- Margin validation
- Liquidation path
- Checkpoint recovery
- Reconciliation

---

## Binance Futures Testnet

无 API Key 时可以先运行只读行情：

```bash
npm run testnet:market
```

配置 Binance Futures Testnet：

```powershell
$env:BINANCE_TESTNET_API_KEY = "..."
$env:BINANCE_TESTNET_API_SECRET = "..."
npm run testnet
```

Testnet 使用独立 checkpoint：

```text
.runtime/binance-testnet-state.json
```

运行结束后会获取交易所权威：

```text
Position Snapshot
Open Orders Snapshot
```

并执行一次只读 reconciliation。

出现以下异常时系统保持 fail-closed：

- submit timeout
- Fill-before-ACK
- user-data disconnect gap
- local / exchange mismatch

### 联合收官冒烟（Joint Closure Smoke）

联合收官冒烟在同一次运行中并行验收 authenticated Binance execution 与真实 Laya Shadow：

可以复制 `.env.example` 为本地 `.env` 后填入配置；`.env` 已被 Git 忽略。若不创建 `.env`，也可以继续使用当前 PowerShell 会话的环境变量：

```powershell
$env:BINANCE_TESTNET_API_KEY = "..."
$env:BINANCE_TESTNET_API_SECRET = "..."
$env:LAYA_BASE_URL = "http://127.0.0.1:8000"
# 仅当 Laya endpoint 要求认证时设置：
$env:LAYA_API_KEY = "..."
npm run smoke:closure
```

启动时，closure 入口会读取 Binance Futures Testnet 的公共 server time，用请求中点估算偏移，并且只在当前 Node 进程内兼容签名时间；它不会修改 Windows 系统时间，也不会放宽 `recvWindow`。时间接口失败、往返时间异常或偏移超出安全边界时均 fail closed，不开始 authenticated execution。

该入口在任何 market tick 进入 `PerpBot` 前要求本地/venue reconciliation 一致、双方 Position 均为 FLAT、venue 无 open order 且 `recoveryRequired=false`；失败时不会撤单、平仓、删除 checkpoint 或自动修复。它使用固定 Mock Evidence 调用真实 `/v1/systemone`，不连接 Search，也不允许 Shadow verdict 进入 Binance signal/risk/order decision。首个 Fill 只停止继续转发 market tick；user-data stream 会保留到剩余 Fill、Position 持久化和最终 reconciliation 完成。`LAYA_BASE_URL` 缺失或真实 endpoint 不可用时，`CLOSURE_REPORT.realLaya` 明确为 `FAIL`，不会回退到 fake provider。

---

## 策略

### 执行基线

项目保留简单 Moving Average Strategy 作为：

```text
baseline
control
execution pressure generator
```

它的职责不是证明交易 Alpha，而是稳定地产生交易行为，用来压力测试：

```text
Risk
Order Lifecycle
Partial Fill
Position
Margin
Recovery
Reconciliation
```

---

## AI 策略研究

上层研究命题现在明确区分为：

```text
Strategy Thesis
Cross-Market Repricing Lag
        ↓
Current Concrete Variant
Crypto FDV Prediction Overlay
        ↓
Current Formal Batch
Strategy Lab v2.1
```

这里的上层假设是：当底层市场已经对新信息产生明显重新定价时，与同一经济命题相关的 Prediction Market 可能存在概率重新定价滞后；如果这种滞后存在，可以研究是否用固定最大亏损的 Prediction YES 暴露替代继续追高底层资产。

**当前仓库真正实现并冻结验证的仍然只是 Crypto FDV Variant。** 历史类名 `MemePredictionOverlayStrategy` 保留，不代表 Meme 是整个 Strategy Thesis 的永久资产限制；FDV、Binance Spot、Polymarket 与 1m cadence 也属于当前具体 Variant / Formal Batch 的边界，不应外推成所有未来研究对象的定义。

当前具体实现中，当 Crypto asset 已明显上涨时，策略不会继续追高现货，而是在固定最大风险预算下模拟购买更高 FDV 目标对应的 Prediction YES。

Prediction Market 与 Perpetual Futures 保持独立业务语义，不存在：

```text
YES → Perp LONG
NO  → Perp SHORT
```

当前 AI 只运行于 Shadow Mode。

运行：

```bash
npm run overlay
```

这条链复用现有 `OrderRequest -> SimulatedExchange -> ACK -> Pending -> Fill`，并使用 Prediction 专用策略、风险与 long-only YES 仓位账本。`BUY_YES` Candidate 启动 `ShadowRunner` 后会立刻继续原 Risk / Execution，不等待 Shadow；Runner 在独立的 fire-and-continue 路径中执行 `deterministic ResearchPlan -> async EvidenceSearch -> async LlmStrategyReviewer -> ShadowRecord`。Candidate 是 defensive clone/deep-freeze 的 T0 输入，Runner 不读取 Bot 当前价格、持仓或后续 snapshot。普通 `npm run overlay` demo 仍使用 fake provider ports；联合收官冒烟单独使用 Mock Evidence 与真实 Laya endpoint，仍不连接真实 Search。

Historical Replay：

```bash
npm run replay
```

Strategy Lab 的正式 Candidate admission 已冻结为 `v1.0.0`：使用 **1 分钟完整收盘 K 线（1-minute fully closed candle）**，以上市后的第一根完整 K 线作为基线（baseline），FDV 由历史现货价格 × 已核验总供应量推导，Prediction YES 只取 `snapshot.ts` 之前最后已知值，不插值、不读取未来数据。PENGU 的逐笔/1 分钟差异保留为 `MICROSTRUCTURE_SENSITIVE` 方法诊断；由于完整原始数据证据（raw artifact）未归档，它不计作正式历史样本（FORMAL historical sample）。详见 [Strategy Lab 收尾记录](docs/research/strategy-lab-closeout.md)。

Historical Replay 是一个**有限的诊断阶段**，不是永久运行的研究主线。当前协议冻结后，主线转向 **Prospective Sampling（前瞻采样）**：只有未来样本暴露新的方法问题、数据泄漏或不可复现行为时，才重新打开历史研究，而不会为了增加样本数量持续寻找历史案例。

Prospective v1 没有产生正式样本，现已冻结并由 v2.1 取代。**v2.1 只定义当前 Crypto-FDV Variant 的 prospective batch，不定义整个 Cross-Market Repricing Thesis。** Prospective v2.1 允许已经在 Binance Spot 上线的加密资产；它以归档的 Polymarket Gamma 首次公开发现时间作为不可回填的边界，baseline 固定为该时间之后第一根完整 1m candle。Polymarket 市场开放时间只保留为证据字段。`npm run manifest:check -- path/to/candidate-v2.1.json` 只做 admission，输出 `DATA_READY / DATA_BLOCKED / INELIGIBLE`，不会抓行情、调用 Strategy 或触发交易。详见 [Strategy Lab v2.1 Prospective Manifest](docs/research/prospective-manifest-v2.md)。

`npm run prospective:discover` 执行一次最小只读发现：查询公开且免认证的 Polymarket Gamma 最新 100 个未关闭市场，归档完整原始响应，并为每个 marketId 只写一次不可覆盖的 first-discovery record。明确出现 `FDV` 或 `fully diluted valuation/value` 的市场只标记为 `POTENTIAL_FDV_REVIEW`；它不会自动填 supply、改变 Strategy 或进入 Risk/Paper/Shadow。默认证据目录是被 Git 忽略的 `work/prospective-v2.1/discovery`。

归档首次发现、Binance Kline 与 Polymarket last-trade 的真实 raw artifacts 后，`npm run strategy-lab:replay -- candidate-v2.1.json observation-v2.1.json reports/prospective-v2.1` 执行 Formal v2.1 链路并原子保存报告。Runner 会从 raw artifact 重新解析完整 candle / YES 序列，并要求它们与 observation 审计副本逐项一致；手填数组不能独立成为正式输入。Execution assumption 仍为独立的 `v1.0.0`：主结果双向不利 50 bps、0/100 bps 敏感性、零 fee、全量成交限制。`NO_CANDIDATE` 不触发 Risk/Paper/Shadow；Candidate 才运行原 Risk 与 Paper，Laya 不可用时明确记录失败且不阻塞 Paper。固定 bps 是压力测试，不代表真实盘口可成交价。

冻结评价时间之后，`npm run prospective:outcome -- <report.json> <resolution-artifact.json>` 从归档的 Polymarket `market_resolved` raw event 推导 YES/NO，并写入独立、不可覆盖的 `<report>.outcome.json`；它不会回写 T0 报告，也不接受手填 verdict。

---

## 仓库结构

```text
src/
├─ bot.ts
├─ strategy.ts
├─ risk.ts
├─ exchange.ts
├─ order-tracker.ts
├─ position.ts
├─ margin.ts
├─ state-store.ts
├─ reconciliation.ts
├─ recovery-evidence.ts
├─ binance-testnet.ts
├─ closure-smoke.ts
├─ historical-replay.ts
├─ overlay/strategy-lab.ts
└─ logging.ts
```

核心入口：

- `src/bot.ts` — trading loop orchestration
- `src/exchange.ts` — execution command/event boundary
- `src/order-tracker.ts` — in-flight order lifecycle
- `src/position.ts` — position accounting
- `src/margin.ts` — isolated margin model
- `src/state-store.ts` — checkpoint persistence
- `src/reconciliation.ts` — local/exchange reconciliation
- `src/binance-testnet.ts` — Binance Futures Testnet adapter
- `src/closure-smoke.ts` — authenticated Binance + real Laya joint closure smoke
- `src/historical-replay.ts` — historical research runner
- `src/overlay/strategy-lab.ts` — frozen 1m Candidate admission protocol

---

## 设计与实验文档

README 只描述**当前系统形态**。完整设计依据、故障案例、AI 研究方法和后续路线统一从：

- [docs/README.md](docs/README.md) — 文档阅读地图

进入。

文档按“当前稳定判断 → 真实故障证据 → AI 研究 → 延期设计 → 历史归档”分层，避免把早期实验结论和当前实现混在一起。

---

## 当前边界

这个项目目前定位为：

> **永续合约交易工程研究机器人（Perpetual Futures Trading Engineering Research Bot）**

重点是交易执行可靠性、状态一致性、恢复边界以及 AI 辅助交易架构。

当前验证层级：

| 验证层级 | 当前状态 | 目标 |
| --- | --- | --- |
| 模拟盘 / 测试网（Paper / Testnet） | 当前主线 | 验证策略、订单生命周期、仓位、保证金、恢复与对账 |
| 小额真实资金验证（Live Micro-Capital Validation） | 下一阶段，尚未完成 | 用受控小额资金验证真实 API、ACK / Fill、手续费、资金费和交易所权威状态 |
| 生产级实盘（Production-grade Live Trading） | 非当前项目范围 | 需要进一步具备高可用、完整监控、事故恢复、资金安全与长期无人值守能力 |

当前明确不包含：

- 生产级实盘交易（Production-grade Live Trading）
- 交易所级高可用（Production-grade Exchange HA）
- 完整回测引擎（Full Backtesting Engine）
- 交易所强平引擎复刻（Exchange Liquidation Engine Replication）
- 自动对账修复（Automatic Reconciliation Repair）
- AI 自主交易（AI Autonomous Trading）
- 已证明盈利的策略（Proven Profitable Strategy）

### 真实资金验证边界

项目后续可以进入 **小额真实资金验证（Live Micro-Capital Validation）**，但必须与生产级实盘严格区分。

它只用于验证：

- 真实交易所 API 行为
- 真实 ACK / Partial Fill / Fill 时序
- 实际成交价、手续费（fee）与资金费（funding）
- 交易所权威仓位（exchange-authoritative position）
- 重启后的恢复（recovery）与对账 / 状态收敛（reconciliation）

即使这些验证全部完成，也只说明核心交易链路在受控的小额真实环境下被验证过，不代表系统已经达到生产级实盘强度。

这些边界是刻意保留的。

项目首先证明的是：

> **在 AI Coding 能快速生成代码之后，如何把交易业务语义、状态一致性、异常恢复和 AI 权限边界真正落实到一个可运行系统里。**
