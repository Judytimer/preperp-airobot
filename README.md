# Minimal Perp Quant Bot

一个以本地 paper 模拟为默认模式的 TypeScript + Node.js 永续合约量化机器人，并提供 Binance USDⓈ-M Futures Testnet 实验入口。它不碰真钱、不做 UI，也不是完整回测框架。

## 数据流

```text
simulateMarket
  -> MovingAverageSignal
  -> RiskManager
  -> ExecutionVenue command (submit / cancel)

ExecutionVenue event callback
  -> ACK / delayed FILL / CancelAck
  -> InFlightOrderTracker / PositionBook
  -> console logs
```

风控使用 `已成交 Position + unresolved Orders` 计算预计仓位，避免 Fill 延迟期间重复下单。Core 在 submit 前生成并跟踪 `clientOrderId`；adapter 后续提供独立的 `exchangeOrderId`。命令结果不携带 future Fill，Fill/CancelAck 只通过 execution event callback 进入状态机。

订单生命周期由 `InFlightOrderTracker` 持有：成交路径为 `SUBMITTED -> ACKED -> PARTIALLY_FILLED -> FILLED`；撤单路径为 `SUBMITTED/ACKED/PARTIALLY_FILLED -> CANCEL_REQUESTED -> CANCELED`。只有 venue execution event 中的 `CancelAck` 才能确认 `CANCELED`。发生 Partial Fill 后，预计仓位使用已成交 Position 加订单 `remainingQty`，不会把整张原始订单重复计入，也不会过早移除 Pending。

第二轮加入了最小逐仓保证金账户。行情明确区分 `lastPrice / markPrice / indexPrice`：Baseline 双均线和模拟订单价格只使用 last，逐仓账户、未实现盈亏与强平触发只使用 mark，index 目前仅代表外部参考输入；本模拟器没有实现交易所级 mark-price 推导。强平触发与执行已分开建模，但当前 paper simplification 仍假设 `liquidation execution price = mark price`，日志会同时记录 trigger mark 与 execution price。下单前检查目标仓位初始保证金，`equity <= maintenanceMargin` 时模拟强平、向 exchange 发起 cancel request，并在 CancelAck 后确认 `CANCELED`，然后停止策略继续下单。它仍然只是 paper model，不代表真实交易所清算流程。

第三轮加入版本化 checkpoint。submit 前的 client intent、ACK、有效 Fill 和模拟强平会原子写入 `.runtime/perp-bot-state.json`，保存客户端订单 identity/序号、仓位、Fill 幂等集合和订单状态；simulator 自己的 venue sequence 不属于 Core checkpoint。正常完成的状态可恢复；如果重启时仍有 unresolved order（包括 `SUBMITTED`），机器人进入 `RECOVERY_REQUIRED` 并停止下单，不猜测该订单最终是否成交。

Reconciliation 目前提供只读比较边界：输入本地 Position / open orders 与权威 exchange snapshot，报告 position mismatch、missing/unexpected order 和 remaining quantity mismatch。它不会自动覆盖任一侧状态；恢复策略仍保持 fail-closed。

Recovery Evidence contract 进一步要求 venue/account/symbol identity、`asOf`、完整 open-orders 声明、权威 position、terminal order facts 与 checkpoint 后 fills。该 contract 只验证 evidence 是否足够进入未来 M2B 设计，不修改本地状态，也不包含 fresh mark。

Funding 作为独立结算事件输入：事件携带 `fundingId / rate / markPrice / ts`，正费率下多仓支付、空仓收取，负费率方向相反。Funding 修改 realized equity，但无权覆盖最新 market mark；`fundingId` 会进入 checkpoint，以保证重启后的重复结算仍然幂等。当前不包含 funding alpha 或交易所费率预测。

Historical Replay 提供最小研究记录边界：Baseline 与 AI Shadow 同时留档，所有证据必须满足 T0，Ground Truth 规则必须在 T0 前定义，outcome 只能在预设窗口结束后记录。每个记录显式区分 `DEMO / QUALITATIVE_ONLY / FORMAL`、`MEASURED / NOT_MEASURABLE` 和 `ARCHIVED / RECONSTRUCTED / MIXED` input provenance；`FORMAL` 必须具备 archived inputs 与 measured outcome。Catalyst/evidence ground truth 与 trading verdict 独立记录，`CONFIRMED` 不自动等于 `PASS`。Candle loader 还校验声明的 interval、连续性以及最后一根 candle 对 T0 的 freshness。该 runner 只产出研究记录，不把 Shadow verdict 映射成订单或 PerpIntent。

```bash
npm run replay
```

真实 FOMC artifacts 仅通过 `npm run acquire:formal-case-1` 获取；脚本先写临时文件，只有 curl exit 0 且 HTTP 2xx 才发布 `.raw` 与 metadata/checksum。失败响应会被清理，不能进入 adapter admission。

该命令输出 schema smoke fixture，以及第一个真实事件 replay：2024-01-09 SEC X 账号被入侵事件。Baseline LONG 由最小 candle fixture 经真实 `MovingAverageSignal(3,6)` 重放产生，不再手写；诊断显示第一条可计算的 LONG 在 21:11，但此前都处于 warm-up，因此不能证明消息触发了 crossover。加上 candle 是 reconstruction、原始消息没有由项目在 T0 归档、Shadow 也由事后重放，该案例仍为 `QUALITATIVE_ONLY / NOT_MEASURABLE`，并被 formal filter 排除。

FORMAL candidate selection 使用纯函数寻找 event release 后、固定 cutoff 前的第一个 actionable MA crossover；HOLD/FLAT → LONG/SHORT 有效，warm-up 后的首个 signal 不算 crossover。Baseline Candidate Outcome 固定为 T0 close 零延迟 paper 成交后持有 15 分钟，并以方向收益 `±50bps` 判定 SUCCESS/FAILURE，中间为 NEUTRAL；结束时间必须严格早于下一 independent catalyst。Baseline 与 Shadow counterfactual 使用同一成交假设，不建模 slippage、next-open 或 order book。样本仅研究 post-event 能产生 actionable crossover 的条件事件，不能解释为 AI alpha 或 unconditional event performance。当前这些规则只有 synthetic DEMO burn-in，尚未把缺失的 raw artifacts 包装成 FORMAL case。

## 运行

首次拉取包含 Testnet connector 的版本后先安装依赖：

```bash
npm install
```

默认本地 paper 运行：

```bash
npm start
npm run demo
```

`npm run demo` 会依次展示 Partial Fill 生命周期、exchange-confirmed cancel 后的模拟强平，以及 restart 后的只读 reconciliation report。

你会看到类似这些日志：

```text
[TICK] ...
[SIGNAL] ...
[RISK] approved ...
[ACK] ...
[FILL] ...
[POSITION] ...
```

## 测试

```bash
npm test
```

测试覆盖了核心闭环：价格 tick 触发双均线信号，风控批准订单，模拟交易所先 ACK，延迟 Fill 后更新 Position；也覆盖 projected position、乱序 Fill、目标仓位 delta 和跨零 Partial Fill。

## Binance USDⓈ-M Futures Testnet

第一条真实 venue 边界使用 Binance 官方模块化 TypeScript connector，并在代码里固定为 Testnet URL。策略和 Core 不调用 SDK；adapter 只负责真实行情、symbol filter 预检、下单/撤单 transport，以及把 user-data `ORDER_TRADE_UPDATE` 翻译为现有 `ACK / Fill / CancelAck`。

无凭证的只读行情 smoke（不会下单）：

```bash
npm run testnet:market
```

有 Binance Futures Testnet key 后运行 12 个真实行情 tick 的最小执行闭环：

```powershell
$env:BINANCE_TESTNET_API_KEY = "..."
$env:BINANCE_TESTNET_API_SECRET = "..."
npm run testnet
```

Testnet runner 要求账户使用 One-way Mode 且 `BTCUSDT` 为 isolated margin；否则启动即 fail closed。它使用独立 checkpoint `.runtime/binance-testnet-state.json`，结束时会拉取权威 position/open-orders snapshot 并打印只读 reconciliation report。REST `newOrder` 的自动 retry 被关闭；REST command completion 不会被当成 ACK，只有 user-data stream 的 `NEW` 才推进本地订单状态。当前仍保持 fail-closed：如果出现 submit timeout、Fill-before-ACK、断线 gap 或本地/交易所不一致，应停机并对账，而不是自动重发订单。

实验过程、故障日志与字段卡见 [`docs/learning-report.md`](docs/learning-report.md)。

## 代码入口

- `src/index.ts`: 可运行示例
- `src/bot.ts`: 闭环编排
- `src/market.ts`: 模拟行情
- `src/strategy.ts`: 简单双均线信号
- `src/risk.ts`: 最小风控
- `src/exchange.ts`: 最小 execution command/event boundary 与模拟 adapter
- `src/binance-testnet.ts`: Binance USDⓈ-M Testnet 行情、execution adapter 与事件映射
- `src/order-tracker.ts`: In-flight order、累计成交、剩余数量与状态
- `src/margin.ts`: 逐仓权益、保证金门槛与强平条件
- `src/state-store.ts`: 版本化 checkpoint 与原子 JSON 文件存储
- `src/reconciliation.ts`: 本地状态与 exchange snapshot 的只读一致性报告
- `src/recovery-evidence.ts`: M2A authoritative recovery evidence contract 与 validation
- `src/coinbase-candle-adapter.ts`: Coinbase raw candle 字段、时间与 gap 的 fail-closed adapter
- `src/historical-replay.ts`: T0-safe Historical Replay schema 与研究记录 runner
- `src/position.ts`: 持仓更新
- `src/logging.ts`: 日志格式

> 运行依赖 Node.js 22 的 `--experimental-strip-types`，所以不需要安装 TypeScript 编译器。

## Meme + Prediction Overlay

另有一条纯模拟策略链：Meme 现货明显上涨后，不增加现货仓位，而是在固定最大 premium 风险预算内 paper BUY 更高 FDV 目标的 YES；YES 价格达到退出阈值后 paper SELL 全部份额。

```bash
npm run overlay
```

这条链复用现有 `OrderRequest -> SimulatedExchange -> ACK -> Pending -> Fill`，并新增 Prediction 专用策略、风险与 long-only YES 仓位账本。`ResearchContext` 已预留，但当前只有确定性的 `MockResearchContext`，不连接 News、X、Reddit 或真实 Prediction Market。

实现说明和未经验证的假设见 [`docs/overlay-learning-report.md`](docs/overlay-learning-report.md)。

Partial Fill 实验见 [`docs/partial-fill-learning-report.md`](docs/partial-fill-learning-report.md)。

逐仓保证金与模拟强平说明见 [`docs/isolated-margin-learning-report.md`](docs/isolated-margin-learning-report.md)。

持久化与重启恢复说明见 [`docs/checkpoint-recovery-learning-report.md`](docs/checkpoint-recovery-learning-report.md)。
