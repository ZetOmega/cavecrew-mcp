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
  up with `/collect` before moving on.
- **Best tool always equipped.** The skills layer re-equips the correct
  tool before every dig — you don't need to manage this yourself when
  using `/chop`, `/mine`, etc. If you're doing manual digging through
  `/eval`, equip the right tool first.

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

Body: `{message}`.

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
