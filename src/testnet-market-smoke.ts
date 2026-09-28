import { BinanceUsdsTestnetMarketFeed } from "./binance-testnet.ts";
import { formatTick } from "./logging.ts";

const feed = new BinanceUsdsTestnetMarketFeed({
  canonicalSymbol: "BTC-PERP",
  venueSymbol: "BTCUSDT"
});

let seen = 0;
let resolveDone: (() => void) | undefined;
const done = new Promise<void>((resolve) => {
  resolveDone = resolve;
});
const timeout = setTimeout(() => resolveDone?.(), 15_000);

try {
  await feed.start((tick) => {
    console.log(`[TESTNET_MARKET] ${formatTick(tick)}`);
    seen += 1;
    if (seen >= 3) resolveDone?.();
  });
  await done;
  if (seen < 3) throw new Error(`received only ${seen}/3 Binance Testnet market ticks`);
} finally {
  clearTimeout(timeout);
  await feed.close();
}
