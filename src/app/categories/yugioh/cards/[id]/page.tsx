
import "server-only";
import Image from "next/image";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import YgoCardSearch from "@/components/ygo/YgoCardSearch";
import { getLatestEbaySnapshot } from "@/lib/ebay";

/* Plan + collection */
import { auth } from "@clerk/nextjs/server";
import { getUserPlan } from "@/lib/plans";
import AddToCollectionButton from "@/components/AddToCollectionButton";

/* ★ Marketplace CTAs */
import CardAmazonCTA from "@/components/CardAmazonCTA";
import CardEbayCTA from "@/components/CardEbayCTA";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------------- Types ---------------- */
type CardRow = {
  id: string; // card_id
  name: string;
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
};

type ImageRow = { small: string | null; large: string | null };
type PriceRow = { tcgplayer: string | null; cardmarket: string | null; ebay: string | null; amazon: string | null; coolstuffinc: string | null };
type BanlistRow = { tcg: string | null; ocg: string | null; goat: string | null };

type SetEntry = { set_name: string; set_code: string | null; set_rarity: string | null; set_price: string | null };

/* ---------------- Helpers ---------------- */
function money(v: string | number | null | undefined) {
  if (!v) return "—";
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}
function bestImage(imgs: ImageRow[]): string | null {
  if (!imgs?.length) return null;
  const first = imgs[0];
  return first.large || first.small || null;
}

/* ---------------- Data loaders ---------------- */
async function getCard(param: string): Promise<{
  card: CardRow | null;
  images: ImageRow[];
  prices: PriceRow | null;
  banlist: BanlistRow | null;
  sets: SetEntry[];
}> {
  const id = decodeURIComponent(param).trim();

  const card =
    (
      await db.execute<CardRow>(sql`
        SELECT
          c.card_id AS id,
          c.name,
          c.type,
          c.desc,
          c.atk,
          c.def,
          c.level,
          c.race,
          c.attribute,
          c.archetype,
          c.ygoprodeck_url,
          c.linkval,
          c.scale,
          c.linkmarkers
        FROM ygo_cards c
        WHERE c.card_id = ${id}
        LIMIT 1
      `)
    ).rows?.[0] ?? null;

  const images =
    (
      await db.execute<ImageRow>(sql`
        SELECT i.image_url_small AS small, i.image_url AS large
        FROM ygo_card_images i
        WHERE i.card_id = ${id}
        ORDER BY (CASE WHEN i.image_url IS NOT NULL THEN 0 ELSE 1 END), i.image_url_small NULLS LAST
        LIMIT 6
      `)
    ).rows ?? [];

  const prices =
    (
      await db.execute<PriceRow>(sql`
        SELECT
          p.tcgplayer_price  AS tcgplayer,
          p.cardmarket_price AS cardmarket,
          p.ebay_price       AS ebay,
          p.amazon_price     AS amazon,
          p.coolstuffinc_price AS coolstuffinc
        FROM ygo_card_prices p
        WHERE p.card_id = ${id}
        LIMIT 1
      `)
    ).rows?.[0] ?? null;

  const banlist =
    (
      await db.execute<BanlistRow>(sql`
        SELECT b.ban_tcg AS tcg, b.ban_ocg AS ocg, b.ban_goat AS goat
        FROM ygo_card_banlist b
        WHERE b.card_id = ${id}
        LIMIT 1
      `)
    ).rows?.[0] ?? null;

  const sets =
    (
      await db.execute<SetEntry>(sql`
        SELECT s.set_name, s.set_code, s.set_rarity, s.set_price
        FROM ygo_card_sets s
        WHERE s.card_id = ${id}
        GROUP BY s.set_name, s.set_code, s.set_rarity, s.set_price
        ORDER BY s.set_name ASC, s.set_code ASC NULLS LAST
      `)
    ).rows ?? [];

  return { card, images, prices, banlist, sets };
}

/* ---------------- Page ---------------- */
export default async function YugiohCardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { card, images, prices, banlist, sets } = await getCard(id);

  if (!card) {
    return (
      <section className="space-y-6">
        <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
          <div className="mb-2 text-sm font-semibold text-white">Find a card</div>
          <YgoCardSearch initialQuery={decodeURIComponent(id)} />
        </div>

        <h1 className="text-2xl font-bold text-white">Card not found</h1>
        <p className="text-white/80">We couldn’t find that Yu-Gi-Oh! card.</p>
        <Link href="/categories/yugioh/cards" className="text-sky-300 hover:underline">
          ← Back to cards
        </Link>
      </section>
    );
  }

  const cover = bestImage(images);
  const firstSet = sets[0]?.set_name ?? null;

  // Latest eBay snapshot
  const ebay = await getLatestEbaySnapshot("ygo", card.id, "all");
  const moneyCents = (c?: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);

  /* plan gate */
  const { userId } = await auth();
  let canSave = false;
  if (userId) {
    const { limits } = await getUserPlan(userId);
    canSave = (limits.maxItems ?? 0) > 0;
  }

  return (
    <section className="space-y-8">
      {/* Quick search at the top */}
      <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
        <div className="mb-2 text-sm font-semibold text-white">Find another card</div>
        <YgoCardSearch initialQuery={card.name} />
      </div>

      {/* Top: image left, info right */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: card image */}
        <div className="lg:col-span-5">
          <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
            <div className="relative mx-auto w-full max-w-md" style={{ aspectRatio: "3 / 4" }}>
              {cover ? (
                <Image
                  src={cover}
                  alt={card.name}
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

        {/* Right: title + meta (text) → CTAs → rest */}
        <div className="lg:col-span-7 space-y-4">
          <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold text-white">{card.name}</h1>
                {/* ★ TEXT ABOVE CTAs */}
                <div className="mt-1 text-sm text-white/80">
                  {card.type ? <span className="mr-3">Type: {card.type}</span> : null}
                  {card.attribute ? <span className="mr-3">Attribute: {card.attribute}</span> : null}
                  {card.race ? <span className="mr-3">Race: {card.race}</span> : null}
                  {card.archetype ? <span>Archetype: {card.archetype}</span> : null}
                </div>
              </div>

              {card.ygoprodeck_url && (
                <Link href={card.ygoprodeck_url} target="_blank" className="text-sm text-sky-300 hover:underline">
                  View on YGOPRODeck →
                </Link>
              )}
            </div>

            {/* Collection action */}
            <div className="mt-3">
              {canSave ? (
                <AddToCollectionButton
                  game="yugioh"
                  cardId={card.id}
                  cardName={card.name}
                  setName={firstSet || undefined}
                  number={undefined}
                  imageUrl={cover || undefined}
                />
              ) : (
                <Link href="/pricing" className="inline-block px-3 py-2 rounded bg-amber-500 text-white hover:bg-amber-600">
                  Upgrade to track your collection
                </Link>
              )}
            </div>

            {/* CTAs (below meta text) */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <CardEbayCTA
                card={{ id: card.id, name: card.name, set_name: firstSet ?? null }}
                game="Yu-Gi-Oh!"
                variant="pill"
              />
              <CardAmazonCTA
                card={{ id: card.id, name: card.name, set_name: firstSet ?? null }}
                game="Yu-Gi-Oh!"
                variant="pill"
              />
            </div>

            {/* Stat grid */}
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs uppercase tracking-wide text-white/60">ATK / DEF</div>
                <div className="mt-1 text-lg font-semibold text-white">
                  {card.atk ?? "—"} / {card.def ?? "—"}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs uppercase tracking-wide text-white/60">Level / Scale / Link</div>
                <div className="mt-1 text-lg font-semibold text-white">
                  {card.level ?? 0} / {card.scale ?? 0} / {card.linkval ?? 0}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs uppercase tracking-wide text-white/60">Card ID</div>
                <div className="mt-1 text-lg font-semibold text-white">{card.id}</div>
              </div>
            </div>
          </div>

          {/* Prices table */}
          <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Market Prices</h2>
              <div className="text-xs text-white/60">Shown in native market currency</div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-3">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-sm font-medium text-white">TCGplayer</div>
                  <div className="text-white/80">Price</div>
                  <div className="mt-1 text-lg font-semibold text-white">{money(prices?.tcgplayer)}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-sm font-medium text-white">eBay</div>
                  <div className="text-white/80">Price</div>
                  <div className="mt-1 text-lg font-semibold text-white">{money(prices?.ebay)}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-sm font-medium text-white">CoolStuffInc</div>
                  <div className="text-white/80">Price</div>
                  <div className="mt-1 text-lg font-semibold text-white">{money(prices?.coolstuffinc)}</div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-sm font-medium text-white">Cardmarket</div>
                  <div className="text-white/80">Price</div>
                  <div className="mt-1 text-lg font-semibold text-white">{money(prices?.cardmarket)}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-sm font-medium text-white">Amazon</div>
                  <div className="text-white/80">Price</div>
                  <div className="mt-1 text-lg font-semibold text-white">{money(prices?.amazon)}</div>
                </div>
              </div>
            </div>
          </div>

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
                  Median: <span className="font-semibold">{moneyCents(ebay.median_cents)}</span>{" "}
                  {ebay.sample_count ? <span className="text-white/60">• n={ebay.sample_count}</span> : null}
                </div>
                <div className="text-sm text-white/80">
                  IQR: {moneyCents(ebay.p25_cents)} – {moneyCents(ebay.p75_cents)}
                </div>
                <div className="text-xs text-white/60 mt-1">
                  Source: eBay Browse API (US, USD; filtered and outliers pruned)
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sets scroller */}
      <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Sets</h2>
        </div>

        {sets.length === 0 ? (
          <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-white/80">
            No set appearances recorded for this card.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sets.map((s) => {
              const href = `/categories/yugioh/sets/${encodeURIComponent(s.set_name)}`;
              return (
                <Link
                  key={`${s.set_name}::${s.set_code ?? ""}`}
                  href={href}
                  className="rounded-xl border border-white/10 bg-white/5 p-3 hover:border-white/20 hover:bg-white/10 transition"
                >
                  <div className="text-sm font-medium text-white line-clamp-1">{s.set_name}</div>
                  <div className="mt-1 text-xs text-white/70">{s.set_rarity ?? "—"}</div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Card text / effect */}
      <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-sm">
        <h2 className="text-lg font-semibold text-white">Card Text</h2>
        <p className="mt-2 whitespace-pre-wrap text-white/90">{card.desc || "—"}</p>
        {banlist && (
          <div className="mt-3 text-sm text-white/80">
            <span className="mr-3">Banlist (TCG): {banlist.tcg ?? "—"}</span>
            <span className="mr-3">OCG: {banlist.ocg ?? "—"}</span>
            <span>GOAT: {banlist.goat ?? "—"}</span>
          </div>
        )}
      </div>

      {/* Footer nav */}
      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/categories/yugioh/cards" className="text-sky-300 hover:underline">
          ← Back to cards
        </Link>
        {firstSet && (
          <Link
            href={`/categories/yugioh/sets/${encodeURIComponent(firstSet)}`}
            className="text-sky-300 hover:underline"
          >
            ← Back to set
          </Link>
        )}
      </div>
    </section>
  );
}
