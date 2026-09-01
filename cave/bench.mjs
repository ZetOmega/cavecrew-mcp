#!/usr/bin/env node
// cave/bench.mjs — one-command pre-flight for the cavecrew runner/skills stack.
//
// ===========================================================================
// CHIEF RULING (2026-09-01) — binding, non-negotiable, supersedes the previous
// design of this file:
//
//   * RCON world-touch is ILLEGAL, with no exception for test infrastructure.
//     This bench contains NO /fill, NO forceload, NO setblock, NO RCON of any
//     kind (the rcon/rconchat imports are gone). Those five words appear in
//     this file ONLY inside this ruling note.
//   * Allowed instead: the test bot TestRock withdraws a SMALL lean test kit
//     from base chest A at (11,89,55) — some cobble, wood, a pickaxe, food —
//     walks to the test yard, and runs every check using its own hands only.
//   * Per check: goto runs on natural terrain (no built room); dig+collect
//     mines natural stone at the yard; craft uses kit wood; place+verify uses
//     the kit's own cobble, hand-placed and hand-removed after; staircase digs
//     natural ground and the resulting far-wilderness scar at the 264+ block
//     yard is accepted rather than restored. If a check ever needs a sealed
//     space, it gets a tiny hand-built cobble shelter from the kit (peaceful
//     server, low risk) — never an admin-built room.
//   * Cleanup law: TestRock returns/banks leftovers to chest A, and the bench
//     kills the TestRock-driven task cleanly at the end. The bot PROCESS stays
//     up — this bench never starts and never stops a runner.
//
// TESTLAB.md's "TestRock never withdraws from camp chests" line is the one
// clause the ruling overrides, and only for the bench kit: the withdraw and
// the matching bank-back are both ledgered in chat (DEPOT lines), so the
// borrow is auditable end to end.
// ===========================================================================
//
// Adapted from felcrew-mcp's bench/preflight.sh + bench/bench.sh (Tier-0
// fixtures, EVALUATION.md doctrine): "grade with something that didn't do the
// work" (law 1). This script does NOT trust any task's own {reached:true} /
// {done:true} / self-reported diff. Every checklist item is graded from a
// SEPARATE ground-truth read (GET /status position, GET /status inventory, or
// a fresh /eval blockAt) taken by this script, before and after the task under
// test — never the task's own result object. That is the exact discipline our
// own commit 4725e84 ("movement: ground-truth reached verification + raw-walk
// fallback (goto false-success dragon)") had to retrofit onto /goto after it
// shipped without it: /goto used to resolve {reached:true} while
// bot.entity.position hadn't moved at all (see FEEDBACK.md "goto
// false-'reached'" / "TORN-GOTO" entries, 2026-09-01). Bench exists so that
// class of bug is caught in one command before it reaches a driver.
//
// Runs against the dedicated test bot (TESTLAB.md): TestRock, port 3209,
// yard center (12, ~90, 320) — 264 blocks from camp (12,89,56) and 316 from
// the FEL base (-3,111,4), comfortably past the 200-block rule. Production
// bots (3201-3208) are never driven by this script; if the port answers as
// anything other than TestRock the run aborts before touching the world.
//
// Usage:
//   node cave/bench.mjs
//
//   TestRock must already be running (this bench never spawns it):
//     node cave/runner.js --name TestRock --port 3209
//
// Exit code: 0 only if every checklist item PASSED. A FAIL or a SKIP both
// exit 1 — a check that could not run (missing kit item, no natural stone in
// range) is not a green light, it is an inconclusive gate. Zero LLM tokens —
// pure node + the runner's own HTTP API.
//
// Checklist (each graded independently, see the philosophy note above):
//   1. goto ground-truth   — /goto ~20 blocks across natural terrain, to a
//                            standable y found by a fresh /eval terrain scan;
//                            verified via a fresh /status position read after
//                            an 800ms settle (EVALUATION.md law 1's own
//                            arrival definition), not the task's reached:true.
//   2. dig+collect cycle   — /mine 2x natural stone (site chosen by an /eval
//                            scan for an air-exposed stone-family block) +
//                            /collect; verified via a drop-item inventory diff
//                            computed from this script's own before/after
//                            /status snapshots.
//   3. craft single        — /craft 1x oak_planks from the kit's oak_log (hand
//                            recipe, no batch>1 — see FEEDBACK.md's
//                            bot.craft(recipe,N>1) miscount entry); verified
//                            via this script's own inventory diff, cross-
//                            checked against (never substituted by) the task's
//                            own before/after/gained fields.
//   4. place+verify        — /eval places 1 kit cobblestone on a natural face
//                            next to the bot, referenced purely via Vec3
//                            instance methods (offset/minus — no Vec3
//                            constructor is in /eval scope); verified via a
//                            SEPARATE /eval blockAt read, then hand-removed
//                            and re-collected, with the removal verified the
//                            same independent way (cleanup law).
//   5. staircase 4-level   — /staircase toY:-4 into natural ground; verified
//                            via this script's own position.y before/after
//                            diff, independent of the engine's internal
//                            net-descent watchdog.
//
// This file intentionally does not import skills.js/runner.js/movement.js — it
// is a black-box HTTP client, same as a driver would be, so it can never end up
// "grading itself" with the code under test.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CAVE_DIR = path.dirname(fileURLToPath(import.meta.url));

const BOT_NAME = 'TestRock';
const PORT = 3209; // TESTLAB.md test-bot lane (3201-3208 are production)

// Base chest A (BASE.md: chest_a_materials, cavecrew access). The only camp
// fixture this bench touches, and only to borrow + bank back the test kit.
const CHEST_A = { x: 11, y: 89, z: 55 };
const CHEST_LABEL = 'chest A';

// Test yard (TESTLAB.md). y is approximate on purpose — it is natural terrain,
// so the real standable height is read from the world, never assumed.
const YARD = { x: 12, y: 90, z: 320 };

// The lean test kit. Each slot lists candidate item names in preference order:
// the first one chest A actually holds is what gets borrowed, so the bench
// survives a chest stocked with a wooden pickaxe instead of a stone one, or
// bread instead of steak. `needs` names the checklist items that cannot run
// without this slot — those get SKIPPED (not FAILED) when it is missing.
const KIT_SLOTS = [
  {
    slot: 'cobble',
    count: 12, // 1 for place+verify, the rest is shelter/contingency material
    candidates: ['cobblestone'],
    needs: ['place-verify'],
  },
  {
    slot: 'wood',
    count: 2, // craft-single consumes 1 oak_log -> 4 planks; 1 spare
    candidates: ['oak_log'],
    needs: ['craft-single'],
  },
  {
    slot: 'pickaxe',
    count: 1,
    candidates: ['stone_pickaxe', 'iron_pickaxe', 'wooden_pickaxe'],
    // A pickaxe in the bag also keeps mineBlocks' ensureTool() from taking its
    // depot-chest branch mid-check — from the yard that is a 264-block detour
    // back to camp in the middle of a graded item.
    needs: ['dig-collect-cycle', 'place-verify', 'staircase-4level'],
  },
  {
    slot: 'food',
    count: 4,
    candidates: ['cooked_beef', 'cooked_porkchop', 'bread', 'cooked_mutton', 'apple'],
    // Food gates no checklist item — it isolates the axis being measured (the
    // five items) from an irrelevant confound (starvation), same reasoning as
    // EVALUATION.md's C1 provisioning note. Missing food is reported, not fatal.
    needs: [],
  },
];

// Natural blocks the dig+collect item is willing to mine, in preference order,
// mapped to what they actually drop without silk touch — the drop name is what
// the inventory diff is graded on, since "stone" never lands in a bag as
// "stone".
const STONE_FAMILY = [
  { block: 'stone', drop: 'cobblestone' },
  { block: 'deepslate', drop: 'cobbled_deepslate' },
  { block: 'andesite', drop: 'andesite' },
  { block: 'granite', drop: 'granite' },
  { block: 'diorite', drop: 'diorite' },
  { block: 'tuff', drop: 'tuff' },
];

const STAIR_DIRECTION = 'east';
const STAIR_LEVELS = 4;
const GOTO_DISTANCE = 20; // blocks, the goto item's travel leg

const SETTLE_MS = 800; // EVALUATION.md law 1's own arrival-settle window
const POLL_MS = 1200;
const TASK_TIMEOUT_MS = 90000;
const CHEST_TASK_TIMEOUT_MS = 120000;
// goto's own internal retry loop (gotoLoopPf) can eat its whole timeoutMs
// PER ATTEMPT before reporting anything (observed live: "attempt 1/5 failed
// (timed out after 60000ms)"), so a goto's timeoutMs must stay well under this
// script's own poll deadline for it, or the poll gives up on a task that is
// still legitimately retrying.
const GOTO_TIMEOUT_MS = 25000;
const GOTO_POLL_TIMEOUT_MS = 45000;
const STAIRCASE_TIMEOUT_MS = 150000;

// Long-haul travel: camp -> yard is ~264 blocks, far past what one /goto is
// tuned for. Bench walks it in bounded hops and grades its OWN progress from
// /status between hops, so a silently-stuck bot is caught in seconds instead
// of after a five-minute timeout.
const TRAVEL_HOP_BLOCKS = 40;
const TRAVEL_HOP_TIMEOUT_MS = 45000;
const TRAVEL_HOP_POLL_MS = 80000;
const TRAVEL_MAX_HOPS = 24;

// ---------------------------------------------------------------------------
// tiny HTTP helpers
// ---------------------------------------------------------------------------

async function apiGet(pathname, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function apiPost(pathname, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Narration + protocol ledger lines both go through /chat; the runner's
// smartChat auto-classifies (DRIVER_GUIDE.md "Chat tiers"), so a DEPOT line
// goes out verbatim as real white chat and everything else becomes grey.
// Best-effort: a chat failure must never decide a checklist verdict.
async function chat(message) {
  try {
    await apiPost('/chat', { message }, 8000);
  } catch {
    // narration is never load-bearing
  }
}

async function depotLine(sign, count, item) {
  if (!count) return;
  await chat(`DEPOT ${sign}${count} ${item} (${CHEST_LABEL})`);
}

// ---------------------------------------------------------------------------
// polling / ground-truth reads
// ---------------------------------------------------------------------------

// Polls /status until currentTask.state is no longer 'running'. Returns the
// final /status object. Never throws on task failure — that's a checklist
// item's job to interpret, not this helper's.
async function waitTaskSettled(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await apiGet('/status');
    const state = last?.currentTask?.state;
    if (state !== 'running') return last;
    await sleep(POLL_MS);
  }
  throw new Error(`task still running after ${timeoutMs}ms (last state: ${last?.currentTask?.state})`);
}

// handleEval (runner.js) answers inline if the eval settles within its own 10s
// soft-timeout, else returns {note, task:{state:'running',...}} and expects the
// caller to poll /status — same task-polling contract as every other endpoint.
// Falls back to that poll rather than treating "still running" as a failure.
// force:true on every task POST below (this one included): /stop is already
// issued before each item, but the runner's own idle-guard can self-issue a
// make-work task in any gap, and a stale cancel can still be winding down. A 409
// "busy" would then show up as a checklist failure that has nothing to do with
// the code under test — force cancels-then-starts instead. It changes who owns
// the mutex, never how a result is graded.
async function evalCode(code, timeoutMs = 30000) {
  const resp = await apiPost('/eval', { code, force: true }, 20000);
  if (resp.body?.error) return { error: resp.body.error };
  if (!resp.body?.note) return resp.body?.result ?? null;
  const status = await waitTaskSettled(timeoutMs);
  if (status?.currentTask?.state === 'failed') return { error: status.currentTask.result?.error };
  return status?.currentTask?.result ?? null;
}

// /eval's scope is (bot, mcData, skills, log) only — there is no bare Vec3
// constructor in there, so every absolute coordinate has to be reached through
// a Vec3 instance the bot already owns. This prelude builds that bridge once.
const EVAL_PRELUDE = `
  const __here = bot.entity.position.floored();
  const abs = (x, y, z) => __here.offset(x - __here.x, y - __here.y, z - __here.z);
`;

function inventoryMap(status) {
  const m = new Map();
  for (const it of status?.inventory ?? []) m.set(it.name, it.count);
  return m;
}

function countOf(status, name) {
  return inventoryMap(status).get(name) ?? 0;
}

// Positive entries only: what this script's own two /status snapshots say the
// bag gained between them.
function inventoryGain(before, after) {
  const a = inventoryMap(before);
  const b = inventoryMap(after);
  const gained = new Map();
  for (const [name, count] of b) {
    const delta = count - (a.get(name) ?? 0);
    if (delta > 0) gained.set(name, delta);
  }
  return gained;
}

function inventoryLoss(before, after) {
  return inventoryGain(after, before);
}

function dist3D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function dist2D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

function fmtPos(p) {
  return p ? `(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})` : '<none>';
}

// Reads real terrain: the topmost standable y at (x,z) — a solid, non-liquid
// block with two clear cells above it — searched downward from aroundY+span.
// This is how the bench finds ground on unbuilt wilderness instead of assuming
// a height the way the old admin-built platform could.
async function groundYAt(x, z, aroundY, span = 12) {
  const code = `${EVAL_PRELUDE}
    const clear = (b) => b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava';
    const solid = (b) => b && b.boundingBox === 'block' && b.name !== 'water' && b.name !== 'lava';
    for (let y = ${aroundY + span}; y >= ${aroundY - span}; y--) {
      const here = bot.blockAt(abs(${x}, y, ${z}));
      const up1 = bot.blockAt(abs(${x}, y + 1, ${z}));
      const up2 = bot.blockAt(abs(${x}, y + 2, ${z}));
      if (!here || !up1 || !up2) continue;
      if (solid(here) && clear(up1) && clear(up2)) return { y: y + 1, ground: here.name };
    }
    return { y: null };
  `;
  const result = await evalCode(code, 20000);
  if (result?.error) throw new Error(`terrain scan at (${x},?,${z}) failed: ${result.error}`);
  return result ?? { y: null };
}

// Picks the dig+collect item's target from the REAL world: the nearest
// stone-family block that has at least one air face (so it is diggable without
// tunnelling to it) and sits no more than 3 blocks below the bot's feet (so
// mineBlocks' own pre-descent guard, "too deep, needs staircase" at >4, never
// discards it). Setup only — the verdict still comes from the inventory diff.
async function findNaturalStone(maxDistance) {
  const code = `${EVAL_PRELUDE}
    const names = ${JSON.stringify(STONE_FAMILY.map((s) => s.block))};
    const airy = (b) => b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava';
    const feetY = Math.floor(bot.entity.position.y);
    for (const name of names) {
      const def = mcData.blocksByName[name];
      if (!def) continue;
      const spots = bot.findBlocks({ matching: def.id, maxDistance: ${maxDistance}, count: 300 });
      for (const p of spots) {
        if (feetY - p.y > 3) continue;
        const faces = [p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 1, 0), p.offset(0, -1, 0), p.offset(0, 0, 1), p.offset(0, 0, -1)];
        if (!faces.some((q) => airy(bot.blockAt(q)))) continue;
        return { block: name, pos: { x: p.x, y: p.y, z: p.z }, distance: bot.entity.position.distanceTo(p) };
      }
    }
    return { block: null };
  `;
  const result = await evalCode(code, 30000);
  if (result?.error) throw new Error(`stone scan failed: ${result.error}`);
  return result ?? { block: null };
}

// ---------------------------------------------------------------------------
// checklist bookkeeping — each item lands here exactly once
// ---------------------------------------------------------------------------

const results = [];

function push(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name} — ${detail}`);
  return status === 'PASS';
}

function record(name, pass, detail) {
  return push(name, pass ? 'PASS' : 'FAIL', detail);
}

// A check that could not run is NOT a pass. It is reported separately and
// still blocks the gate (see the exit-code note in the header) — the whole
// point of this file is that nothing downstream gets to read "no failures" as
// "verified".
function skipped(name, detail) {
  push(name, 'SKIP', detail);
  return false;
}

// ---------------------------------------------------------------------------
// travel — bounded hops, graded from bench's own /status between each one
// ---------------------------------------------------------------------------

async function travelTo(target, opts = {}) {
  const label = opts.label ?? 'travel';
  const arriveRange = opts.arriveRange ?? 3;
  let last = await apiGet('/status');
  if (!last?.pos) throw new Error(`${label}: no position in /status (bot not spawned?)`);
  let stalls = 0;

  for (let hop = 1; hop <= TRAVEL_MAX_HOPS; hop++) {
    const flat = dist2D(last.pos, target);
    if (flat <= arriveRange + 1.5) return last;

    const step = Math.min(TRAVEL_HOP_BLOCKS, flat);
    const final = step >= flat - 0.5;
    const leg = final
      ? { x: target.x, y: target.y, z: target.z, range: arriveRange }
      : {
          x: Math.round(last.pos.x + ((target.x - last.pos.x) / flat) * step),
          y: Math.round(last.pos.y),
          z: Math.round(last.pos.z + ((target.z - last.pos.z) / flat) * step),
          range: 4,
        };

    await apiPost('/stop', {}).catch(() => {});
    const { body } = await apiPost('/goto', {
      x: leg.x, y: leg.y, z: leg.z, range: leg.range, timeoutMs: TRAVEL_HOP_TIMEOUT_MS, engine: 'pf', force: true,
    });
    if (body?.error && body.error !== 'busy') {
      throw new Error(`${label}: /goto rejected on hop ${hop}: ${body.error}`);
    }
    await waitTaskSettled(TRAVEL_HOP_POLL_MS).catch(() => null);
    await sleep(400);

    const after = await apiGet('/status');
    if (!after?.pos) throw new Error(`${label}: /status lost position mid-travel on hop ${hop}`);
    // Ground truth per hop: did the bot actually get closer? A hop that
    // resolves "done" without closing distance is the goto-dragon again, just
    // outside a graded item — catch it here rather than letting it silently
    // strand the whole run.
    const progressed = dist2D(last.pos, target) - dist2D(after.pos, target);
    stalls = progressed < 3 ? stalls + 1 : 0;
    if (stalls >= 3) {
      throw new Error(
        `${label}: stalled ${dist2D(after.pos, target).toFixed(1)} blocks short of (${target.x},${target.y},${target.z}) — ` +
          `3 consecutive hops moved <3 blocks closer (pos ${fmtPos(after.pos)})`
      );
    }
    last = after;
  }
  throw new Error(
    `${label}: still ${dist2D(last.pos, target).toFixed(1)} blocks from (${target.x},${target.y},${target.z}) after ${TRAVEL_MAX_HOPS} hops`
  );
}

// ---------------------------------------------------------------------------
// kit — borrow from chest A by hand, ledger it, and bank it back at the end
// ---------------------------------------------------------------------------

async function readChestContents() {
  const code = `${EVAL_PRELUDE}
    const block = bot.blockAt(abs(${CHEST_A.x}, ${CHEST_A.y}, ${CHEST_A.z}));
    if (!block) return { error: 'no block data at ${CHEST_A.x},${CHEST_A.y},${CHEST_A.z} (chunk not loaded / bot too far)' };
    if (!/chest|barrel|shulker_box/.test(block.name)) {
      return { error: 'block at ${CHEST_A.x},${CHEST_A.y},${CHEST_A.z} is ' + block.name + ', not a container' };
    }
    const win = await bot.openChest(block);
    try {
      const counts = {};
      for (const it of win.containerItems()) counts[it.name] = (counts[it.name] || 0) + it.count;
      return { counts };
    } finally {
      try { win.close(); } catch { /* window already gone */ }
    }
  `;
  return evalCode(code, 40000);
}

function chooseKit(counts) {
  const chosen = new Map();
  const missing = [];
  for (const slot of KIT_SLOTS) {
    let picked = null;
    for (const candidate of slot.candidates) {
      const have = counts?.[candidate] ?? 0;
      if (have > 0) {
        picked = { name: candidate, count: Math.min(slot.count, have) };
        break;
      }
    }
    if (picked) chosen.set(slot.slot, picked);
    else missing.push(slot);
  }
  return { chosen, missing };
}

// Returns { slots: Map<slot,{name,count}>, missing: Map<slot,reason>, borrowed: Map<name,count> }.
// Never throws: a bare chest is a reportable condition that SKIPs dependent
// items, not a crash.
async function withdrawKit() {
  try {
    return await withdrawKitInner();
  } catch (err) {
    const kit = { slots: new Map(), missing: new Map(), borrowed: new Map() };
    for (const slot of KIT_SLOTS) kit.missing.set(slot.slot, `kit withdraw threw: ${err.message}`);
    record('kit-withdraw', false, `kit withdraw threw: ${err.message}`);
    return kit;
  }
}

async function withdrawKitInner() {
  const kit = { slots: new Map(), missing: new Map(), borrowed: new Map() };

  let contents;
  try {
    contents = await readChestContents();
  } catch (err) {
    contents = { error: err.message };
  }
  if (!contents || contents.error) {
    const reason = `${CHEST_LABEL} unreadable: ${contents?.error ?? 'no result'}`;
    for (const slot of KIT_SLOTS) kit.missing.set(slot.slot, reason);
    record('kit-withdraw', false, reason);
    return kit;
  }

  const { chosen, missing } = chooseKit(contents.counts ?? {});
  for (const slot of missing) {
    kit.missing.set(slot.slot, `${CHEST_LABEL} holds none of: ${slot.candidates.join(', ')}`);
  }
  if (chosen.size === 0) {
    record('kit-withdraw', false, `${CHEST_LABEL} holds no kit item at all (wanted ${KIT_SLOTS.map((s) => s.slot).join(', ')})`);
    return kit;
  }

  const before = await apiGet('/status');
  const items = [...chosen.values()].map((c) => ({ name: c.name, count: c.count }));
  const resp = await apiPost('/withdraw', { x: CHEST_A.x, y: CHEST_A.y, z: CHEST_A.z, items, force: true });
  if (resp.body?.error) {
    for (const slot of KIT_SLOTS) if (!kit.missing.has(slot.slot)) kit.missing.set(slot.slot, `/withdraw rejected: ${resp.body.error}`);
    record('kit-withdraw', false, `/withdraw rejected: ${resp.body.error}`);
    return kit;
  }
  const status = await waitTaskSettled(CHEST_TASK_TIMEOUT_MS).catch(() => null);
  const taskFailed = status?.currentTask?.state === 'failed';

  await sleep(SETTLE_MS);
  const after = await apiGet('/status');
  // Ground truth: what the BAG gained, not what withdrawFromChest said it
  // moved. Anything asked for that did not actually arrive is treated as
  // missing, which SKIPs the items that depend on it.
  const gained = inventoryGain(before, after);

  for (const [slotName, pick] of chosen) {
    const got = gained.get(pick.name) ?? 0;
    if (got > 0) {
      kit.slots.set(slotName, { name: pick.name, count: got });
      kit.borrowed.set(pick.name, got);
    } else {
      kit.missing.set(slotName, `asked ${CHEST_LABEL} for ${pick.count}x ${pick.name}, inventory diff says 0 arrived`);
    }
  }

  for (const [name, count] of kit.borrowed) await depotLine('-', count, name);

  const gotDesc = kit.slots.size
    ? [...kit.slots.entries()].map(([s, v]) => `${s}=${v.count}x ${v.name}`).join(', ')
    : 'nothing';
  const missDesc = kit.missing.size ? `; MISSING: ${[...kit.missing.keys()].join(', ')}` : '';
  record(
    'kit-withdraw',
    kit.slots.size > 0 && !taskFailed,
    `borrowed ${gotDesc} from ${CHEST_LABEL} (this script's own inventory diff, not the task's withdrawn[])${missDesc}` +
      (taskFailed ? ` — /withdraw task reported failed: ${status?.currentTask?.result?.error}` : '')
  );
  return kit;
}

// Cleanup law: everything borrowed, everything mined, and everything crafted
// goes back into chest A. Graded on this script's own inventory diff, and
// ledgered with DEPOT + lines per item actually moved.
async function bankLeftovers(kit, extraNames) {
  const names = new Set([...kit.borrowed.keys(), ...extraNames]);
  if (names.size === 0) {
    return record('cleanup-bank-leftovers', true, 'nothing was borrowed or produced — nothing to bank');
  }

  // Decide BEFORE walking: the yard is 264 blocks from camp, and a run that
  // borrowed nothing and mined nothing has no reason to make the trip.
  await apiPost('/stop', {}).catch(() => {});
  const preTravel = await apiGet('/status');
  const carried = [...names].filter((n) => countOf(preTravel, n) > 0);
  if (carried.length === 0) {
    return record('cleanup-bank-leftovers', true, 'nothing borrowed or produced is still in the bag — no trip to camp needed');
  }

  await chat('bench: checklist done, banking leftovers at camp');
  await travelTo(CHEST_A, { label: 'travel-to-chest-a (bank)', arriveRange: 3 });

  const before = await apiGet('/status');
  const resp = await apiPost('/deposit', { x: CHEST_A.x, y: CHEST_A.y, z: CHEST_A.z, items: carried, force: true });
  if (resp.body?.error) {
    return record('cleanup-bank-leftovers', false, `/deposit rejected: ${resp.body.error} (still carrying ${carried.join(', ')})`);
  }
  const status = await waitTaskSettled(CHEST_TASK_TIMEOUT_MS).catch(() => null);

  await sleep(SETTLE_MS);
  const after = await apiGet('/status');
  const lost = inventoryLoss(before, after);
  for (const [name, count] of lost) if (names.has(name)) await depotLine('+', count, name);

  const stillHeld = carried.filter((n) => countOf(after, n) > 0).map((n) => `${countOf(after, n)}x ${n}`);
  const moved = [...lost.entries()].filter(([n]) => names.has(n)).map(([n, c]) => `${c}x ${n}`).join(', ') || 'nothing';
  if (stillHeld.length) {
    return record(
      'cleanup-bank-leftovers',
      false,
      `banked ${moved} but the bag still holds ${stillHeld.join(', ')} (chest full?)` +
        (status?.currentTask?.state === 'failed' ? ` — /deposit task reported failed: ${status.currentTask.result?.error}` : '')
    );
  }
  return record('cleanup-bank-leftovers', true, `banked ${moved} into ${CHEST_LABEL} (this script's own inventory diff, not the task's deposited[])`);
}

// ---------------------------------------------------------------------------
// checklist items — each returns true only on PASS
// ---------------------------------------------------------------------------

async function testGotoGroundTruth() {
  const name = 'goto-ground-truth';
  try {
    const before = await apiGet('/status');
    const startY = Math.floor(before.pos.y);

    // Natural terrain: pick the first cardinal leg that actually has standable
    // ground at roughly the bot's own height (no cliff, no water, no void).
    const legs = [
      { dx: GOTO_DISTANCE, dz: 0 }, { dx: -GOTO_DISTANCE, dz: 0 },
      { dx: 0, dz: GOTO_DISTANCE }, { dx: 0, dz: -GOTO_DISTANCE },
    ];
    let target = null;
    const scans = [];
    for (const leg of legs) {
      const x = Math.round(before.pos.x) + leg.dx;
      const z = Math.round(before.pos.z) + leg.dz;
      const scan = await groundYAt(x, z, startY);
      scans.push(`(${x},${scan.y ?? '?'},${z})`);
      if (scan.y !== null && Math.abs(scan.y - startY) <= 6) {
        target = { x, y: scan.y, z, ground: scan.ground };
        break;
      }
    }
    if (!target) {
      return skipped(name, `no standable natural ground ${GOTO_DISTANCE} blocks out in any cardinal direction from ${fmtPos(before.pos)} (scanned ${scans.join(' ')})`);
    }

    const { body } = await apiPost('/goto', {
      x: target.x, y: target.y, z: target.z, range: 2, timeoutMs: GOTO_TIMEOUT_MS, engine: 'pf', force: true,
    });
    if (body?.error) return record(name, false, `/goto rejected: ${body.error}`);

    const status = await waitTaskSettled(GOTO_POLL_TIMEOUT_MS);
    const claimedReached = status?.currentTask?.result?.reached === true;

    // The settle + independent position read IS the verifier — claimedReached
    // is logged for cross-reference only, never trusted on its own (that trust
    // is exactly what commit 4725e84 removed from /goto after a live false
    // success — see file header).
    await sleep(SETTLE_MS);
    const after = await apiGet('/status');
    const d = dist3D(after.pos, target);
    const moved = dist3D(after.pos, before.pos);
    const arrived = d <= 2 + 1.5;

    if (claimedReached && !arrived) {
      return record(name, false, `GOTO-DRAGON: task claimed reached:true but ground-truth position is ${d.toFixed(2)} blocks from target (pos=${fmtPos(after.pos)}) — false success`);
    }
    if (!arrived) {
      return record(name, false, `did not arrive: ${d.toFixed(2)} blocks from target after ${SETTLE_MS}ms settle (task claimed reached=${claimedReached})`);
    }
    // Second, independent guard against the same dragon in its quieter form:
    // "arrived" is meaningless if the bot never left, so require real
    // displacement too.
    if (moved < GOTO_DISTANCE * 0.6) {
      return record(name, false, `GOTO-DRAGON: within ${d.toFixed(2)} of target but only moved ${moved.toFixed(2)} blocks from the start position — the target was effectively already underfoot`);
    }
    return record(name, true, `arrived within ${d.toFixed(2)} blocks of a ${GOTO_DISTANCE}-block natural-terrain target on ${target.ground}, moved ${moved.toFixed(2)} blocks (task claimed reached=${claimedReached}, ground-truth agrees)`);
  } catch (err) {
    return record(name, false, `exception: ${err.message}`);
  }
}

async function testDigCollect(kit) {
  const name = 'dig-collect-cycle';
  if (!kit.slots.has('pickaxe')) return skipped(name, `no pickaxe in the kit — ${kit.missing.get('pickaxe')}`);
  try {
    // Setup read (not the verdict): find real, air-exposed natural stone.
    const site = await findNaturalStone(48);
    if (!site?.block) {
      return skipped(name, 'no air-exposed natural stone/deepslate/andesite/granite/diorite/tuff within 48 blocks of the yard — nothing to dig by hand');
    }
    const drop = STONE_FAMILY.find((s) => s.block === site.block).drop;
    const maxDistance = Math.max(8, Math.ceil(site.distance) + 4);

    const before = await apiGet('/status');
    const dropBefore = countOf(before, drop);

    const mineResp = await apiPost('/mine', { block: site.block, count: 2, maxDistance, force: true });
    if (mineResp.body?.error) return record(name, false, `/mine rejected: ${mineResp.body.error}`);
    let status = await waitTaskSettled(TASK_TIMEOUT_MS);
    if (status?.currentTask?.state === 'failed') {
      return record(name, false, `/mine task failed: ${status.currentTask.result?.error}`);
    }

    // DRIVER_GUIDE standing law: sweep at 24, not the 16 default, so nothing
    // is left on the ground after a dig.
    const collectResp = await apiPost('/collect', { radius: 24, force: true });
    if (collectResp.body?.error) return record(name, false, `/collect rejected: ${collectResp.body.error}`);
    status = await waitTaskSettled(TASK_TIMEOUT_MS);
    if (status?.currentTask?.state === 'failed') {
      return record(name, false, `/collect task failed: ${status.currentTask.result?.error}`);
    }

    await sleep(SETTLE_MS);
    const after = await apiGet('/status');
    const diff = countOf(after, drop) - dropBefore;
    if (diff < 2) {
      return record(name, false, `${drop} diff is ${diff} (want >= 2) — before=${dropBefore} after=${countOf(after, drop)}, this script's own /status snapshots, not the task's self-report`);
    }
    return record(name, true, `${drop} +${diff} from natural ${site.block} at (${site.pos.x},${site.pos.y},${site.pos.z}) ~${site.distance.toFixed(1)} blocks out (this script's own before/after /status diff, mineBlocks/collectDrops self-reports not consulted for the verdict)`);
  } catch (err) {
    return record(name, false, `exception: ${err.message}`);
  }
}

async function testCraftSingle(kit) {
  const name = 'craft-single';
  if (!kit.slots.has('wood')) return skipped(name, `no kit wood — ${kit.missing.get('wood')}`);
  try {
    const before = await apiGet('/status');
    const planksBefore = countOf(before, 'oak_planks');

    const resp = await apiPost('/craft', { item: 'oak_planks', amount: 1, force: true });
    if (resp.body?.error) return record(name, false, `/craft rejected: ${resp.body.error}`);
    const status = await waitTaskSettled(TASK_TIMEOUT_MS);
    if (status?.currentTask?.state === 'failed') {
      return record(name, false, `/craft task failed: ${status.currentTask.result?.error}`);
    }
    const selfReport = status?.currentTask?.result;

    await sleep(SETTLE_MS);
    const after = await apiGet('/status');
    const diff = countOf(after, 'oak_planks') - planksBefore;

    const agrees = !selfReport || selfReport.gained === undefined || selfReport.gained === diff;
    const note = agrees ? '' : ` (NOTE: task self-reported gained=${selfReport.gained}, this script's own diff is ${diff} — disagreement is itself a finding, not just noise)`;

    if (diff < 4) {
      return record(name, false, `oak_planks diff is ${diff} (want >= 4 from 1 kit oak_log) — before=${planksBefore} after=${countOf(after, 'oak_planks')}${note}`);
    }
    return record(name, true, `oak_planks +${diff} from kit oak_log (this script's own diff${note || '; agrees with the task self-report'})`);
  } catch (err) {
    return record(name, false, `exception: ${err.message}`);
  }
}

async function testPlaceVerify(kit) {
  const name = 'place-verify';
  if (!kit.slots.has('cobble')) return skipped(name, `no kit cobblestone — ${kit.missing.get('cobble')}`);
  if (!kit.slots.has('pickaxe')) return skipped(name, `no pickaxe in the kit, so the placed block could not be hand-removed afterward — ${kit.missing.get('pickaxe')}`);
  const pickName = kit.slots.get('pickaxe').name;
  try {
    // Everything below is built from bot.entity.position via .offset()/.minus()
    // — /eval's scope has bot/mcData/skills/log only, no bare Vec3 constructor.
    // The face is chosen from real terrain (solid ground with a clear cell over
    // it) instead of a fixed offset into a room that no longer exists.
    const placeCode = `
      const feet = bot.entity.position.floored();
      const clear = (b) => b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava';
      const solid = (b) => b && b.boundingBox === 'block' && b.name !== 'water' && b.name !== 'lava';
      let ref = null, target = null;
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const r = feet.offset(d[0], -1, d[1]);
        const t = feet.offset(d[0], 0, d[1]);
        if (solid(bot.blockAt(r)) && clear(bot.blockAt(t))) { ref = r; target = t; break; }
      }
      if (!ref) return { error: 'no natural face next to the bot (need solid ground with a clear cell above) at ' + feet.toString() };
      const item = bot.inventory.items().find((it) => it.name === 'cobblestone');
      if (!item) return { error: 'no cobblestone in inventory to place' };
      await bot.equip(item, 'hand');
      let placeError = null;
      try {
        await bot.placeBlock(bot.blockAt(ref), target.minus(ref));
      } catch (err) {
        placeError = err.message;
      }
      return { targetPos: { x: target.x, y: target.y, z: target.z }, placeError };
    `;
    const placeResult = await evalCode(placeCode);
    if (placeResult?.error) return record(name, false, `place /eval failed: ${placeResult.error}`);
    const targetPos = placeResult?.targetPos;
    if (!targetPos) return record(name, false, `place /eval returned no targetPos: ${JSON.stringify(placeResult)}`);

    await sleep(SETTLE_MS);

    // Independent second witness: a FRESH /eval call reading blockAt at the
    // recorded absolute target position — not the placement call's own resolved
    // promise (law 1 — a verifier reading the world, not trusting the actor
    // that just acted). This is also why a thrown placeError is not itself the
    // verdict: FEEDBACK.md's "blockUpdate timeout but the block is real" quirk
    // is exactly a placement that throws while the world agrees it happened.
    const readBack = async () => {
      const code = `${EVAL_PRELUDE}
        const b = bot.blockAt(abs(${targetPos.x}, ${targetPos.y}, ${targetPos.z}));
        return { name: b ? b.name : null };
      `;
      return evalCode(code);
    };

    const verifyResult = await readBack();
    if (verifyResult?.error) return record(name, false, `verify /eval failed: ${verifyResult.error}`);
    const throwNote = placeResult.placeError ? ` (placeBlock itself threw "${placeResult.placeError}" — graded on the world read, not the call)` : '';
    if (verifyResult?.name !== 'cobblestone') {
      return record(name, false, `independent verify read block "${verifyResult?.name}" at (${targetPos.x},${targetPos.y},${targetPos.z}) (want "cobblestone")${throwNote} — the place call's own promise is not trusted here`);
    }

    // Cleanup law: what the bench placed by hand, the bench removes by hand,
    // then picks the drop back up so nothing is left on the ground.
    const removeCode = `${EVAL_PRELUDE}
      const target = abs(${targetPos.x}, ${targetPos.y}, ${targetPos.z});
      const b = bot.blockAt(target);
      if (!b) return { error: 'no block data at the placed position' };
      if (b.name !== 'cobblestone') return { note: 'already ' + b.name };
      const pick = bot.inventory.items().find((it) => it.name === '${pickName}');
      if (pick) await bot.equip(pick, 'hand');
      let digError = null;
      try { await bot.dig(b); } catch (err) { digError = err.message; }
      return { digError };
    `;
    const removeResult = await evalCode(removeCode, 40000);
    await apiPost('/collect', { radius: 8, force: true }).catch(() => {});
    await waitTaskSettled(TASK_TIMEOUT_MS).catch(() => null);
    await sleep(SETTLE_MS);

    const afterRemove = await readBack();
    if (afterRemove?.name === 'cobblestone') {
      return record(name, false, `placed + verified at (${targetPos.x},${targetPos.y},${targetPos.z})${throwNote}, but the hand-removal left it standing (remove /eval said ${JSON.stringify(removeResult)}) — cleanup law violated, remove it manually`);
    }
    return record(name, true, `independent /eval read confirmed cobblestone at (${targetPos.x},${targetPos.y},${targetPos.z}), a second independent read confirms it is now "${afterRemove?.name}" after hand-removal${throwNote} (separate calls from the ones that placed and dug it)`);
  } catch (err) {
    return record(name, false, `exception: ${err.message}`);
  }
}

async function testStaircase(kit) {
  const name = 'staircase-4level';
  if (!kit.slots.has('pickaxe')) return skipped(name, `no pickaxe in the kit — ${kit.missing.get('pickaxe')}`);
  try {
    const before = await apiGet('/status');
    const startY = before.pos.y;
    const toY = Math.floor(startY) - STAIR_LEVELS;

    const resp = await apiPost('/staircase', { toY, direction: STAIR_DIRECTION, force: true }, 10000);
    if (resp.body?.error) return record(name, false, `/staircase rejected: ${resp.body.error}`);
    const status = await waitTaskSettled(STAIRCASE_TIMEOUT_MS);
    const taskFailed = status?.currentTask?.state === 'failed';

    await sleep(SETTLE_MS);
    const after = await apiGet('/status');
    const netDrop = startY - after.pos.y;

    // Standing law: sweep the dig drops before moving on. Not part of the
    // verdict, but the cleanup law applies to graded items too.
    await apiPost('/collect', { radius: 24, force: true }).catch(() => {});
    await waitTaskSettled(TASK_TIMEOUT_MS).catch(() => null);

    // Ground truth is the position diff this script itself took, not the
    // engine's internal net-descent watchdog (which only guards against
    // in-place grinding, it doesn't grade the task as done/not-done) and not
    // task.state alone (a task can report 'done' on a partial/short descent).
    if (netDrop < STAIR_LEVELS - 1) {
      return record(name, false, `net Y-drop is ${netDrop.toFixed(2)} (want >= ${STAIR_LEVELS - 1}) — startY=${startY.toFixed(2)} endY=${after.pos.y.toFixed(2)}, task ${taskFailed ? 'also reported failed: ' + status.currentTask.result?.error : 'reported done'}`);
    }
    // The stairwell is left in place: the ruling accepts a far-wilderness scar
    // at a yard 264+ blocks from every base, and walking back out of the cut
    // is itself the cheapest proof the steps are real.
    return record(name, true, `net Y-drop ${netDrop.toFixed(2)} into natural ground over a ${STAIR_LEVELS}-level request (this script's own before/after /status.pos.y, not the engine's internal watchdog); stairwell left as an accepted yard scar`);
  } catch (err) {
    return record(name, false, `exception: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// preflight — never spawns anything, never drives a production bot
// ---------------------------------------------------------------------------

const START_HINT =
  `start it first (TESTLAB.md):\n    cd C:\\Users\\phili\\tools\\cavecrew-mcp\n    node cave/runner.js --name ${BOT_NAME} --port ${PORT}`;

async function preflight() {
  let status;
  try {
    status = await apiGet('/status', 5000);
  } catch (err) {
    throw new Error(`nothing answering on 127.0.0.1:${PORT} (${err.message}) — ${BOT_NAME} is offline; ${START_HINT}`);
  }
  if (status?.name && status.name !== BOT_NAME) {
    throw new Error(`port ${PORT} answers as "${status.name}", not ${BOT_NAME} — refusing to drive it (TESTLAB.md: production bots must never be risked by a test)`);
  }
  if (!status?.connected) {
    throw new Error(`${BOT_NAME} is up but not connected to the server (connected=${status?.connected}) — check cave/logs/${BOT_NAME}.log, then ${START_HINT}`);
  }
  if (!status?.pos) {
    throw new Error(`${BOT_NAME} reports connected but has no position yet (still spawning) — re-run in a few seconds`);
  }
  // REAL-SERVER CONNECT-CHECK LAW (team-lead, 2026-09-01, after the
  // chat-mirror outage): a smoke-boot on a dead mcport never reaches
  // connect/wireBot, so a crash class that fires on real connect is invisible
  // to it. connected:true above IS that real-connect proof — but only if the
  // bot PROCESS is newer than the newest code file. A TestRock started before
  // the patch proves nothing about the patched code connecting.
  let pidRec;
  try {
    pidRec = JSON.parse(fs.readFileSync(path.join(CAVE_DIR, 'pids', `${BOT_NAME}.json`), 'utf8'));
  } catch (err) {
    throw new Error(
      `cannot verify ${BOT_NAME} runs current code (pid file unreadable: ${err.message}) — cave/pids/${BOT_NAME}.json is required for the connect-check law; restart ${BOT_NAME} and re-run`
    );
  }
  const startedAt = Date.parse(pidRec?.startedAt);
  let newestMs = 0;
  let newestFile = '';
  for (const f of ['runner.js', 'skills.js', 'movement.js']) {
    try {
      const m = fs.statSync(path.join(CAVE_DIR, f)).mtimeMs;
      if (m > newestMs) {
        newestMs = m;
        newestFile = f;
      }
    } catch {
      // a missing engine file would have failed far earlier than this
    }
  }
  if (!Number.isFinite(startedAt) || newestMs > startedAt) {
    throw new Error(
      `${BOT_NAME} is running STALE code: process started ${pidRec?.startedAt ?? 'unknown'} but cave/${newestFile} changed after that — restart ${BOT_NAME} on the patched tree, then re-run bench (connect-check law)`
    );
  }
  return status;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`bench :: ${BOT_NAME}:${PORT} :: ${new Date().toISOString()}`);
  console.log('---');

  let start;
  try {
    start = await preflight();
  } catch (err) {
    record('preflight', false, err.message);
    return finish();
  }
  record('preflight', true, `${BOT_NAME} connected on port ${PORT} at ${fmtPos(start.pos)}, health=${start.health}, food=${start.food}, deathCount=${start.deathCount}`);

  const deathsBefore = start.deathCount ?? 0;
  let kit = { slots: new Map(), missing: new Map(), borrowed: new Map() };

  try {
    await apiPost('/stop', {}).catch(() => {});
    await chat('bench: pre-blink checklist starting, fetching a test kit from chest A');

    await travelTo(CHEST_A, { label: 'travel-to-chest-a', arriveRange: 3 });
    kit = await withdrawKit();
    // Food is a confound-remover, not a graded item — best-effort only.
    if (kit.slots.has('food')) await apiPost('/autoeat', { on: true }).catch(() => {});

    await chat('bench: kit in hand, walking south to the test yard');
    await travelTo(YARD, { label: 'travel-to-yard', arriveRange: 4 });
    const atYard = await apiGet('/status');
    record('yard-arrival', true, `at the test yard, ${dist2D(atYard.pos, YARD).toFixed(1)} blocks from (${YARD.x},~,${YARD.z}), standing at ${fmtPos(atYard.pos)} — ${dist2D(atYard.pos, CHEST_A).toFixed(0)} blocks from camp (200+ rule holds)`);

    // One task mutex per bot (state.currentTask) — a checklist item that times
    // out on this script's SIDE (waitTaskSettled gives up) can still leave the
    // actual task running server-side, which then 409s every subsequent item
    // as "busy" with nothing to do with their own merits. /stop before each
    // item is idempotent (a no-op task if nothing is running) and keeps one
    // item's timeout from cascading into every item after it.
    for (const test of [testGotoGroundTruth, testDigCollect, testCraftSingle, testPlaceVerify, testStaircase]) {
      await apiPost('/stop', {}).catch(() => {});
      await test(kit);
    }
  } catch (err) {
    record('checklist-aborted', false, `setup/travel failure: ${err.message}`);
  } finally {
    console.log('---');
    // Cleanup law, in order: bank what was borrowed, then kill the bench's own
    // task cleanly. The bot PROCESS is left running — this bench never started
    // it, so it is not the bench's to stop.
    try {
      await bankLeftovers(kit, ['oak_planks', ...STONE_FAMILY.map((s) => s.drop)]);
    } catch (err) {
      record('cleanup-bank-leftovers', false, `banking failed: ${err.message} — ${BOT_NAME} may still be carrying kit items`);
    }

    let final = null;
    try {
      await apiPost('/stop', {}).catch(() => {});
      await sleep(1000);
      final = await apiGet('/status');
      const stillRunning = final?.currentTask?.state === 'running';
      record('cleanup-task-stopped', !stillRunning, stillRunning
        ? `/stop sent but ${BOT_NAME} still reports a running task (${final.currentTask.kind}) — check it before the blink`
        : `${BOT_NAME}'s bench task is stopped (last task ${final?.currentTask?.kind ?? 'none'}: ${final?.currentTask?.state ?? 'none'}); bot process intentionally left running`);
    } catch (err) {
      record('cleanup-task-stopped', false, `could not confirm a clean stop: ${err.message}`);
    }

    // Death guard — the ruling's replacement for the old admin-built sealed
    // room. Nothing shelters the bot now except a peaceful server and the kit,
    // so the run says out loud whether that held: a death mid-run makes every
    // item after it suspect, and it is the trigger for hand-building a cobble
    // shelter from the kit before the next attempt.
    const deathsAfter = final?.deathCount;
    if (typeof deathsAfter !== 'number') {
      skipped('death-guard', `no final /status read, so the run's deathCount could not be compared against the ${deathsBefore} it started at`);
    } else {
      record('death-guard', deathsAfter === deathsBefore, deathsAfter === deathsBefore
        ? `deathCount unchanged at ${deathsAfter} across the whole run — no sealed space was needed`
        : `${BOT_NAME} died ${deathsAfter - deathsBefore}x during the run (deathCount ${deathsBefore} -> ${deathsAfter}) — every item after the death is suspect; re-run, and hand-build a cobble shelter from the kit first if the yard turns out to be hostile`);
    }
    await chat('bench: pre-blink checklist finished');
  }

  return finish();
}

function finish() {
  console.log('---');
  const passN = results.filter((r) => r.status === 'PASS').length;
  const failN = results.filter((r) => r.status === 'FAIL').length;
  const skipN = results.filter((r) => r.status === 'SKIP').length;
  let verdict;
  if (failN === 0 && skipN === 0) {
    verdict = 'ALL GREEN — bench pre-flight PASS, safe to ship';
  } else if (failN === 0) {
    verdict = `${skipN} SKIPPED, 0 failed — INCONCLUSIVE, ROLLOUT BLOCKED (a check that could not run is not a pass: stock ${CHEST_LABEL} / re-check the yard, then re-run)`;
  } else {
    verdict = `${failN} FAILURE(S)${skipN ? ` + ${skipN} skipped` : ''} — ROLLOUT BLOCKED, fix before shipping`;
  }
  console.log(`bench :: ${passN} pass / ${failN} fail / ${skipN} skip :: ${verdict}`);
  process.exit(failN === 0 && skipN === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`bench: fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
