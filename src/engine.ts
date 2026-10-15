import type { Direction, KlineChartItem } from "@tradejs/types";
import { intervalMs, parseConfig, type VwapReversionConfig } from "./config.js";

export const DAY_MS = 86_400_000;
export const utcDay = (timestamp: number) =>
  Math.floor(timestamp / DAY_MS) * DAY_MS;
export type VwapCandle = Pick<
  KlineChartItem,
  "timestamp" | "open" | "high" | "low" | "close" | "volume"
>;
export interface Excursion {
  direction: Direction;
  timestamp: number;
  extreme: number;
}
export interface ReversionSignal extends Excursion {
  entryTimestamp: number;
  target: number;
  stop: number;
}
export interface VwapSample {
  timestamp: number;
  vwap: number;
  upper: number;
  lower: number;
  er: number | null;
  allowed: boolean;
}
export interface EngineResult {
  timestamp: number;
  reason: string;
  sample: VwapSample | null;
  signal: ReversionSignal | null;
}
export interface EngineState {
  version: 1;
  configKey: string;
  day: number | null;
  complete: boolean;
  lastTimestamp: number | null;
  weight: number;
  mean: number;
  m2: number;
  volumeBars: number;
  closes: number[];
  pending: Excursion | null;
  samples: VwapSample[];
  lastResult: EngineResult | null;
}
export function efficiencyRatio(closes: readonly number[]): number | null {
  if (closes.length < 2) return null;
  let path = 0;
  for (let i = 1; i < closes.length; i++)
    path += Math.abs(closes[i] - closes[i - 1]);
  return path === 0
    ? 0
    : Math.min(1, Math.abs(closes.at(-1)! - closes[0]) / path);
}
export function createVwapEngine({
  config: input = {},
  initialCandles = [],
  state: checkpoint,
}: {
  config?: unknown;
  initialCandles?: readonly VwapCandle[];
  state?: EngineState;
} = {}) {
  const config: VwapReversionConfig = parseConfig(input);
  const step = intervalMs(config);
  const configKey = JSON.stringify(config);
  if (
    checkpoint &&
    (checkpoint.version !== 1 || checkpoint.configKey !== configKey)
  )
    throw new Error("Incompatible VWAP checkpoint");
  const state: EngineState = checkpoint
    ? structuredClone(checkpoint)
    : {
        version: 1,
        configKey,
        day: null,
        complete: false,
        lastTimestamp: null,
        weight: 0,
        mean: 0,
        m2: 0,
        volumeBars: 0,
        closes: [],
        pending: null,
        samples: [],
        lastResult: null,
      };
  const next = (candle: VwapCandle): EngineResult => {
    const t = candle.timestamp;
    if (!Number.isSafeInteger(t) || t < 0 || t % step !== 0)
      throw new Error(
        "VWAP requires aligned UTC candle-open timestamps in milliseconds",
      );
    if (state.lastTimestamp === t) return structuredClone(state.lastResult!);
    if (state.lastTimestamp != null && t < state.lastTimestamp)
      throw new Error("VWAP candles must be chronological");
    const day = utcDay(t);
    if (day !== state.day) {
      state.day = day;
      state.complete = t === day;
      state.weight = 0;
      state.mean = 0;
      state.m2 = 0;
      state.volumeBars = 0;
      state.closes = [];
      state.pending = null;
      state.samples = [];
    } else if (
      state.lastTimestamp != null &&
      t - state.lastTimestamp !== step
    ) {
      state.complete = false;
      state.pending = null;
      state.closes = [];
    }
    state.lastTimestamp = t;
    const result: EngineResult = {
      timestamp: t,
      reason: "WAIT_DATA",
      sample: null,
      signal: null,
    };
    const done = () => {
      state.lastResult = result;
      return structuredClone(result);
    };
    const { open, high, low, close, volume } = candle;
    if (
      ![open, high, low, close, volume].every(Number.isFinite) ||
      Math.min(open, high, low, close) <= 0 ||
      volume < 0 ||
      low > Math.min(open, close) ||
      high < Math.max(open, close) ||
      low > high
    ) {
      state.complete = false;
      state.pending = null;
      state.closes = [];
      result.reason = "INVALID_CANDLE";
      return done();
    }
    if (volume === 0) {
      state.pending = null;
      state.closes = [];
      result.reason = "ZERO_VOLUME";
      return done();
    }
    // Weighted Welford: population M2, avoiding E[p²] - E[p]² cancellation.
    const price = high / 3 + low / 3 + close / 3;
    const weight = state.weight + volume;
    const delta = price - state.mean;
    const mean = state.mean + delta * (volume / weight);
    const m2 = state.m2 + volume * delta * (price - mean);
    const tolerance = 64 * Number.EPSILON * Math.max(1, mean * mean);
    const variance = m2 / weight;
    if (
      ![weight, mean, m2, variance].every(Number.isFinite) ||
      variance < -tolerance
    ) {
      state.complete = false;
      state.pending = null;
      state.closes = [];
      result.reason = "NUMERIC_ERROR";
      return done();
    }
    state.weight = weight;
    state.mean = mean;
    state.m2 = Math.max(0, m2);
    state.volumeBars++;
    state.closes.push(close);
    state.closes = state.closes.slice(-(config.VWAP_ER_PERIOD + 1));
    const er =
      state.closes.length === config.VWAP_ER_PERIOD + 1
        ? efficiencyRatio(state.closes)
        : null;
    const sigma = Math.sqrt(Math.max(0, variance));
    const upper = mean + config.VWAP_BAND_MULT * sigma;
    const lower = mean - config.VWAP_BAND_MULT * sigma;
    if (![upper, lower].every(Number.isFinite)) {
      state.complete = false;
      state.pending = null;
      state.closes = [];
      result.reason = "NUMERIC_ERROR";
      return done();
    }
    const allowed =
      state.complete &&
      state.volumeBars >= config.VWAP_MIN_VOLUME_BARS &&
      er != null &&
      er <= config.VWAP_MAX_ER &&
      sigma > 32 * Number.EPSILON * Math.max(1, Math.abs(mean)) &&
      Number.isFinite(upper) &&
      lower > 0 &&
      utcDay(t + step) === day;
    const sample: VwapSample = {
      timestamp: t,
      vwap: mean,
      upper,
      lower,
      er,
      allowed,
    };
    result.sample = sample;
    state.samples.push(sample);
    state.samples = state.samples.slice(-Math.round(DAY_MS / step));
    if (!allowed) {
      state.pending = null;
      result.reason = !state.complete
        ? "INCOMPLETE_SESSION"
        : "REGIME_OR_WARMUP";
      return done();
    }
    result.reason = "WAIT_EXCURSION";
    let pending = state.pending;
    if (
      pending &&
      t - pending.timestamp > config.VWAP_MAX_EXCURSION_BARS * step
    ) {
      pending = null;
      state.pending = null;
    }
    if (pending) {
      pending.extreme =
        pending.direction === "LONG"
          ? Math.min(pending.extreme, low)
          : Math.max(pending.extreme, high);
      const inside = close > lower && close < upper;
      const returning =
        pending.direction === "LONG" ? close < mean : close > mean;
      if (inside) {
        state.pending = null;
        result.reason = "RETURN_PAST_TARGET";
        if (returning) {
          const buffer = (close * config.VWAP_STOP_BUFFER_PCT) / 100;
          result.signal = {
            ...pending,
            entryTimestamp: t,
            target: mean,
            stop:
              pending.direction === "LONG"
                ? pending.extreme - buffer
                : pending.extreme + buffer,
          };
          result.reason = "CONFIRMED_RETURN";
        }
        return done();
      }
    }
    const direction = close < lower ? "LONG" : close > upper ? "SHORT" : null;
    if (
      direction &&
      (!state.pending || state.pending.direction !== direction)
    ) {
      state.pending = {
        direction,
        timestamp: t,
        extreme: direction === "LONG" ? low : high,
      };
    }
    return done();
  };
  if (checkpoint && initialCandles.length)
    throw new Error("Use checkpoint or initialCandles, not both");
  for (const candle of initialCandles) next(candle);
  return { next, getState: (): EngineState => structuredClone(state) };
}
