// cave/drives-dsl.js — done_check DSL (LEAD ANNOTATION H, DRIVES-SPEC.md):
// whitelist predicates only, NEVER eval()/new Function() on model output.
// validateDoneCheck(obj) rejects anything outside the whitelist at any
// nesting level; evalDoneCheck(check, reading) is a pure structural-match
// predicate evaluator over a plain state snapshot the caller builds fresh
// from live bot state. See DRIVES-PLAN.md §4.

const PREDICATE_KEYS = new Set(['has_item', 'near', 'food_min', 'hp_min', 'time_passed_s']);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validatePredicate(obj) {
  if (!isPlainObject(obj)) throw new Error('done_check predicate must be an object');
  const keys = Object.keys(obj);
  if (keys.length !== 1) throw new Error(`done_check predicate must have exactly one key (got ${keys.length})`);
  const [key] = keys;
  if (!PREDICATE_KEYS.has(key)) throw new Error(`done_check: unknown predicate "${key}"`);
  const val = obj[key];
  switch (key) {
    case 'has_item': {
      if (!isPlainObject(val)) throw new Error('has_item: value must be an object');
      if (Object.keys(val).some((k) => k !== 'name' && k !== 'count')) {
        throw new Error('has_item: only "name"/"count" keys allowed');
      }
      if (typeof val.name !== 'string' || !val.name) throw new Error('has_item: "name" must be a non-empty string');
      if (!Number.isInteger(val.count) || val.count < 1) throw new Error('has_item: "count" must be an integer >= 1');
      return;
    }
    case 'near': {
      if (!isPlainObject(val)) throw new Error('near: value must be an object');
      if (Object.keys(val).some((k) => !['x', 'y', 'z', 'r'].includes(k))) {
        throw new Error('near: only "x"/"y"/"z"/"r" keys allowed');
      }
      for (const k of ['x', 'y', 'z']) {
        if (typeof val[k] !== 'number' || !Number.isFinite(val[k])) throw new Error(`near: "${k}" must be a finite number`);
      }
      if (typeof val.r !== 'number' || !(val.r > 0)) throw new Error('near: "r" must be a number > 0');
      return;
    }
    case 'food_min':
    case 'hp_min': {
      if (!Number.isInteger(val) || val < 0 || val > 20) throw new Error(`${key}: must be an integer 0..20`);
      return;
    }
    case 'time_passed_s': {
      if (!Number.isInteger(val) || val < 1) throw new Error('time_passed_s: must be an integer >= 1');
      return;
    }
  }
}

// validateDoneCheck(obj) — top level may be a bare predicate or
// {all:[...]}/{any:[...]} (FLAGGED extension, DRIVES-PLAN.md §4: not in the
// spec's literal grammar, added because a single predicate is sometimes
// insufficient — e.g. "reached the spot AND still have food". Both branches
// recurse into the SAME whitelist below, so annotation H's "never eval
// model output" guarantee is unaffected: still structural matching only,
// at every nesting level, never interpreted as code.
export function validateDoneCheck(obj) {
  if (!isPlainObject(obj)) throw new Error('done_check must be an object');
  const keys = Object.keys(obj);
  if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
    const arr = obj[keys[0]];
    if (!Array.isArray(arr) || arr.length === 0) throw new Error(`done_check: "${keys[0]}" must be a non-empty array`);
    for (const item of arr) validateDoneCheck(item);
    return;
  }
  validatePredicate(obj);
}

function evalPredicate(key, val, reading) {
  switch (key) {
    case 'has_item':
      return (reading.invCounts?.[val.name] ?? 0) >= val.count;
    case 'near': {
      if (!reading.pos) return false;
      const dx = reading.pos.x - val.x;
      const dy = reading.pos.y - val.y;
      const dz = reading.pos.z - val.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) <= val.r;
    }
    case 'food_min':
      return (reading.food ?? 0) >= val;
    case 'hp_min':
      return (reading.hp ?? 0) >= val;
    case 'time_passed_s':
      return !!reading.taskStartedAt && (Date.now() - reading.taskStartedAt) / 1000 >= val;
    default:
      return false; // unreachable once validateDoneCheck has run, kept defensive-only
  }
}

// evalDoneCheck(check, reading) — reading = {pos, hp, food, invCounts,
// taskStartedAt}, a plain snapshot the caller (runner.js) builds fresh from
// live `bot` state on every poll. Pure function, no bot/mineflayer coupling
// (unit-testable with no bot) — assumes `check` already passed
// validateDoneCheck (caller's job, once, at decision-reply validation time).
export function evalDoneCheck(check, reading) {
  const keys = Object.keys(check);
  if (keys.length === 1 && keys[0] === 'all') return check.all.every((c) => evalDoneCheck(c, reading));
  if (keys.length === 1 && keys[0] === 'any') return check.any.some((c) => evalDoneCheck(c, reading));
  const [key] = keys;
  return evalPredicate(key, check[key], reading);
}
