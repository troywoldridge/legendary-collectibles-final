#!/usr/bin/env node
/**
 * Snapshot current prices into history tables (Pokémon + YGO).
 * Run daily via cron/systemd. Requires: DATABASE_URL
 *
 * pnpm add pg
 * node scripts/snapshotPrices.js
 */
import pg from "pg";

const { Client } = pg;

function parseMoneyToNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[\s,$€£¥₩]/g, "");
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseTs(raw) {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function snapshotPokemonTcgplayer(client) {
  const { rows } = await client.query(`
    SELECT card_id, url, updated_at, normal, holofoil, reverse_holofoil,
           first_edition_holofoil, first_edition_normal, currency
    FROM tcg_card_prices_tcgplayer
  `);

  let count = 0;
  for (const r of rows) {
    const q = `
      INSERT INTO tcg_card_prices_tcgplayer_history
        (card_id, source_updated_at, currency, normal, holofoil, reverse_holofoil, first_edition_holofoil, first_edition_normal)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    const params = [
      r.card_id,
      parseTs(r.updated_at),
      r.currency ?? null,
      parseMoneyToNumber(r.normal),
      parseMoneyToNumber(r.holofoil),
      parseMoneyToNumber(r.reverse_holofoil),
      parseMoneyToNumber(r.first_edition_holofoil),
      parseMoneyToNumber(r.first_edition_normal),
    ];
    await client.query(q, params);
    count++;
  }
  return count;
}

async function snapshotPokemonCardmarket(client) {
  const { rows } = await client.query(`
    SELECT card_id, url, updated_at, average_sell_price, low_price, trend_price, german_pro_low,
           suggested_price, reverse_holo_sell, reverse_holo_low, reverse_holo_trend,
           low_price_ex_plus, avg1, avg7, avg30, reverse_holo_avg1, reverse_holo_avg7, reverse_holo_avg30
    FROM tcg_card_prices_cardmarket
  `);

  let count = 0;
  for (const r of rows) {
    const q = `
      INSERT INTO tcg_card_prices_cardmarket_history
        (card_id, source_updated_at, average_sell_price, low_price, trend_price, german_pro_low, suggested_price,
         reverse_holo_sell, reverse_holo_low, reverse_holo_trend, low_price_ex_plus, avg1, avg7, avg30,
         reverse_holo_avg1, reverse_holo_avg7, reverse_holo_avg30)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    `;
    const params = [
      r.card_id,
      parseTs(r.updated_at),
      parseMoneyToNumber(r.average_sell_price),
      parseMoneyToNumber(r.low_price),
      parseMoneyToNumber(r.trend_price),
      parseMoneyToNumber(r.german_pro_low),
      parseMoneyToNumber(r.suggested_price),
      parseMoneyToNumber(r.reverse_holo_sell),
      parseMoneyToNumber(r.reverse_holo_low),
      parseMoneyToNumber(r.reverse_holo_trend),
      parseMoneyToNumber(r.low_price_ex_plus),
      parseMoneyToNumber(r.avg1),
      parseMoneyToNumber(r.avg7),
      parseMoneyToNumber(r.avg30),
      parseMoneyToNumber(r.reverse_holo_avg1),
      parseMoneyToNumber(r.reverse_holo_avg7),
      parseMoneyToNumber(r.reverse_holo_avg30),
    ];
    await client.query(q, params);
    count++;
  }
  return count;
}

async function snapshotYgo(client) {
  const { rows } = await client.query(`
    SELECT card_id, tcgplayer_price, cardmarket_price, ebay_price, amazon_price, coolstuffinc_price
    FROM ygo_card_prices
  `);

  let count = 0;
  for (const r of rows) {
    const q = `
      INSERT INTO ygo_card_prices_history
        (card_id, tcgplayer_price, cardmarket_price, ebay_price, amazon_price, coolstuffinc_price)
      VALUES ($1,$2,$3,$4,$5,$6)
    `;
    const params = [
      r.card_id,
      parseMoneyToNumber(r.tcgplayer_price),
      parseMoneyToNumber(r.cardmarket_price),
      parseMoneyToNumber(r.ebay_price),
      parseMoneyToNumber(r.amazon_price),
      parseMoneyToNumber(r.coolstuffinc_price),
    ];
    await client.query(q, params);
    count++;
  }
  return count;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
  }

  const client = new Client({ connectionString: url, application_name: "price-snapshot" });
  await client.connect();

  try {
    console.log("Starting price snapshot…");
    await client.query("BEGIN");

    const a = await snapshotPokemonTcgplayer(client);
    const b = await snapshotPokemonCardmarket(client);
    const c = await snapshotYgo(client);

    await client.query("COMMIT");
    console.log(`Done. Inserted: Pokémon TCGplayer=${a}, Pokémon Cardmarket=${b}, YGO=${c}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Snapshot failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
