import assert from "node:assert/strict";
import test from "node:test";
import { createVwapEngine, parseConfig } from "../dist/index.js";
import { bar, setup, harness, enter } from "./helpers.mjs";

test("research options are neutral by default and strictly bounded", () => {
  assert.equal(parseConfig({}).VWAP_MAX_COST_SHARE, 0);
  assert.equal(parseConfig({}).VWAP_RETURN_BAND_MULT, 0);
  for (const field of ["VWAP_MAX_COST_SHARE", "VWAP_RETURN_BAND_MULT"]) {
    for (const value of [-1, NaN, Infinity, "0.1", null])
      assert.throws(() => parseConfig({ [field]: value }));
  }
  assert.throws(() => parseConfig({ VWAP_MAX_COST_SHARE: 1.01 }));
  assert.throws(() => parseConfig({ VWAP_RETURN_BAND_MULT: 2.01 }));
  assert.equal(
    parseConfig({ VWAP_RETURN_BAND_MULT: 2 }).VWAP_RETURN_BAND_MULT,
    2,
  );
});
for (const side of ["LONG", "SHORT"]) {
  const price = (long) => (side === "LONG" ? long : 200 - long);
  test(`${side}: shallow return retains age/extreme; deep close confirms and restores identically`, () => {
    const config = { VWAP_RETURN_BAND_MULT: 1.5, VWAP_MAX_ER: 1 };
    const rows = setup(side);
    const engine = createVwapEngine({
      config,
      initialCandles: rows.slice(0, -1),
    });
    const armed = engine.getState().pending;
    assert.equal(engine.next(rows.at(-1)).reason, "WAIT_DEEP_RETURN");
    assert.deepEqual(engine.getState().pending, armed);
    const restored = createVwapEngine({
      config,
      state: JSON.parse(JSON.stringify(engine.getState())),
    });
    const deep = bar(34, price(98.6), 1);
    const result = engine.next(deep);
    assert.equal(result.signal.direction, side);
    assert.equal(result.signal.timestamp, armed.timestamp);
    assert.equal(result.signal.extreme, armed.extreme);
    assert.deepEqual(restored.next(deep), result);
    assert.equal(engine.getState().pending, null);
  });
  test(`${side}: shallow returns never extend expiry`, () => {
    const config = {
      VWAP_RETURN_BAND_MULT: 1.5,
      VWAP_MAX_EXCURSION_BARS: 1,
      VWAP_MAX_ER: 1,
    };
    const engine = createVwapEngine({
      config,
      initialCandles: setup(side).slice(0, -1),
    });
    assert.equal(
      engine.next(bar(33, price(98.2), 1)).reason,
      "WAIT_DEEP_RETURN",
    );
    assert.equal(engine.next(bar(34, price(98.6), 1)).signal, null);
    assert.equal(engine.getState().pending, null);
  });
  test(`${side}: shallow pending is cancelled by zero volume, gap or UTC reset`, () => {
    for (const obstacle of [
      bar(34, price(98.3), 0),
      bar(35, price(98.6), 1),
      bar(96),
    ]) {
      const engine = createVwapEngine({
        config: { VWAP_RETURN_BAND_MULT: 1.5, VWAP_MAX_ER: 1 },
        initialCandles: setup(side),
      });
      assert.ok(engine.getState().pending);
      assert.equal(engine.next(obstacle).signal, null);
      assert.equal(engine.getState().pending, null);
    }
  });
  test(`${side}: cost-share threshold includes entry/target costs and is inclusive`, async () => {
    const original = await enter(harness(), side);
    assert.equal(original.kind, "entry");
    const entry = original.entryContext.prices.currentPrice;
    const target = original.orderPlan.takeProfits[0].price;
    const share =
      ((0.001 + 2 / 10000) * (entry + target)) / Math.abs(target - entry);
    assert.equal(
      (await enter(harness({ VWAP_MAX_COST_SHARE: share }), side)).kind,
      "entry",
    );
    const h = harness({ VWAP_MAX_COST_SHARE: share * (1 - 1e-8) });
    assert.equal((await enter(h, side)).code, "VWAP_COST_SHARE");
    assert.notEqual((await h.run(bar(34))).code, "VWAP_COOLDOWN");
    const future = [...setup(side), bar(34, 2000), bar(35, 0.01)];
    const seeded = harness({ VWAP_MAX_COST_SHARE: share }, { history: future });
    assert.deepEqual(await seeded.run(setup(side).at(-1)), original);
    const costly = harness({
      VWAP_MAX_COST_SHARE: share,
      RISK_MARKET_IMPACT_BPS: 1,
    });
    assert.equal((await enter(costly, side)).code, "VWAP_COST_SHARE");
  });
}
test("deep confirmation still requires price reversal and session permission", () => {
  const config = { VWAP_RETURN_BAND_MULT: 1.5, VWAP_MAX_ER: 1 };
  const e = createVwapEngine({ config, initialCandles: setup().slice(0, -1) });
  assert.equal(e.next(bar(33, 97.7, 5000)).reason, "NO_PRICE_REVERSAL");
  const cutoff = createVwapEngine({
    config: { ...config, VWAP_MIN_SESSION_BARS_LEFT: 64 },
    initialCandles: setup().slice(0, 32),
  });
  assert.equal(cutoff.next(bar(32, 97.8, 1)).signal, null);
  assert.equal(cutoff.getState().pending, null);
});

for (const side of ["LONG", "SHORT"]) {
  test(`${side}: jumping past VWAP outside inner consumes original pending`, () => {
    const config = { VWAP_RETURN_BAND_MULT: 1.5, VWAP_MAX_ER: 1 };
    const engine = createVwapEngine({
      config,
      initialCandles: setup(side).slice(0, -1),
    });
    const restored = createVwapEngine({
      config,
      state: JSON.parse(JSON.stringify(engine.getState())),
    });
    const leap = bar(33, side === "LONG" ? 101.8 : 98.2, 1);
    const result = engine.next(leap);
    assert.equal(result.reason, "RETURN_PAST_TARGET");
    assert.equal(result.signal, null);
    assert.equal(engine.getState().pending, null);
    assert.deepEqual(restored.next(leap), result);
    assert.equal(
      engine.next(bar(34, side === "LONG" ? 98.2 : 101.8, 1)).signal,
      null,
    );
    assert.equal(
      engine.next(bar(35, side === "LONG" ? 98.6 : 101.4, 1)).signal,
      null,
    );
  });
}
