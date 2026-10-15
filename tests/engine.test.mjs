import assert from "node:assert/strict";
import test from "node:test";
import { createVwapEngine, efficiencyRatio, DAY_MS } from "../dist/index.js";
import { bar, setup, START, STEP } from "./helpers.mjs";
const near = (actual, expected, tolerance = 1e-10) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} != ${expected}`,
  );

test("hand example uses typical price and population volume-weighted variance", () => {
  const e = createVwapEngine();
  e.next({ ...bar(0), high: 12, low: 8, open: 10, close: 10, volume: 1 });
  const result = e.next({
    ...bar(1),
    high: 16,
    low: 12,
    open: 14,
    close: 14,
    volume: 3,
  });
  near(result.sample.vwap, 13);
  near(e.getState().m2 / e.getState().weight, 3);
  near(result.sample.upper, 13 + 2 * Math.sqrt(3));
  near(result.sample.lower, 13 - 2 * Math.sqrt(3));
});
test("ER measures direction and defines a constant-price window as zero", () => {
  assert.equal(efficiencyRatio([1, 2, 3]), 1);
  assert.equal(efficiencyRatio([1, 2, 1]), 0);
  assert.equal(efficiencyRatio([1, 1, 1]), 0);
  assert.equal(efficiencyRatio([1]), null);
});
for (const side of ["LONG", "SHORT"]) {
  test(`${side}: outside close arms, later inside close confirms`, () => {
    const rows = setup(side);
    const e = createVwapEngine({ initialCandles: rows.slice(0, -2) });
    assert.equal(e.next(rows.at(-2)).signal, null);
    assert.equal(e.getState().pending.direction, side);
    const result = e.next(rows.at(-1));
    assert.equal(result.signal.direction, side);
    assert.equal(result.signal.timestamp, rows.at(-2).timestamp);
    assert.equal(result.signal.target, result.sample.vwap);
    assert.equal(result.sample.allowed, true);
    assert.equal(e.getState().pending, null);
  });
}
test("one wick touch or a close exactly on the band cannot arm an entry", () => {
  const rows = setup();
  const e = createVwapEngine({ initialCandles: rows.slice(0, 32) });
  assert.equal(e.next({ ...bar(32, 100, 1), low: 97 }).signal, null);
  assert.equal(e.getState().pending, null);
  const exact = createVwapEngine({
    config: {
      VWAP_BAND_MULT: 1,
      VWAP_ER_PERIOD: 1,
      VWAP_MIN_VOLUME_BARS: 2,
      VWAP_MAX_ER: 1,
    },
  });
  exact.next(bar(0, 99));
  const r = exact.next(bar(1, 101));
  assert.equal(r.sample.upper, 101);
  assert.equal(exact.getState().pending, null);
});
test("directional market is blocked and clears an armed excursion", () => {
  const rows = setup();
  const e = createVwapEngine({ initialCandles: rows.slice(0, -1) });
  assert.ok(e.getState().pending);
  let r;
  for (let i = 33; i < 52; i++) r = e.next(bar(i, 100 + i));
  assert.equal(r.sample.er, 1);
  assert.equal(r.sample.allowed, false);
  assert.equal(r.signal, null);
  assert.equal(e.getState().pending, null);
});
test("confirmation after the excursion deadline is discarded", () => {
  const rows = setup();
  const e = createVwapEngine({
    config: { VWAP_MAX_EXCURSION_BARS: 1 },
    initialCandles: rows.slice(0, -1),
  });
  assert.equal(e.next(bar(34, 98.2, 1)).signal, null); // gap also invalidates the session
  const continuous = createVwapEngine({
    config: { VWAP_MAX_EXCURSION_BARS: 1 },
    initialCandles: rows.slice(0, -1),
  });
  continuous.next(bar(33, 97.7, 1));
  assert.equal(continuous.next(bar(34, 98.2, 1)).signal, null);
});
test("warmup, zero variance and incomplete first session prohibit entries", () => {
  const e = createVwapEngine();
  for (let i = 0; i < 32; i++)
    assert.equal(e.next(bar(i)).sample.allowed, false);
  const partial = createVwapEngine({ initialCandles: setup().slice(1, -1) });
  assert.equal(partial.next(setup().at(-1)).reason, "INCOMPLETE_SESSION");
});
test("UTC midnight resets volume, variance, ER and pending on 15m and 1h", () => {
  for (const step of [STEP, 3_600_000]) {
    const e = createVwapEngine({
      config: { INTERVAL: step === STEP ? "15" : "60" },
    });
    const n = DAY_MS / step;
    for (let i = 0; i < n; i++) e.next(bar(i, i % 2 ? 99 : 101, 10, step));
    const result = e.next(bar(n, 123, 7, step));
    const state = e.getState();
    assert.equal(state.day, START + DAY_MS);
    assert.equal(state.complete, true);
    assert.equal(state.weight, 7);
    assert.equal(state.mean, 123);
    assert.equal(state.m2, 0);
    assert.deepEqual(state.closes, [123]);
    assert.equal(state.pending, null);
    assert.equal(result.sample.allowed, false);
  }
});
test("missing candles taint the whole day; next complete midnight recovers", () => {
  const e = createVwapEngine({ initialCandles: setup().slice(0, 32) });
  assert.equal(e.next(bar(33, 97.8, 1)).reason, "INCOMPLETE_SESSION");
  assert.equal(e.next(bar(34, 98.2, 1)).signal, null);
  e.next(bar(96));
  assert.equal(e.getState().complete, true);
});
test("zero volume changes no weighted moments and cancels pending and ER", () => {
  const e = createVwapEngine({ initialCandles: setup().slice(0, -1) });
  const before = e.getState();
  assert.equal(e.next(bar(33, 98.2, 0)).reason, "ZERO_VOLUME");
  const after = e.getState();
  for (const key of ["mean", "m2", "weight", "volumeBars"])
    assert.equal(after[key], before[key]);
  assert.equal(after.pending, null);
  assert.deepEqual(after.closes, []);
  assert.equal(e.next(bar(34, 98.2)).signal, null);
});
test("invalid OHLCV and numerical overflow fail closed", () => {
  for (const patch of [
    { volume: -1 },
    { close: NaN },
    { high: 99, close: 100 },
    { low: 0 },
  ]) {
    const e = createVwapEngine();
    assert.equal(e.next({ ...bar(0), ...patch }).reason, "INVALID_CANDLE");
    assert.equal(e.getState().complete, false);
  }
  const e = createVwapEngine();
  e.next(bar(0, 100, Number.MAX_VALUE));
  assert.equal(e.next(bar(1, 101, Number.MAX_VALUE)).reason, "NUMERIC_ERROR");
});
test("weighted update agrees with independent two-pass formula at large price offsets", () => {
  const rows = Array.from({ length: 80 }, (_, i) =>
    bar(i, 1e9 + (i % 7) * 0.001, i + 1),
  );
  const e = createVwapEngine({ initialCandles: rows });
  const sum = rows.reduce((n, c) => n + c.volume, 0);
  const mean = rows.reduce((n, c) => n + c.close * c.volume, 0) / sum;
  const variance =
    rows.reduce((n, c) => n + c.volume * (c.close - mean) ** 2, 0) / sum;
  near(e.getState().mean, mean, 1e-6);
  near(e.getState().m2 / sum, variance, 1e-9);
});
test("continuous, historical replay and JSON checkpoint restore agree at every prefix", () => {
  const rows = setup();
  const continuous = createVwapEngine();
  for (let i = 0; i < rows.length; i++) {
    const result = continuous.next(rows[i]);
    const replay = createVwapEngine({ initialCandles: rows.slice(0, i) });
    assert.deepEqual(replay.next(rows[i]), result);
    assert.deepEqual(replay.getState(), continuous.getState());
    const restored = createVwapEngine({
      state: JSON.parse(JSON.stringify(continuous.getState())),
    });
    if (rows[i + 1])
      assert.deepEqual(
        restored.next(rows[i + 1]),
        createVwapEngine({ initialCandles: rows.slice(0, i + 1) }).next(
          rows[i + 1],
        ),
      );
  }
});
test("duplicate timestamps are idempotent; backward and misaligned timestamps fail", () => {
  const e = createVwapEngine();
  const r = e.next(bar(0));
  const before = e.getState();
  assert.deepEqual(e.next(bar(0, 999)), r);
  assert.deepEqual(e.getState(), before);
  e.next(bar(1));
  assert.throws(() => e.next(bar(0)), /chronological/);
  assert.throws(() => e.next({ ...bar(2), timestamp: START + 1 }), /aligned/);
  assert.throws(
    () =>
      createVwapEngine({ state: e.getState(), config: { VWAP_BAND_MULT: 3 } }),
    /checkpoint/,
  );
});
test("state and returned snapshots are bounded and detached", () => {
  const e = createVwapEngine();
  for (let i = 0; i < 2000; i++) e.next(bar(i, i % 2 ? 99 : 101));
  const state = e.getState();
  assert.ok(state.samples.length <= 96);
  assert.ok(state.closes.length <= 17);
  state.closes.push(-1);
  assert.notDeepEqual(state.closes, e.getState().closes);
});
test("1h confirms a return with a complete UTC session and correct bar spacing", () => {
  const step = 3_600_000;
  const rows = [
    ...Array.from({ length: 18 }, (_, i) =>
      bar(i, i % 2 ? 101 : 99, 100, step),
    ),
    bar(18, 97.8, 1, step),
    bar(19, 98.2, 1, step),
  ];
  const e = createVwapEngine({
    config: { INTERVAL: "60" },
    initialCandles: rows.slice(0, -1),
  });
  assert.equal(e.next(rows.at(-1)).signal.direction, "LONG");
});

test("tiny negative variance is clamped; material negative variance fails closed", () => {
  const initial = createVwapEngine({ initialCandles: [bar(0)] }).getState();
  initial.m2 = -1e-12;
  const small = createVwapEngine({ state: initial });
  assert.equal(small.next(bar(1)).sample.vwap, 100);
  assert.equal(small.getState().m2, 0);
  initial.m2 = -100;
  assert.equal(
    createVwapEngine({ state: initial }).next(bar(1)).reason,
    "NUMERIC_ERROR",
  );
});

test("a return past VWAP consumes the setup without entry", () => {
  const e = createVwapEngine({ initialCandles: setup().slice(0, -1) });
  const result = e.next(bar(33, 100.5, 1));
  assert.equal(result.reason, "RETURN_PAST_TARGET");
  assert.equal(result.signal, null);
  assert.equal(e.getState().pending, null);
});

test("band overflow produces no non-finite chart data or JSON checkpoint values", () => {
  const e = createVwapEngine({ config: { VWAP_BAND_MULT: Number.MAX_VALUE } });
  e.next(bar(0, 90));
  const result = e.next(bar(1, 110));
  assert.equal(result.reason, "NUMERIC_ERROR");
  assert.equal(result.sample, null);
  assert.deepEqual(JSON.parse(JSON.stringify(e.getState())), e.getState());
});

test("optional price confirmation rejects re-entry caused only by band expansion", () => {
  const rows = setup().slice(0, -1);
  const confirmation = bar(33, 97.7, 500);
  const original = createVwapEngine({
    config: { VWAP_REQUIRE_PRICE_REVERSAL: false, VWAP_MAX_ER: 1 },
    initialCandles: rows,
  });
  assert.equal(original.next(confirmation).signal.direction, "LONG");
  const confirmed = createVwapEngine({
    config: { VWAP_REQUIRE_PRICE_REVERSAL: true, VWAP_MAX_ER: 1 },
    initialCandles: rows,
  });
  const restored = createVwapEngine({
    config: { VWAP_REQUIRE_PRICE_REVERSAL: true, VWAP_MAX_ER: 1 },
    state: JSON.parse(JSON.stringify(confirmed.getState())),
  });
  const result = confirmed.next(confirmation);
  assert.equal(result.signal, null);
  assert.equal(result.reason, "NO_PRICE_REVERSAL");
  assert.equal(confirmed.getState().pending, null);
  assert.deepEqual(restored.next(confirmation), result);
  for (const direction of ["LONG", "SHORT"]) {
    const rows = setup(direction);
    const engine = createVwapEngine({
      config: { VWAP_REQUIRE_PRICE_REVERSAL: true, VWAP_MAX_ER: 1 },
      initialCandles: rows.slice(0, -1),
    });
    assert.equal(engine.next(rows.at(-1)).signal.direction, direction);
  }
});

test("session entry cutoff preserves the requested full bars after candle-close entry", () => {
  const engine = createVwapEngine({
    config: { VWAP_MIN_SESSION_BARS_LEFT: 8 },
  });
  let result;
  for (let i = 0; i <= 87; i++) result = engine.next(bar(i, i % 2 ? 101 : 99));
  assert.equal(result.sample.allowed, true); // 21:45 candle closes at 22:00 UTC
  assert.equal(engine.next(bar(88, 99)).sample.allowed, false);
  assert.equal(engine.getState().pending, null);
});
