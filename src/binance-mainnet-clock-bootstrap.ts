import { measureBinanceClock } from "./binance-testnet-clock.ts";

const nativeNow = Date.now.bind(Date);
const sample = await measureBinanceClock("MAINNET", { now: nativeNow });

// Process-local adjustment only; the operating system clock is not modified.
Date.now = () => nativeNow() + sample.offsetMs;

console.log(
  `[BINANCE_CLOCK] environment=MAINNET synchronized offsetMs=${sample.offsetMs} roundTripMs=${sample.roundTripMs}`
);
