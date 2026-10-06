# OrderTracker 终态迟到成交：复现、修复与抽象

> 日期：2026-10-06  
> 状态：**REPRODUCED / FIXED / REGRESSION TESTED**  
> 范围：只修 `CANCELED` 后 unique late fill 的记账失败；不顺手处理其他 failure。

## 1. Failure

旧 `processFill` 先判断 `status === CANCELED`，再检查 `fillId` 去重。这会让一个已经发生、但更晚到达本地的唯一成交被直接 `accepted:false`。

确定性复现序列：

```text
qty = 0.01
→ ACKED
→ F1 = 0.004
→ CANCEL_REQUESTED
→ CancelAck / CANCELED
→ F2 = 0.003 (unique late fill)
```

| 结果 | 旧实现 | 修复后 |
| --- | --- | --- |
| `accepted` | `false` | `true` |
| `filledQty` | `0.004` | `0.007` |
| `remainingQty` | `0.006` | `0.003` |
| `status` | `CANCELED` | `CANCELED` |
| `getOpenOrders()` | `0` | `0` |

旧实现的问题不是“状态机不够漂亮”，而是本地 exposure 会少记，而且 OrderTracker 内没有这笔 fill 的轨迹。后续 reconciliation 最多看到本地与 venue 的差异，不能从本地订单轨迹定位这笔被吞掉的执行事实。

## 2. 修复

当前顺序冻结为：

```text
fillId idempotency
→ identity validation
→ terminal/non-terminal quantity budget
→ accounting update
→ record processedFillId
```

终态订单的成交预算使用：

```text
originalQty - filledQty
```

非终态仍使用 `remainingQty`。

`CANCELED` 接受合法 unique late fill 后只修正 `filledQty / remainingQty`，**status 仍保持 `CANCELED`**。

## 3. 真实设计决策：为什么不回退状态

如果把 `CANCELED` 回退成 `PARTIALLY_FILLED`：

```text
late fill
→ terminal order reopened
→ getOpenOrders() 再次包含它
→ cancel / recovery 判据被污染
```

所以这里明确分开两个事实：

```text
Order lifecycle fact: CANCELED
Execution accounting fact: filledQty can still be corrected by a late authoritative fill
```

代价也明确：终态下 `remainingQty` 表示“原始数量中尚未被成交事实覆盖的数量”，不再等同于“仍挂在 venue 的 open quantity”。

## 4. 回归边界

本次回归锁住：

- `CANCELED` 后 unique late fill 可以补记；
- status 仍为 `CANCELED`，`getOpenOrders()` 仍为 0；
- 同一 late fillId 重推仍然 `accepted:false`；
- `FILLED` 后同一 fillId 重推仍然 `accepted:false`，不会走到 throw；
- `FILLED` 后全新 fillId 仍然 quantity overflow throw。

最后一条 **刻意没有在本次修复**。它是另一个 failure，继续单独处理。

## 5. 提炼出的工程判断

1. **终态不是成交事实本身。** 本地生命周期结束，不等于否定更晚到达的权威执行事实。
2. **不变量的位置本身就是设计。** 去重放在终态分支之后，就可能被分支短路。
3. **对不可忽略事实的静默拒绝比显式失败更危险。** 它让本地轨迹看起来正常，却悄悄丢掉 exposure。
4. **先证明诊断，再动手。** repro before fix；当 AI 把验证成本压低后，“验证太贵”必须用真实成本证明。
5. **修一条不能破坏另一条。** 允许 late fill 后，fillId 幂等和 open-order invariant 必须同时保留。

## 6. 面试 90 秒口径

> 我在自己的订单模块里复现了一个真实敞口 bug：订单已经收到 CancelAck 后，如果一笔唯一成交更晚才到本地，旧代码会因为 status=CANCELED 直接 accepted:false，filledQty 从应有的 0.007 停在 0.004，而且本地订单轨迹没有这笔 fill。我没有先改，而是先用确定性事件流证明 failure。
>
> 修复时撞到一个设计决策：迟到成交来了以后，CANCELED 要不要回退成 PARTIALLY_FILLED？我选择不回退，因为订单已经不是 open order；回退会让它重新进入 getOpenOrders，污染取消和恢复判据。所以我只修 execution accounting，生命周期仍保持 CANCELED。
>
> 同时我把 fillId 去重提到终态分支之前，因为不变量的位置本身就是设计。改完后 unique late fill 能补记，同一 fillId 重推仍然幂等，open orders 仍为 0。另一个 FILLED 后全新 fillId 的 throw 我没有顺手改，它是独立 failure。

## 7. 验证

本次修改的 focused `order-tracker` tests 已在 Node 22.16.0 下运行：5/5 passed。

完整仓库仍使用：

```bash
npm test
```

相关文件：

- [`src/order-tracker.ts`](../../src/order-tracker.ts)
- [`test/order-tracker.test.ts`](../../test/order-tracker.test.ts)
- [关键架构决策](../architecture/design-decisions.md)
- [延期设计与触发条件](../roadmap/deferred-designs.md)
