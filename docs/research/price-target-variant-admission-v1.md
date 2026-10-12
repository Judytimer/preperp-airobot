# Concrete Variant 2：Price-Target Admission Protocol v1.0.0

日期：2026-10-05
状态：**FROZEN / COLLECTOR IMPLEMENTED / NO EXECUTION AUTHORITY**

## 1. 研究问题与边界

本协议只定义一个独立的 prospective Formal Batch：

```text
BTC / ETH / SOL
× fixed-time ABOVE strike
× Binance Spot 1m final close resolution
× underlying first upward strike crossing
→ Prediction BUY_YES Candidate
```

它检验的是：底层现货第一次由下向上穿越合约 strike 后，Prediction YES 是否存在可交易的 repricing lag。

它不修改 Crypto-FDV v2.1.1，不继承 FDV 的 Candidate，不与 FDV evidence 合并；也不生成 `PerpIntent`、Testnet order 或真钱订单。Prediction `BUY_YES` 是本 Variant 的原生策略语义，underlying Perp 方向仍是另一个研究问题。

## 2. Eligible market family

一个 market family 必须同时满足：

1. asset 只能是 `BTC / ETH / SOL`；
2. market 是二元 `YES / NO`；
3. 问题语义是“该 asset 在一个固定时刻是否 **ABOVE** 一个数值 strike”；
4. 同一 event 内允许存在多个 strikes，但所有 strikes 必须共享同一个 asset、measurementAt 和 resolution source；
5. resolution rules 明确使用对应 Binance Spot `BTCUSDT / ETHUSDT / SOLUSDT` 的指定 **1m candle final close**；
6. `measurementAt` 必须能从规则文本无歧义地转换为 UTC；不能用 Gamma `endDate` 猜测；
7. market 在首次发现时必须 active、未 resolved、接受 CLOB 订单，并能取得 YES outcome asset id；
8. `reach / hit / touch` barrier、date range、ATH、price band、multi-outcome、FDV、dominance、IV 合约全部不属于本 batch。

规则文本、Gamma event/market payload 和 outcome identifiers 必须在首次发现时原样归档并校验 checksum。任何语义歧义都得到 `DATA_BLOCKED`，不能人工补成 eligible。

## 3. 独立 episode 与去重

唯一 episode key：

```text
asset + resolutionVenue + resolutionSymbol + measurementAt
```

因此：

```text
one asset × one measurementAt = one sampling opportunity
```

同一 strike ladder 中的多个市场不能分别计样本。若同一 discovery response 同时出现多个满足同一 episode key 的 events，使用数值最小的 `eventId` 作为 owner event；以后发现的重复 event 只归档为 duplicate，不得替换 owner event。若 event id 不能唯一、稳定地比较，该 episode 为 `DATA_BLOCKED`。

BTC、ETH、SOL 使用同一 admission mechanism，但属于三个独立 cohort：

```text
PRICE_TARGET_V1_BTC
PRICE_TARGET_V1_ETH
PRICE_TARGET_V1_SOL
```

不得把三种资产池化后凑 Stage A / Stage B 样本。未来若要共享 cohort，必须单独提出经济机制与新版本，不能回改 v1。

## 4. Episode registration 与不可回填边界

`discoveredAt` 是 collector 第一次收到该公开 market family 响应的本地 UTC receipt timestamp。它必须与完整原始响应一起落盘；Polymarket market open time 只作证据字段，不代替 `discoveredAt`。

首次发现后立即创建一次且仅一次的 episode registration：

1. 冻结 owner event 和当时完整 strike ladder；
2. 取得 `discoveredAt` 之前最后一根完整 Binance Spot 1m candle；
3. 将该 candle close 冻结为 `registrationSpot`；
4. 运行第 5 节的唯一 strike selection；
5. 开始归档 Spot 1m candles 与已选 YES order book snapshots。

不得用历史搜索结果回填 `discoveredAt`，不得在后续行情出现后重新注册，也不得因后来新增 strike 或改善流动性而重选市场。

## 5. 唯一 strike selection

定义首次发现时的 eligible ABOVE strikes 集合为 `K`，选中的 strike 为：

```text
selectedStrike = min { k in K | k > registrationSpot }
```

即：**首次发现时严格高于现货完整 1m close 的最近价外（nearest OTM）strike**。

这条规则的目的不是宣称 nearest OTM 最优，而是让三个资产使用同一种、与合约本身绑定且不依赖未来结果的选择规则。

Fail-closed 规则：

- 若不存在严格高于 `registrationSpot` 的 strike，该 episode 为 `INELIGIBLE_AT_REGISTRATION`；
- 若同一 owner event 内存在两个无法唯一映射的相同 strikes，该 episode 为 `DATA_BLOCKED`；
- strike 一经选定永久锁定；
- selected market 后续关闭、缺失或失去流动性时，不能切换到邻近 strike；
- spot 一次跳过多个 strikes 时仍只保留原 selected strike；
- 必须归档完整 ladder、`registrationSpot`、选择计算和 selected market id，不能只保存最后结果。

## 6. Candidate trigger 与 T0

本协议不使用任意的 `15m +1%`、volatility z-score 或事后调节的 asset-specific threshold。selected strike 本身就是预注册的 repricing threshold。

从 registration 之后的完整 Binance Spot 1m candles 开始，找到第一对相邻 candles `c[n-1]` 与 `c[n]`，满足：

```text
c[n-1].close < selectedStrike
AND
c[n].close >= selectedStrike
```

这就是本 episode 唯一的 upward-cross trigger。定义：

```text
Candidate T0 = c[n].openTime + 60,000 ms
```

也就是 crossing candle 完全收盘后的下一个 UTC 分钟边界，而不是 collector 之后任意选择的处理时间。

附加约束：

- `c[n]` 必须在 registration 完成后才收盘；
- 只认第一次 upward crossing；后续跌破再上穿不会生成第二个 Candidate；
- `T0 + 4h < measurementAt` 必须成立，确保完整 primary horizon 严格早于合约 measurement；
- 第一次 crossing 若发生在 cutoff 之后，episode 结论是 `NOT_TRIGGERED_BEFORE_CUTOFF`；
- 第一次 eligible crossing 若 evidence 不完整，结论是 `DATA_BLOCKED`，不能等待下一次 crossing 替代。

这个定义把 lookback 固定为前一根完整 1m candle，并与 Polymarket 合约的 Binance 1m resolution cadence 对齐。

v1 不另设任意的“discovery 必须早于 measurement 8h/12h”门槛。真正影响 evidence 完整性的时间条件直接冻结在 Candidate 边界：registration 必须先于 trigger，且 `T0 + 4h < measurementAt`。发现太晚的 episode 会自然结束为 `NOT_TRIGGERED_BEFORE_CUTOFF`，不能进入 cohort。

## 7. T0 时的 Prediction admission

YES evidence 必须来自持续 prospective 归档的 Polymarket CLOB order book，不允许在 T0 之后查询并伪装成历史 snapshot。

T0 admission 要求：

1. 使用 timestamp 不晚于 T0 的最后一个 archived YES book；
2. `T0 - book.timestamp <= 120,000 ms`；
3. book raw payload、server timestamp、hash、best bid/ask、size、tick size 与 `minOrderSize` 全部归档；
4. book 必须双边可报价，满足 `0 < bestBid <= bestAsk < 1`；
5. `bestAskSize >= minOrderSize`，至少能在 best ask 执行 venue 允许的最小订单；
6. selected market 在 T0 仍 active、未 resolved、接受订单。

v1 **不设置任意 maximum spread 或固定美元 depth threshold**。spread、best-ask depth 和 slippage evidence 必须报告；原策略的 entry evaluation 使用可执行 `bestAsk`，而不是 midpoint 或 last trade，因此差流动性会直接降低策略 PnL，不能被事后过滤掉。若未来需要与特定 capital size 绑定的 liquidity gate，必须升级协议版本。

`YES @ T0` 可同时保存 midpoint 作为状态诊断，但 midpoint 不得替代 BUY_YES entry ask。

## 8. 必需 raw evidence

一个 `QUALIFIED` Candidate 至少必须拥有：

```yaml
protocolVersion: PRICE_TARGET_ADMISSION_V1_0_0
cohortKey: PRICE_TARGET_V1_BTC | PRICE_TARGET_V1_ETH | PRICE_TARGET_V1_SOL
episodeKey:
ownerEventId:
selectedMarketId:
yesAssetId:
discoveredAt:
measurementAt:
registrationSpot:
selectedStrike:
candidateT0:
```

以及以下不可变原始 artifacts 与 checksum：

- 首次发现的 Gamma event/market payload 与完整 strike ladder；
- resolution rules 原文及其 measurementAt 解析记录；
- registration Spot 1m candle；
- crossing 前后两根 Binance Spot 1m candles；
- latest-known pre-T0 YES order book snapshot；
- owner/duplicate event 判定与 strike-selection derivation。

所有派生字段必须能仅由这些 archived artifacts 重算。禁止 interpolation、人工 extrema、未来数据和后补 snapshot。

## 9. Admission 状态机

```text
DISCOVERED
→ INELIGIBLE_MARKET_SEMANTICS
  or DATA_BLOCKED
  or REGISTERED_WAITING_TRIGGER

REGISTERED_WAITING_TRIGGER
→ QUALIFIED
  or DATA_BLOCKED
  or NOT_TRIGGERED_BEFORE_CUTOFF
```

只有 `QUALIFIED` 才能进入本 Variant 的 prospective evidence cohort。`INELIGIBLE`、`DATA_BLOCKED`、`NOT_TRIGGERED` 都不算样本，也不能通过换 strike、换 duplicate event 或回填历史行情修复。

## 10. 与后续研究的隔离

- 本协议不复用 `STRATEGY_LAB_V2_1_1_QUALIFIED_PROSPECTIVE_CANDIDATE` qualification；
- 当前 `Directional Study v1.1` 只服务 FDV batch，不能直接累计本 Variant 样本；
- Variant 2 若进入 Directional Study，必须拥有独立 qualification、独立 cohort 与独立 pre-registration；
- admission `QUALIFIED` 只代表可以记录原策略 `BUY_YES` evidence，不代表 alpha、Perp 方向或任何交易授权；
- manifest、schema、纯 evaluator 与 collector 已按本协议实现；实现本身仍是 research-only，不改变任何 Execution 权限。运行说明见 [Prospective Admission Collector](price-target-collector-v1.md)。

## 11. 官方数据接口依据

- Polymarket [Prices and Order Books](https://docs.polymarket.com/market-data/prices-order-books)：公开 order book 包含 server timestamp、bid/ask levels、size、`minOrderSize`、tick size、last-trade price 与 book hash；BUY best price 是 lowest ask。
- Binance Spot [Kline/Candlestick Data](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market#klinecandlestick-data)：`/api/v3/klines` 提供 1m candle 的 open time、OHLC 与 close time，可作为 registration、crossing 和 resolution cadence 的原始证据。

这些接口只说明 evidence 可以被公开、可重复地归档，不赋予任何执行权限。

## 12. Frozen decisions

v1.0.0 已冻结：

```text
episode identity
owner-event deduplication
asset-separated cohorts
nearest-OTM selection at first discovery
first 1m close upward crossing
Candidate T0 boundary
4h-before-measurement cutoff
latest-known YES book staleness
minimum executable book admission
fail-closed / no fallback behavior
```

任何改变都必须新建协议版本；不得修改已经注册的 episode 或 Candidate。collector 只实现与验证这份 admission contract，不得同时扩展 Execution。
