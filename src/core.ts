import { buildTradeEconomics } from "@tradejs/strategy-kit/risk";
import { isOpenPosition } from "@tradejs/strategy-kit/positions";
import type { CreateStrategyCore, Direction } from "@tradejs/types";
import { intervalMs, parseConfig, type VwapReversionConfig } from "./config.js";
import { createVwapEngine, utcDay, type EngineState } from "./engine.js";
import { buildVwapFigures } from "./figures.js";

interface Lifecycle {
  direction: Direction;
  signalTimestamp: number;
}
interface CoreState {
  engine: EngineState | null;
  active: Lifecycle | null;
  cooldownUntil: number;
  lastDecisionTimestamp: number | null;
}
export const createVwapReversionCore: CreateStrategyCore<
  VwapReversionConfig
> = ({ config: input, data, strategyApi }) => {
  const config = parseConfig(input);
  const step = intervalMs(config);
  const controller = strategyApi.createStateController<CoreState>(
    "vwap-reversion-v1",
    () => ({
      engine: null,
      active: null,
      cooldownUntil: -1,
      lastDecisionTimestamp: null,
    }),
    { configKey: JSON.stringify(config) },
  );
  return async (candle) => {
    const { timestamp, currentPrice } =
      await strategyApi.getDecisionPriceContext();
    if (timestamp !== candle.timestamp || currentPrice !== candle.close)
      throw new Error(
        "VWAP decision context must match the current closed candle",
      );
    const state = controller.get();
    if (
      state.lastDecisionTimestamp != null &&
      timestamp <= state.lastDecisionTimestamp
    )
      return strategyApi.skip("VWAP_ALREADY_EVALUATED");
    // Seed lazily: data may already include the current candle or future rows.
    const engine = state.engine
      ? createVwapEngine({ config, state: state.engine })
      : createVwapEngine({
          config,
          initialCandles: data.filter((bar) => bar.timestamp < timestamp),
        });
    const previousTimestamp = state.engine?.lastTimestamp;
    const result = engine.next(candle);
    state.engine = engine.getState();
    state.lastDecisionTimestamp = timestamp;
    const position = await strategyApi.getCurrentPosition();
    if (isOpenPosition(position)) {
      state.engine.pending = null;
      if (!state.active || state.active.direction !== position.direction)
        return strategyApi.exit({
          direction: position.direction,
          code: "VWAP_UNRESTORED_POSITION",
        });
      const dayChanged =
        utcDay(timestamp) !== utcDay(state.active.signalTimestamp) ||
        utcDay(timestamp + step) !== utcDay(timestamp);
      const expired =
        timestamp - state.active.signalTimestamp >=
        config.VWAP_MAX_HOLD_BARS * step;
      const gap =
        previousTimestamp != null && timestamp - previousTimestamp !== step;
      if (
        dayChanged ||
        expired ||
        gap ||
        result.reason === "INVALID_CANDLE" ||
        result.reason === "NUMERIC_ERROR"
      ) {
        return strategyApi.exit({
          direction: position.direction,
          code: dayChanged
            ? "VWAP_SESSION_END"
            : expired
              ? "VWAP_TIME_EXIT"
              : "VWAP_DATA_EXIT",
        });
      }
      return strategyApi.skip("VWAP_POSITION_EXISTS");
    }
    if (state.active) {
      // No API for exit reason. Cool down conservatively even after an unfilled
      // entry, or an entry stopped between two successive observations.
      state.cooldownUntil = timestamp + config.VWAP_COOLDOWN_BARS * step;
      state.active = null;
    }
    if (timestamp <= state.cooldownUntil) {
      state.engine.pending = null;
      return strategyApi.skip("VWAP_COOLDOWN");
    }
    const signal = result.signal;
    if (!signal) return strategyApi.skip(`VWAP_${result.reason}`);
    const side = signal.direction === "LONG" ? 1 : -1;
    if (
      signal.stop <= 0 ||
      side * (currentPrice - signal.stop) <= 0 ||
      side * (signal.target - currentPrice) <= 0
    )
      return strategyApi.skip("VWAP_INVALID_GEOMETRY");
    const economics = buildTradeEconomics({
      entryPrice: currentPrice,
      stopLossPrice: signal.stop,
      takeProfitPrice: signal.target,
      feeRate: config.RISK_FEE_RATE,
      slippageBps: config.RISK_SLIPPAGE_BPS + config.RISK_MARKET_IMPACT_BPS,
    });
    const qty = config.MAX_LOSS_VALUE / economics.lossPerUnit;
    if (
      !Number.isFinite(qty) ||
      qty <= 0 ||
      economics.netRiskRatio < config.VWAP_MIN_RISK_RATIO
    )
      return strategyApi.skip("VWAP_MIN_RISK_RATIO");
    const decision = await strategyApi.entry({
      code: "VWAP_CONFIRMED_RETURN",
      direction: signal.direction,
      signalId: `vwap-${signal.direction}-${signal.timestamp}-${timestamp}`,
      orderPlan: {
        qty,
        stopLossPrice: signal.stop,
        takeProfits: [{ price: signal.target, rate: 1 }],
        positionIntent: "open",
      },
      figures: buildVwapFigures(state.engine.samples, signal, currentPrice),
      additionalIndicators: {
        vwap: result.sample?.vwap,
        vwapER: result.sample?.er,
        vwapNetRiskRatio: economics.netRiskRatio,
      },
    });
    state.active = {
      direction: signal.direction,
      signalTimestamp: timestamp,
    };
    return decision;
  };
};
