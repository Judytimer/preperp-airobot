# Liquidation × Late Fill：复现实验

> **SUPERSEDED（2026-09-24）**：本实验复现的是 S1 Ghost Cancel，不是真正的 late-arrival Fill。旧实现只在本地写入 `CANCELED`，cancel intent 从未到达 `SimulatedExchange`。Stage 1.5 后改为 `CANCEL_REQUESTED → exchange CancelAck → CANCELED`。2026-10-06 又进一步用独立 deterministic sequence 复现并修复了 `CANCELED` 后 unique late fill 的 OrderTracker correctness failure。**当前行为以 [OrderTracker 终态迟到成交](order-tracker-late-fill.md) 和当前源码为准。**

## Scope

以下内容保留为 fail-before characterization，不再代表当前行为。

## Deterministic event order

```text
SIM-1 BUY fill
→ Position LONG 0.01
→ SIM-2 reversal SELL 0.02 ACK
→ SIM-2 fill remains delayed
→ mark falls to liquidation threshold
→ SIM-2 locally becomes CANCELED
→ liquidation fill closes LONG
→ Position FLAT
→ delayed SIM-2 fill arrives
→ InFlightOrderTracker returns accepted=false because status=CANCELED
→ Position remains FLAT
```

覆盖该交错的测试是 `documents current cancel-then-late-fill behavior after liquidation`。

## Observed ownership and state

| Moment | SIM-2 order state | Position |
| --- | --- | --- |
| reversal ACK | `ACKED` | `LONG 0.01` |
| local liquidation cancel | `CANCELED` | `LONG 0.01` |
| liquidation fill | `CANCELED` | `FLAT` |
| delayed exchange fill | `CANCELED` | `FLAT` |

`SimulatedExchange` 在当时实现中已经创建并排队的 Fill promise 不会因本地 `cancelOpenOrders()` 而消失。Fill 仍会到达 Bot；**当时的** `InFlightOrderTracker.processFill()` 因订单已是 `CANCELED` 而返回 `accepted=false`，所以该 Fill 不进入 `PositionBook`。

## Broken invariant / unresolved semantic

> 本地 `CANCELED` 状态不能证明交易所侧没有发生成交。

当时实现把本地取消状态当成拒绝后续 Fill 的充分条件。如果这个 late Fill 代表交易所已经发生且随后才送达的成交事实，系统会漏记真实 exposure，并错误地保持 `FLAT`。这一旧行为已经由后续 `order-tracker-late-fill.md` 中的修复取代。

本实验当时不决定 late Fill 应被接受还是拒绝。后续已经先解决了本地 correctness：已知身份、唯一且数量合法的 CANCELED 后 late Fill 可以补记，同时保持订单终态。交易所级 `executionAt / cancelEffectiveAt / receivedAt` 时间语义仍属于延期研究。

## Stage 1.5 replacement evidence

Stage 1.5 当时的 replacement test 为 `exchange-confirmed cancel prevents the ghost fill after liquidation`：

```text
SIM-2 ACK
→ local CANCEL_REQUESTED
→ SimulatedExchange.requestCancel(SIM-2)
→ authoritative CancelAck
→ local CANCELED
→ liquidation continues
→ scheduled SIM-2 timer observes venue CANCELED
→ no SIM-2 Fill is produced
```

Partial Fill 场景另外证明：已执行的 `filledQty=0.004` 保留，CancelAck 只取消 `remainingQty=0.006`，不会抹掉已成交部分。
