// cave/drives-skills-map.js — static table mapping the model's skill
// vocabulary to real taskRoutes endpoints + per-skill arg validators (LEAD
// ANNOTATION J: "mapped from the runner's real skill surface ... no
// invented skills"). Every entry below is a route that already exists in
// runner.js's taskRoutes table (or, for /seal, DRIVES-PLAN.md §1.9's thin
// wrapper around the already-exported skills.emergencySeal) — nothing here
// is a new movement/task primitive (annotation K).
//
// Load-time assertion below cross-checks every entry whose skillFn names a
// skills.js export against skills.js's own exports, so a rename/removal
// there fails loudly at boot instead of silently at the first drive-issued
// goal that happens to pick that skill.

import * as skills from './skills.js';

function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function str(v) {
  return typeof v === 'string' && v.length > 0;
}

// endpoint: the taskRoutes path this skill dispatches through in the
// runner's own HTTP surface (drive goals call the same in-process
// functions directly — see runner.js's DRIVES ENGINE runDriveSkill() — but
// naming the endpoint here keeps this table legible as "this IS that real
// route", the annotation J cross-check target). skillFn: the skills.js
// export name this route wraps, checked below — null means the route
// dispatches through something else already native to runner.js (a plain
// runner-local helper, movement.js, or real /chat), not a skills.js
// export, and is deliberately exempt from the skills.js cross-check.
export const SKILLS = {
  goto: {
    endpoint: '/goto',
    skillFn: null, // movement.goTo — not a skills.js export
    validateArgs(args) {
      if (!args || !num(args.x) || !num(args.y) || !num(args.z)) throw new Error('goto: args needs numeric x/y/z');
      return { x: args.x, y: args.y, z: args.z, range: num(args.range) ? args.range : undefined };
    },
  },
  chop: {
    endpoint: '/chop',
    skillFn: 'chopTrees',
    validateArgs(args) {
      return { count: num(args?.count) ? args.count : undefined, maxDistance: num(args?.maxDistance) ? args.maxDistance : undefined };
    },
  },
  mine: {
    endpoint: '/mine',
    skillFn: 'mineBlocks',
    validateArgs(args) {
      if (!str(args?.block)) throw new Error('mine: args needs "block" (string)');
      return { block: args.block, count: num(args.count) ? args.count : undefined, maxDistance: num(args.maxDistance) ? args.maxDistance : undefined };
    },
  },
  collect: {
    endpoint: '/collect',
    skillFn: 'collectDrops',
    validateArgs(args) {
      return { radius: num(args?.radius) ? args.radius : undefined };
    },
  },
  hunt: {
    endpoint: '/hunt',
    skillFn: 'huntAnimals',
    validateArgs(args) {
      if (!str(args?.mob)) throw new Error('hunt: args needs "mob" (string)');
      return { mob: args.mob, count: num(args.count) ? args.count : undefined };
    },
  },
  craft: {
    endpoint: '/craft',
    skillFn: null, // runner.js's own local craftItem() helper — not a skills.js export
    validateArgs(args) {
      if (!str(args?.item)) throw new Error('craft: args needs "item" (string)');
      return { item: args.item, amount: num(args.amount) ? args.amount : undefined };
    },
  },
  smelt: {
    endpoint: '/smelt',
    skillFn: 'smeltItems',
    validateArgs(args) {
      if (!str(args?.input)) throw new Error('smelt: args needs "input" (string)');
      return { input: args.input, fuel: args.fuel, count: num(args.count) ? args.count : undefined };
    },
  },
  deposit: {
    endpoint: '/deposit',
    skillFn: 'depositToChest',
    validateArgs(args) {
      if (!args || !num(args.x) || !num(args.y) || !num(args.z)) throw new Error('deposit: args needs numeric x/y/z');
      return { x: args.x, y: args.y, z: args.z, items: Array.isArray(args.items) ? args.items : undefined };
    },
  },
  staircase: {
    endpoint: '/staircase',
    skillFn: 'buildStaircase',
    validateArgs(args) {
      if (!num(args?.toY)) throw new Error('staircase: args needs numeric "toY"');
      return { toY: args.toY, direction: args.direction };
    },
  },
  branchmine: {
    endpoint: '/branchmine',
    skillFn: 'branchMine',
    validateArgs(args) {
      if (!num(args?.y)) throw new Error('branchmine: args needs numeric "y"');
      return { y: args.y, trunkLength: args.trunkLength, branches: args.branches, branchLength: args.branchLength, direction: args.direction };
    },
  },
  // /seal — DRIVES-PLAN.md §1.9: closes the "shelter" need's only real gap
  // (no shelter-BUILDING skill exists anywhere in skills.js today) by giving
  // the drive engine an HTTP door onto the already-existing emergency-
  // seal-in-place skill. No new skill invented.
  seal: {
    endpoint: '/seal',
    skillFn: 'emergencySeal',
    validateArgs() {
      return {}; // emergencySeal(bot, ctx) takes no opts
    },
  },
  // talk — annotation D: "Social need is satisfied by REAL bot-to-bot talk
  // in game chat (allowed — it is actual talk, players enjoy it)". Routes
  // through the real /chat endpoint, style forced to 'talk' — never the
  // signals.jsonl backend, which is protocol spam class, not this.
  talk: {
    endpoint: '/chat',
    skillFn: null, // real chat — not a skills.js export
    validateArgs(args) {
      if (!str(args?.message)) throw new Error('talk: args needs "message" (string)');
      return { message: args.message };
    },
  },
};

for (const [kind, def] of Object.entries(SKILLS)) {
  if (def.skillFn && typeof skills[def.skillFn] !== 'function') {
    throw new Error(
      `drives-skills-map: "${kind}" maps to skills.${def.skillFn}, which is not exported by skills.js — table has drifted out of sync with the real skill surface (annotation J)`
    );
  }
}

export function skillNames() {
  return Object.keys(SKILLS);
}

export function getSkill(name) {
  return SKILLS[name];
}
