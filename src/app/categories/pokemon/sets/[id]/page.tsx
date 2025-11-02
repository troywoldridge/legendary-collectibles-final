// src/app/categories/pokemon/sets/[id]/page.tsx
import "server-only";
import Link from "next/link";
import Image from "next/image";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------- Types ---------- */
type SetRow = {
  id: string;
  name: string | null;
  series: string | null;
  ptcgo_code: string | null;
  release_date: string | null;
  logo_url: string | null;
  symbol_url: string | null;
};

type CardRow = {
  id: string;
  name: string | null;
  rarity: string | null;
  small_image: string | null;
  large_image: string | null;
};

type SearchParams = Record<string, string | string[] | undefined>;

/* ---------- Helpers ---------- */
const PER_PAGE_OPTIONS = [30, 60, 120, 240] as const;

function parsePerPage(v?: string | string[]) {
  const s = Array.isArray(v) ? v[0] : v;
  const n = Number(s ?? 30);
  return (PER_PAGE_OPTIONS as readonly number[]).includes(n) ? n : 30;
}
function parsePage(v?: string | string[]) {
  const s = Array.isArray(v) ? v[0] : v;
  const n = Number(s ?? 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}
function parseBool(v?: string | string[]) {
  const s = (Array.isArray(v) ? v[0] : v)?.toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}
function buildHref(
  base: string,
  qs: { q?: string | null; page?: number; perPage?: number; rares?: boolean; holo?: boolean }
) {
  const p = new URLSearchParams();
  if (qs.q) p.set("q", qs.q);
  if (qs.page) p.set("page", String(qs.page));
  if (qs.perPage) p.set("perPage", String(qs.perPage));
  if (qs.rares) p.set("rares", "1");
  if (qs.holo) p.set("holo", "1");
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}
function bestCardImg(c: CardRow): string | null {
  if (c.large_image) return c.large_image;
  if (c.small_image) return c.small_image;
  return null;
}

/* ---------- Page ---------- */
export default async function SetDetailPage({
  params,
  searchParams,
}: {
  /** Next 15: both are Promises */
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id: rawId } = await params;
  const sp = await searchParams;

  // URL segment can be: set id (e.g., "sv9") OR a name slug ("White-Flare")
  const setParam = decodeURIComponent(rawId ?? "").trim();
  const nameGuess = setParam.replace(/-/g, " ").trim();
  const likeGuess = `%${nameGuess}%`;
  const baseHref = `/categories/pokemon/sets/${encodeURIComponent(setParam)}`;

  const q = (Array.isArray(sp?.q) ? sp.q[0] : sp?.q)?.trim() || null;
  const perPage = parsePerPage(sp?.perPage);
  const reqPage = parsePage(sp?.page);
  const raresOnly = parseBool(sp?.rares);
  const holoOnly = parseBool(sp?.holo);

  /* 1) Resolve the set (try the view first; then fallback to base table). */
  let setRow: SetRow | undefined;

  try {
    const res = await db.execute<SetRow>(sql`
      SELECT id, name, series, ptcgo_code, release_date, logo_url, symbol_url
      FROM v_tcg_sets_images
      WHERE id = ${setParam}
         OR lower(ptcgo_code) = lower(${setParam})
         OR lower(name) = lower(${nameGuess})
         OR name ILIKE ${likeGuess}
      ORDER BY
        CASE WHEN id = ${setParam} THEN 0
             WHEN lower(ptcgo_code) = lower(${setParam}) THEN 1
             WHEN lower(name) = lower(${nameGuess}) THEN 2
             ELSE 3
        END,
        release_date DESC NULLS LAST
      LIMIT 1
    `);
    setRow = res.rows?.[0];
  } catch {
    // view may not exist; fall through
  }

  if (!setRow) {
    const res = await db.execute<SetRow>(sql`
      SELECT
        id,
        name,
        series,
        ptcgo_code,
        release_date,
        COALESCE(unlimited, logo_url)   AS logo_url,
        COALESCE(expanded,  symbol_url) AS symbol_url
      FROM tcg_sets
      WHERE id = ${setParam}
         OR lower(ptcgo_code) = lower(${setParam})
         OR lower(name) = lower(${nameGuess})
         OR name ILIKE ${likeGuess}
      ORDER BY
        CASE WHEN id = ${setParam} THEN 0
             WHEN lower(ptcgo_code) = lower(${setParam}) THEN 1
             WHEN lower(name) = lower(${nameGuess}) THEN 2
             ELSE 3
        END,
        release_date DESC NULLS LAST
      LIMIT 1
    `);
    setRow = res.rows?.[0];
  }

  if (!setRow) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-bold text-white">Set not found</h1>
        <p className="text-white/70 text-sm break-all">Looked up: <code>{setParam}</code></p>
        <Link href="/categories/pokemon/sets" className="text-sky-300 hover:underline">← Back to all sets</Link>
      </section>
    );
  }

  // Use the canonical set ID we resolved to load cards
  const canonicalSetId = setRow.id;

  /* --- Card filters --- */
  const conditions = [sql`set_id = ${canonicalSetId}`];
  if (q) {
    conditions.push(
      sql`(name ILIKE ${"%" + q + "%"} OR rarity ILIKE ${"%" + q + "%"} OR id ILIKE ${"%" + q + "%"})`
    );
  }
  if (raresOnly && holoOnly) {
    conditions.push(sql`(rarity ILIKE '%Rare%' AND (rarity ILIKE '%Holo%' OR rarity ILIKE '%Foil%'))`);
  } else if (raresOnly) {
    conditions.push(sql`(rarity ILIKE '%Rare%')`);
  } else if (holoOnly) {
    conditions.push(sql`(rarity ILIKE '%Holo%' OR rarity ILIKE '%Foil%')`);
  }
  const whereSql = sql.join(conditions, sql` AND `);

  /* Count + page slice */
  const total: number =
    (
      await db.execute<{ count: number }>(
        sql`SELECT COUNT(*)::int AS count FROM tcg_cards WHERE ${whereSql}`
      )
    ).rows?.[0]?.count ?? 0;

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(totalPages, reqPage);
  const safeOffset = (safePage - 1) * perPage;

  const cards =
    (
      await db.execute<CardRow>(sql`
        SELECT id, name, rarity, small_image, large_image
        FROM tcg_cards
        WHERE ${whereSql}
        ORDER BY name ASC NULLS LAST, id ASC
        LIMIT ${perPage} OFFSET ${safeOffset}
      `)
    ).rows ?? [];

  const from = total === 0 ? 0 : safeOffset + 1;
  const to = Math.min(safeOffset + perPage, total);

  /* ---------- UI ---------- */
  const banner = setRow.logo_url || setRow.symbol_url || null;
  const subtitleParts = [
    setRow.series ?? undefined,
    setRow.ptcgo_code ? `PTCGO: ${setRow.ptcgo_code}` : undefined,
    setRow.release_date ? `Released: ${setRow.release_date}` : undefined,
  ].filter(Boolean);
  const subtitle = subtitleParts.join(" • ");

  return (
    <section className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <div className="relative h-20 w-36 shrink-0 rounded-lg bg-white/5 ring-1 ring-white/10 overflow-hidden">
            {banner ? (
              <Image
                src={banner}
                alt={setRow.name ?? setParam}
                fill
                unoptimized
                className="object-contain"
                sizes="144px"
                priority
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-white/60 text-xs">
                No image
              </div>
            )}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">{setRow.name ?? setParam}</h1>
            {subtitle && <div className="text-sm text-white/80">{subtitle}</div>}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <Link
            href={`${baseHref}/prices`}
            className="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
          >
            View price overview →
          </Link>
          <Link href="/categories/pokemon/sets" className="text-sky-300 hover:underline">
            ← All sets
          </Link>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-white/80">
          Showing {from}-{to} of {total} cards
          {(q || raresOnly || holoOnly) && <span> (filtered)</span>}
        </div>

        <div className="flex flex-wrap gap-3">
          {/* Per page */}
          <form action={baseHref} method="get" className="flex items-center gap-2">
            {q ? <input type="hidden" name="q" value={q} /> : null}
            {raresOnly ? <input type="hidden" name="rares" value="1" /> : null}
            {holoOnly ? <input type="hidden" name="holo" value="1" /> : null}
            <input type="hidden" name="page" value="1" />
            <label htmlFor="pp" className="sr-only">Per page</label>
            <select id="pp" name="perPage" defaultValue={String(perPage)}
              className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-white">
              {PER_PAGE_OPTIONS.map((n) => (<option key={n} value={n}>{n}</option>))}
            </select>
            <button type="submit" className="rounded-md border border-white/20 bg-white/10 px-2.5 py-1 text-white hover:bg-white/20">
              Apply
            </button>
          </form>

          {/* Search within set */}
          <form action={baseHref} method="get" className="flex items-center gap-2">
            {raresOnly ? <input type="hidden" name="rares" value="1" /> : null}
            {holoOnly ? <input type="hidden" name="holo" value="1" /> : null}
            <input type="hidden" name="perPage" value={String(perPage)} />
            <input type="hidden" name="page" value="1" />
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search cards (name/rarity/id)…"
              className="w-[240px] md:w-[320px] rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-white/50"
            />
            <button type="submit" className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20">
              Search
            </button>
            {q && (
              <Link
                href={buildHref(baseHref, { perPage, page: 1, rares: raresOnly, holo: holoOnly })}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white hover:bg-white/15"
              >
                Clear
              </Link>
            )}
          </form>

          {/* Toggles */}
          <form action={baseHref} method="get" className="flex items-center gap-3">
            {q ? <input type="hidden" name="q" value={q} /> : null}
            <input type="hidden" name="perPage" value={String(perPage)} />
            <input type="hidden" name="page" value="1" />
            <label className="inline-flex items-center gap-2 text-sm text-white/90">
              <input type="checkbox" name="rares" value="1" defaultChecked={raresOnly} />
              Rares+
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-white/90">
              <input type="checkbox" name="holo" value="1" defaultChecked={holoOnly} />
              Holo only
            </label>
            <button type="submit" className="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20">
              Apply
            </button>
          </form>
        </div>
      </div>

      {/* Cards grid */}
      {cards.length === 0 ? (
        <div className="rounded-xl border border-white/15 bg-white/5 p-6 text-white/90 backdrop-blur-sm">
          {q || raresOnly || holoOnly ? "No cards matched your filters." : "No cards found in this set."}
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {cards.map((c) => {
            const img = bestCardImg(c);
            return (
              <li
                key={c.id}
                className="rounded-xl border border-white/10 bg-white/5 overflow-hidden backdrop-blur-sm hover:bg-white/10 hover:border-white/20 transition"
              >
                <Link href={`/categories/pokemon/cards/${encodeURIComponent(c.id)}`} className="block">
                  <div className="relative w-full" style={{ aspectRatio: "3 / 4" }}>
                    {img ? (
                      <Image
                        src={img}
                        alt={c.name ?? c.id}
                        fill
                        unoptimized
                        className="object-contain"
                        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                      />
                    ) : (
                      <div className="absolute inset-0 grid place-items-center text-white/70">No image</div>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="line-clamp-2 text-sm font-medium text-white">{c.name ?? c.id}</div>
                    <div className="mt-1 text-xs text-white/80">{c.rarity ?? ""}</div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {/* Pagination */}
      {total > perPage && (
        <nav className="mt-4 flex items-center justify-center gap-2 text-sm">
          <Link
            href={buildHref(baseHref, { q, perPage, rares: raresOnly, holo: holoOnly, page: Math.max(1, safePage - 1) })}
            aria-disabled={safePage === 1}
            className={`rounded-md border px-3 py-1 ${
              safePage === 1
                ? "pointer-events-none border-white/10 text-white/40"
                : "border-white/20 text-white hover:bg-white/10"
            }`}
          >
            ← Prev
          </Link>
          <span className="px-2 text-white/80">
            Page {safePage} of {totalPages}
          </span>
          <Link
            href={buildHref(baseHref, { q, perPage, rares: raresOnly, holo: holoOnly, page: safePage + 1 })}
            aria-disabled={safeOffset + perPage >= total}
            className={`rounded-md border px-3 py-1 ${
              safeOffset + perPage >= total
                ? "pointer-events-none border-white/10 text-white/40"
                : "border-white/20 text-white hover:bg-white/10"
            }`}
          >
            Next →
          </Link>
        </nav>
      )}
    </section>
  );
}
