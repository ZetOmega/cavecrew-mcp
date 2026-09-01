# FLEET PANEL

A read-mostly web dashboard for the cavecrew bot fleet. One page, eight cards,
live vitals, and exactly two buttons.

The panel is a plain observer: it speaks the same public HTTP API a driver
speaks (`cave/DRIVER_GUIDE.md`) and knows nothing about runner internals. It
does not import `runner.js`, `skills.js`, or `overseer.mjs`, and it is not part
of the supervision loop — killing it affects nothing.

## Start it

```powershell
node cave/panel.mjs
```

Then open <http://127.0.0.1:3200>.

- **Panel port:** `3200`, bound to `127.0.0.1` only. Not reachable off the
  machine.
- **Runner ports polled:** `3201-3208` by default (the production fleet).
- **Dependencies:** none. Node built-ins only, no `npm install`.

Stop it with Ctrl-C.

### Port override

`CAVE_PANEL_PORTS` replaces the default port list with a comma-separated one:

```powershell
$env:CAVE_PANEL_PORTS = '3209'; node cave/panel.mjs
```

This exists so the two write actions can be exercised against a throwaway test
runner without ever pointing at a production bot a driver owns. Point it at the
test port, click the buttons, confirm the behaviour, then restart without the
variable.

`PANEL_PORT` (default `3200`) runs a second instance of the panel itself on a
different port — for developing the panel against the live, read-only fleet
without ever touching the production process on 3200:

```powershell
$env:PANEL_PORT = '3290'; $env:CAVE_PANEL_PORTS = '3201,3202'; node cave/panel.mjs
```

The Host allow-list is built off `PANEL_PORT`, so a dev instance allow-lists
its own port automatically. `3290` is the registered panel-dev port (see
`cave/CIV.md`'s port registry).

A runner on a port outside the roster shows up under its `/status` name (or
`:PORT` if it is down), and its WAKE button falls back to the universally safe
`/collect {radius: 16}` sweep.

## The two buttons

These are the **only** write actions in the whole panel. There is no RCON, no
chat, no world manipulation, no `/eval`, and no other endpoint that mutates
anything.

### WAKE — shown on idle cards only

Pushes that bot's **role-default task**, mirrored from the `BOTS` list in
`cave/overseer.mjs` (~line 34). Each bot's first default is the one used, so a
click is deterministic:

| Bot | Port | Wake pushes |
| --- | --- | --- |
| UngaBunga | 3201 | `/chop {count: 4, maxDistance: 48}` |
| Grog | 3202 | `/collect {radius: 16}` |
| Zug | 3203 | `/collect {radius: 16}` |
| Bonk | 3204 | `/collect {radius: 16}` |
| Thak | 3205 | `/mine {block: 'coal_ore', count: 4, maxDistance: 28}` |
| Ook | 3206 | `/collect {radius: 16}` |
| Durk | 3207 | `/collect {radius: 16}` |
| Mog | 3208 | `/collect {radius: 16}` |

**Safety rule: `force: false`, always.** The flag is constructed inside
`doWake()` and is never read from the request body — there is no code path in
`panel.mjs` that can send `force: true`. So WAKE can never preempt a driver's
running task. If the runner is busy it answers `409` and the panel reports
`busy, not preempted` under the button, having changed nothing.

The one thing WAKE does interrupt is the runner's own self-issued `idle-guard`
filler task, and that is the runner's behaviour, not the panel's: `startTask()`
in `runner.js` treats any real task as an automatic preemption of idle-guard,
with or without `force`. That is exactly what "wake an idle bot" means.

WAKE also tags the push with `source: 'panel'`, so it shows up as itself in
the runner's own task/event log and the `/status` `currentTask.source` field
— previously indistinguishable from any other unidentified HTTP caller
(runner.js's own fallback is `'http'` when a caller doesn't self-identify).
The dashboard surfaces this as a small "via panel"/"via idle-guard" tag next
to the task's state pill, hidden for the plain `'http'` case since that is
today's common default for undated driver calls, not new information.

A card counts as **idle** — amber border, WAKE button — when it has no current
task, its last task has already finished, or it is only running `idle-guard`.

### STOP — shown on running non-idle tasks only

Forwards `POST /stop` to that bot's runner, which cancels the current task
cleanly. Small and secondary on purpose: it is for calling off work you can see
going wrong, not for routine use. If a driver owns that bot, tell the driver.

## What the page shows

**Header** — `x/8 online`, `y idle`, and total `iron_ingot` across every
inventory against the 360 quota, with a progress bar. The dot on the right
blinks green on each successful poll.

**Cards**, one per port, name tinted its Minecraft team colour:

- connectivity dot, three states: green = bot connected, amber = runner
  process is up but the bot entity isn't (mid-reconnect), grey = runner
  unreachable
- rounded `xyz`, task age (best-effort)
- movement deltas, `Δ30s 12.3 | Δ60s 25.1` (see below)
- health and food as 0-20 bars; health goes amber under 12, red under 6
- current task kind, state, and detail — when the task's `kind` is
  `panic-response` (the runner's own low-health flee/seal reflex taking over,
  see `runner.js`'s `triggerPanic`), the whole card and task box flag red,
  overriding the idle/err border colours. Rarest state a card can be in and
  the one most worth a glance across the room. Persists until the next task
  replaces `currentTask`, same STATUS-HOLD rule `lastError` already follows.
- `deathCount`, last death age (`(3m ago)`, hidden when there is none), the
  runner's `idleGuard` state (`guard on`/muted, `guard off`/amber — off is
  normal while a driver actively drives, see issue #6; older runners without
  the field just omit the chip), and movement engine
- `lastError` in a red box when set
- inventory as compact chips — top 10 stacks by count, with count badges
- a collapsed `▸ events (N)` toggle — click to expand the bot's last ~10
  events, newest first (see Phase 2 ideas below for detail)

Offline runners are tolerated, never fatal: the card dims, the entry is marked
`offline: true` with a reason, and the rest of the fleet renders normally.

**Alerts column** — the tail of the overseer's escalation log merged with every
bot's live `lastError`, newest first.

**Tribe board** — below the fleet grid, full width: `cave/TODO.md`'s work
state, parsed server-side into three groups — DOING and QUEUED always shown,
DONE collapsed behind a `▸ DONE (N)` toggle (same expand motion as a card's
event log). Each row is lane, task text, one chip per name in the `Who`
column (a chip tints to that bot's team colour when the name matches the
roster, plain otherwise — Krug/orchestrator/loose prose render as ordinary
chips, not guessed at), and whatever detail is left in `Status` once the
bucket's own keyword (doing/todo/done) is stripped off (`queued after #5`,
`blocked on cobble`, `law` all survive — they're real information the bucket
label alone doesn't carry). A malformed row (wrong cell count, no `Task`
cell) is counted and skipped rather than guessed at or thrown on; the count
shows in the board's subtitle when non-zero. See `## TODO board` below for
the parsing rules in full.

**Vault** — below the tribe board, full width: `cave/audit-snapshot.json`'s
ground-truth depot ledger (written by `cave/audit.mjs`'s read-only chest
walk). One card per chest — label, coords, item chips in the same style as
a bot's own inventory, total item count — plus the whole snapshot's age up
top, amber past 2 hours. A chest `audit.mjs` failed to read (its `__error`
shape) renders as "read failed: `<message>`" instead of empty/garbage item
chips, with the chest's card border tinted amber. The section is hidden
outright — not shown empty — when the snapshot file has never been written;
"audit never ran yet" is a normal state, not a broken one. Any other read
failure (permissions, corrupt JSON) DOES show the section, with the failure
message where the age would be, since that IS worth noticing. See `## Vault`
below for the field-by-field detail.

Auto-refresh is every 3s and updates the DOM in place — no page reload, no
flicker. Task ages tick locally each second between polls.

## Movement deltas

Each card shows how far the bot actually got in the last 30 and 60 seconds:

```
Δ30s 12.3 | Δ60s 25.1
```

A delta is the straight-line 3D distance between the bot's current position and
its recorded position nearest N seconds ago — endpoint to endpoint, not path
length. That is deliberate: the question being answered is "did it get
anywhere", which is the wedge question, and it costs one square root.

Colours, one decimal place:

| Value | Colour | Means |
| --- | --- | --- |
| `> 5` | green | moving normally |
| `0.5` - `5` | amber | crawling, or working in place |
| `< 0.5` | red | **wedge flag** — pairs with the runner's own wedge watchdog |
| `—` | grey | no reading (see below) |

A delta reads `—` when the bot is offline, has no position, or the ring has no
sample old enough to measure that window (within a 7.5s tolerance). Expect
dashes for the first 30-60 seconds after a panel restart — that is the honest
answer, not a bug.

### Self-polling

The panel polls the whole fleet **every 5 seconds on its own timer, whether or
not a browser is attached**, and appends each bot's position to an in-memory
ring about 65 seconds deep.

This matters: if sampling were driven by the page, opening the tab would show
dashes for the first minute every time. Because the server samples on its own,
deltas are already warm when the page is opened, and they survive browser
refreshes. Request serving still goes through the normal 2s cache — the
self-poll only keeps that cache warm.

The ring is in-memory only. It resets when the panel process restarts, and
there is no persistence by design.

## API

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/` | the dashboard, one self-contained HTML document |
| `GET` | `/api/fleet` | every runner's `/status` polled in parallel (3s timeout each), with the last ~10 `/events` merged per bot and `delta30`/`delta60` movement figures; whole aggregate cached 2s |
| `GET` | `/api/alerts` | last ~50 lines of the alerts log |
| `GET` | `/api/todo` | `cave/TODO.md`'s markdown tables, parsed and bucketed into `doing`/`todo`/`done`; cached on the file's mtime |
| `GET` | `/api/vault` | `cave/audit-snapshot.json`'s per-chest ledger, joined with hand-synced chest coords/labels; cached on the file's mtime, snapshot age always computed fresh |
| `POST` | `/api/wake` | `{bot}` — push the role-default task, `force: false` |
| `POST` | `/api/stop` | `{bot}` — forward `POST /stop` |

Everything else 404s.

`bot` accepts a name (`"Thak"`, case-insensitive) or a port (`3205`, `":3205"`),
and must be on the panel's current port list. The page itself always sends the
port, since that is the one identifier a card can never have wrong.

### Request guards

Binding to `127.0.0.1` keeps other machines out, but it does not keep out a web
page the operator happens to have open — browsers will issue cross-origin
requests at localhost. Two guards close that, and both are needed:

- **Host allow-list, all requests.** Anything whose `Host` header is not
  `127.0.0.1:3200`, `localhost:3200` or `[::1]:3200` gets `403`. This is the
  DNS-rebinding guard: a hostile page can point a domain it controls at
  `127.0.0.1`, but the request still arrives carrying that attacker hostname.
- **`application/json` required on writes.** `text/plain`, form-urlencoded and
  multipart are CORS-*simple* content types — a page can POST them
  cross-origin with no preflight at all, and `mode: 'no-cors'` hides the
  response while the mutation still lands. Anything else gets `415`, checked
  before the body is read and long before anything is forwarded to a runner, so
  a rejected request never touches a bot. Requiring JSON forces a preflight,
  and since the panel sends no CORS headers that preflight fails.

Notes on the aggregate:

- A slow or dead runner is caught per-bot; one bad runner can never fail the
  whole `/api/fleet` response.
- Concurrent refreshes collapse onto a single poll, so a hammered dashboard
  does not multiply into N parallel pokes at every runner.
- Events are pulled incrementally with `?since=<seq>` rather than re-fetching
  the full 500-entry ring every tick. A runner restart resets its seq, which the
  panel detects and re-syncs from 0.
- The alerts log is read from `cave/logs/alerts.log`, with `cave/alerts.log`
  checked as a fallback. A missing file is normal — it just means nothing has
  ever escalated — and returns an empty list, not an error.

## TODO board

`/api/todo` reads `cave/TODO.md` and re-parses it only when the file's mtime
changes — a stat() on every request, a re-read+re-parse only on an actual
edit. Parsing is by markdown table, not by line position, so it survives the
file being hand-edited:

- A table is recognized by its header row being immediately followed by a
  GFM separator row (`|---|---|...`). Column names are matched
  case-insensitively against known aliases (`Lane`, `Task`, `Who`/`By`,
  `Status`) — a table with no recognizable `Task` column is skipped
  entirely (not guessed at), so an unrelated table elsewhere in the file
  (there is none today, but nothing stops one being added) can't get pulled
  in by accident.
- A body row whose cell count doesn't match its header's, or whose `Task`
  cell is empty, is counted and skipped rather than shifted into the wrong
  column or thrown on. The count surfaces in the page's board subtitle
  (`cave/TODO.md — 2 rows skipped (malformed)`) when it's non-zero, silent
  otherwise.
- A table with no `Status` column (the `## DONE` section: `Task`, `By`) has
  every row in it default to `done` — keyed off the table sitting directly
  under a heading matching `/^done/i`, not guessed from row content.
- Each row's `Status` text is bucketed by its own leading word: `doing`,
  `done`, or anything else (`todo`, `queued`, `queued after #5`, `blocked on
  cobble`, `law`, ...) falls into `todo`. The bucket's own keyword is then
  stripped from the text shown in the UI (redundant once a row is already
  grouped under "DOING"/"QUEUED"/"DONE") — everything after it survives,
  since that's real information the bucket label alone doesn't carry.
- Each `Who` token (split on `,`/`+`) is resolved against the roster
  (`BOT_BY_NAME`, the same table the fleet cards use) for a team colour; an
  unrecognized token (a driver name, "orchestrator", loose prose) still
  renders as a chip, just uncoloured — the parser never tries to guess
  which words in freeform prose are "really" a bot name.

## Vault

`/api/vault` reads `cave/audit-snapshot.json` — the file `cave/audit.mjs`
writes after walking every registered chest with a live bot and reading its
real contents over HTTP (`/goto` + `/eval` openChest, read-only end to end).
Same mtime-cache shape as `/api/todo`, with one deliberate difference: the
snapshot's **age** is never part of the cached value. The whole point of
caching on mtime is that the file can sit unchanged — and therefore
increasingly stale — for a long time between audit runs while this endpoint
keeps getting polled every 3s; baking a relative age into the cached object
would freeze it at whatever it was when the cache was last built. Age is
computed fresh from the raw timestamp on every single call instead, cache
hit or not, so "2h 15m ago" always means what it says.

- A chest ID (e.g. `chest_a_materials`) is joined against `CHEST_META`, a
  hand-synced copy of `audit.mjs`'s own `CHESTS` list (coords + label) —
  `audit.mjs` is a one-shot CLI script with no module exports, so this can't
  be imported, same contract as the `BOTS`/`TEAM_HEX` tables. Keep it in
  sync when a chest moves, or gets added/removed from BASE.md's registry.
- A chest whose value is the `{ __error: "<message>" }` shape (audit.mjs's
  own failure marker for a chest it couldn't reach or read) renders as "read
  failed: `<message>`" with an amber-tinted card border — amber, not red:
  a failed *read* is a data-collection problem worth a glance, not
  necessarily a fleet emergency the way a panic-response task is.
- Snapshot age past `VAULT_STALE_MS` (2 hours) tints amber in the section
  header. The threshold ships from the server (`staleMs` in the response),
  not hardcoded twice.
- Missing file (`ENOENT` — `audit.mjs` has simply never been run) returns
  `{ ok: true, missing: true }` and the whole section hides via the `hidden`
  attribute, not an empty-state message — this is the one case in the whole
  panel where "nothing to show" means "hide the section" rather than "show
  it saying so", because unlike an empty inventory or a quiet alerts log,
  "never audited" isn't really a state of the *fleet* at all. Any OTHER
  failure (permissions, corrupt JSON) still shows the section, with the
  failure message where the age normally goes, since that IS a problem
  worth surfacing.
- Item chips reuse the exact same `.chip` markup/style a bot card's own
  inventory uses — deliberately: a chest's contents and a bot's inventory
  are the same kind of fact, so they read the same way. Capped at 30 per
  chest with a "+N more" trailing chip past that (not needed by today's
  real chests — chest A currently sits at 23 distinct stacks — but a static
  page shouldn't quietly render an unbounded chip wall if that ever grows).

## Keeping it in sync

`panel.mjs` carries its own copy of three tables, because none of their
sources can be imported (`overseer.mjs` starts its supervision loop on
import; `runner.js` is a per-bot process; `audit.mjs` is a one-shot CLI
script that calls `main()` directly with no module exports):

- the roster + role-default tasks, from `overseer.mjs`'s `BOTS` (~line 34)
- the team colours, from `runner.js`'s `TEAM_COLORS` (~line 78), lifted to hex
  values that stay readable on a dark card (`blue` and `dark_aqua` are
  brightened off their literal chat colours; the rest are palette values)
- the chest coords + labels, from `audit.mjs`'s `CHESTS` (~line 36), as
  `CHEST_META`

If any of these change upstream, update `panel.mjs` by hand.

## Phase 2 ideas

Not built unless marked DONE below.

- **Event feed** — DONE. Each card carries a collapsed-by-default `▸ events
  (N)` toggle in its footer row; expanding it shows the bot's last ~10 events
  (task starts/stops, idle-guard toggles, deaths, panics, chat, connect/
  disconnect — whatever `runner.js` pushes), newest first, in a small
  scrollable list. Deliberately per-card rather than a merged fleet-wide
  stream: a merged feed would compete with the Alerts column for the same
  "something's wrong" job, where this answers "what has this bot actually
  been doing lately." Relative timestamps refresh every poll even when the
  list itself hasn't changed (same honesty-over-shortcuts rule the movement
  deltas and task age already follow); the list only rebuilds its DOM when
  the underlying event set actually changes, so an open/scrolled log doesn't
  jump on an empty poll. Timestamps render in the card's monospace stack
  (ledger, not prose). Expand/collapse animates via max-height/opacity
  instead of snapping, and `#grid` sets `align-items: start` so a card that
  grows no longer stretches its same-row neighbours' backgrounds into dead
  space — a static grid still reflows rows below it, which isn't the "jump"
  a measured-height overlay would be needed to fully avoid. `runner.js`'s
  rate-cap rollup lines (`...suppressed N similar <type> event(s)`, RING
  RATE CAP fix) render italicized to read as a footnote about the log
  itself rather than a real event, detected by message shape since the
  rollup keeps its original event type.
- **Driver states** — show which bot has a driver attached and what that driver
  currently believes it is doing, so the panel distinguishes "idle" from
  "between driver steps".
- **TODO board view** — DONE. A full-width "Tribe Board" section below the
  fleet grid rather than a column beside it (the aside column is already
  claimed by Alerts) — DOING/QUEUED always shown, DONE collapsed. See
  `## TODO board` above for the parsing rules.
- **Scoreboard integration** — pull `cave/scoreboard-state.json` for quota
  progress, per-bot contribution, and trend over time rather than a single iron
  count.
- **Discord feed** — mirror the alerts column into the channel `discord.mjs`
  already talks to, and surface recent Discord chatter on the page.
