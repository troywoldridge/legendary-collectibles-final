// Client-safe helpers + server-only functions via dynamic import.
// You can import ebaySearchLink from client components safely.

export type EbaySnapshot = {
  sample_count: number | null;
  min_cents: number | null;
  p25_cents: number | null;
  median_cents: number | null;
  p75_cents: number | null;
  max_cents: number | null;
  avg_cents: number | null;
  currency: string | null;
  created_at: string | null; // may be null if column doesn't exist
};

/** ---------------- eBay Partner search link (client-safe) ---------------- **/
/**
 * Builds an eBay search URL. If ePN vars exist, wraps with rover for attribution.
 *
 * Public (client) envs:
 *   NEXT_PUBLIC_EBAY_CAMPID=xxxxxxxxx
 *   NEXT_PUBLIC_EBAY_CUSTOMID=optional-note
 *   NEXT_PUBLIC_EBAY_TOOLID=10001
 *   NEXT_PUBLIC_EBAY_ROVER_PATH=1/711-53200-19255-0/1
 *   NEXT_PUBLIC_EBAY_CATEGORY_ID=183454   // CCG Individual Cards
 */
export function ebaySearchLink(opts: {
  q: string;
  categoryId?: string;
  campId?: string;
  customId?: string | null;
  toolId?: string;
  roverPath?: string; // e.g. "1/711-53200-19255-0/1"
}) {
  const {
    q,
    categoryId = process.env.NEXT_PUBLIC_EBAY_CATEGORY_ID || "183454",
    campId = process.env.NEXT_PUBLIC_EBAY_CAMPID || "",
    customId = process.env.NEXT_PUBLIC_EBAY_CUSTOMID || "",
    toolId = process.env.NEXT_PUBLIC_EBAY_TOOLID || "10001",
    roverPath = process.env.NEXT_PUBLIC_EBAY_ROVER_PATH || "1/711-53200-19255-0/1",
  } = opts;

  // Destination search URL
  const dest = new URL("https://www.ebay.com/sch/i.html");
  dest.searchParams.set("_nkw", q);
  if (categoryId) dest.searchParams.set("_sacat", categoryId);

  // Wrap with rover if we have a campaign id
  if (campId) {
    const rover = new URL(`https://rover.ebay.com/rover/${roverPath}`);
    rover.searchParams.set("campid", campId);
    if (customId) rover.searchParams.set("customid", customId);
    if (toolId) rover.searchParams.set("toolid", toolId);
    rover.searchParams.set("mpre", dest.toString());
    return rover.toString();
  }
  return dest.toString();
}

/** ---------------- Money util (unchanged) ---------------- **/
export function toMoneyUSDFromCents(c?: number | null) {
  return c == null ? "—" : `$${(c / 100).toFixed(2)}`;
}

/** ---------------- Server-only bits (dynamic import) ---------------- **/
async function columnExists(table: string, col: string): Promise<boolean> {
  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");
  const r = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${table}
        AND column_name = ${col}
    ) AS exists
  `);
  return Boolean(r.rows?.[0]?.exists);
}

export async function getLatestEbaySnapshot(
  category: "pokemon" | "ygo" | "mtg" | "sports",
  cardId: string,
  segment: "raw" | "graded" | "all" = "all"
): Promise<EbaySnapshot | null> {
  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");

  const hasCreatedAt = await columnExists("ebay_price_snapshots", "created_at");
  const hasId = await columnExists("ebay_price_snapshots", "id");

  const baseCols = sql`
    sample_count, min_cents, p25_cents, median_cents, p75_cents, max_cents, avg_cents, currency
  `;

  if (hasCreatedAt) {
    const q = await db.execute<EbaySnapshot>(sql`
      SELECT
        ${baseCols},
        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
      FROM ebay_price_snapshots
      WHERE card_id = ${cardId} AND category = ${category} AND segment = ${segment}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return q.rows?.[0] ?? null;
  }

  if (hasId) {
    const q = await db.execute<EbaySnapshot>(sql`
      SELECT
        ${baseCols},
        NULL::text AS created_at
      FROM ebay_price_snapshots
      WHERE card_id = ${cardId} AND category = ${category} AND segment = ${segment}
      ORDER BY id DESC
      LIMIT 1
    `);
    return q.rows?.[0] ?? null;
  }

  const q = await db.execute<EbaySnapshot>(sql`
    SELECT
      ${baseCols},
      NULL::text AS created_at
    FROM ebay_price_snapshots
    WHERE card_id = ${cardId} AND category = ${category} AND segment = ${segment}
    ORDER BY ctid DESC
    LIMIT 1
  `);
  return q.rows?.[0] ?? null;
}
