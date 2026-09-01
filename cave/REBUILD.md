# REBUILD.md — logout-rebuild phase (2026-09-01)

Chief decree: "go fix yourself, log out all bots, go at your own pace, decide
your own way, become the best civilisation." + Goal v3: **build a massive and
rich civilisation (no cheating), self-improve and learn.**

Fleet logged out 07:30Z. This file is the relaunch contract — orchestrator
executes it top-down at its own pace. Delete when R2 complete.

## State at logout

- Code: blink #2 bundle LIVE and committed (19cacce..9c29c40) — dig-law zones,
  DEPOT de-chat, chat-quiet routing, task-source, sealed-pocket rescue,
  safePlaceBlock verify-retry, panel v1.1 deltas, ghwatch daemon.
- All 9 runners stopped (8 fleet + TestRock). Overseer + scoreboard daemons
  stopped (scoreboard chat-scrape is obsolete post-DEPOT-de-chat anyway).
  Panel (:3200) + ghwatch still running — observability stays.
- Bots' logout positions: SIX trapped in pocket y81-86 under camp (Bonk, Thak,
  Ook, Durk, Mog, Zug). Grog y90 surface, UngaBunga y95 surface.
- Drivers: 8 solo drivers retired (shutdown sent). 4 paired drivers spawned
  (MineDriver=Thak+Ook, HaulDriver=Durk+Mog, BuildDriver=Grog+Bonk,
  EconDriver=UngaBunga+Zug) — all hit session limit, resume after 11:20 Berlin
  via SendMessage (transcripts intact).
- Chest A truth: (11,89,55) is the ONE canonical depot (all code constants
  already point there; drivers banked there all session). The (9,89,55) rebuild
  was destroyed by Bonk mid-escape. BASE.md corrected.

## Root causes logged this cycle (do not repeat)

1. Rescue staircase "done in 1ms" = dig-law refusal, correct behavior:
   launch cell z55 was outside rescue_ramp zone (z56-58) AND orchestrator
   force-fired /staircase before its own /goto landed (self-two-commanders).
   LAW: goto → verify arrival via /status → THEN staircase.
2. Session limit is a real resource. Structure for it: fewer, denser teammates
   (4 paired drivers not 8), deterministic runner code does the grinding,
   overseer idle-defaults keep bots working with ZERO driver tokens.
3. Chest A destroyed by blind "dig ceiling above me" driver loop — furniture
   check before EVERY dig is now in driver templates; safeDig refusal guards
   cover registered furniture.

## R0 — solo prep (bots offline, now)

- [x] Commit working tree (9c29c40)
- [x] zones.json: mine_stair / mine_grid / rescue_ramp / test_yard
- [x] BASE.md chest-A truth fix
- [ ] Entire CLI: healthy in repo (hooks OK, doctor clean) — WAITING on chief
      interactive `entire login`. Fan-out blocked on this per chief order.
- [ ] TODO.md prune + ISSUES.md rollup seed (repo hygiene round)

## R1 — relaunch (REWRITTEN 2026-09-01 ~08:50Z: chief ordered a ONE-TIME
## sanctioned teleport of all 8 bots to safety (17,96,47) + logout. The
## pocket rescue below is OBSOLETE — nobody is trapped. Relaunch doctrine is
## now RE-LEARNING RAMP per cave/LAUNCH.md: start 1 bot + 1 driver, build
## confidence, scale gradually to 8. Homes unset — sethome early per bot.)

1. Boot fleet 8 runners + overseer (NEW code, fresh process, idle-defaults on).
2. Resume 4 paired drivers by SendMessage (transcripts hold their laws+lanes).
3. RESCUE — solved on paper 2026-09-01 (scan + analysis in git):
   SEVEN bots are in the pocket (Grog too). GrogDriver's old tread shelf
   already descends z56/z57 to y86-88; the only gap is two support columns.
   Grog carries 85 cobble + 91 dirt + iron tools. Plan: run the staged eval
   scratchpad ev-bridge.json on Grog (places 5 blocks: (10,82,56),(10,83,56),
   (9,82,56),(9,83,56),(9,84,56), multi-support fallback, per-block verify)
   → then plain /goto surface per bot walks the ramp out. placeBlock root
   cause hypothesis: body-clip of target cell — targets at z56 clear a bot
   standing in z55. If eval placements still fail server-side, escalate to
   chief before any workaround.
   Then sethome ritual at camp surface for ALL EIGHT → convoy done.
4. Thak → entrance (15,89,57) → /staircase toY:54 → branchmine y54 → iron.

## R2 — standing-goal grind

- Farm (Zug): 8 tiles + water + wheat cycle → 5 bread/bot buffer.
- Iron quota ~360 ingots (banked ~41): Thak trunk + Durk/Mog sectors after
  wood targets. Full iron kit all 8, then backlog.
- Plaza + lamp-posts (Grog), chest-A hole heal, path camp→trading post (Bonk).
- Trade: UngaBunga shop restock loop, FEL relations (claims.json owed BY them).
- Terrain-heal issue #5: fill pocket layer with mine spoil, retire hazards.

## R3 — massive + rich (the new horizon)

Candidate ladder (orchestrator picks, chief informed via Discord):
smeltery + furnace bank → roads/bridges district → storage silo v2 with
sorted chests → deep-slate mining y-16 (diamonds, real wealth) → villager
trade hall → beacon (post-nether? needs chief ruling on dimension travel) →
FEL joint infrastructure (shared road, claims registry) → 2 baritone
gatherer bots (headless, capped, already researched) → second settlement.
Principle: every rung = build things that COMPOUND (infrastructure that makes
the next rung cheaper), log lessons to FEEDBACK/skills, adopt felcrew finds.
