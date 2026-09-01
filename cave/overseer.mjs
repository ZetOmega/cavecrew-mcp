// overseer.mjs — deterministic idle watchdog for the cavecrew fleet.
// No LLM. Polls every bot; any bot idle past the idle threshold gets a
// role-default task so resources always flow. Stuck bots escalate stop →
// relog → their own `/trigger home` (cavehome datapack; RCON tp retired),
// disconnected bots relogged.
// Run: node cave/overseer.mjs   (detached; pid in cave/pids/overseer.json)
//
// ---------------------------------------------------------------------------
// 2026-09-01 — SAFE DEFAULTS RE-ENABLED after the canDig / reach / wedge fixes.
//
// Why they were off: an overseer idle-default /collect sent a bot pathing with
// pathfinder `canDig: true`, which chewed through camp furniture on the way to
// a drop. Root causes are fixed in shipped code — Movements now runs
// `canDig: false`, the reach-gap bug is patched, and the runner carries its own
// wedge watchdog — so defaults are safe to turn back on.
//
// 120s threshold (was 60s): driver eval-thinking gaps reliably tripped the 60s
// timer, so the overseer fired a default on a bot whose driver was mid-thought.
// See FEEDBACK: "CONFIRMED: overseer idle-default /collect caused the furniture
// damage". 120s sits above normal driver latency and still catches real stalls.
//
// DIG LAW — miners excluded. Thak, Durk and Mog get NO auto-mine default.
// Mining happens only in dedicated zones, via /buildStaircase + /branchMine,
// under explicit driver command. Their idle default is a /goto back to their
// own workstation / wait sector (anti-clump law), which is a cheap no-op walk
// when they are already parked there.
//
// ONE COMMANDER — the overseer pushes defaults ONLY to bots with no running
// task, and never uses `force`. It never cancels, preempts, or fights a
// driver's running task; if a driver is working the bot, the overseer stays
// silent. Drivers command; the overseer only fills dead air.
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRconChat } from './rconchat.js'
import { postStatus, isConfigured as discordConfigured } from './discord.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOG = path.join(HERE, 'logs', 'overseer.log')
const PIDF = path.join(HERE, 'pids', 'overseer.json')

const CAMP = { x: 12, y: 91, z: 52 }
// 120s, not 60s: driver eval-thinking gaps tripped the old 60s timer and the
// overseer stole bots out from under working drivers. See header block.
const IDLE_MS = 120_000
const POLL_MS = 30_000
const STUCK_MS = 150_000

// Role-default tasks: cheap, useful, and never forced — a default only ever
// goes to a bot with no running task, so a driver's work is never preempted.
// Rows keep the rotation-array shape; single-entry arrays are the norm now.
// A rotation entry is either a static {ep, body, say} or a chooser function
// (status) => {ep, body, say} for defaults that depend on live bot state.
//
// /mine is PULLED from every idle-default and stays pulled. Two separate
// incidents: maxDistance is 3D, so it chased ore straight DOWN a ravine and
// killed Grog (y89→y26, full kit lost), and it tunneled Grog 8 blocks below
// his own feet (depth-law breach). Under the dig law, unattended mining is
// gone entirely — ore runs go through /buildStaircase + /branchMine in a
// dedicated zone, on driver command only.
const BOTS = [
  // Wood keeper. Two-step chooser, because the chop-quarantine enforcer below
  // checks the BOT's position, not the tree's: any chop running while he stands
  // inside the 60-block camp ring gets stopped on sight. So a bare /chop
  // default inside the ring would just churn — fire, get killed, refire.
  // Instead: inside the ring, walk him out to the wood-line waypoint first;
  // only once he is standing outside the ring does /chop actually get to run.
  // Real fix (enforcer testing the TREE position instead of the bot's) is
  // queued for a team-lead decision.
  { name: 'UngaBunga', port: 3201, color: 'yellow', defaults: [
    (st) => {
      const dx = (st?.pos?.x ?? CAMP.x) - 12, dz = (st?.pos?.z ?? CAMP.z) - 56
      return Math.sqrt(dx * dx + dz * dz) < 60
        // Waypoint sits ~70.8 from the ring center (not the earlier 63.2):
        // range:2 can park him ~68.8 out, still ~9 blocks of slack against the
        // 60 ring — drift or a shove can't put his chop back inside it.
        ? { ep: '/goto', body: { x: 60, y: 104, z: 108, range: 2, engine: 'pf' }, say: 'idle: out to the wood line' }
        : { ep: '/chop', body: { count: 4, maxDistance: 48 }, say: 'idle: chop wood' }
    },
  ]},
  // Camp tidy — tight radius so a sweep stays inside camp and never wanders.
  { name: 'Grog', port: 3202, color: 'green', defaults: [
    { ep: '/collect', body: { radius: 8 }, say: 'idle: tidy camp' },
  ]},
  // Farm sweep at his farm workstation.
  { name: 'Zug', port: 3203, color: 'light_purple', defaults: [
    { ep: '/collect', body: { radius: 12 }, say: 'idle: farm sweep' },
  ]},
  // Staging tidy — tight radius, door-staging area.
  { name: 'Bonk', port: 3204, color: 'aqua', defaults: [
    { ep: '/collect', body: { radius: 8 }, say: 'idle: tidy staging' },
  ]},
  // DIG LAW: no auto-mine. Idle default parks him at his mine-field
  // workstation (24, 90, 64) — a no-op walk if he is already standing there.
  { name: 'Thak', port: 3205, color: 'gold', defaults: [
    { ep: '/goto', body: { x: 24, y: 90, z: 64, range: 2, engine: 'pf' }, say: 'idle: back to mine field post' },
  ]},
  // Meat runner. /hunt targets passive mobs only by design.
  { name: 'Ook', port: 3206, color: 'red', defaults: [
    { ep: '/hunt', body: { mob: 'pig', count: 1 }, say: 'idle: sniff for pig' },
  ]},
  // DIG LAW: no auto-mine. No listed workstation — parked at a camp-adjacent
  // wait spot picked to satisfy anti-clump (own block, not stacked on anyone).
  { name: 'Durk', port: 3207, color: 'blue', defaults: [
    { ep: '/goto', body: { x: 16, y: 89, z: 52, range: 2, engine: 'pf' }, say: 'idle: back to wait spot' },
  ]},
  // DIG LAW: no auto-mine. Same as Durk — camp-adjacent wait spot, anti-clump.
  { name: 'Mog', port: 3208, color: 'dark_aqua', defaults: [
    { ep: '/goto', body: { x: 8, y: 90, z: 52, range: 2, engine: 'pf' }, say: 'idle: back to wait spot' },
  ]},
]

// Recurring chores: fire when due AND bot is free (never preempts real work).
// Farm-harvest chore upgrades to /farm harvest once farm skills ship.
const CHORES = [
  { id: 'zug-farm-sweep', bot: 'Zug', everyMs: 12 * 60_000, ep: '/goto', body: { x: 10, y: 89, z: 58, range: 3 }, say: 'chore: farm round (check crops, sweep)' },
  { id: 'zug-farm-collect', bot: 'Zug', everyMs: 12 * 60_000, offsetMs: 60_000, ep: '/collect', body: { radius: 12 }, say: 'chore: farm sweep' },
  { id: 'ook-hunt-cycle', bot: 'Ook', everyMs: 20 * 60_000, ep: '/hunt', body: { mob: 'pig', count: 2 }, say: 'chore: meat round' },
]
const choreLast = new Map() // id -> ts

const state = new Map() // name -> {idleSince, lastPos, posSince, lastRelog, defaultIdx}
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}\n`; try { fs.appendFileSync(LOG, line) } catch {}; console.log(line.trim()) }

// alerts.log — the escalation channel the orchestrator reads every 5-min tick.
// Only things the overseer could NOT fix itself belong here.
const ALERTS = path.join(HERE, 'logs', 'alerts.log')
const alert = (m) => { const line = `[${new Date().toISOString()}] ALERT ${m}\n`; try { fs.appendFileSync(ALERTS, line) } catch {}; log(`ALERT ${m}`) }

let rcon = null
const getRcon = () => (rcon ??= createRconChat())
// local.json config — read once, lazily, cached. Same file rconchat.js reads
// for its own [rcon] block; this reads the sibling [discord] block.
let localConfigLoaded = false
let localConfig = null
const getLocalConfig = () => {
  if (!localConfigLoaded) {
    localConfigLoaded = true
    try { localConfig = JSON.parse(fs.readFileSync(path.join(HERE, 'local.json'), 'utf8')) } catch { localConfig = null }
  }
  return localConfig
}
// grey() — status/narration line. CHAT-SILENCE LAW: this NEVER touches game
// chat, not even tellraw grey — it goes to the Discord status feed when
// cave/local.json has discord.webhookUrl configured, else just the log.
const grey = async (name, color, text) => {
  try {
    const cfg = getLocalConfig()
    if (discordConfigured(cfg)) {
      const ok = await postStatus({ botName: name, color, text, webhookUrl: cfg.discord.webhookUrl })
      if (ok) return
      log(`grey: discord postStatus failed, status stays in log only`)
    }
    log(`(status) ${name}: ${text}`)
  } catch (e) { log(`grey fail: ${e.message}`) }
}
const rconCmd = async (cmd) => { try { return await getRcon().send(cmd) } catch (e) { log(`rcon fail: ${e.message}`); return null } }

const api = async (port, ep, body, method = 'POST') => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${ep}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(8000),
    })
    return await r.json().catch(() => null)
  } catch { return null }
}

async function tick(bot) {
  const s = state.get(bot.name) ?? { idleSince: null, lastPos: null, posSince: 0, lastRelog: 0, defaultIdx: 0 }
  state.set(bot.name, s)
  const st = await api(bot.port, '/status', null, 'GET')
  if (!st) {
    s.downCount = (s.downCount ?? 0) + 1
    if (s.downCount === 3) alert(`${bot.name} runner unreachable on port ${bot.port} (3 polls) — needs spawn.mjs restart`)
    return
  }
  s.downCount = 0

  // failed task sitting unhandled → escalate after ~2 min
  const nowTs = Date.now()
  if (st.currentTask && st.currentTask.state === 'failed') {
    const fkey = st.currentTask.id
    if (s.failedSeen === fkey) {
      if (s.failedSince && nowTs - s.failedSince > 120_000 && !s.failedAlerted) {
        s.failedAlerted = true
        alert(`${bot.name} task ${fkey} FAILED >2min, no follow-up (${String(st.lastError).slice(0, 80)})`)
      }
    } else { s.failedSeen = fkey; s.failedSince = nowTs; s.failedAlerted = false }
  } else { s.failedSeen = null }

  // disconnected too long despite relogs → escalate
  if (!st.connected) {
    if (s.discSince == null) s.discSince = nowTs
    if (nowTs - s.discSince > 180_000 && !s.discAlerted) { s.discAlerted = true; alert(`${bot.name} disconnected >3min despite relogs`) }
  } else { s.discSince = null; s.discAlerted = false }

  const now = Date.now()

  // disconnected → relog (at most every 2 min)
  if (!st.connected) {
    if (now - s.lastRelog > 120_000) {
      s.lastRelog = now
      log(`${bot.name} disconnected -> /relog`)
      await api(bot.port, '/relog', {})
    }
    return
  }

  const running = st.currentTask && st.currentTask.state === 'running'

  // CHOP QUARANTINE ENFORCER: /chop matches any oak_log as "tree" and has
  // repeatedly harvested the house pillars. Any running chop within 60 blocks
  // of camp gets killed on sight — code law, not inbox law.
  if (running && st.currentTask.kind === 'chop' && st.pos) {
    const dx = st.pos.x - 12, dz = st.pos.z - 56
    if (Math.sqrt(dx * dx + dz * dz) < 60) {
      log(`${bot.name} CHOP inside camp quarantine at (${Math.round(st.pos.x)},${Math.round(st.pos.z)}) -> stop`)
      await api(bot.port, '/stop', {})
      await grey(bot.name, bot.color, '(overseer) chop stopped — camp quarantine, trees only 60+ blocks out')
      return
    }
  }

  // stuck detection escalation ladder (user law 2026-09-01 v2: RCON tp
  // RETIRED — bots self-rescue LEGIT): 1st detection = stop + relog; still
  // frozen at the SAME spot on a later detection = send the bot's own
  // `/trigger home` chat command (cavehome datapack — works only if the bot
  // ran `/trigger sethome` on the surface first, which is fleet doctrine).
  // No home set / trigger fails = nothing more the overseer may do: log loud
  // and leave it for the orchestrator's stuck report.
  if (running && st.pos) {
    const key = `${Math.round(st.pos.x)},${Math.round(st.pos.y)},${Math.round(st.pos.z)}`
    if (s.lastPos === key) {
      if (now - s.posSince > STUCK_MS && st.currentTask.kind === 'goto') {
        if (s.stuckAtKey === key) {
          log(`${bot.name} STILL stuck at ${key} after relog -> last-resort /trigger home (no tp — retired)`)
          await api(bot.port, '/stop', {})
          await api(bot.port, '/chat', { message: '/trigger home' })
          await grey(bot.name, bot.color, '(overseer) hard-stuck — sent /trigger home (works only if sethome done)')
          s.stuckAtKey = null
        } else {
          log(`${bot.name} stuck at ${key} -> stop + relog (tp next if still frozen)`)
          await api(bot.port, '/stop', {})
          await api(bot.port, '/relog', {})
          await grey(bot.name, bot.color, '(overseer) stuck — relogged; /trigger home next if still frozen')
          s.stuckAtKey = key
        }
        s.posSince = now
      }
    } else { s.lastPos = key; s.posSince = now; s.stuckAtKey = null }
    s.idleSince = null
    return
  }

  // recurring chores: due + bot free → fire (before idle-defaults, higher value)
  for (const ch of CHORES) {
    if (ch.bot !== bot.name) continue
    const last = choreLast.get(ch.id) ?? (ch.offsetMs ? now - ch.everyMs + ch.offsetMs : 0)
    if (now - last < ch.everyMs) continue
    choreLast.set(ch.id, now)
    const r = await api(bot.port, ch.ep, ch.body)
    if (r && !r.error) {
      log(`${bot.name} chore ${ch.id} -> ${ch.ep}`)
      await grey(bot.name, bot.color, `(overseer) ${ch.say}`)
      s.idleSince = null
      return
    }
  }

  // idle tracking — RE-ENABLED 2026-09-01 with safe per-role defaults (see the
  // header block). Reachable only when nothing is running: the running-task
  // branch above returns before this point, so a default can never land on a
  // busy bot.
  const IDLE_DEFAULTS_ENABLED = true
  if (!IDLE_DEFAULTS_ENABLED) return
  if (s.idleSince == null) { s.idleSince = now; return }
  if (now - s.idleSince < IDLE_MS) return

  // idle past threshold → role-default task. NEVER `force` — one commander:
  // the overseer fills dead air, it does not cancel a driver's work. If the
  // runner answers busy, that is the correct outcome; log it and move on.
  // A rotation entry is either a static {ep, body, say} or a chooser function
  // (status) => {ep, body, say} that picks based on live bot state. A chooser
  // may return null/undefined to mean "nothing useful right now" — skip quietly.
  const slot = bot.defaults[s.defaultIdx % bot.defaults.length]
  s.defaultIdx++
  s.idleSince = null
  const d = typeof slot === 'function' ? slot(st) : slot
  if (!d) return
  const res = await api(bot.port, d.ep, d.body)
  if (res && res.ok !== false && !res.error) {
    log(`${bot.name} idle>${IDLE_MS / 1000}s -> ${d.ep} ${JSON.stringify(d.body)}`)
    await grey(bot.name, bot.color, `(overseer) ${d.say}`)
  } else {
    log(`${bot.name} idle task ${d.ep} rejected: ${JSON.stringify(res)?.slice(0, 120)}`)
  }
}

process.on('uncaughtException', (e) => log(`uncaught: ${e.message}`))
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e?.message ?? e}`))
try { fs.writeFileSync(PIDF, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })) } catch {}
process.on('SIGINT', () => { try { fs.unlinkSync(PIDF) } catch {}; process.exit(0) })

log(`overseer up, watching ${BOTS.length} bots (idle ${IDLE_MS / 1000}s, poll ${POLL_MS / 1000}s)`)
let lastPhantomPurge = 0
for (;;) {
  for (const b of BOTS) await tick(b).catch((e) => log(`${b.name} tick error: ${e.message}`))
  // phantom purge REMOVED (user law: no rcon world-touches ever — /kill = cheat).
  // Phantoms handled by defense skills once shipped (bows/melee) or by sleeping
  // mechanics if beds become viable.
  void lastPhantomPurge
  await new Promise((r) => setTimeout(r, POLL_MS))
}
