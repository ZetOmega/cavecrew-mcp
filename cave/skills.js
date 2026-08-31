// cave/skills.js — deterministic bot-fleet algorithms.
//
// Every exported function has the shape `fn(bot, opts, ctx)` and returns a
// JSON-safe result. `ctx` is supplied by runner.js and may carry:
//   ctx.log(level, msg)   — write a line to the runner's log + quirk feed
//   ctx.setDetail(str)    — update the current task's `detail` field
//   ctx.isCancelled()     — true once /stop has cancelled the running task
//   ctx.mcData            — minecraft-data instance for bot.version
// All three are optional — every call below is guarded with `?.()` so a
// bare `skills.fn(bot, opts)` call (e.g. from /eval) still works.
//
// Field quirks encoded here on purpose — do not "simplify" them away:
//   - equip the tool fresh before EVERY dig (equip does not persist between digs)
//   - collect drops immediately after felling/mining (rivals snipe drops fast)
//   - movement always goes through gotoLoop; cancel is setGoal(null), NEVER
//     bot.pathfinder.stop() (verified: stop() leaves a `stopPathing` flag that
//     silently discards the very next setGoal() call — it re-nulls the goal
//     inside the same tick).

import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

const { goals } = pathfinderPkg;

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

// ---------------------------------------------------------------------------
// small internal helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function posKey(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function toPlainPos(pos) {
  return { x: pos.x, y: pos.y, z: pos.z };
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

function isToolLike(name) {
  return /(_pickaxe|_axe|_shovel|_hoe|_sword|shears|bow|crossbow|trident|fishing_rod|flint_and_steel|shield|_helmet|_chestplate|_leggings|_boots|elytra)$/.test(
    name
  );
}

// ---------------------------------------------------------------------------
// gotoLoop — the one and only movement primitive. Cancel = setGoal(null).
// ---------------------------------------------------------------------------

export async function gotoLoop(bot, goal, opts = {}, ctx = {}) {
  const timeoutMs = opts.timeoutMs ?? 45000;
  const maxAttempts = opts.maxAttempts ?? 5;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (ctx.isCancelled?.()) {
      throw new Error('gotoLoop: cancelled');
    }
    try {
      await withTimeout(bot.pathfinder.goto(goal), timeoutMs);
      return;
    } catch (err) {
      lastErr = err;
      ctx.log?.('warn', `gotoLoop: attempt ${attempt}/${maxAttempts} failed (${err?.message}); re-issuing`);
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
  throw new Error(`gotoLoop: failed after ${maxAttempts} attempts: ${lastErr?.message ?? 'unknown error'}`);
}

async function collectNear(bot, ctx, radius) {
  return collectDrops(bot, { radius }, ctx);
}

async function replantSapling(bot, belowPos, ctx) {
  const sapling = bot.inventory.items().find((it) => it.name.endsWith('_sapling'));
  if (!sapling) return false;
  const soil = bot.blockAt(belowPos);
  if (!soil || !SOIL_BLOCKS.has(soil.name)) return false;
  const plantAt = bot.blockAt(belowPos.offset(0, 1, 0));
  if (!plantAt || plantAt.name !== 'air') return false;
  await bot.equip(sapling, 'hand');
  await bot.placeBlock(soil, new Vec3(0, 1, 0));
  ctx.log?.('info', `replanted ${sapling.name} at ${posKey(belowPos)}`);
  return true;
}

// ---------------------------------------------------------------------------
// chopTrees
// ---------------------------------------------------------------------------

export async function chopTrees(bot, opts = {}, ctx = {}) {
  const count = opts.count ?? 8;
  const maxDistance = opts.maxDistance ?? 48;

  const choppedTrees = [];
  const collectedAll = [];
  const skippedKeys = new Set();
  const maxIterations = count * 4 + 20;
  let iterations = 0;

  while (choppedTrees.length < count && iterations < maxIterations) {
    iterations++;
    if (ctx.isCancelled?.()) break;
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
      matching: (b) => /_log$/.test(b.name) && (!b.position || !skippedKeys.has(posKey(b.position))),
    });
    if (!base) {
      ctx.log?.('warn', `chopTrees: no more *_log blocks within ${maxDistance} blocks`);
      break;
    }
    const key = posKey(base.position);

    try {
      await gotoLoop(
        bot,
        new goals.GoalGetToBlock(base.position.x, base.position.y, base.position.z),
        { timeoutMs: 20000, maxAttempts: 3 },
        ctx
      );
    } catch (err) {
      skippedKeys.add(key);
      ctx.log?.('warn', `chopTrees: could not reach tree at ${key}: ${err.message}`);
      continue;
    }

    const belowPos = base.position.offset(0, -1, 0);
    let current = bot.blockAt(base.position);
    let logsFelled = 0;

    while (current && /_log$/.test(current.name)) {
      // Equip the best axe BEFORE EACH log — equip does not persist between digs.
      try {
        await bot.tool.equipForBlock(current, { requireHarvest: false });
      } catch (err) {
        ctx.log?.('warn', `chopTrees: equip axe failed at ${posKey(current.position)}: ${err.message}`);
      }
      try {
        await bot.dig(current);
        logsFelled++;
      } catch (err) {
        ctx.log?.('warn', `chopTrees: dig failed at ${posKey(current.position)}: ${err.message}`);
        break;
      }
      current = bot.blockAt(current.position.offset(0, 1, 0));
    }

    if (logsFelled === 0) {
      skippedKeys.add(key);
      continue;
    }

    choppedTrees.push({ ...toPlainPos(base.position), logs: logsFelled });

    // Collect drops IMMEDIATELY — rival bots snipe drops within seconds.
    const { collected } = await collectNear(bot, ctx, 6).catch(() => ({ collected: [] }));
    collectedAll.push(...collected);

    await replantSapling(bot, belowPos, ctx).catch((err) => {
      ctx.log?.('warn', `chopTrees: replant failed: ${err.message}`);
    });
  }

  return { chopped: choppedTrees.length, trees: choppedTrees, collected: mergeCounts(collectedAll) };
}

// ---------------------------------------------------------------------------
// mineBlocks
// ---------------------------------------------------------------------------

export async function mineBlocks(bot, opts = {}, ctx = {}) {
  const block = opts.block;
  const count = opts.count ?? 8;
  const maxDistance = opts.maxDistance ?? 48;
  if (!block) throw new Error('mineBlocks: "block" is required');

  const mined = [];
  const skipped = [];
  const skippedKeys = new Set();
  const collectedAll = [];
  const maxIterations = count * 4 + 20;
  let iterations = 0;

  while (mined.length < count && iterations < maxIterations) {
    iterations++;
    if (ctx.isCancelled?.()) break;
    ctx.setDetail?.(`mining ${block} ${mined.length}/${count}`);

    const target = bot.findBlock({
      point: bot.entity.position,
      maxDistance,
      // Same palette-pre-filter gotcha as chopTrees above — b.position can
      // be null on the first (synthetic) call; guard it before posKey().
      matching: (b) => b.name === block && (!b.position || !skippedKeys.has(posKey(b.position))),
    });
    if (!target) {
      ctx.log?.('warn', `mineBlocks: no reachable ${block} left within ${maxDistance} blocks`);
      break;
    }
    const key = posKey(target.position);

    let reached = false;
    for (let attempt = 1; attempt <= 2 && !reached; attempt++) {
      try {
        await gotoLoop(
          bot,
          new goals.GoalGetToBlock(target.position.x, target.position.y, target.position.z),
          { timeoutMs: 20000, maxAttempts: 2 },
          ctx
        );
        reached = true;
      } catch (err) {
        ctx.log?.('warn', `mineBlocks: unreachable attempt ${attempt}/2 for ${block} at ${key}: ${err.message}`);
      }
    }
    // Skip block if unreachable twice — record it and move on.
    if (!reached) {
      skippedKeys.add(key);
      skipped.push({ pos: toPlainPos(target.position), reason: 'unreachable' });
      continue;
    }

    // Re-equip the best pickaxe per block — equip does not persist between digs.
    try {
      await bot.tool.equipForBlock(target, { requireHarvest: false });
    } catch (err) {
      ctx.log?.('warn', `mineBlocks: equip failed for ${block} at ${key}: ${err.message}`);
    }

    const freshBlock = bot.blockAt(target.position);
    if (!freshBlock || freshBlock.name !== block) {
      // Someone/something already took it — try again, no penalty.
      continue;
    }

    try {
      await bot.dig(freshBlock);
    } catch (err) {
      skippedKeys.add(key);
      skipped.push({ pos: toPlainPos(target.position), reason: `dig failed: ${err.message}` });
      continue;
    }

    mined.push(toPlainPos(target.position));
    // Step onto / collect the drop immediately.
    const { collected } = await collectNear(bot, ctx, 4).catch(() => ({ collected: [] }));
    collectedAll.push(...collected);
  }

  return { mined: mined.length, positions: mined, skipped, collected: mergeCounts(collectedAll) };
}

// ---------------------------------------------------------------------------
// collectDrops
// ---------------------------------------------------------------------------

export async function collectDrops(bot, opts = {}, ctx = {}) {
  const radius = opts.radius ?? 16;
  const maxIterations = opts.maxIterations ?? 24;

  // Verified against this repo's installed mineflayer (4.35.0 + minecraft-data
  // entities.json): dropped-item entities always report e.name === 'item' —
  // do not gate on e.type/objectType, those aren't set that way here.
  const isDrop = (e) => e && e.name === 'item' && e.position && bot.entity.position.distanceTo(e.position) <= radius;

  const before = snapshotInventory(bot);
  const stuckIds = new Set();
  let iterations = 0;

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

    // Vanilla pickup radius is tight (~1 block from the player). GoalNear
    // with any slack (range 1-2) can stop the bot ~1.5+ blocks short and the
    // drop never gets swept up — path onto the drop's exact block instead.
    const dest = drop.position.floored();
    try {
      await gotoLoop(bot, new goals.GoalBlock(dest.x, dest.y, dest.z), { timeoutMs: 8000, maxAttempts: 2 }, ctx);
    } catch (err) {
      ctx.log?.('warn', `collectDrops: could not reach drop at ${posKey(dest)}: ${err.message}`);
      stuckIds.add(dropId);
      continue;
    }

    // Give the server a tick to register the pickup once we're standing on it.
    await sleep(250);

    // Only mark it "handled" once it's actually gone — a drop that's still
    // sitting there after arrival didn't get collected, don't loop on it forever.
    if (bot.entities[dropId]) {
      stuckIds.add(dropId);
    }
  }

  try {
    bot.pathfinder.setGoal(null);
  } catch {
    // ignore
  }

  const after = snapshotInventory(bot);
  return { collected: diffInventory(before, after) };
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

async function gotoChestBlock(bot, pos, ctx) {
  await gotoLoop(bot, new goals.GoalGetToBlock(pos.x, pos.y, pos.z), { timeoutMs: 30000, maxAttempts: 5 }, ctx);
  const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
  if (!block || !/chest|barrel|shulker_box/.test(block.name)) {
    throw new Error(`no chest-like container at ${pos.x},${pos.y},${pos.z} (found ${block ? block.name : 'nothing'})`);
  }
  return block;
}

export async function depositToChest(bot, opts = {}, ctx = {}) {
  const pos = opts.pos;
  const items = opts.items;
  if (!pos) throw new Error('depositToChest: "pos" is required');

  const chestBlock = await gotoChestBlock(bot, pos, ctx);
  ctx.setDetail?.('opening chest to deposit');
  const win = await bot.openChest(chestBlock);
  const deposited = [];
  try {
    const wanted =
      items && items.length
        ? bot.inventory.items().filter((it) => items.includes(it.name))
        : bot.inventory.items().filter((it) => !isToolLike(it.name));

    const merged = new Map();
    for (const it of wanted) {
      const k = `${it.type}:${it.metadata ?? 0}`;
      const cur = merged.get(k) || { type: it.type, metadata: it.metadata, name: it.name, count: 0 };
      cur.count += it.count;
      merged.set(k, cur);
    }
    for (const it of merged.values()) {
      try {
        await win.deposit(it.type, it.metadata ?? null, it.count);
        deposited.push({ name: it.name, count: it.count });
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

  const chestBlock = await gotoChestBlock(bot, pos, ctx);
  ctx.setDetail?.('opening chest to withdraw');
  const win = await bot.openChest(chestBlock);
  const withdrawn = [];
  try {
    const contents = win.containerItems();
    for (const name of items) {
      const matches = contents.filter((it) => it.name === name);
      if (matches.length === 0) {
        ctx.log?.('warn', `withdrawFromChest: ${name} not found in chest`);
        continue;
      }
      const total = matches.reduce((sum, it) => sum + it.count, 0);
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
  await bot.placeBlock(below, new Vec3(0, 1, 0));
  return true;
}

export async function safeDescend(bot, opts = {}, ctx = {}) {
  const targetY = opts.targetY;
  if (typeof targetY !== 'number') throw new Error('safeDescend: "targetY" is required');

  const startY = bot.entity.position.y;
  if (targetY >= startY) {
    return { descended: 0, finalY: startY, reason: 'already at or above targetY' };
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
          await bot.dig(b);
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
        await bot.dig(belowFrontBlock);
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

  return { descended: startY - bot.entity.position.y, finalY: bot.entity.position.y };
}
