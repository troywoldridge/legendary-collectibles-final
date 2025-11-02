import "server-only";
import Link from "next/link";
import Image from "next/image";
import { CF_ACCOUNT_HASH } from "@/lib/cf";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------- Types ---------- */
type SetRow = {
  id: string;              // canonical set_code
  name: string | null;     // set_name
  series: string | null;   // (YGO: null)
  ptcgo_code?: string | null; // (YGO: null)
  release_date: string | null; // (YGO: null)
  logo_url: string | null; // sample small image
  symbol_url: string | null; // sample large image
};

type ItemRow = {
  id: string;              // ygo_cards.card_id
  name: string | null;
  rarity: string | null;   // ygo_card_sets.set_rarity
  small_image: string | null;
  large_image: string | null;
};

type SearchParams = Record<string, string | string[] | undefined>;

/* ---------- Constants / helpers ---------- */
const CATEGORY = {
  label: "Yu-Gi-Oh!",
  baseListHref: "/categories/yugioh/sets",
  bannerCfId: "87101a20-6ada-4b66-0057-2d210feb9d00",
};

const PER_PAGE_OPTIONS = [30, 60, 120, 240] as const;

const cfImageUrl = (id: string, variant = "categoryThumb") =>
  `https://imagedelivery.net/${CF_ACCOUNT_HASH}/${id}/${variant}`;

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
function bestImg(i: ItemRow): string | null {
  if (i.large_image) return i.large_image;
  if (i.small_image) return i.small_image;
  return null;
}

/* ---------- Real data ---------- */
async function getSet(param: string): Promise<SetRow | null> {
  const nameGuess = param.replace(/-/g, " ").trim();
  const likeGuess = `%${nameGuess}%`;

  const row =
    (
      await db.execute<SetRow>(sql`
        WITH base AS (
          SELECT
            s.set_code AS id,
            MIN(s.set_name) AS name,
            NULL::text AS series,
            NULL::text AS ptcgo_code,
            NULL::text AS release_date,
            MIN(img.image_url_small) AS logo_url,
            MIN(img.image_url)       AS symbol_url
          FROM ygo_card_sets s
          LEFT JOIN ygo_card_images img ON img.card_id = s.card_id
          WHERE s.set_code = ${param}
             OR lower(s.set_name) = lower(${nameGuess})
             OR s.set_name ILIKE ${likeGuess}
          GROUP BY s.set_code
        )
        SELECT *
        FROM base
        ORDER BY
          CASE WHEN id = ${param} THEN 0
               WHEN lower(name) = lower(${nameGuess}) THEN 1
               ELSE 2
          END,
          name ASC NULLS LAST
        LIMIT 1
      `)
    ).rows?.[0] ?? null;

  return row;
}

async function getItems(_opts: {
  setId: string;           // canonical set_code
  q: string | null;
  offset: number;
  limit: number;
  raresOnly: boolean;
  holoOnly: boolean;
}): Promise<{ rows: ItemRow[]; total: number }> {
  const conds = [sql`s.set_code = ${_opts.setId}`];
  if (_opts.q) {
    const like = `%${_opts.q}%`;
    conds.push(sql`(c.name ILIKE ${like} OR c.card_id ILIKE ${like})`);
  }
  if (_opts.raresOnly && _opts.holoOnly) {
    conds.push(sql`(s.set_rarity ILIKE '%Rare%' AND (s.set_rarity ILIKE '%Holo%' OR s.set_rarity ILIKE '%Foil%'))`);
  } else if (_opts.raresOnly) {
    conds.push(sql`(s.set_rarity ILIKE '%Rare%')`);
  } else if (_opts.holoOnly) {
    conds.push(sql`(s.set_rarity ILIKE '%Holo%' OR s.set_rarity ILIKE '%Foil%')`);
  }
  const whereSql = sql.join(conds, sql` AND `);

  const total =
    (
      await db.execute<{ count: number }>(sql`
        SELECT COUNT(DISTINCT c.card_id)::int AS count
        FROM ygo_cards c
        JOIN ygo_card_sets s ON s.card_id = c.card_id
        WHERE ${whereSql}
      `)
    ).rows?.[0]?.count ?? 0;

  const rows =
    (
      await db.execute<ItemRow>(sql`
        SELECT
          c.card_id AS id,
          c.name,
          MIN(s.set_rarity) AS rarity,
          COALESCE(MIN(img.image_url_small), MIN(img.image_url)) AS small_image,
          COALESCE(MIN(img.image_url), MIN(img.image_url_small)) AS large_image
        FROM ygo_cards c
        JOIN ygo_card_sets s ON s.card_id = c.card_id
        LEFT JOIN ygo_card_images img ON img.card_id = c.card_id
        WHERE ${whereSql}
        GROUP BY c.card_id, c.name
        ORDER BY c.name ASC NULLS LAST, c.card_id ASC
        LIMIT ${_opts.limit} OFFSET ${_opts.offset}
      `)
    ).rows ?? [];

  return { rows, total };
}

/* ---------- Page ---------- */
export default async function YugiohSetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id: rawId } = await params;
  const sp = await searchParams;

  const setParam = decodeURIComponent(rawId ?? "").trim();

  // Resolve the set (so we can use canonical set_code for queries)
  const setRow = await getSet(setParam);
  const canonicalSetId = setRow?.id ?? setParam;

  const baseHref = `${CATEGORY.baseListHref}/${encodeURIComponent(canonicalSetId)}`;

  const q = (Array.isArray(sp?.q) ? sp.q[0] : sp?.q)?.trim() || null;
  const perPage = parsePerPage(sp?.perPage);
  const reqPage = parsePage(sp?.page);
  const raresOnly = parseBool(sp?.rares);
  const holoOnly = parseBool(sp?.holo);

  const { rows, total } = await getItems({
    setId: canonicalSetId,
    q,
    offset: (reqPage - 1) * perPage,
    limit: perPage,
    raresOnly,
    holoOnly,
  });

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(totalPages, reqPage);
  const offset = (page - 1) * perPage;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + perPage, total);

  const banner =
    setRow?.logo_url || setRow?.symbol_url || cfImageUrl(CATEGORY.bannerCfId);

  return (
    <section className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <div className="relative h-20 w-36 shrink-0 rounded-lg bg-white/5 ring-1 ring-white/10 overflow-hidden">
            <Image
              src={banner}
              alt={setRow?.name ?? canonicalSetId}
              fill
              unoptimized
              className="object-contain"
              sizes="144px"
              priority
            />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">
              {CATEGORY.label}: {setRow?.name ?? canonicalSetId}
            </h1>
            <div className="text-sm text-white/80">
              Set browser & card index
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <Link href={`${baseHref}/prices`} className="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20">
            View price overview →
          </Link>
          <Link href={CATEGORY.baseListHref} className="text-sky-300 hover:underline">
            ← All {CATEGORY.label} sets
          </Link>
          <Link href="/categories" className="text-sky-300 hover:underline">
            ← All categories
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
            <button type="submit" className="rounded-md border border-white/20 bg-white/10 px-2.5 py-1 text-white hover:bg-white/20">Apply</button>
          </form>

          {/* Search */}
          <form action={baseHref} method="get" className="flex items-center gap-2">
            {raresOnly ? <input type="hidden" name="rares" value="1" /> : null}
            {holoOnly ? <input type="hidden" name="holo" value="1" /> : null}
            <input type="hidden" name="perPage" value={String(perPage)} />
            <input type="hidden" name="page" value="1" />
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search cards (name/id)…"
              className="w-[240px] md:w-[320px] rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-white/50"
            />
            <button type="submit" className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20">Search</button>
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
      {rows.length === 0 ? (
        <div className="rounded-xl border border-white/15 bg-white/5 p-6 text-white/90 backdrop-blur-sm">
          {q || raresOnly || holoOnly ? "No cards matched your filters." : "No cards found in this set yet."}
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {rows.map((c) => {
            const img = bestImg(c);
            return (
              <li key={c.id} className="rounded-xl border border-white/10 bg-white/5 overflow-hidden backdrop-blur-sm hover:bg-white/10 hover:border-white/20 transition">
                <Link href={`/categories/yugioh/cards/${encodeURIComponent(c.id)}`} className="block">
                  <div className="relative w-full" style={{ aspectRatio: "3 / 4" }}>
                    {img ? (
                      <Image src={img} alt={c.name ?? c.id} fill unoptimized className="object-contain"
                        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw" />
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
            href={buildHref(baseHref, { q, perPage, rares: raresOnly, holo: holoOnly, page: Math.max(1, page - 1) })}
            aria-disabled={page === 1}
            className={`rounded-md border px-3 py-1 ${page === 1 ? "pointer-events-none border-white/10 text-white/40" : "border-white/20 text-white hover:bg-white/10"}`}
          >
            ← Prev
          </Link>
          <span className="px-2 text-white/80">Page {page} of {totalPages}</span>
          <Link
            href={buildHref(baseHref, { q, perPage, rares: raresOnly, holo: holoOnly, page: page + 1 })}
            aria-disabled={offset + perPage >= total}
            className={`rounded-md border px-3 py-1 ${offset + perPage >= total ? "pointer-events-none border-white/10 text-white/40" : "border-white/20 text-white hover:bg-white/10"}`}
          >
            Next →
          </Link>
        </nav>
      )}
    </section>
  );
}
