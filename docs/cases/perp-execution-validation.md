# Perp Execution Validation

日期：2026-10-04  
协议：`1.0.0`  
状态：**P0 DETERMINISTIC PAPER PASS / P1 AUTHENTICATED TESTNET PASS / P2 LIVE NOT AUTHORIZED**

## 1. 验证对象

这个入口验证 Perp Core，不验证 alpha：

```text
Explicit Validation Target
→ Risk / Margin Preflight
→ Submit / ACK / Partial Fill / Fill
→ Position / Fee / Funding / PnL
→ FLAT
```

`ExecutionValidationSignal` 只接受 runner 明确设置的 `LONG / SHORT / FLAT / HOLD`。它不读取均线，不声称预测价格，也不进入 Strategy Lab。

`PerpBot` 现在通过 `PerpSignalSource` 接收 signal；原 `MovingAverageSignal` 仍是默认 paper/testnet baseline，但不再与执行内核硬绑定。

## 2. P0：确定性 Core 验证

运行：

```bash
npm run validate:perp
```

冻结场景：

1. 显式 target `LONG 1 BTC-PERP @ 100`；
2. 每张订单按 `40% + 60%` 两次 Fill；
3. 收取 `10 bps` 模拟 fee；
4. 对 LONG 应用一次 `+10 bps` funding，并重复发送同一 fundingId 验证幂等；
5. 显式 target `FLAT @ 110`；
6. 核对 gross trading PnL、fee、funding 与最终 realized PnL；
7. 独立场景验证 initial-margin preflight 拒单；
8. 独立场景验证 liquidation boundary 上下各一个 mark。

当前冻结结果：

| Check | Evidence | Result |
| --- | --- | --- |
| Order lifecycle | 2 Submit / 2 ACK / 4 Fill / 2 partial-fill orders | PASS |
| Position round trip | `FLAT → LONG 1 → FLAT` | PASS |
| PnL | `10 gross - 0.21 fee - 0.10 funding = 9.69 realized` | PASS |
| Funding | payment `-0.10`；重复 fundingId 不重复入账 | PASS |
| Margin preflight | equity `1 < 50 required`；0 submissions | PASS |
| Liquidation boundary | `94.74` safe；`94.73` triggers simulated liquidation | PASS |

## 3. P1：Authenticated Testnet

P0 不证明交易所连接。P1 必须使用独立的显式 validation target 完成：

```text
preflight FLAT + no open orders + reconciliation consistent
→ target LONG
→ venue ACK / Fill
→ target FLAT
→ venue ACK / Fill
→ authoritative Position FLAT + no open orders
→ final reconciliation consistent
```

P1 报告必须记录真实 exchange order id、fill id、fee、成交数量与权威快照。没有凭证或 preflight 不满足时 fail closed；不得使用 MA crossover 代替验证 trigger。

### 2026-10-04 Recovery evidence

使用已配置凭证只读查询 Binance USDⓈ-M Futures Testnet，没有 submit / cancel / position mutation：

```text
venue position = SHORT 0.001 BTC-PERP
venue entryPrice = 83932.5
venue openOrders = 0

local checkpoint position = SHORT 0.001 BTC-PERP
local checkpoint unresolved orders = 1
```

结论：venue 与 local position 方向/数量一致，但本地仍认为存在未决订单，且双方都不是 FLAT。P1 被 preflight 正确阻止，没有通过删除 checkpoint 假装干净。

在获得用户明确授权后，以交易所权威快照为 guard，只在“`SHORT 0.001` 且 open orders 为 0”的精确前置条件下提交一次 `BUY 0.001 BTCUSDT MARKET`：

| Evidence | Value |
| --- | --- |
| client order id | `BTC-PERP-RECOVERY-1791153962491` |
| exchange order id | `28618222711` |
| fill id | `BTCUSDT-TRADE-543942371` |
| fill | `BUY 0.001 @ 86343.9` |
| fee | `0.03453756 USDT` |
| authoritative result | `FLAT`，open orders `0` |

旧 checkpoint 被保留为 recovery evidence，没有覆盖或伪造收敛状态。P1 使用独立 checkpoint 启动。

### 2026-10-04 Authenticated round-trip evidence

运行入口：

```bash
npm run validate:perp:testnet
```

该入口使用显式 `ExecutionValidationSignal`，不读取双均线。preflight 要求 local/venue 同时 FLAT、venue open orders 为 0、reconciliation consistent 且 `recoveryRequired=false`；任一条件不满足即在启动行情和下单前 fail closed。

| Check | Evidence | Result |
| --- | --- | --- |
| Preflight | local/venue `FLAT`；open orders `0`；reconciliation consistent | PASS |
| Open | `BTC-PERP-1` → exchange order `28618225349` → fill `BTCUSDT-TRADE-543942854` | PASS |
| Open fill | `BUY 0.001 @ 86368.3`；fee `0.03454732 USDT` | PASS |
| Close | `BTC-PERP-2` → exchange order `28618225360` → fill `BTCUSDT-TRADE-543942856` | PASS |
| Close fill | `SELL 0.001 @ 86330.1`；fee `0.03453204 USDT` | PASS |
| Position round trip | `FLAT → LONG 0.001 → FLAT` | PASS |
| Local accounting | total fees `0.06907936 USDT`；realized PnL `-0.10727936 USDT` | PASS |
| Final authority | venue `FLAT`；open orders `0`；reconciliation consistent | PASS |

本次 round trip 很短，没有跨交易所 funding settlement，因此报告诚实记录为 `NOT_OBSERVED`，没有注入本地合成 funding。

另以只读 signed endpoint 查询 2026-09-27T22:51:54.424Z 至 2026-10-04T22:51:54.424Z 的账户历史，观察到 10 条 BTCUSDT `FUNDING_FEE` 权威流水。它们证明 adapter/账户能够取得真实 funding ledger，但属于此前 Testnet 仓位，**不归因于本次 LONG → FLAT**。

## 4. P2：Live Micro-Capital

P2 不是 P1 自动升级。只有用户明确授权、venue/账户/仓位上限/最大亏损/退出方式全部冻结后，才允许小额真实资金验证。P2 仍只验证 connectivity 与 execution semantics，不证明策略盈利。

## 5. 当前限制

- P0 的 simulated fee/funding 是确定性会计输入，不是 venue 真实账单；
- P0 的 liquidation 是 Core 风险边界，不是交易所 liquidation engine 复刻；
- P0 不证明 spread、depth、latency、partial-fill distribution 或 user-stream gap；
- P1 已观察到交易所权威历史 funding ledger，但本次短时往返未跨 funding settlement；
- P1 的一次成功 round trip 不证明 ambiguous submit、user-stream gap、重启恢复或长期无人值守；
- P2 的 funding 验证仍必须来自交易所权威记录，不能用本地合成事件替代。
