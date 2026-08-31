// overseer.mjs — deterministic idle watchdog for the cavecrew fleet.
// No LLM. Polls every bot; any bot idle >60s gets a role-default task so
// resources always flow. Stuck bots get teleported, disconnected bots relogged.
// Run: node cave/overseer.mjs   (detached; pid in cave/pids/overseer.json)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRconChat } from './rconchat.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOG = path.join(HERE, 'logs', 'overseer.log')
const PIDF = path.join(HERE, 'pids', 'overseer.json')

const CAMP = { x: 12, y: 91, z: 52 }
const IDLE_MS = 60_000
const POLL_MS = 30_000
const STUCK_MS = 150_000

// Role-default tasks: cheap, useful, safely interruptible by drivers.
const BOTS = [
  { name: 'UngaBunga', port: 3201, color: 'yellow', defaults: [
    { ep: '/chop', body: { count: 4, maxDistance: 48 }, say: 'idle: chop wood' },
    { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' },
  ]},
  { name: 'Grog', port: 3202, color: 'green', defaults: [
    // NO mine defaults — /mine maxDistance ignores depth and tunneled Grog
    // 8 below feet twice (depth-law breach). Builder role: sweeps only.
    { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' },
  ]},
  { name: 'Zug', port: 3203, color: 'light_purple', defaults: [
    { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' },
    { ep: '/hunt', body: { mob: 'chicken', count: 1 }, say: 'idle: look for bird' },
  ]},
  { name: 'Bonk', port: 3204, color: 'aqua', defaults: [
    { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' },
  ]},
  { name: 'Thak', port: 3205, color: 'gold', defaults: [
    { ep: '/mine', body: { block: 'coal_ore', count: 4, maxDistance: 28 }, say: 'idle: dig coal' },
    { ep: '/mine', body: { block: 'iron_ore', count: 4, maxDistance: 28 }, say: 'idle: dig iron' },
  ]},
  { name: 'Ook', port: 3206, color: 'red', defaults: [
    { ep: '/collect', body: { radius: 16 }, say: 'idle: sweep drops' },
    { ep: '/hunt', body: { mob: 'pig', count: 1 }, say: 'idle: sniff for pig' },
  ]},
  { name: 'Durk', port: 3207, color: 'blue', defaults: [
    { ep: '/mine', body: { block: 'iron_ore', count: 6, maxDistance: 32 }, say: 'idle: dig iron' },
  ]},
  { name: 'Mog', port: 3208, color: 'dark_aqua', defaults: [
    { ep: '/mine', body: { block: 'iron_ore', count: 6, maxDistance: 32 }, say: 'idle: dig iron' },
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

let rcon = null
const getRcon = () => (rcon ??= createRconChat())
const grey = async (name, color, text) => { try { await getRcon().sayStatus(name, color, text) } catch (e) { log(`grey fail: ${e.message}`) } }
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
  if (!st) return // runner down — spawn.mjs territory, not ours

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

  // stuck detection: running goto but position frozen too long → tp home
  if (running && st.pos) {
    const key = `${Math.round(st.pos.x)},${Math.round(st.pos.y)},${Math.round(st.pos.z)}`
    if (s.lastPos === key) {
      if (now - s.posSince > STUCK_MS && st.currentTask.kind === 'goto') {
        log(`${bot.name} stuck at ${key} -> tp camp + stop`)
        await api(bot.port, '/stop', {})
        await rconCmd(`tp ${bot.name} ${CAMP.x} ${CAMP.y} ${CAMP.z}`)
        await grey(bot.name, bot.color, '(overseer) unstuck, teleported home')
        s.posSince = now
      }
    } else { s.lastPos = key; s.posSince = now }
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

  // idle tracking — DISABLED since runner-level idle-guard shipped (double
  // tasking caused chat spam + task churn). Overseer keeps: chores, stuck-tp,
  // relog, phantom purge. Flip back if runner idle-guard regresses.
  const IDLE_DEFAULTS_ENABLED = false
  if (!IDLE_DEFAULTS_ENABLED) return
  if (s.idleSince == null) { s.idleSince = now; return }
  if (now - s.idleSince < IDLE_MS) return

  // idle >60s → role-default task (never force; drivers preempt naturally)
  const d = bot.defaults[s.defaultIdx % bot.defaults.length]
  s.defaultIdx++
  s.idleSince = null
  const res = await api(bot.port, d.ep, d.body)
  if (res && res.ok !== false && !res.error) {
    log(`${bot.name} idle>60s -> ${d.ep} ${JSON.stringify(d.body)}`)
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
  // phantom purge (user decree; gamerule doInsomnia rejected by this server build)
  if (Date.now() - lastPhantomPurge > 10 * 60_000) {
    lastPhantomPurge = Date.now()
    const r = await rconCmd('kill @e[type=phantom]')
    if (r && !/No entity was found/i.test(r)) log(`phantom purge: ${r}`)
  }
  await new Promise((r) => setTimeout(r, POLL_MS))
}
