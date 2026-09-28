import { setTimeout as sleep } from "node:timers/promises";

import {
  BinanceUsdsTestnetMarketFeed,
  BinanceUsdsTestnetVenue,
  OfficialBinanceUsdsTestnetTransport
} from "./binance-testnet.ts";
import { PerpBot } from "./bot.ts";
import { JsonFileBotStateStore } from "./state-store.ts";

const apiKey = process.env.BINANCE_TESTNET_API_KEY ?? "";
const apiSecret = process.env.BINANCE_TESTNET_API_SECRET ?? "";
if (apiKey.length === 0 || apiSecret.length === 0) {
  throw new Error("Set BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET before running testnet execution");
}

const canonicalSymbol = "BTC-PERP";
const venueSymbol = "BTCUSDT";
const transport = new OfficialBinanceUsdsTestnetTransport(apiKey, apiSecret);
const venue = new BinanceUsdsTestnetVenue({ canonicalSymbol, venueSymbol, transport });
const bot = await PerpBot.create({
  symbol: canonicalSymbol,
  shortWindow: 3,
  longWindow: 6,
  orderQty: 0.001,
  maxAbsPosition: 0.003,
  margin: { collateral: 1_000, leverage: 5, maintenanceMarginRate: 0.005 },
  stateStore: new JsonFileBotStateStore(".runtime/binance-testnet-state.json"),
  venue
});
const feed = new BinanceUsdsTestnetMarketFeed({ canonicalSymbol, venueSymbol });
const maxTicks = 12;
let ticks = 0;
let resolveDone: (() => void) | undefined;
const done = new Promise<void>((resolve) => {
  resolveDone = resolve;
});

try {
  await venue.start();
  await feed.start(async (tick) => {
    await bot.onTick(tick);
    ticks += 1;
    if (ticks >= maxTicks) resolveDone?.();
  });
  await done;
  await sleep(2_000);
  console.log("[TESTNET_RECONCILIATION]", JSON.stringify(bot.reconcile(await venue.snapshot())));
  console.log("[TESTNET_DONE]", bot.getPosition());
} finally {
  await feed.close();
  await venue.close();
}
