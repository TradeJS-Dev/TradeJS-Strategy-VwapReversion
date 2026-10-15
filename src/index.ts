import { defineStrategyPlugin } from "@tradejs/core/config";
import type { ValidatedStrategyRegistryEntry } from "@tradejs/strategy-kit/config";
import {
  STRATEGY_NAME,
  defaultConfig,
  parseConfig,
  type VwapReversionConfig,
} from "./config.js";
import { createVwapReversionCore } from "./core.js";

export * from "./config.js";
export * from "./engine.js";
export * from "./core.js";
export * from "./figures.js";
const entry: ValidatedStrategyRegistryEntry<VwapReversionConfig> = {
  defaults: defaultConfig,
  parseConfig,
  manifest: { name: STRATEGY_NAME },
  createCore: createVwapReversionCore,
};
export const strategyEntries = defineStrategyPlugin({
  strategyEntries: [entry],
}).strategyEntries;
export default defineStrategyPlugin({ strategyEntries });
