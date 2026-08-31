# FEEDBACK.md — append-only quirk/bug/idea log (FEL-style learning loop)

Every driver logs each quirk/bug/idea THE MOMENT it is found. Engine work
cycles consume open entries. Format:

```
## [open|shipped] short-title — BotName, YYYY-MM-DD HH:MM
symptom / evidence / suggested fix
```

## [open] craft pocket-grid voids materials — Grog, 2026-09-01
/craft birch_planks ate 19 logs, made 4 torches, usedTable:false. FEL confirms:
2x2 pocket batch crafts VOID materials. Fix: ALWAYS craft at table (in flight).

## [open] pathfinder digs with held tool — FEL intel, 2026-09-01
Traversal digging uses currently held tool — long moves eat iron durability.
Fix: equip cheap/no tool before travel legs.

## [open] nuisance block wedges movement — FEL intel, 2026-09-01
Torch/leaf_litter in bot's own tile = path reported but no movement. Detect +
dig block underfoot when goto frozen.

## [open] bucket fill: activateBlock fails — FEL intel, 2026-09-01
Use lookAt(water) + bot.activateItem(), not activateBlock.

## [open] blockAt stale for unvisited chunks — FEL intel, 2026-09-01
Walk near before trusting scans.

## [open] Movements safety config — FEL intel (their fall death), 2026-09-01
Set allowParkour=false, maxDropDown=3, allow1by1towers=false,
allowSprinting=false, infiniteLiquidDropdownDistance=false, scafoldingBlocks=[].
Also stops ugly self-built dirt towers on landscape.

## [open] ledger lines must stay REAL white chat — FEL intel, 2026-09-01
tellraw system msgs don't fire chat events — other bots parse DEPOT/TRADE/USING
lines from real chat. Grey wiring must EXCLUDE protocol-prefixed lines
(DEPOT |TRADE |USING |FREE |LEASE-BREAK |BASE |CLAIM |HELLO |OFFER ).

## [open] health<8 panic listener at game speed — FEL intel, 2026-09-01
Injected health listener: abort task, announce, flee home — BUT when deep/far,
wall off line-of-sight with cobble + eat instead. Game-speed reflex, not LLM.

## [open] torch kit rule — FEL intel (their 3 deaths in dark pockets), 2026-09-01
Every bot carries ≥8 torches on excursions, lights workspace ~7 spacing.
Deep kit below y0: 40 torches, armor, 2 picks, 8 food, durability tracking.

## [open] sign placement via bot fails (blockUpdate timeout) — UngaBunga, 2026-09-01
Orchestrator RCON setblock works; bot-side placeSign needs investigation.

## [open] toss self-repickup — UngaBunga, 2026-08-31
bot.toss reports ok but bot re-grabs own drop; toss + walk 3 back (giveItems
helper in flight).

## [open] pf engine "goal changed" false-fail on short hops — UngaBunga, 2026-09-01
gotoLoopPf failed twice in a row on a ~1-2 block hop right after the blink
restart ("The goal was changed before it could be completed!"), bot barely
moved. Same target with engine:"ash" worked first try. Also hit inside
/deposit (which always uses pf internally, no engine param) — worked around
by skipping gotoChestBlock entirely and calling bot.openChest directly via
/eval once already in range. Suggest: let /deposit and /withdraw accept an
engine override, or default their internal goto to ash post-blink.

## [open] bot.openChest windowOpen timeout, one-shot — UngaBunga, 2026-09-01
Single eval-based bot.openChest(chestBlk) call (dist ~1 block, confirmed
chest block) hung and errored "Event windowOpen did not fire within timeout
of 20000ms". Immediate retry on the same chest, same position, worked fine.
Only seen once, right after the blink restart — logging in case it recurs
for another bot.

## [open] nuisance-block wedge survives /relog, needs tp+restart — Thak, 2026-09-01
Confirms the "nuisance block wedges movement" entry above (had torch +
leaf_litter drops land in own tile after a vertical dig). Adds a fix-scope
detail: /relog is NOT enough — did a full disconnect+respawn (confirmed via
events: "end: relog" then "spawned") and position stayed byte-identical,
zero movement, even through jump/forward/pathfinder.goto, both before and
after the reconnect. Chat/eval/dig-in-place all kept working fine the whole
time — only movement was dead. Only cleared once orchestrator did a
teleport + hard process restart. Suggest: detect-and-dig-underfoot fix
(per the open entry above) is the right permanent fix so this never needs
a manual tp+restart again; until then, escalate straight to tp+restart
rather than looping /relog.

## [open] pathfinder canDig eats camp furniture mid-route — Bonk, 2026-09-01
/goto and auto-/collect both used pf engine and dug straight through solid
blocks in their way as if they were obstacles, not protected builds. First
hit: short goto near old mine scar (15,57) picked up raw_copper + big
dirt/cobble haul with zero mining task running — pf tunneled through a cave
wall it didn't need to. Second hit, worse: auto-collect chasing a far-off
drop routed straight through camp and ate the actual crafting_table at
(12,89,56) as an in-path obstacle, dropped it, picked it up as loot. Ties
into the already-logged "Movements safety config" entry above — needs
canDig:false (or at minimum an exclude-list of protected furniture/build
coords) added to Movements for any bot pathing near camp. Table repair
in progress, complicated further by unexplained mid-repair relocation
(see next entry).

## [open] CONFIRMED: overseer idle-default /collect caused the furniture damage — Bonk, 2026-09-01
Root cause found (read cave/overseer.mjs directly, not guessing): overseer
polls every 30s, and any bot with no "running" task for 60s gets its
role-default fired. Bonk's default is `/collect {radius:16}`. Careful
multi-step eval investigation naturally leaves >60s gaps between calls
(thinking/typing time, not in-game idle) — overseer read those gaps as
idle and fired /collect repeatedly, which routed through camp chasing a
far-off drop and ate the crafting_table (see entry above, same incident).
Not a mystery, not RCON, not a bug in overseer's logic — it's doing
exactly what it's coded to do. Real fix belongs in collectDrops's
Movements (canDig:false / the already-logged safety config), same as the
canDig-eats-furniture entry above. Until that lands, suggest temporarily
dropping '/collect' from Bonk's defaults array in overseer.mjs (BOTS list,
~line 34) while stepped-path construction is active near camp, since that
work involves long inter-call gaps that reliably trip the 60s threshold.
