import "server-only";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getLatestEbaySnapshot } from "@/lib/ebay";
import EbayFallbackPrice from "@/components/EbayFallbackPrice";

/* Plan gate */
import { auth } from "@clerk/nextjs/server";
import { getUserPlan } from "@/lib/plans";
import AddToCollectionButton from "@/components/AddToCollectionButton";

/* ★ NEW: Marketplace CTAs */
import CardAmazonCTA from "@/components/CardAmazonCTA";
import CardEbayCTA from "@/components/CardEbayCTA";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type CardRow = {
  id: string;
  name: string | null;
  printed_name: string | null;
  mana_cost: string | null;
  cmc: string | null;                  // cast to text
  colors: string | null;               // json text
  color_identity: string | null;       // json text
  type_line: string | null;
  rarity: string | null;
  set_code: string | null;
  set_name: string | null;
  collector_number: string | null;
  oracle_id: string | null;
  layout: string | null;
  oracle_text: string | null;
  image_url: string | null;

  // price aliases with fallback (effective -> scryfall)
  usd: string | null;
  usd_foil: string | null;
  usd_etched: string | null;
  eur: string | null;
  tix: string | null;
  price_updated: string | null;

  // server-side eBay snapshot fallback
  ebay_usd: string | null;
  ebay_url: string | null;
};

type SetRow = {
  name: string | null;
  set_type: string | null;
  block: string | null;
  released_at: string | null;
};

function tokenizeMana(cost?: string | null): string[] {
  if (!cost) return [];
  const m = cost.match(/\{[^}]+\}/g) || [];
  return m.map((t) => t.slice(1, -1));
}
function nl2p(s?: string | null) {
  if (!s) return null;
  return s.split(/\n/g).map((line, i) => <p key={i} className="mb-1">{line}</p>);
}
function hexFor(sym: string) {
  switch (sym) {
    case "W": return "#f5f5f5";
    case "U": return "#3b82f6";
    case "B": return "#111827";
    case "R": return "#ef4444";
    case "G": return "#10b981";
    case "C": return "#6b7280";
    case "S": return "#94a3b8";
    default: return "#6b7280";
  }
}
function ManaSymbol({ t }: { t: string }) {
  const up = t.toUpperCase();
  if (up.includes("/")) {
    const [a, b] = up.split("/");
    const c1 = hexFor(a);
    const c2 = hexFor(b === "P" ? "B" : b);
    return (
      <span className="mana mana--hybrid" style={{ ["--c1" as any]: c1, ["--c2" as any]: c2 }} title={`Mana: ${up}`}>
        {up}
      </span>
    );
  }
  if (/^\d+$/.test(up)) return <span className="mana mana--num" title={`Mana: ${up}`}>{up}</span>;
  if (up === "X" || up === "Y" || up === "Z") return <span className="mana mana--var" title={`Mana: ${up}`}>{up}</span>;
  if (up === "T") return <span className="mana mana--sym" title="Tap">↷</span>;
  if (up === "Q") return <span className="mana mana--sym" title="Untap">↶</span>;
  return <span className={`mana mana--${up}`} title={`Mana: ${up}`}>{up}</span>;
}
function ManaCost({ cost }: { cost: string | null }) {
  const toks = tokenizeMana(cost);
  if (!toks.length) return null;
  return <div className="flex flex-wrap items-center gap-2">{toks.map((t, i) => <ManaSymbol key={`${t}-${i}`} t={t} />)}</div>;
}

/** SOI-1, SOI:1, SOI/1 → normalize to set + number */
function parseSetAndNumber(raw: string): { set: string; num: string } | null {
  const cleaned = raw.replace(/[–—]/g, "-").replace(":", "-").replace("/", "-");
  const m = cleaned.match(/^([A-Za-z0-9]{2,10})-(.+)$/);
  if (!m) return null;
  return { set: m[1], num: decodeURIComponent(m[2]) };
}
function normalizeNumVariants(n: string) {
  const exact = n;
  const noZeros = n.replace(/^0+/, "");
  const lower = n.toLowerCase();
  return { exact, noZeros, lower };
}

export default async function MtgCardDetailPage({
  params,
}: {
  // your repo expects Promise-based params
  params: Promise<{ id: string }>
}) {
  const { id } = await params;
  const rawParam = decodeURIComponent((id || "").trim());
  if (!rawParam) {
    console.error("[MTG detail] notFound: empty param");
    notFound();
  }
  const idNoDashes = rawParam.replace(/-/g, "");

  // STEP 1: probe
  const probe = await db.execute<{ id: string }>(sql`
    SELECT c.id::text AS id
    FROM public.mtg_cards c
    WHERE c.id::text = ${rawParam}
       OR REPLACE(c.id::text,'-','') = ${idNoDashes}
    LIMIT 1
  `);
  let foundId = probe.rows?.[0]?.id ?? null;

  // SET-NUM fallback
  if (!foundId) {
    const parsed = parseSetAndNumber(rawParam);
    if (parsed) {
      const set = parsed.set.toLowerCase();
      const { exact, noZeros, lower } = normalizeNumVariants(parsed.num);
      const p2 = await db.execute<{ id: string }>(sql`
        SELECT c.id::text AS id
        FROM public.mtg_cards c
        WHERE LOWER(c.set_code) = ${set}
          AND (
            c.collector_number::text = ${exact}
            OR ltrim(c.collector_number::text,'0') = ${noZeros}
            OR LOWER(c.collector_number::text) = ${lower}
          )
        LIMIT 1
      `);
      foundId = p2.rows?.[0]?.id ?? null;
    }
  }

  if (!foundId) {
    try {
      const meta = await db.execute(sql`SELECT current_database() AS db, current_user AS usr`);
      console.error("[MTG detail] notFound: no foundId", { rawParam, db: meta.rows?.[0]?.db, usr: meta.rows?.[0]?.usr });
    } catch {}
    notFound();
  }

  // STEP 2: load full row with price fallback + latest eBay snapshot (server-side)
  const rowRes = await db.execute<CardRow>(sql`
    SELECT
      c.id,
      c.name,
      c.printed_name,
      c.mana_cost,
      c.cmc::text AS cmc,
      c.colors::text AS colors,
      c.color_identity::text AS color_identity,
      c.type_line,
      c.rarity,
      c.set_code,
      c.set_name,
      c.collector_number,
      c.oracle_id::text AS oracle_id,
      c.layout,
      c.oracle_text,
      COALESCE(
        c.image_uris->>'normal',
        c.image_uris->>'large',
        c.image_uris->>'small',
        (c.card_faces_raw->0->'image_uris'->>'normal'),
        (c.card_faces_raw->0->'image_uris'->>'large'),
        (c.card_faces_raw->0->'image_uris'->>'small')
      ) AS image_url,

      /* --- prices with fallback --- */
      COALESCE(e.effective_usd,        s.usd)::text        AS usd,
      COALESCE(e.effective_usd_foil,   s.usd_foil)::text   AS usd_foil,
      COALESCE(e.effective_usd_etched, s.usd_etched)::text AS usd_etched,
      COALESCE(e.effective_eur,        s.eur)::text        AS eur,
      COALESCE(e.effective_tix,        s.tix)::text        AS tix,
      COALESCE(
        TO_CHAR(e.effective_updated_at,'YYYY-MM-DD'),
        TO_CHAR(s.updated_at,'YYYY-MM-DD')
      ) AS price_updated,

      /* --- latest eBay snapshot (if you ran the prefill cron) --- */
      (
        SELECT eps.price::text
        FROM public.ebay_price_snapshots eps
        WHERE eps.scryfall_id = c.id
        ORDER BY eps.fetched_at DESC
        LIMIT 1
      ) AS ebay_usd,
      (
        SELECT eps.url
        FROM public.ebay_price_snapshots eps
        WHERE eps.scryfall_id = c.id
        ORDER BY eps.fetched_at DESC
        LIMIT 1
      ) AS ebay_url

    FROM public.mtg_cards c
    LEFT JOIN public.mtg_prices_effective e ON e.scryfall_id = c.id
    LEFT JOIN public.mtg_prices_scryfall  s ON s.scryfall_id  = c.id
    WHERE c.id::text = ${foundId}
    LIMIT 1
  `);
  const card = rowRes.rows?.[0] ?? null;
  if (!card) {
    try {
      const meta = await db.execute(sql`SELECT current_database() AS db, current_user AS usr`);
      console.error("[MTG detail] notFound: no card row", { rawParam, foundId, db: meta.rows?.[0]?.db, usr: meta.rows?.[0]?.usr });
    } catch {}
    notFound();
  }

  // Optional set info
  const setRow = card.set_code
    ? (
        await db.execute<SetRow>(sql`
          SELECT
            name,
            set_type,
            block,
            COALESCE(TO_CHAR(released_at,'YYYY-MM-DD'), NULL) AS released_at
          FROM public.mtg_sets
          WHERE LOWER(code) = LOWER(${card.set_code})
          LIMIT 1
        `)
      ).rows?.[0] ?? null
    : null;

  // Safe plan gate
  let canSave = false;
  try {
    const { userId } = await auth();
    if (userId) {
      const { limits } = await getUserPlan(userId);
      canSave = (limits.maxItems ?? 0) > 0;
    }
  } catch (err) {
    console.error("[plan gate failed]", err);
  }

  // Safe eBay snapshot trigger (optional fire-and-forget)
  try { await getLatestEbaySnapshot("mtg", card.id, "all"); } catch (err) {
    console.error("[ebay snapshot failed]", err);
  }

  const hero = (card.image_url ?? "").replace(/^http:\/\//, "https://") || null;
  const setHref = card.set_code ? `/categories/mtg/sets/${encodeURIComponent(card.set_code)}` : null;

  const price = {
    usd:        card.usd,
    usd_foil:   card.usd_foil,
    usd_etched: card.usd_etched,
    eur:        card.eur,
    tix:        card.tix,
    updated_at: card.price_updated,
  };

  const hasPrimaryPrice =
    !!price.usd || !!price.usd_foil || !!price.usd_etched || !!price.eur || !!price.tix;

  // Server-side eBay fallback (from snapshots table)
  const serverEbayPrice = card.ebay_usd ? Number(card.ebay_usd) : null;
  const serverEbayUrl = card.ebay_url || null;

  // Strong query for client ebay fetch
  const ebayQ = [
    card.name ?? "",
    (card.set_code || setRow?.name || ""),
    card.collector_number || "",
    "MTG",
  ].filter(Boolean).join(" ");

  return (
    <article className="grid gap-6 md:grid-cols-2">
      {/* image */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-2 overflow-hidden">
        <div className="relative w-full" style={{ aspectRatio: "3 / 4" }}>
          {hero ? (
            <Image
              src={hero}
              alt={card.name ?? card.id}
              fill
              unoptimized
              className="object-contain"
              sizes="(max-width: 768px) 100vw, 50vw"
              priority
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-white/70">No image</div>
          )}
        </div>
      </div>

      {/* details */}
      <div className="grid gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-white/80">
            {setHref ? (
              <>Set: <Link href={setHref} className="text-sky-300 hover:underline">
                {setRow?.name ?? card.set_name ?? card.set_code}
              </Link></>
            ) : null}
            {setRow?.released_at && <span className="ml-2">• Released: {setRow.released_at}</span>}
            {setRow?.set_type && <span className="ml-2">• {setRow.set_type}</span>}
            {setRow?.block && <span className="ml-2">• {setRow.block}</span>}
          </div>
        </div>

        <h1 className="text-2xl font-bold text-white">{card.name ?? card.id}</h1>

        <div className="text-sm text-white/70">
          {[
            card.type_line || undefined,
            card.cmc ? `CMC: ${card.cmc}` : undefined,
            card.rarity || undefined,
            card.collector_number ? `No. ${card.collector_number}` : undefined,
          ].filter(Boolean).join(" • ")}
        </div>

        <ManaCost cost={card.mana_cost} />

      {/* collection tracker */}
<div className="mt-1">
  {canSave ? (
    <AddToCollectionButton
      game="mtg"
      cardId={card.id}
      cardName={card.name}
      setName={setRow?.name ?? card.set_name ?? undefined}
      number={card.collector_number ?? undefined}
      imageUrl={hero ?? undefined}
    />
  ) : (
    <Link href="/pricing" className="inline-block px-3 py-2 rounded bg-amber-500 text-white hover:bg-amber-600">
      Upgrade to track your collection
    </Link>
  )}
</div>

{/* Marketplace CTAs (keep outside of any <Link>) */}
<div className="flex flex-wrap gap-2 pt-2">
  <CardEbayCTA
    card={{
      id: card.id,
      name: card.name ?? "",
      number: card.collector_number ?? undefined,
      set_code: card.set_code ?? undefined,
      set_name: setRow?.name ?? card.set_name ?? undefined,
    }}
    game="Magic The Gathering"
  />
  <CardAmazonCTA
    card={{
      id: card.id,
      name: card.name ?? "",
      number: card.collector_number ?? undefined,
      set_code: card.set_code ?? undefined,
      set_name: setRow?.name ?? card.set_name ?? undefined,
    }}
    game="Magic The Gathering"
  />
</div>


        {/* prices (primary) */}
        {hasPrimaryPrice && (
          <section className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Market Prices</h2>
              <div className="text-xs text-white/60">Updated {price.updated_at ?? "—"}</div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
              <div><div className="text-white/70 text-sm">USD</div><div className="text-white text-lg font-semibold">{price.usd ?? "—"}</div></div>
              <div><div className="text-white/70 text-sm">USD Foil</div><div className="text-white text-lg font-semibold">{price.usd_foil ?? "—"}</div></div>
              <div><div className="text-white/70 text-sm">USD Etched</div><div className="text-white text-lg font-semibold">{price.usd_etched ?? "—"}</div></div>
              <div><div className="text-white/70 text-sm">EUR</div><div className="text-white text-lg font-semibold">{price.eur ?? "—"}</div></div>
              <div><div className="text-white/70 text-sm">TIX</div><div className="text-white text-lg font-semibold">{price.tix ?? "—"}</div></div>
            </div>
          </section>
        )}

        {/* server-side eBay snapshot (if primary missing and snapshot exists) */}
        {!hasPrimaryPrice && serverEbayPrice && (
          <section className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Market Prices (eBay snapshot)</h2>
              <div className="text-xs text-white/60">Latest server snapshot</div>
            </div>
            <div className="text-white text-lg font-semibold">
              ${serverEbayPrice.toFixed(2)} {serverEbayUrl ? (
                <Link href={serverEbayUrl} className="ml-2 text-sky-300 underline" target="_blank">View on eBay</Link>
              ) : null}
            </div>
          </section>
        )}

        {/* client-side eBay fetch only when primary missing (belt & suspenders) */}
        <EbayFallbackPrice
          cardId={card.id}
          q={ebayQ}
          showWhen="missing"
          hasPrimaryPrice={hasPrimaryPrice}
        />

        {card.oracle_text && (
          <section className="rounded-lg border border-white/10 bg-white/5 p-3">
            <h2 className="font-semibold text-white">Rules Text</h2>
            <div className="mt-1 text-sm text-white/85">{nl2p(card.oracle_text)}</div>
          </section>
        )}
      </div>
    </article>
  );
}
