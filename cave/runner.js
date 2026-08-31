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

const { createBot } = mineflayer;
const { goals } = pathfinderPkg;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { host: 'localhost', mcport: 25565 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--mcport') out.mcport = Number(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.name || !args.port || Number.isNaN(args.port)) {
  console.error('usage: node cave/runner.js --name <Name> --port <320x> [--host localhost --mcport 25565]');
  process.exit(1);
}
const { name, port, host, mcport } = args;

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
};

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
  return {
    log: (level, msg) => {
      logLine(level, msg);
      if (level === 'warn' || level === 'error') pushEvent('quirk', msg);
    },
    setDetail: (detail) => {
      task.detail = detail;
    },
    isCancelled: () => task.state !== 'running',
    get mcData() {
      return mcData;
    },
  };
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
    bot?.pathfinder?.setGoal(null);
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
  });

  b.on('error', (err) => {
    const msg = err?.message ?? String(err);
    logLine('error', `bot error: ${err?.stack ?? err}`);
    state.lastError = msg;
    pushEvent('error', msg);
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
    if (!manualRelog) scheduleReconnect();
  });

  b.on('kicked', (reason) => {
    const msg = typeof reason === 'string' ? reason : JSON.stringify(reason);
    logLine('warn', `kicked: ${msg}`);
    pushEvent('kicked', msg);
  });

  b.on('health', () => {
    if (lastHealth !== null && b.health < lastHealth) {
      pushEvent('health', `health dropped to ${b.health} (food=${b.food})`);
    }
    lastHealth = b.health;
  });

  b.on('death', () => {
    logLine('warn', 'died');
    pushEvent('death', `${name} died`);
  });

  b.on('chat', (username, message) => {
    if (username === b.username) return;
    pushEvent('chat', `${username}: ${message}`);
  });
}

function connect() {
  logLine('info', `connecting to ${host}:${mcport} as ${name}`);
  bot = createBot({
    host,
    port: mcport,
    username: name,
    auth: 'offline',
    disableChatSigning: true,
  });
  wireBot(bot);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delays = [5000, 10000, 20000];
  const delay = reconnectAttempt < delays.length ? delays[reconnectAttempt] : 60000;
  reconnectAttempt++;
  logLine('info', `reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Kick off the Minecraft connection — this does NOT block the HTTP server
// below from binding and answering requests immediately.
connect();

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
    const goal = new goals.GoalNear(x, y, z, range);
    await skills.gotoLoop(b, goal, { timeoutMs, maxAttempts: 5 }, ctx);
    return { x, y, z, range, reached: true };
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
