// scripts/syncYugioh.js
// Run: DATABASE_URL=... node scripts/syncYugioh.js
// Requires: npm i pg
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_URL = "https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes";
const CACHE_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(CACHE_DIR, "ygo_cardinfo.json");

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("❌ DATABASE_URL is missing. Export it then retry.");
  process.exit(1);
}

function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function asBool(v) {
  if (typeof v === "boolean") return v;
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (["true", "t", "1", "yes", "y"].includes(s)) return true;
  if (["false", "f", "0", "no", "n"].includes(s)) return false;
  return null;
}

async function ensureSchema(client) {
  const ddl = `
  ${/* -- paste from section (1) -- */""}
  CREATE TABLE IF NOT EXISTS ygo_cards (
    card_id           TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    type              TEXT,
    "desc"            TEXT,
    atk               INTEGER,
    def               INTEGER,
    level             INTEGER,
    race              TEXT,
    attribute         TEXT,
    archetype         TEXT,
    ygoprodeck_url    TEXT,
    linkval           INTEGER,
    scale             INTEGER,
    linkmarkers       TEXT[],
    has_effect        BOOLEAN,
    staple            BOOLEAN,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS ygo_cards_name_idx      ON ygo_cards USING GIN (to_tsvector('simple', coalesce(name,'')));
  CREATE INDEX IF NOT EXISTS ygo_cards_rarity_idx    ON ygo_cards (type, race, attribute);
  CREATE INDEX IF NOT EXISTS ygo_cards_archetype_idx ON ygo_cards (archetype);

  CREATE TABLE IF NOT EXISTS ygo_card_images (
    card_id           TEXT NOT NULL,
    image_url         TEXT NOT NULL,
    image_url_small   TEXT,
    image_id          TEXT,
    PRIMARY KEY (card_id, image_url),
    FOREIGN KEY (card_id) REFERENCES ygo_cards(card_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ygo_card_sets (
    card_id        TEXT NOT NULL,
    set_name       TEXT,
    set_code       TEXT,
    set_rarity     TEXT,
    set_price      TEXT,
    PRIMARY KEY (card_id, set_code),
    FOREIGN KEY (card_id) REFERENCES ygo_cards(card_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ygo_card_prices (
    card_id            TEXT PRIMARY KEY,
    amazon_price       TEXT,
    cardmarket_price   TEXT,
    tcgplayer_price    TEXT,
    ebay_price         TEXT,
    coolstuffinc_price TEXT,
    FOREIGN KEY (card_id) REFERENCES ygo_cards(card_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ygo_card_banlist (
    card_id   TEXT PRIMARY KEY,
    ban_tcg   TEXT,
    ban_ocg   TEXT,
    ban_goat  TEXT,
    FOREIGN KEY (card_id) REFERENCES ygo_cards(card_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ygo_card_misc (
    card_id    TEXT PRIMARY KEY,
    konami_id  TEXT,
    misc       JSONB,
    FOREIGN KEY (card_id) REFERENCES ygo_cards(card_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS ygo_card_misc_konami_idx ON ygo_card_misc (konami_id);

  CREATE TABLE IF NOT EXISTS ygo_raw_dump (
    id         TEXT PRIMARY KEY DEFAULT 'cardinfo_v7',
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload    JSONB NOT NULL
  );
  `;
  await client.query(ddl);
}

async function fetchAllCards() {
  // Try cache first (if exists and not empty)
  try {
    const stat = await fs.stat(CACHE_FILE);
    if (stat.size > 1024) {
      const raw = await fs.readFile(CACHE_FILE, "utf8");
      const json = JSON.parse(raw);
      if (json && Array.isArray(json.data)) {
        console.log(`🗃️  Using cached ${json.data.length} cards from ${CACHE_FILE}`);
        return json;
      }
    }
  } catch {
    // cache miss
  }

  console.log("🌐 Fetching from YGOPRODeck… (single request)");
  const res = await fetch(API_URL, { headers: { "User-Agent": "Legendary-Collectibles/1.0" } });
  if (!res.ok) {
    throw new Error(`YGOPRODeck fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (!json || !Array.isArray(json.data)) {
    throw new Error("Unexpected YGOPRODeck response shape.");
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(json), "utf8");
  console.log(`💾 Cached to ${CACHE_FILE} (${json.data.length} cards)`);
  return json;
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

async function upsertAll(client, cards) {
  console.log(`🗂️  Upserting ${cards.length} cards + related tables…`);
  const started = Date.now();

  // Begin a big transaction for consistency
  await client.query("BEGIN");

  // Raw dump (keep last snapshot)
  await client.query(
    `INSERT INTO ygo_raw_dump (id, payload) VALUES ('cardinfo_v7', $1)
     ON CONFLICT (id) DO UPDATE SET fetched_at = now(), payload = EXCLUDED.payload`,
    [JSON.stringify({ data: cards })]
  );

  // Prepare statements (simple form; ON CONFLICT upserts)
  const qCard = `
    INSERT INTO ygo_cards (card_id, name, type, "desc", atk, def, level, race, attribute, archetype, ygoprodeck_url, linkval, scale, linkmarkers, has_effect, staple, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
    ON CONFLICT (card_id) DO UPDATE SET
      name=EXCLUDED.name,
      type=EXCLUDED.type,
      "desc"=EXCLUDED."desc",
      atk=EXCLUDED.atk,
      def=EXCLUDED.def,
      level=EXCLUDED.level,
      race=EXCLUDED.race,
      attribute=EXCLUDED.attribute,
      archetype=EXCLUDED.archetype,
      ygoprodeck_url=EXCLUDED.ygoprodeck_url,
      linkval=EXCLUDED.linkval,
      scale=EXCLUDED.scale,
      linkmarkers=EXCLUDED.linkmarkers,
      has_effect=EXCLUDED.has_effect,
      staple=EXCLUDED.staple,
      updated_at=now()
  `;
  const qImg = `
    INSERT INTO ygo_card_images (card_id, image_url, image_url_small, image_id)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (card_id, image_url) DO NOTHING
  `;
  const qSet = `
    INSERT INTO ygo_card_sets (card_id, set_name, set_code, set_rarity, set_price)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (card_id, set_code) DO UPDATE SET
      set_name=EXCLUDED.set_name,
      set_rarity=EXCLUDED.set_rarity,
      set_price=EXCLUDED.set_price
  `;
  const qPrice = `
    INSERT INTO ygo_card_prices (card_id, amazon_price, cardmarket_price, tcgplayer_price, ebay_price, coolstuffinc_price)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (card_id) DO UPDATE SET
      amazon_price=EXCLUDED.amazon_price,
      cardmarket_price=EXCLUDED.cardmarket_price,
      tcgplayer_price=EXCLUDED.tcgplayer_price,
      ebay_price=EXCLUDED.ebay_price,
      coolstuffinc_price=EXCLUDED.coolstuffinc_price
  `;
  const qBan = `
    INSERT INTO ygo_card_banlist (card_id, ban_tcg, ban_ocg, ban_goat)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (card_id) DO UPDATE SET
      ban_tcg=EXCLUDED.ban_tcg,
      ban_ocg=EXCLUDED.ban_ocg,
      ban_goat=EXCLUDED.ban_goat
  `;
  const qMisc = `
    INSERT INTO ygo_card_misc (card_id, konami_id, misc)
    VALUES ($1,$2,$3)
    ON CONFLICT (card_id) DO UPDATE SET
      konami_id=EXCLUDED.konami_id,
      misc=EXCLUDED.misc
  `;

  let i = 0;
  for (const c of cards) {
    i++;
    if (i % 1000 === 0) {
      console.log(`  …${i}/${cards.length}`);
    }

    const card_id = String(c.id);
    const name = c.name ?? null;
    const type = c.type ?? null;
    const desc = c.desc ?? null;
    const atk = asInt(c.atk);
    const def = asInt(c.def);
    const level = asInt(c.level);
    const race = c.race ?? null;
    const attribute = c.attribute ?? null;
    const archetype = c.archetype ?? null;
    const ygoprodeck_url = c.ygoprodeck_url ?? null;
    const linkval = asInt(c.linkval);
    const scale = asInt(c.scale);
    const linkmarkers = Array.isArray(c.linkmarkers) ? c.linkmarkers : null;

    // Extra booleans if returned in misc/staple flags
    const has_effect = asBool(c.has_effect);
    const staple = asBool(c.staple);

    await client.query(qCard, [
      card_id, name, type, desc, atk, def, level, race, attribute, archetype,
      ygoprodeck_url, linkval, scale, linkmarkers, has_effect, staple
    ]);

    // images
    if (Array.isArray(c.card_images)) {
      const imgs = uniqueBy(
        c.card_images.map((im) => ({
          image_url: im.image_url ?? null,
          image_url_small: im.image_url_small ?? null,
          image_id: im.id ? String(im.id) : null,
        })).filter(x => x.image_url),
        (x) => x.image_url
      );
      for (const im of imgs) {
        await client.query(qImg, [card_id, im.image_url, im.image_url_small, im.image_id]);
      }
    }

    // sets
    if (Array.isArray(c.card_sets)) {
      const sets = uniqueBy(
        c.card_sets.map((s) => ({
          set_name: s.set_name ?? null,
          set_code: s.set_code ?? null,
          set_rarity: s.set_rarity ?? null,
          set_price: s.set_price ?? null,
        })).filter(s => s.set_code),
        (x) => x.set_code
      );
      for (const s of sets) {
        await client.query(qSet, [card_id, s.set_name, s.set_code, s.set_rarity, s.set_price]);
      }
    }

    // prices (single object)
    if (Array.isArray(c.card_prices) && c.card_prices[0]) {
      const p = c.card_prices[0];
      await client.query(qPrice, [
        card_id,
        p.amazon_price ?? null,
        p.cardmarket_price ?? null,
        p.tcgplayer_price ?? null,
        p.ebay_price ?? null,
        p.coolstuffinc_price ?? null
      ]);
    }

    // banlist (optional)
    if (c.banlist_info) {
      await client.query(qBan, [
        card_id,
        c.banlist_info.ban_tcg ?? null,
        c.banlist_info.ban_ocg ?? null,
        c.banlist_info.ban_goat ?? null
      ]);
    }

    // misc (when misc=yes)
    const misc = Array.isArray(c.misc_info) && c.misc_info[0] ? c.misc_info[0] : null;
    const konami_id = misc?.konami_id ? String(misc.konami_id) : null;
    if (misc) {
      await client.query(qMisc, [card_id, konami_id, JSON.stringify(misc)]);
    }
  }

  await client.query("COMMIT");
  const ms = Math.round((Date.now() - started) / 100) / 10;
  console.log(`✅ Done. Upserted ${cards.length} cards in ${ms}s`);
}

async function main() {
  const client = new Client({ connectionString: DB_URL, application_name: "ygo-sync" });
  await client.connect();
  try {
    await ensureSchema(client);

    const payload = await fetchAllCards();
    const cards = payload.data || [];
    if (!cards.length) {
      console.error("No cards returned from API.");
      process.exit(2);
    }

    await upsertAll(client, cards);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("❌ Sync failed:", err);
  process.exit(1);
});
