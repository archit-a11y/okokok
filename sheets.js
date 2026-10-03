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

/** Read a range, e.g. "pantry!A1:F20". Returns displayed strings. */
export function readRange(range) {
  return callScript({ action: 'read', range });
}

/**
 * Overwrite starting at an anchor cell. `range` may be a single cell
 * ("pantry!B3") — the block is sized from the values given.
 */
export function writeRange(range, values) {
  return callScript({ action: 'write', range, values });
}

/** Add rows to the bottom of a tab. */
export function appendRows(tab, values) {
  return callScript({ action: 'append', tab, values });
}
