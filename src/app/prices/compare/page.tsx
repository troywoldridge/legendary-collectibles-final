import "server-only";
import Link from "next/link";
import Image from "next/image";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type Currency,
  type DisplayCurrency,
  maybeFormat,
} from "@/lib/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchParams = { ids?: string; currency?: string };

type Row = {
  id: string;
  name: string | null;
  rarity: string | null;
  set_id: string | null;
  small_image: string | null;
  large_image: string | null;

  tp_currency: string | null;
  tp_normal: string | null;
  tp_holofoil: string | null;
  tp_reverse_holofoil: string | null;

  cm_trend_price: string | null;
  cm_low_price: string | null;
  cm_average_sell_price: string | null;
};

function parseCurrency(s?: string): DisplayCurrency {
  const u = (s ?? "").toUpperCase();
  return u === "USD" || u === "EUR" ? (u as Currency) : "NATIVE";
}

function parseIds(raw?: string): string[] {
  if (!raw) return [];
  // split on commas, whitespace, or newlines
  const parts = raw
    .split(/[\s,]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
  // dedupe, keep first 100
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      out.push(p);
      seen.add(p);
      if (out.length >= 100) break;
    }
  }
  return out;
}

export default async function ComparePricesPage({
  searchParams,
}: {
  /** Next 15: Promise */
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const display = parseCurrency(sp?.currency);
  const ids = parseIds(sp?.ids);

  const baseHref = "/prices/compare";

  let rows: Row[] = [];
  if (ids.length > 0) {
    // Build IN (...) safely
    const inList = sql.join(ids.map((x) => sql`${x}`), sql`, `);

    rows =
      (
        await db.execute<Row>(sql`
          SELECT
            c.id,
            c.name,
            c.rarity,
            c.set_id,
            c.small_image,
            c.large_image,

            tp.currency           AS tp_currency,
            tp.normal             AS tp_normal,
            tp.holofoil           AS tp_holofoil,
            tp.reverse_holofoil   AS tp_reverse_holofoil,

            cm.trend_price        AS cm_trend_price,
            cm.low_price          AS cm_low_price,
            cm.average_sell_price AS cm_average_sell_price

          FROM tcg_cards c
          LEFT JOIN tcg_card_prices_tcgplayer tp ON tp.card_id = c.id
          LEFT JOIN tcg_card_prices_cardmarket cm ON cm.card_id = c.id
          WHERE c.id IN (${inList})
          ORDER BY c.set_id ASC NULLS LAST, c.name ASC NULLS LAST, c.id ASC
        `)
      ).rows ?? [];
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Compare Prices</h1>
          <p className="text-sm text-white/70">
            Paste card IDs (e.g., <code>base6-67</code>, <code>sv9-12</code>) — up to 100.
          </p>
        </div>

        <Link href="/categories/pokemon/cards" className="text-sky-300 hover:underline">
          ← Browse all cards
        </Link>
      </header>

      {/* Form */}
      <form action={baseHref} method="get" className="grid gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
        <label htmlFor="ids" className="text-sm text-white/90">
          Card IDs (comma, space or newline separated)
        </label>
        <textarea
          id="ids"
          name="ids"
          defaultValue={sp?.ids ?? ""}
          rows={4}
          placeholder="base6-67, sv9-12, swsh3-20"
          className="rounded-lg border border-white/20 bg-white/10 p-3 text-sm text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-white/50"
        />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="currency" className="sr-only">Display currency</label>
            <select
              id="currency"
              name="currency"
              defaultValue={display === "NATIVE" ? "NATIVE" : display}
              className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-xs text-white"
            >
              <option value="NATIVE">Native</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </div>
          <button
            type="submit"
            className="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
          >
            Compare
          </button>
        </div>
      </form>

      {/* Results */}
      {ids.length === 0 ? (
        <div className="rounded-xl border border-white/15 bg-white/5 p-6 text-white/80 backdrop-blur-sm">
          Enter some IDs above to see prices from TCGplayer and Cardmarket.
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-white/15 bg-white/5 p-6 text-white/80 backdrop-blur-sm">
          No matches for the provided IDs.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/5">
          <table className="min-w-[960px] w-full text-sm">
            <thead className="text-left text-white/80">
              <tr className="border-b border-white/10">
                <th className="px-3 py-2">Card</th>
                <th className="px-3 py-2">Rarity</th>
                <th className="px-3 py-2">TCGp Normal</th>
                <th className="px-3 py-2">TCGp Holofoil</th>
                <th className="px-3 py-2">TCGp Rev Holo</th>
                <th className="px-3 py-2">CM Trend</th>
                <th className="px-3 py-2">CM Low</th>
                <th className="px-3 py-2">CM AvgSell</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {rows.map((r) => {
                const img = r.large_image || r.small_image || null;
                const tpCurr: Currency = r.tp_currency?.toUpperCase() === "EUR" ? "EUR" : "USD";
                const tpNormal = maybeFormat(r.tp_normal, tpCurr, display);
                const tpHolo = maybeFormat(r.tp_holofoil, tpCurr, display);
                const tpRev = maybeFormat(r.tp_reverse_holofoil, tpCurr, display);
                const cmTrend = maybeFormat(r.cm_trend_price, "EUR", display);
                const cmLow = maybeFormat(r.cm_low_price, "EUR", display);
                const cmAvg = maybeFormat(r.cm_average_sell_price, "EUR", display);

                return (
                  <tr key={r.id} className="hover:bg-white/5">
                    <td className="px-3 py-2">
                      <Link href={`/categories/pokemon/cards/${encodeURIComponent(r.id)}`} className="flex items-center gap-3">
                        <div className="relative h-12 w-9 shrink-0 rounded bg-white/5 ring-1 ring-white/10 overflow-hidden">
                          {img ? (
                            <Image
                              src={img}
                              alt={r.name ?? r.id}
                              fill
                              unoptimized
                              className="object-contain"
                              sizes="36px"
                            />
                          ) : null}
                        </div>
                        <div className="text-white hover:underline">
                          {r.name ?? r.id}
                        </div>
                        {r.set_id && (
                          <span className="ml-2 rounded border border-white/15 bg-white/10 px-2 py-0.5 text-[11px] text-white/80">
                            {r.set_id}
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-white/80">{r.rarity ?? ""}</td>
                    <td className="px-3 py-2 text-white">{tpNormal ?? "—"}</td>
                    <td className="px-3 py-2 text-white">{tpHolo ?? "—"}</td>
                    <td className="px-3 py-2 text-white">{tpRev ?? "—"}</td>
                    <td className="px-3 py-2 text-white">{cmTrend ?? "—"}</td>
                    <td className="px-3 py-2 text-white">{cmLow ?? "—"}</td>
                    <td className="px-3 py-2 text-white">{cmAvg ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
