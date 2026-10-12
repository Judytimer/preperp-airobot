# Mainnet Micro-Capital v1

状态：`IMPLEMENTED / NOT YET EXECUTED`

目的：用一次下单前估算不超过 25 USDT 名义金额、1× 杠杆的 Binance USDⓈ-M 主网往返，验证真钱环境的成交、手续费、滑点、状态恢复和最终对账。它不验证持续盈利，也不把 Testnet 盈利当作 Mainnet 准入条件。

## 设计分类

### 业务不变量（必须保留）

- AI、Shadow Review 和研究结论都没有下单权；只有确定性 Risk/Execution 边界可以提交订单。
- `submit()` 不是 ACK；ACK 和 Fill 只来自 Binance user data stream。
- 本地状态不是交易所事实；开始和结束都以权威 snapshot/reconciliation 为准。
- 开始前全账户所有仓位必须为零、所有挂单必须为零，且本地状态为 `FLAT`。
- One-way、Isolated、Single-Asset Margin、1× leverage。
- 进场名义金额有显式用户上限，并受代码内 25 USDT 硬上限约束。
- 平仓请求必须是 `reduceOnly=true`，不能穿越零点反向开仓。
- 下单超时或 Binance `503 unknown` 不得盲目重试；使用原 clientOrderId 查询并等待 user stream/权威状态。
- 取消意图不是订单终态；多张活动订单必须分别按 clientOrderId/exchangeOrderId 归属，冲突订单全部收到权威终态后才能改变方向。
- 最终必须 `FLAT + no open orders + reconciliation consistent`。无法自动恢复时进入人工复核，而不是继续交易。

### 阶段性约束（可在新证据下替换）

- 25 USDT 硬上限、1× 杠杆、10 分钟 plan TTL、100 bps 最大价格漂移。
- 每个 plan 只做一次 entry → immediate FLAT，不持仓等待策略退出。
- 只支持 Binance USDⓈ-M USDT perpetual。
- 市价单用于缩短暴露时间；未来可用有证据支持的限价/IOC 方案替换。

25 USDT 是提交前按实时 last price 计算的 request cap，不是 MARKET Fill 的绝对成交额保证；真实成交名义金额会按 Fill 写入结果证据。若要提供严格成交价上界，应升级协议为带价格边界并正确处理 partial Fill 的 IOC 方案。

这些约束的变更应通过新的协议版本完成，而不是在 v1 上叠加例外。

### 已替换的偶然实现假设

- Binance connector 不再把 Testnet URL 当成自身身份；环境端点由 `TESTNET | MAINNET` 显式选择。
- “退出单与普通订单相同”已被替换：Risk 根据当前/目标仓位推导 reduce-only。
- “每次运行都可复用 `BTC-PERP-1`”已被替换：真钱 clientOrderId 包含 plan hash 命名空间。
- “运行命令即等于授权”已被替换：只读 plan 与精确一次性 arm 分离。
- “一次只能有一张活动订单”已被替换：tracker 和 connector 按双重订单身份处理并发、乱序事件，Bot 在反向前先收敛所有冲突订单。
- “取消请求本身是一种订单状态”已被替换：`cancelRequested` 是正交意图，ACK/Fill 不会把它清除，只有交易所终态或完全成交结束生命周期。
- “CANCELED 是唯一非成交终态”已被替换：`CANCELED / EXPIRED / EXPIRED_IN_MATCH / REJECTED` 使用统一 terminal event。
- “Testnet 盈利后才可上真钱”不作为准入规则；Testnet PnL 不具备经济证据价值。

## 两阶段协议

### 1. Prepare（只读）

必需配置：

```dotenv
BINANCE_MAINNET_API_KEY=...
BINANCE_MAINNET_API_SECRET=...
PREPERP_MICRO_SYMBOL=ETHUSDT
PREPERP_MICRO_SIDE=LONG
PREPERP_MICRO_QUANTITY=...
PREPERP_MICRO_MAX_NOTIONAL_USDT=...
```

运行：

```text
npm run mainnet:micro:prepare
```

Prepare 读取账户、symbol filters 和当前市场价格，不发订单、不改杠杆。它生成不可覆盖的 `work/mainnet-micro-v1/plans/<planId>.json`。planId 是 plan payload 的 SHA-256；任何字段被修改都会失效。

### 2. Execute（真钱）

在 plan 过期前，人工核对 symbol、side、quantity、estimatedNotionalUsdt、maxNotionalUsdt，然后额外设置：

```dotenv
PREPERP_MAINNET_PLAN_ID=<prepare 输出的 64 位 planId>
PREPERP_MAINNET_ARM=EXECUTE_REAL_MONEY_ONCE:<同一个 64 位 planId>
```

运行：

```text
npm run mainnet:micro:execute
```

执行器先完成只读预检并启动 user stream，然后重新检查全账户和 Binance 历史订单；只有这些检查通过后才原子创建 `.runtime/mainnet-micro-v1/<planId>.execution.lock`。订单使用由 planId 派生、符合 Binance 36 字符限制的 clientOrderId 前缀，执行前后都能在交易所历史中识别该 plan。锁不会自动删除，因此授权一旦消费，崩溃或失败后同一 plan 也不能盲目重放。成功证据写入 `work/mainnet-micro-v1/results/<planId>.json`。

本地锁解决单机进程竞争，交易所历史检查解决已经到达 Binance 的跨主机重放。两个主机在完全相同的瞬间首次启动不具备交易所原子分布式锁保证，因此 v1 的操作前提仍是专用账户只运行一个执行器；相同 clientOrderId 会让交易所拒绝重复身份，但不能取代这个操作约束。

## 账户与密钥前提

- 使用专门的微额账户或子账户；账户内不要存在其他仓位和挂单。
- API key 只授予 Futures 交易权限，不授予提现权限，并绑定固定 IP。
- plan 同时冻结 commit 与关键执行源码的 SHA-256 指纹；Execute 要求两者都与 Prepare 时完全一致。
- 账户预先设为 One-way、Isolated、Single-Asset Margin。
- 数量必须满足实时 `MARKET_LOT_SIZE`、`stepSize` 和 `MIN_NOTIONAL`；系统不会替用户放大数量。
- 不要把 key/secret 提交到仓库；`.env` 已被 Git 忽略。

## 证据解释

一次成功往返只回答：真钱链路是否能正确完成 entry、ACK、Fill、reduce-only exit、费用记录和最终对账。

entry 部分成交后即使余量随后 `EXPIRED` 或 `CANCELED`，执行器也按权威实际持仓发出 reduce-only 退出；如果退出被拆成多张订单，必须等所有活动订单终止并再次按实际余仓收敛。异常 submit 会继续观察同一 clientOrderId 和账户状态，不会换 ID 重发；仍无法判定时进入隔离/紧急减仓路径。

报告同时保留 Binance 的逐成交 realized PnL 与按资产汇总的手续费。只有手续费资产全部是 USDT 时才计算 `netPnlUsdt`；存在 BNB 等非 USDT 费用而没有可靠换算价格时，该字段为 `null`，不会伪造统一币种净收益。

它不回答策略是否盈利。盈利可能性应在闭环后另建前瞻、不可回填的样本序列，至少报告：净 PnL、手续费、滑点、胜率、收益分布、最大回撤和失败/数据阻塞次数，而不是用单次结果晋级。

## 当前验证状态

- 静态类型检查：`npm run typecheck`。
- 确定性真钱 runner 仿真：覆盖 `partial entry → EXPIRED → actual-position reduce-only exit → fee/PnL evidence → final FLAT reconciliation`。
- 多订单回归：覆盖多张同向订单乱序成交，以及冲突 entry 全部取消确认后才允许退出。
- 全量测试：191 项，其中 189 通过、2 项因当前 Windows 环境缺 POSIX Bash 而跳过。
- 主网真实订单：尚未执行；因此状态仍是 `IMPLEMENTED / NOT YET EXECUTED`。

## 官方接口依据

- [Binance USDⓈ-M General Info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info)
- [New Order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order)
- [Exchange Information](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information)
- [Get Current Position Mode](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Get-Current-Position-Mode)
