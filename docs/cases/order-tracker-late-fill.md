# OrderTracker 终态迟到成交：发现 → 修复 → 抽象

> 日期：2026-10-06  
> 证据等级：**确定性复现 + 当前仓库回归测试**  
> 状态：**REPRODUCED / FIXED / REGRESSION TESTED**

这份 Case 不按“代码改了什么”组织，而按面试真正需要的顺序组织：

```text
错误判断
→ 真实输出
→ 设计决策
→ 最小修复
→ 反事实验证
→ 抽象
→ 未解决边界
```

---

## 一、先修正自己的一个判断

之前主张：

> 改了但无法验证，比诚实缺口更危险。

原则本身成立，但这次真实暴露了一个隐含假设：**验证很贵**。

实际这个 Failure 可以用很短的 deterministic event sequence 复现。因此新的方法不是“看到问题就都改”，而是：

```text
先问验证成本
→ repro before fix
→ 证明 diagnosis
→ 再决定是否修改
```

当 AI 已经把验证成本压低时，“因为还没验证所以先不改”不能自动成为理由。

---

## 二、四个真实场景

### 场景 A：CANCELED 后 unique late fill

序列：

```text
qty=0.01
→ ACKED
→ F1=0.004
→ CANCEL_REQUESTED
→ CancelAck / CANCELED
→ F2=0.003
```

| | 旧实现 | 修复后 |
|---|---|---|
| `accepted` | `false` | `true` |
| `filledQty` | `0.004` | `0.007` |
| `remainingQty` | `0.006` | `0.003` |
| `status` | `CANCELED` | `CANCELED` |
| `getOpenOrders()` | 0 | 0 |

核心 Failure：

> 本地少记 0.003，而且 OrderTracker 不留下这笔 fill 的轨迹。

这不是 schema taste，而是 correctness failure。

---

### 场景 B：CANCEL_REQUESTED 期间成交

当前行为：

```text
accepted=true
status=PARTIALLY_FILLED
filledQty=0.007
```

说明：

> 非终态时，成交事实本来就能顶掉取消意图。

所以旧实现真正矛盾的是：

```text
CANCEL_REQUESTED
→ Fill 可以覆盖 intent

但

CANCELED
→ unique late Fill 被直接静默拒绝
```

同一条“execution fact > local lifecycle judgment”的线，只实现了一半。

---

### 场景 C：FILLED 后重推同一 fillId

当前行为：

```text
accepted=false
status=FILLED
不会 throw
```

这条用来修正此前错误判断：

> “FILLED 后重传一定进入 throw”

不准确。

同一 fillId 会先被 `processedFillIds` 幂等去重。

---

### 场景 D：FILLED 后全新 fillId

当前仍然：

```text
throw: fill exceeds remaining quantity
```

**本次没有顺手修改。**

原因不是“来不及”，而是它属于另一个 Failure：

- 可能是 venue 异常；
- 可能是事件映射重复但 fillId 变化；
- 可能是本地缺失前序 evidence；
- 也可能暴露更深的时间/身份语义问题。

在没有先定义这个 Failure 的含义前，不应该和场景 A 混成一个大重构。

---

## 三、修复真正撞出的设计决策

问题：

> unique late fill 被接受以后，`CANCELED` 要不要回退成 `PARTIALLY_FILLED`？

选择：**不回退。**

如果回退：

```text
late fill
→ status=PARTIALLY_FILLED
→ getOpenOrders() 再次包含订单
→ cancel / recovery 判据把终态订单重新当 open order
```

所以显式区分：

```text
Order lifecycle fact
= CANCELED

Execution accounting fact
= filledQty / remainingQty 仍可被更晚到达的权威 Fill 修正
```

代价：

> 终态下 `remainingQty` 表示“原始数量里尚未被成交事实覆盖的数量”，不再等同于 venue open quantity。

这个代价不能藏掉。

---

## 四、当前最小修复

`processFill` 当前顺序：

```text
1. processedFillIds 去重
2. identity validation
3. terminal / non-terminal quantity budget
4. accounting update
5. record processedFillId
```

终态预算：

```text
originalQty - filledQty
```

非终态预算：

```text
remainingQty
```

终态接受合法 unique late fill 后：

```text
filledQty / remainingQty 更新
status 保持原终态
```

这保证修复场景 A，同时不破坏：

- fillId 幂等；
- CANCELED 不重新进入 open orders。

---

## 五、五条抽象

### 1. 终态不是成交事实本身

`CANCELED` 是本地订单生命周期判断，不等于“未来绝不可能收到更晚到达的 execution fact”。

### 2. 不变量的位置本身就是设计

去重规则即使存在，如果放在会提前 return 的分支之后，仍然会静默失效。

### 3. 静默拒绝比显式失败更危险

对不可忽略的 Fill 直接 `accepted:false`，调用链看起来没有异常，但 exposure 已经少记。

### 4. 先证明诊断，再动手

```text
repro
→ diagnosis
→ fix
→ regression
```

### 5. 修一条不能破坏另一条

修 late fill 时必须继续守住：

- duplicate fill idempotency；
- terminal order 不重新进入 open orders。

---

## 六、90 秒版本

> 我在自己的订单模块里复现了一个真实敞口 bug：订单已经收到 CancelAck 后，如果一笔唯一成交更晚才到本地，旧代码会因为 status=CANCELED 直接 accepted:false，filledQty 从应有的 0.007 停在 0.004，而且本地订单轨迹没有这笔 fill。
>
> 我没有先改，而是先用确定性事件流证明 Failure。修复时撞到一个设计决策：迟到成交来了以后，CANCELED 要不要回退成 PARTIALLY_FILLED？我选择不回退，因为订单已经不是 open order；回退会让它重新进入 getOpenOrders，污染取消和恢复判据。所以我只修 execution accounting，生命周期仍保持 CANCELED。
>
> 同时我把 fillId 去重提到终态分支之前，因为不变量的位置本身就是设计。改完后 unique late fill 能补记，同一 fillId 重推仍然幂等，open orders 仍为 0。另一个 FILLED 后全新 fillId 的 throw 我没有顺手改，它是独立 Failure。

---

## 七、追问边界

### 为什么不用成熟框架的 TTL 直接解决？

当前 Failure 已经能用现有订单身份 + fillId 幂等 + quantity budget 解决。

成熟框架的 TTL 反映它自己的 active/cached/lost 生命周期设计。现在吸收的是：

> **终态后仍存在一个权威 execution fact 到达窗口。**

不是为了“像成熟框架”而搬整个缓存模型。

### 为什么不把场景 D 一起修？

因为 D 的语义还没被证明。先把每一个 Failure 单独复现、定义、验收，再决定是否需要更复杂的事件时间/身份模型。

### 怎么证明这次修复没破坏别的东西？

至少守住：

```text
unique late fill
→ accepted=true

same fillId replay
→ accepted=false

status after late fill
→ CANCELED

getOpenOrders()
→ 0
```

场景 D 仍 throw，明确作为未解决边界。

---

## 八、源码与测试

- [`src/order-tracker.ts`](../../src/order-tracker.ts)
- [`test/order-tracker.test.ts`](../../test/order-tracker.test.ts)
- [关键架构决策](../architecture/design-decisions.md)
- [延期设计与触发条件](../roadmap/deferred-designs.md)

运行：

```bash
npm test
```

当前 focused OrderTracker regression 已覆盖场景 A / C / D 的关键边界；场景 B 是既有非终态行为，没有被本次修改破坏。
