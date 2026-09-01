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
// Docs: cave/PANEL.md
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const RUNNER_TIMEOUT_MS = 3000;
const FLEET_CACHE_MS = 2000;
// The panel polls the fleet on its own timer, whether or not a browser is
// attached. Movement deltas are only meaningful if the position ring has been
// filling all along, so the page must not be the thing that drives sampling —
// otherwise opening the tab shows dashes for the first minute. Request serving
// still goes through the FLEET_CACHE_MS cache; this just keeps it warm.
const SELF_POLL_MS = 5000;
const EVENTS_PER_BOT = 10;
const ALERT_LINES = 50;
const IRON_QUOTA = 360;

// Runner ports. Default is the production fleet 3201-3208; CAVE_PANEL_PORTS
// (comma-separated) overrides it so the write paths can be exercised against a
// throwaway test runner (e.g. CAVE_PANEL_PORTS=3209) without ever pointing at
// a production bot a driver owns.
const DEFAULT_PORTS = [3201, 3202, 3203, 3204, 3205, 3206, 3207, 3208];
const PORTS = parsePorts(process.env.CAVE_PANEL_PORTS) ?? DEFAULT_PORTS;

function parsePorts(raw) {
  if (!raw) return null;
  const ports = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return ports.length ? ports : null;
}

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
const TEAM_HEX = {
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

function invalidateFleet() {
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
// must not blank the history). See SELF_POLL_MS for how it stays warm.
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
    pos: null, health: null, food: null, inventory: [],
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

async function getFleet() {
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

async function readAlerts() {
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

function parseTodoMarkdown(text) {
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

async function getTodoBoard() {
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
// Write actions — the only two, both narrow.
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

async function doWake(botArg) {
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

async function doStop(botArg) {
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

  if (m === 'GET' && p === '/api/fleet') {
    return sendJson(res, 200, await getFleet());
  }

  if (m === 'GET' && p === '/api/alerts') {
    return sendJson(res, 200, await readAlerts());
  }

  if (m === 'GET' && p === '/api/todo') {
    return sendJson(res, 200, await getTodoBoard());
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
// The page — one self-contained document, no external resources.
// ---------------------------------------------------------------------------

function renderPage() {
  return `<!DOCTYPE html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet Panel</title>
<style>
  :root {
    --bg: #0d0f13;
    --panel: #151920;
    --panel-2: #1b2029;
    --line: #262d38;
    --text: #e4e8ef;
    --muted: #8a93a3;
    --dim: #5d6675;
    --amber: #f2b035;
    --red: #ff6b63;
    --green: #5fe36b;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  code, .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }

  header {
    position: sticky; top: 0; z-index: 10;
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px;
    padding: 14px 22px;
    background: rgba(13,15,19,.92);
    border-bottom: 1px solid var(--line);
    backdrop-filter: blur(8px);
  }
  .brand { font-size: 15px; font-weight: 650; letter-spacing: .14em; text-transform: uppercase; }
  .brand span { color: var(--dim); font-weight: 500; letter-spacing: .06em; text-transform: none; margin-left: 8px; font-size: 12px; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; align-items: center; }
  .stat {
    display: flex; align-items: baseline; gap: 7px;
    padding: 5px 11px; border: 1px solid var(--line); border-radius: 999px;
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
  .quota .track { width: 130px; height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
  .quota .fill { height: 100%; background: linear-gradient(90deg, #9aa4b2, #dfe6f0); transition: width .4s ease; }
  .tick { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); transition: background .3s; }
  .tick.live { background: var(--green); box-shadow: 0 0 8px rgba(95,227,107,.6); }

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
  .card.panic { border-left-width: 5px; border-color: rgba(255,107,99,.6); border-left-color: var(--red); box-shadow: 0 0 0 1px rgba(255,107,99,.25); }
  .task.panic { background: rgba(255,107,99,.12); }
  .task.panic .kind { color: var(--red); }

  .row1 { display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: none; }
  .dot.on { background: var(--green); box-shadow: 0 0 7px rgba(95,227,107,.55); }
  .dot.warn { background: var(--amber); box-shadow: 0 0 7px rgba(242,176,53,.5); }
  .dot.off { background: #4a5160; }
  .name { font-size: 15px; font-weight: 650; letter-spacing: .02em; }
  .port { font-size: 11px; color: var(--dim); }
  .age { margin-left: auto; font-size: 11px; color: var(--muted); white-space: nowrap; }

  .pos { margin-top: 5px; font-size: 11px; color: var(--muted); letter-spacing: .02em; }

  .delta { margin-top: 5px; display: flex; align-items: baseline; gap: 6px; font-size: 11px; }
  .dl { color: var(--dim); letter-spacing: .03em; }
  .dv { font-weight: 650; font-variant-numeric: tabular-nums; }
  .dsep { color: #333a45; }

  .vitals { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin-top: 10px; }
  .vital { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--muted); }
  .vital .lbl { width: 12px; flex: none; text-align: center; }
  .vital .track { flex: 1; height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
  .vital .fill { height: 100%; border-radius: 3px; transition: width .45s ease, background .3s; }
  .vital .num { width: 26px; flex: none; text-align: right; color: var(--text); font-size: 11px; }

  .task { margin-top: 11px; padding: 8px 10px; border-radius: 8px; background: var(--panel-2); }
  .task .head { display: flex; align-items: center; gap: 7px; font-size: 12px; }
  .task .kind { font-weight: 600; }
  .task .state { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .task .state.running { color: var(--green); border-color: rgba(95,227,107,.35); }
  .task .state.failed { color: var(--red); border-color: rgba(255,107,99,.4); }
  .task .src { margin-left: auto; font-size: 10px; color: var(--dim); white-space: nowrap; text-align: right; }
  .task .detail { margin-top: 4px; font-size: 11px; color: var(--muted); word-break: break-word; }

  .err-box { margin-top: 9px; padding: 7px 10px; border-radius: 8px; font-size: 11px; color: #ffb3ae; background: rgba(255,107,99,.09); border: 1px solid rgba(255,107,99,.3); word-break: break-word; }

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
  .ev-item .et { flex: none; font-variant-numeric: tabular-nums; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
  .ev-item .em { color: var(--muted); word-break: break-word; }
  .ev-item.warn .em { color: #ffb3ae; }
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
    padding: 2px 4px 2px 8px; border-radius: 999px;
    background: var(--panel-2); border: 1px solid var(--line);
    font-size: 10px; color: var(--muted); max-width: 100%;
  }
  .chip .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip .c { padding: 0 6px; border-radius: 999px; background: #2c3441; color: var(--text); font-size: 10px; font-weight: 600; }
  .inv-empty { margin-top: 10px; font-size: 11px; color: var(--dim); font-style: italic; }

  .acts { margin-top: 12px; display: flex; gap: 8px; align-items: center; }
  button {
    font: inherit; cursor: pointer; border-radius: 8px; transition: background .15s, border-color .15s, opacity .15s;
  }
  button:disabled { opacity: .45; cursor: default; }
  .wake {
    padding: 6px 15px; font-size: 12px; font-weight: 650; letter-spacing: .05em;
    color: #241a05; background: var(--amber); border: 1px solid var(--amber);
  }
  .wake:hover:not(:disabled) { background: #ffc453; }
  .stop {
    padding: 4px 11px; font-size: 11px; color: var(--muted);
    background: transparent; border: 1px solid var(--line);
  }
  .stop:hover:not(:disabled) { color: var(--red); border-color: rgba(255,107,99,.45); }
  .flash { font-size: 11px; color: var(--muted); }
  .flash.bad { color: var(--amber); }

  aside {
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 13px 15px; position: sticky; top: 74px; max-height: calc(100vh - 100px); display: flex; flex-direction: column;
  }
  aside h2 { margin: 0 0 3px; font-size: 12px; letter-spacing: .13em; text-transform: uppercase; color: var(--red); font-weight: 650; }
  aside .sub { font-size: 11px; color: var(--dim); margin-bottom: 9px; }
  #alerts { overflow-y: auto; display: flex; flex-direction: column; gap: 7px; }
  .alert { padding: 7px 9px; border-radius: 7px; background: rgba(255,107,99,.07); border-left: 2px solid rgba(255,107,99,.55); }
  .alert .t { font-size: 10px; color: var(--dim); }
  .alert .m { font-size: 11px; color: #ffc0bb; word-break: break-word; }
  .alert.bot { background: rgba(255,107,99,.12); border-left-color: var(--red); }
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
  .board-chip { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .board-status { font-size: 11px; color: var(--dim); text-align: right; word-break: break-word; }
  .board-empty { grid-column: 1 / -1; font-size: 11px; color: var(--dim); font-style: italic; }
  #bd-done { max-height: 0; opacity: 0; overflow: hidden; transition: max-height .22s ease, opacity .18s ease; }
  #bd-done.open { max-height: 320px; opacity: 1; overflow-y: auto; }
  @media (max-width: 720px) {
    .board-rows { grid-template-columns: auto 1fr; }
    .board-who, .board-status { grid-column: 1 / -1; }
  }

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

<footer>Read-mostly panel. WAKE pushes the bot's role-default task with <code>force:false</code> (never preempts a driver); STOP cancels the running task. Docs: <code>cave/PANEL.md</code></footer>

<script>
(function () {
  'use strict';
  var QUOTA = ${IRON_QUOTA};
  var grid = document.getElementById('grid');
  var cards = Object.create(null);
  var flashes = Object.create(null);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function setText(node, s) { if (node.textContent !== s) node.textContent = s; }
  function setCls(node, s) { if (node.className !== s) node.className = s; }

  function fmtPos(p) {
    if (!p) return 'position unknown';
    return 'xyz ' + Math.round(p.x) + ' ' + Math.round(p.y) + ' ' + Math.round(p.z);
  }
  function fmtDur(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    var h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }
  function taskAge(bot) {
    var t = bot.currentTask;
    if (!t) return '';
    var start = bot.taskStartedAt ? Date.parse(bot.taskStartedAt) : NaN;
    if (t.state === 'running') {
      if (!isFinite(start)) return 'running';
      return 'running ' + fmtDur(Date.now() - start);
    }
    if (t.finishedAt) {
      var fin = Date.parse(t.finishedAt);
      if (isFinite(fin)) return t.state + ' ' + fmtDur(Date.now() - fin) + ' ago';
    }
    return t.state;
  }
  // Shared by both HP and FD bars — same 0-20 scale, same thresholds. FD used
  // to render a constant blue-grey regardless of value, so a bot starving at
  // 2 food looked exactly like one sitting at a full 20: a real gap against
  // the green/amber/red mandate, not just a missed lick of paint.
  function healthColor(v) {
    if (v == null) return '#3a4150';
    if (v <= 6) return '#ff6b63';
    if (v <= 12) return '#f2b035';
    return '#5fe36b';
  }

  // Event feed (phase-2 item, PANEL.md) — /api/fleet already carries each
  // bot's last ~10 events, this just finally renders them. Kept as a small
  // per-card toggle rather than a fleet-wide stream: a merged feed would
  // compete with the Alerts column for the same "something's wrong" job,
  // where this is closer to "what has this bot actually been doing lately."
  var ALERT_EVENT_TYPES = { death: 1, error: 1, panic: 1, kicked: 1, disconnect: 1 };
  // Matches runner.js's RING RATE CAP rollup line verbatim
  // ("...suppressed N similar <type> event(s)") — detected by message shape
  // since the rollup keeps the original type, not a type of its own.
  // NOTE: doubled backslashes — this whole page is one outer template
  // literal (renderPage()'s return value), so a single \ here would be
  // consumed by THAT literal before the client ever sees the regex (same
  // reason the timestamp-trim regex near paintAlerts uses \\. \\d too).
  var SUPPRESSED_RE = /^\\.\\.\\.suppressed \\d+ similar/;
  function renderEvToggle(toggleEl, listEl, state) {
    var n = state.count || 0;
    setText(toggleEl, (state.expanded ? '▾' : '▸') + ' events' + (n ? ' (' + n + ')' : ''));
    setCls(listEl, 'ev-list' + (state.expanded ? ' open' : ''));
  }
  // Movement delta colouring. Red is the wedge flag — under half a block of
  // travel in the window means the bot is very likely stuck, which pairs with
  // the runner's own wedge watchdog.
  function deltaColor(v) {
    if (v == null) return '#5d6675';
    if (v > 5) return '#5fe36b';
    if (v >= 0.5) return '#f2b035';
    return '#ff6b63';
  }
  function setDelta(node, v) {
    setText(node, v == null ? '—' : v.toFixed(1));
    var col = deltaColor(v);
    if (node.dataset.col !== col) { node.style.color = col; node.dataset.col = col; }
  }

  function build(bot) {
    var c = el('div', 'card');
    var r1 = el('div', 'row1');
    var dot = el('span', 'dot');
    var name = el('span', 'name');
    var port = el('span', 'port');
    var age = el('span', 'age');
    r1.appendChild(dot); r1.appendChild(name); r1.appendChild(port); r1.appendChild(age);

    var pos = el('div', 'pos');

    var delta = el('div', 'delta');
    var d30v = el('span', 'dv');
    var d60v = el('span', 'dv');
    delta.appendChild(el('span', 'dl', 'Δ30s'));
    delta.appendChild(d30v);
    delta.appendChild(el('span', 'dsep', '|'));
    delta.appendChild(el('span', 'dl', 'Δ60s'));
    delta.appendChild(d60v);

    var vitals = el('div', 'vitals');
    function vital(label, color) {
      var v = el('div', 'vital');
      var l = el('span', 'lbl', label);
      var track = el('div', 'track');
      var fill = el('div', 'fill');
      track.appendChild(fill);
      var num = el('span', 'num');
      v.appendChild(l); v.appendChild(track); v.appendChild(num);
      vitals.appendChild(v);
      return { fill: fill, num: num, color: color };
    }
    var hp = vital('HP', healthColor);
    var fd = vital('FD', healthColor);

    var task = el('div', 'task');
    var thead = el('div', 'head');
    var tkind = el('span', 'kind');
    var tstate = el('span', 'state');
    var tsrc = el('span', 'src');
    thead.appendChild(tkind); thead.appendChild(tstate); thead.appendChild(tsrc);
    var tdetail = el('div', 'detail');
    task.appendChild(thead); task.appendChild(tdetail);

    var errBox = el('div', 'err-box');
    errBox.hidden = true;

    var meta = el('div', 'meta');
    var deaths = el('span');
    var lastDeath = el('span');
    var guard = el('span', 'guard');
    var engine = el('span');
    var evState = { expanded: false, count: 0 };
    var evToggle = el('span', 'ev-toggle');
    var evList = el('div', 'ev-list');
    evToggle.addEventListener('click', function () {
      evState.expanded = !evState.expanded;
      renderEvToggle(evToggle, evList, evState);
    });
    renderEvToggle(evToggle, evList, evState);
    meta.appendChild(deaths); meta.appendChild(lastDeath); meta.appendChild(guard);
    meta.appendChild(engine); meta.appendChild(evToggle);

    var inv = el('div', 'inv');
    var acts = el('div', 'acts');
    var wake = el('button', 'wake', 'WAKE');
    var stop = el('button', 'stop', 'stop');
    var flash = el('span', 'flash');
    acts.appendChild(wake); acts.appendChild(stop); acts.appendChild(flash);

    // Keyed by PORT, never by name: a runner that comes up after the card was
    // built renames it (":3209" -> "TestRock"), which would orphan a
    // name-keyed flash and strand the button's feedback. The port is the card
    // identity and never changes; the server resolves a port just as happily
    // as a name.
    var key = bot.port;
    wake.addEventListener('click', function () { act('/api/wake', key, wake, flash); });
    stop.addEventListener('click', function () { act('/api/stop', key, stop, flash); });

    c.appendChild(r1); c.appendChild(pos); c.appendChild(delta); c.appendChild(vitals);
    c.appendChild(task); c.appendChild(errBox); c.appendChild(meta);
    c.appendChild(inv); c.appendChild(evList); c.appendChild(acts);
    grid.appendChild(c);

    return { root: c, dot: dot, name: name, port: port, age: age, pos: pos,
      d30v: d30v, d60v: d60v,
      hp: hp, fd: fd, task: task, tkind: tkind, tstate: tstate, tsrc: tsrc, tdetail: tdetail,
      errBox: errBox, deaths: deaths, lastDeath: lastDeath, guard: guard, engine: engine,
      inv: inv, invSig: null,
      evToggle: evToggle, evList: evList, evState: evState, evSig: null,
      wake: wake, stop: stop, flash: flash };
  }

  function act(path, port, btn, flash) {
    btn.disabled = true;
    flash.className = 'flash';
    flash.textContent = 'sending...';
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bot: port })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.busy) { flash.className = 'flash bad'; flash.textContent = j.message || 'busy'; }
        else if (j.ok) { flash.className = 'flash'; flash.textContent = j.pushed ? ('pushed ' + j.pushed.ep) : 'stopped'; }
        else { flash.className = 'flash bad'; flash.textContent = j.error || 'failed'; }
      })
      .catch(function (e) { flash.className = 'flash bad'; flash.textContent = String(e.message || e); })
      .then(function () {
        btn.disabled = false;
        flashes[String(port)] = { text: flash.textContent, cls: flash.className, until: Date.now() + 8000 };
        refresh();
      });
  }

  function paint(bot) {
    var key = String(bot.port);
    var c = cards[key] || (cards[key] = build(bot));

    var idle = !bot.offline && bot.idle;
    // panic-response is the runner's own low-health flee/seal reflex taking
    // the wheel — rarest and most urgent state a card can be in, so it gets
    // its own flag on top of (not instead of) idle/err, and CSS gives it
    // priority for the border colour. Persists until the next task replaces
    // currentTask, same STATUS-HOLD rule lastError already follows.
    var isPanic = !!(bot.currentTask && bot.currentTask.kind === 'panic-response');
    var cls = 'card' + (bot.offline ? ' offline' : '') + (idle ? ' idle' : '') + (bot.lastError ? ' err' : '') + (isPanic ? ' panic' : '');
    setCls(c.root, cls);

    // Three real states, three colours: offline (runner unreachable, grey),
    // connected (bot live in-world, green), and the gap between them — runner
    // process up but the bot entity isn't (mid-reconnect) — which used to
    // share "off" with true offline and hide a real distinction the pos line
    // already spelled out in words. Amber matches that in-between meaning
    // everywhere else on the card.
    setCls(c.dot, 'dot ' + (bot.offline ? 'off' : (bot.connected ? 'on' : 'warn')));
    setText(c.name, bot.name);
    if (c.name.style.color !== bot.color) c.name.style.color = bot.color;
    setText(c.port, ':' + bot.port);
    setText(c.age, bot.offline ? (bot.offlineReason || 'offline') : taskAge(bot));

    setText(c.pos, bot.offline ? 'runner not answering' : (bot.connected ? fmtPos(bot.pos) : 'runner up, bot disconnected'));

    setDelta(c.d30v, bot.delta30);
    setDelta(c.d60v, bot.delta60);

    function vit(v, val) {
      var pct = val == null ? 0 : Math.max(0, Math.min(100, (val / 20) * 100));
      var w = pct + '%';
      if (v.fill.style.width !== w) v.fill.style.width = w;
      var col = v.color(val);
      if (v.fill.dataset.col !== col) { v.fill.style.background = col; v.fill.dataset.col = col; }
      setText(v.num, val == null ? '-' : String(Math.round(val)));
    }
    vit(c.hp, bot.health);
    vit(c.fd, bot.food);

    var t = bot.currentTask;
    setCls(c.task, 'task' + (isPanic ? ' panic' : ''));
    if (t) {
      c.task.hidden = false;
      setText(c.tkind, t.kind);
      setText(c.tstate, t.state || '');
      setCls(c.tstate, 'state ' + (t.state || ''));
      // Origin tag — who commanded this task (issue #6 arbitration: was this
      // the panel's own WAKE, the runner's idle-guard filler, the panic
      // reflex, or a driver that self-identified). "http" is the sanitizer's
      // fallback for a plain caller that didn't say who it was — the common
      // case today since most drivers don't tag themselves yet — so it's
      // deliberately not shown: a chip that reads the same thing on every
      // card forever is noise, not information.
      var src = t.source;
      c.tsrc.hidden = !src || src === 'http';
      if (!c.tsrc.hidden) setText(c.tsrc, 'via ' + src);
      var det = t.detail || (t.result && t.result.error) || '';
      setText(c.tdetail, det);
      c.tdetail.hidden = !det;
    } else {
      c.task.hidden = false;
      setText(c.tkind, bot.offline ? 'no data' : 'no task');
      setText(c.tstate, '');
      setCls(c.tstate, 'state');
      c.tsrc.hidden = true;
      setText(c.tdetail, bot.offline ? '' : 'runner idle since start');
      c.tdetail.hidden = bot.offline;
    }

    if (bot.lastError) {
      c.errBox.hidden = false;
      setText(c.errBox, bot.lastError);
    } else {
      c.errBox.hidden = true;
    }

    setText(c.deaths, 'deaths ' + (bot.deathCount == null ? '-' : bot.deathCount));

    if (bot.lastDeath && bot.lastDeath.ts) {
      var diedAgo = fmtDur(Date.now() - Date.parse(bot.lastDeath.ts));
      setText(c.lastDeath, diedAgo ? '(' + diedAgo + ' ago)' : '');
      c.lastDeath.hidden = !diedAgo;
    } else {
      c.lastDeath.hidden = true;
    }

    if (bot.offline || bot.idleGuard == null) {
      c.guard.hidden = true;
    } else {
      c.guard.hidden = false;
      // Guard OFF is the driver's own doing while it actively drives (issue
      // #6) — not a fault — but it is the one state worth a glance, since a
      // bot that reads idle AND guard-off for a while means the driver went
      // quiet without re-arming it. Guard ON is the boring default: no colour.
      setText(c.guard, bot.idleGuard ? 'guard on' : 'guard off');
      setCls(c.guard, 'guard' + (bot.idleGuard ? '' : ' warn'));
    }

    setText(c.engine, bot.engine ? 'engine ' + bot.engine : '');

    // Inventory: top 10 stacks by count, rebuilt only when it actually changed.
    var items = (bot.inventory || []).slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 10);
    var sig = items.map(function (i) { return i.name + ':' + i.count; }).join('|');
    if (sig !== c.invSig) {
      c.invSig = sig;
      c.inv.textContent = '';
      if (!items.length) {
        setCls(c.inv, 'inv-empty');
        c.inv.textContent = bot.offline ? '' : 'empty';
      } else {
        setCls(c.inv, 'inv');
        items.forEach(function (i) {
          var chip = el('span', 'chip');
          chip.appendChild(el('span', 'n', i.name));
          chip.appendChild(el('span', 'c', String(i.count)));
          c.inv.appendChild(chip);
        });
      }
    }

    // Event log toggle + list. bot.events is already the last ~10 entries
    // (server-side ring, see EVENTS_PER_BOT) — the list itself is only
    // rebuilt when the actual set of events changed (by seq), same signature
    // pattern as inventory above, so an open/scrolled list doesn't jump or
    // flicker on every 3s poll that brought nothing new. Relative timestamps
    // ARE refreshed every poll regardless (below), since "12s ago" left
    // stale for minutes on an unchanged list would be a quiet honesty bug —
    // same reasoning as the movement-delta and task-age clocks elsewhere on
    // this card.
    var events = bot.events || [];
    c.evState.count = events.length;
    renderEvToggle(c.evToggle, c.evList, c.evState);
    var evSig = events.map(function (e) { return e.seq; }).join('|');
    if (evSig !== c.evSig) {
      c.evSig = evSig;
      c.evList.textContent = '';
      if (!events.length) {
        c.evList.appendChild(el('div', 'ev-empty', 'no events yet'));
      } else {
        events.slice().reverse().forEach(function (e) {
          var cls = 'ev-item' + (ALERT_EVENT_TYPES[e.type] ? ' warn' : '') + (SUPPRESSED_RE.test(e.msg) ? ' suppressed' : '');
          var row = el('div', cls);
          var et = el('span', 'et');
          et.dataset.ts = e.ts;
          var em = el('span', 'em', e.msg);
          row.appendChild(et); row.appendChild(em);
          c.evList.appendChild(row);
        });
      }
    }
    var etNodes = c.evList.querySelectorAll('.et');
    for (var ei = 0; ei < etNodes.length; ei++) {
      var ts = etNodes[ei].dataset.ts;
      if (ts) setText(etNodes[ei], fmtDur(Date.now() - Date.parse(ts)) + ' ago');
    }

    var showWake = !bot.offline && idle;
    var showStop = !bot.offline && !idle;
    c.wake.hidden = !showWake;
    c.stop.hidden = !showStop;

    var f = flashes[key];
    if (f && f.until > Date.now()) {
      c.flash.textContent = f.text;
      c.flash.className = f.cls;
    } else if (c.flash.textContent) {
      c.flash.textContent = '';
      c.flash.className = 'flash';
    }
  }

  var alertsBox = document.getElementById('alerts');
  var alertSig = '';
  function paintAlerts(logAlerts, bots) {
    var list = [];
    bots.forEach(function (b) {
      if (b.lastError) list.push({ src: b.name, msg: b.lastError, ts: null, bot: true });
    });
    logAlerts.forEach(function (a) { list.push({ src: 'overseer', msg: a.msg, ts: a.ts, bot: false }); });

    var sig = list.map(function (a) { return a.src + a.ts + a.msg; }).join('|');
    if (sig === alertSig) return;
    alertSig = sig;
    alertsBox.textContent = '';
    if (!list.length) {
      alertsBox.appendChild(el('div', 'none', 'all quiet'));
      return;
    }
    list.forEach(function (a) {
      var d = el('div', 'alert' + (a.bot ? ' bot' : ''));
      var head = el('div', 't');
      head.textContent = (a.ts ? a.ts.replace('T', ' ').replace(/\\.\\d+Z?$/, '') : 'now') + '  ';
      var src = el('span', 'src', a.src);
      head.appendChild(src);
      d.appendChild(head);
      d.appendChild(el('div', 'm', a.msg));
      alertsBox.appendChild(d);
    });
  }

  // Tribe board (round 5) — /api/todo already grouped+bucketed everything
  // server-side; this just paints it. Whole-payload signature gate (same
  // idea as invSig/evSig on the cards) since TODO.md changes rarely and a
  // full teardown/rebuild on every 3s poll would fight the DONE section's
  // open/closed state and any text the operator is mid-selecting.
  var boardSig = '';
  var boardDoneOpen = false;
  var boardDoneToggle = document.getElementById('bd-done-toggle');
  var boardDoneArrow = document.getElementById('bd-done-arrow');
  var boardDoneRows = document.getElementById('bd-done');
  boardDoneToggle.addEventListener('click', function () {
    boardDoneOpen = !boardDoneOpen;
    setCls(boardDoneRows, 'board-rows' + (boardDoneOpen ? ' open' : ''));
    setText(boardDoneArrow, (boardDoneOpen ? '▾' : '▸') + ' DONE');
  });

  function renderBoardRows(container, rows, emptyMsg) {
    container.textContent = '';
    if (!rows.length) {
      container.appendChild(el('div', 'board-empty', emptyMsg));
      return;
    }
    rows.forEach(function (r) {
      var row = el('div', 'board-row');
      row.appendChild(el('span', 'board-lane', r.lane || '—'));
      row.appendChild(el('span', 'board-task', r.task));
      var who = el('span', 'board-who');
      (r.who || []).forEach(function (w) {
        var chip = el('span', 'board-chip', w.name);
        if (w.color) { chip.style.color = w.color; chip.style.borderColor = w.color; }
        who.appendChild(chip);
      });
      row.appendChild(who);
      row.appendChild(el('span', 'board-status', r.detail || ''));
      container.appendChild(row);
    });
  }

  function paintBoard(data) {
    var sig = JSON.stringify(data);
    if (sig === boardSig) return;
    boardSig = sig;

    var sub = document.getElementById('board-sub');
    var doing = (data && data.doing) || [];
    var todo = (data && data.todo) || [];
    var done = (data && data.done) || [];

    if (data && data.ok === false) {
      setText(sub, 'board unavailable' + (data.error ? ' (' + data.error + ')' : ''));
    } else {
      var extra = data && data.skipped ? ' — ' + data.skipped + ' row' + (data.skipped === 1 ? '' : 's') + ' skipped (malformed)' : '';
      setText(sub, 'cave/TODO.md' + extra);
    }

    setText(document.getElementById('bd-doing-n'), String(doing.length));
    setText(document.getElementById('bd-todo-n'), String(todo.length));
    setText(document.getElementById('bd-done-n'), String(done.length));
    renderBoardRows(document.getElementById('bd-doing'), doing, 'nothing in flight');
    renderBoardRows(document.getElementById('bd-todo'), todo, 'queue empty');
    renderBoardRows(boardDoneRows, done, 'none pruned yet');
  }

  var tick = document.getElementById('tick');
  var lastBots = [];

  function refresh() {
    return Promise.all([
      fetch('/api/fleet').then(function (r) { return r.json(); }),
      fetch('/api/alerts').then(function (r) { return r.json(); }).catch(function () { return { alerts: [] }; }),
      fetch('/api/todo').then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: 'unreachable', doing: [], todo: [], done: [] }; })
    ]).then(function (out) {
      var fleet = out[0], al = out[1], td = out[2];
      lastBots = fleet.bots || [];
      lastBots.forEach(paint);

      var s = fleet.summary || {};
      setText(document.getElementById('s-online'), (s.online || 0) + '/' + (s.total || 0));
      setText(document.getElementById('s-idle'), String(s.idle || 0));
      setText(document.getElementById('s-iron'), String(s.iron_ingot || 0));
      var pct = Math.max(0, Math.min(100, ((s.iron_ingot || 0) / QUOTA) * 100));
      document.getElementById('s-iron-bar').style.width = pct + '%';
      setText(document.getElementById('s-when'), new Date().toLocaleTimeString());
      if (al.file) setText(document.getElementById('alert-src'), al.file.split(/[\\\\/]/).slice(-2).join('/') + ' + live bot errors');
      paintAlerts(al.alerts || [], lastBots);
      paintBoard(td);

      tick.classList.add('live');
      setTimeout(function () { tick.classList.remove('live'); }, 450);
    }).catch(function () {
      setText(document.getElementById('s-when'), 'panel unreachable');
    });
  }

  // Age labels tick locally between polls so "running 1m 4s" keeps counting.
  setInterval(function () {
    lastBots.forEach(function (b) {
      var c = cards[String(b.port)];
      if (c && !b.offline) setText(c.age, taskAge(b));
    });
  }, 1000);

  refresh();
  setInterval(refresh, 3000);
})();
</script>
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
