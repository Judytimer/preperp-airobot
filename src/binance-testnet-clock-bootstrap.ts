import { measureBinanceTestnetClock } from "./binance-testnet-clock.ts";

const nativeNow = Date.now.bind(Date);
const sample = await measureBinanceTestnetClock({ now: nativeNow });

// Scope the compatibility adjustment to this Node process. Windows time and
// the Binance adapter remain unchanged; failure above prevents closure startup.
Date.now = () => nativeNow() + sample.offsetMs;

console.log(
  `[BINANCE_CLOCK] synchronized offsetMs=${sample.offsetMs} roundTripMs=${sample.roundTripMs}`
);
