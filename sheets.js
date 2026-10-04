/**
 * Google Sheet bridge.
 *
 * The agent's memory lives in a Google Sheet. AgenticOrg's native Sheets
 * connector is OAuth2 — it wants a Client ID and Secret, which means a Google
 * Cloud project. We do not need one: an Apps Script web app bound to the sheet
 * already runs as the sheet's owner, so this server talks to that instead.
 *
 * See apps-script/Code.gs for the other half.
 *
 * Everything goes out as GET. Apps Script answers with a 302 to
 * googleusercontent.com; per the fetch spec a redirected POST is rewritten to
 * GET and loses its body, so POST silently drops writes. GET survives.
 */

const WEBAPP_URL = process.env.SHEET_WEBAPP_URL || '';
const SECRET = process.env.SHEET_SECRET || 'bhojan-2026';
const TIMEOUT_MS = Number(process.env.SHEET_TIMEOUT_MS || 20000);

/**
 * AgenticOrg fixes its connector timeout at 10 seconds and does not expose it.
 * A single Apps Script round trip is 2-5s cold, and one planning turn reads
 * six tabs, so the agent was timing out before it finished reading.
 *
 * So the first read of a turn pulls EVERY tab at once, in parallel, and caches
 * the lot. The other five reads are then served from memory in under a
 * millisecond. A write clears the cache, so the agent never reads back a value
 * it has just changed.
 */
const CACHE_MS = Number(process.env.SHEET_CACHE_MS || 45000);
const TABS = [
  'people', 'pantry', 'goals', 'health',
  'recipes', 'dishes', 'history', 'rules', 'usage',
];
const cache = new Map();          // tab -> { values, at }
let warming = null;               // in-flight warm, so we fan out only once

const calls = [];

export function getSheetCalls() {
  return calls;
}

export function clearSheetCalls() {
  calls.length = 0;
}

export function sheetConfigured() {
  return Boolean(WEBAPP_URL);
}

async function callScript(params) {
  if (!WEBAPP_URL) {
    return {
      ok: false,
      error:
        'SHEET_WEBAPP_URL is not set. Deploy apps-script/Code.gs as a web app ' +
        'and set the environment variable to its /exec URL.',
    };
  }

  const url = new URL(WEBAPP_URL);
  url.searchParams.set('secret', SECRET);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }

  const started = Date.now();
  const entry = {
    at: new Date().toISOString(),
    action: params.action,
    range: params.range || params.tab || null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text();

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // Apps Script serves an HTML error page when the deployment is wrong.
      body = {
        ok: false,
        error:
          'The sheet bridge did not return JSON. The usual cause is a web app ' +
          'deployed with "Who has access" set to anything but Anyone, or a URL ' +
          'that is not the /exec one.',
        http_status: res.status,
        first_200_chars: text.slice(0, 200),
      };
    }

    entry.ms = Date.now() - started;
    entry.ok = body.ok !== false;
    calls.push(entry);
    if (calls.length > 300) calls.shift();

    return body;
  } catch (err) {
    entry.ms = Date.now() - started;
    entry.ok = false;
    entry.error = String(err.message);
    calls.push(entry);
    if (calls.length > 300) calls.shift();

    return {
      ok: false,
      error:
        err.name === 'AbortError'
          ? `Sheet bridge timed out after ${TIMEOUT_MS}ms`
          : String(err.message),
    };
  }
}

/** List the tab names. Cheap way to prove the bridge is alive. */
export function listTabs() {
  return callScript({ action: 'tabs' });
}

/** Split "pantry!A1:F20" into its tab and the A1 part. */
function splitRange(range) {
  const i = String(range).lastIndexOf('!');
  if (i === -1) return { tab: String(range), a1: null };
  return { tab: String(range).slice(0, i).replace(/^'|'$/g, ''), a1: String(range).slice(i + 1) };
}

/** Column letters -> 1-based index. A=1, Z=26, AA=27. */
function colToNum(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Cut a cached full-tab grid down to the A1 range the caller asked for. */
function slice(values, a1) {
  if (!a1) return values;
  const m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(a1.trim());
  if (!m) return values;
  const [, c1, r1, c2, r2] = m;
  const rowStart = Math.max(1, Number(r1)) - 1;
  const rowEnd = Number(r2);
  const colStart = Math.max(1, colToNum(c1)) - 1;
  const colEnd = colToNum(c2);
  return values.slice(rowStart, rowEnd).map((row) => row.slice(colStart, colEnd));
}

function fresh(tab) {
  const hit = cache.get(tab);
  return hit && Date.now() - hit.at < CACHE_MS ? hit : null;
}

/** Pull every tab at once. One fan-out, not nine sequential round trips. */
async function warmAll() {
  if (warming) return warming;
  warming = (async () => {
    const started = Date.now();
    const results = await Promise.all(
      TABS.map(async (tab) => {
        const body = await callScript({ action: 'read', range: `${tab}!A1:Z200` });
        return [tab, body];
      })
    );
    let ok = 0;
    for (const [tab, body] of results) {
      if (body && body.ok !== false && Array.isArray(body.values)) {
        cache.set(tab, { values: body.values, at: Date.now() });
        ok += 1;
      }
    }
    calls.push({
      at: new Date().toISOString(),
      action: 'warm_all',
      range: `${ok}/${TABS.length} tabs`,
      ms: Date.now() - started,
      ok: ok > 0,
    });
    warming = null;
    return ok;
  })();
  return warming;
}

export function invalidateSheetCache(tab) {
  if (tab) cache.delete(tab);
  else cache.clear();
}

export function cacheState() {
  return Object.fromEntries(
    [...cache.entries()].map(([t, v]) => [t, { rows: v.values.length, age_ms: Date.now() - v.at }])
  );
}

/**
 * Read a range, e.g. "pantry!A1:F20". Returns displayed strings.
 * Served from the warm cache when possible; the first miss warms every tab.
 */
export async function readRange(range) {
  const { tab, a1 } = splitRange(range);

  let hit = fresh(tab);
  if (!hit) {
    await warmAll();
    hit = fresh(tab);
  }

  if (hit) {
    return { ok: true, range, cached: true, values: slice(hit.values, a1) };
  }

  // Tab is not one we warm (or the warm failed) — go direct.
  return callScript({ action: 'read', range });
}

/**
 * Overwrite starting at an anchor cell. `range` may be a single cell
 * ("pantry!B3") — the block is sized from the values given.
 */
/**
 * Row 1 of every tab is its header. An agent that writes there destroys the
 * column names the whole system reads by, and one did try: it aimed
 * "pantry!A1:F20" at five invented items taken from dish names. A tool that
 * can wipe its own schema is a tool with too much reach, so this refuses.
 */
function guardAnchor(range) {
  const { tab, a1 } = splitRange(range);
  const m = /^([A-Za-z]+)(\d+)/.exec(String(a1 || '').trim());
  if (!m) return null;
  if (Number(m[2]) <= 1) {
    return {
      ok: false,
      error:
        `Refused: ${range} starts at row 1, which is the header row of the ` +
        `${tab} tab. Write to the row of the item you mean — read the tab first ` +
        `and target that cell, e.g. "pantry!B6" for tomato.`,
    };
  }
  return null;
}

export async function writeRange(range, values) {
  const blocked = guardAnchor(range);
  if (blocked) {
    calls.push({ at: new Date().toISOString(), action: 'write_refused', range, ok: false });
    return blocked;
  }
  const { tab } = splitRange(range);
  const res = await callScript({ action: 'write', range, values });
  invalidateSheetCache(tab);   // never serve a stale value we just overwrote
  return res;
}

/** Add rows to the bottom of a tab. */
export async function appendRows(tab, values) {
  const res = await callScript({ action: 'append', tab, values });
  invalidateSheetCache(tab);
  return res;
}
