# Strategy Lab v1 Prospective Manifest

日期：2026-10-02
状态：**FROZEN / WAITING_FOR_QUALIFIED_MARKET**

## 1. 目的

这份规范只定义一个人工登记的 prospective sampling 对象何时可以开始采集。

```text
candidate.json
→ manifest admission
→ DATA_READY / DATA_BLOCKED / INELIGIBLE
```

`DATA_READY` 只表示 manifest 已完整、对象合格且采集 locator 已冻结；它不表示原始行情已经下载，也不表示产生 Candidate。

本地检查：

```bash
npm run manifest:check -- path/to/candidate.json
```

命令只读取文件并输出 admission 状态，不发网络请求、不写采样记录，也不调用 Strategy 或交易链。

本阶段不实现自动 Polymarket 扫描、自动 Meme 分类、多交易所 fallback、FDV 聚合或历史案例扩张。

## 2. 冻结边界

Manifest 必须继续使用现有业务规则：

```text
Formal 1m protocol = 1.0.0
cadence = fully closed Binance Spot 1m candle
baseline = first complete candle after listingAt
FDV = candle close × verified totalSupply
YES = latest known YES trade with trade.ts <= candle.closeTs
interpolation = forbidden
future data = forbidden

spotRiseTriggerPct = 0.5
exitYesPrice = 0.7
maxRiskBudget = 100

executionAssumptionVersion = 1.0.0
primary adverse slippage = 50 bps
sensitivity adverse slippage = 0 / 100 bps
feeModel = ZERO
fillSemantics = FULL_FILL_LIMITATION
```

Polymarket last trade 是 `historical YES market observation`，不是可执行价格、盘口中点、滑点模型或成交保证。

## 3. 人工登记规则

一个对象必须在 `listingAt` 前登记。登记是显式 pre-commit，不允许看到 Candidate 或 outcome 后再加入、删除或改写。

每个 manifest 只对应一个 Polymarket market/FDV threshold。若同一事件包含多个 threshold，必须分别登记全部满足本规范的 threshold，不能事后只保留赢家。

必需字段由 [`strategy-lab-v1-manifest.schema.json`](../../schemas/strategy-lab-v1-manifest.schema.json) 定义，包括：

- manifest identity、登记时间和仓库 commit；
- marketId、question、targetFdv、YES tokenId、market/rules URL；
- token identifier、`MEME` 分类及其事前来源；
- Binance Spot symbol、listingAt、官方 listing announcement；
- verified totalSupply、观测时间、来源与验证方式；
- Binance 1m 与 Polymarket last-trade locator；
- Formal protocol 和原 Strategy/Risk 参数；
- 冻结的 paper execution profile（50 bps 主结果、0/100 bps 对照、零 fee、全量成交限制）；
- T0 前已经公开的 outcome rule、measurementAt 与 rules capture time。

Manifest 中禁止出现 API key、secret、authorization header、password 或 private key。未来采集器如需凭证，只能从环境变量读取。

## 4. 来源

### Spot

唯一正式 v1 来源：

```text
provider = BINANCE_SPOT
interval = 1m
```

原始 Kline 响应必须在未来采集阶段保存，并记录 request URL、source timestamp、retrievedAt 与 SHA-256。

### YES observation

唯一正式 v1 来源：

```text
provider = POLYMARKET_LAST_TRADE
```

每个 snapshot 只允许选择该 YES token 在 `candle.closeTs` 之前或恰好当时的最后一笔公开成交。没有符合条件的成交即 fail closed。不得以 midpoint、order book、未来成交或插值替代。

### Supply

允许：

- `ONCHAIN_TOTAL_SUPPLY`
- `OFFICIAL_TOKENOMICS`

CoinGecko 或 DexScreener 的现成 FDV 只能作为交叉检查，不能成为 Strategy 的正式 FDV 输入。

## 5. Admission 状态

### DATA_READY

Manifest 结构完整、没有凭证字段、对象满足业务 eligibility，且所有正式来源 locator 已声明。该状态只授权后续采集，不授权 Candidate、Risk、Paper Execution 或 Shadow。

### DATA_BLOCKED

包括但不限于：

- JSON 无法解析或必需字段缺失；
- token identifier、listingAt、verified supply 或 outcome measurement 缺失；
- source URL/时间戳不合法；
- manifest 含凭证字段；
- source commit 或冻结参数没有完整记录。

`DATA_BLOCKED` 不得降级来源或补默认值。

### INELIGIBLE

仅对结构完整的 manifest 判定，包括：

- 不是事前登记；
- 资产分类不是 `MEME`；
- market type 不是 `FDV_AFTER_LAUNCH`；
- 登记时市场不活跃；
- 使用非 Binance Spot / 非 Polymarket last-trade 正式来源；
- protocol 或冻结参数不同；
- measurementAt 不晚于 listingAt。

## 6. Outcome

Outcome 必须逐 market 使用 T0 前已经公开的 Polymarket measurement/resolution rule，不统一改写为“上线后 24 小时”。

Candidate admission 在 `measurementAt` 前停止：

```text
触发原 Strategy BUY_YES → CANDIDATE
到 measurementAt 仍未触发 → NO_CANDIDATE
数据不完整或时间异常 → DATA_BLOCKED
```

最终 outcome 等待该 market 的公开 resolution。Outcome 只能追加到未来 sampling record，不能反向修改 manifest、T0 snapshot、Strategy signal、Risk decision 或 Paper/Shadow 记录。

## 7. 最小本地运行入口

采集器不负责发现市场，也不联网补数据。人工 manifest 通过 admission 后，将已经归档的真实 Binance Kline 与 Polymarket last-trade 数据写入 observation 文件，再运行：

```bash
npm run strategy-lab:replay -- candidate.json observation.json reports/prospective
```

Observation 的结构由 [`strategy-lab-v1-observation.schema.json`](../../schemas/strategy-lab-v1-observation.schema.json) 定义，必须包含：

- 唯一 `observationId` 与 `retrievedAt`；
- 闭合的 1m candle 和带原始时间戳的 YES observations；
- 两份 raw artifact 的 source URL、source timestamp、retrievedAt、保存路径与 SHA-256；
- 可选的、在 T0 前已经归档的 Laya evidence 摘要。

Runner 会验证 raw checksum、时间单调性、future data、candle gap 和 manifest source 一致性。输出原子写入：

```text
reports/prospective/<manifestId>/<observationId>.json
```

同一 `observationId` 和相同输入再次运行直接复用原记录；同 ID 不同输入拒绝覆盖。进程锁阻止并发重复执行。

输出统一保存 Formal 结果、原 Risk decision、主/敏感性 Paper ACK/Fill/Position、ShadowRecord 和 outcome 等待状态。`NO_CANDIDATE` 不创建 Risk、Paper 或 Shadow。未配置 `LAYA_BASE_URL` 时，Candidate 仍按原 Risk/Paper 执行，同时留下 `PROVIDER_UNAVAILABLE / REVIEWER_UNAVAILABLE`，不会回退到 fake reviewer。`LAYA_API_KEY` 如需使用只能来自环境变量，绝不写入 manifest、observation 或 report。

报告结构由 [`strategy-lab-v1-report.schema.json`](../../schemas/strategy-lab-v1-report.schema.json) 冻结。

固定 bps 只是执行压力假设，不是盘口、VWAP、真实滑点或真实可成交价格。

## 8. 当前状态

```text
WAITING_FOR_QUALIFIED_MARKET
```

没有合格市场是正常研究状态，不是程序失败，也不构成降低阈值或扩大来源的理由。
