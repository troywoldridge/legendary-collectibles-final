import "server-only";
import Link from "next/link";
import Image from "next/image";
import { CF_ACCOUNT_HASH } from "@/lib/cf";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

type SetItem = {
  id: string;               // set_code
  name: string | null;      // set_name
  series: string | null;    // (YGO: null)
  release_date: string | null; // (YGO: null)
  logo_url: string | null;  // sample image small
  symbol_url: string | null; // sample image large
};

const CATEGORY = {
  label: "Yu-Gi-Oh!",
  baseHref: "/categories/yugioh/sets",
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
function buildHref(base: string, qs: { q?: string | null; page?: number; perPage?: number }) {
  const p = new URLSearchParams();
  if (qs.q) p.set("q", qs.q);
  if (qs.page) p.set("page", String(qs.page));
  if (qs.perPage) p.set("perPage", String(qs.perPage));
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

/* ---------- Real data ---------- */
async function getSets(_opts: { q: string | null; offset: number; limit: number }): Promise<{
  rows: SetItem[];
  total: number;
}> {
  const whereParts = [sql`1=1`];
  if (_opts.q) {
    const like = `%${_opts.q}%`;
    whereParts.push(sql`(s.set_code ILIKE ${like} OR s.set_name ILIKE ${like})`);
  }
  const whereSql = sql.join(whereParts, sql` AND `);

  // total distinct set codes
  const total =
    (
      await db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM (
          SELECT DISTINCT s.set_code
          FROM ygo_card_sets s
          WHERE ${whereSql}
        ) t
      `)
    ).rows?.[0]?.count ?? 0;

  // page slice with a sample image
  const rows =
    (
      await db.execute<SetItem>(sql`
        SELECT
          s.set_code AS id,
          MIN(s.set_name) AS name,
          NULL::text AS series,
          NULL::text AS release_date,
          MIN(img.image_url_small) AS logo_url,
          MIN(img.image_url)       AS symbol_url
        FROM ygo_card_sets s
        LEFT JOIN ygo_card_images img ON img.card_id = s.card_id
        WHERE ${whereSql}
        GROUP BY s.set_code
        ORDER BY MIN(s.set_name) ASC NULLS LAST, s.set_code ASC
        LIMIT ${_opts.limit} OFFSET ${_opts.offset}
      `)
    ).rows ?? [];

  return { rows, total };
}

export default async function YugiohSetsIndex({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const baseHref = CATEGORY.baseHref;

  const q = (Array.isArray(sp?.q) ? sp.q[0] : sp?.q)?.trim() || null;
  const perPage = parsePerPage(sp?.perPage);
  const reqPage = parsePage(sp?.page);

  const { rows, total } = await getSets({
    q,
    offset: (reqPage - 1) * perPage,
    limit: perPage,
  });

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(totalPages, reqPage);
  const offset = (page - 1) * perPage;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + perPage, total);

  const banner = cfImageUrl(CATEGORY.bannerCfId);

  return (
    <section className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <div className="relative h-20 w-36 shrink-0 rounded-lg bg-white/5 ring-1 ring-white/10 overflow-hidden">
            <Image
              src={banner}
              alt={CATEGORY.label}
              fill
              unoptimized
              className="object-contain"
              sizes="144px"
              priority
            />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">{CATEGORY.label} • Sets</h1>
            <div className="text-sm text-white/80">Browse sets and jump into card galleries.</div>
          </div>
        </div>

        <Link href="/categories" className="text-sky-300 hover:underline">← All categories</Link>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-white/80">
          Showing {from}-{to} of {total} sets{q ? " (filtered)" : ""}
        </div>

        <div className="flex flex-wrap gap-3">
          {/* Per page */}
          <form action={baseHref} method="get" className="flex items-center gap-2">
            {q ? <input type="hidden" name="q" value={q} /> : null}
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

          {/* Search */}
          <form action={baseHref} method="get" className="flex items-center gap-2">
            <input type="hidden" name="perPage" value={String(perPage)} />
            <input type="hidden" name="page" value="1" />
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search sets (name/code)…"
              className="w-[240px] md:w-[320px] rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-white/50"
            />
            <button type="submit" className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20">
              Search
            </button>
            {q && (
              <Link
                href={buildHref(baseHref, { perPage, page: 1 })}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white hover:bg-white/15"
              >
                Clear
              </Link>
            )}
          </form>
        </div>
      </div>

      {/* Grid of sets */}
      {rows.length === 0 ? (
        <div className="rounded-xl border border-white/15 bg-white/5 p-6 text-white/90 backdrop-blur-sm">
          No sets yet — run the YGO sync first.
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {rows.map((s) => {
            const img = s.logo_url || s.symbol_url || banner;
            const href = `${CATEGORY.baseHref}/${encodeURIComponent(s.id)}`;
            return (
              <li key={s.id} className="rounded-xl border border-white/10 bg-white/5 overflow-hidden hover:bg-white/10 hover:border-white/20 transition">
                <Link href={href} className="block">
                  <div className="relative w-full" style={{ aspectRatio: "4 / 3" }}>
                    <Image
                      src={img}
                      alt={s.name ?? s.id}
                      fill
                      unoptimized
                      className="object-contain"
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                    />
                  </div>
                  <div className="p-3">
                    <div className="line-clamp-2 text-sm font-medium text-white">{s.name ?? s.id}</div>
                    <div className="mt-1 text-xs text-white/80">{s.release_date ?? ""}</div>
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
            href={buildHref(baseHref, { q, perPage, page: Math.max(1, page - 1) })}
            aria-disabled={page === 1}
            className={`rounded-md border px-3 py-1 ${page === 1 ? "pointer-events-none border-white/10 text-white/40" : "border-white/20 text-white hover:bg-white/10"}`}
          >
            ← Prev
          </Link>
          <span className="px-2 text-white/80">Page {page} of {totalPages}</span>
          <Link
            href={buildHref(baseHref, { q, perPage, page: page + 1 })}
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
