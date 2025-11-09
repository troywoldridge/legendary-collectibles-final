// src/app/categories/pokemon/cards/[id]/page.tsx
import "server-only";
import Image from "next/image";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { unstable_noStore as noStore } from "next/cache";

import MarketPrices from "@/components/MarketPrices";
import PriceSparkline from "@/components/PriceSparkline";
import { type DisplayCurrency, getFx } from "@/lib/pricing";
import { getVendorPricesForCard } from "@/lib/vendorPrices";
import { getLatestEbaySnapshot } from "@/lib/ebay";

import { auth } from "@clerk/nextjs/server";
import { getUserPlan } from "@/lib/plans";
import AddToCollectionButton from "@/components/AddToCollectionButton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/* ---------------- Types ---------------- */
type RawRow = Record<string, any>;

type CardRow = {
  id: string;
  name: string | null;
  supertype: string | null;
  subtypes: string | null;
  level: string | null;
  hp: string | null;
  types: string | null;
  evolves_from: string | null;
  evolves_to: string | null;
  rules: string | null;
  ancient_trait_name: string | null;
  ancient_trait_text: string | null;
  converted_retreat_cost: string | null;
  retreat_cost: string | null;
  set_id: string | null;
  set_name: string | null;
  series: string | null;
  printed_total: string | null;
  total: string | null;
  ptcgo_code: string | null;
  release_date: string | null;
  artist: string | null;
  rarity: string | null;
  flavor_text: string | null;
  small_image: string | null;
  large_image: string | null;
  tcgplayer_url: string | null;
  tcgplayer_updated_at: string | null;
  cardmarket_url: string | null;
  cardmarket_updated_at: string | null;
};

type LegalityRow = { format: string | null; legality: string | null };
type SearchParams = Record<string, string | string[] | undefined>;
type VendorKey = "ebay" | "amazon" | "coolstuffinc";
type VendorPrice = { value: number | null; currency: string; url: string | null };

/* ---------------- Helpers ---------------- */
function normalizeImg(u?: string | null): string | null {
  if (!u) return null;
  let s = String(u).trim();
  if (!s) return null;
  if (s.startsWith("//")) s = "https:" + s;          // protocol-relative → https
  s = s.replace(/^http:\/\//i, "https://");          // force https
  if (s.includes(" ")) s = s.replace(/ /g, "%20");   // encode spaces
  try {
    const url = new URL(s);
    return url.href;
  } catch {
    return s;
  }
}

const coerceText = (v: any): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};

const bestImg = (c: CardRow) => c.large_image || c.small_image || null;

function splitList(s?: string | null): string[] {
  if (!s) return [];
  const t = s.trim();
  if (!t) return [];
  if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean);
      if (parsed && typeof parsed === "object") return Object.values(parsed).map((x) => String(x)).filter(Boolean);
    } catch {}
  }
  return t.split(/[,;|]/g).map((x) => x.trim()).filter(Boolean);
}

function fmtList(s?: string | null, sep = ", "): string {
  const a = splitList(s);
  return a.length ? a.join(sep) : "";
}

/** Accept both ?display= and legacy ?currency= (USD|EUR) else NATIVE */
function readDisplay(sp: SearchParams): DisplayCurrency {
  const a = (Array.isArray(sp?.display) ? sp.display[0] : sp?.display)?.toUpperCase();
  const b = (Array.isArray(sp?.currency) ? sp.currency[0] : sp?.currency)?.toUpperCase();
  const v = a || b;
  return v === "USD" || v === "EUR" ? (v as DisplayCurrency) : "NATIVE";
}

function normalizeId(s: string): string {
  return s.trim().toLowerCase().replace(/[–—−]/g, "-").replace(/\s+/g, "");
}

function mapRow(r: RawRow): CardRow {
  return {
    id: String(r.id),
    name: coerceText(r.name),
    supertype: coerceText(r.supertype),
    subtypes: coerceText(r.subtypes),
    level: coerceText(r.level),
    hp: coerceText(r.hp),
    types: coerceText(r.types),
    evolves_from: coerceText(r.evolves_from),
    evolves_to: coerceText(r.evolves_to),
    rules: coerceText(r.rules),
    ancient_trait_name: coerceText(r.ancient_trait_name),
    ancient_trait_text: coerceText(r.ancient_trait_text),
    converted_retreat_cost: coerceText(r.converted_retreat_cost),
    retreat_cost: coerceText(r.retreat_cost),

    set_id: r["set.id"] ?? r.set_id ?? null,
    set_name: r["set.name"] ?? r.set_name ?? null,
    series: r["set.series"] ?? r.series ?? r.set_series ?? null,
    printed_total: r["set.printedTotal"] ?? r.printed_total ?? r.set_printed_total ?? null,
    total: r["set.total"] ?? r.total ?? r.set_total ?? null,
    ptcgo_code: r["set.ptcgoCode"] ?? r.ptcgo_code ?? r.set_ptcgo_code ?? null,
    release_date: r["set.releaseDate"] ?? r.release_date ?? r.set_release_date ?? null,

    small_image: (r.small_image ?? r.image_small ?? r.imageSmall ?? null) as string | null,
    large_image: (r.large_image ?? r.image_large ?? r.imageLarge ?? null) as string | null,
    artist: coerceText(r.artist),
    rarity: coerceText(r.rarity),
    flavor_text: coerceText(r.flavor_text),
    tcgplayer_url: coerceText(r.tcgplayer_url),
    tcgplayer_updated_at: coerceText(r.tcgplayer_updated_at),
    cardmarket_url: coerceText(r.cardmarket_url),
    cardmarket_updated_at: coerceText(r.cardmarket_updated_at),
  };
}

/* ---------------- Data loaders ---------------- */
async function loadExact(id: string) {
  const rs = await db.execute<RawRow>(sql`SELECT * FROM tcg_cards WHERE id = ${id} LIMIT 1`);
  return rs.rows?.[0] ? mapRow(rs.rows[0]) : null;
}
async function loadCaseInsensitive(id: string) {
  const rs = await db.execute<RawRow>(sql`
    SELECT * FROM tcg_cards
    WHERE LOWER(id) = LOWER(${id})
    LIMIT 1
  `);
  return rs.rows?.[0] ? mapRow(rs.rows[0]) : null;
}
async function loadNormalized(id: string) {
  const wanted = normalizeId(id);
  const rs = await db.execute<RawRow>(sql`
    SELECT * FROM tcg_cards
    WHERE LOWER(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(id,'–','-'),
            '—','-'
          ),
          '−','-'
        ),
        ' ',
        ''
      )
    ) = ${wanted}
    LIMIT 1
  `);
  return rs.rows?.[0] ? mapRow(rs.rows[0]) : null;
}
async function loadCardById(wanted: string) {
  let card = await loadExact(wanted);
  if (card) return { card, path: "exact" as const };
  card = await loadCaseInsensitive(wanted);
  if (card) return { card, path: "lowercase" as const };
  card = await loadNormalized(wanted);
  if (card) return { card, path: "normalized" as const };
  return { card: null as CardRow | null, path: "miss" as const };
}

/* ---------------- Page ---------------- */
export default async function PokemonCardDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id?: string | string[] }>;
  searchParams: Promise<SearchParams>;
}) {
  noStore();

  const p = await params;
  const sp = await searchParams;
  const rawId = Array.isArray(p?.id) ? p.id[0] : p?.id;
  const wanted = decodeURIComponent(String(rawId ?? "")).trim();
  const display = readDisplay(sp);
  const debug = (Array.isArray(sp?.debug) ? sp.debug[0] : sp?.debug) === "1";

  const { card, path } = await loadCardById(wanted);

  if (!card) {
    return (
      <section className="space-y-4">
        {debug && (
          <pre className="text-xs whitespace-pre-wrap rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2 text-yellow-200">
{JSON.stringify({ wanted, normalized: normalizeId(wanted), pathTried: path }, null, 2)}
          </pre>
        )}
        <h1 className="text-2xl font-bold text-white">Card not found</h1>
        <p className="text-white/70 text-sm break-all">Tried ID: <code>{wanted}</code></p>
        <div className="flex gap-4">
          <Link href="/categories/pokemon/cards" className="text-sky-300 hover:underline">← Back to all cards</Link>
          <Link href="/categories/pokemon/sets" className="text-sky-300 hover:underline">← Browse sets</Link>
        </div>
      </section>
    );
  }

  // downstream
  const ebay = await getLatestEbaySnapshot("pokemon", card.id, "all");
  const legalities: LegalityRow[] =
    card.set_id
      ? (await db.execute<LegalityRow>(
          sql`SELECT format, legality FROM tcg_sets_legalities WHERE set_id = ${card.set_id} ORDER BY format ASC`
        )).rows ?? []
      : [];

  // robust image (same behavior as YGO)
  const hero = normalizeImg(bestImg(card));

  const setHref = card.set_id
    ? `/categories/pokemon/sets/${encodeURIComponent(String(card.set_id))}`
    : card.set_name
    ? `/categories/pokemon/sets/${encodeURIComponent(String(card.set_name))}`
    : null;

  const chipsTypes = splitList(card.types);
  const chipsSubtypes = splitList(card.subtypes);
  const rulesList = splitList(card.rules);
  const evoTo = splitList(card.evolves_to);

  const fx = getFx();

// Pull vendor prices (may be empty for some vendors today)
const rawVendors = await getVendorPricesForCard("pokemon", card.id, [
  "ebay",
  "amazon",
  "coolstuffinc",
]);

type VendorKey = "ebay" | "amazon" | "coolstuffinc";
type VendorPrice = { value: number | null; currency: string; url: string | null };

const baseVendors = (rawVendors ?? {}) as Record<VendorKey, VendorPrice>;

// If no eBay vendor price, fall back to snapshot median (USD)
const vendors: Record<VendorKey, VendorPrice> = !baseVendors.ebay || baseVendors.ebay.value == null
  ? {
      ...baseVendors,
      ebay: {
        value: ebay?.median_cents != null ? ebay.median_cents / 100 : null,
        currency: "USD",
        url: baseVendors.ebay?.url ?? null,
      },
    }
  : baseVendors;

// Format vendor price in the chosen display currency
const showVendorPrice = (v?: VendorPrice) => {
  if (!v || v.value == null) return "—";

  if (display === "EUR") {
    if (v.currency === "EUR") return `€${v.value.toFixed(2)}`;
    if (v.currency === "USD" && fx.usdToEur) return `€${(v.value * fx.usdToEur).toFixed(2)}`;
  }
  if (display === "USD") {
    if (v.currency === "USD") return `$${v.value.toFixed(2)}`;
    if (v.currency === "EUR" && fx.eurToUsd) return `$${(v.value * fx.eurToUsd).toFixed(2)}`;
  }

  const sym = v.currency === "EUR" ? "€" : "$";
  return `${sym}${v.value.toFixed(2)}`;
};

  // Fallback to eBay snapshot if vendor service had nothing
  if (!vendors.ebay || vendors.ebay.value == null) {
    vendors.ebay = {
      value: ebay?.median_cents != null ? ebay.median_cents / 100 : null,
      currency: "USD",
      url: vendors.ebay?.url ?? null,
    };
  }



// ----- History gates to avoid <!DOCTYPE…> errors when empty -----
const hasTcgHistory =
  (
    await db.execute(
      sql`SELECT 1 FROM tcg_card_prices_tcgplayer WHERE card_id = ${card.id} LIMIT 1`
    )
  ).rows.length > 0;

const hasCmkHistory =
  (
    await db.execute(
      sql`SELECT 1 FROM tcg_card_prices_cardmarket WHERE card_id = ${card.id} LIMIT 1`
    )
  ).rows.length > 0;



  const moneyFromUsdCents = (cents?: number | null) => {
    if (cents == null) return "—";
    if (display === "EUR" && fx.usdToEur) {
      const eur = (cents / 100) * fx.usdToEur;
      return `€${eur.toFixed(2)}`;
    }
    return `$${(cents / 100).toFixed(2)}`;
  };

  const { userId } = await auth();
  let canSave = false;
  if (userId) {
    const { limits } = await getUserPlan(userId);
    canSave = (limits.maxItems ?? 0) > 0;
  }

  return (
    <section className="space-y-8">
      {debug && (
        <pre className="text-xs whitespace-pre-wrap rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2 text-yellow-200">
{JSON.stringify({ wanted, matchedId: card.id, matchPath: path, hero }, null, 2)}
        </pre>
      )}

      {/* Top: image left, info right */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: large card image */}
        <div className="lg:col-span-5">
          <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
            <div className="relative mx-auto aspect-3/4 w-full max-w-md">
              {hero ? (
                <Image
                  src={hero}
                  alt={card.name ?? card.id}
                  fill
                  unoptimized
                  className="object-contain"
                  sizes="(max-width: 1024px) 80vw, 480px"
                  priority
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center text-white/70">
                  No image
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: title + actions + meta */}
        <div className="lg:col-span-7 space-y-4">
          <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold text-white">{card.name ?? card.id}</h1>
                <div className="mt-1 text-sm text-white/80">
                  {card.rarity ? <span className="mr-3">Rarity: {card.rarity}</span> : null}
                  {card.supertype ? <span className="mr-3">{card.supertype}</span> : null}
                  {chipsTypes.length ? <span className="mr-3">{chipsTypes.join(" • ")}</span> : null}
                  {chipsSubtypes.length ? <span>{chipsSubtypes.join(" • ")}</span> : null}
                </div>
              </div>

              {setHref && (
                <Link href={setHref} className="text-sm text-sky-300 hover:underline">
                  View set →
                </Link>
              )}
            </div>

            {/* collection action */}
            <div className="mt-3">
              {canSave ? (
                <AddToCollectionButton
                  game="pokemon"
                  cardId={card.id}
                  cardName={card.name || undefined}
                  setName={card.set_name || undefined}
                  number={undefined}
                  imageUrl={hero || undefined}
                />
              ) : (
                <Link
                  href="/pricing"
                  className="inline-block px-3 py-2 rounded bg-amber-500 text-white hover:bg-amber-600"
                >
                  Upgrade to track your collection
                </Link>
              )}
            </div>

            {/* quick facts */}
            <div className="mt-4 text-sm text-white/70">
              {[
                card.series || undefined,
                card.ptcgo_code ? `PTCGO: ${card.ptcgo_code}` : undefined,
                card.release_date ? `Released: ${card.release_date}` : undefined,
              ]
                .filter(Boolean)
                .join(" • ")}
            </div>

            {/* legality chips */}
            {legalities.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {legalities.map((l, i) =>
                  l.format && l.legality ? (
                    <span
                      key={i}
                      className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] leading-5 text-white/80"
                    >
                      {l.format}: {l.legality}
                    </span>
                  ) : null
                )}
              </div>
            )}
          </div>

          {/* details grid */}
          <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
            <div className="grid grid-cols-2 gap-2 text-sm text-white/90">
              {card.hp && (<div><span className="text-white/70">HP:</span> {card.hp}</div>)}
              {card.level && (<div><span className="text-white/70">Level:</span> {card.level}</div>)}
              {fmtList(card.retreat_cost) && (
                <div className="col-span-2">
                  <span className="text-white/70">Retreat Cost:</span> {fmtList(card.retreat_cost)}
                </div>
              )}
              {card.converted_retreat_cost && (
                <div className="col-span-2">
                  <span className="text-white/70">Converted Retreat:</span>{" "}
                  {card.converted_retreat_cost}
                </div>
              )}
              {card.evolves_from && (
                <div className="col-span-2">
                  <span className="text-white/70">Evolves from:</span> {card.evolves_from}
                </div>
              )}
              {evoTo.length > 0 && (
                <div className="col-span-2">
                  <span className="text-white/70">Evolves to:</span> {evoTo.join(", ")}
                </div>
              )}
            </div>
          </div>

          {/* flavor / rules */}
          {rulesList.length > 0 && (
            <section className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
              <h2 className="text-lg font-semibold text-white">Rules</h2>
              <ul className="mt-2 list-disc pl-5 text-sm text-white/85">
                {rulesList.map((r, i) => (<li key={i}>{r}</li>))}
              </ul>
            </section>
          )}
          {card.ancient_trait_name || card.ancient_trait_text ? (
            <section className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
              <h2 className="text-lg font-semibold text-white">Ancient Trait</h2>
              {card.ancient_trait_name ? <div className="font-medium">{card.ancient_trait_name}</div> : null}
              {card.ancient_trait_text ? <p className="text-white/80 mt-1">{card.ancient_trait_text}</p> : null}
            </section>
          ) : null}
          {card.flavor_text && (
            <section className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
              <h2 className="text-lg font-semibold text-white">Flavor</h2>
              <p className="text-sm text-white/80">{card.flavor_text}</p>
            </section>
          )}
        </div>
      </div>

      {/* Market prices (unified) */}
      <MarketPrices category="pokemon" cardId={card.id} display={display} />

      {/* eBay Snapshot */}
      {ebay && ebay.median_cents != null && (
        <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">eBay Snapshot</h2>
            <div className="text-xs text-white/60">
              {ebay.created_at ? new Date(ebay.created_at).toLocaleDateString() : ""}
            </div>
          </div>
          <div className="text-white/90">
            <div>
              Median: <span className="font-semibold">{moneyFromUsdCents(ebay.median_cents)}</span>{" "}
              {ebay.sample_count ? <span className="text-white/60">• n={ebay.sample_count}</span> : null}
            </div>
            <div className="text-sm text-white/80">
              IQR: {moneyFromUsdCents(ebay.p25_cents)} – {moneyFromUsdCents(ebay.p75_cents)}
            </div>
            <div className="text-xs text-white/60 mt-1">Source: eBay Browse API (US, USD; outliers pruned)</div>
          </div>
        </div>
      )}

      {/* Other Marketplaces */}
      <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Other Marketplaces</h2>
          <div className="text-xs text-white/60">Converted values are approximate</div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {(["ebay", "amazon", "coolstuffinc"] as const).map((key) => {
            const v = vendors[key];
            const label = key === "coolstuffinc" ? "CoolStuffInc" : key.charAt(0).toUpperCase() + key.slice(1);
            const price = showVendorPrice(v as VendorPrice | undefined);
            return (
              <div key={key} className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-sm font-medium text-white">{label}</div>
                <div className="text-white/80">Price</div>
                <div className="mt-1 text-lg font-semibold text-white">{price}</div>
                {v?.url ? (
                  <a href={v.url} target="_blank" className="text-xs text-sky-300 hover:underline">
                    View listing →
                  </a>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

{/* mini trend glances (only if we have data; prevents <!DOCTYPE…> JSON errors) */}
{(hasTcgHistory || hasCmkHistory) ? (
  <section className="grid gap-3 md:grid-cols-2">
    {/* TCGplayer sparkline */}
    {hasTcgHistory && (
      <PriceSparkline
        category="pokemon"
        cardId={card.id}
        market="TCGplayer"  // Title-case to satisfy union type
        keyName="normal"
        days={30}
        display={display}
        label="TCGplayer • Normal (30d)"
      />
    )}

    {/* Cardmarket sparkline */}
    {hasCmkHistory && (
      <PriceSparkline
        category="pokemon"
        cardId={card.id}
        market="Cardmarket" // Title-case
        keyName="trend_price"
        days={30}
        display={display}
        label="Cardmarket • Trend (30d)"
      />
    )}
  </section>
) : (
  // Graceful placeholder when there is no history for this card
  <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm text-white/70">
    No price history yet for this card.
  </div>
)}


      {/* FX note if converting */}
      {display !== "NATIVE" && (fx.usdToEur != null || fx.eurToUsd != null) && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-white/60">
          <span>
            Converted to {display} using env FX (
            {[
              fx.usdToEur != null ? `USD→EUR=${fx.usdToEur.toFixed(4)}` : null,
              fx.eurToUsd != null ? `EUR→USD=${fx.eurToUsd.toFixed(4)}` : null,
            ].filter(Boolean).join(", ")}
            )
          </span>
        </div>
      )}

      {/* Footer nav */}
      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/categories/pokemon/cards" className="text-sky-300 hover:underline">
          ← Back to cards
        </Link>
        {setHref && (
          <>
            <Link href={setHref} className="text-sky-300 hover:underline">
              ← Back to set
            </Link>
            <Link href={`${setHref}/prices`} className="text-sky-300 hover:underline">
              View set price overview →
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
