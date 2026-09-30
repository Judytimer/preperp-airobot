# 交易机器人 Buy vs. Build 架构审查（2026-09-27）

## 0. 审查范围与结论先行

本审查基于当前分支 `58130b9` 的实际源码、测试和既有审查记录，不重新设计架构，不改变双均线策略，也不把 Hummingbot、NautilusTrader 或 Passivbot 整体搬进来。

当前仓库仍是**本地 paper simulator**：`ExecutionVenue` 只有 `SimulatedExchange` 实现；没有 Binance REST / WebSocket、签名、真实 symbol filter、真实重连或真实账户同步代码。因此，现在不存在一坨应立即用 CCXT/SDK 替换的自研交易所网络代码。最克制的决定是：**周一闭环前保持执行链不动**。

库的“最新版本/API 名称”在本轮环境中无法联网复核（Web 查询返回 401，npm registry 返回 403）。以下对库的判断采用稳定的能力边界，不声称核验了 2026-09-27 的具体版本；真正安装时应从官方来源重新确认包名、版本、Binance Futures 支持范围和维护状态：

- [CCXT Manual](https://docs.ccxt.com/)
- [Binance Connector TypeScript](https://github.com/binance/binance-connector-typescript)
- [trading-signals](https://github.com/bennycode/trading-signals)
- [decimal.js](https://github.com/MikeMcl/decimal.js)
- [Zod](https://zod.dev/)
- [p-retry](https://github.com/sindresorhus/p-retry)

这不影响对当前源码 ownership 的判断。

## 1. 什么必须由项目自己掌握

| 语义 | 结论 | 当前证据与边界 |
| --- | --- | --- |
| Signal | **保留策略语义；计算原语可借库** | `MovingAverageSignal` 决定 warm-up、LONG/SHORT/HOLD 和 reason，这是策略行为；`sma()` 本身只是数学原语。 |
| Risk | **自己保留** | `RiskManager` 把目标方向转换为目标仓位 delta，并对 projected position 限仓。库可以提供数值工具，不能替项目决定风险许可。 |
| OrderIntent / client identity | **自己保留，并应显式命名** | 当前 `SubmitOrderCommand + OrderRequest` 已是最小 intent，且 client ID 在越过 venue boundary 前生成、跟踪、持久化。这正是 ambiguous submit 的基础。无需为改名而改名。 |
| Order State Machine | **自己保留** | `SUBMITTED / ACKED / PARTIALLY_FILLED / CANCEL_REQUESTED / FILLED / CANCELED` 以及 transition validation 是项目最有价值的交易语义。SDK 的订单 DTO 不能代替本地可恢复状态机。 |
| ACK / Fill 分离 | **自己保留** | `ExecutionEvent` 已把 order update、trade/fill 和 cancel ack 分开，且 Fill 只经事件入口改变仓位。adapter 只负责翻译权威外部事实。 |
| Partial Fill 与幂等 | **自己保留** | tracker 用 remaining quantity 和 fill ID 去重；PositionBook 也用 fill ID 防重复记账。这些不能委托给一个“createOrder 返回值”。 |
| Position | **自己保留本地 ledger/mirror** | 开平仓、跨零、手续费、realized PnL 和 funding 的应用规则属于可解释交易核心；交易所 position snapshot 是用于核对的权威外部事实，不应直接悄悄覆盖本地账本。 |
| Projected Position | **坚决自己保留** | 当前用 filled position 加 unresolved order 的 remaining quantity 防止 Fill 延迟期间重复加仓，是策略、风控与执行之间的核心安全语义。 |
| Margin / Perp semantics | **保留领域语义，但不要假装交易所风控引擎** | last/mark/index 分工、funding 方向、initial/maintenance margin 和 liquidation trigger 值得自己掌握；真实 tier、fee、contract size、hedge/one-way mode 等由 adapter 映射交易所元数据。当前简化模型只适合 paper。 |
| Ambiguous submit | **必须自己保留，当前只完成一半** | submit 前持久化 `SUBMITTED` 很正确；但 submit 抛出 timeout/error 后，进程内没有显式 `UNKNOWN`/reconciliation gate。绝不能用通用 retry 再发一次。真实接入前应以同一 `clientOrderId` 查询订单/成交并进入 reconciliation。 |
| Ghost order | **自己负责发现和处置** | 本地/交易所 open orders 差异已能报告 missing/unexpected order；snapshot 的取得可由 SDK 完成，但“是否停机、如何收敛”必须由 Core 决定。 |
| Reconciliation | **自己保留决策，SDK 只取证** | `reconcileState()` 当前是只读 diff，刻意不猜谁覆盖谁，这是正确边界。它还不是 recovery executor。 |
| Recovery | **自己保留** | checkpoint 对 unresolved orders fail-closed，recovery evidence 要求账户、venue、完整 open orders、terminal facts 和 fills。SDK 只能提供证据，不能决定何时解除交易 gate。 |

### 当前状态机需要诚实承认的缺口

这些缺口**不是周一 local simulator 闭环的阻塞项**，但是真实 Binance 接入前的 gate：

1. 此前 `submit()` return 与 `ORDER_ACK` event 存在双 ACK contract；当前已收口为 command completion 与 venue fact 分离，`submit(): Promise<void>`，`ORDER_ACK` event 是唯一 ACK fact path。
2. 没有 `REJECTED / EXPIRED / UNKNOWN`，也没有“进程仍活着但 submit timeout”的运行态 gate。当前 checkpoint 只会在**重启后**将 unresolved order 变成 `RECOVERY_REQUIRED`。
3. `processFill()` 要求先有 matching exchange order ID，因此不能处理“user stream Fill 先于 REST ACK 被本地观察到”的乱序；当前测试的 out-of-order 是不同订单之间乱序，不是同一订单的 Fill-before-ACK。
4. `CANCELED` 后的新权威 Fill 被静默拒绝。模拟器会在 cancel 后抑制未执行 Fill，所以现有闭环不会触发真实 cancel/fill race；真实 connector 需要 terminal-order retention、trade-ID 幂等以及 quarantine/reconciliation，而不是把 SDK 状态直接塞进 Position。
5. reconciliation 用 `clientOrderId` 对 exchange snapshot 的 `orderId`，这要求 adapter 明确保证该字段是 client ID；真实 exchange order ID 与 client order ID 必须分别建模，不能靠命名猜测。

## 2. 哪些是重复造轮子，哪些当前其实没有造

| 检查项 | 当前实现 | 推荐 | 为什么值得换/不换 | 替换后项目仍保留 |
| --- | --- | --- | --- | --- |
| REST / WebSocket | **没有真实实现**；只有 simulator 和离线 Coinbase candle artifact mapper | Binance-only 用官方 SDK；多 venue 再评估 CCXT/CCXT Pro | 现在无代码可替换。将来不应手写 HTTP、listen key、订阅协议和 wire DTO | `ExecutionVenue`、事件归一化 contract、OrderTracker、reconciliation policy |
| 签名 / 时间偏移 / request serialization | 没有 | 官方 Binance SDK（或 CCXT） | 这是低学习价值且易错的基础设施 | client ID、intent persistence、ambiguous-result handling |
| symbol / precision / filters | 仅有 `configSafeSymbol()` 生成本地 ID；业务数值统一 `round(..., 8)` | 由 SDK/CCXT 取得 exchange metadata；项目写薄 mapping；金额计算用 `decimal.js` | 真实 tick size、step size、min notional、contract size 不能用固定 8 位小数替代 | “何时/向哪个安全方向量化”、量化后再过 risk、拒单解释和审计 |
| 普通 retry | 当前没有通用 retry | 闭环后可对**幂等 GET、行情 bootstrap、snapshot 拉取**用 `p-retry` 或很薄的 bounded backoff | 省去 retry/backoff plumbing | operation classification、deadline、retry budget、停机规则；`createOrder` 禁止无脑 retry |
| 指标计算 | 自写 `sma()` 约十余行 | **保持不动**；指标明显增多后才考虑 `trading-signals` | 当前实现简单、可读、测试面小；现在加依赖没有净收益 | Signal 的 warm-up、采样输入、action/reason 和策略参数 |
| decimal 精度 | `number + round(8)` 广泛用于 qty/PnL/margin/funding | **真实交易接入前**在 money/qty/notional ledger 边界采用 `decimal.js`，一次做窄迁移 | JS binary float 和固定 8 位不是交易所精度模型；但周一模拟数据足够 | rounding policy、exchange filters、domain invariants、序列化格式 |
| schema validation | state store、recovery evidence、Coinbase artifact 各自手写校验 | 外部 JSON ingress 增多后用 Zod | 可减少 shape-check boilerplate并生成清晰错误；现在仅几个边界，迁移不紧急 | 跨字段业务不变量：symbol/account 一致、fill 不超 remaining、证据完整性、T0/provenance 规则 |
| reconnect | 没有 | SDK WS 能力 + 项目自己的 resync gate | transport 重连可借库；“重连后是否安全交易”不能借库 | sequence/gap detection、snapshot+delta 重建、reconciliation-required、恢复放行 |
| polling / backoff | 没有通用实现 | SDK/`p-retry` 仅处理 transport；调度可保持简单 | 不要为了尚不存在的问题引入 scheduler subsystem | 查询对象、freshness、超时后的业务状态与 fail-closed policy |
| exchange-specific boilerplate | 没有 Binance adapter；Coinbase 文件是 research artifact admission，不是 execution connector | 将来只在薄 adapter 中使用 SDK DTO | 让 vendor 字段留在 adapter 外会污染核心；但当前 mapper 的 checksum/envelope/provenance 是研究语义，不应被通用交易 SDK 删除 | canonical Tick/Order/Fill types、artifact admission、领域验证 |

### p-retry 的明确红线

可以自动重试：exchange-info、open-orders、position、trade-history 等只读查询（仍需 bounded deadline）；可证明幂等的订阅建立；写入本地临时文件等。

不能直接自动重试：`createOrder`、非幂等改单/撤单组合、无法证明服务端是否受理的资金或仓位写操作。正确流程是：

```text
persist OrderIntent + clientOrderId
  -> submit once
  -> ACK | REJECTED | UNKNOWN
  -> UNKNOWN: stop new risk, query by clientOrderId + trades + open orders + position
  -> reconcile
  -> only then decide whether a new intent is allowed
```

“同一个 clientOrderId 再发也许会被交易所拒重”只能作为 venue contract 的已验证能力，不能作为通用 retry 假设。

## 3. CCXT 还是 Binance 官方 SDK

### 针对 9 月 28 日周一晚的决定

**两者都不引入。保持当前 `SimulatedExchange` 不动。** 当前目标是完整本地/模拟闭环，而现有 adapter 已覆盖 command/event 分离、ACK、partial fill、cancel ack、delayed fill，并有测试。现在替换只会把“本地闭环”改成“依赖网络、凭证、testnet 行为和新 DTO 的接入项目”。

### 闭环后的选择规则

1. **只做 Binance 永续，优先 Binance 官方 TypeScript SDK。** 原因不是它替我们管理订单状态，而是它最适合承担 Binance 认证、REST/WS transport、请求/响应类型及协议演进。外面包一层薄 `BinanceExecutionVenue`，把 vendor event 翻译为现有 canonical ACK/Fill/Cancel 事件。
2. **只有明确要接第二家交易所，而且已经出现可列举的重复 adapter 工作时，才选择 CCXT。** 需要的不是“未来可能多交易所”，而是实际需求：同一组 fetch markets/open orders/positions/trades 与 submit/cancel 正在被第二次实现。
3. **即使用 CCXT，也只放在 ExchangeAdapter 之下。** 不允许 strategy/risk 直接调用 `createOrder()`；不把 CCXT order object 当项目状态机；不依赖统一字段掩盖 reduce-only、position side/mode、contract size、funding、margin mode 等 venue 差异。
4. 如果首要任务是最快做一个**只读多交易所 market-data prototype**，CCXT 可以提前；这不是当前周一 execution 闭环目标。

### 闭环后再迁移的事项

- Binance exchange-info 与 symbol/filter mapping；
- REST snapshot + user-data stream adapter；
- SDK transport reconnect 后的 snapshot resync；
- decimal quantity/price normalization；
- external payload schema；
- ambiguous submit 查询与恢复流程。

不要把 SDK 引入、decimal 全仓迁移、Zod 全仓迁移、状态机扩展和真实 testnet 接入合成一个 PR。

## 4. 学习价值不会被库侵蚀的边界

```text
┌──────────────────────────────────────────────────────┐
│ 我们拥有                                              │
│ 策略 / AI（无 execution authority）                  │
│   ↓                                                  │
│ Signal（action、warm-up、reason）                    │
│   ↓                                                  │
│ Risk（target/delta、limits、margin gate）             │
│   ↓                                                  │
│ OrderIntent（client ID、持久化、审计）                │
│   ↓                                                  │
│ Execution orchestration / OrderTracker               │
│ （ACK/UNKNOWN、partial fill、cancel race、幂等）      │
│   ↓                                                  │
│ ExchangeAdapter（canonical mapping、venue semantics）│
└──────────────────────────┬───────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────┐
│ 第三方拥有                                            │
│ CCXT 或 Binance SDK                                  │
│ （HTTP/WS、签名、序列化、基础 transport reconnect）  │
└──────────────────────────┬───────────────────────────┘
                           ↓
                        Exchange

旁路但仍由我们拥有：
Fill -> Position ledger -> Projected Position -> Margin/Risk
                         ↘ checkpoint / reconciliation / recovery
```

具体分界：第三方可以告诉我们“Binance 发来了什么”，也可以替我们可靠地编码请求；第三方不能替我们回答“这个消息能否推进本地订单状态”“timeout 后是否还能下新单”“partial fill 后风险暴露是多少”“recovery evidence 是否足够”“什么时候解除 halt”。这几项正是项目展示永续交易工程能力的地方。

## 5. 克制的行动清单

### A. 周一闭环前必须改

**没有必须修改的源码。保持不动。**

当前 `npm test` 和 `npm start` 已足以证明 local paper 的 Signal → Risk → submit → ACK → delayed Fill → Position 路径。周一运行前只需确认 `.runtime/perp-bot-state.json` 是希望恢复的场景还是旧实验残留；不要为了方便而让程序自动忽略 unresolved checkpoint，因为 fail-closed 是正确行为。

### B. 闭环后值得替换成成熟库

1. Binance-only 实接时，用官方 SDK 承担签名、REST/WS 和 wire types；若需求变为真实多 venue，再基于两个 adapter 的重复证据评估 CCXT。
2. 真实金额/数量进入 adapter 和 ledger 前，用 `decimal.js` 替代固定 `round(8)`；不要在周一前全仓改数值类型。
3. 外部 payload 增多后，在 adapter/recovery/checkpoint ingress 使用 Zod；业务跨字段 invariant 仍留在 domain code。
4. 幂等 read/reconciliation 请求出现重复 backoff 代码时才引入 `p-retry`；永不把 `createOrder` 包进去。
5. `trading-signals` 暂不引入；等指标数量、增量计算或研究路径确实让当前 `sma()` 成为维护负担再决定。

### C. 坚决自己保留

- Signal 的业务输出与策略解释；
- Risk、target-position delta、projected exposure 和 margin gate；
- OrderIntent/clientOrderId 的 submit-before-send persistence；
- ACK / UNKNOWN / order updates 与 Fill/trade facts 的分离；
- partial fill、cancel/fill race、fill idempotency 与 terminal order retention；
- Position、PnL/funding 应用规则和本地 ledger；
- ghost-order detection、reconciliation policy、checkpoint 和 recovery gate；
- last/mark/index 的角色及永续领域映射。

### D. 目前不要碰

- 整体迁移 Hummingbot/NautilusTrader/Passivbot；
- 为“未来可能多交易所”现在引入 CCXT；
- 重写当前策略或换指标框架；
- event sourcing、消息总线、数据库、通用 workflow engine、插件系统；
- 模拟生产级 liquidation engine、全交易所 margin tier 或 HA/leader election；
- 把只读 reconciliation 直接升级成未经规则冻结的自动覆盖；
- 同一个 PR 同时做 SDK、decimal、Zod、状态机和 testnet。

## 6. 最应该砍掉或简化的 1～3 处

1. **已砍掉双 ACK 通道**：当前 simulator 与 `ExecutionVenue` 均以 event 作为唯一订单 ACK 事实入口；command Promise 只表达 transport/command completion。
2. **砍掉固定 `round(8)` 充当 exchange precision model 的想象**：paper 阶段保留这个小工具；真实 adapter 到来时，把 precision/filter/decimal 收拢到一个薄 normalization boundary，而不是继续把 round 散落到领域代码。
3. **砍掉“每个入口手写 shape parser”的增长趋势**：现有校验保持不动；新增真实 REST/WS payload 时只在 ingress 用 Zod，解析后立即转换成项目 canonical types，不把 Zod schema 或 vendor DTO 传播到 Order/Risk/Position。

一句话：**业务语义自己拥有，网络与数值基础设施借成熟库；眼下最有价值的动作不是换框架，而是先用现有 simulator 完成周一闭环。**
