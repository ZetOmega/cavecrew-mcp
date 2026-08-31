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
    { ep: '/mine', body: { block: 'stone', count: 6, maxDistance: 20 }, say: 'idle: dig stone for house' },
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
]

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

  // idle tracking
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
for (;;) {
  for (const b of BOTS) await tick(b).catch((e) => log(`${b.name} tick error: ${e.message}`))
  await new Promise((r) => setTimeout(r, POLL_MS))
}
