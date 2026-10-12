import { PerpBot } from "./bot.ts";
import { SimulatedExchange } from "./exchange.ts";
import type { FillDelay, FillPlanStep } from "./exchange.ts";
import type { BotCheckpoint, BotStateStore } from "./state-store.ts";
import type { Tick } from "./types.ts";

type DemoSection = {
  title: string;
  lines: string[];
};
const venues = new WeakMap<PerpBot, SimulatedExchange>();

async function lifecycleSection(): Promise<DemoSection> {
  const logs: string[] = [];
  const bot = makeBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 1,
    fillPlan: [
      { fraction: 0.4, delayMs: 1 },
      { fraction: 0.6, delayMs: 10 }
    ],
    logger: (line) => logs.push(line)
  });

  for (const [index, price] of [100, 101, 102, 103].entries()) {
    await bot.onTick(tick(index + 1, price));
  }
  await drain(bot);

  return {
    title: "Signal -> Risk -> ACK -> Partial Fill -> Position",
    lines: select(logs, ["[SIGNAL]", "[RISK]", "[ACK]", "[FILL]", "[ORDER]", "[POSITION]"])
  };
}

async function liquidationCancelSection(): Promise<DemoSection> {
  const logs: string[] = [];
  const bot = makeBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 25,
    margin: { collateral: 0.1, leverage: 20, maintenanceMarginRate: 0.01 },
    logger: (line) => logs.push(line)
  });

  for (const [index, price] of [100, 101, 102, 103].entries()) {
    await bot.onTick(tick(index + 1, price));
  }
  await drain(bot);
  await bot.onTick(tick(5, 80, 103, 100));
  await bot.onTick(tick(6, 80, 90, 95));
  await drain(bot);

  return {
    title: "Cancel Intent -> OrderTerminal -> Liquidation",
    lines: select(logs, ["[ACK]", "[ORDER_TERMINAL]", "cancelRequested=true", "status=CANCELED", "[LIQUIDATION]", "[POSITION]"])
  };
}

async function recoverySection(): Promise<DemoSection> {
  const logs: string[] = [];
  const bot = await createBot({
    symbol: "BTC-PERP",
    shortWindow: 2,
    longWindow: 4,
    orderQty: 0.01,
    maxAbsPosition: 0.03,
    fillDelayMs: 1,
    stateStore: new FixedStateStore(unresolvedCheckpoint()),
    logger: (line) => logs.push(line)
  });
  await bot.onTick(tick(10, 110));
  const report = bot.reconcile({
    position: flatPosition(),
    openOrders: []
  });

  return {
    title: "Restart -> Recovery Required -> Reconciliation Report",
    lines: [...select(logs, ["[RECOVERY]"]), `[RECONCILIATION] ${JSON.stringify(report)}`]
  };
}

function select(lines: readonly string[], markers: readonly string[]): string[] {
  return lines.filter((line) => markers.some((marker) => line.includes(marker)));
}

function tick(seq: number, lastPrice: number, markPrice = lastPrice, indexPrice = markPrice): Tick {
  return { seq, symbol: "BTC-PERP", lastPrice, markPrice, indexPrice, ts: seq };
}

function flatPosition() {
  return { symbol: "BTC-PERP", side: "FLAT" as const, qty: 0, entryPrice: 0, realizedPnl: 0 };
}

class FixedStateStore implements BotStateStore {
  private readonly checkpoint: BotCheckpoint;

  constructor(checkpoint: BotCheckpoint) {
    this.checkpoint = checkpoint;
  }

  async load(): Promise<BotCheckpoint> {
    return structuredClone(this.checkpoint);
  }

  async save(): Promise<void> {}
}

function unresolvedCheckpoint(): BotCheckpoint {
  return {
    version: 1,
    symbol: "BTC-PERP",
    positionState: { position: flatPosition(), processedFillIds: [] },
    orderTrackerState: {
      orders: [
        {
          order: {
            clientOrderId: "BTC-PERP-1",
            exchangeOrderId: "SIM-1",
            side: "BUY",
            originalQty: 0.01,
            filledQty: 0,
            remainingQty: 0.01,
            status: "ACKED"
          },
          symbol: "BTC-PERP",
          processedFillIds: []
        }
      ]
    },
    nextClientOrderSequence: 2,
    halted: false,
    lastMarkPrice: 100
  };
}

const sections = [
  await lifecycleSection(),
  await liquidationCancelSection(),
  await recoverySection()
];

for (const section of sections) {
  console.log(`\n=== ${section.title} ===`);
  for (const line of section.lines) {
    console.log(line);
  }
}


type DemoConfig = Omit<ConstructorParameters<typeof PerpBot>[0], "venue"> & { fillDelayMs: FillDelay; fillPlan?: readonly FillPlanStep[] };
function makeBot(config: DemoConfig): PerpBot {
  const { fillDelayMs, fillPlan, ...core } = config;
  const venue = new SimulatedExchange(fillDelayMs, 0.0004, fillPlan);
  const bot = new PerpBot({ ...core, venue }); venues.set(bot, venue); return bot;
}
async function createBot(config: DemoConfig): Promise<PerpBot> {
  const { fillDelayMs, fillPlan, ...core } = config;
  const venue = new SimulatedExchange(fillDelayMs, 0.0004, fillPlan);
  const bot = await PerpBot.create({ ...core, venue }); venues.set(bot, venue); return bot;
}
async function drain(bot: PerpBot): Promise<void> { await venues.get(bot)?.drain(); }
