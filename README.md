# Perp AI Trading Bot

本地只读运行控制台：[desktop/README.md](desktop/README.md)。它会监督 prospective watcher，并把 `QUALIFIED Candidate → 本地 Laya Shadow Review → 不可变 evidence → 前端状态` 串成闭环，但不暴露任何交易权限。

> TypeScript + Node.js 的永续合约交易执行工程项目。重点不是展示复杂策略，而是验证 **订单事实、仓位一致性、故障恢复和 AI 权限边界** 能否真正落到一个可运行系统里。

## 这个项目解决什么问题

一个交易机器人真正危险的地方，往往不是“策略没信号”，而是：

```text
订单发出但结果未知
ACK 与 Fill 不同步
Partial Fill 后继续重复下单
CancelAck 后又收到迟到成交
程序重启后本地状态与交易所不一致
AI 给了判断，但它是否有资格控制真实下单
```

这个项目围绕这些问题构建最小但可验证的永续交易执行核心。

---

## 当前做到什么

### 1. Paper Core

```text
Market
→ Strategy
→ Risk
→ Submit
→ ACK
→ Partial Fill / Fill
→ Position
→ Margin
→ Checkpoint
→ Reconciliation
```

覆盖异步订单生命周期、Partial Fill / delayed Fill、fillId 幂等、Projected Position、Cross-zero Position、Isolated Margin / Mark Price / Maintenance Margin、fee / funding / realized PnL、checkpoint / restart 与 reconciliation。

### 2. Binance Futures Testnet

已经完成真实认证测试网闭环：

```text
FLAT
→ LONG 0.001 BTC
→ ACK / Fill
→ FLAT
→ ACK / Fill
→ authoritative Position = FLAT
→ open orders = 0
→ reconciliation consistent
```

此外，真实 `MovingAverageSignal(3,6)` 已经可以直接驱动同一套执行核心进入 Binance Testnet：

```text
real market ticks
→ MA Signal
→ Risk
→ Order
→ ACK / Fill
→ Position
→ deterministic FLAT cleanup
→ final reconciliation
```

这里验证的是 **Strategy → Execution 的工程链路**，不是策略 alpha。

Prediction 小时信号也已完成一次真实自动 Testnet smoke：

```text
Polymarket BTC Up/Down
→ prospective DOWN Candidate（YES ask 0.44）
→ TESTNET_DEMO_ONLY SHORT BTCUSDT 0.001
→ ACK / Fill
→ deterministic reduce-only FLAT
→ authoritative position = FLAT / open orders = 0
→ reconciliation PASS
```

这笔测试只证明 Prediction Candidate 能自动驱动测试网闭环；它不把一次 DOWN 信号解释为已验证 alpha。

### 3. AI Shadow

AI 运行在独立 Research Path：

```text
Candidate
→ AI Shadow Reviewer
→ PASS / WOULD_BLOCK / ABSTAIN
→ Research Record
```

AI 不能绕过 deterministic Risk、直接生成真实订单、自行提高仓位 / 杠杆，也不能把 Prediction YES 自动解释成 Perp LONG。

---

# 三个最核心的工程判断

## 1. Intent 不是 Fact

```text
submit() ≠ ACK
cancel request ≠ CancelAck
local terminal state ≠ 未来不会再收到权威 execution fact
```

项目将命令与交易所事件分开建模，并通过真实 Failure 修正过订单终态行为。

### Late Fill Failure

```text
ACKED
→ Fill 0.004
→ CANCEL_REQUESTED
→ CancelAck / CANCELED
→ unique late Fill 0.003
```

旧实现会静默拒绝最后一笔真实成交，导致 exposure 少记。修复后：

```text
filledQty = 0.007
status = CANCELED
getOpenOrders() = 0
```

也就是说：生命周期仍然结束，但成交账本允许被更晚到达的权威事实修正。

完整案例：[`docs/cases/order-tracker-late-fill.md`](docs/cases/order-tracker-late-fill.md)

---

## 2. Position 不是全部 Exposure

ACK 到 Fill 之间，真实仓位还没变，但订单已经在路上。

```text
Projected Position
=
Filled Position
+
Unresolved Order Remaining Qty
```

Risk 读取 projected exposure，避免 Fill 延迟或 Partial Fill 期间重复下单。

---

## 3. Unknown Result 不能当 Failure 重试

```text
submit timeout
≠
exchange definitely rejected
```

当前实现会在提交前持久化 client order identity，并关闭认证下单的盲目 retry。

运行期 ambiguous submit 的自动查询与自动收敛还没有完整实现；当前明确完成的是重启后的 fail-closed 边界。重启后如果 checkpoint 里仍有 unresolved order，系统进入：

```text
RECOVERY_REQUIRED
```

随后可以只读比较：

```text
Local Position / Open Orders
vs
Exchange Position / Open Orders
```

发现不一致时不自动覆盖本地状态，也不擅自重发订单。

---

## 架构

```text
                 ┌──────── AI Research Path ────────┐
                 │ Candidate → Shadow → Record      │
                 │              ✕                   │
                 │       cannot control Execution   │
                 └──────────────────────────────────┘

Market
  ↓
Strategy
  ↓
Risk
  ↓
Execution Command
  ↓
Exchange / Simulator
  ↓
ACK / Fill / CancelAck
  ↓
Order Tracker
  ↓
Position / Margin
  ↓
Checkpoint
  ↓
Reconciliation
```

---

## 快速运行

要求：Node.js >= 22.12、npm。

```bash
npm install
npm start
npm run demo
npm run validate:perp
npm test
```

只读 Binance Testnet 行情：

```bash
npm run testnet:market
```

认证 Testnet 需要先配置 `BINANCE_TESTNET_API_KEY` 与 `BINANCE_TESTNET_API_SECRET`：

```bash
npm run validate:perp:testnet
```

MA Strategy 驱动 Testnet：

```bash
npm run testnet
```

Prediction 监控现在分成两条互不混淆的 lane：

- 日度 Price-Target：`BTC / ETH / SOL / XRP`
- 小时 Up/Down：`BTC / ETH / SOL / XRP / DOGE / HYPE / BNB`

小时 lane 按 Polymarket 合约写明的 Binance 1h candle 语义归档 UP/DOWN order book 和 Binance 1m 路径；只有价格穿越小时开盘价、对应方向 YES ask 不高于 50c，且存在新鲜的 pre-T0 book，才生成 Candidate。`UP → LONG`、`DOWN → SHORT` 只作为 `TESTNET_DEMO_ONLY` 的执行冒烟映射，不声明方向 alpha。

资产不是因为历史上出现过 Candidate 就永久写死；只有同时满足 Polymarket 存在相同语义的活跃合约、Binance 可提供决议行情、Binance Futures Testnet 可执行对应 USDT 永续时，才进入当前可执行池。

```bash
npm run price-target:watch
npm run smoke:prediction:testnet
```

`price-target:watch` 是当前唯一 watcher 进程入口，会同时运行日度 Price-Target 和小时 Up/Down 采集；Testnet consumer 只读取不可变 Candidate evidence，不启动第二个 collector。

桌面控制台会把预测市场、确定性 Candidate、Laya 旁路审核和 Binance Testnet 状态放在同一条中文可视化链路中：

```bash
npm run desktop:dev
```

---

## 关键代码

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
└─ testnet-index.ts
```

---

## 深入阅读

如果想看“为什么这么设计”，而不是只看功能：

1. [`docs/interview/README.md`](docs/interview/README.md)
2. [`docs/cases/order-tracker-late-fill.md`](docs/cases/order-tracker-late-fill.md)
3. [`docs/architecture/design-decisions.md`](docs/architecture/design-decisions.md)
4. [`docs/cases/perp-execution-validation.md`](docs/cases/perp-execution-validation.md)
5. [`docs/README.md`](docs/README.md)

Strategy Lab、Prospective Sampling、Directional Study 和 Future Research 继续保留在 `docs/`，不放进根 README 主叙事。

---

## 当前边界

当前项目是：

> **Perpetual Futures Trading Engineering Research Bot**

它不声称：

- 已证明可持续盈利
- 生产级 7×24 实盘
- 完整交易所清算引擎
- 完整自动 Recovery convergence
- 机构级 HA / 风控
- AI 自主交易

这个项目主要证明：

> **AI Coding 可以快速生成代码，但交易系统仍然需要人明确“什么是事实、谁是真相源、状态何时改变、失败后怎样收敛”，并用真实 Failure 与测试把这些判断固化下来。**
