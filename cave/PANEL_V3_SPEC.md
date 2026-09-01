# PANEL V3 — RESEARCH DOSSIER + FEATURE SPEC

Author: PanelDev. Scope per team-lead's brief: research + spec only, no
code this round — a Workflow implements after this is reviewed, PanelDev
integrates/QA's at the end. Design/look is explicitly NOT this document's
job (team-lead + chief run a design canvas in parallel); every field below
is chosen for correctness and honesty, not visual treatment.

Chief's three picks, confirmed with team-lead:

1. **Mission Control Cards** (per bot) — current task + detail, distance
   from base + direction, tool/durability, mission history.
2. **Economy graphs** — sparklines/charts from `cave/ledger/<bot>.jsonl`:
   flows over time (iron, wheat, bread), harvest yields.
3. **Tribe stat wall** — big numbers: deaths-free streak, total ore
   banked, bread stock, missions today, FEL relation status.

Layout constraint (chief): calm glanceable WALL by default, click-drilldown
depth per bot/section. **No live map.**

Every claim below was checked against the real files in this repo today
(2026-09-01), not against DRIVER_GUIDE.md's documentation, which lags the
real `runner.js` in at least one place — see Gap G5.

---

## 1. DATA INVENTORY

### 1.1 `GET /status` (runner.js `buildStatus()`, ~line 1859)

Real, current shape (DRIVER_GUIDE.md's documented example is stale — it's
missing `idleGuard`/`deathCount`/`lastDeath`/`poisonedTargets` entirely):

```json
{
  "name": "UngaBunga",
  "connected": true,
  "pos": { "x": 12.5, "y": 91, "z": 52.1 },
  "health": 20,
  "food": 18,
  "gamemode": "survival",
  "inventory": [{ "name": "oak_log", "count": 6 }],
  "currentTask": { "id": "task-17", "kind": "chop", "source": "http", "state": "running", "detail": "chopping tree 3/8", "result": null, "finishedAt": null },
  "lastError": null,
  "idleGuard": true,
  "engine": "auto",
  "deathCount": 0,
  "lastDeath": null,
  "poisonedTargets": 0
}
```

| Field | v3 element it feeds | Refresh cost | Staleness handling |
|---|---|---|---|
| `pos` | Mission Control: distance-from-base + direction | free (already polled every 3s by `/api/fleet`) | `null` when offline/unspawned → card already shows this (existing `panel.mjs` pattern) |
| `currentTask.{kind,detail,state,source}` | Mission Control wall state | free, already wired (rounds 1-5) | existing STATUS-HOLD rule: holds last task until replaced |
| `health`/`food` | Mission Control secondary vitals (already on today's cards) | free | existing |
| `inventory` (`{name,count}` only) | Mission Control tool line — **partially**, see Gap G1 | free | — |
| `idleGuard`/`deathCount`/`lastDeath` | already wired into today's cards (round 1); feeds Tribe Stat Wall's deaths-free streak indirectly via `cave/deaths/*.json` (below), NOT this field directly, since `/status` only has the bot's own count | free | existing |
| `poisonedTargets` | not mapped to any v3 element — informational only | free | n/a |
| `gamemode` | not mapped | free | n/a |

**Gap:** no durability, no mission counter, no "distance from base" (base
isn't even a declared constant server-side yet) — see G1, G2, G3.

### 1.2 `GET /events?since=<n>` (per-bot in-memory ring, cap 500)

Shape: `{ events: [{ seq, ts, type, msg }], last: N }`. Types observed in
practice: `chat`, `chat_sent`, `connect`, `death`, `disconnect`, `error`,
`health`, `idle-guard`, `kicked`, `panic`, `quirk`, `system`, `task`. Rate-
capped per type at 30/60s window (commit f46a312) with a rollup line
(`"...suppressed N similar <type> event(s)"`) — already rendered distinctly
on today's cards (round 5).

`panel.mjs` already polls this incrementally (`?since=<seq>`) and keeps a
~65-item rolling window per bot in `eventState` (server memory, resets on
panel restart). **This is NOT a durable record** — it is exactly why Gap G2
(mission history) can't just be "read more of the events ring."

| Feeds | Refresh cost | Staleness |
|---|---|---|
| already-shipped per-card event log (round 4/5) | incremental, cheap | ring resets on panel or runner restart — already documented as "expect gaps" |
| Mission Control drilldown, IF scoped to "recent activity" rather than durable "mission history" | same | same caveat applies — good enough for "last hour," not for "missions today" |

### 1.3 `cave/ledger/<bot>.jsonl` (commit 66a9ca8, new 2026-09-01)

One append-only JSONL file per bot, `.gitignore`d (runtime state, like
logs/pids/deaths). Written from `runner.js`'s `announce()` status branch —
the single choke point every `DEPOT`-prefixed line passes through. Two
line shapes:

```jsonl
{"ts":"2026-09-01T11:12:24.698Z","bot":"Ook","delta":-12,"item":"stick","chest":"chest A","raw":"DEPOT -12 stick (chest A)"}
{"ts":"2026-09-01T11:13:11.534Z","bot":"Ook","raw":"DEPOT -59 torch (chest B), DEPOT +51 torch (chest B) [correction, kept 8]","parsed":false}
```

Parsed lines have `delta`/`item`/`chest` (a positive delta = deposit,
negative = withdraw); unparsed lines only have `raw` + `parsed:false` and
must be excluded from any sum (no clean delta to add) — `cave/ledger.mjs`
already establishes this exact rule, worth mirroring exactly rather than
reinventing it.

Current real data: **one file exists** (`cave/ledger/Ook.jsonl`, 4 lines,
2 parsed / 2 unparsed) — this primitive is brand new and has almost no
history yet. Sparklines will start nearly flat and fill in as the tribe
works; that's honest, not a bug to hide.

| Feeds | Refresh cost | Staleness |
|---|---|---|
| Economy graphs — item flow sparklines, harvest yields (a wheat/bread deposit IS a harvest yield — same primitive, no separate tracking exists or is needed) | cheap today (single-digit KB across all files); **not yet mtime-cached anywhere** — new aggregation code should adopt the same per-file-mtime-check discipline `/api/todo`/`/api/vault` already use, keyed on the DIRECTORY's newest mtime or a per-file map | files only grow (no rotation yet — see Gap G6); a missing `cave/ledger/` dir (fresh checkout, never deployed) must be tolerated exactly like `cave/ledger.mjs`'s own `loadAllEntries()` already does (catch, return empty, no crash) |

### 1.4 `cave/deaths/<bot>.json` (commit 2bdfc15)

One file per bot that has ever died, dedicated dir (mirrors logs/pids
pattern), `.gitignore`d. Shape:

```json
{
  "name": "UngaBunga",
  "deathCount": 2,
  "lastDeath": { "pos": {"x":1,"y":60,"z":2}, "ts": "2026-09-01T09:00:00Z" },
  "deaths": [
    { "pos": {"x":1,"y":60,"z":2}, "ts": "2026-09-01T09:00:00Z", "dimension": "minecraft:overworld", "cause": null, "taskKind": "chop" }
  ]
}
```

`cause` is always `null` today — mineflayer's `death` event carries no
attacker/cause info and this codebase has no damage-source tracking (see
the DEATH LEDGER FIX commit's own comment). **Do not render a "cause"
field as if it might be populated** — it structurally never is right now.

Current real data: **directory is empty** — no bot has died since the
last relaunch. This is the honest state the Tribe Stat Wall needs to
render as "no deaths recorded — streak since relaunch" rather than
inventing a fake start date.

| Feeds | Refresh cost | Staleness |
|---|---|---|
| Tribe Stat Wall — deaths-free streak (days since the MOST RECENT `lastDeath.ts` across all 8 bots' files; if no file exists for any bot, that bot contributes nothing, not a fabricated "never" date) | cheap — 8 small files, mtime-cacheable per file same as vault/todo | missing per-bot file = bot has never died (not an error, not "unknown") |
| Mission Control per-bot drilldown — full death history for that one bot | same | same |

### 1.5 `cave/audit-snapshot.json` (Vault — already shipped, round 7)

Already fully spec'd and shipped by PanelDev this session
(`GET /api/vault`, see `cave/PANEL.md`'s `## Vault` section for the
complete field-by-field contract). Re-stated for this dossier's
completeness:

```json
{ "ts": "...", "port": 3201, "botName": "UngaBunga", "chests": {
  "chest_a_materials": { "oak_log": 76, "...": "..." },
  "chest_b_tools": { "__error": "goto did not reach 12,90,54: timeout" }
} }
```

Joined server-side against `CHEST_META` (hand-synced from `audit.mjs`'s
own `CHESTS` list) for coords/labels. `__error`-shaped entries mean a
read failure, not an empty chest.

| Feeds | Refresh cost | Staleness |
|---|---|---|
| Tribe Stat Wall — total ore banked (sum a defined ore-item-name list across all chests, primarily `chest_d_ore`), bread stock (chest C's `bread` count) | already built, mtime-cached, age computed fresh every call | already handles missing/error/stale per `## Vault` doc — reuse verbatim |

**Spec decision needed, not a data gap:** "total ore banked" needs an
explicit item-name list (`iron_ingot`, `raw_copper`, `coal`, `raw_iron`,
`cobbled_deepslate`? — deepslate/cobblestone are arguably not "ore" in the
tribe's own vocabulary even though they're mined alongside it). Recommend
a short, explicit `ORE_ITEMS` allowlist in the v3 spec so nobody has to
guess later; I've drafted one under §3.3.

"Bread stock" has two honest candidates — banked (chest C, vault data) vs.
carried (summed across all 8 bots' `/status.inventory`, fleet data,
already available). Recommend showing the SUM of both, since the tribe's
real bread supply is both, not one memory location — see §3.3.

### 1.6 `cave/TODO.md` (Tribe Board — already shipped, round 6)

Already fully spec'd and shipped (`GET /api/todo`, `cave/PANEL.md`'s
`## TODO board` section). Restated for completeness: bucketed
`doing`/`todo`/`done`, parsed by markdown table structure, cached on
mtime, malformed rows counted+skipped.

| Feeds | Refresh cost | Staleness |
|---|---|---|
| Tribe Stat Wall — "missions today" is tempting to derive from DOING-row count, but **that is a plan/assignment count, not a completed-work count** — a row can sit in DOING for days. Do not conflate them; missions today needs Gap G2. | n/a — already built | n/a |

### 1.7 `cave/zones.json`

Static named bounding boxes (`mine_stair`, `mine_grid`, `rescue_ramp`,
`test_yard`, `grove_1`, `mine_field`), each `{name, box:{x1,y1,z1,x2,y2,z2}, note?}`.
Used today by `runner.js`/`skills.js` for dig-law/quarantine zones — **not
currently read by panel.mjs at all**.

| Feeds | Refresh cost | Staleness |
|---|---|---|
| Mission Control — could label "where is this bot" as a named zone (e.g. "in mine_grid") instead of/alongside raw coords, by point-in-box lookup against `pos`. Nice-to-have, not one of chief's 4 named fields (task/detail, distance+direction, tool/durability, mission history) — flagging as an OPTIONAL enrichment, not committing panel.mjs to parse it this round unless team-lead wants it added to the Mission Control field list. | trivial (small static file, changes rarely, could mtime-cache like todo/vault) | file missing → just don't show a zone label, never guess |

### 1.8 "tribes-common" / claims files — **NOT FOUND**

Searched the whole repo and `~/tools/` for `claims.json`, a
`tribes-common` directory, or a felcrew-mcp clone. Found none. Grepping
every mention of "claims registry" in this repo's own docs
(`DRIVER_GUIDE.md`, `FEEDBACK.md`, `REBUILD.md`) shows it is **not a
local file at all** — it resolves to
[`monkeorg/cavecrew-mcp#1`](https://github.com/monkeorg/cavecrew-mcp/issues/1),
a GitHub issue thread, plus a Discord channel. `REBUILD.md` line 78's
`claims.json owed BY them` reads as aspirational/planned, not a file that
exists on disk anywhere reachable from this machine.

**Conclusion: FEL relation status has zero local, machine-readable data
source today.** This is the dossier's most consequential finding for the
Tribe Stat Wall — see Gap G4 for the concrete, low-effort fix.

### 1.9 `overseer.mjs` (not importable, hand-synced already for BOTS/TEAM_HEX)

`const CAMP = { x: 12, y: 91, z: 52 }` (~line 43) — used for the idle-guard
ring-distance check and UngaBunga's chop-quarantine logic. **This does not
match** `cave/CIV.md`'s prose base description, "camp centered around
(11-12, 89, 55-57)" (z off by 3-5, y off by 2). Both are real, both are in
active use for different purposes, neither is declared "the" canonical
base-position constant. See Gap G3 — Mission Control's "distance from
base" needs ONE authoritative anchor, and today there isn't one.

---

## 2. GAPS

Each gap below is written to be handed to Engineer as a standalone,
parallel-buildable ask — no gap depends on another shipping first.

### G1 — Tool durability is not in `/status`

**What exists:** `summarizeInventory()` (`runner.js` ~1886) returns only
`{name, count}` per stack. mineflayer/prismarine-item items already
expose `.durabilityUsed` and `.maxDurability` natively on any stack that
supports it (confirmed against `node_modules/prismarine-item`) — tools,
weapons, and armor; food/blocks/materials simply don't have the property
(`maxDurability` is `undefined`).

**Ask:** extend `summarizeInventory()` to include a `durability` object
only when `it.maxDurability` is truthy:

```js
function summarizeInventory(b) {
  const map = new Map();
  for (const it of b.inventory.items()) {
    const key = it.name;
    const existing = map.get(key);
    const entry = existing || { name: key, count: 0 };
    entry.count += it.count;
    // Durability doesn't sum across a stack sensibly (each tool wears
    // independently) — surface the FIRST/current instance's wear, which
    // is what a driver holding one pickaxe actually cares about. Tools
    // don't stack past 1 in vanilla anyway, so this is exact in practice.
    if (it.maxDurability && entry.durability === undefined) {
      entry.durability = { used: it.durabilityUsed ?? 0, max: it.maxDurability };
    }
    map.set(key, entry);
  }
  return Array.from(map.values());
}
```

Resulting item shape becomes `{name, count}` (unchanged for non-durable
items) or `{name, count, durability:{used,max}}` (tools/armor/weapons).
Backward compatible — `panel.mjs`'s existing inventory-chip rendering
(bot cards, vault) doesn't read `durability` and won't break; Mission
Control reads it when present, omits the field from its tool line when
absent (matches every other "hide chip when null" rule already in this
codebase).

**Owner:** Engineer (`runner.js`). **Size:** ~10 line diff, one function.

### G2 — No durable "mission" / completed-task history

**What exists:** the events ring (`/events`) has task start/done lines
but is in-memory, capped at 500, resets on runner restart — not a record,
a recent-activity window. Nothing else in the codebase tracks completed
tasks at all; grepping "mission" across `runner.js`/`overseer.mjs`/
`DRIVER_GUIDE.md`/`CIV.md` returns zero hits as a formal concept (only
loose FEEDBACK.md prose like "mid-mission").

**This blocks TWO of chief's named fields**: Mission Control's "mission
history" and the Tribe Stat Wall's "missions today." Neither can be built
honestly without this.

**Ask:** a new durable primitive, deliberately mirroring the ledger's own
successful pattern (commit 66a9ca8) exactly — same directory-per-concern
convention, same append-only JSONL, same single-choke-point hook:

- `cave/missions/<bot>.jsonl` (new dir, `.gitignore`d like
  `logs/`/`pids/`/`deaths/`/`ledger/`).
- Hook: `markTaskFinished(task)` (`runner.js` ~656) is already the single
  place every task — however it started, however it ends — gets its
  `finishedAt` stamped. Append one line there:
  ```js
  function markTaskFinished(task) {
    task.finishedAt = new Date().toISOString();
    idleSince = Date.now();
    appendMissionLine(task); // NEW
  }
  ```
- Line shape: `{ ts, bot: name, kind: task.kind, source: task.source, state: task.state, durationMs, detail: task.detail, error: task.result?.error ?? null }`.
  `durationMs` needs the task's start timestamp — `startTask()` (~941)
  already creates the task object; stamp a `startedAt` field on it there
  (one field, same object, no extra state) so `markTaskFinished` can
  subtract.
- **Exclude `idle-guard` and `panic-response` kinds from the mission
  count** (not real driver-requested work) but still log them for
  completeness with a flag, e.g. `{"...", "counts": false}` — mirrors how
  the panel already treats `idle-guard` as "idle," not "working," in
  every other view. "Missions today" = count of lines with
  `counts !== false` and `ts` within the current UTC day, across all bot
  files.
- Same tolerance rules as the ledger: append failure = one `logLine('warn', ...)`,
  never throws, never blocks the task-finish path.

**Owner:** Engineer (`runner.js`, ~15-20 line diff plus the new dir
bootstrap + `.gitignore` entry — same shape as the ledger commit almost
exactly, which makes this a fast, low-risk build). **Size:** small,
well-precedented.

### G3 — No single authoritative "base position" constant

**What exists:** two different, both-real, both-in-active-use values —
`overseer.mjs`'s `CAMP = {x:12, y:91, z:52}` (idle-guard/quarantine ring
math) and `CIV.md`'s prose "camp centered around (11-12, 89, 55-57)"
(human-facing description, roughly matching depot chest A's actual
position `(11,89,55)` which `panel.mjs`'s own `CHEST_META` already has
from Vault work).

**Ask — this one is a DECISION, not a code change, but it needs to be
made once and declared, or every future feature that says "distance from
base" silently disagrees with every other one.** Recommend: adopt chest
A's position, `(11, 89, 55)`, as the canonical `BASE_POS` — it's already
a real, physical, unambiguous landmark (not a "center of an imagined
ring"), it's already in `panel.mjs` today (Vault's `CHEST_META`), and it's
within a few blocks of both existing candidates so nothing currently
built on `overseer.mjs`'s `CAMP` breaks in practice if that stays
runner-side-only and panel.mjs declares its own `BASE_POS` for display
purposes (the two constants serve different consumers — one gates a
quarantine ring, one anchors a distance readout — they don't have to be
the literal same constant, but they SHOULD be within a few blocks of each
other and someone should say so out loud once).

**Owner:** team-lead/chief call on which literal point wins; whoever
decides, it's a one-line constant in `panel.mjs`, zero runner.js change
required — direction (compass bearing) is `atan2(dx, dz)` off `pos` vs.
`BASE_POS`, entirely client-or-server computable from data that already
exists.

### G4 — No local FEL relation status data source

**What exists:** nothing. Confirmed in §1.8 — "claims registry" is a
GitHub issue + Discord, not a file. Chief's "FEL relation status" stat
has no honest way to render today; fabricating one would violate every
"never guess, never fabricate" rule this panel has followed for six
rounds.

**Ask:** a tiny hand-maintained file, `cave/fel-relation.json`, updated by
the orchestrator/team-lead when something relation-worthy happens (a
trade, a pact, a dispute) — same spirit as CIV.md's own hand-maintained
roster table, just structured enough for the panel to render without
parsing prose:

```json
{
  "status": "trading",
  "note": "restocking their shop, no disputes open",
  "updatedBy": "orchestrator",
  "updatedAt": "2026-09-01T12:00:00Z"
}
```

`status` enum suggestion: `allied` / `trading` / `neutral` / `tense` /
`disputed` — five states is plenty for a glanceable tile, each gets its
own color once design picks one. Panel reads it exactly like Vault reads
`audit-snapshot.json`: missing file → hide the tile (not "audit never
ran" exactly, but the same "nothing to show yet" semantics); stale
`updatedAt` (no threshold specified by chief — recommend defaulting to
the same 2h-is-arbitrary-but-established precedent Vault uses, or simply
not flagging staleness at all for this one, since relation status
realistically doesn't need hourly freshness the way a chest audit does —
**team-lead's call**, flagging both options rather than picking silently).

**Owner:** whoever writes to it is a process question (orchestrator by
hand, or a small future script), not a runner.js ask — this is the
cheapest gap to close of the four, and unblocks a chief-named stat with
zero mineflayer/game-state work.

### G5 (minor, doc-only) — `DRIVER_GUIDE.md`'s `/status` example is stale

Not a data gap — the real fields all exist — but the documented example
(§1.1) is missing `idleGuard`/`deathCount`/`lastDeath`/`poisonedTargets`
and `currentTask.source`/`finishedAt` entirely. Anyone building v3
against the DOC instead of the CODE will under-spec. Flagging so whoever
picks up G1 also freshens this table while they're in the file — cheap
to bundle, not worth its own round.

### G6 (minor, operational) — ledger/mission files have no rotation

`cave/deaths/<bot>.json` caps its `deaths` array at the last 100 entries
on every write (`persistDeaths`, ~436). `cave/ledger/<bot>.jsonl` and the
proposed `cave/missions/<bot>.jsonl` (G2) have **no such cap** — they grow
forever, append-only. At today's scale (one file, 4 lines, brand new)
this is a non-issue; flagging now so it's a known, deliberate choice
(and an easy future ask — e.g. `cave/ledger.mjs`-side rotation, or a
`--since` default window) rather than a surprise once a bot has been
running for months. **Not a v3 blocker** — the aggregation code in §4
should simply not choke on a large file, which a streaming/line-by-line
read (already how `ledger.mjs` itself reads files) naturally doesn't.

---

## 3. FEATURE SPEC PER SECTION

Every empty/stale/error rule below follows the six rounds of precedent
already shipped in `panel.mjs`/`PANEL.md`: never fabricate, never guess,
hide only when "no data" is itself the normal/expected state (Vault's
missing-snapshot rule), otherwise show the failure honestly where the
data would have gone.

### 3.1 Mission Control Cards

**This extends, not replaces, today's fleet-grid cards.** Rounds 1-5
already built idleGuard chip, lastDeath, 3-state connectivity dot, panic
flag, task-source chip, and the per-card event log onto the existing
card. v3 adds three new fields to the SAME card component plus a
drilldown, rather than introducing a parallel card system.

**Wall state (always visible, no click needed):**

| Field | Source | Empty/stale rule |
|---|---|---|
| current task kind + detail + state | `/status.currentTask` (existing) | unchanged — already handled |
| distance from base + direction | `/status.pos` vs. `BASE_POS` (G3) — `dist = sqrt(dx²+dz²)` (2D, matching how `overseer.mjs`'s own ring check ignores Y), `bearing` → 8-point compass (`N/NE/E/SE/S/SW/W/NW`) via `atan2` | `pos` null (offline/unspawned) → hide the whole badge, don't show "0m" |
| primary tool + durability bar | `/status.inventory`, filtered to the currently-equipped/most-relevant tool (pick the first tool-type item with a `durability` field — pickaxe/axe/sword priority order, matching what `ensureTool` already treats as "the" tool for a task) | G1 not shipped yet → hide the whole tool line, not a fake full bar; durability present but the item is a non-degrading tool variant (shouldn't happen post-G1, but if `max` is falsy, hide) |
| mission history (count today / last N) | new `cave/missions/<bot>.jsonl` (G2) — wall shows just a compact count ("7 today"), full list is drilldown-only | G2 not shipped → hide the whole line (same rule as durability) rather than showing "0" (0 could mean "shipped, no missions yet" OR "not shipped" — those are different facts, don't conflate them; only render the line at all once `/api/missions` (or wherever this lands) returns `ok:true`) |

**Drilldown (click the card, or a dedicated `▸ details` toggle matching
the existing DONE-section/event-log expand language exactly):**

- Full mission list for that bot: last 20-30 entries from
  `cave/missions/<bot>.jsonl`, newest first, each showing kind/outcome/
  duration/timestamp — same visual grammar as the already-shipped
  per-card event log (monospace timestamps, alert-type tinting for
  `state:'failed'` entries).
- Full inventory (today's card already shows top-10 chips; drilldown
  could show ALL stacks, matching Vault's "show everything, cap
  defensively at 30" precedent).
- Full death history for that bot, from `cave/deaths/<bot>.json`'s
  `deaths` array (already have all the data, just not rendered per-bot
  anywhere yet — today's card only shows the aggregate `deathCount` +
  most-recent `lastDeath`).

**Update cadence:** same 3s poll as everything else — no new fetch
frequency needed, mission/durability data just rides along in the
existing `/api/fleet` response (fields added to the same payload) or a
new lightweight `/api/missions?bot=X` fetched only when a drilldown is
actually open (recommend the latter — no reason to ship 20-30 mission
records for all 8 bots on every 3s poll when only one card might be
expanded at a time).

**Interaction model:** click-to-expand inline, matching the exact
max-height/opacity motion already established for the DONE section and
the per-card event log — v3 should NOT introduce a second expand
language. Collapsed by default (density).

### 3.2 Economy graphs

**Wall state:** a compact strip of small sparklines — one per tracked
item (`iron_ingot`, `wheat`, `bread` are chief's three named examples;
recommend generalizing to "top N items by ledger volume" rather than
hardcoding exactly three, so the wall stays useful as the tribe's economy
shifts) — each showing net flow over a fixed recent window (recommend
last 24h, hourly buckets — 24 data points is plenty for a glanceable
trend line and cheap to compute). Beside each sparkline, the current net
total for that window as a plain number (matches the "big number +
trend" pattern chief is already asking for on the stat wall, reused
here at item granularity).

**Drilldown (click a sparkline):** expand into a larger chart — longer
window (7 days, still hourly or daily-bucketed depending on volume),
per-bot breakdown of who contributed the flow (the ledger already tags
every entry with `bot`), and the raw parsed/unparsed entry list for that
item (mirrors `cave/ledger.mjs`'s own CLI output, just rendered instead
of printed).

**Harvest yields:** NOT a separate tracking mechanism — a wheat/bread
deposit IS a harvest yield, same ledger primitive, same aggregation.
Filtering the existing sparkline set to farm-relevant items (`wheat`,
`bread`, `wheat_seeds`) covers this without new code.

**Aggregation approach (server-side, `panel.mjs`):**

```js
// bucket ledger entries into hourly {ts, item} -> netDelta sums, over the
// requested window, per item. Read every cave/ledger/*.jsonl, filter
// unparsed entries out of the sums (same rule ledger.mjs already uses).
```

Cache on the NEWEST mtime across all ledger files (a directory scan,
`fs.readdir` + `Promise.all(fs.stat)`, take the max) — same discipline as
`/api/todo`/`/api/vault`, generalized to N files instead of one.

**Empty/stale states:** zero ledger files anywhere (fresh checkout, no
runner has deposited since the ledger primitive landed) → hide the whole
section, same rule as Vault's missing-snapshot case — "no economic
activity has ever been recorded" is a normal state for a brand-new
primitive, not a broken one. Once at least one file/entry exists, always
render (even a single data point is honest information, unlike an empty
audit which genuinely has nothing to say).

**Update cadence:** ledger files change only on deposit/withdraw events —
does NOT need the same 3s cadence as task status. Recommend a slower
cadence for this section specifically (e.g. 20-30s), decoupled from the
main `refresh()` loop's `Promise.all`, both because the data doesn't
change that fast and because re-scanning N ledger files 3x more often
than necessary is pure waste. This is the one section where I'd
recommend NOT reusing the exact same poll timer as everything else.

### 3.3 Tribe stat wall

Five big-number tiles, each independently sourced — a tile with no data
source should say so, not show a blank or a zero that could be
misread as "confirmed zero."

| Tile | Source | Formula | Empty/stale |
|---|---|---|---|
| Deaths-free streak | `cave/deaths/<bot>.json` × 8 | days since the max `lastDeath.ts` across all files that exist; if NO file exists for any bot, render "no deaths recorded (since relaunch)" rather than a fake day-count | never hide this tile — "no deaths ever" is exactly the good-news state a stat wall exists to show |
| Total ore banked | Vault (`/api/vault`), summed across `ORE_ITEMS = ['iron_ingot','raw_iron','raw_copper','coal','copper_ingot']` (explicit allowlist — recommend NOT including `cobbled_deepslate`/`cobblestone`, which the tribe's own TODO.md vocabulary treats as building material, not banked wealth; team-lead can amend the list, but it should be a declared list, not implicit) | sum across all chests in the snapshot | Vault missing → hide this tile too (no ground truth exists) |
| Bread stock | Vault chest C `bread` count + summed `bread` across all 8 bots' `/status.inventory` (both candidates from §1.5 — recommend the sum since real tribe bread supply is genuinely both) | banked + carried | if Vault is missing, fall back to carried-only with a note ("carried only — no chest audit yet"), don't hide entirely since fleet data alone is still honest partial information |
| Missions today | G2 (`cave/missions/*.jsonl`), UTC-day filter, `counts !== false` | count | G2 not shipped → hide tile entirely (matches Mission Control's same rule — 0 would be ambiguous between "shipped, quiet day" and "not built yet") |
| FEL relation status | G4 (`cave/fel-relation.json`) | direct render of `status`+`note` | file missing → hide tile (matches Vault's rule exactly: "never recorded" is the honest normal state for a file nobody's written yet) |

**Drilldown per tile:** click "deaths-free streak" → full per-bot death
list (same data Mission Control's own drilldown uses, different entry
point); click "missions today" → per-bot mission breakdown; click "total
ore banked"/"bread stock" → the relevant Vault chest cards, scrolled/
highlighted; click "FEL relation" → the note + `updatedAt`/`updatedBy`,
maybe a short manually-maintained history if G4's file grows an array
form later (not needed for v1 of this tile — a single current-state
object is enough to start).

**Update cadence:** same 3s main cycle for deaths/ore/bread (data already
flowing through the main poll or cheap to add); missions and FEL status
can ride the slower economy-style cadence since neither changes
sub-minute.

---

## 4. ARCHITECTURE NOTE

### Current state

`cave/panel.mjs` is 1840 lines today (`cave/runner.js` is 2281, for
scale-of-comparison). Everything — HTTP routing, all data-layer parsing
(fleet aggregation, alerts, TODO board, Vault), the entire HTML document,
every rule of CSS, and the entire client-side JavaScript — lives in one
file, one giant template literal for the page. This has already cost one
real, twice-repeated bug this session: **a literal backslash inside a
client-side regex gets silently eaten by the OUTER template literal's own
escape processing**, because the served page's JS is textually nested
inside `panel.mjs`'s own JS as a string. I hit this exact class of bug in
round 5 (a regex) and caught a second, unrelated "wired but never called"
bug in round 7 only by grepping the SERVED output rather than trusting
the source. Both are symptoms of the same root cause: the client script
isn't really a separate program from the server's perspective, so nothing
(not `node --check`, not an editor, not a linter) can verify it as
JavaScript on its own — every check has to go through "extract the
`<script>` block from the rendered output first."

v3 adds three new sections, each with wall+drilldown state, at least one
new client-side rendering primitive (sparklines) that today's file has
never needed, and at minimum two new server-side data-layer modules
(ledger aggregation, mission-log reader) alongside the two that already
exist (TODO parser, Vault reader). Realistic estimate: v3 alone is
several hundred to ~1000 lines across CSS/HTML/JS. That would push
`panel.mjs` toward 2500-3000+ lines in one file — still technically fine
for Node to run, but past the point where "one file" is actually helping
anyone read, review, or safely hand pieces of it to parallel Workflow
agents without merge conflicts.

### Recommendation: split by CONCERN, not by adding a build step

"No build step" and "one file" are not the same constraint — Node ESM
already supports importing sibling `.mjs` files natively with zero
bundler, and a plain `<script src="/panel.js">` tag can point at a second
route this same `http.createServer` serves as a static file, still zero
build tooling, zero npm installs. Recommend three files, all still
plain, still zero-dependency, still no build step:

1. **`cave/panel.mjs`** stays the HTTP server + route table + the small
   amount of glue (cache objects, `handle()`). This is what boots, what
   `spawn.mjs`-equivalent tooling and the chief's restart routine already
   know about — its role/entry-point doesn't change.
2. **`cave/panel-data.mjs`** (new) — every server-side data-layer function
   that doesn't need `http`: `getTodoBoard`/`parseTodoMarkdown` (existing,
   move as-is), `getVault`/`buildVaultChests` (existing, move as-is), and
   the two new v3 readers (ledger aggregation, mission-log reader/G2
   consumer, deaths-streak scanner). Plain named exports, imported by
   `panel.mjs` with an ordinary `import { getVault, getTodoBoard, ... } from './panel-data.mjs'`.
   This is pure extraction of what's already cleanly self-contained in
   today's file (each of these functions already has zero dependency on
   `req`/`res` or the HTTP layer) — low-risk, mechanical, and immediately
   makes each parser independently testable (a Workflow agent can run
   `node -e "import('./panel-data.mjs').then(m => console.log(m.getVault()))"`
   without booting the whole server).
3. **`cave/panel-client.js`** (new) — the entire client-side script,
   moved out of the template literal into a real, standalone,
   directly-`node --check`-able JavaScript file, served via a new
   `GET /panel.js` route (`fs.readFile` + `content-type: application/javascript`,
   cached in memory the same way `renderPage()`'s HTML string could be)
   and referenced as `<script src="/panel.js"></script>` instead of an
   inline `<script>` block. This is the change that actually kills the
   double-escaping bug class at its root — a real `.js` file has no outer
   template literal to fight with, ever. It is also the single highest-
   leverage change for Workflow-safety: multiple implementation agents
   building Mission Control / Economy / Stat Wall in parallel will all be
   editing "the client script" simultaneously; today that means three
   agents fighting over one enormous template-literal string with
   escaping hazards baked in, versus three agents editing distinct
   well-defined regions of one real `.js` file with normal diff/merge
   semantics.

The HTML shell itself (the static skeleton — header, `<main>`, the
`#board`/`#vault` sections, footer) is small enough and changes rarely
enough that I'd leave it inline in `panel.mjs`'s `renderPage()` rather
than also extracting a template file — splitting three ways already gets
the real win; a fourth split (HTML) adds ceremony for little payoff at
this size.

### Sparklines: hand-rolled inline SVG, no library

Matches the file's zero-deps doctrine exactly and is genuinely simple at
this scale: a sparkline is `N` numbers mapped to an SVG `<path>`. One pure
function, testable in isolation, callable from `panel-client.js`:

```js
function sparklinePath(values, width, height) {
  if (!values.length) return '';
  var max = Math.max.apply(null, values), min = Math.min.apply(null, values);
  var range = max - min || 1;
  var stepX = width / Math.max(1, values.length - 1);
  return values.map(function (v, i) {
    var x = i * stepX;
    var y = height - ((v - min) / range) * height;
    return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
}
```

Wall-state sparklines: no axes, no labels, no grid — just the path (plus
maybe a filled area under it for the "bank total" style tiles), matching
"dense, calm, no decorative noise." Drilldown charts can afford slightly
more (hour/day tick marks, a hover-value readout) but should still be
hand-rolled SVG, not a pulled-in charting library — the doctrine and the
data volume (dozens to low hundreds of points, not thousands) both argue
against needing one.

### Drilldown state

Client-side only, no server persistence needed — a plain per-card/
per-section `expanded` boolean, held in the same kind of module-level JS
object the DONE-section toggle and each card's `evState` already use
today. Re-rendered on the normal poll cycle; never a page reload; never
routed (no client-side router needed — this is explicitly NOT a
multi-page app, it's one page with inline reveal, matching everything
shipped so far). This is not a new pattern to invent, just the existing
one applied three more times.

### Refresh cadence

Recommend NOT putting every v3 fetch on the same single `Promise.all` at
the same 3s cadence. Task status (Mission Control's wall state) belongs
on the fast cycle — it's genuinely live. Economy graphs and the two
slow-moving Stat Wall tiles (missions today, FEL status) do not need
sub-30-second freshness and re-scanning ledger files that often is waste,
not diligence. Recommend a second, independent timer (e.g. 20s) for
economy + the slow stat tiles, decoupled from the main `refresh()`'s 3s
loop — both timers update the DOM in place exactly the same way, just at
different rates.

---

## Summary for the implementing Workflow

- **Buildable today, zero runner.js changes**: Economy graphs (ledger
  already exists), most of the Tribe Stat Wall (deaths-free streak, ore,
  bread — all already-available data), FEL relation tile IF G4's file is
  created by hand first (a `team-lead`/orchestrator action, not code).
- **Blocked on Engineer (parallel, independent asks)**: G1 (tool
  durability, ~10 lines), G2 (mission log, ~15-20 lines, precedented
  almost exactly by the ledger commit).
- **Blocked on a decision, not code**: G3 (which point is `BASE_POS`).
- **Architecture ask for whoever runs the implementation Workflow**: do
  the panel-data.mjs / panel-client.js split FIRST, before building v3's
  new sections into it — building three big new features into the
  current single-file-with-template-literal-JS shape guarantees more of
  the exact bug class this dossier already flagged twice.
