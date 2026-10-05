# Price-Target Variant v1：Prospective Admission Collector

日期：2026-10-05
状态：**IMPLEMENTED / RESEARCH-ONLY / NO EXECUTION AUTHORITY**

## 1. 唯一职责

collector 只实现冻结的 [Price-Target Admission Protocol v1.0.0](price-target-variant-admission-v1.md)：

```text
Gamma discovery
→ immutable episode registration
→ nearest-OTM strike lock
→ continuous Gamma status + YES book + Spot 1m archive
→ first complete 1m upward crossing
→ QUALIFIED / DATA_BLOCKED / NOT_TRIGGERED_BEFORE_CUTOFF
```

它不导入 Strategy、Risk、`PerpIntent`、exchange adapter 或任何 order API。

## 2. 文件边界

- `src/overlay/price-target-admission.ts`：纯 manifest 与 admission evaluator；
- `src/overlay/price-target-collector.ts`：公开数据抓取、raw archive 和状态推进；
- `schemas/price-target-v1-manifest.schema.json`：不可变 registration manifest；
- `schemas/price-target-v1-state.schema.json`：可由 raw evidence 重建的 derived state；
- `test/price-target-admission.test.ts`：cutoff、T0、nearest-OTM、pre-T0 book 边界；
- `test/price-target-collector.test.ts`：真实形状 payload 与单轮 collector。

所有运行产物默认写入 `.gitignore` 已排除的 `work/price-target-v1/`。

## 3. 运行模式

单轮 discovery / registration / admission：

```bash
npm run price-target:collect
```

registration 后持续以固定 60 秒 cadence 归档：

```bash
npm run price-target:watch
```

单轮模式用于可控验证；正式 prospective 运行必须使用 watch 或等价的 60 秒 scheduler。只在 crossing 后启动 collector 不满足协议，因为无法证明 latest-known pre-T0 YES book。

生产运行在写入 evidence 前必须先读取 Binance public server time，并以本轮冻结的 offset 建立权威 evidence clock。scan report 保存 clock source、host offset 和 round-trip time；这防止 host clock drift 悄悄改变 registration candle、`candidateT0`、cutoff 比较或 YES book 的 120 秒 freshness。测试可以显式注入 deterministic clock。

检查单个 immutable manifest：

```bash
npm run price-target:manifest -- work/price-target-v1/manifests/<manifest>.json
```

## 4. 时间不变量

实现中只有一个 cutoff 公式：

```text
cutoffT0 = measurementAt - 4h
QUALIFIED only if candidateT0 < cutoffT0
```

`candidateT0 == cutoffT0` 必须得到 `NOT_TRIGGERED_BEFORE_CUTOFF`。T0 始终是 crossing candle 的 `openTime + 60,000ms`，不会混用 HTTP receipt time 或 candle closeTime。

YES book 只从已经归档且 `book.timestamp <= T0` 的 snapshots 中选最新值，并要求：

```text
T0 - book.timestamp <= 120s
```

## 5. Evidence layout

```text
work/price-target-v1/
├── manifests/   immutable episode registration
├── states/      derived admission state
├── scans/       append-only cycle summaries
└── raw/
    ├── gamma/   discovery and market-status payloads
    ├── spot/    Binance Spot 1m kline payloads
    └── books/   selected YES CLOB order books
```

manifest 一旦写入不更新。state 可以推进，但它只引用 checksum-protected raw artifacts；出现冲突 candle、缺失 first-crossing evidence、过期 pre-T0 book 或 market 在 T0 不可交易时 fail closed。

## 6. STOP condition

第一轮真实 collector 运行后立即停止开发，只报告：

- discovered episodes；
- registered episodes；
- `REGISTERED_WAITING_TRIGGER / QUALIFIED / DATA_BLOCKED / NOT_TRIGGERED`；
- 真实 blocker。

不得因第一轮 qualified 数量少而修改 strike selection、120s freshness、strict cutoff 或 owner-event rule。
