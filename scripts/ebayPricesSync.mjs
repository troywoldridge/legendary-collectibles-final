/* eslint-disable no-console */
// Node 20+
// deps: pg p-limit undici
import 'dotenv/config';
import { Pool } from 'pg';
import pLimit from 'p-limit';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetch } from 'undici';

/** ------------ ENV ------------ **/
const {
  DATABASE_URL,
  EBAY_CLIENT_ID,
  EBAY_CLIENT_SECRET,
  EBAY_MARKETPLACE_ID = 'EBAY_US',
  EBAY_RESULTS_PER_CARD = '120',
  EBAY_CONCURRENCY = '6',
  EBAY_CATEGORY_ID = '183454', // CCG Individual Cards
  // Tunables
  FETCH_TIMEOUT_MS = '12000',
  MAX_PAGES = '2',
  LOG_WRITES = '0',
} = process.env;

if (!DATABASE_URL) throw new Error('Missing DATABASE_URL');
if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) throw new Error('Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET');

const RESULTS_PER_CARD = Math.max(10, Math.min(200, Number(EBAY_RESULTS_PER_CARD) || 120));
const CONCURRENCY = Math.max(1, Math.min(16, Number(EBAY_CONCURRENCY) || 6));
const HTTP_TIMEOUT = Number(FETCH_TIMEOUT_MS) || 12000;
const PAGE_CAP = Math.max(1, Number(MAX_PAGES) || 2);
const SHOULD_LOG_WRITES = LOG_WRITES === '1';

/** ------------ CLI ------------ **/
const argv = process.argv.slice(2);
const getFlag = (name, def = null) => {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return def;
  const [, v] = argv[i].split('=');
  if (v !== undefined) return v;
  const v2 = argv[i + 1];
  return v2 && !v2.startsWith('--') ? v2 : true;
};
const GAME = String(getFlag('game', 'all') || 'all').toLowerCase(); // all|pokemon|ygo|mtg
const LIMIT = Number(getFlag('limit', '0')) || 0;
const STALE_DAYS = Number(getFlag('stale-days', '7')) || 7;

/** ------------ DB (pool + resilient queries) ------------ **/
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

const TRANSIENT_PG = /^(57P01|57P02|53300|08006|08000|08P01)$/;

async function dbQuery(sql, params = [], attempt = 1) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    const code = err?.code || '';
    if (attempt < 5 && TRANSIENT_PG.test(code)) {
      const backoff = 200 * attempt + Math.random() * 300;
      await sleep(backoff);
      return dbQuery(sql, params, attempt + 1);
    }
    throw err;
  }
}

/** ------------ schema helpers ------------ **/
async function tableExists(table) {
  const r = await dbQuery(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [table]
  );
  return r.rowCount > 0;
}
async function getExistingColumns(table) {
  const r = await dbQuery(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return new Set(r.rows.map(x => x.column_name));
}
async function getUniqueKeySets(table) {
  const r = await dbQuery(
    `
    SELECT tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema   = kcu.table_schema
    WHERE tc.table_schema='public'
      AND tc.table_name=$1
      AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')
    ORDER BY tc.constraint_name, kcu.ordinal_position
    `,
    [table]
  );
  const by = new Map();
  for (const row of r.rows) {
    if (!by.has(row.constraint_name)) by.set(row.constraint_name, []);
    by.get(row.constraint_name).push(row.column_name);
  }
  return [...by.values()];
}

/** Ensure/map price table; return profile */
async function ensurePriceTableProfile(game) {
  const table =
    game === 'pokemon' ? 'tcg_card_prices_ebay' :
    game === 'ygo'     ? 'ygo_card_prices_ebay' :
                         'mtg_card_prices_ebay';

  // Create if missing for Pokémon/YGO; MTG is custom
  if (!(await tableExists(table))) {
    if (game === 'pokemon') {
      await dbQuery(`
        CREATE TABLE ${table} (
          game         text NOT NULL,
          card_id      text NOT NULL,
          median       numeric,
          sample_count integer NOT NULL DEFAULT 0,
          currency     text NOT NULL DEFAULT 'USD',
          sample_url   text,
          updated_at   timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (game, card_id)
        )
      `);
    } else if (game === 'ygo') {
      await dbQuery(`
        CREATE TABLE ${table} (
          card_id      text PRIMARY KEY,
          median       numeric,
          sample_count integer NOT NULL DEFAULT 0,
          currency     text NOT NULL DEFAULT 'USD',
          sample_url   text,
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
    } else {
      console.log(`[mtg] ${table} not found; expecting your existing schema.`);
    }
  }

  const columns = await getExistingColumns(table);
  const idCandidates = ['id', 'card_id', 'cardid', 'cardId'];
  const idCol = idCandidates.find(c => columns.has(c)) || 'id';

  const keySets = await getUniqueKeySets(table);
  let keyCols =
    keySets.find(set => set.includes(idCol) && (!columns.has('game') || set.includes('game'))) ||
    keySets.find(set => set.includes(idCol)) ||
    [idCol];

  const hasUnique = keySets.some(set => set.join(',') === keyCols.join(','));
  const gameValue = columns.has('game')
    ? (game === 'pokemon' ? 'pokemon' : game === 'ygo' ? 'ygo' : 'mtg')
    : null;

  console.log(`[${game}] prices table: ${table} | idCol=${idCol} | keyCols=[${keyCols.join(', ')}] | unique=${hasUnique}`);
  return { table, idCol, keyCols, hasUnique, columns, gameValue };
}

/** ------------ HTTP with timeout ------------ **/
function fetchWithTimeout(url, opts = {}, ms = HTTP_TIMEOUT) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(new Error(`Timeout after ${ms}ms`)), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(id));
}

/** ------------ eBay OAuth & Browse ------------ **/
async function getEbayAppToken() {
  const basic = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  });
  const res = await fetchWithTimeout('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}` },
    body,
  }, HTTP_TIMEOUT);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`eBay OAuth failed: ${res.status} ${res.statusText} ${t}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function browseSearch(token, q, offset = 0, limit = 50) {
  const params = new URLSearchParams({
    q,
    category_ids: EBAY_CATEGORY_ID,
    limit: String(Math.min(200, Math.max(1, limit))),
    offset: String(Math.max(0, offset)),
    sort: 'price',
  });
  const res = await fetchWithTimeout(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': EBAY_MARKETPLACE_ID,
      'Accept': 'application/json',
    },
  }, HTTP_TIMEOUT);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Browse search failed: ${res.status} ${res.statusText} q="${q}" ${txt}`);
  }
  return res.json();
}

function extractPricesAndSampleUrl(page) {
  if (!page || !Array.isArray(page.itemSummaries)) return { prices: [], sampleUrl: null };
  const prices = [];
  let sampleUrl = null;
  for (const it of page.itemSummaries) {
    const price = Number(it?.price?.value ?? NaN);
    if (!Number.isFinite(price)) continue;
    let ship = 0;
    if (Array.isArray(it.shippingOptions) && it.shippingOptions.length) {
      let best = Infinity;
      for (const opt of it.shippingOptions) {
        const sc = Number(opt?.shippingCost?.value ?? NaN);
        if (Number.isFinite(sc)) best = Math.min(best, sc);
      }
      if (Number.isFinite(best)) ship = best;
    }
    const total = price + ship;
    if (Number.isFinite(total) && total > 0) {
      prices.push(total);
      if (!sampleUrl && it.itemWebUrl) sampleUrl = it.itemWebUrl;
    }
  }
  return { prices, sampleUrl };
}

/** ------------ stats ------------ **/
function quantiles(vals) {
  if (!vals.length) return null;
  const a = [...vals].sort((x, y) => x - y);
  const n = a.length;
  const q = (p) => {
    if (n === 1) return a[0];
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return a[lo];
    const w = idx - lo;
    return a[lo] * (1 - w) + a[hi] * w;
  };
  if (n >= 10) return { low: q(0.10), median: q(0.50), high: q(0.90), sample: n };
  return { low: a[0], median: q(0.50), high: a[n - 1], sample: n };
}

/** ------------ dynamic UPSERT helpers ------------ **/
function keyValueFor(col, meta, cardId) {
  if (col === meta.idCol) return cardId;
  if (col === 'game') return meta.gameValue;
  return null;
}
function collectParamCols(meta, stats, sampleUrl) {
  const { columns } = meta;
  const paramCols = [];
  const paramVals = [];
  const setLits = [];

  const add = (name, val) => { paramCols.push(name); paramVals.push(val); };

  if (columns.has('low'))          add('low', stats?.low ?? null);
  if (columns.has('median'))       add('median', stats?.median ?? null);
  if (columns.has('high'))         add('high', stats?.high ?? null);
  if (columns.has('sample_count')) add('sample_count', stats?.sample ?? 0);
  if (columns.has('currency'))     add('currency', 'USD');
  if (columns.has('sample_url'))   add('sample_url', sampleUrl ?? null);
  if (columns.has('method'))       add('method', 'active_listings');
  else if (columns.has('basis'))   add('basis', 'active_listings');

  if (columns.has('last_run'))     setLits.push('last_run = now()');
  if (columns.has('updated_at'))   setLits.push('updated_at = now()');

  return { paramCols, paramVals, setLits };
}
function buildUpsertSQL(meta, cardId, stats, sampleUrl) {
  const { table, keyCols } = meta;
  const { paramCols, paramVals, setLits } = collectParamCols(meta, stats, sampleUrl);

  const cols = [];
  const vals = [];
  const updates = [];
  const params = [];
  let i = 1;

  for (const kc of keyCols) {
    cols.push(kc);
    vals.push(`$${i++}`);
    params.push(keyValueFor(kc, meta, cardId));
  }
  for (let p = 0; p < paramCols.length; p++) {
    cols.push(paramCols[p]);
    vals.push(`$${i++}`);
    params.push(paramVals[p]);
    updates.push(`${paramCols[p]} = EXCLUDED.${paramCols[p]}`);
  }
  for (const lit of setLits) updates.push(lit);

  const conflict = `(${keyCols.join(', ')})`;
  const sql = `
    INSERT INTO ${table} (${cols.join(', ')})
    VALUES (${vals.join(', ')})
    ON CONFLICT ${conflict}
    DO UPDATE SET ${updates.join(', ')}
  `;
  return { sql, params };
}
function buildUpdateSQL(meta, cardId, stats, sampleUrl) {
  const { table, keyCols } = meta;
  const { paramCols, paramVals, setLits } = collectParamCols(meta, stats, sampleUrl);

  const sets = [];
  const params = [];
  let i = 1;
  for (let p = 0; p < paramCols.length; p++) {
    sets.push(`${paramCols[p]} = $${i++}`);
    params.push(paramVals[p]);
  }
  for (const lit of setLits) sets.push(lit);

  const wheres = [];
  for (const kc of keyCols) {
    wheres.push(`${kc} = $${i++}`);
    params.push(keyValueFor(kc, meta, cardId));
  }
  const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${wheres.join(' AND ')}`;
  return { sql, params };
}
function buildInsertSQL(meta, cardId, stats, sampleUrl) {
  const { table, keyCols } = meta;
  const { paramCols, paramVals, setLits } = collectParamCols(meta, stats, sampleUrl);

  const cols = [];
  const vals = [];
  const params = [];
  let i = 1;

  for (const kc of keyCols) {
    cols.push(kc);
    vals.push(`$${i++}`);
    params.push(keyValueFor(kc, meta, cardId));
  }
  for (let p = 0; p < paramCols.length; p++) {
    cols.push(paramCols[p]);
    vals.push(`$${i++}`);
    params.push(paramVals[p]);
  }
  for (const lit of setLits) {
    const [col] = lit.split('=').map(s => s.trim());
    cols.push(col);
    vals.push('now()');
  }
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
  return { sql, params };
}
async function upsertPrice(meta, cardId, stats, sampleUrl) {
  if (meta.hasUnique) {
    const { sql, params } = buildUpsertSQL(meta, cardId, stats, sampleUrl);
    await dbQuery(sql, params);
  } else {
    const upd = buildUpdateSQL(meta, cardId, stats, sampleUrl);
    const r = await dbQuery(upd.sql, upd.params);
    if (r.rowCount === 0) {
      const ins = buildInsertSQL(meta, cardId, stats, sampleUrl);
      await dbQuery(ins.sql, ins.params);
    }
  }
}

/** ------------ search helpers ------------ **/
function trimQ(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 100); }
function parsePokemonIdParts(id) {
  const m = String(id || '').match(/^([A-Za-z0-9]+)[-:](.+)$/); // 'xy5-1', 'sv4pt5-148', 'base6:67'
  return m ? { set_code: m[1], number: m[2] } : { set_code: null, number: null };
}
function buildQueriesForCard(game, card) {
  const safeGame = game === 'pokemon' ? 'Pokemon'
                 : game === 'ygo'     ? 'Yu-Gi-Oh!'
                 : game === 'mtg'     ? 'Magic The Gathering'
                 : '';

  let setCode = card.set_code || null;
  let number  = card.number || card.collector_number || null;
  if (game === 'pokemon' && (!setCode || !number)) {
    const p = parsePokemonIdParts(card.id);
    setCode = setCode || p.set_code;
    number  = number  || p.number;
  }

  const q1 = trimQ([card.name, setCode || card.set_name, number, safeGame].filter(Boolean).join(' '));
  const q2 = trimQ([card.name, setCode || card.set_name, safeGame].filter(Boolean).join(' '));
  const q3 = trimQ([card.name, safeGame].filter(Boolean).join(' '));
  return [q1, q2, q3].filter(Boolean);
}

/** ------------ load cards ------------ **/
async function getPokemonCards() {
  if (!(await tableExists('tcg_cards'))) {
    console.warn('No table "tcg_cards". Skipping Pokémon.');
    return [];
  }
  const cols = await getExistingColumns('tcg_cards');
  const selects = ['id', 'name'];
  if (cols.has('number')) selects.push('number');
  if (cols.has('collector_number')) selects.push('collector_number');
  if (cols.has('set.name')) selects.push('"set.name" AS set_name');
  if (cols.has('set.id'))   selects.push('"set.id"   AS set_id');
  const { rows } = await dbQuery(`SELECT ${selects.join(', ')} FROM tcg_cards`);
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    number: r.number ?? r.collector_number ?? null,
    set_name: r.set_name ?? null,
    set_code: r.set_id ?? null,
  }));
}
async function getYgoCards() {
  if (!(await tableExists('ygo_cards'))) {
    console.warn('No table "ygo_cards". Skipping Yu-Gi-Oh!.');
    return [];
  }
  const { rows } = await dbQuery(`SELECT card_id AS id, name FROM ygo_cards`);
  return rows.map(r => ({ id: r.id, name: r.name }));
}
async function getMtgCards() {
  if (await tableExists('mtg_cards')) {
    const cols = await getExistingColumns('mtg_cards');
    const selects = ['id', 'name'];
    if (cols.has('collector_number')) selects.push('collector_number');
    if (cols.has('set_code'))         selects.push('set_code');
    if (cols.has('set_name'))         selects.push('set_name');
    const { rows } = await dbQuery(`SELECT ${selects.join(', ')} FROM mtg_cards`);
    return rows.map(x => ({
      id: x.id,
      name: x.name,
      number: x.collector_number ?? null,
      collector_number: x.collector_number ?? null,
      set_code: x.set_code ?? null,
      set_name: x.set_name ?? null,
    }));
  }
  if (await tableExists('scryfall_cards')) {
    const cols = await getExistingColumns('scryfall_cards');
    const selects = ['id', 'name'];
    if (cols.has('collector_number')) selects.push('collector_number');
    if (cols.has('set_code'))         selects.push('set_code');
    if (cols.has('set_name'))         selects.push('set_name');
    const { rows } = await dbQuery(`SELECT ${selects.join(', ')} FROM scryfall_cards`);
    return rows.map(x => ({
      id: x.id,
      name: x.name,
      number: x.collector_number ?? null,
      collector_number: x.collector_number ?? null,
      set_code: x.set_code ?? null,
      set_name: x.set_name ?? null,
    }));
  }
  console.warn('No MTG table (mtg_cards or scryfall_cards). Skipping MTG.');
  return [];
}

/** ------------ per-card worker (with heartbeat) ------------ **/
async function handleCard(game, token, card, meta) {
  // HEARTBEAT: touch row so you see progress even if eBay is slow
  await upsertPrice(meta, card.id, { low: null, median: null, high: null, sample: 0 }, null);

  const queries = buildQueriesForCard(game, card);
  const seen = new Set();
  const prices = [];
  let sampleUrl = null;

  for (const q of queries) {
    if (!q || seen.has(q)) continue;
    seen.add(q);

    let offset = 0, pageFetches = 0, keepGoing = true;
    while (keepGoing && prices.length < RESULTS_PER_CARD) {
      try {
        const page = await browseSearch(token, q, offset, Math.min(50, RESULTS_PER_CARD - prices.length));
        const { prices: got, sampleUrl: pageUrl } = extractPricesAndSampleUrl(page);
        if (!sampleUrl && pageUrl) sampleUrl = pageUrl;
        for (const v of got) prices.push(v);

        const limit = Number(page?.limit ?? 50);
        const next = page?.next;
        offset += limit;
        pageFetches += 1;
        keepGoing = Boolean(next) && prices.length < RESULTS_PER_CARD && pageFetches < PAGE_CAP;
      } catch (err) {
        const msg = String(err?.message || err);
        if (/429|rate|quota|timeout|ETIMEDOUT|ECONNRESET|5\d\d/i.test(msg)) {
          await sleep(200 + Math.random() * 500);
          continue;
        }
        break; // try broader query
      }
    }
    if (prices.length >= 12) break; // good enough
  }

  const stats = prices.length ? quantiles(prices) : { low: null, median: null, high: null, sample: 0 };
  await upsertPrice(meta, card.id, stats, sampleUrl);
  if (SHOULD_LOG_WRITES) {
    console.log(`[${game}] wrote ${card.id} • samples=${stats.sample ?? 0} • median=${stats.median ?? '—'}`);
  }
  return { id: card.id, samples: stats.sample };
}

/** ------------ stale selection ------------ **/
function joinOn(meta, leftAlias, leftIdCol) {
  return meta.keyCols.map(kc => {
    if (kc === meta.idCol) return `p.${kc} = ${leftAlias}.${leftIdCol}`;
    if (kc === 'game') return `p.game = '${meta.gameValue}'`;
    return `p.${kc} IS NOT NULL`;
  }).join(' AND ');
}
function extraStalePredicate(meta) {
  const parts = [];
  if (meta.columns.has('sample_count')) parts.push('p.sample_count = 0');
  if (meta.columns.has('updated_at')) parts.push(`p.updated_at < now() - interval '${STALE_DAYS} days'`);
  return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
}
async function listStalePokemon(meta) {
  const sql = `
    SELECT c.id
    FROM tcg_cards c
    LEFT JOIN ${meta.table} p ON ${joinOn(meta, 'c', 'id')}
    WHERE p.${meta.keyCols[0]} IS NULL
       OR ${extraStalePredicate(meta)}
  `;
  const { rows } = await dbQuery(sql);
  return rows.map(r => r.id);
}
async function listStaleYgo(meta) {
  const sql = `
    SELECT c.card_id AS id
    FROM ygo_cards c
    LEFT JOIN ${meta.table} p ON ${joinOn(meta, 'c', 'card_id')}
    WHERE p.${meta.keyCols[0]} IS NULL
       OR ${extraStalePredicate(meta)}
  `;
  const { rows } = await dbQuery(sql);
  return rows.map(r => r.id);
}
async function listStaleMtg(meta) {
  const hasMtg = await tableExists('mtg_cards');
  const hasSf  = await tableExists('scryfall_cards');
  const source = hasMtg ? 'mtg_cards' : hasSf ? 'scryfall_cards' : null;
  if (!source) return [];
  const sql = `
    SELECT s.id
    FROM ${source} s
    LEFT JOIN ${meta.table} p ON ${joinOn(meta, 's', 'id')}
    WHERE p.${meta.keyCols[0]} IS NULL
       OR ${extraStalePredicate(meta)}
  `;
  const { rows } = await dbQuery(sql);
  return rows.map(r => r.id);
}

/** ------------ main ------------ **/
async function main() {
  try {
    console.log('Ensuring/mapping price tables…');
    const metaPokemon = await ensurePriceTableProfile('pokemon');
    const metaYgo     = await ensurePriceTableProfile('ygo');
    const metaMtg     = await ensurePriceTableProfile('mtg');

    console.log('Fetching eBay token…');
    let token = await getEbayAppToken();

    const limit = pLimit(CONCURRENCY);

    async function doGame(game, meta) {
      let cards = [];
      if (game === 'pokemon') cards = await getPokemonCards();
      if (game === 'ygo')     cards = await getYgoCards();
      if (game === 'mtg')     cards = await getMtgCards();

      if (!cards.length) {
        console.log(`[${game}] No cards found. Skipping.`);
        return;
      }

      let staleIds = [];
      if (game === 'pokemon') staleIds = await listStalePokemon(meta);
      if (game === 'ygo')     staleIds = await listStaleYgo(meta);
      if (game === 'mtg')     staleIds = await listStaleMtg(meta);

      const todo = cards.filter(c => staleIds.includes(c.id));
      const list = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;
      console.log(`[${game}] processing ${list.length}/${cards.length} (stale >= ${STALE_DAYS}d, limit=${LIMIT || '∞'})…`);

      let ok = 0, miss = 0;
      const t0 = Date.now();

      await Promise.all(list.map(card => limit(async () => {
        try {
          const res = await handleCard(game, token, card, meta);
          if (!res || res.samples === 0) miss++; else ok++;
        } catch (e) {
          const m = String(e?.message || e);
          if (/401|expired token|invalid_token/i.test(m)) {
            token = await getEbayAppToken();
            try {
              const res2 = await handleCard(game, token, card, meta);
              if (!res2 || res2.samples === 0) miss++; else ok++;
            } catch (e2) {
              console.warn(`[${game}] ${card.id} ${card.name || ''} → error: ${String(e2.message || e2)}`);
              miss++;
            }
          } else {
            console.warn(`[${game}] ${card.id} ${card.name || ''} → error: ${m}`);
            miss++;
          }
        }

        const done = ok + miss;
        if (done % 50 === 0) {
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(`[${game}] ${done}/${list.length} in ${secs}s…`);
        }
      })));

      console.log(`[${game}] DONE → updated=${ok}, missing=${miss}`);
    }

    if (GAME === 'all' || GAME === 'pokemon') await doGame('pokemon', metaPokemon);
    if (GAME === 'all' || GAME === 'ygo')     await doGame('ygo', metaYgo);
    if (GAME === 'all' || GAME === 'mtg')     await doGame('mtg', metaMtg);

    console.log('All done.');
  } finally {
    await pool.end().catch(() => {});
  }
}

// nicer logs if something slips through
process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED REJECTION:', e);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT EXCEPTION:', e);
  process.exit(1);
});

main().catch(err => {
  console.error(err);
  process.exit(1);
});
