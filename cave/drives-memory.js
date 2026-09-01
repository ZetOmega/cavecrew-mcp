// cave/drives-memory.js — cave/botmind/<bot>.json read/write (LEAD
// ANNOTATION I): reflection lines, known shelter/bed spots, failed-args
// ring (cap 20), signals cache, counters. Runtime state — gitignored (see
// cave/.gitignore), never committed. Pure fs, no other module coupling.
// See DRIVES-PLAN.md §1 file table.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOTMIND_DIR = path.join(__dirname, 'botmind');

const FAILED_ARGS_CAP = 20;
const RECENT_GOALS_CAP = 20;

function filePath(botName) {
  return path.join(BOTMIND_DIR, `${botName}.json`);
}

function emptyMind() {
  return {
    reflection: { ts: null, good_at: null, village_lacks: null, want_next: null },
    knownShelterSpot: null,
    failedArgsRing: [],
    recentGoals: [],
    counters: {
      consecutiveFails: 0,
      lastDrivesSuccessAt: null,
      lastCrewChatAt: null,
    },
  };
}

// loadMind(botName) — best-effort: a missing file (fresh bot, ENOENT —
// expected) or a corrupt/unreadable one both fall back to emptyMind()
// silently (this is runtime scratch state, not the death-ledger evidence
// class that demands a loud warn on loss). Shallow-merges onto the default
// shape so a schema addition in a later version never crashes on an older
// saved file.
export function loadMind(botName) {
  try {
    const raw = fs.readFileSync(filePath(botName), 'utf8');
    const parsed = JSON.parse(raw);
    const base = emptyMind();
    return {
      ...base,
      ...parsed,
      reflection: { ...base.reflection, ...(parsed.reflection ?? {}) },
      counters: { ...base.counters, ...(parsed.counters ?? {}) },
    };
  } catch {
    return emptyMind();
  }
}

export function saveMind(botName, mind) {
  try {
    fs.mkdirSync(BOTMIND_DIR, { recursive: true });
    fs.writeFileSync(filePath(botName), JSON.stringify(mind, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function appendFailedArgs(mind, entry) {
  mind.failedArgsRing.push({ ts: new Date().toISOString(), ...entry });
  if (mind.failedArgsRing.length > FAILED_ARGS_CAP) {
    mind.failedArgsRing = mind.failedArgsRing.slice(-FAILED_ARGS_CAP);
  }
  return mind;
}

export function appendRecentGoal(mind, entry) {
  mind.recentGoals.push({ ts: new Date().toISOString(), ...entry });
  if (mind.recentGoals.length > RECENT_GOALS_CAP) {
    mind.recentGoals = mind.recentGoals.slice(-RECENT_GOALS_CAP);
  }
  return mind;
}

export function setReflection(mind, { good_at, village_lacks, want_next }) {
  mind.reflection = { ts: new Date().toISOString(), good_at: good_at ?? null, village_lacks: village_lacks ?? null, want_next: want_next ?? null };
  return mind;
}

export function setKnownShelterSpot(mind, pos) {
  mind.knownShelterSpot = pos ? { x: pos.x, y: pos.y, z: pos.z } : null;
  return mind;
}
