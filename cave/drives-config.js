// cave/drives-config.js — loads/validates cave/drives.json (drive-engine
// config: DRIVES-PLAN.md §8). Mtime-cached hot-reload, pure fs, no other
// module coupling.
//
// Fail-CLOSED on missing/malformed file — the deliberate INVERSE of
// zones.json's fail-open precedent (runner.js's own dig-law comment: "a
// missing zones.json ... fail-open"). Zones fail-open because a missing
// zones file just means dig-law isn't enforced (a safety net absent, not a
// hazard present); drives.json fail-closed because a missing/broken config
// must never silently let autonomous LLM-issued tasks start running on a
// bot nobody reviewed the settings for. See DRIVES-PLAN.md §1 file table.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'drives.json');

const DEFAULTS = {
  global: false,
  bots: {},
  decisionModel: 'deepseek-chat',
  escalationModel: 'deepseek-chat',
  reflectionModel: 'deepseek-chat',
  tickMs: 5000,
  driverQuietMs: 15000,
  minCallIntervalMs: 20000,
  hourlyCallCap: 60,
  globalInFlightCap: 5,
  escalateAfterFails: 2,
  reflectionIntervalMinMs: 600000,
  reflectionIntervalMaxMs: 900000,
  signalsIntervalMs: 300000,
};

// FAIL-CLOSED FALLBACK — always global:false + no bots, regardless of what
// DEFAULTS above says for the other tuning knobs (those only matter once
// global is actually true, so their fail-closed values are moot).
function closedConfig() {
  return { ...DEFAULTS, global: false, bots: {} };
}

let cache = null; // { mtimeMs, config }
let warnedBadConfig = false; // logs the malformed/missing-file warning at most once per distinct failure state

export function getConfig() {
  let stat;
  try {
    stat = fs.statSync(CONFIG_PATH);
  } catch {
    if (!warnedBadConfig) {
      warnedBadConfig = true;
      console.error('[drives-config] cave/drives.json missing — drive engine fail-closed (global=false)');
    }
    cache = null;
    return closedConfig();
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('drives.json root must be a JSON object');
    }
    const bots = parsed.bots && typeof parsed.bots === 'object' && !Array.isArray(parsed.bots) ? parsed.bots : {};
    const config = { ...DEFAULTS, ...parsed, bots: { ...bots } };
    config.global = config.global === true; // coerce anything non-boolean-true to false, never truthy-guess
    cache = { mtimeMs: stat.mtimeMs, config };
    warnedBadConfig = false; // config recovered — a later re-break gets warned again
    return config;
  } catch (err) {
    if (!warnedBadConfig) {
      warnedBadConfig = true;
      console.error(`[drives-config] cave/drives.json malformed (${err?.message ?? err}) — drive engine fail-closed (global=false)`);
    }
    cache = { mtimeMs: stat.mtimeMs, config: closedConfig() };
    return cache.config;
  }
}

export function isGlobalOn() {
  return getConfig().global === true;
}

// isEnrolled(name) — explicit opt-in only: a name absent from `bots`, or
// present but not exactly `true`, is NOT enrolled. Matches annotation B's
// `{"bots":{"Durk":true}}` example literally.
export function isEnrolled(name) {
  return getConfig().bots?.[name] === true;
}

export function getModels() {
  const cfg = getConfig();
  return {
    decisionModel: cfg.decisionModel,
    escalationModel: cfg.escalationModel,
    reflectionModel: cfg.reflectionModel,
  };
}

export function getGuards() {
  const cfg = getConfig();
  return {
    tickMs: cfg.tickMs,
    driverQuietMs: cfg.driverQuietMs,
    minCallIntervalMs: cfg.minCallIntervalMs,
    hourlyCallCap: cfg.hourlyCallCap,
    globalInFlightCap: cfg.globalInFlightCap,
    escalateAfterFails: cfg.escalateAfterFails,
    reflectionIntervalMinMs: cfg.reflectionIntervalMinMs,
    reflectionIntervalMaxMs: cfg.reflectionIntervalMaxMs,
    signalsIntervalMs: cfg.signalsIntervalMs,
  };
}
