import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVwapGateFeatures,
  evaluateVwapGate,
  vwapReversionAiAdapter,
  parseConfig,
  defaultConfig,
} from "../dist/index.js";
const features = {
  efficiencyRatio: 0.07,
  netRiskRatio: 1.2,
  stopDistanceBps: 250,
};
test("rounded SHORT thresholds include exact boundaries and reject just outside", () => {
  assert.equal(evaluateVwapGate("SHORT", features).approvalAllowedNow, true);
  for (const changes of [
    { efficiencyRatio: 0.07 - 1e-12 },
    { stopDistanceBps: 250 + 1e-9 },
  ])
    assert.equal(
      evaluateVwapGate("SHORT", { ...features, ...changes }).approvalAllowedNow,
      false,
    );
  for (const changes of [
    { efficiencyRatio: 0.07 + 1e-12 },
    { stopDistanceBps: 250 - 1e-9 },
  ])
    assert.equal(
      evaluateVwapGate("SHORT", { ...features, ...changes })
        .deterministicQuality,
      5,
    );
});
test("missing, null, nonnumeric and nonfinite values fail closed", () => {
  for (const field of Object.keys(features))
    for (const value of [null, undefined, NaN, Infinity, "0.1"]) {
      const next = { ...features, [field]: value };
      // Public feature builder normalizes untrusted values before evaluation.
      const normalized = Object.fromEntries(
        Object.entries(next).map(([k, v]) => [
          k,
          typeof v === "number" && Number.isFinite(v) ? v : null,
        ]),
      );
      for (const direction of ["LONG", "SHORT"])
        assert.equal(
          evaluateVwapGate(direction, normalized).approvalAllowedNow,
          false,
        );
    }
  assert.equal(evaluateVwapGate("UNKNOWN", features).approvalAllowedNow, false);
});
test("LONG retains valid core setups; quality is binary rather than calibrated probability", () => {
  const decision = evaluateVwapGate("LONG", {
    ...features,
    efficiencyRatio: 0,
    stopDistanceBps: 500,
  });
  assert.equal(decision.approvalAllowedNow, true);
  assert.equal(decision.deterministicQuality, 5);
  assert.equal(
    evaluateVwapGate("SHORT", { ...features, stopDistanceBps: 500 })
      .deterministicQuality,
    1,
  );
});
test("features use only saved setup and requested prices, never outcome fields", () => {
  const prices = { currentPrice: 100, stopLossPrice: 102.5 };
  const a = buildVwapGateFeatures(
    { vwapER: 0.07, vwapNetRiskRatio: 1.2 },
    prices,
  );
  const b = buildVwapGateFeatures(
    {
      vwapER: 0.07,
      vwapNetRiskRatio: 1.2,
      tradeResult: { netProfit: 9999, exitPrice: 42 },
    },
    prices,
  );
  assert.deepEqual(a, b);
  assert.deepEqual(a, features);
  assert.equal(
    buildVwapGateFeatures({ vwapER: "0.07" }, prices).efficiencyRatio,
    null,
  );
  assert.equal(
    buildVwapGateFeatures({}, { currentPrice: 0, stopLossPrice: 10 })
      .stopDistanceBps,
    null,
  );
});
test("gate is disabled by default and explicitly maps to local gate mode", () => {
  assert.equal(defaultConfig.VWAP_AI_GATE_ENABLED, false);
  assert.equal(parseConfig({}).VWAP_AI_GATE_ENABLED, false);
  assert.throws(() => parseConfig({ VWAP_AI_GATE_ENABLED: "true" }));
  assert.deepEqual(
    vwapReversionAiAdapter.mapEntryRuntimeFromConfig({
      VWAP_AI_GATE_ENABLED: true,
    }),
    { enabled: true, mode: "gate", minQuality: 4 },
  );
});

test("adapter preserves source context and exposes explicit rejection reasons", () => {
  const basePayload = {
    signal: {
      direction: "SHORT",
      prices: { currentPrice: 100, stopLossPrice: 103 },
    },
    additionalIndicators: {
      vwapER: 0.01,
      vwapNetRiskRatio: 1.2,
      marker: "preserved",
    },
  };
  const payload = vwapReversionAiAdapter.buildPayload({
    basePayload,
    signal: {},
  });
  assert.equal(payload.additionalIndicators.marker, "preserved");
  const analysis = vwapReversionAiAdapter.postProcessLocalAnalysis({
    payload,
    signal: {},
    analysis: { direction: null, quality: 1 },
  });
  assert.equal(analysis.direction, null);
  assert.equal(
    analysis.rejectReason,
    "VWAP_SHORT_STOP_TOO_WIDE; VWAP_SHORT_RETURN_TOO_FLAT",
  );
  assert.equal(
    basePayload.additionalIndicators.vwapReversionGateContext,
    undefined,
  );
});
