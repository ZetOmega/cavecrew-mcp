# DRIVES-SPEC.md — drive-based self-selection (chief idea, 2026-09-01)

Goal (chief, verbatim intent): replace idle behaviour with drive-based
self-selection. No roles, no injected story, vanilla survival.

## 1. Drives (code, per bot, tick every ~5s)

Needs 0-100: hunger, safety, shelter, resources, social, boredom.

- hunger    = f(food level), spikes <10.
- safety    = night, hostile within 16, hp low.
- shelter   = night AND no bed/enclosed spot in memory.
- resources = missing items for bot's current project (from last reflection).
- social    = minutes since last chat with another bot.
- boredom   = minutes since last successful goal; +15/min, reset on success.

Top need + its context goes into the decision prompt. Model never computes
needs.

## 2. Decision call (Haiku default, Sonnet after 2 consecutive fails)

Input: top 2 needs, compact state (pos, hp, food, time, top-10 inventory,
nearby block types, nearby bots), last goal + result + reason, skill list.
Output JSON: `{need, skill, args, done_check, timeout_s, why}`.
Rules baked into prompt: one goal, must be from skill list, no waiting,
boredom → explore/build/visit, no repeat of failed args.

Decision prompt (chief text):
"Vanilla Minecraft survival bot, self-directed, no leader. Pick ONE goal
from skills. Highest need first; tie → not done recently. Boredom →
explore new area, build, or find another bot and talk. Night without
shelter → shelter. Hungry → food. Last goal failed → change
target/place/method, never same args. Reply JSON only:
{need, skill, args, done_check, timeout_s, why(<=5 words)}."

## 3. Executor / watchdog (code)

- Validate reply: skill in list, done_check present. Invalid → re-prompt
  once with the error, then fall back to cheapest safe skill (gather
  nearest wood/food).
- Run skill; poll done_check; on timeout mark fail:timeout.
- Any fail → set LAST, call decision again immediately. Never sleep on fail.
- Success → reset boredom, log to memory.

## 4. Reflection (Sonnet, every 10-15 min per bot, staggered)

Input: goals done/failed, things seen, chats. Output 3 short lines:
good_at / village_lacks / want_next. Stored in memory, injected into
decision state. Specialization emerges here instead of roles.

Reflection prompt (chief text):
"Review last N minutes. Answer 3 lines: good_at / village_lacks /
want_next. Terse."

## 5. Shared signals (code, no LLM)

Bots periodically announce inventory summary; others store it.
"village_lacks" in reflection reads from these. Enables trade/help
without a planner.

## 6. Concurrency

Decision calls through a queue, max 4-6 in flight. Stagger tick offsets
per bot so 20 bots don't all decide at once.

---

# LEAD ANNOTATIONS (integration law — binding for architect/builder)

A. **Precedence law**: driver-issued task (HTTP task mutex) ALWAYS beats
   the drive engine. Drive engine fires ONLY when: no task running AND no
   recent driver HTTP activity (any HTTP call = activity — this also
   closes issue #7's eval-hijack family for enrolled bots). Driver call
   arriving mid-drive-goal: drive goal aborts cleanly, driver wins.
B. **Enrollment**: per-bot flag, default OFF, config `cave/drives.json`
   (`{"bots":{"Durk":true},"global":true}` — global=false is the
   kill-switch). Runtime toggle endpoint `/drives on|off` like /idleguard.
   PILOT: Durk (3207) first, then Mog (3208). Existing economy bots
   enroll only after pilot proves out (re-learning ramp doctrine).
C. **Baritone bots excluded v1** (no inventory/health API on wrapper).
D. **De-chat law adaptation** (chief decree total de-chat stands):
   inventory-summary signals go BACKEND (shared `cave/signals.jsonl`
   append + read, or peer HTTP) — NOT game chat; protocol spam class.
   Social need is satisfied by REAL bot-to-bot talk in game chat (allowed
   — it is actual talk, players enjoy it). Deviation from spec #5
   flagged to chief; overridable.
E. **Overseer/goal-engine**: overseer SKIPS enrolled bots (drive engine
   owns their idle). Overseer keeps serving non-enrolled bots. Retirement
   decision after pilot.
F. **LLM infra**: `@anthropic-ai/sdk` (to install). Models:
   `claude-haiku-4-5-20251001` (decision), `claude-sonnet-5`
   (escalation after 2 fails + reflection). Key: `ANTHROPIC_API_KEY` env
   or `cave/local.json` `anthropic.apiKey`. **Currently MISSING on this
   box — chief must provide before pilot can run.** Engine must degrade
   cleanly without key: log once, stay dormant, no crash, no retry storm.
G. **Cost guards**: needs computed every 5s (code only); decision call
   only on (idle AND no drive goal running) or immediately after a fail;
   min 20s between calls per bot; per-bot hourly cap 60 calls; global
   in-flight queue 4-6; hard kill-switch (config global=false) checked
   before every call.
H. **done_check is a DSL, never code**: whitelist predicates only, e.g.
   `{"has_item":{"name":"oak_log","count":8}}`, `{"near":{"x":..,"y":..,
   "z":..,"r":3}}`, `{"food_min":18}`, `{"hp_min":15}`, `{"time_passed_s":..}`.
   Validator rejects anything else. Never eval model output.
I. **Memory**: `cave/botmind/<bot>.json` — reflection lines, known
   shelter/bed spots, failed-args ring (last 20), signals cache,
   counters. Gitignored (runtime state).
J. **Skill list**: mapped from the runner's real skill surface
   (cave/skills.js + runner task kinds: chop/mine/goto/collect/craft/
   smelt/deposit/staircase/branchmine/farm/hunt/talk...). Architect maps
   the actual list; no invented skills.
K. **Safety unchanged**: fall-guard, panic reflex, zones/dig-law, no-go
   box, de-chat routing all stay in force under drive goals — drive
   engine issues tasks through the SAME task layer drivers use, no new
   movement primitives.
L. **No live-fleet restarts** during build: feature lands flag-off;
   testing on reserved port 3298 test bot only; economy runners
   (3201-3204) restart only at natural moments with driver coordination.
