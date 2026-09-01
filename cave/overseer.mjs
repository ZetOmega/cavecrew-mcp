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
// DIG LAW — miners excluded from the ROLE-DEFAULT fallback specifically:
// Thak, Durk and Mog get NO auto-mine entry in BOTS[].defaults below (that
// array is untouched by the goal engine, see the block below). Their default
// is still a /goto back to their own workstation / wait sector (anti-clump
// law), a cheap no-op walk when they are already parked there. See the GOAL
// ENGINE block below for the 2026-09-01 lift of this exclusion one layer up.
//
// ONE COMMANDER — the overseer pushes defaults ONLY to bots with no running
// task, and never uses `force`. It never cancels, preempts, or fights a
// driver's running task; if a driver is working the bot, the overseer stays
// silent. Drivers command; the overseer only fills dead air.
// ---------------------------------------------------------------------------
//
// 2026-09-01 — GOAL ENGINE landed (goals.json, below); the miner auto-mine
// EXCLUSION IS LIFTED at this new dispatch layer (lead policy call). Before
// today, Thak/Durk/Mog's BOTS[].defaults entries were the ONLY source of
// unattended work, and those entries deliberately never included /mine or
// /branchmine for the three miners (see the DIG LAW paragraph above) — a
// blanket ban born of two incidents (Grog chased ore straight down a ravine
// to his death; Grog tunneled 8 blocks below his own feet, a depth-law
// breach). The goal engine below runs BEFORE that role-default fallback and
// dispatches goals.json entries to WHICHEVER bot is eligible — no per-bot-
// name restriction baked in — so a miner CAN now auto-receive a dig-shaped
// goal (branchmine, mine) the instant one is eligible and the bot is free.
//
// Why this is safe now, when it wasn't before: the root causes are fixed,
// not routed around. /mine now takes an optional zone filter so a wide
// maxDistance can no longer wander into the wrong zone (0dca76b), branchmine
// corridor stepping refuses to walk into an unsecured void (0b2eee7), and
// Movements runs canDig:false fleet-wide (see the SAFE DEFAULTS block
// above) — the same three fixes that let idle-defaults themselves come back
// on. The goal engine adds NO safety logic of its own: it only ever calls
// EXISTING endpoints, which still run every skills.js dig check (dig zones,
// no-go zones, depth gate) exactly as a driver-issued call would. What's
// lifted is the overseer's own blanket refusal to hand a miner that work
// automatically — not any world-safety check underneath it, and BOTS[]
// itself for Thak/Durk/Mog is not edited by this change (still no /mine
// there — still the final fallback when no goal is eligible).
//
// cave/goal-picks.jsonl (one line per goal the engine actually fires, any
// bot) is the audit trail for this policy: "did the engine send a miner
// mining, and why" reads that file, not this log.
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

// ---------------------------------------------------------------------------
// GOAL ENGINE (2026-09-01) — see the header POLICY block above for what this
// lifts and why. Tried in tick(), BEFORE the BOTS[].defaults fallback below;
// that fallback is unchanged and still fires whenever nothing here is
// eligible. goals.json is curator-edited by hand and mtime-cached here so
// edits land live, no overseer restart needed — see loadGoals().
//
// Per-bot in-memory tracking lives on the SAME `state` Map every other
// per-bot field already uses (idleSince, lastPos, ...): s.activeGoalId /
// s.activeGoalTaskId (the goal + task this bot is currently running, if
// any) and s.lastGoalId (the last goal id actually fired for this bot, for
// the anti-repeat pick below). All reset to undefined across an overseer
// restart, by design — reconcileGoalClaims()'s file-based stale-claim sweep
// is what stays correct across a restart, not this in-memory state.
// ---------------------------------------------------------------------------
const GOALS_FILE = path.join(HERE, 'goals.json')
const GOAL_PICKS_FILE = path.join(HERE, 'goal-picks.jsonl')
const GOAL_ZONE_PAD = 24 // requires.nearZone: "within ~24 blocks of that zone's box"
const STALE_CLAIM_MS = 5 * 60_000 // restart-safety unclaim threshold

// requires.minDurability checks THIS tool for THIS goal kind — mirrors
// skills.js's own ensureTool() kind vocabulary (pickaxe|axe are the only two
// it understands). A goal kind with no entry here can never satisfy a
// minDurability requirement: no known tool to check means "not eligible",
// never "assume it's fine".
const GOAL_TOOL_KIND = { mine: 'pickaxe', branchmine: 'pickaxe', staircase: 'pickaxe', chop: 'axe' }

let goalsCache = { mtimeMs: 0, data: { goals: [] } }
let goalsLoadErrLogged = false
// mtime-cached load — cheap enough to call every tick per bot; only actually
// re-reads+re-parses when the file's mtime moved since the last good load.
// Missing/corrupt file: keeps serving the last-known-good cache (starts as
// {goals:[]}, so a fresh checkout or a mid-edit save never breaks boot).
function loadGoals() {
  try {
    const fst = fs.statSync(GOALS_FILE)
    if (fst.mtimeMs !== goalsCache.mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'))
      if (!parsed || !Array.isArray(parsed.goals)) throw new Error('missing/invalid "goals" array')
      goalsCache = { mtimeMs: fst.mtimeMs, data: parsed }
      goalsLoadErrLogged = false
      log(`goals.json reloaded (${parsed.goals.length} goal(s))`)
    }
  } catch (e) {
    if (!goalsLoadErrLogged) {
      log(`goals.json load failed (${e.message}) — using last-known-good (${goalsCache.data.goals.length} goal(s))`)
      goalsLoadErrLogged = true
    }
  }
  return goalsCache.data
}

// Read-modify-write with a dirty-check: reloads fresh from disk right before
// mutating, so a concurrent lead edit landed between our last read and now
// is never clobbered by writing back a possibly-stale in-memory copy.
// `mutate(fresh)` mutates in place and returns whether anything changed;
// only then does this write, and only the freshly-reloaded object — never
// the caller's own possibly-stale snapshot.
function mutateGoalsFile(mutate) {
  let fresh
  try {
    fresh = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'))
  } catch (e) {
    log(`goals.json write skipped: reload failed (${e.message})`)
    return false
  }
  if (!fresh || !Array.isArray(fresh.goals)) {
    log('goals.json write skipped: invalid shape on reload')
    return false
  }
  if (!mutate(fresh)) return false
  try {
    fs.writeFileSync(GOALS_FILE, JSON.stringify(fresh, null, 2) + '\n')
    const fst = fs.statSync(GOALS_FILE)
    goalsCache = { mtimeMs: fst.mtimeMs, data: fresh }
  } catch (e) {
    log(`goals.json write failed (${e.message})`)
    return false
  }
  return true
}

function claimGoal(goalId, botName) {
  // Deficit-generated (dynamic) ids never exist in goals.json — nothing to
  // read-modify-write there. Their claim state lives in dynamicClaims
  // instead (module-scope Map, see the DEFICIT ENGINE block below) so a
  // second idle bot can't also pick up the same synthesized goal this tick.
  if (!isStaticGoalId(goalId)) {
    if (dynamicClaims.has(goalId)) return false
    dynamicClaims.set(goalId, botName)
    return true
  }
  let ok = false
  mutateGoalsFile((fresh) => {
    const g = fresh.goals.find((x) => x.id === goalId)
    if (!g || g.claimedBy) return false
    g.claimedBy = botName
    g.claimedAt = new Date().toISOString()
    ok = true
    return true
  })
  return ok
}

function unclaimGoal(goalId, expectBotName) {
  if (!isStaticGoalId(goalId)) {
    if (dynamicClaims.get(goalId) === expectBotName) dynamicClaims.delete(goalId)
    return
  }
  mutateGoalsFile((fresh) => {
    const g = fresh.goals.find((x) => x.id === goalId)
    if (!g || g.claimedBy !== expectBotName) return false
    delete g.claimedBy
    delete g.claimedAt
    return true
  })
}

function removeGoal(goalId, expectBotName) {
  // Dynamic ids have nothing to splice out of a file — every entry
  // dynamicGoals() produces is repeat:true, so this branch isn't expected to
  // be reached for one in practice, but it stays a safe release-only no-op
  // rather than a file-mutate that silently finds nothing, should that ever
  // change.
  if (!isStaticGoalId(goalId)) {
    if (dynamicClaims.get(goalId) === expectBotName) dynamicClaims.delete(goalId)
    return
  }
  mutateGoalsFile((fresh) => {
    const idx = fresh.goals.findIndex((x) => x.id === goalId)
    if (idx === -1 || fresh.goals[idx].claimedBy !== expectBotName) return false
    fresh.goals.splice(idx, 1)
    return true
  })
}

// ---------------------------------------------------------------------------
// DEFICIT ENGINE (2026-09-01, stage 2) — reads the SAME cave/ledger/*.jsonl
// files ledger.mjs prints from (per-bot DEPOT lines, {ts,bot,delta,item,
// chest}) and sums every parsed delta per item to get a banked-stock number.
// Pure read + arithmetic over files already on disk, no bot dispatch, no
// network call — genuinely "milliseconds" per the design brief, even summed
// fresh every call. Cached SHORT (DEFICIT_CACHE_MS) purely to avoid
// re-reading the same six-ish small files once per bot per 30s poll tick
// (8x redundant reads); this is a plain TTL, not an mtime-cache like
// loadGoals() — ledger files are appended by several bot processes, and
// "close enough to live" is all the deficit math needs.
//
// STOCK_TABLE — hard floor (min) below which an item counts as deficient at
// all, and a target used only to SCALE priority once it is:
//   severity = (target - current) / target
// current can go negative in practice (a bot withdrew more than the ledger
// ever saw deposited, e.g. before the ledger existed — see cobblestone/
// oak_planks/stick in the live sample) — that's fine, it just makes
// severity > 1, i.e. even more urgent. Never clamped.
const STOCK_TABLE = {
  iron_ingot: { min: 64, target: 280 }, // iron chain needs a deep buffer, not just the floor
  coal: { min: 64, target: 64 },
  torch: { min: 64, target: 64 },
  oak_planks: { min: 64, target: 64 },
  oak_log: { min: 64, target: 64 },
  stick: { min: 32, target: 32 },
  bread: { min: 40, target: 40 },
  cobblestone: { min: 128, target: 128 },
  oak_sapling: { min: 16, target: 16 },
}

const LEDGER_DIR = path.join(HERE, 'ledger')
const DEFICIT_CACHE_MS = 10_000
let bankedStockCache = { computedAt: 0, data: new Map() }

function computeBankedStock() {
  const now = Date.now()
  if (now - bankedStockCache.computedAt < DEFICIT_CACHE_MS) return bankedStockCache.data
  const stock = new Map()
  let files = []
  try {
    files = fs.readdirSync(LEDGER_DIR).filter((f) => f.endsWith('.jsonl'))
  } catch {
    files = [] // no ledger dir yet — every item defaults to 0 banked below,
    // which correctly reads as "deficient" for every STOCK_TABLE entry: fail
    // toward wanting work done, never toward silently assuming plenty banked.
  }
  for (const f of files) {
    let text
    try {
      text = fs.readFileSync(path.join(LEDGER_DIR, f), 'utf8')
    } catch {
      continue // one unreadable bot ledger shouldn't blank out every other bot's numbers
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue // corrupt/partial line — same tolerance ledger.mjs itself uses
      }
      if (typeof e.delta !== 'number' || !e.item) continue // unparsed DEPOT lines carry no delta/item — skip, not zero
      stock.set(e.item, (stock.get(e.item) ?? 0) + e.delta)
    }
  }
  bankedStockCache = { computedAt: now, data: stock }
  return stock
}

// Only the items currently BELOW their hard floor, each carrying the
// severity score used both to scale the one dynamic goal below and (loosely,
// by hand) to pick the static SEED goals' own priority numbers in
// goals.json — see the "note" field on each entry there.
function computeDeficits(stock) {
  const out = []
  for (const [item, { min, target }] of Object.entries(STOCK_TABLE)) {
    const current = stock.get(item) ?? 0
    if (current < min) out.push({ item, current, min, target, severity: (target - current) / target })
  }
  return out
}

// Dynamic (in-memory-only) goal generation. goals.json's static SEED already
// hand-authors the iron chain, torch crafting and cobble mining (their
// priorities are curator-set using the severity formula as a guide, not
// live-recomputed) — see each entry's own "note" field for why those three
// stayed static. Wood is the ONE stock item this stage generates a goal for
// automatically, because it's the one seed item explicitly called out as
// deficit-gated rather than requires-gated ("wood buffer chop, only while
// logs deficit"), and its production action (/chop) has no on-hand-
// ingredient prerequisite to check — it can be regenerated fresh from live
// severity every tick with zero curator upkeep. Other STOCK_TABLE entries
// with no template here (coal is an ingredient of the static goals above;
// saplings/bread have no single-endpoint production action yet) still get
// counted by computeDeficits() for visibility, they just don't synthesize a
// goal — future work, not a gap this stage silently hides.
//
// Claim tracking for these lives ENTIRELY in-memory (dynamicClaims below)
// rather than round-tripping through goals.json like the static claim path:
// there's nothing to persist — these entries don't exist in the file at
// all, they're resynthesized fresh every tick straight from ledger
// arithmetic, and a process restart already wipes dynamicClaims along with
// every other in-memory goal-tracking field (state Map, s.activeGoalId, ...)
// in one consistent sweep. See reconcileGoalClaims' dynamic-goal branch for
// the completion side of this.
const dynamicClaims = new Map() // goalId -> botName, this process's lifetime only
const WOOD_DEFICIT_GOAL_ID = 'deficit-oak_log-chop'

function dynamicGoals() {
  const goals = []
  const woodDeficit = computeDeficits(computeBankedStock()).find((d) => d.item === 'oak_log')
  if (woodDeficit) {
    const priority = Math.min(9, Math.max(1, Math.round(woodDeficit.severity * 8)))
    const claimedBy = dynamicClaims.get(WOOD_DEFICIT_GOAL_ID)
    goals.push({
      id: WOOD_DEFICIT_GOAL_ID,
      priority,
      kind: 'chop',
      params: { count: 8, maxDistance: 48 },
      requires: {},
      repeat: true,
      ...(claimedBy ? { claimedBy } : {}),
    })
  }
  return goals
}

function isStaticGoalId(id) {
  return loadGoals().goals.some((g) => g.id === id)
}

// static-file-wins on id collision (design contract): a curator can define a
// goals.json entry with THIS exact id to override/replace a generated one
// outright (custom params, an added requires clause, whatever) — the static
// entry always shadows the dynamic one, never the reverse.
function mergedGoalsPool() {
  const staticGoals = loadGoals().goals
  const staticIds = new Set(staticGoals.map((g) => g.id))
  return [...staticGoals, ...dynamicGoals().filter((g) => !staticIds.has(g.id))]
}
// ---------------------------------------------------------------------------

let cachedGoalZones = null
function loadGoalZones() {
  if (cachedGoalZones) return cachedGoalZones
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(HERE, 'zones.json'), 'utf8'))
    cachedGoalZones = Array.isArray(parsed?.zones) ? parsed.zones : []
  } catch {
    cachedGoalZones = []
  }
  return cachedGoalZones
}

function withinZonePad(pos, box, pad) {
  if (!pos || !box) return false
  const x1 = Math.min(box.x1, box.x2) - pad, x2 = Math.max(box.x1, box.x2) + pad
  const y1 = Math.min(box.y1, box.y2) - pad, y2 = Math.max(box.y1, box.y2) + pad
  const z1 = Math.min(box.z1, box.z2) - pad, z2 = Math.max(box.z1, box.z2) + pad
  return pos.x >= x1 && pos.x <= x2 && pos.y >= y1 && pos.y <= y2 && pos.z >= z1 && pos.z <= z2
}

// Eligibility filter — a claimed goal (by anyone, including this same bot's
// own in-flight one) is never re-eligible; unclaimed goals still need every
// requires clause satisfied against the bot's OWN already-fetched /status
// (no extra API calls spent per goal candidate).
function goalEligible(g, st) {
  if (g.claimedBy) return false
  const req = g.requires || {}
  if (Array.isArray(req.items)) {
    const counts = new Map()
    for (const it of st.inventory ?? []) counts.set(it.name, (counts.get(it.name) ?? 0) + (it.count ?? 0))
    for (const need of req.items) {
      if ((counts.get(need.name) ?? 0) < need.minCount) return false
    }
  }
  if (req.nearZone) {
    const zone = loadGoalZones().find((z) => z.name === req.nearZone)
    if (!zone || !withinZonePad(st.pos, zone.box, GOAL_ZONE_PAD)) return false
  }
  if (typeof req.minDurability === 'number') {
    const toolKind = GOAL_TOOL_KIND[g.kind]
    if (!toolKind) return false // unknown-tool goal kind: fail safe, not "assume ok"
    const suffix = `_${toolKind}`
    const tool = (st.inventory ?? []).find((it) => it.name.endsWith(suffix) && it.durability)
    if (!tool) return false
    const pctRemaining = 100 * (1 - tool.durability.used / tool.durability.max)
    if (pctRemaining < req.minDurability) return false
  }
  return true
}

// Priority desc, ties broken by id for a fully deterministic order (plain
// array-order "stability" isn't enough once goals.json gets hand-edited).
// Anti-repeat: skip re-picking this bot's immediately-prior goal id when
// another eligible one exists — otherwise a repeat:true goal that stays
// top-priority would monopolize the bot forever even with alternatives free.
function pickGoal(goals, st, s) {
  const eligible = goals.filter((g) => goalEligible(g, st))
  if (eligible.length === 0) return null
  eligible.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (eligible[0].id === s.lastGoalId && eligible.length > 1) return eligible[1]
  return eligible[0]
}

// Every connected tick, running or idle — NOT gated behind the idle
// threshold below, so a goal's completion/abandonment is picked up the very
// next tick after it happens, not delayed until the bot sits idle again.
function reconcileGoalClaims(bot, st, s, now) {
  // Dynamic-goal completion/abandonment: handled here FIRST and separately
  // from the static-file loop below, because a deficit-generated goal can
  // legitimately vanish from dynamicGoals()'s own output mid-flight (the
  // stock it was tracking crosses back above its floor while the bot is
  // still out chopping) — a loop keyed off "goals currently in the pool"
  // would then never see it again and its claim would leak forever. Keying
  // off this bot's own s.activeGoalId instead is correct regardless of
  // whether the goal is still being generated this tick.
  if (s.activeGoalId && !isStaticGoalId(s.activeGoalId)) {
    const gid = s.activeGoalId
    const ct = st.currentTask
    if (ct && ct.id === s.activeGoalTaskId) {
      if (ct.state === 'running') return // still working — nothing else to reconcile this tick
      const cancelled = !!ct.result?.cancelled
      const success = ct.state === 'done' && !cancelled
      log(`${bot.name} goal ${gid} ${success ? 'completed' : cancelled ? 'cancelled' : `failed (${ct.state})`} (deficit-generated)`)
      s.activeGoalId = null
      s.activeGoalTaskId = null
      unclaimGoal(gid, bot.name) // dynamic: release only — nothing to remove from a file
      return
    }
    log(`${bot.name} goal ${gid} claim abandoned (current task no longer matches, deficit-generated)`)
    s.activeGoalId = null
    s.activeGoalTaskId = null
    unclaimGoal(gid, bot.name)
    return
  }

  const goals = loadGoals().goals
  for (const g of goals) {
    if (g.claimedBy !== bot.name) continue
    if (s.activeGoalId === g.id && s.activeGoalTaskId) {
      const ct = st.currentTask
      if (ct && ct.id === s.activeGoalTaskId) {
        if (ct.state === 'running') continue // still working — claim stands
        // cancelCurrentTask (runner.js) marks a /stop'd task state 'done'
        // WITH result.cancelled:true — that is NOT a success, even though
        // the state string says 'done'. Only a real finish with no
        // cancellation flag counts toward repeat:false removal.
        const cancelled = !!ct.result?.cancelled
        const success = ct.state === 'done' && !cancelled
        log(`${bot.name} goal ${g.id} ${success ? 'completed' : cancelled ? 'cancelled' : `failed (${ct.state})`}`)
        s.activeGoalId = null
        s.activeGoalTaskId = null
        if (success && g.repeat === false) removeGoal(g.id, bot.name)
        else unclaimGoal(g.id, bot.name)
        continue
      }
      // Current task no longer matches the one we fired (replaced/relogged
      // out from under us) — treat as abandoned, release the claim.
      log(`${bot.name} goal ${g.id} claim abandoned (current task no longer matches)`)
      s.activeGoalId = null
      s.activeGoalTaskId = null
      unclaimGoal(g.id, bot.name)
      continue
    }
    // Not tracked in-memory this session (fresh process — an overseer
    // restart mid-goal loses activeGoalId). Restart safety: only unclaim
    // once BOTH the claim is stale AND the bot isn't currently running a
    // task of this goal's own kind (a still-running matching task is left
    // alone; an unparseable/missing claimedAt is treated as already-stale).
    const claimedAtMs = g.claimedAt ? Date.parse(g.claimedAt) : NaN
    const ageMs = Number.isFinite(claimedAtMs) ? now - claimedAtMs : Infinity
    const runningSameKind = st.currentTask?.state === 'running' && st.currentTask.kind === g.kind
    if (ageMs > STALE_CLAIM_MS && !runningSameKind) {
      log(`${bot.name} stale claim on goal ${g.id} (${Math.round(ageMs / 1000)}s, no matching running task) -> unclaim`)
      unclaimGoal(g.id, bot.name)
    }
  }
}

// Picks + fires one goal for an idle bot. Same gate the role-default block
// below already relies on (only reachable once `running` was false earlier
// this tick) — never `force`, one commander, unchanged. Returns true iff a
// goal was actually fired (caller falls through to BOTS[].defaults on false).
async function tryFireGoal(bot, st, s) {
  const g = pickGoal(mergedGoalsPool(), st, s)
  if (!g) return false
  if (!claimGoal(g.id, bot.name)) {
    log(`${bot.name} goal ${g.id} claim lost (race/concurrent edit) — skipping this cycle`)
    return false
  }
  const ep = `/${g.kind}`
  const res = await api(bot.port, ep, g.params ?? {})
  if (!res || res.ok === false || res.error) {
    log(`${bot.name} goal ${g.id} fire ${ep} rejected: ${JSON.stringify(res)?.slice(0, 120)} — releasing claim`)
    unclaimGoal(g.id, bot.name)
    return false
  }
  s.activeGoalId = g.id
  s.activeGoalTaskId = res.task?.id ?? null
  s.lastGoalId = g.id
  try {
    fs.appendFileSync(
      GOAL_PICKS_FILE,
      JSON.stringify({
        ts: new Date().toISOString(),
        bot: bot.name,
        goalId: g.id,
        kind: g.kind,
        priority: g.priority ?? 0,
        taskId: s.activeGoalTaskId,
      }) + '\n'
    )
  } catch (e) {
    log(`goal-picks.jsonl append failed: ${e.message}`)
  }
  log(`${bot.name} idle -> goal ${g.id} (${ep}) ${JSON.stringify(g.params ?? {})}`)
  await grey(bot.name, bot.color, `(overseer) idle→goal: ${g.id}`)
  return true
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

  // GOAL ENGINE claim reconciliation — every connected tick, running or
  // idle, so a fired goal's completion/abandonment is caught the tick right
  // after it happens. See the goal-engine section above tick().
  reconcileGoalClaims(bot, st, s, now)

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

  // GOAL ENGINE — tried BEFORE the role-default fallback below, which stays
  // exactly as written, still the final fallback when nothing here is
  // eligible. See the header POLICY block for the miner auto-mine exclusion
  // this lifts at the dispatch layer only (BOTS[].defaults itself is
  // unedited, and no new world-safety logic is added — see that block).
  if (await tryFireGoal(bot, st, s)) { s.idleSince = null; return }

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
