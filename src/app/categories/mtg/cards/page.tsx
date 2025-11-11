import "server-only";
import Link from "next/link";
import Image from "next/image";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { unstable_noStore as noStore } from "next/cache";
import CardAmazonCTA from "@/components/CardAmazonCTA";
import CardEbayCTA from "@/components/CardEbayCTA";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------------- Types ---------------- */
type SearchParams = Record<string, string | string[] | undefined>;

type CardThumb = {
  id: string;
  name: string | null;
  number: string | null;       // collector_number
  image_url: string | null;    // derived
  set_code: string | null;
  rarity: string | null;
  type_line: string | null;
  price_usd: string | null;
  price_updated: string | null;
};

/* ---------------- UI Constants ---------------- */
const PER_PAGE_OPTIONS = [30, 60, 120, 240] as const;
const COLOR_OPTS = ["White", "Blue", "Black", "Red", "Green", "Colorless"] as const;
const TYPE_OPTS = ["Artifact","Creature","Enchantment","Instant","Land","Planeswalker","Sorcery","Tribal"] as const;
const RARITY_UI = ["Common","Uncommon","Rare","Mythic Rare","Special","Basic Land"] as const;

const RARITY_MAP: Record<(typeof RARITY_UI)[number], string> = {
  Common: "common",
  Uncommon: "uncommon",
  Rare: "rare",
  "Mythic Rare": "mythic",
  Special: "special",
  "Basic Land": "basic",
};
const COLOR_CODE: Record<(typeof COLOR_OPTS)[number], string> = {
  White: "W", Blue: "U", Black: "B", Red: "R", Green: "G", Colorless: "",
};

/* ---------------- Helpers ---------------- */
// take the LAST value if an array shows up (clicked submit button is last)
function lastVal(v?: string | string[]) {
  if (Array.isArray(v)) return v[v.length - 1];
  return v;
}
function parsePerPage(sp: SearchParams) {
  // prefer new name "pp", fall back to legacy "perPage"
  const raw = lastVal(sp?.pp) ?? lastVal(sp?.perPage);
  const n = Number(raw ?? 60);
  return (PER_PAGE_OPTIONS as readonly number[]).includes(n) ? n : 60;
}
function parsePage(sp: SearchParams) {
  // prefer new name "p", fall back to legacy "page"
  const raw = lastVal(sp?.p) ?? lastVal(sp?.page);
  const n = Number(raw ?? 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}
function parseMulti(sp: SearchParams, key: string): string[] {
  const raw = sp?.[key];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
}

// Build URLs using ONLY the new keys (p, pp)
function buildHref(
  base: string,
  qs: {
    q?: string | null;
    set?: string | null;
    p?: number;
    pp?: number;
    color?: string[];
    type?: string[];
    rarity?: string[];
    debug?: boolean;
  }
) {
  const p = new URLSearchParams();
  if (qs.q != null && qs.q !== "") p.set("q", String(qs.q));
  if (qs.set != null && qs.set !== "") p.set("set", String(qs.set));
  p.set("p", String(qs.p ?? 1));
  p.set("pp", String(qs.pp ?? 60));
  (qs.color ?? []).forEach((c) => p.append("color", c));
  (qs.type ?? []).forEach((t) => p.append("type", t));
  (qs.rarity ?? []).forEach((r) => p.append("rarity", r));
  if (qs.debug) p.set("debug", "1");
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

function orJoin(parts: any[]) {
  if (!parts.length) return sql`TRUE`;
  let expr = parts[0];
  for (let k = 1; k < parts.length; k++) expr = sql`${expr} OR ${parts[k]}`;
  return sql`(${expr})`;
}
const fmt = (s?: string | null) => (s == null ? null : Number(s).toFixed(2));

/* ---------------- Data ---------------- */
async function getCards(opts: {
  q: string | null;
  set: string | null;
  colors: string[];
  types: string[];
  rarities: string[];
  offset: number;
  limit: number;
}): Promise<{ rows: CardThumb[]; total: number }> {
  noStore();

  const like = opts.q ? `%${opts.q}%` : null;

  let where = sql`TRUE`;
  if (like) where = sql`${where} AND (c.name ILIKE ${like} OR c.collector_number ILIKE ${like} OR c.type_line ILIKE ${like})`;
  if (opts.set) where = sql`${where} AND (c.set_code ILIKE ${opts.set})`;
  if (opts.rarities.length) {
    const vals = opts.rarities.map((r) => RARITY_MAP[r as keyof typeof RARITY_MAP] || r).map((r) => r.toLowerCase());
    const rParts = vals.map((r) => sql`LOWER(c.rarity) = ${r}`);
    where = sql`${where} AND ${orJoin(rParts)}`;
  }
  if (opts.types.length) {
    const tParts = opts.types.map((t) => sql`c.type_line ILIKE ${"%" + t + "%"}`);
    where = sql`${where} AND ${orJoin(tParts)}`;
  }
  if (opts.colors.length) {
    const colorParts = opts.colors.map((ui) => {
      if (ui === "Colorless") return sql`COALESCE(c.colors,'[]'::jsonb) = '[]'::jsonb`;
      const code = COLOR_CODE[ui as keyof typeof COLOR_CODE];
      return sql`COALESCE(c.colors,'[]'::jsonb) ? ${code}`;
    });
    where = sql`${where} AND ${orJoin(colorParts)}`;
  }

  const totalRes = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM public.mtg_cards c
    WHERE ${where}
  `);
  const total = Number(totalRes.rows?.[0]?.count ?? "0");

  const rowsRes = await db.execute<CardThumb>(sql`
    SELECT
      c.id,
      c.name,
      c.collector_number AS number,
      c.set_code,
      c.rarity,
      c.type_line,
      COALESCE(
        c.image_uris->>'normal',
        c.image_uris->>'large',
        c.image_uris->>'small',
        (c.card_faces_raw->0->'image_uris'->>'normal'),
        (c.card_faces_raw->0->'image_uris'->>'large'),
        (c.card_faces_raw->0->'image_uris'->>'small')
      ) AS image_url,
      COALESCE(e.effective_usd, s.usd)::text AS price_usd,
      COALESCE(
        TO_CHAR(e.effective_updated_at,'YYYY-MM-DD'),
        TO_CHAR(s.updated_at,'YYYY-MM-DD')
      ) AS price_updated
    FROM public.mtg_cards c
    LEFT JOIN public.mtg_prices_effective e ON e.scryfall_id = c.id
    LEFT JOIN public.mtg_prices_scryfall  s ON s.scryfall_id  = c.id
    WHERE ${where}
    ORDER BY c.name ASC NULLS LAST
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `);

  return { rows: rowsRes.rows ?? [], total };
}

/* ---------------- Page ---------------- */
export default async function MtgCardsIndex({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams; // Promise in Next 15
  const baseHref = "/categories/mtg/cards";

  const q = (lastVal(sp?.q) ?? "")?.trim() || null;
  const set = (lastVal(sp?.set) ?? "")?.trim() || null;
  const perPage = parsePerPage(sp);
  const reqPage = parsePage(sp);

  const selColors = parseMulti(sp, "color").filter((c) => (COLOR_OPTS as readonly string[]).includes(c));
  const selTypes = parseMulti(sp, "type").filter((t) => (TYPE_OPTS as readonly string[]).includes(t));
  const selRarities = parseMulti(sp, "rarity").filter((r) => (RARITY_UI as readonly string[]).includes(r));

  const { rows, total } = await getCards({
    q, set, colors: selColors, types: selTypes, rarities: selRarities,
    offset: (reqPage - 1) * perPage,
    limit: perPage,
  });

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.max(1, Math.min(totalPages, reqPage));
  const offset = (page - 1) * perPage;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + perPage, total);
  const isFirst = page <= 1;
  const isLast = page >= totalPages;

  const filterCount = selColors.length + selTypes.length + selRarities.length;
  const filtersOpen = filterCount > 0;

  const debug = lastVal(sp?.debug) === "1";

  return (
    <section
      key={[
        q ?? "", set ?? "", perPage, reqPage,
        selColors.join(","), selTypes.join(","), selRarities.join(","),
      ].join("|")}
      className="space-y-6"
    >
      {debug && (
        <pre className="text-xs whitespace-pre-wrap rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2 text-yellow-200">
{JSON.stringify({ q, set, perPage, reqPage, page, total, totalPages, selColors, selTypes, selRarities }, null, 2)}
        </pre>
      )}

      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Magic: The Gathering • Cards</h1>
          <div className="text-sm text-white/80">Search all MTG cards across sets. Filter by color, type, and rarity.</div>
        </div>
        <Link href="/categories/mtg/sets" className="text-sky-300 hover:underline" prefetch={false}>
          ← Browse sets
        </Link>
      </div>

      {/* Top bar: results + per-page */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-white/80">
          Showing {from}-{to} of {total} cards
          {q ? ` • “${q}”` : ""}{set ? ` • set: ${set}` : ""}
          {filterCount ? ` • ${filterCount} filter${filterCount > 1 ? "s" : ""}` : ""}
        </div>

        {/* Per-page control as GET form; resets to first page */}
        <form action={baseHref} method="get" className="flex items-center gap-2">
          {q ? <input type="hidden" name="q" value={q} /> : null}
          {set ? <input type="hidden" name="set" value={set} /> : null}
          {selColors.map((v) => <input key={`c-${v}`} type="hidden" name="color" value={v} />)}
          {selTypes.map((v) => <input key={`t-${v}`} type="hidden" name="type" value={v} />)}
          {selRarities.map((v) => <input key={`r-${v}`} type="hidden" name="rarity" value={v} />)}
          <input type="hidden" name="p" value="1" />
          <label htmlFor="pp" className="sr-only">Per page</label>
          <select
            id="pp"
            name="pp"
            defaultValue={String(perPage)}
            className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-white"
          >
            {PER_PAGE_OPTIONS.map((n) => (<option key={n} value={n}>{n}</option>))}
          </select>
          <button type="submit" className="rounded-md border border-white/20 bg-white/10 px-2.5 py-1 text-white hover:bg-white/20">
            Apply
          </button>

          {/* Quick picks */}
          <div className="hidden sm:flex items-center gap-2 pl-2">
            {[30, 60, 120, 240].map((n) => (
              <a
                key={`pp-${n}`}
                href={buildHref(baseHref, { q, set, color: selColors, type: selTypes, rarity: selRarities, p: 1, pp: n })}
                className={`rounded-md border px-2.5 py-1 text-sm ${
                  perPage === n ? "border-white/40 text-white" : "border-white/20 text-white/80 hover:bg-white/10"
                }`}
              >
                {n}
              </a>
            ))}
          </div>
        </form>
      </div>

      {/* Search + Filters */}
      <form action={baseHref} method="get" className="rounded-xl border border-white/10 bg-white/5 p-3">
        <input type="hidden" name="pp" value={String(perPage)} />
        <input type="hidden" name="p" value="1" />

        <div className="flex flex-wrap items-center gap-2">
          <input name="q" defaultValue={q ?? ""} placeholder="Search name / number / type…" className="w-60 md:w-[320px] rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-white/50" />
          <input name="set" defaultValue={set ?? ""} placeholder="Set code (e.g. SOI)" className="w-[140px] rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-white/50" />
          <button type="submit" className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20">Search</button>

          {(q || set || filterCount) ? (
            <a href={buildHref(baseHref, { pp: perPage, p: 1 })} className="ml-auto rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white hover:bg-white/15">
              Clear
            </a>
          ) : null}

          <details className="relative ml-auto sm:ml-2" open={filtersOpen}>
            <summary className="list-none inline-flex cursor-pointer select-none items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20">
              Filters
              {filterCount > 0 && (<span className="rounded-full bg-white/20 px-1.5 text-xs">{filterCount}</span>)}
            </summary>

            <div className="z-10 mt-2 w-[min(92vw,900px)] rounded-xl border border-white/10 bg-black/60 p-4 backdrop-blur-md shadow-2xl">
              <div className="grid gap-4">
                <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                  <legend className="col-span-full text-xs uppercase tracking-wide text-white/60">Colors</legend>
                  {COLOR_OPTS.map((c) => (
                    <label key={c} className="flex items-center gap-2 text-sm text-white/90">
                      <input type="checkbox" name="color" value={c} defaultChecked={selColors.includes(c)} className="h-4 w-4 rounded border-white/30 bg-transparent" />
                      <span>{c}</span>
                    </label>
                  ))}
                </fieldset>

                <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-8">
                  <legend className="col-span-full text-xs uppercase tracking-wide text-white/60">Types</legend>
                  {TYPE_OPTS.map((t) => (
                    <label key={t} className="flex items-center gap-2 text-sm text-white/90">
                      <input type="checkbox" name="type" value={t} defaultChecked={selTypes.includes(t)} className="h-4 w-4 rounded border-white/30 bg-transparent" />
                      <span>{t}</span>
                    </label>
                  ))}
                </fieldset>

                <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                  <legend className="col-span-full text-xs uppercase tracking-wide text-white/60">Rarities</legend>
                  {RARITY_UI.map((r) => (
                    <label key={r} className="flex items-center gap-2 text-sm text-white/90">
                      <input type="checkbox" name="rarity" value={r} defaultChecked={selRarities.includes(r)} className="h-4 w-4 rounded border-white/30 bg-transparent" />
                      <span>{r}</span>
                    </label>
                  ))}
                </fieldset>
              </div>
            </div>
          </details>
        </div>
      </form>

      {/* Grid */}
      {rows.length === 0 ? (
        <div className="rounded-xl border border-white/15 bg-white/5 p-6 text-white/90 backdrop-blur-sm">No cards found. Try different filters.</div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {rows.map((c) => {
            const img = (c.image_url ?? "").replace(/^http:\/\//, "https://") || "/placeholder.svg";
            const href = `/categories/mtg/cards/${encodeURIComponent(c.id)}`;
            const price = fmt(c.price_usd);

            return (
              <li key={c.id} className="rounded-xl border border-white/10 bg-white/5 overflow-hidden hover:bg-white/10 hover:border-white/20 transition">
                {/* Card (image + text) */}
                <Link href={href} className="block" prefetch={false}>
                  <div className="relative w-full" style={{ aspectRatio: "3 / 4" }}>
                    <Image
                      src={img}
                      alt={c.name ?? c.id}
                      fill
                      unoptimized
                      className="object-contain"
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                    />
                  </div>
                  <div className="p-3">
                    <div className="line-clamp-2 text-sm font-medium text-white">{c.name ?? c.id}</div>
                    <div className="mt-1 text-xs text-white/70">
                      {[c.set_code || undefined, c.number || undefined, c.rarity || undefined].filter(Boolean).join(" • ")}
                    </div>
                    <div className="mt-1 text-xs text-white/60">
                      {price ? `$${price}` : "—"}{c.price_updated ? ` • ${c.price_updated}` : ""}
                    </div>
                    <div className="mt-0.5 text-[11px] text-white/60 line-clamp-1">{c.type_line ?? ""}</div>
                  </div>
                </Link>

                {/* Market CTAs (outside the Link to avoid nested anchors) */}
                <div className="px-3 pb-3 pt-0 flex items-center justify-end gap-2">
                  <CardEbayCTA
                    card={{
                      id: c.id,
                      name: c.name ?? c.id,
                      number: c.number,
                      set_code: c.set_code ?? null,
                      set_name: null,
                    }}
                    game="Magic The Gathering"
                    compact
                  />
                  <CardAmazonCTA
                    card={{
                      id: c.id,
                      name: c.name ?? c.id,
                      number: c.number,
                      set_code: c.set_code ?? null,
                      set_name: null,
                    }}
                    game="Magic The Gathering"
                    compact
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Pager */}
      {total > perPage && (
        <form action={baseHref} method="get" className="mt-4 flex items-center justify-center gap-2 text-sm">
          {q ? <input type="hidden" name="q" value={q} /> : null}
          {set ? <input type="hidden" name="set" value={set} /> : null}
          <input type="hidden" name="pp" value={String(perPage)} />
          {selColors.map((v) => <input key={`pc-${v}`} type="hidden" name="color" value={v} />)}
          {selTypes.map((v) => <input key={`pt-${v}`} type="hidden" name="type" value={v} />)}
          {selRarities.map((v) => <input key={`pr-${v}`} type="hidden" name="rarity" value={v} />)}

          <button type="submit" name="p" value="1" disabled={isFirst}
            className={`rounded-md border px-3 py-1 ${isFirst ? "pointer-events-none border-white/10 text-white/40" : "border-white/20 text-white hover:bg-white/10"}`}>
            « First
          </button>

          <button type="submit" name="p" value={String(Math.max(1, page - 1))} disabled={isFirst}
            className={`rounded-md border px-3 py-1 ${isFirst ? "pointer-events-none border-white/10 text-white/40" : "border-white/20 text-white hover:bg-white/10"}`}>
            ← Prev
          </button>

          <span className="px-2 text-white/80">Page {page} of {totalPages}</span>

          <button type="submit" name="p" value={String(Math.min(totalPages, page + 1))} disabled={isLast}
            className={`rounded-md border px-3 py-1 ${isLast ? "pointer-events-none border-white/10 text-white/40" : "border-white/20 text-white hover:bg-white/10"}`}>
            Next →
          </button>

          <button type="submit" name="p" value={String(totalPages)} disabled={isLast}
            className={`rounded-md border px-3 py-1 ${isLast ? "pointer-events-none border-white/10 text-white/40" : "border-white/20 text-white hover:bg-white/10"}`}>
            Last »
          </button>
        </form>
      )}
    </section>
  );
}
