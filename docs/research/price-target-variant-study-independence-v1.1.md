# Price-Target Variant 2：Study Independence Rule v1.1.0

日期：2026-10-06

状态：**FROZEN / AWAITING ACTIVATION / NO EXECUTION AUTHORITY**

v1.1.0 是新的 prospective cohort，不修复、不续接 v1.0.1。启动它的唯一依据是 v1.0.1 真实运行暴露了一个 blocking instrumentation gap：collector 没有归档协议要求的 underlying Perp mark path，因此首个 BTC locked cluster 合法终结为 `DATA_BLOCKED`。

## 1. v1.0.1 永久结论

```yaml
PRICE_TARGET_DIRECTIONAL_V1_BTC:
  slot_1: DATA_BLOCKED
  stage_A: STAGE_A_DATA_BLOCKED / NO_AUTHORIZATION
  stage_B: STAGE_B_DATA_BLOCKED / NO_AUTHORIZATION
```

- Cluster #1 不得补抓历史 Perp mark；
- 后续 cluster 不得替换 slot #1；
- 旧 Candidate、旧 cluster 和旧 evidence 不得搬入 v1.1.0；
- v1.0.1 继续作为 instrumentation failure evidence 保留。

## 2. 新 cohort 与启用边界

新 cohort 为：

```text
PRICE_TARGET_DIRECTIONAL_V1_1_BTC
PRICE_TARGET_DIRECTIONAL_V1_1_ETH
PRICE_TARGET_DIRECTIONAL_V1_1_SOL
```

只有 BTC、ETH、SOL 三个 symbol 的首轮 Perp mark raw archive 全部成功并写入不可变 `activation.json` 后，v1.1.0 才激活。

```text
candidateT0 > activation.activatedAt
```

是唯一准入边界。等于或早于 `activatedAt` 的 Candidate 永久不属于新 cohort。Activation manifest 同时冻结启动代码 commit、数据源、1m interval、首次归档延迟上限和三份起始 raw artifact checksum。

## 3. Perp mark evidence

唯一数据源：Binance USDⓈ-M Futures public mark-price kline：

```text
GET https://fapi.binance.com/fapi/v1/markPriceKlines
symbol = BTCUSDT / ETHUSDT / SOLUSDT
interval = 1m
```

collector 每轮对三个资产都归档原始响应，不因当前是否有 waiting episode 或 qualified Candidate 而停止。每份 artifact 保存：

- source URL；
- server-synchronized `retrievedAt`；
- repository-relative raw path；
- SHA-256 checksum；
- 由 raw payload 派生的 candle coverage index。

一个 1m candle 只有在首次归档满足下式时，才可用于 v1.1.0：

```text
0 <= firstArchivedAt - closeTime <= 180 seconds
```

晚于 180 秒首次出现的 candle 即使可由 Binance 历史接口读取，也只能算历史数据，不能修补 prospective path。重叠拉取只用于抵抗单轮调度抖动；研究时取每个 open time 的最早归档时间。

## 4. 冻结边界价格与路径

Candidate T0 由 Admission v1.0.0 定义，天然对齐 1m boundary。Perp mark observation 使用已及时归档的 1m mark kline：

```text
mark(T0)      = open of mark candle with openTime == T0
mark(T0+1h)   = open of mark candle with openTime == T0+1h
mark(T0+4h)   = open of mark candle with openTime == T0+4h

path extrema  = high / low of every complete mark candle with
                T0 <= openTime < T0+4h
```

缺少任何 exact boundary candle、缺少 path 中任何 1m candle、首次归档超时、OHLC 冲突或 checksum 失败，都必须使该 locked cluster 终结为 `DATA_BLOCKED`。禁止 interpolation、历史补抓、Spot 代替 Perp mark、YES path 代替 underlying path。

## 5. 计数与 gate

独立单位仍为：

```text
directionalClusterKey = asset + candidateT0
```

每个 asset 按 candidateT0 锁定最早 3/10 个 **v1.1.0 boundary 之后**的 qualified unique clusters。Stage A / Stage B 公式、blocked 占位、不可补位和显式 review 权限全部沿用 v1.0.1；新版本不降低证据门槛。

## 6. 工程边界

本版本只新增 research instrumentation：

```text
public Perp mark source
→ continuous raw archive
→ checksum
→ immutable activation boundary
```

它不修改 Price-Target Admission、Strategy、Risk、Execution、Perp Expression 或 PerpIntent，不生成订单，不解锁 Testnet，不解锁 Micro-Capital。
