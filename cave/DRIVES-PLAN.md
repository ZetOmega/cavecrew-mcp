# DRIVES-PLAN.md — implementation plan for DRIVES-SPEC.md

Status: PLAN ONLY. Nothing in this document has been implemented. Written
against runner.js/skills.js/overseer.mjs/local.json as they exist at commit
706c9b0. Every design choice below is checked against LEAD ANNOTATIONS A-L in
DRIVES-SPEC.md; deviations/extensions beyond literal annotation text are
marked **FLAGGED** the same way annotation D flags its own #5 deviation —
inferred from spec intent, overridable by chief.

---

## 0. Architecture decision (resolves the spec/annotation ambiguity first)

Two shapes were possible: (a) drives logic **inside each bot's own runner.js
process**, or (b) a **separate poller process** (overseer.mjs-shaped) that
drives bots purely over HTTP.

**Chosen: (a), in-process.** Reasons:
- Needs computation needs live mineflayer state DRIVER_GUIDE's `/status`
  does not expose today: time-of-day/isDay, nearby block types, nearby
  hostile/passive entities, nearby crew bots by live distance. Getting these
  over HTTP would mean bloating `/status` for every poller (overseer, panel,
  drivers) just to serve the rare drives tick — wasteful and couples unrelated
  concerns.
- Annotation K requires drive-issued tasks to run through "the SAME task
  layer drivers use" — in-process means calling `startTask()` directly, zero
  new movement/task primitives, by construction.
- Annotation A's precedence law ("no task running AND no recent driver HTTP
  activity") reads directly off runner.js's own `state.currentTask` /
  `lastHttpRequestAt` — no cross-process staleness window to reason about.

Cost: the `openai` SDK and its network calls now live inside the same
process that holds the Minecraft connection. Mitigated by: LLM calls are
async (never block the event loop or bot ticks), a hard global in-flight cap
(cave/drives-queue.js, §5), and total dormancy with zero network attempts
when unconfigured (annotation F).

---

## 1. File layout

### New files (all under `cave/`)

| File | Purpose | Coupling |
|---|---|---|
| `drives.json` | Config, committed, ships `{"global": false, "bots": {}}` — flag-off by default (annotation L). | none (data) |
| `drives-config.js` | Loads/validates `drives.json`, mtime-cached hot-reload, exposes `isEnrolled(name)`, `isGlobalOn()`, `getModels()`, `getGuards()`. Fail-**closed** on missing/malformed file (opposite of zones.json's fail-open — an unreviewed config must never silently enable autonomous LLM action). | pure fs |
| `drives-dsl.js` | done_check grammar: `validateDoneCheck(obj)` (whitelist-only, throws on anything else), `evalDoneCheck(check, reading)` (pure predicate eval, never `eval()`/`new Function()`). §4. | pure |
| `drives-llm.js` | DeepSeek client wrapper (`openai` npm pkg, `baseURL: https://api.deepseek.com`). Key resolution, startup model-list fetch + match-or-dormant (annotation F), `decisionCall()`, `reflectionCall()`. | `openai` pkg only |
| `drives-memory.js` | `cave/botmind/<bot>.json` read/write: reflection lines, known shelter/bed spots, failed-args ring (cap 20), signals cache, counters (annotation I). | pure fs |
| `drives-queue.js` | Cross-process global in-flight semaphore (file-lock dir `cave/drives/queue/`) + per-bot min-interval/hourly-cap counters. §5. | pure fs |
| `signals.js` | Shared `cave/signals.jsonl` backend: `appendSignal()`, `readLatestPerBot()`, self-pruning to last N lines. Annotation D. | pure fs |
| `drives-skills-map.js` | Static table mapping the model's skill vocabulary → real taskRoutes endpoints + per-skill arg validators. Annotation J. Load-time assertion cross-checks every mapped kind against `skills.js` exports so it can't silently drift. | imports `skills.js` (assertion only) |

### Touched files

**`cave/runner.js`** (anchors are current line numbers, will drift once other
patches land before this — re-anchor by comment text, not line number, at
build time):

1. New imports, top of file next to the `skills.js`/`movement.js` block
   (~line 28-32).
2. New module-level `let lastCommandAt = Date.now();` and one stamp line in
   `handleRequest()` (~2386), **POST only** — see §2 "activity" fix below.
   Does not touch `lastHttpRequestAt` (idle-guard's own safety-TTL clock
   stays exactly as-is).
3. New section **"DRIVES ENGINE"**, inserted directly after the existing
   IDLE-GUARD section (after line 1766, before "task-specific helpers" at
   1768) — same structural style as idle-guard: constants, per-bot needs
   struct, `tickDrives()`, decision-call trigger, executor/watchdog glue.
4. `tickDrives()` wired into the **existing** `setInterval(..., IDLE_GUARD_TICK_MS)`
   at 1758-1766 (one more call alongside `checkIdleGuardSafetyTTL()` /
   `maybeStartIdleGuard()` / `sweepStaleRateWindows()`) — reuses the current
   5s cadence, no new timer.
5. `maybeStartIdleGuard()` (1727): one new guard line at top —
   `if (drivesOwnsIdle(name)) return;` — **FLAGGED/inferred**: spec's own
   framing ("replace idle behaviour with drive-based self-selection") plus
   annotation E's parallel treatment of overseer's goal-engine implies
   idle-guard must also stand down for an enrolled+on bot, or the two
   idle-fillers fight over the same trigger. `drivesOwnsIdle()` = enrolled
   AND global AND runtime-on (same three-part check drives itself uses).
6. `startTask()`'s preemption check (1022): generalize
   `state.currentTask.kind === 'idle-guard'` to
   `state.currentTask.kind === 'idle-guard' || state.currentTask.source === 'drives'`
   — a drive-issued task is preemptible by any real driver call exactly like
   idle-guard is today, no `force` needed. One-line change, same
   `replaceLine` evidence logging already in place (annotation A's "driver
   always wins" + K's "safety unchanged" — this is the SAME mutex, not a new
   one).
7. `buildStatus()` (1946): add `drives: { enrolled, on }` (cheap booleans;
   full detail lives on `GET /drives`, not bloating every `/status` poll).
8. Two new routes in `handleRequest()`: `POST /drives` (mirrors
   `handleIdleGuard` exactly incl. its own safety-TTL re-arm — annotation B:
   "Runtime toggle endpoint `/drives on|off` like /idleguard") and
   `GET /drives` (debug/panel detail: needs, last decision, last reflection,
   calls-this-hour, queue depth — read-only, does **not** stamp
   `lastCommandAt`).
9. New taskRoutes entry `POST /seal` — thin wrapper around the *already
   exported* `skills.emergencySeal`, same shape/precedent as the existing
   `/ensureTool` entry (2211, whose own comment says it was added "so the
   goal engine has an endpoint to fire"). Closes the "shelter" need's only
   real gap: no shelter-building skill exists in skills.js, but the
   emergency-seal-in-place skill already does and only lacks an HTTP door.
   **No new skill invented** — annotation J honored.

**`cave/overseer.mjs`**:
- Import `{ isEnrolled }` from `./drives-config.js`.
- In `tick(bot)`, right after the stuck-detection early-return block
  (790-792) and before the CHORES loop (794), insert:
  `if (isEnrolled(bot.name)) return;` — annotation E: "overseer SKIPS
  enrolled bots (drive engine owns their idle)". Everything ABOVE this line
  in `tick()` — down-poll alert, failed-task escalation, disconnect/relog,
  goal-claim reconciliation, chop-quarantine enforcer, stuck-detection
  ladder — stays active for enrolled bots. Those are connectivity/safety
  concerns, not idle-ownership (annotation K: "safety unchanged").

**`cave/local.json.example`**: add a `deepseek` block —
```json
"deepseek": { "apiKey": "CHANGE_ME" }
```
documents the key **name** only, never a real value (matches the existing
`rcon`/`discord` blocks' own placeholder convention).

**`package.json`**: add `"openai"` to `dependencies` (not present today —
confirmed via `grep`). Exact version pinned at build time to whatever
`npm install openai` resolves to current stable.

**`cave/.gitignore`**: add `botmind/`, `signals.jsonl`, `drives/queue/` —
runtime state, annotation I.

**Doc updates needed at build time, not performed by this plan** (flagged,
out of scope of a planning pass): `DRIVER_GUIDE.md` needs a `/drives` /
`/seal` endpoint entry in its API reference; `CIV.md`'s port/roster table
should eventually note which bots are drives-enrolled.

---

## 2. The "driver HTTP activity" fix (must-resolve conflict, annotation A)

Annotation A: "no recent driver HTTP activity (any HTTP call = activity —
this also closes issue #7's eval-hijack family)". But `overseer.mjs` polls
`GET /status` on **every** bot every `POLL_MS` (30s) regardless of
enrollment (§ touched-file notes above — it still needs connectivity/stuck
data for enrolled bots). If GET polling counted as "activity", an enrolled
bot would see fresh "activity" every 30s forever and drives would never
clear the precedence check — permanently starved.

**Resolution**: two separate clocks already exist in spirit; make them
explicit as two separate variables:
- `lastHttpRequestAt` (existing, unchanged) — ANY request, GET or POST.
  Still solely feeds idle-guard's own 15-min safety-TTL re-arm. Untouched.
- `lastCommandAt` (new) — stamped only on `method === 'POST'`, i.e. exactly
  the set of endpoints that represent driver intent (`/goto`, `/chop`, ...,
  `/chat`, `/eval`, `/idleguard`, `/stop`, `/relog`, and `/drives` itself).
  `GET /status` and `GET /events` — the passive-poll surface overseer/panel
  hammer continuously — never touch it.

Drives' precedence check reads `lastCommandAt`, not `lastHttpRequestAt`.
This is the literal, narrow read of "any HTTP call" that still lets a
monitoring poller coexist with an enrolled bot — **FLAGGED** for chief
confirmation since it narrows the annotation's wording, but the alternative
(literal wording) makes drives permanently inert on any bot overseer also
watches, which cannot be the intent.

---

## 3. Needs (code only, no LLM) — every 5s, per enrolled bot

Computed inside `tickDrives()` from live `bot` state, stored in a small
per-process struct `{hunger, safety, shelter, resources, social, boredom}`
(0-100 each), no persistence needed (reconstructed live every tick).

```
hunger    = clamp(round((20 - food) / 20 * 100), 0, 100)
            + (food < 10 ? 20 : 0)                    // spike, capped 100
safety    = min(100, (isNight ? 40 : 0)
                    + (hostileWithin16 ? 40 : 0)
                    + (hp < 10 ? 40 : 0))
shelter   = (isNight && !botmind.knownShelterSpot) ? 80 : 0
resources = 25 * countMissingMentionedItems(reflection.want_next, inventory)
            // heuristic: word-match reflection text against mcData item
            // names; capped 100. Best-effort, tuned post-pilot.
social    = min(100, minutesSinceLastCrewChat * 5)
boredom   = min(100, minutesSinceLastDrivesSuccess * 15)   // spec's own formula, verbatim
```

`isNight` = `!bot.time.isDay`. `hostileWithin16` = any `bot.entities` value
with hostile mob kind within 16 blocks (mineflayer entity `.kind` category
— confirmed against the installed mineflayer version at build time, not
guessed). "Top need" = max of the six; ties broken by "not done recently"
(least-recently-satisfied need wins), matching the spec's own tie rule for
goal selection.

---

## 4. done_check DSL (annotation H — whitelist only, never eval)

```
done_check := predicate | { "all": [predicate, ...] } | { "any": [predicate, ...] }
predicate  := has_item | near | food_min | hp_min | time_passed_s

has_item      := { "has_item":      { "name": <string>, "count": <int >= 1> } }
near          := { "near":          { "x": <num>, "y": <num>, "z": <num>, "r": <num > 0> } }
food_min      := { "food_min":      <int 0..20> }
hp_min        := { "hp_min":        <int 0..20> }
time_passed_s := { "time_passed_s": <int >= 1> }   // measured from task start, code-tracked
```

`all`/`any` combinators are **FLAGGED** — not in the spec's literal
grammar, added because a single predicate is sometimes insufficient (e.g.
"reached the spot AND still have food"); both branches recurse into the
same whitelist, so H's "never eval model output" guarantee is unaffected —
still structural matching, never interpreted as code.

`validateDoneCheck(obj)`: rejects any key outside the whitelist at any
nesting level, rejects wrong types/ranges, rejects extra keys in a
predicate's inner object. `evalDoneCheck(check, reading)`: pure function,
`reading = {pos, hp, food, invCounts, taskStartedAt}` is a plain snapshot
runner.js builds fresh from live `bot` state each poll — decouples the DSL
module from mineflayer entirely (unit-testable with no bot).

---

## 5. Decision-call flow

**Trigger** (annotation G, all must hold):
1. `isEnrolled(name) && isGlobalOn() && drivesRuntimeOn` (the `/drives`
   toggle, mirrors `idleGuardEnabled`).
2. `(state.currentTask is null/finished) OR (last event was a drives-task
   fail)` — "idle" for an enrolled bot only ever means null/finished, since
   idle-guard is suppressed for enrolled bots (§1.5) and overseer's
   goal-engine/defaults are suppressed too (§1, overseer.mjs change) — the
   only other occupant of `state.currentTask` is a real driver task (which
   already blocks by definition) or panic-response (also blocks, correctly
   — panic always wins).
3. `now - lastCommandAt >= driverQuietMs` (config-driven window, default
   e.g. 15000ms — driver still "thinking" inside their own gap must not get
   a drive goal shoved under them; mirrors idle-guard's own driver-aware
   toggle reasoning).
4. Cost guards (drives-queue.js): `now - bot.lastCallAt >= minCallIntervalMs`
   (default 20000), `bot.callsThisHour < hourlyCallCap` (default 60), a
   global in-flight slot successfully acquired (default cap 5), kill-switch
   (`isGlobalOn()`) re-checked fresh immediately before the call (not
   cached from step 1 — a toggle mid-tick must be honored).
   "Immediately after a fail" (spec §3, "never sleep on fail") bypasses
   nothing about guard 4's numeric limits — it only means condition 2 can
   be true without waiting for a fresh idle transition. If guard 4 still
   says "too soon", the retry genuinely waits; this reconciles spec's
   "never sleep on fail" with annotation G's "min 20s between calls" —
   **FLAGGED** as the resolution of an otherwise-contradictory pair.

**Build state snapshot**: pos, hp, food, `{isDay, timeOfDay}`, top-10
inventory by count, nearby block types (`bot.findBlocks` small radius,
deduped, capped 8 names), nearby crew bots (`OUR_BOTS`-filtered
`bot.players` within ~24 blocks), last goal + result + reason (from
`drives-memory.js`'s ring), reflection's 3 lines (good_at/village_lacks/
want_next, verbatim), top-2 needs + values, skill list (from
`drives-skills-map.js`).

**Prompt**: spec's exact decision-prompt text (DRIVES-SPEC.md §2), state
snapshot appended as one structured JSON block, "Reply JSON only."

**Model select**: `decisionModel`, or `escalationModel` once
`consecutiveFails >= escalateAfterFails` (default 2) for this bot — per
annotation F, both default to the same configured model unless chief sets
a distinct (presumably pricier) escalation model.

**Validate reply** (`JSON.parse` in try/catch — a parse failure is an
"invalid reply", never partial-eval'd):
- `need` ∈ the six need names.
- `skill` ∈ `drives-skills-map.js`'s vocabulary.
- `args` passes that skill's own arg validator (mirrors each taskRoutes
  handler's inline checks — e.g. `/mine` needs `block:string`, `/goto`
  needs `x/y/z:number` — same rules, evaluated locally before ever calling
  into task machinery).
- `done_check` passes `validateDoneCheck()` (§4).
- `timeout_s` ∈ [5, 1800].
- `why` — string, soft length cap (~60 chars), not a strict 5-word parse.

Invalid → **re-prompt once** with the specific validation error appended.
Still invalid → **code fallback**, no model call: hunger is top need →
`/collect` (nearby food drops) else `/hunt pig`; otherwise → `/chop`
(spec §3's literal "cheapest safe skill: gather nearest wood/food").

**Dispatch**: valid reply (or fallback) → `startTask(skillKind, fn,
{source:'drives'})`, same in-process call every taskRoutes handler makes —
this is what gives drive goals the wedge-watchdog, panic reflex, poison-
target tracking, dig-law, and de-chat routing "for free" (annotation K).
`ctx.setTargetPos()` wired the same way `/goto`/`/mine` already do when
`args` carries x/y/z.

**Executor/watchdog**: while the task runs, poll `evalDoneCheck()` against
a fresh `reading` every ~2-3s. Whichever fires first — `done_check` true,
the skill's own promise resolving, or `timeout_s` elapsing — ends the
cycle: `done_check`-early success cancels the task
(`cancelCurrentTask('drives: done_check satisfied')`) and counts as
success; the skill's own natural completion is logged as success/fail per
its own result regardless of `done_check` (a skill finishing without
technically satisfying `done_check` is not force-failed — logged, not
punished); `timeout_s` elapsed with neither → `cancelCurrentTask()`,
mark fail:timeout.

**On success**: reset `lastDrivesSuccessAt` (feeds boredom), append to
`drives-memory.js`'s recent-goals ring, immediately loop to the trigger
check (no sleep). **On any failure**: `consecutiveFails++`, append
`{skill, args}` to the failed-args ring (cap 20 — this is what lets the
next prompt's "no repeat of failed args" instruction actually have
ammunition, since it's injected into the next state snapshot's "last goal"
field), immediately loop to the trigger check (guard 4 above still applies
— see the reconciliation note).

---

## 6. Reflection scheduler

Per enrolled bot, `reflectionIntervalMs` randomized once per bot inside
`[reflectionIntervalMinMs, reflectionIntervalMaxMs]` (default 10-15 min,
config-driven) plus a deterministic phase offset (`hash(botName) %
interval`) so the pilot's two bots don't fire together — the fleet-scale
version of spec §6's staggering, cheap defense-in-depth alongside the
queue's own hard cap (§7).

**Input**: goals done/failed since last reflection (from the ring),
"things seen" (nearby-block-type set sampled each decision tick, merged/
deduped since last reflection, capped), chats heard (reused straight from
the existing `eventsBuf` 'chat'-type entries since the last reflection
timestamp — no new capture path), peer inventory summaries (latest-per-bot
from `signals.js`, feeds `village_lacks` in prose, not code-computed).

**Prompt**: spec's exact reflection-prompt text (DRIVES-SPEC.md §4).
**Model**: `reflectionModel` (defaults to `decisionModel`, annotation F).
**Parse**: lenient line match (`/^(\w[\w_]*)\s*:\s*(.+)$/` per line,
case/order-tolerant) for `good_at` / `village_lacks` / `want_next`.
**Store**: `drives-memory.js`, overwriting the previous 3 lines (not
accumulated) — these get injected verbatim into every subsequent decision
snapshot until the next reflection.

---

## 7. Signals backend (annotation D — jsonl, never game chat)

`cave/signals.jsonl`, one shared file, append-only:
```json
{"ts":"2026-09-01T...","bot":"Durk","inventory":[{"name":"oak_log","count":40}, ...top10]}
```
Appended by each enrolled bot on its own cadence (config `signalsIntervalMs`,
default 5 min — independent of the reflection cadence). Read by
`readLatestPerBot()`: parses the whole file, keeps only the most recent
line per `bot`, tolerates corrupt lines (skip + count, same pattern as
`ledger.mjs`'s `loadAllEntries()`). **Self-pruning**: any appender that
notices the file exceeds a line-count threshold (default 2000) truncates
to the last 500 lines first — mirrors the in-memory `EVENTS_MAX` ring
philosophy, applied to a file shared across processes.

**Open risk, flagged**: this is the first jsonl file **shared across
multiple runner processes** (ledger/missions files are one-per-bot,
written by only their own process). `fs.appendFileSync` under `O_APPEND`
is atomic per write on POSIX only while a single write stays under the
platform's atomic-write boundary (commonly 4KB on Linux) — safe for these
small single-line JSON records, but worth an explicit note rather than a
silent assumption. No corruption-recovery beyond the existing "skip bad
line, count it" tolerance is planned for v1.

---

## 8. Config schema — `cave/drives.json`

```json
{
  "global": false,
  "bots": { "Durk": false, "Mog": false },
  "decisionModel": "deepseek-chat",
  "escalationModel": "deepseek-chat",
  "reflectionModel": "deepseek-chat",
  "tickMs": 5000,
  "driverQuietMs": 15000,
  "minCallIntervalMs": 20000,
  "hourlyCallCap": 60,
  "globalInFlightCap": 5,
  "escalateAfterFails": 2,
  "reflectionIntervalMinMs": 600000,
  "reflectionIntervalMaxMs": 900000,
  "signalsIntervalMs": 300000
}
```
Ships with `global:false` and every roster bot `false` — flag-off by
construction (annotation L). `bots.<Name>` missing = not enrolled
(explicit opt-in only, matches annotation B's `{"bots":{"Durk":true}}`
example). Malformed JSON / missing file → `drives-config.js` logs one warn
and behaves exactly as `global:false` (fail-**closed**, deliberately the
inverse of zones.json's fail-open precedent — see §1 file table).

`decisionModel`/`escalationModel`/`reflectionModel` are matched at each
enrolled runner's boot against `client.models.list()` from the DeepSeek
API. Configured name absent from that list → log the full available list
**once**, engine stays dormant for that bot, never retried until the
runner restarts (annotation F: "never guess-spend on a wrong model").

---

## 9. `/drives` endpoint spec

**`POST /drives`** — body `{"on": boolean}` (required). Mirrors
`handleIdleGuard` exactly: toggles an in-memory `drivesRuntimeOn` flag for
this runner's session only (does not persist to `drives.json`), same
15-min-silence safety-TTL re-arm as idle-guard (annotation B: "like
/idleguard"). Response:
```json
{ "ok": true, "drives": true,
  "note": "drives armed" | "drives disabled; auto re-arms after 15min with zero incoming HTTP requests (safety TTL)" }
```
Stamps `lastCommandAt` like any other POST (a driver toggling drives off
IS driver activity).

**`GET /drives`** — read-only, does not stamp `lastCommandAt`. Response:
```json
{
  "enrolled": true, "on": true,
  "needs": { "hunger": 12, "safety": 0, "shelter": 0, "resources": 25, "social": 40, "boredom": 55 },
  "lastDecision": { "ts": "...", "need": "boredom", "skill": "goto", "why": "explore east ridge" },
  "lastReflection": { "ts": "...", "good_at": "...", "village_lacks": "...", "want_next": "..." },
  "callsThisHour": 4, "consecutiveFails": 0, "queueDepth": 1
}
```
`enrolled:false` short-circuits the rest to nulls/zeros — cheap to poll for
the panel without needing a separate "is this bot even in scope" check.

---

## 10. Test plan — reserved port 3298

Uses a short-lived test bot (CIV.md: "3298 — reserved: short-lived test
bots, e.g. PebbleZoom"), same stop procedure TESTLAB.md documents for
TestRock (pid file → kill). **Never touches 3201-3208/3301-3309/3200**
(hard rule, honored).

### Test 1 — flag-off zero-change proof
1. `node cave/runner.js --name PebbleZoom --port 3298`, `drives.json`
   shipped default (`global:false`, empty `bots`).
2. Boot log: no drives ERROR lines; at most one benign "drives: disabled
   (global=false)" info line, never repeated per-tick.
3. Snapshot `GET /status` key set against a pre-change baseline captured
   from a currently-running production bot — confirm the **only** new key
   is `drives:{enrolled:false,on:false}`; every existing key's shape/type
   unchanged.
4. Fire every existing endpoint once (`/goto`, `/chop`, `/collect`,
   `/idleguard`, `/stop`, `/relog`, `/chat`, `/eval`) — each behaves exactly
   per DRIVER_GUIDE.md (task starts, `/status` reflects it, `/events` logs
   it). This is the real regression check on the generalized preemption
   condition in §1.6 — with drives inert, `source === 'drives'` is always
   false, so that clause is dead code on this run.
5. Confirm idle-guard still self-fires at 90s exactly as before (§1.5's new
   guard costs one boolean+mtime check per tick when global:false, never
   short-circuits idle-guard).
6. Leave PebbleZoom running 10+ min with zero driver traffic: zero decision
   calls, zero reflection calls, no `botmind/PebbleZoom.json` writes, no
   `signals.jsonl` lines attributable to it — full dormancy.
7. Stop via pid file (TESTLAB.md procedure) — clean shutdown log, pid file
   removed, no drives-related hang.

### Test 2 — no-API-key dormant proof
1. Same bot, `drives.json` now `{"global":true,"bots":{"PebbleZoom":true}}`,
   **no** `deepseek` block in `local.json`, `DEEPSEEK_API_KEY` unset.
2. First tick: exactly ONE log line — "drives: no DeepSeek API key
   configured (local.json deepseek.apiKey or DEEPSEEK_API_KEY) — engine
   dormant" — never repeated on later ticks (rate-limited via a boolean
   guard, same pattern as idle-guard's `idleGuardOffLoggedAt`).
3. Needs computation still runs every 5s (`GET /drives` shows live `needs`
   values changing) — proves the needs layer is genuinely independent of
   the LLM layer per spec's "Model never computes needs".
4. Zero decision calls ever fire — verified two ways: (a) no openai/DeepSeek
   SDK errors ever logged (a dormant engine that never attempts a call has
   none to log — the absence itself is evidence, cross-checked against
   variant (b) below so it isn't just a silently-swallowed catch-all);
   (b) same bot, same run, temporarily set a garbage `DEEPSEEK_API_KEY` —
   confirm THIS path DOES attempt a call and logs a distinct auth-failure,
   proving the no-key path is an earlier, separate short-circuit, not an
   accidental blanket catch.
5. No retry storm: log-line growth flat over 10 minutes (a few needs-only
   lines, no tight loop).
6. Runner stays fully controllable via every normal endpoint throughout
   (repeat of Test 1 step 4's battery) — dormant drives never blocks real
   commands.
7. Bonus — model-list-mismatch variant: valid key, `decisionModel` set to a
   name absent from the account's model list. Confirm the available list is
   logged once, engine stays dormant identically to steps 2-3, verifying
   annotation F's "log the available list once and stay dormant" clause
   specifically (distinct code path from the no-key case).

Pilot rollout itself (Durk 3207 first, then Mog 3208, annotation B) is a
**separate, later** step — not part of this 3298 test plan.

---

## 11. Annotation compliance table

| # | Annotation | Where honored |
|---|---|---|
| A | Driver task always beats drives; any HTTP = activity | §2 (activity-clock split, flagged), §5 trigger conditions 2-3, §1.6 preemption generalization |
| B | Enrollment flag, `drives.json`, `/drives` toggle, Durk→Mog pilot order | §8 config, §9 endpoint, §10 test-plan note (pilot order is post-plan, not part of 3298 tests) |
| C | Baritone bots excluded v1 | `drives-config.js`'s `isEnrolled()` only ever consults `drives.json`'s explicit `bots` map — BariBrute (3301-3309) is simply never listed; no separate baritone-detection code needed since enrollment is opt-in only |
| D | Signals backend, never game chat; social via real chat | §7 (signals.jsonl), §5 skill list includes `talk` → real `/chat` (annotation D: "allowed — it is actual talk") |
| E | Overseer skips enrolled bots | §1, overseer.mjs touched-file entry |
| F | DeepSeek via `openai` pkg, config-driven models, dormant-clean without key | §8, §10 Test 2, `drives-llm.js` file entry |
| G | Cost guards: 5s needs tick, 20s/call, 60/hr, 4-6 in-flight, kill-switch pre-call | §3 (5s), §5 trigger condition 4, `drives-queue.js` |
| H | done_check DSL, whitelist only, never eval | §4 |
| I | `cave/botmind/<bot>.json`, gitignored | §1 file table (`drives-memory.js`), `.gitignore` touched-file entry |
| J | Skill list mapped from real surface, no invented skills | `drives-skills-map.js` file entry + load-time assertion; §1.9 `/seal` wraps a pre-existing `skills.emergencySeal`, not a new skill |
| K | Safety unchanged, same task layer, no new movement primitives | §5 dispatch (`startTask()` directly), overseer.mjs change keeps stuck/chop-quarantine/disconnect logic active for enrolled bots |
| L | Flag-off landing, 3298-only testing, no live-fleet restarts | §8 shipped defaults, §10 entire test plan, no 3201-3208/3301-3309/3200 touches anywhere in this plan |

---

## 12. Open risks / flagged decisions for chief

1. **§2** — "any HTTP call = activity" narrowed to POST-only
   (`lastCommandAt`), because overseer's routine GET-polling of enrolled
   bots would otherwise starve drives permanently. Needs a yes/no.
2. **§1.5** — idle-guard suppressed entirely for enrolled+on bots (drives
   fully replaces it, not just coexists). Inferred from spec's stated
   intent, not literal annotation text.
3. **§1.9** — new `/seal` endpoint (thin wrapper on existing
   `skills.emergencySeal`) to give the "shelter" need a real skill to pick;
   no shelter-BUILDING skill exists anywhere in skills.js today, so v1
   shelter-need behavior is "flee to a known safe spot or seal in place",
   never "construct a shelter". Worth chief awareness before pilot.
4. **§5** — "never sleep on fail" reconciled as "never a *designed* wait",
   still bounded by the 20s min-interval guard. A literal read of both
   spec text and annotation G together seemed genuinely contradictory
   without this.
5. **§7** — `signals.jsonl` as the first jsonl file written by multiple
   processes concurrently (vs. today's one-file-per-bot pattern). Relies
   on POSIX small-write atomicity; no stronger guarantee designed for v1.
6. **§5 concurrency** — global in-flight cap implemented as a file-lock
   semaphore (`cave/drives-queue.js`) rather than a small broker process,
   to avoid adding a new always-on port/service. Fine at pilot scale (2
   bots); worth revisiting if/when the full 20-bot fleet enrolls.
7. **`resources` need** (§3) is a coarse word-match heuristic against the
   reflection's free-text `want_next` line — spec itself doesn't specify a
   precise formula here; flagged as tune-after-pilot-data, not exact.
