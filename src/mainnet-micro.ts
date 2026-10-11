import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { resolveBuildIdentity } from "./build-identity.ts";
import {
  BinanceUsdsMarketFeed,
  BinanceUsdsVenue,
  AmbiguousOrderResultError,
  OfficialBinanceUsdsTransport,
  type BinanceMicroCapitalAccountStatus,
  type BinanceMarketSnapshot,
  type BinanceUsdsTransport,
  validateMarketOrder
} from "./binance-testnet.ts";
import { PerpBot } from "./bot.ts";
import { ObservedExecutionVenue } from "./observed-execution-venue.ts";
import { validateFlatPreflight } from "./perp-testnet-validation.ts";
import type { ExchangeStateSnapshot, ReconciliationReport } from "./reconciliation.ts";
import { runtimeEvidencePath, runtimeStatePath } from "./runtime-paths.ts";
import { JsonFileBotStateStore, type BotStateStore } from "./state-store.ts";
import type { PerpSignalSource } from "./strategy.ts";
import type { Position, Signal, Tick } from "./types.ts";

export const MAINNET_MICRO_PROTOCOL = "BINANCE_USDS_MAINNET_MICRO_V1" as const;
export const MAINNET_MICRO_ARM_PREFIX = "EXECUTE_REAL_MONEY_ONCE" as const;
export const MAINNET_MICRO_HARD_MAX_NOTIONAL_USDT = 25;
export const MAINNET_MICRO_PLAN_TTL_MS = 10 * 60 * 1_000;
export const MAINNET_MICRO_MAX_PRICE_DRIFT_BPS = 100;

const ROUND_TRIP_TIMEOUT_MS = 90_000;
const RECONCILIATION_TIMEOUT_MS = 20_000;
const POST_UNKNOWN_OBSERVATION_MS = 30_000;

export type MainnetMicroPlanPayload = {
  readonly protocolVersion: typeof MAINNET_MICRO_PROTOCOL;
  readonly environment: "BINANCE_USDS_MAINNET";
  readonly purpose: "EXECUTION_REALISM_ONLY";
  readonly profitabilityClaim: false;
  readonly repositoryCommit: string;
  readonly sourceFingerprint: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly canonicalSymbol: string;
  readonly venueSymbol: string;
  readonly side: "LONG" | "SHORT";
  readonly quantity: number;
  readonly leverage: 1;
  readonly maxNotionalUsdt: number;
  readonly referenceLastPrice: number;
  readonly estimatedNotionalUsdt: number;
  readonly maxPriceDriftBps: number;
  readonly accountPreflight: {
    readonly canTrade: true;
    readonly oneWayAndIsolated: true;
    readonly multiAssetsMargin: false;
    readonly allPositionsFlat: true;
    readonly noOpenOrders: true;
    readonly availableBalanceCoversCap: true;
  };
};

export type MainnetMicroPlan = MainnetMicroPlanPayload & { readonly planId: string };

export type MainnetMicroReport = {
  readonly status: "ROUND_TRIP_COMPLETE";
  readonly protocolVersion: typeof MAINNET_MICRO_PROTOCOL;
  readonly mode: "BINANCE_USDS_MAINNET";
  readonly purpose: "EXECUTION_REALISM_ONLY";
  readonly profitabilityClaim: false;
  readonly planId: string;
  readonly repositoryCommit: string;
  readonly marketTicks: number;
  readonly preflight: { readonly snapshot: ExchangeStateSnapshot; readonly reconciliation: ReconciliationReport };
  readonly submissions: ReturnType<ObservedExecutionVenue["getSubmissions"]>;
  readonly acknowledgements: ReturnType<ObservedExecutionVenue["getAcknowledgements"]>;
  readonly fills: ReturnType<ObservedExecutionVenue["getFills"]>;
  readonly terminals: ReturnType<ObservedExecutionVenue["getTerminals"]>;
  readonly openedPosition: Position;
  readonly actualEntryNotionalUsdt: number;
  readonly finalLocalPosition: Position;
  readonly localRealizedPnlAssumingQuoteFees: number;
  readonly venueRealizedPnlBeforeFeesUsdt: number | null;
  readonly feeTotalsByAsset: Readonly<Record<string, number>>;
  readonly netPnlUsdt: number | null;
  readonly final: { readonly snapshot: ExchangeStateSnapshot; readonly reconciliation: ReconciliationReport };
};

type PrepareConfig = {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly venueSymbol: string;
  readonly canonicalSymbol: string;
  readonly side: "LONG" | "SHORT";
  readonly quantity: number;
  readonly maxNotionalUsdt: number;
};

export type MainnetMicroRuntimeTransport = BinanceUsdsTransport & {
  loadMicroCapitalAccountStatus(): Promise<BinanceMicroCapitalAccountStatus>;
  ensureIsolatedMarginWhenFlat(symbol: string): Promise<void>;
  ensureInitialLeverageWhenFlat(symbol: string, leverage: number): Promise<void>;
  loadMarketSnapshot(symbol: string): Promise<BinanceMarketSnapshot>;
  hasHistoricalOrderPrefix(symbol: string, clientOrderPrefix: string, startTime: number): Promise<boolean>;
};

export type MainnetMicroRuntimeFeed = {
  start(onTick: (tick: Tick) => void | Promise<void>): Promise<void>;
  close(): Promise<void>;
};

export type MainnetMicroExecutionDependencies = {
  readonly transport?: MainnetMicroRuntimeTransport;
  readonly feed?: MainnetMicroRuntimeFeed;
  readonly stateStore?: BotStateStore;
  readonly logger?: (line: string) => void;
  readonly loadPlan?: (planId: string) => Promise<MainnetMicroPlan>;
  readonly repositoryCommit?: string;
  readonly sourceFingerprint?: string;
  readonly consumeAuthorization?: (planId: string) => Promise<void>;
  readonly persistReport?: (report: MainnetMicroReport) => Promise<string>;
};

class MainnetMicroSignal implements PerpSignalSource {
  private exitRequested = false;
  private readonly plan: MainnetMicroPlan;

  constructor(plan: MainnetMicroPlan) {
    this.plan = plan;
  }

  onTick(tick: Tick): Signal {
    if (!this.exitRequested) assertMarketWithinPlan(this.plan, tick.lastPrice);
    return this.exitRequested
      ? {
          action: "FLAT",
          shortMa: null,
          longMa: null,
          reason: `${MAINNET_MICRO_PROTOCOL} deterministic reduce-only FLAT after entry Fill`
        }
      : {
          action: this.plan.side,
          shortMa: null,
          longMa: null,
          reason: `${MAINNET_MICRO_PROTOCOL} plan=${this.plan.planId}`
        };
  }

  requestExit(): void {
    this.exitRequested = true;
  }
}

export function assertMicroCapitalAccountReady(
  status: BinanceMicroCapitalAccountStatus,
  maxNotionalUsdt: number
): void {
  const failures: string[] = [];
  if (!status.canTrade) failures.push("account cannot trade");
  if (status.multiAssetsMargin) failures.push("multi-assets margin is enabled");
  if (status.nonFlatSymbols.length > 0) failures.push(`non-flat positions: ${status.nonFlatSymbols.join(",")}`);
  if (status.openOrderSymbols.length > 0) failures.push(`open orders: ${status.openOrderSymbols.join(",")}`);
  if (status.availableBalance < maxNotionalUsdt) failures.push("available balance does not cover the notional cap");
  if (failures.length > 0) throw new Error(`mainnet micro account preflight failed: ${failures.join("; ")}`);
}

export function createMainnetMicroPlan(payload: MainnetMicroPlanPayload): MainnetMicroPlan {
  validatePlanPayload(payload, payload.createdAt);
  return { ...payload, planId: hashPlanPayload(payload) };
}

export function validateMainnetMicroPlan(plan: MainnetMicroPlan, now = Date.now()): MainnetMicroPlan {
  const { planId, ...payload } = plan;
  validatePlanPayload(payload, now);
  if (!/^[a-f0-9]{64}$/.test(planId) || hashPlanPayload(payload) !== planId) {
    throw new Error("mainnet micro plan hash mismatch");
  }
  return plan;
}

export function mainnetMicroArm(planId: string): string {
  return `${MAINNET_MICRO_ARM_PREFIX}:${safePlanId(planId)}`;
}

export function validateMainnetMicroArm(value: string | undefined, planId: string): void {
  const expected = mainnetMicroArm(planId);
  if (value !== expected) {
    throw new Error(`PREPERP_MAINNET_ARM must equal ${expected}`);
  }
}

export async function prepareMainnetMicro(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<{ readonly plan: MainnetMicroPlan; readonly path: string }> {
  const config = readPrepareConfig(env);
  const repositoryCommit = resolveBuildIdentity(env).repositoryCommit;
  const sourceFingerprint = await computeSourceFingerprint();
  const transport = new OfficialBinanceUsdsTransport({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    environment: "MAINNET"
  });
  try {
    const [status, rules, market] = await Promise.all([
      transport.loadMicroCapitalAccountStatus(),
      transport.loadSymbolRules(config.venueSymbol),
      transport.loadMarketSnapshot(config.venueSymbol)
    ]);
    assertMicroCapitalAccountReady(status, config.maxNotionalUsdt);
    await transport.validateAccountMode(config.venueSymbol);
    validateMarketOrder({
      symbol: config.canonicalSymbol,
      side: config.side === "LONG" ? "BUY" : "SELL",
      qty: config.quantity,
      price: market.lastPrice,
      reason: `${MAINNET_MICRO_PROTOCOL} prepare`,
      ts: market.observedAt
    }, rules);
    const estimatedNotionalUsdt = config.quantity * market.lastPrice;
    if (estimatedNotionalUsdt > config.maxNotionalUsdt) {
      throw new Error(`estimated notional ${estimatedNotionalUsdt} exceeds cap ${config.maxNotionalUsdt}`);
    }
    const createdAt = Date.now();
    const plan = createMainnetMicroPlan({
      protocolVersion: MAINNET_MICRO_PROTOCOL,
      environment: "BINANCE_USDS_MAINNET",
      purpose: "EXECUTION_REALISM_ONLY",
      profitabilityClaim: false,
      repositoryCommit,
      sourceFingerprint,
      createdAt,
      expiresAt: createdAt + MAINNET_MICRO_PLAN_TTL_MS,
      canonicalSymbol: config.canonicalSymbol,
      venueSymbol: config.venueSymbol,
      side: config.side,
      quantity: config.quantity,
      leverage: 1,
      maxNotionalUsdt: config.maxNotionalUsdt,
      referenceLastPrice: market.lastPrice,
      estimatedNotionalUsdt,
      maxPriceDriftBps: MAINNET_MICRO_MAX_PRICE_DRIFT_BPS,
      accountPreflight: {
        canTrade: true,
        oneWayAndIsolated: true,
        multiAssetsMargin: false,
        allPositionsFlat: true,
        noOpenOrders: true,
        availableBalanceCoversCap: true
      }
    });
    const path = planPath(plan.planId);
    await writeImmutable(path, `${JSON.stringify(plan, null, 2)}\n`);
    return { plan, path };
  } finally {
    await transport.close().catch(() => undefined);
  }
}

export async function executeMainnetMicro(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: MainnetMicroExecutionDependencies = {}
): Promise<{ readonly report: MainnetMicroReport; readonly path: string }> {
  const apiKey = requiredEnv(env, "BINANCE_MAINNET_API_KEY");
  const apiSecret = requiredEnv(env, "BINANCE_MAINNET_API_SECRET");
  const planId = safePlanId(requiredEnv(env, "PREPERP_MAINNET_PLAN_ID"));
  validateMainnetMicroArm(env.PREPERP_MAINNET_ARM, planId);
  const loadedPlan = dependencies.loadPlan === undefined
    ? JSON.parse(await readFile(planPath(planId), "utf8")) as MainnetMicroPlan
    : await dependencies.loadPlan(planId);
  const plan = validateMainnetMicroPlan(loadedPlan);
  if (plan.planId !== planId) throw new Error("requested plan ID does not match plan body");
  const repositoryCommit = dependencies.repositoryCommit ?? resolveBuildIdentity(env).repositoryCommit;
  if (repositoryCommit !== plan.repositoryCommit) {
    throw new Error("repository commit changed after mainnet micro plan preparation");
  }
  const sourceFingerprint = dependencies.sourceFingerprint ?? await computeSourceFingerprint();
  if (sourceFingerprint !== plan.sourceFingerprint) {
    throw new Error("execution source changed after mainnet micro plan preparation");
  }

  const transport: MainnetMicroRuntimeTransport = dependencies.transport ??
    new OfficialBinanceUsdsTransport({ apiKey, apiSecret, environment: "MAINNET" });
  const fatal = deferred<never>();
  const venue = new BinanceUsdsVenue({
    canonicalSymbol: plan.canonicalSymbol,
    venueSymbol: plan.venueSymbol,
    transport,
    onError: fatal.reject
  });
  const feed: MainnetMicroRuntimeFeed = dependencies.feed ?? new BinanceUsdsMarketFeed({
    canonicalSymbol: plan.canonicalSymbol,
    venueSymbol: plan.venueSymbol,
    environment: "MAINNET",
    onError: fatal.reject
  });
  const signal = new MainnetMicroSignal(plan);
  let bot: PerpBot | undefined;
  let openedPosition: Position | undefined;
  let exitRequested = false;
  const completed = deferred<void>();
  const observedVenue = new ObservedExecutionVenue(venue, {
    onProcessedEvent: (event) => {
      if ((event.type !== "FILL" && event.type !== "ORDER_TERMINAL") || bot === undefined) return;
      const position = bot.getPosition();
      const noOpenOrders = bot.getOpenOrders().length === 0;
      if (!exitRequested && noOpenOrders && position.side === plan.side && position.qty > 0) {
        openedPosition = position;
        exitRequested = true;
        signal.requestExit();
        return;
      }
      if (!exitRequested && noOpenOrders && position.side === "FLAT") {
        fatal.reject(new Error("mainnet micro entry reached a terminal state without a fill"));
        return;
      }
      if (exitRequested && noOpenOrders && position.side === "FLAT") completed.resolve();
    }
  });
  bot = await PerpBot.create({
    symbol: plan.canonicalSymbol,
    signalSource: signal,
    orderQty: plan.quantity,
    maxAbsPosition: plan.quantity,
    clientOrderNamespace: mainnetMicroClientOrderPrefix(plan.planId),
    margin: { collateral: plan.maxNotionalUsdt, leverage: 1, maintenanceMarginRate: 0.005 },
    stateStore: dependencies.stateStore ?? new JsonFileBotStateStore(runtimeStatePath("mainnet-micro-v1", `${planId}.state.json`)),
    venue: observedVenue,
    logger: dependencies.logger ?? console.log
  });

  let venueStarted = false;
  let feedStarted = false;
  let marketTicks = 0;
  try {
    const status = await transport.loadMicroCapitalAccountStatus();
    assertMicroCapitalAccountReady(status, plan.maxNotionalUsdt);
    await transport.ensureIsolatedMarginWhenFlat(plan.venueSymbol);
    await transport.ensureInitialLeverageWhenFlat(plan.venueSymbol, 1);
    const currentMarket = await transport.loadMarketSnapshot(plan.venueSymbol);
    assertMarketWithinPlan(plan, currentMarket.lastPrice);
    const clientOrderPrefix = mainnetMicroClientOrderPrefix(plan.planId);
    if (await transport.hasHistoricalOrderPrefix(plan.venueSymbol, `${clientOrderPrefix}-`, plan.createdAt - 60_000)) {
      throw new Error("mainnet micro plan has already reached Binance order history");
    }

    venueStarted = true;
    await venue.start();
    // Recheck globally after the user stream is live and immediately before consuming authorization.
    assertMicroCapitalAccountReady(await transport.loadMicroCapitalAccountStatus(), plan.maxNotionalUsdt);
    if (await transport.hasHistoricalOrderPrefix(plan.venueSymbol, `${clientOrderPrefix}-`, plan.createdAt - 60_000)) {
      throw new Error("mainnet micro plan was concurrently executed by another runner");
    }
    if (dependencies.consumeAuthorization === undefined) {
      const lockPath = runtimeStatePath("mainnet-micro-v1", `${planId}.execution.lock`);
      await writeImmutable(lockPath, `${JSON.stringify({ planId, armedAt: Date.now(), processId: process.pid })}\n`);
    } else {
      await dependencies.consumeAuthorization(planId);
    }
    const preflightSnapshot = await venue.snapshot();
    const preflight = { snapshot: preflightSnapshot, reconciliation: validateFlatPreflight(bot, preflightSnapshot) };
    feedStarted = true;
    await feed.start(async (tick) => {
      marketTicks += 1;
      await bot!.onTick(tick);
    });
    await Promise.race([
      withTimeout(completed.promise, ROUND_TRIP_TIMEOUT_MS, "mainnet micro round trip timed out"),
      fatal.promise
    ]);
    await feed.close();
    feedStarted = false;
    const final = await waitForFlatReconciliation(bot, venue);
    const submissions = observedVenue.getSubmissions();
    const acknowledgements = observedVenue.getAcknowledgements();
    const fills = observedVenue.getFills();
    const terminals = observedVenue.getTerminals();
    const finalLocalPosition = bot.getPosition();
    if (
      openedPosition === undefined || submissions.length < 2 ||
      submissions[0]?.request.reduceOnly === true || submissions.slice(1).some(({ request }) => request.reduceOnly !== true) ||
      fills.length < 2 || finalLocalPosition.side !== "FLAT" ||
      final.snapshot.position.side !== "FLAT" || final.snapshot.openOrders.length !== 0 ||
      !final.reconciliation.consistent
    ) throw new Error("mainnet micro execution evidence is incomplete");
    const feeTotalsByAsset = summarizeFees(fills.map(({ fill }) => fill));
    const venueRealizedPnlBeforeFeesUsdt = fills.every(({ fill }) => fill.venueRealizedPnl !== undefined)
      ? fills.reduce((total, { fill }) => total + (fill.venueRealizedPnl ?? 0), 0)
      : null;
    const netPnlUsdt = venueRealizedPnlBeforeFeesUsdt !== null &&
      Object.keys(feeTotalsByAsset).every((asset) => asset === "USDT")
      ? venueRealizedPnlBeforeFeesUsdt - (feeTotalsByAsset.USDT ?? 0)
      : null;
    const report: MainnetMicroReport = {
      status: "ROUND_TRIP_COMPLETE",
      protocolVersion: MAINNET_MICRO_PROTOCOL,
      mode: "BINANCE_USDS_MAINNET",
      purpose: "EXECUTION_REALISM_ONLY",
      profitabilityClaim: false,
      planId,
      repositoryCommit: plan.repositoryCommit,
      marketTicks,
      preflight,
      submissions,
      acknowledgements,
      fills,
      terminals,
      openedPosition,
      actualEntryNotionalUsdt: openedPosition.entryPrice * openedPosition.qty,
      finalLocalPosition,
      localRealizedPnlAssumingQuoteFees: finalLocalPosition.realizedPnl,
      venueRealizedPnlBeforeFeesUsdt,
      feeTotalsByAsset,
      netPnlUsdt,
      final
    };
    const path = dependencies.persistReport === undefined
      ? resultPath(planId)
      : await dependencies.persistReport(report);
    if (dependencies.persistReport === undefined) {
      await writeImmutable(path, `${JSON.stringify(report, null, 2)}\n`);
    }
    return { report, path };
  } catch (error) {
    if (venueStarted) {
      if (error instanceof AmbiguousOrderResultError) {
        await quarantineAmbiguousOrder(venue, plan.referenceLastPrice).catch((quarantineError) => {
          throw new AggregateError([error, quarantineError], "ambiguous order quarantine could not prove a flat account");
        });
      }
      const snapshot = await venue.snapshot().catch(() => null);
      if (snapshot !== null && snapshot.position.side !== "FLAT") {
        const referencePrice = snapshot.position.entryPrice > 0 ? snapshot.position.entryPrice : plan.referenceLastPrice;
        await venue.emergencyFlatten(referencePrice).catch((flattenError) => {
          throw new AggregateError([error, flattenError], "mainnet micro failed and emergency reduce-only FLAT also failed");
        });
      }
    }
    throw error;
  } finally {
    if (feedStarted) await feed.close().catch(() => undefined);
    if (venueStarted) await venue.close().catch(() => undefined);
    else await transport.close().catch(() => undefined);
  }
}

function readPrepareConfig(env: Readonly<Record<string, string | undefined>>): PrepareConfig {
  const venueSymbol = requiredEnv(env, "PREPERP_MICRO_SYMBOL").toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(venueSymbol)) throw new Error("PREPERP_MICRO_SYMBOL must be a USDT symbol");
  const side = requiredEnv(env, "PREPERP_MICRO_SIDE").toUpperCase();
  if (side !== "LONG" && side !== "SHORT") throw new Error("PREPERP_MICRO_SIDE must be LONG or SHORT");
  const quantity = positiveEnvNumber(env, "PREPERP_MICRO_QUANTITY");
  const maxNotionalUsdt = positiveEnvNumber(env, "PREPERP_MICRO_MAX_NOTIONAL_USDT");
  if (maxNotionalUsdt > MAINNET_MICRO_HARD_MAX_NOTIONAL_USDT) {
    throw new Error(`PREPERP_MICRO_MAX_NOTIONAL_USDT exceeds hard cap ${MAINNET_MICRO_HARD_MAX_NOTIONAL_USDT}`);
  }
  return {
    apiKey: requiredEnv(env, "BINANCE_MAINNET_API_KEY"),
    apiSecret: requiredEnv(env, "BINANCE_MAINNET_API_SECRET"),
    venueSymbol,
    canonicalSymbol: `${venueSymbol.slice(0, -4)}-PERP`,
    side,
    quantity,
    maxNotionalUsdt
  };
}

function validatePlanPayload(payload: MainnetMicroPlanPayload, now: number): void {
  if (
    payload.protocolVersion !== MAINNET_MICRO_PROTOCOL || payload.environment !== "BINANCE_USDS_MAINNET" ||
    payload.purpose !== "EXECUTION_REALISM_ONLY" || payload.profitabilityClaim !== false ||
    payload.leverage !== 1 || (payload.side !== "LONG" && payload.side !== "SHORT") ||
    !/^[A-Z0-9]{2,20}USDT$/.test(payload.venueSymbol) ||
    payload.canonicalSymbol !== `${payload.venueSymbol.slice(0, -4)}-PERP` ||
    !Number.isFinite(payload.quantity) || payload.quantity <= 0 ||
    !Number.isFinite(payload.maxNotionalUsdt) || payload.maxNotionalUsdt <= 0 ||
    payload.maxNotionalUsdt > MAINNET_MICRO_HARD_MAX_NOTIONAL_USDT ||
    !Number.isFinite(payload.referenceLastPrice) || payload.referenceLastPrice <= 0 ||
    !Number.isFinite(payload.estimatedNotionalUsdt) || payload.estimatedNotionalUsdt <= 0 ||
    payload.estimatedNotionalUsdt > payload.maxNotionalUsdt ||
    Math.abs(payload.estimatedNotionalUsdt - payload.quantity * payload.referenceLastPrice) >
      Math.max(1, payload.estimatedNotionalUsdt) * 1e-12 ||
    payload.maxPriceDriftBps !== MAINNET_MICRO_MAX_PRICE_DRIFT_BPS ||
    !Number.isSafeInteger(payload.createdAt) || !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt !== payload.createdAt + MAINNET_MICRO_PLAN_TTL_MS || now < payload.createdAt || now > payload.expiresAt ||
    typeof payload.repositoryCommit !== "string" || payload.repositoryCommit.length === 0 ||
    !/^[a-f0-9]{64}$/.test(payload.sourceFingerprint) ||
    payload.accountPreflight?.canTrade !== true || payload.accountPreflight.oneWayAndIsolated !== true ||
    payload.accountPreflight.multiAssetsMargin !== false || payload.accountPreflight.allPositionsFlat !== true ||
    payload.accountPreflight.noOpenOrders !== true || payload.accountPreflight.availableBalanceCoversCap !== true
  ) throw new Error("invalid or expired mainnet micro plan");
}

function hashPlanPayload(payload: MainnetMicroPlanPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function assertMarketWithinPlan(plan: MainnetMicroPlan, lastPrice: number): void {
  if (Date.now() > plan.expiresAt) throw new Error("mainnet micro plan expired before entry");
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) throw new Error("invalid current market price");
  const driftBps = Math.abs(lastPrice / plan.referenceLastPrice - 1) * 10_000;
  if (driftBps > plan.maxPriceDriftBps) throw new Error(`market price drift ${driftBps} bps exceeds plan cap`);
  const notional = plan.quantity * lastPrice;
  if (notional > plan.maxNotionalUsdt) throw new Error(`current notional ${notional} exceeds plan cap ${plan.maxNotionalUsdt}`);
}

async function waitForFlatReconciliation(
  bot: PerpBot,
  venue: Pick<BinanceUsdsVenue, "snapshot">
): Promise<{ snapshot: ExchangeStateSnapshot; reconciliation: ReconciliationReport }> {
  const deadline = Date.now() + RECONCILIATION_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const snapshot = await venue.snapshot();
    const reconciliation = bot.reconcile(snapshot);
    if (
      snapshot.position.side === "FLAT" && snapshot.position.qty === 0 &&
      snapshot.openOrders.length === 0 && reconciliation.consistent
    ) return { snapshot, reconciliation };
    await sleep(250);
  }
  throw new Error("mainnet micro final FLAT reconciliation timed out");
}

async function quarantineAmbiguousOrder(venue: BinanceUsdsVenue, referencePrice: number): Promise<void> {
  const deadline = Date.now() + POST_UNKNOWN_OBSERVATION_MS;
  let lastSnapshot: ExchangeStateSnapshot | null = null;
  while (Date.now() <= deadline) {
    lastSnapshot = await venue.snapshot();
    if (lastSnapshot.openOrders.length === 0 && lastSnapshot.position.side !== "FLAT") {
      await venue.emergencyFlatten(
        lastSnapshot.position.entryPrice > 0 ? lastSnapshot.position.entryPrice : referencePrice
      );
    }
    await sleep(500);
  }
  lastSnapshot = await venue.snapshot();
  if (lastSnapshot.position.side !== "FLAT" || lastSnapshot.openOrders.length > 0) {
    throw new Error("UNKNOWN order observation ended with exposure or open orders");
  }
}

function summarizeFees(fills: readonly { readonly fee: number; readonly feeAsset?: string }[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const fill of fills) {
    if (fill.fee === 0) continue;
    const asset = fill.feeAsset ?? "UNKNOWN";
    totals[asset] = (totals[asset] ?? 0) + fill.fee;
  }
  return Object.fromEntries(Object.entries(totals).sort(([left], [right]) => left.localeCompare(right)));
}

function planPath(planId: string): string {
  return runtimeEvidencePath("mainnet-micro-v1", "plans", `${safePlanId(planId)}.json`);
}

function resultPath(planId: string): string {
  return runtimeEvidencePath("mainnet-micro-v1", "results", `${safePlanId(planId)}.json`);
}

export function mainnetMicroClientOrderPrefix(planId: string): string {
  return `PM${safePlanId(planId).slice(0, 16)}`;
}

function safePlanId(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid PREPERP_MAINNET_PLAN_ID");
  return value;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function computeSourceFingerprint(): Promise<string> {
  const sourceFiles = (await readdir(resolve(process.cwd(), "src"), { recursive: true }))
    .filter((path) => path.endsWith(".ts"))
    .map((path) => `src/${path.replaceAll("\\", "/")}`)
    .sort();
  const files = ["package.json", "package-lock.json", ...sourceFiles];
  const hash = createHash("sha256");
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(resolve(process.cwd(), relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function positiveEnvNumber(env: Readonly<Record<string, string | undefined>>, name: string): number {
  const value = Number(requiredEnv(env, name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveArgument, rejectArgument) => {
    resolvePromise = resolveArgument;
    rejectPromise = rejectArgument;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function writeImmutable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const command = process.argv[2];
  if (command === "prepare") {
    const prepared = await prepareMainnetMicro();
    console.log("[MAINNET_MICRO_PLAN_READY]", JSON.stringify({
      planId: prepared.plan.planId,
      expiresAt: prepared.plan.expiresAt,
      symbol: prepared.plan.venueSymbol,
      side: prepared.plan.side,
      quantity: prepared.plan.quantity,
      maxNotionalUsdt: prepared.plan.maxNotionalUsdt,
      path: prepared.path,
      next: `Set PREPERP_MAINNET_PLAN_ID=${prepared.plan.planId} and PREPERP_MAINNET_ARM=${mainnetMicroArm(prepared.plan.planId)}, then run mainnet:micro:execute`
    }));
  } else if (command === "execute") {
    const executed = await executeMainnetMicro();
    console.log("[MAINNET_MICRO_COMPLETE]", JSON.stringify({
      planId: executed.report.planId,
      netPnlUsdt: executed.report.netPnlUsdt,
      feeTotalsByAsset: executed.report.feeTotalsByAsset,
      finalPosition: executed.report.finalLocalPosition.side,
      path: executed.path
    }));
  } else {
    throw new Error("usage: mainnet-micro.ts prepare|execute");
  }
}
