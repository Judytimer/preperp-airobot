# Price-Target Variant 2：BTC Trigger Cluster #1 Outcome

日期：2026-10-06
状态：**DATA_BLOCKED / PERMANENT / NO REPLACEMENT**

## 1. Locked identity

```yaml
studyRule: PRICE_TARGET_STUDY_INDEPENDENCE_V1_0_1
asset: BTC
directionalClusterKey: BTC+1791238800000
candidateT0: 2026-10-05T22:20:00.000Z
primaryBoundary: 2026-10-06T02:20:00.000Z
cohortSlot: 1
contractLevelQualified: 7
baselineCommit: b89c4a3d7a21f399342172073d1b32e217515c76
```

本次审计只读取 primary boundary 之前已经归档的 raw evidence。没有联网补抓历史行情，没有插值，也没有用 Spot price 替代 Perp mark。

## 2. Archived evidence audit

7 个 qualified BTC contract states 共同引用 32 个唯一 raw artifacts：

```yaml
BINANCE_SPOT_KLINES: 4
POLYMARKET_CLOB_BOOK: 26
POLYMARKET_GAMMA: 2
artifactReferencesChecked: 32
checksumFailures: 0
```

Candidate admission evidence 本身完整：

```yaml
selectedStrike: 86000
crossingPreviousClose: 85982.68
crossingClose: 86015.04
candidateT0: 2026-10-05T22:20:00.000Z
latestPreT0BookAgeMsRange: 33613..90393
```

BTC Spot raw archive 最晚只覆盖到 `2026-10-05T22:20:59.999Z`。它只用于 admission crossing，既不是 Perp mark，也没有覆盖 `T0+1h` 或 `T0+4h`。

## 3. Missing primary evidence

在整个已归档 evidence tree 中均不存在 Binance Futures / Perpetual mark artifact 或 futures mark source URL。因此以下 frozen requirements 无法满足：

```yaml
markAtT0: MISSING
markAtT0Plus1h: MISSING
markAtT0Plus4h: MISSING
completeMarkPathT0ToT0Plus4h: MISSING
return1h: NOT_COMPUTABLE
return4h: NOT_COMPUTABLE
LONG_MFE: NOT_COMPUTABLE
LONG_MAE: NOT_COMPUTABLE
SHORT_MFE: NOT_COMPUTABLE
SHORT_MAE: NOT_COMPUTABLE
```

Primary boundary 已经过去。现在查询 Binance historical mark klines 会构成协议禁止的 post-hoc backfill，不能把该 cluster 修复为 `COMPLETE`。

## 4. Frozen outcome

```yaml
asset: BTC
candidateT0: 2026-10-05T22:20:00.000Z
status: DATA_BLOCKED
reasons:
  - MISSING_PERP_MARK_AT_T0
  - MISSING_PERP_MARK_AT_T0_PLUS_1H
  - MISSING_PERP_MARK_AT_T0_PLUS_4H
  - MISSING_COMPLETE_PERP_MARK_PATH
BTC_Stage_A: LOCKED_SLOT_1_DATA_BLOCKED_OF_3
BTC_Stage_B: LOCKED_SLOT_1_DATA_BLOCKED_OF_10
authorization: NO_AUTHORIZATION
```

按照 Study Independence v1.0.1，该 cluster 永久占用 BTC cohort slot #1。后续 cluster 不得替换它；7 个 Prediction contract-level Candidates 及其后续 YES outcome/PnL 仍可分别保留和报告。

```yaml
VERDICT: DATA_BLOCKED
NEXT: KEEP COLLECTOR RUNNING / STOP DEVELOPMENT
```
