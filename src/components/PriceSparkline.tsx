"use client";

import { useEffect, useMemo, useState } from "react";
import type { DisplayCurrency } from "@/lib/pricing";

type Props = {
  category: "pokemon" | "yugioh";
  cardId: string;
  market: "TCGplayer" | "Cardmarket" | "eBay" | "Amazon" | "CoolStuffInc";
  keyName: string;        // e.g. "normal", "trend_price"
  days?: number;          // default 30
  display: DisplayCurrency;
  label?: string;
  className?: string;
};

type SeriesPoint = { t: string; native: number | null; display: number | null };
type Series = {
  id: string;
  market: string;
  key: string;
  nativeCurrency: "USD" | "EUR";
  points: SeriesPoint[];
};
type ApiJson = {
  series: Series[];
};

export default function PriceSparkline({
  category,
  cardId,
  market,
  keyName,
  days = 30,
  display,
  label,
  className,
}: Props) {
  const [data, setData] = useState<SeriesPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const q = new URLSearchParams({
      days: String(days),
      display,
      markets: market.toLowerCase(), // matches route filter
      keys: keyName,
    });

    fetch(`/api/prices/history/${category}/${encodeURIComponent(cardId)}?${q.toString()}`, {
      cache: "no-store",
      signal: ac.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j: ApiJson = await r.json();
        // find our exact series
        const s = j.series.find(
          (s) => s.market.toLowerCase() === market.toLowerCase() && s.key === keyName
        );
        setData(s?.points ?? []);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setErr(e instanceof Error ? e.message : "Failed to load");
      });

    return () => ac.abort();
  }, [category, cardId, market, keyName, days, display]);

  // choose values to plot (display if present else native)
  const values = useMemo(() => {
    if (!data) return [];
    return data
      .map((p) => (p.display ?? p.native))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  }, [data]);

  // simple inline SVG sparkline
  const svg = useMemo(() => {
    const W = 320;
    const H = 56;
    if (!values.length) {
      return (
        <div className="h-14 grid place-items-center text-xs text-white/60">
          No data yet
        </div>
      );
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const stepX = values.length > 1 ? W / (values.length - 1) : W;

    const pts = values.map((v, i) => {
      const x = i * stepX;
      const y = H - ((v - min) / span) * H;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });

    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="56" preserveAspectRatio="none">
        {/* baseline */}
        <line x1="0" y1={H} x2={W} y2={H} stroke="currentColor" opacity="0.2" />
        {/* area */}
        <polyline
          points={`0,${H} ${pts.join(" ")} ${W},${H}`}
          fill="currentColor"
          opacity="0.12"
        />
        {/* line */}
        <polyline
          points={pts.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.9"
        />
      </svg>
    );
  }, [values]);

  return (
    <div
      className={
        className ??
        "rounded-lg border border-white/10 bg-white/5 p-3 text-white backdrop-blur-sm"
      }
    >
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs font-medium text-white/80">
          {label ?? `${market} • ${keyName}`}
        </div>
        {err ? (
          <span className="text-[10px] text-red-300/80">error: {err}</span>
        ) : null}
      </div>
      {svg}
      {/* mini stats */}
      {values.length ? (
        <div className="mt-1 grid grid-cols-3 text-[11px] text-white/70">
          <div>Start: <span className="text-white">{values[0].toFixed(2)}</span></div>
          <div>End: <span className="text-white">{values[values.length - 1].toFixed(2)}</span></div>
          <div>
            Δ:{" "}
            <span className={`text-white ${values[values.length - 1] - values[0] >= 0 ? "" : ""}`}>
              {(values[values.length - 1] - values[0]).toFixed(2)}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
