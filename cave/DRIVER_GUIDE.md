# DRIVER_GUIDE.md — for LLM driver agents

You are driving one cavecrew bot through its runner's HTTP API. The runner
(`cave/runner.js`) holds the deterministic loop, the pathfinding, and the
field-quirk workarounds — your job is to issue tasks, watch them resolve,
narrate what's happening in-game, and use judgment when the deterministic
skills aren't enough. Check `CIV.md` for the port registry and roster
before you start: it tells you which port your bot's API is on.

All examples below use `curl.exe` from Windows PowerShell (the `.exe`
suffix matters — plain `curl` is a PowerShell alias for
`Invoke-WebRequest` and does not behave the same way). Replace `3201`
with your bot's actual port from `CIV.md`.

## Poll discipline — read this first

- **Single-poll contract**: every task response from `/status` carries
  its own state and result. You do not need to chain calls — one
  `/status` poll tells you everything about the current task.
- **Poll every 15-30 seconds** while a task is running. Do not poll
  faster than that — you will flood the runner and the log for no
  benefit. A `chop` or `mine` task can legitimately take a couple of
  minutes.
- **One task at a time.** The runner enforces a single-task mutex: if you
  POST a new task while one is already running, you get back `409
  {"error":"busy","currentTask":{...}}`. Either wait for the current task
  to finish, POST `/stop` to cancel it, or add `"force": true` to the new
  request body to cancel-then-start.
- Never spam-loop `/eval` or `/status`. If you're unsure what's
  happening, one `/status` call answers it.

## Escalation rule

If a deterministic skill (`/chop`, `/mine`, `/goto`, etc.) **fails twice
in a row on the same objective**, stop retrying it as-is. Instead:

1. Drop to `/eval` and reason through the problem manually (see below).
2. **Report the quirk to the orchestrator** — what you were trying to do,
   what actually happened, and what worked instead — so it gets coded
   into `skills.js` as a permanent fix. A quirk you work around by hand
   and don't report will bite the next bot too.

## Narration

Narrate every phase of what you're doing **in-game, in English, via
`/chat`** — not just in your own reasoning. Other players (and other
cavecrew bots) should be able to follow along from chat alone: "heading
out to chop wood", "found a cave, mining down", "under attack, falling
back". Keep lines short.

## Conduct rules

- **Never attack players.** `/hunt` only ever targets passive mobs by
  design, but this also applies to anything you do through `/eval` — no
  player-targeting, ever, for any reason.
- **Never touch the other tribe's chests or builds.** The other tribe on
  this server is **FurzFriedrich, MettMarcel, BuddelBernd, KackboonKevin**.
  Their chest depot near the crafting-table cluster around
  **(-3, 111, 4)** is **theirs** — do not open, deposit to, withdraw
  from, or break anything there or anywhere else that looks like their
  build. When in doubt, back off and ask in chat rather than guess.
- **Never leave drops on the ground.** Skills already collect
  immediately after felling/mining (rival bots snipe drops within
  seconds) — if you do anything through `/eval` that drops items, follow
  up with `/collect` before moving on. **Standing law: after every
  chop/mine/hunt task, run `/collect {"radius":24}`** as a sweep — 24
  blocks, not the 16 default, so nothing gets left for rivals.
- **Protected blocks — never dug by skills.** `safeDig` (the one
  choke point every `/chop`, `/mine`, `/staircase`, `/branchmine`, etc.
  dig goes through) refuses outright to dig chests, barrels, furnaces,
  crafting tables, beds, anvils, enchanting tables, brewing stands,
  lecterns, composters, or signs — by block **type**, fleet-wide, no
  coordinate list to keep in sync. This is a hard stop, not a skip: a
  task that walks into one of these gets an error, not a silent detour.
  If you need to actually remove one of our own fixtures on purpose, do
  it through `/eval` directly, not through the deterministic skills.
- **Wedge-detection.** If a `/goto` (or any skill built on it) fails
  every retry attempt while a nuisance block — a torch, leaf_litter,
  short_grass, or snow layer — is sitting in the bot's own foot/head
  tile, the skill layer digs just that one block and retries once before
  giving up for real. Travel itself never auto-digs (see Depth law and
  the Movements note below), so a bot wedged on its own just-placed
  torch used to just fail; now it self-clears the narrow, pre-vetted
  nuisance set on its own. That set is ONLY those four zero-collision
  block types — never fences, walls, slabs, stairs, carpets, or anything
  else a build could be made of. If a task still fails after that, the
  block in the way genuinely isn't on the safe-to-clear list — report it
  per the Escalation rule rather than manually digging around it via
  `/eval`.
- **Best tool always equipped.** The skills layer re-equips the correct
  tool before every dig — you don't need to manage this yourself when
  using `/chop`, `/mine`, etc. If you're doing manual digging through
  `/eval`, equip the right tool first.
- **Idle & nag law (two-tier).** If your bot has been idle (no running
  task) for more than **60 seconds**, that's a bug in your loop, not a
  rest break — self-issue the next step from the goal ladder in `CIV.md`
  or your workstation assignment (see Anti-clump below) immediately,
  don't wait to be asked. Separately, if **you as a driver** have gone
  quiet — no `/status` poll, no `/chat` narration, nothing — for **5+
  minutes**, that's nag-worthy: the senior driver / team-lead should ping
  you, and if you're the one who notices another driver has gone quiet
  that long, ping them. The two timers are independent: a bot can be
  correctly mid-task (not idle) while its driver is still expected to be
  actively polling/narrating, not silent for 5+ minutes.
- **Anti-clump — per-bot workstations.** Each bot has a home working area
  so the crew spreads out instead of stacking on one spot:
  Grog = house site (20, 89, 58); UngaBunga = trading post ~(3, 95, 22);
  Thak = mine field (24, 90, 64); Bonk = door staging (10, 90, 61);
  Zug = farm (8-11, 58-59). When your goal doesn't pin you elsewhere,
  default back to your own workstation rather than following the crowd.
  If you notice multiple bots stacked on the same block with no shared
  task reason, that's the anti-clump law being violated — one of you
  should move.
- **Watching ≠ working.** Standing near another bot while it does
  something is not itself work, and doesn't exempt your bot from the
  idle law above. If you're not issuing your own task, you're idle — act
  accordingly (self-issue the next step) even if the scene looks busy
  because a neighbor bot is active.
- **Ground-truth verify.** Before reporting a step "done" — in chat, to
  the team-lead, or in a doc update — confirm it against actual state
  (`/status`, `/eval` reading real inventory/position/blocks), not
  against your own or another bot's chat narration. Narration can lag or
  be wrong; the world state via the API is the source of truth.
- **Equality doctrine.** All five bots are equally cavecrew. No bot's
  task, goal, or driver outranks another's by default — conflicts (e.g.
  two bots wanting the same resource/spot) get resolved by the team-lead,
  not by whichever bot claims priority first.
- **Depth law — SOLVED.** `buildStaircase` and `branchMine` are both live
  on the runner (see below). Deep ore goes through that pair only. Do not
  `/mine` raw ore more than **4 blocks below your own feet** by hand —
  that's how bots fall into ravines and lava pockets. Staircase down
  properly first.
- **Trade etiquette.** If another player (especially the neighbor tribe)
  offers a trade, only ever take the items they actually offered — never
  grab extra out of an open chest or inventory. Send a `DEPOT`-style
  chat line recording what was traded so it's auditable. Compliments in
  chat go over well with **KackboonKevin** specifically — a friendly
  line costs nothing and has smoothed past interactions.
- **Trading post protocol.** Full trading-post layout (chest positions,
  which chest is CAVE's vs FEL's, the `TRADE take X leave Y` chat-line
  format) lives in `TRADE.md` — read it before driving any trade-post
  task, don't improvise the protocol from this file alone.
- **tp-rescue policy.** If a bot is stuck, lost, or in danger it can't
  path itself out of (lava-adjacent, walled in, falling through a
  ravine), the team-lead can `/tp` it to safety via RCON as a last
  resort. This is a rescue tool, not a shortcut for normal travel — use
  `/goto` for everything routine, and report the stuck condition per the
  escalation rule so the underlying pathing bug gets fixed.
- **Blink protocol.** A bot that visibly teleports/snaps position in
  chat or logs without a `/tp` rescue in play (position jump with no
  corresponding `/goto` completion or death) is "blinking" — treat it as
  a connection/desync symptom, not normal movement. Check `/status` for
  `connected: true` and a sane `pos`, and `/relog` if anything looks off,
  per the Disconnect protocol below.
- **Plugin-first doctrine.** Prefer a maintained mineflayer plugin over
  hand-rolled `/eval` logic whenever one exists for what you need
  (pathfinding, auto-eat, web-inventory, etc.) — plugins are vetted once
  and reused, hand-rolled `/eval` code is a one-off that has to be
  re-derived and re-debugged every time. Reach for `/eval` only when no
  plugin covers the need, per the Escalation rule above.
- **Build standards.** When constructing camp structures (walls, roofs,
  staging), follow the established look: **log pillars** at corners,
  **plank infill** for walls, **windows** left as gaps (or glass if
  available) rather than solid walls throughout, and a **rimmed roof**
  (roof edge one block higher than the field, like a lip) rather than a
  flat plane. Matches the style UngaBunga used for the original camp
  shelter (now removed — see `CIV.md` state refresh — but the standard
  still applies to any rebuild).
- **Signs-for-labeling law.** Label camp fixtures — chests, crafting
  tables, staging areas — with a physical oak_sign where placement
  actually works. Where sign placement fails (see the sign-on-chest
  quirk logged in `CIV.md` under Trading post — `blockUpdate` timeout,
  target block stays `air`), fall back to chat + a note in `CIV.md`/
  `TRADE.md` instead of retrying indefinitely; report the placement
  failure per the escalation rule so it gets a real fix.
- **Chat tiers (grey / white / rainbow) — now auto-classified.** The
  default `/chat` style (`"talk"`, or no `style` at all) routes through
  the runner's `smartChat`: a line starting with `!` is stripped of the
  `!` and sent as **important white** real chat; a line starting with a
  protocol-ledger prefix (`DEPOT `, `TRADE `, `USING `, `FREE `,
  `LEASE-BREAK `, `BASE `, `CLAIM `, `HELLO `, `OFFER `) is sent
  **verbatim as real white chat**, unchanged, because other bots/tribes
  parse chat for those exact prefixes; everything else becomes **grey**
  routine narration automatically. You don't need to pick a style for
  ordinary narration ("heading out to chop wood") or for a DEPOT ledger
  line — just `/chat` it and the classification happens for you. Use
  `"style":"status"` to force grey regardless of content, or
  `"style":"rainbow"` for tribe-wide proclamations (a goal-ladder
  milestone, a new pact like the trading post no-touch exception).

## DEPOT ledger

Once cavecrew has its own chests (goal ladder step 6 in `CIV.md`), every
deposit or withdrawal against a cavecrew chest gets a chat line so the
whole tribe can follow the ledger by reading chat:

```
DEPOT +N item (chest X)
DEPOT -N item (chest X)
```

`N` is the count, `item` the item name, `X` identifies which chest (a
short label or coordinate). Example:

```
DEPOT +64 cobblestone (chest A)
DEPOT -8 iron_ingot (chest A)
```

Send this line via `/chat` yourself right after a `/deposit` or
`/withdraw` call succeeds.

## Panic reflex (automatic)

The runner watches health at game-packet speed, not driver-poll speed:
if health drops below **8**, it fires automatically — no `/chat` or
`/stop` from you required. It aborts the current task, announces
`!HP <n>/20 - breaking off, reacting to danger!` (real white chat), and
then either **flees to camp** (if reasonably close and shallow) or
**seals itself in place and eats** (if far from camp or deep below it —
a blind flee across unknown terrain is riskier than holing up). This is
debounced 30s so it won't refire on every low-health tick. Check
`/events` for a `panic` entry and `/status` afterward — the panic
response runs as a normal task (`kind: "panic-response"`), so it shows
up like anything else. Treat a panic firing as a real incident worth a
`/status` check and a chat narration of what you find, same as any other
unexpected task failure.

## Death protocol

- A death **aborts the current task** — whatever was running is over,
  don't assume it resumes on respawn.
- `GET /status` carries a `deathCount` field. Check it after any
  unexpected task failure or gap in `/events` — a jump means the bot
  died and respawned since you last looked.
- After a death, if the bot lost its kit (tools/armor), run a `/recover`
  kit run: get back to camp/depot, `ensureTool` (see below) the essentials
  back into hand, and only then resume the goal you were on.
- Poisoned targets (mobs/blocks flagged poisonous by the runner) are
  **auto-skipped** by the skills layer — you don't need to detect these
  yourself, but don't fight the skip by manually targeting them through
  `/eval`.

## Disconnect protocol

- If the bot has dropped off the server, endpoints return **503** while
  it's offline — that's the signal, not a bug to route around.
- First aid: `POST /relog` (reconnects the bot). Try this before
  anything else.
- If `/relog` doesn't bring it back and you hit a **second** disconnect
  in the same session, **report it** to the team-lead rather than
  looping `/relog` indefinitely — two disconnects in a row usually means
  something upstream (server restart, kick, crash) that a driver can't
  fix alone.

## Structured mining (buildStaircase → branchMine)

This pair of skills is **live on the runner** — the depth law is solved.
This is the required pattern for any real ore run.

1. `POST /buildStaircase` to descend safely to target depth (torches +
   safe steps, not a raw dig-down).
2. `POST /branchMine` from the bottom of the staircase to sweep ore
   bands at that depth (branches off a central shaft, standard
   strip-mining pattern).
3. Only fall back to plain `/mine` for shallow, surface-adjacent blocks
   — not for anything past the 4-block depth law above.

Exact body shapes for `/buildStaircase` and `/branchMine` — check
`/status` or ask the team-lead if the runner's response shape isn't
obvious from a first call; document what you learn back to `CIV.md` or
`skills.js` per the escalation rule.

## ensureTool (auto tool chain)

Skills that need a specific tool call `ensureTool` internally. When your
bot's inventory doesn't have the right tool:

1. It checks current inventory first — no wasted trip if you already
   have it.
2. If missing, it goes to the depot at **(11, 89, 55)** and withdraws
   the tool if the chest has one — sends the `DEPOT -N item (chest X)`
   ledger line for you.
3. If the depot doesn't have it either, it walks the **craft chain**:
   gather/withdraw materials → craft table if needed → craft the tool.

You don't need to drive this by hand — it's automatic inside `/chop`,
`/mine`, `/buildStaircase`, `/branchMine`, etc. Just expect a task to
take longer than usual the first time a bot needs a new tool tier.

## placeBlock — slow confirm

`placeBlock` (used internally by staircase/shelter skills, and via
`/eval` if you call it directly) confirms placement **slowly** — the
runner waits for the block-update packet before considering it done
rather than assuming success the instant the packet is sent. Don't treat
a pause here as a hang; give it a few extra seconds before you decide
something's wrong and escalate.

## Team tags

Each bot is on its own colored in-game team, named `cave_<name>` (e.g.
`cave_Grog`, `cave_UngaBunga`, `cave_Zug`), with chat prefixed `[CAVE]`
so tribe members are visually distinguishable from the neighbor tribe at
a glance. When a **new bot** joins the roster, it needs its team created
and joined via RCON before it's doing real work:

```powershell
node swarm\rcon.mjs "team add cave_<Name>"
node swarm\rcon.mjs "team join cave_<Name> <Name>"
```

Run these from `C:\Users\phili\tools\minecraft-mcp-v2`. Add the new
bot's name and port to the roster table in `CIV.md` at the same time.

## Engine choice on `/goto`

`engine` on `/goto` currently defaults to the runner's own pick (see
`GET /status`'s `"engine"` field) but you can force it: `"pf"`
(pathfinder) or `"ash"` (ashfinder). As of now, **`pf` is measured
faster on open ground** — prefer it for camp-to-camp or surface travel.
`ash` remains an option worth trying for tight cave/underground
navigation where pathfinder struggles. A proper safety A/B between the
two engines is **pending** — don't treat either as fully vetted yet, and
report any stuck/unsafe pathing back per the escalation rule regardless
of which engine you used.

## API reference

Base URL for every endpoint: `http://127.0.0.1:<port>` — bind is
loopback-only, this is not reachable off the machine.

### `GET /status`

Poll this to check on the current (or last) task and vitals.

```powershell
curl.exe -s http://127.0.0.1:3201/status
```

Response shape:

```json
{
  "name": "UngaBunga",
  "connected": true,
  "pos": { "x": 12.5, "y": 64, "z": -8.1 },
  "health": 20,
  "food": 18,
  "gamemode": "survival",
  "inventory": [{ "name": "oak_log", "count": 6 }],
  "currentTask": {
    "id": "task-17",
    "kind": "chop",
    "state": "running",
    "detail": "chopping tree 3/8",
    "result": null
  },
  "lastError": null,
  "engine": "auto"
}
```

`currentTask.state` is one of `running`, `done`, `failed`. `result`
carries the task's return value once it's `done`, or a failure summary
once `failed`.

### `POST /goto`

Looping goto — re-issues the pathfinder goal internally up to 5 times on
timeout before giving up. You don't need to retry this yourself.

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/goto `
  -H "Content-Type: application/json" `
  -d '{"x":100,"y":64,"z":-40,"range":1,"timeoutMs":45000}'
```

Body: `{x, y, z, range?=1, timeoutMs?=45000, engine?}`. `engine` is
optional — `"auto"` (tries ashfinder, falls back to pathfinder), `"ash"`
(ashfinder only), or `"pf"` (pathfinder only). Omit it to use the runner's
own default (see `GET /status`'s `"engine"` field).

### `POST /chop`

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/chop `
  -H "Content-Type: application/json" `
  -d '{"count":8,"maxDistance":48}'
```

Body: `{count?=8, maxDistance?=48}`.

### `POST /mine`

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/mine `
  -H "Content-Type: application/json" `
  -d '{"block":"stone","count":16,"maxDistance":48}'
```

Body: `{block, count?=8, maxDistance?=48}`.

### `POST /collect`

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/collect `
  -H "Content-Type: application/json" `
  -d '{"radius":16}'
```

Body: `{radius?=16}`.

### `POST /hunt`

Passive mobs only — never players.

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/hunt `
  -H "Content-Type: application/json" `
  -d '{"mob":"cow","count":2}'
```

Body: `{mob, count?=1}`.

### `POST /follow`

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/follow `
  -H "Content-Type: application/json" `
  -d '{"player":"SomePlayer","range":3}'
```

Body: `{player, range?=3}`.

### `POST /deposit`

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/deposit `
  -H "Content-Type: application/json" `
  -d '{"x":10,"y":65,"z":20,"items":["cobblestone"]}'
```

Body: `{x, y, z, items?}` — omit `items` to deposit everything except
tools. Send a `DEPOT +N item (chest X)` chat line per item afterward.

### `POST /withdraw`

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/withdraw `
  -H "Content-Type: application/json" `
  -d '{"x":10,"y":65,"z":20,"items":["iron_ingot"]}'
```

Body: `{x, y, z, items}`. Send a `DEPOT -N item (chest X)` chat line per
item afterward.

### `POST /craft`

Finds a crafting table within 16 blocks and goes to it if the item needs
one.

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/craft `
  -H "Content-Type: application/json" `
  -d '{"item":"wooden_pickaxe","amount":1}'
```

Body: `{item, amount?=1}`.

### `POST /chat`

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/chat `
  -H "Content-Type: application/json" `
  -d '{"message":"heading out to chop wood"}'
```

Body: `{message, style?}`. `style` defaults to `"talk"`, which now
auto-classifies via the runner's `smartChat` — see Chat tiers above:
`!`-prefixed and protocol-ledger-prefixed (`DEPOT `/`TRADE `/`USING `/
`FREE `/`LEASE-BREAK `/`BASE `/`CLAIM `/`HELLO `/`OFFER `) lines go out
as real white chat verbatim, everything else becomes grey narration
automatically. Pass `"style":"status"` to force grey, `"fancy"` for a
gold accent, or `"rainbow"` for a tribe-wide proclamation.

### `POST /autoeat`

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/autoeat `
  -H "Content-Type: application/json" `
  -d '{"on":true}'
```

Body: `{on: boolean}`. Returns `204` with a note in the body if the
`mineflayer-auto-eat` plugin isn't loaded on this runner.

### `POST /stop`

Cancels whatever the bot is currently doing, cleanly. No body needed.

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/stop
```

### `POST /eval`

Escape hatch. Runs your `code` as the body of an async function with
`(bot, mcData, skills, log)` in scope; return a JSON-safe value.

```powershell
curl.exe -s -X POST http://127.0.0.1:3201/eval `
  -H "Content-Type: application/json" `
  -d '{"code":"return { pos: bot.entity.position, held: bot.heldItem?.name };"}'
```

Body: `{code}`. Errors come back as `{"error": "..."}` rather than
throwing across the HTTP boundary. There's a 10s soft timeout — if your
code is still running past that, the response will note it's still in
flight rather than blocking forever. Use this for anything the fixed
skills don't cover, and remember the escalation rule above: if you had to
reach for `/eval` because a skill failed twice, report it.

### `GET /events?since=<n>`

Ring buffer (last 500) of notable events: chat heard, health drops,
death, kicked, task transitions, quirk hits.

```powershell
curl.exe -s "http://127.0.0.1:3201/events?since=0"
```

Response: `{"events":[{"seq":1,"ts":"...","type":"chat","msg":"..."}],
"last":42}`. Pass the last `seq` you've seen as `since` next time to get
only what's new.

## More info

- Port registry, roster, naming scheme, base location, goal ladder:
  `CIV.md`.
- What `cave/` is and how to start/stop bots from outside the runner:
  `README.md`.
