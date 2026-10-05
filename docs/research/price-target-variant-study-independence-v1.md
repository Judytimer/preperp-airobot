# Price-Target Variant 2：Study Independence Rule v1.0.0

日期：2026-10-05

状态：**FROZEN / COLLECTING / NO EXECUTION AUTHORITY**

本规则在首个 BTC trigger cluster 的 `T0+4h` 边界之前冻结。冻结时可见的最后一份 server-synchronized collector scan 是 `2026-10-05T22:41:29.538Z`；首个 cluster 的 primary boundary 是 `2026-10-06T02:20:00.000Z`。

## 1. 两种研究单位

Price-Target Admission v1.0.0 保持不变：

```text
Admission unit = asset × measurementAt
```

每个 `QUALIFIED` contract-level Candidate 都必须保留自己的 market、entry best ask、YES path、measurementAt、resolution 和 BUY_YES PnL。

方向研究与任何“独立样本数”声明使用更严格的单位：

```text
directionalClusterKey = asset + candidateT0
Research independence unit = one directionalClusterKey
```

同一 key 下无论存在多少 measurementAt、marketId 或 selected strike：

- contract-level Candidate 全部保留；
- Directional primary evidence 只贡献 **1 个** observation；
- 原 BUY_YES 策略可以逐 contract 报告结果，但任何独立机会或有效样本数声明必须同时报告 cluster count，不能把同一 cluster 内 contracts 当成独立重复试验。

## 2. Cluster 完整性

一个 cluster 只在以下条件全部满足后成为 complete directional observation：

1. 至少包含一个 Price-Target Admission v1.0.0 `QUALIFIED` Candidate；
2. cluster 的 `asset` 与 `candidateT0` 能由 admission raw evidence 重算；
3. `T0`、`T0+1h`、`T0+4h` 和完整 `[T0,T0+4h]` underlying perp mark path 满足 Directional Study v1.1 的 raw-evidence、边界与 no-interpolation 口径；
4. 4h return、MFE 与 MAE 能从同一份 cluster path 唯一派生。

同一 cluster 内所有 contracts 共享一次 underlying directional observation。缺失 cluster-level path 时不得用某个 contract 的 YES 结果替代，也不得把其他 measurementAt 拆成额外 directional observations。

## 3. 独立 cohort

BTC、ETH、SOL 继续使用三个独立 cohort，不得跨资产池化：

```text
PRICE_TARGET_DIRECTIONAL_V1_BTC
PRICE_TARGET_DIRECTIONAL_V1_ETH
PRICE_TARGET_DIRECTIONAL_V1_SOL
```

每个 asset cohort 按 `candidateT0` 升序取最早 10 个 complete unique clusters。Stage A 永久使用最早 3 个；第 4～9 个不得重算 Stage A。Stage B 在第 10 个完成后关闭该 cohort，禁止 optional stopping。

## 4. Variant 2 两级 gate

LONG 与 SHORT 使用相同的 4h return 和 path 定义对称评估。

### Stage A：3 个 independent trigger clusters

```text
3 complete clusters
AND median directional 4h return > 0
AND hit rate >= 2/3
AND median MFE > median MAE
```

只可能得到：

```text
PROVISIONAL_LONG_SUPPORTED
PROVISIONAL_SHORT_SUPPORTED
NO_PROVISIONAL_DIRECTIONAL_EVIDENCE
```

前两个结果只产生 `strategyGeneratedTestnet = ELIGIBLE_FOR_EXPLICIT_REVIEW`；不生成订单、不证明 alpha、不允许真钱。

### Stage B：10 个 independent trigger clusters

```text
10 complete clusters
AND median directional 4h return > 0
AND hit rate >= 70%（至少 7/10）
AND median MFE > median MAE
```

只可能得到：

```text
DIRECTIONAL_LONG_SUPPORTED
DIRECTIONAL_SHORT_SUPPORTED
NO_DIRECTIONAL_EVIDENCE
```

前两个结果只产生 `microCapital = ELIGIBLE_FOR_EXPLICIT_REVIEW`；不自动激活 `DIRECTIONAL_PROXY`、`PerpIntent` 或真钱交易。

## 5. 与现有研究和工程的隔离

- 现有 Directional Study v1.1 仍只属于 FDV batch；Variant 2 cluster 不得累计进去；
- Variant 2 当前只冻结 independence unit 与 gate，不新增 evaluator；
- collector、Price-Target Admission、Strategy、Risk、Execution 与 Perp Expression 均不修改；
- 任何 Testnet 或 Micro-Capital 权限都必须在对应 gate 通过后另开显式审核。

## 6. 冻结时状态

```yaml
contractLevelQualified: 7
independentTriggerClusters: 1
firstCluster:
  asset: BTC
  candidateT0: 2026-10-05T22:20:00.000Z
  selectedStrike: 86000
  contracts: 7
  primaryBoundary: 2026-10-06T02:20:00.000Z
  directionalObservation: PENDING_T0_PLUS_4H
BTC_stageA: COLLECTING_0_COMPLETE_OF_3
BTC_stageB: COLLECTING_0_COMPLETE_OF_10
ETH_stageA: NOT_STARTED
SOL_stageA: NOT_STARTED
```

`7 QUALIFIED contracts` 不得写成 `7 independent samples`。在 4h evidence 完整前，这个 BTC cluster 也不得提前写成 `1/3 complete`。
