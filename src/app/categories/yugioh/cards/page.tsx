
import "server-only";
import Image from "next/image";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import YgoCardSearch from "@/components/ygo/YgoCardSearch";

/* ★ Marketplace CTAs */
import CardAmazonCTA from "@/components/CardAmazonCTA";
import CardEbayCTA from "@/components/CardEbayCTA";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------------- Types ---------------- */
type ListRow = {
  id: string;        // ygo_cards.card_id
  name: string;
  type: string | null;
  attribute: string | null;
  race: string | null;
  thumb: string | null;
};
type CountRow = { count: string };

/* ---------------- Helpers ---------------- */
function toInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function getStr(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0] ?? null;
  return null;
}
function qs(next: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/* ---------------- Data ---------------- */
async function fetchCards(opts: { q: string | null; page: number; per: number }) {
  const { q, page, per } = opts;
  const offset = (page - 1) * per;

  if (q) {
    const countRes = await db.execute<CountRow>(sql`
      SELECT COUNT(*)::bigint::text AS count
      FROM ygo_cards c
      WHERE c.card_id = ${q} OR c.name ILIKE '%' || ${q} || '%'
    `);
    const total = Number(countRes.rows?.[0]?.count ?? "0");

    const listRes = await db.execute<ListRow>(sql`
      SELECT
        c.card_id AS id,
        c.name,
        c.type,
        c.attribute,
        c.race,
        img.thumb
      FROM ygo_cards c
      LEFT JOIN LATERAL (
        SELECT i.image_url_small AS thumb
        FROM ygo_card_images i
        WHERE i.card_id = c.card_id
        ORDER BY (CASE WHEN i.image_url_small IS NOT NULL THEN 0 ELSE 1 END)
        LIMIT 1
      ) img ON TRUE
      WHERE c.card_id = ${q} OR c.name ILIKE '%' || ${q} || '%'
      ORDER BY
        CASE WHEN LOWER(c.name) = LOWER(${q}) THEN 0
             WHEN LOWER(c.name) LIKE LOWER(${q}) || '%' THEN 1
             ELSE 2
        END,
        c.name ASC
      LIMIT ${per} OFFSET ${offset}
    `);

    return { rows: (listRes.rows ?? []) as ListRow[], total };
  }

  const countRes = await db.execute<CountRow>(sql`SELECT COUNT(*)::bigint::text AS count FROM ygo_cards`);
  const total = Number(countRes.rows?.[0]?.count ?? "0");

  const listRes = await db.execute<ListRow>(sql`
    SELECT
      c.card_id AS id,
      c.name,
      c.type,
      c.attribute,
      c.race,
      img.thumb
    FROM ygo_cards c
    LEFT JOIN LATERAL (
      SELECT i.image_url_small AS thumb
      FROM ygo_card_images i
      WHERE i.card_id = c.card_id
      ORDER BY (CASE WHEN i.image_url_small IS NOT NULL THEN 0 ELSE 1 END)
      LIMIT 1
    ) img ON TRUE
    ORDER BY c.name ASC
    LIMIT ${per} OFFSET ${offset}
  `);

  return { rows: (listRes.rows ?? []) as ListRow[], total };
}

/* ---------------- Page ---------------- */
export default async function YugiohCardsIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const sp = await searchParams;
  const qRaw = getStr(sp.q);
  const q = qRaw ? qRaw.trim() : null;

  const per = Math.min(96, toInt(sp.per, 36));
  const page = Math.max(1, toInt(sp.page, 1));

  const { rows, total } = await fetchCards({ q, page, per });
  const pages = Math.max(1, Math.ceil(total / per));
  const showingFrom = total ? (page - 1) * per + 1 : 0;
  const showingTo = Math.min(total, page * per);

  return (
    <section className="space-y-6">
      {/* Search */}
      <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
        <div className="mb-2 text-sm font-semibold text-white">Search Yu-Gi-Oh! cards</div>
        <YgoCardSearch initialQuery={q ?? ""} />
        <div className="mt-2 text-xs text-white/60">Tip: type a name or an exact Card ID.</div>
      </div>

      {/* Header + meta */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Yu-Gi-Oh! Cards</h1>
        <div className="text-sm text-white/70">
          {q ? (
            <>
              Showing <span className="text-white">{showingFrom}</span>–
              <span className="text-white">{showingTo}</span> of{" "}
              <span className="text-white">{total.toLocaleString()}</span> results for{" "}
              <span className="text-white">&ldquo;{q}&rdquo;</span>
            </>
          ) : (
            <>
              Showing <span className="text-white">{showingFrom}</span>–
              <span className="text-white">{showingTo}</span> of{" "}
              <span className="text-white">{total.toLocaleString()}</span> cards
            </>
          )}
        </div>
      </div>

      {/* Empty state / Grid */}
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-white/15 bg-white/5 p-6 text-white/80">
          No cards found{q ? <> for “{q}”</> : null}.
        </div>
      ) : (
        <>
          <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-3">
            {rows.map((r) => {
              const hasThumb = !!r.thumb;
              return (
                <li
                  key={r.id}
                  className="rounded-xl border border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10 transition"
                >
                  <Link
                    href={`/categories/yugioh/cards/${encodeURIComponent(r.id)}`}
                    className="block group"
                  >
                    <div className="relative mx-auto w-full" style={{ aspectRatio: "3 / 4" }}>
                      {hasThumb ? (
                        <Image
                          src={r.thumb as string}
                          alt={r.name}
                          fill
                          sizes="(max-width: 768px) 50vw, (max-width: 1280px) 25vw, 16vw"
                          className="object-contain transition-transform group-hover:scale-[1.02]"
                          unoptimized
                        />
                      ) : (
                        <div className="absolute inset-0 grid place-items-center text-white/60">
                          No image
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <div className="line-clamp-2 text-sm font-medium text-white">{r.name}</div>
                      {/* ★ TEXT ABOVE CTAs */}
                      <div className="mt-1 text-xs text-white/70">
                        {r.id}
                        {r.type ? ` • ${r.type}` : ""}
                        {r.attribute ? ` • ${r.attribute}` : ""}
                        {r.race ? ` • ${r.race}` : ""}
                      </div>
                    </div>
                  </Link>

                  {/* CTAs (outside Link) */}
                  <div className="px-3 pb-3 pt-0">
                    <div className="mt-2 flex items-center gap-2">
                      <CardEbayCTA card={{ id: r.id, name: r.name }} game="Yu-Gi-Oh!" compact />
                      <CardAmazonCTA card={{ id: r.id, name: r.name }} game="Yu-Gi-Oh!" compact />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Pagination */}
          <nav className="mt-4 flex items-center justify-between gap-2">
            {/* Prev */}
            <div>
              {page > 1 ? (
                <Link
                  href={qs({ q: q ?? undefined, page: page - 1, per })}
                  className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-sky-300 hover:border-white/25 hover:bg-white/10"
                >
                  ← Prev
                </Link>
              ) : (
                <span className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/40">
                  ← Prev
                </span>
              )}
            </div>

            {/* Page status */}
            <div className="text-sm text-white/70">
              Page <span className="text-white">{page}</span> of{" "}
              <span className="text-white">{pages}</span>
            </div>

            {/* Next */}
            <div>
              {page < pages ? (
                <Link
                  href={qs({ q: q ?? undefined, page: page + 1, per })}
                  className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-sky-300 hover:border-white/25 hover:bg-white/10"
                >
                  Next →
                </Link>
              ) : (
                <span className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/40">
                  Next →
                </span>
              )}
            </div>
          </nav>
        </>
      )}
    </section>
  );
}
