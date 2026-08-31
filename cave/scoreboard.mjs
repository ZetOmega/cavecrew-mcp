// scoreboard.mjs — tribe evolution scoreboard daemon for the cavecrew fleet.
// No LLM. Every 10 min: (a) tails mc-dev-server latest.log for DEPOT ledger,
// BASE builds, TRADE lines, advancements, deaths; (b) polls our fleet
// /status (deathCount + inventory) on 3201-3208 + best-effort 3301 (FEL);
// (c) accumulates cumulative + daily-snapshot counters in
// cave/scoreboard-state.json; (d) writes cave/SCOREBOARD.md; (e) pushes a
// read-only "Tribe Fitness" sidebar via RCON (scoreboard display commands
// ONLY — no world-touches, per user law).
//
// PRIMARY table = per-bot fitness among our own 8 (survival of the fittest,
// formula per cave/EVOLUTION.md). SECONDARY section = CAVE vs FEL tribe
// comparison (original weighted formula, unchanged per decree).
//
// Signals NOT derivable from log/status alone (task completed clean +2,
// quirk found +8, peer help +5, task failed -3, needed rescue -8, materials
// lost -1/stack, idle caught -5, broke laws -10 — see EVOLUTION.md) are left
// at 0 here; hook point noted below for a future FEEDBACK.md/runner-log pass.
//
// Run: node cave/scoreboard.mjs   (detached; pid in cave/pids/scoreboard.json)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRconChat } from './rconchat.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOG = path.join(HERE, 'logs', 'scoreboard.log')
const PIDF = path.join(HERE, 'pids', 'scoreboard.json')
const STATE_FILE = path.join(HERE, 'scoreboard-state.json')
const MD_FILE = path.join(HERE, 'SCOREBOARD.md')
const MC_LOG = 'C:\\Users\\phili\\tools\\mc-dev-server\\logs\\latest.log'

const POLL_MS = 10 * 60_000
const OBJECTIVE = 'tribes'
const DAILY_SNAPSHOTS_KEEP = 14

// Roster we control (ports = /status endpoints). Roles per CIV.md roster
// table (Durk/Mog inferred from overseer.mjs idle-default role: sweep-only).
const ROSTER = [
  { name: 'UngaBunga', port: 3201, role: 'lumber, camp builder' },
  { name: 'Grog', port: 3202, role: 'stone/coal/iron miner' },
  { name: 'Zug', port: 3203, role: 'food (hunt, later farm)' },
  { name: 'Bonk', port: 3204, role: 'builder (camp infra)' },
  { name: 'Thak', port: 3205, role: 'iron miner #2' },
  { name: 'Ook', port: 3206, role: 'hunter (far-range meat)' },
  { name: 'Durk', port: 3207, role: 'gatherer (sweep drops)' },
  { name: 'Mog', port: 3208, role: 'gatherer (sweep drops)' },
]
const FEL_STATUS_PORT = 3301 // best-effort; likely unreachable (remote fleet)

// Name -> tribe attribution for raw (untagged) log lines: advancements,
// deaths. Chat lines (DEPOT/TRADE/BASE) already carry a [CAVE]/[FEL] tag.
const CAVE_NAMES = ['UngaBunga', 'Grog', 'Zug', 'Bonk', 'Thak', 'Ook', 'Durk', 'Mog', 'BariBrute']
const FEL_NAMES = [
  'FurzFriedrich', 'MettMarcel', 'BuddelBernd', 'KackboonKevin', 'PflasterPeter',
  'BratwurstBodo', 'KloputzKarl', 'HuettenHorst', 'SchisserSiegbert', 'GearSmith',
  'GrubenGuenther', 'NudelNorbert',
]
// Fallback for new/unlisted FEL bots: their names read as two capitalized
// German-word halves joined (e.g. "PflasterPeter"). Only used when a raw
// death/advancement line names someone not already in either list above.
const FEL_COMPOUND_RE = /^[A-Z][a-z]+[A-Z][a-z]+$/

function tribeOf(name) {
  if (CAVE_NAMES.includes(name)) return 'CAVE'
  if (FEL_NAMES.includes(name)) return 'FEL'
  if (FEL_COMPOUND_RE.test(name)) return 'FEL'
  return null
}

const IRON_ITEM_RE = /^(iron_ore|deepslate_iron_ore|raw_iron|iron_ingot|iron_block|iron_nugget)$/
const HARVEST_ITEM_RE = /^(wheat|wheat_seeds|bread|carrot|potato|beetroot|beetroot_seeds|melon|melon_slice|pumpkin|pumpkin_seeds|apple)$/

const DEATH_RE = /\b(was slain|was shot|was killed|fell (from|off|out)|drowned|burned to death|went up in flames|blew up|was blown up|hit the ground too hard|discovered the floor was lava|walked into|tried to swim in lava|starved to death|suffocated|was pricked|was squashed|was struck by lightning|withered away|was fireballed|was skewered|was impaled|was stung|was obliterated|died)\b/i
const ADVANCEMENT_RE = /^has (made the advancement|completed the challenge|reached the goal) \[/i

// Chat lines: [HH:MM:SS] [Server thread/INFO]: [Not Secure] <[TAG] Name> body
const CHAT_RE = /^\[\d\d:\d\d:\d\d\] \[Server thread\/INFO\]: (?:\[Not Secure\] )?<\[(CAVE|FEL)\] (\S+)> (.*)$/
// Raw server lines (deaths/advancements): [HH:MM:SS] [Server thread/INFO]: Name rest...
const RAW_RE = /^\[\d\d:\d\d:\d\d\] \[Server thread\/INFO\]: (\S+) (.*)$/
// DEPOT item tokens: "+61 oak_log", "-64 oak_log", repeated in one line
const ITEM_TOKEN_RE = /([+-]\d+)\s+(\w+)/g

const log = (m) => { const line = `[${new Date().toISOString()}] ${m}\n`; try { fs.appendFileSync(LOG, line) } catch {}; console.log(line.trim()) }

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { logLineCount: 0, bots: {}, tribe: { CAVE: emptyCounters(), FEL: emptyCounters() }, dailySnapshots: [], sidebarObjectiveAdded: false, lastRun: null }
  }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)) } catch (e) { log(`state save fail: ${e.message}`) }
}

function emptyCounters() {
  return { resourcesBanked: 0, ironBanked: 0, harvestBanked: 0, builds: 0, trades: 0, advancements: 0, deaths: 0 }
}
function botState(state, name) {
  if (!state.bots[name]) state.bots[name] = { role: '', counters: emptyCounters(), ironHeld: 0, connected: false }
  return state.bots[name]
}

// --- log tailing --------------------------------------------------------

function applyDepot(counters, body) {
  ITEM_TOKEN_RE.lastIndex = 0
  let m
  let any = false
  while ((m = ITEM_TOKEN_RE.exec(body))) {
    any = true
    const n = parseInt(m[1], 10)
    const item = m[2]
    counters.resourcesBanked += n
    if (IRON_ITEM_RE.test(item)) counters.ironBanked += n
    if (HARVEST_ITEM_RE.test(item)) counters.harvestBanked += n
  }
  return any
}

function tailLog(state) {
  let text
  try {
    text = fs.readFileSync(MC_LOG, 'utf8')
  } catch (e) {
    log(`log read fail: ${e.message}`)
    return
  }
  const lines = text.split(/\r?\n/)
  const total = lines.length
  let start = state.logLineCount || 0
  if (start > total) { log(`latest.log shrank (rotated) — resetting cursor`); start = 0 }
  const newLines = lines.slice(start)
  state.logLineCount = total
  if (newLines.length === 0) return

  for (const line of newLines) {
    if (!line) continue
    const chat = CHAT_RE.exec(line)
    if (chat) {
      const [, tag, name, body] = chat
      const bs = tribeOf(name) === 'CAVE' && ROSTER.some((r) => r.name === name) ? botState(state, name) : null
      const tribeCounters = state.tribe[tag] ?? (state.tribe[tag] = emptyCounters())
      if (body.startsWith('DEPOT ')) {
        applyDepot(tribeCounters, body.slice(6))
        if (bs) applyDepot(bs.counters, body.slice(6))
      } else if (body.startsWith('TRADE ')) {
        tribeCounters.trades++
        if (bs) bs.counters.trades++
      } else if (body.startsWith('BASE +')) {
        tribeCounters.builds++
        if (bs) bs.counters.builds++
      }
      continue
    }
    const raw = RAW_RE.exec(line)
    if (raw) {
      const [, name, rest] = raw
      const tribe = tribeOf(name)
      if (!tribe) continue
      const tribeCounters = state.tribe[tribe] ?? (state.tribe[tribe] = emptyCounters())
      const bs = tribe === 'CAVE' && ROSTER.some((r) => r.name === name) ? botState(state, name) : null
      if (ADVANCEMENT_RE.test(rest)) {
        tribeCounters.advancements++
        if (bs) bs.counters.advancements++
      } else if (DEATH_RE.test(rest)) {
        // FEL deaths only counted here (no /status for them). CAVE deaths
        // use the authoritative /status deathCount instead (set in poll
        // step below) to avoid double counting against the same event.
        if (tribe === 'FEL') tribeCounters.deaths++
      }
    }
  }
}

// --- fleet status poll --------------------------------------------------

async function apiGet(port, ep) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${ep}`, { method: 'GET', signal: AbortSignal.timeout(8000) })
    return await r.json().catch(() => null)
  } catch { return null }
}

function ironHeldFrom(inventory) {
  if (!Array.isArray(inventory)) return 0
  let sum = 0
  for (const it of inventory) if (it && IRON_ITEM_RE.test(it.name)) sum += it.count || 0
  return sum
}

async function pollFleet(state) {
  for (const r of ROSTER) {
    const bs = botState(state, r.name)
    bs.role = r.role
    const st = await apiGet(r.port, '/status')
    if (!st) { bs.connected = false; continue }
    bs.connected = !!st.connected
    bs.ironHeld = ironHeldFrom(st.inventory)
    if (typeof st.deathCount === 'number') bs.counters.deaths = st.deathCount
  }
  // Best-effort FEL aggregate status (likely unreachable — remote fleet).
  const felSt = await apiGet(FEL_STATUS_PORT, '/status')
  if (felSt) {
    const tc = state.tribe.FEL ?? (state.tribe.FEL = emptyCounters())
    if (Array.isArray(felSt.bots)) {
      let deaths = 0
      for (const b of felSt.bots) if (typeof b.deathCount === 'number') deaths += b.deathCount
      if (deaths) tc.deaths = Math.max(tc.deaths, deaths)
    } else if (typeof felSt.deathCount === 'number') {
      tc.deaths = Math.max(tc.deaths, felSt.deathCount)
    }
  }
}

// --- scoring --------------------------------------------------------------

// Per-bot fitness, formula per cave/EVOLUTION.md (only derivable signals):
//   resources banked (net, per ledger unit)  +1 each
//   milestone (build / trade / advancement)  +10 each
//   death                                    -15 each
function botScore(c) {
  return c.resourcesBanked * 1 + (c.builds + c.trades + c.advancements) * 10 - c.deaths * 15
}
function topContribution(c) {
  const cats = [
    ['resources banked', c.resourcesBanked * 1],
    ['builds', c.builds * 10],
    ['trades', c.trades * 10],
    ['advancements', c.advancements * 10],
  ]
  cats.sort((a, b) => b[1] - a[1])
  if (cats[0][1] <= 0) return '—'
  return `${cats[0][0]} (+${cats[0][1]})`
}
function verdicts(rows) {
  if (rows.length < 2) { for (const r of rows) r.verdict = 'watch'; return }
  const scores = rows.map((r) => r.score)
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length
  const max = Math.max(...scores)
  const min = Math.min(...scores)
  const MARGIN = 5
  for (const r of rows) {
    if (r.score === max && r.score > avg + MARGIN) r.verdict = 'fit'
    else if (r.score === min && r.score < avg - MARGIN) r.verdict = 'at-risk'
    else r.verdict = 'watch'
  }
}

// Tribe-level formula — original spec, unchanged per decree.
function tribeScore(c) {
  return c.ironBanked * 2 + c.harvestBanked * 1 + c.builds * 3 + c.trades * 5 - c.deaths * 5 + c.advancements * 2
}

// --- report ---------------------------------------------------------------

function fmtDate(d) { return d.toISOString().slice(0, 10) }

function maybeSnapshot(state, botRows, tribeRows) {
  const today = fmtDate(new Date())
  const last = state.dailySnapshots[state.dailySnapshots.length - 1]
  if (last && last.date === today) return
  const snap = {
    date: today,
    bots: Object.fromEntries(botRows.map((r) => [r.name, r.score])),
    tribe: Object.fromEntries(tribeRows.map((r) => [r.name, r.score])),
  }
  state.dailySnapshots.push(snap)
  if (state.dailySnapshots.length > DAILY_SNAPSHOTS_KEEP) state.dailySnapshots.shift()
}

function writeMarkdown(state, botRows, tribeRows) {
  const now = new Date().toISOString()
  let md = `# SCOREBOARD.md — cavecrew evolution\n\n_Last updated: ${now}_\n\n`
  md += `## Per-bot fitness (survival of the fittest — formula: cave/EVOLUTION.md)\n\n`
  md += `| Rank | Bot | Role | Score | Resources | Builds | Trades | Advancements | Deaths | Iron Held (live) | Top Contribution | Verdict |\n`
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|\n`
  botRows
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach((r, i) => {
      md += `| ${i + 1} | ${r.name} | ${r.role} | ${r.score} | ${r.counters.resourcesBanked} | ${r.counters.builds} | ${r.counters.trades} | ${r.counters.advancements} | ${r.counters.deaths} | ${r.ironHeld} | ${r.top} | ${r.verdict} |\n`
    })

  md += `\n## Tribe comparison — CAVE vs FEL (secondary)\n\n`
  md += `| Tribe | Iron Banked | Harvests | Builds | Trades | Deaths | Advancements | Fitness Score |\n`
  md += `|---|---|---|---|---|---|---|---|\n`
  for (const r of tribeRows) {
    md += `| ${r.name} | ${r.counters.ironBanked} | ${r.counters.harvestBanked} | ${r.counters.builds} | ${r.counters.trades} | ${r.counters.deaths} | ${r.counters.advancements} | ${r.score} |\n`
  }

  md += `\n## Week-over-week trend (per-bot cumulative score, daily snapshots)\n\n`
  const snaps = state.dailySnapshots
  if (snaps.length === 0) {
    md += `_No daily snapshots yet — first one saved today._\n`
  } else {
    md += `| Bot | ${snaps.map((s) => s.date).join(' | ')} | Δ (first→last) |\n`
    md += `|---|${snaps.map(() => '---').join('|')}|---|\n`
    for (const r of botRows) {
      const vals = snaps.map((s) => s.bots[r.name] ?? '—')
      const first = snaps.find((s) => typeof s.bots[r.name] === 'number')
      const delta = first ? r.score - first.bots[r.name] : '—'
      md += `| ${r.name} | ${vals.join(' | ')} | ${delta} |\n`
    }
  }

  md += `\n---\n_Signals not yet wired (need FEEDBACK.md / runner-log parsing): task-completed-clean, quirk-found, peer-help, task-failed, needed-rescue, materials-lost, idle-caught, broke-laws. See cave/EVOLUTION.md._\n`
  try { fs.writeFileSync(MD_FILE, md) } catch (e) { log(`SCOREBOARD.md write fail: ${e.message}`) }
}

// --- RCON sidebar -----------------------------------------------------------

let rcon = null
const getRcon = () => (rcon ??= createRconChat())

async function pushSidebar(state, botRows) {
  const chat = getRcon()
  try {
    if (!state.sidebarObjectiveAdded) {
      await chat.send(`scoreboard objectives add ${OBJECTIVE} dummy "Tribe Fitness"`)
      state.sidebarObjectiveAdded = true
    }
    await chat.send(`scoreboard objectives setdisplay sidebar ${OBJECTIVE}`)
    for (const r of botRows) {
      await chat.send(`scoreboard players set ${r.name} ${OBJECTIVE} ${Math.round(r.score)}`)
    }
  } catch (e) {
    log(`rcon sidebar fail: ${e.message}`)
  }
}

// --- main tick --------------------------------------------------------------

async function tick(state) {
  tailLog(state)
  await pollFleet(state)

  const botRows = ROSTER.map((r) => {
    const bs = botState(state, r.name)
    const score = botScore(bs.counters)
    return { name: r.name, role: bs.role || r.role, counters: bs.counters, ironHeld: bs.ironHeld, score, top: topContribution(bs.counters) }
  })
  verdicts(botRows)

  const tribeRows = ['CAVE', 'FEL'].map((name) => {
    const counters = state.tribe[name] ?? (state.tribe[name] = emptyCounters())
    return { name, counters, score: tribeScore(counters) }
  })

  maybeSnapshot(state, botRows, tribeRows)
  writeMarkdown(state, botRows, tribeRows)
  await pushSidebar(state, botRows)

  state.lastRun = new Date().toISOString()
  saveState(state)
  log(`cycle done — ${botRows.map((r) => `${r.name}:${r.score}`).join(' ')} | CAVE:${tribeRows[0].score} FEL:${tribeRows[1].score}`)
}

process.on('uncaughtException', (e) => log(`uncaught: ${e.message}`))
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e?.message ?? e}`))
try { fs.writeFileSync(PIDF, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })) } catch {}
process.on('SIGINT', () => { try { fs.unlinkSync(PIDF) } catch {}; process.exit(0) })

log(`scoreboard up, tracking ${ROSTER.length} bots (poll ${POLL_MS / 60_000}min)`)
const state = loadState()
for (;;) {
  await tick(state).catch((e) => log(`tick error: ${e.stack || e.message}`))
  await new Promise((r) => setTimeout(r, POLL_MS))
}
