#!/usr/bin/env node
// FLEET PANEL — read-mostly web dashboard for the cavecrew bot fleet.
//
// Standalone Node ESM HTTP server on 127.0.0.1:3200. Zero npm deps, Node
// built-ins only. It never touches the runners' internals: it speaks the same
// public HTTP API a driver speaks (see cave/DRIVER_GUIDE.md).
//
// SAFETY CONTRACT — the panel has exactly TWO write actions:
//   POST /api/wake {bot}  -> pushes that bot's role-default task, force:false
//   POST /api/stop {bot}  -> forwards POST /stop to that bot's runner
// force:false is hard-coded and un-overridable, so wake can NEVER preempt a
// driver's running task — a busy runner answers 409 and the panel reports it.
// No RCON, no chat, no world manipulation, no /eval, no other mutations.
//
// This file is the HTTP server + route table ONLY (PANEL V3 SPEC,
// architecture note, phase 1 — the 3-way split). Every parser and every byte
// of data assembly (fleet polling, TODO board, Vault, the two write actions,
// the newer v3 readers) lives in cave/panel-data.mjs, imported below as plain
// named functions — this file never touches a bot's status shape directly.
// The entire client-side script lives in cave/panel-client.js, served
// statically via GET /panel.js rather than inlined into the HTML this file
// renders (kills the double-escaping bug class the architecture note
// describes — see that file's own header for the story).
//
// Docs: cave/PANEL.md
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IRON_QUOTA,
  PORTS,
  getFleet,
  invalidateFleet,
  readAlerts,
  getTodoBoard,
  getVault,
  getEconomy,
  getMissionsForBot,
  doWake,
  doStop,
} from './panel-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// PANEL_PORT defaults to the production 3200; override with env for a
// throwaway dev instance (e.g. PANEL_PORT=3290) so panel changes can be
// smoke-tested without ever touching the live process on 3200. The Host
// allow-list below is built off this const, so a dev instance automatically
// allow-lists its own port instead of 3200's.
const PANEL_PORT = Number(process.env.PANEL_PORT) || 3200;
// Bind all interfaces: loopback + Tailscale (chief order 2026-09-01). Network
// exposure is fenced by the Windows firewall (inbound 3200 scoped to the
// tailnet CGNAT range 100.64.0.0/10) — the Host allow-list below stays as
// CSRF protection, not as network auth.
const PANEL_HOST = process.env.PANEL_HOST || '0.0.0.0';
// The panel polls the fleet on its own timer, whether or not a browser is
// attached. Movement deltas are only meaningful if the position ring has been
// filling all along, so the page must not be the thing that drives sampling —
// otherwise opening the tab shows dashes for the first minute. Request serving
// still goes through panel-data.mjs's own fleet cache; this just keeps it warm.
const SELF_POLL_MS = 5000;

// ---------------------------------------------------------------------------
// /panel.js — the client script, served as a real static file (architecture
// note, phase 1). mtime-cached in memory the same spirit as panel-data.mjs's
// TODO/Vault caches: re-read from disk only when the file on disk actually
// changed, not on every request.
// ---------------------------------------------------------------------------
const PANEL_CLIENT_PATH = path.join(HERE, 'panel-client.js');
let clientCache = { mtimeMs: -1, text: null };

async function getClientScript() {
  const stat = await fsp.stat(PANEL_CLIENT_PATH);
  if (!clientCache.text || clientCache.mtimeMs !== stat.mtimeMs) {
    clientCache = { mtimeMs: stat.mtimeMs, text: await fsp.readFile(PANEL_CLIENT_PATH, 'utf8') };
  }
  return clientCache.text;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64_000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    try {
      sendJson(res, 500, { error: err?.message ?? String(err) });
    } catch {
      // response already gone
    }
  });
});

// CSRF / DNS-rebinding guard. Binding to 127.0.0.1 keeps other machines out
// but does NOT keep out a random web page the operator happens to have open:
// the browser will happily issue cross-origin requests at localhost. Two
// layers close that, and both are needed:
//
//  1. Host allow-list — a hostile page can point a domain it controls at
//     127.0.0.1 (DNS rebinding) and reach this server with its own origin's
//     privileges. Such a request still carries that attacker hostname in the
//     Host header, so anything but our own loopback names is refused.
//  2. Content-type gate on writes — text/plain, form-urlencoded and multipart
//     are CORS-"simple" request types: a page can POST them cross-origin with
//     no preflight at all, and `mode:'no-cors'` hides the response while the
//     mutation still lands. Requiring application/json forces a preflight,
//     and since this server sends no CORS headers the preflight fails and the
//     request never arrives.
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PANEL_PORT}`,
  `localhost:${PANEL_PORT}`,
  `[::1]:${PANEL_PORT}`,
  `zetpc:${PANEL_PORT}`,
  `zetpc.tail5d7e78.ts.net:${PANEL_PORT}`,
]);
// Tailscale CGNAT IPs (100.64.0.0/10) are legitimate Host values when a
// tailnet device opens the panel by IP.
const TAILNET_HOST_RE = new RegExp('^100([.][0-9]{1,3}){3}:' + PANEL_PORT + '$');

function hostAllowed(req) {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  const h = host.toLowerCase();
  return ALLOWED_HOSTS.has(h) || TAILNET_HOST_RE.test(h);
}

function isJsonRequest(req) {
  const ct = req.headers['content-type'];
  return typeof ct === 'string' && ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${PANEL_HOST}:${PANEL_PORT}`);
  const p = url.pathname;
  const m = req.method;

  if (!hostAllowed(req)) {
    return sendJson(res, 403, { error: 'forbidden host — panel only answers to its own loopback origin' });
  }

  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    const html = renderPage();
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
    });
    return res.end(html);
  }

  if (m === 'GET' && p === '/panel.js') {
    let text;
    try {
      text = await getClientScript();
    } catch (err) {
      return sendJson(res, 500, { error: `panel-client.js unreadable (${err?.message ?? err})` });
    }
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    return res.end(text);
  }

  if (m === 'GET' && p === '/api/fleet') {
    return sendJson(res, 200, await getFleet());
  }

  if (m === 'GET' && p === '/api/alerts') {
    return sendJson(res, 200, await readAlerts());
  }

  if (m === 'GET' && p === '/api/todo') {
    return sendJson(res, 200, await getTodoBoard());
  }

  if (m === 'GET' && p === '/api/vault') {
    return sendJson(res, 200, await getVault());
  }

  // Economy graphs (PANEL_V3_SPEC.md §3.2) — per-item, time-bucketed net-flow
  // series over cave/ledger/*.jsonl, decoupled from the fast /api/fleet poll
  // (panel-client.js fetches this on its own slower ~20s timer, see that
  // file's own comment — ledger files only change on deposit/withdraw
  // events, not sub-second like task status).
  if (m === 'GET' && p === '/api/economy') {
    return sendJson(res, 200, await getEconomy());
  }

  // Mission Control drilldown (PANEL_V3_SPEC.md §3.1) — one bot's mission
  // history, fetched lazily when a card's drilldown is opened, deliberately
  // NOT part of /api/fleet's fast 3s payload (no reason to ship 8 bots' worth
  // of history on every poll when at most one card is expanded at a time).
  if (m === 'GET' && p === '/api/missions') {
    const bot = url.searchParams.get('bot');
    if (!bot) {
      return sendJson(res, 200, { ok: false, missing: false, bot: null, error: 'bot query param required', entries: [] });
    }
    return sendJson(res, 200, await getMissionsForBot(bot));
  }

  if (m === 'POST' && (p === '/api/wake' || p === '/api/stop')) {
    // Checked before the body is even read, and long before anything is
    // forwarded to a runner: a rejected request never touches a bot.
    if (!isJsonRequest(req)) {
      return sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    const out = p === '/api/wake' ? await doWake(body.bot) : await doStop(body.bot);
    // A write invalidates the cache so the next poll shows the new state.
    invalidateFleet();
    return sendJson(res, out.status, out.body);
  }

  return sendJson(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// The page — one self-contained HTML document (the HTML shell + CSS stay
// inline here per the architecture note: small, changes rarely, not worth a
// fourth file). The client script itself is NOT inlined — it's a real file,
// cave/panel-client.js, loaded via <script src="/panel.js">.
// ---------------------------------------------------------------------------

function renderPage() {
  return `<!DOCTYPE html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet Panel</title>
<style>
  :root {
    /* Dark-ops palette — current hardcoded colours lifted to tokens as
       baseline values (phase 1, zero visual change). A later skin pass
       swaps values in THIS block only; nothing downstream should ever
       hardcode a colour literal again. -rgb triplets exist purely so an
       alpha-composited box-shadow/background (rgba(var(--x-rgb), .4)) can
       still route through the same single source of truth as the solid
       colour, since a hex token can't be fed into rgba() directly without a
       preprocessor this file deliberately doesn't have. */
    --bg: #0d0f13;
    --bg-rgb: 13, 15, 19;
    --panel: #151920;
    --panel-2: #1b2029;
    --line: #262d38;
    --text: #e4e8ef;
    --muted: #8a93a3;
    --dim: #5d6675;
    --amber: #f2b035;
    --amber-rgb: 242, 176, 53;
    --red: #ff6b63;
    --red-rgb: 255, 107, 99;
    --green: #5fe36b;
    --green-rgb: 95, 227, 107;
    --health-track: #3a4150;
    --dot-off: #4a5160;
    --dsep-color: #333a45;
    --chip-count-bg: #2c3441;
    --wake-text: #241a05;
    --wake-hover: #ffc453;
    --err-text: #ffb3ae;
    --alert-text: #ffc0bb;
    --quota-grad-start: #9aa4b2;
    --quota-grad-end: #dfe6f0;
    /* Economy sparkline palette (v3, §3.2) — one fixed hue per tracked item
       (ECONOMY_KEY_ITEMS, panel-data.mjs), chosen to evoke the real material
       rather than reused from the red/amber/green severity set (that trio
       means "something's wrong" everywhere else on this page; an item chart
       isn't a severity signal) or from TEAM_HEX (that set means "which bot",
       a different identity axis entirely). */
    --econ-iron: #b9c3d6;
    --econ-raw-iron: #d98f5a;
    --econ-wheat: #e3c66a;
    --econ-bread: #c98a52;
    --econ-oak: #a97c4f;
    --econ-cobble: #9aa4b2;
    --radius: 12px;
    --radius-sm: 8px;
    --radius-xs: 7px;
    --radius-pill: 999px;
    --radius-track: 3px;
    --font-sans: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
    --font-mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }
  code, .mono { font-family: var(--font-mono); }

  header {
    position: sticky; top: 0; z-index: 10;
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px;
    padding: 14px 22px;
    background: rgba(var(--bg-rgb), .92);
    border-bottom: 1px solid var(--line);
    backdrop-filter: blur(8px);
  }
  .brand { font-size: 15px; font-weight: 650; letter-spacing: .14em; text-transform: uppercase; }
  .brand span { color: var(--dim); font-weight: 500; letter-spacing: .06em; text-transform: none; margin-left: 8px; font-size: 12px; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; align-items: center; }
  .stat {
    display: flex; align-items: baseline; gap: 7px;
    padding: 5px 11px; border: 1px solid var(--line); border-radius: var(--radius-pill);
    background: var(--panel); font-size: 12px; color: var(--muted);
  }
  .stat b { font-size: 13px; color: var(--text); font-weight: 600; }
  .stat.idle b { color: var(--amber); }
  /* The fleet's one shared KPI gets more visual weight than the other stat
     pills: a bigger number and a wider, taller track, so the number every
     driver is actually working toward doesn't read as just another pill in
     the row. */
  .quota { display: flex; align-items: center; gap: 9px; }
  .quota b { font-size: 15px; }
  .quota .track { width: 130px; height: 6px; border-radius: var(--radius-track); background: var(--panel-2); overflow: hidden; }
  .quota .fill { height: 100%; background: linear-gradient(90deg, var(--quota-grad-start), var(--quota-grad-end)); transition: width .4s ease; }
  .tick { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); transition: background .3s; }
  .tick.live { background: var(--green); box-shadow: 0 0 8px rgba(var(--green-rgb), .6); }

  main { display: grid; grid-template-columns: minmax(0,1fr) 320px; gap: 20px; padding: 20px 22px 40px; align-items: start; }
  @media (max-width: 1080px) { main { grid-template-columns: minmax(0,1fr); } }

  /* align-items:start — default grid stretch would make every OTHER card in
     the same row grow to match whichever one just expanded its event log,
     leaving dead space under their shorter content. Cards below the row
     still reflow when one grows (unavoidable in a static grid without a
     measured-height overlay), but same-row neighbours no longer visibly
     stretch for it. */
  #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; align-items: start; }

  .card {
    position: relative;
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 3px solid var(--line);
    border-radius: var(--radius);
    padding: 13px 15px 14px;
    transition: border-color .3s, opacity .3s;
  }
  /* Severity escalates in two dimensions at once — colour AND weight — so the
     four states read as a clear ladder even to a glance that only catches
     the left edge: idle (waiting, unremarkable) = amber, default 3px width;
     err (a task actually failed) = red, 4px, heavier than idle on purpose;
     panic (the runner's own emergency reflex) = red, 5px, full-ring glow,
     outranks everything. Idle previously tinted the WHOLE border ring the
     same as a real error would — that made "bot is waiting for a driver"
     look almost as alarming as "something broke", working against the calm
     end of the hierarchy. Idle now only accents the left edge. */
  .card.idle { border-left-color: var(--amber); }
  .card.offline { opacity: .55; }
  .card.err { border-left-color: var(--red); border-left-width: 4px; }
  .card.panic { border-left-width: 5px; border-color: rgba(var(--red-rgb), .6); border-left-color: var(--red); box-shadow: 0 0 0 1px rgba(var(--red-rgb), .25); }
  .task.panic { background: rgba(var(--red-rgb), .12); }
  .task.panic .kind { color: var(--red); }

  .row1 { display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: none; }
  .dot.on { background: var(--green); box-shadow: 0 0 7px rgba(var(--green-rgb), .55); }
  .dot.warn { background: var(--amber); box-shadow: 0 0 7px rgba(var(--amber-rgb), .5); }
  .dot.off { background: var(--dot-off); }
  .name { font-size: 15px; font-weight: 650; letter-spacing: .02em; }
  .port { font-size: 11px; color: var(--dim); }
  .age { margin-left: auto; font-size: 11px; color: var(--muted); white-space: nowrap; }

  .pos { margin-top: 5px; font-size: 11px; color: var(--muted); letter-spacing: .02em; }

  /* Distance-from-base (v3, Mission Control) — horizontal metres + 8-point
     compass + vertical delta off BASE_ANCHOR (panel-data.mjs). One line,
     supplementary to .pos rather than replacing it, so hidden entirely
     (never "0m") when pos itself is unknown — see panel-client.js fmtDistance. */
  .distance { margin-top: 3px; font-size: 11px; color: var(--dim); letter-spacing: .02em; }

  .delta { margin-top: 5px; display: flex; align-items: baseline; gap: 6px; font-size: 11px; }
  .dl { color: var(--dim); letter-spacing: .03em; }
  .dv { font-weight: 650; font-variant-numeric: tabular-nums; }
  .dsep { color: var(--dsep-color); }

  .vitals { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin-top: 10px; }
  .vital { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--muted); }
  .vital .lbl { width: 12px; flex: none; text-align: center; }
  .vital .track { flex: 1; height: 6px; border-radius: var(--radius-track); background: var(--panel-2); overflow: hidden; }
  .vital .fill { height: 100%; border-radius: var(--radius-track); transition: width .45s ease, background .3s; }
  .vital .num { width: 26px; flex: none; text-align: right; color: var(--text); font-size: 11px; }

  .task { margin-top: 11px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--panel-2); }
  .task .head { display: flex; align-items: center; gap: 7px; font-size: 12px; }
  .task .kind { font-weight: 600; }
  .task .state { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; padding: 2px 7px; border-radius: var(--radius-pill); border: 1px solid var(--line); color: var(--muted); }
  .task .state.running { color: var(--green); border-color: rgba(var(--green-rgb), .35); }
  .task .state.failed { color: var(--red); border-color: rgba(var(--red-rgb), .4); }
  .task .src { margin-left: auto; font-size: 10px; color: var(--dim); white-space: nowrap; text-align: right; }
  .task .detail { margin-top: 4px; font-size: 11px; color: var(--muted); word-break: break-word; }

  .err-box { margin-top: 9px; padding: 7px 10px; border-radius: var(--radius-sm); font-size: 11px; color: var(--err-text); background: rgba(var(--red-rgb), .09); border: 1px solid rgba(var(--red-rgb), .3); word-break: break-word; }

  /* Footer divider — one hairline splits each card into two read zones:
     identity/vitals/task above, history+inventory+actions below. Eight
     flush-stacked blocks with only whitespace between them read as one
     undifferentiated pile at a glance; this line is the one chunk-point
     worth having, not sprinkled everywhere (that would be noise, not
     rhythm). */
  .meta { margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 5px 12px; font-size: 11px; color: var(--dim); }
  .meta b { color: var(--muted); font-weight: 600; }
  .meta .guard.warn { color: var(--amber); }
  .ev-toggle { cursor: pointer; user-select: none; }
  .ev-toggle:hover { color: var(--muted); }

  /* Per-card event log — collapsed by default (density: most of the time
     nobody needs it), toggled by the .ev-toggle chip in .meta. Capped height
     + its own scrollbar so an eventful bot can't stretch the whole card past
     its neighbours. Animated via max-height/opacity rather than [hidden] so
     expand/collapse eases in instead of snapping the card's height in one
     frame — that abrupt snap was the actual "jump", not the row reflow below
     it (which a static grid can't avoid without a measured-height overlay;
     see #grid's align-items:start above for the other half of that fix). */
  .ev-list {
    margin-top: 0; max-height: 0; opacity: 0; overflow: hidden;
    display: flex; flex-direction: column; gap: 5px; padding-right: 2px;
    transition: max-height .22s ease, opacity .18s ease, margin-top .22s ease;
  }
  .ev-list.open { margin-top: 8px; max-height: 140px; opacity: 1; overflow-y: auto; }
  .ev-item { font-size: 10px; color: var(--dim); display: flex; gap: 7px; }
  /* Monospace + tabular-nums: a column of "12s ago" / "3m 4s ago" reads as a
     ledger, not a paragraph — same reasoning as the delta/health numerals
     elsewhere on the card. */
  .ev-item .et { flex: none; font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
  .ev-item .em { color: var(--muted); word-break: break-word; }
  .ev-item.warn .em { color: var(--err-text); }
  /* Rate-cap rollup lines ("...suppressed N similar X event(s)", runner.js's
     RING RATE CAP) are log housekeeping, not a real thing the bot did —
     italicized so they read as a footnote about the log itself, distinct
     from the events around them even when the type they're rolling up
     happens to also be alert-worthy (.warn still applies its own colour). */
  .ev-item.suppressed .em { font-style: italic; }
  .ev-empty { font-size: 10px; color: var(--dim); font-style: italic; }

  .inv { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 5px; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 4px 2px 8px; border-radius: var(--radius-pill);
    background: var(--panel-2); border: 1px solid var(--line);
    font-size: 10px; color: var(--muted); max-width: 100%;
  }
  .chip .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip .c { padding: 0 6px; border-radius: var(--radius-pill); background: var(--chip-count-bg); color: var(--text); font-size: 10px; font-weight: 600; }
  .inv-empty { margin-top: 10px; font-size: 11px; color: var(--dim); font-style: italic; }

  /* Durability chips (v3, G1's per-item durability field) — a thin bar under
     the name+count row, vanilla Minecraft's own inventory-GUI convention for
     "this tool is wearing out." Only items that actually carry a
     {used,max} pair grow this second row; every other chip (materials,
     food, a tool from a runner that hasn't shipped G1 yet) renders exactly
     like today's plain chip — see buildItemChip() in panel-client.js. */
  .chip.has-dur { flex-direction: column; align-items: stretch; gap: 3px; padding: 4px 8px 5px; }
  .chip-top { display: flex; align-items: center; gap: 5px; }
  .dur-bar { display: block; height: 3px; border-radius: var(--radius-track); background: var(--health-track); overflow: hidden; }
  .dur-fill { display: block; height: 100%; border-radius: var(--radius-track); transition: width .3s ease, background .3s; }

  .acts { margin-top: 12px; display: flex; gap: 8px; align-items: center; }
  button {
    font: inherit; cursor: pointer; border-radius: var(--radius-sm); transition: background .15s, border-color .15s, opacity .15s;
  }
  button:disabled { opacity: .45; cursor: default; }
  .wake {
    padding: 6px 15px; font-size: 12px; font-weight: 650; letter-spacing: .05em;
    color: var(--wake-text); background: var(--amber); border: 1px solid var(--amber);
  }
  .wake:hover:not(:disabled) { background: var(--wake-hover); }
  .stop {
    padding: 4px 11px; font-size: 11px; color: var(--muted);
    background: transparent; border: 1px solid var(--line);
  }
  .stop:hover:not(:disabled) { color: var(--red); border-color: rgba(var(--red-rgb), .45); }
  .flash { font-size: 11px; color: var(--muted); }
  .flash.bad { color: var(--amber); }

  /* Mission Control drilldown (v3) — click a card's header row (row1) to
     reveal full inventory, this bot's recent events (same data as the
     existing per-card ev-toggle above, just the fuller view), and durable
     mission history from /api/missions (fetched lazily, only while this
     panel is open — see panel-client.js, not part of the 3s fleet poll).
     Same max-height/opacity reveal language as .ev-list/#bd-done — v3
     deliberately does not invent a second expand motion. */
  .row1.clickable { cursor: pointer; }
  .row1.clickable:hover .name { text-decoration: underline; text-decoration-color: var(--dim); text-underline-offset: 2px; }
  .dd-toggle { flex: none; font-size: 10px; color: var(--dim); margin-left: 6px; }
  .dd {
    max-height: 0; opacity: 0; overflow: hidden;
    transition: max-height .25s ease, opacity .2s ease, margin-top .25s ease, padding-top .25s ease;
  }
  .dd.open { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); max-height: 720px; opacity: 1; }
  .dd-head { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); margin: 10px 0 6px; }
  .dd-head:first-child { margin-top: 0; }
  .dd-inv.inv, .dd-inv.inv-empty { margin-top: 0; }
  .dd-list { display: flex; flex-direction: column; gap: 5px; max-height: 150px; overflow-y: auto; padding-right: 2px; }

  aside {
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 13px 15px; position: sticky; top: 74px; max-height: calc(100vh - 100px); display: flex; flex-direction: column;
  }
  aside h2 { margin: 0 0 3px; font-size: 12px; letter-spacing: .13em; text-transform: uppercase; color: var(--red); font-weight: 650; }
  aside .sub { font-size: 11px; color: var(--dim); margin-bottom: 9px; }
  #alerts { overflow-y: auto; display: flex; flex-direction: column; gap: 7px; }
  .alert { padding: 7px 9px; border-radius: var(--radius-xs); background: rgba(var(--red-rgb), .07); border-left: 2px solid rgba(var(--red-rgb), .55); }
  .alert .t { font-size: 10px; color: var(--dim); }
  .alert .m { font-size: 11px; color: var(--alert-text); word-break: break-word; }
  .alert.bot { background: rgba(var(--red-rgb), .12); border-left-color: var(--red); }
  .alert .src { font-size: 10px; letter-spacing: .09em; text-transform: uppercase; color: var(--dim); }
  .none { font-size: 11px; color: var(--dim); font-style: italic; }

  /* Tribe board (round 5) — "what is the tribe working on", parsed
     server-side from cave/TODO.md. Full-width, below the fleet grid, its
     own card: DOING and QUEUED always shown, DONE collapsed (same
     max-height/opacity motion language as a card's event log, so the page
     has exactly one way expand/collapse ever behaves). Rows lay out as a
     div-grid "table" — display:contents on each row lets lane/task/who/
     status line up into shared columns without an actual <table>. */
  #board { margin: 0 22px 24px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 18px 16px; }
  .board-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
  .board-head h2 { margin: 0; font-size: 12px; letter-spacing: .13em; text-transform: uppercase; color: var(--text); font-weight: 650; }
  .board-sub { font-size: 11px; color: var(--dim); }
  /* margin-top on the DOING label (14px) stacks with .board-head's own
     margin-bottom (10px) into a slightly larger gap under the section
     header than between the groups below it — left alone on purpose rather
     than zeroed out with a :first-of-type rule that would silently never
     fire (.board-head is the actual first <div> child, not a .board-label,
     so :first-of-type never matches any of these three). */
  .board-label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); margin: 14px 0 7px; }
  .board-label b { color: var(--muted); font-weight: 600; }
  .board-label.toggle { cursor: pointer; user-select: none; }
  .board-label.toggle:hover { color: var(--muted); }
  .board-rows { display: grid; grid-template-columns: 100px minmax(0,1fr) auto 170px; column-gap: 12px; row-gap: 7px; align-items: start; }
  .board-row { display: contents; }
  .board-lane { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--dim); white-space: nowrap; padding-top: 2px; }
  .board-task { font-size: 12px; color: var(--text); word-break: break-word; }
  .board-who { display: flex; flex-wrap: wrap; gap: 4px; align-items: flex-start; }
  .board-chip { font-size: 10px; padding: 1px 7px; border-radius: var(--radius-pill); background: var(--panel-2); border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .board-status { font-size: 11px; color: var(--dim); text-align: right; word-break: break-word; }
  .board-empty { grid-column: 1 / -1; font-size: 11px; color: var(--dim); font-style: italic; }
  #bd-done { max-height: 0; opacity: 0; overflow: hidden; transition: max-height .22s ease, opacity .18s ease; }
  #bd-done.open { max-height: 320px; opacity: 1; overflow-y: auto; }
  @media (max-width: 720px) {
    .board-rows { grid-template-columns: auto 1fr; }
    .board-who, .board-status { grid-column: 1 / -1; }
  }

  /* Vault (round 7) — cave/audit-snapshot.json, the ground-truth depot
     ledger, same card shell as #board. Hidden outright (not an empty-state
     message) when the file has never been written — "audit never ran" is a
     normal state, not a broken one. Chip look is deliberately identical to
     a bot card's own inventory chips (.chip, reused as-is) — same "what's
     actually in there" language for a chest as for a bot. */
  #vault { margin: 0 22px 24px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 18px 16px; }
  .vault-age { font-size: 11px; color: var(--dim); }
  .vault-age.stale { color: var(--amber); }
  #vault-chests { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-top: 4px; }
  .vault-chest { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .vault-chest.err { border-color: rgba(var(--amber-rgb), .45); }
  .vault-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .vault-label { font-size: 12px; font-weight: 600; color: var(--text); }
  .vault-pos { font-size: 10px; color: var(--dim); font-family: var(--font-mono); }
  .vault-total { margin-left: auto; font-size: 11px; color: var(--muted); white-space: nowrap; }
  .vault-error { font-size: 11px; color: var(--amber); font-style: italic; }

  /* Economy (v3, §3.2) — cave/ledger/*.jsonl's per-item net-flow sparklines,
     same full-width card shell as #board/#vault. Sits between the fleet
     grid and the Tribe Board per the launch brief's layout ask. Hidden
     outright (not an empty-state message) when no ledger file has ever
     existed — mirrors Vault's "never audited" rule exactly, since "no
     economic activity recorded yet" is a normal state for a brand-new
     primitive, not a broken one. Once at least one file/entry exists the
     section always shows, even a single data point being honest information
     (unlike an empty Vault audit, which genuinely has nothing to say). */
  #economy { margin: 0 22px 24px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 18px 16px; }
  .econ-empty { font-size: 11px; color: var(--dim); font-style: italic; }
  .econ-items { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
  .econ-row { display: flex; align-items: center; gap: 12px; padding: 7px 10px; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .econ-name { width: 100px; flex: none; font-size: 12px; font-weight: 600; color: var(--text); font-family: var(--font-mono); }
  .econ-spark { flex: none; line-height: 0; }
  .econ-net { flex: none; width: 64px; text-align: right; font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; color: var(--muted); }
  .econ-net.pos { color: var(--green); }
  .econ-net.neg { color: var(--red); }
  .econ-last { flex: 1; min-width: 0; font-size: 10px; color: var(--dim); text-align: right; white-space: nowrap; }

  footer { padding: 0 22px 28px; font-size: 11px; color: var(--dim); }
  footer code { color: var(--muted); }
</style>

<header>
  <div class="brand">Fleet Panel<span>cavecrew</span></div>
  <div class="stats">
    <div class="stat"><b id="s-online">-</b> online</div>
    <div class="stat idle"><b id="s-idle">-</b> idle</div>
    <div class="stat quota">
      <span>iron_ingot</span>
      <b id="s-iron">-</b>
      <div class="track"><div class="fill" id="s-iron-bar" style="width:0%"></div></div>
      <span id="s-quota">/ ${IRON_QUOTA}</span>
    </div>
    <div class="stat"><span class="tick" id="tick"></span><span id="s-when">connecting</span></div>
  </div>
</header>

<main>
  <div id="grid"></div>
  <aside>
    <h2>Alerts</h2>
    <div class="sub" id="alert-src">overseer escalations + live bot errors</div>
    <div id="alerts"><div class="none">nothing yet</div></div>
  </aside>
</main>

<section id="economy" hidden>
  <div class="board-head">
    <h2>Economy</h2>
    <span class="board-sub" id="economy-sub">cave/ledger/*.jsonl — last 6h, 10-min buckets</span>
  </div>
  <div class="econ-items" id="economy-items"></div>
</section>

<section id="board">
  <div class="board-head">
    <h2>Tribe Board</h2>
    <span class="board-sub" id="board-sub">cave/TODO.md</span>
  </div>
  <div class="board-label">DOING <b id="bd-doing-n">0</b></div>
  <div class="board-rows" id="bd-doing"></div>
  <div class="board-label">QUEUED <b id="bd-todo-n">0</b></div>
  <div class="board-rows" id="bd-todo"></div>
  <div class="board-label toggle" id="bd-done-toggle"><span id="bd-done-arrow">▸ DONE</span> <b id="bd-done-n">0</b></div>
  <div class="board-rows" id="bd-done"></div>
</section>

<section id="vault" hidden>
  <div class="board-head">
    <h2>Vault</h2>
    <span class="board-sub">audit-snapshot.json —</span>
    <span class="vault-age" id="vault-age"></span>
  </div>
  <div id="vault-chests"></div>
</section>

<footer>Read-mostly panel. WAKE pushes the bot's role-default task with <code>force:false</code> (never preempts a driver); STOP cancels the running task. Docs: <code>cave/PANEL.md</code></footer>

<script src="/panel.js"></script>
`;
}

server.listen(PANEL_PORT, PANEL_HOST, () => {
  console.log(`[panel] fleet panel on http://${PANEL_HOST}:${PANEL_PORT}`);
  console.log(`[panel] watching runner ports: ${PORTS.join(', ')}`);
  console.log(`[panel] self-polling every ${SELF_POLL_MS}ms to keep movement deltas warm`);
  console.log('[panel] write actions: /api/wake (force:false), /api/stop — nothing else mutates');

  // Fires regardless of connected clients. unref'd so it can never be the
  // reason the process refuses to exit — the server handle owns the lifetime.
  const selfPoll = setInterval(() => {
    getFleet().catch(() => {
      // A failed sweep is already tolerated per-bot inside buildFleet; nothing
      // to do here but wait for the next tick.
    });
  }, SELF_POLL_MS);
  selfPoll.unref();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
