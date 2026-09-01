// cave/signals.js — shared cave/signals.jsonl backend (LEAD ANNOTATION D:
// "inventory-summary signals go BACKEND — NOT game chat; protocol spam
// class"). Each enrolled bot appends its own inventory summary on its own
// cadence; readLatestPerBot() (used by the reflection scheduler, feeds
// "village_lacks" in prose — never code-computed) keeps only the newest
// line per bot. See DRIVES-PLAN.md §7.
//
// OPEN RISK (DRIVES-PLAN.md §7, flagged, not silently assumed): this is the
// first jsonl file SHARED ACROSS MULTIPLE runner.js processes — ledger/
// missions files are one-per-bot, written only by their own process.
// fs.appendFileSync under O_APPEND is atomic per write on POSIX only while
// a single write stays under the platform's atomic-write boundary
// (commonly 4KB on Linux) — safe for these small single-line JSON records,
// but not a stronger guarantee. No corruption-recovery beyond the existing
// "skip bad line, count it" tolerance (ledger.mjs's own loadAllEntries()
// pattern, mirrored below) is planned for v1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGNALS_PATH = path.join(__dirname, 'signals.jsonl');

const PRUNE_THRESHOLD_LINES = 2000;
const PRUNE_KEEP_LINES = 500;

// appendSignal({bot, inventory, ...}) — never throws: a write failure is
// swallowed and reported back as {ok:false}, never taking the caller's
// tick down with it.
export function appendSignal(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try {
    fs.appendFileSync(SIGNALS_PATH, line + '\n');
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  maybePrune();
  return { ok: true };
}

// SELF-PRUNING (DRIVES-PLAN.md §7) — any appender that notices the file has
// grown past PRUNE_THRESHOLD_LINES truncates it to the last PRUNE_KEEP_LINES
// first, mirroring the in-memory EVENTS_MAX ring philosophy applied to a
// file shared across processes. Best-effort; a race between two appenders'
// prune isn't fatal (worst case one prune's write is immediately followed
// by the other's append, still a valid, still-bounded file).
function maybePrune() {
  try {
    const raw = fs.readFileSync(SIGNALS_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > PRUNE_THRESHOLD_LINES) {
      fs.writeFileSync(SIGNALS_PATH, lines.slice(-PRUNE_KEEP_LINES).join('\n') + '\n');
    }
  } catch {
    // no file yet, or a transient read/write race — not fatal; the next
    // appender's own maybePrune() retries
  }
}

// readLatestPerBot() — parses the whole file, keeps only the most recent
// line per `bot` field, tolerates corrupt lines (skip + count), same
// pattern as ledger.mjs's loadAllEntries().
export function readLatestPerBot() {
  let raw;
  try {
    raw = fs.readFileSync(SIGNALS_PATH, 'utf8');
  } catch {
    return { byBot: {}, badLines: 0 };
  }
  const byBot = {};
  let badLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry.bot !== 'string' || !entry.bot) throw new Error('missing "bot" field');
      const prev = byBot[entry.bot];
      if (!prev || (entry.ts && entry.ts > prev.ts)) byBot[entry.bot] = entry;
    } catch {
      badLines++; // a corrupt JSONL line (partial write, disk issue) — counted, not fatal
    }
  }
  return { byBot, badLines };
}
