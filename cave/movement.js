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
function goalGroundTruth(bot, goal) {
  if (typeof goal?.x !== 'number' && typeof goal?.z !== 'number') return null;
  const pos = bot.entity.position;
  const range = typeof goal.rangeSq === 'number' ? Math.sqrt(goal.rangeSq) : 0;
  let distSq = 0;
  if (typeof goal.x === 'number') {
    const dx = pos.x - (goal.x + 0.5);
    distSq += dx * dx;
  }
  if (typeof goal.z === 'number') {
    const dz = pos.z - (goal.z + 0.5);
    distSq += dz * dz;
  }
  if (typeof goal.y === 'number') {
    const dy = pos.y - goal.y;
    distSq += dy * dy;
  }
  return { dist: Math.sqrt(distSq), range };
}

// Last-resort fallback once bot.pathfinder's own goto() has been caught
// false-reaching (or genuinely failing) across every retry AND the bot is
// still ground-truthed as actually close (<6 blocks — see call site).
// Bypasses pathfinder entirely: look at the target, pulse forward+jump in
// short (300ms) bursts, re-measuring real position after every pulse, until
// ground-truth distance clears range+0.75 or 15s elapses. Deliberately dumb
// (no obstacle avoidance, no digging) — only meant for the "goal is right
// there, pathfinder just isn't moving" case, never general navigation.
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
      if (check && check.dist <= check.range + 0.75) return;
      try {
        await bot.lookAt(targetPos, true);
      } catch {
        // ignore — still attempt to walk even if look fails
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
  if (!finalCheck || finalCheck.dist > finalCheck.range + 0.75) {
    throw new Error(
      `rawWalkTo: still ${finalCheck ? finalCheck.dist.toFixed(2) : '?'} blocks from goal after 15s raw-walk`
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
      // DRAGON GUARD: goto() resolving is not proof the bot moved (see the
      // goalGroundTruth comment above) — ground-truth it before trusting it.
      const check = goalGroundTruth(bot, goal);
      if (check && check.dist > check.range + 0.75) {
        lastErr = new Error(
          `false-reached caught: goto resolved success but bot is ${check.dist.toFixed(2)} blocks from goal (range ${check.range})`
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
    return await gotoAsh(bot, goal, { timeoutMs }, ctx);
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

  if (engine === 'pf') return runPf(bot, { x, y, z, range, timeoutMs }, ctx);

  if (engine === 'ash') return runAsh(bot, { x, y, z, range, timeoutMs }, ctx);

  // auto
  if (!ashAvailable(bot)) {
    ctx.log?.('warn', 'goTo(auto): ashfinder not available on this bot, using pathfinder');
    return runPf(bot, { x, y, z, range, timeoutMs }, ctx);
  }
  try {
    return await runAsh(bot, { x, y, z, range, timeoutMs }, ctx);
  } catch (err) {
    if (ctx.isCancelled?.()) throw err; // cancellation, not a failure — don't also start pf
    ctx.log?.('warn', `goTo(auto): ashfinder failed (${err?.message ?? err}), falling back to pathfinder`);
    return runPf(bot, { x, y, z, range, timeoutMs }, ctx);
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
