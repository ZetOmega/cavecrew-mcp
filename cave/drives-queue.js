// cave/drives-queue.js — cost guards for the drive engine (LEAD ANNOTATION
// G, DRIVES-PLAN.md §5 trigger condition 4): a cross-process global
// in-flight semaphore (file-lock dir cave/drives/queue/ — each bot is its
// own runner.js process, so the global cap on simultaneous LLM calls has to
// be enforced across processes, unlike the per-bot counters below which
// only ever need to be correct within their own single process) plus
// per-bot min-interval/hourly-cap counters. Implemented as a file-lock
// semaphore rather than a small broker service to avoid adding a new
// always-on port at pilot scale (DRIVES-PLAN.md §12 item 6 — flagged as
// worth revisiting if/when the full fleet enrolls).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = path.join(__dirname, 'drives', 'queue');

// A lock file older than this is treated as an abandoned/crashed holder
// (its runner process died mid-call without releasing) and pruned rather
// than counted against the cap forever.
const STALE_LOCK_MS = 5 * 60 * 1000;

function listLocks() {
  try {
    return fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.lock'));
  } catch {
    return [];
  }
}

function pruneStale() {
  const now = Date.now();
  for (const f of listLocks()) {
    const p = path.join(QUEUE_DIR, f);
    try {
      if (now - fs.statSync(p).mtimeMs > STALE_LOCK_MS) fs.unlinkSync(p);
    } catch {
      // already gone — fine
    }
  }
}

// acquireSlot(cap) — synchronous, best-effort: returns a release() function
// on success, or null if the cap is already full (or the queue dir itself
// is unavailable — treated the same as "no slot", never thrown, so a
// filesystem hiccup degrades to "try again next tick" rather than crashing
// the drive engine).
export function acquireSlot(cap) {
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    pruneStale();
    if (listLocks().length >= cap) return null;
    const id = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const p = path.join(QUEUE_DIR, `${id}.lock`);
    fs.writeFileSync(p, String(Date.now()));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(p);
      } catch {
        // already gone
      }
    };
  } catch {
    return null;
  }
}

export function queueDepth() {
  pruneStale();
  return listLocks().length;
}

// Per-bot cost guards — in-process only. Each bot's own runner.js process
// is the sole writer of its own counters (contrast acquireSlot() above,
// which IS cross-process), so a plain in-memory Map is sufficient; nothing
// here needs to survive a restart.
const perBotState = new Map(); // botName -> { lastCallAt, hourWindowStart, callsThisHour }

function getBotState(botName) {
  let s = perBotState.get(botName);
  if (!s) {
    s = { lastCallAt: 0, hourWindowStart: Date.now(), callsThisHour: 0 };
    perBotState.set(botName, s);
  }
  return s;
}

function rolloverHour(s) {
  if (Date.now() - s.hourWindowStart >= 3600000) {
    s.hourWindowStart = Date.now();
    s.callsThisHour = 0;
  }
}

// canCallNow(botName, guards) — checks min-interval + hourly cap ONLY (not
// the global in-flight slot — that's acquireSlot(), called separately so a
// caller can tell "too soon" apart from "queue full" in its own log line).
export function canCallNow(botName, guards) {
  const s = getBotState(botName);
  rolloverHour(s);
  if (Date.now() - s.lastCallAt < guards.minCallIntervalMs) return { ok: false, reason: 'min-interval' };
  if (s.callsThisHour >= guards.hourlyCallCap) return { ok: false, reason: 'hourly-cap' };
  return { ok: true };
}

export function recordCall(botName) {
  const s = getBotState(botName);
  rolloverHour(s);
  s.lastCallAt = Date.now();
  s.callsThisHour++;
}

export function callsThisHour(botName) {
  const s = getBotState(botName);
  rolloverHour(s);
  return s.callsThisHour;
}
