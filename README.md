# PrePerp

**Evidence-first prediction-market research and perpetual-futures execution system**

PrePerp 持续采集 Polymarket 与 Binance 的真实公开数据，由确定性规则生成 prospective Candidate，再通过 Risk、订单生命周期和权威 reconciliation，在 Binance Futures Testnet 完成一次性自动交易闭环。Monad 分支在同一套 Trading Core 上增加了 Perpl 链上 readiness 与 EVM 交易状态层，不重写策略或桌面运行时。中文 Tauri 桌面端负责观察和监督，本地 Laya 只做 Shadow Review，没有下单权。

> 这是一套交易工程与研究证据系统，不是盈利宣传，也不是已获授权的实盘机器人。

快速入口：[Monad 链路](#monad--perpl-适配) · [运行与验证](#快速运行) · [系统架构](#系统如何工作) · [真钱边界](#mainnet-微额真钱闭环) · [桌面端](desktop/README.md) · [完整文档](docs/README.md)

## 当前状态

| 能力 | 状态 |
|---|---|
| Paper execution core | `COMPLETE` |
| Binance Futures Testnet 基础闭环 | `PASS` |
| MA strategy → Testnet | `PASS` |
| Prediction Candidate → Testnet | `PASS` |
| 中文桌面控制台 | `AVAILABLE` |
| Monad Testnet RPC / Perpl contract readiness | `PASS / OBSERVE_ONLY` |
| Monad transaction lifecycle | `IMPLEMENTED / NO SIGNER` |
| Mainnet / Micro-Capital | `IMPLEMENTED / NOT YET EXECUTED` |
| 可持续 alpha | `NOT CLAIMED` |
| 最新全量测试 | `200 PASS / 0 FAIL / 2 SKIP` |

当前工程结论很明确：执行真实性已经从 Paper 推进到认证 Testnet，并具备受限 Mainnet 微额闭环代码；盈利能力仍需依靠多笔、前瞻、不可回填的真钱样本验证，不能由一次 Testnet 或一次主网往返推出。

## Monad / Perpl 适配

Monad 分支保留 Strategy、Risk、OrderTracker、PositionBook、checkpoint、Recovery 和 Reconciliation，只增加两个边界：

```text
Perpl protocol facts                 Monad transaction facts
Order Update / WalletFill            nonce / simulation / txHash
orders / positions snapshots         receipt / revert / finalized
            │                                  │
            └────────── correlation ───────────┘
                               │
                    existing Trading Core
```

二者不能合并：交易 receipt 成功不等于订单 ACK，更不等于成交。当前已实现并测试 Monad JSON-RPC、chain ID 与 Perpl 合约代码探测、外部 signer 边界、持久化 nonce/transaction journal、同钱包并发串行、revert/unknown/finality 状态，以及桌面只读状态卡。尚未配置钱包、抵押品或 Perpl API key，因此没有声称完成真实 Perpl 订单闭环。

只读探测不会签名、花 gas 或发交易：

```bash
npm run monad:probe
```

默认目标是 Monad testnet（chain ID `10143`）。真实执行仍需要少量 `MON` gas、Perpl 抵押品、exchange account，以及外部 signer 或 trade-scoped API key；切到链上不等于免费交易。完整设计与当前证据见 [Monad / Perpl 链上交易整合](docs/monad-chain-integration.md)。

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
| Hourly Up/Down | BTC / ETH / SOL / XRP / DOGE / HYPE / BNB / ADA / LINK / AVAX / SUI / LTC / BCH / DOT / TRX | Binance 1h candle 方向合约 |

小时发现池已扩展到 15 个同时拥有 Binance Spot 与 USDⓈ-M Perp 的高流动性资产。当前 Polymarket 实时供给仍主要集中在原 7 个资产；新增 8 个只在真实同语义市场出现后才会注册 Candidate，不会因扩大列表伪造信号：

```text
Polymarket 有相同语义的活跃合约
+ Binance 有明确的 resolution data
+ Binance Futures Testnet 有对应 USDT perpetual
```

桌面端会把“已配置发现资产”和“当前确有 Prediction 市场的资产”分色显示。仅在 Binance 上成交活跃、但没有对应 Prediction contract 的资产，不会被伪造成策略信号。

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
- watcher / Laya 本地常驻与最后心跳；
- Windows 登录后启动开关和“云端 AI = 0”边界；
- 明确的 Mainnet / AI 权限边界。

Renderer 不能执行任意 shell 命令，也不接收交易所密钥。Rust host 启动后独立监督唯一 watcher 与本地 Laya；关闭窗口只隐藏到系统托盘。Testnet 不随桌面启动或开机自启而重新武装。

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

## Mainnet 微额真钱闭环

主网不是“测试网一盈利就自动放开”。测试网余额没有经济含义，只验证接口、订单状态机和对账。真钱阶段独立验证滑点、手续费、真实成交和操作可靠性；策略盈利仍需靠多笔前瞻样本判断。

当前实现采用两阶段一次性授权：

```text
prepare（只读）
→ 核验全账户空仓、零挂单、One-way、Isolated、单资产保证金
→ 核验交易规则、数量、名义金额和可用余额
→ 生成 10 分钟过期、SHA-256 内容寻址的 planId

execute（真钱）
→ 必须同时提供精确 planId + EXECUTE_REAL_MONEY_ONCE:<planId>
→ 再次核验账户、价格和 Binance 历史订单（最大漂移 100 bps）
→ user stream 就绪后再次核验全账户，再创建不可重复执行锁
→ 1× 杠杆、下单前 `quantity × lastPrice ≤ 25 USDT`、一次 MARKET entry
→ entry 的实际成交量大于零后立即发出 reduce-only MARKET FLAT；余量终止时按真实持仓补齐退出
→ 最终要求本地与 Binance 都 FLAT、零挂单、reconciliation consistent
```

`.env` 必须由操作者显式填写，仓库不会提供真钱默认值：

```dotenv
BINANCE_MAINNET_API_KEY=...
BINANCE_MAINNET_API_SECRET=...
PREPERP_MICRO_SYMBOL=...
PREPERP_MICRO_SIDE=LONG_or_SHORT
PREPERP_MICRO_QUANTITY=...
PREPERP_MICRO_MAX_NOTIONAL_USDT=...
```

API key 应只启用 Futures 交易、禁用提现并绑定 IP。plan 会冻结 commit 与关键执行源码的 SHA-256 指纹，Prepare 之后源码发生变化就拒绝执行。先运行 `npm run mainnet:micro:prepare`，人工核对输出的 plan 后，再设置 `PREPERP_MAINNET_PLAN_ID=<planId>` 与 `PREPERP_MAINNET_ARM=EXECUTE_REAL_MONEY_ONCE:<planId>`，最后运行 `npm run mainnet:micro:execute`。本地锁与 plan 专属 clientOrderId/交易所历史检查共同阻止重放；任何已消费授权都不会自动重试。

费用按 Binance 返回的资产分别汇总；只有全部费用都能按 USDT 解释时才给出 `netPnlUsdt`，否则明确返回 `null`，避免把 BNB 等手续费误当 USDT。当前代码和确定性仿真已验证该闭环，但尚未提交任何主网订单。

完整边界与设计分类见：[Mainnet Micro-Capital v1](docs/research/mainnet-micro-capital-v1.md)。

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
- 多张并发订单、乱序 ACK/Fill、Partial Fill、delayed Fill 与 fillId 幂等；
- cancel intent 与订单状态正交；冲突 entry 会全部确认终止后，才允许 reduce-only exit；
- `CANCELED / EXPIRED / EXPIRED_IN_MATCH / REJECTED` 统一进入权威终态；
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
npm ci
npm run desktop:install
npm run typecheck
npm test
npm run desktop:check
```

核心 Node 测试不要求交易所凭证。当前 Windows 环境的最新结果为 202 项测试：200 通过、0 失败、2 项因缺少 POSIX Bash 跳过。

启动中文桌面控制台：

```bash
npm run desktop:dev
```

构建 Windows 安装程序：

```bash
npm run desktop:build
```

NSIS 安装程序输出到 `desktop/src-tauri/target/release/bundle/nsis/`。安装后可直接从 Windows 开始菜单启动，不需要 Codex。开机启动默认关闭，可在控制台中显式开启。

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
| `npm run mainnet:micro:prepare` | 只读生成、校验微额主网 plan；不发订单 |
| `npm run mainnet:micro:execute` | 需要 plan 专属人工授权的真钱往返 |
| `npm run monad:probe` | 只读验证 Monad chain ID、最新区块、Perpl 合约代码与可选钱包余额/nonce |

## 关键代码

```text
src/
├─ bot.ts                              execution orchestration
├─ risk.ts                             deterministic risk boundary
├─ order-tracker.ts                    ACK / Fill / terminal lifecycle
├─ position.ts                         position and realized PnL
├─ reconciliation.ts                   local vs exchange truth
├─ binance-testnet.ts                  Binance USDⓈ-M venue adapter
├─ mainnet-micro.ts                    capped two-phase Mainnet protocol
├─ monad/                              RPC readiness and EVM transaction truth
├─ observed-execution-venue.ts         post-processing evidence observer
├─ overlay/
│  ├─ price-target-collector.ts        daily watcher entry
│  ├─ hourly-up-down-collector.ts      15-asset hourly discovery lane
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
7. [Mainnet Micro-Capital v1](docs/research/mainnet-micro-capital-v1.md)
8. [面试复盘入口](docs/interview/README.md)

## 明确不声称

PrePerp 当前不声称：

- 已证明可持续盈利；
- 一次 Testnet DOWN smoke 证明方向 alpha；
- 生产级 7×24 Mainnet 自动交易；
- AI 可以控制 Risk 或下单；
- 完整自动 recovery convergence；
- 机构级 HA、风控或清算能力。

项目真正证明的是：

> 从真实 prospective 数据、不可变 evidence 和确定性 Candidate 开始，研究信号可以在不放大 AI 权限的前提下，安全驱动一条可观察、可复算、失败即关闭的交易闭环；当前已验证到 Testnet，Mainnet 微额协议仍等待首次人工授权执行。
