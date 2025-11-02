import "server-only";
import { NextResponse, NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { convert, getFx, type DisplayCurrency } from "@/lib/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SeriesPoint = { t: string; native: number | null; display: number | null };
type Series = {
  id: string;
  market: string; // "TCGplayer" | "Cardmarket" | "eBay" | "Amazon" | "CoolStuffInc"
  key: string;
  nativeCurrency: "USD" | "EUR";
  points: SeriesPoint[];
};

type JsonOut = {
  category: "pokemon" | "yugioh";
  cardId: string;
  display: DisplayCurrency;
  fx: { usdToEur: number | null; eurToUsd: number | null };
  days: number;
  series: Series[];
};

function readDisplay(sp: URLSearchParams): DisplayCurrency {
  const a = sp.get("display")?.toUpperCase();
  const b = sp.get("currency")?.toUpperCase();
  const v = a || b;
  return v === "USD" || v === "EUR" ? (v as DisplayCurrency) : "NATIVE";
}
function clampDays(x: number) {
  if (!Number.isFinite(x)) return 90;
  return Math.min(365, Math.max(1, Math.floor(x)));
}
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toISO(raw: unknown): string | null {
  if (!raw) return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function convMaybe(n: number | null, from: "USD" | "EUR", display: DisplayCurrency): number | null {
  if (n == null) return null;
  if (display === "NATIVE") return n;
  const out = convert(n, from, display);
  return out == null ? n : out;
}

/* ----------------------- POKÉMON ----------------------- */
async function loadPokemonSeries(
  cardId: string,
  days: number,
  display: DisplayCurrency,
  marketsFilter?: Set<string>,
  keysFilter?: Set<string>,
): Promise<Series[]> {
  const tpRows =
    (
      await db.execute<{
        captured_at: string;
        currency: string | null;
        normal: string | null;
        holofoil: string | null;
        reverse_holofoil: string | null;
        first_edition_holofoil: string | null;
        first_edition_normal: string | null;
      }>(sql`
        SELECT captured_at, currency, normal, holofoil, reverse_holofoil, first_edition_holofoil, first_edition_normal
        FROM tcg_card_prices_tcgplayer_history
        WHERE card_id = ${cardId}
          AND captured_at >= now() - (${days}::int * interval '1 day')
        ORDER BY captured_at ASC
      `)
    ).rows ?? [];

  const tpCur = (tpRows[0]?.currency?.toUpperCase() === "EUR" ? "EUR" : "USD") as "USD" | "EUR";
  const tpKeysAll = ["normal", "holofoil", "reverse_holofoil", "first_edition_holofoil", "first_edition_normal"] as const;
  const wantTP = !marketsFilter || marketsFilter.has("tcgplayer");
  const series: Series[] = [];

  if (wantTP) {
    for (const key of tpKeysAll) {
      if (keysFilter && !keysFilter.has(key)) continue;
      const points: SeriesPoint[] = tpRows.map((r) => {
        const t = toISO(r.captured_at)!;
        const n = num(r[key]);
        return { t, native: n, display: convMaybe(n, tpCur, display) };
      });
      series.push({
        id: `TCGplayer:${key}`,
        market: "TCGplayer",
        key,
        nativeCurrency: tpCur,
        points,
      });
    }
  }

  const cmRows =
    (
      await db.execute<{
        captured_at: string;
        trend_price: string | null;
        average_sell_price: string | null;
        low_price: string | null;
        suggested_price: string | null;
      }>(sql`
        SELECT captured_at, trend_price, average_sell_price, low_price, suggested_price
        FROM tcg_card_prices_cardmarket_history
        WHERE card_id = ${cardId}
          AND captured_at >= now() - (${days}::int * interval '1 day')
        ORDER BY captured_at ASC
      `)
    ).rows ?? [];

  const cmCur: "USD" | "EUR" = "EUR";
  const cmKeysAll = ["trend_price", "average_sell_price", "low_price", "suggested_price"] as const;
  const wantCM = !marketsFilter || marketsFilter.has("cardmarket");

  if (wantCM) {
    for (const key of cmKeysAll) {
      if (keysFilter && !keysFilter.has(key)) continue;
      const points: SeriesPoint[] = cmRows.map((r) => {
        const t = toISO(r.captured_at)!;
        const n = num(r[key]);
        return { t, native: n, display: convMaybe(n, cmCur, display) };
      });
      series.push({
        id: `Cardmarket:${key}`,
        market: "Cardmarket",
        key,
        nativeCurrency: cmCur,
        points,
      });
    }
  }

  return series;
}

/* ----------------------- YU-GI-OH! ----------------------- */
async function loadYgoSeries(
  cardId: string,
  days: number,
  display: DisplayCurrency,
  marketsFilter?: Set<string>,
  keysFilter?: Set<string>,
): Promise<Series[]> {
  const rows =
    (
      await db.execute<{
        captured_at: string;
        tcgplayer_price: string | null;
        cardmarket_price: string | null;
        ebay_price: string | null;
        amazon_price: string | null;
        coolstuffinc_price: string | null;
      }>(sql`
        SELECT captured_at, tcgplayer_price, cardmarket_price, ebay_price, amazon_price, coolstuffinc_price
        FROM ygo_card_prices_history
        WHERE card_id = ${cardId}
          AND captured_at >= now() - (${days}::int * interval '1 day')
        ORDER BY captured_at ASC
      `)
    ).rows ?? [];

  const out: Series[] = [];
  const add = (
    id: string,
    market: string,
    key: keyof (typeof rows)[number],
    nativeCurrency: "USD" | "EUR",
  ) => {
    if (keysFilter && !keysFilter.has(String(key))) return;
    const points: SeriesPoint[] = rows.map((r) => {
      const t = toISO(r.captured_at)!;
      const n = num(r[key]);
      return { t, native: n, display: convMaybe(n, nativeCurrency, display) };
    });
    out.push({ id, market, key: String(key), nativeCurrency, points });
  };

  const want = (m: string) => !marketsFilter || marketsFilter.has(m);
  if (want("tcgplayer")) add("TCGplayer:price", "TCGplayer", "tcgplayer_price", "USD");
  if (want("cardmarket")) add("Cardmarket:price", "Cardmarket", "cardmarket_price", "EUR");
  if (want("ebay")) add("eBay:price", "eBay", "ebay_price", "USD");
  if (want("amazon")) add("Amazon:price", "Amazon", "amazon_price", "USD");
  if (want("coolstuffinc")) add("CoolStuffInc:price", "CoolStuffInc", "coolstuffinc_price", "USD");

  return out;
}

/* ----------------------- Route (await params Promise) ----------------------- */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ category: string; cardId: string }> }
) {
  const { category: rawCat, cardId: rawParam } = await params;
  const category = rawCat?.toLowerCase();
  const cardId = decodeURIComponent(rawParam ?? "").trim();

  if (!cardId) {
    return NextResponse.json({ error: "Missing cardId" }, { status: 400 });
  }
  if (category !== "pokemon" && category !== "yugioh") {
    return NextResponse.json({ error: "Unsupported category" }, { status: 400 });
  }

  const sp = new URL(request.url).searchParams;
  const display = readDisplay(sp);
  const days = clampDays(Number(sp.get("days") ?? "90"));
  const marketsFilter = sp.get("markets")
    ? new Set(sp.get("markets")!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
    : undefined;
  const keysFilter = sp.get("keys")
    ? new Set(sp.get("keys")!.split(",").map((s) => s.trim()).filter(Boolean))
    : undefined;

  const fx = getFx();
  const series =
    category === "pokemon"
      ? await loadPokemonSeries(cardId, days, display, marketsFilter, keysFilter)
      : await loadYgoSeries(cardId, days, display, marketsFilter, keysFilter);

  const body: JsonOut = { category: category as JsonOut["category"], cardId, display, fx, days, series };

  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
