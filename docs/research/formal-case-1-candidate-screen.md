# FORMAL Case #1｜候选筛选

日期：2026-09-25  
状态：**NOT ADMITTED — 仍缺合格 crossover 与原始输入证据**

## 1. 候选事件

```text
Event: 2024-03-20 FOMC monetary-policy statement
Symbol: BTC-USD
Event release: 18:00 UTC（必须由官方归档材料验证）
Cutoff: strictly before 18:30 UTC Powell press conference
Baseline: MovingAverageSignal(3,6)
Shadow: PASS / WOULD_BLOCK / ABSTAIN
```

## 2. 已冻结的 Candidate 选择规则

1. 用 Federal Reserve 原始材料确认 release time；
2. 用连续、已闭合的一分钟 BTC-USD vendor candle 重放原始 MA(3,6)；
3. release 后寻找第一个 actionable crossover；
4. `HOLD/FLAT → LONG/SHORT` 可以算，但 warm-up 后第一次可计算 signal 不算；
5. T0 取该 candle close time；
6. T0 必须严格早于 18:30；
7. 没有合格 crossover 就淘汰，不移动 T0、不改参数。

## 3. 已冻结的 Baseline Outcome

```text
H = 15 minutes
entry = T0 close
exit = T0 + 15m close
outcomeEnd < nextIndependentCatalystAt
threshold = ±50bps
```

Baseline 与 Shadow counterfactual 使用相同 zero-latency paper assumption。这里不模拟 slippage、next-open 或 order book。

## 4. Pre-Formal Gate

| Gate | 状态 |
| --- | --- |
| T0 前可信事件证据 | PENDING |
| Vendor raw market data | FAIL |
| Candle interval / freshness | PENDING |
| Event → Baseline 对齐 | PENDING |
| Baseline Outcome 规则 | READY |
| Shadow mapping / ABSTAIN accounting | DEFERRED |

## 5. 原始证据要求

需要保存 Fed official bytes + metadata + checksum，以及 vendor BTC-USD 1m raw response + request/retrieval metadata + checksum。

第一次获取失败，见 [原始证据获取记录](formal-case-1-artifact-acquisition.md)。

## 6. 当前结论

**NO-GO。**

原因是 authoritative event bytes、vendor candle raw bytes、仓库内验证过的 release timestamp 和合格 pre-18:30 crossover 都还不存在。

证据不够就淘汰该 Case，不能为了凑 FORMAL 样本降低 admission 标准。
