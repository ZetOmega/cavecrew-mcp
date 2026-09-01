# EVALUATION.md — cavecrew bench doctrine (v2, 2026-09-01)

## CHIEF RULING (2026-09-01) — binding, read this first

The bench no longer builds itself a world to run in. Verbatim constraints:

- **RCON world-touch is ILLEGAL, with no exception for test infrastructure.**
  `bench.mjs` contains no `/fill`, no forceload, no setblock, no RCON of any
  kind — the `rconchat.js` import is gone. Those words appear in `bench.mjs`
  only inside its own copy of this ruling.
- **Allowed instead:** the test bot **TestRock** withdraws a SMALL lean test
  kit from base **chest A (11,89,55)** — some cobble, wood, a pickaxe, food —
  walks to the test yard, and runs every check **using its own hands only**.
- **Per check:** `goto` runs on natural terrain (no built room); `dig+collect`
  mines natural stone at the yard; `craft` uses kit wood; `place+verify` uses
  the kit's own cobble, hand-placed and **hand-removed after**; `staircase`
  digs natural ground, and the resulting far-wilderness scar at the 264+ block
  yard is accepted rather than restored. If a check ever needs a sealed space,
  it gets a tiny **hand-built cobble shelter from the kit** (peaceful server,
  low risk) — never an admin-built room.
- **Cleanup law:** TestRock returns/banks leftovers to chest A, and the bench
  kills the TestRock-driven task cleanly at the end. The bot **process** stays
  up — this bench never starts and never stops a runner.

Two knock-on consequences, both binding:

1. `TESTLAB.md`'s "TestRock never withdraws from camp chests" line is
   overridden **only** for the bench kit. Both halves of the borrow (withdraw
   and bank-back) go out as `DEPOT` ledger lines in chat, so the loan is
   auditable end to end by anyone reading chat.
2. Because nothing is scaffolded any more, a check can now be **impossible**
   rather than merely failing (chest A is bare, no natural stone in range).
   That case is reported as **SKIP**, never as PASS, and a SKIP still exits
   non-zero: *a check that could not run is not a green light.* See "SKIP is
   not a pass" below.

---

Adopted from felcrew-mcp's `EVALUATION.md` (their fleet evaluation doctrine, same
date) after an adoption survey of their evaluation/evolution system. Their stack
runs a driverless, telemetry-ledgered autonomous agenda with a statistical A/B
bench harness (routes, cluster bootstrap, SPRT, ALGO.md scoreboards — see their
`EVALUATION.md` in full if that's ever the shape our stack grows into). Ours is
smaller on purpose: a deterministic runner (`runner.js`/`skills.js`/`movement.js`)
driven by per-bot LLM drivers, not a driverless agenda. What we adopt here is the
part of their doctrine that transfers regardless of scale: **the discipline of not
trusting a skill's own success claim**, and the one-command pre-flight that
enforces it. This file is the binding decision; `bench.mjs` is the enforcement.

---

## The false-success root (why bench.mjs exists)

felcrew's framing, verbatim because it's exactly our problem too:

> "Reporting success you haven't earned" recurs at every altitude — task, project,
> tool, restock, payload-presence, goto-arrival — because each layer trusts the
> layer BELOW's word for it. The fix is always the same shape: GRADE WITH
> SOMETHING THAT DIDN'T DO THE WORK.

**We have already lived this, not just read about it.** Commit `4725e84`
("movement: ground-truth reached verification + raw-walk fallback (goto
false-success dragon)") exists because `/goto` used to resolve `{reached:true}`
while `bot.entity.position` had not moved at all — sometimes bit-identical down
to the decimal, confirmed live by a fresh `/eval` position read, not a stale
`/status` snapshot (FEEDBACK.md, "goto false-'reached'" + "TORN-GOTO" entries,
Thak/Bonk, 2026-09-01). The commit fixed `/goto`'s own internals. It did **not**
retroactively fix every place a driver, a script, or a future skill trusts a task
result without an independent check — that's a per-caller discipline, not a
one-time patch, which is why it has to be a standing law rather than a closed
ticket. We nicknamed that whole failure class **the goto-dragon**: a task that
reports arrival/completion while the world disagrees. Any new skill, any new
script, any new driver habit that reads a task's own `result` field as proof of
what happened is one blink away from growing a new one.

The corollary felcrew found the hard way, worth carrying forward even though our
stack has no agenda/rung system yet: **a verifier only protects the layer it is
actually pointed at.** Their `mineLane` got marked "VERIFIED done" by grading
`produce`'s own passing assertion — the verifier was honest, the thing it was
handed was wrong. If we ever build anything with an owner/task-identity split
(a queue, a multi-step project, anything that hands a "which task just finished"
pointer between components), audit both halves: does this grade itself, AND is
what reaches the grader actually the thing that did the work.

---

## The law: bench before you ship

**No change to `runner.js`, `skills.js`, or `movement.js` ships to the live fleet
without a green `node cave/bench.mjs` run immediately before the blink.** This is
the cavecrew equivalent of felcrew's Tier-0 gate ("HARD block on version bump").
We don't have their versioned `engine/skills-vN.js` + `CURRENT` pointer or their
rollout manager that mechanically refuses an ungated version (see the skill
versioning note below for why that's on the adopt-later list, not done) — so
today this law is enforced by convention, not by code. Treat it as binding
anyway: a red bench is the same "ROLLOUT BLOCKED" signal their harness prints,
whether or not anything currently stops you from blinking past it.

What counts as "a change to the hot files": any edit to `runner.js`, `skills.js`,
or `movement.js` — new skill, tuned constant, refactor, quirk fix, everything.
Chat-protocol files, `CIV.md`, driver-guide prose, and this file itself are not
gated by bench (they can't false-success a live bot).

**Running it** (post-ruling — bench no longer spawns anything of its own):

1. TestRock must already be up on its own lane, per `TESTLAB.md`:
   `node cave/runner.js --name TestRock --port 3209`. Bench refuses to start
   otherwise, and refuses outright if port 3209 answers as anything other than
   TestRock — a production bot (3201-3208) is never risked by a test.
2. Chest A (11,89,55) must hold the kit: **cobblestone (12 taken), oak_log (2
   taken), one pickaxe (stone → iron → wooden, first found), and 4 food**
   (cooked_beef → cooked_porkchop → bread → cooked_mutton → apple, first
   found). Anything missing is named in the report and skips only the items
   that need it; food gates nothing, it just removes starvation as a confound.
3. `node cave/bench.mjs`. It walks TestRock to chest A, borrows the kit
   (`DEPOT -N` lines), walks the ~264 blocks to the yard in bounded hops,
   runs the five items, walks back, banks everything (`DEPOT +N` lines), and
   `/stop`s its own task. The runner process is left running either way.

## The un-fixtured-run philosophy (no scaffolding in the checklist)

felcrew's clearest statement of the principle, and the reason `bench.mjs` is
built the way it is:

> A stripped-bare run found three blockers a fixtured run structurally cannot
> surface — the fixtures were quietly papering over all three.

**A false success is a worse bug than an honest failure.** An honest failure
tells a driver (or team-lead) exactly what to fix. A false success tells
everyone downstream — the driver narrating progress in chat, the orchestrator's
morning report, `EVOLUTION.md`'s fitness scoring — that something is fine when
it isn't, and that lie propagates until something else independently notices the
world doesn't match the story. That is strictly worse than the task just
failing loudly.

`bench.mjs`'s checklist items are each graded from a **separate** ground-truth
read (a fresh `GET /status` position/inventory snapshot, or a second `/eval`
call reading `blockAt` — never the task's own `result` object) taken by the
bench script itself, before and after the action under test:

- goto → position read after an 800ms settle, not `{reached:true}`. The target
  is a point ~20 blocks out whose standable height came from a fresh `/eval`
  terrain scan, and the verdict needs **two** independent facts: within 3.5
  blocks of the target *and* at least 12 blocks of real displacement from the
  start position. "Arrived" is meaningless if the bot never left.
- dig+collect → inventory diff computed from bench's own before/after snapshots,
  not `mineBlocks`'/`collectDrops`' internal counters. The dig site is real
  terrain: an `/eval` scan picks the nearest **air-exposed** stone-family block
  (stone / deepslate / andesite / granite / diorite / tuff) no more than 3
  blocks below the bot's feet, and the diff is graded on what that block
  actually **drops** — `stone` never lands in a bag as "stone".
- craft → same: bench's own diff is the verdict; the task's self-reported
  `{before,after,gained}` is logged and cross-checked, and a disagreement
  between the two is itself flagged as a finding, never silently discarded.
  The `oak_log` it consumes comes out of the kit, not out of an admin command.
- place → a **second, separate** `/eval` call reads the placed block back from
  the world; the placement call's own resolved promise is not trusted (this is
  literally the shape of the "block confirmed gone but no item drop appeared"
  and "blockUpdate timeout but the block is real" quirks already logged in
  `FEEDBACK.md` — a call resolving is not the same fact as the world agreeing).
  A `placeBlock` that *throws* is not trusted either: the world read decides,
  and a throw is recorded as a note beside the verdict. Under the cleanup law
  the block is then hand-dug and the drop re-collected, and a **third**
  independent read confirms the removal — a block left standing fails the item.
- staircase → net Y-drop from bench's own before/after position read. The
  engine's internal net-descent watchdog (`skills.js` `buildStaircase`, "only
  Xy net drop over steps N-M") is a good in-place stall guard, but it grades
  *itself*; it is not a substitute for an external witness confirming the
  descent actually happened by the amount requested. The cut is left in the
  ground: at a yard 264+ blocks from every base, the ruling accepts the scar.

Fixture setup is still fine and expected — felcrew's own doctrine says so
("fixtures are allowed to build deterministic scenarios, that's the whole point
of a local fixture server"). The line is unchanged: **scaffolding the
precondition is fine, scaffolding — or trusting — the verdict is not.** What
changed is *who is allowed to do the scaffolding*. Under the ruling the answer
is "the bot's own hands, out of a chest-A kit" and nothing else:

- The pickaxe is **borrowed**, not conjured, so mining is possible at all — and
  so `mineBlocks`' internal `ensureTool()` never takes its depot-chest branch
  mid-check, which from the yard is a 264-block detour into the middle of a
  graded item.
- Choosing *where* to dig, *which* face to place against, and *what* height to
  walk to are all reads of the real world, done up front with `/eval`. A read
  that picks a target is setup; a read that decides the outcome is the verdict.
  Bench never lets the second one be the same call as the action.
- The bench still never hands TestRock the *outcome* it is supposed to be
  proving.

## SKIP is not a pass

The old bench built its own room, so every item could always run and the only
outcomes were PASS and FAIL. Hand-run checks on real terrain have a third:
**the check could not run at all** — chest A had no oak_log, no pickaxe came
back, no exposed stone within 48 blocks of the yard. Those are reported as
`SKIP` with the reason, the items that depend on the missing thing are skipped
rather than failed (a bare chest is not a bug in `skills.js`), and:

- `node cave/bench.mjs` exits **0 only if every item PASSED**. Any FAIL *or*
  any SKIP exits 1, printing `INCONCLUSIVE, ROLLOUT BLOCKED`.
- Treat an inconclusive bench exactly like a red one at step 3 of the cycle
  below. "Nothing failed" is not the same fact as "it works" — that is the same
  false-success confusion this whole file exists to refuse, one level up.

Two non-checklist rows are recorded the same ground-truth way and gate the run
alongside the five items: `cleanup-bank-leftovers` (the bag is empty of kit and
test items afterward, per this script's own inventory diff) and `death-guard`
(`deathCount` unchanged across the run). The death guard is the direct
replacement for the old sealed room: nothing shelters the bot now except a
peaceful server and its kit, so the run states out loud whether that held, and
a death is the trigger for hand-building a cobble shelter before the re-run.

## Field-report → fix → bench → ship

The cycle a quirk should travel, matching `EVOLUTION.md`'s own "Quirk found +
logged in FEEDBACK.md with evidence (+8, smart = fit)" scoring:

1. **Field report** — a driver hits something wrong live, logs it in
   `FEEDBACK.md` with real evidence (fresh `/eval` reads, not chat narration —
   see `CIV.md` law 9, ground-truth verify).
2. **Fix** — orchestrator or a driver patches `skills.js`/`runner.js`/
   `movement.js`. The fix should be traceable to the FEEDBACK.md entry the same
   way `4725e84` is traceable to the "goto false-'reached'" entries.
3. **Bench** — `node cave/bench.mjs` green before the fix goes live. If the
   fixed behavior isn't one of the five checklist items yet, that's a signal
   this file's checklist should grow (see Extending the checklist, below) —
   the same way felcrew seeds one Tier-0 fixture per shipped FEEDBACK entry.
4. **Ship** — blink the fleet. Flip the FEEDBACK.md entry to `[shipped]` with
   the commit hash, same convention already in use (see `4725e84`,
   `46f53b1`, `31b7508` in the git log).

A red bench at step 3 means the fix isn't done, full stop — it does not mean
"ship anyway and watch the fleet." That's the entire point of the gate.

## Evolution scoring tie-in (`EVOLUTION.md`)

Bench results feed the fitness ritual, not just the ship/no-ship decision:

- A driver/bot pair whose work triggers a red bench on the NEXT blink (i.e., a
  change made to accommodate that bot's workflow broke a hot-file invariant)
  is a code-bug finding, not a fault of the bot that hit it live — per
  `EVOLUTION.md`'s existing rule, "code bugs are NOT counted against the bot
  that suffered them." Finding and logging the FEEDBACK.md entry that led to
  the fix IS worth the existing "+8, smart = fit" — bench turns that qualitative
  call into a mechanical one (there's a git commit, there's a green bench run,
  the finding was real).
- A field claim of "done" that a bench-equivalent ground-truth check would have
  caught as false is the same false-success class this file exists to catch —
  score it as the task-failed-by-bad-judgment case (-3), not as a completed
  milestone (+10), if a driver reports completion without doing the CIV.md law
  9 ground-truth check first.
- This is deliberately a soft tie-in (human/orchestrator judgment at the morning
  report), not an automated scoreboard — we do not have felcrew's ALGO.md
  machine-written verdict ledger, and building one is out of scope for this
  pass (see below).

## Skill versioning note (gap, not yet closed)

felcrew ships every engine change behind `engine/skills-vN.js` + a `CURRENT`
pointer and a `bench/gates/skills-vN.json` gate report, so a rollout can be
mechanically refused and rollback is "repoint + restart." We have no equivalent
today — `skills.js`/`runner.js`/`movement.js` are edited in place and the only
version record is the git log (commit messages like `4725e84`'s already
function as an informal version note). That is enough for a fleet this size
running under human/orchestrator supervision, but it means "bench before you
ship" above is a **convention**, not something the runner can refuse to start
without. If the fleet or the driver count grows enough that blinks start
happening faster than a human can enforce the law by habit, revisit this: a
lightweight `ENGINE_VERSION` constant bumped per hot-file change, logged into
`GET /status`, would be enough to let `bench.mjs` refuse to certify a version
it's never seen and let a future rollout script refuse to blink an uncertified
one — felcrew's mechanism scaled down, not felcrew's mechanism verbatim.

## Next-adopt item: `toolguard.js`

felcrew's `toolguard.js` (their `bot.dig` choke-point guard, "RIGHT TOOL,
ALWAYS") is a strong candidate for future adoption and is flagged here
deliberately rather than wired in now, per this pass's scope (new files only,
hot files untouched):

- **What it does**: wraps `bot.dig` once. Before every dig, resolves what the
  target block actually requires from `minecraft-data`
  (`block.harvestTools`/`block.material`) and EQUIPS the best satisfying tool
  already in the bag before digging — it does not just refuse, it fixes the
  common case (holding the wrong thing) transparently. Only refuses when
  nothing in the inventory can do the job at all, and only hard-gates
  axe/pickaxe-class work; shovel/hoe stays advisory so legitimate hand-digging
  (dirt, clearing a path) is never blocked.
- **Why it fits us**: our `ensureTool()` already acquires a missing tool
  *before* a skill starts (chopTrees/mineBlocks/branchMine), but nothing
  guards a bare `bot.dig()` call reached via `/eval` or a future hand-rolled
  skill from silently swinging with the wrong tool equipped mid-task (e.g. a
  bot holding a sword after `huntAnimals` that then digs a block without
  re-equipping). toolguard closes exactly that gap, at the one choke point,
  without touching every call site.
- **Why not now**: it patches `bot.dig`, which is squarely inside the "do not
  touch `skills.js`/`runner.js`/`movement.js` this pass" boundary, and wiring
  a new always-on monkey-patch into the hot files deserves its own bench run
  and its own FEEDBACK.md entry when it lands, not a drive-by addition to an
  adoption-survey commit. Filed here so it isn't lost: next engine-touching
  session should port `toolguard.js` in near-verbatim (it's dependency-free —
  `bot`/`bot.registry`/`bot.inventory`/`bot.equip` only), bench it, and ship it
  as its own commit.

## Extending the checklist

Five items today: goto, dig+collect, craft, place, staircase-4-level — chosen
because together they touch every hot file (`movement.js` via goto,
`skills.js` for the rest) and every write path a driver actually uses hour to
hour. Chest withdraw/deposit is no longer on the "not covered yet" list: the
ruling's kit run exercises both, and both are graded ground-truth (against
bench's own inventory diff, not `withdrawFromChest`'s `withdrawn[]` or
`depositToChest`'s `deposited[]`) as the `kit-withdraw` and
`cleanup-bank-leftovers` rows. They gate the run like any other row, they just
aren't one of the five named items.

When a FEEDBACK.md entry describes a NEW false-success shape (not covered by an
existing item or row — e.g. smelting, hunting), add a sixth checklist item to
`bench.mjs` grading it the same ground-truth way, rather than special-casing it
as a one-off script. Two constraints on any new item, both from the ruling:
it sets up its own precondition from the kit or from natural terrain, and it
leaves the world the way it found it (or takes an accepted yard scar). That
mirrors felcrew's "one Tier-0 fixture per shipped FEEDBACK entry" convention at
a scale that fits us: a handful of checklist items in one file, not a
`bench/fixtures/` directory of dozens — revisit that structure only if this
file's checklist grows past what's comfortable to read top to bottom.
