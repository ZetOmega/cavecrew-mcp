// cave/skills.js — deterministic bot-fleet algorithms.
//
// Every exported function has the shape `fn(bot, opts, ctx)` and returns a
// JSON-safe result. `ctx` is supplied by runner.js and may carry:
//   ctx.log(level, msg)   — write a line to the runner's log + quirk feed
//   ctx.setDetail(str)    — update the current task's `detail` field
//   ctx.isCancelled()     — true once /stop has cancelled the running task
//   ctx.mcData            — minecraft-data instance for bot.version
//   ctx.isPoisoned(pos)   — true if `pos` is flagged unsafe fleet-wide
//                           (runner.js's own poisonedTargets Map, TTL'd).
//                           Falls back to a raw ctx.poisonedTargets
//                           Set/Array/anything-with-.has() for bare ctx
//                           objects that don't supply the function.
//   ctx.setTargetPos(pos) — call right before moving toward a dig/mine
//                           target so that if the bot dies mid-approach, the
//                           runner's death handler can poison that exact
//                           spot (see runner.js's failActiveTask/'death').
//                           Optional — skipping it just means no poison gets
//                           recorded for that particular movement.
//   ctx.isStaleGeneration() — optional; true once the runner has reconnected
//                           since this task started (see runTargetWithWatchdog
//                           below — belt-and-braces on top of
//                           ctx.isCancelled(), not a replacement). NOTE:
//                           ctx.generation itself is a snapshot taken once at
//                           task-start, not a live value — never compare it
//                           against a later read of itself.
//   ctx.sayStatus(text)   — optional; routes through the runner's smartChat
//                           (protocol-ledger lines stay real white chat for
//                           parser compat — DEPOT is NOT one of them since the
//                           2026-09-01 de-chat decree, it goes to the Discord
//                           status feed like any other status line; everything else goes grey
//                           via rconchat, falling back to bot.chat on any
//                           rconchat trouble — see runner.js's smartChat(),
//                           announce(), and makeCtx()). Used for routine
//                           lines this file itself generates (e.g.
//                           ensureTool's DEPOT ledger line). Absent on a bare
//                           ctx (tests, /eval helpers) — callers fall back to
//                           plain bot.chat.
// All are optional — every call below is guarded with `?.()` / defensive
// checks so a bare `skills.fn(bot, opts)` call (e.g. from /eval) still works.
//
// Field quirks encoded here on purpose — do not "simplify" them away:
//   - equip the tool fresh before EVERY dig (equip does not persist between digs)
//   - collect drops immediately after felling/mining (rivals snipe drops fast)
//   - movement always goes through gotoLoop; cancel is setGoal(null), NEVER
//     bot.pathfinder.stop() (verified: stop() leaves a `stopPathing` flag that
//     silently discards the very next setGoal() call — it re-nulls the goal
//     inside the same tick).
//   - dropped-item entities can take a tick or two to actually appear after a
//     dig resolves — collecting immediately used to race that and come back
//     empty; stepOntoAndCollect() below waits 500ms and walks onto the
//     mined block before sweeping (see MINE AUTO-COLLECT FIX in the task
//     spec this file was built against).
//   - EVERY direct bot.dig()/bot.placeBlock() call goes through
//     safeDig()/safePlaceBlock() — both race a 10s timeout and, on timeout
//     OR rejection, check actual world state before believing it was a real
//     failure (a slow server confirm is not the same thing as a failed dig).
//   - EVERY reported block coordinate is floor()'d, never round()'d — see
//     toPlainPos().
//
// gotoLoop below is pathfinder-only and takes a pre-built mineflayer-pathfinder
// Goal object (GoalGetToBlock, GoalBlock, GoalFollow, ...) — its own
// implementation now lives in cave/movement.js as gotoLoopPf (same
// retry/backoff, same setGoal(null)-only cancel rule) and this function just
// delegates to it, so there's one copy of the gotcha instead of two. It stays
// pathfinder-only on purpose: ashfinder's Goal classes are a different,
// Vec3-world-position-based API (see movement.js) that a GoalFollow(entity,
// range) can't be translated into, so the ashfinder-primary engine selection
// in movement.js's goTo() only applies to the coordinate-based /goto
// endpoint, not to this goal-object-based helper.
//
// gotoLoop ALSO absorbs a field-observed pathfinder quirk on top of
// movement.gotoLoopPf: pathfinder's own goto() promise sometimes rejects with
// "goal was changed before it could be completed!" even though the bot is
// already standing right on top of the goal (observed at 0.8 blocks out).
// Rather than edit movement.js's retry internals, this wrapper catches that
// specific message and rechecks the ACTUAL distance to the goal before
// trusting it as a real failure — see goalTargetInfo() below.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import * as movement from './movement.js';

const { goals } = pathfinderPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOIL_BLOCKS = new Set([
  'dirt',
  'grass_block',
  'podzol',
  'coarse_dirt',
  'rooted_dirt',
  'farmland',
  'mycelium',
]);

const SEAL_MATERIALS = /cobblestone|_stone$|^stone$|dirt|netherrack|blackstone|deepslate/;

// (16) WEDGE-DETECTION nuisance set — narrow and pre-vetted on purpose: only
// the zero-collision block types the felcrew-mcp survey actually documented
// wedging a bot in its own tile (torch + leaf_litter confirmed in their
// FEEDBACK/LEARNING_HANDOFF entries; short_grass and layered snow are the
// same zero-shape class), none of which is ever a build material.
// Deliberately NOT fences/walls/slabs/stairs/carpets/etc — those are all
// craftable build components (FEL's fences, our own grand-staircase
// cobblestone_stairs) and digging one "because it was in the way" is exactly
// the eats-own-infrastructure failure mode guard (17) below exists to stop.
// "snow" is the thin layered block; "snow_block" intentionally not matched.
// Travel Movements (m.canDig=false, see runner.js's safety-Movements
// comment) will never clear these on its own. Used by gotoLoop's
// wedge-detection retry below (adapted from felcrew-mcp survey findings).
//
// pointed_dripstone added 2026-09-01 (FEEDBACK "pointed_dripstone wedges
// bot", Krug/TestRock): unlike the rest of this set it has a REAL collision
// box, and TestRock full-wedged with one in its foot AND head tile at
// (18.9,102,120.9) — a raw look-wake control burst moved 0.000 blocks, a
// manual dig freed it instantly. It qualifies on the rule that actually
// matters here: a natural cave hazard with zero build value, so clearing one
// can never eat our own infrastructure.
const NUISANCE_BLOCKS = /^(torch|leaf_litter|short_grass|snow|pointed_dripstone)$/;

// (17) PROTECTED-BLOCK DIG GUARD (adapted from felcrew-mcp survey findings —
// their own digguard.js hardcodes plaza-pillar coordinates as an anti-grief
// scar after Friedrich chopped Peter's house pillars thinking they were
// trees; their own TODO admits that should be generalized to block TYPES
// read from BASE.md instead of hardcoded coords). Refuses to dig any of our
// own infrastructure block types outright, fleet-wide, no coordinate list to
// maintain — this is what stops an autonomous mining/idle task from
// accidentally eating our own chest/furnace/crafting_table/bed during
// unattended running. Enforced once, centrally, inside safeDig() below,
// since that's the one choke point every direct bot.dig() call in this file
// already goes through.
const PROTECTED_BLOCK_TYPES =
  /^(chest|trapped_chest|barrel|furnace|blast_furnace|smoker|crafting_table|.*_bed|anvil|chipped_anvil|damaged_anvil|enchanting_table|brewing_stand|lectern|composter|.*_sign|.*_hanging_sign)$/;

// Matches furnace/blast_furnace/smoker block names in both their lit and
// unlit forms (some minecraft-data versions expose the lit state as a
// separate block name, e.g. "lit_furnace"; others fold it into a blockstate
// on "furnace" — matching both costs nothing and covers either case).
const FURNACE_BLOCKS = /^(lit_)?(furnace|blast_furnace|smoker)$/;

const PASSIVE_MOBS = new Set([
  'cow',
  'pig',
  'sheep',
  'chicken',
  'rabbit',
  'horse',
  'donkey',
  'mule',
  'llama',
  'trader_llama',
  'goat',
  'bee',
  'turtle',
  'fox',
  'cat',
  'wolf',
  'panda',
  'ocelot',
  'parrot',
  'squid',
  'glow_squid',
  'mooshroom',
  'frog',
  'axolotl',
  'strider',
  'villager',
  'wandering_trader',
  'pufferfish',
  'salmon',
  'cod',
  'tropical_fish',
  'bat',
  'allay',
]);

// Ore-band guidance (comments only — not enforced, callers pass explicit y):
//   coal:   y=90-140 upper band, also common near any surface exposure
//   iron:   y=15 ± (1.21 * distance-from-15) banding, but also runs through
//           exposed mountain faces well above y=15
// branchMine() defaults to y=54 when no explicit y is given — a reasonable
// generic mid-depth fallback, not tuned to any one ore.
const ORE_NAMES = [
  'iron_ore',
  'deepslate_iron_ore',
  'coal_ore',
  'deepslate_coal_ore',
  'copper_ore',
  'deepslate_copper_ore',
];

const CARDINALS = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 },
};

const CAMP_POS = new Vec3(12, 89, 56); // also the camp crafting table location
const DEPOT_POS = { x: 11, y: 89, z: 55 };

// (3) CAMP PROTECT RADIUS — same center/radius as overseer.mjs's own CHOP
// QUARANTINE ENFORCER (reactive: kills a running /chop task after the fact
// once it notices the bot inside this ring). This constant is used to make
// chopTrees proactive instead — never even select a tree in here — so the
// overseer's kill-on-sight is a backstop, not the only line of defense.
const CAMP_PROTECT_CENTER = { x: 12, z: 56 };
const CAMP_PROTECT_RADIUS = 60;

// (2c) NO-GO ZONES — read from cave/local.json's {noGoZones:[{x,z,radius,label}]}
// (2D circles, y ignored — a "zone" here means an x/z footprint on the map,
// same shape recoverKit and mineBlocks both need), merged with one
// hardcoded default that ships regardless of local.json's contents: the FEL
// base. Field-fatal without it — a mining/recover task walked straight into
// FEL's base and cost 2 PvP deaths. Read once and cached for the process
// lifetime (same "config read at startup" assumption rconchat.js's own
// createRconChat() makes about this same file).
const DEFAULT_NO_GO_ZONES = [{ x: -3, z: 4, radius: 15, label: 'FEL base' }];

let cachedNoGoZones = null;
function loadNoGoZones() {
  if (cachedNoGoZones) return cachedNoGoZones;
  let fromFile = [];
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'local.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.noGoZones)) {
      fromFile = parsed.noGoZones.filter(
        (z) => z && typeof z.x === 'number' && typeof z.z === 'number' && typeof z.radius === 'number'
      );
    }
  } catch {
    // no local.json (or unreadable/bad json) — defaults only, same
    // fall-through rconchat.js's loadRconConfig uses.
  }
  cachedNoGoZones = [...DEFAULT_NO_GO_ZONES, ...fromFile];
  return cachedNoGoZones;
}

// Never TARGET a position inside a no-go zone — that's the hard minimum this
// was built to guarantee. (Never PATHING THROUGH one is aspirational: every
// caller here uses this to filter target *selection*, not to steer
// pathfinder's/ashfinder's route away from one mid-transit.)
// (5) silent: bulk pre-filter callers (128 candidates per pickNextVein()
// call, for example) pass true here to skip the warn — the real, single
// "this exact target is inside a no-go zone" warn belongs at the one place
// a target actually gets popped and acted on, not fired once per candidate
// every filter pass.
function isInNoGoZone(pos, ctx, silent = false) {
  const zones = loadNoGoZones();
  for (const z of zones) {
    const dx = pos.x - z.x;
    const dz = pos.z - z.z;
    if (Math.hypot(dx, dz) <= z.radius) {
      if (!silent) {
        ctx?.log?.(
          'warn',
          `no-go zone: ${posKey(pos)} is within ${z.radius} of ${z.label ?? 'zone'} (${z.x},${z.z}) — refusing to target`
        );
      }
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// (19) DIG LAW (chief decree, 2026-09-01) — bulk digging happens ONLY inside
// dedicated mine zones. Zones are 3D boxes read from cave/zones.json
// (committed infra, unlike local.json's per-machine noGoZones above):
//   { "zones": [ { "name": "mine_main", "box": {x1,y1,z1,x2,y2,z2} }, ... ] }
//
// FAIL-OPEN BY DESIGN: an absent/unreadable/empty zones.json means ZERO
// zones, and zero zones means the law is simply not in force — every dig is
// allowed, exactly as before this landed. The alternative (fail-closed) would
// brick the whole fleet's mining the first time a runner started from a
// directory without the file, which is a far worse failure than an
// unenforced law. Read once and cached for the process lifetime, same
// assumption loadNoGoZones() makes.
//
// Scope, per the decree: mineBlocks (bulk ore/stone) and the two structured
// diggers (buildStaircase, branchMine) are gated. Surface skills — chopTrees,
// collectDrops, replant, seal/torch placement — are untouched: they are not
// "digging out the world", and a chop quarantine already covers camp.
// ---------------------------------------------------------------------------

let cachedDigZones = null;

function normalizeDigZone(z) {
  const b = z?.box;
  if (!b) return null;
  const nums = [b.x1, b.y1, b.z1, b.x2, b.y2, b.z2];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  // Accept the corners in either order — a zone written x2 < x1 is a typo
  // that should still describe the box the author obviously meant.
  return {
    name: typeof z.name === 'string' && z.name ? z.name : 'zone',
    x1: Math.min(b.x1, b.x2),
    x2: Math.max(b.x1, b.x2),
    y1: Math.min(b.y1, b.y2),
    y2: Math.max(b.y1, b.y2),
    z1: Math.min(b.z1, b.z2),
    z2: Math.max(b.z1, b.z2),
  };
}

function loadDigZones() {
  if (cachedDigZones) return cachedDigZones;
  let zones = [];
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'zones.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.zones)) {
      zones = parsed.zones.map(normalizeDigZone).filter(Boolean);
    }
  } catch {
    // No zones.json, unreadable, or bad JSON — zero zones, law not in force.
  }
  cachedDigZones = zones;
  return cachedDigZones;
}

// True when the law permits digging at `pos`. Zero zones configured = the law
// is not in force, so everything is permitted (see FAIL-OPEN above).
function isInDigZone(pos, zones = loadDigZones()) {
  if (zones.length === 0) return true;
  return zones.some(
    (z) => pos.x >= z.x1 && pos.x <= z.x2 && pos.y >= z.y1 && pos.y <= z.y2 && pos.z >= z.z1 && pos.z <= z.z2
  );
}

// True when the vertical column from `fromY` down to `toY` at this x/z passes
// through any zone — what makes a descending staircase legal: it is heading
// INTO the mine, even though it starts outside one.
function columnEntersDigZone(pos, fromY, toY, zones = loadDigZones()) {
  if (zones.length === 0) return true;
  const top = Math.max(fromY, toY);
  const bottom = Math.min(fromY, toY);
  return zones.some(
    (z) => pos.x >= z.x1 && pos.x <= z.x2 && pos.z >= z.z1 && pos.z <= z.z2 && bottom <= z.y2 && top >= z.y1
  );
}

// Nearest zone by centre distance, for the refusal message — a driver reading
// "outside dedicated mine zones" needs to know where the legal ground IS.
function nearestDigZone(pos, zones = loadDigZones()) {
  let best = null;
  let bestDist = Infinity;
  for (const z of zones) {
    const cx = (z.x1 + z.x2) / 2;
    const cy = (z.y1 + z.y2) / 2;
    const cz = (z.z1 + z.z2) / 2;
    const d = Math.hypot(pos.x - cx, pos.y - cy, pos.z - cz);
    if (d < bestDist) {
      bestDist = d;
      best = z;
    }
  }
  if (!best) return null;
  return {
    name: best.name,
    dist: Math.round(bestDist),
    box: `(${best.x1},${best.y1},${best.z1})-(${best.x2},${best.y2},${best.z2})`,
  };
}

function digLawRefusal(pos, what, zones = loadDigZones()) {
  const near = nearestDigZone(pos, zones);
  return (
    `${what} at ${posKey(pos)} is outside dedicated mine zones (dig law)` +
    (near ? ` — nearest zone "${near.name}" ${near.box}, ~${near.dist} blocks away` : '')
  );
}

// ---------------------------------------------------------------------------
// small internal helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function posKey(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

// (13) SAFE COORDS: floor(), never round() — a block position reported as
// "the block at 4.9" is the block at 4, not 5. Centralized here so every
// caller (existing and new) gets this for free.
function toPlainPos(pos) {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
}

function mergeCounts(items) {
  const map = new Map();
  for (const it of items) {
    map.set(it.name, (map.get(it.name) || 0) + it.count);
  }
  return Array.from(map, ([name, count]) => ({ name, count }));
}

function snapshotInventory(bot) {
  const map = new Map();
  for (const it of bot.inventory.items()) {
    map.set(it.name, (map.get(it.name) || 0) + it.count);
  }
  return map;
}

function diffInventory(before, after) {
  const out = [];
  for (const [name, count] of after) {
    const prev = before.get(name) || 0;
    if (count > prev) out.push({ name, count: count - prev });
  }
  return out;
}

export function isToolLike(name) {
  return /(_pickaxe|_axe|_shovel|_hoe|_sword|shears|bow|crossbow|trident|fishing_rod|flint_and_steel|shield|_helmet|_chestplate|_leggings|_boots|elytra)$/.test(
    name
  );
}

function itemCount(bot, name) {
  return bot.inventory
    .items()
    .filter((it) => it.name === name)
    .reduce((sum, it) => sum + it.count, 0);
}

// runner.js's ctx exposes poisoning as a function — ctx.isPoisoned(pos) —
// backed by its own Map with TTL expiry (see poisonedTargets/isPoisonedTarget
// in runner.js). Prefer that live check; fall back to a raw
// ctx.poisonedTargets Set/Array/anything-with-.has() for callers that build
// their own bare ctx (tests, /eval one-offs) without the runner.js function.
function isPoisoned(ctx, pos) {
  if (typeof ctx?.isPoisoned === 'function') return !!ctx.isPoisoned(pos);
  const p = ctx?.poisonedTargets;
  if (!p) return false;
  const key = posKey(pos);
  if (typeof p.has === 'function') return p.has(key);
  if (Array.isArray(p)) return p.includes(key);
  return false;
}

// (5) SAFE DEPTH GATE — shared by mineBlocks, recoverKit, and the structured
// mining skills: a target more than `maxBelow` blocks below the bot's own
// feet is not safe to blind-goto toward (pathfinder will happily route
// through an unlit shaft into whatever's down there). maxBelow defaults to 4
// per the mineBlocks spec.
function withinDepthGate(bot, pos, maxBelow = 4) {
  const feetY = Math.floor(bot.entity.position.y);
  const blockY = Math.floor(pos.y);
  return feetY - blockY <= maxBelow;
}

// ---------------------------------------------------------------------------
// gotoLoop — the one and only goal-object movement primitive. Cancel =
// setGoal(null). Implementation lives in cave/movement.js (gotoLoopPf) — see
// the file-header note above for why this stays pathfinder-only, and for the
// (11) spurious-throw recovery this wrapper adds on top of it.
// ---------------------------------------------------------------------------

// Duck-types a pathfinder Goal object to extract "what position/range is it
// actually aiming for" — used only to recheck a spurious failure, see (11).
function goalTargetInfo(goal) {
  if (!goal) return null;
  if (goal.entity && goal.entity.position) {
    // GoalFollow
    return { pos: goal.entity.position, range: typeof goal.range === 'number' ? goal.range : 1 };
  }
  if (typeof goal.x === 'number' && typeof goal.y === 'number' && typeof goal.z === 'number') {
    // (REACH-GAP FIX, same class as movement.js's goalGroundTruth) pathfinder
    // goals never carry a plain `range` field — GoalNear stores rangeSq, and
    // GoalGetToBlock stores neither — so this always read 0 and the (11)
    // spurious-throw recheck (dist <= range + 0.8) almost never accepted a
    // genuinely-arrived bot. Derive from rangeSq when present; treat
    // GoalGetToBlock's "stand adjacent" semantics as an effective 1.5.
    let range = 0;
    if (typeof goal.range === 'number') range = goal.range;
    else if (typeof goal.rangeSq === 'number') range = Math.sqrt(goal.rangeSq);
    else if (goals?.GoalGetToBlock && goal instanceof goals.GoalGetToBlock) range = 1.5;
    return { pos: new Vec3(goal.x, goal.y, goal.z), range };
  }
  return null;
}

// (16) WEDGE-DETECTION helper — a nuisance block (torch, leaf_litter,
// short_grass, snow layer) sitting in the bot's own foot/head tile after
// every retry has been exhausted. Adapted from felcrew-mcp survey findings.
function findNuisanceAtSelf(bot) {
  const pos = bot.entity.position.floored();
  for (const dy of [0, 1]) {
    const b = bot.blockAt(pos.offset(0, dy, 0));
    if (b && NUISANCE_BLOCKS.test(b.name)) return b;
  }
  return null;
}

export async function gotoLoop(bot, goal, opts = {}, ctx = {}) {
  try {
    return await movement.gotoLoopPf(bot, goal, opts, ctx);
  } catch (err) {
    // (11) Spurious throw observed in the field: pathfinder's goto() promise
    // sometimes rejects with "goal was changed before it could be
    // completed!" even though the bot is already standing right on top of
    // the goal (measured at 0.8 blocks out). Recheck the ACTUAL distance
    // before trusting that message as a real failure.
    if (/goal was changed before it could be completed/i.test(err?.message ?? '') && bot?.entity) {
      const info = goalTargetInfo(goal);
      if (info) {
        const dist = bot.entity.position.distanceTo(info.pos);
        if (dist <= info.range + 0.8) {
          ctx.log?.(
            'info',
            `gotoLoop: treating spurious "goal changed" throw as success (${dist.toFixed(2)} blocks from goal, range ${info.range})`
          );
          return;
        }
      }
    }
    // (16) WEDGE-DETECTION (adapted from felcrew-mcp survey findings): a goto
    // that exhausted every retry attempt while a nuisance block sits in the
    // bot's own foot/head tile is very likely wedged on that block, not
    // genuinely unreachable — travel Movements deliberately never auto-digs
    // (m.canDig=false, see runner.js's safety-Movements comment: pathfinder's
    // own auto-dig previously ate the camp crafting table and depot chests
    // as "path obstacles"), so a real nuisance block never clears itself.
    // Dig ONLY this narrow, pre-vetted nuisance set (never anything a build
    // could be made of — see NUISANCE_BLOCKS above) and retry the goto
    // exactly once more before giving up for real.
    if (!ctx.isCancelled?.() && !ctx.isStaleGeneration?.() && bot?.entity) {
      let nuisance = null;
      try {
        nuisance = findNuisanceAtSelf(bot);
      } catch {
        nuisance = null;
      }
      if (nuisance) {
        ctx.log?.(
          'warn',
          `gotoLoop: wedge-detected — ${nuisance.name} in own tile at ${posKey(nuisance.position)}, digging and retrying once`
        );
        try {
          await safeDig(bot, nuisance, ctx);
          return await movement.gotoLoopPf(bot, goal, opts, ctx);
        } catch (digErr) {
          ctx.log?.('warn', `gotoLoop: wedge dig/retry failed: ${digErr?.message ?? digErr}`);
        }
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// (12) safeDig / safePlaceBlock — every direct bot.dig()/bot.placeBlock()
// call in this file goes through these. Both race a 10s timeout; on timeout
// OR any rejection, check actual world state before believing it — a slow
// server confirm on an already-successful action is not a failure.
// ---------------------------------------------------------------------------

function withTimeoutLocal(promise, ms) {
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

function assertNotProtected(block) {
  if (block && PROTECTED_BLOCK_TYPES.test(block.name)) {
    throw new Error(
      `safeDig: refusing to dig protected block type "${block.name}" at ${posKey(block.position)} (chest/furnace/table/bed/etc. are never dig targets)`
    );
  }
}

// (1) REACH LAW — mineflayer's own bot.dig()/bot.placeBlock() will happily
// accept a target far past real survival-mode interaction range (a leftover
// of the API also serving creative-mode callers) and then just hang waiting
// on a server-side reject that never resolves cleanly. Vanilla survival
// reach is ~4.5 blocks; gate at 4.2 to stay clear of the edge, and close the
// distance to within 2 blocks BEFORE ever handing a block to bot.dig()/
// bot.placeBlock(). Centralized here — inside safeDig()/safePlaceBlock(),
// the two choke points every direct dig/place call in this file already
// goes through (see (12) below) — so every call site gets this for free
// instead of needing a per-site edit.
async function ensureWithinReach(bot, block, ctx) {
  if (!block || !block.position || !bot?.entity) return;
  const dist = bot.entity.position
    .offset(0, 1.62, 0)
    .distanceTo(block.position.offset(0.5, 0.5, 0.5));
  if (dist <= 4.2) return;
  ctx?.log?.(
    'warn',
    `ensureWithinReach: ${dist.toFixed(2)} blocks from ${posKey(block.position)} (>4.2) — closing distance before dig/place`
  );
  try {
    await gotoLoop(
      bot,
      new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2),
      { timeoutMs: 15000, maxAttempts: 3 },
      ctx
    );
  } catch (err) {
    ctx?.log?.('warn', `ensureWithinReach: could not close distance to ${posKey(block.position)}: ${err.message}`);
  }
  // (1b) REACH LAW HARD STOP — a goto that throws (no path) or one that
  // spuriously "succeeds" without actually landing within reach must never
  // let the caller fall through to bot.dig()/bot.placeBlock() anyway: vanilla
  // survival's server doesn't reliably reject an out-of-range dig/place
  // packet on its own (confirmed live: an 8-block-away safeDig() call
  // succeeded with the bot never moving, once the approach goto failed with
  // "No path to the goal!" and this function silently swallowed that). Recheck
  // real distance regardless of which branch above ran, and refuse the
  // dig/place outright if still out of reach.
  const distAfter = bot.entity.position
    .offset(0, 1.62, 0)
    .distanceTo(block.position.offset(0.5, 0.5, 0.5));
  if (distAfter > 4.2) {
    throw new Error(
      `ensureWithinReach: still ${distAfter.toFixed(2)} blocks from ${posKey(block.position)} after approach attempt — refusing to dig/place out of reach`
    );
  }
}

// Exported (not just internal) so /eval can reach a single-block dig through
// the same reach-law (ensureWithinReach) + protected-block guard
// (assertNotProtected) every deterministic skill already goes through —
// without this, a driver's manual `bot.dig()` via /eval had neither
// protection: no reach gate (mineflayer will hang past real interaction
// range) and no chest/furnace/table/bed guard. Behavior is unchanged for
// every existing internal call site.
export async function safeDig(bot, block, ctx) {
  assertNotProtected(block);
  await ensureWithinReach(bot, block, ctx);
  const pos = block.position;
  const expectedName = block.name;
  try {
    await withTimeoutLocal(bot.dig(block), 10000);
    return true;
  } catch (err) {
    const now = bot.blockAt(pos);
    if (!now || now.name !== expectedName) {
      ctx?.log?.(
        'warn',
        `safeDig: dig() errored/timed out but world state shows the block is gone at ${posKey(pos)} — treating as success (${err?.message ?? err})`
      );
      return true;
    }
    throw err;
  }
}

// (FIELD LAW, Bonk + Grog 2026-09-01 — FEEDBACK "placeBlock false-success:
// reports ok, block never sticks") A resolved placeBlock() is NOT proof a
// block landed: 5 of 7 honeycomb caps that reported res:"ok" were air again
// on a fresh re-check, and Grog hit the identical thing batch-patching a
// floor. The mirror case is already handled below (Thak's table restoration:
// placeBlock THREW "Event blockUpdate did not fire" while the block had in
// fact landed) — so neither the resolve nor the throw can be trusted on its
// own, and the ONLY authority is an independent world-state read of the
// expected position afterwards. Both outcomes now funnel into the same
// ground-truth check, with one retry (re-equipping first — equips do not
// persist, same law as dig) before a hard throw, so no caller can skip the
// verification by forgetting to write it.
const PLACE_VERIFY_POLLS = 4;
// Probe-style callers (retry:false — see safePlaceBlock's opts) walk a list of
// candidate faces and expect most to fail, so they pay this poll per dud
// face. 2 samples (300ms) instead of 4 keeps the verification honest while
// cutting a 6-face sealStairCell sweep from ~3.6s of polling to ~1.8s, which
// matters in exactly one place: emergencySeal with lava already in view.
const PLACE_VERIFY_POLLS_PROBE = 2;
const PLACE_VERIFY_INTERVAL_MS = 150;

// air / cave_air / void_air read as "nothing landed here", and so do water and
// lava: sealStairCell/emergencySeal place INTO fluid cells, so a cell that is
// still fluid afterwards means the seal did not take — the old check
// (`name !== 'air'`) called those a success and is exactly the false-success
// class this fix exists to kill. Anything else counts as placed: a torch that
// became wall_torch on a side face, a slab/stair variant, etc. — the caller
// only ever needs to know the cell is no longer empty.
const NOT_PLACED_RE = /^(?:cave_air|void_air|air|water|lava|bubble_column)$/;

function placedAt(bot, checkPos) {
  const now = bot.blockAt(checkPos);
  return !!(now && !NOT_PLACED_RE.test(now.name));
}

// Server block updates lag the place packet by a tick or two; poll briefly
// before declaring a miss so a slow confirm never triggers a duplicate
// placement (the same race stepOntoAndCollect's 500ms wait exists for).
async function pollPlaced(bot, checkPos, polls = PLACE_VERIFY_POLLS) {
  for (let i = 0; i < polls; i++) {
    if (placedAt(bot, checkPos)) return true;
    await sleep(PLACE_VERIFY_INTERVAL_MS);
  }
  return placedAt(bot, checkPos);
}

// opts.retry (default true) — the one knob. PROBE-style callers walk a list
// of candidate faces and expect most of them to throw (sealStairCell tries up
// to 6 neighbors, placeTorchHere up to 5), so paying re-equip + a second
// place + a second verify poll on every dud face costs ~20s worst case in
// exactly the path that must be fastest: emergencySeal with lava in view.
// Those callers pass { retry: false } and keep the single verified attempt;
// every other caller gets the full verify-and-retry law.
async function safePlaceBlock(bot, refBlock, faceVector, ctx, expectedPos, opts = {}) {
  const retry = opts.retry !== false;
  await ensureWithinReach(bot, refBlock, ctx);
  const checkPos = expectedPos ?? refBlock.position.plus(faceVector);
  // Captured BEFORE the first attempt: on the retry we have to put the same
  // item back in hand ourselves. Callers equip immediately before calling,
  // but a failed/half-completed place can leave the hand holding something
  // else, and equips never persist across the failure anyway.
  const heldName = bot.heldItem?.name ?? null;
  const refPos = refBlock.position;

  let firstErr = null;
  try {
    await withTimeoutLocal(bot.placeBlock(refBlock, faceVector), 10000);
  } catch (err) {
    firstErr = err;
  }

  if (await pollPlaced(bot, checkPos, retry ? PLACE_VERIFY_POLLS : PLACE_VERIFY_POLLS_PROBE)) {
    if (firstErr) {
      // Unchanged legacy success path — errored/timed out, world says placed.
      ctx?.log?.(
        'warn',
        `safePlaceBlock: placeBlock() errored/timed out but world state shows a block now present at ${posKey(checkPos)} — treating as success (${firstErr?.message ?? firstErr})`
      );
    }
    return true;
  }

  if (!retry) {
    // Probe caller: still VERIFIED (the false-success can never slip past),
    // just not retried — the caller's own next candidate face is the retry.
    throw new Error(
      `safePlaceBlock: nothing placed at ${posKey(checkPos)} (${firstErr?.message ?? 'resolved ok, world showed air'})`
    );
  }

  ctx?.log?.(
    'warn',
    firstErr
      ? `safePlaceBlock: nothing at ${posKey(checkPos)} after failed place (${firstErr?.message ?? firstErr}) — re-equipping and retrying once`
      : `safePlaceBlock: FALSE SUCCESS — placeBlock() resolved ok but ${posKey(checkPos)} is still air — re-equipping and retrying once`
  );

  if (heldName) {
    const again = bot.inventory.items().find((it) => it.name === heldName);
    if (!again) {
      throw new Error(
        `safePlaceBlock: nothing placed at ${posKey(checkPos)} and no ${heldName} left in inventory to retry with${firstErr ? ` (first attempt: ${firstErr.message})` : ''}`
      );
    }
    try {
      await bot.equip(again, 'hand');
    } catch (equipErr) {
      ctx?.log?.('warn', `safePlaceBlock: re-equip of ${heldName} failed before retry: ${equipErr?.message ?? equipErr}`);
    }
  }

  // Re-read the reference block: the cached Block object handed in by the
  // caller can be stale by now (the stale-chunk trap logged in FEEDBACK), and
  // a reference that has since changed type is not something to place against.
  const freshRef = bot.blockAt(refPos);
  if (!freshRef || !placedAt(bot, refPos)) {
    throw new Error(
      `safePlaceBlock: reference block at ${posKey(refPos)} is gone — cannot retry placement at ${posKey(checkPos)}${firstErr ? ` (first attempt: ${firstErr.message})` : ''}`
    );
  }

  await ensureWithinReach(bot, freshRef, ctx);
  let retryErr = null;
  try {
    await withTimeoutLocal(bot.placeBlock(freshRef, faceVector), 10000);
  } catch (err) {
    retryErr = err;
  }

  if (await pollPlaced(bot, checkPos)) {
    ctx?.log?.('info', `safePlaceBlock: retry landed a block at ${posKey(checkPos)}`);
    return true;
  }

  throw new Error(
    `safePlaceBlock: no block at ${posKey(checkPos)} after 2 verified attempts (first: ${firstErr?.message ?? 'resolved ok, world showed air'}; retry: ${retryErr?.message ?? 'resolved ok, world showed air'})`
  );
}

// ---------------------------------------------------------------------------
// (6) LOW-HEALTH RETREAT — shared guard, called at the top of every
// per-target/per-step iteration in the task loops below. Best-effort goto
// camp, then always aborts the task (the throw is what makes runner.js set
// state.failed + lastError "low health retreat" — see taskEndpoint/startTask
// in runner.js, unmodified here).
// ---------------------------------------------------------------------------

async function checkHealthRetreat(bot, ctx) {
  if (typeof bot.health === 'number' && bot.health < 8) {
    ctx.log?.('warn', `low health (${bot.health}) — retreating to camp before aborting task`);
    try {
      await gotoLoop(bot, new goals.GoalNear(CAMP_POS.x, CAMP_POS.y, CAMP_POS.z, 3), { timeoutMs: 60000, maxAttempts: 3 }, ctx);
    } catch (err) {
      ctx.log?.('warn', `low-health retreat goto failed (best-effort, continuing to abort): ${err.message}`);
    }
    throw new Error('low health retreat');
  }
}

// ---------------------------------------------------------------------------
// (10) STALL WATCHDOG — wraps a per-target step (goto+dig+collect, or
// equivalent) with a progress timeout. If the step hasn't settled within
// timeoutMs AND the bot hasn't moved, inventory hasn't changed, and no block
// broke, it's a stall: the caller should skip this target. If any of those
// three progress signals fired, this is NOT a stall — just slow — so we keep
// waiting for the real result instead of abandoning good work.
//
// Returns { stalled: true } on a genuine stall (the still-running step
// promise is deliberately abandoned/unref'd at that point — same "don't
// re-await a promise once you've decided to move on" pattern movement.js
// uses for ashfinder timeouts). Returns { stalled: false, result } on a
// normal completion. Rethrows on a real error from stepFn (not a stall).
// ---------------------------------------------------------------------------

async function runTargetWithWatchdog(bot, ctx, timeoutMs, stepFn) {
  let blockBroke = false;
  const onBreak = () => {
    blockBroke = true;
  };
  bot.on('diggingCompleted', onBreak);

  const startPos = bot.entity.position.clone();
  const startInv = snapshotInventory(bot);

  let settled = false;
  let stepResult;
  let stepError;

  const stepPromise = stepFn().then(
    (v) => {
      settled = true;
      stepResult = v;
    },
    (err) => {
      settled = true;
      stepError = err;
    }
  );

  let stalled = false;
  const timeoutPromise = sleep(timeoutMs).then(() => {
    if (settled) return;
    const moved = bot.entity.position.distanceTo(startPos) > 0.5;
    const invChanged = diffInventory(startInv, snapshotInventory(bot)).length > 0;
    // runner.js's ctx.generation is a snapshot captured once at task-start
    // (it never mutates on the ctx object itself) — the live check is the
    // ctx.isStaleGeneration() function, which reads the module-level counter
    // that DOES get bumped on every reconnect. A reconnect mid-step means the
    // runner already superseded this task — no point calling that
    // "progress", treat it like a stall so the caller unwinds promptly
    // instead of grinding on a bot instance that's now a zombie.
    const staleGeneration = !!ctx.isStaleGeneration?.();
    if (staleGeneration || (!moved && !invChanged && !blockBroke)) {
      stalled = true;
    }
  });

  await Promise.race([stepPromise, timeoutPromise]);

  bot.removeListener('diggingCompleted', onBreak);

  if (!settled && stalled) {
    return { stalled: true };
  }
  if (!settled) {
    // Progress was observed at the 25s mark but the step is still running —
    // this is a stall detector, not a hard deadline, so wait for real
    // completion once we know it's making progress.
    await stepPromise;
  }
  if (stepError) throw stepError;
  return { stalled: false, result: stepResult };
}

// ---------------------------------------------------------------------------
// (8) MINE AUTO-COLLECT FIX — wait for the drop entity to actually exist,
// then walk straight onto the block that was just broken (loose drops
// usually land inside it) before falling back to the normal drop-hunt sweep.
// This is what fixed mined-block collected[] always coming back empty.
// ---------------------------------------------------------------------------

// (8b) preDigSnapshot (optional): a snapshotInventory() taken by the caller
// BEFORE the dig that produced this drop. Vanilla auto-pickup is often
// faster than our own 500ms-sleep-then-collect dance below — a drop landing
// right at the bot's feet can already be in the bag before collectNear()
// ever takes ITS OWN "before" snapshot, which made the returned collected[]
// silently miss real pickups (confirmed live: 3 stone mined, 3 cobblestone
// sitting in inventory, task result reported collected:[] for it). When the
// caller supplies preDigSnapshot, the diff is computed against that earlier
// point instead, so an already-auto-picked-up item still gets reported.
async function stepOntoAndCollect(bot, pos, ctx, radius, preDigSnapshot) {
  await sleep(500);
  try {
    await gotoLoop(bot, new goals.GoalBlock(pos.x, pos.y, pos.z), { timeoutMs: 5000, maxAttempts: 1 }, ctx);
  } catch {
    // ignore — the collectDrops sweep below still tries via its own pathing
  }
  const before = preDigSnapshot ?? snapshotInventory(bot);
  await collectNear(bot, ctx, radius).catch(() => ({ collected: [] }));
  const after = snapshotInventory(bot);
  const collected = diffInventory(before, after);
  if (collected.length === 0) {
    ctx.log?.('warn', `stepOntoAndCollect: no drop picked up near ${posKey(pos)}`);
  }
  return collected;
}

async function collectNear(bot, ctx, radius) {
  return collectDrops(bot, { radius }, ctx);
}

const LEAVES_RE = /_leaves$/;

// (3) NATURAL TREE CHECK — a *_log column that has no leaves within 4 blocks
// above its own top log is a built structure (a house pillar, a fence-post
// core), not a tree. Chopping it has harvested our own house pillars three
// times in the field. Walks up the contiguous log run first (basePos may not
// be the top log — findBlock returns whichever log it happened to see) so
// the leaf search starts from the real top of the trunk.
function hasLeavesAboveTop(bot, basePos) {
  let top = basePos;
  for (;;) {
    const next = top.offset(0, 1, 0);
    const b = bot.blockAt(next);
    if (b && /_log$/.test(b.name)) {
      top = next;
    } else {
      break;
    }
  }
  // (4) widened to dx/dz +-4, dy 1-6 — acacia's diagonal-leaning trunk puts
  // its canopy well outside a +-2 column and was false-flagging as a built
  // structure and getting skipped/chopped-as-pillar.
  for (let dy = 1; dy <= 6; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        const b = bot.blockAt(top.offset(dx, dy, dz));
        // (4) null means an unloaded chunk edge, not "no leaves here" — a
        // real canopy could be sitting there un-rendered. Assume tree
        // rather than false-skip it as a built structure.
        if (!b) return true;
        if (LEAVES_RE.test(b.name)) return true;
      }
    }
  }
  return false;
}

async function replantSapling(bot, belowPos, ctx) {
  const sapling = bot.inventory.items().find((it) => it.name.endsWith('_sapling'));
  if (!sapling) return false;
  const soil = bot.blockAt(belowPos);
  if (!soil || !SOIL_BLOCKS.has(soil.name)) return false;
  const plantAt = bot.blockAt(belowPos.offset(0, 1, 0));
  if (!plantAt || plantAt.name !== 'air') return false;
  await bot.equip(sapling, 'hand');
  await safePlaceBlock(bot, soil, new Vec3(0, 1, 0), ctx, belowPos.offset(0, 1, 0));
  ctx.log?.('info', `replanted ${sapling.name} at ${posKey(belowPos)}`);
  return true;
}

// ---------------------------------------------------------------------------
// chopTrees
// ---------------------------------------------------------------------------

// (FIELD BUG, UngaBunga 2026-09-01 — FEEDBACK "chopTrees dies with 'stalled'
// mid-tree, no auto-retry") A stalled target used to poison exactly ONE log
// position, but findBlock's next pick is simply the nearest remaining log —
// which, on a tree the bot just failed to reach, is the very next log of that
// SAME trunk one block up or across. Three "different" candidates in a row
// were therefore three attempts at one unreachable tree, and the third one
// killed the whole /chop with result.error "stalled" while the task detail
// still read "chopping tree 1/12". Skipping the whole trunk (the 3x3 column
// around the base, which also covers 2x2 dark-oak/jungle trunks) is what
// actually makes "skip this tree, try the next one" mean the next TREE.
// Returns how many log positions were poisoned, for the log line.
//
// The upward window has to clear the TALLEST trunk, not the average one: a
// 2x2 jungle giant runs 25-30 logs, so a +12 window left the top third of it
// still selectable and one unreachable giant could still eat all three stall
// strikes (y0, y13, y26). The `*_log` type filter is what keeps this
// surgical — a taller window only ever poisons blocks that are actually
// logs, so overshooting costs nothing but blockAt reads off the local cache.
const TREE_SKIP_Y_BELOW = 4;
const TREE_SKIP_Y_ABOVE = 30;

function markTreeSkipped(bot, basePos, skippedKeys) {
  let n = 0;
  skippedKeys.add(posKey(basePos));
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -TREE_SKIP_Y_BELOW; dy <= TREE_SKIP_Y_ABOVE; dy++) {
        const p = basePos.offset(dx, dy, dz);
        const b = bot.blockAt(p);
        // null = unloaded chunk edge; nothing to poison there and no reason
        // to guess (a later iteration re-reads it anyway).
        if (b && /_log$/.test(b.name)) {
          skippedKeys.add(posKey(p));
          n++;
        }
      }
    }
  }
  return n;
}

// A watchdog stall ABANDONS its step promise (see runTargetWithWatchdog) —
// the goto/dig it gave up on is still running, still driving this bot's
// controls, and gotoLoopPf will keep RE-ISSUING its own remaining attempts.
// Starting the next tree's goto on top of that is how a single stall
// cascaded into the 3-consecutive-stall task kill: the two loops take turns
// calling setGoal, each one's promise rejecting with "goal was changed before
// it could be completed" as the other claims the bot.
//
// The step therefore runs against a ctx whose isCancelled() also reports true
// once its tree has been abandoned — gotoLoopPf/ashfinder both check
// ctx.isCancelled() between attempts, so the abandoned step unwinds itself
// instead of fighting the live one. Object.create keeps every other ctx
// member live through the prototype chain (including ones runner.js mutates
// later); only isCancelled is shadowed, and the real ctx is still consulted
// so a genuine /stop still wins.
function abandonableCtx(ctx, flag) {
  const wrapped = Object.create(ctx);
  wrapped.isCancelled = () => flag.abandoned || !!ctx.isCancelled?.();
  return wrapped;
}

// Belt to that suspenders: clear whichever movement engine is actually
// holding the controls (cancelMovement is the single entry point, and is
// idempotent/safe when nothing is pathing) plus any half-finished dig, then
// let physics settle before the next attempt.
async function releaseAfterStall(bot, ctx) {
  try {
    movement.cancelMovement(bot);
  } catch (err) {
    ctx?.log?.('warn', `releaseAfterStall: cancelMovement failed: ${err?.message ?? err}`);
  }
  try {
    bot.stopDigging?.();
  } catch {
    // not digging — nothing to stop, and mineflayer throws rather than no-ops
  }
  await sleep(500);
}

export async function chopTrees(bot, opts = {}, ctx = {}) {
  const count = opts.count ?? 8;
  const maxDistance = opts.maxDistance ?? 48;

  // (9) Axe is optional here — hand-chopping works, just slower. Best-effort
  // only: a failed ensureTool() must never abort a chop task.
  //
  // opts._skipEnsureTool is an internal-only escape hatch: ensureTool's own
  // craft chain bootstraps missing logs via ensureLogs() -> chopTrees(), and
  // without this flag that would recurse forever (chopTrees calls
  // ensureTool('axe') -> craftToolChain -> ensurePlanksAndSticks ->
  // ensureLogs -> chopTrees -> ensureTool('axe') -> ...). Never set this
  // from outside skills.js.
  if (!opts._skipEnsureTool) {
    await ensureTool(bot, { kind: 'axe' }, ctx).catch((err) => {
      ctx.log?.('warn', `chopTrees: ensureTool(axe) failed, hand-chopping instead: ${err.message}`);
    });
  }

  const choppedTrees = [];
  const collectedAll = [];
  const skippedKeys = new Set();
  const maxIterations = count * 4 + 20;
  let iterations = 0;
  let consecutiveStalls = 0;

  while (choppedTrees.length < count && iterations < maxIterations) {
    iterations++;
    if (ctx.isCancelled?.()) break;
    await checkHealthRetreat(bot, ctx);
    ctx.setDetail?.(`chopping tree ${choppedTrees.length + 1}/${count}`);

    const base = bot.findBlock({
      point: bot.entity.position,
      maxDistance,
      // mineflayer's findBlock calls this matcher twice per candidate: once
      // during the palette pre-filter with a synthetic Block.fromStateId
      // that has position === null, and once for real with the actual
      // block (position set). Guard b.position before keying on it, or the
      // pre-filter call throws "Cannot read properties of null (reading
      // 'x')" the instant a nearby section's palette contains a log type.
      matching: (b) =>
        /_log$/.test(b.name) && (!b.position || (!skippedKeys.has(posKey(b.position)) && !isPoisoned(ctx, b.position))),
    });
    if (!base) {
      ctx.log?.('warn', `chopTrees: no more *_log blocks within ${maxDistance} blocks`);
      break;
    }
    const key = posKey(base.position);
    const basePos = base.position.clone();

    // (3) CAMP PROTECT RADIUS — never even select a target this close to
    // camp; matches overseer.mjs's own CHOP QUARANTINE ENFORCER center/
    // radius exactly, but proactive instead of reactive-kill.
    const campDx = basePos.x - CAMP_PROTECT_CENTER.x;
    const campDz = basePos.z - CAMP_PROTECT_CENTER.z;
    if (Math.hypot(campDx, campDz) < CAMP_PROTECT_RADIUS) {
      skippedKeys.add(key);
      ctx.log?.(
        'warn',
        `chopTrees: skipping ${key} — inside camp quarantine (<${CAMP_PROTECT_RADIUS} of (${CAMP_PROTECT_CENTER.x},${CAMP_PROTECT_CENTER.z}))`
      );
      continue;
    }

    // (3) NO-GO ZONES — never select a chop target inside one, same rule
    // mineBlocks already enforces on its own targets.
    if (isInNoGoZone(basePos, ctx)) {
      skippedKeys.add(key);
      continue;
    }

    // (3) NATURAL TREE CHECK — see hasLeavesAboveTop() above.
    if (!hasLeavesAboveTop(bot, basePos)) {
      skippedKeys.add(key);
      ctx.log?.('warn', `chopTrees: skipping ${key} — no leaves within 4 blocks above top log (built structure, not tree)`);
      continue;
    }

    // Per-tree abandon flag — see abandonableCtx above. Fresh object every
    // iteration so a previous tree's flag can never mute the current one.
    const abandonFlag = { abandoned: false };
    const stepCtx = abandonableCtx(ctx, abandonFlag);

    let watchdog;
    try {
      watchdog = await runTargetWithWatchdog(bot, stepCtx, 25000, async () => {
        stepCtx.setTargetPos?.(basePos);
        await gotoLoop(
          bot,
          new goals.GoalGetToBlock(basePos.x, basePos.y, basePos.z),
          { timeoutMs: 20000, maxAttempts: 3 },
          stepCtx
        );

        const belowPos = basePos.offset(0, -1, 0);
        let current = bot.blockAt(basePos);
        let logsFelled = 0;
        const preDigSnapshot = snapshotInventory(bot);

        while (current && /_log$/.test(current.name)) {
          // Equip the best axe BEFORE EACH log — equip does not persist between digs.
          try {
            await bot.tool.equipForBlock(current, { requireHarvest: false });
          } catch (err) {
            stepCtx.log?.('warn', `chopTrees: equip axe failed at ${posKey(current.position)}: ${err.message}`);
          }
          try {
            await safeDig(bot, current, stepCtx);
            logsFelled++;
          } catch (err) {
            stepCtx.log?.('warn', `chopTrees: dig failed at ${posKey(current.position)}: ${err.message}`);
            break;
          }
          current = bot.blockAt(current.position.offset(0, 1, 0));
        }

        if (logsFelled === 0) return { logsFelled: 0, collected: [] };

        // Collect drops IMMEDIATELY — rival bots snipe drops within seconds.
        const collected = await stepOntoAndCollect(bot, basePos, stepCtx, 6, preDigSnapshot);

        await replantSapling(bot, belowPos, stepCtx).catch((err) => {
          stepCtx.log?.('warn', `chopTrees: replant failed: ${err.message}`);
        });

        return { logsFelled, collected };
      });
    } catch (err) {
      // Same whole-trunk skip as the stall path below, for the same reason:
      // pf can throw "No path to the goal!" fast enough to land here instead
      // of tripping the 25s watchdog, and poisoning one log then leaves the
      // very next findBlock pick on that same unreachable trunk — a tree
      // across a ravine got re-ground log-by-log for minutes. Whatever made
      // this tree unworkable applies to the whole trunk, not one block of it.
      // (No abandon flag here — reaching this catch means the step promise
      // already settled with that error; nothing is left in flight to unwind.)
      const poisoned = markTreeSkipped(bot, basePos, skippedKeys);
      ctx.log?.(
        'warn',
        `chopTrees: could not reach/fell tree at ${key} (${err.message}) — skipping ${poisoned} log position(s) of that trunk`
      );
      continue;
    }

    if (watchdog.stalled) {
      // Skip the whole TREE, not just this one log, and hand the bot's
      // controls back before the next candidate — see markTreeSkipped /
      // releaseAfterStall above. Only a third CONSECUTIVE stall (a run of
      // three separate trees the bot could not work) fails the task; any
      // successful tree in between resets the counter.
      abandonFlag.abandoned = true;
      const poisoned = markTreeSkipped(bot, basePos, skippedKeys);
      consecutiveStalls++;
      ctx.log?.(
        'warn',
        `chopTrees: tree at ${key} stalled (${consecutiveStalls}/3 consecutive) — skipping ${poisoned} log position(s) of that trunk and moving to the next tree`
      );
      await releaseAfterStall(bot, ctx);
      if (consecutiveStalls >= 3) throw new Error('stalled');
      continue;
    }
    consecutiveStalls = 0;

    if (!watchdog.result || watchdog.result.logsFelled === 0) {
      skippedKeys.add(key);
      continue;
    }

    choppedTrees.push({ ...toPlainPos(basePos), logs: watchdog.result.logsFelled });
    collectedAll.push(...(watchdog.result.collected || []));
  }

  // (8) End-of-task late-drop sweep — leaf decay and slow-to-land drops.
  await sleep(2500);
  const { collected: late } = await collectDrops(bot, { radius: 24 }, ctx).catch(() => ({ collected: [] }));
  collectedAll.push(...late);

  return { chopped: choppedTrees.length, trees: choppedTrees, collected: mergeCounts(collectedAll) };
}

// ---------------------------------------------------------------------------
// mineBlocks
// ---------------------------------------------------------------------------

// (2b) VEIN LOCALITY — groups candidate positions into clusters (chebyshev
// distance <=3 counts as "one vein"), then picks the nearest cluster by a
// horizontal-biased score (lateral x/z distance weighted over vertical) so a
// straight-down outlier one block away in y doesn't get chosen over a
// cluster that's actually much closer to walk to. Field-fatal without this:
// raw nearest-single-block selection bounced the bot between distant veins
// one block at a time and stranded 13 iron scattered over 48-block hops.
// Returns the chosen vein's positions, nearest-first within the vein, or []
// if nothing usable was found.
function pickNextVein(bot, block, maxDistance, isUsable) {
  const candidates = bot
    .findBlocks({
      point: bot.entity.position,
      matching: (b) => b.name === block,
      maxDistance,
      count: 128,
    })
    // (5) silent: this runs once per candidate (up to 128) every time a
    // vein drains — the real no-go-zone warn fires later, once, at the
    // target-pop recheck in mineBlocks instead.
    .filter((p) => isUsable(p, true));
  if (candidates.length === 0) return [];

  const clusters = [];
  const seen = new Set();
  for (const p of candidates) {
    const key = posKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    const cluster = [p];
    const stack = [p];
    while (stack.length) {
      const cur = stack.pop();
      for (const other of candidates) {
        const ok = posKey(other);
        if (seen.has(ok)) continue;
        const cheb = Math.max(Math.abs(other.x - cur.x), Math.abs(other.y - cur.y), Math.abs(other.z - cur.z));
        if (cheb <= 3) {
          seen.add(ok);
          cluster.push(other);
          stack.push(other);
        }
      }
    }
    clusters.push(cluster);
  }

  const botPos = bot.entity.position;
  let best = null;
  let bestScore = Infinity;
  for (const cluster of clusters) {
    for (const p of cluster) {
      const score = Math.hypot(p.x - botPos.x, p.z - botPos.z) + Math.abs(p.y - botPos.y) * 0.35;
      if (score < bestScore) {
        bestScore = score;
        best = cluster;
      }
    }
  }
  return best.slice().sort((a, b) => botPos.distanceTo(a) - botPos.distanceTo(b));
}

export async function mineBlocks(bot, opts = {}, ctx = {}) {
  const block = opts.block;
  const count = opts.count ?? 8;
  const maxDistance = opts.maxDistance ?? 48;
  if (!block) throw new Error('mineBlocks: "block" is required');

  // (9) Pickaxe is REQUIRED for stone/ores — fail the whole task with a
  // clear lastError if the ensureTool chain can't produce one.
  try {
    await ensureTool(bot, { kind: 'pickaxe' }, ctx);
  } catch (err) {
    throw new Error(`mineBlocks: pickaxe required but ensureTool failed: ${err.message}`);
  }

  const mined = [];
  const skipped = [];
  const skippedKeys = new Set();
  const collectedAll = [];
  const maxIterations = count * 4 + 20;
  let iterations = 0;
  let consecutiveStalls = 0;

  // (2b) queue of positions still to mine in the vein currently being
  // worked, nearest-first; refilled by pickNextVein() whenever it drains.
  let currentVein = [];

  // (19) DIG LAW — a candidate outside every dedicated mine zone is not a
  // target, full stop. Zones loaded once here so the whole run sees one
  // consistent list (and so the "why did it stop" check below can tell a
  // law refusal apart from an exhausted vein).
  const digZones = loadDigZones();

  const isUsable = (p, silent = false) =>
    !skippedKeys.has(posKey(p)) && !isPoisoned(ctx, p) && !isInNoGoZone(p, ctx, silent) && isInDigZone(p, digZones);

  while (mined.length < count && iterations < maxIterations) {
    iterations++;
    if (ctx.isCancelled?.()) break;
    await checkHealthRetreat(bot, ctx);
    ctx.setDetail?.(`mining ${block} ${mined.length}/${count}`);

    if (currentVein.length === 0) {
      currentVein = pickNextVein(bot, block, maxDistance, isUsable);
      if (currentVein.length === 0) {
        // (19) Tell the two "nothing to mine" cases apart before giving up
        // quietly: an empty world is a normal end-of-task, but ore sitting in
        // range that the law forbids is a REFUSAL and has to say so loudly —
        // otherwise a driver reads "no reachable iron_ore" and goes hunting
        // for a pathing bug that isn't there.
        if (digZones.length > 0) {
          const raw = bot.findBlocks({
            point: bot.entity.position,
            matching: (b) => b.name === block,
            maxDistance,
            count: 16,
          });
          if (raw.length > 0 && !raw.some((p) => isInDigZone(p, digZones))) {
            throw new Error(`mineBlocks: ${digLawRefusal(raw[0], `nearest of ${raw.length}x ${block}`, digZones)}`);
          }
        }
        ctx.log?.('warn', `mineBlocks: no reachable ${block} left within ${maxDistance} blocks`);
        break;
      }
    }

    const targetPos = currentVein.shift();
    const key = posKey(targetPos);
    // (2c) NO-GO ZONES / re-check poison — the vein was snapshotted when
    // picked; a later entry in it could since have been poisoned by a death
    // elsewhere in the same run. Never TARGET inside a no-go zone or a
    // poisoned spot, full stop.
    if (!isUsable(targetPos)) continue;

    let watchdog;
    try {
      watchdog = await runTargetWithWatchdog(bot, ctx, 25000, async () => {
        // (2a) PRE-DESCENT GUARD — must fire BEFORE any movement toward this
        // target, never after. mineBlocks does not auto-build a staircase to
        // reach a deep target (that's the separate, deliberate buildStaircase
        // skill) — a target more than 4 blocks below the bot's own feet is
        // skipped outright. Field-fatal without this: blind-goto toward a
        // far-below target let pathfinder route through an open shaft and a
        // bot fell from y89 to y26.
        const depthBelow = Math.floor(bot.entity.position.y) - Math.floor(targetPos.y);
        if (depthBelow > 4) {
          throw new Error('too deep, needs staircase');
        }
        ctx.setTargetPos?.(targetPos);

        let reached = false;
        let lastReachErr = null;
        for (let attempt = 1; attempt <= 2 && !reached; attempt++) {
          try {
            await gotoLoop(
              bot,
              new goals.GoalGetToBlock(targetPos.x, targetPos.y, targetPos.z),
              { timeoutMs: 20000, maxAttempts: 2 },
              ctx
            );
            reached = true;
          } catch (err) {
            lastReachErr = err;
            ctx.log?.('warn', `mineBlocks: unreachable attempt ${attempt}/2 for ${block} at ${key}: ${err.message}`);
          }
        }
        if (!reached) throw new Error(`unreachable: ${lastReachErr?.message ?? 'unknown'}`);

        // Re-equip the best pickaxe per block — equip does not persist between digs.
        const preDigBlock = bot.blockAt(targetPos);
        if (preDigBlock) {
          try {
            await bot.tool.equipForBlock(preDigBlock, { requireHarvest: false });
          } catch (err) {
            ctx.log?.('warn', `mineBlocks: equip failed for ${block} at ${key}: ${err.message}`);
          }
        }

        const freshBlock = bot.blockAt(targetPos);
        if (!freshBlock || freshBlock.name !== block) {
          // Someone/something already took it — try again, no penalty.
          return { taken: true };
        }

        const preDigSnapshot = snapshotInventory(bot);
        await safeDig(bot, freshBlock, ctx);
        const collected = await stepOntoAndCollect(bot, targetPos, ctx, 4, preDigSnapshot);
        return { minedPos: toPlainPos(targetPos), collected };
      });
    } catch (err) {
      skippedKeys.add(key);
      skipped.push({ pos: toPlainPos(targetPos), reason: err.message });
      // (2d) a "too deep, needs staircase" target means the rest of this
      // vein is on the same unreachable ledge — skip it whole instead of
      // burning one watchdog timeout per block re-discovering the same
      // depth wall.
      if (err.message === 'too deep, needs staircase') {
        for (const p of currentVein) skippedKeys.add(posKey(p));
        currentVein = [];
      }
      continue;
    }

    if (watchdog.stalled) {
      skippedKeys.add(key);
      skipped.push({ pos: toPlainPos(targetPos), reason: 'stalled' });
      consecutiveStalls++;
      ctx.log?.('warn', `mineBlocks: target at ${key} stalled (${consecutiveStalls}/3)`);
      if (consecutiveStalls >= 3) throw new Error('stalled');
      continue;
    }
    consecutiveStalls = 0;

    if (watchdog.result?.taken) {
      continue;
    }

    mined.push(watchdog.result.minedPos);
    collectedAll.push(...(watchdog.result.collected || []));

    // (2b) Vein finished — sweep any drops still lying around this pocket
    // BEFORE walking off toward the next (possibly distant) vein, so a slow
    // drop doesn't get abandoned mid-hop.
    if (currentVein.length === 0) {
      const { collected: veinSweep } = await collectNear(bot, ctx, 6).catch(() => ({ collected: [] }));
      collectedAll.push(...veinSweep);
    }
  }

  // (8) End-of-task late-drop sweep — leaf/ore decay drops can lag.
  await sleep(2500);
  const { collected: late } = await collectDrops(bot, { radius: 24 }, ctx).catch(() => ({ collected: [] }));
  collectedAll.push(...late);

  return { mined: mined.length, positions: mined, skipped, collected: mergeCounts(collectedAll) };
}

// ---------------------------------------------------------------------------
// collectDrops
// ---------------------------------------------------------------------------

// (FIELD BUG, Bonk 2026-09-01 — FEEDBACK.md "/collect finds nothing despite
// real nearby drops") A raw `Object.values(bot.entities).filter(e =>
// e.name==='item')` scan found 9-11 real drops 2.8-8 blocks away — well
// inside radius — while collectDrops still came back {collected:[]}, twice.
// Filter/entity-detection itself checks out (e.name==='item' is correct for
// this repo's mineflayer 4.35.0 + minecraft-data, confirmed against
// entities.json; distanceTo is a real 3D check, not something silently NaN'd
// — Number.isFinite guard added below anyway, cheap insurance). stuckIds is
// function-local and freshly created every call — no cross-call leak.
// Root cause: the only approach goal used to be GoalBlock onto the drop's own
// EXACT voxel, no fallback. Bonk's own report already named the likely
// cause — drops landing "inside/near dug-out pockets" from mining — and it
// checks out: now that travel Movements are no-dig (m.canDig=false, see
// runner.js's safety-Movements comment), that one exact voxel is very often
// not part of the walkable graph in honeycombed post-mining terrain, even
// though an immediately adjacent voxel — well within vanilla's own pickup
// range — is perfectly reachable. Falling back to the 6 lateral/vertical
// neighbor voxels before giving up fixes that without ever needing to dig.
// Every branch below now logs to ctx.log so a future empty result is never
// unexplained again.
const DROP_NEIGHBOR_OFFSETS = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
];

export async function collectDrops(bot, opts = {}, ctx = {}) {
  const radius = opts.radius ?? 16;
  const maxIterations = opts.maxIterations ?? 24;

  // Verified against this repo's installed mineflayer (4.35.0 + minecraft-data
  // entities.json): dropped-item entities always report e.name === 'item' —
  // do not gate on e.type/objectType, those aren't set that way here.
  const isDrop = (e) =>
    e &&
    e.name === 'item' &&
    e.position &&
    Number.isFinite(e.position.x) &&
    bot.entity.position.distanceTo(e.position) <= radius;

  const before = snapshotInventory(bot);
  const stuckIds = new Set();
  let iterations = 0;
  let reachFailures = 0;
  let pickupMisses = 0;

  const startCandidates = Object.values(bot.entities).filter((e) => isDrop(e)).length;
  ctx.log?.('info', `collectDrops: ${startCandidates} item drop(s) within ${radius} blocks at start`);

  // bot.collectBlock.collect() used to do this via GoalFollow(entity, 0), but
  // one unreachable drop in the batch throws and silently aborts every drop
  // after it. Walk drops one at a time instead, so a stuck drop can't eat the
  // rest of the pile.
  while (iterations < maxIterations) {
    iterations++;
    if (ctx.isCancelled?.()) break;

    const drop = bot.nearestEntity((e) => isDrop(e) && !stuckIds.has(e.id));
    if (!drop) break;
    const dropId = drop.id;
    const dropPos = drop.position.clone();
    const dest = dropPos.floored();

    // Vanilla pickup radius is tight (~1 block from the player). GoalBlock
    // onto the drop's own exact voxel is tried first — path onto the drop's
    // exact block instead of a slack GoalNear that can stop 1.5+ blocks
    // short. If that exact voxel isn't reachable without digging
    // (honeycombed mining pockets — see field bug note above), fall back to
    // whichever neighbor voxel IS reachable before giving up on the drop.
    let arrived = false;
    let lastErr = null;
    const attempts = [dest, ...DROP_NEIGHBOR_OFFSETS.map((o) => dest.offset(o.x, o.y, o.z))];
    for (let i = 0; i < attempts.length && !arrived; i++) {
      const c = attempts[i];
      const goOpts = i === 0 ? { timeoutMs: 8000, maxAttempts: 2 } : { timeoutMs: 4000, maxAttempts: 1 };
      try {
        await gotoLoop(bot, new goals.GoalBlock(c.x, c.y, c.z), goOpts, ctx);
        arrived = true;
        if (i > 0) {
          ctx.log?.(
            'info',
            `collectDrops: exact voxel at ${posKey(dest)} unreachable, reached neighbor ${posKey(c)} instead`
          );
        }
      } catch (err) {
        lastErr = err;
      }
    }

    if (!arrived) {
      reachFailures++;
      ctx.log?.(
        'warn',
        `collectDrops: could not reach drop ${dropId} at ${posKey(dropPos)} (exact voxel + ${DROP_NEIGHBOR_OFFSETS.length} neighbors all failed): ${lastErr?.message ?? 'unknown'}`
      );
      stuckIds.add(dropId);
      continue;
    }

    // Give the server a tick to register the pickup once we're standing on it.
    await sleep(250);

    // Only mark it "handled" once it's actually gone — a drop that's still
    // sitting there after arrival didn't get collected, don't loop on it forever.
    if (bot.entities[dropId]) {
      pickupMisses++;
      const dist = bot.entity.position.distanceTo(dropPos);
      ctx.log?.(
        'warn',
        `collectDrops: arrived near drop ${dropId} at ${posKey(dropPos)} (${dist.toFixed(2)} blocks off now) but it is still there — not picked up`
      );
      stuckIds.add(dropId);
    }
  }

  try {
    bot.pathfinder.setGoal(null);
  } catch {
    // ignore
  }

  const after = snapshotInventory(bot);
  const collected = diffInventory(before, after);
  ctx.log?.(
    'info',
    `collectDrops: done — ${collected.length} item type(s) collected, ${reachFailures} unreachable, ${pickupMisses} reached-but-missed, ${iterations} iteration(s)`
  );
  return { collected };
}

// ---------------------------------------------------------------------------
// huntAnimals — passive mobs only, NEVER players.
// ---------------------------------------------------------------------------

export async function huntAnimals(bot, opts = {}, ctx = {}) {
  const mob = opts.mob;
  const count = opts.count ?? 1;
  const maxDistance = opts.maxDistance ?? 48;
  if (!mob) throw new Error('huntAnimals: "mob" is required');
  const wanted = String(mob).toLowerCase();
  if (wanted === 'player' || wanted === 'players') {
    throw new Error('huntAnimals: refuses to target players');
  }
  if (!PASSIVE_MOBS.has(wanted)) {
    throw new Error(`huntAnimals: "${wanted}" is not on the passive-mob allowlist — refusing`);
  }

  let killed = 0;
  const collectedAll = [];

  for (let i = 0; i < count; i++) {
    if (ctx.isCancelled?.()) break;
    await checkHealthRetreat(bot, ctx);
    ctx.setDetail?.(`hunting ${wanted} ${i + 1}/${count}`);

    const target = bot.nearestEntity((e) => {
      if (!e || e.type === 'player') return false; // never target players, ever
      const name = (e.name || '').toLowerCase();
      if (name !== wanted) return false;
      if (!e.position) return false;
      return bot.entity.position.distanceTo(e.position) <= maxDistance;
    });
    if (!target) {
      ctx.log?.('warn', `huntAnimals: no ${wanted} found within ${maxDistance} blocks`);
      break;
    }
    const targetId = target.id;

    try {
      await gotoLoop(bot, new goals.GoalFollow(target, 2), { timeoutMs: 20000, maxAttempts: 3 }, ctx);
    } catch (err) {
      ctx.log?.('warn', `huntAnimals: could not reach ${wanted}: ${err.message}`);
      continue;
    }

    if (bot.pvp && typeof bot.pvp.attack === 'function') {
      const stillThere = bot.entities[targetId];
      if (stillThere) {
        try {
          // pvp.attack() only SETS the target and resolves immediately — it
          // does not wait for the kill. Awaiting it and then calling
          // forceStop() right away would tap the mob once and walk off.
          await bot.pvp.attack(stillThere);
        } catch (err) {
          ctx.log?.('warn', `huntAnimals: pvp.attack error: ${err?.message ?? err}`);
        }
        let waitedMs = 0;
        while (bot.entities[targetId] && waitedMs < 30000 && !ctx.isCancelled?.()) {
          await sleep(500);
          waitedMs += 500;
        }
      }
      try {
        bot.pvp.forceStop();
      } catch {
        // ignore
      }
    } else {
      // Manual fallback when mineflayer-pvp isn't loaded.
      let attempts = 0;
      while (attempts < 40) {
        attempts++;
        const stillThere = bot.entities[targetId];
        if (!stillThere) break;
        if (stillThere.type === 'player') break; // safety: never attack a player
        const dist = bot.entity.position.distanceTo(stillThere.position);
        if (dist > 3.5) {
          await gotoLoop(bot, new goals.GoalFollow(stillThere, 2), { timeoutMs: 8000, maxAttempts: 2 }, ctx).catch(() => {});
        }
        const stillThere2 = bot.entities[targetId];
        if (!stillThere2) break;
        bot.attack(stillThere2);
        await sleep(600);
      }
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        // ignore
      }
    }

    await sleep(500);
    const { collected } = await collectNear(bot, ctx, 10).catch(() => ({ collected: [] }));
    collectedAll.push(...collected);
    // Only count it if the entity is actually gone — a survivor is not a kill.
    if (!bot.entities[targetId]) killed++;
  }

  return { killed, mob: wanted, requested: count, collected: mergeCounts(collectedAll) };
}

// ---------------------------------------------------------------------------
// deposit / withdraw
// ---------------------------------------------------------------------------

// (FIELD BUG, UngaBunga 2026-09-01 — FEEDBACK "pf engine 'goal changed'
// false-fail on short hops") gotoLoop is pathfinder-only, so /deposit and
// /withdraw had no way to dodge a pf that was failing a 1-2 block hop right
// after a blink restart — the same target went through first try on
// engine:"ash". opts.engine (auto|ash|pf, threaded from the HTTP body) routes
// the chest approach through movement.goTo instead, which owns the ash path
// and the auto ash->pf fallback. Omitted or "pf" keeps the ORIGINAL gotoLoop
// call byte-for-byte (GoalGetToBlock + the wedge-detection retry it carries),
// so nothing changes for any existing caller.
async function gotoChestBlock(bot, pos, ctx, opts = {}) {
  const engine = opts.engine;
  if (engine && engine !== 'pf') {
    // movement.goTo speaks {x,y,z,range} rather than a pathfinder Goal
    // object. range 2 lands the bot inside the 4.2-block reach law that
    // ensureWithinReach/openChest need, without demanding the exact
    // GoalGetToBlock cell (which is what pf kept fighting over on short hops).
    await movement.goTo(bot, { x: pos.x, y: pos.y, z: pos.z, range: 2, timeoutMs: 30000, engine }, ctx);
  } else {
    await gotoLoop(bot, new goals.GoalGetToBlock(pos.x, pos.y, pos.z), { timeoutMs: 30000, maxAttempts: 5 }, ctx);
  }
  const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
  if (!block || !/chest|barrel|shulker_box/.test(block.name)) {
    throw new Error(`no chest-like container at ${pos.x},${pos.y},${pos.z} (found ${block ? block.name : 'nothing'})`);
  }
  return block;
}

// (6) COUNT SUPPORT — `items` may still be a plain array of name strings
// (deposit/withdraw everything of that name — the original, unchanged
// behavior), or entries may be `{name, count}` to move only part of a
// stack. Mixed arrays work too. Normalizes both shapes to {name, count},
// count undefined meaning "all of it".
function normalizeItemSpecs(items) {
  return items.map((it) => {
    if (typeof it === 'string') return { name: it, count: undefined };
    if (!it || typeof it.name !== 'string' || !it.name) {
      throw new Error('items entries must be a name string or {name, count}');
    }
    // Defensive: /eval callers reach these functions directly, without the
    // runner's endpoint validation in front of them. A junk count is a
    // caller bug, not a silent "move nothing" (or worse, a NaN handed to
    // win.withdraw/win.deposit).
    if (it.count === undefined || it.count === null) return { name: it.name, count: undefined };
    // Same floored gate the runner's validateItemsBody uses: 0.9 must not
    // slip through a bare "> 0" check and floor to a silent zero-item move.
    if (typeof it.count !== 'number' || !Number.isFinite(it.count) || Math.floor(it.count) < 1) {
      throw new Error(`items: "count" for ${it.name} must be a number >= 1 (got ${JSON.stringify(it.count)})`);
    }
    return { name: it.name, count: Math.floor(it.count) };
  });
}

export async function depositToChest(bot, opts = {}, ctx = {}) {
  const pos = opts.pos;
  const items = opts.items;
  if (!pos) throw new Error('depositToChest: "pos" is required');

  const chestBlock = await gotoChestBlock(bot, pos, ctx, { engine: opts.engine });
  ctx.setDetail?.('opening chest to deposit');
  const win = await bot.openChest(chestBlock);
  const deposited = [];
  try {
    const specs = items && items.length ? normalizeItemSpecs(items) : null;
    const wanted = specs
      ? bot.inventory.items().filter((it) => specs.some((s) => s.name === it.name))
      : bot.inventory.items().filter((it) => !isToolLike(it.name));

    const merged = new Map();
    for (const it of wanted) {
      const k = `${it.type}:${it.metadata ?? 0}`;
      const cur = merged.get(k) || { type: it.type, metadata: it.metadata, name: it.name, count: 0 };
      cur.count += it.count;
      merged.set(k, cur);
    }
    for (const it of merged.values()) {
      // (6) A count on the matching spec caps how much of this stack moves;
      // no spec (bare deposit-everything call) or no count on it means the
      // full merged stack, same as before.
      const spec = specs?.find((s) => s.name === it.name);
      const toDeposit = typeof spec?.count === 'number' ? Math.min(spec.count, it.count) : it.count;
      if (toDeposit <= 0) continue;
      try {
        await win.deposit(it.type, it.metadata ?? null, toDeposit);
        deposited.push({ name: it.name, count: toDeposit });
      } catch (err) {
        ctx.log?.('warn', `depositToChest: failed to deposit ${it.name}: ${err.message}`);
      }
    }
  } finally {
    try {
      win.close();
    } catch {
      // ignore
    }
  }
  return { pos: toPlainPos(chestBlock.position), deposited };
}

export async function withdrawFromChest(bot, opts = {}, ctx = {}) {
  const pos = opts.pos;
  const items = opts.items;
  if (!pos) throw new Error('withdrawFromChest: "pos" is required');
  if (!items || !items.length) throw new Error('withdrawFromChest: "items" is required');

  const chestBlock = await gotoChestBlock(bot, pos, ctx, { engine: opts.engine });
  ctx.setDetail?.('opening chest to withdraw');
  const win = await bot.openChest(chestBlock);
  const withdrawn = [];
  try {
    const contents = win.containerItems();
    const specs = normalizeItemSpecs(items);
    for (const spec of specs) {
      const name = spec.name;
      const matches = contents.filter((it) => it.name === name);
      if (matches.length === 0) {
        ctx.log?.('warn', `withdrawFromChest: ${name} not found in chest`);
        continue;
      }
      const available = matches.reduce((sum, it) => sum + it.count, 0);
      // (6) A count on the spec caps how much comes out; no count (bare
      // name string, original behavior) withdraws everything found.
      const total = typeof spec.count === 'number' ? Math.min(spec.count, available) : available;
      if (total <= 0) continue;
      const { type, metadata } = matches[0];
      try {
        await win.withdraw(type, metadata ?? null, total);
        withdrawn.push({ name, count: total });
      } catch (err) {
        ctx.log?.('warn', `withdrawFromChest: failed to withdraw ${name}: ${err.message}`);
      }
    }
  } finally {
    try {
      win.close();
    } catch {
      // ignore
    }
  }
  return { pos: toPlainPos(chestBlock.position), withdrawn };
}

// ---------------------------------------------------------------------------
// giveItems — toss a stack toward a target position, then step 3 blocks back
// so vanilla auto-pickup doesn't just walk the bot right back onto its own
// drop (confirmed live: without the step-back, the "given" item silently
// stayed in inventory — the bot re-grabbed the toss before it ever settled).
// Verified via inventory-diff: a net decrease smaller than `count` means the
// bot reclaimed some or all of the toss, and that's reported as a failure,
// not papered over.
// ---------------------------------------------------------------------------

export async function giveItems(bot, opts = {}, ctx = {}) {
  const targetPos = opts.targetPos;
  const itemName = opts.itemName;
  const count = opts.count ?? 1;
  if (!targetPos || typeof targetPos.x !== 'number' || typeof targetPos.y !== 'number' || typeof targetPos.z !== 'number') {
    throw new Error('giveItems: "targetPos" {x,y,z} is required');
  }
  if (!itemName) throw new Error('giveItems: "itemName" is required');

  const before = itemCount(bot, itemName);
  if (before < count) throw new Error(`giveItems: only have ${before}x ${itemName}, need ${count}`);

  ctx.setDetail?.(`giveItems: heading to ${posKey(targetPos)} to toss ${count}x ${itemName}`);
  ctx.setTargetPos?.(targetPos);
  await gotoLoop(bot, new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2), { timeoutMs: 30000, maxAttempts: 3 }, ctx);

  const toToss = bot.inventory.items().find((it) => it.name === itemName);
  if (!toToss) throw new Error(`giveItems: ${itemName} vanished from inventory before toss`);
  await bot.toss(toToss.type, toToss.metadata ?? null, count);

  // Step 3 blocks back along the (bot -> target) line, away from the drop.
  const pos = bot.entity.position;
  const dx = pos.x - targetPos.x;
  const dz = pos.z - targetPos.z;
  const mag = Math.hypot(dx, dz) || 1;
  const back = { x: pos.x + (dx / mag) * 3, y: pos.y, z: pos.z + (dz / mag) * 3 };
  try {
    await gotoLoop(bot, new goals.GoalNear(back.x, back.y, back.z, 1), { timeoutMs: 10000, maxAttempts: 2 }, ctx);
  } catch (err) {
    ctx.log?.('warn', `giveItems: step-back failed (continuing to verify anyway): ${err.message}`);
  }

  await sleep(500);
  const after = itemCount(bot, itemName);
  const netGiven = before - after;
  if (netGiven < count) {
    throw new Error(
      `giveItems: toss verify failed — expected net -${count} ${itemName}, actual net -${netGiven} (before=${before}, after=${after}); the bot likely re-collected its own toss`
    );
  }
  return { targetPos: toPlainPos(targetPos), item: itemName, requested: count, given: netGiven };
}

// ---------------------------------------------------------------------------
// smeltItems — goto a furnace within 16 blocks, load input + fuel (default
// fuel: coal/charcoal, else *_planks from inventory), poll takeOutput until
// `count` worth has come out or timeoutMs elapses, then verify via
// inventory-diff that what was actually taken out of the furnace really
// landed in the bot's bag — never trust the poll loop's own bookkeeping
// alone (same "no diff = no success" rule as craftItem's fix).
// ---------------------------------------------------------------------------

export async function smeltItems(bot, opts = {}, ctx = {}) {
  const inputName = opts.input;
  const count = opts.count ?? 1;
  if (!inputName) throw new Error('smeltItems: "input" is required');

  const haveInput = itemCount(bot, inputName);
  if (haveInput < count) throw new Error(`smeltItems: only have ${haveInput}x ${inputName}, need ${count}`);

  const furnaceBlock = bot.findBlock({
    matching: (b) => FURNACE_BLOCKS.test(b.name),
    maxDistance: 16,
    point: bot.entity.position,
  });
  if (!furnaceBlock) throw new Error('smeltItems: no furnace within 16 blocks');
  const furnacePos = furnaceBlock.position.clone();

  ctx.setDetail?.(`smeltItems: heading to furnace at ${posKey(furnacePos)}`);
  ctx.setTargetPos?.(furnacePos);
  await gotoLoop(bot, new goals.GoalGetToBlock(furnacePos.x, furnacePos.y, furnacePos.z), { timeoutMs: 30000, maxAttempts: 5 }, ctx);

  const freshFurnace = bot.blockAt(furnacePos);
  if (!freshFurnace || !FURNACE_BLOCKS.test(freshFurnace.name)) {
    throw new Error(`smeltItems: no furnace-like block at ${posKey(furnacePos)} anymore`);
  }

  const preSnapshot = snapshotInventory(bot);
  const furnace = await bot.openFurnace(freshFurnace);
  const taken = [];
  try {
    const inputItem = bot.inventory.items().find((it) => it.name === inputName);
    if (!inputItem) throw new Error(`smeltItems: ${inputName} vanished from inventory before putInput`);
    await furnace.putInput(inputItem.type, inputItem.metadata ?? null, count);

    let fuelItem;
    if (opts.fuel) {
      fuelItem = bot.inventory.items().find((it) => it.name === opts.fuel);
      if (!fuelItem) throw new Error(`smeltItems: requested fuel "${opts.fuel}" not in inventory`);
    } else {
      fuelItem =
        bot.inventory.items().find((it) => it.name === 'coal' || it.name === 'charcoal') ||
        bot.inventory.items().find((it) => it.name.endsWith('_planks'));
      if (!fuelItem) throw new Error('smeltItems: no fuel available (need coal/charcoal in inventory, or pass "fuel")');
    }
    const fuelToPut = Math.min(fuelItem.count, Math.max(1, Math.ceil(count / 8)));
    await furnace.putFuel(fuelItem.type, fuelItem.metadata ?? null, fuelToPut);

    ctx.setDetail?.(`smeltItems: smelting ${count}x ${inputName}`);
    const timeoutMs = opts.timeoutMs ?? Math.max(40000, count * 12000);
    const deadline = Date.now() + timeoutMs;
    let takenCount = 0;
    while (takenCount < count && Date.now() < deadline) {
      if (ctx.isCancelled?.()) break;
      await sleep(2000);
      const outSlotItem = furnace.outputItem ? furnace.outputItem() : null;
      if (outSlotItem) {
        try {
          const out = await furnace.takeOutput();
          if (out) {
            taken.push({ name: out.name, count: out.count });
            takenCount += out.count;
          }
        } catch (err) {
          ctx.log?.('warn', `smeltItems: takeOutput error (will keep polling): ${err.message}`);
        }
      }
    }
  } finally {
    try {
      furnace.close();
    } catch {
      // ignore
    }
  }

  // INVENTORY-DIFF VERIFY — the poll loop's own `taken` bookkeeping is not
  // proof by itself (a takeOutput() could in principle resolve without the
  // stack actually landing back in the bot's inventory, e.g. a full
  // inventory silently dropping it). Confirm each taken item really shows up
  // as a net gain before calling this a success.
  const after = snapshotInventory(bot);
  const gained = diffInventory(preSnapshot, after);
  const takenTotals = mergeCounts(taken);
  const verified = taken.length > 0 && takenTotals.every((t) => {
    const g = gained.find((x) => x.name === t.name);
    return g && g.count >= t.count;
  });
  if (!verified) {
    throw new Error(
      `smeltItems: no verified output — took ${JSON.stringify(takenTotals)}, inventory diff shows ${JSON.stringify(gained)} (furnace may have timed out, or output was never confirmed in the bag)`
    );
  }

  return { input: inputName, requested: count, smelted: takenTotals, furnace: toPlainPos(furnacePos) };
}

// ---------------------------------------------------------------------------
// safeDescend — staircase down, never straight-dig, seal fluids, flee lava.
// ---------------------------------------------------------------------------

async function sealBlock(bot, pos, ctx) {
  const material = bot.inventory.items().find((it) => SEAL_MATERIALS.test(it.name));
  if (!material) {
    ctx.log?.('warn', `safeDescend: no block on hand to seal ${posKey(pos)}`);
    return false;
  }
  const below = bot.blockAt(pos.offset(0, -1, 0));
  if (!below || below.name === 'air') return false;
  await bot.equip(material, 'hand');
  await safePlaceBlock(bot, below, new Vec3(0, 1, 0), ctx, pos);
  return true;
}

export async function safeDescend(bot, opts = {}, ctx = {}) {
  const targetY = opts.targetY;
  if (typeof targetY !== 'number') throw new Error('safeDescend: "targetY" is required');

  const startY = bot.entity.position.y;
  if (targetY >= startY) {
    return { descended: 0, finalY: Math.floor(startY), reason: 'already at or above targetY' };
  }

  const dirs = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 },
  ];
  const maxSteps = Math.ceil(startY - targetY) * 3 + 20;
  let steps = 0;

  while (bot.entity.position.y > targetY && steps < maxSteps) {
    if (ctx.isCancelled?.()) break;
    steps++;
    ctx.setDetail?.(`descending, y=${Math.floor(bot.entity.position.y)} -> ${targetY}`);

    const pos = bot.entity.position.floored();

    // Stop and fail immediately on lava sight — never step toward it.
    for (const d of dirs) {
      for (const dy of [0, -1, 1]) {
        const b = bot.blockAt(pos.offset(d.x, dy, d.z));
        if (b && b.name === 'lava') {
          throw new Error(`safeDescend: lava spotted near ${posKey(pos)} — stopping for safety`);
        }
      }
    }

    const dir = dirs[steps % dirs.length];
    const frontPos = pos.offset(dir.x, 0, dir.z);
    const frontAbove = frontPos.offset(0, 1, 0);
    const belowFront = frontPos.offset(0, -1, 0);
    const belowFrontBlock = bot.blockAt(belowFront);
    ctx.setTargetPos?.(belowFront);

    if (belowFrontBlock && (belowFrontBlock.name === 'lava' || belowFrontBlock.name === 'water')) {
      // Never dig straight down into a fluid — seal it instead and try another heading.
      await sealBlock(bot, belowFront, ctx).catch(() => {});
      continue;
    }

    for (const digPos of [frontPos, frontAbove]) {
      const b = bot.blockAt(digPos);
      if (b && b.diggable) {
        try {
          await bot.tool.equipForBlock(b, { requireHarvest: false });
        } catch {
          // ignore — not every block needs a tool
        }
        try {
          await safeDig(bot, b, ctx);
        } catch (err) {
          ctx.log?.('warn', `safeDescend: dig failed at ${posKey(digPos)}: ${err.message}`);
        }
      }
    }

    if (belowFrontBlock && belowFrontBlock.diggable && belowFrontBlock.name !== 'air') {
      try {
        await bot.tool.equipForBlock(belowFrontBlock, { requireHarvest: false });
      } catch {
        // ignore
      }
      try {
        await safeDig(bot, belowFrontBlock, ctx);
      } catch (err) {
        ctx.log?.('warn', `safeDescend: dig-below failed at ${posKey(belowFront)}: ${err.message}`);
      }
    }

    try {
      await gotoLoop(bot, new goals.GoalNear(belowFront.x, belowFront.y, belowFront.z, 0), { timeoutMs: 8000, maxAttempts: 2 }, ctx);
    } catch (err) {
      ctx.log?.('warn', `safeDescend: step toward ${posKey(belowFront)} failed: ${err.message}`);
    }
  }

  return { descended: startY - bot.entity.position.y, finalY: Math.floor(bot.entity.position.y) };
}

// ---------------------------------------------------------------------------
// (9) ensureTool(kind) — resolution order (the depot step is ALWAYS tried
// before anything that gathers, never as a post-failure fallback):
//   (a) inventory already has an adequate tool → equip it
//   (b) depot chest at (11,89,55) reachable + has one → withdraw + chat ledger;
//       no tool in there → withdraw craft MATERIALS from the same open window
//       (see withdrawCraftMaterials) so (c) does not have to gather them
//   (c) craft chain: logs → planks/sticks → crafting table → wooden_pickaxe
//       → 3 (shallow, depth-gated) cobblestone → stone_pickaxe/stone_axe
// Wired into chopTrees (axe, best-effort) and mineBlocks (pickaxe, required).
// ---------------------------------------------------------------------------

// bot.recipesFor()/bot.craft() duplicate the pattern runner.js's own
// craftItem() uses (skills.js can't import from runner.js — that would be a
// circular import, runner.js is the one that imports skills.js). Kept
// deliberately simple: hand-craftable items only (planks, sticks, the table
// itself) — anything needing a 3x3 grid goes through craftWithTable() below.
async function craftLocal(bot, itemName, amount, ctx) {
  const itemDef = ctx.mcData?.itemsByName?.[itemName];
  if (!itemDef) throw new Error(`craftLocal: unknown item "${itemName}" (mcData missing or item not found)`);
  const recipes = bot.recipesFor(itemDef.id, null, 1, null);
  if (recipes.length === 0) throw new Error(`craftLocal: no hand recipe for "${itemName}" (missing ingredients?)`);
  await bot.craft(recipes[0], amount, undefined);
  return { item: itemName, amount };
}

async function ensureCraftingTableNearby(bot, ctx) {
  const existing = bot.findBlock({
    matching: (b) => b.name === 'crafting_table',
    maxDistance: 40,
    point: bot.entity.position,
  });
  if (existing) return existing;

  // Craft + place our own — spec: "use camp table (12,89,56) if within 40,
  // else craft+place own". findBlock above already covers "any table within
  // 40" (the camp table included, if it's actually there); this is the
  // fallback when nothing was found.
  const planksItem = bot.inventory.items().find((it) => it.name.endsWith('_planks'));
  if (!planksItem || planksItem.count < 4) {
    throw new Error('ensureTool: not enough planks to craft a crafting_table (need 4)');
  }
  await craftLocal(bot, 'crafting_table', 1, ctx);
  const tableItem = bot.inventory.items().find((it) => it.name === 'crafting_table');
  if (!tableItem) throw new Error('ensureTool: crafting_table craft reported success but item not in inventory');

  const belowPos = bot.entity.position.floored().offset(0, -1, 0);
  const ground = bot.blockAt(belowPos);
  if (!ground || ground.name === 'air') {
    throw new Error('ensureTool: no solid ground under feet to place a crafting_table on');
  }
  await bot.equip(tableItem, 'hand');
  await safePlaceBlock(bot, ground, new Vec3(0, 1, 0), ctx, belowPos.offset(0, 1, 0));
  const placed = bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 4, point: bot.entity.position });
  if (!placed) throw new Error('ensureTool: placed crafting_table not found afterward');
  ctx.log?.('info', `ensureTool: crafted + placed own crafting_table at ${posKey(placed.position)}`);
  return placed;
}

async function craftWithTable(bot, itemName, amount, ctx) {
  const table = await ensureCraftingTableNearby(bot, ctx);
  await gotoLoop(
    bot,
    new goals.GoalGetToBlock(table.position.x, table.position.y, table.position.z),
    { timeoutMs: 30000, maxAttempts: 3 },
    ctx
  );
  const itemDef = ctx.mcData?.itemsByName?.[itemName];
  if (!itemDef) throw new Error(`craftWithTable: unknown item "${itemName}" (mcData missing or item not found)`);
  const tableBlock = bot.blockAt(table.position);
  const recipes = bot.recipesFor(itemDef.id, null, 1, tableBlock);
  if (recipes.length === 0) throw new Error(`craftWithTable: no recipe for "${itemName}" at crafting table (missing ingredients?)`);
  await bot.craft(recipes[0], amount, tableBlock);
  return { item: itemName, amount };
}

// (FIELD BUG, UngaBunga 2026-09-01 — FEEDBACK "ROOT CAUSE of chop deaths:
// ensureTool axe craft-chain wedges when totally bare" + its follow-up)
// Every chop death traced back to here: a bot holding ZERO log/plank/stick,
// with no crafting table and no depot chest in reach (90+ blocks out in the
// south wood zone), sat at detail "ensureTool: craft chain for axe" until the
// 90s wedge watchdog killed it. The chain had nothing to bootstrap the very
// first log from — and the one thing that always works, punching a log with
// a bare hand, was never attempted because the only log-gathering path was
// chopTrees, which is a whole task (ensureTool for an axe, tree checks,
// replant, watchdogs) rather than "get me one block of wood".
//
// So: punch first, task second. Bare-hand oak takes ~3s per log, needs no
// axe, no table, no depot, and no recursion. Same target filters chopTrees
// uses (camp quarantine, no-go zones, poisoned spots, natural-tree check) so
// this can never punch a build or trip the overseer's chop quarantine.
const BARE_HAND_LOG_MAX_DISTANCE = 32;

async function punchLogsBareHand(bot, ctx, wanted) {
  const skipped = new Set();
  let felled = 0;
  for (let i = 0; i < wanted; i++) {
    if (ctx.isCancelled?.()) break;
    const target = bot.findBlock({
      point: bot.entity.position,
      maxDistance: BARE_HAND_LOG_MAX_DISTANCE,
      // Same null-position guard as chopTrees: findBlock runs this matcher
      // once against a synthetic palette block with position === null.
      matching: (b) => /_log$/.test(b.name) && (!b.position || !skipped.has(posKey(b.position))),
    });
    if (!target) break;
    const pos = target.position.clone();
    skipped.add(posKey(pos));

    if (isPoisoned(ctx, pos) || isInNoGoZone(pos, ctx, true)) continue;
    if (Math.hypot(pos.x - CAMP_PROTECT_CENTER.x, pos.z - CAMP_PROTECT_CENTER.z) < CAMP_PROTECT_RADIUS) continue;
    if (!hasLeavesAboveTop(bot, pos)) continue; // built structure, not a tree

    try {
      ctx.setDetail?.(`ensureTool: bare-hand log punch at ${posKey(pos)}`);
      await gotoLoop(bot, new goals.GoalGetToBlock(pos.x, pos.y, pos.z), { timeoutMs: 20000, maxAttempts: 2 }, ctx);
      const fresh = bot.blockAt(pos);
      if (!fresh || !/_log$/.test(fresh.name)) continue;
      // Equip an axe IF one happens to be in the pouch — this path exists for
      // the bare case, but a bot with an axe and no logs should not punch
      // slowly out of principle. Failure here is fine: bare hand still works.
      try {
        await bot.tool.equipForBlock(fresh, { requireHarvest: false });
      } catch {
        // bare hand it is
      }
      const preDig = snapshotInventory(bot);
      await safeDig(bot, fresh, ctx);
      await stepOntoAndCollect(bot, pos, ctx, 4, preDig);
      felled++;
    } catch (err) {
      ctx.log?.('warn', `ensureTool: bare-hand punch at ${posKey(pos)} failed: ${err.message}`);
    }
  }
  return felled;
}

async function ensureLogs(bot, ctx, minLogs) {
  const haveLogs = () => bot.inventory.items().filter((it) => /_log$/.test(it.name)).reduce((s, it) => s + it.count, 0);
  if (haveLogs() >= minLogs) return true;

  // STEP 1 — bare-hand punch. Never more than 2 blocks: this is a bootstrap
  // to unblock the craft chain, not a wood run.
  const wanted = Math.min(2, Math.max(1, minLogs - haveLogs()));
  ctx.log?.('info', `ensureTool: bare-hand bootstrap, punching up to ${wanted} log(s) (have ${haveLogs()}, need ${minLogs})`);
  const punched = await punchLogsBareHand(bot, ctx, wanted).catch((err) => {
    ctx.log?.('warn', `ensureTool: bare-hand bootstrap failed: ${err.message}`);
    return 0;
  });
  if (haveLogs() >= minLogs) {
    ctx.log?.('info', `ensureTool: bare-hand bootstrap got ${punched} log(s) — chain can proceed`);
    return true;
  }

  // STEP 2 — only now fall back to the full chop task, for the case where
  // the punch found nothing within 32 blocks but a wider sweep might.
  ctx.log?.('info', `ensureTool: gathering logs (have ${haveLogs()}, need ${minLogs})`);
  try {
    // _skipEnsureTool: see the matching comment in chopTrees() — without it
    // this call recurses into ensureTool('axe') -> craftToolChain ->
    // ensurePlanksAndSticks -> ensureLogs -> chopTrees -> ... forever.
    await chopTrees(bot, { count: minLogs - haveLogs() + 1, _skipEnsureTool: true }, ctx);
  } catch (err) {
    ctx.log?.('warn', `ensureTool: chopTrees for logs failed: ${err.message}`);
  }
  return haveLogs() >= minLogs;
}

async function ensurePlanksAndSticks(bot, ctx) {
  // Need >=3 planks for a pickaxe/axe head plus >=2 planks worth of sticks —
  // keep this simple and just make sure we have a healthy buffer (>=5
  // planks, >=2 sticks) before attempting the tool recipe itself.
  let planks = bot.inventory.items().find((it) => it.name.endsWith('_planks'));
  if (!planks || planks.count < 5) {
    let log = bot.inventory.items().find((it) => /_log$/.test(it.name));
    if (!log) {
      if (!(await ensureLogs(bot, ctx, 2))) throw new Error('ensureTool: could not gather any logs for planks');
      log = bot.inventory.items().find((it) => /_log$/.test(it.name));
    }
    if (!log) throw new Error('ensureTool: no logs available to craft planks');
    const plankName = log.name.replace(/_log$/, '_planks');
    const logCount = itemCount(bot, log.name);
    await craftLocal(bot, plankName, Math.min(logCount, 4), ctx);
    planks = bot.inventory.items().find((it) => it.name.endsWith('_planks'));
  }
  if (!planks || planks.count < 5) throw new Error('ensureTool: not enough planks after crafting');

  if (itemCount(bot, 'stick') < 2) {
    await craftLocal(bot, 'stick', 1, ctx);
  }
  if (itemCount(bot, 'stick') < 2) throw new Error('ensureTool: not enough sticks after crafting');
  return true;
}

// Bootstrap-safe shallow cobblestone mining: called with only a fresh
// wooden_pickaxe, so this stays deliberately simple and hand-rolled rather
// than recursing into mineBlocks() (which itself calls ensureTool() for its
// own pickaxe requirement — recursing would loop). Surface stone only, same
// depth gate as mineBlocks.
//
// (19) DIG LAW EXEMPT — deliberately NOT gated on mine zones. This is a
// 3-block tool bootstrap within ~24 blocks of wherever the bot already
// stands, and gating it would deadlock the exact bare-handed-far-from-camp
// case the bootstrap exists to rescue (a bot with no pickaxe cannot walk to
// the mine zone to earn the pickaxe it needs to be allowed to mine).
// FLAGGED FOR TEAM-LEAD RULING: if the chief wants zero un-zoned digging at
// all, the fix is to make ensureTool's depot step carry cobble/tools rather
// than to gate this function — gating it alone just brings back the wedge.
async function mineShallowCobble(bot, count, ctx) {
  const collectedAll = [];
  let mined = 0;
  let attempts = 0;
  while (mined < count && attempts < count * 4 + 10) {
    attempts++;
    if (ctx.isCancelled?.()) break;
    const target = bot.findBlock({
      point: bot.entity.position,
      maxDistance: 24,
      matching: (b) => b.name === 'stone' && (!b.position || (withinDepthGate(bot, b.position) && !isPoisoned(ctx, b.position))),
    });
    if (!target) break;
    const pos = target.position.clone();
    try {
      await gotoLoop(bot, new goals.GoalGetToBlock(pos.x, pos.y, pos.z), { timeoutMs: 15000, maxAttempts: 2 }, ctx);
    } catch (err) {
      ctx.log?.('warn', `mineShallowCobble: unreachable stone at ${posKey(pos)}: ${err.message}`);
      continue;
    }
    try {
      await bot.tool.equipForBlock(target, { requireHarvest: false });
    } catch {
      // ignore
    }
    const fresh = bot.blockAt(pos);
    if (!fresh || fresh.name !== 'stone') continue;
    const preDigSnapshot = snapshotInventory(bot);
    try {
      await safeDig(bot, fresh, ctx);
    } catch (err) {
      ctx.log?.('warn', `mineShallowCobble: dig failed at ${posKey(pos)}: ${err.message}`);
      continue;
    }
    mined++;
    const collected = await stepOntoAndCollect(bot, pos, ctx, 4, preDigSnapshot);
    collectedAll.push(...collected);
  }
  return { mined, collected: mergeCounts(collectedAll) };
}

async function craftToolChain(bot, kind, ctx) {
  ctx.setDetail?.(`ensureTool: craft chain for ${kind}`);
  await ensurePlanksAndSticks(bot, ctx);

  // Wooden tier first — always a pickaxe, even when the caller wants an
  // axe, because a pickaxe is what lets us mine the cobblestone the stone
  // tier needs (an axe can't mine stone). Skip if any pickaxe is already
  // owned.
  const hasAnyPickaxe = bot.inventory.items().some((it) => /_pickaxe$/.test(it.name));
  if (!hasAnyPickaxe) {
    await ensurePlanksAndSticks(bot, ctx);
    await craftWithTable(bot, 'wooden_pickaxe', 1, ctx);
    ctx.log?.('info', 'ensureTool: crafted wooden_pickaxe (bootstrap)');
  }

  if (kind === 'axe') {
    const hasAxe = bot.inventory.items().some((it) => /_axe$/.test(it.name));
    if (!hasAxe) {
      await ensurePlanksAndSticks(bot, ctx);
      await craftWithTable(bot, 'wooden_axe', 1, ctx);
      ctx.log?.('info', 'ensureTool: crafted wooden_axe');
    }
  }

  // Upgrade path: mine 3 shallow cobblestone with whatever pickaxe we now
  // have, then craft the stone-tier tool the caller actually asked for. If
  // cobblestone can't be gathered, wooden tier is an acceptable outcome —
  // the caller already has SOME tool of the right family by this point.
  const haveCobble = itemCount(bot, 'cobblestone');
  if (haveCobble < 3) {
    const { mined } = await mineShallowCobble(bot, 3 - haveCobble, ctx);
    ctx.log?.('info', `ensureTool: mined ${mined} cobblestone toward stone tier`);
  }
  if (itemCount(bot, 'cobblestone') >= 3) {
    await ensurePlanksAndSticks(bot, ctx);
    const stoneName = kind === 'axe' ? 'stone_axe' : 'stone_pickaxe';
    const hasStone = bot.inventory.items().some((it) => it.name === stoneName);
    if (!hasStone) {
      await craftWithTable(bot, stoneName, 1, ctx);
      ctx.log?.('info', `ensureTool: crafted ${stoneName}`);
    }
  } else {
    ctx.log?.('warn', 'ensureTool: could not gather 3 cobblestone, staying at wooden tier');
  }
}

// (FIELD BUG, Durk 2026-09-01 — FEEDBACK "ensureTool has no chest-withdraw
// fallback when no trees nearby") Step (b) below only ever looked for a
// FINISHED tool in the depot. When chest A held no pickaxe but 70+ oak_planks
// and 42 oak_log, the bot walked to the chest, found no tool, walked away
// empty-handed and then failed the whole task in the craft chain with
// "ensureTool: could not gather any logs for planks" — because its current
// position had no reachable trees. The materials were sitting right there,
// one open window away, both times.
//
// So while that window is already open, top up whatever the craft chain is
// about to need. Wants are deliberately small (this is a tool bootstrap, not
// a resupply run) and expressed as shortfalls against what the bot already
// carries, so a bot with plenty takes nothing from the shared depot.
const ENSURE_TOOL_MATERIAL_WANTS = [
  // 5 planks is ensurePlanksAndSticks's own buffer; 8 leaves room for the
  // crafting_table (4) that ensureCraftingTableNearby may need to place.
  { label: 'planks', match: (name) => /_planks$/.test(name), need: 8 },
  { label: 'stick', match: (name) => name === 'stick', need: 4 },
  // Logs are ONLY the fallback for planks (2 logs -> 8 planks) — skipped
  // outright when the planks want came back satisfied. Without that gate
  // every toolless bootstrap pulled 2 depot logs it was never going to use,
  // on top of the planks it had just taken: a silent drain on the shared
  // wood buffer, which is exactly the kind of chest-A leak Durk's original
  // report was about.
  { label: 'log', match: (name) => /_log$/.test(name), need: 2, onlyIfShort: 'planks' },
  // craftToolChain's stone-tier upgrade needs exactly 3.
  { label: 'cobblestone', match: (name) => name === 'cobblestone', need: 3 },
];

async function withdrawCraftMaterials(bot, win, contents, ctx) {
  const taken = [];
  // label -> true when that want ended with its need still unmet (either the
  // chest had none, or it ran out mid-fill). Drives the onlyIfShort gate.
  const stillShort = new Map();
  for (const want of ENSURE_TOOL_MATERIAL_WANTS) {
    if (want.onlyIfShort && !stillShort.get(want.onlyIfShort)) continue;
    const have = bot.inventory
      .items()
      .filter((it) => want.match(it.name))
      .reduce((sum, it) => sum + it.count, 0);
    let short = want.need - have;
    if (short <= 0) {
      stillShort.set(want.label, false);
      continue;
    }
    for (const stack of contents.filter((it) => want.match(it.name))) {
      if (short <= 0) break;
      const n = Math.min(short, stack.count);
      try {
        await win.withdraw(stack.type, stack.metadata ?? null, n);
        taken.push({ name: stack.name, count: n });
        short -= n;
      } catch (err) {
        // A single unavailable stack (someone else's concurrent withdraw,
        // a full inventory) is never fatal here — the craft chain still has
        // its own gather path, this is a head start, not a requirement.
        ctx.log?.('warn', `ensureTool: depot withdraw of ${n}x ${stack.name} failed: ${err.message}`);
        break;
      }
    }
    // Anything left unfilled here (chest empty of it, or a withdraw that
    // failed part-way) is what makes a dependent want — logs for planks —
    // worth pulling at all.
    stillShort.set(want.label, short > 0);
  }
  return taken;
}

export async function ensureTool(bot, opts = {}, ctx = {}) {
  const kind = opts.kind;
  if (kind !== 'pickaxe' && kind !== 'axe') throw new Error('ensureTool: "kind" must be "pickaxe" or "axe"');
  const suffix = `_${kind}`;

  // (a) already-adequate tool in inventory.
  const owned = bot.inventory.items().find((it) => it.name.endsWith(suffix));
  if (owned) {
    await bot.equip(owned, 'hand');
    return { source: 'inventory', tool: owned.name };
  }

  // (b) depot chest — ALWAYS attempted before the craft chain (which is what
  // gathers/chops), never as a post-failure fallback. Two things come out of
  // it now: the finished tool if it's there, otherwise craft materials.
  let depotMaterials = [];
  try {
    const chestBlock = await gotoChestBlock(bot, DEPOT_POS, ctx, { engine: opts.engine });
    ctx.setDetail?.('ensureTool: checking depot chest');
    const win = await bot.openChest(chestBlock);
    let match = null;
    try {
      const contents = win.containerItems();
      match = contents.find((it) => it.name.endsWith(suffix)) || null;
      if (match) {
        await win.withdraw(match.type, match.metadata ?? null, 1);
      } else {
        depotMaterials = await withdrawCraftMaterials(bot, win, contents, ctx);
      }
    } finally {
      try {
        win.close();
      } catch {
        // ignore
      }
    }
    if (match) {
      const depotLine = `DEPOT -1 ${match.name} (chest A)`;
      // Grey narration via the runner's rconchat sayStatus when ctx supplies
      // it (see runner.js's makeCtx) — it already falls back to bot.chat
      // internally on any rconchat trouble. Bare ctx (tests, /eval helpers
      // without a runner behind them) falls back to plain bot.chat here.
      if (typeof ctx.sayStatus === 'function') {
        await ctx.sayStatus(depotLine);
      } else {
        bot.chat(depotLine);
      }
      const got = bot.inventory.items().find((it) => it.name === match.name);
      if (got) await bot.equip(got, 'hand');
      return { source: 'depot', tool: match.name };
    }
  } catch (err) {
    ctx.log?.('warn', `ensureTool: depot chest unavailable/empty (${err.message}), falling back to craft chain`);
  }

  // Same ledger discipline as the tool line above — one DEPOT line per item
  // pulled, so the depot ledger parser sees material draws too and nothing
  // leaves chest A unaccounted for.
  for (const m of depotMaterials) {
    const depotLine = `DEPOT -${m.count} ${m.name} (chest A)`;
    if (typeof ctx.sayStatus === 'function') {
      await ctx.sayStatus(depotLine);
    } else {
      bot.chat(depotLine);
    }
  }
  if (depotMaterials.length) {
    ctx.log?.(
      'info',
      `ensureTool: no ${kind} in depot — withdrew craft materials instead (${depotMaterials.map((m) => `${m.count}x ${m.name}`).join(', ')})`
    );
  }

  // (c) craft chain — may still gather (chop/mine) for anything the depot
  // could not supply.
  await craftToolChain(bot, kind, ctx);
  const crafted = bot.inventory.items().find((it) => it.name.endsWith(suffix));
  if (!crafted) throw new Error(`ensureTool: craft chain finished but no ${kind} in inventory`);
  await bot.equip(crafted, 'hand');
  return { source: 'craft', tool: crafted.name, depotMaterials };
}

// ---------------------------------------------------------------------------
// (7) recoverKit — safe-goto to a death position (depth gate respected),
// collectDrops radius 8, time-boxed 90s total. No /recover endpoint exists
// in runner.js yet (out of this file's scope — see the report this worker
// filed); exported here so the orchestrator can wire an endpoint later.
// ---------------------------------------------------------------------------

function withDeadline(promise, ms) {
  if (ms <= 0) return Promise.reject(new Error('deadline exceeded'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`operation exceeded time budget (${ms}ms)`)), ms);
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

export async function recoverKit(bot, opts = {}, ctx = {}) {
  const deathPos = opts.deathPos;
  if (!deathPos || typeof deathPos.x !== 'number' || typeof deathPos.y !== 'number' || typeof deathPos.z !== 'number') {
    throw new Error('recoverKit: "deathPos" {x,y,z} is required');
  }

  // (5b) DESPAWN GATE — dropped-item entities are gone ~5 minutes after
  // death; sending the bot back in for kit that's already despawned is pure
  // risk for zero reward. Accepts either opts.deathAtMs (epoch ms) or
  // opts.deathTs (ISO string, matching runner.js's state.lastDeath.ts shape)
  // — skip the whole recovery if either says the death is older than 4min.
  const deathAtMs =
    typeof opts.deathAtMs === 'number' ? opts.deathAtMs : typeof opts.deathTs === 'string' ? Date.parse(opts.deathTs) : NaN;
  if (Number.isFinite(deathAtMs) && Date.now() - deathAtMs > 4 * 60 * 1000) {
    ctx.log?.(
      'warn',
      `recoverKit: death at ${posKey(deathPos)} is ${Math.round((Date.now() - deathAtMs) / 1000)}s old (>4min) — drops have despawned, skipping`
    );
    return {
      deathPos: toPlainPos(deathPos),
      skipped: true,
      reason: 'despawned',
      reachedDeathPos: false,
      staircased: false,
      collected: [],
      timedOut: false,
    };
  }

  // (5c) NO-GO ZONES — never send the bot into a forbidden area to fetch its
  // own kit; a death inside one is a write-off, not a retrieval job.
  // Field-fatal without this: recoverKit walked a bot into FEL's base and
  // cost 2 PvP deaths on top of the original one.
  if (isInNoGoZone(deathPos, ctx)) {
    return {
      deathPos: toPlainPos(deathPos),
      skipped: true,
      reason: 'no-go zone',
      reachedDeathPos: false,
      staircased: false,
      collected: [],
      timedOut: false,
    };
  }

  const timeBudgetMs = opts.timeBudgetMs ?? 90000;
  const deadline = Date.now() + timeBudgetMs;

  const result = {
    deathPos: toPlainPos(deathPos),
    reachedDeathPos: false,
    staircased: false,
    collected: [],
    timedOut: false,
  };

  ctx.setDetail?.(`recoverKit: heading to death pos ${posKey(deathPos)}`);
  ctx.setTargetPos?.(deathPos);

  // (5a) SURFACE-FIRST ROUTE — travel to the death x/z on the surface FIRST
  // via GoalXZ (it doesn't care about y, so pathfinder naturally hugs
  // walkable terrain instead of caring which shaft it's near), THEN descend
  // via the staircase pattern once actually above the target. Reversed
  // order (descend wherever the bot happened to be standing, then beeline
  // underground toward the death pos) is what let a recovery run wander
  // through unrelated terrain/bases on the way down.
  try {
    const remaining = deadline - Date.now();
    // (6) cap the surface leg at half of whatever's left — burning the
    // whole remaining budget just walking to the death x/z left nothing for
    // the descend+collect legs that still have to run after this.
    await withDeadline(
      gotoLoop(
        bot,
        new goals.GoalXZ(deathPos.x, deathPos.z),
        { timeoutMs: Math.min(remaining * 0.5, 60000), maxAttempts: 3 },
        ctx
      ),
      remaining
    );
  } catch (err) {
    ctx.log?.('warn', `recoverKit: surface travel to death x/z failed: ${err.message}`);
  }

  if (Date.now() >= deadline) {
    result.timedOut = true;
    return result;
  }

  // (5) SAFE DEPTH GATE, same rule as mineBlocks.
  const feetY = Math.floor(bot.entity.position.y);
  const targetY = Math.floor(deathPos.y);
  if (feetY - targetY > 4) {
    try {
      await safeDescend(bot, { targetY }, ctx);
      result.staircased = true;
    } catch (err) {
      ctx.log?.('warn', `recoverKit: safeDescend failed: ${err.message}`);
    }
  }

  if (Date.now() >= deadline) {
    result.timedOut = true;
    return result;
  }

  try {
    const remaining = deadline - Date.now();
    await withDeadline(
      gotoLoop(bot, new goals.GoalNear(deathPos.x, deathPos.y, deathPos.z, 2), { timeoutMs: Math.min(remaining, 30000), maxAttempts: 3 }, ctx),
      remaining
    );
    result.reachedDeathPos = true;
  } catch (err) {
    ctx.log?.('warn', `recoverKit: could not reach death pos: ${err.message}`);
  }

  if (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const { collected } = await withDeadline(collectDrops(bot, { radius: 8 }, ctx), remaining);
      result.collected = collected;
    } catch (err) {
      ctx.log?.('warn', `recoverKit: collectDrops interrupted: ${err.message}`);
      result.timedOut = true;
    }
  } else {
    result.timedOut = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// (14) STRUCTURED MINING — buildStaircase, branchMine.
// ---------------------------------------------------------------------------

function resolveDirection(opts) {
  const dir = (opts.direction || 'south').toLowerCase();
  if (!CARDINALS[dir]) throw new Error(`unknown direction "${opts.direction}" (expected north|south|east|west)`);
  return { name: dir, ...CARDINALS[dir] };
}

// Places (or crafts-then-places) a torch on the floor or nearest solid wall
// under the bot's feet. Crafts from coal/charcoal + a stick (1 stick + 1
// coal -> 4 torches) if none are already carried. Returns false, never
// throws, when torches just aren't available — torching is a nice-to-have,
// not a hard requirement of either structured-mining skill.
async function ensureTorches(bot, ctx) {
  if (bot.inventory.items().some((it) => it.name === 'torch')) return true;
  const coal = bot.inventory.items().find((it) => it.name === 'coal' || it.name === 'charcoal');
  const stick = bot.inventory.items().find((it) => it.name === 'stick');
  if (!coal || !stick) return false;
  try {
    await craftLocal(bot, 'torch', 1, ctx);
    return bot.inventory.items().some((it) => it.name === 'torch');
  } catch (err) {
    ctx.log?.('warn', `ensureTorches: craft failed: ${err.message}`);
    return false;
  }
}

async function placeTorchHere(bot, ctx) {
  const ok = await ensureTorches(bot, ctx);
  if (!ok) return false;
  const torch = bot.inventory.items().find((it) => it.name === 'torch');
  if (!torch) return false;
  const pos = bot.entity.position.floored();
  const candidates = [
    { ref: pos.offset(0, -1, 0), face: new Vec3(0, 1, 0) },
    { ref: pos.offset(1, 0, 0), face: new Vec3(-1, 0, 0) },
    { ref: pos.offset(-1, 0, 0), face: new Vec3(1, 0, 0) },
    { ref: pos.offset(0, 0, 1), face: new Vec3(0, 0, -1) },
    { ref: pos.offset(0, 0, -1), face: new Vec3(0, 0, 1) },
  ];
  for (const c of candidates) {
    const refBlock = bot.blockAt(c.ref);
    if (!refBlock || refBlock.name === 'air') continue;
    try {
      await bot.equip(torch, 'hand');
      // Probe loop — retry:false, the next candidate face IS the retry.
      await safePlaceBlock(bot, refBlock, c.face, ctx, c.ref.plus(c.face), { retry: false });
      return true;
    } catch {
      // try the next candidate face
    }
  }
  return false;
}

// Seals one cell (air/water/lava) by placing a seal-material block against
// whichever solid neighbor is available — used by buildStaircase's
// side+below exposure checks.
async function sealStairCell(bot, cellPos, ctx) {
  const b = bot.blockAt(cellPos);
  if (!b || !(b.name === 'air' || b.name === 'water' || b.name === 'lava')) return false;
  const material = bot.inventory.items().find((it) => SEAL_MATERIALS.test(it.name));
  if (!material) {
    ctx.log?.('warn', `sealStairCell: no seal material on hand for ${posKey(cellPos)}`);
    return false;
  }
  const neighborOffsets = [
    [0, -1, 0],
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (const [dx, dy, dz] of neighborOffsets) {
    const refPos = cellPos.offset(dx, dy, dz);
    const ref = bot.blockAt(refPos);
    if (ref && ref.name !== 'air' && ref.name !== 'water' && ref.name !== 'lava') {
      const faceVec = cellPos.minus(refPos);
      try {
        await bot.equip(material, 'hand');
        // Probe loop over up to 6 neighbor faces — retry:false keeps the
        // verify but not the second attempt, so a lava-adjacent
        // emergencySeal isn't spending ~20s working through dud faces.
        await safePlaceBlock(bot, ref, faceVec, ctx, cellPos, { retry: false });
        return true;
      } catch (err) {
        ctx.log?.('warn', `sealStairCell: place attempt against ${posKey(refPos)} failed: ${err.message}`);
      }
    }
  }
  ctx.log?.('warn', `sealStairCell: no solid neighbor found to seal ${posKey(cellPos)} against`);
  return false;
}

// ---------------------------------------------------------------------------
// (18) emergencySeal — "coffin" response to the panic reflex (adapted from
// felcrew-mcp survey findings: their unshipped survival-doctrine.md spec
// calls this a WALL_OFF response for far-from-home-or-low-health branches;
// built here as real code, reusing this file's own sealStairCell instead of
// a new placement routine). Seals the bot into a full 1x2 pocket — floor,
// the four side cells at BOTH feet and head level, and the cap above the
// head — with whatever seal-capable material is on hand, then best-effort
// eats once sealed. (The bot's own two body cells are unplaceable while it
// stands in them, so they are not attempted.) Called by runner.js's panic reflex (triggerPanic) when the
// bot is too far from camp or too deep below it for a blind flee to be safer
// than holing up. Never throws — every failure mode (no seal material, no
// food, an already-solid face) just means a smaller number in the returned
// summary.
// ---------------------------------------------------------------------------
export async function emergencySeal(bot, ctx = {}) {
  const pos = bot.entity.position.floored();
  // Cells to seal, feet-relative. The bot occupies (0,0,0) and (0,1,0) —
  // the server refuses placement into an entity's own bounding box, so those
  // two are skipped, not attempted-and-failed. Order matters: floor + feet
  // ring first (stops melee reach), head ring next (each head-ring cell can
  // then place against the fresh feet-ring block below it; stops arrows),
  // cap above the head last (places against the sealed head ring).
  const offsets = [
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [1, 1, 0],
    [-1, 1, 0],
    [0, 1, 1],
    [0, 1, -1],
    [0, 2, 0],
  ];
  let sealed = 0;
  for (const [dx, dy, dz] of offsets) {
    if (ctx.isCancelled?.()) break;
    const cellPos = pos.offset(dx, dy, dz);
    const ok = await sealStairCell(bot, cellPos, ctx).catch(() => false);
    if (ok) sealed++;
  }

  let ate = false;
  try {
    if (bot.autoEat && typeof bot.autoEat.eat === 'function') {
      await bot.autoEat.eat({ food: true, offhand: false });
      ate = true;
    } else {
      const food = bot.inventory
        .items()
        .find((it) => /(bread|cooked_|apple|carrot|potato|beetroot|melon_slice)/.test(it.name));
      if (food) {
        await bot.equip(food, 'hand');
        await bot.consume();
        ate = true;
      }
    }
  } catch (err) {
    ctx.log?.('warn', `emergencySeal: eat attempt failed: ${err.message}`);
  }

  return { pos: toPlainPos(pos), sealed, ate };
}

// Returns true when a block is solid ground — not air, not a liquid.
function isSolidGround(b) {
  return !!b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava';
}

// (VOID-AHEAD GUARD) — natural cave floors and cliff edges can leave the
// block under the NEXT tread as air/liquid. Called before the dig loop
// touches anything, while frontFeet (the tread's usual vertical reference)
// is still solid, so placement has the best chance of a valid neighbor.
// Prefers cobblestone, then dirt, matching what the bot actually carries.
// Throws the caller-specified error when out of both.
async function ensureTreadFoundation(bot, treadPos, ctx) {
  const b = bot.blockAt(treadPos);
  if (isSolidGround(b)) return true;
  const material =
    bot.inventory.items().find((it) => it.name === 'cobblestone') ||
    bot.inventory.items().find((it) => it.name === 'dirt');
  if (!material) {
    throw new Error('staircase: out of tread material (need cobble/dirt)');
  }
  const neighborOffsets = [
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, -1, 0],
  ];
  for (const [dx, dy, dz] of neighborOffsets) {
    const refPos = treadPos.offset(dx, dy, dz);
    const ref = bot.blockAt(refPos);
    if (isSolidGround(ref)) {
      const faceVec = treadPos.minus(refPos);
      try {
        await bot.equip(material, 'hand');
        await safePlaceBlock(bot, ref, faceVec, ctx, treadPos);
        return true;
      } catch (err) {
        ctx.log?.('warn', `ensureTreadFoundation: place attempt against ${posKey(refPos)} failed: ${err.message}`);
      }
    }
  }
  return false;
}

// True once the bot's real feet are inside stepPos (floored position match)
// or close enough to count as arrived — used by both advanceIntoStep's pulse
// loop and the post-backup recheck below it.
//
// (CALIBRATION) horizontal dist <0.6 AND feet y in [stepY, stepY+0.3] —
// field trace (Thak) proved the old single 3D distanceTo(<0.7) check was too
// tight for a legit 1-down landing: a diagonal-corner landing alone can put
// the bot up to ~0.707 blocks from center horizontally, and folding the y
// term into that same 3D distance pushed a real, valid landing past the 0.7
// cutoff. Horizontal and vertical are now checked separately instead.
function isInStepCell(bot, stepPos) {
  const feet = bot.entity.position.floored();
  if (feet.x === stepPos.x && feet.y === stepPos.y && feet.z === stepPos.z) return true;
  const pos = bot.entity.position;
  const dx = pos.x - (stepPos.x + 0.5);
  const dz = pos.z - (stepPos.z + 0.5);
  const horizDist = Math.hypot(dx, dz);
  return horizDist < 0.6 && pos.y >= stepPos.y && pos.y <= stepPos.y + 0.3;
}

// (STEP-ADVANCE FIX) — field trace with bot Thak proved the pathfinder
// short-hop (a plain GoalNear one step away) can resolve without the bot
// ever actually moving: 9 "completed" staircase steps logged digs + a torch
// each, but bot.entity.position sat pinned at (16.7,87,44.5) +/-0.2 on EVERY
// axis the whole run — the step counter was advancing on digs alone, never
// on real movement. Replaces that call with the manual technique bot Thak
// was hand-flown down staircases with all night: look at the tread center,
// pulse forward in short (250-350ms) bursts, jump ONLY when the tread is
// above the current floor (stepping down just falls the 1 block on its
// own), and re-measure REAL position after every single pulse — a resolved
// promise is never trusted alone (same lesson as movement.js's own THE
// DRAGON). Never throws; returns whether it actually landed in stepPos.
//
// (CALIBRATION) aim target's y is the bot's OWN current eye height, not
// stepPos.y+1.62 — for a 1-down step, stepPos.y+1.62 sits a full block below
// the bot's own eye level, forcing a steep downward pitch on every pulse.
// Recomputed every iteration (not once up front) so it tracks the bot's
// real eye height as it descends. Horizontal x/z only drive yaw; matching
// the eye y keeps pitch ~0 so the forward pulse walks off the ledge instead
// of catching the step's face/edge.
async function advanceIntoStep(bot, stepPos, ctx) {
  const steppingUp = stepPos.y > Math.floor(bot.entity.position.y);
  const deadline = Date.now() + 4000;
  // (RUNAWAY-FALL GUARD v2 — field death round 1, field near-death round 2)
  // startY is THIS CALL's own baseline, not stepPos.y. Round 2 field trace:
  // a prior step timed out (4s elapsed, isInStepCell never true) WITHOUT
  // ever tripping a stepPos-relative bail, because it never fell more than
  // 1.5 below ITS OWN target before the deadline — it was sinking slowly,
  // gaining downward velocity the whole time. The very next step then began
  // already-falling-fast and blew from -1.5-below-target to -6.6-below in
  // one detection window. Anchoring the bail to where THIS call started
  // (one block of legitimate step-down is never more than ~1.5 below
  // wherever the bot stood when the call began) catches that compounding
  // case immediately instead of measuring against a target that a fast
  // fall can leapfrog past between checks.
  const startY = bot.entity.position.y;
  const fallFloor = Math.min(stepPos.y, startY) - 1.5;
  function fellThrough() {
    return bot.entity.position.y < fallFloor;
  }
  try {
    while (Date.now() < deadline) {
      if (isInStepCell(bot, stepPos)) return true;
      if (ctx.isCancelled?.()) return isInStepCell(bot, stepPos);
      if (fellThrough()) {
        ctx.log?.(
          'warn',
          `advanceIntoStep: runaway fall detected below ${posKey(stepPos)} (call started y=${startY.toFixed(2)}, now y=${bot.entity.position.y.toFixed(2)}) — aborting pulse immediately`
        );
        return false;
      }
      const target = new Vec3(stepPos.x + 0.5, bot.entity.position.y + 1.62, stepPos.z + 0.5);
      // (LOOK-WAKE LAW, Thak 2026-09-01 — FEEDBACK "setControlState no-op
      // without preceding bot.look()") A forced look packet immediately
      // before the first control toggle of a burst is what makes the toggle
      // take effect at all: bare setControlState produced ZERO position or
      // velocity change across 3 full test batches, and a single
      // bot.look(yaw, pitch, true) in front of it fixed jump AND forward
      // every time. lookAt(target, true) IS that forced look (force=true is
      // the same packet), so this loop already satisfies the law — but only
      // when it succeeds, hence the fallback: never toggle a control without
      // some look packet having gone out first.
      try {
        await bot.lookAt(target, true);
      } catch {
        try {
          await bot.look(bot.entity.yaw, bot.entity.pitch, true);
        } catch {
          // ignore — still attempt to walk even if both look forms fail
        }
      }
      bot.setControlState('forward', true);
      if (steppingUp) bot.setControlState('jump', true);
      // Pulse in short sub-bursts (~90ms) with a fall check between each,
      // instead of one uninterrupted 250-350ms burst — once actually
      // falling, terminal velocity climbs fast and a single wide sleep can
      // cover several blocks before the next check ever runs. Total pulse
      // length is unchanged (~270-360ms across 3 sub-bursts).
      for (let sub = 0; sub < 3; sub++) {
        await sleep(90 + Math.floor(Math.random() * 30));
        if (fellThrough()) break;
      }
      bot.setControlState('forward', false);
      if (steppingUp) bot.setControlState('jump', false);
      if (fellThrough()) {
        ctx.log?.(
          'warn',
          `advanceIntoStep: runaway fall detected below ${posKey(stepPos)} (call started y=${startY.toFixed(2)}, now y=${bot.entity.position.y.toFixed(2)}) — aborting pulse immediately`
        );
        return false;
      }
    }
  } finally {
    try {
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
    } catch {
      // ignore
    }
  }
  return isInStepCell(bot, stepPos);
}

// buildStaircase({toY, direction?}) — PURE-DIG RELATIVE TUNNEL MACHINE.
//
// (REWRITE — eight straight field failures killed the old design) The old
// buildStaircase re-derived its target cells from the world every step
// (blockAt() lookups to pick "the viable heading", to decide what counts as
// a floor) — it terrain-followed and goal-sought (a pathfinder GoalNear
// backup on every failed advance). Last field trace: it computed a step
// THREE Y-LEVELS below the bot mid-run. Terrain-following + goal-seeking
// are exactly the failure mode: the moment blockAt() near an unloaded chunk
// edge or a weird cave void returns something unexpected, the old logic
// "corrects" toward that bad read instead of just continuing the tunnel.
//
// This version copies the bot's own hand-proven manual descent instead: one
// heading, chosen ONCE, dug forever. Every cell touched this step is a
// FIXED relative offset from cur = bot.entity.position.floored() — never a
// stored/predicted position, never a terrain scan. The machine does not
// look at the world to decide WHERE to go, only to decide what to dig and
// whether the floor needs a tread. It digs its own reality forward one cell
// at a time and trusts nothing else.
//
// Per step: dig the 3-cell walk-through column ahead (head/feet/lower, top
// to bottom so a falling gravel/sand block can't re-bury a cleared cell),
// foundation the new floor if it's air/liquid (ensureTreadFoundation — void-
// ahead guard, throws a clear error if out of cobble/dirt), then walk
// forward with the field-proven pulse-and-verify technique (advanceIntoStep
// above) — no pathfinder fallback, ever. A step counts (steps++) only once
// the landing is REAL-POSITION verified. Lava sighted anywhere in the step's
// cells seals it and aborts loud. 20 loop iterations in a row with no
// verified landing is the one hard safety abort (watchdog is now trivial:
// steps IS landings, so any stall shows up directly as stuck iterations).
// recoverFromCaughtFall — the runaway-fall guards above stop a plunge fast
// (round 2 field trace: a 5-block dip caught with zero HP lost, vs. the
// round 1 death before those guards existed), but a hard-abort on every
// single caught dip means the run never gets past the first natural cave
// breach in genuinely broken terrain — this test area is full of them. If
// the bot is actually fine (health checked, standing on real solid ground,
// not still mid-fall), let the run continue from its new position instead
// of throwing; only when it's NOT fine (still airborne, or hurt enough that
// checkHealthRetreat wants to intervene) does the caller still throw loud.
// Never masks an unsafe state — it only turns a SAFE caught dip into a
// resume instead of a full-run abort.
async function recoverFromCaughtFall(bot, ctx, stepStart) {
  await sleep(400); // let physics settle after the guard cut 'forward'
  const before = bot.health;
  try {
    await checkHealthRetreat(bot, ctx); // throws/retreats on its own thresholds if health is bad
  } catch (err) {
    ctx.log?.('warn', `recoverFromCaughtFall: checkHealthRetreat intervened (${err.message}) — not safe to resume`);
    return false;
  }
  const feetBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  const grounded = isSolidGround(feetBlock);
  const dropped = stepStart.y - bot.entity.position.y;
  if (!grounded) {
    ctx.log?.(
      'warn',
      `recoverFromCaughtFall: not standing on solid ground at ${posKey(bot.entity.position.floored())} — not safe to resume`
    );
    return false;
  }
  ctx.log?.(
    'warn',
    `recoverFromCaughtFall: caught a ${dropped.toFixed(1)}y dip near ${posKey(stepStart)}, now standing safely at ${posKey(bot.entity.position.floored())} (health ${before}->${bot.health}) — resuming staircase from here`
  );
  return true;
}

export async function buildStaircase(bot, opts = {}, ctx = {}) {
  const toY = opts.toY;
  if (typeof toY !== 'number') throw new Error('buildStaircase: "toY" is required');
  // FIXED HEADING — chosen ONCE, right here, from opts.direction or an east
  // default. NEVER recomputed from terrain for the rest of the run.
  const dir = opts.direction ? resolveDirection(opts) : { name: 'east', ...CARDINALS.east };
  const from = toPlainPos(bot.entity.position);
  if (bot.entity.position.y <= toY) {
    return { from, to: from, steps: 0, torches: 0, headings: 1, reason: 'already at or below toY' };
  }

  // (19) DIG LAW — a staircase is exempt ONLY when it is launched toward a
  // mine zone: the descending column from where the bot stands down to toY
  // has to pass through one. That is what separates "cutting the access
  // shaft into the mine" (legal, and it necessarily starts outside the zone,
  // up at the surface) from "sinking a private hole in the middle of the
  // landscape" (not legal). Heading drift moves x/z by a block or two per
  // step, which cannot walk a shaft out of a zone tens of blocks wide.
  {
    const startPos = bot.entity.position.floored();
    if (!columnEntersDigZone(startPos, startPos.y, toY)) {
      throw new Error(`buildStaircase: ${digLawRefusal(startPos, `descent to y${toY}`)}`);
    }
  }

  const maxSteps = 120;
  let steps = 0; // counts ONLY verified landings (point 5 of the design)
  let torchesPlaced = 0;
  let staleIterations = 0; // loop passes since the last verified landing
  let lastFailureDetail = null;
  // (MACRO DRIFT TRIPWIRE) — advanceIntoStep's own guard bails a single
  // call fast, but `cur` is re-read fresh every outer-loop pass, so a slow
  // multi-iteration sink (each single pass only a little worse than the
  // last, never tripping that pass's own 1.5-block check) would otherwise
  // never show up: every new `cur` just re-baselines to wherever the bot
  // already drifted to. lastVerifiedY anchors to the last CONFIRMED landing
  // instead and is never silently re-based, so any accumulated drop below
  // it — however it happened — throws instead of quietly continuing.
  let lastVerifiedY = bot.entity.position.y;

  while (bot.entity.position.y > toY && steps < maxSteps) {
    if (ctx.isCancelled?.()) break;
    await checkHealthRetreat(bot, ctx);
    if (bot.entity.position.y < lastVerifiedY - 3) {
      throw new Error(
        `buildStaircase: drifted to ${posKey(bot.entity.position.floored())}, ${(lastVerifiedY - bot.entity.position.y).toFixed(1)}y below the last verified landing (y=${lastVerifiedY.toFixed(1)}) without a counted step in between — likely an uncaught fall in progress, aborting`
      );
    }

    // (SAFETY WATCHDOG) — the only hard abort left. A verified landing
    // always makes real descent progress, so 20 iterations with none is a
    // genuine stall, not slow progress.
    if (staleIterations >= 20) {
      throw new Error(
        `buildStaircase: safety abort — 20 loop iterations with no verified landing, stuck near ${posKey(bot.entity.position.floored())} (heading ${dir.name})` +
          (lastFailureDetail ? `; last failure: ${lastFailureDetail}` : '')
      );
    }

    // (UNGROUNDED-START GUARD) — field trace round 1: a caught fall left
    // over from a prior run (stopped before this guard existed) can park
    // the bot on a corner perch — air directly under its OWN reported feet
    // cell, held up only by an adjacent block's overlap (confirmed via
    // /eval block probe: dripstone cave, floor at cur.x-1 solid, cur.x
    // itself air). Computing this pass's dig/tread cells from that cur is
    // building on sand — every one of them inherits the same false floor.
    // Nudge sideways onto a real solid neighbor first; only if none exists
    // does this abort (loud, not a silent 20-iteration stall-out).
    {
      const groundCur = bot.entity.position.floored();
      if (!isSolidGround(bot.blockAt(groundCur.offset(0, -1, 0)))) {
        const neighborOffsets = [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ];
        let recovered = false;
        for (const [ndx, ndz] of neighborOffsets) {
          const npos = groundCur.offset(ndx, 0, ndz);
          if (isSolidGround(bot.blockAt(npos.offset(0, -1, 0)))) {
            ctx.log?.(
              'warn',
              `buildStaircase: not grounded at ${posKey(groundCur)} — nudging onto solid neighbor ${posKey(npos)}`
            );
            await advanceIntoStep(bot, npos, ctx).catch(() => {});
            // Don't trust advanceIntoStep's own return value here — a bot
            // straddling the boundary between two columns can satisfy its
            // isInStepCell tolerance for BOTH cells at once and report
            // "arrived" without ever actually moving (field trace: 20
            // identical-timestamp log lines in <2ms, a true zero-progress
            // spin). Verify real footing directly instead.
            if (isSolidGround(bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)))) {
              recovered = true;
              break;
            }
          }
        }
        if (!recovered) {
          // Last resort before aborting: let physics settle. Field trace
          // (round 1, between rounds) showed an idle bot on this exact kind
          // of corner perch quietly drop the 1 block onto real ground on
          // its own within seconds once nothing was holding 'forward'.
          await sleep(600);
          recovered = isSolidGround(bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)));
        }
        if (!recovered) {
          throw new Error(
            `buildStaircase: not grounded at ${posKey(groundCur)}, no adjacent solid neighbor, and physics settle didn't fix it — aborting rather than digging from an unstable perch`
          );
        }
        staleIterations++;
        continue; // re-read a fresh cur next pass now that footing is real
      }
    }

    // (1) STEP CELL — every cell below is a fixed offset from the bot's OWN
    // current floored position, recomputed fresh every pass. Never stored,
    // never predicted, never pulled from a terrain scan.
    const cur = bot.entity.position.floored();
    const targetFeet = cur.offset(dir.x, -1, dir.z); // where the bot lands this step
    const aheadHead = cur.offset(dir.x, 1, dir.z); // walk-through: head height ahead
    const aheadFeet = cur.offset(dir.x, 0, dir.z); // walk-through: current feet height ahead
    const aheadLower = targetFeet; // walk-through: new feet cell itself
    const newFloor = cur.offset(dir.x, -2, dir.z); // floor UNDER the new feet cell
    ctx.setTargetPos?.(targetFeet);
    ctx.setDetail?.(
      `buildStaircase: step ${steps + 1}/${maxSteps}, y=${Math.floor(bot.entity.position.y)} -> ${toY}, heading ${dir.name}`
    );

    // (4) LAVA CHECK (existing pattern) — scan every cell this step touches
    // BEFORE digging any of them. Sight of lava seals the exposed cell and
    // aborts loud rather than digging into it.
    const watchCells = [aheadHead, aheadFeet, aheadLower, newFloor];
    const lavaCell = watchCells.find((p) => bot.blockAt(p)?.name === 'lava');
    if (lavaCell) {
      await sealStairCell(bot, lavaCell, ctx).catch(() => {});
      ctx.log?.('warn', `buildStaircase: lava spotted at ${posKey(lavaCell)} — aborting for safety`);
      break;
    }

    // (PICKAXE-BREAKAGE GUARD — field trace round 2) buildStaircase never
    // called ensureTool up front and never checks durability mid-run; a
    // stone_pickaxe genuinely broke after ~60+ blocks (stone, ores,
    // deepslate) mined over both rounds. With no pickaxe, safeDig below
    // just goes bare-handed and silently times out over and over (deepslate
    // bare-handed is effectively unbreakable in the 10s dig timeout) —
    // 20 identical 10-40s timeouts before the watchdog even fires, with no
    // indication WHY. Detect the missing pickaxe once per step instead and
    // try a local craft (no depot detour — craftToolChain crafts from
    // whatever's already carried); if that also can't succeed (no wood down
    // here to bootstrap a wooden tier), fail fast and clearly rather than
    // grinding out the full stale-iteration budget on a doomed bare-hand dig.
    // (simplified from an earlier b.material==='rock' check that silently
    // never matched — this minecraft-data version doesn't tag deepslate
    // with the material this file expected, so the guard never fired and
    // the original bare-hand-timeout loop went right on happening. Just
    // check for ANY diggable block in the walkthrough instead: harmless
    // when a pickaxe is already held (the craft chain is skipped inside
    // craftToolChain itself via its own hasAnyPickaxe check).
    const needsPickaxe = [aheadHead, aheadFeet, aheadLower].some((p) => {
      const b = bot.blockAt(p);
      return b && b.diggable && b.name !== 'air';
    });
    if (needsPickaxe && !bot.inventory.items().some((it) => /_pickaxe$/.test(it.name))) {
      ctx.log?.('warn', 'buildStaircase: no pickaxe in inventory (broke?) — attempting a local craft before digging further');
      try {
        await craftToolChain(bot, 'pickaxe', ctx);
      } catch (err) {
        throw new Error(`buildStaircase: pickaxe is gone and a local craft failed (${err.message}) — aborting rather than grinding bare-handed`);
      }
      if (!bot.inventory.items().some((it) => /_pickaxe$/.test(it.name))) {
        throw new Error('buildStaircase: pickaxe is gone and the craft chain finished without producing one — aborting rather than grinding bare-handed');
      }
    }

    // (2) DIG — the 3-cell walk-through column, top to bottom.
    for (const digPos of [aheadHead, aheadFeet, aheadLower]) {
      const b = bot.blockAt(digPos);
      if (b && b.diggable && b.name !== 'air') {
        try {
          await bot.tool.equipForBlock(b, { requireHarvest: false });
        } catch {
          // ignore — dig bare-handed rather than fail the step over a tool swap
        }
        // reach-guard is safeDig's own ensureWithinReach; these cells are
        // always <=2 blocks from the bot so it's a no-op check, not a walk.
        await safeDig(bot, b, ctx).catch((err) => {
          ctx.log?.('warn', `buildStaircase: dig failed at ${posKey(digPos)}: ${err.message}`);
        });
      }
    }

    // Tread: floor under the new feet cell must be solid before walking
    // onto it. air/liquid -> place cobble/dirt; genuinely out of material is
    // a clear, immediate error (ensureTreadFoundation already throws for
    // that — nothing to soften here).
    await ensureTreadFoundation(bot, newFloor, ctx);

    // (3) ADVANCE — the bot's own hand-proven pulse-and-verify walk
    // (advanceIntoStep, above). One retry round after re-clearing any block
    // a fresh blockAt() shows still solid; still failing after that is a
    // loud, detailed log — the 20-iteration watchdog is what actually aborts
    // the run, not this single step.
    let arrived = await advanceIntoStep(bot, targetFeet, ctx);
    // (FALL-SAFETY) advanceIntoStep's own runaway-fall guard already stopped
    // the pulse, but "didn't land" also covers a real overshoot into open
    // space beyond the intended tread — a natural cave breach ahead
    // (aheadHead/aheadFeet/aheadLower already air pre-dig) has no far wall
    // this machine ever checks. Re-clearing and retrying the ORIGINAL
    // (now-stale) cells is only safe if the bot is still roughly where this
    // step started; if it has actually dropped away, that retry would dig
    // cells far above the bot's real position and teach it nothing. Treat a
    // real drop as fatal-to-this-step and stop the whole run loud instead.
    if (!arrived && bot.entity.position.y < cur.y - 2) {
      if (await recoverFromCaughtFall(bot, ctx, cur)) {
        lastVerifiedY = bot.entity.position.y; // re-anchor the drift tripwire to this checked-safe spot
        staleIterations++;
        continue; // don't dig/retry from the now-stale cur-relative cells — reread fresh next pass
      }
      throw new Error(
        `buildStaircase: uncontrolled fall past intended step ${posKey(targetFeet)} — now at ${posKey(bot.entity.position.floored())} (started step at ${posKey(cur)}); aborting rather than digging/retrying from stale cells`
      );
    }
    if (!arrived) {
      ctx.log?.('warn', `buildStaircase: advance to ${posKey(targetFeet)} didn't land — re-clearing and retrying once`);
      for (const digPos of [aheadHead, aheadFeet, aheadLower]) {
        const b = bot.blockAt(digPos);
        if (b && b.diggable && b.name !== 'air') {
          await safeDig(bot, b, ctx).catch(() => {});
        }
      }
      arrived = await advanceIntoStep(bot, targetFeet, ctx);
      if (!arrived && bot.entity.position.y < cur.y - 2) {
        if (await recoverFromCaughtFall(bot, ctx, cur)) {
          lastVerifiedY = bot.entity.position.y;
          staleIterations++;
          continue;
        }
        throw new Error(
          `buildStaircase: uncontrolled fall past intended step ${posKey(targetFeet)} on retry — now at ${posKey(bot.entity.position.floored())} (started step at ${posKey(cur)}); aborting rather than continuing from stale cells`
        );
      }
    }
    if (!arrived) {
      const dump = [aheadHead, aheadFeet, aheadLower, newFloor]
        .map((p) => `${posKey(p)}=${bot.blockAt(p)?.name ?? 'unknown'}`)
        .join(', ');
      lastFailureDetail = `advance to ${posKey(targetFeet)} failed twice — cells: ${dump}`;
      ctx.log?.('warn', `buildStaircase: ${lastFailureDetail}`);
      staleIterations++;
      continue; // no landing verified — retry from a freshly-read position, no steps++
    }

    staleIterations = 0;
    steps++; // (5) counted ONLY after a verified landing
    lastVerifiedY = bot.entity.position.y; // re-anchor the drift tripwire to this confirmed landing

    if (steps % 8 === 0) {
      const placed = await placeTorchHere(bot, ctx).catch((err) => {
        ctx.log?.('warn', `buildStaircase: torch placement failed: ${err.message}`);
        return false;
      });
      if (placed) torchesPlaced++;
    }
  }

  return { from, to: toPlainPos(bot.entity.position), steps, torches: torchesPlaced, headings: 1 };
}

async function scanForOres(bot, ctx, oreCounts, collectedAll) {
  const pos = bot.entity.position.floored();
  const neighborOffsets = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  let found = false;
  for (const [dx, dy, dz] of neighborOffsets) {
    const p = pos.offset(dx, dy, dz);
    if (isPoisoned(ctx, p)) continue;
    const b = bot.blockAt(p);
    if (b && ORE_NAMES.includes(b.name)) {
      found = true;
      await mineOreVein(bot, p, ctx, oreCounts, collectedAll);
    }
  }
  return found;
}

async function mineOreVein(bot, startPos, ctx, oreCounts, collectedAll, cap = 12) {
  const seen = new Set([posKey(startPos)]);
  const queue = [startPos];
  let mined = 0;
  while (queue.length && mined < cap) {
    if (ctx.isCancelled?.()) break;
    const p = queue.shift();
    if (isPoisoned(ctx, p) || !withinDepthGate(bot, p, 6)) continue;
    const b = bot.blockAt(p);
    if (!b || !ORE_NAMES.includes(b.name)) continue;

    ctx.setTargetPos?.(p);
    try {
      await gotoLoop(bot, new goals.GoalGetToBlock(p.x, p.y, p.z), { timeoutMs: 10000, maxAttempts: 2 }, ctx);
    } catch (err) {
      ctx.log?.('warn', `mineOreVein: unreachable ${b.name} at ${posKey(p)}: ${err.message}`);
      continue;
    }
    try {
      await bot.tool.equipForBlock(b, { requireHarvest: false });
    } catch {
      // ignore
    }
    const fresh = bot.blockAt(p);
    if (!fresh || !ORE_NAMES.includes(fresh.name)) continue;
    const oreName = fresh.name;
    const preDigSnapshot = snapshotInventory(bot);
    try {
      await safeDig(bot, fresh, ctx);
    } catch (err) {
      ctx.log?.('warn', `mineOreVein: dig failed at ${posKey(p)}: ${err.message}`);
      continue;
    }
    mined++;
    oreCounts[oreName] = (oreCounts[oreName] || 0) + 1;
    const collected = await stepOntoAndCollect(bot, p, ctx, 4, preDigSnapshot);
    collectedAll.push(...collected);

    for (const [dx, dy, dz] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]) {
      const np = p.offset(dx, dy, dz);
      const key = posKey(np);
      if (seen.has(key)) continue;
      seen.add(key);
      const nb = bot.blockAt(np);
      if (nb && ORE_NAMES.includes(nb.name)) queue.push(np);
    }
  }
  return mined;
}

async function digCorridorStep(bot, dir, ctx) {
  const pos = bot.entity.position.floored();
  const fwd0 = pos.offset(dir.x, 0, dir.z); // same level as feet — new feet cell
  const fwd1 = pos.offset(dir.x, 1, dir.z); // one above — headroom
  ctx.setTargetPos?.(fwd0);
  for (const digPos of [fwd0, fwd1]) {
    const b = bot.blockAt(digPos);
    if (b && b.diggable && b.name !== 'air') {
      try {
        await bot.tool.equipForBlock(b, { requireHarvest: false });
      } catch {
        // ignore
      }
      await safeDig(bot, b, ctx).catch((err) => {
        ctx.log?.('warn', `branchMine: corridor dig failed at ${posKey(digPos)}: ${err.message}`);
      });
    }
  }
  await gotoLoop(bot, new goals.GoalNear(fwd0.x, fwd0.y, fwd0.z, 0), { timeoutMs: 8000, maxAttempts: 2 }, ctx).catch((err) => {
    ctx.log?.('warn', `branchMine: corridor step failed: ${err.message}`);
  });
}

async function mineBranch(bot, dir, length, ctx, oreCounts, collectedAll) {
  const from = toPlainPos(bot.entity.position);
  const result = { from, to: null, length: 0, torch: false };
  result.torch = await placeTorchHere(bot, ctx).catch(() => false);

  for (let i = 0; i < length; i++) {
    if (ctx.isCancelled?.()) break;
    await checkHealthRetreat(bot, ctx);
    await digCorridorStep(bot, dir, ctx);
    await scanForOres(bot, ctx, oreCounts, collectedAll);
    result.length = i + 1;
  }
  result.to = toPlainPos(bot.entity.position);
  return result;
}

// branchMine({y, trunkLength?=24, branches?=6, branchLength?=8, direction?}) —
// from the current position (intended to be a staircase bottom): trunk
// corridor 2-high, branch pairs every 3 blocks alternating sides, torch each
// branch mouth, collect all drops, ore-scan each branch (iron/coal/copper ore
// adjacent to the corridor -> mine them + their connected vein).
export async function branchMine(bot, opts = {}, ctx = {}) {
  const trunkLength = opts.trunkLength ?? 24;
  const branchesCount = opts.branches ?? 6;
  const branchLength = opts.branchLength ?? 8;
  // Explicit y accepted; default fallback y=54 per the ore-band guidance
  // comment near ORE_NAMES above. y itself isn't used to move the bot (the
  // caller is expected to already be at depth, e.g. via buildStaircase) —
  // it's accepted so callers can report/verify the intended depth.
  const y = opts.y ?? 54;

  // (19) DIG LAW — branch mining is the bulk-dig case the decree is aimed at,
  // so it is exempt only when the y band it will work is inside a zone at the
  // bot's own x/z. Checked against the START position before ensureTool can
  // relocate the bot (see the snapshot note below) and before the first
  // corridor block is touched.
  {
    const startPos = bot.entity.position.floored();
    const band = new Vec3(startPos.x, y, startPos.z);
    if (!isInDigZone(band)) {
      throw new Error(`branchMine: ${digLawRefusal(band, `trunk at y${y}`)}`);
    }
  }

  // (15) branchMine assumes the caller is already standing at the intended
  // staircase-bottom location — but ensureTool()'s depot-chest fallback (see
  // its own header) can silently walk the bot back to camp (the depot chest
  // sits right in the middle of it) to fetch a pickaxe, and camp is very
  // likely NOT where trunk-digging should start. Confirmed live: this exact
  // path put a bot's trunk corridor straight through the camp furnace.
  // Snapshot the intended start now and, if ensureTool moved us off of it,
  // walk back before digging the first trunk block.
  const intendedStart = bot.entity.position.clone();
  try {
    await ensureTool(bot, { kind: 'pickaxe' }, ctx);
  } catch (err) {
    throw new Error(`branchMine: pickaxe required but ensureTool failed: ${err.message}`);
  }
  if (bot.entity.position.distanceTo(intendedStart) > 2) {
    ctx.log?.(
      'warn',
      `branchMine: ensureTool relocated the bot (now ${posKey(bot.entity.position)}) — returning to intended start ${posKey(intendedStart)} before digging`
    );
    try {
      await gotoLoop(
        bot,
        new goals.GoalNear(intendedStart.x, intendedStart.y, intendedStart.z, 1),
        { timeoutMs: 30000, maxAttempts: 3 },
        ctx
      );
    } catch (err) {
      throw new Error(`branchMine: could not return to intended start after ensureTool relocation: ${err.message}`);
    }
  }

  const dir = resolveDirection(opts);
  const perp = { x: -dir.z, z: dir.x };

  const trunkFrom = toPlainPos(bot.entity.position);
  const trunkResult = { from: trunkFrom, to: null, length: 0, y };
  const branchResults = [];
  const oreCounts = {};
  const collectedAll = [];
  let consecutiveStalls = 0;

  for (let i = 0; i < trunkLength; i++) {
    if (ctx.isCancelled?.()) break;
    await checkHealthRetreat(bot, ctx);
    ctx.setDetail?.(`branchMine: trunk ${i + 1}/${trunkLength}`);

    let watchdog;
    try {
      watchdog = await runTargetWithWatchdog(bot, ctx, 25000, async () => {
        await digCorridorStep(bot, dir, ctx);
        const found = await scanForOres(bot, ctx, oreCounts, collectedAll);
        return { found };
      });
    } catch (err) {
      ctx.log?.('warn', `branchMine: trunk position ${i} failed: ${err.message}`);
      continue;
    }

    if (watchdog.stalled) {
      consecutiveStalls++;
      ctx.log?.('warn', `branchMine: trunk position ${i} stalled (${consecutiveStalls}/3)`);
      if (consecutiveStalls >= 3) throw new Error('stalled');
      continue;
    }
    consecutiveStalls = 0;
    trunkResult.length = i + 1;

    if ((i + 1) % 3 === 0 && branchResults.length < branchesCount) {
      const side = branchResults.length % 2 === 0 ? perp : { x: -perp.x, z: -perp.z };
      const branch = await mineBranch(bot, side, branchLength, ctx, oreCounts, collectedAll);
      branchResults.push(branch);
    }
  }
  trunkResult.to = toPlainPos(bot.entity.position);

  // (8) End-of-task late-drop sweep — leaf/ore decay drops can lag.
  await sleep(2500);
  const { collected: late } = await collectDrops(bot, { radius: 24 }, ctx).catch(() => ({ collected: [] }));
  collectedAll.push(...late);

  return { trunk: trunkResult, branches: branchResults, ores: oreCounts, collected: mergeCounts(collectedAll) };
}
