// scripts/ygoUpsertAll.mjs
/* eslint-disable no-console */
// Node 20+ (global fetch available)
import pg from "pg";
const { Pool } = pg;

// ---------- ENV ----------
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL env");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

// ---------- API ----------
const API_CARDS = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const FETCH_OPTS = { headers: { "User-Agent": "Legendary-Collectibles/ygopull" } };

// ---------- HELPERS ----------
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};
const toNumOrNull = (v) =>
  Number.isFinite(v) ? v : (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

// ---------- SQL (all UPSERTs) ----------
const upsertCardSQL = `
INSERT INTO ygo_cards
  (card_id, name, type, "desc", atk, def, level, race, attribute, archetype, ygoprodeck_url, linkval, scale, linkmarkers, updated_at)
VALUES
  ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
ON CONFLICT (card_id) DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type,
  "desc" = EXCLUDED."desc",
  atk = EXCLUDED.atk,
  def = EXCLUDED.def,
  level = EXCLUDED.level,
  race = EXCLUDED.race,
  attribute = EXCLUDED.attribute,
  archetype = EXCLUDED.archetype,
  ygoprodeck_url = EXCLUDED.ygoprodeck_url,
  linkval = EXCLUDED.linkval,
  scale = EXCLUDED.scale,
  linkmarkers = EXCLUDED.linkmarkers,
  updated_at = now()
`;

const upsertPriceSQL = `
INSERT INTO ygo_card_prices
  (card_id, tcgplayer_price, cardmarket_price, ebay_price, amazon_price, coolstuffinc_price)
VALUES
  ($1,$2,$3,$4,$5,$6)
ON CONFLICT (card_id) DO UPDATE SET
  tcgplayer_price   = EXCLUDED.tcgplayer_price,
  cardmarket_price  = EXCLUDED.cardmarket_price,
  ebay_price        = EXCLUDED.ebay_price,
  amazon_price      = EXCLUDED.amazon_price,
  coolstuffinc_price= EXCLUDED.coolstuffinc_price
`;

const upsertBanSQL = `
INSERT INTO ygo_card_banlist
  (card_id, ban_tcg, ban_ocg, ban_goat)
VALUES
  ($1,$2,$3,$4)
ON CONFLICT (card_id) DO UPDATE SET
  ban_tcg  = EXCLUDED.ban_tcg,
  ban_ocg  = EXCLUDED.ban_ocg,
  ban_goat = EXCLUDED.ban_goat
`;

// ygo_card_sets is expected to have a UNIQUE/PK on (card_id, set_code)
const upsertSetSQL = `
INSERT INTO ygo_card_sets (card_id, set_name, set_code, set_rarity, set_price)
VALUES ($1,$2,$3,$4,$5)
ON CONFLICT (card_id, set_code) DO UPDATE SET
  set_name   = EXCLUDED.set_name,
  set_rarity = EXCLUDED.set_rarity,
  set_price  = EXCLUDED.set_price
`;

/**
 * ygo_card_images likely doesn't have a natural unique key beyond the URLs.
 * Strategy:
 *   1) Try UPDATE by (card_id AND (image_url = $2 OR image_url_small = $3)).
 *   2) If no rows updated, INSERT a new row.
 *
 * Add a UNIQUE constraint later if you want true ON CONFLICT handling, e.g.:
 *   ALTER TABLE ygo_card_images ADD CONSTRAINT ygo_card_images_unique UNIQUE (card_id, image_url);
 */
const updateImageSQL = `
UPDATE ygo_card_images
SET image_url_small = COALESCE($3, image_url_small), image_url = COALESCE($2, image_url)
WHERE card_id = $1 AND (image_url = COALESCE($2,'') OR image_url_small = COALESCE($3,''))
`;
const insertImageSQL = `
INSERT INTO ygo_card_images (card_id, image_url_small, image_url)
VALUES ($1,$3,$2)
`;

// ---------- MAIN ----------
async function main() {
  console.log("Fetching all cards from YGOPRODeck…");
  const res = await fetch(API_CARDS, FETCH_OPTS);
  if (!res.ok) {
    console.error("YGOPRODeck error", res.status, await res.text());
    process.exit(1);
  }
  const payload = await res.json();
  const cards = payload?.data ?? [];
  console.log(`Got ${cards.length} cards`);

  let processed = 0;
  const batches = chunk(cards, 400);
  const t0 = Date.now();

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const c of batch) {
        const cardId = String(c.id);
        const linkmarkers = Array.isArray(c.linkmarkers) ? c.linkmarkers : null;

        // 1) cards (UPSERT)
        await client.query(upsertCardSQL, [
          cardId,
          c.name ?? null,
          c.type ?? null,
          c.desc ?? null,
          toNumOrNull(c.atk),
          toNumOrNull(c.def),
          toNumOrNull(c.level),
          c.race ?? null,
          c.attribute ?? null,
          c.archetype ?? null,
          `https://db.ygoprodeck.com/card/?search=${encodeURIComponent(c.name ?? cardId)}`,
          toNumOrNull(c.linkval),
          toNumOrNull(c.scale),
          linkmarkers, // expect text[] in schema
        ]);

        // 2) prices (UPSERT if present)
        const price = Array.isArray(c.card_prices) && c.card_prices[0] ? c.card_prices[0] : null;
        if (price) {
          await client.query(upsertPriceSQL, [
            cardId,
            toNumOrNull(price.tcgplayer_price),
            toNumOrNull(price.cardmarket_price),
            toNumOrNull(price.ebay_price),
            toNumOrNull(price.amazon_price),
            toNumOrNull(price.coolstuffinc_price),
          ]);
        }

        // 3) banlist (UPSERT if present)
        const ban = c.banlist_info || null;
        if (ban) {
          await client.query(upsertBanSQL, [
            cardId,
            ban?.ban_tcg ?? null,
            ban?.ban_ocg ?? null,
            ban?.ban_goat ?? null,
          ]);
        }

        // 4) sets (UPSERT each, de-dupe by set_code)
        const sets = Array.isArray(c.card_sets) ? c.card_sets : [];
        const seenCodes = new Set();
        for (const s of sets) {
          const code = (s.set_code ?? "").trim();
          if (!code || seenCodes.has(code)) continue;
          seenCodes.add(code);

          await client.query(upsertSetSQL, [
            cardId,
            s.set_name ?? null,
            code,
            s.set_rarity ?? null,
            s.set_price != null && s.set_price !== "" ? String(s.set_price) : null,
          ]);
        }

        // 5) images — UPDATE first; if no row changed, INSERT
        const imgs = Array.isArray(c.card_images) ? c.card_images : [];
        const seenImg = new Set();
        for (const img of imgs) {
          const small = img.image_url_small ?? "";
          const large = img.image_url ?? "";
          const key = `${small}::${large}`;
          if (seenImg.has(key)) continue;
          seenImg.add(key);
          if (!small && !large) continue;

          const upd = await client.query(updateImageSQL, [cardId, large || null, small || null]);
          if (upd.rowCount === 0) {
            await client.query(insertImageSQL, [cardId, large || null, small || null]);
          }
        }
      }

      await client.query("COMMIT");
      client.release();

      processed += batch.length;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `Upserted batch ${bi + 1}/${batches.length} — ${batch.length} cards (total ${processed}/${cards.length}) in ${elapsed}s`
      );
    } catch (err) {
      try { await pool.query("ROLLBACK"); } catch {}
      client.release();
      console.error("Batch failed:", err);
      process.exit(1);
    }
  }

  console.log("All done.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
