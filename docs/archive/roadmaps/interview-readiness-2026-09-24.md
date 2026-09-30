# Interview Readiness｜完成度与剩余交付线

日期：2026-09-24  
目标：可运行、可解释的 Crypto Perpetual Exchange Trading Development 面试项目，而非真钱交易系统。

## 当前完成度

整体约 **75%**。这个比例只表示面试项目交付度，不表示 production readiness 或策略盈利能力。

| 能力 | 状态 | 当前证据 | 仍缺什么 |
| --- | --- | --- | --- |
| Order Lifecycle | 基本完成 | ACK、partial/multi-fill、out-of-order、duplicate、cancel intent/ack | reject、真正 execution/arrival 分离的 late fill |
| Position / Projected Position | 基本完成 | Fill 驱动净仓位；pending remaining qty 进入 projected exposure | 多品种与 venue position snapshot 收敛 |
| Deterministic Risk | 部分完成 | target-position delta、max position、initial-margin gate | reduce-only、显式 leverage constraint、close/reverse policy 字段 |
| Isolated Margin | 面试可演示 | equity、IM、MM、available margin、mark valuation | 交易所阶梯维持保证金和手续费细节 |
| Price Semantics | 面试可演示 | last / mark / index 分离 | exchange-grade mark derivation（当前不需要） |
| Funding | 最小完成 | rate、timestamp、side effect、idempotency | attribution 字段与 funding-triggered risk policy |
| Liquidation | 最小完成 | mark trigger 与 execution boundary 分离 | venue liquidation event 与 reopened exposure recovery |
| Recovery | 部分完成 | checkpoint、atomic save、unresolved order fail-closed | authoritative snapshot 驱动的恢复完成路径 |
| Reconciliation | 起步完成 | Position/order read-only mismatch report | resolution policy 与状态收敛 |
| Historical Replay | Pre-Formal gate 完成 | T0、input provenance、candle interval/freshness、formal filter | 3–5 个 FORMAL records |
| Prospective Sampling | Roadmap | 已明确不阻塞求职版 | Freeze 后再开始未来样本 |

## 面试完成线：剩余四个里程碑

### M1｜Perp failure demo 收口 ✅

挑选现有 deterministic traces，形成一次可运行演示：

```text
Signal → Risk → ACK → Partial Fill → Position
Cancel Intent → CancelAck → CANCELED
Mark → Liquidation
Restart → Recovery Required → Reconciliation Report
```

不新增完整 Connector 或 EventLog。

当前可通过 `npm run demo` 重复运行上述三段 trace。

### M2｜最小 recovery completion（M2A evidence contract ✅）

M2A 已定义 authoritative recovery evidence contract；当前仍只验证 evidence，不修改本地状态。M2B 只有获得满足 contract 的真实 snapshot 后，才定义窄的恢复完成路径。当前只读 reconciliation 已足够发现差异，但尚不能安全解除 `RECOVERY_REQUIRED`。

### M3｜3–5 个 FORMAL Historical Replay records

每条正式记录必须具备真实 T0、归档的 T0 前 event evidence、带 interval 且 fresh 到 T0 的 vendor market data、预定义 outcome rule 和窗口结束后的可测量 outcome。`RECONSTRUCTED / MIXED` 输入不能升级为 FORMAL。当前 SEC X 案例只是方法论反例，不计入正式样本。

FORMAL Case #1 已把候选选择规则实现为纯函数并完成 synthetic DEMO burn-in：在 FOMC release 后，用未修改的 MA(3,6) 找到第一个 actionable crossover（包括 HOLD/FLAT → LONG/SHORT），并要求发生在 18:30 Powell press conference 前；不存在则直接淘汰。Baseline Candidate Outcome 已冻结为 T0 close 零延迟 paper 成交、沿 crossover 方向持有 15 分钟，并以全局 ±50bps 阈值评分；结束时间必须严格早于下一 independent catalyst。该研究只覆盖 post-event 能产生 actionable crossover 的条件样本，本质是 mechanical momentum-chase comparison；ABSTAIN/WOULD_BLOCK 的优势可能来自“不追已有移动”，不能直接解释为 AI alpha 或 unconditional event performance。首次 raw artifact acquisition 因执行环境对 Fed/Coinbase 均返回 401/403 而未取得任何源 bytes；当前仍为 `NOT ADMITTED`。详见 [`formal-case-1-candidate-screen.md`](formal-case-1-candidate-screen.md) 与 [`formal-case-1-artifact-acquisition-attempt-2026-09-25.md`](formal-case-1-artifact-acquisition-attempt-2026-09-25.md)。

### M4｜面试叙事与演示脚本

整理一条 10–15 分钟演示：架构图、两个 failure trace、一个 recovery/reconciliation trace、一个 Historical Replay record，以及明确的非目标。

## 暂不阻塞完成线

- Prospective Paper Sampling；
- Binance 实盘 Connector；
- Cross Margin；
- exchange-grade liquidation engine；
- 大型 UI / backtest；
- AI 自动 gating 或下单；
- Prediction / YES → PerpIntent 映射。

## 下一步

下一步只能在可访问 authoritative locators 的环境中获取（或由用户提供）带原始 metadata 的 Fed official bytes 与 vendor BTC-USD 1m raw response；先 checksum 后解析，再执行冻结的 pre-18:30 selector。无合格 crossover 就淘汰；存在时才冻结 Shadow mapping/ABSTAIN accounting 并实现 record。成功后再扩到 3–5 条 FORMAL records。M2 recovery mutation 继续等待 authoritative exchange evidence，不阻塞案例与面试材料整理。
