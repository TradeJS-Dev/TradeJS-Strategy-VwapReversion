import type { StrategyAiAdapter } from "@tradejs/types";
import { parseConfig } from "../config.js";

export const VWAP_SHORT_MAX_STOP_DISTANCE_BPS = 250;
export const VWAP_SHORT_MIN_EFFICIENCY_RATIO = 0.07;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export interface VwapGateFeatures {
  efficiencyRatio: number | null;
  netRiskRatio: number | null;
  stopDistanceBps: number | null;
}
/** Only closed-signal setup values and requested prices, never fills or outcomes. */
export const buildVwapGateFeatures = (
  additional: unknown,
  prices?: unknown,
): VwapGateFeatures => {
  const saved = record(additional),
    plan = record(prices);
  const current = finite(plan.currentPrice),
    stop = finite(plan.stopLossPrice);
  return {
    efficiencyRatio: finite(saved.vwapER),
    netRiskRatio: finite(saved.vwapNetRiskRatio),
    stopDistanceBps:
      current !== null && current > 0 && stop !== null && stop > 0
        ? (Math.abs(current - stop) / current) * 10000
        : null,
  };
};
export const evaluateVwapGate = (
  direction: unknown,
  features: VwapGateFeatures,
) => {
  const {
    efficiencyRatio: er,
    netRiskRatio: rr,
    stopDistanceBps: stop,
  } = features;
  const reasons: string[] = [];
  if (
    (direction !== "LONG" && direction !== "SHORT") ||
    er === null ||
    !Number.isFinite(er) ||
    er < 0 ||
    er > 1 ||
    rr === null ||
    !Number.isFinite(rr) ||
    rr <= 0 ||
    stop === null ||
    !Number.isFinite(stop) ||
    stop <= 0
  ) {
    reasons.push("VWAP_GATE_INVALID_SETUP");
  } else if (direction === "SHORT") {
    if (stop > VWAP_SHORT_MAX_STOP_DISTANCE_BPS)
      reasons.push("VWAP_SHORT_STOP_TOO_WIDE");
    if (er < VWAP_SHORT_MIN_EFFICIENCY_RATIO)
      reasons.push("VWAP_SHORT_RETURN_TOO_FLAT");
  }
  return {
    approvalAllowedNow: reasons.length === 0,
    deterministicQuality: reasons.length === 0 ? 5 : 1,
    structuralHardBlockReasons: reasons,
    approvalBlockReasons: reasons,
    profile: "vwap-gate-research-20261016",
  };
};
/** Opt-in only. Historical support is insufficient for a production-readiness claim. */
export const vwapReversionAiAdapter: StrategyAiAdapter = {
  mapEntryRuntimeFromConfig: (input) => ({
    enabled: parseConfig(input).VWAP_AI_GATE_ENABLED,
    mode: "gate",
    minQuality: 4,
  }),
  postProcessLocalAnalysis: ({ payload, analysis }) => {
    const context = record(
      record(payload.additionalIndicators).vwapReversionGateContext,
    );
    const reasons = Array.isArray(context.approvalBlockReasons)
      ? context.approvalBlockReasons.filter(
          (reason): reason is string => typeof reason === "string",
        )
      : [];
    return {
      ...analysis,
      qualityReason: reasons.length
        ? reasons.join("; ")
        : "VWAP_RESEARCH_GATE_APPROVED",
      rejectReason: reasons.length ? reasons.join("; ") : null,
    };
  },
  buildPayload: ({ basePayload }) => {
    const features = buildVwapGateFeatures(
      basePayload.additionalIndicators,
      basePayload.signal.prices,
    );
    return {
      ...basePayload,
      additionalIndicators: {
        ...record(basePayload.additionalIndicators),
        vwapReversionGateFeatures: features,
        vwapReversionGateContext: evaluateVwapGate(
          basePayload.signal.direction,
          features,
        ),
      },
    };
  },
};
