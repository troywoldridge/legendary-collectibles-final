import Link from "next/link";
import Image from "next/image";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import MarketPrices from "@/components/MarketPrices";
import PriceSparkline from "@/components/PriceSparkline"; // <-- client component, safe to import
import { type DisplayCurrency, getFx } from "@/lib/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ---- DB row types ---- */
type CardRow = {
  id: string;
  name: string | null;
  supertype: string | null;
  subtypes: string | null;
  level: string | null;
  hp: string | null;
  types: string | null;
  evolves_from: string | null;
  evolves_to: string | null;
  rules: string | null;
  ancient_trait_name: string | null;
  ancient_trait_text: string | null;
  converted_retreat_cost: string | null;
  retreat_cost: string | null;
  set_id: string | null;
  set_name: string | null;
  series: string | null;
  printed_total: string | null;
  total: string | null;
  ptcgo_code: string | null;
  release_date: string | null;
  regulation_mark: string | null;
  artist: string | null;
  rarity: string | null;
  flavor_text: string | null;
  small_image: string | null;
  large_image: string | null;
  tcgplayer_url: string | null;
  tcgplayer_updated_at: string | null;
  cardmarket_url: string | null;
  cardmarket_updated_at: string | null;
};

type LegalityRow = { format: string | null; legality: string | null };
type SearchParams = Record<string, string | string[] | undefined>;

/* ---------------- helpers ---------------- */
function bestImg(c: CardRow) {
  return c.large_image || c.small_image || null;
}

/** interpret comma/pipe/semicolon lists or JSON arrays stored as text */
function splitList(s?: string | null): string[] {
  if (!s) return [];
  const t = s.trim();
  if (!t) return [];
  if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map(String);
      if (parsed && typeof parsed === "object") return Object.values(parsed).map(String);
    } catch {}
  }
  return t.split(/[,;|]/g).map((x) => x.trim()).filter(Boolean);
}

/** Accept both ?display= and legacy ?currency= (USD|EUR) else NATIVE */
function readDisplay(sp: SearchParams): DisplayCurrency {
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

/* ---------------- page ---------------- */
export default async function PokemonCardDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const baseHref = `/categories/pokemon/cards/${encodeURIComponent(id ?? "")}`;
  const display = readDisplay(sp);
  const wanted = decodeURIComponent(id ?? "").trim();

  // exact ID
  let card =
    (
      await db.execute<CardRow>(
        sql`SELECT * FROM tcg_cards WHERE id = ${wanted} LIMIT 1`
      )
    ).rows?.[0] ?? null;

  // case/whitespace-insensitive fallback
  if (!card) {
    card =
      (
        await db.execute<CardRow>(
          sql`SELECT * FROM tcg_cards WHERE lower(trim(id)) = lower(${wanted}) LIMIT 1`
        )
      ).rows?.[0] ?? null;
  }

  if (!card) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-bold text-white">Card not found</h1>
        <p className="text-white/70 text-sm break-all">
          Tried ID: <code>{wanted}</code>
        </p>
        <div className="flex gap-4">
          <Link href="/categories/pokemon/cards" className="text-sky-300 hover:underline">
            ← Back to all cards
          </Link>
          <Link href="/categories/pokemon/sets" className="text-sky-300 hover:underline">
            ← Browse sets
          </Link>
        </div>
      </section>
    );
  }

  // optional: set legalities
  const legalities: LegalityRow[] =
    card.set_id
      ? (
          await db.execute<LegalityRow>(
            sql`SELECT format, legality FROM tcg_sets_legalities WHERE set_id = ${card.set_id} ORDER BY format ASC`
          )
        ).rows ?? []
      : [];

  const hero = bestImg(card);
  const setHref = card.set_name
    ? `/categories/pokemon/sets/${encodeURIComponent(card.set_name)}`
    : card.set_id
    ? `/categories/pokemon/sets/${encodeURIComponent(card.set_id)}`
    : null;

  const chipsTypes = splitList(card.types);
  const chipsSubtypes = splitList(card.subtypes);
  const rulesList = splitList(card.rules);
  const evoTo = splitList(card.evolves_to);

  // FX note (if converting)
  const fx = getFx();

  return (
    <article className="grid gap-6 md:grid-cols-2">
      {/* image */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-2 overflow-hidden">
        <div className="relative w-full" style={{ aspectRatio: "3 / 4" }}>
          {hero ? (
            <Image
              src={hero}
              alt={card.name ?? card.id}
              fill
              unoptimized
              className="object-contain"
              sizes="(max-width: 768px) 100vw, 50vw"
              priority
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-white/70">No image</div>
          )}
        </div>
      </div>

      {/* details */}
      <div className="grid gap-4">
        {/* top line: set + display toggle */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-white/80">
            {setHref ? (
              <>
                Set:{" "}
                <Link href={setHref} className="text-sky-300 hover:underline">
                  {card.set_name ?? card.set_id}
                </Link>
              </>
            ) : null}
          </div>

          {/* display selector */}
          <div className="rounded-md border border-white/20 bg-white/10 p-1 text-sm text-white">
            <span className="px-2">Display:</span>
            <Link
              href={withParam(baseHref, "display", "NATIVE")}
              className={`rounded px-2 py-1 ${display === "NATIVE" ? "bg-white/20" : "hover:bg-white/10"}`}
            >
              Native
            </Link>
            <Link
              href={withParam(baseHref, "display", "USD")}
              className={`ml-1 rounded px-2 py-1 ${display === "USD" ? "bg-white/20" : "hover:bg-white/10"}`}
            >
              USD
            </Link>
            <Link
              href={withParam(baseHref, "display", "EUR")}
              className={`ml-1 rounded px-2 py-1 ${display === "EUR" ? "bg-white/20" : "hover:bg-white/10"}`}
            >
              EUR
            </Link>
          </div>
        </div>

        {/* headline */}
        <h1 className="text-2xl font-bold text-white">{card.name ?? card.id}</h1>

        <div className="text-sm text-white/70">
          {[
            card.series || undefined,
            card.ptcgo_code ? `PTCGO: ${card.ptcgo_code}` : undefined,
            card.release_date ? `Released: ${card.release_date}` : undefined,
            card.regulation_mark ? `Regulation: ${card.regulation_mark}` : undefined,
          ]
            .filter(Boolean)
            .join(" • ")}
        </div>

        {/* quick facts */}
        <div className="grid grid-cols-2 gap-2 text-sm text-white/90">
          {card.rarity && (
            <div>
              <span className="text-white/70">Rarity:</span> {card.rarity}
            </div>
          )}
          {card.artist && (
            <div>
              <span className="text-white/70">Artist:</span> {card.artist}
            </div>
          )}
          {card.hp && (
            <div>
              <span className="text-white/70">HP:</span> {card.hp}
            </div>
          )}
          {card.level && (
            <div>
              <span className="text-white/70">Level:</span> {card.level}
            </div>
          )}
          {card.retreat_cost && (
            <div className="col-span-2">
              <span className="text-white/70">Retreat Cost:</span> {card.retreat_cost}
            </div>
          )}
          {card.converted_retreat_cost && (
            <div className="col-span-2">
              <span className="text-white/70">Converted Retreat:</span> {card.converted_retreat_cost}
            </div>
          )}
          {card.evolves_from && (
            <div className="col-span-2">
              <span className="text-white/70">Evolves from:</span> {card.evolves_from}
            </div>
          )}
          {evoTo.length > 0 && (
            <div className="col-span-2">
              <span className="text-white/70">Evolves to:</span> {evoTo.join(", ")}
            </div>
          )}
        </div>

        {/* chips */}
        {(chipsTypes.length > 0 || chipsSubtypes.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {chipsTypes.map((t, i) => (
              <span
                key={`t-${i}`}
                className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-xs text-white"
              >
                {t}
              </span>
            ))}
            {chipsSubtypes.map((t, i) => (
              <span
                key={`st-${i}`}
                className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-xs text-white/90"
              >
                {t}
              </span>
            ))}
          </div>
        )}

        {/* rules / ancient trait / flavor */}
        {rulesList.length > 0 && (
          <section className="rounded-lg border border-white/10 bg-white/5 p-3">
            <h2 className="font-semibold text-white">Rules</h2>
            <ul className="mt-1 list-disc pl-5 text-sm text-white/85">
              {rulesList.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </section>
        )}

        {(card.ancient_trait_name || card.ancient_trait_text) && (
          <section className="rounded-lg border border-white/10 bg-white/5 p-3">
            <h2 className="font-semibold text-white">Ancient Trait</h2>
            <div className="text-sm text-white/90">
              {card.ancient_trait_name ? (
                <div className="font-medium">{card.ancient_trait_name}</div>
              ) : null}
              {card.ancient_trait_text ? (
                <p className="text-white/80 mt-1">{card.ancient_trait_text}</p>
              ) : null}
            </div>
          </section>
        )}

        {card.flavor_text && (
          <section className="rounded-lg border border-white/10 bg-white/5 p-3">
            <h2 className="font-semibold text-white">Flavor</h2>
            <p className="text-sm text-white/80">{card.flavor_text}</p>
          </section>
        )}

        {/* unified price panel */}
        <MarketPrices category="pokemon" cardId={card.id} display={display} />

        {/* mini trend glances (sparklines) */}
        <section className="grid gap-3 md:grid-cols-2">
          <PriceSparkline
            category="pokemon"
            cardId={card.id}
            market="TCGplayer"
            keyName="normal"
            days={30}
            display={display}
            label="TCGplayer • Normal (30d)"
          />
          <PriceSparkline
            category="pokemon"
            cardId={card.id}
            market="Cardmarket"
            keyName="trend_price"
            days={30}
            display={display}
            label="Cardmarket • Trend (30d)"
          />
        </section>

        {/* FX note if converting */}
        {display !== "NATIVE" && (fx.usdToEur != null || fx.eurToUsd != null) && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-white/60">
            <span>
              Converted to {display} using env FX (
              {[
                fx.usdToEur != null ? `USD→EUR=${fx.usdToEur.toFixed(4)}` : null,
                fx.eurToUsd != null ? `EUR→USD=${fx.eurToUsd.toFixed(4)}` : null,
              ]
                .filter(Boolean)
                .join(", ")}
              )
            </span>
          </div>
        )}

        {/* back links */}
        <div className="mt-2 flex gap-4">
          <Link href="/categories/pokemon/cards" className="text-sky-300 hover:underline">
            ← Back to cards
          </Link>
          {setHref && (
            <>
              <Link href={setHref} className="text-sky-300 hover:underline">
                ← Back to set
              </Link>
              <Link href={`${setHref}/prices`} className="text-sky-300 hover:underline">
                View set price overview →
              </Link>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
