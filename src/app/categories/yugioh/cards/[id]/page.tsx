import "server-only";
import Link from "next/link";
import Image from "next/image";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import MarketPrices from "@/components/MarketPrices";
import type { DisplayCurrency } from "@/lib/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------- Types ---------- */
type SearchParams = Record<string, string | string[] | undefined>;

type CardCore = {
  id: string;
  name: string | null;
  type: string | null;
  desc: string | null;
  atk: number | null;
  def: number | null;
  level: number | null;
  race: string | null;
  attribute: string | null;
  archetype: string | null;
  ygoprodeck_url: string | null;
  linkval: number | null;
  scale: number | null;
  linkmarkers: string[] | null;
  has_effect: boolean | null;
  staple: boolean | null;
};

type Img = { image_url: string; image_url_small: string | null };
type SetRow = { set_code: string; set_name: string | null; set_rarity: string | null; set_price: string | null };
type Ban = { ban_tcg: string | null; ban_ocg: string | null; ban_goat: string | null };
type Misc = { konami_id: string | null };

/* ---------- Helpers ---------- */
function readDisplay(sp: SearchParams): DisplayCurrency {
  // Accept both ?display= and legacy ?currency= (USD|EUR) else NATIVE
  const a = (Array.isArray(sp?.display) ? sp.display[0] : sp?.display)?.toUpperCase();
  const b = (Array.isArray(sp?.currency) ? sp.currency[0] : sp?.currency)?.toUpperCase();
  const v = a || b;
  return v === "USD" || v === "EUR" ? (v as DisplayCurrency) : "NATIVE";
}
function withParam(baseHref: string, key: string, val: string) {
  const u = new URL(baseHref, "https://x/");
  u.searchParams.set(key, val);
  return u.pathname + (u.search ? u.search : "");
}
function safeNum(x: unknown): number | null {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

/* ---------- Data ---------- */
async function resolveCardId(param: string): Promise<string | null> {
  const nameGuess = param.replace(/-/g, " ").trim();
  const likeGuess = `%${nameGuess}%`;
  const row =
    (
      await db.execute<{ card_id: string }>(sql`
        SELECT card_id
        FROM ygo_cards
        WHERE card_id = ${param}
           OR lower(name) = lower(${nameGuess})
           OR name ILIKE ${likeGuess}
        ORDER BY
          CASE WHEN card_id = ${param} THEN 0
               WHEN lower(name) = lower(${nameGuess}) THEN 1
               ELSE 2
          END,
          name ASC NULLS LAST,
          card_id ASC
        LIMIT 1
      `)
    ).rows?.[0] ?? null;
  return row?.card_id ?? null;
}

async function loadCore(cardId: string): Promise<CardCore | null> {
  return (
    (
      await db.execute<CardCore>(sql`
        SELECT card_id AS id, name, type, "desc", atk, def, level, race, attribute, archetype,
               ygoprodeck_url, linkval, scale, linkmarkers, has_effect, staple
        FROM ygo_cards
        WHERE card_id = ${cardId}
        LIMIT 1
      `)
    ).rows?.[0] ?? null
  );
}

async function loadImages(cardId: string): Promise<Img[]> {
  const rows =
    (
      await db.execute<Img>(sql`
        SELECT image_url, image_url_small
        FROM ygo_card_images
        WHERE card_id = ${cardId}
        ORDER BY image_url_small NULLS LAST, image_url ASC
      `)
    ).rows ?? [];
  const seen = new Set<string>();
  const out: Img[] = [];
  for (const r of rows) {
    if (r.image_url && !seen.has(r.image_url)) {
      seen.add(r.image_url);
      out.push(r);
    }
  }
  return out;
}

async function loadSets(cardId: string): Promise<SetRow[]> {
  return (
    (
      await db.execute<SetRow>(sql`
        SELECT set_code, set_name, set_rarity, set_price
        FROM ygo_card_sets
        WHERE card_id = ${cardId}
        ORDER BY set_name ASC NULLS LAST, set_code ASC
      `)
    ).rows ?? []
  );
}

async function loadBan(cardId: string): Promise<Ban | null> {
  return (
    (
      await db.execute<Ban>(sql`
        SELECT ban_tcg, ban_ocg, ban_goat
        FROM ygo_card_banlist
        WHERE card_id = ${cardId}
        LIMIT 1
      `)
    ).rows?.[0] ?? null
  );
}

async function loadMisc(cardId: string): Promise<Misc | null> {
  const row =
    (
      await db.execute<Misc>(sql`
        SELECT konami_id
        FROM ygo_card_misc
        WHERE card_id = ${cardId}
        LIMIT 1
      `)
    ).rows?.[0] ?? null;
  return row ?? null;
}

/* ---------- Page ---------- */
export default async function YugiohCardDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id: rawId } = await params;
  const sp = await searchParams;
  const display = readDisplay(sp);

  const cardParam = decodeURIComponent(rawId ?? "").trim();
  const cardId = (await resolveCardId(cardParam)) ?? cardParam;

  const [core, images, sets, ban, misc] = await Promise.all([
    loadCore(cardId),
    loadImages(cardId),
    loadSets(cardId),
    loadBan(cardId),
    loadMisc(cardId),
  ]);

  if (!core) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-bold text-white">Card not found</h1>
        <p className="text-white/70 text-sm break-all">Looked up: <code>{cardParam}</code></p>
        <div className="flex gap-4">
          <Link href="/categories/yugioh/sets" className="text-sky-300 hover:underline">← Back to YGO sets</Link>
          <Link href="/categories" className="text-sky-300 hover:underline">← All categories</Link>
        </div>
      </section>
    );
  }

  const title = core.name ?? core.id;
  const hero = images[0]?.image_url || images[0]?.image_url_small || null;
  const baseHref = `/categories/yugioh/cards/${encodeURIComponent(core.id)}`;

  return (
    <section className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <div className="relative h-48 w-36 shrink-0 rounded-lg bg-white/5 ring-1 ring-white/10 overflow-hidden">
            {hero ? (
              <Image src={hero} alt={title} fill unoptimized className="object-contain" sizes="144px" priority />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-white/60 text-xs">No image</div>
            )}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">{title}</h1>
            <div className="mt-1 flex flex-wrap gap-2 text-xs">
              {core.type && <span className="rounded bg-white/10 px-2 py-0.5 text-white/90">{core.type}</span>}
              {core.attribute && <span className="rounded bg-white/10 px-2 py-0.5 text-white/90">Attribute: {core.attribute}</span>}
              {core.race && <span className="rounded bg-white/10 px-2 py-0.5 text-white/90">Race: {core.race}</span>}
              {core.archetype && <span className="rounded bg-white/10 px-2 py-0.5 text-white/90">Archetype: {core.archetype}</span>}
              {core.has_effect != null && <span className="rounded bg-white/10 px-2 py-0.5 text-white/90">{core.has_effect ? "Effect" : "No Effect"}</span>}
              {core.staple && <span className="rounded bg-white/10 px-2 py-0.5 text-white/90">Staple</span>}
            </div>
            {core.ygoprodeck_url && (
              <div className="mt-2 text-xs">
                <a href={core.ygoprodeck_url} target="_blank" rel="noopener noreferrer" className="text-sky-300 hover:underline">
                  View on YGOPRODeck ↗
                </a>
              </div>
            )}
          </div>
        </div>

        {/* Display toggle */}
        <div className="flex items-center gap-3">
          <div className="rounded-md border border-white/20 bg-white/10 p-1 text-sm text-white">
            <span className="px-2">Display:</span>
            <Link href={withParam(baseHref, "display", "NATIVE")} className={`rounded px-2 py-1 ${display === "NATIVE" ? "bg-white/20" : "hover:bg-white/10"}`}>Native</Link>
            <Link href={withParam(baseHref, "display", "USD")} className={`ml-1 rounded px-2 py-1 ${display === "USD" ? "bg-white/20" : "hover:bg-white/10"}`}>USD</Link>
            <Link href={withParam(baseHref, "display", "EUR")} className={`ml-1 rounded px-2 py-1 ${display === "EUR" ? "bg-white/20" : "hover:bg-white/10"}`}>EUR</Link>
          </div>
          <Link href="/categories/yugioh/sets" className="text-sky-300 hover:underline">← Back to sets</Link>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-white/15 bg-white/5 p-4 text-white/90">
          <div className="text-sm text-white/70">ATK / DEF</div>
          <div className="mt-1 text-lg font-semibold">
            {safeNum(core.atk) ?? "—"} / {safeNum(core.def) ?? "—"}
          </div>
        </div>
        <div className="rounded-lg border border-white/15 bg-white/5 p-4 text-white/90">
          <div className="text-sm text-white/70">Level / Scale / Link</div>
          <div className="mt-1 text-lg font-semibold">
            {safeNum(core.level) ?? "—"} / {safeNum(core.scale) ?? "—"} / {safeNum(core.linkval) ?? "—"}
          </div>
          {core.linkmarkers?.length ? (
            <div className="mt-1 text-xs text-white/80">Markers: {core.linkmarkers.join(", ")}</div>
          ) : null}
        </div>
        <div className="rounded-lg border border-white/15 bg-white/5 p-4 text-white/90">
          <div className="text-sm text-white/70">Card ID</div>
          <div className="mt-1 text-lg font-semibold">{core.id}</div>
          {/* If you want Konami ID here, uncomment next line when loadMisc includes it */}
          {/* {misc?.konami_id && <div className="mt-1 text-xs text-white/80">Konami ID: {misc.konami_id}</div>} */}
        </div>
      </div>

      {/* Prices (shared) */}
      <MarketPrices category="yugioh" cardId={core.id} display={display} />

      {/* Banlist */}
      <div className="rounded-xl border border-white/15 bg-white/5 p-4 text-white/90">
        <h2 className="mb-2 text-lg font-semibold text-white">Banlist</h2>
        {!ban || (!ban.ban_tcg && !ban.ban_ocg && !ban.ban_goat) ? (
          <div className="rounded-md border border-white/10 bg-white/5 p-3 text-sm text-white/80">
            No current ban statuses recorded.
          </div>
        ) : (
          <ul className="space-y-2 text-sm">
            {ban.ban_tcg && <li className="flex items-center justify-between"><span>TCG</span><span className="font-medium">{ban.ban_tcg}</span></li>}
            {ban.ban_ocg && <li className="flex items-center justify-between"><span>OCG</span><span className="font-medium">{ban.ban_ocg}</span></li>}
            {ban.ban_goat && <li className="flex items-center justify-between"><span>Goat</span><span className="font-medium">{ban.ban_goat}</span></li>}
          </ul>
        )}
      </div>

      {/* Sets this card appears in */}
      <div className="rounded-xl border border-white/15 bg-white/5 p-4 text-white/90">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Sets</h2>
          <Link href="/categories/yugioh/sets" className="text-sky-300 hover:underline text-sm">Browse sets →</Link>
        </div>
        {sets.length === 0 ? (
          <div className="rounded-md border border-white/10 bg-white/5 p-3 text-sm text-white/80">
            No sets recorded for this card.
          </div>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {sets.map((s) => (
              <li key={s.set_code} className="rounded-md border border-white/10 bg-white/5 px-3 py-2">
                <div className="text-sm font-medium text-white">
                  <Link href={`/categories/yugioh/sets/${encodeURIComponent(s.set_code)}`} className="hover:underline">
                    {s.set_name ?? s.set_code}
                  </Link>
                </div>
                <div className="mt-1 text-xs text-white/80">
                  {s.set_rarity ?? "—"}{s.set_price ? ` • ${s.set_price}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Description */}
      {core.desc && (
        <div className="rounded-xl border border-white/15 bg-white/5 p-4 text-white/90">
          <h2 className="mb-2 text-lg font-semibold text-white">Card Text</h2>
          <p className="whitespace-pre-line text-sm leading-relaxed">{core.desc}</p>
        </div>
      )}

      {/* Gallery */}
      {images.length > 1 && (
        <div className="rounded-xl border border-white/15 bg-white/5 p-4 text-white/90">
          <h2 className="mb-2 text-lg font-semibold text-white">Gallery</h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {images.slice(1).map((im) => (
              <li key={im.image_url} className="relative w-full" style={{ aspectRatio: "3 / 4" }}>
                <Image
                  src={im.image_url}
                  alt={title}
                  fill
                  unoptimized
                  className="object-contain rounded-md border border-white/10 bg-white/5"
                  sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
