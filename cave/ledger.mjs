#!/usr/bin/env node
// cave/ledger.mjs — reads cave/ledger/*.jsonl (written by runner.js's
// appendLedgerLine, see cave/runner.js's MACHINE-READABLE DEPOT LEDGER
// section) and prints a merged, filterable table + per-item net totals.
//
// This is the scoreboard/panel data source going forward, and it settles
// any future "chest X went from N to M, what happened?" mystery in one
// command — no chat-log scraping, no ad-hoc single-stack chest reads (see
// FEEDBACK.md "audit.mjs is the ledger ground truth" / Grog's single-stack
// self-correction entries).
//
// Usage:
//   node cave/ledger.mjs [--bot UngaBunga] [--item oak_log] [--since 2026-09-01T10:00:00Z]
//
// Zero LLM tokens, read-only (never touches the world or the ledger files).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_DIR = path.join(HERE, 'ledger');

function parseArgs(argv) {
  const args = { bot: null, item: null, since: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bot') args.bot = argv[++i];
    else if (argv[i] === '--item') args.item = argv[++i];
    else if (argv[i] === '--since') args.since = argv[++i];
  }
  if (args.since) {
    const t = Date.parse(args.since);
    if (Number.isNaN(t)) throw new Error(`--since is not a valid date: ${args.since}`);
    args.sinceMs = t;
  }
  return args;
}

function loadAllEntries() {
  let files;
  try {
    files = fs.readdirSync(LEDGER_DIR).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { entries: [], badLines: 0, files: [] };
  }
  const entries = [];
  let badLines = 0;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(LEDGER_DIR, file), 'utf8');
    } catch {
      continue; // unreadable file — skip, don't crash the whole tool over one bad file
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        badLines++; // a corrupt JSONL line (partial write, disk issue) — counted, not fatal
      }
    }
  }
  return { entries, badLines, files };
}

function applyFilters(entries, args) {
  return entries.filter((e) => {
    if (args.bot && e.bot !== args.bot) return false;
    if (args.item && e.item !== args.item) return false;
    if (args.sinceMs && Date.parse(e.ts) < args.sinceMs) return false;
    return true;
  });
}

function fmtRow(cols, widths) {
  return cols.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { entries: all, badLines, files } = loadAllEntries();

  if (files.length === 0) {
    console.log(`no ledger files found in ${LEDGER_DIR} — nothing has been deposited/withdrawn yet, or no runner has run since the ledger landed.`);
    return;
  }

  const entries = applyFilters(all, args);
  entries.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  console.log(`ledger: ${files.length} bot file(s), ${all.length} total entries, ${entries.length} after filters` + (badLines ? `, ${badLines} corrupt line(s) skipped` : ''));
  if (args.bot || args.item || args.since) {
    console.log(`  filters: ${[args.bot && `bot=${args.bot}`, args.item && `item=${args.item}`, args.since && `since=${args.since}`].filter(Boolean).join(', ')}`);
  }
  console.log('');

  const parsed = entries.filter((e) => typeof e.delta === 'number');
  const unparsed = entries.filter((e) => typeof e.delta !== 'number');

  const widths = [24, 12, 8, 20, 14];
  console.log(fmtRow(['ts', 'bot', 'delta', 'item', 'chest'], widths));
  for (const e of parsed) {
    console.log(fmtRow([e.ts, e.bot, (e.delta > 0 ? '+' : '') + e.delta, e.item, e.chest], widths));
  }
  if (unparsed.length) {
    console.log(`\n${unparsed.length} unparsed/malformed DEPOT-ish line(s) (raw, no clean delta/item/chest):`);
    for (const e of unparsed) console.log(`  [${e.ts}] ${e.bot}: ${e.raw}`);
  }

  const netByItem = new Map();
  for (const e of parsed) netByItem.set(e.item, (netByItem.get(e.item) ?? 0) + e.delta);

  console.log('\n--- per-item net totals (deposits minus withdrawals, filtered set) ---');
  if (netByItem.size === 0) {
    console.log('(no parsed entries in range)');
  } else {
    for (const [item, net] of [...netByItem.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${item.padEnd(24)} ${net > 0 ? '+' : ''}${net}`);
    }
  }
}

main();
