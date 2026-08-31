// cave/runner.js — one process per cavecrew bot.
//
// Usage:
//   node cave/runner.js --name <Name> --port <320x> [--host localhost --mcport 25565]
//
// Starts an HTTP control API on 127.0.0.1:<port> immediately (it does not
// wait on the Minecraft connection), then connects to Minecraft in the
// background with auto-reconnect. See cave/DRIVER_GUIDE.md for the full API
// reference and cave/CIV.md for the port registry.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import toolPkg from 'mineflayer-tool';
import collectBlockPkg from 'mineflayer-collectblock';
import minecraftData from 'minecraft-data';
// Plain CJS optional plugins — safe to import unconditionally, only the
// *load into the bot* is try/catch guarded (see loadOptionalPlugins below).
// mineflayer-auto-eat is native ESM and is dynamic-imported there instead,
// so a hard failure in it can't blow up module evaluation for this file.
import armorManagerPlugin from 'mineflayer-armor-manager';
import pvpPkg from 'mineflayer-pvp';

import * as skills from './skills.js';
import * as movement from './movement.js';

const { createBot } = mineflayer;
const { goals } = pathfinderPkg;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { host: 'localhost', mcport: 25565, engine: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--mcport') out.mcport = Number(argv[++i]);
    else if (a === '--engine') out.engine = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.name || !args.port || Number.isNaN(args.port)) {
  console.error(
    'usage: node cave/runner.js --name <Name> --port <320x> [--host localhost --mcport 25565] [--engine auto|ash|pf]'
  );
  process.exit(1);
}
if (!['auto', 'ash', 'pf'].includes(args.engine)) {
  console.error(`usage: --engine must be one of auto|ash|pf (got "${args.engine}")`);
  process.exit(1);
}
const { name, port, host, mcport, engine: defaultEngine } = args;

// ---------------------------------------------------------------------------
// directories + logging (set up before anything else can throw)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CAVE_DIR = __dirname;
const LOG_DIR = path.join(CAVE_DIR, 'logs');
const PID_DIR = path.join(CAVE_DIR, 'pids');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(PID_DIR, { recursive: true });

const logFilePath = path.join(LOG_DIR, `${name}.log`);
const pidFilePath = path.join(PID_DIR, `${name}.json`);

function logLine(level, msg) {
  const line = `[${new Date().toISOString()}] ${String(level).toUpperCase()} ${msg}`;
  try {
    fs.appendFileSync(logFilePath, line + '\n');
  } catch {
    // best effort — never let logging crash the process
  }
}

process.on('uncaughtException', (err) => {
  logLine('error', `uncaughtException: ${err?.stack ?? err}`);
});
process.on('unhandledRejection', (reason) => {
  logLine('error', `unhandledRejection: ${reason?.stack ?? reason}`);
});

logLine('info', `runner starting: name=${name} port=${port} host=${host} mcport=${mcport} pid=${process.pid}`);

// ---------------------------------------------------------------------------
// pid file
// ---------------------------------------------------------------------------

function writePidFile() {
  const record = { pid: process.pid, port, name, startedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(pidFilePath, JSON.stringify(record, null, 2));
  } catch (err) {
    logLine('error', `failed to write pid file: ${err.message}`);
  }
}

function removePidFile() {
  try {
    fs.unlinkSync(pidFilePath);
  } catch {
    // already gone, fine
  }
}

writePidFile();
process.on('exit', removePidFile);

function shutdown(signal) {
  logLine('info', `received ${signal}, shutting down`);
  try {
    server.close();
  } catch {
    // ignore
  }
  try {
    bot?.quit?.();
  } catch {
    // ignore
  }
  removePidFile();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// runtime state, events ring buffer, task bookkeeping
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const state = {
  connected: false,
  lastError: null,
  currentTask: null,
  deathCount: 0,
  lastDeath: null, // { pos: {x,y,z}|null, ts }
};

// ---------------------------------------------------------------------------
// poisoned targets — a position a task's bot died going after gets flagged
// here (with a timestamp) so future skill runs can steer clear of it. Set by
// the death handler below, read via ctx.isPoisoned() (see makeCtx). Entries
// expire on their own after POISON_TTL_MS; never retried automatically.
// ---------------------------------------------------------------------------

const POISON_TTL_MS = 15 * 60 * 1000;
const poisonedTargets = new Map(); // key "x,y,z" (floored) -> { pos, ts, expiresAt }

function poisonKey(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function poisonTarget(pos) {
  if (!pos) return;
  const key = poisonKey(pos);
  const now = Date.now();
  poisonedTargets.set(key, { pos: { x: pos.x, y: pos.y, z: pos.z }, ts: now, expiresAt: now + POISON_TTL_MS });
}

function purgeExpiredPoison() {
  const now = Date.now();
  for (const [key, entry] of poisonedTargets) {
    if (entry.expiresAt <= now) poisonedTargets.delete(key);
  }
}

function isPoisonedTarget(pos) {
  if (!pos) return false;
  purgeExpiredPoison();
  return poisonedTargets.has(poisonKey(pos));
}

function poisonedTargetsCount() {
  purgeExpiredPoison();
  return poisonedTargets.size;
}

const EVENTS_MAX = 500;
const eventsBuf = [];
let eventSeq = 0;
function pushEvent(type, msg) {
  eventSeq++;
  eventsBuf.push({ seq: eventSeq, ts: new Date().toISOString(), type, msg: String(msg) });
  if (eventsBuf.length > EVENTS_MAX) eventsBuf.shift();
}

let taskCounter = 0;
function newTask(kind) {
  return { id: `task-${++taskCounter}`, kind, state: 'running', detail: null, result: null };
}
function taskToJSON(t) {
  if (!t) return null;
  return { id: t.id, kind: t.kind, state: t.state, detail: t.detail, result: t.result };
}

function makeCtx(task) {
  // Captured once, at task-start — every movement/task promise spawned from
  // this ctx "carries" this generation. `generation` itself (module-level,
  // bumped once per connect() call — see connect() below) is read live
  // inside isStaleGeneration(), so a reconnect that happens WHILE this task
  // is still running is detected the instant something next polls it.
  const startGen = generation;
  return {
    log: (level, msg) => {
      logLine(level, msg);
      if (level === 'warn' || level === 'error') pushEvent('quirk', msg);
    },
    setDetail: (detail) => {
      task.detail = detail;
    },
    isCancelled: () => task.state !== 'running',
    generation: startGen,
    isStaleGeneration: () => generation !== startGen,
    // Skills (out of this file's scope) call this to register "where I'm
    // headed right now" so that if the bot dies mid-task, that spot gets
    // poisoned (see the death handler below). Optional — a task that never
    // calls it just has nothing to poison on death.
    setTargetPos: (pos) => {
      task.targetPos = pos ? { x: pos.x, y: pos.y, z: pos.z } : null;
    },
    isPoisoned: (pos) => isPoisonedTarget(pos),
    get mcData() {
      return mcData;
    },
  };
}

// Instantly fails the active task (state=failed, not cancelled) with the
// given reason — used by the death/disconnect handlers below, which need the
// task to stop being "running" synchronously, before anything awaits.
// Distinct from cancelCurrentTask(): that one is for a *requested* stop
// (/stop, superseded-by-force) and marks the task done/cancelled; this one is
// for the bot no longer being in a state where the task could ever succeed.
function failActiveTask(errMsg) {
  const task = state.currentTask;
  if (task && task.state === 'running') {
    task.state = 'failed';
    task.result = { error: errMsg };
    state.lastError = errMsg;
    logLine('error', `task ${task.id} (${task.kind}) failed: ${errMsg}`);
    pushEvent('task', `task ${task.id} (${task.kind}) failed: ${errMsg}`);
  }
  try {
    // Same cancel path cancelCurrentTask uses: setGoal(null) always, plus
    // bot.ashfinder.stop() when ash was the engine actually in flight. `bot`
    // here is still the OLD instance at the moment end/kicked/death fires
    // (connect() only reassigns it later, from scheduleReconnect's timer).
    movement.cancelMovement(bot);
  } catch {
    // ignore
  }
  try {
    bot?.collectBlock?.cancelTask?.().catch(() => {});
  } catch {
    // ignore
  }
  return task;
}

async function cancelCurrentTask(reason) {
  const task = state.currentTask;
  // Mark the task cancelled FIRST (synchronously) so ctx.isCancelled() flips
  // before we await anything — otherwise a concurrent startTask can slip in
  // during the awaits below and end up with two tasks running at once.
  if (task && task.state === 'running') {
    task.state = 'done';
    task.detail = reason;
    task.result = { cancelled: true, reason };
    logLine('info', `task ${task.id} (${task.kind}) cancelled: ${reason}`);
    pushEvent('task', `task ${task.id} (${task.kind}) cancelled: ${reason}`);
  }
  try {
    // Delegates to cave/movement.js: setGoal(null) for pathfinder always,
    // plus bot.ashfinder.stop() when ashfinder was the engine actually
    // in flight — never bot.pathfinder.stop() (see skills.js/movement.js
    // header comments for why).
    movement.cancelMovement(bot);
  } catch {
    // ignore
  }
  try {
    if (bot?.collectBlock) await bot.collectBlock.cancelTask();
  } catch {
    // ignore
  }
  return task;
}

async function startTask(kind, fn, { force = false } = {}) {
  if (state.currentTask && state.currentTask.state === 'running') {
    if (!force) {
      const err = new Error('busy');
      err.busy = true;
      throw err;
    }
    await cancelCurrentTask(`superseded by new ${kind} task (force)`);
    // Re-check after the await: another request may have claimed the mutex
    // while we were cancelling. Exactly one caller may install a task.
    if (state.currentTask && state.currentTask.state === 'running') {
      const err = new Error('busy');
      err.busy = true;
      throw err;
    }
  }

  const task = newTask(kind);
  state.currentTask = task;
  logLine('info', `task ${task.id} (${kind}) started`);
  pushEvent('task', `task ${task.id} (${kind}) started`);
  const ctx = makeCtx(task);

  // Run in the background — the caller gets an immediate ack and polls /status.
  (async () => {
    try {
      const result = await fn(task, ctx);
      if (task.state === 'running') {
        task.state = 'done';
        task.result = result ?? null;
        logLine('info', `task ${task.id} (${kind}) done`);
        pushEvent('task', `task ${task.id} (${kind}) done`);
      }
    } catch (err) {
      if (task.state === 'running') {
        const msg = err?.message ?? String(err);
        task.state = 'failed';
        task.result = { error: msg };
        state.lastError = msg;
        logLine('error', `task ${task.id} (${kind}) failed: ${msg}`);
        pushEvent('task', `task ${task.id} (${kind}) failed: ${msg}`);
      }
    }
  })();

  return task;
}

function requireBot() {
  if (!bot || !bot.entity) throw new Error('bot is not connected/spawned yet');
  return bot;
}

// ---------------------------------------------------------------------------
// mineflayer bot lifecycle
// ---------------------------------------------------------------------------

let bot = null;
let mcData = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let relogTimer = null;
let manualRelog = false;
let lastHealth = null;
// Bumped once per connect() attempt (success or failure). ctx captures this
// at task-start (see makeCtx) so any promise a task is awaiting can tell,
// live, whether the bot it was talking to has since been replaced.
let generation = 0;

const pluginStatus = { autoEat: false, armorManager: false, pvp: false };

function tryLoadOptional(b, label, fn) {
  try {
    fn();
    logLine('info', `optional plugin loaded: ${label}`);
    return true;
  } catch (err) {
    logLine('warn', `optional plugin skipped (${label}): ${err?.message ?? err}`);
    return false;
  }
}

async function loadOptionalPlugins(b) {
  pluginStatus.autoEat = await tryLoadOptionalAsync(b, 'mineflayer-auto-eat', async () => {
    const mod = await import('mineflayer-auto-eat');
    b.loadPlugin(mod.loader);
  });
  pluginStatus.armorManager = tryLoadOptional(b, 'mineflayer-armor-manager', () => {
    b.loadPlugin(armorManagerPlugin);
  });
  pluginStatus.pvp = tryLoadOptional(b, 'mineflayer-pvp', () => {
    b.loadPlugin(pvpPkg.plugin);
  });
}

async function tryLoadOptionalAsync(b, label, fn) {
  try {
    await fn();
    logLine('info', `optional plugin loaded: ${label}`);
    return true;
  } catch (err) {
    logLine('warn', `optional plugin skipped (${label}): ${err?.message ?? err}`);
    return false;
  }
}

function wireBot(b) {
  b.loadPlugin(pathfinderPkg.pathfinder);
  b.loadPlugin(toolPkg.plugin);
  b.loadPlugin(collectBlockPkg.plugin);
  loadOptionalPlugins(b).catch((err) => logLine('error', `loadOptionalPlugins failed: ${err?.stack ?? err}`));
  // Synchronous, and always runs after movement.resolveAshfinder() has
  // already finished (see the connect() call site below) — ashfinder's own
  // internal spawn handler (which builds its real pathExecutor) must be
  // registered before b.once('spawn', ...) below fires, or bot.ashfinder
  // ends up looking loaded while silently not working. Guarded internally:
  // if the module never resolved (package not installed, or resolution
  // failed), this is a no-op and the bot runs pathfinder-only.
  movement.loadAshfinderIntoBot(b, (lvl, msg) => logLine(lvl, msg));

  b.once('spawn', () => {
    state.connected = true;
    reconnectAttempt = 0;
    try {
      mcData = minecraftData(b.version);
    } catch (err) {
      logLine('warn', `minecraft-data lookup failed for version ${b.version}: ${err.message}`);
    }
    logLine('info', `spawned as ${name} (mc version ${b.version})`);
    pushEvent('connect', `${name} spawned`);
    // Defensive belt-and-suspenders on every (re)connect: clear any movement
    // engine state that could otherwise carry over from a previous
    // connection's plugin internals. Cheap, idempotent, never throws — see
    // movement.js file-header gotcha #2 for why a stray in-flight ashfinder
    // path needs an explicit stop(), not just being left alone.
    try {
      b.ashfinder?.stop?.();
    } catch {
      // ignore
    }
    try {
      b.pathfinder?.setGoal?.(null);
    } catch {
      // ignore
    }
  });

  b.on('error', (err) => {
    if (b !== bot) {
      logLine('info', `ignoring 'error' from stale bot instance: ${err?.message ?? err}`);
      return;
    }
    const msg = err?.message ?? String(err);
    logLine('error', `bot error: ${err?.stack ?? err}`);
    state.lastError = msg;
    pushEvent('error', msg);
    // Some failure modes (e.g. connection refused before spawn) only ever
    // emit 'error', never 'end' — without this, reconnect backoff never
    // gets armed and the bot stays offline forever (the Zug case).
    // scheduleReconnect() is idempotent (guarded by reconnectTimer) so this
    // never double-schedules alongside the 'end' handler below.
    if (!state.connected) {
      state.connected = false;
      if (!manualRelog) scheduleReconnect();
    }
  });

  b.on('end', (reason) => {
    // Stale-bot guard: if a relog/reconnect already swapped in a new bot
    // object, this 'end' belongs to the old zombie. Reacting to it would
    // clobber state.connected and schedule a SECOND connect — two bots with
    // the same name. Ignore it.
    if (b !== bot) {
      logLine('info', `ignoring 'end' from stale bot instance: ${reason}`);
      return;
    }
    state.connected = false;
    logLine('warn', `disconnected (end): ${reason}`);
    pushEvent('disconnect', `end: ${reason}`);
    failActiveTask('disconnected');
    if (!manualRelog) scheduleReconnect();
  });

  b.on('kicked', (reason) => {
    if (b !== bot) return;
    const msg = typeof reason === 'string' ? reason : JSON.stringify(reason);
    logLine('warn', `kicked: ${msg}`);
    pushEvent('kicked', msg);
    // 'end' normally follows shortly and would catch this too, but fail the
    // task right here — no reason to wait for the socket-close event when we
    // already know the connection is done.
    failActiveTask('disconnected');
  });

  b.on('health', () => {
    if (lastHealth !== null && b.health < lastHealth) {
      pushEvent('health', `health dropped to ${b.health} (food=${b.food})`);
    }
    lastHealth = b.health;
  });

  b.on('death', () => {
    if (b !== bot) return;
    const pos = b.entity ? { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z } : null;
    const posStr = pos ? `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}` : 'unknown';
    logLine('warn', `died at ${posStr}`);
    pushEvent('death', `${name} died at ${posStr}`);
    state.deathCount++;
    state.lastDeath = { pos, ts: new Date().toISOString() };
    // Grab the dying task's target BEFORE failing it (failActiveTask doesn't
    // touch task.targetPos, but read it first for clarity/safety) — that's
    // the spot that got the bot killed, so future skill runs should steer
    // clear of it. No automatic retry, ever.
    const dyingTask = state.currentTask;
    const targetPos = dyingTask && dyingTask.state === 'running' ? dyingTask.targetPos : null;
    failActiveTask(`died: ${posStr}`);
    if (targetPos) {
      poisonTarget(targetPos);
      logLine('info', `poisoned target ${poisonKey(targetPos)} after death`);
      pushEvent('quirk', `poisoned target ${poisonKey(targetPos)} after death`);
    }
  });

  b.on('chat', (username, message) => {
    if (username === b.username) return;
    pushEvent('chat', `${username}: ${message}`);
  });
}

function connect() {
  logLine('info', `connecting to ${host}:${mcport} as ${name}`);
  // Bump BEFORE the attempt, even though it might fail synchronously below —
  // this is "a (re)connect happened", and any task/promise still holding an
  // older generation should already be considering itself stale.
  generation++;
  try {
    bot = createBot({
      host,
      port: mcport,
      username: name,
      auth: 'offline',
      disableChatSigning: true,
    });
    wireBot(bot);
  } catch (err) {
    // Root cause of the Zug bug: reconnection was entirely event-driven (via
    // bot.on('end')/('error')). If createBot()/wireBot() itself threw
    // synchronously (bad plugin load, etc.), no bot object ever got far
    // enough to emit those events, so nothing ever called scheduleReconnect()
    // again — connected stayed false forever with backoff never re-armed.
    // Catch it here and re-arm explicitly so a bad attempt always leads to
    // another attempt.
    logLine('error', `connect() failed synchronously: ${err?.stack ?? err}`);
    state.connected = false;
    state.lastError = err?.message ?? String(err);
    pushEvent('error', `connect failed: ${err?.message ?? err}`);
    if (!manualRelog) scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delays = [5000, 10000, 20000];
  // Cap at 60s regardless of how large reconnectAttempt has grown; reset to 0
  // happens on every successful spawn (see b.once('spawn', ...) above).
  const delay = reconnectAttempt < delays.length ? delays[reconnectAttempt] : 60000;
  reconnectAttempt++;
  logLine('info', `reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Kick off the Minecraft connection — this does NOT block the HTTP server
// below from binding and answering requests immediately (server.listen() is
// still a synchronous call further down this same module, unaffected by the
// promise chain below). The one thing that DOES wait is connect() itself:
// movement.resolveAshfinder() must finish (successfully or not) before the
// first wireBot() runs, so the ashfinder plugin's own spawn handler always
// gets registered before mineflayer's spawn fires — see movement.js and
// wireBot() above. Every reconnect after this first one hits the cached
// result instantly, so this only delays the very first connect, by however
// long a local module resolution takes (milliseconds).
movement
  .resolveAshfinder((lvl, msg) => logLine(lvl, msg))
  .catch((err) => logLine('error', `movement.resolveAshfinder failed: ${err?.stack ?? err}`))
  .finally(() => connect());

// ---------------------------------------------------------------------------
// task-specific helpers not delegated to skills.js
// ---------------------------------------------------------------------------

async function followPlayer(b, playerName, range, ctx) {
  const findEntity = () => {
    const p = b.players[playerName];
    return p && p.entity ? p.entity : null;
  };

  let entity = findEntity();
  let waited = 0;
  while (!entity && waited < 10000) {
    await sleep(500);
    waited += 500;
    entity = findEntity();
  }
  if (!entity) throw new Error(`followPlayer: player "${playerName}" not found or not in view`);

  ctx.setDetail(`following ${playerName}`);
  b.pathfinder.setGoal(new goals.GoalFollow(entity, range), true);
  try {
    while (!ctx.isCancelled()) {
      await sleep(1000);
      if (!findEntity()) {
        ctx.log('warn', `followPlayer: lost sight of ${playerName}`);
        break;
      }
    }
  } finally {
    try {
      b.pathfinder.setGoal(null);
    } catch {
      // ignore
    }
  }
  return { followed: playerName, range };
}

async function craftItem(b, itemName, amount, ctx) {
  const itemDef = mcData?.itemsByName?.[itemName];
  if (!itemDef) throw new Error(`craftItem: unknown item "${itemName}"`);

  let recipes = b.recipesFor(itemDef.id, null, 1, null);
  let table = null;
  if (recipes.length === 0) {
    table = b.findBlock({
      matching: (blk) => blk.name === 'crafting_table',
      maxDistance: 16,
      point: b.entity.position,
    });
    if (!table) {
      throw new Error(`craftItem: no hand recipe for "${itemName}" and no crafting table within 16 blocks`);
    }
    ctx.setDetail(`going to crafting table for ${itemName}`);
    await skills.gotoLoop(
      b,
      new goals.GoalGetToBlock(table.position.x, table.position.y, table.position.z),
      { timeoutMs: 30000, maxAttempts: 5 },
      ctx
    );
    recipes = b.recipesFor(itemDef.id, null, 1, table);
    if (recipes.length === 0) {
      throw new Error(`craftItem: no recipe for "${itemName}" even with a crafting table (missing ingredients?)`);
    }
  }

  ctx.setDetail(`crafting ${amount}x ${itemName}`);
  await b.craft(recipes[0], amount, table || undefined);
  return { item: itemName, amount, usedTable: !!table };
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runEvalCode(b, mc, sk, log, code) {
  const fn = new AsyncFunction('bot', 'mcData', 'skills', 'log', code);
  const result = await fn(b, mc, sk, log);
  if (result === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(result));
  } catch (err) {
    throw new Error(`eval result is not JSON-safe: ${err.message}`);
  }
}

function waitForTaskSettled(task) {
  return new Promise((resolve) => {
    const check = () => {
      if (task.state !== 'running') return resolve();
      setTimeout(check, 100);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) req.destroy(new Error('body too large'));
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

function buildStatus() {
  const b = bot;
  const spawned = !!(b && b.entity);
  return {
    name,
    connected: !!state.connected,
    pos: spawned ? { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z } : null,
    health: spawned ? b.health : null,
    food: spawned ? b.food : null,
    gamemode: b?.game ? b.game.gameMode : null,
    inventory: spawned ? summarizeInventory(b) : [],
    currentTask: taskToJSON(state.currentTask),
    lastError: state.lastError,
    engine: defaultEngine,
    deathCount: state.deathCount,
    lastDeath: state.lastDeath,
    poisonedTargets: poisonedTargetsCount(),
  };
}

function summarizeInventory(b) {
  const map = new Map();
  for (const it of b.inventory.items()) {
    map.set(it.name, (map.get(it.name) || 0) + it.count);
  }
  return Array.from(map, ([itemName, count]) => ({ name: itemName, count }));
}

// Task-producing endpoints share the same shape: validate + start a task,
// ack immediately with the task id, let the caller poll /status.
function taskEndpoint(kind, runner) {
  return async (req, res) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    // Disconnect-abort: every task-starting endpoint refuses outright while
    // offline (status/relog/events/stop stay reachable — see handleRequest).
    if (!state.connected) {
      return sendJson(res, 503, { error: 'disconnected' });
    }
    try {
      const task = await startTask(
        kind,
        async (task, ctx) => {
          const b = requireBot();
          return runner(b, body, ctx);
        },
        { force: !!body.force }
      );
      sendJson(res, 200, { ok: true, task: taskToJSON(task) });
    } catch (err) {
      if (err?.busy) return sendJson(res, 409, { error: 'busy', currentTask: taskToJSON(state.currentTask) });
      sendJson(res, 400, { error: err?.message ?? String(err) });
    }
  };
}

function requireNumber(body, field) {
  if (typeof body[field] !== 'number') throw new Error(`requires numeric "${field}"`);
}

const taskRoutes = {
  '/goto': taskEndpoint('goto', async (b, body, ctx) => {
    requireNumber(body, 'x');
    requireNumber(body, 'y');
    requireNumber(body, 'z');
    const { x, y, z, range = 1, timeoutMs = 45000 } = body;
    const engine = body.engine ?? defaultEngine;
    // Register this as the task's current target — if the bot dies mid-goto,
    // the death handler poisons this exact spot.
    ctx.setTargetPos({ x, y, z });
    const result = await movement.goTo(b, { x, y, z, range, timeoutMs, engine }, ctx);
    return { x, y, z, range, reached: true, engine: result.engine };
  }),
  '/chop': taskEndpoint('chop', async (b, body, ctx) =>
    skills.chopTrees(b, { count: body.count ?? 8, maxDistance: body.maxDistance ?? 48 }, ctx)
  ),
  '/mine': taskEndpoint('mine', async (b, body, ctx) => {
    if (!body.block) throw new Error('/mine requires "block"');
    return skills.mineBlocks(b, { block: body.block, count: body.count ?? 8, maxDistance: body.maxDistance ?? 48 }, ctx);
  }),
  '/collect': taskEndpoint('collect', async (b, body, ctx) => skills.collectDrops(b, { radius: body.radius ?? 16 }, ctx)),
  '/hunt': taskEndpoint('hunt', async (b, body, ctx) => {
    if (!body.mob) throw new Error('/hunt requires "mob"');
    return skills.huntAnimals(b, { mob: body.mob, count: body.count ?? 1 }, ctx);
  }),
  '/follow': taskEndpoint('follow', async (b, body, ctx) => {
    if (!body.player) throw new Error('/follow requires "player"');
    return followPlayer(b, body.player, body.range ?? 3, ctx);
  }),
  '/deposit': taskEndpoint('deposit', async (b, body, ctx) => {
    requireNumber(body, 'x');
    requireNumber(body, 'y');
    requireNumber(body, 'z');
    return skills.depositToChest(b, { pos: { x: body.x, y: body.y, z: body.z }, items: body.items }, ctx);
  }),
  '/withdraw': taskEndpoint('withdraw', async (b, body, ctx) => {
    requireNumber(body, 'x');
    requireNumber(body, 'y');
    requireNumber(body, 'z');
    if (!body.items || !body.items.length) throw new Error('/withdraw requires "items"');
    return skills.withdrawFromChest(b, { pos: { x: body.x, y: body.y, z: body.z }, items: body.items }, ctx);
  }),
  '/craft': taskEndpoint('craft', async (b, body, ctx) => {
    if (!body.item) throw new Error('/craft requires "item"');
    return craftItem(b, body.item, body.amount ?? 1, ctx);
  }),
  '/recover': taskEndpoint('recover', async (b, body, ctx) => {
    // deathPos comes from the runner's own state.lastDeath (set by the
    // b.on('death') handler above) — not the request body. skills.recoverKit
    // itself calls ctx.setTargetPos(deathPos) so a second death at the same
    // recovery spot gets poisoned too.
    const deathPos = state.lastDeath?.pos;
    if (!deathPos) throw new Error('/recover: no recorded death position (bot has not died this session)');
    return skills.recoverKit(b, { deathPos, timeBudgetMs: body.timeBudgetMs }, ctx);
  }),
  '/staircase': taskEndpoint('staircase', async (b, body, ctx) => {
    requireNumber(body, 'toY');
    return skills.buildStaircase(b, { toY: body.toY, direction: body.direction }, ctx);
  }),
  '/branchmine': taskEndpoint('branchmine', async (b, body, ctx) => {
    requireNumber(body, 'y');
    return skills.branchMine(
      b,
      {
        y: body.y,
        trunkLength: body.trunkLength,
        branches: body.branches,
        branchLength: body.branchLength,
        direction: body.direction,
      },
      ctx
    );
  }),
};

async function handleChat(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (!body.message) return sendJson(res, 400, { error: '/chat requires "message"' });
  try {
    const b = requireBot();
    b.chat(String(body.message));
    pushEvent('chat_sent', String(body.message));
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleAutoEat(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const on = !!body.on;
  const available = !!(bot && bot.autoEat && typeof bot.autoEat.enableAuto === 'function');
  if (!available) {
    const payload = JSON.stringify({ note: 'mineflayer-auto-eat not loaded on this runner' });
    res.writeHead(204, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(payload);
  }
  try {
    if (on) bot.autoEat.enableAuto();
    else bot.autoEat.disableAuto();
    sendJson(res, 200, { ok: true, on });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleStop(res) {
  const task = await cancelCurrentTask('stopped via /stop');
  sendJson(res, 200, { ok: true, task: taskToJSON(task) });
}

async function handleRelog(res) {
  logLine('info', 'relog requested via /relog');
  pushEvent('task', 'relog requested via /relog');
  manualRelog = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // Only ever one pending relog-connect timer — two quick /relog calls must
  // not each fire connect() (that would put two bots online with one name).
  if (relogTimer) {
    clearTimeout(relogTimer);
    relogTimer = null;
  }
  reconnectAttempt = 0;
  try {
    bot?.quit?.('relog');
  } catch (err) {
    logLine('warn', `relog: quit() error: ${err.message}`);
  }
  relogTimer = setTimeout(() => {
    relogTimer = null;
    manualRelog = false;
    connect();
  }, 500);
  sendJson(res, 200, { ok: true });
}

async function handleEval(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (typeof body.code !== 'string') return sendJson(res, 400, { error: '/eval requires "code" (string)' });
  if (!state.connected) return sendJson(res, 503, { error: 'disconnected' });

  let task;
  try {
    task = await startTask(
      'eval',
      async (task, ctx) => {
        const b = requireBot();
        const evalLog = (msg) => ctx.log('info', typeof msg === 'string' ? msg : JSON.stringify(msg));
        return runEvalCode(b, mcData, skills, evalLog, body.code);
      },
      { force: !!body.force }
    );
  } catch (err) {
    if (err?.busy) return sendJson(res, 409, { error: 'busy', currentTask: taskToJSON(state.currentTask) });
    return sendJson(res, 400, { error: err?.message ?? String(err) });
  }

  const winner = await Promise.race([waitForTaskSettled(task).then(() => 'settled'), sleep(10000).then(() => 'timeout')]);
  if (winner === 'timeout' && task.state === 'running') {
    return sendJson(res, 200, {
      note: 'still running past the 10s soft timeout; poll /status for the result',
      task: taskToJSON(task),
    });
  }
  if (task.state === 'failed') {
    return sendJson(res, 200, { error: task.result?.error ?? 'eval failed', task: taskToJSON(task) });
  }
  return sendJson(res, 200, { result: task.result, task: taskToJSON(task) });
}

function handleEvents(u, res) {
  const since = Number(u.searchParams.get('since') || 0);
  const filtered = eventsBuf.filter((e) => e.seq > since);
  sendJson(res, 200, { events: filtered, last: eventSeq });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    logLine('error', `unhandled request error: ${err?.stack ?? err}`);
    try {
      sendJson(res, 500, { error: err?.message ?? String(err) });
    } catch {
      // response already sent/broken — nothing more to do
    }
  });
});

async function handleRequest(req, res) {
  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  const pathname = u.pathname;
  const method = req.method;

  if (method === 'GET' && pathname === '/status') return sendJson(res, 200, buildStatus());
  if (method === 'GET' && pathname === '/events') return handleEvents(u, res);
  if (method === 'POST' && pathname === '/chat') return handleChat(req, res);
  if (method === 'POST' && pathname === '/autoeat') return handleAutoEat(req, res);
  if (method === 'POST' && pathname === '/stop') return handleStop(res);
  if (method === 'POST' && pathname === '/relog') return handleRelog(res);
  if (method === 'POST' && pathname === '/eval') return handleEval(req, res);
  if (method === 'POST' && taskRoutes[pathname]) return taskRoutes[pathname](req, res);

  sendJson(res, 404, { error: 'not found' });
}

server.on('error', (err) => {
  // Without this, a failed bind (EADDRINUSE etc.) is swallowed by the
  // uncaughtException handler and the bot stays online with NO control API.
  // An uncontrollable bot is worse than a dead one — exit hard.
  logLine('error', `HTTP server error, exiting: ${err?.stack ?? err}`);
  try {
    bot?.quit?.();
  } catch {
    // ignore
  }
  removePidFile();
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  logLine('info', `HTTP API listening on 127.0.0.1:${port}`);
});
