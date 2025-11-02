// src/lib/pricing.ts
// Server-only (used by server components / API routes).
import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/* =========================================================
 * CURRENCIES & PARSING
 * =======================================================*/
export type Currency = "USD" | "EUR";
export type DisplayCurrency = "NATIVE" | Currency;

/** robust parse for text price columns -> number */
export function parseMoneyToNumber(raw?: string | null): number | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;

  // remove common currency symbols and whitespace
  s = s.replace(/[\s,$€£¥₩]/g, "");

  // if decimal comma likely (contains ',' but not '.') -> switch comma to dot
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");

  // drop thousands separators (commas) like "1,234.56"
  s = s.replace(/,/g, "");

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** validate + read env FX. Returns nulls if invalid/missing. */
export function getFx() {
  // Prefer both if provided; either one is enough.
  // FX_USD_EUR = EUR per 1 USD
  // FX_EUR_USD = USD per 1 EUR
  const rawUsdEur = process.env.FX_USD_EUR;
  const rawEurUsd = process.env.FX_EUR_USD;

  const usdEurParsed =
    rawUsdEur != null && rawUsdEur !== "" ? Number(rawUsdEur) : NaN; // EUR per 1 USD
  const eurUsdParsed =
    rawEurUsd != null && rawEurUsd !== "" ? Number(rawEurUsd) : NaN; // USD per 1 EUR

  const usdEurValid = Number.isFinite(usdEurParsed) && usdEurParsed > 0;
  const eurUsdValid = Number.isFinite(eurUsdParsed) && eurUsdParsed > 0;

  let usdToEur: number | null = null;
  let eurToUsd: number | null = null;

  if (usdEurValid) {
    usdToEur = usdEurParsed;
    eurToUsd = 1 / usdEurParsed;
  }
  if (eurUsdValid) {
    eurToUsd = eurUsdParsed;
    usdToEur = 1 / eurUsdParsed;
  }

  return { usdToEur, eurToUsd };
}

export function convert(n: number, from: Currency, to: Currency): number | null {
  if (from === to) return n;
  const fx = getFx();
  if (from === "USD" && to === "EUR" && fx.usdToEur) return n * fx.usdToEur;
  if (from === "EUR" && to === "USD" && fx.eurToUsd) return n * fx.eurToUsd;
  return null; // No usable FX provided; cannot convert
}

export function formatMoney(n: number, currency: Currency): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}

/** format possibly converting to display currency; else returns null */
export function maybeFormat(
  valueText: string | null | undefined,
  source: Currency,
  display: DisplayCurrency
): string | null {
  const n = parseMoneyToNumber(valueText);
  if (n == null) return null;

  if (display === "NATIVE" || display === source) {
    return formatMoney(n, source);
  }

  const converted = convert(n, source, display);
  if (converted == null) {
    // no FX defined, fallback to native to avoid misleading values
    return formatMoney(n, source);
  }
  return formatMoney(converted, display);
}

/** pick latest timestamp string (tcg vs cm) */
export function pickLatestTimestamp(a?: string | null, b?: string | null): string | null {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta >= tb ? (a as string) : (b as string);
  if (Number.isFinite(ta)) return a as string;
  if (Number.isFinite(tb)) return b as string;
  return a || b || null;
}

/* =========================================================
 * NORMALIZED PRICE SHAPE
 * =======================================================*/

export type MarketPriceRow = { label: string; value: string | null };
export type MarketBlock = {
  market: "TCGplayer" | "Cardmarket" | "eBay" | "Amazon" | "CoolStuffInc";
  rows: MarketPriceRow[];
  updatedAt?: string | null;
};

export type CardPriceSummary = {
  /** What the UI asked for: "NATIVE" (per-market) or a target currency */
  display: DisplayCurrency;
  /** Grouped display blocks ready to render */
  blocks: MarketBlock[];
  /** Useful for “Last updated …” */
  latestUpdatedAt: string | null;
  /** quick flag */
  hasAnyPrice: boolean;
};

/* =========================================================
 * CATEGORY LOADER (POKÉMON / YGO now, MTG stub, FUNKO & SPORTS skipped)
 * =======================================================*/

export type PriceCategory = "pokemon" | "yugioh" | "mtg" | "funko" | "sports";

/** Main entry point */
export async function loadCardPrices(opts: {
  category: PriceCategory;
  cardId: string;
  display?: DisplayCurrency; // defaults to "NATIVE"
}): Promise<CardPriceSummary | null> {
  const display: DisplayCurrency = opts.display ?? "NATIVE";

  if (opts.category === "funko" || opts.category === "sports") {
    // explicit: not supported (no source yet)
    return null;
  }

  if (opts.category === "pokemon") {
    return loadPokemonPrices(opts.cardId, display);
  }

  if (opts.category === "yugioh") {
    return loadYgoPrices(opts.cardId, display);
  }

  if (opts.category === "mtg") {
    // TODO: wire once tables exist
    return null;
  }

  return null;
}

/* ---------- Pokémon (TCGplayer + Cardmarket tables) ---------- */

type PkmnTcgplayerRow = {
  updated_at: string | null;
  currency: string | null; // usually "USD"
  normal: string | null;
  holofoil: string | null;
  reverse_holofoil: string | null;
  first_edition_holofoil: string | null;
  first_edition_normal: string | null;
};

type PkmnCardmarketRow = {
  updated_at: string | null;
  average_sell_price: string | null;
  low_price: string | null;
  trend_price: string | null;
  german_pro_low: string | null;
  suggested_price: string | null;
  reverse_holo_sell: string | null;
  reverse_holo_low: string | null;
  reverse_holo_trend: string | null;
  low_price_ex_plus: string | null;
  avg1: string | null;
  avg7: string | null;
  avg30: string | null;
  reverse_holo_avg1: string | null;
  reverse_holo_avg7: string | null;
  reverse_holo_avg30: string | null;
};

function normalizeCurrencyCode(s?: string | null): Currency {
  return s && s.toUpperCase() === "EUR" ? "EUR" : "USD";
}

async function loadPokemonPrices(cardId: string, display: DisplayCurrency): Promise<CardPriceSummary> {
  const tp =
    (
      await db.execute<PkmnTcgplayerRow>(sql`
        SELECT updated_at, currency, normal, holofoil, reverse_holofoil, first_edition_holofoil, first_edition_normal
        FROM tcg_card_prices_tcgplayer
        WHERE card_id = ${cardId}
        LIMIT 1
      `)
    ).rows?.[0] ?? null;

  const cm =
    (
      await db.execute<PkmnCardmarketRow>(sql`
        SELECT updated_at, average_sell_price, low_price, trend_price, german_pro_low, suggested_price,
               reverse_holo_sell, reverse_holo_low, reverse_holo_trend, low_price_ex_plus,
               avg1, avg7, avg30, reverse_holo_avg1, reverse_holo_avg7, reverse_holo_avg30
        FROM tcg_card_prices_cardmarket
        WHERE card_id = ${cardId}
        LIMIT 1
      `)
    ).rows?.[0] ?? null;

  const tpCur: Currency = normalizeCurrencyCode(tp?.currency);
  const latestUpdatedAt = pickLatestTimestamp(tp?.updated_at, cm?.updated_at);

  const tpBlock: MarketBlock = {
    market: "TCGplayer",
    updatedAt: tp?.updated_at ?? null,
    rows: [
      { label: "Normal", value: maybeFormat(tp?.normal, tpCur, display) },
      { label: "Holofoil", value: maybeFormat(tp?.holofoil, tpCur, display) },
      { label: "Reverse Holofoil", value: maybeFormat(tp?.reverse_holofoil, tpCur, display) },
      { label: "1st Ed. Holofoil", value: maybeFormat(tp?.first_edition_holofoil, tpCur, display) },
      { label: "1st Ed. Normal", value: maybeFormat(tp?.first_edition_normal, tpCur, display) },
    ],
  };

  const cmBlock: MarketBlock = {
    market: "Cardmarket",
    updatedAt: cm?.updated_at ?? null,
    rows: [
      { label: "Average", value: maybeFormat(cm?.average_sell_price, "EUR", display) },
      { label: "Low", value: maybeFormat(cm?.low_price, "EUR", display) },
      { label: "Trend", value: maybeFormat(cm?.trend_price, "EUR", display) },
      { label: "Suggested", value: maybeFormat(cm?.suggested_price, "EUR", display) },
      { label: "RH Sell", value: maybeFormat(cm?.reverse_holo_sell, "EUR", display) },
      { label: "RH Low", value: maybeFormat(cm?.reverse_holo_low, "EUR", display) },
      { label: "RH Trend", value: maybeFormat(cm?.reverse_holo_trend, "EUR", display) },
      { label: "Avg 1d", value: maybeFormat(cm?.avg1, "EUR", display) },
      { label: "Avg 7d", value: maybeFormat(cm?.avg7, "EUR", display) },
      { label: "Avg 30d", value: maybeFormat(cm?.avg30, "EUR", display) },
      { label: "RH Avg 1d", value: maybeFormat(cm?.reverse_holo_avg1, "EUR", display) },
      { label: "RH Avg 7d", value: maybeFormat(cm?.reverse_holo_avg7, "EUR", display) },
      { label: "RH Avg 30d", value: maybeFormat(cm?.reverse_holo_avg30, "EUR", display) },
      { label: "Low EX+", value: maybeFormat(cm?.low_price_ex_plus, "EUR", display) },
      { label: "German Pro Low", value: maybeFormat(cm?.german_pro_low, "EUR", display) },
    ],
  };

  const blocks = [
    ...(tp ? [tpBlock] : []),
    ...(cm ? [cmBlock] : []),
  ];

  const hasAnyPrice = blocks.some((b) => b.rows.some((r) => r.value != null));

  return { display, blocks, latestUpdatedAt, hasAnyPrice };
}

/* ---------- Yu-Gi-Oh! (single prices table) ---------- */

type YgoPriceRow = {
  tcgplayer_price: string | null;     // USD
  cardmarket_price: string | null;    // EUR
  ebay_price: string | null;          // USD (assumed)
  amazon_price: string | null;        // USD (assumed)
  coolstuffinc_price: string | null;  // USD (assumed)
};

async function loadYgoPrices(cardId: string, display: DisplayCurrency): Promise<CardPriceSummary> {
  const p =
    (
      await db.execute<YgoPriceRow>(sql`
        SELECT tcgplayer_price, cardmarket_price, ebay_price, amazon_price, coolstuffinc_price
        FROM ygo_card_prices
        WHERE card_id = ${cardId}
        LIMIT 1
      `)
    ).rows?.[0] ?? null;

  if (!p) {
    return { display, blocks: [], latestUpdatedAt: null, hasAnyPrice: false };
  }

  const b1: MarketBlock = {
    market: "TCGplayer",
    rows: [{ label: "Price", value: maybeFormat(p.tcgplayer_price, "USD", display) }],
  };
  const b2: MarketBlock = {
    market: "Cardmarket",
    rows: [{ label: "Price", value: maybeFormat(p.cardmarket_price, "EUR", display) }],
  };
  const b3: MarketBlock = {
    market: "eBay",
    rows: [{ label: "Price", value: maybeFormat(p.ebay_price, "USD", display) }],
  };
  const b4: MarketBlock = {
    market: "Amazon",
    rows: [{ label: "Price", value: maybeFormat(p.amazon_price, "USD", display) }],
  };
  const b5: MarketBlock = {
    market: "CoolStuffInc",
    rows: [{ label: "Price", value: maybeFormat(p.coolstuffinc_price, "USD", display) }],
  };

  const blocks = [b1, b2, b3, b4, b5].filter(
    (b) => b.rows.some((r) => r.value != null)
  );
  const hasAnyPrice = blocks.length > 0;

  return { display, blocks, latestUpdatedAt: null, hasAnyPrice };
}
