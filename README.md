# PrePerp

**Prediction-Market Driven Perpetual Futures Testnet Bot**

PrePerp 持续采集 Polymarket 与 Binance 的真实公开数据，由确定性规则生成 prospective Candidate，再通过 Risk、订单生命周期和权威 reconciliation，在 Binance Futures Testnet 完成一次性自动交易闭环。中文 Tauri 桌面端负责观察和监督，本地 Laya 只做 Shadow Review，没有下单权。

> 这是一套交易工程与研究证据系统，不是盈利宣传，也不是已获授权的实盘机器人。

## 当前状态

| 能力 | 状态 |
|---|---|
| Paper execution core | `COMPLETE` |
| Binance Futures Testnet 基础闭环 | `PASS` |
| MA strategy → Testnet | `PASS` |
| Prediction Candidate → Testnet | `PASS` |
| 中文桌面控制台 | `AVAILABLE` |
| Mainnet / Micro-Capital | `DISABLED` |
| 可持续 alpha | `NOT CLAIMED` |

## 已跑通的 Prediction → Testnet 闭环

系统已经从持续运行的真实数据中自动捕获一个新的 BTC 小时级 `DOWN` Candidate，而不是手工注入历史样本：

```text
Polymarket: Bitcoin Up or Down - October 8, 7PM ET

hour open              81896.72
previous 1m close      81926.00
crossing 1m close      81896.01
archived DOWN YES ask  0.44

                 ↓ deterministic Candidate

TESTNET_DEMO_ONLY SHORT BTCUSDT 0.001
→ Exchange ACK
→ SELL Fill @ 81898.6
→ Position = SHORT 0.001
→ deterministic reduce-only FLAT
→ BUY Fill @ 81903.3
→ authoritative Position = FLAT
→ open orders = 0
→ reconciliation PASS
```

本地账本记录手续费 `0.06552075` Testnet USDT，realized PnL 为 `-0.07022075`。盈亏不参与本次验收；这次运行证明的是自动化链路，而不是方向 alpha。

详细供给、触发与边界记录见：[高流动性资产 × Prediction Market 供给审计](docs/research/high-liquidity-prediction-supply-2026-10-08.md)。

## 系统如何工作

```text
Polymarket Gamma / CLOB               Binance public market data
             │                                   │
             └───────────┬───────────────────────┘
                         ▼
              Prospective Watcher
              raw archive + checksum
                         │
                         ▼
              Deterministic Admission
                         │
                  QUALIFIED Candidate
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
      Laya Shadow Review       TESTNET_DEMO_ONLY
      evidence check only      same-asset mapping
      no trading authority            │
                                      ▼
                              Risk → Perp Order
                                      │
                                      ▼
                         Binance Futures Testnet
                                      │
                         ACK / Fill / Position
                                      │
                         deterministic FLAT
                                      │
                         authoritative reconciliation

           全链路状态 → Tauri 中文桌面控制台
```

核心边界是：

```text
AI judgment ≠ trading authority
submit() ≠ ACK
local state ≠ exchange fact
Prediction direction mapping ≠ proven alpha
```

## 当前监控范围

Prediction 监控分成两条独立 lane：

| Lane | 当前资产 | 研究对象 |
|---|---|---|
| Daily Price-Target | BTC / ETH / SOL / XRP | 固定日期价格阈值合约 |
| Hourly Up/Down | BTC / ETH / SOL / XRP / DOGE / HYPE / BNB | Binance 1h candle 方向合约 |

这 7 个小时级资产是审计时满足以下条件的真实交集，不是对所有高流动性币种的永久上限：

```text
Polymarket 有相同语义的活跃合约
+ Binance 有明确的 resolution data
+ Binance Futures Testnet 有对应 USDT perpetual
```

仅在 Binance 上成交活跃、但没有对应 Prediction contract 的资产，不会被伪造成策略信号。

### 小时 Candidate 的确定性规则

```text
UP:
previous 1m close < hour open <= current closed 1m close

DOWN:
previous 1m close >= hour open > current closed 1m close

AND
corresponding pre-T0 YES book freshness <= 120s
AND
best executable ask <= 0.50
```

未收盘 candle 会被忽略；缺少 pre-T0 book、时间边界或原始 artifact 时 fail closed。禁止 interpolation、未来数据和事后回填。

### 候选供给初测

```text
审计快照：47 个小时 episode / 7 个资产 / 约 24h 上架窗口
正式运行：43 个等待 episode，3 个当时活跃 episode
武装后约 10 分钟：1 个 qualified Candidate
```

这证明供给不再像 FDV Variant 那样稀疏，但样本仍不足以外推稳定日频。长期密度应按 `qualified Candidates / monitored asset-hours` 统计，并同时报告 active episode 与 `DATA_BLOCKED` 数量。

## 中文桌面控制台

桌面端位于 [`desktop/`](desktop/README.md)，技术栈为：

```text
Tauri 2
+ Rust local supervisor
+ React / TypeScript
+ TanStack Query
```

它在同一界面显示：

- 日度 Price-Target watcher；
- 小时 Up/Down watcher 与当前资产池；
- 最新 Candidate、T0、方向和 YES ask；
- 本地 Laya 服务与 Shadow Review；
- Binance Testnet consumer 状态；
- ACK、Fill、Position、FLAT 和 reconciliation 结果；
- 明确的 Mainnet / AI 权限边界。

Renderer 不能执行任意 shell 命令，也不接收交易所密钥。Rust host 只暴露固定命令，并监督唯一 watcher 与一次性 Testnet consumer。

## Testnet 安全边界

Prediction 驱动的 Testnet runner 必须满足：

- Candidate 在 consumer 武装之后自动产生；
- 不消费历史 Candidate 补单；
- One-way mode；
- 下单前 authoritative position 为 `FLAT`；
- open orders 为 `0`；
- 空仓时才允许切换为 Isolated；
- 使用每个资产预冻结的极小测试数量；
- 首个 entry Fill 后立即确定性退出；
- 最终必须 `FLAT + no open orders + reconciliation consistent`；
- 成功一次后自动停止。

小时 `UP → LONG`、`DOWN → SHORT` 只属于 `TESTNET_DEMO_ONLY_V1`。它用于证明信号可以驱动执行系统，不进入 Stage A/B，不授权 Mainnet，也不声称 Prediction→Perp directional edge。

## 交易执行核心

底层执行路径覆盖：

```text
Market
→ Strategy / Candidate Signal
→ Risk
→ Submit Command
→ Exchange ACK
→ Partial Fill / Fill
→ Position / Margin
→ Checkpoint
→ Restart / Recovery Boundary
→ Reconciliation
```

已经实现并测试：

- command 与 exchange fact 分离；
- Partial Fill、delayed Fill 与 fillId 幂等；
- Late Fill 对终态账本的权威修正；
- filled position + unresolved order 的 projected exposure；
- cross-zero position；
- isolated margin、mark price、maintenance margin；
- fee、funding 与 realized PnL；
- checkpoint、restart 与 `RECOVERY_REQUIRED`；
- unknown submit result 禁止盲目 retry；
- local / exchange position 与 open-order reconciliation。

典型案例：[CancelAck 后 Late Fill](docs/cases/order-tracker-late-fill.md)。

## 快速运行

要求：

- Node.js `>= 22.12`
- npm
- Rust toolchain（仅桌面端需要）
- Binance Futures Testnet API credentials（仅认证 Testnet 需要）

安装与测试：

```bash
npm install
npm run desktop:install
npm test
npm run desktop:check
```

启动中文桌面控制台：

```bash
npm run desktop:dev
```

CLI 模式持续采集：

```bash
npm run price-target:watch
```

该入口同时运行 Daily Price-Target 与 Hourly Up/Down，保持唯一 evidence writer。

在另一个终端武装一次性 Prediction Testnet consumer：

```bash
npm run smoke:prediction:testnet
```

认证 Testnet 使用本地 `.env`，不要提交凭证：

```text
BINANCE_TESTNET_API_KEY=...
BINANCE_TESTNET_API_SECRET=...
```

其他入口：

| Command | Purpose |
|---|---|
| `npm run demo` | 核心订单生命周期演示 |
| `npm run validate:perp` | Paper perp round trip |
| `npm run validate:perp:testnet` | 认证 Testnet connectivity validation |
| `npm run testnet` | MA strategy Testnet smoke |
| `npm run laya:review:next` | 运行下一条只读 Laya Shadow Review |
| `npm run testnet:market` | 只读 Testnet market smoke |

## 关键代码

```text
src/
├─ bot.ts                              execution orchestration
├─ risk.ts                             deterministic risk boundary
├─ order-tracker.ts                    ACK / Fill lifecycle
├─ position.ts                         position and realized PnL
├─ reconciliation.ts                   local vs exchange truth
├─ binance-testnet.ts                  authenticated venue adapter
├─ overlay/
│  ├─ price-target-collector.ts        daily watcher entry
│  ├─ hourly-up-down-collector.ts      seven-asset hourly lane
│  ├─ prospective-testnet-demo.ts      one-shot Candidate consumer
│  └─ laya-candidate-review.ts         read-only AI shadow
└─ observability/domain-event.ts       append-only runtime events

desktop/
├─ src/overview.tsx                    Chinese control room
├─ src/system-status.ts                typed desktop status
└─ src-tauri/src/lib.rs                local supervisor and IPC boundary
```

## 深入阅读

1. [项目文档索引](docs/README.md)
2. [交易系统设计决策](docs/architecture/design-decisions.md)
3. [Perp execution validation](docs/cases/perp-execution-validation.md)
4. [Order Tracker Late Fill](docs/cases/order-tracker-late-fill.md)
5. [高流动性 Prediction 供给审计](docs/research/high-liquidity-prediction-supply-2026-10-08.md)
6. [Price-Target Admission v1.1](docs/research/price-target-variant-admission-v1.1.md)
7. [面试复盘入口](docs/interview/README.md)

## 明确不声称

PrePerp 当前不声称：

- 已证明可持续盈利；
- 一次 Testnet DOWN smoke 证明方向 alpha；
- 生产级 7×24 Mainnet 自动交易；
- AI 可以控制 Risk 或下单；
- 完整自动 recovery convergence；
- 机构级 HA、风控或清算能力。

项目真正证明的是：

> 从真实 prospective 数据、不可变 evidence 和确定性 Candidate 开始，研究信号可以在不放大 AI 权限的前提下，安全驱动一条可观察、可复算、失败即关闭的 Testnet 交易闭环。
