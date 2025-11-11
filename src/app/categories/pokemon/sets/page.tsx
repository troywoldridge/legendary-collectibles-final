
import "server-only";
import Link from "next/link";
import Image from "next/image";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/* ★ Marketplace CTAs */
import CardAmazonCTA from "@/components/CardAmazonCTA";
import CardEbayCTA from "@/components/CardEbayCTA";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SetRow = {
  id: string;
  name: string | null;
  series: string | null;
  ptcgo_code: string | null;
  release_date: string | null;
  logo_url: string | null;   // COALESCE(unlimited, logo_url)
  symbol_url: string | null; // COALESCE(expanded,  symbol_url)
};

const PER_PAGE_OPTIONS = [30, 60, 120, 240] as const;

function parsePerPage(v?: string) {
  const n = Number(v ?? 30);
  return (PER_PAGE_OPTIONS as readonly number[]).includes(n) ? n : 30;
}
function parsePage(v?: string) {
  const n = Number(v ?? 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function buildHref(
  base: string,
  qs: { q?: string | null; page?: number; perPage?: number }
) {
  const p = new URLSearchParams();
  if (qs.q) p.set("q", qs.q);
  if (qs.page) p.set("page", String(qs.page));
  if (qs.perPage) p.set("perPage", String(qs.perPage));
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

export default async function SetsIndex({
  searchParams,
}: {
  searchParams?: { q?: string; page?: string; perPage?: string };
}) {
  const q = (searchParams?.q ?? "").trim() || null;
  const perPage = parsePerPage(searchParams?.perPage);
  const reqPage = parsePage(searchParams?.page);
  const page = Math.max(1, reqPage);
  const offset = (page - 1) * perPage;

  const where = q
    ? sql`WHERE (name ILIKE ${"%" + q + "%"} OR series ILIKE ${"%" + q + "%"} OR id ILIKE ${"%" + q + "%"})`
    : sql``;

  const countSql = sql`SELECT COUNT(*)::int AS count FROM tcg_sets ${where}`;
  const total =
    (await db.execute<{ count: number }>(countSql)).rows?.[0]?.count ?? 0;

  const rowsSql = sql`
    SELECT
      id,
      name,
      series,
      ptcgo_code,
      release_date,
      COALESCE(unlimited, logo_url)  AS logo_url,
      COALESCE(expanded,  symbol_url) AS symbol_url
    FROM tcg_sets
    ${where}
    ORDER BY release_date DESC NULLS LAST, name ASC
    LIMIT ${perPage} OFFSET ${offset}
  `;
  const sets = (await db.execute<SetRow>(rowsSql)).rows ?? [];

  const baseHref = "/categories/pokemon/sets";
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + perPage, total);

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-white">Pokémon Sets</h1>

        {/* Toolbar */}
        <div className="flex flex-wrap gap-3">
          {/* Per-page */}
          <form action={baseHref} method="get" className="flex items-center gap-2">
            {q ? <input type="hidden" name="q" value={q} /> : null}
            <input type="hidden" name="page" value="1" />
            <label htmlFor="pp" className="sr-only">Per page</label>
            <select
              id="pp"
              name="perPage"
              defaultValue={String(perPage)}
              className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-white"
            >
              {PER_PAGE_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <button className="rounded-md border border-white/20 bg-white/10 px-2.5 py-1 text-white hover:bg-white/20">
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
              placeholder="Search sets (name/series/id)…"
              className="w-[240px] md:w-[320px] rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-white/50"
            />
            <button className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20">
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

      <div className="text-sm text-white/80">
        Showing {from}-{to} of {total} sets {q && "(filtered)"}
      </div>

      {/* Grid */}
      {sets.length === 0 ? (
        <div className="rounded-xl border border-white/15 bg-white/5 p-6 text-white/90 backdrop-blur-sm">
          {q ? "No sets matched your search." : "No sets found."}
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {sets.map((s) => {
            const img = s.logo_url || s.symbol_url || null; // prefer logo
            return (
              <li
                key={s.id}
                className="rounded-xl border border-white/10 bg-white/5 overflow-hidden backdrop-blur-sm hover:bg-white/10 hover:border-white/20 transition"
              >
                <Link
                  href={`/categories/pokemon/sets/${encodeURIComponent(s.id)}`}
                  className="block"
                >
                  <div className="relative w-full" style={{ aspectRatio: "16 / 9" }}>
                    {img ? (
                      <Image
                        src={img}
                        alt={s.name ?? s.id}
                        fill
                        unoptimized
                        className="object-contain"
                        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                      />
                    ) : (
                      <div className="absolute inset-0 grid place-items-center text-white/70">
                        No image
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="line-clamp-2 text-sm font-semibold text-white">
                      {s.name ?? s.id}
                    </div>
                    <div className="mt-1 text-xs text-white/80">
                      {(s.series ?? "").trim()}
                      {s.series && s.ptcgo_code ? " • " : ""}
                      {s.ptcgo_code ?? ""}
                    </div>
                    {s.release_date && (
                      <div className="mt-0.5 text-[11px] text-white/70">
                        Released: {s.release_date}
                      </div>
                    )}
                  </div>
                </Link>

                {/* ★ Text above CTAs (already in this order) */}
                <div className="px-3 pb-3 pt-0">
                  <div className="mt-2 flex flex-wrap gap-2">
                    <CardEbayCTA
                      card={{ id: s.id, name: s.name ?? s.id, set_code: s.id, set_name: s.name ?? s.id }}
                      game="Pokémon TCG"
                      variant="pill"
                    />
                    <CardAmazonCTA
                      card={{ id: s.id, name: s.name ?? s.id, set_code: s.id, set_name: s.name ?? s.id }}
                      game="Pokémon TCG"
                      variant="pill"
                    />
                  </div>
                </div>
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
            className={`rounded-md border px-3 py-1 ${
              page === 1
                ? "pointer-events-none border-white/10 text-white/40"
                : "border-white/20 text-white hover:bg-white/10"
            }`}
          >
            ← Prev
          </Link>
          <span className="px-2 text-white/80">
            Page {page} of {Math.max(1, Math.ceil(total / perPage))}
          </span>
          <Link
            href={buildHref(baseHref, { q, perPage, page: page + 1 })}
            aria-disabled={offset + perPage >= total}
            className={`rounded-md border px-3 py-1 ${
              offset + perPage >= total
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
