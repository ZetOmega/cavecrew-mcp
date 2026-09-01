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

Offline runners are tolerated, never fatal: the card dims, the entry is marked
`offline: true` with a reason, and the rest of the fleet renders normally.

**Alerts column** — the tail of the overseer's escalation log merged with every
bot's live `lastError`, newest first.

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

## Keeping it in sync

`panel.mjs` carries its own copy of two tables, because neither source can be
imported (`overseer.mjs` starts its supervision loop on import; `runner.js` is a
per-bot process):

- the roster + role-default tasks, from `overseer.mjs`'s `BOTS` (~line 34)
- the team colours, from `runner.js`'s `TEAM_COLORS` (~line 78), lifted to hex
  values that stay readable on a dark card (`blue` and `dark_aqua` are
  brightened off their literal chat colours; the rest are palette values)

If either changes upstream, update `panel.mjs` by hand.

## Phase 2 ideas

Not built. v1 is only what is above.

- **Event feed** — `/api/fleet` already carries the last ~10 events per bot, but
  the page does not render them. Add a per-card expandable log, or a merged
  fleet-wide stream beside the alerts column.
- **Driver states** — show which bot has a driver attached and what that driver
  currently believes it is doing, so the panel distinguishes "idle" from
  "between driver steps".
- **TODO board view** — render `cave/TODO.md` as a live column beside the fleet,
  with per-bot assignment.
- **Scoreboard integration** — pull `cave/scoreboard-state.json` for quota
  progress, per-bot contribution, and trend over time rather than a single iron
  count.
- **Discord feed** — mirror the alerts column into the channel `discord.mjs`
  already talks to, and surface recent Discord chatter on the page.
