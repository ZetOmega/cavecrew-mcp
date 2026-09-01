#!/usr/bin/env node
// cave/audit.mjs — read-only camp-chest snapshot + diff tool.
//
// Spec (team-lead, 2026-09-01): a fresh 4-iron_ingot ledger mystery (chest D
// 18->14, unexplained) made the case for this — settle every future "what
// happened to this chest" question with a real before/after read instead of
// reconstructing it from chat/DEPOT lines after the fact. Snapshots every
// registered camp chest's REAL contents via a live bot's HTTP API (goto +
// eval openChest/containerItems, same ground-truth discipline as bench.mjs's
// law 1: never trust a ledger, read the world), diffs against the previous
// snapshot on disk, and prints/logs what changed. Read-only end to end — no
// withdraw, no deposit, nothing here can move an item.
//
// Usage:
//   node cave/audit.mjs [--port 3201]
//
// Requires a runner already up and connected on that port (any bot works —
// this only needs pathing + eval, not a specific role). Chest list below
// must be kept in sync with BASE.md's registry rows by hand, same
// maintenance contract CIV.md's roster/port table already has.
//
// Zero LLM tokens, zero world-touches beyond walking the bot to each chest.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(HERE, 'audit-snapshot.json');
const LOG_DIR = path.join(HERE, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'audit.log');

// Camp depot/storage chests — coords from BASE.md's registry (chest_a/b rows,
// storage_house's chest C/D ground-truth notes). Keep this in sync by hand
// whenever a chest moves/gets added/removed in BASE.md.
const CHESTS = [
  { id: 'chest_a_materials', x: 11, y: 89, z: 55, label: 'chest A (wood/materials depot)' },
  { id: 'chest_b_tools', x: 12, y: 90, z: 54, label: 'chest B (building/torch supplies)' },
  { id: 'chest_c_food', x: 16, y: 89, z: 54, label: 'chest C (food, Mine House)' },
  { id: 'chest_d_ore', x: 14, y: 89, z: 57, label: 'chest D (ore, Mine House)' },
];

const DEFAULT_PORT = 3201;

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
  }
  if (!Number.isFinite(args.port) || args.port <= 0) {
    throw new Error(`bad --port value (must be a positive number): ${argv.join(' ')}`);
  }
  return args;
}

async function apiPost(port, pathname, body, timeoutMs = 45000) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${pathname} -> HTTP ${res.status}: ${json?.error ?? 'unknown error'}`);
  }
  return json;
}

async function apiGet(port, pathname, timeoutMs = 8000) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}

// The eval payload deliberately avoids anything requiring a require()'d
// class (Vec3, pathfinder goals) — /eval's scope is only (bot, mcData,
// skills, log), see DRIVER_GUIDE.md. An absolute-position Vec3 is built via
// .offset() off bot.entity.position (itself already a real Vec3 instance)
// instead of constructing one directly. Navigation to within reach happens
// BEFORE this runs, via the ordinary /goto endpoint — this payload only
// opens/reads/closes, once the bot is already standing next to the chest.
function buildReadChestCode(chest) {
  return `
    const cur = bot.entity.position;
    const target = cur.offset(${chest.x} - cur.x, ${chest.y} - cur.y, ${chest.z} - cur.z);
    const block = bot.blockAt(target);
    if (!block || !/chest|barrel|shulker_box/.test(block.name)) {
      return { error: 'no chest-like block at ${chest.x},${chest.y},${chest.z} (found ' + (block ? block.name : 'nothing') + ')' };
    }
    let win;
    try {
      win = await bot.openChest(block);
    } catch (err) {
      // One retry — same spirit as skills.js's openChestRetry fix for the
      // known "windowOpen timeout, one-shot" field bug, duplicated here
      // in-line since this eval payload can't import skills.js helpers.
      win = await bot.openChest(block);
    }
    let items;
    try {
      items = win.containerItems().map((it) => ({ name: it.name, count: it.count }));
    } finally {
      try { win.close(); } catch {}
    }
    return { items };
  `;
}

async function auditOneChest(port, chest) {
  await apiPost(port, '/goto', { x: chest.x, y: chest.y, z: chest.z, range: 2, timeoutMs: 30000 });
  const result = await apiPost(port, '/eval', { code: buildReadChestCode(chest) }, 15000);
  if (result?.error) throw new Error(result.error);
  if (!Array.isArray(result?.items)) throw new Error(`eval returned no items array (got ${JSON.stringify(result)})`);
  return result.items;
}

function toCountMap(items) {
  const m = new Map();
  for (const it of items) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function loadPrevSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch {
    return null; // missing or corrupt — no diff possible, this run becomes the new baseline
  }
}

function diffCounts(prevCounts, curCounts) {
  const names = new Set([...Object.keys(prevCounts ?? {}), ...Object.keys(curCounts)]);
  const changes = [];
  for (const name of [...names].sort()) {
    const before = prevCounts?.[name] ?? 0;
    const after = curCounts[name] ?? 0;
    if (before !== after) changes.push({ name, before, after, delta: after - before });
  }
  return changes;
}

function appendLog(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // best effort — a log-write failure must never break the audit run
  }
}

async function main() {
  const { port } = parseArgs(process.argv.slice(2));

  const status = await apiGet(port, '/status').catch(() => null);
  if (!status || !status.connected) {
    throw new Error(`bot on port ${port} not reachable/connected — start it first (see cave/spawn.mjs)`);
  }

  const prev = loadPrevSnapshot();
  const snapshot = { ts: new Date().toISOString(), port, botName: status.name ?? null, chests: {} };
  console.log(`audit: snapshotting ${CHESTS.length} chest(s) via ${status.name ?? 'bot'} on port ${port}...`);

  for (const chest of CHESTS) {
    process.stdout.write(`  ${chest.id} (${chest.x},${chest.y},${chest.z})... `);
    try {
      const items = await auditOneChest(port, chest);
      snapshot.chests[chest.id] = toCountMap(items);
      console.log(`ok, ${items.length} stack(s)`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      snapshot.chests[chest.id] = { __error: err.message };
    }
  }

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  console.log(`\nsnapshot saved: ${SNAPSHOT_FILE}`);

  if (!prev) {
    console.log('no previous snapshot to diff against — this run is the new baseline.');
    appendLog(`baseline snapshot taken (${CHESTS.length} chests, port ${port})`);
    return;
  }

  console.log(`\n--- diff vs previous snapshot (${prev.ts}) ---`);
  let anyChange = false;
  const logLines = [];
  for (const chest of CHESTS) {
    const prevCounts = prev.chests?.[chest.id];
    const curCounts = snapshot.chests[chest.id];
    if (curCounts?.__error) {
      console.log(`${chest.id}: SKIPPED this run (read failed: ${curCounts.__error})`);
      continue;
    }
    if (!prevCounts || prevCounts.__error) {
      console.log(`${chest.id}: no valid previous read to diff against (fresh baseline for this chest)`);
      continue;
    }
    const changes = diffCounts(prevCounts, curCounts);
    if (changes.length === 0) continue;
    anyChange = true;
    console.log(`${chest.id} (${chest.label}):`);
    for (const c of changes) {
      const sign = c.delta > 0 ? '+' : '';
      const line = `${c.name}: ${c.before} -> ${c.after} (${sign}${c.delta})`;
      console.log(`  ${line}`);
      logLines.push(`${chest.id} ${line}`);
    }
  }
  if (!anyChange) {
    console.log('no changes since last snapshot.');
    appendLog(`audit run, no changes (port ${port})`);
  } else {
    appendLog(`audit run, changes detected (port ${port}): ${logLines.join(' | ')}`);
  }
}

main().catch((err) => {
  console.error(`audit failed: ${err.stack ?? err.message}`);
  process.exit(1);
});
