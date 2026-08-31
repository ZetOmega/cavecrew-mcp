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
| 3298 | (reserved: short-lived test bots, e.g. PebbleZoom) |

## Roster

| Name      | Port | Role                        | Driver          | Status |
|-----------|------|-----------------------------|-----------------|--------|
| UngaBunga | 3201 | lumber, camp builder        | UngaBungaDriver | active |
| Grog      | 3202 | stone/coal/iron miner       | GrogDriver      | active |
| Zug       | 3203 | food (hunt, later farm)     | ZugDriver       | active |

Standing driver rules (user law): (1) bot idle >3 min → driver issues
next step or pings team-lead — never silent standing; (2) after every
chop/mine/hunt task, run /collect {radius:24} sweep — no drops left.

Drivers are sonnet teammates in the orchestrator session; senior driver:
GrogDriver. Orchestrator (team-lead) sets big goals.

Status values: `planned` (named + ported, not yet spawned), `active`
(spawned and working), `idle` (spawned, no current task), `stopped`
(spawned before, cleanly stopped), `dead` (crashed / needs a driver to
check logs and restart via `spawn.mjs`).

## Base location

Cavecrew camp centered around **(11-12, 89, 55-57)**. Crafting table at
(12, 89, 56), furnace at (11, 89, 57) [placed by Grog], depot chest at
(11, 89, 55) [placed by UngaBunga]. South of world spawn, away from the
other tribe's build near (-3, 111, 4).

**Grove** (tree farm patch): marked spot near **(8, 91, 68)**, already
cleared from UngaBunga's chop run. Pending — no oak_sapling in hand yet
(bad RNG on ~45 leaves punched 2026-08-31); plant here once one drops.

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
   Started: table + furnace + depot chest placed. Shelter: single-layer
   oak_planks perimeter wall around camp DONE (x 10-13, z 54-58, y=90
   atop ground, southeast corner patched over its terrain step), only
   gap is the door at (11, 90, 58) facing south toward the grove. Built
   by UngaBunga 2026-08-31.
6. **Depot** — cavecrew's own chest storage with a ledger. DONE: chest
   at (11, 89, 55), first deposit logged in chat 2026-08-31 (+14
   oak_log, +24 oak_planks, +6 birch_log). See `DRIVER_GUIDE.md` for
   the `DEPOT +N item (chest X)` / `DEPOT -N item (chest X)` chat-line
   ledger format.

## Neighbors (not cavecrew)

Another tribe shares this server (remote fleet, grows over time):
**FurzFriedrich, MettMarcel, BuddelBernd, KackboonKevin, PflasterPeter,
BratwurstBodo**. Humans: ZetOmega (our user), Felsenuboot (their operator). Their chest depot near the crafting-table
cluster around **(-3, 111, 4)** is theirs — see `DRIVER_GUIDE.md` for the
full conduct rules around them.
