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
| 3205 | Thak (RETIRED 2026-09-01 — cutover zu BariThak 3302) |
| 3206 | Ook (RETIRED 2026-09-01 — cutover zu BariOok 3303)   |
| 3207 | Durk        |
| 3208 | Mog         |
| 3200 | Fleet panel (production — `cave/panel.mjs`, chief restarts on deploy) |
| 3290 | Fleet panel (dev instance — `PANEL_PORT=3290`, PanelDev's own smoke-test port) |
| 3291 | Fleet panel — mock runner for button-click testing (never point at 3201-3208) |
| 3298 | (reserved: short-lived test bots, e.g. PebbleZoom) |
| 3301 | BariBrute (baritone heavy-lifter — range 3301-3309, see BARITONE.md) |
| 3302 | BariThak (baritone, ex-Thak — fleet conversion 2026-09-01) |
| 3303 | BariOok (baritone, ex-Ook — fleet conversion 2026-09-01) |

## Roster

RELAUNCH 2026-09-01: fleet was fully logged out at safe spot (17,96,47),
homes unset, old roles dissolved (chief decree). Re-learning ramp per
LAUNCH.md — bots come back online one at a time as confidence builds.
Roles get reassigned fresh by the orchestrator as each bot boots.

| Name      | Port | Role                        | Driver          | Status | Workstation                     |
|-----------|------|-----------------------------|-----------------|--------|----------------------------------|
| UngaBunga | 3201 | lumber, trade voice         | UngaBungaDriver | active (reserve) | camp yard (12, 90, 52)  |
| Grog      | 3202 | builder, grand staircase    | GrogDriver      | active | staircase corridor (mine_stair)  |
| Zug       | 3203 | farmer, hunter              | ZugDriver       | active | farm_1 (x7-12, z58-59)           |
| Bonk      | 3204 | path/infra builder          | BonkDriver      | active | trade path z29-22 stretch        |
| Thak      | 3205 | RETIRED (→ BariThak)        | —               | retired | — |
| Ook       | 3206 | RETIRED (→ BariOok)         | —               | retired | — |
| Durk      | 3207 | unassigned (relaunch)       | —               | stopped | —                                |
| BariBrute | 3301 | baritone heavy-lift miner   | BariBruteDriver | active | free-range southeast (baritone)  |
| BariThak  | 3302 | baritone miner (team cave_BariThak joined) | ThakDriver | active | staging → camp (20,90,60) |
| BariOok   | 3303 | baritone long-range scout/hauler (team cave_BariOok joined) | OokDriver | active | recon (252,94,131) — Base 2.0 candidate, killTree crash-loop fixed+RCON-confirmed, board #19/#21 |
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
12. Radio discipline (chief order 2026-09-01): poll interval 30-60s on
    running tasks; message team-lead ONLY on real events — task result
    (with ground-truth numbers), escalation after the retry budget, a
    finding, or danger. Silence = all good. No per-poll status ticks,
    no "holding/waiting" messages.

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

**BASE 2.0 PLAN (chief long-term idea, 2026-09-01)**: relocate the main
base to **~(252, 94, 131)** — east plains, possibly next to a VILLAGE
(unverified, recon running: BariOok vanguard + Bonk survey, board #19/#21).
The hilltop house + farm project (#20/#22) becomes Base 2.0's founding
build if the site verifies. Current camp below stays as mining outpost
(staircase, mine_field, chests) — infra is not abandoned, it becomes the
resource satellite.

Cavecrew camp centered around **(11-12, 89, 55-57)**. Crafting table at
(12, **89**, 56) — re-corrected 2026-09-01 post-relaunch: UngaBunga
ground-truthed table at y=89, (12,88,56) is air. (The earlier "y=88"
correction no longer matches the world — table was evidently re-placed.)
Depot chest A (wood) at (11, 89, 55) [placed by UngaBunga], depot chest B
(tools) at (12, 90, 54) [placed by UngaBunga 2026-08-31]. South of world
spawn, away from the other tribe's build near (-3, 111, 4).

**REBUILT 2026-09-01 by Grog**: the shelter is back — see Goal ladder #5
below and BASE.md `camp_shelter` row for the full build record (footprint,
door, window, roof). Furnace_1 was found already-rebuilt earlier the same
session (ground-truth, not Grog's build — see BASE.md furnace_1 row).
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

> Not the same thing as the overseer's **goal engine** (`cave/goals.json`)
> — that's per-bot auto-dispatch for idle bots (iron chain, torch
> crafting, cobble mining, tool re-kit), tried before the old role-default
> rotation. See DRIVER_GUIDE.md's "Goal-directed idle" section for what it
> means for you as a driver.

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
   DONE 2026-09-01 (Grog): table + depot chest + furnace + shelter (log
   corner pillars, plank walls, window, 2-wide farm-facing door, rimmed
   cobblestone roof) all standing — see BASE.md `camp_shelter` row for
   the full record. Camp signs placed 2026-09-01 (see Signs law in
   `DRIVER_GUIDE.md`).
6. **Depot** — cavecrew's own chest storage with a ledger. DONE: chest
   at (11, 89, 55), first deposit logged in chat 2026-08-31 (+14
   oak_log, +24 oak_planks, +6 birch_log). See `DRIVER_GUIDE.md` for
   the `DEPOT +N item (chest X)` / `DEPOT -N item (chest X)` chat-line
   ledger format.

## Scouting (far-range)

**West corridor, 2026-09-01 (Ook/OokDriver, far meat run + scout, chief's
far-range decree)**: swept x-90..-60 / z20-70 west of camp (camp is x~12),
10 ground-truthed scan points (entity scan radius 48-80, no mobs missed at
range). **Verdict: animal-empty.** Zero pig/cow/sheep/chicken anywhere in
the whole corridor, day time, full render-radius checks. Terrain is
entirely `forest` / `old_growth_birch_forest` hillside (elevation swings
90-103, rugged), not the plains the "pig zone" report implied — that report
doesn't hold up for this stretch. Small water pools noted near (-15,90,56)
and (-56,90,67), nothing bigger. No village, no sand, no sugar cane, no
lava. **Next far-hunt driver: try a different bearing (south or north of
this corridor) rather than re-running x-90..-60 west — this strip is
checked and dry.**

**HAZARD — dripstone cave belt, x~-78 to -90, y47-55, z45-70**: a large
dripstone cavern sits under the west-corridor hillside, skyLight 0, entered
unintentionally via both `pf` and `ash` `/goto` while the target was an
above-ground waypoint (see `FEEDBACK.md` 2026-09-01 Ook entry for the full
pathing/wedge writeup). Got a bot genuinely wedged on pointed_dripstone
blocks for several minutes; self-rescue (manual dig-out) partially worked,
final fix was `/trigger home`. No HP/item loss, but route AROUND this zone
—goto targets in this box should expect to path underground, not across
the hillside surface. Not marked in `BASE.md`'s hazard table since it's
outside the camp/base radius that table tracks, but flagging here for any
bot ranging this direction again.

**South corridor, 2026-09-01 (Ook/OokDriver, standing scout loop leg 1 of 3: south/east/far-SW)**:
swept camp (z~55) south to z~120 (fell short of the z+120=175 target — see hazard note below for
why). Terrain: `forest` climbing into a `grove` (snowy mountain) biome around z=140, elevation
rising steadily from y~104 near camp to y~150 at the grove — this is a mountain range, not open
land. **Verdict: animal-empty again**, zero mobs at every scan point (up to 64 block radius). No
water/sand/cane/village found this leg (one small pool near (9,105,85)). **Not a second-settlement
candidate** — too steep/rocky for a build site as scouted; grove biome at z~140 might be worth a
snow-build novelty later but isn't the animal zone the tribe needs.

**HAZARD — dripstone_caves recurs east of camp too, not just west**: hit the same pf/ash wedge (see
`FEEDBACK.md`) at x~39-43,y106,z95-98, in full daylight — this world's dripstone_caves biome
surfaces at mountain elevation, not just underground. Second confirmed occurrence same session,
different location — treat `dripstone_caves` as a recurring hazard class along the south/southeast
bearing, not a single spot to avoid. Also hit `dripstone_caves` again at (12,150,175)-ish scouted
by height/biome probe (not entered) — the direct south line along x=12 crosses it repeatedly past
z~130, so future south legs should drift x=0 to 20 rather than following x=12 exactly.

**Chest A (11,89,55) is FULL — 27/27 slots**, confirmed by ground-truth `containerItems()` read.
New item-type deposits will silently fail (or path-fail approaching it — the furniture cluster
around it is tight, approach from the north side (~11,89,54) if going). Needs a driver pass to
prune low-value stacks (leaf_litter, gravel, diorite, andesite look prunable) or an overflow chest.
Full item list in the FEEDBACK.md entry.

**EAST — JACKPOT, 2026-09-01 (Ook/OokDriver, plains + fox lead, post-fall-guard)**: the near-death
incident from earlier (see FEEDBACK.md) happened crossing x~100-132/z~50 chasing this exact lead —
returned once the goto vertical-drop guard shipped, careful shorter hops the whole way, zero
incidents this pass. **Found a massive plains biome starting around x~100 and confirmed continuous
out to x~257+ (didn't hit the far edge), roughly z30-180.** This is BOTH the settlement candidate
and the animal zone the tribe needed:
- **Animal density**: at one scan point (205,92,120) counted **9 chickens + 3 pigs** simultaneously
  within a 64-block radius — easily the densest wildlife found anywhere this session (west and
  south legs were both animal-empty). Good breeding-pen candidate clusters: chicken pair at
  ~(183,94,76)/(181,98,58), pig+chicken cluster around x196-236,z33-114, another chicken/pig knot
  further out around x250-257,z100-150 (not fully mapped, extent keeps going).
  - **Hunted 4** (2 chicken, 2 pig) around (180-211,~93,~69-120) — banked chest C: chicken×2,
    porkchop×3 (one extra drop), egg×1, feather×3. `/collect radius24` swept clean both times.
- **Lava found** (Nether prep, board target): a real pool at roughly (96-101, y83-84, z18-23) —
  but it's ~46-56 blocks UNDERGROUND below a mountain (grove/meadow biome surface at y130-140
  there), not surface-accessible. Confirmed via `findBlocks` scan from the surface, not
  eyes-on-entered — reaching it is a staircase/branchmine job, not a scout-goto one. Good target
  once mining infra reaches that direction.
  - Water source further south around (88-95, y65-75, z60-61) — looks like a deep shaft/waterfall,
    also not surface-level, noted but not explored.
- Terrain is flat, walkable, day-lit — genuinely the best-looking second-settlement ground found
  across all three scouted bearings (west = dry hillside, south = dripstone mountains, east =
  plains). Worth a dedicated follow-up: stake a claim, plan a breeding pen at one of the
  chicken/pig clusters above, and a proper mining approach to the lava pool for Nether prep.
- Fox sighted repeatedly at (91,138,19) throughout the day — same individual, north of the plains
  in mountain terrain, note-only per doctrine (not food).

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
UPDATE 2026-09-01 (chief, total de-chat decree): `TRADE` lines route through
`/chat` exactly as before, but per `DRIVER_GUIDE.md`'s Chat tiers section
they now land on the Discord status feed, not public white chat — same
destination move as DEPOT, generalized to every protocol prefix. Rainbow
proclamations for genuine milestones are unaffected (still real chat, by
explicit style choice).

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
