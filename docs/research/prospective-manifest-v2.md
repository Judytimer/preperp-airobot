# Strategy Lab v2.1 Prospective Manifest

日期：2026-10-02
状态：**FROZEN / WAITING_FOR_QUALIFIED_MARKET**

## 0. Scope：v2.1 是 Formal Batch，不是整个 Strategy

v2.1 只负责当前 **Crypto FDV Prediction Overlay** 的 prospective admission 与证据协议。

它不定义整个上层 Strategy Thesis。上层研究命题当前表述为 **Cross-Market Repricing Lag**；未来如果出现 Crypto Price Target、Equity Valuation 或其他不同 contract semantics，必须新建语义明确的 Variant / Protocol，而不是把不同含义硬塞进 v2.1 的 `targetFdv`。

因此本文中的：

- Binance Spot；
- FDV / verified totalSupply；
- Polymarket FDV threshold；
- 1m fully-closed candle；
- FDV keyword discovery；

都属于**当前 Formal Batch 的冻结边界**，不是所有未来 Variant 的永久限制。

v2.1 继续保持冻结，不因为上层 Thesis 变宽而回改 admission。完整纠偏依据见 [Strategy Thesis × Variant × Formal Batch：策略边界纠偏说明](strategy-thesis-boundary-correction.md)。

## 1. 为什么是 v2.1

v1 将研究对象限制为尚未上市的 Meme token，并以上市后的第一根完整 1m candle 为 baseline。v1 尚未产生正式样本，因此不回改 v1。v2.0 曾计划允许已经在 Binance Spot 上线的加密资产，并使用 Polymarket 市场开放时间作为 baseline；但公开 API 不保证市场在开放前可被发现，v2.0 在产生任何正式样本前被 v2.1 取代。

v2.1 使用“采集进程第一次公开发现市场的时间”作为前瞻边界。这个时间必须由归档的 Polymarket Gamma 原始响应、retrievedAt 和 SHA-256 证明，不能手填成更早时间。市场可以已经开放，但 baseline 绝不能回到首次发现之前。

v2.1 不修改 `MemePredictionOverlayStrategy`、`OverlayRiskManager`、Paper Order/Position 或 Shadow 权限。它只改变 prospective admission 与 Formal adapter 的 baseline 来源。

## 2. 冻结协议

```text
Formal 1m protocol = 2.1.0
eligible asset = CRYPTO_ASSET already listed on Binance Spot before first discovery
discovery = first archived public observation from Polymarket Gamma
firstDiscoveredAt = discovery.retrievedAt
baseline = first complete 1m candle whose openTs >= firstDiscoveredAt
market.openedAt = evidence metadata only; never a retrospective baseline
FDV = closed Binance spot × verified totalSupply
totalSupply = proven fixed through the frozen outcome measurement
YES = latest known Polymarket YES trade with trade.ts <= candle.closeTs
interpolation = forbidden
future data = forbidden

spotRiseTriggerPct = 0.5
exitYesPrice = 0.7
maxRiskBudget = 100

execution assumption = 1.0.0
primary adverse slippage = 50 bps
sensitivity adverse slippage = 0 / 100 bps
feeModel = ZERO
fillSemantics = FULL_FILL_LIMITATION
```

首次发现前的 candle 不得进入 v2.1 baseline。发现后如果缺少规则、供给证明、Binance Spot 对应资产或未来评价时间，应保存阻塞/不合格结果，不能等结果出现后补登记。没有合格市场是合法的 `WAITING_FOR_QUALIFIED_MARKET`。

## 3. Manifest admission

结构由 [`strategy-lab-v2-manifest.schema.json`](../../schemas/strategy-lab-v2-manifest.schema.json) 定义。

```bash
npm run manifest:check -- candidate-v2.1.json
```

`DATA_READY` 至少要求：

- 首次发现证据来自 `POLYMARKET_GAMMA`，保存 source URL、source timestamp、retrievedAt、原始响应路径和 SHA-256；
- `registeredAt === firstDiscoveredAt === discovery.retrievedAt`；采集器以同一个抓取时间原子登记，禁止先观察后补登记；
- market 规则在首次发现时已经公开；
- token 已在 Binance Spot 上线，且 `listing.listedAt < firstDiscoveredAt`；
- market 是带明确 measurement/resolution rule 的未来 FDV threshold；
- Binance 1m、Polymarket last-trade、totalSupply 和 outcome rule 来源已冻结；
- 有来源证明 `totalSupply` 在 measurementAt 前固定；持续增发/销毁且没有逐时供应量协议的资产 fail closed；
- Strategy、Risk 和 execution assumptions 与本协议完全一致；
- manifest 不含 API key、secret 或 authorization 字段。

结构缺失、时间倒退、discovery checksum 不符或凭证字段产生 `DATA_BLOCKED`。资产未提前上线、首次发现时规则不可用、来源或冻结规则不同产生 `INELIGIBLE`。

## 4. 最小只读发现

官方 Gamma API 的市场列表是公开、免认证数据源，字段包括 `createdAt`、`updatedAt`、`startDate`、`acceptingOrdersTimestamp` 和市场状态。接口依据见 [Discover Markets](https://docs.polymarket.com/market-data/discover-markets) 与 [List markets](https://docs.polymarket.com/api-reference/markets/list-markets)。

```bash
npm run prospective:discover
```

该命令只执行一次有界扫描：

- 固定读取按 `createdAt DESC` 排列的最新 100 个未关闭市场，不声称覆盖 Polymarket 全量历史；
- 完整原样保存 Gamma 响应、retrievedAt 与 SHA-256；`retrievedAt` 使用响应的 Polymarket HTTP `Date`，同时记录本机请求起止时间与 midpoint offset，避免本机时钟偏差制造 future-data 假象；
- 每个 marketId 首次出现时，以不可覆盖文件冻结 `registeredAt === firstDiscoveredAt === retrievedAt`；
- 重复抓取保留原 first-discovery record，不重复登记；
- 每次扫描使用独立 scanId 且 scan summary 只允许首次创建；相同 ID 冲突时拒绝，禁止覆盖旧扫描；
- 完整 Gamma payload 会先全部解析成功，再发布 raw、market 与 scan 文件；畸形的后续 market 不得留下半次扫描；
- 只有明确含 `FDV` 或 `fully diluted valuation/value` 的文本进入 `POTENTIAL_FDV_REVIEW`；普通 `market cap` 不自动等同 FDV；
- 缺少关键时间或出现未来 `updatedAt` 时记录 `DATA_BLOCKED`；
- 不读取 API key，不运行 Strategy、Risk、Paper 或 Shadow，也不自动补 supply/token/outcome 字段。

默认输出位于 `work/prospective-v2.1/discovery`，其中 `raw/` 保存原始响应，`markets/` 保存不可覆盖的首次发现记录，`scans/` 保存每次扫描摘要。该目录被 Git 忽略，真实证据不得提交进源码仓库。

发现记录结构由 [`strategy-lab-v2-discovery.schema.json`](../../schemas/strategy-lab-v2-discovery.schema.json) 定义。`POTENTIAL_FDV_REVIEW` 仍不是 Candidate；必须完成 v2.1 manifest admission 后才能采集 Formal observation。

## 5. Observation 与报告

Observation 结构由 [`strategy-lab-v2-observation.schema.json`](../../schemas/strategy-lab-v2-observation.schema.json) 定义。它必须引用真实 raw Binance Kline 与 Polymarket last-trade artifact，并保存 source URL、source timestamp、retrievedAt、路径和 SHA-256。Runner 还会读取并校验 manifest 中的 Gamma discovery raw artifact。

正式 raw 格式冻结为：

- Binance artifact 是 `/api/v3/klines` 原始 JSON tuple 数组；`openTs = row[0]`、`close = row[4]`、`closeTs = row[6]`；
- Polymarket artifact 是 JSON 数组或 newline-delimited JSON market-stream 消息，只接受 `last_trade_price`，并只保留 manifest 已冻结的 `yesTokenId`；
- observation 中的 `candles` 与 `yesPrices` 只是便于审计的副本，必须与 runner 从 raw artifact 确定性解析出的完整序列逐项相等；不相等即 `DATA_BLOCKED`；
- Strategy 实际接收的是 raw artifact 重新解析后的序列，不接收手填数组作为权威输入。

```bash
npm run strategy-lab:replay -- candidate-v2.1.json observation-v2.1.json reports/prospective-v2.1
```

报告按 [`strategy-lab-v2-report.schema.json`](../../schemas/strategy-lab-v2-report.schema.json) 原子写入：

```text
reports/prospective-v2.1/<manifestId>/<observationId>.json
```

- `NO_CANDIDATE`：保存扫描证据，不运行 Risk、Paper 或 Shadow。
- `CANDIDATE`：立即冻结 T0，运行原 Risk、50/0/100 bps Paper scenarios 与 Laya Shadow。
- `DATA_BLOCKED`：保存明确 blocker，不补默认值、不读取未来数据。
- 相同 observation 重跑复用原报告；同 ID 不同输入禁止覆盖；并发运行由 lock 拒绝。
- Laya 不可用时记录 `PROVIDER_UNAVAILABLE / REVIEWER_UNAVAILABLE`，Paper 不受影响，不回退 fake provider。

## 6. 冻结时间后的 Outcome

T0 报告永不改写。冻结评价时间到达、Polymarket 发布公开 `market_resolved` 事件后，使用单独的 append-only outcome record：

```bash
npm run prospective:outcome -- \
  reports/prospective-v2.1/<manifestId>/<observationId>.json \
  resolution-artifact.json
```

`resolution-artifact.json` 只保存 provider、公开 market-stream URL、sourceTimestamp、retrievedAt、raw path 与 SHA-256，不接受人工填写 YES/NO verdict。程序从归档的 `market_resolved` raw event 读取 marketId、tokenIds、winningTokenId、winningOutcome 与 timestamp，匹配冻结的 marketId / yesTokenId 后推导 `YES / NO`。输出默认是 `<report>.outcome.json`，结构由 [`strategy-lab-v2-outcome.schema.json`](../../schemas/strategy-lab-v2-outcome.schema.json) 定义。

评价时间前、checksum 不符、market/token 不符、事件矛盾或同一路径不同输入均拒绝。重复提交完全相同的输入只复用已有 outcome，不重写文件。

## 7. 研究边界

Polymarket last trade 只是预测市场状态 observation，不是保证可获得的执行价。固定 bps 也不是 order book、VWAP、market impact 或真实 fee 模型。

v1 与 v2.1 属于不同 batch，不合并统计。v2.0 没有产生正式记录。v2.1 若再次改变 baseline、资产 admission 或 execution assumptions，必须升级版本，不能修改已经落盘的记录。
