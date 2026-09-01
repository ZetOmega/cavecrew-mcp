// cave/runner.js — one process per cavecrew bot.
//
// Usage:
//   node cave/runner.js --name <Name> --port <320x> [--host localhost --mcport 25565]
//
// Starts an HTTP control API on 127.0.0.1:<port> immediately (it does not
// wait on the Minecraft connection), then connects to Minecraft in the
// background with auto-reconnect. See cave/DRIVER_GUIDE.md for the full API
// reference and cave/CIV.md for the port registry.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import toolPkg from 'mineflayer-tool';
import collectBlockPkg from 'mineflayer-collectblock';
import minecraftData from 'minecraft-data';
// Plain CJS optional plugins — safe to import unconditionally, only the
// *load into the bot* is try/catch guarded (see loadOptionalPlugins below).
// mineflayer-auto-eat is native ESM and is dynamic-imported there instead,
// so a hard failure in it can't blow up module evaluation for this file.
import armorManagerPlugin from 'mineflayer-armor-manager';
import pvpPkg from 'mineflayer-pvp';

import * as skills from './skills.js';
import * as movement from './movement.js';
import { createRconChat } from './rconchat.js';
import { tryStartWebInventory } from './webinv.js';
import { postStatus, isConfigured as discordConfigured } from './discord.mjs';
// DRIVES ENGINE (DRIVES-PLAN.md, DRIVES-SPEC.md) — drive-based idle
// self-selection, flag-off by default (cave/drives.json global:false).
// See the "DRIVES ENGINE" section below (after the IDLE-GUARD block) for
// the wiring; these modules are pure/side-effect-free at import time, so
// importing them unconditionally here costs nothing when drives is off.
import * as drivesConfig from './drives-config.js';
import * as drivesDsl from './drives-dsl.js';
import * as drivesLlm from './drives-llm.js';
import * as drivesMemory from './drives-memory.js';
import * as drivesQueue from './drives-queue.js';
import * as driveSignals from './signals.js';
import { skillNames as drivesSkillNames, getSkill as getDriveSkill } from './drives-skills-map.js';

const { createBot } = mineflayer;
const { goals } = pathfinderPkg;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { host: 'localhost', mcport: 25565, engine: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--mcport') out.mcport = Number(argv[++i]);
    else if (a === '--engine') out.engine = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.name || !args.port || Number.isNaN(args.port)) {
  console.error(
    'usage: node cave/runner.js --name <Name> --port <320x> [--host localhost --mcport 25565] [--engine auto|ash|pf]'
  );
  process.exit(1);
}
if (!['auto', 'ash', 'pf'].includes(args.engine)) {
  console.error(`usage: --engine must be one of auto|ash|pf (got "${args.engine}")`);
  process.exit(1);
}
const { name, port, host, mcport, engine: defaultEngine } = args;

// ---------------------------------------------------------------------------
// rconchat — grey narration. One lazy rconChat instance per runner process
// (created on first use, never re-created), used for every ROUTINE line this
// process itself generates (idle-guard chatter, the DEPOT ledger line
// ensureTool's own depot withdrawal emits — see skills.js). Real talk from a
// driver's own /chat call bypasses this entirely and stays bot.chat unless
// the driver explicitly asks for a style. Never let rconchat trouble crash
// the runner: local.json missing, RCON down, or a send failing all fall back
// to plain bot.chat.
// ---------------------------------------------------------------------------

const TEAM_COLORS = {
  Grog: 'green',
  UngaBunga: 'yellow',
  Zug: 'light_purple',
  Bonk: 'aqua',
  Thak: 'gold',
  Ook: 'red',
  Durk: 'blue',
  Mog: 'dark_aqua',
};
const teamColor = TEAM_COLORS[name] || 'white';

// local.json config — read once, lazily, cached. Same file rconchat.js reads
// for its own [rcon] block; this reads the sibling [discord] block. Missing
// file / bad JSON / missing block are all fine — just means Discord routing
// is off and status narration falls back to tellraw grey, as before.
let localConfigLoaded = false;
let localConfig = null;
function getLocalConfig() {
  if (!localConfigLoaded) {
    localConfigLoaded = true;
    try {
      const raw = fs.readFileSync(path.join(CAVE_DIR, 'local.json'), 'utf8');
      localConfig = JSON.parse(raw);
    } catch {
      localConfig = null;
    }
  }
  return localConfig;
}

let rconChatInstance = null;
let rconChatInitTried = false;
function getRconChat() {
  if (!rconChatInitTried) {
    rconChatInitTried = true;
    try {
      rconChatInstance = createRconChat();
    } catch (err) {
      logLine('warn', `rconchat unavailable, narration will fall back to bot.chat: ${err?.message ?? err}`);
      rconChatInstance = null;
    }
  }
  return rconChatInstance;
}

// DECHAT_PREFIXES — protocol/ledger prefixes that must NEVER reach real game
// chat, under ANY style (TOTAL DE-CHAT HARDENING, chief, 2026-09-01: the
// decree says never, and a driver picking style:"fancy"/"rainbow" on a
// TRADE/DEPOT/etc. line used to slip straight past smartChat's classifier —
// announce() sends fancy/rainbow as real chat unconditionally, no prefix
// check at all). Re-introduced (was PROTOCOL_PREFIX, deleted as dead weight
// in the first de-chat pass when it only gated smartChat's now-removed
// real-chat branch) specifically as the shared guard both remaining
// real-chat paths — announce()'s fancy/rainbow branch below, and smartChat's
// "!" branch — check before ever calling bot.chat.
const DECHAT_PREFIXES = /^(TRADE |USING |FREE |LEASE-BREAK |BASE |CLAIM |HELLO |OFFER |DEPOT )/;

// MACHINE-READABLE DEPOT LEDGER (foundation-grade, team-lead 2026-09-01) —
// DEPOT lines live only in the Discord feed since the de-chat decree;
// scoreboard.mjs's old chat-scrape is dead (nothing left to scrape), and
// audit.mjs only diffs point-in-time snapshots, it has no record of FLOW.
// One primitive fixes all three: every DEPOT-shaped line that passes
// through announce()'s status branch (the single choke point ALL DEPOT
// lines funnel through — DECHAT_PREFIXES forces any style down to
// 'status' first, so a fancy/rainbow DEPOT line still lands here) also
// gets appended as one JSON line to cave/ledger/<BotName>.jsonl.
//
// DEPOT_TRIGGER_RE decides "is this DEPOT-shaped at all" (loose — matches
// the FEEDBACK.md-documented DEPOT ledger prefix); DEPOT_PARSE_RE extracts
// the exact DRIVER_GUIDE.md format (`DEPOT +N item (chest X)` /
// `DEPOT -N item (chest X)`). A trigger-match that fails the stricter
// parse still gets logged — {ts, bot, raw, parsed:false} — never silently
// dropped, per the file's own "never unexplained again" standard.
const DEPOT_TRIGGER_RE = /^DEPOT [+-]\d+ /;
const DEPOT_PARSE_RE = /^DEPOT ([+-]\d+) (\S+) \(([^)]+)\)$/;

function appendLedgerLine(text) {
  const raw = String(text);
  if (!DEPOT_TRIGGER_RE.test(raw)) return;
  const ts = new Date().toISOString();
  const m = DEPOT_PARSE_RE.exec(raw);
  const entry = m
    ? { ts, bot: name, delta: parseInt(m[1], 10), item: m[2], chest: m[3], raw }
    : { ts, bot: name, raw, parsed: false };
  try {
    fs.appendFileSync(ledgerFilePath, JSON.stringify(entry) + '\n');
  } catch (err) {
    logLine('warn', `ledger append failed: ${err?.message ?? err}`);
  }
}

// announce(style, text) — style: 'status' (grey, default for routine lines),
// 'fancy', or 'rainbow'. Always resolves, never throws: an rconchat failure
// (no local.json, RCON down, a bad send) falls back to bot.chat with the
// plain text, so a narration line never takes the runner down with it.
async function announce(style, text) {
  // TOTAL DE-CHAT HARDENING — a protocol/ledger line forces style down to
  // 'status' regardless of what was requested. Checked BEFORE the style
  // dispatch below so fancy/rainbow can never carry one to real chat; one
  // log line records the downgrade so a driver who asked for fancy/rainbow
  // can see why it came out grey instead of silently getting a different
  // result than requested.
  if (style !== 'status' && DECHAT_PREFIXES.test(String(text))) {
    logLine('warn', `announce: forcing style '${style}' -> 'status' for protocol-prefixed line (never real chat, any style): ${String(text).slice(0, 60)}`);
    style = 'status';
  }
  // STATUS + DISCORD ROUTING (user decree): routine status chatter belongs in
  // a Discord channel, not game chat — game chat stays for real talk only.
  // When cave/local.json has a configured discord.webhookUrl, 'status' lines
  // go there INSTEAD of tellraw. Fancy/rainbow (and talk, handled by
  // smartChat below) are unaffected — those are deliberate in-game moments,
  // not routine narration. No webhook configured (current default state) ->
  // falls straight through to the existing tellraw-grey path.
  if (style === 'status') {
    // Ledger write happens unconditionally here, before the Discord/log
    // dispatch below and regardless of whether it succeeds — this is the
    // one place EVERY DEPOT-shaped status line passes through exactly
    // once, so it's the right (and only) place to hook the append.
    appendLedgerLine(text);
    // CHAT-SILENCE HARDENING (chief decree v2, 2026-09-01): routine status
    // NEVER touches the game — not as white chat, not as tellraw grey. It
    // goes to the Discord status feed when configured, otherwise only to the
    // runner log. The old tellraw-grey fallback still put narration in every
    // player's chat window, which is exactly the spam the decree bans.
    const cfg = getLocalConfig();
    if (discordConfigured(cfg)) {
      const ok = await postStatus({ botName: name, color: teamColor, text, webhookUrl: cfg.discord.webhookUrl });
      if (ok) return;
      logLine('warn', 'discord postStatus failed; status stays in runner log only');
    }
    logLine('info', `(status) ${text}`);
    return;
  }
  const rc = getRconChat();
  if (rc) {
    try {
      if (style === 'fancy') await rc.sayFancy(name, teamColor, text);
      else if (style === 'rainbow') await rc.sayRainbow(name, teamColor, text);
      else await rc.sayStatus(name, teamColor, text);
      return;
    } catch (err) {
      logLine('warn', `rconchat announce(${style}) failed, falling back to bot.chat: ${err?.message ?? err}`);
    }
  }
  try {
    // NARRATION-LEAK FIX (user decree: game chat = real talk only): a
    // 'status' line whose discord AND rconchat routes both failed must
    // degrade to the runner log, never to plain WHITE real chat — white
    // narration is the exact leak the routing exists to prevent. Deliberate
    // in-game moments (fancy/rainbow) keep the bot.chat fallback so a
    // proclamation is never silently swallowed.
    if (style === 'status') logLine('info', `(status, unrouted) ${text}`);
    else bot?.chat?.(String(text));
  } catch {
    // ignore — no bot to talk through either, nothing more to do
  }
}

// smartChat — narration router. Classification, in order:
//   1. starts with "!" -> IMPORTANT WHITE: strip the "!" and send verbatim
//      real chat — an announcement worth every bot/player noticing. This is
//      the ONLY path left that still touches real game chat.
//   2. anything else (including former protocol-ledger lines, see decree
//      below) -> routine narration, routed through announce('status', ...)
//      (Discord status feed when configured, else runner log only — see
//      announce() above).
//
// TOTAL DE-CHAT DECREE (chief, 2026-09-01): game chat = real talk only, full
// stop. Protocol-ledger lines (TRADE/USING/FREE/LEASE-BREAK/BASE/CLAIM/
// HELLO/OFFER) used to be a distinct case here — REAL WHITE CHAT, sent
// verbatim, because other bots/tribes parsed public chat for these exact
// prefixes. That is no longer true: inter-tribe coordination moved to the
// claims registry + repo/Discord (monkeorg/cavecrew-mcp#1), so nothing
// outside the crew needs these off public chat anymore, and that branch
// collapsed into case 2 above — same announce('status', ...) route DEPOT
// already got in the earlier, narrower DEPOT DE-CHAT decree. The
// PROTOCOL_PREFIX regex that used to gate that branch had no other reader
// in this codebase (checked: `rg PROTOCOL_PREFIX`, only this function used
// it) and is deleted along with the branch, not left dead. This is an
// EMIT-side change only — the runner's INBOUND chat parsing (hearing FEL's
// own protocol lines off real chat) is untouched, we still LISTEN, we just
// stop EMITTING these prefixes as white chat ourselves. Drivers keep
// sending every ledger line exactly as before, via /chat, unchanged format
// — only the destination moved, identical to the DEPOT precedent. KNOWN
// CONSEQUENCE (same shape as DEPOT's): any downstream tooling that greps the
// server's real chat log for these prefixes (scoreboard.mjs already had this
// problem for DEPOT) goes silent on protocol lines too until repointed at
// the Discord feed / claims registry.
async function smartChat(text) {
  const msg = String(text);
  if (msg.startsWith('!')) {
    const stripped = msg.slice(1).trim();
    // TOTAL DE-CHAT HARDENING — "!USING ..." (or any "!"+protocol-prefix
    // combo) must not slip a protocol line into real chat just because a
    // driver stacked the important-white marker on top of it. Same
    // DECHAT_PREFIXES guard announce() uses for fancy/rainbow, checked here
    // against the STRIPPED text (the "!" itself was never part of the
    // prefix match).
    if (DECHAT_PREFIXES.test(stripped)) {
      logLine('warn', `smartChat: forcing "!"-prefixed protocol line to status (never real chat): ${stripped.slice(0, 60)}`);
      await announce('status', stripped);
      return;
    }
    try {
      bot?.chat?.(stripped);
    } catch {
      // ignore — no bot to talk through either, nothing more to do
    }
    return;
  }
  await announce('status', msg);
}

// CHAT MIRROR (chief order): every line this bot actually SENDS to real MC
// chat is also mirrored to a second Discord webhook — config key
// discord.chatMirrorWebhookUrl in cave/local.json; key absent/placeholder ->
// feature silently off. The existing discord.webhookUrl status feed is
// untouched. Outbound-only by construction: this hooks the SEND side
// (bot.chat), never chat events heard from others, so no FEL lines can ever
// leak into the mirror. Wired by wrapping b.chat inside wireBot() — native
// runner code re-applied on every (re)connect, unlike felcrew's /eval
// monkeypatch that dies on relog — which catches every outbound path in one
// place: smartChat's '!' and protocol branches, announce()'s fancy/rainbow
// fallback, skills' bare-ctx fallbacks, and driver /eval chat. Best-effort
// same as postStatus: a mirror failure logs a warn and never delays or
// breaks the real chat send.
function mirrorOutboundChat(text) {
  const msg = String(text);
  if (msg.startsWith('/')) return; // never mirror slash-commands
  const cfg = getLocalConfig();
  const url = cfg?.discord?.chatMirrorWebhookUrl;
  if (typeof url !== 'string' || url.trim().length === 0 || url === 'CHANGE_ME') return;
  postStatus({ botName: name, color: teamColor, text: msg, webhookUrl: url }).then((ok) => {
    if (!ok) logLine('warn', `chat mirror post failed (best-effort, not retried): ${msg.slice(0, 80)}`);
  });
}

// ---------------------------------------------------------------------------
// directories + logging (set up before anything else can throw)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CAVE_DIR = __dirname;
const LOG_DIR = path.join(CAVE_DIR, 'logs');
const PID_DIR = path.join(CAVE_DIR, 'pids');
const DEATHS_DIR = path.join(CAVE_DIR, 'deaths');
const LEDGER_DIR = path.join(CAVE_DIR, 'ledger');
const MISSIONS_DIR = path.join(CAVE_DIR, 'missions');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(PID_DIR, { recursive: true });
fs.mkdirSync(DEATHS_DIR, { recursive: true });
fs.mkdirSync(LEDGER_DIR, { recursive: true });
fs.mkdirSync(MISSIONS_DIR, { recursive: true });

const logFilePath = path.join(LOG_DIR, `${name}.log`);
const pidFilePath = path.join(PID_DIR, `${name}.json`);
const ledgerFilePath = path.join(LEDGER_DIR, `${name}.jsonl`);
const missionsFilePath = path.join(MISSIONS_DIR, `${name}.jsonl`);

function logLine(level, msg) {
  const line = `[${new Date().toISOString()}] ${String(level).toUpperCase()} ${msg}`;
  try {
    fs.appendFileSync(logFilePath, line + '\n');
  } catch {
    // best effort — never let logging crash the process
  }
}

process.on('uncaughtException', (err) => {
  logLine('error', `uncaughtException: ${err?.stack ?? err}`);
});
process.on('unhandledRejection', (reason) => {
  logLine('error', `unhandledRejection: ${reason?.stack ?? reason}`);
});

logLine('info', `runner starting: name=${name} port=${port} host=${host} mcport=${mcport} pid=${process.pid}`);

// ---------------------------------------------------------------------------
// pid file
// ---------------------------------------------------------------------------

function writePidFile() {
  const record = { pid: process.pid, port, name, startedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(pidFilePath, JSON.stringify(record, null, 2));
  } catch (err) {
    logLine('error', `failed to write pid file: ${err.message}`);
  }
}

function removePidFile() {
  try {
    fs.unlinkSync(pidFilePath);
  } catch {
    // already gone, fine
  }
}

writePidFile();
process.on('exit', removePidFile);

// DIG-LAW VISIBILITY (team-lead ruling, 2026-09-01): a missing zones.json
// means the dig law is fail-open (see skills.js loadDigZones — deliberate, a
// fail-closed law would brick fleet mining on any box without the file), and
// that state must never be silent. One loud boot line makes it visible.
try {
  fs.accessSync(path.join(CAVE_DIR, 'zones.json'));
} catch {
  logLine('warn', 'cave/zones.json absent — dig law NOT in force on this runner (fail-open)');
}

function shutdown(signal) {
  logLine('info', `received ${signal}, shutting down`);
  try {
    server.close();
  } catch {
    // ignore
  }
  try {
    bot?.quit?.();
  } catch {
    // ignore
  }
  removePidFile();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// runtime state, events ring buffer, task bookkeeping
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const state = {
  connected: false,
  lastError: null,
  currentTask: null,
  deathCount: 0,
  lastDeath: null, // { pos: {x,y,z}|null, ts }
};

// ---------------------------------------------------------------------------
// DEATH LEDGER PERSISTENCE — a runner restart used to zero deathCount and
// drop lastDeath, erasing death evidence entirely (FEEDBACK: "runner restart
// erases death evidence" — violates the death-coordinates-always-logged law
// and breaks evolution scoring). Every death event now also appends to a
// gitignored per-bot cave/deaths/<name>.json, reloaded here on boot.
// Best-effort on both sides: a missing/corrupt file just means starting from
// zero (one warn line, not silent), and a failed write never takes the death
// handler down with it.
// ---------------------------------------------------------------------------

const deathsFilePath = path.join(DEATHS_DIR, `${name}.json`);
const deathLedger = []; // [{ pos, ts, dimension, cause, taskKind }] — capped at the last 100

function persistDeaths() {
  try {
    fs.writeFileSync(
      deathsFilePath,
      JSON.stringify(
        { name, deathCount: state.deathCount, lastDeath: state.lastDeath, deaths: deathLedger.slice(-100) },
        null,
        2
      )
    );
  } catch (err) {
    logLine('warn', `death ledger persist failed: ${err?.message ?? err}`);
  }
}

function loadDeaths() {
  try {
    const raw = JSON.parse(fs.readFileSync(deathsFilePath, 'utf8'));
    if (typeof raw?.deathCount === 'number') state.deathCount = raw.deathCount;
    if (raw?.lastDeath) state.lastDeath = raw.lastDeath;
    if (Array.isArray(raw?.deaths)) deathLedger.push(...raw.deaths.slice(-100));
    logLine('info', `death ledger loaded: deathCount=${state.deathCount}, entries=${deathLedger.length}`);
  } catch (err) {
    // No ledger yet (fresh bot, ENOENT — expected) or an unreadable/corrupt
    // file (unexpected) — either way, starting from zero is the correct
    // fallback, but it must be LOUD: silently resetting deathCount is the
    // exact evidence-loss bug this whole mechanism exists to prevent.
    logLine('warn', `death ledger: no usable file at ${deathsFilePath} (${err?.code ?? err?.message ?? err}) — starting fresh`);
  }
}
loadDeaths();

// Timestamp of the last moment the runner had no running task. Read by the
// idle-guard ticker (below) to decide when 60s of idleness has elapsed;
// written by markTaskFinished() every time a task leaves 'running'.
let idleSince = Date.now();

// ---------------------------------------------------------------------------
// poisoned targets — a position a task's bot died going after gets flagged
// here (with a timestamp) so future skill runs can steer clear of it. Set by
// the death handler below, read via ctx.isPoisoned() (see makeCtx). Entries
// expire on their own after POISON_TTL_MS; never retried automatically.
// ---------------------------------------------------------------------------

const POISON_TTL_MS = 15 * 60 * 1000;
const poisonedTargets = new Map(); // key "x,y,z" (floored) -> { pos, ts, expiresAt }

function poisonKey(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function poisonTarget(pos) {
  if (!pos) return;
  const key = poisonKey(pos);
  const now = Date.now();
  poisonedTargets.set(key, { pos: { x: pos.x, y: pos.y, z: pos.z }, ts: now, expiresAt: now + POISON_TTL_MS });
}

function purgeExpiredPoison() {
  const now = Date.now();
  for (const [key, entry] of poisonedTargets) {
    if (entry.expiresAt <= now) poisonedTargets.delete(key);
  }
}

function isPoisonedTarget(pos) {
  if (!pos) return false;
  purgeExpiredPoison();
  return poisonedTargets.has(poisonKey(pos));
}

function poisonedTargetsCount() {
  purgeExpiredPoison();
  return poisonedTargets.size;
}

// PANIC REFLEX tuning — see triggerPanic() below (defined after
// startTask/cancelCurrentTask) and its wiring into b.on('health', ...) in
// wireBot(). PANIC_CAMP_POS must stay in sync with skills.js's own (private)
// CAMP_POS constant, same duplication tradeoff as IDLE_GUARD_DEPOT_POS below.
const PANIC_HEALTH_THRESHOLD = 8; // matches skills.js's checkHealthRetreat threshold
const PANIC_COOLDOWN_MS = 30000; // don't refire the reflex on every single low-health tick
const PANIC_CAMP_POS = { x: 12, y: 89, z: 56 }; // must stay in sync with skills.js's CAMP_POS
const PANIC_FAR_RADIUS = 40; // blocks from camp — past this, a blind flee is riskier than sealing in place
const PANIC_DEEP_DELTA = 15; // blocks below camp's Y — this deep, seal+eat beats fleeing back to the surface
let lastPanicAt = 0;

const EVENTS_MAX = 500;
const eventsBuf = [];
let eventSeq = 0;

// RING FILTER (FEEDBACK "event ring flooded by FEL join/leave spam — useless
// for forensics", team-lead 2026-09-01) — Ook's ring at seq 10k+ was almost
// entirely "[FEL] X joined/left the game" from their reconnect storms, and a
// task-replacement sequence could not be reconstructed because the real
// events had already been shifted out of a 500-entry buffer. Join/leave of
// OUR OWN bots stays (that IS forensics — a crew bot relogging mid-task is
// exactly what you need to see); everyone else's is dropped at the two
// handler sites below, deliberately NOT inside pushEvent, so every other
// caller keeps writing to the ring unconditionally and nothing else can be
// silently swallowed by a filter it never asked for.
const OUR_BOTS = /^(Grog|UngaBunga|Zug|Bonk|Thak|Ook|Durk|Mog|TestRock|BariBrute)$/;
const JOIN_LEAVE_RE = /(?:^|\s)(\S+) (?:joined|left) the game$/;

function isForeignJoinLeave(text) {
  const m = JOIN_LEAVE_RE.exec(String(text).trim());
  if (!m) return false;
  // Names arrive tagged in this world ("[FEL] Friedrich", "[CAVE] Grog") —
  // strip any bracketed tribe prefix before matching the roster.
  const who = m[1].replace(/^\[[^\]]*\]/, '');
  return !OUR_BOTS.test(who);
}

// RING RATE CAP (FEEDBACK "2X CONFIRMED: idle-guard sweeps driver's KEEP
// items + retry-spam floods event ring", Grog 2026-09-01 09:13/09:19) — once
// chest A hit its cap, idle-guard's own deposit retries logged one 'quirk'
// event PER FAILED ITEM every ~5s cycle, 400+ events inside a minute, wiping
// the whole 500-entry ring past any real task history before anyone could
// read it. Same disease as the join/leave flood above, different source.
// Cap each event TYPE to RATE_CAP_PER_TYPE entries per RATE_CAP_WINDOW_MS;
// the rest are dropped and counted, and a single "...suppressed N similar"
// line replaces them once the window rolls over (either lazily, on the next
// event of that type, or via the sweep below if the spammy source goes
// quiet before that happens). Deliberately keyed on type alone, not
// message content — matches how the flood actually presented (many
// distinct item names, same 'quirk' type).
const RATE_CAP_PER_TYPE = 30;
const RATE_CAP_WINDOW_MS = 60000;
const rateState = new Map(); // type -> { windowStart, count, suppressed }

function flushSuppressed(type, rs) {
  if (!rs || rs.suppressed <= 0) return;
  eventSeq++;
  eventsBuf.push({
    seq: eventSeq,
    ts: new Date().toISOString(),
    type,
    msg: `...suppressed ${rs.suppressed} similar ${type} event(s)`,
  });
  if (eventsBuf.length > EVENTS_MAX) eventsBuf.shift();
  rs.suppressed = 0;
}

// Catches a type whose window went stale WITHOUT a follow-up event (the
// spam source stopped rather than kept going) — otherwise a trailing
// suppressed count would sit invisible forever, never flushed by
// pushEvent's own lazy rollover. Piggybacks the existing idle-guard tick
// interval below instead of adding a second timer for a cheap periodic scan.
function sweepStaleRateWindows() {
  const now = Date.now();
  for (const [type, rs] of rateState) {
    if (rs.suppressed > 0 && now - rs.windowStart >= RATE_CAP_WINDOW_MS) {
      flushSuppressed(type, rs);
    }
  }
}

function pushEvent(type, msg) {
  const now = Date.now();
  let rs = rateState.get(type);
  if (!rs) {
    rs = { windowStart: now, count: 0, suppressed: 0 };
    rateState.set(type, rs);
  } else if (now - rs.windowStart >= RATE_CAP_WINDOW_MS) {
    flushSuppressed(type, rs);
    rs.windowStart = now;
    rs.count = 0;
  }
  rs.count++;
  if (rs.count > RATE_CAP_PER_TYPE) {
    rs.suppressed++;
    return;
  }
  eventSeq++;
  eventsBuf.push({ seq: eventSeq, ts: new Date().toISOString(), type, msg: String(msg) });
  if (eventsBuf.length > EVENTS_MAX) eventsBuf.shift();
}

// TASK SOURCE (FEEDBACK "UPDATE on force task silently replaced: may be
// TWO-COMMANDERS problem", team-lead 2026-09-01) — a forced goto on Ook was
// replaced within 45s by a hunt task while OokDriver was independently
// running his own meat-run chain. Nobody could prove afterwards WHO issued
// the replacement: orchestrator, driver, and idle-guard all looked identical
// in the log. The adopted doctrine fix is one-commander-per-bot, but that is
// unenforceable without evidence, so every task now carries who asked for it
// and every replacement names both sides. Free-form on purpose (drivers
// invent their own labels: "OokDriver", "orchestrator", "bench") — sanitized
// to a short slug so a task field can never carry an injection payload into
// the status JSON or the log.
const TASK_SOURCE_MAX = 24;
function sanitizeSource(raw, fallback = 'http') {
  if (typeof raw !== 'string') return fallback;
  const slug = raw.trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, TASK_SOURCE_MAX);
  return slug || fallback;
}

// RUN_EPOCH (goal-engine repair, 2026-09-01) — taskCounter is module-scope
// and resets to 0 every time this process starts, so a bare `task-N` id is
// only unique WITHIN one runner.js process lifetime, never across a crash+
// respawn (spawn.mjs has no auto-restart, but a human respawning it hits
// this exactly). overseer.mjs's goal-completion detection matches a fired
// goal to its outcome by `ct.id === s.activeGoalTaskId` string equality —
// if the process restarts while the overseer still holds a stale
// activeGoalTaskId, the very first task after respawn is always "task-1"
// again, which can collide with a pre-restart id of the same name and be
// misread as that OLD goal completing (verified: found this could fire a
// false-positive removeGoal() on a repeat:false goal from a totally
// unrelated task's outcome). Folding a per-process epoch into the id
// itself makes every id globally unique for the practical lifetime of any
// tracking that references it, with no schema change and no extra field
// for callers to remember to compare — task.id stays a single opaque
// string everywhere it's already used (goal-picks.jsonl, panel-data.mjs's
// Map key, logs).
const RUN_EPOCH = `${process.pid}-${Date.now()}`;

let taskCounter = 0;
function newTask(kind, source = 'http') {
  // startedAt (G2, PANEL_V3_SPEC.md) — stamped once here, at the single
  // place every task object gets constructed, so markTaskFinished can
  // compute durationMs for the mission-history line without any extra
  // module-level state to track alongside it.
  return {
    id: `task-${RUN_EPOCH}-${++taskCounter}`,
    kind,
    source,
    state: 'running',
    detail: null,
    result: null,
    finishedAt: null,
    startedAt: new Date().toISOString(),
  };
}
function taskToJSON(t) {
  if (!t) return null;
  return {
    id: t.id,
    kind: t.kind,
    source: t.source ?? null,
    state: t.state,
    detail: t.detail,
    result: t.result,
    finishedAt: t.finishedAt,
  };
}

// G2 (PANEL_V3_SPEC.md) — durable mission history, deliberately mirroring
// the ledger's own pattern (commit 66a9ca8) exactly: same directory-per-
// concern convention, same append-only JSONL, same single-choke-point
// hook (every task, however it started, however it ends, passes through
// markTaskFinished exactly once — see its own comment above). Same
// tolerance rule too: append failure is one logLine('warn'), never
// throws, never blocks the task-finish path it's hooked into.
//
// counts:false marks idle-guard/panic-response — self-issued filler/
// reflex tasks, not real driver-requested work — mirrors how the panel
// already treats idle-guard as "idle," not "working," everywhere else.
// "Missions today" (a future panel query) = count of lines with
// counts !== false and ts within the current UTC day, across all bot
// files; these still get logged here for completeness, just flagged.
const MISSION_EXCLUDED_KINDS = new Set(['idle-guard', 'panic-response']);
function appendMissionLine(task) {
  const startedMs = task.startedAt ? Date.parse(task.startedAt) : NaN;
  const finishedMs = task.finishedAt ? Date.parse(task.finishedAt) : NaN;
  const durationMs = Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? finishedMs - startedMs : null;
  const entry = {
    ts: task.finishedAt,
    bot: name,
    kind: task.kind,
    source: task.source ?? null,
    state: task.state,
    durationMs,
    detail: task.detail,
    error: task.result?.error ?? null,
    counts: !MISSION_EXCLUDED_KINDS.has(task.kind),
  };
  try {
    fs.appendFileSync(missionsFilePath, JSON.stringify(entry) + '\n');
  } catch (err) {
    logLine('warn', `mission history append failed: ${err?.message ?? err}`);
  }
}

// Marks a task done/failed/cancelled: stamps finishedAt (STATUS-HOLD: the
// task object itself — including this timestamp — stays in state.currentTask
// as-is, never cleared to null, until the NEXT task replaces it; a driver
// polling /status always sees either a running task or the last finished one)
// and resets idleSince so the idle-guard threshold (see below) is measured
// from the moment the runner actually went idle, not from whenever it was
// last checked.
function markTaskFinished(task) {
  task.finishedAt = new Date().toISOString();
  idleSince = Date.now();
  appendMissionLine(task);
}

function makeCtx(task) {
  // Captured once, at task-start — every movement/task promise spawned from
  // this ctx "carries" this generation. `generation` itself (module-level,
  // bumped once per connect() call — see connect() below) is read live
  // inside isStaleGeneration(), so a reconnect that happens WHILE this task
  // is still running is detected the instant something next polls it.
  const startGen = generation;
  return {
    log: (level, msg) => {
      logLine(level, msg);
      if (level === 'warn' || level === 'error') pushEvent('quirk', msg);
    },
    setDetail: (detail) => {
      task.detail = detail;
    },
    isCancelled: () => task.state !== 'running',
    generation: startGen,
    isStaleGeneration: () => generation !== startGen,
    // Skills (out of this file's scope) call this to register "where I'm
    // headed right now" so that if the bot dies mid-task, that spot gets
    // poisoned (see the death handler below). Optional — a task that never
    // calls it just has nothing to poison on death.
    setTargetPos: (pos) => {
      task.targetPos = pos ? { x: pos.x, y: pos.y, z: pos.z } : null;
    },
    isPoisoned: (pos) => isPoisonedTarget(pos),
    get mcData() {
      return mcData;
    },
    // Grey narration passthrough for skills.js's own routine chat lines (e.g.
    // ensureTool's DEPOT ledger line on an automatic depot withdrawal, which
    // since the DEPOT/total de-chat decrees rides this path into the Discord
    // status feed — see smartChat and announce() above, which already falls
    // back to bot.chat internally on any rconchat failure). Optional on ctx
    // by design: a bare ctx built by
    // /eval or a test has no runner to route through, and skills.js falls
    // back to plain bot.chat itself when this isn't present.
    sayStatus: (text) => smartChat(text),
  };
}

// Instantly fails the active task (state=failed, not cancelled) with the
// given reason — used by the death/disconnect handlers below, which need the
// task to stop being "running" synchronously, before anything awaits.
// Distinct from cancelCurrentTask(): that one is for a *requested* stop
// (/stop, superseded-by-force) and marks the task done/cancelled; this one is
// for the bot no longer being in a state where the task could ever succeed.
function failActiveTask(errMsg) {
  const task = state.currentTask;
  if (task && task.state === 'running') {
    task.state = 'failed';
    task.result = { error: errMsg };
    state.lastError = errMsg;
    markTaskFinished(task);
    logLine('error', `task ${task.id} (${task.kind}) failed: ${errMsg}`);
    pushEvent('task', `task ${task.id} (${task.kind}) failed: ${errMsg}`);
  }
  try {
    // Same cancel path cancelCurrentTask uses: setGoal(null) always, plus
    // bot.ashfinder.stop() when ash was the engine actually in flight. `bot`
    // here is still the OLD instance at the moment end/kicked/death fires
    // (connect() only reassigns it later, from scheduleReconnect's timer).
    movement.cancelMovement(bot);
  } catch {
    // ignore
  }
  try {
    bot?.collectBlock?.cancelTask?.().catch(() => {});
  } catch {
    // ignore
  }
  return task;
}

async function cancelCurrentTask(reason) {
  const task = state.currentTask;
  // Mark the task cancelled FIRST (synchronously) so ctx.isCancelled() flips
  // before we await anything — otherwise a concurrent startTask can slip in
  // during the awaits below and end up with two tasks running at once.
  if (task && task.state === 'running') {
    task.state = 'done';
    task.detail = reason;
    task.result = { cancelled: true, reason };
    markTaskFinished(task);
    logLine('info', `task ${task.id} (${task.kind}) cancelled: ${reason}`);
    pushEvent('task', `task ${task.id} (${task.kind}) cancelled: ${reason}`);
  }
  try {
    // Delegates to cave/movement.js: setGoal(null) for pathfinder always,
    // plus bot.ashfinder.stop() when ashfinder was the engine actually
    // in flight — never bot.pathfinder.stop() (see skills.js/movement.js
    // header comments for why).
    movement.cancelMovement(bot);
  } catch {
    // ignore
  }
  try {
    if (bot?.collectBlock) await bot.collectBlock.cancelTask();
  } catch {
    // ignore
  }
  return task;
}

// ---------------------------------------------------------------------------
// WEDGE WATCHDOG — generic gathering-task progress guard (FEEDBACK: "chop
// task claims progress while full-wedged — no task-level watchdog": a chop
// sat 'running' 8+ minutes, position byte-stable, zero logs gained, while a
// full-wedge froze the bot's client physics). Staircase has its own
// net-descent watchdog; chop/mine/collect/hunt had nothing. This samples
// position + total inventory every WEDGE_TICK_MS while one of those kinds is
// running: ANY progress signal (>=1 block net move from the window baseline,
// or any inventory-count change) resets the window; a full WEDGE_WINDOW_MS
// with neither fails the task loudly so overseer/driver escalates (the 3/3
// confirmed cure for a real full-wedge is tp + hard runner restart) instead
// of trusting 'running' forever. goto is deliberately excluded (its own
// per-attempt timeouts + ground-truth checks already bound it); so are
// staircase/branchmine (net-descent watchdog) and station tasks (smelt/
// craft/deposit legitimately stand still — their inventories change anyway).
// Offline gaps never count toward the window (baseline resets while
// disconnected, so a relog doesn't insta-trip it).
// ---------------------------------------------------------------------------

const WEDGE_WATCHDOG_KINDS = new Set(['chop', 'mine', 'collect', 'hunt']);
const WEDGE_WINDOW_MS = 90000;
const WEDGE_TICK_MS = 15000;
const WEDGE_MOVE_EPSILON = 1.0; // blocks of net movement that count as progress

function inventoryTotalCount(b) {
  try {
    return b.inventory.items().reduce((sum, it) => sum + it.count, 0);
  } catch {
    return -1;
  }
}

// SEALED-POCKET RESCUE (FEEDBACK "mine/collect wedge-detector false-positives
// on tight ore pockets", Thak 2026-09-01) — a /mine and a /collect both died
// on the wedge error at the exact spot a coal_ore vein had just been dug out.
// Ground-truthing showed no engine wedge at all: the bot had simply sealed
// itself into a 1x1 mined-out pocket, every horizontal neighbor at foot level
// solid, nothing to walk into regardless of facing. That is the NORMAL
// end-state of finishing a vein, and the stuck-taxonomy ladder (raw-control
// test, then tp + hard restart) is enormous overkill for it — Thak freed it
// both times by digging one side wall and walking out.
//
// So: before declaring a wedge, look for that exact signature, and if it's
// there, dig one exit and give the task its window back. Only a rescue that
// fails (or a non-pocket stall) falls through to the loud failure.
const POCKET_DIRS = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
];

function isSealedPocket(b) {
  const feet = b.entity.position.floored();
  return POCKET_DIRS.every((d) => {
    const blk = b.blockAt(feet.offset(d.x, 0, d.z));
    // A null read is an unloaded/unknown cell, not a confirmed wall — never
    // claim the pocket signature on missing data.
    return !!blk && blk.boundingBox === 'block';
  });
}

// Digs one foot-level exit. Preference order matches Thak's manual fix:
// a neighbor whose HEAD-level cell is already air (so one dig opens a
// walkable 1x2 gap), else any diggable neighbor. skills.safeDig carries the
// protected-block guard and the reach law, so this can never eat furniture.
async function digPocketExit(b) {
  const feet = b.entity.position.floored();
  const rescueCtx = { log: (level, msg) => logLine(level, `pocket rescue: ${msg}`) };
  const candidates = [];
  for (const d of POCKET_DIRS) {
    const footBlk = b.blockAt(feet.offset(d.x, 0, d.z));
    const headBlk = b.blockAt(feet.offset(d.x, 1, d.z));
    if (!footBlk || !footBlk.diggable) continue;
    const headClear = !!headBlk && headBlk.boundingBox === 'empty';
    candidates.push({ block: footBlk, headClear });
  }
  candidates.sort((a, c) => Number(c.headClear) - Number(a.headClear));
  for (const c of candidates) {
    try {
      await b.tool?.equipForBlock?.(c.block, { requireHarvest: false });
    } catch {
      // bare hand is fine — dirt/gravel/stone all break eventually
    }
    try {
      await skills.safeDig(b, c.block, rescueCtx);
      return c.block.position;
    } catch (err) {
      logLine('warn', `pocket rescue: dig at ${c.block.position} failed: ${err?.message ?? err}`);
    }
  }
  return null;
}

function startWedgeWatchdog(task) {
  if (!WEDGE_WATCHDOG_KINDS.has(task.kind)) return null;
  let baselinePos = null;
  let baselineInv = -1;
  let baselineAt = Date.now();
  // Guards against a second rescue starting while the first is mid-dig: the
  // interval keeps firing every WEDGE_TICK_MS regardless of what the previous
  // tick started, and two concurrent digs on one bot is how you get a
  // half-broken block and a confused task.
  let rescueInProgress = false;
  return setInterval(() => {
    if (task.state !== 'running') return; // finally-clause clears us shortly
    const b = bot;
    if (!state.connected || !b?.entity) {
      baselinePos = null; // offline/respawning time never counts as wedged
      baselineAt = Date.now();
      return;
    }
    const pos = b.entity.position;
    const inv = inventoryTotalCount(b);
    if (!baselinePos || pos.distanceTo(baselinePos) >= WEDGE_MOVE_EPSILON || inv !== baselineInv) {
      baselinePos = pos.clone();
      baselineInv = inv;
      baselineAt = Date.now();
      return;
    }
    if (Date.now() - baselineAt < WEDGE_WINDOW_MS) return;
    // No movement, no inventory change, full window elapsed — wedge. Guard on
    // identity too: a force-preempt may have replaced state.currentTask while
    // this tick was queued, and failActiveTask only ever fails the CURRENT one.
    if (state.currentTask !== task) return;
    const posStr = `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`;

    // SEALED-POCKET FIRST — a self-dug pocket is not a wedge, so try the
    // cheap real fix before spending a task failure on it. The rescue is
    // async while this callback is not, so it runs detached: the task stays
    // alive meanwhile (that is the point), and either outcome is resolved on
    // its own promise. The next tick sees rescueInProgress and stands down.
    if (rescueInProgress) return;
    if (isSealedPocket(b)) {
      rescueInProgress = true;
      logLine('warn', `wedge watchdog: task ${task.id} looks SEALED-POCKET at ${posStr} — attempting self-rescue dig before failing`);
      pushEvent('quirk', `sealed-pocket rescue attempt at ${posStr} (${task.kind})`);
      Promise.race([
        digPocketExit(b),
        sleep(15000).then(() => {
          throw new Error('rescue exceeded 15s');
        }),
      ])
        .then((dugAt) => {
          if (!dugAt) throw new Error('no diggable exit found');
          // Give the task its full window back — it now has somewhere to go,
          // and the very next tick would otherwise re-fire on the same stale
          // baseline and fail it anyway.
          baselinePos = null;
          baselineAt = Date.now();
          logLine('info', `pocket rescue: opened exit at ${dugAt} — task ${task.id} continues`);
          pushEvent('quirk', `sealed-pocket rescue opened exit at ${dugAt}, task ${task.id} continues`);
        })
        .catch((err) => {
          // Rescue failed — this really is (or is indistinguishable from) a
          // wedge, so fall through to the original loud failure.
          if (state.currentTask !== task || task.state !== 'running') return;
          logLine('warn', `pocket rescue failed (${err?.message ?? err}) — falling through to wedge failure`);
          failActiveTask(
            `wedge: zero progress over ${WEDGE_WINDOW_MS / 1000}s at ${posStr}, sealed-pocket self-rescue failed (${err?.message ?? err}) — escalate per stuck-taxonomy (raw-control test, then tp+restart)`
          );
        })
        .finally(() => {
          rescueInProgress = false;
        });
      return;
    }

    logLine('warn', `wedge watchdog: task ${task.id} (${task.kind}) zero progress for ${WEDGE_WINDOW_MS / 1000}s at ${posStr}`);
    pushEvent('quirk', `wedge watchdog fired: ${task.kind} zero progress ${WEDGE_WINDOW_MS / 1000}s at ${posStr}`);
    failActiveTask(
      `wedge: zero progress over ${WEDGE_WINDOW_MS / 1000}s (no items gained, <${WEDGE_MOVE_EPSILON} block net move) at ${posStr} — likely wedged; escalate per stuck-taxonomy (raw-control test, then tp+restart)`
    );
  }, WEDGE_TICK_MS);
}

async function startTask(kind, fn, { force = false, source = 'http' } = {}) {
  const src = sanitizeSource(source);
  if (state.currentTask && state.currentTask.state === 'running') {
    // IDLE-GUARD auto-preemption: idle-guard is a runner-self-issued filler
    // task (see idleGuardCycle below), never something a driver asked for.
    // Any real task request must preempt it instantly — no 409, no need for
    // the driver to pass force:true — so a driver never has to know or care
    // that idle-guard happened to be running underneath it.
    // DRIVES-PLAN.md §1.6 (FLAGGED/inferred from annotation A's "driver
    // always wins" + K's "safety unchanged — same task layer, no new mutex"):
    // a drive-issued task (source:'drives') is preemptible by any real
    // driver call exactly like idle-guard already is — same boolean, same
    // evidence logging below, no `force` needed either way.
    const preemptingIdleGuard =
      (state.currentTask.kind === 'idle-guard' || state.currentTask.source === 'drives') && kind !== 'idle-guard';
    if (!force && !preemptingIdleGuard) {
      const err = new Error('busy');
      err.busy = true;
      throw err;
    }
    // TWO-COMMANDERS EVIDENCE — every replacement, forced or idle-guard
    // preemption, names both sides with their sources. This is the line that
    // settles "who ate my task" without anyone having to correlate three
    // separate driver transcripts by timestamp.
    const prev = state.currentTask;
    const replaceLine =
      `task ${prev.id} (${prev.kind}, source ${prev.source ?? 'unknown'}) replaced by ${kind} (source ${src})` +
      (preemptingIdleGuard ? ' [idle-guard preemption]' : ' [force]');
    logLine('warn', replaceLine);
    pushEvent('task', replaceLine);
    await cancelCurrentTask(preemptingIdleGuard ? 'preempted by driver task' : `superseded by new ${kind} task (force)`);
    // Re-check after the await: another request may have claimed the mutex
    // while we were cancelling. Exactly one caller may install a task.
    if (state.currentTask && state.currentTask.state === 'running') {
      const err = new Error('busy');
      err.busy = true;
      throw err;
    }
  }

  const task = newTask(kind, src);
  state.currentTask = task;
  logLine('info', `task ${task.id} (${kind}) started by ${src}`);
  pushEvent('task', `task ${task.id} (${kind}) started by ${src}`);
  const ctx = makeCtx(task);

  // Run in the background — the caller gets an immediate ack and polls /status.
  (async () => {
    const wedgeTimer = startWedgeWatchdog(task);
    try {
      const result = await fn(task, ctx);
      if (task.state === 'running') {
        task.state = 'done';
        task.result = result ?? null;
        markTaskFinished(task);
        logLine('info', `task ${task.id} (${kind}) done`);
        pushEvent('task', `task ${task.id} (${kind}) done`);
      }
    } catch (err) {
      if (task.state === 'running') {
        const msg = err?.message ?? String(err);
        task.state = 'failed';
        task.result = { error: msg };
        state.lastError = msg;
        markTaskFinished(task);
        logLine('error', `task ${task.id} (${kind}) failed: ${msg}`);
        pushEvent('task', `task ${task.id} (${kind}) failed: ${msg}`);
      }
    } finally {
      if (wedgeTimer) clearInterval(wedgeTimer);
    }
  })();

  return task;
}

// ---------------------------------------------------------------------------
// PANIC REFLEX — instant, game-speed health listener (adapted from
// felcrew-mcp survey findings: their panicguard.js is an /eval-injected
// payload that dies on every bot restart and needs manual re-injection after
// every relog; this is native to runner.js so it can never go missing).
// Their own FEEDBACK.md documents the gap this closes: a bot bled 20->0 HP
// in ~8 SECONDS inside a 50s driver polling gap — nothing that only checks
// health at the top of a task loop (see skills.js's checkHealthRetreat) is
// fast enough to catch that; only an event listener reacting the instant the
// 'health' packet arrives is. Wired into b.on('health', ...) in wireBot().
//
// Debounced (PANIC_COOLDOWN_MS) so a bot sitting below the threshold for a
// while doesn't refire the reflex every tick. Two responses, chosen by how
// safe a blind flee is likely to be (adapted from their own unshipped
// survival-doctrine.md "coffin" idea): near camp -> flee there; far from
// camp OR deep below it -> seal in place via skills.emergencySeal, since
// their own FEEDBACK.md logs a flee-home death to a skeleton at depth —
// fleeing toward camp doesn't help when camp isn't reachable in one safe
// line. Runs as a real task through startTask/cancelCurrentTask so it
// participates in the normal task mutex, /status, and /events like anything
// else — never a bypass around them.
// ---------------------------------------------------------------------------
async function triggerPanic(b) {
  const hp = typeof b.health === 'number' ? b.health : null;
  logLine('warn', `PANIC: health ${hp} at/below threshold ${PANIC_HEALTH_THRESHOLD}`);
  pushEvent('panic', `health ${hp} — panic reflex firing`);
  // CHIEF DECREE (2026-09-01): danger/HP lines are logs + Discord status
  // feed, NEVER game chat — this used to ride smartChat's "!" path (real
  // white chat, unmissable by design) which is exactly what's now banned
  // for routine danger telemetry. logLine + pushEvent above already cover
  // the record; announce('status', ...) is the Discord/log route (see
  // announce()'s style==='status' branch) — no game-chat emission at all.
  await announce('status', `HP ${hp != null ? Math.round(hp) : '?'}/20 - breaking off, reacting to danger!`);
  await cancelCurrentTask('panic: low health');

  const pos = b.entity?.position;
  const distFromCamp = pos
    ? Math.sqrt((pos.x - PANIC_CAMP_POS.x) ** 2 + (pos.y - PANIC_CAMP_POS.y) ** 2 + (pos.z - PANIC_CAMP_POS.z) ** 2)
    : Infinity;
  const deepBelowCamp = pos ? PANIC_CAMP_POS.y - pos.y > PANIC_DEEP_DELTA : false;
  const farOrDeep = distFromCamp > PANIC_FAR_RADIUS || deepBelowCamp;

  try {
    await startTask(
      'panic-response',
      async (task, ctx) => {
        if (farOrDeep) {
          ctx.setDetail('panic: far/deep from camp — sealing in place');
          return skills.emergencySeal(b, ctx);
        }
        ctx.setDetail('panic: fleeing to camp');
        await movement.goTo(
          b,
          { x: PANIC_CAMP_POS.x, y: PANIC_CAMP_POS.y, z: PANIC_CAMP_POS.z, range: 3, timeoutMs: 30000, engine: 'pf' },
          ctx
        );
        return { fled: true, to: PANIC_CAMP_POS };
      },
      { force: true, source: 'panic' }
    );
  } catch (err) {
    logLine('error', `panic response task failed to start: ${err?.message ?? err}`);
  }
}

function requireBot() {
  if (!bot || !bot.entity) throw new Error('bot is not connected/spawned yet');
  return bot;
}

// ---------------------------------------------------------------------------
// mineflayer bot lifecycle
// ---------------------------------------------------------------------------

let bot = null;
let mcData = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let relogTimer = null;
let manualRelog = false;
let lastHealth = null;
// Bumped once per connect() attempt (success or failure). ctx captures this
// at task-start (see makeCtx) so any promise a task is awaiting can tell,
// live, whether the bot it was talking to has since been replaced.
let generation = 0;

const pluginStatus = { autoEat: false, armorManager: false, pvp: false };

function tryLoadOptional(b, label, fn) {
  try {
    fn();
    logLine('info', `optional plugin loaded: ${label}`);
    return true;
  } catch (err) {
    logLine('warn', `optional plugin skipped (${label}): ${err?.message ?? err}`);
    return false;
  }
}

async function loadOptionalPlugins(b) {
  pluginStatus.autoEat = await tryLoadOptionalAsync(b, 'mineflayer-auto-eat', async () => {
    const mod = await import('mineflayer-auto-eat');
    b.loadPlugin(mod.loader);
  });
  pluginStatus.armorManager = tryLoadOptional(b, 'mineflayer-armor-manager', () => {
    b.loadPlugin(armorManagerPlugin);
  });
  pluginStatus.pvp = tryLoadOptional(b, 'mineflayer-pvp', () => {
    b.loadPlugin(pvpPkg.plugin);
  });
}

async function tryLoadOptionalAsync(b, label, fn) {
  try {
    await fn();
    logLine('info', `optional plugin loaded: ${label}`);
    return true;
  } catch (err) {
    logLine('warn', `optional plugin skipped (${label}): ${err?.message ?? err}`);
    return false;
  }
}

function wireBot(b) {
  // CHAT MIRROR wrap — see mirrorOutboundChat above. b.chat does NOT exist
  // yet at wireBot() time: mineflayer's core chat plugin injects async after
  // createBot() returns (took the whole fleet down on 2026-09-01 — the eager
  // `b.chat.bind(b)` threw on undefined for every connect attempt). Wrap
  // lazily once the plugin has injected; 'inject_allowed' fires before
  // 'spawn', with a spawn-time fallback in case injection ordering shifts.
  const wrapChatForMirror = () => {
    if (typeof b.chat !== 'function' || b.chat.__mirrorWrapped) return;
    const origChat = b.chat.bind(b);
    b.chat = (msg) => {
      try {
        mirrorOutboundChat(msg);
      } catch {
        // the mirror must never break the real chat send
      }
      return origChat(msg);
    };
    b.chat.__mirrorWrapped = true;
  };
  wrapChatForMirror();
  b.once('inject_allowed', wrapChatForMirror);
  b.once('spawn', wrapChatForMirror);

  b.loadPlugin(pathfinderPkg.pathfinder);
  b.loadPlugin(toolPkg.plugin);
  b.loadPlugin(collectBlockPkg.plugin);
  loadOptionalPlugins(b).catch((err) => logLine('error', `loadOptionalPlugins failed: ${err?.stack ?? err}`));
  // Synchronous, and always runs after movement.resolveAshfinder() has
  // already finished (see the connect() call site below) — ashfinder's own
  // internal spawn handler (which builds its real pathExecutor) must be
  // registered before b.once('spawn', ...) below fires, or bot.ashfinder
  // ends up looking loaded while silently not working. Guarded internally:
  // if the module never resolved (package not installed, or resolution
  // failed), this is a no-op and the bot runs pathfinder-only.
  movement.loadAshfinderIntoBot(b, (lvl, msg) => logLine(lvl, msg));

  b.once('spawn', () => {
    state.connected = true;
    reconnectAttempt = 0;
    idleSince = Date.now();
    try {
      mcData = minecraftData(b.version);
    } catch (err) {
      logLine('warn', `minecraft-data lookup failed for version ${b.version}: ${err.message}`);
    }
    // SAFETY MOVEMENTS (FEL intel + camp griefing incident): default pathfinder
    // Movements auto-DIG blocks en route — it ate the camp crafting table and
    // both depot chests as "path obstacles". Travel must never dig or scaffold;
    // actual digging happens only inside skills via bot.dig. Also fall-safety
    // caps (their fleet's fall death) and no ugly self-built towers.
    //
    // AUDIT (Grog 17-block fall, y54->37, health 20->6, team-lead priority
    // 2026-09-01): re-checked the FEEDBACK "Movements safety config" entry's
    // full list against this block line by line. 5 of 6 were ALREADY here
    // (allowParkour, maxDropDown=3, allow1by1towers, infiniteLiquidDropdown-
    // Distance, scafoldingBlocks — all correctly set since fe9e63c, early
    // today). Only allowSprinting was genuinely missing; added below.
    // IMPORTANT CAVEAT, not fixed by this change: maxDropDown only governs
    // pf's OWN voluntary route-planning (mineflayer-pathfinder source,
    // lib/movements.js ~467/487 — checked only inside the drop-down move
    // generator) — it does nothing for a fall caused by DIGGING out from
    // under/beside the bot mid-mine, which is not a pf-planned move at all.
    // Grog was branchmining (y45-62 band) when this happened; a mining-
    // triggered floor collapse is the far more likely cause than a travel
    // goto choosing too big a voluntary drop, and maxDropDown was already
    // active either way. Flagged to team-lead as a separate, real gap — a
    // mining-side "don't dig your own supporting floor out" check, if one
    // doesn't already exist, is not something this Movements-config audit
    // can address.
    try {
      const m = new pathfinderPkg.Movements(b);
      m.canDig = false;
      m.allow1by1towers = false;
      m.allowParkour = false;
      m.allowSprinting = false;
      m.maxDropDown = 3;
      m.infiniteLiquidDropdownDistance = false;
      m.scafoldingBlocks = [];
      // FARM AVOID (FEEDBACK "goto ROUTES STRAIGHT ACROSS live farmland",
      // Zug 2026-09-01) — no bot should ever step ON a crop tile anywhere;
      // farmers work from the adjacent path row, same reach-law discipline
      // as every other skill. Read mineflayer-pathfinder's own move-cost
      // source (node_modules/mineflayer-pathfinder/lib/movements.js) to
      // find the actually-effective cell rather than guessing:
      // getMoveForward/getMoveDiagonal only run safeOrBreak() — the
      // function blocksToAvoid gates — against the FEET/HEAD (body-space)
      // cells (blockB/blockC in getMoveForward, ~line 361-374); the FLOOR
      // block one down (blockD) is checked ONLY for .physical (can I stand
      // on it), never passed through safeOrBreak, so blocksToAvoid on it is
      // a structural no-op. farmland (id, boundingBox:'block') IS that
      // floor block — adding it here would do nothing, confirmed by
      // tracing the source, not left in. The block that DOES occupy the
      // feet cell when a tile is planted is the CROP itself (wheat/
      // carrots/potatoes/beetroots, all boundingBox:'empty' — normally
      // freely walkable, which is exactly why putting them in
      // blocksToAvoid is what actually changes pf's cost function).
      // Known gap, not solved by this: a BARE (unplanted/freshly-hoed)
      // farmland tile has no crop block above it, so it isn't covered —
      // flagged to team-lead, not silently claimed as complete.
      // Name list lives in movement.js's CROP_BLOCK_NAMES (single canonical
      // source shared with skills.js's collectDrops pre-filter and
      // movement.js's own rawWalkTo refusal) — not copy-pasted here.
      for (const cropName of movement.CROP_BLOCK_NAMES) {
        const cropId = mcData?.blocksByName?.[cropName]?.id;
        if (typeof cropId === 'number') m.blocksToAvoid.add(cropId);
      }
      b.pathfinder.setMovements(m);
      logLine('info', 'safety Movements applied (no-dig travel, crop-avoid)');
    } catch (err) {
      logLine('warn', `safety Movements failed: ${err.message}`);
    }
    logLine('info', `spawned as ${name} (mc version ${b.version})`);
    pushEvent('connect', `${name} spawned`);
    // Defensive belt-and-suspenders on every (re)connect: clear any movement
    // engine state that could otherwise carry over from a previous
    // connection's plugin internals. Cheap, idempotent, never throws — see
    // movement.js file-header gotcha #2 for why a stray in-flight ashfinder
    // path needs an explicit stop(), not just being left alone.
    try {
      b.ashfinder?.stop?.();
    } catch {
      // ignore
    }
    try {
      b.pathfinder?.setGoal?.(null);
    } catch {
      // ignore
    }
    // Best-effort inventory web viewer — see cave/webinv.js. Never throws
    // (internally try/catch guarded), but wrapped in .catch() anyway per this
    // file's defensive style for every optional-plugin call site.
    tryStartWebInventory(b, port).catch((err) =>
      logLine('error', `tryStartWebInventory threw unexpectedly: ${err?.stack ?? err}`)
    );
  });

  b.on('error', (err) => {
    if (b !== bot) {
      logLine('info', `ignoring 'error' from stale bot instance: ${err?.message ?? err}`);
      return;
    }
    const msg = err?.message ?? String(err);
    logLine('error', `bot error: ${err?.stack ?? err}`);
    state.lastError = msg;
    pushEvent('error', msg);
    // Some failure modes (e.g. connection refused before spawn) only ever
    // emit 'error', never 'end' — without this, reconnect backoff never
    // gets armed and the bot stays offline forever (the Zug case).
    // scheduleReconnect() is idempotent (guarded by reconnectTimer) so this
    // never double-schedules alongside the 'end' handler below.
    if (!state.connected) {
      state.connected = false;
      if (!manualRelog) scheduleReconnect();
    }
  });

  b.on('end', (reason) => {
    // Stale-bot guard: if a relog/reconnect already swapped in a new bot
    // object, this 'end' belongs to the old zombie. Reacting to it would
    // clobber state.connected and schedule a SECOND connect — two bots with
    // the same name. Ignore it.
    if (b !== bot) {
      logLine('info', `ignoring 'end' from stale bot instance: ${reason}`);
      return;
    }
    state.connected = false;
    logLine('warn', `disconnected (end): ${reason}`);
    pushEvent('disconnect', `end: ${reason}`);
    failActiveTask('disconnected');
    if (!manualRelog) scheduleReconnect();
  });

  b.on('kicked', (reason) => {
    if (b !== bot) return;
    const msg = typeof reason === 'string' ? reason : JSON.stringify(reason);
    logLine('warn', `kicked: ${msg}`);
    pushEvent('kicked', msg);
    // 'end' normally follows shortly and would catch this too, but fail the
    // task right here — no reason to wait for the socket-close event when we
    // already know the connection is done.
    failActiveTask('disconnected');
  });

  b.on('health', () => {
    if (lastHealth !== null && b.health < lastHealth) {
      pushEvent('health', `health dropped to ${b.health} (food=${b.food})`);
    }
    lastHealth = b.health;
    // PANIC REFLEX — see triggerPanic() above for the full rationale. Fires
    // at game-packet speed, not driver-poll speed; debounced so a bot
    // sitting below threshold doesn't refire every tick.
    if (b !== bot) return;
    if (typeof b.health !== 'number' || b.health <= 0 || b.health >= PANIC_HEALTH_THRESHOLD) return;
    const now = Date.now();
    if (now - lastPanicAt < PANIC_COOLDOWN_MS) return;
    lastPanicAt = now;
    triggerPanic(b).catch((err) => logLine('error', `triggerPanic threw: ${err?.stack ?? err}`));
  });

  b.on('death', () => {
    if (b !== bot) return;
    const pos = b.entity ? { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z } : null;
    const posStr = pos ? `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}` : 'unknown';
    logLine('warn', `died at ${posStr}`);
    pushEvent('death', `${name} died at ${posStr}`);
    state.deathCount++;
    state.lastDeath = { pos, ts: new Date().toISOString() };
    // Persist the ledger BEFORE anything async below — evidence must survive
    // even if the process dies mid-handler (see DEATH LEDGER PERSISTENCE).
    // dimension comes straight off bot.game (cheap, already populated by
    // mineflayer). cause is left null: mineflayer's 'death' event carries no
    // cause/attacker info on its own and this codebase has no damage-source
    // tracking to attach yet — recording null here beats fabricating one.
    deathLedger.push({
      pos,
      ts: state.lastDeath.ts,
      dimension: b.game?.dimension ?? null,
      cause: null,
      taskKind: state.currentTask?.kind ?? null,
    });
    persistDeaths();
    // TOTAL DE-CHAT, death included (chief decree, 2026-09-01): "chat =
    // talk only, no telemetry exceptions" — this used to be the one
    // deliberate holdout on the "!" real-chat path ("every death is worth
    // every bot/player noticing"), but the decree's spirit doesn't carve
    // out an importance exception. Routes through announce('status', ...)
    // like every other status line now; logLine + pushEvent('death', ...)
    // above already give the durable record. Bold + a skull emoji keeps it
    // visually unmissable in the Discord feed without needing real embed
    // support (discord.mjs's postStatus is plain-text content only today —
    // out of scope for this change) — Discord renders the markdown, and
    // the panel already shows death red from state.deathCount/lastDeath.
    announce('status', `**💀 DEATH:** ${name} died at (${posStr}) — deathCount ${state.deathCount}`).catch((err) =>
      logLine('warn', `death announce failed: ${err?.message ?? err}`)
    );
    // Grab the dying task's target BEFORE failing it (failActiveTask doesn't
    // touch task.targetPos, but read it first for clarity/safety) — that's
    // the spot that got the bot killed, so future skill runs should steer
    // clear of it. No automatic retry, ever.
    const dyingTask = state.currentTask;
    const targetPos = dyingTask && dyingTask.state === 'running' ? dyingTask.targetPos : null;
    failActiveTask(`died: ${posStr}`);
    if (targetPos) {
      poisonTarget(targetPos);
      logLine('info', `poisoned target ${poisonKey(targetPos)} after death`);
      pushEvent('quirk', `poisoned target ${poisonKey(targetPos)} after death`);
    }
  });

  b.on('chat', (username, message) => {
    if (username === b.username) return;
    // Ring filter (see isForeignJoinLeave): a server that routes join/leave
    // announcements as chat-position messages would otherwise flood the ring
    // through this handler too.
    if (isForeignJoinLeave(message)) return;
    pushEvent('chat', `${username}: ${message}`);
    // DRIVES-PLAN.md §3 — social need reads "minutes since last chat with
    // another (crew) bot"; markCrewChatHeard (DRIVES ENGINE section below,
    // function declaration, hoisted) is a no-op whenever drives-memory
    // hasn't been touched at all, i.e. always safe to call unconditionally.
    markCrewChatHeard(username);
  });

  // System/tellraw capture — mineflayer's 'message' event fires for every
  // server-sent chat-shaped packet, tagged with a position ('chat' |
  // 'system' | 'game_info', the "type flag"). Actual player chat already
  // comes through the dedicated 'chat' event above, so skip position==='chat'
  // here to avoid double-logging it; this is specifically for tellraw/system
  // announcements (including our own sayStatus/sayFancy/sayRainbow lines)
  // that never fire 'chat' at all.
  b.on('message', (jsonMsg, position) => {
    if (b !== bot) return;
    if (position === 'chat') return;
    let text;
    try {
      text = jsonMsg.toString();
    } catch {
      text = String(jsonMsg);
    }
    // Ring filter — this is the handler FEL's reconnect storms actually came
    // through (join/leave are system-position messages, not player chat).
    if (isForeignJoinLeave(text)) return;
    pushEvent('system', `[${position}] ${text}`);
  });
}

function connect() {
  logLine('info', `connecting to ${host}:${mcport} as ${name}`);
  // Bump BEFORE the attempt, even though it might fail synchronously below —
  // this is "a (re)connect happened", and any task/promise still holding an
  // older generation should already be considering itself stale.
  generation++;
  try {
    bot = createBot({
      host,
      port: mcport,
      username: name,
      auth: 'offline',
      disableChatSigning: true,
    });
    wireBot(bot);
  } catch (err) {
    // Root cause of the Zug bug: reconnection was entirely event-driven (via
    // bot.on('end')/('error')). If createBot()/wireBot() itself threw
    // synchronously (bad plugin load, etc.), no bot object ever got far
    // enough to emit those events, so nothing ever called scheduleReconnect()
    // again — connected stayed false forever with backoff never re-armed.
    // Catch it here and re-arm explicitly so a bad attempt always leads to
    // another attempt.
    logLine('error', `connect() failed synchronously: ${err?.stack ?? err}`);
    state.connected = false;
    state.lastError = err?.message ?? String(err);
    pushEvent('error', `connect failed: ${err?.message ?? err}`);
    if (!manualRelog) scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delays = [5000, 10000, 20000];
  // Cap at 60s regardless of how large reconnectAttempt has grown; reset to 0
  // happens on every successful spawn (see b.once('spawn', ...) above).
  const delay = reconnectAttempt < delays.length ? delays[reconnectAttempt] : 60000;
  reconnectAttempt++;
  logLine('info', `reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Kick off the Minecraft connection — this does NOT block the HTTP server
// below from binding and answering requests immediately (server.listen() is
// still a synchronous call further down this same module, unaffected by the
// promise chain below). The one thing that DOES wait is connect() itself:
// movement.resolveAshfinder() must finish (successfully or not) before the
// first wireBot() runs, so the ashfinder plugin's own spawn handler always
// gets registered before mineflayer's spawn fires — see movement.js and
// wireBot() above. Every reconnect after this first one hits the cached
// result instantly, so this only delays the very first connect, by however
// long a local module resolution takes (milliseconds).
movement
  .resolveAshfinder((lvl, msg) => logLine(lvl, msg))
  .catch((err) => logLine('error', `movement.resolveAshfinder failed: ${err?.stack ?? err}`))
  .finally(() => connect());

// ---------------------------------------------------------------------------
// IDLE-GUARD — runner-level, self-issued filler work. When the bot has had no
// running task for IDLE_GUARD_THRESHOLD_MS and is connected, the ticker below
// self-issues an 'idle-guard' task (through the normal startTask/task-mutex
// path, so it shows up in /status like anything else) that loops forever:
// sweep drops -> deposit surplus at depot A if close enough and carrying
// enough, else a short pause -> repeat. Deliberately preemptible: any real
// task request from a driver instantly cancels it (see the
// preemptingIdleGuard branch in startTask above) with no 409 and no force
// flag needed. deathCount/poisonedTargets/state.connected etc. are never
// touched here — idle-guard is just another task from their point of view.
// ---------------------------------------------------------------------------

const IDLE_GUARD_THRESHOLD_MS = 90000; // EMERGENCY REVERT: 15s machine-gunned the task mutex and locked out ALL driver tasks fleet-wide. Visible-idle answer = smarter filler, not faster trigger.
const IDLE_GUARD_TICK_MS = 5000;

// DRIVER-AWARE TOGGLE (issue #6) — an LLM driver's own think-gaps regularly
// exceed IDLE_GUARD_THRESHOLD_MS and are normal, not abandonment; without a
// way to say "I'm still driving, just thinking" the guard self-issues a
// filler task underneath an active driver (two-commanders problem). POST
// /idleguard {"on":false} lets a driver quiet the guard for its own session.
// SAFETY TTL below is the backstop for a driver that goes off flag AND then
// vanishes for real — a bot must never end up permanently unguarded just
// because the driver that disabled it crashed or forgot.
let idleGuardEnabled = true;
let idleGuardOffLoggedAt = 0;
const IDLE_GUARD_OFF_LOG_INTERVAL_MS = 180000; // log the "skipping" line at most once per 3min while off, not every 5s tick
let lastHttpRequestAt = Date.now(); // stamped once per request in handleRequest; safety TTL below measures driver silence from this
const IDLE_GUARD_SAFETY_TTL_MS = 15 * 60 * 1000; // 15min with zero incoming HTTP requests while off -> auto re-arm
// Depot chest A — must stay in sync with skills.js's own DEPOT_POS constant
// (kept separate rather than exported/imported to avoid coupling this
// runner-only scheduling concern to skills.js's module surface).
const IDLE_GUARD_DEPOT_POS = { x: 11, y: 89, z: 55 };
const IDLE_GUARD_DEPOT_RADIUS = 40;
const IDLE_GUARD_SURPLUS_THRESHOLD = 8;

// KEEP-LIST HEURISTIC (FEEDBACK "2X CONFIRMED: idle-guard sweeps driver's
// KEEP items", Grog 2026-09-01 09:13/09:19) — idle-guard's deposit sweep had
// no concept of "keep this on the bot": a real idle gap (reading a teammate
// message, no task issued) dumped crafting_table x1, bread x5, furnace x2 —
// items the driver needed on-hand, not banked — straight into chest A, twice
// in one session. FEEDBACK's own fix (1) proposed either a full driver-set
// keep-list (bigger: needs a new endpoint + validation + docs) or, "at
// minimum," a fixed heuristic — keep last N food + first crafting_table +
// first furnace. Implemented the minimum here: it directly stops the
// reported damage without new API surface. FOOD_MIN(8) matches
// DRIVER_GUIDE's own "8 food" deep-kit baseline, not a new number invented
// here. Food detection uses mcData.foodsByName (populated on spawn — see
// wireBot), not a hardcoded name list, so it stays correct across recipe/
// item-set changes for free.
const IDLE_GUARD_KEEP_CRAFTING_TABLE = 1;
const IDLE_GUARD_KEEP_FURNACE = 1;
const IDLE_GUARD_KEEP_FOOD_MIN = 8;

// DEPOSIT BACKOFF (FEEDBACK "2X CONFIRMED: idle-guard sweeps driver's KEEP
// items + retry-spam floods event ring", Grog 2026-09-01 09:13/09:19) — once
// chest A was full, idle-guard kept re-attempting the identical deposit
// every ~5s cycle (31+ cycles observed in under 30s) instead of backing off,
// burning ring budget for zero effect. Two consecutive failed/empty deposit
// attempts (chest full, or the call throwing outright) now pause further
// deposit attempts for IDLE_GUARD_DEPOSIT_BACKOFF_MS — drop-sweeping still
// runs every cycle as before, only the deposit step is skipped.
const IDLE_GUARD_DEPOSIT_BACKOFF_MS = 10 * 60 * 1000;
let idleGuardDepositFailStreak = 0;
let idleGuardDepositBackoffUntil = 0;

function distance3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Sleeps up to ms, but checks ctx.isCancelled() every 500ms and returns
// early the instant a preemption lands — this is what makes the "else pause
// 20s" branch of the cycle instantly preemptible instead of blocking a
// driver's request behind a dumb setTimeout.
async function cancellableSleep(ms, ctx) {
  const step = 500;
  let waited = 0;
  while (waited < ms) {
    if (ctx.isCancelled?.()) return;
    await sleep(Math.min(step, ms - waited));
    waited += step;
  }
}

async function idleGuardCycle(task, ctx) {
  let cycles = 0;
  while (!ctx.isCancelled() && !ctx.isStaleGeneration?.()) {
    const b = bot;
    if (!b || !b.entity) break;
    cycles++;
    ctx.setDetail(`idle-guard: cycle ${cycles}`);

    await announce('status', '(idle-guard) sweeping for drops');
    try {
      await skills.collectDrops(b, { radius: 12 }, ctx);
    } catch (err) {
      ctx.log('warn', `idle-guard: collectDrops failed: ${err.message}`);
    }
    if (ctx.isCancelled()) break;
    if (!bot || !bot.entity) break;

    const nonTool = bot.inventory.items().filter((it) => !skills.isToolLike(it.name));
    // KEEP-LIST HEURISTIC — merge same-name stacks first (multiple
    // inventory slots of one item are separate Item objects), then subtract
    // each item's keep-minimum before deciding what's actually surplus.
    // depositToChest supports {name, count} specs (caps how much of a
    // matching stack moves), so a keep-protected item either drops out of
    // the deposit list entirely (count <= keep-min) or only its true
    // surplus goes out — ordinary items (keepMin 0) behave exactly as
    // before: full stack, unchanged.
    const mergedCounts = new Map();
    for (const it of nonTool) mergedCounts.set(it.name, (mergedCounts.get(it.name) ?? 0) + it.count);
    const depositSpecs = [];
    for (const [itemName, count] of mergedCounts) {
      let keepMin = 0;
      if (itemName === 'crafting_table') keepMin = IDLE_GUARD_KEEP_CRAFTING_TABLE;
      else if (itemName === 'furnace') keepMin = IDLE_GUARD_KEEP_FURNACE;
      else if (mcData?.foodsByName?.[itemName]) keepMin = IDLE_GUARD_KEEP_FOOD_MIN;
      const surplus = count - keepMin;
      if (surplus > 0) depositSpecs.push({ name: itemName, count: surplus });
    }
    const nonToolCount = depositSpecs.reduce((sum, s) => sum + s.count, 0);
    const dist = distance3(bot.entity.position, IDLE_GUARD_DEPOT_POS);

    if (nonToolCount > IDLE_GUARD_SURPLUS_THRESHOLD && dist <= IDLE_GUARD_DEPOT_RADIUS) {
      if (Date.now() < idleGuardDepositBackoffUntil) {
        // Backed off after 2 consecutive failures — see IDLE_GUARD_DEPOSIT_BACKOFF_MS
        // above. Drop-sweep above still ran this cycle; only the deposit
        // attempt itself is skipped until the backoff clears.
        await announce('status', '(idle-guard) deposit backed off (chest full/failing recently), pausing');
        await cancellableSleep(20000, ctx);
      } else {
        await announce('status', `(idle-guard) depositing ${nonToolCount} surplus items at depot`);
        let depositFailed = false;
        try {
          const result = await skills.depositToChest(bot, { pos: IDLE_GUARD_DEPOT_POS, items: depositSpecs }, ctx);
          const deposited = result.deposited || [];
          if (deposited.length) {
            idleGuardDepositFailStreak = 0;
            // DEPOT ledger, one line per item, in the DRIVER_GUIDE DEPOT format.
            // Still emitted through smartChat and still worded identically —
            // but since the DEPOT de-chat decree (2026-09-01) and now the
            // total de-chat decree (see smartChat above), every non-"!" line
            // routes through announce('status') to the Discord status feed
            // instead of public white chat, protocol lines included.
            for (const d of deposited) {
              await smartChat(`DEPOT +${d.count} ${d.name} (chest A)`);
            }
          } else {
            depositFailed = true;
            await announce('status', '(idle-guard) deposited nothing (chest full?)');
          }
        } catch (err) {
          depositFailed = true;
          ctx.log('warn', `idle-guard: deposit failed: ${err.message}`);
          await announce('status', `(idle-guard) deposit attempt failed: ${err.message}`);
        }
        if (depositFailed) {
          idleGuardDepositFailStreak++;
          if (idleGuardDepositFailStreak >= 2) {
            idleGuardDepositBackoffUntil = Date.now() + IDLE_GUARD_DEPOSIT_BACKOFF_MS;
            idleGuardDepositFailStreak = 0;
            logLine('warn', `idle-guard: deposit failed twice in a row, backing off ${IDLE_GUARD_DEPOSIT_BACKOFF_MS / 60000}min`);
            pushEvent('idle-guard', `deposit backoff: 2 consecutive failures, pausing deposit attempts for ${IDLE_GUARD_DEPOSIT_BACKOFF_MS / 60000}min`);
          }
        }
      }
    } else {
      await announce('status', '(idle-guard) nothing to do, pausing');
      await cancellableSleep(20000, ctx);
    }
  }
  return { cycles };
}

function maybeStartIdleGuard() {
  // DRIVES-PLAN.md §1.5 (FLAGGED/inferred — spec's own framing "replace
  // idle behaviour with drive-based self-selection" + annotation E's
  // parallel treatment of overseer's goal-engine implies idle-guard must
  // also stand down for an enrolled+on bot, or the two idle-fillers fight
  // over the same trigger). Costs one cheap boolean+mtime check per tick
  // when drives is off/not-enrolled — never short-circuits idle-guard then.
  if (drivesOwnsIdle(name)) return;
  if (!idleGuardEnabled) {
    const now = Date.now();
    if (now - idleGuardOffLoggedAt > IDLE_GUARD_OFF_LOG_INTERVAL_MS) {
      idleGuardOffLoggedAt = now;
      logLine('info', 'idle-guard: disabled by driver, skipping fire');
    }
    return;
  }
  if (!state.connected || !bot?.entity) return;
  const isIdle = !state.currentTask || state.currentTask.state !== 'running';
  if (!isIdle) return;
  if (Date.now() - idleSince < IDLE_GUARD_THRESHOLD_MS) return;
  startTask('idle-guard', idleGuardCycle, { source: 'idle-guard' }).catch((err) => {
    if (!err?.busy) logLine('error', `idle-guard: failed to self-start: ${err?.message ?? err}`);
  });
}

// SAFETY TTL — if a driver disabled the guard and then goes silent (crashed,
// lost connection, forgot) for IDLE_GUARD_SAFETY_TTL_MS with zero incoming
// HTTP requests of ANY kind, the guard re-arms itself unconditionally. An
// abandoned bot must never sit unguarded forever just because the last thing
// a driver did was turn the guard off.
function checkIdleGuardSafetyTTL() {
  if (idleGuardEnabled) return;
  if (Date.now() - lastHttpRequestAt < IDLE_GUARD_SAFETY_TTL_MS) return;
  idleGuardEnabled = true;
  logLine('warn', 'idle-guard: re-armed after 15min driver silence (safety TTL)');
  pushEvent('idle-guard', 're-armed after 15min driver silence');
}

setInterval(() => {
  try {
    checkIdleGuardSafetyTTL();
    maybeStartIdleGuard();
    sweepStaleRateWindows();
    tickDrives(); // DRIVES-PLAN.md §1.4 — reuses this existing 5s cadence, no new timer
  } catch (err) {
    logLine('error', `idle-guard tick error: ${err?.stack ?? err}`);
  }
}, IDLE_GUARD_TICK_MS);

// ---------------------------------------------------------------------------
// DRIVES ENGINE (DRIVES-SPEC.md, DRIVES-PLAN.md) — drive-based idle
// self-selection: no roles, no injected story, vanilla survival. Fires
// ONLY for a bot explicitly enrolled in cave/drives.json AND with
// global:true there AND not paused via POST /drives — flag-off by
// construction (annotation L), and every layer below fails toward
// dormant/inert, never toward guessing or retrying blind.
//
// Structured exactly like idle-guard above: module-level constants/state,
// a tick function wired into the SAME 5s setInterval, and task dispatch
// through the SAME startTask()/task-mutex path every taskRoutes handler
// uses (annotation K — no new movement primitive, no new mutex).
// ---------------------------------------------------------------------------

// lastCommandAt (DRIVES-PLAN.md §2) — see the "any HTTP call = activity"
// narrowing note at its stamp site in handleRequest() above. Starts at
// process-boot time (not 0) so a freshly-started, already-enrolled bot
// doesn't fire a decision call before anything (bot spawn, driver
// handshake) has had a chance to settle.
let lastCommandAt = Date.now();

// Runtime toggle (mirrors idleGuardEnabled exactly) — a driver's per-session
// pause, NOT the config kill-switch. Defaults to true so an enrolled+
// global:true bot is armed the instant it boots, same as idle-guard; the
// real "off by default" guarantee lives in drives.json's global:false and
// each bot's own absent/false enrollment entry, not here.
let drivesRuntimeOn = true;

// drivesOwnsIdle(botName) — the three-part check both maybeStartIdleGuard's
// suppression (§1.5) and buildStatus()'s `drives.on` field read off of:
// this bot is enrolled, the kill-switch is on, and the driver hasn't
// paused it this session.
function drivesOwnsIdle(botName) {
  return drivesConfig.isEnrolled(botName) && drivesConfig.isGlobalOn() && drivesRuntimeOn;
}

// Per-process runtime state — reconstructed live (needs) or loaded once at
// boot (mind) rather than re-read every tick; see drives-memory.js for the
// on-disk shape (cave/botmind/<bot>.json, gitignored).
const mind = drivesMemory.loadMind(name);
const driveState = {
  needs: null, // {hunger, safety, shelter, resources, social, boredom} | null (null until first enrolled+global tick)
  lastDecision: null, // {ts, need, skill, why}
};

let decisionInFlight = false;
let reflectionInFlight = false;
let reflectionState = null; // {intervalMs, nextAt} — randomized once per process, see ensureReflectionSchedule
let reflectionWindowStart = Date.now();
const recentBlockSightings = new Set(); // nearby block-type names sampled each tick, merged/deduped since last reflection

// LLM readiness — checked ONCE, lazily, the first tick every other trigger
// condition already holds (annotation F: "never retried until the runner
// restarts"). llmReadinessResult stays a stable {ready:false,...} or
// {ready:true, apiKey} for the rest of this process's life either way.
//
// CRITICAL FIX (drive-engine audit): this used to be a boolean latch
// (llmReadinessChecked) set true SYNCHRONOUSLY plus a result populated only
// after the `await verifyModel(...)` network round-trip resolved. A second
// tickDrives() (next 5s tick, or a concurrent reflection cycle) landing in
// that window — the exact slow-network case annotation F's "no retry
// storm" contract is testing — read llmReadinessResult while still null and
// returned null; every caller does `if (!ready.ready)` on that, an
// uncaught TypeError surfacing as one ERROR log line per tick until (or
// unless) the first verifyModel() call ever resolves. Caching the in-flight
// PROMISE itself instead of a boolean+later-populated-result closes the
// window: every concurrent caller awaits the SAME promise, none can
// observe a not-yet-populated result.
let llmReadinessPromise = null;

// LOG-ONCE latch (DRIVES-PLAN.md Test 1/Test 2: "at most one ... line",
// "never repeated on later ticks") — same intent as idle-guard's own
// idleGuardOffLoggedAt, but a permanent one-shot-per-distinct-message latch
// rather than a periodic re-log, since these are one-time state
// transitions (config off, no key, model mismatch), not an ongoing
// condition worth re-announcing.
const drivesLoggedReasons = new Set();
function logDrivesOnce(msg) {
  if (drivesLoggedReasons.has(msg)) return;
  drivesLoggedReasons.add(msg);
  logLine('info', msg);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// markCrewChatHeard(username) — hooked from the b.on('chat', ...) handler
// above (wireBot()). Only OUR_BOTS chat counts toward the social need
// (spec: "minutes since last chat with ANOTHER BOT") — FEL/random-player
// chat doesn't satisfy it, matching OUR_BOTS' existing use elsewhere in
// this file for exactly this "is this one of ours" question.
function markCrewChatHeard(username) {
  const stripped = String(username).replace(/^\[[^\]]*\]/, '');
  if (stripped === name || !OUR_BOTS.test(stripped)) return;
  mind.counters.lastCrewChatAt = Date.now();
}

// isHostileNearby(radius) — entity.kind is mineflayer's own live category
// string, confirmed against the installed mineflayer 4.35.0 + minecraft-data
// (entities.js: `entity.kind = entityData.category`; minecraft-data's own
// entities.json tags e.g. zombie/skeleton/creeper as category "Hostile
// mobs") — not guessed.
function isHostileNearby(radius) {
  const b = bot;
  if (!b?.entity) return false;
  const p = b.entity.position;
  for (const e of Object.values(b.entities)) {
    if (!e || e === b.entity || e.kind !== 'Hostile mobs' || !e.position) continue;
    if (distance3(p, e.position) <= radius) return true;
  }
  return false;
}

// countMissingMentionedItems — coarse word-match heuristic against the
// reflection's free-text want_next line (DRIVES-PLAN.md §3: "spec itself
// doesn't specify a precise formula here; flagged as tune-after-pilot-data,
// not exact"). Matches real mcData item names only, so plain English words
// in want_next ("need", "more", "for") never register as items.
function countMissingMentionedItems(wantNextText, b) {
  if (!wantNextText || !mcData) return 0;
  const haveNames = new Set((b?.inventory?.items() ?? []).map((it) => it.name));
  const words = String(wantNextText).toLowerCase().split(/[^a-z_]+/).filter(Boolean);
  const seen = new Set();
  let missing = 0;
  for (const w of words) {
    if (seen.has(w) || !mcData.itemsByName?.[w]) continue;
    seen.add(w);
    if (!haveNames.has(w)) missing++;
  }
  return missing;
}

// NEEDS (DRIVES-SPEC.md §1, DRIVES-PLAN.md §3) — code only, no LLM, every
// tick. "Model never computes needs." Returns null when the bot isn't
// spawned yet (needs are undefined, not zero, until there's a live bot to
// read state from).
function computeNeeds() {
  const b = bot;
  if (!b?.entity) return null;
  const food = typeof b.food === 'number' ? b.food : 20;
  const hp = typeof b.health === 'number' ? b.health : 20;
  const isNight = b.time ? !b.time.isDay : false;

  let hunger = clamp(Math.round(((20 - food) / 20) * 100), 0, 100);
  if (food < 10) hunger = Math.min(100, hunger + 20);

  let safety = 0;
  if (isNight) safety += 40;
  if (isHostileNearby(16)) safety += 40;
  if (hp < 10) safety += 40;
  safety = Math.min(100, safety);

  const shelter = isNight && !mind.knownShelterSpot ? 80 : 0;

  const resources = Math.min(100, 25 * countMissingMentionedItems(mind.reflection?.want_next, b));

  const minutesSinceChat = mind.counters.lastCrewChatAt ? (Date.now() - mind.counters.lastCrewChatAt) / 60000 : 999;
  const social = Math.min(100, Math.round(minutesSinceChat * 5));

  const minutesSinceSuccess = mind.counters.lastDrivesSuccessAt ? (Date.now() - mind.counters.lastDrivesSuccessAt) / 60000 : 999;
  const boredom = Math.min(100, Math.round(minutesSinceSuccess * 15)); // spec's own formula, verbatim

  return { hunger, safety, shelter, resources, social, boredom };
}

// sampleNearbyBlockTypes — small-radius bot.findBlocks scan (same API shape
// skills.js's pickNextVein/mineBlocks already use), deduped, capped 8
// names. Feeds both the decision snapshot and the reflection's "things
// seen" set. Never throws: an unloaded-chunk edge case just yields [].
function sampleNearbyBlockTypes(maxDistance, count) {
  const b = bot;
  if (!b?.entity) return [];
  try {
    const positions = b.findBlocks({ point: b.entity.position, matching: () => true, maxDistance, count });
    const names = new Set();
    for (const p of positions) {
      const blk = b.blockAt(p);
      if (blk && blk.name !== 'air') names.add(blk.name);
      if (names.size >= 8) break;
    }
    return [...names];
  } catch {
    return [];
  }
}

// SIGNALS (LEAD ANNOTATION D, DRIVES-PLAN.md §7) — code only, no LLM.
// Independent of the runtime toggle/LLM layer entirely: this is backend
// inventory broadcast, never game chat, and costs no API spend either way.
function maybeSendSignal(guards) {
  if (Date.now() - lastSignalAt < guards.signalsIntervalMs) return;
  lastSignalAt = Date.now();
  const b = bot;
  if (!b?.entity) return;
  const counts = new Map();
  for (const it of b.inventory.items()) counts.set(it.name, (counts.get(it.name) ?? 0) + it.count);
  const top10 = [...counts.entries()].sort((a, c) => c[1] - a[1]).slice(0, 10).map(([n, c]) => ({ name: n, count: c }));
  driveSignals.appendSignal({ bot: name, inventory: top10 });
}
let lastSignalAt = 0;

// ensureLlmReady() — LEAD ANNOTATION F: key resolution (local.json
// deepseek.apiKey or DEEPSEEK_API_KEY), then a startup model-list
// fetch-and-match for decisionModel. Runs at most ONCE per process
// (llmReadinessPromise latch) — a no-key or model-mismatch bot never
// retries the network on its own; only a runner restart re-evaluates.
// Order matters: the no-key check is a hardcoded, pre-network short-circuit
// — verifyModel() is never even called without a key, so a garbage-key run
// and a no-key run are provably different code paths, not one swallowed
// catch-all wearing two faces (DRIVES-PLAN.md §10 Test 2 item 4).
//
// CRITICAL FIX (drive-engine audit): cache the in-flight PROMISE, not a
// boolean-checked-flag-plus-later-populated-result — see llmReadinessPromise
// above for why. computeLlmReadiness() below is the actual body; every
// caller of ensureLlmReady() gets the exact same promise instance while one
// is outstanding, so nobody can observe a "checked but not yet resolved"
// half-state.
async function computeLlmReadiness() {
  const apiKey = drivesLlm.resolveApiKey(getLocalConfig());
  if (!apiKey) {
    logDrivesOnce('drives: no DeepSeek API key configured (local.json deepseek.apiKey or DEEPSEEK_API_KEY) — engine dormant');
    return { ready: false, reason: 'no-key' };
  }
  const models = drivesConfig.getModels();
  const check = await drivesLlm.verifyModel(apiKey, models.decisionModel);
  if (!check.ok) {
    logDrivesOnce(
      `drives: configured decisionModel "${models.decisionModel}" not found in DeepSeek model list (${check.available.join(', ') || check.error || 'none returned'}) — engine dormant`
    );
    return { ready: false, reason: 'model-mismatch', available: check.available };
  }
  logLine('info', `drives: DeepSeek ready (model=${models.decisionModel})`);
  return { ready: true, apiKey };
}
function ensureLlmReady() {
  return (llmReadinessPromise ??= computeLlmReadiness());
}

// Prompt text is the chief's own wording, verbatim (DRIVES-SPEC.md §2/§4) —
// not paraphrased.
const DECISION_PROMPT =
  'Vanilla Minecraft survival bot, self-directed, no leader. Pick ONE goal from skills. Highest need first; tie ' +
  '→ not done recently. Boredom → explore new area, build, or find another bot and talk. Night without ' +
  'shelter → shelter. Hungry → food. Last goal failed → change target/place/method, never same args. ' +
  'Reply JSON only: {need, skill, args, done_check, timeout_s, why(<=5 words)}.';
const REFLECTION_PROMPT = 'Review last N minutes. Answer 3 lines: good_at / village_lacks / want_next. Terse.';

const NEED_NAMES = ['hunger', 'safety', 'shelter', 'resources', 'social', 'boredom'];

// buildStateSnapshot (DRIVES-PLAN.md §5) — pos, hp, food, time, top-10
// inventory, nearby block types, nearby crew bots, last goal+result+reason,
// reflection's 3 lines verbatim, top-2 needs+values, skill list.
function buildStateSnapshot() {
  const b = bot;
  const pos = b?.entity?.position ? { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z } : null;
  const invCounts = new Map();
  for (const it of b?.inventory?.items() ?? []) invCounts.set(it.name, (invCounts.get(it.name) ?? 0) + it.count);
  const topInventory = [...invCounts.entries()].sort((a, c) => c[1] - a[1]).slice(0, 10).map(([n, c]) => ({ name: n, count: c }));

  const nearbyBlocks = sampleNearbyBlockTypes(16, 60);
  for (const n of nearbyBlocks) recentBlockSightings.add(n);

  const nearbyBots = [];
  if (b) {
    for (const [uname, player] of Object.entries(b.players ?? {})) {
      const stripped = uname.replace(/^\[[^\]]*\]/, '');
      if (stripped === name || !OUR_BOTS.test(stripped) || !player?.entity?.position || !pos) continue;
      const d = distance3(pos, player.entity.position);
      if (d <= 24) nearbyBots.push({ name: stripped, distance: Math.round(d) });
    }
  }

  const lastGoal = mind.recentGoals[mind.recentGoals.length - 1] ?? null;
  const needs = driveState.needs ?? {};
  const topNeeds = NEED_NAMES.map((k) => [k, needs[k] ?? 0])
    .sort((a, c) => c[1] - a[1])
    .slice(0, 2)
    .map(([need, value]) => ({ need, value }));

  return {
    pos,
    hp: typeof b?.health === 'number' ? b.health : null,
    food: typeof b?.food === 'number' ? b.food : null,
    time: b?.time ? { isDay: b.time.isDay, timeOfDay: b.time.timeOfDay } : null,
    inventory: topInventory,
    nearbyBlocks,
    nearbyBots,
    lastGoal,
    reflection: { good_at: mind.reflection.good_at, village_lacks: mind.reflection.village_lacks, want_next: mind.reflection.want_next },
    topNeeds,
    skills: drivesSkillNames(),
    failedArgsRecent: mind.failedArgsRing.slice(-5),
  };
}

// validateDecisionReply — JSON.parse in try/catch (a parse failure is an
// "invalid reply", never partial-eval'd), then need/skill/args/done_check/
// timeout_s/why validated against the real skill surface + the done_check
// whitelist DSL (annotation H). Never eval()s anything.
function validateDecisionReply(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `reply is not valid JSON: ${err.message}` };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'reply is not a JSON object' };
  if (!NEED_NAMES.includes(obj.need)) return { ok: false, error: `"need" must be one of ${NEED_NAMES.join('/')}` };
  const skillNames = drivesSkillNames();
  if (!skillNames.includes(obj.skill)) return { ok: false, error: `"skill" must be one of ${skillNames.join('/')}` };
  const skillDef = getDriveSkill(obj.skill);
  let args;
  try {
    args = skillDef.validateArgs(obj.args ?? {});
  } catch (err) {
    return { ok: false, error: `args: ${err.message}` };
  }
  try {
    drivesDsl.validateDoneCheck(obj.done_check);
  } catch (err) {
    return { ok: false, error: `done_check: ${err.message}` };
  }
  if (!Number.isInteger(obj.timeout_s) || obj.timeout_s < 5 || obj.timeout_s > 1800) {
    return { ok: false, error: '"timeout_s" must be an integer in [5,1800]' };
  }
  if (typeof obj.why !== 'string' || !obj.why) return { ok: false, error: '"why" must be a non-empty string' };
  return {
    ok: true,
    value: { need: obj.need, skill: obj.skill, args, done_check: obj.done_check, timeout_s: obj.timeout_s, why: obj.why.slice(0, 120) },
  };
}

// codeFallbackGoal (DRIVES-SPEC.md §3, "cheapest safe skill: gather nearest
// wood/food") — reached only when the model's reply is invalid TWICE (see
// runDecisionCycle) with no further model call. hunger top-need -> collect
// nearby food drops; any other top-need -> chop (cheapest safe default).
function codeFallbackGoal() {
  const needs = driveState.needs ?? {};
  const topNeed = NEED_NAMES.map((k) => [k, needs[k] ?? 0]).sort((a, c) => c[1] - a[1])[0]?.[0] ?? 'boredom';
  if (topNeed === 'hunger') {
    return { need: 'hunger', skill: 'collect', args: { radius: 16 }, done_check: { food_min: 15 }, timeout_s: 60, why: 'code fallback: hunger' };
  }
  return {
    need: topNeed,
    skill: 'chop',
    args: { count: 4 },
    done_check: { has_item: { name: 'oak_log', count: 1 } },
    timeout_s: 120,
    why: 'code fallback: cheapest safe skill',
  };
}

// runDriveSkill — dispatches through the SAME functions the real HTTP
// taskRoutes handlers call (annotation K: no new movement/task primitive).
// Deliberately not routed back through HTTP-to-self; this runs in-process,
// startTask()'s own mutex/wedge-watchdog/panic-reflex/poison-tracking apply
// exactly as they do to a driver's own call, "for free".
async function runDriveSkill(goal, ctx) {
  const b = requireBot();
  switch (goal.skill) {
    case 'goto': {
      const { x, y, z, range = 1 } = goal.args;
      ctx.setTargetPos({ x, y, z });
      return movement.goTo(b, { x, y, z, range, timeoutMs: goal.timeout_s * 1000, engine: defaultEngine }, ctx);
    }
    case 'chop':
      return skills.chopTrees(b, { count: goal.args.count ?? 8, maxDistance: goal.args.maxDistance ?? 48 }, ctx);
    case 'mine':
      return skills.mineBlocks(b, { block: goal.args.block, count: goal.args.count ?? 8, maxDistance: goal.args.maxDistance ?? 48 }, ctx);
    case 'collect':
      return skills.collectDrops(b, { radius: goal.args.radius ?? 16 }, ctx);
    case 'hunt':
      return skills.huntAnimals(b, { mob: goal.args.mob, count: goal.args.count ?? 1 }, ctx);
    case 'craft':
      return craftItem(b, goal.args.item, goal.args.amount ?? 1, ctx);
    case 'smelt':
      return skills.smeltItems(b, { input: goal.args.input, fuel: goal.args.fuel, count: goal.args.count ?? 1 }, ctx);
    case 'deposit':
      if (Number.isFinite(goal.args.x)) ctx.setTargetPos({ x: goal.args.x, y: goal.args.y, z: goal.args.z });
      return skills.depositToChest(b, { pos: { x: goal.args.x, y: goal.args.y, z: goal.args.z }, items: goal.args.items }, ctx);
    case 'staircase':
      return skills.buildStaircase(b, { toY: goal.args.toY, direction: goal.args.direction }, ctx);
    case 'branchmine':
      return skills.branchMine(
        b,
        { y: goal.args.y, trunkLength: goal.args.trunkLength, branches: goal.args.branches, branchLength: goal.args.branchLength, direction: goal.args.direction },
        ctx
      );
    case 'seal':
      return skills.emergencySeal(b, ctx);
    case 'talk':
      // CRITICAL FIX (drive-engine audit): smartChat() only ever sends REAL
      // game chat for text starting with "!" (see smartChat above) — plain
      // text silently falls through to announce('status', ...), i.e.
      // Discord/log only. The LLM never emits that prefix on its own (no
      // prompt tells it to), so drive-issued talk goals were dead on
      // arrival for real chat and no other bot's markCrewChatHeard could
      // ever fire from them. Force the "!" ourselves — annotation D's
      // whole point is that this needs to be REAL bot-to-bot chat.
      await smartChat('!' + String(goal.args.message));
      return { said: goal.args.message };
    default:
      throw new Error(`drives: no executor wired for skill "${goal.skill}"`);
  }
}

// buildDoneCheckReading — plain snapshot handed to drives-dsl's pure
// evalDoneCheck(), decoupling that module from mineflayer entirely.
function buildDoneCheckReading(task) {
  const b = bot;
  const pos = b?.entity?.position ? { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z } : null;
  const invCounts = {};
  for (const it of b?.inventory?.items() ?? []) invCounts[it.name] = (invCounts[it.name] ?? 0) + it.count;
  return {
    pos,
    hp: typeof b?.health === 'number' ? b.health : null,
    food: typeof b?.food === 'number' ? b.food : null,
    invCounts,
    taskStartedAt: task.startedAt ? Date.parse(task.startedAt) : null,
  };
}

function onGoalOutcome(goal, outcome, detail) {
  if (outcome === 'success') {
    mind.counters.consecutiveFails = 0;
    mind.counters.lastDrivesSuccessAt = Date.now();
    drivesMemory.appendRecentGoal(mind, { skill: goal.skill, args: goal.args, result: 'success', detail });
    logLine('info', `drives: goal ${goal.skill} succeeded (${detail})`);
  } else {
    mind.counters.consecutiveFails = (mind.counters.consecutiveFails ?? 0) + 1;
    drivesMemory.appendFailedArgs(mind, { skill: goal.skill, args: goal.args });
    drivesMemory.appendRecentGoal(mind, { skill: goal.skill, args: goal.args, result: 'fail', detail });
    logLine('warn', `drives: goal ${goal.skill} failed (${detail})`);
  }
  drivesMemory.saveMind(name, mind);
  // "Never sleep on fail" (DRIVES-SPEC.md §3) — no designed extra wait is
  // added here; the very next 5s tick re-evaluates the trigger fresh, still
  // bounded by guard 4's own min-call-interval (DRIVES-PLAN.md §5 point 4's
  // reconciliation note — FLAGGED as the resolution of an otherwise-
  // contradictory pair between spec text and annotation G).
}

// onGoalSettled — the task ended "out from under" watchGoal's own poll (by
// natural completion, a driver preemption, panic reflex, or /stop) rather
// than by watchGoal's own done_check/timeout branches (which report their
// own outcome inline and never reach here — see watchGoal below).
function onGoalSettled(goal, task) {
  if (task.state === 'failed') {
    onGoalOutcome(goal, 'fail', task.result?.error ?? 'unknown error');
    return;
  }
  if (task.state === 'done' && task.result?.cancelled) {
    // Driver preemption (annotation A: "drive goal aborts cleanly, driver
    // wins"), panic reflex, or a plain /stop — the bot had a real reason to
    // stop that has nothing to do with whether THIS goal was any good.
    // Neutral: no penalty, no success credit either.
    logLine('info', `drives: goal ${goal.skill} interrupted (${task.result.reason}) — no penalty`);
    return;
  }
  if (task.state === 'done') {
    // Natural completion — "logged as success/fail per its own result
    // regardless of done_check" (DRIVES-PLAN.md §5): a skill finishing
    // without technically satisfying done_check is not force-failed.
    onGoalOutcome(goal, 'success', 'natural completion');
  }
}

// watchGoal — polls done_check every ~2.5s against a fresh reading;
// whichever fires first (done_check true, the skill's own promise
// resolving, or timeout_s elapsing) ends the cycle.
async function watchGoal(task, goal, startedAt) {
  const timeoutAt = startedAt + goal.timeout_s * 1000;
  for (;;) {
    await sleep(2500);
    if (state.currentTask !== task || task.state !== 'running') {
      onGoalSettled(goal, task);
      return;
    }
    let done = false;
    try {
      done = drivesDsl.evalDoneCheck(goal.done_check, buildDoneCheckReading(task));
    } catch {
      done = false;
    }
    if (done) {
      await cancelCurrentTask('drives: done_check satisfied');
      onGoalOutcome(goal, 'success', 'done_check satisfied');
      return;
    }
    if (Date.now() >= timeoutAt) {
      await cancelCurrentTask(`drives: timeout_s (${goal.timeout_s}s) elapsed`);
      onGoalOutcome(goal, 'fail', 'timeout');
      return;
    }
  }
}

// dispatchGoal — startTask(goal.skill, fn, {source:'drives'}), the SAME
// in-process call every taskRoutes handler makes (annotation K). A 'busy'
// throw here means a driver grabbed the mutex between the trigger check and
// this call — fine, the next 5s tick re-checks the trigger fresh.
async function dispatchGoal(goal) {
  let task;
  try {
    task = await startTask(goal.skill, async (t, ctx) => runDriveSkill(goal, ctx), { source: 'drives' });
  } catch (err) {
    if (err?.busy) return;
    logLine('error', `drives: failed to start goal ${goal.skill}: ${err?.message ?? err}`);
    return;
  }
  driveState.lastDecision = { ts: new Date().toISOString(), need: goal.need, skill: goal.skill, why: goal.why };
  pushEvent('drives', `goal ${goal.skill} (need=${goal.need}): ${goal.why}`);
  await watchGoal(task, goal, Date.now());
}

// runDecisionCycle (DRIVES-PLAN.md §5) — model select (decisionModel, or
// escalationModel once consecutiveFails >= escalateAfterFails), build
// snapshot, call, validate; invalid -> re-prompt once with the specific
// error; still invalid -> code fallback, no further model call. `ready` is
// already-verified (see maybeFireDecision, which checks readiness BEFORE
// touching the cost guards/queue at all — see its own comment for why).
async function runDecisionCycle(guards, ready) {
  const models = drivesConfig.getModels();
  const useEscalation = (mind.counters.consecutiveFails ?? 0) >= guards.escalateAfterFails;
  const model = useEscalation ? models.escalationModel : models.decisionModel;

  const snapshot = buildStateSnapshot();
  const first = await drivesLlm.decisionCall(ready.apiKey, model, DECISION_PROMPT, snapshot);
  let parsed = first.ok ? validateDecisionReply(first.text) : { ok: false, error: first.error };

  if (!parsed.ok) {
    const retryPrompt = `${DECISION_PROMPT}\nPrevious reply was invalid: ${parsed.error}. Reply JSON only, fixing that problem.`;
    const retry = await drivesLlm.decisionCall(ready.apiKey, model, retryPrompt, snapshot);
    parsed = retry.ok ? validateDecisionReply(retry.text) : { ok: false, error: retry.error };
  }

  let goal;
  if (parsed.ok) {
    goal = parsed.value;
  } else {
    goal = codeFallbackGoal();
    logLine('warn', `drives: invalid model reply twice (${parsed.error}) — code fallback: ${goal.skill}`);
  }

  await dispatchGoal(goal);
}

// maybeFireDecision (DRIVES-PLAN.md §5 guard 4) — readiness checked FIRST
// (cheap once cached — a dormant bot must touch neither the per-bot cost
// counters nor the cross-process queue dir ever again after the one-time
// dormancy determination, not just skip the network call); THEN min-
// interval + hourly cap (drives-queue.js, in-process per bot), a global
// in-flight slot (drives-queue.js, cross-process file-lock) with recordCall()
// stamped the instant the slot is actually granted (so the min-interval
// guard genuinely throttles real attempts — recordCall() living any later,
// e.g. only after a successful call, would let the min-interval check keep
// reading a stale lastCallAt and firing every tick forever). Kill-switch is
// re-checked FRESH here (not cached from tickDrives' outer check) so a
// toggle mid-tick is always honored.
async function maybeFireDecision(guards) {
  if (decisionInFlight) return;
  if (!drivesConfig.isGlobalOn()) return;
  const ready = await ensureLlmReady();
  if (!ready.ready) return; // dormant — already logged once by ensureLlmReady; zero queue/counter churn from here on
  const cost = drivesQueue.canCallNow(name, guards);
  if (!cost.ok) return; // too soon / hourly cap — genuinely wait, no forced retry (see runDecisionCycle's own comment)
  const release = drivesQueue.acquireSlot(guards.globalInFlightCap);
  if (!release) return; // global queue full this instant — retry next tick
  decisionInFlight = true;
  drivesQueue.recordCall(name);
  try {
    await runDecisionCycle(guards, ready);
  } catch (err) {
    logLine('error', `drives: decision cycle error: ${err?.stack ?? err}`);
  } finally {
    decisionInFlight = false;
    release();
  }
}

// REFLECTION SCHEDULER (DRIVES-PLAN.md §6) — per-bot interval randomized
// once inside [reflectionIntervalMinMs, reflectionIntervalMaxMs] plus a
// deterministic phase offset (hash(botName) % interval) so the pilot's two
// bots don't fire together.
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function ensureReflectionSchedule(guards) {
  if (reflectionState) return reflectionState;
  const span = Math.max(1, guards.reflectionIntervalMaxMs - guards.reflectionIntervalMinMs);
  const intervalMs = guards.reflectionIntervalMinMs + (hashString(name) % span);
  const phaseOffset = hashString(name) % intervalMs;
  reflectionState = { intervalMs, nextAt: Date.now() + phaseOffset };
  return reflectionState;
}

function parseReflectionReply(text) {
  const out = { good_at: null, village_lacks: null, want_next: null };
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\w[\w_]*)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key in out) out[key] = m[2].trim();
  }
  return out;
}

async function runReflectionCycle(guards) {
  const ready = await ensureLlmReady();
  if (!ready.ready) return; // dormant — already logged once by ensureLlmReady
  const models = drivesConfig.getModels();
  const since = reflectionWindowStart;
  const goalsSince = mind.recentGoals.filter((g) => Date.parse(g.ts) >= since);
  const chatsSince = eventsBuf.filter((e) => e.type === 'chat' && Date.parse(e.ts) >= since).map((e) => e.msg).slice(-20);
  const peer = driveSignals.readLatestPerBot();
  const input = {
    goals: goalsSince.map((g) => ({ skill: g.skill, result: g.result })),
    thingsSeen: [...recentBlockSightings].slice(0, 20),
    chats: chatsSince,
    peerInventories: Object.fromEntries(Object.entries(peer.byBot).map(([botName, e]) => [botName, e.inventory])),
  };
  const resp = await drivesLlm.reflectionCall(ready.apiKey, models.reflectionModel, REFLECTION_PROMPT, input);
  reflectionWindowStart = Date.now();
  recentBlockSightings.clear();
  if (!resp.ok) {
    logLine('warn', `drives: reflection call failed: ${resp.error}`);
    return;
  }
  drivesMemory.setReflection(mind, parseReflectionReply(resp.text));
  drivesMemory.saveMind(name, mind);
  logLine('info', `drives: reflection stored (good_at=${mind.reflection.good_at ?? '?'})`);
}

function maybeFireReflection(guards) {
  const sched = ensureReflectionSchedule(guards);
  if (Date.now() < sched.nextAt) return;
  sched.nextAt = Date.now() + sched.intervalMs;
  if (reflectionInFlight) return;
  reflectionInFlight = true;
  runReflectionCycle(guards)
    .catch((err) => logLine('error', `drives: reflection cycle error: ${err?.stack ?? err}`))
    .finally(() => {
      reflectionInFlight = false;
    });
}

// tickDrives (DRIVES-PLAN.md §5 trigger, annotation G) — wired into the
// existing IDLE_GUARD_TICK_MS setInterval above, no new timer.
function tickDrives() {
  const globalOn = drivesConfig.isGlobalOn();
  if (!globalOn) {
    logDrivesOnce('drives: disabled (global=false)');
    return;
  }
  const enrolled = drivesConfig.isEnrolled(name);
  if (!enrolled) {
    logDrivesOnce('drives: disabled (not enrolled)');
    return;
  }

  const guards = drivesConfig.getGuards();

  // NEEDS + SIGNALS — code only, run every tick regardless of the LLM
  // layer or the runtime toggle (DRIVES-PLAN.md §10 Test 2 item 3: proves
  // this layer is genuinely independent of DeepSeek being configured at
  // all; annotation D: signals are "code, no LLM").
  driveState.needs = computeNeeds();
  maybeSendSignal(guards);

  if (!drivesRuntimeOn) return; // driver paused via POST /drives {on:false} — needs/signals above still ran

  maybeFireReflection(guards);

  // TRIGGER (annotation G): idle (no running task) AND driver-quiet.
  const isIdle = !state.currentTask || state.currentTask.state !== 'running';
  if (!isIdle) return;
  if (Date.now() - lastCommandAt < guards.driverQuietMs) return;

  maybeFireDecision(guards).catch((err) => logLine('error', `drives: maybeFireDecision error: ${err?.stack ?? err}`));
}

// ---------------------------------------------------------------------------
// task-specific helpers not delegated to skills.js
// ---------------------------------------------------------------------------

async function followPlayer(b, playerName, range, ctx) {
  const findEntity = () => {
    const p = b.players[playerName];
    return p && p.entity ? p.entity : null;
  };

  let entity = findEntity();
  let waited = 0;
  while (!entity && waited < 10000) {
    await sleep(500);
    waited += 500;
    entity = findEntity();
  }
  if (!entity) throw new Error(`followPlayer: player "${playerName}" not found or not in view`);

  ctx.setDetail(`following ${playerName}`);
  b.pathfinder.setGoal(new goals.GoalFollow(entity, range), true);
  try {
    while (!ctx.isCancelled()) {
      await sleep(1000);
      if (!findEntity()) {
        ctx.log('warn', `followPlayer: lost sight of ${playerName}`);
        break;
      }
    }
  } finally {
    try {
      b.pathfinder.setGoal(null);
    } catch {
      // ignore
    }
  }
  return { followed: playerName, range };
}

// craftItem — rewritten resolution after a field bug where recipesFor()
// silently handed back a recipe for the WRONG item entirely: a birch_planks
// request crafted torches and burned 19 logs while reporting success; a
// torch request ate ingredients and produced 0. Fix has three parts:
//   1. Look the item id up via bot.registry (the same minecraft-data-backed
//      registry bot.recipesFor()/bot.craft() resolve recipes against
//      internally) rather than the separately-instantiated module-level
//      mcData — using two different registry instances for the id lookup
//      and the actual craft risks an id-space mismatch.
//   2. Never trust recipesFor()'s own filtering: assert recipe.result.id
//      matches the requested item's id ourselves before a recipe is ever
//      handed to bot.craft().
//   3. INVENTORY-DIFF VERIFY: bot.craft()'s resolved promise is not proof of
//      anything by itself (see the field bug above). Only a measured
//      increase in the requested item's own inventory count counts as a
//      real success — no diff means a real, thrown error, never a silent
//      "ok".
async function craftItem(b, itemName, amount, ctx) {
  const registry = b.registry ?? mcData;
  const itemDef = registry?.itemsByName?.[itemName];
  if (!itemDef) throw new Error(`craftItem: unknown item "${itemName}"`);

  const countOf = (nm) => b.inventory.items().filter((it) => it.name === nm).reduce((sum, it) => sum + it.count, 0);
  const before = countOf(itemName);

  const exactRecipesFor = (table) =>
    b.recipesFor(itemDef.id, null, 1, table).filter((r) => r.result && r.result.id === itemDef.id);

  let table = null;
  let tableBlock = null;
  let recipes = exactRecipesFor(null);
  if (recipes.length === 0) {
    table = b.findBlock({
      matching: (blk) => blk.name === 'crafting_table',
      maxDistance: 16,
      point: b.entity.position,
    });
    if (!table) {
      throw new Error(`craftItem: no hand recipe for "${itemName}" and no crafting table within 16 blocks`);
    }
    ctx.setDetail(`going to crafting table for ${itemName}`);
    await skills.gotoLoop(
      b,
      new goals.GoalGetToBlock(table.position.x, table.position.y, table.position.z),
      { timeoutMs: 30000, maxAttempts: 5 },
      ctx
    );
    tableBlock = b.blockAt(table.position);
    recipes = exactRecipesFor(tableBlock);
    if (recipes.length === 0) {
      throw new Error(`craftItem: no recipe for "${itemName}" even with a crafting table (missing ingredients?)`);
    }
  }

  // (FIELD BUG, Thak 2026-09-01 — FEEDBACK "goto false-reached + bot.craft
  // (recipe, N>1) only does 1 iteration") bot.craft(recipe, N, table) with
  // N>1 crafted exactly one batch (correct delta) then threw "missing
  // ingredient" on the very next internal iteration despite plenty of both
  // materials still in inventory (confirmed 2x, different batch sizes,
  // fresh inventory read same tick). Proven workaround: loop single
  // (amount=1) craft calls, re-deriving the recipe fresh via
  // exactRecipesFor() before each one instead of reusing the recipe object
  // or handing bot.craft the count param — ran clean 20+ iterations
  // straight for Thak (100 torches). table/tableBlock are resolved once
  // above (position doesn't move mid-craft); only the recipe object itself
  // gets re-derived per iteration.
  ctx.setDetail(`crafting ${amount}x ${itemName}`);
  for (let i = 0; i < amount; i++) {
    const freshRecipes = exactRecipesFor(tableBlock);
    if (freshRecipes.length === 0) {
      throw new Error(`craftItem: ran out of ingredients for "${itemName}" after ${i}/${amount} crafted`);
    }
    await b.craft(freshRecipes[0], 1, table || undefined);
  }

  const after = countOf(itemName);
  if (after <= before) {
    throw new Error(
      `craftItem: craft() reported success but inventory shows no increase in "${itemName}" (before=${before}, after=${after}) — treating as a failed craft, not trusting the resolved promise`
    );
  }

  return { item: itemName, amount, usedTable: !!table, before, after, gained: after - before };
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runEvalCode(b, mc, sk, log, code) {
  const fn = new AsyncFunction('bot', 'mcData', 'skills', 'log', code);
  const result = await fn(b, mc, sk, log);
  if (result === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(result));
  } catch (err) {
    throw new Error(`eval result is not JSON-safe: ${err.message}`);
  }
}

function waitForTaskSettled(task) {
  return new Promise((resolve) => {
    const check = () => {
      if (task.state !== 'running') return resolve();
      setTimeout(check, 100);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function buildStatus() {
  const b = bot;
  const spawned = !!(b && b.entity);
  return {
    name,
    connected: !!state.connected,
    pos: spawned ? { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z } : null,
    health: spawned ? b.health : null,
    food: spawned ? b.food : null,
    gamemode: b?.game ? b.game.gameMode : null,
    inventory: spawned ? summarizeInventory(b) : [],
    // G1 (PANEL_V3_SPEC.md) — bot.heldItem is mineflayer's own live,
    // authoritative getter for "what's actually equipped right now" (not
    // a heuristic guess off the inventory list — a bot can carry a
    // pickaxe AND an axe AND a sword at once, only one is equipped).
    // durability mirrors the same {used,max} shape summarizeInventory
    // attaches below; undefined/omitted for non-durable items (food,
    // blocks, materials) rather than a fake 0/0.
    heldItem:
      spawned && b.heldItem
        ? {
            name: b.heldItem.name,
            count: b.heldItem.count,
            durability: b.heldItem.maxDurability
              ? { used: b.heldItem.durabilityUsed ?? 0, max: b.heldItem.maxDurability }
              : undefined,
          }
        : null,
    currentTask: taskToJSON(state.currentTask),
    // Per-task, not global: reflects the CURRENT task's own failure (if it
    // failed) and nothing else — a fresh task starting always reads back
    // null here immediately, even if some earlier unrelated task or a bare
    // connection blip had set state.lastError. STATUS-HOLD (see
    // markTaskFinished) means this still holds the last task's error after
    // it's done, same as currentTask itself, until the next task replaces it.
    lastError: state.currentTask?.result?.error ?? null,
    idleGuard: idleGuardEnabled,
    // Cheap booleans only — full detail (needs, last decision/reflection,
    // calls-this-hour, queue depth) lives on GET /drives, not bloating
    // every /status poll (DRIVES-PLAN.md §1.7). `on` mirrors the same
    // three-part enrolled+global+runtime check drives itself uses to decide
    // whether it owns this bot's idle right now (see drivesOwnsIdle()).
    drives: { enrolled: drivesConfig.isEnrolled(name), on: drivesOwnsIdle(name) },
    engine: defaultEngine,
    deathCount: state.deathCount,
    lastDeath: state.lastDeath,
    poisonedTargets: poisonedTargetsCount(),
  };
}

// G1 (PANEL_V3_SPEC.md) — attaches a `durability` object to any item that
// has one (prismarine-item's .durabilityUsed/.maxDurability, confirmed
// against node_modules/prismarine-item — tools/weapons/armor; food/blocks/
// materials simply don't have maxDurability, so they stay plain
// {name,count}, unchanged/backward-compatible). Durability doesn't sum
// meaningfully across a merged stack (each tool wears independently), so
// this surfaces the first instance's wear per name — exact in practice
// since tools don't stack past 1 in vanilla anyway.
function summarizeInventory(b) {
  const map = new Map();
  for (const it of b.inventory.items()) {
    const entry = map.get(it.name) || { name: it.name, count: 0 };
    entry.count += it.count;
    if (it.maxDurability && entry.durability === undefined) {
      entry.durability = { used: it.durabilityUsed ?? 0, max: it.maxDurability };
    }
    map.set(it.name, entry);
  }
  return Array.from(map.values());
}

// Task-producing endpoints share the same shape: validate + start a task,
// ack immediately with the task id, let the caller poll /status.
function taskEndpoint(kind, runner) {
  return async (req, res) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    // Disconnect-abort: every task-starting endpoint refuses outright while
    // offline (status/relog/events/stop stay reachable — see handleRequest).
    if (!state.connected) {
      return sendJson(res, 503, { error: 'disconnected' });
    }
    try {
      const task = await startTask(
        kind,
        async (task, ctx) => {
          const b = requireBot();
          return runner(b, body, ctx);
        },
        // Optional body.source: who is commanding this bot right now
        // ("OokDriver", "orchestrator", "bench"). Sanitized in startTask;
        // absent means a plain HTTP caller that did not identify itself.
        { force: !!body.force, source: body.source }
      );
      sendJson(res, 200, { ok: true, task: taskToJSON(task) });
    } catch (err) {
      if (err?.busy) return sendJson(res, 409, { error: 'busy', currentTask: taskToJSON(state.currentTask) });
      sendJson(res, 400, { error: err?.message ?? String(err) });
    }
  };
}

function requireNumber(body, field) {
  if (typeof body[field] !== 'number') throw new Error(`requires numeric "${field}"`);
}

// (FIELD GAP, Durk 2026-09-01 — FEEDBACK "HTTP /withdraw and /deposit take an
// `items` name list but no count — they always grab/dump the ENTIRE matching
// stack", which cost chest A's whole wood buffer and forced drivers into
// hand-rolled /eval chest.withdraw calls.) skills.js's normalizeItemSpecs
// already understands both shapes; this is the endpoint-side gate so a
// malformed body fails the task with a named, readable lastError (same place
// requireNumber's errors surface — inside the task body, per taskEndpoint)
// instead of reaching win.withdraw()/win.deposit() as a NaN count.
//   items: ["oak_planks", ...]                → whole stack (unchanged)
//   items: [{name:"oak_planks", count:16}, …] → exact count
// Mixed arrays are fine. Returns the array to hand to skills.js.
function validateItemsBody(items, label) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`${label} requires a non-empty "items" array`);
  }
  return items.map((it) => {
    if (typeof it === 'string') {
      if (!it) throw new Error(`${label}: item names must be non-empty strings`);
      return it;
    }
    if (!it || typeof it !== 'object' || typeof it.name !== 'string' || !it.name) {
      throw new Error(`${label}: each item must be a name string or {name, count}`);
    }
    if (it.count === undefined || it.count === null) return { name: it.name };
    // Gate on the FLOORED value, not the raw one: count 0.9 passes a bare
    // "> 0" test and then floors to 0, which is a silent no-op withdraw the
    // bot only discovers after a 30s walk to the chest — the failure then
    // surfaces far from its cause. Reject anything that cannot move at
    // least one item, at the endpoint, before a task is even started.
    if (typeof it.count !== 'number' || !Number.isFinite(it.count) || Math.floor(it.count) < 1) {
      throw new Error(`${label}: "count" for ${it.name} must be a number >= 1 (got ${JSON.stringify(it.count)})`);
    }
    return { name: it.name, count: Math.floor(it.count) };
  });
}

// (FIELD GAP, UngaBunga 2026-09-01 — FEEDBACK "pf engine 'goal changed'
// false-fail on short hops": /deposit "always uses pf internally, no engine
// param", so a bot whose pf was failing a 1-2 block hop had to bypass the
// endpoint entirely and drive bot.openChest by hand through /eval.) Same
// auto|ash|pf vocabulary as /goto; omitted means the chest goto keeps its
// original pathfinder path, so no existing caller changes behavior. Note
// this deliberately does NOT fall back to defaultEngine — the historical
// behavior of these two endpoints is pf-only, and silently switching every
// fleet deposit to the process-wide default is not this fix's job.
const MOVEMENT_ENGINES = new Set(['auto', 'ash', 'pf']);

function validateEngineBody(body, label) {
  if (body.engine === undefined || body.engine === null) return undefined;
  if (!MOVEMENT_ENGINES.has(body.engine)) {
    throw new Error(`${label}: "engine" must be one of auto|ash|pf (got ${JSON.stringify(body.engine)})`);
  }
  return body.engine;
}

const taskRoutes = {
  '/goto': taskEndpoint('goto', async (b, body, ctx) => {
    requireNumber(body, 'x');
    requireNumber(body, 'y');
    requireNumber(body, 'z');
    const { x, y, z, range = 1, timeoutMs = 45000 } = body;
    const engine = body.engine ?? defaultEngine;
    // Register this as the task's current target — if the bot dies mid-goto,
    // the death handler poisons this exact spot.
    ctx.setTargetPos({ x, y, z });
    const result = await movement.goTo(b, { x, y, z, range, timeoutMs, engine }, ctx);
    return { x, y, z, range, reached: true, engine: result.engine };
  }),
  '/chop': taskEndpoint('chop', async (b, body, ctx) =>
    skills.chopTrees(b, { count: body.count ?? 8, maxDistance: body.maxDistance ?? 48 }, ctx)
  ),
  '/mine': taskEndpoint('mine', async (b, body, ctx) => {
    if (!body.block) throw new Error('/mine requires "block"');
    // zone (optional): restricts candidate selection to one named
    // zones.json zone, so a wide maxDistance can't wander into a
    // different (legit, but not this mission's) zone. See skills.js
    // mineBlocks' own ZONE FILTER comment.
    return skills.mineBlocks(
      b,
      { block: body.block, count: body.count ?? 8, maxDistance: body.maxDistance ?? 48, zone: body.zone },
      ctx
    );
  }),
  '/collect': taskEndpoint('collect', async (b, body, ctx) => skills.collectDrops(b, { radius: body.radius ?? 16 }, ctx)),
  '/hunt': taskEndpoint('hunt', async (b, body, ctx) => {
    if (!body.mob) throw new Error('/hunt requires "mob"');
    return skills.huntAnimals(b, { mob: body.mob, count: body.count ?? 1 }, ctx);
  }),
  '/follow': taskEndpoint('follow', async (b, body, ctx) => {
    if (!body.player) throw new Error('/follow requires "player"');
    return followPlayer(b, body.player, body.range ?? 3, ctx);
  }),
  '/deposit': taskEndpoint('deposit', async (b, body, ctx) => {
    requireNumber(body, 'x');
    requireNumber(body, 'y');
    requireNumber(body, 'z');
    // "items" stays OPTIONAL here — omitting it (or sending an empty array,
    // which depositToChest has always read the same way) keeps the original
    // deposit-everything-non-tool behavior.
    const noItems = body.items === undefined || body.items === null || (Array.isArray(body.items) && body.items.length === 0);
    const items = noItems ? undefined : validateItemsBody(body.items, '/deposit');
    const engine = validateEngineBody(body, '/deposit');
    return skills.depositToChest(b, { pos: { x: body.x, y: body.y, z: body.z }, items, engine }, ctx);
  }),
  '/withdraw': taskEndpoint('withdraw', async (b, body, ctx) => {
    requireNumber(body, 'x');
    requireNumber(body, 'y');
    requireNumber(body, 'z');
    const items = validateItemsBody(body.items, '/withdraw');
    const engine = validateEngineBody(body, '/withdraw');
    return skills.withdrawFromChest(b, { pos: { x: body.x, y: body.y, z: body.z }, items, engine }, ctx);
  }),
  '/craft': taskEndpoint('craft', async (b, body, ctx) => {
    if (!body.item) throw new Error('/craft requires "item"');
    return craftItem(b, body.item, body.amount ?? 1, ctx);
  }),
  '/smelt': taskEndpoint('smelt', async (b, body, ctx) => {
    if (!body.input) throw new Error('/smelt requires "input"');
    return skills.smeltItems(
      b,
      { input: body.input, fuel: body.fuel, count: body.count ?? 1, timeoutMs: body.timeoutMs },
      ctx
    );
  }),
  '/recover': taskEndpoint('recover', async (b, body, ctx) => {
    // deathPos comes from the runner's own state.lastDeath (set by the
    // b.on('death') handler above) — not the request body. skills.recoverKit
    // itself calls ctx.setTargetPos(deathPos) so a second death at the same
    // recovery spot gets poisoned too. deathTs is forwarded too so
    // recoverKit's own despawn gate (skip if the death is >4min old) has
    // something to check against.
    const deathPos = state.lastDeath?.pos;
    if (!deathPos) throw new Error('/recover: no recorded death position (bot has not died this session)');
    return skills.recoverKit(b, { deathPos, deathTs: state.lastDeath?.ts, timeBudgetMs: body.timeBudgetMs }, ctx);
  }),
  '/staircase': taskEndpoint('staircase', async (b, body, ctx) => {
    requireNumber(body, 'toY');
    return skills.buildStaircase(b, { toY: body.toY, direction: body.direction }, ctx);
  }),
  '/branchmine': taskEndpoint('branchmine', async (b, body, ctx) => {
    requireNumber(body, 'y');
    return skills.branchMine(
      b,
      {
        y: body.y,
        trunkLength: body.trunkLength,
        branches: body.branches,
        branchLength: body.branchLength,
        direction: body.direction,
      },
      ctx
    );
  }),
  // POST /ensureTool {kind: "pickaxe"|"axe"} — thin task wrapper around
  // skills.ensureTool (inventory -> depot chest -> craft chain, see its own
  // header in skills.js), same mutex/force/source/taskToJSON wiring every
  // other row here gets from taskEndpoint. Added 2026-09-01 so the goal
  // engine (cave/overseer.mjs, GOAL ENGINE block) has an endpoint to fire
  // for its "re-kit" pseudo-goal — goals.json's `kind` field doubles as the
  // endpoint name there (ep = '/' + kind), so a goal needs kind:"ensureTool"
  // to reach this row; see goals.json's "pickaxe-rekit" seed entry.
  '/ensureTool': taskEndpoint('ensureTool', async (b, body, ctx) => {
    if (body.kind !== 'pickaxe' && body.kind !== 'axe') {
      throw new Error('/ensureTool requires "kind" to be "pickaxe" or "axe"');
    }
    const engine = validateEngineBody(body, '/ensureTool');
    return skills.ensureTool(b, { kind: body.kind, engine }, ctx);
  }),
  // POST /seal — DRIVES-PLAN.md §1.9: thin wrapper around the already
  // exported skills.emergencySeal, same shape/precedent as /ensureTool
  // directly above. Closes the "shelter" need's only real gap: no
  // shelter-BUILDING skill exists in skills.js, but the emergency-seal-
  // in-place skill already does and only lacked an HTTP door. No new skill
  // invented (annotation J).
  '/seal': taskEndpoint('seal', async (b, body, ctx) => skills.emergencySeal(b, ctx)),
};

async function handleChat(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (!body.message) return sendJson(res, 400, { error: '/chat requires "message"' });
  const style = body.style ?? 'talk';
  if (!['talk', 'status', 'fancy', 'rainbow'].includes(style)) {
    return sendJson(res, 400, { error: '/chat "style" must be one of talk|status|fancy|rainbow' });
  }
  try {
    const b = requireBot();
    if (style === 'talk') {
      // 'talk' (the default) now auto-classifies via smartChat — protocol
      // ledger lines and "!"-prefixed announcements still land as real white
      // chat, everything else routes to grey narration. Ask for "status"
      // explicitly to force grey regardless of content.
      await smartChat(String(body.message));
    } else {
      await announce(style, String(body.message));
    }
    pushEvent('chat_sent', String(body.message));
    sendJson(res, 200, { ok: true, style });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleAutoEat(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const on = !!body.on;
  const available = !!(bot && bot.autoEat && typeof bot.autoEat.enableAuto === 'function');
  if (!available) {
    const payload = JSON.stringify({ note: 'mineflayer-auto-eat not loaded on this runner' });
    res.writeHead(204, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(payload);
  }
  try {
    if (on) bot.autoEat.enableAuto();
    else bot.autoEat.disableAuto();
    sendJson(res, 200, { ok: true, on });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleIdleGuard(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (typeof body.on !== 'boolean') return sendJson(res, 400, { error: '/idleguard requires "on" (boolean)' });
  idleGuardEnabled = body.on;
  pushEvent('idle-guard', idleGuardEnabled ? 'enabled by driver' : 'disabled by driver');
  logLine('info', `idle-guard: ${idleGuardEnabled ? 'enabled' : 'disabled'} via /idleguard`);
  sendJson(res, 200, {
    ok: true,
    idleGuard: idleGuardEnabled,
    note: idleGuardEnabled
      ? 'idle-guard armed'
      : 'idle-guard disabled; auto re-arms after 15min with zero incoming HTTP requests (safety TTL)',
  });
}

// POST /drives {"on": boolean} — DRIVES-PLAN.md §9, mirrors handleIdleGuard
// above exactly (annotation B: "like /idleguard"). Toggles an in-memory
// drivesRuntimeOn flag for THIS runner session only — does not persist to
// drives.json. Stamped as a POST, so it counts as driver activity for
// lastCommandAt like any other (a driver toggling drives off IS driver
// activity).
async function handleDrivesToggle(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (typeof body.on !== 'boolean') return sendJson(res, 400, { error: '/drives requires "on" (boolean)' });
  drivesRuntimeOn = body.on;
  pushEvent('drives', drivesRuntimeOn ? 'enabled by driver' : 'disabled by driver');
  logLine('info', `drives: ${drivesRuntimeOn ? 'enabled' : 'disabled'} via /drives`);
  sendJson(res, 200, {
    ok: true,
    drives: drivesRuntimeOn,
    note: drivesRuntimeOn
      ? 'drives armed'
      : 'drives disabled; auto re-arms after 15min with zero incoming HTTP requests (safety TTL)',
  });
}

// GET /drives — DRIVES-PLAN.md §9, read-only debug/panel detail. Does NOT
// stamp lastCommandAt (it's routed as GET, same as /status/`/events`).
// enrolled:false short-circuits to nulls/zeros — cheap for the panel to
// poll without a separate "is this bot even in scope" check.
function handleDrivesStatus(res) {
  const enrolled = drivesConfig.isEnrolled(name);
  if (!enrolled) {
    return sendJson(res, 200, {
      enrolled: false,
      on: false,
      needs: null,
      lastDecision: null,
      lastReflection: null,
      callsThisHour: 0,
      consecutiveFails: 0,
      queueDepth: drivesQueue.queueDepth(),
    });
  }
  sendJson(res, 200, {
    enrolled: true,
    on: drivesOwnsIdle(name),
    needs: driveState.needs,
    lastDecision: driveState.lastDecision,
    lastReflection: mind.reflection,
    callsThisHour: drivesQueue.callsThisHour(name),
    consecutiveFails: mind.counters.consecutiveFails ?? 0,
    queueDepth: drivesQueue.queueDepth(),
  });
}

async function handleStop(res) {
  const task = await cancelCurrentTask('stopped via /stop');
  sendJson(res, 200, { ok: true, task: taskToJSON(task) });
}

async function handleRelog(res) {
  logLine('info', 'relog requested via /relog');
  pushEvent('task', 'relog requested via /relog');
  manualRelog = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // Only ever one pending relog-connect timer — two quick /relog calls must
  // not each fire connect() (that would put two bots online with one name).
  if (relogTimer) {
    clearTimeout(relogTimer);
    relogTimer = null;
  }
  reconnectAttempt = 0;
  try {
    bot?.quit?.('relog');
  } catch (err) {
    logLine('warn', `relog: quit() error: ${err.message}`);
  }
  relogTimer = setTimeout(() => {
    relogTimer = null;
    manualRelog = false;
    connect();
  }, 500);
  sendJson(res, 200, { ok: true });
}

async function handleEval(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (typeof body.code !== 'string') return sendJson(res, 400, { error: '/eval requires "code" (string)' });
  if (!state.connected) return sendJson(res, 503, { error: 'disconnected' });

  let task;
  try {
    task = await startTask(
      'eval',
      async (task, ctx) => {
        const b = requireBot();
        const evalLog = (msg) => ctx.log('info', typeof msg === 'string' ? msg : JSON.stringify(msg));
        return runEvalCode(b, mcData, skills, evalLog, body.code);
      },
      { force: !!body.force, source: body.source }
    );
  } catch (err) {
    if (err?.busy) return sendJson(res, 409, { error: 'busy', currentTask: taskToJSON(state.currentTask) });
    return sendJson(res, 400, { error: err?.message ?? String(err) });
  }

  const winner = await Promise.race([waitForTaskSettled(task).then(() => 'settled'), sleep(10000).then(() => 'timeout')]);
  if (winner === 'timeout' && task.state === 'running') {
    return sendJson(res, 200, {
      note: 'still running past the 10s soft timeout; poll /status for the result',
      task: taskToJSON(task),
    });
  }
  if (task.state === 'failed') {
    return sendJson(res, 200, { error: task.result?.error ?? 'eval failed', task: taskToJSON(task) });
  }
  return sendJson(res, 200, { result: task.result, task: taskToJSON(task) });
}

function handleEvents(u, res) {
  const since = Number(u.searchParams.get('since') || 0);
  const filtered = eventsBuf.filter((e) => e.seq > since);
  sendJson(res, 200, { events: filtered, last: eventSeq });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    logLine('error', `unhandled request error: ${err?.stack ?? err}`);
    try {
      sendJson(res, 500, { error: err?.message ?? String(err) });
    } catch {
      // response already sent/broken — nothing more to do
    }
  });
});

async function handleRequest(req, res) {
  // SAFETY TTL clock — cheap one assignment per request, any endpoint counts
  // as evidence the driver (or whoever) is still alive; see
  // checkIdleGuardSafetyTTL above.
  lastHttpRequestAt = Date.now();

  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  const pathname = u.pathname;
  const method = req.method;

  // DRIVES ENGINE §2 (DRIVES-PLAN.md) — "any HTTP call = activity" (LEAD
  // ANNOTATION A) narrowed to POST-only: overseer.mjs polls GET /status on
  // every bot every 30s regardless of enrollment (still needs connectivity/
  // stuck data for enrolled bots — annotation K), and a GET-counts-as-
  // activity reading would starve drives permanently on any bot overseer
  // also watches. lastHttpRequestAt above (ANY method) stays the idle-guard
  // safety-TTL clock, untouched. lastCommandAt (POST only) is the narrower,
  // literal read of "driver intent" that drives' own precedence check reads
  // instead — FLAGGED for chief confirmation (DRIVES-PLAN.md §12 item 1).
  if (method === 'POST') lastCommandAt = Date.now();

  if (method === 'GET' && pathname === '/status') return sendJson(res, 200, buildStatus());
  if (method === 'GET' && pathname === '/events') return handleEvents(u, res);
  if (method === 'POST' && pathname === '/chat') return handleChat(req, res);
  if (method === 'POST' && pathname === '/autoeat') return handleAutoEat(req, res);
  if (method === 'POST' && pathname === '/idleguard') return handleIdleGuard(req, res);
  if (method === 'GET' && pathname === '/drives') return handleDrivesStatus(res);
  if (method === 'POST' && pathname === '/drives') return handleDrivesToggle(req, res);
  if (method === 'POST' && pathname === '/stop') return handleStop(res);
  if (method === 'POST' && pathname === '/relog') return handleRelog(res);
  if (method === 'POST' && pathname === '/eval') return handleEval(req, res);
  if (method === 'POST' && taskRoutes[pathname]) return taskRoutes[pathname](req, res);

  sendJson(res, 404, { error: 'not found' });
}

server.on('error', (err) => {
  // Without this, a failed bind (EADDRINUSE etc.) is swallowed by the
  // uncaughtException handler and the bot stays online with NO control API.
  // An uncontrollable bot is worse than a dead one — exit hard.
  logLine('error', `HTTP server error, exiting: ${err?.stack ?? err}`);
  try {
    bot?.quit?.();
  } catch {
    // ignore
  }
  removePidFile();
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  logLine('info', `HTTP API listening on 127.0.0.1:${port}`);
});
