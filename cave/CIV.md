# CIV.md — cavecrew tribe state

The single source of truth for who cavecrew is, where it lives, and what
port each bot answers on. Drivers and orchestrator both read this before
starting or addressing a bot. Keep it up to date by hand — `spawn.mjs list`
shows live process state, this file records the tribe's plan.

## Naming scheme

Bot usernames must be:

- Stupid/funny caveman names — the dumber the better (`UngaBunga`,
  `GrogSmash`, `Thak`, `Blorp`, `Zug`).
- `<= 16 characters` (Minecraft username limit).
- Characters restricted to `[A-Za-z0-9_]` only.

Pick a new name from this scheme for every bot added to the roster below.

## Port registry

cavecrew owns the range **3200-3299** on `127.0.0.1` for bot HTTP APIs.
Never assign a port outside this range, and never reuse a port that is
already claimed in the roster below (even if that bot is currently
stopped) — pick the next free port in the range instead.

| Port | Bot         |
|------|-------------|
| 3201 | UngaBunga   |
| 3202 | Grog        |
| 3203 | Zug         |
| 3204 | Bonk        |
| 3205 | Thak        |
| 3206 | Ook         |
| 3207 | Durk        |
| 3208 | Mog         |
| 3298 | (reserved: short-lived test bots, e.g. PebbleZoom) |

## Roster

RELAUNCH 2026-09-01: fleet was fully logged out at safe spot (17,96,47),
homes unset, old roles dissolved (chief decree). Re-learning ramp per
LAUNCH.md — bots come back online one at a time as confidence builds.
Roles get reassigned fresh by the orchestrator as each bot boots.

| Name      | Port | Role                        | Driver          | Status | Workstation                     |
|-----------|------|-----------------------------|-----------------|--------|----------------------------------|
| UngaBunga | 3201 | ramp scout (re-learn)       | UngaBungaDriver | active | camp yard (12, 90, 52)           |
| Grog      | 3202 | unassigned (relaunch)       | —               | stopped | —                                |
| Zug       | 3203 | unassigned (relaunch)       | —               | stopped | —                                |
| Bonk      | 3204 | unassigned (relaunch)       | —               | stopped | —                                |
| Thak      | 3205 | unassigned (relaunch)       | —               | stopped | —                                |
| Ook       | 3206 | unassigned (relaunch)       | —               | stopped | —                                |
| Durk      | 3207 | unassigned (relaunch)       | —               | stopped | —                                |
| Mog       | 3208 | unassigned (relaunch)       | —               | stopped | —                                |

Per-bot workstations exist so bots spread out rather than clump on one
spot — see Anti-clump law in `DRIVER_GUIDE.md`. A bot working away from
its listed workstation isn't automatically wrong (goals move), but if
several bots end up stacked on the same block for no reason, that's the
anti-clump law being violated — spread back out.

Standing driver rules (user law):

1. Idle/nag law: bot idle >60s → driver issues the next step itself;
   if the driver has gone quiet with nothing running for 5+ minutes,
   that's a nag-worthy silence — ping the senior driver / team-lead.
   See Idle & nag law in `DRIVER_GUIDE.md` for the full two-tier detail.
2. After every chop/mine/hunt task, run `/collect {"radius":24}` sweep —
   no drops left.
3. Death aborts the current task; check `deathCount` in `/status` after
   any surprise failure; `/recover` for kit runs after a death that lost
   gear; poisoned targets are auto-skipped by the skills layer.
4. Disconnect shows as `503` on every endpoint; `/relog` is first aid;
   two disconnects in a row → report to team-lead, don't loop `/relog`.
5. Depth law: **SOLVED** — deep ore goes through `buildStaircase` →
   `branchMine` only, both live on the runner. No raw `/mine` more than
   4 blocks below feet.
6. Trade etiquette: only take what's offered, log it with a `DEPOT`-style
   chat line, compliments go over well with KackboonKevin specifically.
7. Anti-clump: spread out to your workstation (roster table above)
   rather than stacking on one spot.
8. Watching ≠ working: a bot standing near another bot's task isn't
   "helping" unless it's actually issuing its own task — idle law still
   applies to it.
9. Ground-truth verify: confirm state via `/status`/`/eval` (actual
   inventory, actual position, actual block) before reporting something
   done — don't take another bot's or your own chat narration as proof.
10. Signs-for-labeling law: label camp fixtures (chests, stations) with
    physical signs where placement works, chat + `CIV.md` otherwise (see
    the sign-on-chest quirk logged under Trading post above).
11. Equality doctrine: all bots are equally cavecrew — no bot's
    output/goal outranks another's without team-lead say-so.

Full detail on all of the above, plus build standards, chat tiers,
plugin-first doctrine, and the blink/tp-rescue protocols: `DRIVER_GUIDE.md`.

Drivers are sonnet teammates in the orchestrator session; senior driver:
GrogDriver. Orchestrator (team-lead) sets big goals.

## Team tags

Each bot runs on its own in-game team, `cave_<name>`, chat prefixed
`[CAVE]`, so tribe members read at a glance against the neighbor tribe.

| Bot       | Team          |
|-----------|---------------|
| UngaBunga | cave_UngaBunga|
| Grog      | cave_Grog     |
| Zug       | cave_Zug      |
| Thak      | cave_Thak     |
| Bonk      | cave_Bonk     |
| Ook       | cave_Ook      |

A newly added bot needs its team created and joined via RCON
(`node swarm\rcon.mjs "team add cave_<Name>"` then
`"team join cave_<Name> <Name>"`, from
`C:\Users\phili\tools\minecraft-mcp-v2`) before it starts real work —
add it to this table and the port registry/roster above at the same
time.

Status values: `planned` (named + ported, not yet spawned), `active`
(spawned and working), `idle` (spawned, no current task), `stopped`
(spawned before, cleanly stopped), `dead` (crashed / needs a driver to
check logs and restart via `spawn.mjs`).

## Base location

Cavecrew camp centered around **(11-12, 89, 55-57)**. Crafting table at
(12, **89**, 56) — re-corrected 2026-09-01 post-relaunch: UngaBunga
ground-truthed table at y=89, (12,88,56) is air. (The earlier "y=88"
correction no longer matches the world — table was evidently re-placed.)
Depot chest A (wood) at (11, 89, 55) [placed by UngaBunga], depot chest B
(tools) at (12, 90, 54) [placed by UngaBunga 2026-08-31]. South of world
spawn, away from the other tribe's build near (-3, 111, 4).

**State refresh 2026-09-01**: the shelter (perimeter wall + roof) was
**removed by the user** — camp is currently open-air again, wall/roof
goal below no longer reflects reality until it's rebuilt. The furnace at
(11, 89, 57) was **destroyed** — rebuild pending, nobody assigned yet.
Camp signs have been placed (labeling depot chests/crafting table area,
see Signs law below). There is a **mystery chest at (-1, 91, 56)** of
unknown origin — **do not open, deposit to, or withdraw from it** until
someone identifies whose it is.

**Grove** (tree farm patch): planted DONE near **(8, 91, 68)** by
UngaBunga 2026-08-31 — 6 oak_sapling + 2 birch_sapling in ground,
spaced ~2 blocks apart on grass. Let grow before harvesting.

**New bot note 2026-09-01**: Ook (hunter) spawned in at (-6.5, 111, 3.5) —
right on top of the FEL base coord (-3, 111, 4), not near cavecrew spawn.
Inventory was empty on wake so no touch risk, but OokDriver moved it out
carefully (no digging, nothing held) before doing anything else. If a
future bot spawns near FEL territory again, same drill: check inventory
empty, chat announce, move off before any task.

**Mine entrance**: picked by Grog at **(15, 89, 57)** — flat grass/dirt
patch just east of the shelter wall (wall spans x 10-13), right next to
the existing stone-age dig scar from Grog's first mining run. Staircase
goes down from here once `buildStaircase`/`branchMine` lands. **Now
interior to the Mine House (see below)** — stairwell frame goes up once
Thak's shaft is actually cut.

**Mine House** (Grog's build, task #4): 9x7 footprint x13-21, z53-59, east
of the camp furniture cluster. Oak_log corner pillars (4x, 3 high),
oak_planks wall infill, window centered north wall (17,90,53), door
centered south wall (17,89-90,59), stone (cobblestone) flat roof + rim
pending ~99 cobblestone delivery. Interior: chest D (ore) at (14,89,57)
right by the stairwell, chest C (food) at (16,89,54) on the north wall.
Mine entrance (15,89,57) sits inside as the interior stairwell — decreed
option (a), house swallows the shaft on purpose.

**Plaza + lamp-posts (proposed, Grog draft 2026-09-01)**: once the FEL-style
plaza goes in under the camp furniture core (~10-13, 89, 54-58), ring it
with 4-6 log lamp-posts (2-high oak_log + torch on top, torch craft AT
TABLE only per the fix). Draft positions, one per side, 1 block outside
the plaza edge so they don't crowd furniture traffic: **(9,89,56)** west,
**(14,89,53)** north, **(14,89,59)** south, and **(9,89,52)** /
**(9,89,60)** as optional NW/SW corner posts if the plaza runs the full
depth. Whoever builds the plaza should adjust these to the actual footprint
once it's staked — these are placeholders based on the current furniture
spread, not a surveyed plan.

## Goal ladder

Progress the tribe as a whole, in order:

1. **Wood age** — punch/chop starter wood, craft a crafting table and
   basic wood tools. DONE.
2. **Stone age** — stone tools, a furnace. DONE (Grog: stone tools +
   furnace at camp).
3. **Iron age** — mine and smelt iron, iron tools and armor. In
   progress (Grog mining coal/iron).
4. **Farm** — a sustainable food source (crops and/or animal pen). In
   progress (Zug hunting; farm later).
5. **Base** — a claimed, defensible build at the base location above.
   Table + depot chest placed. Shelter (perimeter wall + roof, previously
   DONE 2026-08-31) was **removed by the user 2026-09-01** — camp is
   open-air again, rebuild not yet scheduled. Furnace **destroyed**
   2026-09-01 — rebuild pending, nobody assigned. Camp signs placed
   2026-09-01 (see Signs law in `DRIVER_GUIDE.md`). See State refresh
   note above for current condition.
6. **Depot** — cavecrew's own chest storage with a ledger. DONE: chest
   at (11, 89, 55), first deposit logged in chat 2026-08-31 (+14
   oak_log, +24 oak_planks, +6 birch_log). See `DRIVER_GUIDE.md` for
   the `DEPOT +N item (chest X)` / `DEPOT -N item (chest X)` chat-line
   ledger format.

## Trading post

Built by UngaBunga 2026-09-01, flat 3-block ridge at **x=6-8, z=22, y=112**
(the (3,95-100,22) target area turned out to be a hillside, not flat — real
flat spot found ~4 blocks northeast and ~11 blocks up from the original
guess). Layout: WEST chest (6,112,22) = **CAVE shop**, gap (7,112,22) has a
crafting table, EAST chest (8,112,22) = **FEL shop** (left empty for the
other tribe to stock themselves).

CAVE shop seeded 2026-09-01: 20 oak_log + 20 oak_planks + 20 cobblestone.
Cobblestone came from chest B (12,90,54) — chest A (11,89,55) turned out to
hold only birch_log/wheat_seeds/dirt, no oak_log/oak_planks/cobblestone as
expected; oak_log/oak_planks for the shop came from UngaBunga's own carried
stock instead. See DEPOT ledger lines in chat 2026-09-01.

**Trade protocol** (announced in chat, white status + rainbow proclamation,
2026-09-01): the no-touch pact on other-tribe property is **lifted for
these 2 chests only**. Taking from the other shop chest = leave fair pay in
the same chest, log it in chat as `TRADE take X leave Y`. Everywhere else
the other tribe's build (near -3,111,4) is still strictly off-limits.

Quirk: tried to place oak_sign labels on top of both chests (physical
WEST/EAST markers) — failed twice in a row (`bot.placeBlock` reports
`blockUpdate` timeout, and the target block is confirmed still `air`
afterward even past the slow-confirm window). Dropped per escalation rule;
labeling is chat + this doc only for now. Someone should look at whether
sign placement on top of a chest block needs different handling than
placing on a normal solid block.

## Neighbors (not cavecrew)

Another tribe shares this server (remote fleet, grows over time):
**FurzFriedrich, MettMarcel, BuddelBernd, KackboonKevin, PflasterPeter,
BratwurstBodo, KloputzKarl, SoloSauhund** (last two confirmed 2026-09-01
from felcrew repo ledger data; KloputzKarl seen restocking FEL shop with
bread at the trading post). Humans: ZetOmega (our user), Felsenuboot
(their operator). Their chest depot near the crafting-table
cluster around **(-3, 111, 4)** is theirs — see `DRIVER_GUIDE.md` for the
full conduct rules around them.
