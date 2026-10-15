import { buildEntryStopTargetFigures } from "@tradejs/strategy-kit/figures";
import type { StrategyEntryModelFigures } from "@tradejs/types";
import type { ReversionSignal, VwapSample } from "./engine.js";

export function buildVwapFigures(
  samples: readonly VwapSample[],
  signal: ReversionSignal,
  price: number,
): StrategyEntryModelFigures {
  const figures = buildEntryStopTargetFigures({
    idPrefix: "vwap",
    direction: signal.direction,
    entryTimestamp: signal.entryTimestamp,
    entryPrice: price,
    stopLossPrice: signal.stop,
    takeProfitPrice: signal.target,
    referenceTimestamp: signal.timestamp,
  });
  figures.lines!.push(
    ...(["vwap", "upper", "lower"] as const).map((key) => ({
      id: `vwap-${key}`,
      kind: `vwap_${key}`,
      points: samples.map((s) => ({ timestamp: s.timestamp, value: s[key] })),
      color: key === "vwap" ? "#eab308" : "#60a5fa",
      width: 1,
    })),
  );
  figures.points!.push(
    ...[true, false].map((allowed) => ({
      id: `vwap-regime-${allowed}`,
      kind: allowed ? "vwap_entries_allowed" : "vwap_entries_blocked",
      points: samples
        .filter((s) => s.allowed === allowed)
        .map((s) => ({ timestamp: s.timestamp, value: s.vwap })),
      color: allowed ? "#22c55e" : "#ef4444",
      radius: 2,
    })),
  );
  const last = samples.at(-1);
  figures.annotations = [
    {
      kind: "vwap_regime",
      point: { timestamp: signal.entryTimestamp, value: price },
      title: `VWAP ${signal.direction}: confirmed return`,
      items: [
        `ER=${last?.er?.toFixed(4) ?? "n/a"}; allowed=${last?.allowed}`,
        "Target and stop fixed at signal",
        "UTC session; OHLCV approximation",
      ],
    },
  ];
  return figures;
}
