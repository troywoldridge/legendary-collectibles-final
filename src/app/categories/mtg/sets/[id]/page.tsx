import "server-only";
import Link from "next/link";
import Image from "next/image";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import CardGridTile from "@/components/CardGridTile";

/* ★ Marketplace CTAs (set-level) */
import CardAmazonCTA from "@/components/CardAmazonCTA";
import CardEbayCTA from "@/components/CardEbayCTA";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

type SetRow = {
  code: string;
  name: string | null;
  set_type: string | null;
  block: string | null;
  released_at: string | null; // yyyy-mm-dd
};

type CardThumb = {
  id: string;
  name: string | null;
  number: string | null;
  image_url: string | null;
  rarity: string | null;
  price_usd: string | null;
  price_updated: string | null;
};

const PER_PAGE_OPTIONS = [30, 60, 120] as const;

function parsePerPage(v?: string | string[]) {
  const s = Array.isArray(v) ? v[0] : v;
  const n = Number(s ?? 60);
  return (PER_PAGE_OPTIONS as readonly number[]).includes(n) ? n : 60;
}
function parsePage(v?: string | string[]) {
  const s = Array.isArray(v) ? v[0] : v;
  const n = Number(s ?? 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}
function buildHref(base: string, qs: { page?: number; perPage?: number }) {
  const p = new URLSearchParams();
  if (qs.page) p.set("page", String(qs.page));
  if (qs.perPage) p.set("perPage", String(qs.perPage));
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

export default async function MtgSetDetailPage({
  params,
  searchParams,
}: {
  params: { id?: string };
  searchParams: SearchParams;
}) {
  const id = (params?.id || "").trim();
  if (!id) notFound();

  const perPage = parsePerPage(searchParams?.perPage);
  const reqPage = parsePage(searchParams?.page);

  // Case-insensitive match on set code
  const setRes = await db.execute<SetRow>(sql`
    SELECT
      code,
      name,
      set_type,
      block,
      COALESCE(TO_CHAR(released_at,'YYYY-MM-DD'), NULL) AS released_at
    FROM public.mtg_sets
    WHERE LOWER(code) = LOWER(${id})
    LIMIT 1
  `);
  const s = setRes.rows?.[0] ?? null;
  if (!s) notFound();

  const totalRes = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM public.mtg_cards
    WHERE LOWER(set_code) = LOWER(${s.code})
  `);
  const total = Number(totalRes.rows?.[0]?.count ?? "0");
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(reqPage, totalPages);
  const offset = (page - 1) * perPage;

  const cardsRes = await db.execute<CardThumb>(sql`
    SELECT
      c.id,
      c.name,
      c.collector_number AS number,
      c.rarity,
      COALESCE(
        c.image_uris->>'normal',
        c.image_uris->>'large',
        c.image_uris->>'small',
        (c.card_faces_raw->0->'image_uris'->>'normal'),
        (c.card_faces_raw->0->'image_uris'->>'large'),
        (c.card_faces_raw->0->'image_uris'->>'small')
      ) AS image_url,
      e.effective_usd::text      AS price_usd,
      TO_CHAR(e.effective_updated_at, 'YYYY-MM-DD') AS price_updated
    FROM public.mtg_cards c
    LEFT JOIN public.mtg_prices_effective e
      ON e.scryfall_id = c.id
    WHERE LOWER(c.set_code) = LOWER(${s.code})
    ORDER BY
      (CASE WHEN c.collector_number ~ '^[0-9]+$' THEN 0 ELSE 1 END),
      c.collector_number::text,
      c.name ASC
    LIMIT ${perPage} OFFSET ${offset}
  `);

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{s.name ?? s.code}</h1>
          <div className="text-sm text-white/70">
            {[
              s.code,
              s.set_type ?? undefined,
              s.block ? `Block: ${s.block}` : undefined,
              s.released_at ? `Released: ${s.released_at}` : undefined,
            ]
              .filter(Boolean)
              .join(" • ")}
          </div>

          {/* Set-level CTAs (outside links, no unsupported props) */}
          <div className="mt-2 flex flex-wrap gap-2">
            <CardEbayCTA
              card={{
                id: s.code,
                name: s.name ?? s.code,
                number: null,
                set_code: s.code,
                set_name: s.name ?? s.code,
              }}
              game="Magic The Gathering"
            />
            <CardAmazonCTA
              card={{
                id: s.code,
                name: s.name ?? s.code,
                number: null,
                set_code: s.code,
                set_name: s.name ?? s.code,
              }}
              game="Magic The Gathering"
            />
          </div>
        </div>

        <Link href="/categories/mtg/sets" className="text-sky-300 hover:underline">
          ← All MTG sets
        </Link>
      </div>

      {total === 0 ? (
        <div className="rounded-xl border border-white/15 bg-white/5 p-6 text-white/90">
          No cards in this set yet.
        </div>
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {cardsRes.rows.map((c) => {
              const img = (c.image_url ?? "").replace(/^http:\/\//, "https://") || null;
              const href = `/categories/mtg/cards/${encodeURIComponent(c.id)}`;

              return (
                <CardGridTile
                  key={c.id}
                  href={href}
                  imageUrl={img}
                  title={c.name ?? c.id}
                  // text ABOVE buttons:
                  subtitleLeft={[c.rarity ?? "", c.number ?? ""].filter(Boolean).join(" • ") || null}
                  // price line under subtitle:
                  extra={
                    <div className="text-xs text-white/60">
                      {c.price_usd ? `$${c.price_usd}` : "—"}
                      {c.price_updated ? ` • ${c.price_updated}` : ""}
                    </div>
                  }
                  // buttons BELOW text:
                  cta={{
                    game: "Magic The Gathering",
                    card: {
                      id: c.id,
                      name: c.name ?? "",
                      number: c.number ?? undefined,
                      set_code: s.code,
                      set_name: s.name ?? undefined,
                    },
                  }}
                />
              );
            })}
          </ul>

          {total > perPage && (
            <nav className="mt-4 flex items-center justify-center gap-2 text-sm">
              <Link
                href={buildHref(`/categories/mtg/sets/${encodeURIComponent(s.code)}`, {
                  perPage,
                  page: Math.max(1, page - 1),
                })}
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
                Page {page} of {totalPages}
              </span>
              <Link
                href={buildHref(`/categories/mtg/sets/${encodeURIComponent(s.code)}`, {
                  perPage,
                  page: page + 1,
                })}
                aria-disabled={page >= totalPages}
                className={`rounded-md border px-3 py-1 ${
                  page >= totalPages
                    ? "pointer-events-none border-white/10 text-white/40"
                    : "border-white/20 text-white hover:bg-white/10"
                }`}
              >
                Next →
              </Link>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
