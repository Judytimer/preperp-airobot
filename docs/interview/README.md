# 面试准备入口

> 这份文档不是项目说明书，而是“怎么把这个仓库学成自己的面试能力”。

如果你只想看项目现在做到了什么，先看根目录 [README](../../README.md)。  
如果你想准备面试，从这里开始。

---

# 使用方法

每个主题都按同一套顺序学：

1. **15 岁解释**：先确认自己真的懂业务现象；
2. **真实问题 / Failure**：知道为什么这个设计不是为了“显得高级”；
3. **我的设计判断**：能说出自己做了什么选择；
4. **去看哪段源码**：能把判断落回代码；
5. **面试怎么说**：形成 30–90 秒口头表达；
6. **什么程度算学会**：不用背文档也能推导。

不要一次把所有源码读完。  
目标是先吃透 6 个判断，再扩展到具体实现细节。

---

# 1. Projected Position：为什么只看 Position 会重复下单

## ① 15 岁解释

你在网店下单以后，商品还没发货，但你已经“占用了预算”。

交易也一样：

```text
ACK
→ 订单已经在路上
→ Fill 还没回来
→ Position 暂时没变
```

如果 Risk 只看已经成交的 Position，它可能误以为“我还没买”，于是再下一张同方向订单。

## ② 真实问题 / Failure

最初模型只看 Filled Position。

当 Fill 有延迟时：

```text
Order A ACK
→ Position 仍然是 0
→ 下一个 Tick 又来
→ Risk 仍看到 0
→ 又发 Order B
```

这会产生重复 exposure。

Partial Fill 后问题更明显：

```text
原订单 0.01
已成交 0.004
剩余 0.006
```

如果把整张订单从 pending 删除，就会低估仍在路上的 0.006。

## ③ 我的设计判断

Risk 使用：

```text
Projected Position
=
Filled Position
+
Unresolved Order Remaining Qty
```

Partial Fill 后只计算 remaining quantity。

这让：

- Position 继续表示“已经成交的事实”；
- OrderTracker 表示“尚未完成的订单事实”；
- Risk 读取两者组合后的潜在 exposure。

## ④ 去看哪段源码

重点看：

- [src/bot.ts](../../src/bot.ts)
- [src/risk.ts](../../src/risk.ts)
- [src/order-tracker.ts](../../src/order-tracker.ts)
- [src/position.ts](../../src/position.ts)

历史演进可看：

- [Partial Fill 阶段学习报告](../archive/learning/partial-fill.md)

## ⑤ 面试怎么说

> Position 只代表已经成交的仓位，但 ACK 到 Fill 之间还有 unresolved exposure。早期实现只看 Position，Fill 延迟时会重复下单。后来我把 Risk 改成读取 filled position 加 unresolved order 的 remaining quantity，也就是 Projected Position。Partial Fill 后只保留剩余未成交数量，这样不会重复计算整张订单。

## ⑥ 什么程度算学会

你应该不用文档就能回答：

- 为什么不能只看 Position？
- Partial Fill 后 projected exposure 怎么算？
- 为什么 remaining quantity 属于 OrderTracker，而不是 PositionBook？

---

# 2. Cancel Intent ≠ CancelAck：本地不能伪造交易所事实

## ① 15 岁解释

你点“取消外卖”不等于外卖已经取消成功。

你只是表达了：

> 我想取消。

真正取消成功，要等平台确认。

## ② 真实问题 / Failure

早期实现曾经在本地发起 cancel 后，直接把订单改成：

```text
CANCELED
```

但实际上 cancel intent 根本还没有经过 exchange/venue 确认。

后来一个 Liquidation × Late Fill 场景暴露了问题：

```text
本地认为 CANCELED
→ delayed Fill 到来
→ 本地因为“已经取消”拒绝这个 Fill
→ 可能把真实 exposure 隐藏掉
```

这就是 Ghost Cancel。

## ③ 我的设计判断

状态必须拆开：

```text
ACKED / PARTIALLY_FILLED
→ CANCEL_REQUESTED
→ CancelAck
→ CANCELED
```

同时冻结一个更重要的事实优先级：

```text
Exchange execution fact
>
Exchange order fact
>
Local mirror
>
Intent
```

本地状态不能静默抹掉权威 execution fact。

## ④ 去看哪段源码

重点看：

- [src/exchange.ts](../../src/exchange.ts)
- [src/order-tracker.ts](../../src/order-tracker.ts)
- [src/bot.ts](../../src/bot.ts)

Failure Case：

- [F06：交易所客户端边界](../cases/f06-client-boundary.md)
- [Cancel × Fill × Reconciliation](../cases/cancel-fill-reconciliation.md)
- [Liquidation × Late Fill](../cases/liquidation-late-fill.md)

## ⑤ 面试怎么说

> 我早期有一个 Ghost Cancel 问题：本地发出 cancel intent 后直接把订单写成 CANCELED，相当于本地状态越权制造了交易所事实。后来我把它拆成 CANCEL_REQUESTED 和 CancelAck，并明确 source of truth：execution fact 高于 order fact，高于 local mirror，高于 intent。这个改动不是状态机美化，而是被真实 late-fill failure 逼出来的。

## ⑥ 什么程度算学会

你要能解释：

- 为什么 Cancel Request 和 CancelAck 必须分开？
- 为什么 CANCELED 后仍不能简单认为历史上没有成交？
- 什么叫“本地 mirror 不能成为外部事实的 source of truth”？

---

# 3. Ambiguous Submit：为什么 timeout 不能直接 retry

## ① 15 岁解释

你发一条微信，手机提示“发送超时”。

这不代表对方一定没收到。

如果你立刻再发一次，对方可能收到两条。

## ② 真实问题 / Failure

下单也一样：

```text
submit
→ 网络 timeout
→ exchange 可能已经接单
→ 本地没拿到 ACK
```

如果这时无脑 retry：

```text
retry createOrder
→ 可能创建第二张订单
→ 重复 exposure
```

这不是 ordinary network failure，而是 ambiguous result。

## ③ 我的设计判断

项目采取几条边界：

1. Core 在 submit 前生成 clientOrderId；
2. 先记录 / 持久化 SUBMITTED；
3. signed order submit 不套普通自动 retry；
4. 后续依赖 query by clientOrderId、open orders、trade history、position snapshot、reconciliation 判断外部真实状态。

## ④ 去看哪段源码

重点看：

- [src/bot.ts](../../src/bot.ts)
- [src/exchange.ts](../../src/exchange.ts)
- [src/state-store.ts](../../src/state-store.ts)
- [src/reconciliation.ts](../../src/reconciliation.ts)
- [src/binance-testnet.ts](../../src/binance-testnet.ts)

对照：

- [关键架构决策](../architecture/design-decisions.md)
- [Testnet 验证记录](../cases/testnet-validation.md)

## ⑤ 面试怎么说

> 我把下单 timeout 当成 ambiguous result，而不是普通失败。因为交易所可能已经接单，只是 ACK 丢了。如果直接 retry，可能重复下单。所以 clientOrderId 在越过 venue boundary 前由 Core 生成并持久化，signed submit 不自动 retry，后续通过 clientOrderId、open orders、trade history 和 position snapshot 做 reconciliation。

## ⑥ 什么程度算学会

不用看文档，你应该能画出：

```text
submit timeout
→ UNKNOWN / unresolved
→ stop new risk
→ query evidence
→ reconcile
→ 再决定是否允许新 intent
```

并能回答：为什么 p-retry(createOrder) 是危险的？

---

# 4. Recovery ≠ Reconciliation：重启后为什么先停下来

## ① 15 岁解释

你玩游戏突然断电。

重新打开以后，如果你不知道刚才那一局到底有没有保存成功，最危险的做法不是“随便猜一个状态继续玩”，而是先查存档和服务器。

## ② 真实问题 / Failure

程序重启时可能存在 SUBMITTED、ACKED、PARTIALLY_FILLED、CANCEL_REQUESTED。

本地进程没了，但交易所可能继续发生 Fill、Cancel、Liquidation、Position change。

如果重启后直接继续策略交易，就可能基于错误仓位再次下单。

## ③ 我的设计判断

重启发现 unresolved order：

```text
→ RECOVERY_REQUIRED
→ 停止新交易
```

然后分两层：

**Reconciliation**：本地和交易所哪里不一样？

**Recovery**：有足够权威证据后，怎么安全把本地状态收敛到正确状态，并重新开闸？

当前项目已经做到 checkpoint、unresolved detection、fail-closed、read-only reconciliation、Recovery Evidence contract；还没有完整自动 Recovery convergence。

## ④ 去看哪段源码

重点看：

- [src/state-store.ts](../../src/state-store.ts)
- [src/reconciliation.ts](../../src/reconciliation.ts)
- [src/recovery-evidence.ts](../../src/recovery-evidence.ts)
- [src/bot.ts](../../src/bot.ts)

历史材料：

- [Checkpoint / Recovery 阶段报告](../archive/learning/checkpoint-recovery.md)
- [延期设计](../roadmap/deferred-designs.md)

## ⑤ 面试怎么说

> 我把 Reconciliation 和 Recovery 分开。Reconciliation 只负责发现 local state 和 venue state 的差异，不自动覆盖任何一边。重启后如果存在 unresolved order，系统进入 RECOVERY_REQUIRED，先 fail closed。只有拿到足够 authoritative evidence 后，才有资格做 Recovery convergence。当前项目做到 evidence contract 和只读 reconciliation，完整自动恢复是刻意延期的。

## ⑥ 什么程度算学会

你要能回答：

- 为什么 Restart 后不能自动把 unresolved order 标成 CANCELED？
- Reconciliation 和 Recovery 差别是什么？
- 为什么 Fail Closed 是牺牲可用性换正确性？

---

# 5. 为什么用了 Binance SDK，核心能力仍然是自己的

## ① 15 岁解释

你开车可以用别人生产的发动机，但什么时候踩刹车、什么时候换挡、出故障后是否继续开，还是你自己的控制系统决定。

## ② 真实问题 / Failure

交易所 SDK 很擅长 HTTP / WebSocket、签名、wire types、请求序列化、基础 reconnect。

但它不会替你决定：

- timeout 后能不能继续下单；
- Partial Fill 后 projected exposure 是多少；
- CancelAck 到底意味着什么；
- Recovery evidence 是否够；
- Reconciliation mismatch 怎么处理。

## ③ 我的设计判断

第三方 SDK 放在 adapter 边界：

```text
Binance SDK
↓
Binance Adapter
↓
canonical ACK / Fill / CancelAck
↓
OrderTracker
↓
Position / Risk / Recovery / Reconciliation
```

SDK 负责“交易所怎么说”。

Core 负责“这些事实怎样改变本地状态和风险”。

## ④ 去看哪段源码

重点看：

- [src/binance-testnet.ts](../../src/binance-testnet.ts)
- [src/exchange.ts](../../src/exchange.ts)
- [src/order-tracker.ts](../../src/order-tracker.ts)
- [src/risk.ts](../../src/risk.ts)
- [src/reconciliation.ts](../../src/reconciliation.ts)

材料：

- [Testnet 验证记录](../cases/testnet-validation.md)
- [历史 Buy vs Build 审查](../archive/reviews/buy-vs-build-2026-09-27.md)

## ⑤ 面试怎么说

> 我没有手写 Binance 的签名、REST/WS 和 wire protocol，而是交给官方 SDK。但 SDK 只放在 adapter 层。Order State Machine、Projected Position、ambiguous submit、Recovery gate、Reconciliation policy 仍然由 Core 自己掌握。这样既避免重复造低价值轮子，又保留真正体现交易工程判断的部分。

## ⑥ 什么程度算学会

你应该能明确说出：SDK 可以替你做什么，以及绝对不能替你决定什么。

---

# 6. AI Shadow：为什么不让 AI 直接下单

## ① 15 岁解释

AI 可以像副驾驶一样提醒“前面可能有危险”。

但在它还没有被证明稳定可靠以前，不应该直接抢方向盘。

## ② 真实问题 / Failure

“AI 很聪明”不等于 AI 有稳定 Alpha、判断可重复、不会受历史记忆污染、不会误判证据。

如果直接把 AI 接到 Execution：

```text
LLM verdict
→ order
```

一旦判断错，错误会直接变成资金风险。

## ③ 我的设计判断

当前 AI 只运行：

```text
Candidate
→ AI Shadow Reviewer
→ PASS / WOULD_BLOCK / ABSTAIN
→ Research Record
```

它不能修改 Strategy Signal、绕过 Risk、直接下单、改 leverage / size、自动反手。

Historical Replay 用来检查方法问题，而不是把历史案例包装成 Alpha。

## ④ 去看哪段源码

重点看：

- [src/overlay/shadow-runner.ts](../../src/overlay/shadow-runner.ts)
- [src/overlay/laya-reviewer.ts](../../src/overlay/laya-reviewer.ts)
- [src/historical-replay.ts](../../src/historical-replay.ts)
- [src/closure-smoke.ts](../../src/closure-smoke.ts)

材料：

- [AI Shadow](../research/ai-shadow.md)
- [验证方法](../research/validation-methodology.md)
- [FORMAL Case #1](../research/formal-case-1-candidate-screen.md)

## ⑤ 面试怎么说

> 我没有先假设 AI 有 Alpha，再让它直接控制交易。我把它限制在 Shadow Reviewer，只允许输出 PASS、WOULD_BLOCK、ABSTAIN，并保留 deterministic Risk 作为不可绕过的边界。Historical Replay 主要用于找 Prompt、标签和证据问题；真正要升级 AI 权限，必须等冻结规则后的 prospective evidence。

## ⑥ 什么程度算学会

你要能解释：

- 为什么 Historical Replay 不能证明 prospective alpha？
- 什么叫 T0 leakage？
- 为什么 AI gating 和 Risk 是两层不同权限？
- 未来什么证据出现后，AI 才可能从 Shadow 升级？

---

# 7. 面试前最低掌握标准

如果准备时间有限，先做到：

- 能画 Projected Position 数据流；
- 能讲 Ghost Cancel 是怎么被发现和修正的；
- 能解释 submit timeout 为什么不能直接 retry；
- 能区分 Reconciliation 与 Recovery；
- 能解释 Binance SDK 和自有 Core 的边界；
- 能解释 AI Shadow 为什么没有 execution authority。

每个主题至少准备：

```text
30 秒版本
+
90 秒版本
+
一个追问
+
一段源码证据
```

---

# 8. 推荐练习顺序

## 第一轮：只讲业务

不看代码，先把 6 个主题都用 15 岁能听懂的话讲清楚。

## 第二轮：绑定源码

每个主题只挑 2–4 个关键函数 / 类型，不要整文件背。

## 第三轮：绑定 Failure

每个设计都回答：如果没有这个设计，具体会错在哪里？

## 第四轮：模拟追问

优先练：

- 为什么不用 retry？
- 为什么不能直接相信本地状态？
- 为什么不直接上 Hummingbot？
- 为什么 Recovery 不自动修？
- 为什么 AI 不直接下单？
- Testnet 到底验证了什么，没验证什么？

---

# 9. 你真正要证明的不是“我写过这些代码”

面试里最重要的不是：

> 我实现了 ACK / Fill / Recovery / AI Shadow。

而是：

> 我能解释一个错误假设怎样导致 Failure，Failure 怎样逼出 Invariant，Invariant 怎样变成代码边界，同时我也知道哪些复杂度现在没有证据值得加入。

如果这条链你能讲顺，这个仓库才真正变成你的面试资产。
