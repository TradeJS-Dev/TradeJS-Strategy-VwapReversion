import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import plugin, {
  strategyEntries,
  defaultConfig,
  parseConfig,
  STRATEGY_NAME,
} from "../dist/index.js";
import { buildTradeEconomics } from "@tradejs/strategy-kit/risk";
import { bar, setup, harness, enter, positionFrom, STEP } from "./helpers.mjs";

test("package exports ESM/CJS plugin and strict parser", () => {
  assert.equal(STRATEGY_NAME, "VwapReversion");
  assert.equal(strategyEntries.length, 1);
  assert.equal(strategyEntries[0].manifest.name, STRATEGY_NAME);
  assert.deepEqual(parseConfig({}), defaultConfig);
  assert.deepEqual(plugin.strategyEntries, strategyEntries);
  assert.equal(
    createRequire(import.meta.url)("../dist/index.cjs").STRATEGY_NAME,
    STRATEGY_NAME,
  );
  for (const input of [
    { VWAP_BNAD_MULT: 2 },
    { VWAP_MAX_ER: NaN },
    { MAX_LOSS_VALUE: "10" },
    { VWAP_ER_PERIOD: 1.5 },
    { INTERVAL: "1h" },
    { VWAP_MIN_RISK_RATIO: 0 },
    { RISK_FEE_RATE: -1 },
    { VWAP_MAX_ER: 1.1 },
    { VWAP_STOP_BUFFER_PCT: 100 },
    { VWAP_ER_PERIOD: 23, INTERVAL: "60" },
    { BACKTEST_ENTRY_DELAY_BARS: 1 },
    { BACKTEST_PRICE_MODE: "open" },
    { AI_GATE: {} },
  ])
    assert.throws(() => parseConfig(input));
});
for (const side of ["LONG", "SHORT"]) {
  test(`${side} core builds real StrategyAPI entry with fixed stop, VWAP target and cost-aware risk`, async () => {
    const h = harness();
    const decision = await enter(h, side);
    assert.equal(decision.kind, "entry");
    assert.equal(decision.entryContext.direction, side);
    assert.equal(decision.entryContext.timestamp, setup().at(-1).timestamp);
    assert.equal(decision.orderPlan.positionIntent, "open");
    assert.equal(decision.orderPlan.takeProfits[0].rate, 1);
    const economics = buildTradeEconomics({
      entryPrice: decision.entryContext.prices.currentPrice,
      stopLossPrice: decision.orderPlan.stopLossPrice,
      takeProfitPrice: decision.orderPlan.takeProfits[0].price,
      feeRate: defaultConfig.RISK_FEE_RATE,
      slippageBps: defaultConfig.RISK_SLIPPAGE_BPS,
    });
    assert.ok(economics.netRiskRatio >= defaultConfig.VWAP_MIN_RISK_RATIO);
    assert.ok(
      Math.abs(decision.orderPlan.qty * economics.lossPerUnit - 10) < 1e-10,
    );
    const figures = decision.signal.figures;
    for (const kind of [
      "vwap_vwap",
      "vwap_lower",
      "vwap_upper",
      "vwap_stop",
      "vwap_target",
    ])
      assert.ok(figures.lines.some((line) => line.kind === kind));
    for (const kind of [
      "vwap_entries_allowed",
      "vwap_entries_blocked",
      "vwap_entry",
    ])
      assert.ok(figures.points.some((points) => points.kind === kind));
    assert.ok(figures.annotations[0].items[0].includes("allowed=true"));
    assert.ok(
      figures.lines
        .flatMap((line) => line.points)
        .every((p) => p.timestamp <= decision.entryContext.timestamp),
    );
    h.setPosition(positionFrom(decision));
    assert.equal((await h.run(bar(34, 105))).code, "VWAP_POSITION_EXISTS");
    assert.equal((await h.run(bar(34, 105))).code, "VWAP_ALREADY_EVALUATED");
    assert.equal((await h.run(bar(49, 100))).code, "VWAP_TIME_EXIT");
  });
}
test("minimum reward/risk includes fees and rejects entry without lifecycle mutation", async () => {
  const h = harness({ RISK_FEE_RATE: 0.1 });
  assert.equal((await enter(h)).code, "VWAP_MIN_RISK_RATIO");
  assert.equal((await h.run(bar(34))).code.startsWith("VWAP_COOLDOWN"), false);
});
test("exit uses real StrategyAPI current candle, never synthetic exit fields", async () => {
  const h = harness({ VWAP_MAX_HOLD_BARS: 2 });
  h.setPosition(positionFrom(await enter(h)));
  await h.run(bar(34, 99));
  const decision = await h.run(bar(35, 99.3));
  assert.equal(decision.kind, "exit");
  assert.equal(decision.code, "VWAP_TIME_EXIT");
  assert.deepEqual(decision.closePlan, {
    direction: "LONG",
    timestamp: bar(35).timestamp,
    price: 99.3,
  });
});
test("all observed closes, including stop and unfilled entry, start inclusive cooldown", async () => {
  for (const observed of [true, false]) {
    const h = harness();
    const d = await enter(h);
    assert.equal(d.kind, "entry");
    if (observed) {
      h.setPosition(positionFrom(d));
      await h.run(bar(34));
    }
    h.setPosition(null);
    const closedAt = observed ? 35 : 34;
    assert.equal((await h.run(bar(closedAt))).code, "VWAP_COOLDOWN");
    for (let i = 1; i <= 4; i++)
      assert.equal((await h.run(bar(closedAt + i))).code, "VWAP_COOLDOWN");
    assert.notEqual((await h.run(bar(closedAt + 5))).code, "VWAP_COOLDOWN");
  }
});
test("shared lifecycle restores across CRON wrappers and JSON store checkpoint", async () => {
  const h = harness({}, { env: "CRON" });
  const decision = await enter(h);
  const store = new Map(JSON.parse(JSON.stringify([...h.store])));
  const restored = harness({}, { env: "CRON", store, history: setup() });
  restored.setPosition(positionFrom(decision));
  assert.equal((await restored.run(bar(34))).code, "VWAP_POSITION_EXISTS");
  const exit = await restored.run(bar(49));
  assert.equal(exit.code, "VWAP_TIME_EXIT");
});
test("configurations sharing one replay key do not share state", async () => {
  const store = new Map();
  const first = harness({}, { store });
  assert.equal((await enter(first)).kind, "entry");
  const second = harness({ VWAP_MAX_ER: 0 }, { store });
  assert.notEqual((await enter(second)).kind, "entry");
  assert.equal(store.size, 2);
});
test("restart with an existing position and no lifecycle closes through StrategyAPI", async () => {
  const h = harness({}, { history: setup() });
  h.setPosition({ symbol: "TESTUSDT", price: 98, qty: 1, direction: "LONG" });
  assert.equal((await h.run(bar(34))).code, "VWAP_UNRESTORED_POSITION");
});
test("last candle of UTC day closes the position and never opens another", async () => {
  const h = harness();
  h.setPosition(positionFrom(await enter(h)));
  const d = await h.run(bar(95));
  assert.equal(d.kind, "exit");
  assert.equal(d.code, "VWAP_SESSION_END");
  h.setPosition(null);
  assert.equal((await h.run(bar(96))).kind, "skip");
});
test("gap while position exists forces a data exit", async () => {
  const h = harness();
  h.setPosition(positionFrom(await enter(h)));
  assert.equal((await h.run(bar(35))).code, "VWAP_DATA_EXIT");
});
test("core historical seeding excludes current and future candles", async () => {
  const rows = setup();
  const expected = await enter(harness());
  const polluted = harness(
    {},
    {
      history: [
        ...rows,
        ...Array.from({ length: 20 }, (_, i) => bar(34 + i, 1000 + i)),
      ],
    },
  );
  const actual = await polluted.run(rows.at(-1));
  assert.deepEqual(actual, expected);
});
test("JSON lifecycle restore retains cooldown", async () => {
  const first = harness();
  await enter(first);
  await first.run(bar(34));
  const restored = harness(
    {},
    { store: new Map(JSON.parse(JSON.stringify([...first.store]))) },
  );
  assert.equal((await restored.run(bar(35))).code, "VWAP_COOLDOWN");
});
test("1h core uses hour-based time limit and supports the standard payload", async () => {
  const step = 3_600_000;
  const rows = [
    ...Array.from({ length: 18 }, (_, i) =>
      bar(i, i % 2 ? 101 : 99, 100, step),
    ),
    bar(18, 97.8, 1, step),
    bar(19, 98.2, 1, step),
  ];
  const h = harness({ INTERVAL: "60", VWAP_MAX_HOLD_BARS: 2 });
  let d;
  for (const row of rows) d = await h.run(row);
  assert.equal(d.kind, "entry");
  assert.equal(d.entryContext.interval, "60");
  h.setPosition(positionFrom(d));
  assert.equal((await h.run(bar(20, 99, 100, step))).kind, "skip");
  assert.equal((await h.run(bar(21, 99, 100, step))).code, "VWAP_TIME_EXIT");
});

test("future backtest examples resolve to strict one-cell configs", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["backtest-grid.json", "backtest-grid-1h.json"]) {
    const grid = JSON.parse(
      await readFile(new URL(`../examples/${file}`, import.meta.url), "utf8"),
    );
    assert.ok(
      Object.values(grid).every(
        (values) => Array.isArray(values) && values.length === 1,
      ),
    );
    const resolved = Object.fromEntries(
      Object.entries(grid).map(([k, v]) => [k, v[0]]),
    );
    assert.deepEqual(parseConfig(resolved), resolved);
  }
});
