# Checkpoint Recovery Learning Report

## 1. Problem

前两轮所有状态都只在内存中。进程重启会丢失仓位、已处理 Fill ID、订单剩余数量和模拟交易所序号，可能造成重复记账、`SIM-1` ID 冲突或把 unresolved order 当作不存在后重复下单。

## 2. Checkpoint Contract

`BotCheckpoint` 当前固定为 `version: 1`，保存：

- `PositionBook` 的 Position 与 `processedFillIds`；
- `InFlightOrderTracker` 的订单、symbol 与每单 `processedFillIds`；
- `SimulatedExchange.nextOrderId`；
- liquidation halt 状态；
- 最近一次业务状态写入时的 mark price。

Checkpoint 在 ACK、accepted Fill 和 liquidation 后写入。高频 Tick 本身不触发磁盘写入，避免让行情节奏直接受文件 I/O 支配。

## 3. Durability And Ordering

`JsonFileBotStateStore` 先写同目录临时文件，再 `rename` 覆盖目标文件，避免留下半截 JSON。Bot 内部还用 Promise 队列串行化 checkpoint 写入，避免相邻 Partial Fill 的旧状态后完成写入并覆盖新状态。

加载时校验版本和嵌套 Position/Order 字段。文件不存在表示首次运行；无效 JSON、未知版本和非法字段会抛错，不以空状态继续交易。

## 4. Restart Reconciliation

- 没有 open order：恢复 Position、幂等集合、halt 状态和下一 order ID，可继续 paper trading。
- 存在 `ACKED / PARTIALLY_FILLED`：设置 `RECOVERY_REQUIRED`，所有后续 Tick 停止策略和下单。

这是必要的保守行为。当前模拟 Exchange 的定时 Promise 无法跨进程恢复，也没有真实交易所 REST 查询可确认订单状态；自动标记 FILLED 或 CANCELED 都是在编造外部事实。

## 5. TDD Evidence

- Store RED：`src/state-store.ts` 不存在，测试得到 `ERR_MODULE_NOT_FOUND`。
- Component RED：`exportState / fromState / restoreNextOrderId` 均不存在。
- Bot RED：`PerpBot.create is not a function`。
- Validation RED：嵌套 Position 的 `qty: "not-a-number"` 被错误接受，测试报告 `Missing expected rejection`。
- GREEN：分别完成底层与 Bot focused tests 后，再执行全量验证。

## 6. Assumptions / Deferred Decisions

- Checkpoint 是单进程单写者模型，没有文件锁或多实例 leader election。
- 策略均线窗口不持久化；恢复后策略重新 warm-up。
- Tick 不逐条持久化；`lastMarkPrice` 是最近状态提交时的价格。
- 没有自动 reconciliation API；未来真实 connector 应查询 open orders、fills 和 position 后才能解除 gate。
- 没有 schema migration；未知版本 fail closed。
- 没有数据库、event sourcing、WAL 压缩或远程备份。
- 仍然不接真钱。

下一轮若继续向真实永续执行靠近，应先实现 exchange adapter contract 和 mock reconciliation，不应直接填入 API key。
