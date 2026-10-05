# Concrete Variant 2：Crypto Price-Target Feasibility

日期：2026-10-05
状态：**FEASIBILITY COMPLETE / ADMISSION v1 FROZEN / NO EXECUTION AUTHORITY**

## 1. 为什么允许启动这项设计研究

首次真实 FDV v2.1.1 discovery 得到：

```text
observed markets: 426
new POTENTIAL_FDV_REVIEW: 33
qualified: 0
```

这不是降低 Directional Study 样本标准的理由，但它证明 Crypto-FDV Formal Batch 的 prospective 样本供给稀疏。上层 Thesis 是 `Cross-Market Repricing Lag`，因此可以研究一个独立、更高频的 Concrete Variant；FDV v2.1.1 继续冻结，两个 variant 的 evidence 永不混池。

## 2. 2026-10-05 真实市场供给快照

使用 Polymarket Gamma 官方公开搜索的第一页 active events：

- `public-search?q=Bitcoin&limit_per_type=50&events_status=active&page=1`
- `public-search?q=Ethereum&limit_per_type=50&events_status=active&page=1`
- `public-search?q=Solana&limit_per_type=50&events_status=active&page=1`

只保留带 Crypto `tag_id=21` 的 events。探索性关键词筛选得到：

| Query | Crypto events returned | Crypto markets | Price-like active markets |
| --- | ---: | ---: | ---: |
| Bitcoin | 50 | 325 | 260 |
| Ethereum | 50 | 299 | 250 |
| Solana | 50 | 254 | 206 |

这是 discovery feasibility，不是 qualified sample 数量。搜索是 relevance-ranked、第一页有界且可能重叠；关键词也会包含 IV、dominance 等非目标语义。

真实结果中存在连续 daily fixed-time families，例如：

```text
Bitcoin above ___ on October 5 / 6 / 7 / ...
Ethereum above ___ on October 5 / 6 / 7 / ...
Solana above ___ on October 5 / 6 / 7 / ...
```

抽查的 BTC daily event 规则明确使用指定日期美东中午的 Binance `BTC/USDT` 1m candle final close 结算。BTCUSDT、ETHUSDT、SOLUSDT 当前在 Binance Spot 均为 `TRADING`，对应 USDⓈ-M Futures 合约均为 `TRADING / PERPETUAL`。

结论：相较 FDV，成熟资产的 fixed-time price-threshold contracts 有明显更高的 prospective 供给，足以继续做协议设计。

## 3. 当前首选语义

优先研究：

```text
BTC / ETH / SOL
×
fixed-time ABOVE threshold contract
×
Binance Spot 1m close resolution
```

暂不混入：

- `reach / hit during month`：属于 path-dependent barrier contract；
- `price range on date`：多 outcome / range semantics 不同；
- ATH、dominance、implied volatility；
- FDV 或 token-launch contracts。

这些合约不能因为都包含“price”就进入同一 Formal Batch。

## 4. 独立样本单位

同一个 event 往往有多个 strike：

```text
BTC above 74k
BTC above 76k
BTC above 78k
...
```

它们共享 asset、measurement time 和底层价格路径，不能按多个独立 Candidate 计数。Admission v1 已冻结：

```text
one asset × one measurement episode
= one independent sampling opportunity
```

唯一 contract-selection rule 已在看到后续结果前固定为首次发现时的 nearest-OTM ABOVE strike；不得事后从同一 strike ladder 挑表现最好的市场。

## 5. Admission 设计结论

后续协议设计已经在结果出现前冻结为 [Price-Target Admission Protocol v1.0.0](price-target-variant-admission-v1.md)：

1. episode 使用 `asset + resolution venue/symbol + measurementAt` 去重；
2. BTC、ETH、SOL 使用同一 admission mechanism，但保持三个独立 cohort；
3. 首次发现时按最后完整 Binance Spot 1m close 选择唯一 nearest-OTM ABOVE strike；
4. Candidate trigger 是选定 strike 的第一次 1m close upward crossing；
5. Candidate T0 固定为 crossing candle 完整收盘后的下一个分钟边界；
6. `T0 + 4h < measurementAt` 是不可放宽的安全条件；
7. T0 只接受不晚于 T0 且最多陈旧 120 秒的已归档 YES order book；
8. selected strike 不得因数据缺失、流动性或后续结果而切换；
9. 原策略仍是 Prediction `BUY_YES`，不自动映射成 Perp LONG/SHORT。

协议 v1 已冻结，但 collector、manifest、schema 和 evaluator 尚未实现，因此 Variant 2 仍未开始收集 evidence。

## 6. 当前 verdict

```text
MARKET_SUPPLY_FEASIBLE
→ ADMISSION PROTOCOL v1.0.0 FROZEN
→ NOT COLLECTING
→ DO NOT IMPLEMENT EXECUTION
```

Variant 2 将拥有独立 manifest、独立 cohort 和独立 Directional Study；不得与 FDV v2.1.1 的 0/10 混合累计。下一阶段只有在明确开启后，才实现这份 admission contract；本轮不写 collector 或交易代码。
