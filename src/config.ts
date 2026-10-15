import { createStrategyConfigParser } from "@tradejs/strategy-kit/config";
import type { StrategyConfig } from "@tradejs/types";

export const STRATEGY_NAME = "VwapReversion";
export interface VwapReversionConfig extends StrategyConfig {
  INTERVAL: "15" | "60";
  VWAP_BAND_MULT: number;
  VWAP_MIN_VOLUME_BARS: number;
  VWAP_ER_PERIOD: number;
  VWAP_MAX_ER: number;
  VWAP_MAX_EXCURSION_BARS: number;
  VWAP_STOP_BUFFER_PCT: number;
  VWAP_MAX_HOLD_BARS: number;
  VWAP_COOLDOWN_BARS: number;
  VWAP_MIN_RISK_RATIO: number;
  VWAP_REQUIRE_PRICE_REVERSAL: boolean;
  VWAP_MIN_SESSION_BARS_LEFT: number;
  MAX_LOSS_VALUE: number;
  RISK_FEE_RATE: number;
  RISK_SLIPPAGE_BPS: number;
  RISK_MARKET_IMPACT_BPS: number;
}
export const defaultConfig: VwapReversionConfig = {
  INTERVAL: "15",
  BACKTEST_PRICE_MODE: "close",
  BACKTEST_ENTRY_DELAY_BARS: 0,
  VWAP_REQUIRE_PRICE_REVERSAL: true,
  VWAP_MIN_SESSION_BARS_LEFT: 1,
  VWAP_BAND_MULT: 2,
  VWAP_MIN_VOLUME_BARS: 8,
  VWAP_ER_PERIOD: 8,
  VWAP_MAX_ER: 0.2,
  VWAP_MAX_EXCURSION_BARS: 8,
  VWAP_STOP_BUFFER_PCT: 0.1,
  VWAP_MAX_HOLD_BARS: 16,
  VWAP_COOLDOWN_BARS: 4,
  VWAP_MIN_RISK_RATIO: 1.2,
  MAX_LOSS_VALUE: 10,
  RISK_FEE_RATE: 0.001,
  RISK_SLIPPAGE_BPS: 2,
  RISK_MARKET_IMPACT_BPS: 0,
};
const parseShape = createStrategyConfigParser({
  strategyName: STRATEGY_NAME,
  defaults: defaultConfig,
  // The shared backtest/runtime runner adds these execution switches before
  // constructing a core. They are not strategy parameters.
  optionalScalarFields: {
    ENV: "string",
    MAKE_ORDERS: "boolean",
    CLOSE_OPPOSITE_POSITIONS: "boolean",
  },
});
export function parseConfig(input: unknown): VwapReversionConfig {
  const config = parseShape(input);
  const fail = (field: string) => {
    throw new Error(`Invalid ${STRATEGY_NAME}.${field}`);
  };
  if (!["15", "60"].includes(config.INTERVAL)) fail("INTERVAL");
  const barsPerDay = 1440 / Number(config.INTERVAL);
  for (const key of [
    "VWAP_MIN_VOLUME_BARS",
    "VWAP_ER_PERIOD",
    "VWAP_MAX_EXCURSION_BARS",
    "VWAP_MAX_HOLD_BARS",
    "VWAP_COOLDOWN_BARS",
    "VWAP_MIN_SESSION_BARS_LEFT",
  ] as const) {
    if (
      !Number.isInteger(config[key]) ||
      config[key] < 1 ||
      config[key] >= barsPerDay - 1
    )
      fail(key);
  }
  for (const key of [
    "VWAP_BAND_MULT",
    "VWAP_STOP_BUFFER_PCT",
    "VWAP_MIN_RISK_RATIO",
    "MAX_LOSS_VALUE",
  ] as const) {
    if (config[key] <= 0) fail(key);
  }
  if (config.VWAP_MAX_ER < 0 || config.VWAP_MAX_ER > 1) fail("VWAP_MAX_ER");
  if (config.VWAP_STOP_BUFFER_PCT >= 100) fail("VWAP_STOP_BUFFER_PCT");
  for (const key of [
    "RISK_FEE_RATE",
    "RISK_SLIPPAGE_BPS",
    "RISK_MARKET_IMPACT_BPS",
  ] as const) {
    if (config[key] < 0) fail(key);
  }
  // Decision geometry and fixed targets are defined at the closed signal candle.
  if (
    config.BACKTEST_ENTRY_DELAY_BARS != null &&
    config.BACKTEST_ENTRY_DELAY_BARS !== 0
  )
    fail("BACKTEST_ENTRY_DELAY_BARS");
  if (
    config.BACKTEST_PRICE_MODE != null &&
    config.BACKTEST_PRICE_MODE !== "close"
  )
    fail("BACKTEST_PRICE_MODE");
  return config;
}
export const intervalMs = (config: VwapReversionConfig) =>
  Number(config.INTERVAL) * 60_000;
