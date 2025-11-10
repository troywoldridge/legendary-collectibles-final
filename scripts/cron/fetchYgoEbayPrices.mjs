
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from './_db.js';

/**
 * Usage:
 *   node scripts/cron/fetchYgoEbayPrices.mjs --all --limit=0 --batch=800 --concurrency=4
 *   node scripts/cron/fetchYgoEbayPrices.mjs --only-missing-ebay --days=3 --base=https://legendary-collectibles.com
 *
 * Requires:
 *   EBAY_CLIENT_ID
 *   EBAY_CLIENT_SECRET
 *   CRON_SECRET
 */

const argv = process.argv.slice(2);
const flags = new Map(
  argv.map((s) => {
    const i = s.indexOf('=');
    if (i === -1) return [s.replace(/^--/, ''), 'true'];
    return [s.slice(2, i), s.slice(i + 1)];
  }),
);

const FLAG_ALL               = flags.has('all');
const FLAG_ONLY_MISSING_PRIM = flags.has('only-missing-primary'); // kept for parity (no-op by default)
const FLAG_ONLY_MISSING_EBAY = flags.has('only-missing-ebay');
const DAYS_FRESH             = Number(flags.get('days') ?? '7');
const LIMIT                  = Number(flags.get('limit') ?? '0');
const BATCH                  = Math.max(50, Number(flags.get('batch') ?? '500'));
const CONCURRENCY            = Math.min(8, Math.max(1, Number(flags.get('concurrency') ?? '4')));
const START_AFTER            = flags.get('startAfter') || null;
const DRY_RUN                = flags.has('dry-run');
const FLAG_VERBOSE           = flags.has('verbose');

const BASE_URL = (flags.get('base') || process.env.EBAY_PRICE_BASE_URL || 'https://legendary-collectibles.com')
  .replace(/\/+$/, '');

if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
  console.error('Fatal: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET missing');
  process.exit(1);
}
if (!process.env.CRON_SECRET) {
  console.error('Fatal: CRON_SECRET missing');
  process.exit(1);
}

if (/adapnow\.com/i.test(BASE_URL)) {
  console.warn(`[warn] BASE_URL is "${BASE_URL}". For LC use legendary-collectibles.com.`);
}

const PRICE_ENDPOINT = (id) =>
  `${BASE_URL}/api/ebay/price/${encodeURIComponent(id)}?persist=1&game=ygo`;

async function tableExists(name) {
  const q = sql`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema='public' AND table_name=${name}
    LIMIT 1
  `;
  const r = await db.execute(q);
  return (r.rows?.length ?? 0) > 0;
}

let HAS_YGO_EBAY_TABLE = false;
(async () => {
  HAS_YGO_EBAY_TABLE = await tableExists('ygo_card_prices_ebay');
})().catch(() => { /* ignore */ });

async function getIdsPage({ after, limit }) {
  const whereParts = [];
  if (after) whereParts.push(sql`c.card_id > ${after}`);
  else whereParts.push(sql`TRUE`);

  if (FLAG_ONLY_MISSING_PRIM) {
    whereParts.push(sql`TRUE`);
  }

  if (FLAG_ONLY_MISSING_EBAY && HAS_YGO_EBAY_TABLE) {
    whereParts.push(sql`
      NOT EXISTS (
        SELECT 1
        FROM public.ygo_card_prices_ebay e
        WHERE e.card_id = c.card_id
          AND e.updated_at >= NOW() - INTERVAL '${DAYS_FRESH} days'
      )
    `);
  }

  const where = whereParts.reduce((a, b) => sql`${a} AND ${b}`);

  const rows = await db.execute(sql`
    SELECT c.card_id::text AS id
    FROM public.ygo_cards c
    WHERE ${where}
    ORDER BY c.card_id ASC
    LIMIT ${limit}
  `);

  return rows.rows?.map((r) => r.id) ?? [];
}

function isJson(res) {
  const ct = res.headers.get('content-type') || '';
  return /\bjson\b/i.test(ct);
}

async function fetchOne(id) {
  const url = PRICE_ENDPOINT(id);
  if (FLAG_VERBOSE) console.log('[ebay/ygo] GET', url);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-cron': '1',
        'x-cron-key': process.env.CRON_SECRET || '',
      },
    });
  } catch (e) {
    throw new Error(`Fetch failed: ${e.message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (!isJson(res)) {
      console.warn(`[ebay/ygo] Non-JSON (status ${res.status}) from ${url}`);
      console.warn('          First 200 chars:', body.slice(0, 200).replace(/\s+/g, ' '));
    } else {
      console.warn(`[ebay/ygo] ${res.status} JSON error from ${url}:`, body.slice(0, 500));
    }
    throw new Error(`HTTP ${res.status}`);
  }

  if (!isJson(res)) {
    const sample = await res.text().catch(() => '');
    try { return JSON.parse(sample); } catch { return { ok: false, error: 'non-json-ok' }; }
  }

  return res.json();
}

async function poolRun(ids, concurrency) {
  let inFlight = 0, idx = 0;
  const results = [];
  let resolveAll;
  const done = new Promise((res) => { resolveAll = res; });

  const launch = () => {
    if (idx >= ids.length && inFlight === 0) return resolveAll(results);
    while (inFlight < concurrency && idx < ids.length) {
      const id = ids[idx++];
      inFlight++;
      fetchOne(id)
        .then((r) => results.push([id, null, r]))
        .catch((e) => results.push([id, e, null]))
        .finally(() => { inFlight--; launch(); });
    }
  };
  launch();
  return done;
}

const STATE_DIR = 'logs';
const CURSOR_FILE = `${STATE_DIR}/ebay-ygo.cursor`;
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
function loadCursor() {
  if (START_AFTER) return START_AFTER;
  try { return readFileSync(CURSOR_FILE, 'utf8').trim() || null; } catch { return null; }
}
function saveCursor(id) {
  try { writeFileSync(CURSOR_FILE, id + '\n'); } catch {}
}

// -------- main loop --------
console.log('YGO eBay harvester starting…');
console.log({
  base: BASE_URL,
  all: FLAG_ALL,
  onlyMissingPrimary: FLAG_ONLY_MISSING_PRIM,
  onlyMissingEbay: FLAG_ONLY_MISSING_EBAY,
  days: DAYS_FRESH,
  limit: LIMIT,
  batch: BATCH,
  concurrency: CONCURRENCY,
  startAfter: START_AFTER || '(state)',
  dryRun: DRY_RUN,
  verbose: FLAG_VERBOSE,
});

let processed = 0, found = 0, errors = 0;
let cursor = loadCursor();

while (true) {
  const toFetch = await getIdsPage({ after: cursor, limit: BATCH });
  if (toFetch.length === 0) break;

  const remainingCap = LIMIT > 0 ? Math.max(0, LIMIT - processed) : toFetch.length;
  const ids = toFetch.slice(0, remainingCap);
  if (ids.length === 0) break;

  console.log(`\nBatch ${processed + 1}..${processed + ids.length} (cursor from ${cursor || 'START'})`);

  if (!DRY_RUN) {
    const results = await poolRun(ids, CONCURRENCY);
    for (const [id, err, res] of results) {
      if (err) {
        errors++;
        console.warn('  •', id, '→ ERROR:', err.message);
        continue;
      }
      const price = res?.item?.price?.value;
      if (res?.ok && price) {
        found++;
        const urlOk = res?.item?.itemWebUrl ? '(url ok)' : '';
        console.log('  •', id, '→ $' + price, urlOk);
      } else if (res?.ok) {
        console.log('  •', id, '→ not found');
      } else {
        errors++;
        console.warn('  •', id, '→ route error:', res?.error ?? 'unknown');
      }
    }
  }

  processed += ids.length;
  cursor = ids[ids.length - 1];
  saveCursor(cursor);

  console.log(`Progress: processed=${processed}  found=${found}  errors=${errors}`);
  if (LIMIT > 0 && processed >= LIMIT) break;
  await sleep(100);
}

console.log(`\nDone. Processed=${processed}  Found=${found}  Errors=${errors}`);
