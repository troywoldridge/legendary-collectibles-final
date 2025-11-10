
// Node 18+ (uses global fetch)
// Deps: pg p-limit dotenv
// Usage examples:
//   node scripts/ebayPriceSweep.mjs --game=all --limit=80 --concurrency=1 --rps=0.5 --pages=1
//   node scripts/ebayPriceSweep.mjs --game=pokemon --engine=finding --limit=100
//   node scripts/ebayPriceSweep.mjs --game=mtg --engine=browse --rps=0.5 --concurrency=1

import 'dotenv/config';
import { Pool } from 'pg';
import pLimit from 'p-limit';
import { setTimeout as sleep } from 'node:timers/promises';

// ------------ ENV ------------
const {
  DATABASE_URL,
  EBAY_CLIENT_ID,
  EBAY_CLIENT_SECRET,
  EBAY_APP_ID, // <- Finding API APP ID (aka "AppID")
  EBAY_SCOPE = 'https://api.ebay.com/oauth/api_scope',
  EBAY_MARKETPLACE = 'EBAY_US',
  EBAY_ENDUSERCTX, // e.g. contextualLocation=country%3DUS%2Czip%3D94105
} = process.env;

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: DATABASE_URL });

// ------------ CLI ------------
const args = Object.fromEntries(
  process.argv.slice(2).map(s => {
    const [k, v] = s.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const GAME        = (args.game ?? 'all').toLowerCase();
const LIMIT       = args.limit ? Number(args.limit) : undefined;
const CONCURRENCY = args.concurrency ? Number(args.concurrency) : 1;
const RPS         = args.rps ? Number(args.rps) : Number(process.env.EBAY_RPS || 0.5);
const PAGES       = args.pages ? Number(args.pages) : Number(process.env.EBAY_PAGES || 1);
const PAGE_LIMIT  = args.page_limit ? Number(args.page_limit) : Number(process.env.EBAY_PAGE_LIMIT || 200);
const ENGINE      = (args.engine ?? 'auto').toLowerCase(); // auto | browse | finding

// ------------ DB helpers ------------
async function tableExists(table) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1;`,
    [table]
  );
  return rows.length > 0;
}
async function getExactColumnType(table, column) {
  const q = `
    SELECT format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = $1 AND a.attname = $2
      AND a.attnum > 0 AND NOT a.attisdropped
    LIMIT 1;
  `;
  const { rows } = await pool.query(q, [table, column]);
  return rows[0]?.type || null;
}
async function colExists(table, column) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2 LIMIT 1;`,
    [table, column]
  );
  return rows.length > 0;
}
async function resolveTcgSetColumn() {
  if (await colExists('tcg_cards', 'set_id')) return 'set_id';
  if (await colExists('tcg_cards', 'set.id')) return '"set.id"';
  return null;
}
async function resolveTcgSetNameExpr(setCol) {
  if (await colExists('tcg_cards', 'set_name')) return { expr: 'c.set_name', needsJoin: false };
  if (setCol) return { expr: 's.name', needsJoin: true };
  return { expr: 'NULL::text', needsJoin: false };
}
function derivePkmnNumberFromId(cardId) {
  if (!cardId) return null;
  const i = cardId.indexOf('-');
  if (i === -1) return null;
  return cardId.slice(i + 1);
}

// ------------ Ensure tables ------------
async function ensureTables() {
  // Pokémon
  const tcgBaseExists = await tableExists('tcg_cards');
  const tcgType = tcgBaseExists ? (await getExactColumnType('tcg_cards', 'id')) || 'text' : 'text';
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tcg_card_prices_ebay (
      cardid ${tcgType} PRIMARY KEY${tcgBaseExists ? ` REFERENCES tcg_cards(id) ON DELETE CASCADE` : ``},
      currency text NOT NULL DEFAULT 'USD',
      low numeric,
      median numeric,
      high numeric,
      sample_count integer NOT NULL DEFAULT 0,
      method text NOT NULL DEFAULT 'active_listings',
      query text NOT NULL,
      last_run timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // YGO
  const ygoBaseExists = await tableExists('ygo_cards');
  const ygoType = ygoBaseExists ? (await getExactColumnType('ygo_cards', 'card_id')) || 'text' : 'text';
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ygo_card_prices_ebay (
      card_id ${ygoType} PRIMARY KEY${ygoBaseExists ? ` REFERENCES ygo_cards(card_id) ON DELETE CASCADE` : ``},
      currency text NOT NULL DEFAULT 'USD',
      low numeric,
      median numeric,
      high numeric,
      sample_count integer NOT NULL DEFAULT 0,
      method text NOT NULL DEFAULT 'active_listings',
      query text NOT NULL,
      last_run timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // MTG
  const mtgBaseExists = await tableExists('mtg_cards');
  const mtgType = mtgBaseExists ? (await getExactColumnType('mtg_cards', 'id')) || 'uuid' : 'uuid';
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mtg_card_prices_ebay (
      id ${mtgType} PRIMARY KEY${mtgBaseExists ? ` REFERENCES mtg_cards(id) ON DELETE CASCADE` : ``},
      currency text NOT NULL DEFAULT 'USD',
      low numeric,
      median numeric,
      high numeric,
      sample_count integer NOT NULL DEFAULT 0,
      method text NOT NULL DEFAULT 'active_listings',
      query text NOT NULL,
      last_run timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

// ------------ Rate limiter ------------
let nextAt = 0;
function msPerReq() { return Math.ceil(1000 / Math.max(0.1, RPS)); }
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextAt - now);
  if (wait > 0) {
    const jitter = Math.floor(Math.random() * 150);
    await sleep(wait + jitter);
  }
  nextAt = Math.max(now, nextAt) + msPerReq();
}

// ------------ eBay PROVIDER #1: Browse API (OAuth) ------------
async function getEbayBrowseToken() {
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error('Browse API requires EBAY_CLIENT_ID & EBAY_CLIENT_SECRET');
  }
  const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: EBAY_SCOPE }).toString(),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`eBay token error ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return data.access_token;
}

const EBAY_BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

async function searchBrowse({ token, q, limitPerPage = PAGE_LIMIT, maxPages = PAGES }) {
  const prices = [];
  let offset = 0;
  let retries = 0;

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': EBAY_MARKETPLACE,
  };
  if (EBAY_ENDUSERCTX) headers['X-EBAY-C-ENDUSERCTX'] = EBAY_ENDUSERCTX;

  const filter = [
    'buyingOptions:{FIXED_PRICE|AUCTION}',
    'priceCurrency:USD',
    'conditions:{NEW|USED}',
  ].join(',');

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(EBAY_BROWSE_URL);
    url.searchParams.set('q', q.substring(0, 100));
    url.searchParams.set('limit', String(Math.min(200, limitPerPage)));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('filter', filter);

    await throttle();

    const resp = await fetch(url, { method: 'GET', headers });

    if (resp.status === 429) {
      const ra = Number(resp.headers.get('retry-after') || 0);
      const backoffMs = ra > 0 ? ra * 1000 : Math.min(60000, 1500 * Math.pow(2, retries));
      const body = await resp.text().catch(() => '');
      retries++;
      console.warn(`429 (Browse) "${q}" p${page}/off${offset}. Sleep ${backoffMs}ms. Body: ${body}`);
      await sleep(backoffMs + Math.floor(Math.random() * 200));
      if (retries >= 3) throw new Error('browse-429');
      page--; // retry
      continue;
    }

    if (resp.status >= 500) {
      const body = await resp.text().catch(() => '');
      const backoffMs = Math.min(20000, 1000 * (retries + 1));
      retries++;
      console.warn(`5xx (Browse) "${q}" p${page}. Sleep ${backoffMs}ms. Body: ${body}`);
      await sleep(backoffMs);
      page--;
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Browse ${resp.status}: ${text}`);
    }

    retries = 0;
    const json = await resp.json();
    const items = json.itemSummaries ?? [];
    for (const it of items) {
      const price = Number(it?.price?.value ?? 0);
      const ship  = Number(it?.shippingOptions?.[0]?.shippingCost?.value ?? 0);
      const landed = (Number.isFinite(price) && Number.isFinite(ship)) ? price + ship : price;
      if (Number.isFinite(landed) && landed > 0) prices.push(landed);
    }
    if (!items.length) break;

    offset += limitPerPage;
    if (prices.length >= 1000) break;
  }
  return prices;
}

// ------------ eBay PROVIDER #2: Finding API (AppID) ------------
const MARKETPLACE_TO_GLOBAL = {
  EBAY_US: 'EBAY-US',
  EBAY_GB: 'EBAY-GB',
  EBAY_AU: 'EBAY-AU',
  EBAY_DE: 'EBAY-DE',
};
function globalIdFromMarketplace(mkt) {
  return MARKETPLACE_TO_GLOBAL[mkt] || 'EBAY-US';
}

// Parse Finding JSON safely (it’s nested arrays galore)
function extractFindingNumbers(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur) return [];
    cur = Array.isArray(cur) ? cur[0] : cur;
    cur = cur?.[key];
  }
  return Array.isArray(cur) ? cur : (cur ? [cur] : []);
}

async function searchFinding({ q, limitPerPage = 100, maxPages = 1 }) {
  if (!EBAY_APP_ID) throw new Error('finding-missing-appid');

  const prices = [];
  let page = 1;

  for (; page <= maxPages; page++) {
    await throttle();

    const url = new URL('https://svcs.ebay.com/services/search/FindingService/v1');
    url.searchParams.set('OPERATION-NAME', 'findItemsByKeywords');
    url.searchParams.set('SERVICE-VERSION', '1.13.0');
    url.searchParams.set('SECURITY-APPNAME', EBAY_APP_ID);
    url.searchParams.set('RESPONSE-DATA-FORMAT', 'JSON');
    url.searchParams.set('REST-PAYLOAD', 'true');
    url.searchParams.set('keywords', q);
    url.searchParams.set('paginationInput.entriesPerPage', String(Math.min(100, limitPerPage)));
    url.searchParams.set('paginationInput.pageNumber', String(page));
    url.searchParams.set('GLOBAL-ID', globalIdFromMarketplace(EBAY_MARKETPLACE));
    // Filter to fixed price + auction, US dollars if possible
    url.searchParams.set('itemFilter(0).name', 'HideDuplicateItems');
    url.searchParams.set('itemFilter(0).value', 'true');

    const resp = await fetch(url);
    if (resp.status === 429) {
      const ra = Number(resp.headers.get('retry-after') || 0);
      const backoffMs = ra > 0 ? ra * 1000 : 3000;
      console.warn(`429 (Finding) "${q}" p${page}. Sleep ${backoffMs}ms`);
      await sleep(backoffMs);
      page--; // retry
      continue;
    }
    if (resp.status >= 500) {
      const backoffMs = 1000 * page;
      console.warn(`5xx (Finding) "${q}" p${page}. Sleep ${backoffMs}ms`);
      await sleep(backoffMs);
      page--; // retry
      continue;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Finding ${resp.status}: ${text}`);
    }

    const data = await resp.json();

    const ack = extractFindingNumbers(data, ['findItemsByKeywordsResponse', 'ack'])[0];
    if ((ack || '').toUpperCase() !== 'SUCCESS') {
      const err = JSON.stringify(data);
      throw new Error(`Finding ack!=SUCCESS: ${err.substring(0, 400)}`);
    }

    const itemsArr = extractFindingNumbers(data, ['findItemsByKeywordsResponse', 'searchResult', 'item']);
    if (!itemsArr.length) break;

    for (const it of itemsArr) {
      const priceStr = extractFindingNumbers(it, ['sellingStatus', 'convertedCurrentPrice', '__value__'])[0]
                    || extractFindingNumbers(it, ['sellingStatus', 'currentPrice', '__value__'])[0]
                    || '0';
      const shipStr = extractFindingNumbers(it, ['shippingInfo', 'shippingServiceCost', '__value__'])[0] || '0';
      const free = (extractFindingNumbers(it, ['shippingInfo', 'shippingType'])[0] || '').toLowerCase().includes('free');
      const price = Number(priceStr);
      const ship  = free ? 0 : Number(shipStr);
      const landed = (Number.isFinite(price) && Number.isFinite(ship)) ? price + ship : price;
      if (Number.isFinite(landed) && landed > 0) prices.push(landed);
    }
    if (prices.length >= 1000) break;
  }

  return prices;
}

// ------------ Stats ------------
function quantiles(sortedArr) {
  const q = (p) => {
    if (sortedArr.length === 0) return 0;
    const pos = (sortedArr.length - 1) * p;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sortedArr[base + 1] !== undefined) {
      return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
    }
    return sortedArr[base];
  };
  return { q1: q(0.25), q2: q(0.5), q3: q(0.75) };
}
function trimOutliers(arr) {
  if (arr.length < 6) return arr.slice().sort((a, b) => a - b);
  const sorted = arr.slice().sort((a, b) => a - b);
  const { q1, q3 } = quantiles(sorted);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return sorted.filter(v => v >= lo && v <= hi);
}
function summarize(prices) {
  if (!prices.length) return null;
  const trimmed = trimOutliers(prices);
  if (!trimmed.length) return null;
  const low = trimmed[0];
  const high = trimmed[trimmed.length - 1];
  const { q2 } = quantiles(trimmed);
  return {
    low: Math.round(low * 100) / 100,
    median: Math.round(q2 * 100) / 100,
    high: Math.round(high * 100) / 100,
    count: prices.length,
    count_after_trim: trimmed.length,
  };
}

// ------------ Iterators ------------
async function* iterPokemon(limit) {
  const setCol = await resolveTcgSetColumn();
  const { expr: setNameExpr, needsJoin } = await resolveTcgSetNameExpr(setCol);

  const selectSetCols = setCol
    ? `, c.${setCol} AS set_id, ${setNameExpr} AS set_name`
    : `, NULL::text AS set_id, ${setNameExpr} AS set_name`;

  const joinSets = needsJoin ? `LEFT JOIN tcg_sets s ON s.id = c.${setCol}` : ``;

  const sql = `
    SELECT c.id, c.name
           ${selectSetCols}
    FROM tcg_cards c
    ${joinSets}
    ORDER BY c.id
    ${limit ? 'LIMIT $1' : ''};
  `;
  const { rows } = await pool.query(sql, limit ? [limit] : []);
  for (const r of rows) yield r;
}
async function* iterYgo(limit) {
  const sql = `
    SELECT card_id AS id, name
    FROM ygo_cards
    ORDER BY card_id
    ${limit ? 'LIMIT $1' : ''};
  `;
  const { rows } = await pool.query(sql, limit ? [limit] : []);
  for (const r of rows) yield r;
}
async function* iterMtg(limit) {
  const hasCollector = await colExists('mtg_cards', 'collector_number');
  const numberExpr = hasCollector ? 'c.collector_number::text' : 'NULL::text';
  const hasSetCode = await colExists('mtg_cards', 'set_code');
  const setCodeExpr = hasSetCode ? 'c.set_code' : 'NULL::text';
  const joinable = await tableExists('mtg_sets') && hasSetCode && await colExists('mtg_sets', 'code');

  const selectSetCols = joinable
    ? `, s.name AS set_name, ${setCodeExpr} AS set_code`
    : `, NULL::text AS set_name, ${setCodeExpr} AS set_code`;

  const joinSets = joinable ? `LEFT JOIN mtg_sets s ON s.code = c.set_code` : ``;

  const sql = `
    SELECT c.id, c.name, ${numberExpr} AS number
           ${selectSetCols}
    FROM mtg_cards c
    ${joinSets}
    ORDER BY c.id
    ${limit ? 'LIMIT $1' : ''};
  `;
  const { rows } = await pool.query(sql, limit ? [limit] : []);
  for (const r of rows) yield r;
}

// ------------ Query builders ------------
function buildQueryPokemon(card) {
  const num = derivePkmnNumberFromId(card.id);
  const parts = [
    card.name ? `"${card.name}"` : '',
    card.set_name || card.set_id || '',
    num ? `#${num}` : '',
    'Pokemon TCG',
  ].filter(Boolean);
  return parts.join(' ').trim();
}
function buildQueryYgo(card) {
  const parts = [card.name ? `"${card.name}"` : '', 'Yu-Gi-Oh!', 'TCG'].filter(Boolean);
  return parts.join(' ').trim();
}
function buildQueryMtg(card) {
  const parts = [
    card.name ? `"${card.name}"` : '',
    (card.set_name || card.set_code || '')?.toString().toUpperCase(),
    card.number ? `${card.number}` : '',
    'MTG',
  ].filter(Boolean);
  return parts.join(' ').trim();
}

// ------------ Upserts ------------
async function upsertPokemon(cardid, summary, query) {
  const sql = `
    INSERT INTO tcg_card_prices_ebay (cardid, currency, low, median, high, sample_count, method, query, last_run, updated_at)
    VALUES ($1,'USD',$2,$3,$4,$5,'active_listings',$6,now(),now())
    ON CONFLICT (cardid) DO UPDATE
    SET low=EXCLUDED.low,
        median=EXCLUDED.median,
        high=EXCLUDED.high,
        sample_count=EXCLUDED.sample_count,
        method=EXCLUDED.method,
        query=EXCLUDED.query,
        last_run=now(),
        updated_at=now();
  `;
  const vals = [cardid, summary?.low ?? null, summary?.median ?? null, summary?.high ?? null, summary?.count ?? 0, query];
  await pool.query(sql, vals);
}
async function upsertYgo(cardid, summary, query) {
  const sql = `
    INSERT INTO ygo_card_prices_ebay (card_id, currency, low, median, high, sample_count, method, query, last_run, updated_at)
    VALUES ($1,'USD',$2,$3,$4,$5,'active_listings',$6,now(),now())
    ON CONFLICT (card_id) DO UPDATE
    SET low=EXCLUDED.low,
        median=EXCLUDED.median,
        high=EXCLUDED.high,
        sample_count=EXCLUDED.sample_count,
        method=EXCLUDED.method,
        query=EXCLUDED.query,
        last_run=now(),
        updated_at=now();
  `;
  const vals = [cardid, summary?.low ?? null, summary?.median ?? null, summary?.high ?? null, summary?.count ?? 0, query];
  await pool.query(sql, vals);
}
async function upsertMtg(id, summary, query) {
  const sql = `
    INSERT INTO mtg_card_prices_ebay (id, currency, low, median, high, sample_count, method, query, last_run, updated_at)
    VALUES ($1,'USD',$2,$3,$4,$5,'active_listings',$6,now(),now())
    ON CONFLICT (id) DO UPDATE
    SET low=EXCLUDED.low,
        median=EXCLUDED.median,
        high=EXCLUDED.high,
        sample_count=EXCLUDED.sample_count,
        method=EXCLUDED.method,
        query=EXCLUDED.query,
        last_run=now(),
        updated_at=now();
  `;
  const vals = [id, summary?.low ?? null, summary?.median ?? null, summary?.high ?? null, summary?.count ?? 0, query];
  await pool.query(sql, vals);
}

// ------------ Search wrapper w/ auto-fallback ------------
let browseTokenCache = null;
async function getBrowseTokenCached() {
  if (!browseTokenCache) browseTokenCache = await getEbayBrowseToken();
  return browseTokenCache;
}

async function searchEbayPrices({ q }) {
  const useBrowse = ENGINE === 'browse' || ENGINE === 'auto';
  const useFinding = ENGINE === 'finding' || ENGINE === 'auto';

  // Try Browse first
  if (useBrowse) {
    try {
      const token = await getBrowseTokenCached();
      const prices = await searchBrowse({ token, q });
      if (prices.length) return prices;
    } catch (err) {
      if (String(err.message).includes('browse-429')) {
        // fall through to Finding if allowed
      } else {
        // For other Browse errors, still try Finding
      }
      if (!useFinding) throw err;
    }
  }
  // Fallback: Finding
  if (useFinding) {
    try {
      const prices = await searchFinding({ q, limitPerPage: Math.min(100, PAGE_LIMIT), maxPages: PAGES });
      return prices;
    } catch (err) {
      if (ENGINE === 'finding') throw err;
      // As a last resort: return empty and let caller upsert zeros
      console.warn(`Finding failed for "${q}": ${err.message}`);
      return [];
    }
  }
  return [];
}

// ------------ Runner per game ------------
async function* iterPokemon(limit) {
  const setCol = await resolveTcgSetColumn();
  const { expr: setNameExpr, needsJoin } = await resolveTcgSetNameExpr(setCol);

  const selectSetCols = setCol
    ? `, c.${setCol} AS set_id, ${setNameExpr} AS set_name`
    : `, NULL::text AS set_id, ${setNameExpr} AS set_name`;

  const joinSets = needsJoin ? `LEFT JOIN tcg_sets s ON s.id = c.${setCol}` : ``;

  const sql = `
    SELECT c.id, c.name
           ${selectSetCols}
    FROM tcg_cards c
    ${joinSets}
    ORDER BY c.id
    ${limit ? 'LIMIT $1' : ''};
  `;
  const { rows } = await pool.query(sql, limit ? [limit] : []);
  for (const r of rows) yield r;
}
async function* iterYgo(limit) {
  const sql = `
    SELECT card_id AS id, name
    FROM ygo_cards
    ORDER BY card_id
    ${limit ? 'LIMIT $1' : ''};
  `;
  const { rows } = await pool.query(sql, limit ? [limit] : []);
  for (const r of rows) yield r;
}
async function* iterMtg(limit) {
  const hasCollector = await colExists('mtg_cards', 'collector_number');
  const numberExpr = hasCollector ? 'c.collector_number::text' : 'NULL::text';
  const hasSetCode = await colExists('mtg_cards', 'set_code');
  const setCodeExpr = hasSetCode ? 'c.set_code' : 'NULL::text';
  const joinable = await tableExists('mtg_sets') && hasSetCode && await colExists('mtg_sets', 'code');

  const selectSetCols = joinable
    ? `, s.name AS set_name, ${setCodeExpr} AS set_code`
    : `, NULL::text AS set_name, ${setCodeExpr} AS set_code`;

  const joinSets = joinable ? `LEFT JOIN mtg_sets s ON s.code = c.set_code` : ``;

  const sql = `
    SELECT c.id, c.name, ${numberExpr} AS number
           ${selectSetCols}
    FROM mtg_cards c
    ${joinSets}
    ORDER BY c.id
    ${limit ? 'LIMIT $1' : ''};
  `;
  const { rows } = await pool.query(sql, limit ? [limit] : []);
  for (const r of rows) yield r;
}

function buildQueryPokemon(card) {
  const num = derivePkmnNumberFromId(card.id);
  return [card.name ? `"${card.name}"` : '', card.set_name || card.set_id || '', num ? `#${num}` : '', 'Pokemon TCG']
    .filter(Boolean).join(' ').trim();
}
function buildQueryYgo(card) {
  return [card.name ? `"${card.name}"` : '', 'Yu-Gi-Oh!', 'TCG'].filter(Boolean).join(' ').trim();
}
function buildQueryMtg(card) {
  return [card.name ? `"${card.name}"` : '', (card.set_name || card.set_code || '')?.toString().toUpperCase(), card.number ? `${card.number}` : '', 'MTG']
    .filter(Boolean).join(' ').trim();
}

// ------------ Upserts ------------
async function upsertPokemon(cardid, summary, query) {
  const sql = `
    INSERT INTO tcg_card_prices_ebay (cardid, currency, low, median, high, sample_count, method, query, last_run, updated_at)
    VALUES ($1,'USD',$2,$3,$4,$5,'active_listings',$6,now(),now())
    ON CONFLICT (cardid) DO UPDATE
    SET low=EXCLUDED.low,
        median=EXCLUDED.median,
        high=EXCLUDED.high,
        sample_count=EXCLUDED.sample_count,
        method=EXCLUDED.method,
        query=EXCLUDED.query,
        last_run=now(),
        updated_at=now();
  `;
  const vals = [cardid, summary?.low ?? null, summary?.median ?? null, summary?.high ?? null, summary?.count ?? 0, query];
  await pool.query(sql, vals);
}
async function upsertYgo(cardid, summary, query) {
  const sql = `
    INSERT INTO ygo_card_prices_ebay (card_id, currency, low, median, high, sample_count, method, query, last_run, updated_at)
    VALUES ($1,'USD',$2,$3,$4,$5,'active_listings',$6,now(),now())
    ON CONFLICT (card_id) DO UPDATE
    SET low=EXCLUDED.low,
        median=EXCLUDED.median,
        high=EXCLUDED.high,
        sample_count=EXCLUDED.sample_count,
        method=EXCLUDED.method,
        query=EXCLUDED.query,
        last_run=now(),
        updated_at=now();
  `;
  const vals = [cardid, summary?.low ?? null, summary?.median ?? null, summary?.high ?? null, summary?.count ?? 0, query];
  await pool.query(sql, vals);
}
async function upsertMtg(id, summary, query) {
  const sql = `
    INSERT INTO mtg_card_prices_ebay (id, currency, low, median, high, sample_count, method, query, last_run, updated_at)
    VALUES ($1,'USD',$2,$3,$4,$5,'active_listings',$6,now(),now())
    ON CONFLICT (id) DO UPDATE
    SET low=EXCLUDED.low,
        median=EXCLUDED.median,
        high=EXCLUDED.high,
        sample_count=EXCLUDED.sample_count,
        method=EXCLUDED.method,
        query=EXCLUDED.query,
        last_run=now(),
        updated_at=now();
  `;
  const vals = [id, summary?.low ?? null, summary?.median ?? null, summary?.high ?? null, summary?.count ?? 0, query];
  await pool.query(sql, vals);
}

// ------------ Orchestration ------------
async function processGame({ game, limit }) {
  let iter, buildQ, upsert, label;
  if (game === 'pokemon') {
    iter = iterPokemon; buildQ = buildQueryPokemon; upsert = upsertPokemon; label = 'Pokémon';
  } else if (game === 'ygo') {
    iter = iterYgo; buildQ = buildQueryYgo; upsert = upsertYgo; label = 'Yu-Gi-Oh!';
  } else if (game === 'mtg') {
    iter = iterMtg; buildQ = buildQueryMtg; upsert = upsertMtg; label = 'MTG';
  } else {
    throw new Error(`Unknown game: ${game}`);
  }

  console.log(`\n=== ${label} sweep start (${ENGINE}) ===`);
  const limiter = pLimit(CONCURRENCY);
  let done = 0;
  const tasks = [];
  for await (const card of iter(limit)) {
    tasks.push(limiter(async () => {
      const q = buildQ(card);
      try {
        const prices = await searchEbayPrices({ q });
        const summary = summarize(prices);
        await upsert(card.id, summary ?? { low: null, median: null, high: null, count: 0 }, q);
      } catch (err) {
        console.error(`[${label}] ${card.id}: ${err.message}`);
        await sleep(200);
      }
      const n = ++done;
      if (n % 200 === 0) console.log(`[${label}] processed ${n}…`);
    }));
  }
  await Promise.all(tasks);
  console.log(`=== ${label} sweep complete. processed=${done} ===`);
}

async function main() {
  await ensureTables();

  // If user forces browse, ensure creds exist now (fail fast).
  if (ENGINE === 'browse') {
    if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) throw new Error('Browse engine requires EBAY_CLIENT_ID/SECRET');
    await getBrowseTokenCached(); // warm token
  }

  // If user forces finding, ensure APP_ID exists now.
  if (ENGINE === 'finding') {
    if (!EBAY_APP_ID) throw new Error('Finding engine requires EBAY_APP_ID');
  }

  const order = ['pokemon', 'ygo', 'mtg'];
  const toRun = GAME === 'all' ? order : order.filter(x => x === GAME);
  for (const g of toRun) {
    await processGame({ game: g, limit: LIMIT });
    await sleep(400);
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('Fatal:', err);
    await pool.end();
    process.exit(1);
  });
