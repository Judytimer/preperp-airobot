# Monad / Perpl 链上交易整合

> 状态：2026-10-12 第一层已实现并通过本地与真实 RPC 只读验证；尚未接入钱包签名、抵押品或真实 Perpl 订单。

## 结论

Monad 适配不需要重写桌面端、Strategy、Risk、OrderTracker、PositionBook 或 Reconciliation。需要新增的是一个与协议订单状态正交的链上交易层。

```text
Strategy / Risk / Core order intent
                 │
                 ▼
         Perpl command router
          ┌──────┴────────┐
          │               │
 API-forwarded order   direct on-chain / account operation
 rq + sn/cid           calldata + external signer
          │               │
          │        Monad transaction coordinator
          │        nonce → simulate → sign → broadcast
          │        → receipt → finalized / reverted / unknown
          │               │
          └──────┬────────┘
                 ▼
     Perpl Order Update / WalletFill / snapshots
                 ▼
       OrderTracker / PositionBook / Reconciliation
```

链上 receipt 只证明 EVM 交易被执行或回滚。它不证明订单已经打开、成交或释放保证金。`ORDER_ACK`、`FILL` 和账户状态仍必须来自 Perpl 的协议事实。

## 旧设计分类

### 必须保持的业务不变量

- 本地意图不等于外部资金事实；
- 未解决的广播结果、nonce、订单身份或 stream gap 必须 fail closed；
- PositionBook 只接受带原生 fill identity 的成交事实；
- 对账保持只读，不能为了恢复运行而猜测覆盖；
- 私钥不进入 React renderer、日志、checkpoint 或 evidence；
- 不确定的交易不得盲目重发。

### 已替换的阶段性约束

旧计划将 raw transaction / finality engine 排除在第一阶段之外。这适用于“只演示 Perpl API forwarding”的旧里程碑，但不适用于用户要求的链上交易整合，现已替换为最小 Monad transaction coordinator。

旧计划还要求在获得完整账户访问前不写任何执行代码。现在保留“不得提交真实 Perpl order”的限制，但允许实现并验证协议无关的 RPC、nonce、模拟、receipt、finality 和持久化边界。

### 丢弃的实现假设

- 不把 `txHash` 塞进 `exchangeOrderId`；
- 不把 receipt success 转成 `ORDER_ACK` 或 `FILL`；
- 不假设每个 Perpl API order 都对应一笔用户钱包交易；
- 不用多个并发交易 nonce 表达多张相关订单；协议支持时优先编码为一个 `execOrders` 原子 batch；
- 不用固定确认数假装 finality。RPC 支持 `finalized` block tag 时才推进到 `FINALIZED`，否则停在 `INCLUDED`。

## 两条执行路径

### API forwarding

常规机器人交易优先使用 Perpl 的认证 WebSocket：

```text
clientOrderId
→ durable rq / sn allocation
→ Post / Change / Cancel
→ Command Status
→ authoritative Order Update
→ WalletFill
```

钱包只用于账户创建、抵押品、`allowOrderForwarding(true)` 和密钥 enrollment。订单并不需要每次弹出钱包签名。

### Direct on-chain

直接合约调用用于账户操作、需要原子性的 `execOrders`，或者明确选择的链上交易路径：

```text
intent persisted
→ expected chain ID verified
→ pending nonce reserved and persisted
→ eth_call simulation
→ eth_estimateGas
→ external signer
→ signed hash persisted
→ eth_sendRawTransaction
→ receipt
→ finalized / reverted / unknown
→ Perpl protocol fact reconciliation
```

当前仓库只接受已编码的 calldata，不自行猜测尚未冻结的 Perpl ABI。具体 order encoding 必须来自官方 ABI/SDK，并在 testnet fork 或真实 testnet 上验证后才能接入。

## 并发规则

- 同一 signer 的链上交易默认串行；本地和远端 pending nonce 共同确定下一个 nonce；
- journal 写入有全局锁，避免不同账户并发保存时相互覆盖；
- 一笔交易处于 `UNKNOWN`、`SIGNED`、`BROADCAST` 或 `INCLUDED` 时，同一 signer 不得扩张新风险；
- 多张相关订单优先使用 Perpl `execOrders` 形成一个原子交易，而不是竞速多个 nonce；
- API order 的并发仍由独立 `rq`、`sn/cid` 和协议 `oid` 处理，不能借用 EVM nonce 充当订单身份。

## 钱与权限边界

切到 Monad 不等于交易免费。真实闭环仍至少需要：

- 少量 `MON` 支付 gas；
- Perpl 要求的抵押品；
- 已创建的 exchange account；
- API forwarding 路径所需的 trade-scoped key 与 `fw=true`，或 direct on-chain 路径所需的外部 signer；
- 当前市场的最小订单量、价格刻度和风险上限。

在没有资金时，可以完整验证 RPC、链 ID、合约代码、nonce、模拟失败、journal、revert、unknown recovery 和桌面展示；不能诚实地宣称完成了订单/成交/盈亏闭环。

## 当前真实验证

2026-10-12 运行 `npm run monad:probe` 得到：

```text
network                 testnet
expected / observed ID  10143 / 10143
latest block            70424409
Perpl Exchange          0x1964C32f0bE608E7D29302AFF5E61268E72080cc
contract code           present
wallet                  not configured
authority               READ_ONLY
phase                   OBSERVE_ONLY
```

探测写入 `.runtime/monad-readiness.json`，桌面端只读取该 artifact。桌面 renderer 没有 signer，也没有任意 calldata 广播入口。

## 已实现

- HTTP JSON-RPC client 与严格 quantity/address/hash 校验；
- Monad mainnet/testnet 固定配置与运行时 chain ID 验证；
- Perpl Exchange bytecode readiness probe；
- 可选钱包原生余额与 pending nonce 只读探测；
- 原子 JSON transaction journal；
- `PLANNED → NONCE_RESERVED → SIMULATED → SIGNED → BROADCAST → INCLUDED → FINALIZED` 状态机；
- `SIMULATION_REJECTED`、`REVERTED`、`UNKNOWN` 失败分支；
- 外部 signer 接口；
- 同 signer 串行、多账户 journal 写锁和未知结果阻断；
- Tauri status 中的 Monad / Perpl 只读卡片；
- 并发、revert、ambiguous broadcast、wrong chain 和 finality 降级测试。

## 下一道真实门槛

下一步不是继续堆抽象，而是提供一个专用于 Monad testnet 的地址，并验证该地址的 `MON`、抵押品、exchange account、当前 Perpl context 和订单规格。之后才接官方 ABI/SDK encoder 与外部签名器，完成：

```text
one bounded testnet intent
→ one chain/API command
→ one authoritative order fact
→ cancel or fill
→ snapshots reconcile
→ FLAT / no open orders
```

## 官方依据

- [Monad Network Information](https://docs.monad.xyz/developer-essentials/network-information)
- [Perpl API Documentation](https://github.com/PerplFoundation/api-docs)
- [Perpl API Quickstart](https://github.com/PerplFoundation/perpl-docs/blob/main/docs/resources/for-developers/quickstart.md)
- [Perpl Delegated Account](https://github.com/PerplFoundation/delegated-account)
