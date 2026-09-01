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

## [open] pf goto ate blocks near FEL base spawn-in — Ook, 2026-09-01
New bot spawned in at (-6.5,111,3.5), right on FEL base coord (-3,111,4).
Ordered /goto camp (11,89,55) engine:"pf", long haul + big drop
(y111->y81). Landed short of goal (y81 not y89) with 7 dirt + 1 oak_log in
pouch that were never targeted — same canDig-eats-anything-in-path bug
logged above (Bonk), now confirmed happening on a fresh long-haul goto too,
not just short camp-adjacent hops. Can't rule out the oak_log came off a
FEL wall (they build with oak_log per their own DEPOT chat) vs natural
hillside. Holding the items aside, not depositing, pending team-lead call.
Suggest: canDig:false (or protected-coord exclude radius around known
builds, FEL base included) lands before any more bots goto near (-3,111,4).
UPDATE 2026-09-01 (team-lead verdict): dirt/log confirmed natural hillside
pickup, not FEL material — verdict clean, kept + deposited. Root-cause
(pf canDig eats anything) still open, this entry just closes the "was it
FEL's stuff" question.

## [open] SAME BUG hit chest A + chest B, not griefing — Zug, 2026-09-01
Found chest A (11,89,55) AND chest B (12,90,54) both gone — blockAt/findBlocks
read air in a 21x21x8 scan, confirmed at ~1 block range (not the stale-chunk
issue). Zug's own overseer default also includes `/collect {radius:16}`
(see overseer.mjs BOTS list), and this session had many long eval-investigation
gaps near camp (same driver-thinking-time pattern Bonk documented). Ties
directly into the two entries above — near-certain same root cause (pf
canDig tunneling through furniture while chasing a far drop), just chests
instead of the crafting table this time. Neither chest showed up in Zug's
own inventory afterward, so either another bot's auto-collect ate it, or the
dug drop despawned/got sniped before anyone's collect caught it. Whatever
cooked meat (3 porkchop, 1 chicken) and spare furnace Zug deposited earlier
this session may be lost with it — orchestrator should check drops near
camp and replace both chests once the canDig fix lands. Same suggested
interim fix as above: pull '/collect' from Zug's overseer defaults too until
Movements gets canDig:false.

## [open] 4th confirmation: canDig bug, Thak carried unexplained furnace+chest+sign — Thak, 2026-09-01
Independent confirmation of the canDig-eats-furniture bug above (now 4/4
drivers hit it: Bonk, Ook, Zug, Thak). Mid-session found my own inventory
mysteriously holding furnace:1, chest:1, oak_sign:1, oak_planks:77,
dirt:80, birch_log:19 — items I never intentionally mined/crafted. Many
pf-engine /goto calls this session routed near camp with long
investigation gaps in between (same pattern as the other 3 reports).
Strongly suggests MY own goto traffic is what ate chest A/B and the camp
furnace that Zug reported missing. Deposited everything back into
whatever chest currently exists near (9,89,55) so materials aren't lost,
but flagging so orchestrator can connect this to the same root cause
before rebuilding chest A/B/furnace — no point replacing them until
canDig:false lands or they'll just get eaten again.

## [open] /staircase reports "done" with high step-count but near-zero net descent, ate my only pickaxe — Thak, 2026-09-01
Dispatched /staircase {toY:54} from y=87 near (14,87,45). Result: state
"done", detail "buildStaircase: step 96, y=86 -> 54" (looked like healthy
progress the whole time), but result.from={x:14,y:87,z:45} / result.to=
{x:14,y:86,z:46} — ONE level of net descent in 96 dig-steps, not 32.
torches:0 (never carried any). My only stone_pickaxe vanished from
inventory during/after the run (durability death, no drop) with nothing
to show for it. Left me sealed in a leftover 1-tall dead-end pocket
(walls stone N/W, "exit" south blocked by a 1-tall ceiling) that both
/goto engines then reported as unreachable ("no path" on ash, false
"reached:true" with zero position change on pf). Had to manually dig the
ceiling block and eval-walk out. Suspect the step-loop is retrying a
blocked/oscillating dig (maybe digging the same spot repeatedly, or a
stairway direction that loops back on itself) without detecting zero net
displacement. NEEDS FIX before Grog runs the real grand staircase (TODO
#5) — same bug will burn his kit for zero depth too. Suggest: track net
vertical delta vs step-attempts and abort with a clear error the moment
net progress stalls, instead of counting attempted digs as "steps".

## [open] goto false-"reached" + bot.craft(recipe, N>1) only does 1 iteration — Thak, 2026-09-01
Two separate quirks hit back to back on a routine errand (fetch furnace,
craft torches, all well within camp bounds):

1. /goto reported {reached:true} multiple times in a row while
   bot.entity.position (checked fresh via /eval right after) hadn't moved
   at all, sometimes bit-identical down to the decimal. Confirmed genuine
   — not a stale /status snapshot, eval read the live position directly.
   Had real "no path to goal" pockets nearby too (confirmed separately by
   ashfinder/pf both throwing that explicitly), so this may be the same
   root pathing trouble surfacing as a false-success instead of a clean
   failure sometimes. Ended up self-rescuing twice via manual eval
   pillar-jump climbs (dig ceiling + place block underfoot while jumping)
   through solid rock pockets with no path out, ~13 blocks vertical total
   across two separate spots.

2. bot.craft(recipe, N, table) with N>1 crafted exactly one iteration
   (correct delta: -1 coal, -1 stick, +4 torch) then threw
   "Error: missing ingredient" on the very next iteration despite tons of
   both materials left (confirmed via fresh inventory read same tick).
   Reproduced 2x with different batch sizes. Workaround: loop
   bot.craft(recipe, 1, table) one at a time, calling
   bot.recipesFor(...) fresh before each single craft rather than reusing
   the recipe object or count param — that ran clean for 20+ iterations
   straight to make 100 torches. Suggests the recipe object mineflayer
   hands back may not be safe to reuse across multiple internal craft
   ticks, or count>1 miscounts available ingredients after the first
   round-trip.

## [open] broken crafting_table sometimes drops nothing — Thak, 2026-09-01
Placed my own held crafting_table twice to have a workbench mid-errand
(camp tables were both gone from an earlier canDig incident), used it,
then broke it with an axe/pickaxe in hand each time to take it back.
Both times: block confirmed gone (blockAt returns air right after), but
no item entity ever appeared nearby (checked bot.entities for item drops
within a few blocks, empty both times) and a /collect sweep found
nothing. Lost 2 real crafting_table items this way with nothing to show
for it — normal vanilla behavior is a guaranteed drop on any tool. No
repro steps beyond "place, use, break" — happened identically twice in a
row on the same bot/session, so leaning toward a real bug rather than a
one-off despawn race, but sample size is only 2.

## [shipped] table pocket-craft restoration worked — confirms two fixes — Thak, 2026-09-01
Team-lead's pocket-craft protocol worked clean on first try: 1 oak_log ->
4 oak_planks (single craft, exact diff), 4 planks -> 1 crafting_table
(single craft, exact diff). No void either time — confirms the earlier
"bot.craft(recipe,N>1)" bug is specifically a batch-count problem; single
iterations are safe.

Also confirms a placeBlock fix: placed the new table back at canonical
(12,89,56), which needed 2 floor blocks rebuilt too (dirt at y87/88, hole
left over from an earlier tunnel mishap). Standing directly in the target
column and referencing the block straight down from my own feet (face up)
is what kept timing out all session ("Event blockUpdate did not fire").
Switched to: stand one block to the SIDE of the target column, reference
the block one-down-and-beside, face up — all 3 placements (dirt, dirt,
crafting_table) went through instantly, zero timeouts, zero retries.
Recommend this as the default placeBlock pattern in skills.js: side-stand
+ side-reference, not self-referencing-straight-down.

## [open] 3-signature stuck-in-place taxonomy — Bonk, 2026-09-01
Hit all three flavors of "bot won't move" in one session on the same path
build, each needing a DIFFERENT fix — worth telling apart before reaching
for any single cure:

1. TORN-GOTO: goto resolves {reached:true} instantly, bot.pathfinder never
   engages (isMoving/isMining both false, controlState:{} checked right
   after) — caused by a runner blink loading mid-edit on movement.js
   (torn code snapshot, same class as the original torn-boot bug). No
   amount of retrying fixes this; needs the clean blink to land. Confirmed
   by team-lead's diagnosis.

2. FULL-WEDGE: position stays byte-identical through EVERYTHING — goto,
   raw setControlState jump/forward, all of it (moved:0 exact). This is
   the bot's own client-physics frozen, not a pathing problem. Confirmed
   fix (2/2 so far, Thak + Bonk): needs BOTH a teleport AND a hard runner
   restart — restart alone doesn't clear it, matches the earlier "survives
   /relog" entry above.

3. STEP-SNAG: goto fails/stalls on one specific short hop, but raw manual
   movement (setControlState forward, or forward+jump) DOES produce real
   partial displacement (not zero) — just slow/inconsistent, sometimes
   needing several repeated bursts. Two different root causes hit this
   session, both masquerading identically:
   - A REAL block obstruction (self-built tread stacked directly above
     another tread, blocking headroom for the lower one — a build mistake,
     not an engine bug). Fix: verify actual current blockAt state fresh
     (topY scans done before walking close can be stale — see the
     already-logged stale-chunk entry) and rebuild the step with correct
     spacing, or as team-lead suggested: break + horizontal-reference
     re-place the tread (matches Thak's placeBlock fix above, 3rd
     confirmation of that pattern).
   - Another bot's entity physically standing in a narrow (1-2 wide) path
     tile. blockAt sees nothing wrong (entities aren't blocks); the fix is
     checking Object.values(bot.entities) for anything within ~1 block of
     the stuck position, not touching the terrain at all. Only spotted
     after exhausting every geometry-based fix — should be the FIRST check
     for any step-snag, cheaper than rebuilding anything.

Diagnostic order for future stuck-in-place reports: (a) check nearby
entities first (cheap, rules out the collision case entirely), (b) raw
setControlState jump/forward test — zero displacement = full-wedge
(escalate for tp+restart), nonzero/inconsistent = step-snag (rebuild the
tread or route around), (c) if goto claims reached:true with zero
displacement AND raw control also does nothing, check whether this
follows a recent blink — that's torn-goto, just wait for the clean one.
