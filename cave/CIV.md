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

## Roster

| Name      | Port | Role | Status  |
|-----------|------|------|---------|
| UngaBunga | 3201 | TBD  | planned |

Status values: `planned` (named + ported, not yet spawned), `active`
(spawned and working), `idle` (spawned, no current task), `stopped`
(spawned before, cleanly stopped), `dead` (crashed / needs a driver to
check logs and restart via `spawn.mjs`).

## Base location

TBD. Nothing claimed yet. First driver to establish a base should record
its coordinates here and update the goal ladder below.

## Goal ladder

Progress the tribe as a whole, in order:

1. **Wood age** — punch/chop starter wood, craft a crafting table and
   basic wood tools.
2. **Stone age** — stone tools, a furnace.
3. **Iron age** — mine and smelt iron, iron tools and armor.
4. **Farm** — a sustainable food source (crops and/or animal pen).
5. **Base** — a claimed, defensible build at the base location above.
6. **Depot** — cavecrew's own chest storage with a ledger. See
   `DRIVER_GUIDE.md` for the `DEPOT +N item (chest X)` / `DEPOT -N item
   (chest X)` chat-line ledger format once cavecrew has chests of its own.

## Neighbors (not cavecrew)

Another tribe shares this server: **FurzFriedrich, MettMarcel,
BuddelBernd, KackboonKevin**. Their chest depot near the crafting-table
cluster around **(-3, 111, 4)** is theirs — see `DRIVER_GUIDE.md` for the
full conduct rules around them.
