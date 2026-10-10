import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { readAutostart, writeAutostart } from "./autostart";
import { fetchSystemStatus, type ServicePhase, type SystemStatus } from "./system-status";

const healthyServicePhases = new Set<ServicePhase>(["SERVICE_READY_MODEL_COLD", "MODEL_READY"]);

export function Overview() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["system-status"], queryFn: fetchSystemStatus });
  const autostart = useQuery({ queryKey: ["autostart"], queryFn: readAutostart, retry: false });
  const toggleAutostart = useMutation({
    mutationFn: writeAutostart,
    onSuccess: (enabled) => queryClient.setQueryData(["autostart"], enabled)
  });
  const data = status.data;
  const candidate = data?.latestCandidate;
  const testnet = data?.predictionTestnet;
  const hourly = data?.hourlyWatcher;
  const hourlyCandidate = candidate?.variant === "HOURLY_UP_DOWN_V1";

  return (
    <main className="shell">
      <header className="masthead">
        <div className="brand-mark" aria-hidden="true"><span>P</span></div>
        <div><p className="eyebrow">本地量化运行时</p><h1>PrePerp 量化控制台</h1></div>
        <div className="header-status"><span className={`pulse ${status.isError ? "danger" : ""}`} />{status.isPending ? "正在连接" : status.isError ? "运行时不可用" : data?.authority.testnetDemoArmed ? "测试网已武装" : "本地观察中"}</div>
      </header>

      {status.isError && <section className="alert danger-panel" role="alert"><strong>桌面运行时不可用</strong><span>{runtimeErrorText(status.error)}</span></section>}

      <section className="hero-grid">
        <article className="hero-card">
          <p className="label">当前任务</p>
          <h2>{testnet?.phase === "ROUND_TRIP_COMPLETE" ? "预测信号测试网闭环已完成" : "监控 7 资产小时信号 + 4 资产日度信号"}</h2>
          <p className="muted">采集器持续读取 Polymarket 与 Binance。小时 Up/Down 提高触发频率；新候选仍由确定性规则产生，量化机器人只执行一次测试网演示闭环。</p>
          <div className="authority-row"><Badge>{data?.authority.testnetDemoArmed ? "测试网已武装" : "测试网待机"}</Badge><Badge>实盘关闭</Badge><Badge>Laya 无下单权</Badge></div>
        </article>
        <article className="clock-card"><p className="label">观测时间</p><div className="clock">{data ? formatTime(data.observedAt) : "--:--:--"}</div><p className="mono muted">{data ? shortCommit(data.build.commit) : "--------"} · v{data?.build.version ?? "—"}</p></article>
      </section>

      <section className="flow-panel">
        <div className="flow-heading"><div><p className="label">信号到订单</p><h3>真实数据链路</h3></div><span className="flow-note">小时 Up/Down 为同方向演示映射，不代表 alpha</span></div>
        <div className="flow-grid">
          <FlowNode index="01" title="预测市场" state={candidate ? "已归档" : "等待数据"}>
            <strong>{candidate?.question ?? "等待新的价格目标市场"}</strong><span>YES 最优卖价 {candidate ? formatPrice(candidate.entryBestAsk) : "—"}</span><span>可用数量 {candidate ? formatNumber(candidate.entryBestAskSize) : "—"}</span>
          </FlowNode>
          <FlowArrow />
          <FlowNode index="02" title="确定性候选" state={candidate ? "QUALIFIED" : "等待触发"}>
            <strong>{candidate ? candidateHeadline(candidate) : "7 资产小时池 / 4 资产日度池"}</strong><span>{candidate ? candidateCrossing(candidate) : "真实 1 分钟收盘触发"}</span><span>T0 {candidate ? formatDateTime(candidate.candidateT0) : "—"}</span>
          </FlowNode>
          <FlowArrow />
          <FlowNode index="03" title="证据审核" state={hourlyCandidate ? "确定性规则" : localizeLaya(data?.layaReview.choice)}>
            <strong>{hourlyCandidate ? "跨越 + ≤50¢ 滞后" : data?.layaReview.choice ? localizeLaya(data.layaReview.choice) : "尚无审核"}</strong><span>{hourlyCandidate ? "UP/DOWN 来自市场定义" : `模型分数 ${formatPercent(data?.layaReview.answerConfidence)}`}</span><span>Laya 无方向权、无下单权</span>
          </FlowNode>
          <FlowArrow />
          <FlowNode index="04" title="Binance 测试网" state={localizeTestnet(testnet?.phase)} accent>
            <strong>{testnet?.venueSymbol ?? "等待候选后选择同资产合约"}</strong><span>当前可执行池 {testnet?.allowedAssets.join(" / ") || "BTC / ETH / SOL / XRP / DOGE / HYPE / BNB"}</span><span>成交后立即减仓至 FLAT</span>
          </FlowNode>
        </div>
      </section>

      <section className="status-grid compact-grid">
        <StatusCard index="01" title="日度 Price-Target" status={localizeWatcher(data?.watcher.phase)} healthy={data?.watcher.phase === "RUNNING"} detail={data?.watcher.latestCycleAt ? `最近一次采集：${relativeTime(data.watcher.latestCycleAt, data.observedAt)}` : "尚无采集记录"}>
          <Metric label="等待触发" value={data?.watcher.admission?.waiting ?? "—"} /><Metric label="合格合约" value={data?.watcher.admission?.qualified ?? "—"} accent /><Metric label="数据阻塞" value={data?.watcher.admission?.dataBlocked ?? "—"} />
        </StatusCard>
        <StatusCard index="02" title="小时 Up/Down" status={localizeWatcher(hourly?.phase)} healthy={hourly?.phase === "RUNNING"} detail={hourly?.latestCycleAt && data ? `资产 ${hourly.monitoredAssets.join(" / ")} · ${relativeTime(hourly.latestCycleAt, data.observedAt)}` : "等待首轮小时市场扫描"}>
          <Metric label="活跃 episode" value={hourly?.activeEpisodes ?? "—"} accent /><Metric label="等待触发" value={hourly?.admission?.waiting ?? "—"} /><Metric label="合格信号" value={hourly?.admission?.qualified ?? "—"} />
        </StatusCard>
        <StatusCard index="03" title="本地 Laya" status={localizeLayaService(data?.laya.phase)} healthy={data ? healthyServicePhases.has(data.laya.phase) : false} detail={data?.laya.detail ?? (data?.laya.loadedModels.length ? `${data.laya.loadedModels.join(", ")} · ${data.laya.device ?? "设备未知"}` : "本地模型服务")}>
          <Metric label="已加载模型" value={data?.laya.loadedModels.length ?? "—"} /><Metric label="推理耗时" value={formatDuration(data?.layaReview.inferenceMs)} /><Metric label="下单权限" value="无" />
        </StatusCard>
        <StatusCard index="04" title="测试网执行器" status={localizeTestnet(testnet?.phase)} healthy={testnet?.phase === "ARMED_WAITING_CANDIDATE" || testnet?.phase === "ROUND_TRIP_COMPLETE"} detail={testnet?.detail ?? "只消费启动后出现的新候选；不会使用历史候选补单。"}>
          <Metric label="监听资产" value={testnet?.allowedAssets.join("/") || "—"} /><Metric label="目标合约" value={testnet?.venueSymbol ?? "自动选择"} accent /><Metric label="候选" value={testnet?.candidateId ? "已捕捉" : "等待中"} />
        </StatusCard>
        <StatusCard index="05" title="本地常驻" status={data?.supervisor.resident ? "后台监督中" : "未启动"} healthy={data?.supervisor.resident === true} detail={data ? `每 ${Math.round(data.supervisor.cadenceMs / 1_000)} 秒检查 watcher 与 Laya；测试网不会自动重新武装。` : "等待本地 supervisor 状态"} action={
          <div className="autostart-control">
            <span>Windows 登录后启动</span>
            <button
              type="button"
              className={autostart.data ? "toggle enabled" : "toggle"}
              disabled={autostart.isPending || autostart.isError || toggleAutostart.isPending}
              onClick={() => toggleAutostart.mutate(!autostart.data)}
              aria-pressed={autostart.data === true}
            >
              {toggleAutostart.isPending ? "保存中" : autostart.data ? "已开启" : autostart.isError ? "不可用" : "未开启"}
            </button>
          </div>
        }>
          <Metric label="采集规则" value="本地确定性" /><Metric label="云端 AI" value={data?.supervisor.cloudAiRequired ? "需要" : "0 / 不需要"} accent /><Metric label="Laya" value={data?.supervisor.layaLocalOnly ? "仅本机" : "—"} />
        </StatusCard>
      </section>

      <section className="runtime-panel"><div><p className="label">本地运行边界</p><h3>可检查、可追溯、失败即关闭</h3></div><dl className="path-list"><PathRow label="模式" value={data?.runtime.mode ?? "—"} /><PathRow label="证据" value={data?.runtime.evidenceRoot ?? "—"} /><PathRow label="状态" value={data?.runtime.stateRoot ?? "—"} /><PathRow label="日志" value={data?.runtime.logRoot ?? "—"} /></dl></section>
      <footer><span>失败时默认关闭</span><span className="mono">每 5 秒刷新状态</span></footer>
    </main>
  );
}

function runtimeErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("invoke") || message.includes("__TAURI_INTERNALS__")) {
    return "当前是浏览器预览；实时状态只在 PrePerp 桌面应用内可用。";
  }
  return message ? `连接本地运行时失败：${message}` : "连接本地运行时失败，请确认桌面服务仍在运行。";
}

function FlowNode({ index, title, state, accent = false, children }: { readonly index: string; readonly title: string; readonly state: string; readonly accent?: boolean; readonly children: React.ReactNode }) { return <article className={`flow-node ${accent ? "accent-node" : ""}`}><div className="flow-node-top"><span>{index}</span><em>{state}</em></div><h4>{title}</h4><div className="flow-copy">{children}</div></article>; }
function FlowArrow() { return <div className="flow-arrow" aria-hidden="true">→</div>; }
function StatusCard(props: { readonly index: string; readonly title: string; readonly status: string; readonly healthy: boolean; readonly detail: string; readonly children: React.ReactNode; readonly action?: React.ReactNode }) { return <article className="status-card"><div className="status-heading"><span className="card-index">{props.index}</span><span className={`status-dot ${props.healthy ? "healthy" : "warning"}`} /></div><h3>{props.title}</h3><p className={`status-word ${props.healthy ? "healthy-text" : "warning-text"}`}>{props.status}</p><p className="card-detail">{props.detail}</p><dl className="metrics">{props.children}</dl>{props.action}</article>; }
function Metric({ label, value, accent = false }: { readonly label: string; readonly value: string | number; readonly accent?: boolean }) { return <div><dt>{label}</dt><dd className={accent ? "accent" : ""}>{value}</dd></div>; }
function PathRow({ label, value }: { readonly label: string; readonly value: string }) { return <div><dt>{label}</dt><dd className="mono" title={value}>{value}</dd></div>; }
function Badge({ children }: { readonly children: React.ReactNode }) { return <span className="badge safe">{children}</span>; }
function formatTime(timestamp: number): string { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(timestamp); }
function formatDateTime(timestamp: number): string { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp); }
function relativeTime(timestamp: number, now: number): string { const seconds = Math.max(0, Math.round((now - timestamp) / 1_000)); if (seconds < 60) return `${seconds} 秒前`; const minutes = Math.round(seconds / 60); return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`; }
function shortCommit(commit: string): string { return commit.length >= 8 ? commit.slice(0, 8) : commit; }
function formatPercent(value: number | null | undefined): string { return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`; }
function formatDuration(value: number | null | undefined): string { if (value === null || value === undefined) return "—"; return value >= 1_000 ? `${(value / 1_000).toFixed(1)} 秒` : `${Math.round(value)} 毫秒`; }
function formatPrice(value: number): string { return `${(value * 100).toFixed(0)}¢`; }
function formatNumber(value: number): string { return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value); }
function formatUsd(value: number): string { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value); }
function candidateHeadline(candidate: NonNullable<SystemStatus["latestCandidate"]>): string { return candidate.variant === "HOURLY_UP_DOWN_V1" ? `${candidate.asset} ${candidate.direction === "DOWN" ? "看跌 / SHORT" : "看涨 / LONG"}` : `${candidate.asset} 上穿 ${formatUsd(candidate.selectedStrike ?? 0)}`; }
function candidateCrossing(candidate: NonNullable<SystemStatus["latestCandidate"]>): string { const reference = candidate.variant === "HOURLY_UP_DOWN_V1" ? ` · 小时开盘 ${formatNumber(candidate.referenceOpen ?? 0)}` : ""; return `${formatNumber(candidate.crossingPreviousClose)} → ${formatNumber(candidate.crossingClose)}${reference}`; }
function localizeWatcher(value: string | undefined): string { return ({ RUNNING: "运行中", STALE: "已停滞", NEVER_RUN: "尚未运行", FAILED: "失败" } as Record<string, string>)[value ?? ""] ?? "连接中"; }
function localizeLayaService(value: string | undefined): string { return ({ MODEL_READY: "模型已就绪", SERVICE_READY_MODEL_COLD: "服务已就绪 / 模型冷启动", SERVICE_STARTING: "正在启动", OFFLINE: "离线", FAILED: "失败" } as Record<string, string>)[value ?? ""] ?? "连接中"; }
function localizeLaya(value: string | null | undefined): string { return ({ consistent: "证据一致", manual_review: "需要人工复核", insufficient: "证据不足" } as Record<string, string>)[value ?? ""] ?? "等待审核"; }
function localizeTestnet(value: string | undefined): string { return ({ DISARMED: "未武装", STARTING: "正在启动", ARMED_WAITING_CANDIDATE: "等待新候选", EXECUTING: "正在执行", ROUND_TRIP_COMPLETE: "闭环完成", FAILED_REVIEW_REQUIRED: "失败 / 需复核" } as Record<string, string>)[value ?? ""] ?? "连接中"; }
