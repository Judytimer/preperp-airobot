# PrePerp 中文桌面控制台

PrePerp Control Room 是一个基于 Tauri 的本地量化运行时观察与监督界面。它把 Prediction watcher、确定性 Candidate、本地 Laya Shadow Review、Binance Futures Testnet consumer 和权威 reconciliation 放在同一条中文可视化链路中。

桌面端负责监督进程与展示事实，不拥有任意交易权限。

## 当前能力

桌面端可以：

- 确定每个用户独立的本地 runtime data boundary；
- 检查并启动 loopback Laya 服务；
- 区分“服务已启动但模型未加载”和“模型已就绪”；
- 监督固定的 prospective watcher 入口，并在异常退出后重新启动；
- 读取最新的不可变 Daily Price-Target 与 Hourly Up/Down scan；
- 展示两个 watcher lane、监控资产、数据新鲜度和 Admission 数量；
- 展示最新的不可变 Laya Candidate Shadow Review；
- 展示 Candidate、T0、方向、YES ask 与证据边界；
- 展示 Binance Testnet 的 ACK、Fill、Position、FLAT 和 reconciliation 状态；
- 展示冻结的 AI、Testnet 与 Mainnet 权限边界；
- 武装一个多资产 `TESTNET_DEMO_ONLY_V1` one-shot consumer。

One-shot consumer 只等待启动后出现的新 prospective Candidate。命中后，它会执行一次极小 Binance Futures Testnet round trip，权威确认 `FLAT`、写入不可变 evidence，然后自动退出。

## 明确不能做什么

桌面端不能：

- 提交 Binance Mainnet 订单；
- 修改 Admission Protocol；
- 修改 Strategy 或 Risk 参数；
- 把 Laya 判断提升为交易授权；
- 自动宣称 Prediction→Perp directional edge；
- 使用历史 Candidate 补单；
- 启动第二个 collector 与主 watcher 争夺 evidence writer 权限。

系统始终保持：

```text
一个 supervised watcher
→ 一个 evidence writer
→ 多个只读消费者
```

## 技术架构

```text
React / TypeScript / TanStack Query
                │
          fixed Tauri IPC
                │
        Rust local supervisor
        ├─ Laya health / model state
        ├─ prospective watcher
        ├─ Testnet one-shot consumer
        └─ immutable runtime evidence
```

Renderer 只能调用以下固定 Tauri commands：

```text
ensure_laya
ensure_watcher
ensure_prediction_testnet
system_status
```

Renderer 没有任意 shell 权限，不能传入自定义进程参数，也不会接收 Binance API credentials。

## 本地开发

从仓库根目录运行：

```powershell
npm run desktop:install
npm run desktop:dev
```

构建与 Rust 检查：

```powershell
npm run desktop:check
```

开发模式读取仓库现有的：

```text
work/
.runtime/
```

打包后的 host 应显式设置 `PREPERP_DATA_ROOT`；未设置时，release build 使用 Tauri application-data directory。

可选 runtime overrides：

```text
PREPERP_WORKSPACE_ROOT
PREPERP_DATA_ROOT
PREPERP_BUILD_COMMIT
LAYA_HOME
LAYA_BASE_URL
```

如需自动启动 Laya，`LAYA_BASE_URL` 必须指向 loopback 地址。

## Prediction 监控与 Testnet 映射

当前监控分成两条 lane：

| Lane | 资产 |
|---|---|
| Daily Price-Target | BTC / ETH / SOL / XRP |
| Hourly Up/Down | BTC / ETH / SOL / XRP / DOGE / HYPE / BNB |

Testnet one-shot consumer 监听七个小时级资产。小时 Candidate 的演示映射是：

```text
UP   → Testnet LONG
DOWN → Testnet SHORT
```

该映射严格限定为 `TESTNET_DEMO_ONLY_V1` execution smoke，不代表已证明方向 alpha。

任一资产执行前必须满足：

- Binance Testnet account 为 One-way；
- authoritative position 为 `FLAT`；
- open orders 为 `0`；
- 本地不处于 recovery state；
- symbol 已为 Isolated，或仅在确认空仓且无挂单时从 Cross 切换为 Isolated；
- 交易数量符合对应 symbol 的 `minQty`、`stepSize` 与 `minNotional`。

如果 symbol 已有 exposure 或 open orders，runner 不会修改 margin mode，也不会提交新订单。

## Laya Shadow Review 边界

每个成功 watcher cycle 最多把一个尚未审核的 `QUALIFIED` Candidate 发送给 loopback Laya 服务。输入是受限 evidence snapshot，只要求模型做证据一致性分类，不允许修改策略。

Review 结果以 append-only 方式保存到：

```text
work/price-target-v1/laya-shadow-v1/reviews/
```

Laya 请求失败时：

- 不改变 Candidate Admission；
- 不终止 watcher；
- 不阻断确定性 Risk；
- 不生成 fallback AI 判断；
- 不获得下单权。

界面显示的模型分数只用于观察，不用于任何执行授权。

## 当前安全结论

```text
Candidate 可以驱动 Testnet smoke
Laya 只能提供 Shadow evidence review
Risk 与 Exchange Fact 仍由确定性代码控制
Mainnet 始终关闭
```
