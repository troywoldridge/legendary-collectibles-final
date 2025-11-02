import "server-only";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import MarketPrices from "@/components/MarketPrices";
import { type DisplayCurrency, convert, formatMoney, getFx } from "@/lib/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
type CardCore = { id: string; name: string | null };

type TcgHist = {
  captured_at: string;
  currency: string | null;
  normal: string | null;
  holofoil: string | null;
  reverse_holofoil: string | null;
};
type CmHist = {
  captured_at: string;
  trend_price: string | null;
  average_sell_price: string | null;
  low_price: string | null;
  suggested_price: string | null;
};

function readDisplay(sp: SearchParams): DisplayCurrency {
  const a = (Array.isArray(sp?.display) ? sp.display[0] : sp?.display)?.toUpperCase();
  const b = (Array.isArray(sp?.currency) ? sp.currency[0] : sp?.currency)?.toUpperCase();
  const v = a || b;
  return v === "USD" || v === "EUR" ? (v as DisplayCurrency) : "NATIVE";
}
function withParam(baseHref: string, key: string, val: string) {
  const u = new URL(baseHref, "https://x/");
  u.searchParams.set(key, val);
  return u.pathname + (u.search ? u.search : "");
}

function asNum(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pickAtOrAfter<T extends { captured_at: string }>(rows: T[], sinceMs: number) {
  const t0 = Date.now() - sinceMs;
  for (const r of rows) {
    const t = Date.parse(r.captured_at);
    if (Number.isFinite(t) && t >= t0) return r;
  }
  return null;
}
function pctChange(from: number | null, to: number | null): string | null {
  if (from == null || to == null || from === 0) return null;
  const p = ((to - from) / from) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

async function resolveCardId(param: string): Promise<string | null> {
  const like = `%${param.replace(/-/g, " ").trim()}%`;
  const row =
    (
      await db.execute<{ id: string }>(sql`
        SELECT id FROM tcg_cards
        WHERE id = ${param}
           OR lower(id) = lower(${param})
           OR name ILIKE ${like}
        ORDER BY
          CASE WHEN id = ${param} THEN 0
               WHEN lower(id) = lower(${param}) THEN 1
               ELSE 2
          END, id ASC
        LIMIT 1
      `)
    ).rows?.[0] ?? null;
  return row?.id ?? null;
}

async function loadCore(cardId: string): Promise<CardCore | null> {
  return (
    (await db.execute<CardCore>(sql`SELECT id, name FROM tcg_cards WHERE id = ${cardId} LIMIT 1`))
      .rows?.[0] ?? null
  );
}

async function loadHistory(cardId: string, days = 90) {
  const tcg =
    (
      await db.execute<TcgHist>(sql`
        SELECT captured_at, currency, normal, holofoil, reverse_holofoil
        FROM tcg_card_prices_tcgplayer_history
        WHERE card_id = ${cardId} AND captured_at >= now() - INTERVAL '${days} days'
        ORDER BY captured_at ASC
      `)
    ).rows ?? [];

  const cm =
    (
      await db.execute<CmHist>(sql`
        SELECT captured_at, trend_price, average_sell_price, low_price, suggested_price
        FROM tcg_card_prices_cardmarket_history
        WHERE card_id = ${cardId} AND captured_at >= now() - INTERVAL '${days} days'
        ORDER BY captured_at ASC
      `)
    ).rows ?? [];

  return { tcg, cm };
}

export default async function PokemonCardPricesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id: rawId } = await params;
  const sp = await searchParams;
  const display = readDisplay(sp);

  const cardParam = decodeURIComponent(rawId ?? "").trim();
  const cardId = (await resolveCardId(cardParam)) ?? cardParam;

  const [core, hist] = await Promise.all([loadCore(cardId), loadHistory(cardId, 90)]);
  if (!core) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-bold text-white">Card not found</h1>
        <p className="text-white/70 text-sm break-all">Looked up: <code>{cardParam}</code></p>
        <div className="flex gap-4">
          <Link href="/categories/pokemon/sets" className="text-sky-300 hover:underline">← Back to sets</Link>
          <Link href="/categories" className="text-sky-300 hover:underline">← All categories</Link>
        </div>
      </section>
    );
  }

  const baseDetail = `/categories/pokemon/cards/${encodeURIComponent(core.id)}`;
  const baseHref = `${baseDetail}/prices`;

  // Build quick trend rows (latest value, 7d %, 30d %) for a few keys.
  // TCGplayer native = (tp.currency || 'USD'), Cardmarket native = EUR
  const fx = getFx();

  const tcgLatest = hist.tcg.at(-1) ?? null;
  const tcg7 = pickAtOrAfter(hist.tcg, 7 * 24 * 3600 * 1000);
  const tcg30 = pickAtOrAfter(hist.tcg, 30 * 24 * 3600 * 1000);
  const tcgCur = (tcgLatest?.currency?.toUpperCase() === "EUR" ? "EUR" : "USD") as "USD" | "EUR";

  function conv(n: number | null, src: "USD" | "EUR"): number | null {
    if (n == null) return null;
    if (display === "NATIVE") return n;
    const out = convert(n, src, display);
    return out == null ? n : out; // fallback to native if no FX provided
    }

  const metrics: Array<{
    label: string;
    latest: string | null;
    d7: string | null;
    d30: string | null;
  }> = [];

  // Helper to push a metric (TCGplayer key)
  function pushTcg(label: string, key: "normal" | "holofoil" | "reverse_holofoil") {
    const L = asNum(tcgLatest?.[key]);
    const A7 = asNum(tcg7?.[key]);
    const A30 = asNum(tcg30?.[key]);
    const Ld = conv(L, tcgCur);
    const A7d = conv(A7, tcgCur);
    const A30d = conv(A30, tcgCur);
    metrics.push({
      label: `TCGplayer ${label}`,
      latest: Ld == null ? null : formatMoney(Ld, display === "NATIVE" ? tcgCur : display),
      d7: pctChange(A7d, Ld),
      d30: pctChange(A30d, Ld),
    });
  }

  pushTcg("Normal", "normal");
  pushTcg("Holofoil", "holofoil");
  pushTcg("Reverse Holofoil", "reverse_holofoil");

  // Cardmarket (EUR native): show Trend + Average
  const cmLatest = hist.cm.at(-1) ?? null;
  const cm7 = pickAtOrAfter(hist.cm, 7 * 24 * 3600 * 1000);
  const cm30 = pickAtOrAfter(hist.cm, 30 * 24 * 3600 * 1000);

  function pushCm(label: string, key: "trend_price" | "average_sell_price") {
    const L = asNum(cmLatest?.[key]);
    const A7 = asNum(cm7?.[key]);
    const A30 = asNum(cm30?.[key]);
    const Ld = conv(L, "EUR");
    const A7d = conv(A7, "EUR");
    const A30d = conv(A30, "EUR");
    metrics.push({
      label: `Cardmarket ${label}`,
      latest: Ld == null ? null : formatMoney(Ld, display === "NATIVE" ? "EUR" : display),
      d7: pctChange(A7d, Ld),
      d30: pctChange(A30d, Ld),
    });
  }

  pushCm("Trend", "trend_price");
  pushCm("Average", "average_sell_price");

  return (
    <section className="space-y-6">
      {/* Header & toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Prices: {core.name ?? core.id}</h1>
          <div className="mt-1 text-sm text-white/80">Live market snapshot + recent trends</div>
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-md border border-white/20 bg-white/10 p-1 text-sm text-white">
            <span className="px-2">Display:</span>
            <Link href={withParam(baseHref, "display", "NATIVE")} className={`rounded px-2 py-1 ${display === "NATIVE" ? "bg-white/20" : "hover:bg-white/10"}`}>Native</Link>
            <Link href={withParam(baseHref, "display", "USD")} className={`ml-1 rounded px-2 py-1 ${display === "USD" ? "bg-white/20" : "hover:bg-white/10"}`}>USD</Link>
            <Link href={withParam(baseHref, "display", "EUR")} className={`ml-1 rounded px-2 py-1 ${display === "EUR" ? "bg-white/20" : "hover:bg-white/10"}`}>EUR</Link>
          </div>
          <Link href={baseDetail} className="text-sky-300 hover:underline">← Card detail</Link>
        </div>
      </div>

      {/* Live snapshot (shared) */}
      <MarketPrices category="pokemon" cardId={core.id} display={display} />

      {/* Simple trend table */}
      <div className="rounded-xl border border-white/15 bg-white/5 p-5 text-white/90">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Recent Trends</h2>
          <div className="text-xs text-white/60">
            {display === "NATIVE"
              ? "Native market currencies"
              : `Converted to ${display}${fx.usdToEur || fx.eurToUsd ? "" : " (no FX set; falling back where needed)"}`}
          </div>
        </div>

        {metrics.every(m => !m.latest) ? (
          <div className="rounded-md border border-white/10 bg-white/5 p-3 text-sm text-white/80">
            Not enough history yet. Snapshots will populate after your first daily run.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-white/70">
                  <th className="py-2 pr-4">Metric</th>
                  <th className="py-2 pr-4">Latest</th>
                  <th className="py-2 pr-4">7d</th>
                  <th className="py-2 pr-4">30d</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {metrics.map((m) => (
                  <tr key={m.label}>
                    <td className="py-2 pr-4 text-white">{m.label}</td>
                    <td className="py-2 pr-4">{m.latest ?? "—"}</td>
                    <td className="py-2 pr-4">{m.d7 ?? "—"}</td>
                    <td className="py-2 pr-4">{m.d30 ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
