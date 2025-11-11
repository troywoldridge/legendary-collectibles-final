/* eslint-disable no-console */
// scripts/ebayActivePriceSweep.mjs
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
  EBAY_CATEGORY_ID = '183454', // CCG Individual Cards
  // Tunables (defaults; override with CLI flags)
  EBAY_RESULTS_PER_CARD = '60',
  EBAY_CONCURRENCY = '3',
  FETCH_TIMEOUT_MS = '12000',
  MAX_PAGES = '1',
  LOG_WRITES = '0',
  USER_AGENT = 'LegendaryCollectiblesPriceSweep/1.1 (+legendary-collectibles.com)',
} = process.env;

if (!DATABASE_URL) throw new Error('Missing DATABASE_URL');
if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) throw new Error('Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET');

const DEFAULT_RESULTS_PER_CARD = Math.max(10, Math.min(200, Number(EBAY_RESULTS_PER_CARD) || 60));
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(16, Number(EBAY_CONCURRENCY) || 3));
const HTTP_TIMEOUT = Number(FETCH_TIMEOUT_MS) || 12000;
const DEFAULT_PAGE_CAP = Math.max(1, Number(MAX_PAGES) || 1);
const SHOULD_LOG_WRITES = LOG_WRITES === '1';

/** ------------ CLI ------------ **/
const argv = process.argv.slice(2);
const getFlag = (name, def = null) => {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return def;
  const [k, v] = argv[i].split('=');
  if (v !== undefined) return v;
  const v2 = argv[i + 1];
  return v2 && !v2.startsWith('--') ? v2 : true;
};

const GAME = String(getFlag('game', 'all') || 'all').toLowerCase(); // all|pokemon|ygo|mtg
const LIMIT = Number(getFlag('limit', '0')) || 0;
const STALE_DAYS = Number(getFlag('stale-days', '7')) || 7;
const CONCURRENCY = Math.max(1, Number(getFlag('concurrency', DEFAULT_CONCURRENCY)) || DEFAULT_CONCURRENCY);
const PAGE_CAP = Math.max(1, Number(getFlag('max-pages', DEFAULT_PAGE_CAP)) || DEFAULT_PAGE_CAP);
const RESULTS_PER_CARD = Math.max(10, Math.min(200, Number(getFlag('results-per-card', DEFAULT_RESULTS_PER_CARD)) || DEFAULT_RESULTS_PER_CARD));

// strict token bucket (requests/min) — 0 disables limiter (not recommended)
const RPM = Math.max(0, Number(getFlag('rpm', '12')) || 12);

// when <cooldownThreshold> consecutive 429s are observed, pause for cooldownMs
const cooldownThreshold = Math.max(1, Number(getFlag('cooldown-threshold', '3')) || 3);
const cooldownMs = Math.max(1000, Number(getFlag('cooldown-ms', '60000')) || 60000);

// max time allowed per card before we bail and move on
const cardTimeoutMs = Math.max(10000, Number(getFlag('card-timeout-ms', '60000')) || 60000);

// retry cap per page fetch (not counting global RPM waits)
const pageRetryCap = Math.max(0, Number(getFlag('page-retry-cap', '4')) || 4);

// verbosity
const DEBUG = String(getFlag('debug', '0')) === '1';
const TRACE_PAGES = String(getFlag('trace-pages', '0')) === '1';

// query builder knobs
const ASCII_FIRST = String(getFlag('ascii-first', '1')) === '1';         // try ASCII query first
const EXPAND_ALIASES = String(getFlag('alias-expansion', '1')) === '1';  // name + alias variations
const FALLBACK_IF_LESS_THAN = Math.max(0, Number(getFlag('fallback-sample-threshold', '6')) || 6); // expand only if < N samples

// browse filters
const DELIVERY_COUNTRY = String(getFlag('delivery-country', 'US') || 'US');
const PRICE_CURRENCY   = String(getFlag('price-currency', 'USD') || 'USD');
const BUYING_OPTIONS   = String(getFlag('buying-options', 'FIXED_PRICE') || 'FIXED_PRICE'); // FIXED_PRICE | AUCTION | BEST_OFFER

// rate-limit preflight (off by default; may require extra scopes in some accounts)
const RATE_PREFLIGHT = String(getFlag('rate-preflight', '0')) === '1';

if (RPM > 0) {
  console.log(`RPM=${RPM}/min • concurrency=${CONCURRENCY} • pageCap=${PAGE_CAP} • perCard=${RESULTS_PER_CARD}`);
}

/** ------------ DB ------------ **/
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
    SELECT tc.constraint_name, kcu.column_name, kcu.ordinal_position
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

/** Ensure/Map price tables; return profile */
async function ensurePriceTableProfile(game) {
  const table =
    game === 'pokemon' ? 'tcg_card_prices_ebay' :
    game === 'ygo'     ? 'ygo_card_prices_ebay' :
                         'mtg_card_prices_ebay';

  // Create minimal table if missing (Pokémon lean, YGO/MTG richer)
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
    } else {
      await dbQuery(`
        CREATE TABLE ${table} (
          card_id      text PRIMARY KEY,
          low          numeric,
          median       numeric,
          high         numeric,
          sample_count integer NOT NULL DEFAULT 0,
          currency     text NOT NULL DEFAULT 'USD',
          method       text NOT NULL DEFAULT 'active_listings',
          query        text NOT NULL DEFAULT '',
          sample_url   text,
          last_run     timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
    }
  }

  const columns = await getExistingColumns(table);
  const idCandidates = ['id', 'card_id', 'cardid', 'cardId'];
  const idCol = idCandidates.find(c => columns.has(c)) || 'card_id';

  const keySets = await getUniqueKeySets(table);
  let keyCols =
    keySets.find(set => set.includes(idCol) && (!columns.has('game') || set.includes('game'))) ||
    keySets.find(set => set.includes(idCol)) ||
    [idCol];

  const hasUnique = keySets.some(set => set.join(',') === keyCols.join(','));
  const gameValue = columns.has('game') ? (game === 'pokemon' ? 'pokemon' : game) : null;

  console.log(`[${game}] prices table: ${table} | idCol=${idCol} | keyCols=[${keyCols.join(', ')}] | unique=${hasUnique}`);
  return { table, idCol, keyCols, hasUnique, columns, gameValue };
}

/** ------------ HTTP with timeout + token bucket ------------ **/
function fetchWithTimeout(url, opts = {}, ms = HTTP_TIMEOUT) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(new Error(`Timeout after ${ms}ms`)), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(id));
}

// global precise RPM limiter
let bucket = 0;
let lastRefill = Date.now();
const perMinute = RPM;
function refillBucket() {
  if (perMinute <= 0) return;
  const now = Date.now();
  const elapsed = now - lastRefill; // ms
  if (elapsed > 0) {
    const add = (perMinute / 60000) * elapsed; // tokens per ms
    bucket = Math.min(perMinute, bucket + add);
    lastRefill = now;
  }
}
async function rpmWait() {
  if (perMinute <= 0) return;
  for (;;) {
    refillBucket();
    if (bucket >= 1) { bucket -= 1; return; }
    await sleep(200);
  }
}

/** ------------ eBay OAuth / (optional) Rate Preflight ------------ **/
async function getEbayAppToken() {
  const basic = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  });
  const res = await fetchWithTimeout('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}`, 'User-Agent': USER_AGENT },
    body,
  }, HTTP_TIMEOUT);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`eBay OAuth failed: ${res.status} ${res.statusText} ${t}`);
  }
  const data = await res.json();
  return data.access_token;
}

// Optional: will log your browse rate status if your account + token allows it.
// Gracefully ignored when unauthorized.
async function ratePreflight(token) {
  if (!RATE_PREFLIGHT) return;
  try {
    const res = await fetchWithTimeout('https://api.ebay.com/developer/analytics/v1/analytics/rate_limit', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    }, HTTP_TIMEOUT);
    if (!res.ok) {
      if (DEBUG) console.warn('[rate] preflight unavailable:', res.status, res.statusText);
      return;
    }
    const data = await res.json().catch(() => null);
    if (!data) return;
    const row = (data?.rateLimits || []).find(r => (r?.apiContext || '').includes('buy.browse') );
    if (row) {
      console.log(`[rate] buy.browse window=${row.timeWindow || '—'} used=${row.callsWithinLimit || '—'} limit=${row.callLimit || '—'} remaining=${row.callsRemaining || '—'}`);
    } else {
      console.log('[rate] preflight ok (no specific buy.browse row returned)');
    }
  } catch (e) {
    if (DEBUG) console.warn('[rate] preflight error:', String(e?.message || e));
  }
}

/** ------------ Browse search ------------ **/
async function browseSearch(token, q, offset = 0, limit = 50) {
  await rpmWait();
  const params = new URLSearchParams({
    q,
    category_ids: EBAY_CATEGORY_ID,
    limit: String(Math.min(200, Math.max(1, limit))),
    offset: String(Math.max(0, offset)),
    sort: 'price',
  });
  // Pragmatic filters to stabilize pricing samples
  const filters = [];
  if (DELIVERY_COUNTRY) filters.push(`deliveryCountry:${DELIVERY_COUNTRY}`);
  if (PRICE_CURRENCY)   filters.push(`priceCurrency:${PRICE_CURRENCY}`);
  if (BUYING_OPTIONS)   filters.push(`buyingOptions:{${BUYING_OPTIONS}}`);
  if (filters.length)   params.set('filter', filters.join(','));

  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`;
  if (DEBUG) console.log('[ebay] GET', url);
  const res = await fetchWithTimeout(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': EBAY_MARKETPLACE_ID,
      'Accept': 'application/json',
      'User-Agent': USER_AGENT,
    },
  }, HTTP_TIMEOUT);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const retryAfter = Number(res.headers.get('Retry-After'));
    const err = new Error(`Browse search failed: ${res.status} ${res.statusText} q="${q}" ${txt}`);
    err.retryAfter = Number.isFinite(retryAfter) ? retryAfter : null;
    err.status = res.status;
    throw err;
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
      if (Number.isFinite(best) && best !== Infinity) ship = best;
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
  if (!vals?.length) return null;
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

/** ------------ UPSERT helpers ------------ **/
function keyValueFor(col, meta, cardId) {
  if (col === meta.idCol) return cardId;
  if (col === 'game') return meta.gameValue;
  return null;
}

// include 'query' column when present; fill '' on heartbeat inserts to satisfy NOT NULL
function collectParamCols(meta, stats, sampleUrl, queryUsed) {
  const { columns } = meta;
  const paramCols = [], paramVals = [], setLits = [];
  const add = (name, val) => { paramCols.push(name); paramVals.push(val); };

  if (columns.has('low'))          add('low', stats?.low ?? null);
  if (columns.has('median'))       add('median', stats?.median ?? null);
  if (columns.has('high'))         add('high', stats?.high ?? null);
  if (columns.has('sample_count')) add('sample_count', stats?.sample ?? 0);
  if (columns.has('currency'))     add('currency', 'USD');
  if (columns.has('sample_url'))   add('sample_url', sampleUrl ?? null);
  if (columns.has('method'))       add('method', 'active_listings');
  else if (columns.has('basis'))   add('basis', 'active_listings');

  if (columns.has('query'))        add('query', (queryUsed ?? ''));

  if (columns.has('last_run'))     setLits.push('last_run = now()');
  if (columns.has('updated_at'))   setLits.push('updated_at = now()');

  return { paramCols, paramVals, setLits };
}
function buildUpsertSQL(meta, cardId, stats, sampleUrl, queryUsed) {
  const { table, keyCols } = meta;
  const { paramCols, paramVals, setLits } = collectParamCols(meta, stats, sampleUrl, queryUsed);

  const cols = [], vals = [], updates = [], params = [];
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
  const sql = `INSERT INTO ${table} (${cols.join(', ')})
               VALUES (${vals.join(', ')})
               ON CONFLICT ${conflict} DO UPDATE SET ${updates.join(', ')}`;
  return { sql, params };
}
function buildUpdateSQL(meta, cardId, stats, sampleUrl, queryUsed) {
  const { table, keyCols } = meta;
  const { paramCols, paramVals, setLits } = collectParamCols(meta, stats, sampleUrl, queryUsed);

  const sets = [], params = []; let i = 1;
  for (let p = 0; p < paramCols.length; p++) { sets.push(`${paramCols[p]} = $${i++}`); params.push(paramVals[p]); }
  for (const lit of setLits) sets.push(lit);

  const wheres = [];
  for (const kc of keyCols) { wheres.push(`${kc} = $${i++}`); params.push(keyValueFor(kc, meta, cardId)); }
  const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${wheres.join(' AND ')}`;
  return { sql, params };
}
function buildInsertSQL(meta, cardId, stats, sampleUrl, queryUsed) {
  const { table, keyCols } = meta;
  const { paramCols, paramVals, setLits } = collectParamCols(meta, stats, sampleUrl, queryUsed);

  const cols = [], vals = [], params = []; let i = 1;
  for (const kc of keyCols) { cols.push(kc); vals.push(`$${i++}`); params.push(keyValueFor(kc, meta, cardId)); }
  for (let p = 0; p < paramCols.length; p++) { cols.push(paramCols[p]); vals.push(`$${i++}`); params.push(paramVals[p]); }
  for (const lit of setLits) { const [col] = lit.split('=').map(s => s.trim()); cols.push(col); vals.push('now()'); }
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
  return { sql, params };
}
async function upsertPrice(meta, cardId, stats, sampleUrl, queryUsed) {
  if (meta.hasUnique) {
    const { sql, params } = buildUpsertSQL(meta, cardId, stats, sampleUrl, queryUsed);
    await dbQuery(sql, params);
  } else {
    const upd = buildUpdateSQL(meta, cardId, stats, sampleUrl, queryUsed);
    const r = await dbQuery(upd.sql, upd.params);
    if (r.rowCount === 0) {
      const ins = buildInsertSQL(meta, cardId, stats, sampleUrl, queryUsed);
      await dbQuery(ins.sql, ins.params);
    }
  }
}

/** ------------ search helpers ------------ **/
// NFKD removes diacritics; add a small symbol map (e.g., MTG delta species)
const SYMBOL_MAP = new Map([
  ['δ', 'delta'], ['Δ', 'delta'],
]);
const toASCII = (s) => {
  let t = String(s || '');
  for (const [k, v] of SYMBOL_MAP) t = t.replaceAll(k, v);
  return t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
};

// Keep under documented limit; be conservative (98 < 100)
function trimQ(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 98); }

function parsePokemonIdParts(id) {
  const m = String(id || '').match(/^([A-Za-z0-9]+)[-:](.+)$/); // 'xy5-1', 'sv4pt5-148', 'base6:67'
  return m ? { set_code: m[1], number: m[2] } : { set_code: null, number: null };
}
function gameAliases(game) {
  if (game === 'pokemon') return ['Pokemon TCG', 'Pokémon TCG', 'Pokemon Trading Card Game'];
  if (game === 'ygo')     return ['Yu-Gi-Oh!', 'YuGiOh', 'YGO'];
  if (game === 'mtg')     return ['Magic The Gathering', 'MTG', 'Magic: The Gathering'];
  return ['Trading Card Game'];
}
function primaryQuery(game, card) {
  let setCode = card.set_code || null;
  let setName = card.set_name || null;
  let number  = card.number || card.collector_number || null;

  // Prefer code+number in YGO when we have explicit set_num
  if (game === 'ygo' && card.set_code && card.set_num) {
    setCode = `${card.set_code}-${card.set_num}`;
  }

  if (game === 'pokemon' && (!setCode || !number)) {
    const p = parsePokemonIdParts(card.id);
    setCode = setCode || p.set_code;
    number  = number  || p.number;
  }

  const alias = gameAliases(game)[0];
  return trimQ([card.name, setCode || setName, number, alias].filter(Boolean).join(' '));
}
function fallbackQueries(game, card) {
  const aliases = EXPAND_ALIASES ? gameAliases(game) : [gameAliases(game)[0]];
  const setCode = (game === 'ygo' && card.set_code && card.set_num) ? `${card.set_code}-${card.set_num}` : (card.set_code || null);
  const setName = card.set_name || null;
  const number  = card.number || card.collector_number || null;

  const q2s = aliases.map(a => trimQ([card.name, setCode || setName, a].filter(Boolean).join(' ')));
  const q3s = aliases.map(a => trimQ([card.name, a].filter(Boolean).join(' ')));
  return [...new Set([...q2s, ...q3s].filter(Boolean))];
}

/** ------------ card loaders ------------ **/
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
  const hasSetTbl = await tableExists('ygo_card_sets');
  let hasSetNum = false;
  if (hasSetTbl) {
    const cols = await getExistingColumns('ygo_card_sets');
    hasSetNum = cols.has('set_num');
  }

  const { rows } = await dbQuery(`
    SELECT
      c.card_id AS id,
      c.name,
      MIN(s.set_code) AS set_code,
      MIN(s.set_name) AS set_name
      ${hasSetNum ? ', MIN(s.set_num) AS set_num' : ''}
    FROM ygo_cards c
    LEFT JOIN ygo_card_sets s ON s.card_id = c.card_id
    GROUP BY c.card_id, c.name
  `);

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    set_code: r.set_code ?? null,
    set_name: r.set_name ?? null,
    set_num: hasSetNum ? (r.set_num ?? null) : null,
    number: null,
  }));
}

async function getMtgCards() {
  const hasMtg = await tableExists('mtg_cards');
  const hasSf  = await tableExists('scryfall_cards');
  const source = hasMtg ? 'mtg_cards' : hasSf ? 'scryfall_cards' : null;
  if (!source) {
    console.warn('No MTG table (mtg_cards or scryfall_cards). Skipping MTG.');
    return [];
  }
  const cols = await getExistingColumns(source);
  const selects = ['id', 'name'];
  if (cols.has('collector_number')) selects.push('collector_number');
  if (cols.has('set_code'))         selects.push('set_code');
  if (cols.has('set_name'))         selects.push('set_name');
  const { rows } = await dbQuery(`SELECT ${selects.join(', ')} FROM ${source}`);
  return rows.map(x => ({
    id: x.id,
    name: x.name,
    number: x.collector_number ?? null,
    collector_number: x.collector_number ?? null,
    set_code: x.set_code ?? null,
    set_name: x.set_name ?? null,
  }));
}

/** ------------ per-card worker ------------ **/
async function handleCard(game, token, card, meta) {
  const startedAt = Date.now();
  const nameForLog = `${card.id} :: ${card.name || ''}`.trim();

  // Touch row so progress is visible (query column will be '' initially on YGO/MTG)
  await upsertPrice(meta, card.id, { low: null, median: null, high: null, sample: 0 }, null, '');

  const primary = primaryQuery(game, card);
  const primaryASCII = ASCII_FIRST ? toASCII(primary) : primary;
  const triedPrimaries = ASCII_FIRST && primaryASCII !== primary ? [primaryASCII, primary] : [primary];

  if (DEBUG) console.log(`[${game}] START ${nameForLog}`);
  let prices = [];
  let sampleUrl = null;
  let queryUsed = ''; // the first query that yields samples
  let global429 = 0;

  const tryOneQuery = async (q) => {
    let offset = 0, pages = 0, attempts = 0;
    while (pages < PAGE_CAP && prices.length < RESULTS_PER_CARD) {
      attempts += 1;
      try {
        if (TRACE_PAGES || DEBUG) console.log(`[${game}] ${card.id} → query="${q}" page@${offset}`);
        const page = await browseSearch(token, q, offset, Math.min(50, RESULTS_PER_CARD - prices.length));
        const { prices: got, sampleUrl: url } = extractPricesAndSampleUrl(page);
        if (!sampleUrl && url) sampleUrl = url;
        if (got.length && !queryUsed) queryUsed = q;
        for (const v of got) prices.push(v);

        const limit = Number(page?.limit ?? 50);
        const hasNext = Boolean(page?.next);
        offset += limit;
        pages += 1;
        if (!hasNext) break;
      } catch (err) {
        const status = err?.status || 0;
        const msg = String(err?.message || err);
        if (status === 429) {
          global429 += 1;
          const ra = Number(err?.retryAfter || NaN);
          if (global429 >= cooldownThreshold) {
            const wait = Number.isFinite(ra) ? ra * 1000 : cooldownMs;
            console.warn(`[rl] ${global429}x 429s → COOL-DOWN for ${Math.round(wait/1000)}s`);
            await sleep(wait);
            global429 = 0;
          } else {
            await sleep(500 + Math.random() * 1000);
          }
          if (Date.now() - startedAt > cardTimeoutMs) throw new Error('per-card timeout after 429s');
          continue;
        }
        if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|5\d\d/i.test(msg)) {
          if (attempts <= pageRetryCap) {
            await sleep(300 + Math.random() * 700);
            continue;
          }
        }
        // give up on this query; caller may try fallback
        break;
      }
    }
  };

  // 1) primary query (ASCII first if enabled)
  for (const q of triedPrimaries) {
    await tryOneQuery(q);
    if (prices.length >= FALLBACK_IF_LESS_THAN || Date.now() - startedAt > cardTimeoutMs) break;
  }

  // 2) fallbacks only if we still have few samples
  if (prices.length < FALLBACK_IF_LESS_THAN && Date.now() - startedAt <= cardTimeoutMs) {
    const fb = fallbackQueries(game, card);
    const seen = new Set(triedPrimaries);
    for (const q of fb) {
      if (seen.has(q)) continue;
      seen.add(q);
      const tryAscii = ASCII_FIRST ? [toASCII(q), q] : [q];
      for (const qq of tryAscii) {
        if (seen.has(qq)) continue;
        seen.add(qq);
        await tryOneQuery(qq);
        if (prices.length >= RESULTS_PER_CARD || Date.now() - startedAt > cardTimeoutMs) break;
      }
      if (prices.length >= RESULTS_PER_CARD || Date.now() - startedAt > cardTimeoutMs) break;
    }
  }

  const stats = prices.length ? quantiles(prices) : { low: null, median: null, high: null, sample: 0 };
  await upsertPrice(meta, card.id, stats, sampleUrl, queryUsed || triedPrimaries[0] || '');
  if (SHOULD_LOG_WRITES) {
    console.log(`[${game}] DONE ${card.id} samples=${stats.sample ?? 0} median=${stats.median ?? '—'} q="${(queryUsed || triedPrimaries[0] || '').slice(0,80)}"`);
  }
  return { id: card.id, samples: stats.sample ?? 0, median: stats.median ?? null };
}

/** ------------ stale selection ------------ **/
function joinOn(meta, leftAlias, leftIdCol) {
  return meta.keyCols.map(kc => {
    if (kc === meta.idCol) return `p.${kc} = ${leftAlias}.${leftIdCol}`;
    if (kc === 'game') return `p.game = '${meta.gameValue}'`;
    return `TRUE`;
  }).join(' AND ');
}
function extraStalePredicate(meta) {
  const parts = [];
  if (meta.columns.has('sample_count')) parts.push('p.sample_count = 0');
  if (meta.columns.has('updated_at')) parts.push(`p.updated_at < now() - interval '${STALE_DAYS} days'`);
  return parts.length ? `(${parts.join(' OR ')})` : 'TRUE';
}
async function listStalePokemon(meta) {
  const sql = `
    SELECT c.id
    FROM tcg_cards c
    LEFT JOIN ${meta.table} p ON ${joinOn(meta, 'c', 'id')}
    WHERE p.${meta.keyCols[0]} IS NULL OR ${extraStalePredicate(meta)}
  `;
  const { rows } = await dbQuery(sql);
  return rows.map(r => r.id);
}
async function listStaleYgo(meta) {
  const sql = `
    SELECT c.card_id AS id
    FROM ygo_cards c
    LEFT JOIN ${meta.table} p ON ${joinOn(meta, 'c', 'card_id')}
    WHERE p.${meta.keyCols[0]} IS NULL OR ${extraStalePredicate(meta)}
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
    WHERE p.${meta.keyCols[0]} IS NULL OR ${extraStalePredicate(meta)}
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

    await ratePreflight(token); // optional, safe if disabled or unauthorized

    const limit = pLimit(CONCURRENCY);

    async function doGame(game, meta) {
      let cards = [];
      if (game === 'pokemon') cards = await getPokemonCards();
      if (game === 'ygo')     cards = await getYgoCards();
      if (game === 'mtg')     cards = await getMtgCards();

      console.log(`[${game}] total cards in DB: ${cards.length.toLocaleString()}`);
      if (!cards.length) { console.log(`[${game}] No cards found. Skipping.`); return; }

      let staleIds = [];
      if (game === 'pokemon') staleIds = await listStalePokemon(meta);
      if (game === 'ygo')     staleIds = await listStaleYgo(meta);
      if (game === 'mtg')     staleIds = await listStaleMtg(meta);

      console.log(`[${game}] stale (eligible) count: ${staleIds.length.toLocaleString()}`);
      const todo = cards.filter(c => staleIds.includes(c.id));
      const list = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;
      console.log(`[${game}] processing ${list.length.toLocaleString()}/${cards.length.toLocaleString()} (stale >= ${STALE_DAYS}d, limit=${LIMIT || '∞'})…`);

      let ok = 0, miss = 0, processed = 0;
      const t0 = Date.now();

      const heartbeat = setInterval(() => {
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`[hb][${game}] inflight=${Math.min(CONCURRENCY, Math.max(0, list.length - processed))} processed=${processed}/${list.length} updated=${ok} missing=${miss} elapsed=${secs}s`);
      }, 15000);

      try {
        await Promise.all(list.map((card, idx) => limit(async () => {
          const started = Date.now();
          if (DEBUG) console.log(`[${game}] [${idx + 1}/${list.length}] START ${card.id} :: ${card.name || ''}`);

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
            } else if (/per-card timeout/i.test(m)) {
              console.warn(`[${game}] ${card.id} timed out, moving on.`);
              miss++;
            } else {
              console.warn(`[${game}] ${card.id} ${card.name || ''} → error: ${m}`);
              miss++;
            }
          } finally {
            processed++;
            if (DEBUG) console.log(`[${game}] [${idx + 1}/${list.length}] DONE ${card.id} in ${(Date.now() - started)}ms`);
          }
        })));
      } finally {
        clearInterval(heartbeat);
      }
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
process.on('unhandledRejection', (e) => { console.error('UNHANDLED REJECTION:', e); process.exit(1); });
process.on('uncaughtException', (e) => { console.error('UNCAUGHT EXCEPTION:', e); process.exit(1); });

main().catch(err => { console.error(err); process.exit(1); });
