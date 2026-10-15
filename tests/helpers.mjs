import { createStrategyAPI } from "@tradejs/core/strategies";
import { createVwapReversionCore, parseConfig } from "../dist/index.js";
export const START = Date.parse("2026-10-01T00:00:00Z");
export const STEP = 900_000;
export function bar(index, close = 100, volume = 100, step = STEP) {
  return {
    timestamp: START + index * step,
    open: close,
    high: close,
    low: close,
    close,
    volume,
    turnover: close * volume,
    dt: new Date(START + index * step).toISOString(),
  };
}
export function setup(side = "LONG", step = STEP) {
  return [
    ...Array.from({ length: 32 }, (_, i) =>
      bar(
        i,
        side === "SHORT" ? (i % 2 ? 99 : 101) : i % 2 ? 101 : 99,
        100,
        step,
      ),
    ),
    bar(32, side === "LONG" ? 97.8 : 102.2, 1, step),
    bar(33, side === "LONG" ? 98.2 : 101.8, 1, step),
  ];
}
export function harness(
  input = {},
  { history, store = new Map(), env = "BACKTEST", key = "unit" } = {},
) {
  const config = parseConfig(input);
  const cachedData = [];
  let position = null;
  const strategyApi = createStrategyAPI({
    strategy: "VwapReversion",
    symbol: "TESTUSDT",
    interval: config.INTERVAL,
    env,
    cachedData,
    connector: { getPosition: async () => position },
    sharedReplayKey: key,
    getSharedReplayState: (id, create) => {
      if (!store.has(id)) store.set(id, create());
      return store.get(id);
    },
  });
  const core = createVwapReversionCore({
    config,
    data: history ?? cachedData,
    strategyApi,
  });
  return {
    store,
    strategyApi,
    setPosition: (next) => {
      position = next;
    },
    run: async (candle) => {
      if (cachedData.at(-1)?.timestamp !== candle.timestamp)
        cachedData.push(candle);
      return core(candle, candle);
    },
  };
}
export const positionFrom = (decision) => ({
  symbol: "TESTUSDT",
  qty: decision.orderPlan.qty,
  price: decision.entryContext.prices.currentPrice,
  direction: decision.entryContext.direction,
  slPrice: decision.orderPlan.stopLossPrice,
  tpPrice: decision.orderPlan.takeProfits[0].price,
});
export async function enter(h, side = "LONG") {
  let decision;
  for (const candle of setup(side)) decision = await h.run(candle);
  return decision;
}
