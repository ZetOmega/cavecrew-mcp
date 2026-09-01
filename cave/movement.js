// cave/movement.js — engine-selectable movement layer.
//
// Two movement engines live behind one API:
//   'pf'  — mineflayer-pathfinder looping-goto. The original gotoLoop logic
//           from skills.js, moved here verbatim (same retry/backoff, same
//           cancel-safety comment). Cancel = bot.pathfinder.setGoal(null)
//           ONLY — bot.pathfinder.stop() sets an internal stopPathing flag
//           that silently discards the very next setGoal() call.
//   'ash' — @miner-org/mineflayer-baritone (bot.ashfinder), when the plugin
//           successfully loads. NOT installed in this repo's node_modules as
//           of this writing (confirmed absent from package.json + node_modules
//           by the researcher who wrote the notes below) — resolveAshfinder()
//           below degrades to "unavailable" cleanly when that's the case, and
//           every goTo() caller just gets pf. `npm install
//           @miner-org/mineflayer-baritone` (pinned to the researched 4.6.2,
//           declared in package.json) turns ash on with no further code
//           changes needed here.
//
// goTo(bot, {x,y,z,range,timeoutMs,engine}, ctx) is the one public entry
// point every caller should use. engine: 'auto' (default) tries ash first
// and falls back to pf on throw/timeout/unreachable, logging a quirk event
// on the way down; 'ash' and 'pf' pin to one engine only.
//
// ---------------------------------------------------------------------------
// Ashfinder gotchas encoded here on purpose (confirmed by direct source read
// of the installed package under minecraft-mcp-v2/node_modules — README
// disagrees with the real v4.6.2 code in several places noted below). Do not
// "simplify" these away:
//
// 1. goto()/gotoWithPath() ALWAYS resolve, never reject, except for two
//    synchronous throws (already-navigating, fly-without-elytra). An
//    unreachable goal, a search timeout, an exhausted stuck-loop — all of it
//    resolves {status:'success'} because an empty/partial path still counts
//    as "reached the end of the path" to the executor. NEVER trust goto()'s
//    own resolved status. The honest verdict lives in generatePath()'s own
//    `status` field ("found" | "partial" | "no path"). gotoAsh() below always
//    calls generatePath() first, bails on "no path", then runs
//    gotoWithPath() on the already-generated path (skips a second search),
//    then double-checks goal.isReached(bot.entity.position) itself — that
//    isReached() call is the only truth to trust, matching gotoSmart()'s own
//    (more honest) self-check pattern.
//
// 2. HANG WARNING — the big one. PathExecutor.stop() (what
//    AshFinderPlugin.stop() calls internally) clears controls but never
//    touches the completion promise; that promise only ever settles inside
//    _onPathEnd(), which the tick loop skips once executing=false. So: if
//    something calls bot.ashfinder.stop() while a goto()/gotoWithPath() await
//    is in flight, that await hangs forever — nothing rejects or resolves it.
//    Fix applied here: every ashfinder await in this file is wrapped in
//    raceWithCancelAndTimeout(), which races the real promise against (a) our
//    own timeoutMs watchdog and (b) a short poll of ctx.isCancelled(). The
//    wrapper always settles even if the underlying library promise never
//    does; we just stop awaiting it (per the library's own recommended
//    workaround — never re-await a goto() promise once something else has
//    called stop() on it) and let it dangle unobserved. cancelMovement()
//    below still calls the real bot.ashfinder.stop() (it's the only thing
//    that actually clears the bot's in-world controls/path state) — the race
//    is what keeps OUR caller from hanging on it.
//
// 3. Cancel APIs are NOT interchangeable between engines. ashfinder's own
//    cancel is bot.ashfinder.stop() (no args) — a completely different
//    library from mineflayer-pathfinder, with its own dedicated stop() that
//    really is the right call there (unlike pathfinder's stop(), which is the
//    one to avoid). Do not cross-wire the two.
//
// 4. Events: only 'stopped' and 'pathStarted' are ever actually emitted by
//    the installed v4.6.2 (grepped every `.emit(` in its src/ tree). The
//    README's 'goal-reach' / 'goal-reach-partial' / 'waypoint-reached' do not
//    exist in this version — nothing here listens for them.
// ---------------------------------------------------------------------------

import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

const { goals: pfGoals } = pathfinderPkg;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// THE DRAGON: bot.pathfinder.goto() lies about "success" — confirmed by
// direct source read of mineflayer-pathfinder's own lib/goto.js + index.js:
//   1. `noPathListener` in lib/goto.js calls cleanup() with NO error whenever
//      `results.path.length === 0` — an empty path (e.g. a no-dig Movements
//      search that can't find a single step forward from the start node)
//      resolves the promise as a SUCCESS, not a NoPath rejection.
//   2. index.js only ever fires 'goal_reached' by checking
//      `stateGoal.isEnd(bot.entity.position.floored())` — a FLOORED integer
//      node, not the bot's real continuous position. A goal whose floor cell
//      already contains the bot's start position (loose range, or a target
//      that floors into the same cell) fires goal_reached with zero actual
//      movement, on the very first physics tick.
// Both paths resolve the goto() promise as if the goal were reached even
// though the bot never moved. gotoLoopPf below never trusted the resolved
// promise alone again — every "success" gets ground-truthed against
// bot.entity.position before being believed.
//
// Returns null when `goal` doesn't expose enough of x/y/z to ground-truth
// (e.g. a pure GoalY) — callers should skip verification in that case.
//
// (CALIBRATION) horizDist/vertDist split out separately from the old single
// 3D `dist` — field logs (Grog + Bonk) showed the combined-3D check flagging
// a real, close success as a false-reach whenever a GoalNear had a vertical
// offset baked in (mining/staircase targets almost always do): a bot well
// within lateral range but 1+ block above/below the goal's y got its 3D dist
// inflated past range+0.75 by the y term alone. horizDist now carries the
// x/z-only distance (what the range margin is actually meant to gate), and
// vertDist carries the y-only distance, checked against its own generous
// fixed slack — see call sites below. `dist` (full 3D) is kept for the one
// caller that still wants a plain "how close is close enough to bother with
// rawWalkTo" heuristic, unrelated to the reached/not-reached verdict.
function goalGroundTruth(bot, goal) {
  if (typeof goal?.x !== 'number' && typeof goal?.z !== 'number') return null;
  const pos = bot.entity.position;
  // (REACH-GAP FIX) GoalGetToBlock extends Goal directly — it has NO rangeSq,
  // so this used to ground-truth it as range 0, making every downstream
  // margin check (false-reach at range+1.0, rawWalkTo's stop condition)
  // demand <=1.0h from the block CENTER. Physically impossible whenever the
  // target's adjacent cell isn't standable: a bot pressed flush against the
  // next wall bottoms out at 1.0 (cell) + 0.5 (center) + 0.3 (body radius)
  // = exactly the fixed 1.80h shortfall in every field log. "Stand adjacent"
  // semantics = an effective range of 1.5, which puts the margin checks at
  // 2.5h — and the dig itself is still gated separately by skills.js's
  // ensureWithinReach 4.2 eye-distance law, so this loosens nothing unsafe.
  let range = 0;
  if (typeof goal.rangeSq === 'number') range = Math.sqrt(goal.rangeSq);
  else if (pfGoals?.GoalGetToBlock && goal instanceof pfGoals.GoalGetToBlock) range = 1.5;
  let horizDistSq = 0;
  if (typeof goal.x === 'number') {
    const dx = pos.x - (goal.x + 0.5);
    horizDistSq += dx * dx;
  }
  if (typeof goal.z === 'number') {
    const dz = pos.z - (goal.z + 0.5);
    horizDistSq += dz * dz;
  }
  const horizDist = Math.sqrt(horizDistSq);
  const vertDist = typeof goal.y === 'number' ? Math.abs(pos.y - goal.y) : 0;
  return { dist: Math.hypot(horizDist, vertDist), horizDist, vertDist, range };
}

// CROP_BLOCK_NAMES — the single canonical source (FEEDBACK "A/B TEST
// RESULT: new crop-blocksToAvoid PASSES for /goto+pf, but /collect still
// tramples farmland", Zug). runner.js's Movements.blocksToAvoid (070661b)
// and skills.js's collectDrops pre-filter (d5e58fb) both consume this same
// array — movement.js is the shared module both already import (skills.js:
// `import * as movement from './movement.js'`, runner.js: same), and
// neither runner.js nor skills.js is imported back by movement.js, so this
// is the one place that isn't circular. Exported, not copy-pasted a 3rd
// time.
export const CROP_BLOCK_NAMES = ['wheat', 'carrots', 'potatoes', 'beetroots'];

// Floored cell one step from `pos` toward `targetPos`, horizontal only (y
// held at pos.y) — a cheap approximation of "the next block rawWalkTo's
// forward pulse is aimed at", good enough for a pre-pulse hazard check
// without simulating real movement physics.
function nextCellToward(pos, targetPos) {
  const dx = targetPos.x - pos.x;
  const dz = targetPos.z - pos.z;
  const mag = Math.hypot(dx, dz);
  if (mag < 0.001) return pos.floored();
  return new Vec3(pos.x + dx / mag, pos.y, pos.z + dz / mag).floored();
}

// Last-resort fallback once bot.pathfinder's own goto() has been caught
// false-reaching (or genuinely failing) across every retry AND the bot is
// still ground-truthed as actually close (<6 blocks — see call site).
// Bypasses pathfinder entirely: look at the target, pulse forward+jump in
// short (300ms) bursts, re-measuring real position after every pulse, until
// ground-truth horizontal distance clears range+1.0 (vertical within 1.5) or
// 15s elapses. Deliberately dumb
// (no obstacle avoidance, no digging) — only meant for the "goal is right
// there, pathfinder just isn't moving" case, never general navigation.
//
// (FIELD BUG, Zug 2026-09-01) "Deliberately dumb" used to mean "zero
// block-type awareness at all" too — pf's own move-generation correctly
// REFUSES a path onto a blocksToAvoid-flagged crop cell (that refusal is
// runner.js's crop-avoid Movements config working as designed), but this
// exact fallback exists BECAUSE pf attempts exhausted, and used to bulldoze
// straight over whatever pf had legitimately refused — undoing the
// protection for the one caller (collectDrops) whose own target can land
// on a crop cell by chance. Fixed here at the source instead of only at
// collectDrops' call site, so every gotoLoop caller gets the same
// guarantee: refuse rather than bulldoze onto a protected block, full stop.
async function rawWalkTo(bot, goal, range, ctx) {
  const targetPos = new Vec3(
    typeof goal.x === 'number' ? goal.x + 0.5 : bot.entity.position.x,
    typeof goal.y === 'number' ? goal.y : bot.entity.position.y,
    typeof goal.z === 'number' ? goal.z + 0.5 : bot.entity.position.z
  );
  const deadline = Date.now() + 15000;
  try {
    while (Date.now() < deadline) {
      if (ctx.isCancelled?.()) throw new Error('rawWalkTo: cancelled');
      if (ctx.isStaleGeneration?.()) throw new Error('rawWalkTo: stale generation');
      const check = goalGroundTruth(bot, goal);
      if (check && check.horizDist <= check.range + 1.0 && check.vertDist <= 1.5) return;
      // PROTECTED-BLOCK REFUSAL — checked fresh every pulse (position/
      // heading can shift between pulses), BEFORE touching the controls
      // below. Feet cell covers "already standing on one" (shouldn't
      // happen given this check, but cheap insurance against a pulse that
      // landed on one before this fix); the projected next cell covers
      // "about to step onto one".
      const feetName = bot.blockAt(bot.entity.position.floored())?.name;
      const aheadName = bot.blockAt(nextCellToward(bot.entity.position, targetPos))?.name;
      if (CROP_BLOCK_NAMES.includes(feetName) || CROP_BLOCK_NAMES.includes(aheadName)) {
        throw new Error(
          `rawWalkTo: refusing to bulldoze onto a protected block (feet=${feetName ?? '?'}, ahead=${aheadName ?? '?'}) — pf's own refusal stands, this fallback does not override it`
        );
      }
      // (LOOK-WAKE LAW, Thak 2026-09-01 — FEEDBACK "setControlState no-op
      // without preceding bot.look()") The forced look packet is what makes
      // the control toggles below actually take effect; bare setControlState
      // measured zero movement across 3 test batches until a forced look was
      // put in front of it. lookAt(pos, true) is that forced look, sent once
      // per pulse here — the fallback keeps the law satisfied on the pulses
      // where lookAt itself throws.
      try {
        await bot.lookAt(targetPos, true);
      } catch {
        try {
          await bot.look(bot.entity.yaw, bot.entity.pitch, true);
        } catch {
          // ignore — still attempt to walk even if both look forms fail
        }
      }
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await sleep(300);
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
    }
  } finally {
    try {
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
    } catch {
      // ignore
    }
  }
  const finalCheck = goalGroundTruth(bot, goal);
  if (!finalCheck || finalCheck.horizDist > finalCheck.range + 1.0 || finalCheck.vertDist > 1.5) {
    throw new Error(
      `rawWalkTo: still ${finalCheck ? `${finalCheck.horizDist.toFixed(2)}h/${finalCheck.vertDist.toFixed(2)}v` : '?'} blocks from goal after 15s raw-walk`
    );
  }
}

// Plain timeout race, no cancellation polling — this is the exact helper
// gotoLoopPf below used as skills.js's `withTimeout`, kept unchanged. The
// cancellation-aware version (raceWithCancelAndTimeout, further down) exists
// only for the ash engine, which has a real hang bug to work around (gotcha
// #2 in the file header); pf has no such bug, so gotoLoopPf keeps its
// original, already-proven-in-production behavior verbatim.
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Races `promise` against a timeout AND (when ctx.isCancelled is present) a
// short poll of ctx.isCancelled() — whichever settles first wins, and the
// loser is simply abandoned (never re-awaited). This is what lets an
// ashfinder call site survive a concurrent bot.ashfinder.stop() without
// hanging forever — see gotcha #2 above.
function raceWithCancelAndTimeout(promise, { timeoutMs, ctx, label }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poller) clearInterval(poller);
      fn(val);
    };
    const timer = setTimeout(() => finish(reject, new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    // Also polls ctx.isStaleGeneration() (set by runner.js — flips true the
    // instant the bot reconnects/relogs mid-task) so a promise tied to a bot
    // instance that no longer exists fails fast with a distinct message
    // instead of riding out the full timeoutMs. This is what actually fixes
    // the ash-executor-never-resolves-after-kick case: the underlying
    // library promise still never settles (gotcha #2 above), but we stop
    // waiting on it immediately once the generation moves on, same as we
    // already do for cancellation.
    const poller = ctx?.isCancelled || ctx?.isStaleGeneration
      ? setInterval(() => {
          if (ctx.isStaleGeneration?.()) {
            finish(reject, new Error(`${label} stale generation`));
            return;
          }
          if (ctx.isCancelled?.()) finish(reject, new Error(`${label} cancelled`));
        }, 200)
      : null;
    promise.then(
      (v) => finish(resolve, v),
      (err) => finish(reject, err)
    );
  });
}

// ---------------------------------------------------------------------------
// ashfinder module resolution + per-bot injection
// ---------------------------------------------------------------------------

let ashMod = null; // { loader, goals } once resolved, else null
let ashResolved = false;

// Resolve the @miner-org/mineflayer-baritone module ONCE per process and
// cache the result (success or permanent "unavailable"). Dynamic import on
// purpose: the package may not be installed at all (it currently isn't in
// this repo — see file header), and a static top-level `import` would throw
// MODULE_NOT_FOUND at module-evaluation time and take the whole runner
// process down with it. This never throws.
//
// Call this ONCE, before the first connect()/wireBot(), and await it — the
// bot's ashfinder object appears the instant loadPlugin(loader) runs, but its
// real engine (#pathExecutor) is only built inside the plugin's own internal
// bot.on('spawn', ...) handler. If loadAshfinderIntoBot() below ran AFTER a
// bot had already spawned, that internal handler would register too late and
// bot.ashfinder would look loaded but never actually work. Resolving the
// module before any connect() call, then injecting synchronously inside
// wireBot() (before mineflayer's own spawn fires), keeps that ordering safe
// on every connect AND every reconnect.
export async function resolveAshfinder(log) {
  if (ashResolved) return ashMod !== null;
  ashResolved = true;
  try {
    const mod = await import('@miner-org/mineflayer-baritone');
    const { loader, goals } = mod.default ?? mod;
    if (typeof loader !== 'function' || !goals) {
      throw new Error('unexpected export shape from @miner-org/mineflayer-baritone (expected {loader, goals})');
    }
    ashMod = { loader, goals };
    log?.('info', 'ashfinder module resolved (@miner-org/mineflayer-baritone)');
    return true;
  } catch (err) {
    ashMod = null;
    log?.('warn', `ashfinder module not available, all goTo calls will use pathfinder: ${err?.message ?? err}`);
    return false;
  }
}

// Synchronous. Safe to call inside wireBot() right before mineflayer's own
// b.once('spawn', ...) registration, as long as resolveAshfinder() above has
// already finished (it has, by construction — see runner.js). Never throws.
export function loadAshfinderIntoBot(bot, log) {
  if (!ashMod) return false;
  try {
    bot.loadPlugin(ashMod.loader);
    log?.('info', 'ashfinder plugin loaded onto bot (@miner-org/mineflayer-baritone)');
    return true;
  } catch (err) {
    log?.('warn', `ashfinder plugin failed to load onto bot, this bot will use pathfinder only: ${err?.message ?? err}`);
    return false;
  }
}

// Whether the module itself resolved successfully (process-wide). For a
// specific bot's actual usability, prefer ashAvailable(bot) below — it also
// covers "plugin loaded but bot hasn't spawned yet" and "loadPlugin call on
// this particular bot instance failed".
export function ashfinderLoaded() {
  return ashMod !== null;
}

function ashAvailable(bot) {
  // bot.ashfinder appears the instant the loader runs, but its real engine
  // is only built on spawn (see resolveAshfinder's comment above) — gate on
  // bot.entity too, which mineflayer itself only sets once spawned.
  return !!(bot && bot.ashfinder && bot.entity);
}

// ---------------------------------------------------------------------------
// per-bot "which engine is this bot's in-flight goTo() actually using"
// tracking, so cancelMovement() knows which cancel call to reach for.
// ---------------------------------------------------------------------------

// Value is a per-run token object ({ engine: 'ash' | 'pf' }), not a bare
// string: identity comparison lets a superseded (force-cancelled) run tell
// "the registration is still mine" apart from "a newer run has already
// claimed this bot" — so a stale run never deletes the new run's
// registration, and never fires a cleanup stop() into the new run's path.
const activeEngineByBot = new WeakMap();

// ---------------------------------------------------------------------------
// pf engine
// ---------------------------------------------------------------------------

// The original gotoLoop from skills.js, moved here verbatim. Cancel =
// bot.pathfinder.setGoal(null) ONLY (see file header) — never
// bot.pathfinder.stop().
export async function gotoLoopPf(bot, goal, opts = {}, ctx = {}) {
  const timeoutMs = opts.timeoutMs ?? 45000;
  const maxAttempts = opts.maxAttempts ?? 5;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (ctx.isCancelled?.()) {
      throw new Error('gotoLoopPf: cancelled');
    }
    // Bot reconnected/relogged out from under this run (generation bumped in
    // runner.js) — the bot.pathfinder.goto() promise below is bounded by
    // timeoutMs already so this isn't a hang risk like ash, but there's no
    // reason to burn further retries against a stale bot instance.
    if (ctx.isStaleGeneration?.()) {
      throw new Error('gotoLoopPf: stale generation');
    }
    try {
      await withTimeout(bot.pathfinder.goto(goal), timeoutMs);
      // (FIELD BUG, Grog 2026-09-01 — FEEDBACK "goto false-reach reports
      // IDENTICAL stale distance from different positions") The false-reach
      // check reported the EXACT same "9.30 blocks horiz / 3.00 vert" from
      // two genuinely different bot positions, which no live measurement can
      // do. The position source itself is live (goalGroundTruth reads
      // bot.entity.position at call time) — what is not live is `bot` after a
      // mid-task reconnect: the old bot object stops receiving position
      // updates the moment the runner builds a new one, so every later read
      // returns the same frozen coordinates. Re-check the generation the
      // instant goto() settles, BEFORE ground-truthing, so a stale bot's
      // frozen position can never produce a false-reach verdict (or a retry
      // burnt against a zombie).
      if (ctx.isStaleGeneration?.()) throw new Error('gotoLoopPf: stale generation');
      // DRAGON GUARD: goto() resolving is not proof the bot moved (see the
      // goalGroundTruth comment above) — ground-truth it before trusting it.
      // (CALIBRATION) horizontal-only margin vs range+1.0, vertical checked
      // separately within 1.5 — the old combined-3D check vs range+0.75 was
      // flagging real near-goal successes as false (Grog/Bonk field logs:
      // "resolved success but bot is X blocks from goal" firing when the
      // bot was actually <1 block away, and a vertical-offset GoalNear got
      // its y term double-counted into the same margin as range).
      const check = goalGroundTruth(bot, goal);
      if (check && (check.horizDist > check.range + 1.0 || check.vertDist > 1.5)) {
        lastErr = new Error(
          `false-reached caught: goto resolved success but bot is ${check.horizDist.toFixed(2)} blocks horiz / ${check.vertDist.toFixed(2)} vert from goal (range ${check.range})`
        );
        ctx.log?.('warn', `gotoLoopPf: ${lastErr.message}`);
        try {
          bot.pathfinder.setGoal(null);
        } catch {
          // ignore
        }
        if (attempt < maxAttempts) await sleep(300);
        continue;
      }
      return;
    } catch (err) {
      lastErr = err;
      ctx.log?.('warn', `gotoLoopPf: attempt ${attempt}/${maxAttempts} failed (${err?.message}); re-issuing`);
      // Cancel via setGoal(null) ONLY. bot.pathfinder.stop() sets an internal
      // stopPathing flag that silently nulls out the *next* setGoal() call —
      // never call it here.
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        // ignore
      }
      if (attempt < maxAttempts) await sleep(300);
    }
  }
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    // ignore
  }

  // Same stale guard as inside the loop, and for the same reason: the
  // rawWalkTo fallback below both READS position (to decide whether the goal
  // is close enough to be worth hand-walking to) and DRIVES the bot. Neither
  // is meaningful on a superseded bot instance — its position is frozen, and
  // its controls belong to a connection the runner has already replaced.
  if (ctx.isStaleGeneration?.()) throw new Error('gotoLoopPf: stale generation');

  // Every retry either false-reached or genuinely failed. If the bot is
  // still ground-truthed as actually close, pathfinder itself is the thing
  // lying (or stuck on a no-dig-unreachable short hop) — bypass it by hand
  // rather than give up on a goal that's right there.
  const finalCheck = goalGroundTruth(bot, goal);
  if (finalCheck && finalCheck.dist < 6) {
    try {
      await rawWalkTo(bot, goal, finalCheck.range, ctx);
      return;
    } catch (rawErr) {
      lastErr = rawErr;
    }
  }

  throw new Error(`gotoLoopPf: failed after ${maxAttempts} attempts: ${lastErr?.message ?? 'unknown error'}`);
}

async function runPf(bot, { x, y, z, range, timeoutMs }, ctx) {
  if (ctx.isStaleGeneration?.()) throw new Error('goTo: stale generation');
  const token = { engine: 'pf' };
  activeEngineByBot.set(bot, token);
  try {
    const goal = new pfGoals.GoalNear(x, y, z, range);
    await gotoLoopPf(bot, goal, { timeoutMs, maxAttempts: 5 }, ctx);
    return { engine: 'pf', reached: true };
  } finally {
    if (activeEngineByBot.get(bot) === token) activeEngineByBot.delete(bot);
  }
}

// ---------------------------------------------------------------------------
// ash engine
// ---------------------------------------------------------------------------

async function gotoAsh(bot, goal, opts, ctx) {
  const timeoutMs = opts.timeoutMs ?? 45000;
  const { x: goalX, y: goalY, z: goalZ, range: goalRange } = opts;

  const planned = await raceWithCancelAndTimeout(bot.ashfinder.generatePath(goal), {
    timeoutMs,
    ctx,
    label: 'ashfinder generatePath',
  });
  if (planned.status === 'no path') {
    throw new Error('ashfinder: no path (goal unreachable)');
  }

  // gotoWithPath() runs the already-generated path — skips a second search.
  // Its own resolved status can't be trusted (see gotcha #1 in the file
  // header); the real check is goal.isReached() below.
  await raceWithCancelAndTimeout(bot.ashfinder.gotoWithPath(planned, goal), {
    timeoutMs,
    ctx,
    label: 'ashfinder gotoWithPath',
  });

  // isReached() right at the instant gotoWithPath() resolves can be a false
  // negative: the path executor calls itself done a tick or two before the
  // bot's own physics has finished settling into its final resting spot
  // (observed live on an uphill GoalNear finish — bot measured ~2.46 blocks
  // out against a range of 2 the instant the promise settled, but was
  // sitting at ~1.9 blocks out, well inside range, one poll later with no
  // further movement). Give it a brief settle-and-recheck window instead of
  // trusting a single immediate sample — still fails fast (~750ms) on a
  // genuine miss, never masks one.
  let reached = typeof goal.isReached === 'function' ? goal.isReached(bot.entity.position) : true;
  for (let i = 0; !reached && i < 5 && !ctx.isCancelled?.() && !ctx.isStaleGeneration?.(); i++) {
    await sleep(150);
    reached = typeof goal.isReached === 'function' ? goal.isReached(bot.entity.position) : true;
  }
  // (ASH FALSE-FAIL FIX — FEEDBACK "ashfinder 'did not reach goal' fires
  // while already within requested range", Bonk 2026-09-01) ashfinder's own
  // GoalNear.isReached() folds horizontal AND vertical offset into one
  // combined-3D check with zero slack on either axis — the exact same shape
  // of bug goalGroundTruth() was built to fix on the pf side (see its
  // CALIBRATION note above): a bot well within lateral range but sitting a
  // block or so above/below the goal's y can get its 3D distance inflated
  // past range by the y term alone, even after the settle-retry loop above.
  // Can't reuse goalGroundTruth() itself here — ash's Goal hides x/y/z/range
  // behind a floored, private `_position` and a `.distance` field, not the
  // x/y/z/rangeSq shape pf goals expose — so redo the same horizDist/vertDist
  // split directly against the raw target the caller asked for (threaded in
  // via opts below). Same margins already proven safe at rawWalkTo's stop
  // condition (range+1.0 horizontal, 1.5 vertical) — never masks a genuine
  // miss, only catches the settle-loop's false negative.
  if (!reached && typeof goalX === 'number' && typeof goalZ === 'number' && typeof goalRange === 'number') {
    const pos = bot.entity.position;
    const horizDist = Math.hypot(pos.x - (goalX + 0.5), pos.z - (goalZ + 0.5));
    const vertDist = typeof goalY === 'number' ? Math.abs(pos.y - goalY) : 0;
    if (horizDist <= goalRange + 1.0 && vertDist <= 1.5) reached = true;
  }
  if (!reached) {
    throw new Error(`ashfinder: did not reach goal after gotoWithPath (search status was "${planned.status}")`);
  }
  return { engine: 'ash', reached: true, searchStatus: planned.status };
}

async function runAsh(bot, { x, y, z, range, timeoutMs }, ctx) {
  if (ctx.isStaleGeneration?.()) throw new Error('goTo: stale generation');
  if (!ashAvailable(bot)) {
    throw new Error('goTo: bot.ashfinder is not available (plugin not loaded, or bot not spawned yet)');
  }
  const token = { engine: 'ash' };
  activeEngineByBot.set(bot, token);
  try {
    const goal = new ashMod.goals.GoalNear(new Vec3(x, y, z), range);
    return await gotoAsh(bot, goal, { timeoutMs, x, y, z, range }, ctx);
  } catch (err) {
    // CRITICAL: on any ash failure — especially a raceWithCancelAndTimeout
    // timeout that abandoned a still-executing gotoWithPath() — the library's
    // PathExecutor is still driving the bot's controls (and self-replans
    // partial paths). Stop it before this error frees the task mutex or lets
    // goTo(auto) start pathfinder, or both engines fight over one bot.
    // Token-guarded so a stale superseded run never stops a newer run's path;
    // idempotent with cancelMovement()'s stop() on the cancellation path.
    if (activeEngineByBot.get(bot) === token) {
      try {
        bot.ashfinder.stop();
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    if (activeEngineByBot.get(bot) === token) activeEngineByBot.delete(bot);
  }
}

// ---------------------------------------------------------------------------
// HARD VERTICAL-DROP GUARD (chief 2026-09-01 — three fall incidents in one
// session: Grog's west-corridor 17-block drop, Ook's dripstone x2 including
// the HP20->2 near-death) — false-reach retries were riding the SAME fall
// out instead of catching it: Ook's own trace showed the reported gap
// GROWING between two consecutive false-reach checks ("30.83h/21.67v" then
// "32.64h/30.77v") — proof the bot kept falling between polls, not just
// landing off-target once. Every incident traced back to a plain goTo()
// call (pf and ash both) with no vertical-drop awareness at all.
//
// Runs for the lifetime of one goTo() call, sampling bot.entity every
// physicsTick — independent of which engine is driving, so it works
// uniformly for both black-box engine awaits (neither gotoLoopPf's
// bot.pathfinder.goto() nor gotoAsh's gotoWithPath() exposes per-tick
// control back to us). Trips on either signal:
//   - a single-tick y-drop > FALL_GUARD_TICK_JUMP: a position snap/
//     correction, the same shape as Ook's growing-gap trace, catchable
//     before velocity has even had time to build up;
//   - a cumulative drop since the last known-solid (onGround) tick >
//     FALL_GUARD_MAX_DROP while velocity.y still reads as actively
//     falling (never trips on a bot that's already resting — landing
//     zeroes velocity.y before onGround necessarily flips in some edge
//     cases, so velocity is the corroborating signal, not the trigger).
// A normal 1-block step-down or jump arc never gets close to either
// threshold (peak jump height ~1.25 blocks; a stepped 1-block drop lands
// within 1-2 ticks, long before velocity.y or cumulative drop builds up).
//
// No opt-out param exists on purpose: goTo() is the shared "plain travel"
// primitive — buildStaircase's advanceIntoStep and branchMine's
// digCorridorStep both hand-pulse their own controlled descent and never
// call goTo() at all (confirmed by grep — zero staircase/branchmine call
// sites route through here), so there is no legitimate caller that WANTS
// an unplanned multi-block drop tolerated here.
// ---------------------------------------------------------------------------
const FALL_GUARD_MAX_DROP = 4;
const FALL_GUARD_VELOCITY_Y = -1.0;
const FALL_GUARD_TICK_JUMP = 3;

function attachFallGuard(bot, onTrip) {
  let tripped = false;
  let lastY = bot?.entity?.position?.y ?? null;
  let lastOnGroundY = lastY;
  const onTick = () => {
    if (tripped) return;
    const pos = bot.entity?.position;
    if (!pos) return;
    if (lastY === null) {
      lastY = pos.y;
      lastOnGroundY = pos.y;
      return;
    }
    if (bot.entity.onGround) {
      lastOnGroundY = pos.y;
      lastY = pos.y;
      return;
    }
    const tickDrop = lastY - pos.y;
    lastY = pos.y;
    if (tickDrop > FALL_GUARD_TICK_JUMP) {
      tripped = true;
      onTrip(`single-tick position drop of ${tickDrop.toFixed(2)} blocks`);
      return;
    }
    const cumDrop = lastOnGroundY - pos.y;
    const vy = bot.entity.velocity?.y ?? 0;
    if (cumDrop > FALL_GUARD_MAX_DROP && vy < FALL_GUARD_VELOCITY_Y) {
      tripped = true;
      onTrip(`unplanned ${cumDrop.toFixed(2)}-block drop (velocity.y ${vy.toFixed(2)})`);
    }
  };
  bot.on('physicsTick', onTick);
  return () => {
    bot.removeListener('physicsTick', onTick);
  };
}

// ---------------------------------------------------------------------------
// public entry points
// ---------------------------------------------------------------------------

const ENGINES = new Set(['auto', 'ash', 'pf']);

// goTo(bot, {x, y, z, range?=1, timeoutMs?=45000, engine?='auto'}, ctx?)
//   'auto' — try ash first (its own timeoutMs budget); on throw, timeout, or
//            unreachable, log a quirk (ctx.log('warn', ...)) and fall back to
//            pf. A cancellation mid-ash-attempt is NOT treated as a failure
//            to fall back from — it propagates as-is so a /stop doesn't
//            accidentally kick off a second (pf) movement.
//   'ash'  — ashfinder only. Throws if bot.ashfinder isn't available.
//   'pf'   — pathfinder only (the original gotoLoop behavior).
export async function goTo(bot, opts = {}, ctx = {}) {
  const { x, y, z, range = 1, timeoutMs = 45000, engine = 'auto' } = opts;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
    throw new Error('goTo: numeric x, y, z are required');
  }
  if (!ENGINES.has(engine)) {
    throw new Error(`goTo: unknown engine "${engine}" (expected auto|ash|pf)`);
  }
  // ctx.generation/isStaleGeneration are stamped by runner.js's makeCtx() —
  // every task/movement promise "carries its generation" that way. A goTo()
  // call issued just before a reconnect/relog can arrive here after the
  // generation has already moved on; fail it immediately rather than driving
  // a bot instance that's about to become (or already is) a zombie.
  if (ctx.isStaleGeneration?.()) {
    throw new Error('goTo: stale generation');
  }

  // Fall guard spans the WHOLE call below (every engine branch, every pf
  // retry, the auto ash-then-pf fallback) — see the block above for why.
  // guardedCtx's isCancelled() folds the trip into the SAME signal
  // gotoLoopPf/raceWithCancelAndTimeout already poll for real /stop
  // cancellation, so a trip gets the identical fast reaction a cancel gets
  // today, with no changes needed inside either engine's own code. The
  // auto branch's existing `if (ctx.isCancelled?.()) throw err` (below)
  // also means a trip during an ash attempt correctly skips the pf
  // fallback — never trades a caught fall for a second blind attempt.
  let fallGuardReason = null;
  const detachFallGuard = attachFallGuard(bot, (reason) => {
    if (fallGuardReason) return; // first trip wins
    fallGuardReason = reason;
    ctx.log?.('warn', `goTo: FALL GUARD TRIPPED — ${reason}, stopping`);
    cancelMovement(bot);
  });
  const guardedCtx = {
    ...ctx,
    isCancelled: () => fallGuardReason !== null || (ctx.isCancelled ? ctx.isCancelled() : false),
  };

  try {
    let result;
    try {
      if (engine === 'pf') {
        result = await runPf(bot, { x, y, z, range, timeoutMs }, guardedCtx);
      } else if (engine === 'ash') {
        result = await runAsh(bot, { x, y, z, range, timeoutMs }, guardedCtx);
      } else if (!ashAvailable(bot)) {
        ctx.log?.('warn', 'goTo(auto): ashfinder not available on this bot, using pathfinder');
        result = await runPf(bot, { x, y, z, range, timeoutMs }, guardedCtx);
      } else {
        try {
          result = await runAsh(bot, { x, y, z, range, timeoutMs }, guardedCtx);
        } catch (err) {
          if (guardedCtx.isCancelled()) throw err; // cancellation (incl. fall guard) — don't also start pf
          ctx.log?.('warn', `goTo(auto): ashfinder failed (${err?.message ?? err}), falling back to pathfinder`);
          result = await runPf(bot, { x, y, z, range, timeoutMs }, guardedCtx);
        }
      }
    } catch (err) {
      // Whatever string the engine itself threw (often just "cancelled" or
      // a generic timeout once guardedCtx.isCancelled() trips mid-flight)
      // gets replaced with the real reason here — the caller should always
      // see WHY, never a bare "cancelled" that looks like an ordinary
      // /stop.
      if (fallGuardReason) throw new Error(`goTo: aborted by fall guard — ${fallGuardReason}`);
      throw err;
    }
    if (fallGuardReason) {
      throw new Error(`goTo: aborted by fall guard — ${fallGuardReason}`);
    }
    return result;
  } finally {
    detachFallGuard();
  }
}

// cancelMovement(bot) — the one cancel entry point for whatever goTo() (or
// skills.gotoLoop, which now delegates to gotoLoopPf above) is currently
// doing on this bot. Always clears pathfinder via setGoal(null) (cheap,
// idempotent, safe even if pf wasn't the active engine); additionally calls
// bot.ashfinder.stop() when ash was the last engine goTo() started on this
// bot. See gotcha #2 in the file header for why calling stop() here does NOT
// by itself unblock an in-flight ashfinder await — the raceWithCancelAndTimeout
// wrapper around every ashfinder call is what actually does that; stop() is
// still required to make the bot's real in-world controls/path state clear.
export function cancelMovement(bot) {
  const engine = activeEngineByBot.get(bot)?.engine;
  if (engine === 'ash') {
    try {
      bot?.ashfinder?.stop();
    } catch {
      // ignore
    }
  }
  try {
    bot?.pathfinder?.setGoal(null);
  } catch {
    // ignore
  }
}
