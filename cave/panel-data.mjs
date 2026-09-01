// cave/panel-data.mjs — every server-side data-layer function the fleet
// panel needs, with zero dependency on `http`/`req`/`res`. This is the panel's
// entire read (and the two narrow write) surface: fleet polling/aggregation,
// the alerts tail, the TODO board parser, the Vault reader, the two write
// actions (wake/stop), and the newer v3 data primitives (ledger, deaths,
// FEL relation, missions) — of which distanceFromBase() and
// getMissionsForBot() are now wired into Mission Control (PANEL_V3_SPEC.md
// §3.1); the ledger/deaths-streak/FEL-relation readers remain unwired,
// waiting on the Economy graphs / Tribe Stat Wall sections.
//
// Split out of cave/panel.mjs (PANEL V3 SPEC, architecture note, phase 1) so
// each parser is independently testable without booting the HTTP server:
//   node -e "import('./panel-data.mjs').then(m => console.log(m.getVault()))"
// panel.mjs imports named exports from here and stays HTTP server + routing
// only. See cave/PANEL_V3_SPEC.md and cave/PANEL.md for the full contract.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const RUNNER_TIMEOUT_MS = 3000;
const FLEET_CACHE_MS = 2000;
const EVENTS_PER_BOT = 10;
const ALERT_LINES = 50;
export const IRON_QUOTA = 360;

// Runner ports. Default is the production fleet 3201-3208; CAVE_PANEL_PORTS
// (comma-separated) overrides it so the write paths can be exercised against a
// throwaway test runner (e.g. CAVE_PANEL_PORTS=3209) without ever pointing at
// a production bot a driver owns.
const DEFAULT_PORTS = [3201, 3202, 3203, 3204, 3205, 3206, 3207, 3208];

function parsePorts(raw) {
  if (!raw) return null;
  const ports = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return ports.length ? ports : null;
}

export const PORTS = parsePorts(process.env.CAVE_PANEL_PORTS) ?? DEFAULT_PORTS;

// ---------------------------------------------------------------------------
// Fleet roster. Mirrored from cave/overseer.mjs's BOTS list (~line 34) — that
// file is the source of truth for role-default tasks, but it is a daemon that
// starts its own supervision loop on import, so it cannot be imported here.
// Keep this table in sync by hand when overseer's defaults change.
//
// `defaults` in overseer is a rotation the supervisor cycles through; the WAKE
// button pushes defaults[0] so one click is deterministic and predictable.
// `team` is the Minecraft team colour from runner.js's TEAM_COLORS (~line 78).
// ---------------------------------------------------------------------------
const BOTS = [
  { name: 'UngaBunga', port: 3201, team: 'yellow',
    wake: { ep: '/chop', body: { count: 4, maxDistance: 48 }, say: 'idle: chop wood' } },
  { name: 'Grog', port: 3202, team: 'green',
    // No /mine default on purpose: /mine's maxDistance is 3D and has tunnelled
    // bots downward unattended. Builder role sweeps only.
    wake: { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' } },
  { name: 'Zug', port: 3203, team: 'light_purple',
    wake: { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' } },
  { name: 'Bonk', port: 3204, team: 'aqua',
    wake: { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' } },
  { name: 'Thak', port: 3205, team: 'gold',
    wake: { ep: '/mine', body: { block: 'coal_ore', count: 4, maxDistance: 28 }, say: 'idle: dig coal' } },
  { name: 'Ook', port: 3206, team: 'red',
    wake: { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' } },
  { name: 'Durk', port: 3207, team: 'blue',
    wake: { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' } },
  { name: 'Mog', port: 3208, team: 'dark_aqua',
    wake: { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' } },
];

// Any runner on a port outside the roster (a test bot under CAVE_PANEL_PORTS)
// still gets a wake action — the universally safe sweep every roster bot has.
const FALLBACK_WAKE = { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' };

const BOT_BY_PORT = new Map(BOTS.map((b) => [b.port, b]));
const BOT_BY_NAME = new Map(BOTS.map((b) => [b.name.toLowerCase(), b]));

// Minecraft chat-colour names -> hex that stays readable on a near-black card.
// `blue` and `dark_aqua` are lifted off their literal chat values (#5555FF,
// #00AAAA), which go muddy on dark; everything else is the palette value.
export const TEAM_HEX = {
  green: '#5fe36b',
  yellow: '#ffe14d',
  light_purple: '#e77ff0',
  aqua: '#5ff2f2',
  gold: '#ffb340',
  red: '#ff6b63',
  blue: '#7d8dff',
  dark_aqua: '#3fd0cf',
  white: '#d8dee9',
};

// The single authoritative "base position" — G3 in PANEL_V3_SPEC.md. Adopts
// chest A's real, physical, unambiguous position (already CHEST_META's
// chest_a_materials below) rather than either of the two informal candidates
// that predate this constant (overseer.mjs's idle-guard CAMP ring centre, and
// CIV.md's looser prose description) — those stay what they are for their own
// consumers; this is the one v3 (and any future feature) measures "distance
// from base" against. Consumed by distanceFromBase() below, wired into
// Mission Control's per-card distance badge (PANEL_V3_SPEC.md §3.1).
export const BASE_ANCHOR = { x: 11, y: 89, z: 55 };

// ---------------------------------------------------------------------------
// Distance from base — Mission Control wall state (PANEL_V3_SPEC.md §3.1,
// G3). Horizontal distance is 2D (dx/dz only), deliberately matching how
// overseer.mjs's own idle-guard ring check ignores Y; vertical delta is kept
// separate rather than folded into one 3D number, since "how far sideways"
// and "how far up/down" are different questions a driver reads differently.
// Compass bearing is the 8-point points-of-the-compass reading (not 16), off
// Minecraft's own world axes: +X = east, +Z = south, so north is -Z.
// ---------------------------------------------------------------------------
const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
// Below this horizontal distance a bearing is noise, not information — a bot
// standing on top of the anchor doesn't have a meaningful "direction from
// base" any more than "0m away" needs one.
const COMPASS_MIN_DIST = 1;

function compassBearing(dx, dz) {
  const deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const norm = (deg + 360) % 360;
  return COMPASS_POINTS[Math.round(norm / 45) % 8];
}

// Exported for independent testing (`node -e "import('./panel-data.mjs').then(m => console.log(m.distanceFromBase({x:1,y:1,z:1})))"`).
// pos null (offline/unspawned) is the honest "no reading" case — never a
// fabricated 0m — same rule the movement-delta ring already follows.
export function distanceFromBase(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return null;
  const dx = pos.x - BASE_ANCHOR.x;
  const dz = pos.z - BASE_ANCHOR.z;
  const horiz = Math.sqrt(dx * dx + dz * dz);
  const vertical = typeof pos.y === 'number' ? Math.round(pos.y - BASE_ANCHOR.y) : null;
  return {
    horiz: Math.round(horiz * 10) / 10,
    vertical,
    compass: horiz < COMPASS_MIN_DIST ? null : compassBearing(dx, dz),
  };
}

// ---------------------------------------------------------------------------
// Runner polling
// ---------------------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// Per-port rolling event window. /events has no "last N" parameter, so instead
// of re-pulling the whole 500-entry ring every 2s we remember each runner's
// last seq and ask only for what's new. A runner restart resets its seq, which
// shows up as `last` moving backwards — detected below and re-synced from 0.
const eventState = new Map(); // port -> { since, window: [], starts: Map(taskId -> ts) }

function eventSlot(port) {
  let slot = eventState.get(port);
  if (!slot) {
    slot = { since: 0, window: [], starts: new Map() };
    eventState.set(port, slot);
  }
  return slot;
}

const TASK_START_RE = /^task (\S+) \(.+\) started$/;

async function pollEvents(port) {
  const slot = eventSlot(port);
  try {
    const { status, json } = await getJson(`http://127.0.0.1:${port}/events?since=${slot.since}`);
    if (status !== 200 || !json || !Array.isArray(json.events)) return slot.window;
    const last = Number(json.last) || 0;
    if (last < slot.since) {
      // Runner restarted — its ring is fresh and its seq counter went back to
      // 1, so the response we're holding was filtered against a `since` from
      // the previous run and is empty/meaningless. Drop the stale view, rewind
      // to 0 and bail: the NEXT tick refetches the new run from its first
      // event. (Falling through here instead would skip seq 1..last forever,
      // losing every task-start entry and with it the cards' task ages.)
      slot.window = [];
      slot.starts.clear();
      slot.since = 0;
      return slot.window;
    }
    for (const ev of json.events) {
      // Best-effort task age: remember when each task id was announced as
      // started, so /status's currentTask (which carries no timestamp) can be
      // aged even after its start event has scrolled out of the window.
      const m = typeof ev.msg === 'string' ? TASK_START_RE.exec(ev.msg) : null;
      if (m) {
        slot.starts.set(m[1], ev.ts);
        if (slot.starts.size > 50) slot.starts.delete(slot.starts.keys().next().value);
      }
      slot.window.push(ev);
    }
    if (slot.window.length > EVENTS_PER_BOT) {
      slot.window = slot.window.slice(-EVENTS_PER_BOT);
    }
    slot.since = Math.max(slot.since, last);
  } catch {
    // A down or slow runner just keeps whatever window we already had.
  }
  return slot.window;
}

async function pollBot(port) {
  const roster = BOT_BY_PORT.get(port) ?? null;
  const base = {
    port,
    name: roster?.name ?? `:${port}`,
    team: roster?.team ?? 'white',
    color: TEAM_HEX[roster?.team ?? 'white'] ?? TEAM_HEX.white,
    inRoster: !!roster,
  };

  let status = null;
  let offline = true;
  let offlineReason = null;
  try {
    const res = await getJson(`http://127.0.0.1:${port}/status`);
    if (res.status === 200 && res.json && typeof res.json === 'object') {
      status = res.json;
      offline = false;
    } else {
      offlineReason = `HTTP ${res.status}`;
    }
  } catch (err) {
    offlineReason = err?.name === 'TimeoutError' ? 'timeout' : (err?.message ?? String(err));
  }

  if (offline) {
    return {
      ...base,
      offline: true,
      offlineReason,
      connected: false,
      pos: null,
      distance: null,
      health: null,
      food: null,
      inventory: [],
      currentTask: null,
      lastError: null,
      deathCount: null,
      idleGuard: null,
      lastDeath: null,
      engine: null,
      idle: false,
      taskStartedAt: null,
      events: eventSlot(port).window,
    };
  }

  const events = await pollEvents(port);
  const slot = eventSlot(port);
  const task = status.currentTask ?? null;
  const running = !!task && task.state === 'running';
  // Idle per spec: nothing scheduled, or the last task already finished, or the
  // runner is only filling time with its self-issued idle-guard.
  const idle = !task || !running || task.kind === 'idle-guard';

  return {
    ...base,
    name: typeof status.name === 'string' && status.name ? status.name : base.name,
    offline: false,
    offlineReason: null,
    connected: !!status.connected,
    pos: status.pos ?? null,
    distance: distanceFromBase(status.pos ?? null),
    health: typeof status.health === 'number' ? status.health : null,
    food: typeof status.food === 'number' ? status.food : null,
    gamemode: status.gamemode ?? null,
    inventory: Array.isArray(status.inventory) ? status.inventory : [],
    currentTask: task,
    lastError: status.lastError ?? null,
    deathCount: typeof status.deathCount === 'number' ? status.deathCount : null,
    // idleGuard (issue #6): true = armed, false = a driver disabled it for its
    // own active session (safety TTL re-arms it after 15min of silence — see
    // runner.js). Older runners predating that field just report null, same
    // treatment as any other missing optional status field.
    idleGuard: typeof status.idleGuard === 'boolean' ? status.idleGuard : null,
    lastDeath: status.lastDeath ?? null,
    engine: status.engine ?? null,
    idle,
    running,
    taskStartedAt: task ? (slot.starts.get(task.id) ?? null) : null,
    events,
  };
}

let fleetCache = { at: 0, payload: null };
let fleetInFlight = null;
// Bumped by invalidateFleet(). A buildFleet() captures this at start and only
// stamps its result into the cache if it is still current — otherwise a poll
// that was already in flight when a wake/stop landed would write its
// pre-write snapshot back over the freshly invalidated cache, and the panel
// would keep serving the old task state for up to FLEET_CACHE_MS.
let fleetGen = 0;

export function invalidateFleet() {
  fleetGen++;
  fleetCache = { at: 0, payload: fleetCache.payload };
}

// ---------------------------------------------------------------------------
// Movement deltas — "is this bot actually moving, or is it wedged?"
//
// Per-bot in-memory ring of timestamped positions, ~65s deep, appended on every
// fleet build (client-driven or self-poll alike). A delta is the straight-line
// 3D distance from the current position to the sample nearest N seconds ago —
// deliberately endpoint-to-endpoint, not path length: it answers "did it get
// anywhere", which is the wedge question, and costs one sqrt.
//
// The ring lives only in this process: it resets when the panel restarts, and
// survives browser refreshes (which is the point — the chief's tab being closed
// must not blank the history). See SELF_POLL_MS (panel.mjs) for how it stays warm.
// ---------------------------------------------------------------------------
const POS_RING_MS = 65_000;
// How far off the requested age a sample may be and still count. At the 5s
// self-poll cadence the nearest sample is normally within ~2.5s; anything
// beyond this means the ring is too young or has a hole, and the honest answer
// is null rather than a delta measured over the wrong window.
const DELTA_TOLERANCE_MS = 7_500;
const posRing = new Map(); // port -> [{ t, x, y, z }] oldest first

function samplePosition(port, pos, now) {
  let ring = posRing.get(port);
  if (!ring) {
    ring = [];
    posRing.set(port, ring);
  }
  if (pos && typeof pos.x === 'number') ring.push({ t: now, x: pos.x, y: pos.y, z: pos.z });
  const cutoff = now - POS_RING_MS;
  while (ring.length && ring[0].t < cutoff) ring.shift();
  return ring;
}

function deltaOver(ring, pos, now, windowMs) {
  if (!pos || typeof pos.x !== 'number') return null;
  const target = now - windowMs;
  let best = null;
  let bestGap = Infinity;
  for (const s of ring) {
    const gap = Math.abs(s.t - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = s;
    }
  }
  // Covers the just-started case too: with only fresh samples in the ring the
  // nearest one is ~windowMs away from the target, so this returns null until
  // the ring is actually old enough to answer.
  if (!best || bestGap > DELTA_TOLERANCE_MS) return null;
  const dx = pos.x - best.x;
  const dy = pos.y - best.y;
  const dz = pos.z - best.z;
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10) / 10;
}

async function buildFleet() {
  const bots = await Promise.all(PORTS.map((p) => pollBot(p).catch((err) => ({
    port: p,
    name: BOT_BY_PORT.get(p)?.name ?? `:${p}`,
    team: BOT_BY_PORT.get(p)?.team ?? 'white',
    color: TEAM_HEX[BOT_BY_PORT.get(p)?.team ?? 'white'] ?? TEAM_HEX.white,
    offline: true,
    offlineReason: err?.message ?? String(err),
    connected: false,
    pos: null, distance: null, health: null, food: null, inventory: [],
    currentTask: null, lastError: null, deathCount: null, idleGuard: null,
    lastDeath: null, engine: null,
    idle: false, taskStartedAt: null, events: [],
  }))));

  // Feed the position ring and stamp each bot's deltas. Offline bots still get
  // a samplePosition() call (with a null pos) so their ring keeps getting
  // pruned rather than freezing stale samples that would produce a bogus delta
  // the moment the runner comes back.
  const now = Date.now();
  for (const b of bots) {
    const pos = b.offline ? null : b.pos;
    const ring = samplePosition(b.port, pos, now);
    b.delta30 = deltaOver(ring, pos, now, 30_000);
    b.delta60 = deltaOver(ring, pos, now, 60_000);
  }

  const online = bots.filter((b) => !b.offline);
  const iron = bots.reduce((sum, b) => {
    const stack = b.inventory.find((i) => i.name === 'iron_ingot');
    return sum + (stack ? stack.count : 0);
  }, 0);

  return {
    ts: new Date().toISOString(),
    quota: { iron_ingot: IRON_QUOTA },
    summary: {
      total: PORTS.length,
      online: online.length,
      idle: online.filter((b) => b.idle).length,
      iron_ingot: iron,
    },
    bots,
  };
}

export async function getFleet() {
  const now = Date.now();
  if (fleetCache.payload && now - fleetCache.at < FLEET_CACHE_MS) return fleetCache.payload;
  // Collapse concurrent refreshes onto one poll — a hammered dashboard must not
  // multiply into N parallel pokes at every runner.
  if (!fleetInFlight) {
    const gen = fleetGen;
    fleetInFlight = buildFleet()
      .then((payload) => {
        if (gen === fleetGen) fleetCache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        fleetInFlight = null;
      });
  }
  return fleetInFlight;
}

// ---------------------------------------------------------------------------
// Alerts — tail of the overseer's escalation log.
// Written by cave/overseer.mjs to cave/logs/alerts.log; the older cave/alerts.log
// path is still checked so either layout works. Missing file is normal, not an
// error: it just means nothing has ever escalated.
// ---------------------------------------------------------------------------
const ALERT_PATHS = [path.join(HERE, 'logs', 'alerts.log'), path.join(HERE, 'alerts.log')];
const ALERT_TAIL_BYTES = 256 * 1024;
const ALERT_LINE_RE = /^\[([^\]]+)\]\s*(?:ALERT\s*)?(.*)$/;

export async function readAlerts() {
  for (const file of ALERT_PATHS) {
    let handle = null;
    try {
      handle = await fsp.open(file, 'r');
      const { size } = await handle.stat();
      const start = Math.max(0, size - ALERT_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      if (buf.length) await handle.read(buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
      // A partial first line is possible when the tail window cut mid-line.
      if (start > 0) lines.shift();
      return {
        file,
        alerts: lines.slice(-ALERT_LINES).reverse().map((line) => {
          const m = ALERT_LINE_RE.exec(line);
          return m ? { ts: m[1], msg: m[2] } : { ts: null, msg: line };
        }),
      };
    } catch {
      // try the next candidate path
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return { file: null, alerts: [] };
}

// ---------------------------------------------------------------------------
// TODO board — parses cave/TODO.md's markdown tables server-side (round 5,
// team-lead's phase-2 ask) so the page can show "what is the tribe working
// on" without shipping a markdown parser to the client. Cached on the file's
// mtime: re-read+re-parse only when TODO.md actually changed, not on every
// poll — driver edits to that file are occasional, not per-second.
//
// TODO.md carries at least two tables in practice: the live board (#, Lane,
// Task, Who, Status columns) and a "## DONE" section further down (Task, By
// — no Status column, since everything in it is implicitly done). Both are
// parsed the same generic way — by header name, not position — so a
// hand-reordered or renamed column still lands in the right field, and a
// row whose cell count doesn't match its header is counted and skipped
// rather than guessed at or thrown on.
// ---------------------------------------------------------------------------
const TODO_PATH = path.join(HERE, 'TODO.md');
let todoCache = { mtimeMs: -1, board: null };

const TODO_COLUMN_ALIASES = { lane: 'lane', task: 'task', who: 'who', by: 'who', status: 'status' };

function splitTableRow(line) {
  // GFM allows the leading/trailing pipe to be omitted; strip them if
  // present so "| a | b |" and "a | b" split identically.
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function isTableSeparatorRow(line) {
  const t = line.trim();
  return t.length > 0 && /^[-:|\s]+$/.test(t) && t.includes('-');
}

export function parseTodoMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  let skipped = 0;
  let lastHeading = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) {
      lastHeading = line.replace(/^#{1,6}\s*/, '').trim();
      continue;
    }
    if (!line.includes('|') || i + 1 >= lines.length || !isTableSeparatorRow(lines[i + 1])) continue;

    // line i is a table header, i+1 its separator.
    const header = splitTableRow(line).map((h) => h.toLowerCase());
    const fieldFor = header.map((h) => TODO_COLUMN_ALIASES[h] ?? null);
    if (!fieldFor.includes('task')) {
      // Not one of ours (no recognizable Task column) — skip just the
      // separator row and keep scanning; whatever body rows follow aren't
      // touched since we never entered the body-parsing loop below.
      i += 1;
      continue;
    }
    // Status-less tables (the "## DONE" section: Task, By) default every row
    // in them to 'done' rather than 'todo' — matching the heading they sit
    // under, not guessing from row content.
    const doneSection = /^done\b/i.test(lastHeading);
    i += 2; // past header + separator, onto the first body row
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      const cells = splitTableRow(lines[i]);
      if (cells.length !== header.length) {
        skipped++;
        i++;
        continue;
      }
      const rec = { lane: '', task: '', who: '', status: '' };
      fieldFor.forEach((field, idx) => {
        if (field) rec[field] = cells[idx] || '';
      });
      if (!rec.task) {
        skipped++;
        i++;
        continue;
      }
      if (!rec.status) rec.status = doneSection ? 'done' : 'todo';
      rows.push(rec);
      i++;
    }
    i--; // back up one so the outer for-loop's i++ lands on the line we just stopped at
  }
  return { rows, skipped };
}

function classifyStatus(status) {
  if (/^doing\b/i.test(status)) return 'doing';
  if (/^done\b/i.test(status)) return 'done';
  return 'todo';
}

// Strips a leading doing/done/todo keyword — redundant once a row is already
// grouped under that bucket's own heading. Only the bare keyword (plus an
// optional trailing dash) goes; "queued", "queued after #5", "blocked on
// cobble", "law" etc. don't match this and stay verbatim, since those ARE
// real information the bucket label alone doesn't carry.
function bucketDetail(status) {
  return status.replace(/^(doing|done|todo)\b\s*[-—:]*\s*/i, '').trim();
}

// A who-token that case-insensitively matches a roster bot gets that bot's
// team colour client-side — same visual language as its own card's name.
// Everything else (a driver/teammate name, "orchestrator", loose prose like
// "pair drivers") renders as a plain chip: real information, just not a bot.
function whoChip(token) {
  const bot = BOT_BY_NAME.get(token.toLowerCase());
  return { name: token, color: bot ? TEAM_HEX[bot.team] ?? null : null };
}

function splitWho(who) {
  return who.split(/[,+]/).map((s) => s.trim()).filter(Boolean).map(whoChip);
}

function buildTodoBoard(parsed) {
  const board = { doing: [], todo: [], done: [] };
  for (const rec of parsed.rows) {
    const bucket = classifyStatus(rec.status);
    board[bucket].push({
      lane: rec.lane,
      task: rec.task,
      who: splitWho(rec.who),
      detail: bucketDetail(rec.status),
    });
  }
  return board;
}

export async function getTodoBoard() {
  let stat;
  try {
    stat = await fsp.stat(TODO_PATH);
  } catch (err) {
    return { ok: false, error: `TODO.md unreadable (${err?.code ?? err?.message ?? err})`, doing: [], todo: [], done: [], skipped: 0, total: 0 };
  }
  if (todoCache.board && todoCache.mtimeMs === stat.mtimeMs) return todoCache.board;
  let text;
  try {
    text = await fsp.readFile(TODO_PATH, 'utf8');
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), doing: [], todo: [], done: [], skipped: 0, total: 0 };
  }
  const parsed = parseTodoMarkdown(text);
  const board = buildTodoBoard(parsed);
  const result = { ok: true, doing: board.doing, todo: board.todo, done: board.done, skipped: parsed.skipped, total: parsed.rows.length };
  todoCache = { mtimeMs: stat.mtimeMs, board: result };
  return result;
}

// ---------------------------------------------------------------------------
// Vault — round 7 (team-lead's ask): renders cave/audit-snapshot.json, the
// ground-truth depot ledger `cave/audit.mjs` writes after a read-only chest
// walk. Same mtime-cache shape as the TODO board above, with one addition:
// snapshot AGE must never be baked into the cached object, since the whole
// point of "cache until the file changes" is that the file can go stale for
// a long time between audit runs while this endpoint keeps getting polled —
// so age is computed fresh on every call, cache hit or not.
//
// CHEST_META (id -> x/y/z/label) is mirrored from audit.mjs's own CHESTS
// list (~line 36) — audit.mjs is a one-shot CLI script with no module
// exports (it calls main() directly), so this is a hand-synced copy, same
// contract as the BOTS/TEAM_HEX tables above. Keep in sync when a chest
// moves, gets added, or is removed from BASE.md's registry.
// ---------------------------------------------------------------------------
const VAULT_PATH = path.join(HERE, 'audit-snapshot.json');
const VAULT_STALE_MS = 2 * 60 * 60 * 1000;
let vaultCache = { mtimeMs: -1, result: null };

const CHEST_META = {
  chest_a_materials: { x: 11, y: 89, z: 55, label: 'chest A (wood/materials depot)' },
  chest_b_tools: { x: 12, y: 90, z: 54, label: 'chest B (building/torch supplies)' },
  chest_c_food: { x: 16, y: 89, z: 54, label: 'chest C (food, Mine House)' },
  chest_d_ore: { x: 14, y: 89, z: 57, label: 'chest D (ore, Mine House)' },
};

function buildVaultChests(rawChests) {
  return Object.entries(rawChests ?? {}).map(([id, counts]) => {
    const meta = CHEST_META[id] ?? null;
    const pos = meta ? { x: meta.x, y: meta.y, z: meta.z } : null;
    const label = meta?.label ?? id;
    // audit.mjs's __error shape: a chest it failed to read (goto/eval error,
    // chest missing/moved, timeout) — never a valid count map, so checked
    // first and rendered as a distinct failure, not garbage item chips.
    if (counts && typeof counts.__error === 'string') {
      return { id, label, pos, error: counts.__error, items: [], total: 0 };
    }
    const items = Object.entries(counts ?? {})
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    const total = items.reduce((sum, it) => sum + it.count, 0);
    return { id, label, pos, error: null, items, total };
  });
}

export async function getVault() {
  let stat;
  try {
    stat = await fsp.stat(VAULT_PATH);
  } catch (err) {
    // ENOENT (audit.mjs has simply never been run yet) is the normal,
    // expected case — distinct from any other stat failure (permissions,
    // etc.), which IS worth surfacing rather than quietly treating as
    // "nothing to show".
    if (err?.code === 'ENOENT') return { ok: true, missing: true };
    return { ok: false, missing: false, error: `audit-snapshot.json unreadable (${err?.code ?? err?.message ?? err})` };
  }

  let cached = vaultCache.result;
  if (!cached || vaultCache.mtimeMs !== stat.mtimeMs) {
    let raw;
    try {
      raw = await fsp.readFile(VAULT_PATH, 'utf8');
    } catch (err) {
      return { ok: false, missing: false, error: err?.message ?? String(err) };
    }
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch (err) {
      return { ok: false, missing: false, error: `audit-snapshot.json corrupt JSON: ${err?.message ?? err}` };
    }
    cached = {
      ok: true,
      missing: false,
      ts: typeof snapshot.ts === 'string' ? snapshot.ts : null,
      botName: snapshot.botName ?? null,
      chests: buildVaultChests(snapshot.chests),
    };
    vaultCache = { mtimeMs: stat.mtimeMs, result: cached };
  }

  const ageMs = cached.ts ? Date.now() - Date.parse(cached.ts) : null;
  return { ...cached, ageMs, staleMs: VAULT_STALE_MS };
}

// ---------------------------------------------------------------------------
// v3 data primitives (PANEL_V3_SPEC.md §1.3/1.4/1.8, G2/G4). readLedgerEntries/
// readDeathFiles/readFelRelation below remain UNWIRED — no route calls them
// and no client code renders them yet, waiting on the Economy graphs / Tribe
// Stat Wall sections. getMissionsForBot() (further down, mission history)
// IS wired — GET /api/missions, consumed by Mission Control's drilldown
// (PANEL_V3_SPEC.md §3.1). All of these share the same contract as
// getTodoBoard/getVault above: never fabricate, never guess, tolerate a
// missing file/directory as the normal "nothing recorded yet" state rather
// than an error.
// ---------------------------------------------------------------------------

// cave/ledger/<bot>.jsonl reader (PANEL_V3_SPEC.md §1.3). Mirrors
// cave/ledger.mjs's own loadAllEntries() exactly, including its "parsed" rule
// (typeof delta === 'number' — an unparsed DEPOT-ish line has raw+parsed:false
// and no clean delta to sum) so panel and CLI never quietly disagree on what
// counts. A missing cave/ledger/ directory (fresh checkout, or before the
// ledger primitive's first write) is the normal case, not an error.
const LEDGER_DIR = path.join(HERE, 'ledger');

export async function readLedgerEntries() {
  let files;
  try {
    files = (await fsp.readdir(LEDGER_DIR)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { entries: [], badLines: 0, files: [] };
  }
  const entries = [];
  let badLines = 0;
  for (const file of files) {
    let text;
    try {
      text = await fsp.readFile(path.join(LEDGER_DIR, file), 'utf8');
    } catch {
      continue; // unreadable file — skip, don't fail the whole read over one bad file
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        badLines++; // a corrupt JSONL line (partial write, disk issue) — counted, not fatal
      }
    }
  }
  return { entries, badLines, files };
}

// cave/deaths/<bot>.json reader (PANEL_V3_SPEC.md §1.4). One record per bot
// that has ever died; a bot with no file has never died (not an error, not
// "unknown"). A missing cave/deaths/ directory (no bot has died since the
// last relaunch — today's real state) returns an empty list, not an error.
const DEATHS_DIR = path.join(HERE, 'deaths');

export async function readDeathFiles() {
  let files;
  try {
    files = (await fsp.readdir(DEATHS_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return { records: [], files: [] };
  }
  const records = [];
  for (const file of files) {
    let raw;
    try {
      raw = await fsp.readFile(path.join(DEATHS_DIR, file), 'utf8');
    } catch {
      continue;
    }
    try {
      records.push(JSON.parse(raw));
    } catch {
      // corrupt file — skip, don't fail the whole read over one bad file
    }
  }
  return { records, files };
}

// cave/missions/<bot>.jsonl reader (PANEL_V3_SPEC.md §G2). The directory
// doesn't exist yet on this machine — G2 (runner.js's markTaskFinished hook)
// hasn't shipped — so this must be tolerant-if-missing exactly like the
// ledger reader above, and stays that way once the directory does appear.
// Same shape/rule as readLedgerEntries() by design: the two primitives are
// deliberately parallel (append-only JSONL, one file per bot).
const MISSIONS_DIR = path.join(HERE, 'missions');

export async function readMissionEntries() {
  let files;
  try {
    files = (await fsp.readdir(MISSIONS_DIR)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { entries: [], badLines: 0, files: [] };
  }
  const entries = [];
  let badLines = 0;
  for (const file of files) {
    let text;
    try {
      text = await fsp.readFile(path.join(MISSIONS_DIR, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        badLines++;
      }
    }
  }
  return { entries, badLines, files };
}

// Resolves a bot name/port query (same accepted shapes as doWake/doStop's
// resolveBot: case-insensitive name, or a port, with or without a leading
// ":") down to a roster bot NAME — the key cave/missions/<bot>.jsonl files
// are written under. Read-only, so unlike resolveBot it never needs to fall
// back to a wake/stop plan; a live-fleet-cache lookup still covers a named
// bot running on an off-roster port (CAVE_PANEL_PORTS test mode).
function resolveBotName(nameOrPort) {
  if (nameOrPort === undefined || nameOrPort === null) return null;
  const raw = String(nameOrPort).trim();
  if (!raw) return null;
  const byName = BOT_BY_NAME.get(raw.toLowerCase());
  if (byName) return byName.name;
  const asPort = Number(raw.replace(/^:/, ''));
  if (Number.isInteger(asPort)) {
    const byPort = BOT_BY_PORT.get(asPort);
    if (byPort) return byPort.name;
    const live = fleetCache.payload?.bots?.find((b) => b.port === asPort);
    if (live) return live.name;
  }
  return null;
}

// Mission Control drilldown (PANEL_V3_SPEC.md §3.1) — last N missions for ONE
// bot, newest first, fetched only when a driver actually opens that card's
// drilldown (not on the fast 3s poll — see panel-client.js). Reads the one
// file directly rather than routing through readMissionEntries()'s
// read-every-file-then-filter shape, since a drilldown only ever wants one
// bot's history and there is no reason to read the other seven files to get
// it. A missing file (G2 not shipped yet for THIS bot, or shipped but this
// bot has never had a task finish) is the honest "no mission history yet"
// state, not an error — same tolerant contract as every other v3 reader
// above.
const MISSION_HISTORY_CAP = 30;

export async function getMissionsForBot(nameOrPort) {
  const name = resolveBotName(nameOrPort);
  if (!name) {
    return { ok: false, missing: false, bot: null, error: `unknown bot "${nameOrPort}"`, entries: [] };
  }
  const file = path.join(MISSIONS_DIR, `${name}.jsonl`);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, missing: true, bot: name, entries: [] };
    return { ok: false, missing: false, bot: name, error: err?.message ?? String(err), entries: [] };
  }
  const parsed = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      badLines++; // corrupt JSONL line — counted, not fatal
    }
  }
  // Append-only file: later lines are newer. Reversing the parse order for
  // "newest first" rather than sorting on each entry's own `ts` means one
  // line with a missing/malformed timestamp can never jump the queue.
  const newestFirst = parsed.slice().reverse();
  return {
    ok: true,
    missing: false,
    bot: name,
    entries: newestFirst.slice(0, MISSION_HISTORY_CAP),
    total: parsed.length,
    badLines,
  };
}

// cave/fel-relation.json reader (PANEL_V3_SPEC.md §1.8/G4). Same tolerant
// shape as getVault(): ENOENT is the honest normal state for a hand-maintained
// file nobody's written yet (`missing: true`, not an error); any other read
// or parse failure IS worth surfacing. Returns the raw parsed object under
// `data` rather than reshaping it — the real file on disk today already
// carries more fields (`headline`, `detail`, `openItems`) than G4's minimal
// example, and this reader shouldn't have an opinion about that.
const FEL_RELATION_PATH = path.join(HERE, 'fel-relation.json');

export async function readFelRelation() {
  let raw;
  try {
    raw = await fsp.readFile(FEL_RELATION_PATH, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, missing: true };
    return { ok: false, missing: false, error: `fel-relation.json unreadable (${err?.code ?? err?.message ?? err})` };
  }
  try {
    return { ok: true, missing: false, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, missing: false, error: `fel-relation.json corrupt JSON: ${err?.message ?? err}` };
  }
}

// ---------------------------------------------------------------------------
// Write actions — the only two, both narrow. force:false is hard-coded and
// un-overridable (see panel.mjs's SAFETY CONTRACT header) — there is no code
// path here that can send force:true.
// ---------------------------------------------------------------------------

function resolveBot(nameOrPort) {
  if (nameOrPort === undefined || nameOrPort === null) return null;
  const raw = String(nameOrPort).trim();
  if (!raw) return null;
  const byName = BOT_BY_NAME.get(raw.toLowerCase());
  if (byName && PORTS.includes(byName.port)) return byName;
  const asPort = Number(raw.replace(/^:/, ''));
  if (Number.isInteger(asPort) && PORTS.includes(asPort)) {
    return BOT_BY_PORT.get(asPort) ?? { name: `:${asPort}`, port: asPort, team: 'white', wake: FALLBACK_WAKE };
  }
  // Named bot that this panel instance isn't watching (e.g. a test runner whose
  // name only shows up in /status). Match it against the live fleet by name.
  const live = fleetCache.payload?.bots?.find((b) => b.name.toLowerCase() === raw.toLowerCase());
  if (live && PORTS.includes(live.port)) {
    return BOT_BY_PORT.get(live.port) ?? { name: live.name, port: live.port, team: live.team, wake: FALLBACK_WAKE };
  }
  return null;
}

export async function doWake(botArg) {
  const bot = resolveBot(botArg);
  if (!bot) return { status: 404, body: { ok: false, error: `unknown bot "${botArg}" (not on this panel's port list)` } };

  const plan = bot.wake ?? FALLBACK_WAKE;
  // force:false is built here, not copied from the plan and not read from the
  // request — there is no code path in this file that can send force:true.
  // source:'panel' tags the runner's own task/event log with who actually
  // pushed this (issue #6 arbitration forensics) — previously indistinguishable
  // from any other unidentified HTTP caller (runner.js defaults body.source
  // to 'http' when absent).
  const body = { ...plan.body, force: false, source: 'panel' };

  try {
    const { status, json } = await postJson(`http://127.0.0.1:${bot.port}${plan.ep}`, body);
    if (status === 409) {
      return {
        status: 200,
        body: {
          ok: false,
          busy: true,
          message: 'busy, not preempted',
          bot: bot.name,
          currentTask: json?.currentTask ?? null,
        },
      };
    }
    if (status !== 200) {
      return {
        status: 200,
        body: { ok: false, bot: bot.name, error: json?.error ?? `runner HTTP ${status}`, httpStatus: status },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        bot: bot.name,
        port: bot.port,
        pushed: { ep: plan.ep, body, say: plan.say },
        task: json?.task ?? null,
      },
    };
  } catch (err) {
    return { status: 200, body: { ok: false, bot: bot.name, error: err?.message ?? String(err) } };
  }
}

export async function doStop(botArg) {
  const bot = resolveBot(botArg);
  if (!bot) return { status: 404, body: { ok: false, error: `unknown bot "${botArg}" (not on this panel's port list)` } };
  try {
    const { status, json } = await postJson(`http://127.0.0.1:${bot.port}/stop`, {});
    if (status !== 200) {
      return { status: 200, body: { ok: false, bot: bot.name, error: json?.error ?? `runner HTTP ${status}`, httpStatus: status } };
    }
    return { status: 200, body: { ok: true, bot: bot.name, port: bot.port, task: json?.task ?? null } };
  } catch (err) {
    return { status: 200, body: { ok: false, bot: bot.name, error: err?.message ?? String(err) } };
  }
}
