# InFlightOrder + Partial Fill Learning Report

## 1. Broken Invariant

> 一张订单部分成交后，Risk 必须继续看到未成交的 remaining quantity；只有 remaining quantity 为零时，订单才能离开 open/in-flight 状态。

旧模型的 `Map<orderId, OrderRequest>` 只保存 original quantity。第一个 Fill 到达后，Bot 直接删除整张 Pending，无法表达“已成交 0.004、仍有 0.006 在途”。这会让下一次 Risk 低估 projected exposure，并可能补发重复订单。

## 2. 新状态模型

```text
ACK
 -> ACKED
 -> Fill 0.004
 -> PARTIALLY_FILLED (filled=0.004, remaining=0.006)
 -> Fill 0.006
 -> FILLED (filled=0.01, remaining=0)
```

`InFlightOrderTracker` 现在持有：

- `orderId`
- `side`
- `originalQty`
- `filledQty`
- `remainingQty`
- `status`
- 每张订单已处理的 `fillId`

已完成订单暂时保留在 tracker 中，以便识别 duplicate/late Fill；`getOpenOrders()` 只返回 ACKED 和 PARTIALLY_FILLED。

## 3. Projected Exposure

Partial Fill 后的计算是：

```text
filled Position = LONG 0.004
open order remaining BUY = 0.006
projected Position = LONG 0.010
```

关键 trace：

```text
[ORDER] orderId=SIM-1 status=PARTIALLY_FILLED filled=0.004 remaining=0.006
[EXPOSURE] filled=0.004 pending=0.006 projected=0.01
[RISK] blocked reason="already LONG"
[ORDER] orderId=SIM-1 status=FILLED filled=0.01 remaining=0
```

这证明新 Tick 确实发生在两次 Fill 之间，且没有产生第二个 ACK。

## 4. TDD 证据

第一个 RED：`test/order-tracker.test.ts` 因 `src/order-tracker.ts` 不存在而失败。实现 tracker 后，该测试验证 0.004/0.006 累计、duplicate fill rejection 和 terminal state。

第二个 RED：Bot 测试期望 PARTIALLY_FILLED trace，但旧交换所只产生一笔完整 0.01 Fill。加入确定性 fill plan 并让 Bot 消费多个 Fill 后转绿。

## 5. 状态所有权变化

- `PerpBot.pendingOrders` 已删除，不再和订单 tracker 保存两份 Pending。
- `InFlightOrderTracker` 是订单状态、累计成交与 remaining quantity 的事实源。
- `PositionBook` 仍是已成交净仓位与 PnL 的事实源。
- `PositionBook.processedFillIds` 暂时保留为账本入口的第二道幂等防线；它与 tracker 都记录 fill identity。持久化阶段需要决定统一恢复和归档策略，不能让两者独立恢复。

## 6. 本轮没有实现

- Cancel、Reject、Failed、Pending Cancel
- Partial Fill 后取消剩余数量
- 真实 Connector 和 WebSocket event stream
- tracker/Position 的持久化与重启恢复
- completed order 和 fill IDs 的归档清理
- leverage、margin、mark price、funding、liquidation
- Overlay 专用 InFlightOrderTracker

下一轮最有价值的方向是 isolated-margin account model；在那之前，不应把策略复杂度继续提高。
