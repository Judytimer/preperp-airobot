# 面试冲刺入口：先吃透一个真故事，再补三个判断

> 更新时间：2026-10-06  
> 面试：2026-10-08  
> 目标：不是把仓库全部背下来，而是能把 **Failure → 证据 → 设计决策 → 修复 → 抽象 → 边界** 讲顺。

如果时间很少，**不要从头读整个 docs**。

当前优先级：

```text
P0：OrderTracker 终态迟到成交
    ↓
P1：Projected Position
    ↓
P1：Ambiguous Submit
    ↓
P1：Recovery ≠ Reconciliation
    ↓
P2：Binance SDK 边界 / AI Shadow / Strategy Lab
```

P0 是现在最完整、最能证明工程判断力的故事。其他主题先作为它的支撑，不要平均用力。

---

# 一、P0 主故事：OrderTracker 终态迟到成交

完整证据看：

- [OrderTracker 终态迟到成交：复现、修复与抽象](../cases/order-tracker-late-fill.md)
- [src/order-tracker.ts](../../src/order-tracker.ts)
- [test/order-tracker.test.ts](../../test/order-tracker.test.ts)

## 1. 先记住真实输出，不要先背概念

复现序列：

```text
qty=0.01
→ ACKED
→ F1=0.004
→ CANCEL_REQUESTED
→ CancelAck / CANCELED
→ F2=0.003（unique late fill）
```

关键结果：

```text
旧实现：
accepted=false
filledQty=0.004      ← 少记 0.003，而且没有这笔 fill 轨迹

修复后：
accepted=true
filledQty=0.007
status=CANCELED      ← 仍然不是 open order
getOpenOrders()=0
```

先把这一段讲顺，再谈“终态”“不变量”“幂等”。

---

## 2. 这次先修正了自己的判断

之前的判断：

> 改了但无法验证，比诚实缺口更危险。

这个原则本身没错，但这次暴露出一个隐含前提：

> **验证成本真的很高。**

实际用 mock / deterministic event sequence 很快就能复现，因此新的判断是：

> **先真实估算验证成本。AI 已经把验证成本压得很低时，“我没验证所以没改”不能继续作为默认理由。**

这不是“以后什么都要改”，而是：

```text
先 repro
→ 证明 diagnosis
→ 再决定要不要修
```

---

## 3. 修复真正有价值的地方不是改代码，而是撞出设计决策

问题：

> `CANCELED` 后收到合法 late fill，status 要保持 `CANCELED`，还是回退 `PARTIALLY_FILLED`？

选择：**保持 `CANCELED`。**

理由：

- CancelAck 已经说明订单生命周期结束；
- 如果回退成非终态，订单会重新进入 `getOpenOrders()`；
- 取消和 Recovery 判据会把它再次当成 open order。

因此把两个事实拆开：

```text
Order lifecycle fact
= CANCELED

Execution accounting fact
= filledQty 仍允许被更晚到达的权威 Fill 修正
```

代价也要会讲：

> 终态下的 `remainingQty` 不再等同于“venue 上仍挂着的数量”，而是“原始数量中还没有被成交事实覆盖的数量”。

这就是 Trade-off，不要藏掉。

---

## 4. 五条抽象，只背这五条

1. **终态不是成交事实本身**  
   本地认为生命周期结束，不等于未来不会收到更晚到达的权威 execution fact。

2. **不变量的位置本身就是设计**  
   fillId 去重如果放在终态分支后面，就可能被提前 return 短路。

3. **静默拒绝比显式失败更危险**  
   对不可忽略的事实直接 `accepted:false`，系统表面正常，exposure 却悄悄少记。

4. **先证明诊断，再动手修改**  
   repro before fix。

5. **修一条不能破坏另一条**  
   允许 late fill 后，fillId 幂等和 open-order invariant 都必须继续成立。

这五条来自这次真实 Failure，不是为了面试临时编出来的口号。

---

## 5. 四个场景要分清，避免面试里混在一起

| 场景 | 当前结论 |
|---|---|
| A：CANCELED 后 unique late fill | **已复现、已修复**：补记成交，status 仍 CANCELED |
| B：CANCEL_REQUESTED 期间成交 | 原本就能接受；成交事实可以顶掉取消意图 |
| C：FILLED 后重推同一 fillId | **不会 throw**；去重先吃掉 |
| D：FILLED 后全新 fillId | **仍会 throw**；这是独立 Failure，没有顺手改 |

场景 C 很重要，因为它修正了之前错误的判断：

> “FILLED 后重传一定会被推到 throw 路径”

不对。**同一个 fillId 会先被幂等去重。**

---

# 二、90 秒面试版本

> 我在自己的订单模块里复现了一个真实敞口 bug：订单已经收到 CancelAck 后，如果一笔唯一成交更晚才到本地，旧代码会因为 status=CANCELED 直接 accepted:false，filledQty 从应有的 0.007 停在 0.004，而且本地订单轨迹没有这笔 fill。
>
> 我没有先改，而是先用确定性事件流证明 Failure。修复时撞到一个设计决策：迟到成交来了以后，CANCELED 要不要回退成 PARTIALLY_FILLED？我选择不回退，因为订单已经不是 open order；回退会让它重新进入 getOpenOrders，污染取消和恢复判据。所以我只修 execution accounting，生命周期仍保持 CANCELED。
>
> 同时我把 fillId 去重提到终态分支之前，因为不变量的位置本身就是设计。改完以后 unique late fill 能补记，同一 fillId 重推仍然幂等，open orders 仍然是 0。另一个 FILLED 后全新 fillId 的 throw 我没有顺手改，它是独立 Failure。

能脱离文档讲出这 90 秒，P0 才算过关。

---

# 三、最可能的三个追问

### 1. 为什么不直接照 Hummingbot 的 TTL？

答题重点不是背 TTL 数字，而是：

> 成熟框架的 TTL 是它自己的订单身份/缓存策略。我这里当前 Failure 只要求“已经知道身份的终态订单不能吞掉 unique execution fact”。先解决被真实复现的问题，不因为成熟框架更复杂就整套搬过来。

### 2. 为什么不把 D 也一起修？

> D 是“FILLED 后全新 fillId”的另一种失败。它需要先定义这种事件到底代表 venue 异常、重复映射还是本地 evidence gap。一次只推进一个 Failure，避免一轮改动同时改变多条语义。

### 3. 你怎么证明修复没有引入新问题？

回答三条就够：

```text
late unique fill → accepted=true / filledQty 修正
same fillId replay → accepted=false
CANCELED → getOpenOrders() 仍为 0
```

然后补：

> FILLED 后全新 fillId 仍 throw，我没有把未解决的东西说成解决了。

---

# 四、P1 支撑判断 1：Projected Position

## 一句话问题

ACK 到 Fill 之间，Position 还没变，但 exposure 已经在路上。

```text
Projected Position
=
Filled Position
+
Unresolved Order Remaining Qty
```

Partial Fill 后只把 remaining quantity 算进 projected exposure。

### 你必须会答

- 为什么 Risk 不能只看 Position？
- 为什么 Partial Fill 后不能把整张原订单继续算进去？
- OrderTracker 和 PositionBook 分别代表什么事实？

源码：

- [src/bot.ts](../../src/bot.ts)
- [src/risk.ts](../../src/risk.ts)
- [src/order-tracker.ts](../../src/order-tracker.ts)
- [src/position.ts](../../src/position.ts)

面试一句话：

> Position 是已经成交的事实，OrderTracker 还有 unresolved exposure；Risk 必须同时看两者，否则 Fill 延迟时会重复下单。

---

# 五、P1 支撑判断 2：Ambiguous Submit

## 一句话问题

```text
submit timeout
≠
exchange 一定没收到
```

如果直接 retry，可能重复下单。

### 设计边界

```text
Core 先生成并持久化 clientOrderId
→ submit
→ timeout 时不自动重试
→ 查询 authoritative evidence
→ reconcile
```

源码：

- [src/bot.ts](../../src/bot.ts)
- [src/binance-testnet.ts](../../src/binance-testnet.ts)
- [src/reconciliation.ts](../../src/reconciliation.ts)

面试一句话：

> 我把 submit timeout 当 ambiguous result，不当普通网络失败；否则 retry 可能把“不知道有没有成功”变成“两张都成功”。

---

# 六、P1 支撑判断 3：Recovery ≠ Reconciliation

记住：

```text
Reconciliation
= 发现哪里不一致

Recovery
= 有足够权威证据后，怎么安全收敛并重新开闸
```

当前仓库已经有：

- checkpoint；
- unresolved detection；
- `RECOVERY_REQUIRED`；
- read-only reconciliation；
- Recovery Evidence contract。

还没有完整自动 Recovery convergence。

**不要说成“我故意设计成没有出口”。**

更准确：

> 之前实现了 Recovery gate 的入口，但没有完整定义和实现安全解除条件；源码深挖后发现它实际上形成了单向阀门。这是当前明确知道的缺口。

源码：

- [src/state-store.ts](../../src/state-store.ts)
- [src/reconciliation.ts](../../src/reconciliation.ts)
- [src/recovery-evidence.ts](../../src/recovery-evidence.ts)
- [src/bot.ts](../../src/bot.ts)

---

# 七、P2：有时间再补

## Binance Testnet / SDK 边界

当前 P1 authenticated Testnet 已完成真实：

```text
FLAT
→ LONG 0.001
→ FLAT
```

有 ACK、Fill、fee 和最终 authoritative FLAT reconciliation。

重点不是“我会调 Binance API”，而是：

> SDK 负责交易所 wire protocol；Core 决定订单事实如何改变本地状态、Risk、Recovery 和 Reconciliation。

材料：

- [Perp Execution Validation](../cases/perp-execution-validation.md)
- [Binance Testnet 验证记录](../cases/testnet-validation.md)

## AI Shadow

只记权限边界：

```text
Candidate
→ AI Shadow Reviewer
→ Research Record

不能：
→ 绕过 deterministic Risk
→ 直接下单
→ 自己放大仓位/杠杆
```

材料：

- [AI Shadow](../research/ai-shadow.md)

---

# 八、如果现在只有 45 分钟

只做这一轮：

1. 先不看源码，把 **P0 的 Failure → 修复 → Trade-off → 五条抽象** 用自己的话讲出来；
2. 打开 `processFill`，只找三处：fillId 去重、terminal budget、status 保持；
3. 闭眼回答 A/B/C/D 四个场景；
4. 讲一遍 90 秒版本；
5. 最后各用一句话回答 Projected Position、Ambiguous Submit、Recovery ≠ Reconciliation。

不要为了“准备充分”继续展开新模块。

---

# 九、真正的验收标准

你不需要证明：

> 我记得仓库里所有模块。

你需要证明：

> 我能拿一个真实 Failure，先复现、再纠正自己的错误判断，再做设计取舍，用最小修改守住不变量，并明确说出仍没解决什么。

这条链比“我实现了很多功能”更像真实工程能力。
