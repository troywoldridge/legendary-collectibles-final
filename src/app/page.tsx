import "server-only";
import Link from "next/link";
import Image from "next/image";
import { db } from "@/lib/db";
import { categories, products } from "@/lib/db/schema";
import { asc, desc, eq } from "drizzle-orm";
import { cfUrl } from "@/lib/cf";
import { CF_ACCOUNT_HASH } from "@/lib/cf";

/* ---------------- Types ---------------- */
type FeaturedItem = {
  title: string;
  tag: string;
  price: string;
  href: string;
  cfId?: string;
  alt?: string;
};

type CategoryCard = {
  slug: string;
  label: string;
  blurb: string;
  cfId: string;
};

type DbCategory = typeof categories.$inferSelect;
type DbProduct  = typeof products.$inferSelect;

/* ---------------- UI constants ---------------- */
export const dynamic = "force-dynamic";

const CAT_CARD_HEIGHT = "h-40 md:h-44";
const BRANDS = ["Pokémon", "Yu-Gi-Oh!", "Magic: The Gathering", "One Piece", "Dragon Ball", "Funko"] as const;
const FALLBACK_IMG =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

/* Static fallback content (keeps the look if DB is empty) */
const CATEGORIES_FALLBACK: ReadonlyArray<CategoryCard> = [
  { slug: "pokemon", label: "Pokémon", blurb: "Booster boxes, ETBs, singles", cfId: "b4e6cda2-4739-4717-5005-e0b84d75c200" },
  { slug: "yugioh", label: "Yu-Gi-Oh!", blurb: "Boxes, tins, structure decks", cfId: "87101a20-6ada-4b66-0057-2d210feb9d00" },
  { slug: "mtg", label: "Magic: The Gathering", blurb: "Play boosters, commander", cfId: "69ab5d2b-407c-4538-3c82-be8a551efa00" },
  { slug: "sports", label: "Sports Cards", blurb: "NFL, NBA, MLB, UFC", cfId: "f95ef753-c5fd-4079-9743-27cf651fd500" },
  { slug: "anime", label: "Anime TCGs", blurb: "One Piece, DBSCG, WS", cfId: "dbb25cb7-55f0-4b38-531a-2c26f513c700" },
  { slug: "funko", label: "Funko & Figures", blurb: "Exclusives, vaulted, waves", cfId: "a9d2f9ea-6b9b-4f7a-93a1-7aa587842b00" },
];

/* ---------------- Helpers ---------------- */
const fmtUSD = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    .format((cents || 0) / 100);

const cfImageUrl = (id: string, variant = "categoryThumb") =>
  `https://imagedelivery.net/${CF_ACCOUNT_HASH}/${id}/${variant}`    

/* ---------------- Queries ---------------- */
async function getCategoriesFromDB(): Promise<CategoryCard[]> {
  try {
    const rows: DbCategory[] = await db
      .select()
      .from(categories)
      .orderBy(asc(categories.name))
      .limit(6);

    type CatRow = DbCategory & Partial<{ cf_image_id: string | null; cfImageId: string | null; description: string | null }>;

    const mapped = rows.map<CategoryCard>((c) => {
      const r = c as CatRow;
      return {
        slug: c.slug ?? "",
        label: c.name ?? "Untitled",
        blurb: r.description ?? "",
        cfId: r.cf_image_id ?? r.cfImageId ?? "",
      };
    });

    return mapped.length ? mapped : [...CATEGORIES_FALLBACK];
  } catch (err) {
    console.error("[home] categories query failed:", err);
    return [...CATEGORIES_FALLBACK];
  }
}

async function getFeaturedItems(): Promise<FeaturedItem[]> {
  try {
    const rows: DbProduct[] = await db
      .select()
      .from(products)
      .where(eq(products.in_stock, true))
      .orderBy(desc(products.created_at))
      .limit(10);

    type ProdRow = DbProduct & Partial<{
      price_cents: number | null; priceCents: number | null;
      cf_image_id: string | null; cfImageId: string | null;
      cf_alt: string | null; cfAlt: string | null;
    }>;

    return rows.map<FeaturedItem>((p) => {
      const r = p as ProdRow;
      const priceCents = r.price_cents ?? r.priceCents ?? 0;
      const cfId = r.cf_image_id ?? r.cfImageId ?? "";
      const alt = r.cf_alt ?? r.cfAlt ?? p.name ?? "Product image";

      return {
        title: p.name ?? "Untitled Product",
        tag: "Featured",
        price: fmtUSD(priceCents),
        href: `/products/${p.id}`,
        cfId,
        alt,
      };
    });
  } catch (err) {
    console.error("[home] featured query failed:", err);
    return [];
  }
}

/* ---------------- Page ---------------- */
export default async function HomePage() {
  const [CATEGORIES, FEATURED_ITEMS] = await Promise.all([
    getCategoriesFromDB(),
    getFeaturedItems(),
  ]);

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8">
        {/* HERO */}
        <section className="relative" aria-labelledby="hero-title">
          <div className="mx-auto w-full max-w-[1100px] px-4 sm:px-0">
            <div className="flex min-h-[55vh] items-center justify-center py-10 sm:py-14">
              <div className="w-full max-w-[900px] text-center mx-auto space-y-6 sm:space-y-8 lg:space-y-10">
                <p className="mb-2 text-4xl font-semibold tracking-wide text-white/85 drop-shadow-[0_1px_2px_rgba(0,0,0,.6)]">
                  WELCOME TO LEGENDARY COLLECTIBLES
                </p>

                <h1
                  id="hero-title"
                  className="mb-3 text-4xl font-extrabold leading-tight text-white drop-shadow-[0_2px_10px_rgba(0,0,0,.45)] sm:text-5xl"
                >
                  Rip, trade, and collect <span className="underline decoration-4 underline-offset-4">Legendary</span> cards
                </h1>

                <p className="mb-2 text-2xl font-semibold tracking-wide text-white/85 drop-shadow-[0_1px_2px_rgba(0,0,0,.6)]">
                  Sealed heat, graded grails, and weekly drops—curated for real collectors. Fast shipping. Authenticity guaranteed.
                </p>

                {/* CTAs */}
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Link
                    href="/categories"
                    className="inline-flex items-center rounded-lg border border-white/60 bg-white/5 px-4 py-2 text-sm font-semibold text-white backdrop-blur-sm hover:bg-white/10"
                  >
                    Browse Categories
                  </Link>
                  <Link
                    href="/search"
                    className="inline-flex items-center rounded-lg border border-white/50 bg-white/5 px-4 py-2 text-sm font-semibold text-white backdrop-blur-sm hover:bg-white/10"
                  >
                    Search the Vault
                  </Link>
                  <Link
                    href="/cart"
                    className="inline-flex items-center rounded-lg border border-white/50 bg-white/5 px-4 py-2 text-sm font-semibold text-white backdrop-blur-sm hover:bg-white/10"
                  >
                    View Cart
                  </Link>
                  <Link
                    href="/categories/pokemon/cards"
                    className="inline-flex items-center rounded-lg border border-white/50 bg-white/5 px-4 py-2 text-sm font-semibold text-white backdrop-blur-sm hover:bg-white/10"
                  >
                    Pokémon Cards
                  </Link>
                </div>

                {/* Brand chips */}
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {BRANDS.map((b) => (
                    <Link
                      key={b}
                      href={`/search?q=${encodeURIComponent(b)}`}
                      className="rounded-full border border-white/30 bg-white/5 px-3 py-1 text-xs font-semibold text-white/90 backdrop-blur-sm hover:bg-white/10"
                    >
                      {b}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SHOP BY CATEGORY */}
{/* SHOP BY CATEGORY */}
<section className="mt-8 sm:mt-10 lg:mt-12" aria-labelledby="shop-by-category">
  <div className="mb-3 text-center">
    <h2
      id="shop-by-category"
      className="text-2xl font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,.6)] sm:text-3xl"
    >
      Shop by Category
    </h2>
    <p className="mt-1 text-2xl text-white/85 drop-shadow-[0_1px_1px_rgba(0,0,0,.6)]">
      Find sealed product, singles, slabs, and figures by game or line.
    </p>
    <Link
      href="/categories"
      className="text-sm font-semibold text-white/90 underline underline-offset-4 hover:text-white"
    >
      View all →
    </Link>
  </div>

  {/*
    Configure your tiles here.
    HREFs point to future set indexes following the Pokémon pattern.
    If your slugs differ, just tweak the hrefs.
  */}
  {(() => {
    const TILES: Array<{
      key: string;
      label: string;
      href: string;
      cfId: string;
      alt?: string;
    }> = [
      {
        key: "pokemon",
        label: "Pokémon",
        href: "/categories/pokemon/sets",
        cfId: "eb1a8f57-bd66-4203-fb59-32749ee3e500", // ✅ your provided ID
        alt: "Pokémon category",
      },
      {
        key: "yugioh",
        label: "Yu-Gi-Oh!",
        href: "/categories/yugioh/sets",
        cfId: "87101a20-6ada-4b66-0057-2d210feb9d00", // ✅ your provided ID
        alt: "Yu-Gi-Oh! category",
      },
      {
        key: "mtg",
        label: "Magic: The Gathering",
        href: "/categories/mtg/sets",
        cfId: "69ab5d2b-407c-4538-3c82-be8a551efa00", // ✅ your provided ID
        alt: "Magic: The Gathering category",
      },
      {
        key: "funko",
        label: "Funko Pop",
        href: "/categories/funko/sets",
        cfId: "48efbf88-be1f-4a1f-f3f7-892fe21b5000", // ✅ your provided ID
        alt: "Funko Pop category",
      },
      {
        key: "sports",
        label: "Sports Cards",
        href: "/categories/sports/sets",
        cfId: "f95ef753-c5fd-4079-9743-27cf651fd500", // ✅ your provided ID
        alt: "Sports Cards category",
      },
    ];

    return (
      <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {TILES.map((t) => {
          const src = cfImageUrl(t.cfId, "categoryThumb"); // change variant if you prefer
          return (
            <li
              key={t.key}
              className="rounded-xl border border-white/10 bg-white/5 overflow-hidden hover:border-white/20 hover:bg-white/10 transition"
            >
              <Link href={t.href} className="block">
                <div className="relative w-full" style={{ aspectRatio: "4 / 3" }}>
                  <Image
                    src={src}
                    alt={t.alt ?? t.label}
                    fill
                    unoptimized
                    priority={t.key === "pokemon"}
                    className="object-cover"
                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                  />
                </div>
                <div className="p-3">
                  <div className="text-sm font-semibold text-white">{t.label}</div>
                  <div className="text-xs text-white/75">Shop now →</div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    );
  })()}
</section>


        {/* FEATURED DROPS */}
        <section className="mt-10 sm:mt-12 lg:mt-14" aria-labelledby="featured-drops">
          <div className="mb-4 text-center">
            <h2 id="featured-drops" className="text-2xl font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,.6)] sm:text-3xl">
              🔥 Featured Drops
            </h2>
            <Link href="/drops" className="text-sm font-semibold text-white/90 underline underline-offset-4 hover:text-white">
              See all →
            </Link>
          </div>

          <div className="relative">
            <div className="flex snap-x gap-4 overflow-x-auto pb-2">
              {(FEATURED_ITEMS.length ? FEATURED_ITEMS : []).map((item, idx) => {
                const src = item.cfId ? (cfUrl(item.cfId, "saleCard") ?? FALLBACK_IMG) : FALLBACK_IMG;
                return (
                  <article
                    key={`${item.href}-${idx}`}
                    className="snap-start w-[280px] shrink-0 overflow-hidden rounded-xl border border-white/20 bg-white/5 shadow-[0_8px_20px_rgba(0,0,0,.25)] backdrop-blur-sm transition hover:bg-white/10 hover:border-white/30"
                  >
                    <div className="relative aspect-[4/3] w-full bg-white/5">
                      <Image
                        src={src}
                        alt={item.alt ?? item.title}
                        fill
                        className="object-cover"
                        sizes="(max-width: 640px) 90vw, (max-width: 1024px) 50vw, 33vw"
                        priority={false}
                      />
                    </div>
                    <div className="p-3">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="rounded border border-white/30 bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-white/90">
                          {(item.tag || "").toUpperCase()}
                        </span>
                      </div>
                      <Link href={item.href} className="line-clamp-2 font-semibold text-white hover:underline">
                        {item.title}
                      </Link>
                      <div className="mt-1 text-sm font-semibold text-white/90">{item.price}</div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* EMAIL CAPTURE (static, no client handlers here) */}
        <section className="my-10 sm:my-12 lg:my-14">
          <div className="overflow-hidden rounded-2xl border border-white/20 bg-white/5 p-5 text-white shadow-[0_8px_20px_rgba(0,0,0,.25)] backdrop-blur-sm ring-0 sm:p-6 lg:p-7">
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-lg font-semibold drop-shadow-[0_1px_2px_rgba(0,0,0,.6)]">Get first dibs on restocks & drops</h3>
                <p className="text-sm text-white/85 drop-shadow-[0_1px_2px_rgba(0,0,0,.6)]">No spam. Just heat.</p>
              </div>
              <form className="flex w-full max-w-md items-center gap-2" action="/newsletter" method="post">
                <input
                  type="email"
                  name="email"
                  required
                  placeholder="you@trainer.club"
                  className="w-full rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/70 outline-none backdrop-blur focus:ring-2 focus:ring-white/60"
                />
                <button
                  type="submit"
                  className="shrink-0 rounded-lg border border-white/60 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white/60"
                >
                  Notify me
                </button>
              </form>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
