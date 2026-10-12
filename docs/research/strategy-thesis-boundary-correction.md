# Strategy Thesis × Variant × Formal Batch：策略边界纠偏说明

日期：2026-10-04  
状态：**CONCEPTUAL CORRECTION / NO STRATEGY CODE CHANGE**

## 0. 结论先行

这次纠偏不撤销现有 Strategy Lab v2.1，也不重写 `MemePredictionOverlayStrategy`。

需要纠正的是**概念层级**：

```text
Strategy Thesis（上层研究假设）
Cross-Market Repricing Lag
        ↓

Concrete Variant（具体策略变体）
Crypto FDV Prediction Overlay
        ↓

Formal Batch（可复核实验协议）
Strategy Lab v2.1
Binance Spot + Polymarket FDV + Formal 1m + frozen execution assumptions
```

当前仓库真正实现并冻结验证的是 **Crypto FDV Variant**，不是所有可能的 Cross-Market Repricing Strategy。

因此：

- Meme 不是上层 Thesis 的永久限制；
- FDV 不是上层 Thesis 的永久限制；
- Binance Spot / Polymarket / 1m candle 是当前 Formal Batch 的证据与采样边界；
- 现有 v2.1 继续冻结，不因为这次概念纠偏而回改已经定义的 protocol；
- 股票、Crypto Price Target、Event/Catalyst 等只能视为未来可能的 Variant，**当前没有实现，也没有验证**。

---

## 1. 为什么会出现“策略越来越窄”的感觉

### 1.1 仓库能够确认的事实

仓库里最早可核实的 Overlay 设计已经是一个具体原型：

```text
Meme Spot
+ current FDV
+ higher target FDV
+ Prediction YES
```

2026-09-18 的设计文档目标就是：

> 观察已经上涨的 Meme 现货资产，不继续追加现货，而是在固定最大亏损预算下购买更高 FDV 目标对应的 YES。

`src/overlay/strategy.ts` 第一次进入 Git 历史时，也已经实现为：

```text
MemePredictionOverlayStrategy
spotRiseTriggerPct
targetFdv > currentFdv
BUY_YES
exitYesPrice
```

而且该 Strategy 文件之后没有经历“从通用版本改成 Meme 版本”的提交。

因此，从仓库证据看：

> **代码不是后期被改窄的；第一次落地时就选择了 Meme + FDV 作为具体实现。**

### 1.2 真正发生的偏移

问题不在于某次 commit 偷偷修改 Strategy，而在于后续研究流程不断把这个**具体原型的约束 Formalize**：

```text
Meme prototype
→ Historical Replay
→ PENGU
→ 1m Formal Protocol
→ FDV evidence rules
→ Binance Spot
→ Polymarket FDV discovery
→ v2.1 Prospective Manifest
```

这些约束本来是在回答：

> “这一批实验怎样做到可复核、不可事后挑样本？”

但随着文档越来越完整，它们开始看起来像是在回答：

> “这套策略本身只能研究什么？”

这就是本次要纠正的地方。

---

## 2. 用户原始意图与仓库证据需要分开

用户当前回忆中的策略意图比仓库首个实现更宽：

- Meme 可以是标的；
- 普通 Crypto 也可以是标的；
- 股票等其他 underlying 理论上也可能存在同类研究问题；
- 核心兴趣不是“必须 Meme”，而是研究某个 underlying 已经发生明显 repricing 后，相关 Prediction Market 是否仍存在重新定价滞后。

这份回忆值得恢复到上层 Thesis。

但也必须诚实：

> 当前仓库不能证明“2026-09-18 已经实现或正式定义了股票 / 任意资产版本”。

所以本次纠偏是：

**恢复更合理的上层研究命题，而不是伪造历史说仓库以前已经支持更广范围。**

---

## 3. 三层模型

## 3.1 Strategy Thesis：Cross-Market Repricing Lag

上层研究假设可以写成：

> 当一个底层市场（Underlying Market）已经对新信息产生明显重新定价时，与同一经济命题相关的 Prediction Market 可能存在概率重新定价滞后；如果存在这种滞后，可以考虑用固定最大亏损的 Prediction YES 暴露替代继续追高底层资产。

抽象数据流：

```text
Underlying Market Repricing
        ↓
Related Prediction Contract
        ↓
Compare market-implied state / threshold
        ↓
Possible repricing lag
        ↓
Fixed-risk Prediction exposure
```

这个 Thesis 并不天然要求：

- Meme；
- FDV；
- Binance；
- Polymarket；
- 1m candle。

这些都应在更下层定义。

---

## 3.2 Current Concrete Variant：Crypto FDV Prediction Overlay

当前代码真正实现的是：

```text
Crypto spot rise
        +
current FDV
        +
higher target FDV Prediction YES
        ↓
BUY_YES
```

当前 Strategy 的具体规则仍然是：

```text
spotRiseTriggerPct = 50%
targetFdv > currentFdv
exitYesPrice = 0.70
fixed max risk budget
```

因此当前最准确的描述不是：

> “整个 Strategy 就是 Meme Strategy。”

而是：

> “仓库当前实现的第一个 Cross-Market Repricing Variant，是 Crypto FDV Prediction Overlay；历史类名 `MemePredictionOverlayStrategy` 暂时保留。”

这次不立即重命名类，是为了避免没有业务必要的重构和回归风险。

---

## 3.3 Current Formal Batch：Strategy Lab v2.1

v2.1 进一步冻结：

```text
eligible asset = Binance Spot listed CRYPTO_ASSET
contract semantics = future FDV threshold
discovery = archived Polymarket Gamma first discovery
cadence = 1m fully closed candle
FDV = closed spot × verified totalSupply
YES = latest known trade <= snapshot.ts
execution = 50 bps primary, 0/100 sensitivity
fee = ZERO assumption
fill = FULL_FILL_LIMITATION
```

这些约束的作用是：

> 让当前 Crypto-FDV Variant 可以形成不可事后篡改的 prospective evidence。

它们**不是上层 Strategy Thesis 的永久定义**。

尤其：

`prospective:discover` 只把明确出现 FDV / fully diluted valuation 的市场标成 `POTENTIAL_FDV_REVIEW`，这是 **v2.1 batch admission**，不是“系统认为只有 FDV Prediction 才值得研究”。

---

## 4. 可以扩展到什么，不能声称什么

从 Thesis 层看，未来可能存在：

```text
Cross-Market Repricing Thesis
│
├─ Variant A：Crypto FDV
│   └─ 当前已实现 / v2.1 正在等待 prospective evidence
│
├─ Variant B：Crypto Price Target
│   └─ 例如 BTC/ETH target-price Prediction
│
├─ Variant C：Equity Valuation / Market Cap
│   └─ 股票价格或估值与相关 Prediction Contract
│
└─ Variant D：Event / Catalyst
    └─ underlying 已反应，但 Prediction Contract 可能滞后
```

但后面三个当前都只是**研究方向示例**，不能写成已有能力。

如果未来真的出现一个明确问题，例如 BTC target-price Prediction：

- 不应把 `targetPrice` 假装成 `targetFdv`；
- 不应修改 v2.1 已冻结记录；
- 应新建一个语义明确的 Variant / Protocol version；
- Evidence / Manifest / T0 Report / Outcome 等通用研究纪律可以复用。

---

## 5. 为什么不现在把代码全部泛化

发现“过窄”以后最危险的反应，是立刻走到另一个极端：

```text
MemePredictionOverlayStrategy
↓
UniversalAssetCrossMarketAlphaFramework
```

这会重新带来：

- 抽象层膨胀；
- 类型语义变模糊；
- 为尚不存在的股票 / Price Target 场景预设计；
- 大面积回归；
- 再次拖慢收尾。

因此本轮只纠正：

1. README 的策略定位；
2. Strategy Lab / Manifest 的 scope；
3. 首个 Overlay 报告的历史身份；
4. 文档阅读地图。

**不改 Strategy、Risk、Order、Position、Shadow 运行语义。**

只有出现真实的新 Variant research question 时，才允许扩展代码。

---

## 6. 对现有 v2.1 的处理

v2.1 不撤销，也不降级为“做错了”。

它应该被重新理解为：

> **Cross-Market Repricing Thesis 下，第一个严格冻结的 Crypto-FDV prospective batch。**

所以：

```text
v2.1 = KEEP FROZEN
```

继续允许的状态：

```text
WAITING_FOR_QUALIFIED_MARKET
CANDIDATE
NO_CANDIDATE
DATA_BLOCKED
INELIGIBLE
```

不因为上层 Thesis 变宽，就降低当前 batch 的 admission 标准。

---

## 7. 这次偏差的根因

根因不是单个代码 bug，而是**概念层级混淆**：

```text
Concrete prototype vocabulary
        ↓
被不断写入 Formal Protocol
        ↓
Formal Protocol 越来越严谨
        ↓
反过来被误认为 Strategy Thesis
```

可以总结成一句：

> **我们把“为了可证伪而故意做窄的一批实验”，误当成了“策略只能这么窄”。**

Formalization 本身没有错；错的是缺少 Thesis / Variant / Batch 的显式分层。

---

## 8. 后续 Stop Rule

完成本次文档纠偏后，不因此开启新的策略框架开发。

只有满足下面任一条件，才新增 Variant：

- 出现一个真实、可提前登记的非 FDV Prediction research question；
- 当前 Crypto-FDV prospective evidence 暴露“FDV 只是偶然代理变量”的方法问题；
- 面试或真实业务明确要求演示另一类 underlying / contract semantics；
- 新 Variant 能回答当前 v2.1 无法回答的独立假设，而不是为了增加样本量。

否则继续：

```text
Crypto-FDV v2.1
→ WAITING_FOR_QUALIFIED_MARKET
```

同时交易工程主线可以独立推进小额真实资金的 execution validation，两者不互相阻塞。

---

## 9. 给复审者（元宝）的审核问题

请重点挑战以下判断，而不是默认赞同：

1. 从现有仓库证据看，是否同意“Strategy 代码从首次提交起就是 Meme/FDV 具体实现，而不是后来被 commit 改窄”？
2. 将上层 Thesis 抽象为 `Cross-Market Repricing Lag` 是否忠实于当前 Variant 的经济逻辑，还是抽象过度？
3. Thesis / Variant / Formal Batch 三层是否足以解决当前概念混淆？
4. 当前 v2.1 是否应该继续冻结，而不是为了扩大资产范围直接修改 admission？
5. 是否有任何字段实际上属于 Strategy 核心，但这份文档错误地把它降级成 Variant 或 Batch？
6. 在不做过度抽象的前提下，未来出现 BTC Price Target 或 Equity Prediction 时，现有 Evidence / Execution / Outcome 基础设施有哪些可以复用，哪些必须重新建模？
7. 本轮只改文档、不改运行代码，是否是当前收尾阶段最小且正确的动作？

请优先指出：
- 事实错误；
- 概念偷换；
- 过度泛化；
- 会破坏已冻结 prospective evidence 的修改；
- 为未来场景提前抽象而导致的工程膨胀风险。
