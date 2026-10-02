# Strategy Lab 收尾：Formal 1m Protocol × PENGU

日期：2026-10-02  
状态：**本阶段收尾；下一阶段只做冻结协议后的 prospective sampling**

## 1. 这轮真正闭合的东西

Strategy 没有为了历史案例改参数或改语义。

仓库新增可执行的 `FORMAL_STRATEGY_LAB_PROTOCOL_VERSION = 1.0.0`，冻结：

```text
cadence = 1-minute fully closed candle
baseline = first complete candle after listing
fdv = historical closed spot × verified total supply
yesPrice = latest known point <= snapshot.ts
interpolation = forbidden
future data = forbidden
```

Formal runner 只负责生成与筛选 Candidate：

```text
如果 Strategy 发出 BUY_YES
→ CANDIDATE
→ 后续才允许 Strategy → Risk → Paper Execution → Position → Laya Shadow

如果始终没有 BUY_YES
→ NO_CANDIDATE
→ 不强行执行后续链路
```

Laya 仍然只是 Shadow，不拥有 paper execution 权限。

## 2. PENGU 的结论

已取得的探索性证据暴露出明显的 microstructure sensitivity：

```text
DIAGNOSTIC_TRADES
→ MICROSTRUCTURE_SENSITIVE

FORMAL_1M
→ NO_CANDIDATE
```

PENGU 于 2024-12-17 14:00 UTC 上线现货；已核对的总供应量为 `88,888,888,888`。逐笔级观察里，极早期价格从约 `0.003375` 到 `0.016875` 的跳变可以触发 50% rise 条件；但在冻结后的 1m closed-candle 口径中不触发正式 Candidate。

这说明的问题不是“应该把 Strategy 改得更容易触发”，而是：

> Candidate 是否出现对采样频率敏感，因此 cadence 必须在 prospective sampling 前冻结。

### 证据边界

- Binance 上线与供应量可由官方公告 / Research 复核。
- PENGU 的逐笔与 1m 对比目前作为方法诊断使用。
- 当前仓库没有保存完整 PENGU 原始逐笔 / 1m / Polymarket history artifact，因此 **PENGU 不计作 FORMAL historical sample，也不用于宣称 historical alpha**。
- `FORMAL_1M → NO_CANDIDATE` 是冻结协议下的 Candidate screen 结论，不是“失败交易”。

参考：
- Binance Research: https://www.binance.com/en/research/projects/pudgy-penguins
- Binance listing / futures announcement: https://www.binance.com/en/support/announcement/detail/c669e07a85214c55a4f15af7717675c6
- Polymarket PENGU FDV event: https://polymarket.com/event/pengu-market-cap-fdv-one-day-after-launch

## 3. 收尾问题分类

| 问题 | 分类 | 处理 |
| --- | --- | --- |
| Formal 1m 口径此前没有可执行边界 | 必须修 | 已用 `strategy-lab.ts` + deterministic tests 冻结 |
| PENGU tick 与 1m 是否产生相同 Candidate | 研究发现 | 否；记录为 `MICROSTRUCTURE_SENSITIVE`，不改 Strategy |
| PENGU 完整 raw artifact 未归档到仓库 | DEFER | 因 PENGU 不作为 FORMAL 样本，不阻塞本阶段；若未来要升级其证据等级再补 |
| 为了样本数继续找历史 Candidate | 不做 | 没有未解决方法问题时停止 |

## 4. 数据适配边界

允许替换历史数据来源，但这不属于 Strategy 修改：

```text
spotPrice
→ Binance historical closed candles

fdv
→ historical spot × verified total supply

yesPrice
→ Polymarket historical latest-known point <= snapshot.ts
```

如果某个时间点没有可用的历史 YES price，Formal adapter 应失败，而不是插值、向未来取值或填默认概率。

## 5. 为什么现在不继续找历史案例

Historical Replay 的价值已经完成了一项关键任务：发现 sampling cadence 会改变 Candidate admission。

继续无限寻找历史案例，除非它能回答尚未解决的方法问题，否则只会增加 hindsight / selection bias 风险。

因此从这里开始，主证据转为：

```text
Frozen protocol
→ future Candidate arrives
→ record Baseline
→ record AI Shadow
→ do not rewrite before outcome
→ evaluate after frozen window
```

如果运行中发现 bug / leakage，需要修正规则，则升级 protocol version 或重启 batch，不允许回改已经观察到结果的样本。

## 6. Prospective sampling 的最小记录

每个未来观察点至少保存：

```text
protocolVersion
snapshot.ts
spot candle source + close
verified totalSupply source
derived fdv
prediction market id / question / targetFdv
yesPrice
yesPrice observedAt
Strategy signal
Candidate / NO_CANDIDATE
ShadowRecord（仅 Candidate 时）
paper execution record（仅 Candidate 时）
outcome rule / outcome window
```

不需要为了“样本完整”让每个观察点都产生交易。

## 7. 面试表达

可以诚实表述为：

> 我最初用逐笔数据回放 PENGU 时得到了 Candidate，但换成 1 分钟闭合 K 线后 Candidate 消失。这个 failure 让我意识到策略 admission 对 microstructure cadence 敏感，所以我没有调 Strategy 去迁就案例，而是把 cadence、baseline、历史 YES 对齐方式和 no-future-data 规则冻结成可执行协议。PENGU 最终保留为方法诊断，不包装成 alpha；后续证据改用 freeze 后的 prospective sampling。

## 8. Stop Rule

本阶段不再因为“看起来更完整”继续增加功能。

只有以下情况才重新打开 Strategy Lab 历史研究：

- 新历史案例能验证一个尚未解决的方法问题；
- prospective 暴露 protocol bug / leakage；
- Candidate / Outcome 记录无法复现；
- 岗位或真实业务提出新的验证要求。

否则：

> **本阶段可以收尾。**
