#!/usr/bin/env node
// cave/bench.mjs — one-command pre-flight for the cavecrew runner/skills stack.
//
// Adapted from felcrew-mcp's bench/preflight.sh + bench/bench.sh (Tier-0 fixtures,
// EVALUATION.md doctrine): "grade with something that didn't do the work" (law 1).
// This script does NOT trust any task's own {reached:true} / {done:true} / self-
// reported diff. Every checklist item is graded from a SEPARATE ground-truth read
// (GET /status position, GET /status inventory, or a fresh /eval blockAt) taken by
// this script, before and after the task under test — never the task's own result
// object. That is the exact discipline our own commit 4725e84 ("movement:
// ground-truth reached verification + raw-walk fallback (goto false-success
// dragon)") had to retrofit onto /goto after it shipped without it: /goto used to
// resolve {reached:true} while bot.entity.position hadn't moved at all (see
// FEEDBACK.md "goto false-'reached'" / "TORN-GOTO" entries, 2026-09-01). Bench
// exists so that class of bug is caught in one command before it reaches a driver.
//
// Spawns a disposable bot ("BenchMole", port 3295 — NOT a roster bot, never added
// to CIV.md), immediately relocates it 200+ blocks from every cavecrew/FEL base
// coordinate onto a small RCON-built platform (a fully sealed cobblestone shell
// around a lit, hollow interior — this world's real terrain at arbitrary
// coordinates is unpredictable and unloaded, so the bench force-loads the target
// chunks and builds its own known-good, fully-enclosed room rather than trusting
// whatever is already there, same reasoning as felcrew's bench/lib/common.sh
// build_platform), runs the checklist below, then kills the bot and erases the
// platform. Never lingers.
//
// Usage:
//   node cave/bench.mjs
//
// Exit code: 0 if every checklist item passes, 1 otherwise (setup/connect failure
// counts as a failed item too). Zero LLM tokens — pure node+RCON+HTTP.
//
// Checklist (each graded independently, see the philosophy note above):
//   1. goto ground-truth   — /goto 20 blocks away; verified via a fresh /status
//                            position read after an 800ms settle (EVALUATION.md
//                            law 1's own arrival definition), not the task's
//                            reached:true.
//   2. dig+collect cycle   — /mine 2x stone + /collect; verified via a cobblestone
//                            inventory diff computed from this script's own
//                            before/after /status snapshots.
//   3. craft single        — /craft 1x oak_planks (hand recipe, no batch>1 — see
//                            FEEDBACK.md's bot.craft(recipe,N>1) miscount entry);
//                            verified via this script's own inventory diff, cross-
//                            checked against (never substituted by) the task's own
//                            before/after/gained fields.
//   4. place+verify        — /eval places 1 cobblestone next to the bot, referenced
//                            purely via Vec3 instance methods (offset/minus — no
//                            Vec3 constructor is in /eval scope); verified via a
//                            SEPARATE /eval blockAt read afterward.
//   5. staircase 4-level   — /staircase toY:-4; verified via this script's own
//                            position.y before/after diff, independent of the
//                            engine's internal net-descent watchdog.
//
// This file intentionally does not import skills.js/runner.js/movement.js — it is
// a black-box HTTP+RCON client, same as a driver would be, so it can never end up
// "grading itself" with the code under test.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRconChat } from './rconchat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.dirname(__dirname);
const SPAWN_PATH = path.join(__dirname, 'spawn.mjs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BOT_NAME = 'BenchMole';
const PORT = 3295; // inside cavecrew's 3200-3299 range (CIV.md), not a roster slot

// Platform: a fully SEALED stone shell (floor + ceiling + 1-block-thick walls
// on all 4 sides), with a lit hollow interior. Centered far from every base in
// CIV.md (camp ~11,89,56; trading post ~7,112,22; FEL base ~-3,111,4) and far
// from the live fleet's current wander range (checked live: nearest bot was Zug
// at -32,116,101) — every one of those is 250+ blocks from this box, comfortably
// clearing the 200-block rule. This is x300-339,z300-311 coordinates NEVER
// visited before, i.e. unloaded/ungenerated chunks — found live, the hard way,
// on the first real run: a floor+ceiling-only design (air fill over the same
// footprint as the stone floor, no side walls) leaves the interior OPEN on all
// 4 sides to whatever the freshly-generated surrounding terrain happens to be.
// That first run's BenchMole took fatal unexplained damage and died mid-goto
// (health 20 -> dead in under 90s with no combat logged) — consistent with the
// "air pocket" actually being a doorway into an unexplored cave system, not an
// enclosed room. Fix: fully enclose the interior in solid stone on every side,
// independent of whatever the outside terrain turns out to be (same reasoning
// as felcrew's own build_platform note: "this world's real terrain at arbitrary
// coordinates is unpredictable... build your own rather than trusting it" —
// that note was about the FLOOR; it turns out to apply to every side, not just
// the floor).
const PX0 = 300, PX1 = 339; // outer shell x range (40 wide)
const PZ0 = 300, PZ1 = 311; // outer shell z range (12 wide)
const PY_FLOOR_TOP = 79;    // shell floor top is at y79 (feet stand at y80)
const PY_SHELL_BASE = 40;
const PY_SHELL_TOP = 85;    // the whole outer box, solid, y40..85
const IX0 = PX0 + 1, IX1 = PX1 - 1; // interior (hollowed, walled on all sides)
const IZ0 = PZ0 + 1, IZ1 = PZ1 - 1;
const PY_AIR0 = PY_FLOOR_TOP + 1, PY_AIR1 = PY_SHELL_TOP - 2; // hollow air, walled
const PY_GLOW = PY_SHELL_TOP - 1; // lit ceiling layer INSIDE the shell (interior footprint only)

// Shell material is COBBLESTONE, deliberately NOT "stone" — found live: an
// all-stone shell means the dig-collect checklist item's /mine {block:'stone'}
// happily tunnels through the room's own floor/ceiling chasing more "stone" to
// mine (confirmed live: drops turned up at y93-94, ~9-14 blocks above/outside
// the sealed shell — the bot mined its own way out through the roof). Cobble
// doesn't match a 'stone' search, so the shell itself is dig-test-proof; a
// small dedicated DIG_PATCH below gives the dig-collect item real 'stone' to
// mine without any risk of breaching the room.
const DIG_PATCH = [
  { x: 324, y: PY_FLOOR_TOP, z: 306 },
  { x: 325, y: PY_FLOOR_TOP, z: 306 },
  { x: 326, y: PY_FLOOR_TOP, z: 306 },
]; // 1 block off the goto/dig travel line (z+1) — close enough for /mine's
   // search radius near GOTO_TARGET, but not sitting directly under it, so it
   // doesn't collide with waitWorldLoaded()'s cobblestone floor-load check at
   // GOTO_TARGET itself.

const HOME = { x: 305, y: 80, z: 305 };
const GOTO_TARGET = { x: 325, y: 80, z: 305 }; // 20 blocks east of HOME
const PLACE_STAND = { x: 315, y: 80, z: 305 };
const STAIR_START = { x: 305, y: 80, z: 308 }; // z+3 off the goto/dig line
const STAIR_DIRECTION = 'east';
const STAIR_LEVELS = 4;

const SETTLE_MS = 800; // EVALUATION.md law 1's own arrival-settle window
const CONNECT_TIMEOUT_MS = 30000;
const TASK_TIMEOUT_MS = 60000;
// goto's own internal retry loop (gotoLoopPf) can eat its whole timeoutMs
// PER ATTEMPT before reporting anything (observed live: "attempt 1/5 failed
// (timed out after 60000ms)"), so a goto's timeoutMs must stay well under
// this script's own poll deadline for it, or the poll gives up on a task
// that's still legitimately retrying. Kept short on purpose — DRIVER_GUIDE's
// own default is 45000; this is a smoke test on flat open ground, a real
// arrival should be fast once chunks are loaded (see the chunk-settle note
// in relocateAwayFromBases).
const GOTO_TIMEOUT_MS = 25000;
const GOTO_POLL_TIMEOUT_MS = 40000;
const STAIRCASE_TIMEOUT_MS = 150000;
const POLL_MS = 1200;

// ---------------------------------------------------------------------------
// tiny HTTP + RCON helpers
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

async function apiPost(pathname, body, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let rcon = null;
async function rconSend(cmd) {
  if (!rcon) rcon = createRconChat();
  return rcon.send(cmd);
}

// ---------------------------------------------------------------------------
// process management (reuses spawn.mjs — bench never reimplements bot lifecycle)
// ---------------------------------------------------------------------------

function spawnBotProcess() {
  try {
    execFileSync(process.execPath, [SPAWN_PATH, 'stop', BOT_NAME], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch {
    // no stale BenchMole — fine, this is best-effort idempotency
  }
  execFileSync(process.execPath, [SPAWN_PATH, 'start', BOT_NAME, String(PORT)], { cwd: REPO_ROOT, stdio: 'pipe' });
}

function stopBotProcess() {
  try {
    execFileSync(process.execPath, [SPAWN_PATH, 'stop', BOT_NAME], { cwd: REPO_ROOT, stdio: 'pipe' });
    return true;
  } catch (err) {
    console.error(`bench: spawn.mjs stop ${BOT_NAME} failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

async function waitConnected(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = await apiGet('/status');
      if (st?.connected) return st;
    } catch {
      // process may not be listening yet
    }
    await sleep(POLL_MS);
  }
  throw new Error(`bot did not report connected:true within ${timeoutMs}ms`);
}

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
async function evalCode(code, timeoutMs = 30000) {
  const resp = await apiPost('/eval', { code }, 15000);
  if (resp.body?.error) return { error: resp.body.error };
  if (!resp.body?.note) return resp.body?.result ?? null;
  const status = await waitTaskSettled(timeoutMs);
  if (status?.currentTask?.state === 'failed') return { error: status.currentTask.result?.error };
  return status?.currentTask?.result ?? null;
}

// x300+/z300+ is coordinate space nobody has ever visited — freshly generated,
// freshly streamed to BenchMole's client. Found live: issuing a goto right
// after RCON confirms the bot's OWN position lands there is not the same fact
// as the surrounding chunk data having arrived — a goto issued too early
// resolved "success" instantly with zero actual movement (caught by the
// engine's own false-reach retry, which then failed identically 5 times in a
// row, since the same missing-data condition triggered on every retry). This
// polls a fresh /eval blockAt read at each corner of the room the checklist
// actually uses, and only proceeds once every one of them reads back the real
// placed material — the strongest available signal that the bot's own world
// model, not just its reported position, has caught up.
async function waitWorldLoaded(timeoutMs = 20000) {
  const floorPoints = [HOME, GOTO_TARGET, PLACE_STAND, STAIR_START].map((p) => ({ x: p.x, y: p.y - 1, z: p.z }));
  const code = `
    const here = bot.entity.position.floored();
    const abs = (x, y, z) => here.offset(x - here.x, y - here.y, z - here.z);
    const pts = ${JSON.stringify(floorPoints)};
    return pts.map((p) => { const b = bot.blockAt(abs(p.x, p.y, p.z)); return b ? b.name : null; });
  `;
  const deadline = Date.now() + timeoutMs;
  let lastNames = null;
  while (Date.now() < deadline) {
    const result = await evalCode(code, 8000);
    if (Array.isArray(result)) {
      lastNames = result;
      if (result.every((n) => n === 'cobblestone')) return;
    }
    await sleep(1000);
  }
  throw new Error(`world data for the bench room never fully loaded within ${timeoutMs}ms (last floor-block read: ${JSON.stringify(lastNames)})`);
}

function inventoryMap(status) {
  const m = new Map();
  for (const it of status?.inventory ?? []) m.set(it.name, it.count);
  return m;
}

function countOf(status, name) {
  return inventoryMap(status).get(name) ?? 0;
}

function dist3D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

// ---------------------------------------------------------------------------
// checklist items — each returns { name, pass, detail }
// ---------------------------------------------------------------------------

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
  return pass;
}

// Internal repositioning hop — NOT a graded checklist item, but still
// ground-truth verified (a silent goto-dragon here would invalidate every
// test after it). Throws on failure so main() can abort cleanly.
async function gotoOrThrow(target, range = 1, label = 'reposition') {
  const { body } = await apiPost('/goto', { x: target.x, y: target.y, z: target.z, range, timeoutMs: GOTO_TIMEOUT_MS, engine: 'pf' });
  if (body?.error) throw new Error(`${label}: /goto rejected: ${body.error}`);
  const status = await waitTaskSettled(GOTO_POLL_TIMEOUT_MS);
  if (status?.currentTask?.state === 'failed') {
    throw new Error(`${label}: /goto task failed: ${status.currentTask.result?.error}`);
  }
  await sleep(SETTLE_MS);
  const after = await apiGet('/status');
  const d = dist3D(after.pos, target);
  if (d > range + 1.5) throw new Error(`${label}: ground-truth position after settle is ${d.toFixed(2)} blocks from target (want <= ${range + 1.5})`);
  return after;
}

async function testGotoGroundTruth() {
  const name = 'goto-ground-truth';
  try {
    const { body } = await apiPost('/goto', {
      x: GOTO_TARGET.x, y: GOTO_TARGET.y, z: GOTO_TARGET.z, range: 1, timeoutMs: GOTO_TIMEOUT_MS, engine: 'pf',
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
    const d = dist3D(after.pos, GOTO_TARGET);
    const arrived = d <= 1 + 1.5;

    if (claimedReached && !arrived) {
      return record(name, false, `GOTO-DRAGON: task claimed reached:true but ground-truth position is ${d.toFixed(2)} blocks from target (pos=${JSON.stringify(after.pos)}) — false success`);
    }
    if (!arrived) {
      return record(name, false, `did not arrive: ${d.toFixed(2)} blocks from target after ${SETTLE_MS}ms settle (task claimed reached=${claimedReached})`);
    }
    return record(name, true, `arrived within ${d.toFixed(2)} blocks of a 20-block target (task claimed reached=${claimedReached}, ground-truth agrees)`);
  } catch (err) {
    return record(name, false, `exception: ${err.message}`);
  }
}

async function testDigCollect() {
  const name = 'dig-collect-cycle';
  try {
    const before = await apiGet('/status');
    const cobbleBefore = countOf(before, 'cobblestone');

    // maxDistance kept tight on purpose — found live: the sealed room's
    // ceiling is only ~6 blocks above the interior floor from the REAL
    // (natural, unmodified) terrain's own stone starting again above y85, and
    // mineBlocks' search isn't confined to "inside bench's box", so a generous
    // maxDistance let it repeatedly target natural stone it could see but not
    // physically path to (60s of "No path to the goal!"/"unreachable"), never
    // reaching DIG_PATCH just 1-2 blocks away. 5 safely excludes that exterior
    // stone (~6.6 blocks away) while covering DIG_PATCH with room to spare for
    // ordinary goto-arrival slop.
    const mineResp = await apiPost('/mine', { block: 'stone', count: 2, maxDistance: 5 });
    if (mineResp.body?.error) return record(name, false, `/mine rejected: ${mineResp.body.error}`);
    let status = await waitTaskSettled(TASK_TIMEOUT_MS);
    if (status?.currentTask?.state === 'failed') {
      return record(name, false, `/mine task failed: ${status.currentTask.result?.error}`);
    }

    const collectResp = await apiPost('/collect', { radius: 16 });
    if (collectResp.body?.error) return record(name, false, `/collect rejected: ${collectResp.body.error}`);
    status = await waitTaskSettled(TASK_TIMEOUT_MS);
    if (status?.currentTask?.state === 'failed') {
      return record(name, false, `/collect task failed: ${status.currentTask.result?.error}`);
    }

    await sleep(SETTLE_MS);
    const after = await apiGet('/status');
    const cobbleAfter = countOf(after, 'cobblestone');
    const diff = cobbleAfter - cobbleBefore;
    if (diff < 2) {
      return record(name, false, `cobblestone diff is ${diff} (want >= 2) — before=${cobbleBefore} after=${cobbleAfter}, this script's own /status snapshots, not the task's self-report`);
    }
    return record(name, true, `cobblestone +${diff} (this script's own before/after /status diff, mineBlocks/collectDrops self-reports not consulted for the verdict)`);
  } catch (err) {
    return record(name, false, `exception: ${err.message}`);
  }
}

async function testCraftSingle() {
  const name = 'craft-single';
  try {
    const before = await apiGet('/status');
    const planksBefore = countOf(before, 'oak_planks');

    const resp = await apiPost('/craft', { item: 'oak_planks', amount: 1 });
    if (resp.body?.error) return record(name, false, `/craft rejected: ${resp.body.error}`);
    const status = await waitTaskSettled(TASK_TIMEOUT_MS);
    if (status?.currentTask?.state === 'failed') {
      return record(name, false, `/craft task failed: ${status.currentTask.result?.error}`);
    }
    const selfReport = status?.currentTask?.result;

    await sleep(SETTLE_MS);
    const after = await apiGet('/status');
    const planksAfter = countOf(after, 'oak_planks');
    const diff = planksAfter - planksBefore;

    const agrees = !selfReport || selfReport.gained === undefined || selfReport.gained === diff;
    const note = agrees ? '' : ` (NOTE: task self-reported gained=${selfReport.gained}, this script's own diff is ${diff} — disagreement is itself a finding, not just noise)`;

    if (diff < 4) {
      return record(name, false, `oak_planks diff is ${diff} (want >= 4 from 1 oak_log) — before=${planksBefore} after=${planksAfter}${note}`);
    }
    return record(name, true, `oak_planks +${diff} (this script's own diff${note || '; agrees with the task self-report'})`);
  } catch (err) {
    return record(name, false, `exception: ${err.message}`);
  }
}

async function testPlaceVerify() {
  const name = 'place-verify';
  try {
    await gotoOrThrow(PLACE_STAND, 1, `${name}: move to stand`);

    // Everything below is built from bot.entity.position via .offset()/.minus()
    // — /eval's scope has bot/mcData/skills/log only, no bare Vec3 constructor,
    // same constraint felcrew's own fixtures work under.
    const placeCode = `
      const feet = bot.entity.position.floored();
      const refPos = feet.offset(1, -1, 0);
      const targetPos = feet.offset(1, 0, 0);
      const refBlock = bot.blockAt(refPos);
      if (!refBlock) return { error: 'no reference block at ' + JSON.stringify(refPos) };
      const item = bot.inventory.items().find((it) => it.name === 'cobblestone');
      if (!item) return { error: 'no cobblestone in inventory to place' };
      await bot.equip(item, 'hand');
      const face = targetPos.minus(refPos);
      await bot.placeBlock(refBlock, face);
      return { targetPos: { x: targetPos.x, y: targetPos.y, z: targetPos.z } };
    `;
    const placeResult = await evalCode(placeCode);
    if (placeResult?.error) return record(name, false, `place /eval failed: ${placeResult.error}`);
    const targetPos = placeResult?.targetPos;
    if (!targetPos) return record(name, false, `place /eval returned no targetPos: ${JSON.stringify(placeResult)}`);

    await sleep(SETTLE_MS);

    // Independent second witness: a FRESH /eval call reading blockAt at the
    // recorded absolute target position — not the placement call's own resolved
    // promise (law 1 — a verifier reading the world, not trusting the actor
    // that just acted). Built the same offset-from-current-position way, since
    // /eval scope has no bare Vec3 constructor.
    const verifyCode = `
      const here = bot.entity.position.floored();
      const target = here.offset(${targetPos.x} - here.x, ${targetPos.y} - here.y, ${targetPos.z} - here.z);
      const b = bot.blockAt(target);
      return { name: b ? b.name : null };
    `;
    const verifyResult = await evalCode(verifyCode);
    if (verifyResult?.error) return record(name, false, `verify /eval failed: ${verifyResult.error}`);
    const placedName = verifyResult?.name;
    if (placedName !== 'cobblestone') {
      return record(name, false, `independent verify read block "${placedName}" at ${JSON.stringify(targetPos)} (want "cobblestone") — place call's own promise resolving is not trusted here`);
    }
    return record(name, true, `independent /eval read confirms cobblestone at ${JSON.stringify(targetPos)} (separate call from the one that placed it)`);
  } catch (err) {
    return record(name, false, `exception: ${err.message}`);
  }
}

async function testStaircase() {
  const name = 'staircase-4level';
  try {
    await gotoOrThrow(STAIR_START, 1, `${name}: move to start`);

    const before = await apiGet('/status');
    const startY = before.pos.y;
    const toY = Math.floor(startY) - STAIR_LEVELS;

    const resp = await apiPost('/staircase', { toY, direction: STAIR_DIRECTION }, 10000);
    if (resp.body?.error) return record(name, false, `/staircase rejected: ${resp.body.error}`);
    const status = await waitTaskSettled(STAIRCASE_TIMEOUT_MS);
    const taskFailed = status?.currentTask?.state === 'failed';

    await sleep(SETTLE_MS);
    const after = await apiGet('/status');
    const netDrop = startY - after.pos.y;

    // Ground truth is the position diff this script itself took, not the
    // engine's internal net-descent watchdog (which only guards against
    // in-place grinding, it doesn't grade the task as done/not-done) and not
    // task.state alone (a task can report 'done' on a partial/short descent).
    if (netDrop < STAIR_LEVELS - 1) {
      return record(name, false, `net Y-drop is ${netDrop.toFixed(2)} (want >= ${STAIR_LEVELS - 1}) — startY=${startY.toFixed(2)} endY=${after.pos.y.toFixed(2)}, task ${taskFailed ? 'also reported failed: ' + status.currentTask.result?.error : 'reported done'}`);
    }
    return record(name, true, `net Y-drop ${netDrop.toFixed(2)} over a ${STAIR_LEVELS}-level request (this script's own before/after /status.pos.y, not the engine's internal watchdog)`);
  } catch (err) {
    return record(name, false, `exception: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// setup / cleanup
// ---------------------------------------------------------------------------

// RCON /fill silently does NOTHING but reply "That position is not loaded" on
// chunks nobody has a reason to have loaded — found live: this coordinate
// space has no player/entity anywhere near it, buildPlatform() runs before
// BenchMole ever connects, so every fill in this function failed silently
// this way until forceload was added below. rconSend() itself doesn't
// validate responses (it's a generic RCON transport), so every write in this
// function checks its own response instead of trusting the round-trip
// completed — the same "don't trust the layer below" discipline as the
// checklist items, just applied to bench's own setup.
async function rconFill(cmd) {
  const resp = await rconSend(cmd);
  // "No blocks were filled" is a legitimate success (the target region
  // already matched, e.g. re-running bench right after a manual RCON probe
  // of the same area) — only a genuine refusal (chunk not loaded, fill too
  // large, syntax error, etc.) should fail this.
  if (!/^(Successfully filled|No blocks were filled)/.test(String(resp))) {
    throw new Error(`RCON fill did not report success: "${cmd}" -> "${resp}"`);
  }
  return resp;
}

async function buildPlatform() {
  // 0. Force the target chunks loaded FIRST — see the rconFill note above.
  //    Vanilla /fill refuses to touch a chunk nobody has a reason to have
  //    loaded; forceload is the one admin lever that doesn't require an
  //    entity to physically be there first.
  await rconSend(`forceload add ${PX0} ${PZ0} ${PX1} ${PZ1}`);
  // 1. Solid outer shell — the WHOLE box, no interior yet. Cobblestone, not
  //    stone (see the DIG_PATCH comment above) — guarantees full enclosure
  //    regardless of what the real (unvisited) terrain out there turns out to
  //    be, and is immune to a 'stone'-type dig search.
  await rconFill(`fill ${PX0} ${PY_SHELL_BASE} ${PZ0} ${PX1} ${PY_SHELL_TOP} ${PZ1} minecraft:cobblestone`);
  // 2. Carve the interior hollow — 1 block in from every outer face, so a
  //    full-thickness wall/floor/ceiling remains on all 6 sides.
  await rconFill(`fill ${IX0} ${PY_AIR0} ${IZ0} ${IX1} ${PY_AIR1} ${IZ1} minecraft:air`);
  // 3. A lit ceiling layer, interior footprint only — full light throughout
  //    the sealed room regardless of what's outside, so nothing can spawn in
  //    it for the few minutes this takes (belt-and-suspenders on top of the
  //    sealing itself).
  await rconFill(`fill ${IX0} ${PY_GLOW} ${IZ0} ${IX1} ${PY_GLOW} ${IZ1} minecraft:glowstone`);
  // 4. The dig-collect checklist item's actual target: real 'stone' blocks,
  //    flush with the floor, small and bounded (see DIG_PATCH comment above).
  for (const p of DIG_PATCH) {
    await rconSend(`setblock ${p.x} ${p.y} ${p.z} minecraft:stone`);
  }
}

async function erasePlatform() {
  try {
    await rconFill(`fill ${PX0} ${PY_SHELL_BASE} ${PZ0} ${PX1} ${PY_SHELL_TOP} ${PZ1} minecraft:air`);
  } catch (err) {
    console.error(`bench: erasePlatform failed (manual cleanup may be needed at x${PX0}-${PX1} z${PZ0}-${PZ1} y${PY_SHELL_BASE}-${PY_SHELL_TOP}): ${err.message}`);
  } finally {
    // Always release the forceload, even if the erase-fill itself failed —
    // an un-erased box is a visible, fixable problem; a permanently
    // force-loaded chunk range pinning server resources forever is not.
    await rconSend(`forceload remove ${PX0} ${PZ0} ${PX1} ${PZ1}`).catch((err) => {
      console.error(`bench: forceload remove failed (chunks x${PX0}-${PX1} z${PZ0}-${PZ1} may still be pinned): ${err.message}`);
    });
  }
}

async function provisionKit() {
  await rconSend(`give ${BOT_NAME} minecraft:stone_pickaxe 2`);
  await rconSend(`give ${BOT_NAME} minecraft:oak_log 4`);
  await rconSend(`give ${BOT_NAME} minecraft:cobblestone 4`);
  // Food buffer, same reasoning as EVALUATION.md's C1 provisioning note this
  // adopts from felcrew: isolate the axis actually being measured (the five
  // checklist items) from an irrelevant confound (starvation/no-food-to-heal).
  await rconSend(`give ${BOT_NAME} minecraft:cooked_beef 8`);
}

async function relocateAwayFromBases() {
  // "IMMEDIATELY walked/kept 200+ blocks from all bases" — the very first thing
  // done to a freshly connected BenchMole, before any inventory setup or task.
  await rconSend(`tp ${BOT_NAME} ${HOME.x} ${HOME.y} ${HOME.z}`);
  const deadline = Date.now() + 10000;
  let confirmed = null;
  while (Date.now() < deadline) {
    const st = await apiGet('/status').catch(() => null);
    if (st?.pos && dist3D(st.pos, HOME) < 3) { confirmed = st; break; }
    await sleep(500);
  }
  if (!confirmed) throw new Error(`relocate: BenchMole position never confirmed near HOME (${JSON.stringify(HOME)})`);
  // Chunk-settle: the bot's OWN reported position confirming above is not the
  // same fact as its world model having the surrounding (freshly generated,
  // never-before-visited) chunk data. See waitWorldLoaded()'s header comment —
  // found live, a goto issued right after the position-confirm above raced
  // that stream and resolved "success" with zero actual movement.
  await waitWorldLoaded();
  return confirmed;
}

async function verifyGone() {
  const deadline = Date.now() + 15000;
  let last = '';
  while (Date.now() < deadline) {
    last = await rconSend('list').catch((e) => `<rcon error: ${e.message}>`);
    if (!String(last).includes(BOT_NAME)) return { gone: true, detail: last };
    await sleep(1500);
  }
  return { gone: false, detail: last };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`bench :: ${BOT_NAME}:${PORT} :: ${new Date().toISOString()}`);
  console.log('---');

  let connected = false;
  try {
    await buildPlatform();
    spawnBotProcess();
    await waitConnected(CONNECT_TIMEOUT_MS);
    connected = true;
    record('connect', true, `${BOT_NAME} connected on port ${PORT}`);

    await relocateAwayFromBases();
    await provisionKit();

    // One task mutex per bot (state.currentTask) — a checklist item that
    // times out on this script's SIDE (waitTaskSettled gives up) can still
    // leave the actual task running server-side, which then 409s every
    // subsequent item as "busy" with nothing to do with their own merits.
    // /stop before each item is idempotent (a no-op task if nothing is
    // running) and keeps one item's timeout from cascading into every item
    // after it.
    for (const test of [testGotoGroundTruth, testDigCollect, testCraftSingle, testPlaceVerify, testStaircase]) {
      await apiPost('/stop', {}).catch(() => {});
      await test();
    }
  } catch (err) {
    record(connected ? 'checklist-aborted' : 'connect', false, `setup/connect failure: ${err.message}`);
  } finally {
    console.log('---');
    const stopped = stopBotProcess();
    const gone = await verifyGone();
    record('cleanup-kill-verify-gone', stopped && gone.gone, gone.gone
      ? `RCON list confirms ${BOT_NAME} is gone: ${String(gone.detail).trim()}`
      : `RCON list STILL shows ${BOT_NAME} (or stop failed): ${String(gone.detail).trim()}`);
    await erasePlatform();
    if (rcon) await rcon.close();
  }

  console.log('---');
  const passN = results.filter((r) => r.pass).length;
  const failN = results.length - passN;
  const verdict = failN === 0 ? 'ALL GREEN — bench pre-flight PASS, safe to ship' : `${failN} FAILURE(S) — ROLLOUT BLOCKED, fix before shipping`;
  console.log(`bench :: ${passN}/${results.length} passed :: ${verdict}`);
  process.exit(failN === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`bench: fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
