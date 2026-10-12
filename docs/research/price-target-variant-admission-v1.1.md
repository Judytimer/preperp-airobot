# Price-Target Admission v1.1 — XRP Asset Extension

状态：`FROZEN / PROSPECTIVE FROM DEPLOYMENT`

版本：`PRICE_TARGET_ADMISSION_V1_1_0`

## 为什么扩展

2026-10-08 的真实 Polymarket active search 显示，固定时间 `above ___` 加密价格目标市场不只覆盖 BTC、ETH、SOL；XRP 同时存在多个活跃 episode。Binance Spot `XRPUSDT` 可提供协议指定的 1m final close，Binance USDⓈ-M Futures Testnet 的 `XRPUSDT` perpetual 也处于 `TRADING`。

因此 v1.1 只增加一个由真实供给触发的资产 cohort：

```text
PRICE_TARGET_V1_XRP
```

本次没有为了增加样本而降低任何 Candidate admission 条件。

## 不变规则

XRP 与原 v1.0.0 完全共用以下规则：

- admission unit 仍为 `asset × measurementAt`；
- 首次发现锁定 owner event 和 strictly nearest-OTM strike；
- `candidateT0` 仍为第一次完整 Binance Spot 1m upward crossing；
- 只允许使用已经归档且不晚于 T0 的 YES book；
- `candidateT0 < measurementAt - 4h`；
- 缺证据 fail closed；
- 不允许历史回填、换 strike 或事后选择 episode。

旧 `PRICE_TARGET_ADMISSION_V1_0_0` manifest 保持可验证，但只允许 BTC、ETH、SOL。XRP manifest 必须使用 v1.1。

## 研究与执行边界

本扩展允许 XRP 进入：

```text
prospective discovery
→ admission
→ BUY_YES paper smoke
→ TESTNET_DEMO_ONLY execution smoke
```

它不把 XRP 加入既有 `Directional Study v1.1`。该 study 的 BTC、ETH、SOL cohort 和 activation boundary 保持原样；XRP Candidate 不得计入其 Stage A / Stage B。

XRP 的 Binance Testnet 映射仍然只是同资产执行链路演示：

```text
XRP Candidate
→ XRPUSDT perpetual LONG
→ first Fill
→ deterministic reduce-only FLAT
```

它不声明 `BUY_YES → LONG perp` 已具有方向 alpha，也不授权 Mainnet。

## 后续资产如何加入

不接受“Binance 有这个币”作为充分理由。新增资产必须同时满足：

1. Polymarket 已出现相同 fixed-time ABOVE 语义的活跃市场；
2. resolution rules 明确引用对应 Binance Spot `ASSET/USDT` 1m final close；
3. Binance Spot 与 Futures Testnet 都支持对应 symbol；
4. parser、数量步长、最小名义额和独立 cohort 均已显式验证；
5. 只接收扩展生效后的 prospective evidence。

因此当前执行池是 `BTC / ETH / SOL / XRP`，但架构边界是“经验证的市场供给集合”，不是永久的三币或四币白名单。
