# 高流动性资产 × Prediction Market 供给审计

审计时间：2026-10-08

状态：`IMPLEMENTED / TESTNET_DEMO_ONLY / NO ALPHA CLAIM`

## 结论

日度 `ASSET above ___ on DATE` Price-Target family 当前只覆盖 BTC、ETH、SOL、XRP，但它不是全部可研究市场。

Polymarket 当前同时提供小时级 `ASSET Up or Down` family。筛选 2026-10-08 至 2026-10-09 active crypto events 后，共观察到 47 个小时 episode，覆盖：

```text
BTC / ETH / SOL / XRP / DOGE / HYPE / BNB
```

七个对应的 Binance USDⓈ-M Futures Testnet 合约均为 `TRADING / PERPETUAL`。

## 实时供给快照

| Asset | Binance Futures 24h quote volume | Polymarket 6PM sample liquidity | Testnet perpetual |
|---|---:|---:|---|
| BTC | 17.94B USDT | 6,126 USDC | BTCUSDT |
| ETH | 14.09B USDT | 1,838 USDC | ETHUSDT |
| SOL | 3.42B USDT | 1,010 USDC | SOLUSDT |
| XRP | 1.43B USDT | 349 USDC | XRPUSDT |
| HYPE | 836M USDT | 110 USDC | HYPEUSDT |
| DOGE | 751M USDT | 211 USDC | DOGEUSDT |
| BNB | 578M USDT | 315 USDC | BNBUSDT |

数值是审计时点快照，只用于证明真实市场供给，不作为永久 liquidity threshold。

## 市场语义

原始规则对七个资产一致：

```text
指定 Binance ASSET/USDT 1h candle

close >= open  → Up
close < open   → Down
```

因此它与 Perp LONG/SHORT 的业务语义比 `BUY_YES → LONG` 更接近，但“结果方向一致”仍不等于存在可交易 alpha。是否生成 Candidate 仍需一个提前冻结、可重算的 prediction-lag trigger；不能仅因为合约存在就下单。

## 为什么不是把 Binance Top 40 全部加入

本次还观察到 ZEC、NEAR、SUI、ADA、AVAX、LINK、UNI、LTC 等高成交量永续。但在相同审计边界下，它们没有同时出现当前小时级 Up/Down event，或者只有长期 `What price will ... hit in 2026` 市场。

```text
Binance 流动性高
≠
存在可对应的 Prediction signal
```

所以它们保留为 discovery watchlist，不进入 Candidate 或 Testnet 执行池。

## 已落地的最小改造

新增独立 `Hourly Up/Down` observation lane：

```text
Polymarket active Up/Down event
→ validate Binance 1h resolution semantics
→ archive UP/DOWN order books
→ archive 1h open + closed 1m path
→ deterministic lag Candidate
→ TESTNET_DEMO_ONLY one-shot consumer
```

实现保持一条 watcher 写入路径，并把小时 lane 与旧 Price-Target / Directional cohort 隔离。小时 Candidate 仅在真实 prospective 数据满足以下确定性条件时产生：

```text
UP:   previous 1m close < hour open <= current 1m close
DOWN: previous 1m close >= hour open > current 1m close

对应方向的 pre-T0 YES book freshness <= 120s
best executable ask <= 0.50
```

Testnet consumer 对 `UP` 使用 LONG、对 `DOWN` 使用 SHORT，成交后立即确定性 reduce-only FLAT，并做权威 reconciliation。该映射仅验证自动链路，不进入 Stage A/B，不授权 Mainnet，也不证明 Prediction→Perp alpha。

## 首次自动闭环结果

2026-10-08T23:04:00Z，扩展后的 watcher 自动捕获 BTC 小时合约的首个新 DOWN Candidate：前一分钟收盘 `81926`，当前完整一分钟收盘 `81896.01`，穿越小时开盘价 `81896.72`；已归档 pre-T0 DOWN ask 为 `0.44`。随后 one-shot consumer 自动完成：

```text
SELL BTCUSDT 0.001 @ 81898.6
→ Fill
→ BUY BTCUSDT 0.001 @ 81903.3
→ FLAT
→ open orders = 0
→ reconciliation consistent = true
```

该运行的本地 evidence 为 `work/price-target-v1/testnet-demo/UDV1-BTC-1791500640000-DOWN.json`。手续费合计 `0.06552075` Testnet USDT，本地账本 realized PnL 为 `-0.07022075`；盈亏不参与本次工程 smoke 的验收。

## 候选密度：当前证据边界

本轮已经验证“供给密度”和“能否真实产生 Candidate”，尚未形成稳定的长期候选率：

```text
审计快照：47 个小时 episode / 7 个资产 / 约 24h 上架窗口
正式运行：43 个等待 episode，3 个当时活跃 episode
武装后约 10 分钟：产生 1 个 qualified Candidate
```

这足以反驳“长期没有触发机会”，但样本仍然过小，不能外推为每天固定产生多少 Candidate。若后续要报告密度，应使用持续运行后的 `qualified Candidates / monitored asset-hours`，并同时报告 active episode 数与 DATA_BLOCKED 数，不能用一次快速触发冒充稳定频率。

## Source boundaries

- Polymarket Gamma active events：`active=true / closed=false / tag_id=21`
- Binance Futures：USDⓈ-M `exchangeInfo` 与 24h ticker
- Binance Futures Testnet：USDⓈ-M `exchangeInfo`

所有查询均为公开只读接口；本次审计没有提交任何订单。
