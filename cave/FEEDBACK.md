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
UPDATE 2026-09-01 (chief decree, DEPOT DE-CHAT): DEPOT is EXEMPTED from this
rule and removed from runner.js's PROTOCOL_PREFIX — depot lines are our own
bookkeeping, not an inter-tribe protocol, and they now route to the Discord
status feed via announce('status'). Every other prefix above is unchanged and
still enforced. Drivers keep sending DEPOT lines via /chat as before, format
unchanged. Known consequence: cave/scoreboard.mjs parses "DEPOT " out of the
server latest.log CHAT lines only, so its depot accounting goes silent until
repointed at the new feed.

## [open] health<8 panic listener at game speed — FEL intel, 2026-09-01
Injected health listener: abort task, announce, flee home — BUT when deep/far,
wall off line-of-sight with cobble + eat instead. Game-speed reflex, not LLM.

## [open] torch kit rule — FEL intel (their 3 deaths in dark pockets), 2026-09-01
Every bot carries ≥8 torches on excursions, lights workspace ~7 spacing.
Deep kit below y0: 40 torches, armor, 2 picks, 8 food, durability tracking.

## [open] sign placement via bot fails (blockUpdate timeout) — UngaBunga, 2026-09-01
Orchestrator RCON setblock works; bot-side placeSign needs investigation.

## [open] setControlState no-op without preceding bot.look() — Thak, 2026-09-01 06:40
CONFIRMED reproducible: bare bot.setControlState("jump",true) (or "forward") in
eval produced ZERO position/velocity change for 3+ consecutive full test batches
(fixed-sleep AND polling-wait variants both failed identically, ruling out
timing) — velocity.y stuck at passive gravity tick (-0.0784) the whole hold
window, onGround never left true. Root cause isolated: NOT a "wedge"/stuck-bot
state (this was NOT the nuisance-tile bug — target tile was already clean air).
Adding a single bot.look(bot.entity.yaw,0,true) call immediately before the
setControlState toggle made jump AND forward work correctly every time after,
in the same session, same bot, same spot. Suspect: control-state changes get
silently dropped by the client tick loop until a look/position packet is sent
to "wake" it, possibly after any prior eval task leaves controls idle for a
stretch. Fix: ALWAYS call bot.look(bot.entity.yaw, bot.entity.pitch, true)
immediately before setControlState-driven movement in any eval script. This
likely explains some/all of the earlier "movement wedge" reports this session
that tp+restart "fixed" — restart implicitly re-establishes look state too.

## [open] placeBlock uses currently-held item, not a smart pick — Thak, 2026-09-01 06:40
Pillar-climb loop's placeBlock calls kept failing with "Event blockUpdate did
not fire within timeout of 5000ms" against a perfectly valid solid reference
block. Ground-truth check (bot.heldItem) showed bot was holding a TORCH (left
over from earlier route-marking) — bot.placeBlock places whatever is equipped,
it does NOT auto-select a sensible building block. Compounding gotcha: a torch
sitting in a tile reports boundingBox:"empty" (correctly, for movement/pathing
purposes) but STILL occupies the tile for block-placement purposes, so a
naive "only dig if boundingBox==='block'" clearance check misses it entirely —
must instead check block.name!=="air" when clearing a placement target. Fix
for any place/build skill: explicitly bot.equip(desiredBlockItem,"hand")
right before every placeBlock call, and clear target tiles by name!=="air",
not by boundingBox.

## [open] mine/collect wedge-detector false-positives on tight ore pockets — Thak, 2026-09-01 06:52
Both a /mine and a /collect task failed back-to-back with the runner's own
"wedge: zero progress over 90s ... likely wedged; escalate per stuck-taxonomy"
error, at the exact spot a coal_ore vein had just been dug out. Ground-truth
check (blockAt scan of the 3x3 column around feet) showed the real cause each
time: the bot was simply sealed in a 1x1 mined-out pocket — every horizontal
neighbor at foot level solid, nothing to move "forward" into regardless of
facing. This is a normal, expected end-state after digging an ore vein, NOT
an engine wedge. Manually digging one side wall free (bot.dig on the block at
feet.offset(-1,0,0) toward whichever neighbor cell has head-height clearance)
and walking out worked instantly both times — no tp/restart needed. The
runner's stuck-taxonomy escalation ladder is overkill for this case and wastes
90s + a task failure per occurrence. Suggest: before declaring a wedge, have
mine/collect check whether ALL 4 horizontal foot-level neighbors are solid
(self-dug-in pocket) and auto-dig one exit before falling through to the
raw-control-test/tp+restart ladder — same fix likely helps buildStaircase too.

## [open] genuine movement wedge, look-fix + relog both failed — Thak, 2026-09-01 07:11
Distinct from the two "wedge" entries above (which were both false positives —
tight ore pocket and diagonal corner-cut). This one is real: at (11,86,55),
directly below chest A, bare bot.look()+forward-alone produced velocity.x/z
exactly 0, isCollidedHorizontally:false, feet tile confirmed clean air (no
nuisance block), onGround:true — everything structurally normal, just zero
control response. Tried /relog per the standard ladder: reconnected fine but
did NOT clear the freeze (identical zero-velocity result immediately after).
Escalated to team-lead for tp+restart (the one thing that reliably cleared
this class of wedge earlier in the session). Also flagging as a possible
correlated cause: this exact spot had a 100% (20/20) placeBlock failure rate
moments before the freeze, right in the column under chest A/camp footprint,
after normal partial-success rates everywhere else in open cave this session —
worth checking whether a region-protection plugin around camp is involved in
both the placement wall and this freeze.

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

## [open] event ring flooded by FEL join/leave spam — useless for forensics — team-lead, 2026-09-01
Ook's ring at seq 10k+: nearly every entry = "[FEL] X joined/left the game"
(their reconnect storms). Task/error events drowned out — could not
reconstruct a task-replacement sequence. Fix: exclude foreign join/leave
system messages from the ring (or keep a separate task-only ring). Cheap,
high forensic value.

## [open] UPDATE on "force task silently replaced": may be TWO-COMMANDERS problem — team-lead, 2026-09-01
New data: my forced goto on Ook (task-8, accepted, running) was replaced
within 45s by a hunt task — but OokDriver was simultaneously running his own
meat-run chain. The Durk/Mog cases also had drivers issuing their own
force-gotos around the same window. So "idle-guard eats tasks" may really be
"orchestrator and driver both command the same bot" — last write wins, each
side sees its task vanish. DOCTRINE FIX adopted now: ONE commander per bot —
driver owns the bot while active; orchestrator pushes only to bots with
idle/absent drivers, and messages the driver instead when active. Code-side:
arbitration check still worthwhile (a task-source field on tasks — driver vs
orchestrator vs idle-guard — logged per replacement would settle this
forever).

## [open] goto false-reach reports IDENTICAL stale distance from different positions — Grog, 2026-09-01
pf goto false-reach check reported the EXACT same "9.30 blocks horiz / 3.00
vert" on two separate attempts from two DIFFERENT actual positions — cannot
be a live measurement. Looks like the distance in the false-reach error is
computed from a stale/cached position (or the goal snapshot) rather than
bot.entity.position at check time. Separate from the known 1.80 constant-gap
bug (that one is fixed). Check goalGroundTruth's position source in
movement.js. Workaround that worked: short pf hops instead of one long goto.

## [open] chopTrees root cause: ensureTool axe-craft-chain wedges bare-handed — UngaBunga, 2026-09-01
Follow-up to the entry below with the real signature, from a watched
count:1 test: task failed at detail "ensureTool: craft chain for axe",
error "wedge: zero progress over 90s (no ite[ms gained?])". Reproduced with
zero logs/planks/sticks/axe in inventory, no crafting table or depot chest
within reach (90+ blocks out in the south wood zone). Looks like the
craft-chain has nothing to bootstrap the very first log from and just sits
waiting rather than punching one bare-handed. Suggest: ensureTool's axe
chain should try one bare-hand log punch first when totally bare, before
falling back to table/depot logic.

## [open] ROOT CAUSE of chop deaths: ensureTool axe craft-chain wedges when totally bare — UngaBunga, 2026-09-01
Trace test (count:1 chop, live watch): task died at detail "ensureTool: craft
chain for axe" with wedge-watchdog error "zero progress over 90s". NOT a
chopTrees stall — ensureTool's craft chain deadlocks when the bot holds ZERO
log/plank/stick AND no table AND no depot chest in reach (bare kit, 90+
blocks from camp = exact setup on every dead run). It waits for materials
nothing will ever produce. Fix: when fully bare-handed far from base,
ensureTool must BOOTSTRAP — punch ONE log bare-hand first (slow but
guaranteed), then table→sticks→axe. Watchdog worked perfectly here (loud
fail instead of eternal running). Supersedes/refines the "chopTrees dies
with stalled" entry below.

## [open] chopTrees dies with "stalled" mid-tree, no auto-retry — UngaBunga, 2026-09-01
/chop task failed outright with result.error:"stalled" while at "chopping
tree 1/12" (south wood zone, z=109, well clear of camp). Bot did not
recover on its own; sat at idle-guard cycling with zero logs gained until
team-lead force-pushed a fresh /chop. No world hazard (health/food both 20,
open ground) — looks like an internal watchdog inside chopTrees giving up
rather than retrying the current tree or moving to the next one. Suggest:
chopTrees should treat a single-tree stall as "skip this tree, try next"
rather than failing the whole task.

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

## [open] placeBlock false-success, sibling to goto false-reach — Bonk, 2026-09-01
Batch-filled 7 honeycomb pit columns via eval, got res:"ok" for most placements
(no thrown error), moved on trusting that. Came back later for a fresh check
and 5 of 7 had reverted to air — the blocks never actually landed despite
"ok". Redid all 7 one at a time, verifying blockAt(target).name === expected
material immediately after each placeBlock call (not just checking the
promise resolved) — that caught every real failure, including several
disguised as "ok" the first pass. Same family as the already-logged goto
false-reach bug (resolves success without the effect actually happening),
just on the place side instead of movement. Lesson: never trust a
skill/eval's own ok:true for a world-mutating action — always re-read the
actual block/position state as the real check.

## [open] idle-guard wandered Bonk into an adjacent uncapped pocket — Bonk, 2026-09-01
Parked at camp (11.4,89,55.5) per standing order, no active driver task issued
for a while. Team-lead caught me at (13.7,85,49.6) — 6 blocks down, z=49-50,
just OUTSIDE the honeycomb zone I'd already sealed (14-15,85-89,44-48).
Picked up 3 cobblestone along the way that I never mined myself. Best read:
runner-level idle-guard's own auto-collect/sweep behavior (same family as
the earlier canDig-eats-anything-in-path entries above) walked me into a
NEW adjacent cave pocket chasing a drop while I had no task running —
sealing 7 columns in one zone doesn't help if the honeycomb extends further
than mapped. Suggest: either widen the hazard_old_shaft BASE.md footprint
once someone re-surveys the full extent, or give idle-guard's wander radius
a hard cap so "parked, no task" doesn't turn into "parked, but relocated
underground" for a bot that's supposed to be holding still.

Diagnostic order for future stuck-in-place reports: (a) check nearby
entities first (cheap, rules out the collision case entirely), (b) raw
setControlState jump/forward test — zero displacement = full-wedge
(escalate for tp+restart), nonzero/inconsistent = step-snag (rebuild the
tread or route around), (c) if goto claims reached:true with zero
displacement AND raw control also does nothing, check whether this
follows a recent blink — that's torn-goto, just wait for the clean one.

## [open] /collect finds nothing despite real nearby drops — Bonk, 2026-09-01
Two separate /mine runs (16 then 6 stone, task reported success both
times, verified real — mined positions confirmed air afterward, not a
mining-lied bug) each followed immediately by /collect (radius 16 then
24). Both times result was {collected:[]}, cobblestone count unchanged.
But a direct entity scan (Object.values(bot.entities).filter(e=>e.name
==="item")) found 9-11 real item drops sitting 2.8-8 blocks away — well
inside the collect radius used both times. So the drops genuinely exist
and are close, /collect just isn't finding or reaching them. Lost 22
stone worth of cobblestone this way. Manual walk-to-the-drop pickup also
struggled in that specific spot (honeycombed old mine-entrance area,
lots of leftover holes from earlier sessions — may be a contributing
factor: e.name==="item" drops sitting inside/near dug-out pockets could
be harder for the collect skill's pathing to reach even if they're
"nearby" in raw distance). Suggest: skills.js collectDrops needs its own
diagnostic pass — check whether it's using a stale/short-radius entity
query, or failing silently on a pathing step to each drop without
logging why. Interim workaround: after any /mine call, manually scan
bot.entities for item drops and walk-to each by hand rather than
trusting /collect's report.

## [open] two distinct /staircase stall modes post-blink, watchdog confirmed working — Thak, 2026-09-01
Net-descent watchdog (the fix shipped for my earlier "step 96, zero
descent" bug) works exactly right in all 4 test runs today — aborts
cleanly with a clear net-drop error the moment progress stalls, no more
silent durability burn. But real descent is still broken in two separate
ways:

1. Starting INSIDE a built structure (tried 3x from the canonical mine
   entrance, inside Grog's Mine House): 0.00-1.00y net drop over 9 steps,
   every attempt, regardless of facing direction. Interior room geometry
   (walls, a doorway with an odd air-below/planks-above gap right next to
   the spot) seems to confuse the dig-direction logic immediately.

2. Starting on CLEAN open ground (24,89,60, facing away from all builds):
   worked correctly for ~10 steps (real 2-block descent, real
   dirt/cobblestone collected), then hard-stalled for the next 9 steps
   (0.00y net drop) and aborted. Checked blockAt at the stall point: solid
   stone straight down x2, dirt/stone to 3 sides, but the 4th side was
   open air — looks like the edge of a small natural cave/cliff pocket.
   Guess: the algorithm doesn't have a safe path when it meets a natural
   void mid-descent (retries against nothing instead of routing around or
   building through it), as opposed to it not working on any clean-ground
   descent at all.

So: interior starts break immediately, clean-ground starts work until
they meet a natural void. Both need a fix before the grand staircase can
actually reach y54. Diagnostic breadcrumb for whoever picks this up: check
blockAt in all 4 horizontal directions at the exact spot where net-drop
goes to 0.00 — an open-air side there is the void case; solid-but-odd
geometry (like a doorway) on all sides is the interior case.

## [open] dragon-fix (movement.js 4725e84) real progress, 3rd distinct staircase stall pattern — Thak, 2026-09-01
Confirms the movement/goto ground-truth fix is a genuine improvement:
retried /staircase {toY:54} from virgin ground post-fix and got real
motion for the first time all night — walked x14->16.7 (2.7 actual
blocks) over 9 steps, real digging, a torch got placed, net descent
y88->87 confirmed. Best result of the session by a wide margin.

But the watchdog still caught it at step 10 ("only 1.00y net drop over
steps 1-9"). Checked the stall point (16.7,87,44.5): ahead/aheadDown =
air, aheadFloor = solid stone, north/south = stone. Completely clear,
diggable path — NOT the void case (open side) and NOT obvious interior
geometry either. So this is a third distinct signature: clean ground,
nothing blocking, yet net descent still stops accumulating after ~9
steps. Possible causes worth checking: (a) digging the same already-clear
cell repeatedly instead of advancing the target coords, (b) a step-up
immediately undoing the prior step-down (net cancels to near-zero even
though gross movement is happening), (c) landing/rest-step logic in the
staircase pattern that doesn't count toward net-descent tracking. Given
real walking now works, this looks like the last piece — the algorithm's
own step-advancement logic, not the movement layer underneath it.

## [open] window-1 retry CONFIRMS dig-geometry bug: 0.00y net, barely any x/z drift either — Thak, 2026-09-01
Retry from the exact same spot (16.7,87,44.5), same heading, polling y
every ~15s per team-lead's test design (window 1 = steps 1-9, window 2 =
steps 10-19 — the plan was: window 1 ≤1y again = confirmed bug, window 2
hits 2y+ = false alarm, let it run). Full trace:

  t=15s y=87 (step ~2) | t=30s y=87 | t=45s y=87 (step4) | t=60s y=87
  (step5) | t=75s y=87 (step6) | t=90s y=87 (step8) | t=105s y=87.2
  (step9, torch placed) | t=120s y=87 (step9, lingering) | FINAL:
  watchdog fires at step 10, "0.00y net drop over steps 1-9"

Result: window 1 = 0.00y this run, flatter than the first retry's 1.00y.
Never reached window 2 — watchdog stopped it exactly at the window-1
checkpoint as designed, confirming the dig-geometry bug per team-lead's
own decision criteria. Bonus finding: x stayed ~16.5-16.7 and z stayed
~44.3-44.5 the whole time too — this isn't "digs sideways instead of
down", it's "barely advances the reference position in ANY axis" despite
9 real logged steps and real block breaking (cobblestone went 12->13,
one torch got placed). Whatever coordinate the dig-target sequence
computes each step isn't moving forward much at all, in any direction —
worth checking the ahead-down step math for an off-by-one or a target
that keeps resolving to the same or an adjacent-but-not-advancing cell.

## [open] new validation rejects a genuinely valid step cell — Thak, 2026-09-01
Latest code round added new pre-checks (interior-geometry detection +
likely the void-ahead handling). Relocated to confirmed genuine open
surface (climbed out of my own old tunnel to real sky, verified visually
via column scan) to retest. New error, immediate, step 1: "staircase:
cannot advance into step at (15,96,43)".

Manually inspected that exact coordinate: block = air, block above = air,
block below = solid stone. That is a completely valid, safe, diggable
step cell by every check this guide teaches — nothing wrong with it.
So the new advance-validation logic is rejecting a target that's
actually fine. Given the earlier "no viable heading from start (interior
geometry)" message also fired correctly for me once this session (when I
really was underground in my own tunnel, not open ground), the geometry
detection itself seems to work — this looks like a separate bug in
whatever check runs AFTER heading selection, when it tries to actually
step into the chosen cell. Worth checking whether the "cannot advance"
check is looking at the wrong offset (e.g. off-by-one relative to the
cell it just validated) or double-validating something already confirmed
safe by the heading scan.

## [open] runner restart erases death evidence (deathCount/lastDeath in-memory only) — Durk, 2026-09-01
Durk's full kit vanished between polls (38 cobble + 2 picks + coal/copper →
empty), position reset to camp spawn, health full — classic death. But runner
process restarted around the same moment: event ring buffer reset to bare
"spawned" seq 1, task counter back to task-1, deathCount read 0. Real death
became invisible — no coords logged (violates "death coordinates always
logged" law), no evolution -15 scoring possible. Fix: persist deathCount +
lastDeath (+ small death ledger w/ coords) to a gitignored deaths.json on
every death event, reload on runner boot. Fold into next runner.js code pass
(bundle with narration-leak audit — same file, one blink).

## [open] exact 1.80-block reach gap on EVERY unreachable /mine candidate — Bonk, 2026-09-01
Virgin-ground retest (20-22,93-94,68-70): every single unreachable-candidate
log line reads "still 1.80h" — same exact 1.8 horizontal shortfall, dozens of
times, many different targets, multiple task instances. Not luck — fixed
offset bug in the reach-approach math (reach/stop-distance constant short by
~1.8, likely GoalNear range vs ensureWithinReach eye-distance mismatch:
approach stops at goal range but eye→block-center check then fails by the
same margin every time). False-reach catcher itself never lies — it just
can't close this constant gap. Fix in skills.js approach logic (queued
behind staircase rebuild — same file, one blink).

## [open] ensureTool has no chest-withdraw fallback when no trees nearby — Durk, 2026-09-01
Hit the identical failure twice this session, both times bot had zero/low
planks: "mineBlocks: pickaxe required but ensureTool failed: ensureTool:
could not gather any logs for planks". Per DRIVER_GUIDE, ensureTool's chain
is supposed to be check-inventory -> withdraw-from-depot -> gather/craft, but
in practice when the bot's *current position* has no reachable trees, it
never falls through to trying the chest-A withdraw step at all — it just
fails the whole task on the chop attempt. Chest A had 70+ oak_planks/42
oak_log both times (confirmed by manually withdrawing from it seconds
later), so the materials were sitting right there and ensureTool didn't
reach for them. Workaround used both times: manual /goto to chest A (11,89,
55), /eval a precise `chest.withdraw(item.type, null, N)` for oak_planks
(HTTP /withdraw has no count param, see below), then /goto the crafting
table at (12,88,56) and /eval bot.craft a stone_pickaxe by hand. Suggest:
ensureTool should try the depot withdraw step unconditionally before
attempting to chop, not only as a fallback after a chop attempt already
failed.

Related, smaller gotcha: HTTP `/withdraw` and `/deposit` (skills.js
withdrawFromChest/depositToChest) take an `items` name list but no count —
they always grab/dump the ENTIRE matching stack in the chest or inventory,
no partial amounts. Cost chest A's whole wood buffer briefly (had to
withdraw-then-redeposit the full stack to fix it). If you need an exact
count, skip the HTTP endpoint and go straight to /eval with
`bot.openChest(block)` + `chest.withdraw(item.type, null, exactCount)`.

## [open] chop task claims progress while full-wedged — no task-level watchdog — team-lead, 2026-09-01
UngaBunga chop ran 8+ min stuck at "chopping tree 1/12": position byte-stable,
zero logs gained, no axe held, raw forward+jump moved 0.02 blocks (full-wedge
signature). Task state stayed "running" the whole time — nothing detected the
stall. Staircase now has a net-descent watchdog; chop/mine/collect have NO
equivalent. Fix: generic task-progress watchdog in runner/skills — if a
gathering task gains zero target items AND net movement <1 block over ~90s,
abort with clear wedge error so overseer/driver escalates to tp+restart
instead of trusting "running" forever. (Cure confirmed again: tp + hard
runner restart = 3/3 on full-wedges.)

## [open] placeBlock false-success: reports ok, block never sticks — Bonk, 2026-09-01
Honeycomb seal: 5 of 7 caps "placed ok" (eval res:"ok") earlier in session had
reverted/never existed on fresh re-check — air again. Same disease family as
goto false-reached, now confirmed on the PLACE side. Grog saw the same during
floor patching (batch placements "successful" but not landed, redone with
in-loop verify). Law until code fix: NEVER trust placeBlock/res:"ok" alone —
verify blockAt(target).name === expected immediately after EVERY placement,
retry on mismatch. Code fix for Krug queue: build verify-after-place into
safePlaceBlock (skills.js) itself — check + one retry + hard error, so callers
can't skip it.

## [open] force:true task accepted then silently replaced by idle-guard — team-lead, 2026-09-01
Post-blink pattern, 2 independent hits within minutes: orchestrator force-pushed
goto tasks to Durk and Mog (both returned {"ok":true, state:"running"}), but
minutes later BOTH bots sat on idle-guard cycles at their old positions with
the old free-mine tasks having continued/resumed — the forced goto never won.
Drivers re-forced manually and it stuck. Suspect: idle-guard (or a queued
prior task) races/preempts an externally forced task, or force kills the task
but the runner's next-tick logic restores the previous kind. Needs a look at
task-mutex + idle-guard arbitration in runner.js post-blink. Until fixed:
after any force push, VERIFY 30-60s later that the task still runs and
position moves — don't trust the accepted response.

## [open] harvested farmland trampled by own bot before replant — Zug, 2026-09-01
Harvest loop order matters: dig-all-ripe-tiles → /collect → replant, in
that order, cost real tiles. 3-4 of 7 camp-door tiles reverted straight to
plain dirt (not grass_block, just dirt — a fresh trample, not the slow
grass-spread decay logged elsewhere) during the /collect step, before
replanting got to them. Bare empty farmland gets trampled to dirt by the
bot's own footsteps/landing while it walks/paths over the tile chasing
drops — this is real vanilla mechanic, not a bug, just an ordering
mistake on my part. Fix: replant EACH tile immediately after digging it,
same visit, before moving off it for collect — don't batch dig-all then
collect-then-replant across the whole plot. If batching digs is still
wanted for efficiency, at minimum route the post-harvest /collect so it
doesn't backtrack across tiles already dug-but-not-yet-replanted.

## [open] canDig:false safety fix leaves legacy dig-pockets unescapable — Ook, 2026-09-01
Good news/bad news on the already-shipped canDig:false fix (see the
canDig-eats-furniture thread above): confirmed via eval it's live
(`bot.pathfinder.movements.canDig === false`), and it correctly stops new
digging. Bad news: Ook got sealed in an old dig-pocket carved by the
PRE-fix pf-eats-everything bug (from the original FEL-base-to-camp big
drop earlier today) — stone floor+walls+ceiling on every side but one
1-block sliver (open at foot level, still capped at head level, so not
walkable). With canDig off, pathfinder now correctly refuses to tunnel out,
so every /goto (pf, ash, auto engines all tried) from that spot goes
nowhere — "stuck," not a new pathing bug, just an old wound the new fix
can't retroactively heal. Didn't hand-dig out myself (that's the exact
blind-tunnel risk canDig:false exists to prevent — no visibility on what's
past those walls). Used tp-rescue per DRIVER_GUIDE policy instead. Suggest:
worth a one-time server-wide sweep (or an overseer check) for any other
bot sitting in a pre-fix dig-pocket from before canDig:false landed, since
they'd hit this same silent dead-end.

## [shipped] step-snag self-rescued clean under new no-tp law — Zug, 2026-09-01
Goto to FEL shop hard-stalled (byte-identical position across polls, exact
signature Bonk's taxonomy calls STEP-SNAG or full-wedge). Ran the taxonomy's
diagnostic order: no entities nearby (ruled out collision case), then a
plain jump test alone (no forward) — real vertical physics, y rose 108->109
and stuck landed, proving this was NOT full-wedge (that needs zero movement
on ANY raw control including jump). blockAt scan showed the classic 1-high
wall-on-two-sides / open-drop-on-two-sides ledge geometry from an earlier
incident this session. Fix: face the actual open direction (toward the real
goal, not a generic offset) with forward+jump held together — got 6.5 real
blocks of movement including a 5-level drop, goto resumed clean from there.
Good news for the new no-teleport law: this class of stuck (real geometry,
vertical physics intact) is fully self-rescuable without any tp — the
jump-alone test is a cheap, reliable way to rule out true full-wedge before
escalating for a driver-check/relog per the no-tp policy.

## [open] 2nd confirmation: sealed in legacy pre-fix dig-pocket, canDig:false correctly refuses to tunnel out — Durk, 2026-09-01
Same bug as Ook's "canDig:false safety fix leaves legacy dig-pockets
unescapable" entry above, different bot. Durk ended up at (13,85,53) —
idle-guard's own deposit-to-chest-A attempts logged the tell: every retry
failed with the exact same "gotoLoopPf: false-reached caught... bot is
3.33 blocks horiz / ~3-4.00 vert from goal" — a consistent, non-closing
gap, not random pathing noise. Raw distance to chest A (11,89,55) is
genuinely tiny (~3 blocks), so this isn't lost-in-open-world, it's sealed
in a pocket right next to the depot. Likely origin: my own earlier
/goto calls to the crafting table (task-5/task-6, engines ash/pf) during
kit-recovery tunneled through terrain near camp — matches the
already-logged "pf engine canDig eats camp furniture/terrain mid-route"
family — and the pocket got carved before canDig:false landed, then
sealed once it did. No hand-digging attempted (same reasoning as Ook's
entry — blind tunnel risk is exactly what the fix prevents). Per
team-lead: Thak digging a manual escape tunnel from the same layer,
consistent with the current no-teleport policy. Suggest folding into the
same fix as Ook's entry: a one-time sweep/overseer check for any bot
sitting in a pre-fix pocket, since it's now hit 2/2 bots that had a
goto route pass through the vulnerable window.

## [open] pointed_dripstone wedges bot, not in NUISANCE_BLOCKS self-clear set — Krug/TestRock, 2026-09-01
TestRock full-wedged at (18.9,102,120.9) in the dripstone ravine belt:
pointed_dripstone occupied BOTH his feet and head tiles, raw look-wake
forward+jump burst = moved 0.000 (real collision box, real wedge — the
look() fix from Thak's entry was applied and did not help, so this is
mechanical, not the control-wake bug). Wedge-detection could not self-clear
because pointed_dripstone is not in the pre-vetted NUISANCE_BLOCKS set
(torch/leaf_litter/short_grass/snow only). Manual eval dig of both blocks
freed him instantly, no tp needed. Fix queued (mini-bundle round 3):
add pointed_dripstone to NUISANCE_BLOCKS — natural hazard, zero build
value, drops nothing worth protecting.

## [open] one-tile placeBlock curse, hyper-local, neighbor tile fine — Grog, 2026-09-01
During roof-rim fill, target cell (18,89,60) rejected EVERY placement method
tried, all with the identical "Event blockUpdate did not fire within timeout"
signature (or windowOpen-flavored variant of the same class):
1. Vertical reference (block below, face up) — timeout.
2. Horizontal reference (solid neighbor cell, face sideways) — timeout.
3. Reposition via /goto to a different standing angle, retry both refs —
   timeout again from the new position too.
4. Raw setControlState forward-key nudge (in case of a hidden nuisance-tile
   wedge under my own feet, per the already-logged nuisance-block entries) —
   moved fine, then placeBlock still timed out.
5. Plain retry, same ref, same face, no other change — timeout again.

Evidence this is hyper-local, not a general engine bug: the very next cell
over, (19,89,60), took byte-identical code (same ref-selection logic, same
equip call, same face vector shape) and placed on the FIRST try, no retry
needed, no delay. Confirmed via fresh bot.blockAt(target) reads before/after
each attempt on both tiles — not a stale-read illusion. Never got a thrown
JS error either, every failure was the same blockUpdate-style timeout
resolving false/void.

This does not match any already-logged pattern: not the false-reach distance
bug (goto itself worked, positioning wasn't the problem), not the
false-success family (this failed loudly every time, never claimed a fake
ok), and not a held-item mistake (equip was verified oak_log/birch_log before
every attempt, matching what worked one tile over). Worked around
pragmatically by shifting the rim-fill target one tile out and capping
(18,89,60) from (17,89,60)'s reference instead — rim reads solid now, just
not from the "natural" side.

Suggest: whoever owns placeBlock/blockUpdate plumbing should treat this as a
NEW signature distinct from the logged false-reach/stale-distance and
false-success bugs — worth checking if there's a per-block-position retry
cooldown or listener dedup keyed on coordinates that can wedge itself against
one specific (x,y,z) after enough failed attempts land on it, independent of
which bot/ref/face is used.

## [open] chest A (11,89,55) missing AGAIN, ground-truth confirmed, not stale-chunk — UngaBunga, 2026-09-01 08:56
Fresh re-learning ramp, step 5 (read chest A contents). blockAt(11,89,55) returned "air" from 2.7
blocks away; walked to 1.57 blocks away (fresh goto, reached:true) and re-checked — still "air",
ruling out the stale-unvisited-chunk gotcha. Wide scan (dx/dz -8..8, dy -2..2 around 11,89,55) found
ONLY chest B (12,90,54), chest D (14,89,57), chest C (16,89,54) — no chest at or near (11,89,55), no
loose item drops within 10 blocks (Object.values(bot.entities) scan, 0 results) either, so it wasn't
just-broken-with-drops-uncollected. This contradicts BASE.md's 2026-09-01 "truth fix" entry which
declared (11,89,55) the CANONICAL live chest_a_materials account. Either it was destroyed again after
that note was written (churn from many bots active same session — canDig-eats-furniture family bug
already hit this exact chest twice per Zug/Thak entries above) or the truth-fix itself was wrong.
Did NOT rebuild (out of ramp scope, avoiding a duplicate-build repeat of the earlier (9,89,55)
mixup). Held wood-run output in inventory instead of depositing to (11,89,55); reported to team-lead.
Suggest: whoever owns BASE.md next should re-verify chest A by ground-truth blockAt before trusting
the registry, and consider a canDig:false / no-dig-near-furniture regression check across all camp
chests, not just A.

## [open] chopTrees camp-quarantine (radius 60) blocks the planted grove too, not just structures — UngaBunga, 2026-09-01 08:57
/chop {"count":4,"maxDistance":48} from camp (10.5,89,56.5) finished "done" with chopped:0,
trees:[], collected:[] — /events showed EVERY single candidate position it considered (~30,
tight box x9-19,z52-60,y89-97, all real oak_log blocks — camp's own log pillars/lamp posts)
got the line "chopTrees: skipping X,Y,Z — inside camp quarantine (<60 of (12,56))". Makes sense
for those (protects our own built structures from being felled as "trees" — good, matches the
canDig-eats-furniture lesson). BUT the quarantine check is a flat 60-block radius around camp
center with no distinction between a built pillar and a real tree, and the tribe's own PLANTED
GROVE at (8,91,68) is only 12.65 blocks from that center — permanently inside the no-chop ring.
Confirmed the grove has grown in nicely (blockAt scan: 5+ full oak_log trunks, tons of
oak_leaves/birch_leaves canopy, well past sapling stage) but /chop can never legally harvest ANY
of it while this radius stands, contradicting the whole point of planting it. Math check: since
maxDistance(48) < quarantine radius(60), NO position within chop-reach of anywhere near camp can
ever pass the filter — this isn't a fluke, it's guaranteed every time a bot chops from camp.
Workaround used this run: manual /eval bot.dig() on 4 identified oak_log blocks at the grove
(escape hatch per escalation rule, 2nd distinct failure signature confirmed via math not just
retry) — worked clean, 4/4 dug, confirmed air after each, /collect swept the 2 that dropped out
of immediate pickup range. Suggest: either carve the grove out as an explicit quarantine
exception (radius check keyed off nearest KNOWN build coord, not blanket camp-center distance),
or give chopTrees a real tree-vs-placed-pillar distinguisher (e.g. only quarantine a log block
that has no dirt/grass parent block or is adjacent to other build materials) instead of raw
distance.

## 2026-09-01 orchestrator self-report: force-fire before arrival (self-two-commanders)
Rescue staircase task-2 on Grog "done" in 1ms. NOT a bug: dig-law refusal, working as designed.
Two orchestrator errors stacked: (1) /staircase force:true fired while own /goto (task-1) still
running — force cancelled the positioning, bot never reached launch cell; (2) actual stand cell
z55 is outside rescue_ramp zone z56-58, columnEntersDigZone correctly said no.
LAW (now in REBUILD.md R1): goto → verify arrival via fresh /status position → THEN dig task.
force:true is for replacing a WRONG task, never for skipping the wait on your own right one.

## [open] 2X CONFIRMED: idle-guard sweeps driver's KEEP items + retry-spam floods event ring — Grog, 2026-09-01 09:13/09:19
Left Grog idle ~90s (reading a teammate msg, no task issued) between task-10 and task-11. Runner's
built-in idle-guard fired its default "deposit toward chest A" and dumped almost the WHOLE
inventory in one pass — including crafting_table, bread x5, and BOTH furnace x2 — items the driver
was explicitly told to KEEP on the bot, not bank. No keep-list/allowlist concept exists in
idle-guard's deposit path; it deposits everything non-tool, full stop. Recovered by withdrawing
them back afterward (worked fine), but if idle-guard had fired mid-task instead of at a clean idle
point, or if the driver hadn't caught it, kit loss was real (had it been food during a fight, or a
tool needed same-session, this bites harder than lost chest slots).

Second, worse finding: once chest A hit its 27-slot cap partway through the sweep, idle-guard did
NOT stop or back off — it kept cycling (`detail:"idle-guard: cycle 66"` through at least `"cycle
97"` observed, 31+ cycles in under 30s) re-attempting the SAME failed items (oak_door, oak_log,
diorite, andesite, dripstone_block, birch_planks, birch_sapling, raw_copper, apple,
pointed_dripstone) every cycle, each retry logging one `quirk depositToChest: failed to deposit
X: destination full` event PER ITEM. This produced 400+ ring events in under a minute (confirmed:
/events?since=34 right after had already rolled seq past 1150, vs. seq 35 before idle-guard fired)
— blew this bot's entire session history (task-1..task-10, the sethome/goto/bank steps) straight
out of the 500-entry ring before I could reference it. Same disease as the already-logged "event
ring flooded by FEL join/leave spam" entry above, different source (own idle-guard retry-loop
instead of foreign join/leave spam) — both point at the same fix: notable-task-events need their
own ring, or spam-dedup on repeated identical quirk lines within a short window.

Suggest: (1) idle-guard's default-deposit should accept/consult a driver-set keep-list (or at
minimum a "keep last N food + first crafting_table + first furnace" heuristic) before sweeping;
(2) idle-guard should back off (stop retrying, or drop to a single warning) the moment ANY item in
its batch reports "destination full" instead of full-speed-retrying the identical failing batch
every cycle; (3) ring buffer should either dedup identical consecutive quirk lines or keep a
separate task-only ring, so one spam episode can't erase real task history.

UPDATE 09:19Z — RECURRED, same session, ~6 min later: after I'd already withdrawn crafting_table 1
+ furnace 1 (spare) + cobblestone 16 back onto Grog per team-lead's explicit keep-list, another
idle gap (reading/processing a teammate message, no bot task issued) let idle-guard fire a THIRD
time and re-deposit all three straight back into chest A — this time pushing chest A to a hard
27/27 slots FULL (confirmed via containerItems().length). Recovered again (partial-count eval
withdraw), chest back to 26/27. Two-for-two: every idle gap this session that lasted through a
message-processing pause triggered a sweep, 100% hit rate, and the second occurrence had a real
consequence (drove a shared depot chest to capacity) rather than just noise. This is not a rare
edge case, it's the default outcome of any driver pause long enough to read+act on a teammate
message — strongly reinforces fix (1) above (keep-list) as high priority, not a nice-to-have.
