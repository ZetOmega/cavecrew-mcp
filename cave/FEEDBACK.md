# FEEDBACK.md — append-only quirk/bug/idea log (FEL-style learning loop)

Every driver logs each quirk/bug/idea THE MOMENT it is found. Engine work
cycles consume open entries. Format:

```
## [open|shipped] short-title — BotName, YYYY-MM-DD HH:MM
symptom / evidence / suggested fix
```

## [open] camp→(54,110,83) route: both engines make ZERO progress, 3/3 attempts, watchdog auto-rescued — UngaBunga, 2026-09-01 14:11
Chop-kampagne leg from camp (12.7,89.9,55.5, right by table_1/chest A) toward a known-good hill oak
cluster near (54,110,83). Tried 3x back to back, same exact start position each time, ZERO horizontal
movement recorded across all 3 (position byte-identical before/after every attempt): (1) engine ash,
"ashfinder gotoWithPath timed out after 60000ms"; (2) engine pf, "gotoLoopPf: failed... timed out after
60000ms" x2 internal retries then task cancelled externally via /stop; (3) engine pf retry, same timeout
pattern, cancelled externally via /stop again, immediately followed by an external /trigger home (not
issued by me — someone/something else is watching this bot's stuck state and auto-rescuing). Note: a
DIFFERENT nearby hill target worked fine earlier this session — camp→(55,107,99) succeeded clean via
ash in one shot (task-166), and (54,116,91)/(56,115,88) also reached fine via ash (task-178). So this
isn't "hillside terrain = universally bad for pf/ash" (already documented elsewhere) — it's specifically
the (54,110,83) endpoint or the exact path to it that's a dead zone for both engines, unlike its close
neighbors 5-10 blocks away. Didn't hand-diagnose further (bot never left camp, no physical wedge to
scan). Suggest: if a specific coordinate reproducibly fails on both engines while nearby coordinates
work fine, the goal node itself may be unreachable (e.g. inside a solid block, or requires a jump/climb
neither pathfinder attempts) rather than a general engine weakness — worth a blockAt check on the exact
target column before further routing attempts there. Practical workaround used: route via the
known-good waypoint (55,107,99) first, then hop shorter legs from there instead of one long direct shot.

## [open] mine_field surface pocket (19-20,y95,72-73) wedges bot mid-mine, coal_ore embedded in low ceiling — UngaBunga, 2026-09-01 13:20
Coal-run second (board #3b): after 2x false-reach goto fails at (26,91,72) (see identical-stale-distance
pattern below), issued /mine coal_ore maxDistance:10 direct from ~28.6,91,66.5 instead of fighting
pathfinder further (position was inside maxDistance of the mine_field zone). Task ran fine for a while
(mining coal_ore 13/16) then failed: "wedge: zero progress over 90s (no items gained, <1 block net move)
at 19.7,95.0,72.7". Ground-truth diagnostic before escalating: (a) column scan at that position: y93-94
stone (floor), y95 air, y96 air, y97 coal_ore, y98 grass_block — 2 clear blocks to stand in but a
coal_ore block sits directly in the low ceiling just above head height, one of several candidate ore
blocks embedded in a shallow surface pocket's roof, not a normal open-sky mine face; (b) horizontal
4-side scan found 3 sides part-blocked (coal_ore/dirt in the head slot) but the -x (west) side fully
open both feet+head — so NOT a sealed pocket by the block-geometry check alone; (c) despite the open
side, a raw manual-control test (bot.look + setControlState forward held 1.5s) produced 0.0003 blocks
of real movement — genuine physics-level wedge, not a pathfinder-only failure, confirms this is a real
stuck state and not a false read. Escalated straight to /trigger home (HOME SYSTEM doctrine, raw-control
test already failed so no further diagnostic ladder needed) — clean rescue, back at camp (11.52,89,53.47)
instantly. COST: only 2 coal actually in inventory post-rescue despite 13/16 candidates reportedly mined
— the other ~11 mined drops were left on the ground at the wedge site (never got to the /collect step,
teleport-home abandons the loot). Suggest: (1) low-ceiling ore pockets where ore blocks sit IN the roof
(not just walls) may need a duck/mine-up move the mine skill doesn't attempt — worth a skills.js check;
(2) a wedge-escalation path that does a local /collect radius (e.g. 8 blocks) BEFORE the home-teleport
would save drops like this instead of abandoning ~11 coal on the ground; (3) flagging (19-20,y95,72-73)
as a bad sub-pocket within the otherwise-good mine_field zone — future miners should avoid landing
exactly there, or expect this failure mode and pre-plan a local collect before any home-rescue.

## [open] identical-stale-distance goto false-reach at (26,91,72), 2x in a row — UngaBunga, 2026-09-01 12:50
Travel leg from (24.5,90,61.5) toward the coal-run second position (26,91,72), engine pf, range 3:
failed twice, byte-identical signature both times — "gotoLoopPf: failed after 5 attempts: false-reached
caught: goto resolved success but bot is 6.36 blocks horiz / 0.00 vert from goal (range 3)" — and zero
real position change between attempt 1 and attempt 2 (stuck at 28.599797092534384,91,66.5 both times).
Matches the same stale-false-reach-distance bug family already logged against Grog (14.36 constant,
6.36 here) — looks systemic to gotoLoopPf's false-reach retry path, not a one-off. Did not burn a 3rd
attempt or a /trigger home (bot wasn't wedged, just short of the exact target and still within /mine's
maxDistance:10 of the intended zone) — proceeded with /mine directly from the reached position instead,
noting the deviation to lead. Suggest: gotoLoopPf's false-reach detector should re-measure distance
fresh each retry rather than reusing a cached value — the byte-identical repeat distance across attempts
suggests it's not actually re-polling position before deciding to retry.

## [open] ash routed bot into a sealed natural cave pocket during long-distance overland goto — UngaBunga, 2026-09-01 12:42
Ranged wood-run leg toward (35,90,80)/(40,90,85) from camp: pf stalled twice at the exact same spot
(21.5,90,77.3) with identical false-reach distance (14.36 — matches Grog's already-logged
stale-distance bug). Switched to ash, which DID make real progress (33.67,89,76.57) but the next
attempt from there failed "no path (goal unreachable)", again zero movement. Ground-truth scan
found why: bot was sitting 6+ blocks BELOW the real surface, own head-height blocked by solid stone
1 block up (col: y88 dripstone_block floor, y89-90 air, y91 solid stone ceiling), and a 16-block-
radius wider scan found solid ground at y95-96 in every direction with no gap — genuinely sealed in
a natural dripstone-floor cave pocket (matches the dripstone cavern Ook mapped on the west scout,
apparently this cave system extends this direction too). Ash's "partial" path search must have
routed through a cave entrance it found further back and just dead-ended here rather than staying
surface-level for an overland trip. Did NOT hand-dig out (canDig:false doctrine — blind tunnel risk
is exactly what that's for). Escalated straight to /trigger home per HOME SYSTEM doctrine, worked
clean. Suggest: for surface/overland goto legs specifically (not intentional cave travel), a
"prefer-surface" or "avoid-underground" hint on /goto would prevent ash from opportunistically
diving into cave systems that dead-end; until then, drivers doing long blind overland travel should
expect this failure mode and budget for a home-rescue mid-route, or travel in shorter hops with a
position/altitude sanity check between each (a sudden y-drop of several blocks mid-leg is the tell).

## [open] pf engine total fail on hillside climb, ash instant success — UngaBunga, 2026-09-01 10:02
Long trading-post leg (camp ~(10.5,91,66.5) to post (7,112,23), ~44 horiz / +21 vert, open-air
hillside per CIV.md's own trading-post note, not underground). engine:"pf" with timeoutMs:90000:
ALL 5 internal gotoLoopPf retries timed out at exactly 90000ms each (~7.5 min total), position
never moved a single block the entire time (10.461843,108,32.3 byte-identical across every poll).
Ground-truth diagnostic before escalating: (a) no entities nearby, feet tile clean air, onGround
true — ruled out entity-blocking and nuisance-wedge; (b) isolated jump-only test via /eval got a
full real 1-block y-rise — ruled out full-wedge (client-physics frozen), physics/controls fine;
(c) manual bot.lookAt(target)+forward+sprint via /eval moved 5.6 real blocks toward goal in 2.5s —
confirms this was 100% a PATHFINDER COMPUTATION problem (pf couldn't find/commit to a route from
this exact hillside spot), not a movement/physics/wedge problem at all. Retried the same target
with engine:"ash" (nothing else changed) — reached in under 20s, first try, byte-clean. This is a
much starker A/B than the DRIVER_GUIDE's existing "ash better for tight cave nav" note — this was
open-air hillside, and pf didn't just lose to ash, it failed completely (0/5) while ash won
instantly. Suggest: bump the pf-vs-ash default recommendation for any route with significant
elevation change / uneven natural terrain (not just caves) toward ash, pending the still-open
proper A/B safety comparison the guide flags.

## [open] another one-tile placeBlock curse — (9,89,57) — UngaBunga, 2026-09-01 12:12
Same family as Grog's already-logged "one-tile placeBlock curse, hyper-local, neighbor tile fine"
entry. Chest-E placement attempt at (9,89,57) (verified target air, floor cobblestone solid,
ground-truth before every attempt) failed twice in a row, identical signature both times: "Event
blockUpdate:(9, 89, 57) did not fire within timeout of 5000ms", blockAt confirmed still air after
each. Tried from two different stand positions (10.67,89,56.5 and 10.48,89,56.7), same reference
block (9,88,57 face up) both times. Did not try a 3rd time or dig around it — per the placement law,
picked a different cell entirely ((12,89,57)) instead. Adding coordinate to the running "cursed
tile" list Grog's entry flagged as worth investigating for a shared root cause (per-position retry
cooldown / listener dedup keyed on coords, independent of bot/ref/face).

## [open] new camp_shelter furniture cluster traps bots, both engines "no path", self-rescued via /trigger home — UngaBunga, 2026-09-01 12:15
Right after Grog's camp_shelter rebuild + my own chest_f_bulk placement, tried to /goto the grove
from inside the furniture cluster near (11.68,90,57.5) — between chest E (12,89,55)-ish, chest
_f_bulk (12,89,57), table_1, and the new shelter wall. BOTH engines hard-failed immediately, not a
timeout: pf gave "No path to the goal!" (5/5 retries), ash gave "ashfinder: no path (goal
unreachable)" — first time either engine has returned a clean unreachable verdict instead of
timing out. Diagnostic ladder: (1) no real entities nearby (the one "player" hit in
Object.values(bot.entities) was a self-detection artifact — bot.players cross-check showed only
self within 3 blocks, worth noting as a gotcha for future entity-blocking checks); (2) jump-alone
test read 0 rise, LOOKED like full-wedge by Bonk's taxonomy — but a column scan showed solid
cobblestone 2 blocks above feet (the shelter's own y92 flat roof) — bot was simply indoors with
zero jump headroom, a false full-wedge read. Lesson: the jump-alone full-wedge test needs a
"confirm open sky / 2+ clear blocks above" precondition before trusting a 0-rise result, or it
misdiagnoses ordinary indoor standing as a wedge. (3) horizontal-only manual walk (forward, no
jump) toward the door DID move, but a 5-waypoint manual walk trace showed the bot oscillating
between exactly two points (11.3,90,57.7) and (12.21-12.39,90,57.7) — z pinned dead solid across
all 5 different look targets — genuinely trapped in a ~1-block-wide furniture gap, not a full
engine wedge, a real physical pocket. Escalated per HOME SYSTEM doctrine (self-rescue tried first,
this qualified as "sealed in a pocket it can't path out of in reasonable time") — /trigger home
via /eval teleported cleanly to the saved camp-yard home (11.52,91,53.47), immediate fresh /goto
to the grove worked perfectly right after (reached, no issues). Root cause: dense new furniture
placed close together (chest E, chest F, table, wall) with no throughway wide enough for
navmesh/collision, in a spot bots need to path through often. Suggest: leave a minimum 1-tile
walking lane between any two furniture pieces in the camp core, and/or a wider door gap; this will
keep re-trapping bots as more chests/tables land in that cluster otherwise.

## [RETRACTED, self-caught] falsely called (4,90,67) a placeBlock curse — was a silent goto failure — UngaBunga, 2026-09-01 12:22-12:23
Original claim below was WRONG, caught by re-reading my own event log a minute later — leaving both
so the mistake and the catch are on record. What actually happened: goto to the stump (task-75)
FAILED outright ("No path to the goal!", 5/5) and a second goto (task-78, different stump target)
came back false-reached 10.20 blocks off — I never re-verified fresh /status position after either
goto before eval-placing, just trusted "task done". Both placeBlock "failures" were the bot trying
to place a block ~10+ blocks from the target, nowhere near reach — completely expected behavior,
not a curse, not even really a bug. This is the exact "verify arrival via fresh /status THEN dig/
place" law from the orchestrator's own 2026-09-01 self-report at the bottom of this file — I broke
that law myself right after reading it. Root pathing cause: same furniture-cluster trap logged in
the entry above (camp core near chest E/F/table) — goto from inside/near that pocket keeps failing
to leave it, silently, without always throwing a loud error I'd catch on a casual glance. Re-ran
/trigger home a second time to clear it, then resumed the replant loop WITH explicit position
verification after every goto from here on. Original (retracted) text follows for the record:

~~Same family, brief log: sapling replant at grove stump (4,90,67), 2/2 fail, identical "Event
blockUpdate:(4, 90, 67) did not fire within timeout of 5000ms", blockAt confirmed air after each.
Skipped per law, moved to next stump, no digging/workaround attempted. 3 cursed coords logged
today: (9,89,57), (11,88,55)-area column (mission2, resolved eventually), now (4,90,67) — spread
across totally different builds/times, still looks coordinate-keyed not build-keyed, matches
Grog's "one-tile curse" open question about a shared root cause.~~

Real suggestion from this: the furniture-trap entry above needs a driver-side mitigation, not just
a build-layout one — always check goto's own `reached` field (or a fresh position delta) before
any placement/dig attempt at the target, every time, no exceptions, especially right after a
goto that came back fast/suspiciously.

## [open] CONFIRMED REPRODUCIBLE: goto chest-A-vicinity → grove fails "No path", every time, post-shelter — UngaBunga, 2026-09-01 12:26
Not a one-off — reproduced 3/3 times this lumber loop, always the same shape: after visiting chest
A (11,89,55) to bank/withdraw, the next /goto toward the grove (8,91,68) hard-fails "No path to the
goal!" 5/5 attempts, zero movement, bot stuck near (9-10,89,57) (right by chest A/table/chest F).
Every single time, /trigger home (teleport to saved camp-yard home 11.52,91,53.47) immediately
unwedges it and the VERY NEXT goto-to-grove from home works perfectly, no retries needed. Pattern
is 100% consistent across 3 independent trials in one session: chest-A-area → grove = broken;
home → grove = fine. Ties into (or is the same root cause as) the furniture-cluster-trap entry
above — likely the new camp_shelter's walls/door created a route where the pathfinder's node graph
near chest A genuinely has no computed path to open ground anymore (not intermittent lag, a real
"No path" verdict every attempt). WORKAROUND adopted for the rest of this loop: after every chest A
visit, /trigger home before heading back out to the grove, instead of a direct goto. Costs one
extra teleport+short-walk per cycle but is 100% reliable so far (2/2 uses). Suggest: someone
ground-truth-scan the chest-A-to-shelter-door-to-outside route for what actually changed (door
alignment change, a stray placed block mid-doorway, etc.) — this is now blocking EVERY iteration of
a standing driver loop, not a rare edge case.
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

## [shipped] ledger lines must stay REAL white chat — FEL intel, 2026-09-01
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
UPDATE 2026-09-01 (chief decree, TOTAL DE-CHAT): this entry's original law —
"ledger lines must stay REAL white chat" — is now SUPERSEDED, not just the
DEPOT exemption above. Inter-tribe transport of protocol/ledger lines moved
off public chat entirely to the claims registry + repo/Discord (coordination
live in monkeorg/cavecrew-mcp#1); nothing outside the crew needs TRADE/USING/
FREE/LEASE-BREAK/BASE/CLAIM/HELLO/OFFER off real chat anymore. runner.js's
PROTOCOL_PREFIX constant is deleted (had no other reader); smartChat's
protocol branch collapsed into the same announce('status') route DEPOT
already used. Drivers keep sending every ledger line via /chat unchanged;
only the destination moved, fleet-wide. Same scoreboard.mjs-style known
consequence as DEPOT's: any tooling still grepping real chat for these
prefixes goes silent until repointed at the Discord feed / claims registry.

## [shipped] health<8 panic listener at game speed — FEL intel, 2026-09-01
Injected health listener: abort task, announce, flee home — BUT when deep/far,
wall off line-of-sight with cobble + eat instead. Game-speed reflex, not LLM.
SHIPPED: runner.js:991 triggerPanic already does exactly this — flee to camp
when close/shallow, skills.emergencySeal (wall off + eat) when farOrDeep.

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

## [shipped] toss self-repickup — UngaBunga, 2026-08-31
bot.toss reports ok but bot re-grabs own drop; toss + walk 3 back (giveItems
helper in flight).
SHIPPED: skills.js giveItems (~2017) does exactly this — toss, step 3 back,
verify the net inventory delta before trusting the toss.

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

## [shipped] chopTrees root cause: ensureTool axe-craft-chain wedges bare-handed — UngaBunga, 2026-09-01
SHIPPED: skills.js ensureLogs (~2460) does a bare-hand punch (STEP 1, up to
2 logs) before falling back to the full chop task — same fix as the entry
right below, both closed together.
Follow-up to the entry below with the real signature, from a watched
count:1 test: task failed at detail "ensureTool: craft chain for axe",
error "wedge: zero progress over 90s (no ite[ms gained?])". Reproduced with
zero logs/planks/sticks/axe in inventory, no crafting table or depot chest
within reach (90+ blocks out in the south wood zone). Looks like the
craft-chain has nothing to bootstrap the very first log from and just sits
waiting rather than punching one bare-handed. Suggest: ensureTool's axe
chain should try one bare-hand log punch first when totally bare, before
falling back to table/depot logic.

## [shipped] ROOT CAUSE of chop deaths: ensureTool axe craft-chain wedges when totally bare — UngaBunga, 2026-09-01
SHIPPED: same fix as the entry above (skills.js ensureLogs ~2460, bare-hand
bootstrap punch before craft-chain fallback).
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

## [shipped] chopTrees dies with "stalled" mid-tree, no auto-retry — UngaBunga, 2026-09-01
SHIPPED: skills.js chopTrees (~1371-1380) skips just the stalled tree and
moves to the next candidate; only 3 CONSECUTIVE stalls fail the task, any
successful tree in between resets the counter. Matches the suggested fix.
/chop task failed outright with result.error:"stalled" while at "chopping
tree 1/12" (south wood zone, z=109, well clear of camp). Bot did not
recover on its own; sat at idle-guard cycling with zero logs gained until
team-lead force-pushed a fresh /chop. No world hazard (health/food both 20,
open ground) — looks like an internal watchdog inside chopTrees giving up
rather than retrying the current tree or moving to the next one. Suggest:
chopTrees should treat a single-tree stall as "skip this tree, try next"
rather than failing the whole task.

## [shipped] bot.openChest windowOpen timeout, one-shot — UngaBunga, 2026-09-01
SHIPPED: skills.js openChestRetry (~1913) — one retry with a short pause on
any openChest failure, wired into all 3 call sites (deposit/withdraw/ensureTool).
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

## [shipped] CONFIRMED: overseer idle-default /collect caused the furniture damage — Bonk, 2026-09-01
SHIPPED (moot): the interim workaround this entry proposed (drop /collect
from overseer.mjs defaults) is obsolete — the actual root cause it names
(pf canDig eating furniture) is already fixed (canDig:false), confirmed
shipped by 3 later FEEDBACK entries acknowledging it "correctly refuses to
tunnel out." No overseer.mjs change made or needed.
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

## [shipped] /collect finds nothing despite real nearby drops — Bonk, 2026-09-01
SHIPPED: skills.js collectDrops — DROP_NEIGHBOR_OFFSETS fallback ladder
(6 neighbor voxels) when the drop's own exact voxel is unreachable in
honeycombed post-mining terrain, plus logging on every branch.
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

## [shipped] two distinct /staircase stall modes post-blink, watchdog confirmed working — Thak, 2026-09-01
SHIPPED (signatures #2/#3): commit f98395c — interior/flat-floor starts no
longer dig pits into solid ground (per-step fresh classification), and
void-ahead steps honor ensureTreadFoundation with one bounded deeper
attempt then a clean stop instead of walking into air. Workflow
wf_181b5939, adversarially verified.
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

## [shipped] dragon-fix (movement.js 4725e84) real progress, 3rd distinct staircase stall pattern — Thak, 2026-09-01
SHIPPED (signature #4, confirmed by the entry below): commit 31b7508 —
position-verified raw-control step advance (the step counter was counting
digs, not real movement; field y-trace proved it). Judge-verified.
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

## [shipped] window-1 retry CONFIRMS dig-geometry bug: 0.00y net, barely any x/z drift either — Thak, 2026-09-01
SHIPPED (signature #4, same fix as the entry above): commit 31b7508.
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

## [shipped] new validation rejects a genuinely valid step cell — Thak, 2026-09-01
SHIPPED (signature #5): commit a09dfd6 — calibrated step-advance aim/landing
+ ground-truth margins (valid steps were being rejected, near-goal successes
flagged false). Judge-verified.
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

## [shipped] ensureTool has no chest-withdraw fallback when no trees nearby — Durk, 2026-09-01
SHIPPED: skills.js ensureTool (~2711) — depot chest is now ALWAYS attempted
before the craft chain, never as a post-failure fallback.
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
STALE (see Ook's DOC CORRECTION entry further down, same session-day):
per-item `{name, count}` support landed after this was written —
`/withdraw`/`/deposit` DO support an exact count now, the /eval-only
workaround above is no longer necessary. DRIVER_GUIDE.md's API reference
updated to show `{name, count}` as the primary form.

## [shipped] chop task claims progress while full-wedged — no task-level watchdog — team-lead, 2026-09-01
SHIPPED: skills.js chopTrees/mineBlocks both wrapped in runTargetWithWatchdog
(25s), from the generic gathering-task progress guard pass.
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

## [shipped] force:true task accepted then silently replaced by idle-guard — team-lead, 2026-09-01
SHIPPED: runner.js startTask's preemption logic only lets idle-guard preempt
ITSELF (preemptingIdleGuard requires currentTask.kind==='idle-guard'), never
a real driver task — structurally can't happen with current code.
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

## [shipped] pointed_dripstone wedges bot, not in NUISANCE_BLOCKS self-clear set — Krug/TestRock, 2026-09-01
SHIPPED: skills.js:123 NUISANCE_BLOCKS already includes pointed_dripstone.
(Missed this one in the earlier doc pass despite having it on my checked
list — correcting now.)
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

## [shipped] chopTrees camp-quarantine (radius 60) blocks the planted grove too, not just structures — UngaBunga, 2026-09-01 08:57
SHIPPED: commit 54168da (GROVE FIX) — grove_1 zone in zones.json +
isInGroveZone() carve-out in the camp-quarantine check (skills.js).
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

## [shipped] chopTrees burns minutes on unreachable tall-canopy log segments — UngaBunga, 2026-09-01 09:42
[shipped 6582a9b — chopTrees pre-filters via footholdY check, skips log positions >3 blocks above current foothold before burning a gotoLoopPf cycle. skills.js ~line 1269-1287. — Engineer]
Grove chop retest (post-ChopFix, count:4 maxDistance:32) SUCCEEDED overall (chopped:4, 17 oak_log
banked) — ChopFix confirmed working: budget no longer eaten by quarantine skips, ensureTool axe
craft + round-trip to grove both worked clean this run. But hit a distinct, separate cost: several
candidate trunk positions it tried were TALL oaks whose remaining upper log segments sit 4-8 blocks
above the last reachable foothold (e.g. target (4,99,71) with bot at y91, target (9,93,69) needing
y+2 with no stair/climb path, (7,96,68) needing y+5). Each one burned a full 3-attempt gotoLoopPf
cycle (~20-45s of real time, some finishing as false-reached instead of a clean immediate fail)
before chopTrees logged "could not reach/fell tree at X,Y,Z ... skipping N log position(s) of that
trunk" and moved on. 6 separate unreachable-segment failures logged this one run, costing a few real
minutes total, before it finally landed on 4 fully-reachable trees. Not fatal (task still completed,
matches the new "skip and continue, don't burn the whole task" behavior working as intended) but
worth a cheap pre-filter: before committing a gotoLoopPf attempt, check whether the target log
position is reachable via a plain vertical/short-hop path from current ground level (or already has
a stair/log-pillar the bot climbed for a lower segment of the same trunk) and skip straight to
"unreachable, next candidate" without the 3-attempt goto cycle for logs more than ~3 blocks above
the bot's own current foothold. Movements config already has allowParkour=false/no towers, so these
upper segments are genuinely unreachable without scaffolding — the fix is to recognize that FAST,
not to make them climbable.

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

PARTIAL SHIP (runner.js, not by me — verified live in current tree): fix (2) deposit backoff
(IDLE_GUARD_DEPOSIT_BACKOFF_MS, 2-consecutive-failure trip) and fix (3) ring rate-cap
(RATE_CAP_PER_TYPE/flushSuppressed) are BOTH in. Fix (1), the keep-list itself — the actual
"sweeps driver's KEEP items" complaint — is still missing (grepped, no KEEP_LIST/keepList symbol
anywhere). Leaving [open]: the root ask isn't done yet. — Engineer

## [open] HAZARD: void under Mine House floor near (13,87,56) eats bots on goto to chest D — Grog, 2026-09-01 09:35
Any /goto from camp/home toward chest D (14,89,57) that starts from a position not immediately
adjacent to chest A routes THROUGH a hidden cavity at roughly (13,86-87,56), directly under the
Mine House's own sealed floor (oak_planks x3 + cobblestone layer confirmed solid overhead via
blockAt column scan — canDig:false correctly refuses to path through it, so this isn't the
eats-furniture bug). Hit this 3x in a row: two goto failures (pf "still 2.32h/2.26v" rawWalkTo
fail, then ash "gotoWithPath timed out after 45000ms"), plus a raw-control diagnostic forward+jump
burst that dropped me a further 6 blocks (y87->y81) into the same pocket. Real open horizontal
space exists there (dirs -x/-z clear both feet+head), so it isn't fully sealed, but the pathfinder
can't find/complete a route back up to camp level (y89) from inside it — every fresh /goto from
camp toward chest D re-enters the SAME void column, not a one-off.

WORSE: while stuck here, hit what looks like a NEW full-wedge flavor. Raw setControlState
jump-with-look-first (the documented fix for the "setControlState no-op" bug above) produced
ZERO position change, velocity.y pinned at passive gravity (-0.0784), onGround:true — classic
full-wedge signature. Per doctrine tried /trigger home next: server SAYS success (events show
"Triggered [home]" + "[cavehome] home restored." both system + chat) but bot's actual position
never moved (confirmed 2x, one with a 3s wait first to rule out a read race). /relog afterward:
reconnected clean (connected:true) but wedge survived identically, position still byte-locked.
So: this is a full-wedge that survives BOTH the new home self-rescue AND relog — same as Thak's
07:11 "look-fix + relog both failed" entry, but this is the first time /trigger home itself has
been seen to false-succeed (server message fires, zero real effect) rather than just not being
tried. tp+restart escalated to team-lead per the pre-home-system ladder since every sanctioned
self-rescue tool failed in order. Suggest: (1) fence this specific void off in BASE.md as a hazard
coord like hazard_seal_pocket, since it's now reproducibly eating bots via a normal goto, not just
a fluke; (2) whoever owns /trigger home's server-side integration should check whether a completed
home-restore can fail to reach a client stuck in this wedge state — may need the runner to detect
zero-position-change post-teleport and treat it as a wedge signal itself, distinct from a plain
false-reach.

RESOLUTION (team-lead, 09:47Z): hit this full-wedge signature a 2nd time same session (fell into
the same void again mid-mission, then again on a route to chest A that had worked fine minutes
earlier — the void eats ANY goto passing near it, not just chest-D-bound ones). Confirmed cure:
hard runner restart (relog alone insufficient, matches Thak's 07:11 entry) + fresh /trigger home
AFTER the restart lands. Full-wedge ladder is now: (1) look-wake raw-control test to confirm it's
really full-wedge, (2) /relog, (3) if relog doesn't clear it, ESCALATE to team-lead for a hard
runner restart, (4) /trigger home again post-restart — that last pair is the confirmed cure. tp
stays banned. Root read: "/trigger home false-success" = the wedged CLIENT never applied the
server-side teleport (a desync class), not a bug in the home datapack itself — the hard process
restart is what resyncs client and server state.

Separately CONFIRMED as a doctrine note, not a bug: /trigger home is unreliable if called twice in
quick succession even OUTSIDE a full-wedge (same "home restored" message fires, zero real
position change) — spacing calls ~15s+ apart works reliably. This is server-side (cavehome
datapack), not our code, so no code fix — just know the spacing rule.

PROBE-TIMING GOTCHA (team-lead, follow-up): after a hard runner restart, the FIRST raw-control
probe done immediately on reconnect can read moved:0 — a FALSE-DEAD reading, not a real wedge —
because the freshly-spawned client hasn't settled yet. Wait ~10s+ after a restart/reconnect
before trusting a raw-control probe's result; a probe run too early can send you back into the
wedge-escalation ladder for a bot that's actually fine.

TERRAIN FIX (team-lead approved, board monkeorg/botnet-tasks#5): ground-truth blockAt scan found
8 real air cells in the y88 walking-floor band (x11-14,z53-58) directly under camp/Mine House —
(11,88,56),(11,88,57),(12,88,54),(12,88,55),(12,88,56),(12,88,57),(13,88,55),(13,88,56) — this is
why the pathfinder kept falling through: it wasn't imagining a bad path, the floor had real holes.
Patched all 8 with cobblestone from a single safe stand point at chest A (11,89,55) — every hole
was within ~2.5 blocks of that one spot, no need to stand over the void at all. Placement order
mattered: filled edge holes against pre-existing solid neighbors first, then interior holes
referencing the just-placed cobblestone next to them. Verified via blockAt after every placement
(2 retries built in, all 8 needed a 2nd attempt to read back solid — matches the known slow-confirm
placeBlock quirk, not a real failure). Re-scanned the full band after: 0 air cells remain. The
deeper cavity below y87 is UNTOUCHED (out of scope — only the walking surface needed sealing),
logged as BASE.md hazard_minehouse_floor_void. Walking floor sealed = confirmed FIXED for goto
purposes; do not path/dig into the deeper cavity below y87 until board #5 lands.

## [open] real placeBlock false-failure on a torch, genuinely never lands (2x retry, 3rd would still fail) — Grog, 2026-09-01 10:04
Building the NORTH camp lamp-post (12,89-90,53), both oak_log placements (self-referencing
straight down, the exact pattern Thak's earlier entry flagged as usually slow-to-confirm)
succeeded clean on the FIRST attempt each. The torch on top (12,91,53), same reference pattern,
same code path that worked instantly for 6 other torches/logs this session, failed BOTH attempts
with identical "Event blockUpdate:(12, 91, 53) did not fire within timeout of 5000ms", and
blockAt confirmed genuinely air after each — not a slow-confirm illusion, a real non-placement.
Per doctrine (team-lead), left that post torchless and moved on rather than burning a 3rd retry.
Only data point so far: 7/8 torches+logs placed clean this session at the same technique, only
this one exact coordinate failed twice running. Might be the same per-coordinate placeBlock
curse Grog logged earlier this session (one-tile placeBlock curse, hyper-local) — worth checking
if (12,91,53) has some hidden listener/lighting-update collision, though no obvious cause found
(checked blockAt fresh before each attempt, target was plain air both times).

## [shipped] ROOT CAUSE (self-correction): my own "chest has only 12 oak_log / 15 torch" reads were a single-stack read bug, not a real drain — Grog, 2026-09-01 10:15
Reported chest A oak_log at 12 and chest B torch at 15 mid-lamp-mission (see the DEPOT -8/-4 lines
and my Phase B report). Team-lead's audit.mjs snapshot came back with the REAL totals: oak_log 76,
torch 80 — no drain, my reads were just wrong. Root cause, found by re-reading my own eval code:
every "how much of item X does this chest/inventory hold" check I did this whole session used the
pattern `containerItems().find(i=>i.name===X)` (or `bot.inventory.items().find(...)`) then reported
`.count` off that ONE match. `.find()` returns only the FIRST matching stack — if the item is split
across multiple stacks in the container (very likely for bulk materials that exceed 64, or that
just got deposited/withdrawn piecemeal by several bots), `.count` silently reports that one stack's
size, not the item's real total. The actual `c.withdraw(type, null, N)` calls I made were NOT
affected by this (mineflayer's withdraw pulls N units across however many matching stacks exist,
confirmed correct both times — my inventory after each withdraw had exactly the requested amount),
so no materials were actually lost or misdelivered; only my SELF-REPORTED "had:" diagnostic numbers
in chat/reports were wrong, and I compounded it by reporting those numbers as if they were the
chest's total instead of one stack's size.

Fix for any driver reading a chest/inventory count for reporting (not just to identify an item
exists): sum ALL matching stacks, not just the first —
`containerItems().filter(i=>i.name===X).reduce((s,i)=>s+i.count,0)`. The runner's own `/status`
inventory list already does this correctly (confirmed earlier this session: it showed
`iron_pickaxe: count 2` correctly after two separate 1-count tool stacks existed) — trust `/status`
or a summed reduce, never a bare `.find(...).count`, when the number itself matters. Marking
[shipped] since this is now understood and the fix is just "read chests correctly next time," not
a code change — but flagging loudly since I personally used the broken pattern many times this
session for other chest reads too (not just these two), so any of my earlier "chest X holds Y"
numbers in this log or in BASE.md should be treated as possibly a single-stack undercount rather
than gospel until re-verified by audit.mjs.

## [open] A/B TEST RESULT: new crop-blocksToAvoid PASSES for /goto+pf, but /collect still tramples farmland — Zug, 2026-09-01 10:52
Requested test: does the new pathfinder crop-avoidance (wheat/carrots/potatoes/beetroots added to
blocksToAvoid) stop a goto whose straight-line target crosses farm_1? PASS, cleanly: forced
`engine:"pf"` from (9,89,62) to chest C (16,89,54) — dead straight line goes right through the
z58-61 plot — and the bot instead arced wide east out to (22.3,93,58.5) before curving back,
verified zero tiles reverted afterward across all 17. Good fix, holds up under a real test.

BUT: immediately after, using `/collect {"radius":6}` to sweep drops from a harvest 2 tiles away
walked the bot straight onto tile (7,59) — a live, actively-growing (age 2) crop we hadn't even
touched this cycle — and trampled it to bare dirt, crop destroyed outright (not even a seed
recovered, since it wasn't ripe). `/collect`'s internal movement apparently isn't wired to the same
blocksToAvoid list `/goto` now respects — same trample mechanic as the original camp-door incident
and the goto-tramples entry above, just a THIRD trigger vector now (own footsteps during harvest →
fixed by discipline; goto passing through → just fixed by blocksToAvoid; /collect's own pathing →
still open). Recovered same session: re-hoed + replanted (7,59), reverified age:0.

Fix needed: whatever movements config gained blocksToAvoid for goto should also apply to
collectDrops' internal pathfinder instance (skills.js), not just the driver-facing /goto endpoint —
they're presumably separate Movements objects. Until that lands: DON'T use `/collect` near a farm
plot to sweep harvest drops — stayed off /collect for the rest of this session's harvest and instead
just let passive proximity pickup happen (worked partially — see the "wheat drops shared with nearby
bots" note in the round-1 farm report; whatever isn't auto-picked up either lands on a nearby
fleet-mate, who isn't a loss, or needs a manual reach-only nudge, never a /collect call, while
working a farm plot.

## [open] bot.dig() gives a FALSE-SUCCESS "air" read when called via /eval from way outside reach — Zug, 2026-09-01
Hand-rolling a wheat harvest via /eval (no dedicated /harvest skill exists, so this bypasses
safeDig's reach law entirely — see skills.js REACH LAW comment, which already warns raw
`bot.dig()`/`bot.placeBlock()` will "happily attempt across arbitrarily long distances"). I called
`bot.dig(cropBlock)` on a wheat crop while still standing at chest C, ~8.8 blocks from the target
(forgot to goto back to the farm first). The call resolved with no error, and `bot.blockAt(pos)`
read back `air` immediately after — looked like a clean harvest. It wasn't: no item ever dropped,
and a fresh `blockAt` read after actually walking back into range showed the original ripe
`wheat age:7` still sitting there, untouched. The `air` reading was a stale/optimistic client-side
prediction that got silently corrected once real chunk data resynced on approach — same failure
class as the documented "placeBlock false success" (FEEDBACK, Bonk/Grog), just on the dig side and
triggered by reach instead of packet-timing. Cost: one wasted eval round-trip, no real damage since
I re-verified before trusting it and no drop was ever created to go stale on the ground. Fix for any
driver doing manual crop/block work via /eval: always check `bot.entity.position.distanceTo(target)`
is under ~4.5 BEFORE the dig/place, and don't trust the very next `blockAt` read as ground truth
after a long-range action — re-read after moving into real reach. Belongs in a `safeDig`-equivalent
for /eval-only manual actions if one ever gets written; for now this is a driver-discipline note.

## [open] goto ROUTES STRAIGHT ACROSS live farmland — trampled a freshly-replanted tile mid-transit — Zug, 2026-09-01
Full farm_1 harvest (8/8 tiles) went clean: reach-only dig+replant, verified age:0 on every tile
right after planting, zero trample during the harvest+collect loop itself (stood off-plot on the
z56-57 cobblestone path row the whole time, per the established "route around plot edges" law).
Then did an ordinary `/goto` from the farm straight to chest C (16,89,54) to bank the harvest —
totally unrelated-looking travel task, not touching the farm on purpose. Re-scanned the whole plot
afterward anyway (habit, not because anything looked wrong) and found tile (11,88,59) reverted to
plain `dirt`, crop gone (`air`) — it had verified `farmland`+`wheat age:0` moments earlier. The only
thing that touched that tile between the two reads was the goto to chest C; ash-engine pathfinding
has no concept of "farmland is fragile, route around it" and will walk straight across a live crop
tile if that's the shortest path, same trample mechanic as the original camp-door incident but
triggered by a routine travel task instead of the post-harvest collect walk. Recovered same session:
re-hoed + replanted (11,59), reverified age:0. Fix: this needs to be a pathfinder-level exclusion
zone (farm_1's tile set, or "farmland with no override" generally) added to the movements config —
same mechanism as the elevated-risk-chunk avoidance already in place for the FEL-adjacent chunks —
because no amount of driver discipline about *my own* footsteps covers a goto call that paths
through the plot for an unrelated reason. Until that lands: any driver routing *through* (not just
working *in*) a farm plot should sanity-check the goto's likely path or box a wide waypoint around
it, and re-verify tile state after any travel task that passes near one.

## [shipped] dig-law zones.json has no zone covering Thak's own mine field workstation — Thak, 2026-09-01
SHIPPED: commit eedca25 added the mine_field surface-ore zone to zones.json.
Dispatched surface-ore mission (TODO #1 iron for all): scanned x18-40,z58-80,y85-95 around Thak's
own DRIVER_GUIDE.md workstation (24,90,64) — 0 iron_ore in that band (all iron is deep, y46-50,
40+ below feet, 3 clusters at (25-26,49-50,66-67)/(38-39,47-48,59-60)/(23-24,46-47,77-79), logged
for whoever plans the branchmine). Found 93 coal_ore + 13 copper_ore candidates in the surface
band though. First `/mine coal_ore` call hard-failed: "coal_ore at 21,88,65 is outside dedicated
mine zones (dig law) — nearest zone \"rescue_ramp\" (8,84,56)-(15,91,58), ~12 blocks away". Checked
zones.json directly: only mine_stair (z54-60, Grog's live corridor, off-limits to me anyway this
mission per anti-clump), mine_grid (y45-62 deep branchmine layer), rescue_ramp, test_yard — none
cover Thak's assigned surface workstation at all. Not a flaky/retry bug, not bypassing via eval —
per skills.js comment this is a deliberate chief decree (blink #2, 2026-09-01). Gap: the dig-law
landed without a zone for every bot's own DRIVER_GUIDE.md workstation, so any surface-ore task
outside mine_stair/mine_grid is now structurally impossible until zones.json gets a matching
entry. Suggest a "mine_field" zone (e.g. x18-40,y83-95,z60-80, or tighter around the actual ore
clusters found: coal x20-29,y85-89,z63-77 + copper x28-31,y89-91,z69-70). Reported to team-lead,
holding at workstation with idle-guard off rather than grinding a blocked task or eval-bypassing
the law.

## [shipped] ad-hoc driver chest reads mid-mission can misreport — audit.mjs is the ledger ground truth now — Engineer, 2026-09-01
The "chest D 18->14 iron_ingot" and "logs 74->12 / torches 83->15" ledger-drain
scare (see Grog's self-correction entry above, single-stack `.find()` read
bug) got chased down live: cave/audit.mjs (goto + eval openChest/
containerItems, merges ALL matching stacks per item name — not a single
`.find()`) was run twice against UngaBunga back to back and read chest A/B/C/D
cleanly both times, correctly reporting "no changes" between the two runs.
Only the original, separately-confirmed 4-iron_ingot gap turned out real; the
rest was ad-hoc mid-mission reads undercounting a multi-stack item. Standing
rule going forward: a driver's own manual chest peek (via `/eval` + a single
`.find()` or a quick glance) is NOT reliable ground truth for "how much is in
this chest" the moment an item spans more than one inventory slot — run
`node cave/audit.mjs --port <bot>` for the real merged-stack count, and treat
its snapshot/diff as the ledger record, not a chat-reconstructed guess. Two
real bugs got fixed in audit.mjs itself during this live test (see commit
f1a839e): /goto is fire-and-forget like every task endpoint (must poll
/status, not assume the POST blocks until the walk finishes), and /eval's
success shape is `{result: <return value>, task}` (was read at the wrong
nesting level). Both confirmed fixed via 2 clean consecutive live runs.

## [shipped] torch placeBlock verification bug: placed torches become "wall_torch", not "torch" — Grog, 2026-09-01 11:01
GRAND STAIRCASE mission, lighting a freshly-carved bottom room: 5 straight torch placements all
reported "failed" (blockUpdate timeout, my usual `check.name==="torch"` verify came back false)
against a target cell that a moment later checked out as a REAL block anyway. Re-read the target
cells fresh: every single one was actually `wall_torch`, not `torch` — the placement genuinely
worked every time, my verification just checked the wrong block name and reported false failures.
Wasted several extra torches re-attempting placements that had already succeeded (each "retry" on
an already-filled cell either no-ops or throws, but doesn't consume real progress — just burns
inventory count and time). Root cause: torch is one of a handful of vanilla items that resolve to
a DIFFERENT block id depending on the face it's attached to — floor-standing = `torch`, attached
to any vertical/side face = `wall_torch`. A verify script written as `blockAt(target).name===
"torch"` will false-negative on every wall-mounted torch. Fix for any driver/skill verifying a
torch placement: check `name==="torch" || name==="wall_torch"` (or just check `name!=="air"` and
trust placeBlock's own resolved face), not a single hardcoded name. Distinct from the two other
already-logged torch/placeBlock quirks this session (the NORTH lamppost torch that genuinely never
landed, and the general placeBlock slow-confirm/false-timeout family) — this one is specifically a
driver-side verification bug, not an engine bug, but worth flagging since it looks IDENTICAL to a
real failure from the outside (blockUpdate timeout, target reads "not what I expected") until you
check the actual resolved block name.

## [open] /branchmine endpoint doc mismatch + corridor-step fall triggered a real panic — Grog, 2026-09-01 11:04
API shape: POST /buildStaircase returned 404 earlier this session (real endpoint: /staircase,
already logged). Same family here: POST /branchMine (as written in DRIVER_GUIDE/team-lead's
mission text) returns {"error":"not found"} — real endpoint is lowercase /branchmine. First call
with `{}` failed clean with `{"error":"requires numeric \"y\""}` (good, self-documenting). Second
call `{"y":47}` from the staircase hub (45,54,57) started fine (task kind "branchmine").

Then a real incident: within ~15-20s the bot dropped from y54 to y37 — 17 levels, well past the
target y47 — and health crashed from 20 to 6 almost instantly (event log: two
"gotoLoopPf: false-reached caught" lines immediately before "health dropped to 6"). Read: branchMine's
internal corridor-travel step uses the same goto primitive that has the documented false-reach bug
(resolves reached:true without real position match) — here it looks like that false-reach let the
skill's internal logic treat a ledge as "arrived", continue its digging/movement routine, and the
bot walked/fell off an edge for a ~17-block drop. Panic fired correctly at health 6 (task
cancelled, no further damage), but the seal-in-place response only partially worked
("sealStairCell: no solid neighbor found" 2x before a 3rd attempt reported sealed:6) — ground
truth after showed 3 of 4 sides dirt-walled, one side still open air, though no mobs were in range
so it wasn't exploited. Health fully self-regenerated to 20 within ~30s (full food helped), no
death, no item loss. Landed at y37, z62 — OUTSIDE the mine_grid zone's y45-62 floor (zone stated
by team-lead as x14-80,y45-62,z35-80), meaning the fall also pushed the bot out of the legal dig
corridor bounds; did not resume branchmine/staircase digging from here without checking zone
compliance first.

SEPARATE bug in the same incident: panic-response's emergency-eat step failed with
"emergencySeal: eat attempt failed: Item switched early to: wheat_seeds!" — the auto-eat logic
apparently tried to consume whatever's first in inventory / a wrong slot pick, grabbing
wheat_seeds (not edible, can't be eaten) instead of the 5 bread actually held. If health had
stayed critical instead of regenerating on its own, this bug would have left the bot unable to
self-heal via the panic reflex's own eat fallback. Suggest: emergencySeal's food-item selection
needs an edible-only filter (check foodPoints/isFood, not just "first non-tool item" or whatever
picked wheat_seeds here).

Fix suggestions: (1) branchMine's internal corridor-goto needs the same false-reach hardening as
plain /goto, or a hard vertical-drop guard (abort/reconfirm before any >3-block unplanned y
change) so a false-reach can't turn into a real fall; (2) fix emergencySeal's eat-item selection
to filter for actual food items only.

## [open] CONFIRMED 2x: dripstone_caves biome is a systemic pf/ash wedge hazard, not a one-off — Ook, 2026-09-01
Follow-up to the west-corridor dripstone entry above (same session, ~1hr later): hit the IDENTICAL
wedge pattern again on the SOUTH scout leg, this time ~40-45 blocks southeast of camp (x39-43,
y106, z95-98) — a totally different location from the west cave, so this is a biome-class problem,
not a single bad chunk. Same signature both times: `/goto` (pf then ash) freezes position exactly
across multiple `/status` polls, `gotoLoopPf`/`ashfinder` retries all fail identically, `/stop` +
re-`/goto` doesn't help, and `blockAt` on neighbors shows `pointed_dripstone`/`dripstone_block`
directly adjacent. Same fix worked again: manual `/eval` dig of the 4-6 adjacent dripstone blocks
(not tool-protected), then goto resolves normally. New data point: this time it was **full
daylight** (skyLight 15, `mcData.biomes[...].name === "dripstone_caves"`) — this world generates
dripstone_caves as a surface-reaching biome in places (mountain tops, not just underground caverns),
so "skyLight 0 = danger" isn't a reliable pre-check; the tell is the biome name itself. Suggest:
(1) treat `dripstone_caves` as a named hazard biome for `/goto` — either route around it or
auto-apply the dig-adjacent-dripstone recovery before giving up; (2) a driver ranging far in any
direction should biome-probe (not just height-probe) candidate waypoints first and steer clear of
`dripstone_caves` tiles specifically, same as we already dodge lava/void columns.

## [open] chest A (11,89,55) is genuinely full (27/27 slots) — deposits of new item types silently no-op — Ook, 2026-09-01
Tried to bank 2 pointed_dripstone + 3 wheat_seeds + 3 wheat picked up on the south scout leg.
POST /deposit kept failing on the GOTO step first (`rawWalkTo: still 2.55h/0.75v blocks from goal`,
consistent across 3 different approach angles/engines — chest is boxed in tight by the furniture
cluster: furnace at (11,89,57), crafting_table at (12,89,56), plank walls, log pillars all within
1-2 blocks, not much clear standing room), so initially looked like a pathing bug. Bypassed the
`/deposit` skill's goto step with a direct `/eval` `bot.openChest` + `chest.deposit` from ~3.4
blocks away (worked fine, no path needed at that range) and got the REAL answer: `"Error:
destination full"`. Ground-truth `containerItems()` read: 27/27 slots occupied (furnace, feather,
andesite, dripstone_block x45, oak_planks x2 stacks, chest x2, leaf_litter, oak_sapling,
cobblestone, oak_log x2 stacks, crafting_table, torch, dirt x2 stacks, birch_sapling,
pointed_dripstone x18 (!), birch_log, wildflowers, oak_door, diorite, bucket, oak_sign, stick,
gravel, birch_planks). Note the existing pointed_dripstone x18 and dripstone_block x45 already
banked — other bots hit the same dripstone terrain this session, corroborates the entry above.
Chest A needs either an overflow chest or a driver pass to consolidate/relocate low-value stacks
(leaf_litter 58, gravel, diorite, andesite look like prune candidates) — flagging for team-lead,
didn't touch anything myself (not this driver's call to decide what's prunable). Left the
unbanked items in Ook's own inventory rather than force it.

## [shipped] DOC CORRECTION: /withdraw and /deposit DO support per-item count now, DRIVER_GUIDE + earlier FEEDBACK entry are stale — Ook, 2026-09-01
The "no count param, always grabs the whole stack" gotcha logged above (line ~670, same
session-day) is now WRONG — skills.js withdrawFromChest/depositToChest both read a `count` off
each item spec (see the "(6)" comments in cave/skills.js ~L2008/2052): `typeof spec?.count ===
'number'` caps the move, falls back to full-stack only when count is omitted. Confirmed live this
session: `{"items":[{"name":"stick","count":2}]}` on POST /withdraw pulled exactly 2 sticks, not
the full stack of 12. Bit me for real before I found this — first withdraw call this run used the
bare-string form (`"items":["torch"]`) per DRIVER_GUIDE's API reference examples, which are ALL
bare strings with no count example anywhere in the doc, and it grabbed all 59 torches from chest B
(needed 8), had to redeposit 51 back. Same for a stick withdraw (grabbed all 12, needed ~2).
Fix: DRIVER_GUIDE.md's `/withdraw` and `/deposit` sections should show the `{name, count}` object
form as the primary example, not just bare item-name strings — the count-capped form is the actual
recommended usage for any withdraw/deposit that isn't "give me everything."

## [open] far-range /goto (pf and ash both) breaks down in dripstone-cave terrain — false-reach, timeout, and one genuine multi-minute wedge — Ook, 2026-09-01
FAR MEAT RUN mission, ranging west from camp toward x-90. A `/goto` toward a hillside waypoint
(-48,89,55 — 60 blocks out) surfaced a large vertical gap the driver didn't know about (target y=89
assumed camp-level ground, but real hillside terrain there was y~93-103) — first ash timed out,
then pf failed with "still 1.80h/5.00v blocks from goal" (a real, not false, gap — the fixed-y
target itself was bad, not a runner bug on that one). Lesson for other drivers: **don't hardcode a
flat camp-level y for far-range waypoints** — probe the column height first (scan blockAt down
from ~y120 for the first `boundingBox==="block"`) and target that +1, or the goto will legitimately
fail on hillside/mountain terrain regardless of engine.

Separate, real bug: continuing west, both engines (ash then pf) pathed the bot DOWN into an
unplanned dripstone cave (skyLight 0, ~50 blocks below the surface it was aiming for) while
targeting what should have been a normal above-ground valley waypoint — no lava, no damage taken
getting in, but this was clearly the wrong side of "prefer pf on open ground / ash for tight cave
nav," since neither call was asked to go underground. Once in the cavern, the bot got **genuinely
wedged** standing on/between `pointed_dripstone` blocks: position byte-identical across 3+
`/status` polls ~15s apart, `/stop` + re-`/goto` (pf) failed 5/5 attempts stationary, raw
`setControlState` forward+jump for 2s moved it 0.02 blocks total (full-wedge signature per the
chop-wedge entry above). `blockAt` on all 6 neighbors showed `pointed_dripstone` above, below, and
one horizontal side. Self-rescue that worked: `/eval` dug the surrounding pointed_dripstone/
dripstone_block blocks by hand (not tool-protected, safe to clear) — freed movement, but a second
goto attempt from the same cavern later false-reached again ("3.02 blocks horiz / 37.00 vert from
goal") and a follow-up ash call took 90s, dealt 2 damage (dripstone fall-damage spike, self-healed),
and STILL didn't clear the cave. Escalated per doctrine to `/trigger home` (HOME SYSTEM) after
confirmed self-rescue attempts failed twice — worked cleanly, zero HP/item loss, bot back at camp
home instantly. Suggest: (1) `/goto`'s engine choice (or a pre-check) should avoid dropping into
unplanned underground pockets when the caller's target y is clearly at/near surface level for that
column; (2) pointed_dripstone/dripstone_block terrain is a known wedge hazard for the pathfinder —
worth a driver-facing callout in DRIVER_GUIDE alongside the existing wedge-detection nuisance-block
note, even though dripstone isn't safe to auto-clear fleet-wide (it can carry a real fall below it,
unlike leaf_litter/torch/snow) so this stays a manual /eval judgment call, not a new auto-clear
entry.

UPDATE 11:20Z — REPRODUCED 2/2 after a runner restart that shipped OTHER fixes (allowSprinting
off, panic-eat food-selection now picks real food). Same exact sequence, same EXACT landing coords
(36,37,62) down to the integer, within 6 SECONDS of task start this time (task started 11:19:56,
health hit 5 at 11:20:02) — faster and worse than the first hit (health 5 vs 6). This is not
timing-sensitive or a fluke, it's a deterministic dig-out at a fixed early step in the corridor
route from this hub. Confirms Engineer's read that maxDropDown was already correctly configured
and the real bug is branchMine's OWN corridor-dig removing floor out from under/beside the bot,
independent of the Movements safety caps (which are now fully set and didn't help). Sealing was
WORSE this run: 0/? sealed (all 3 "no solid neighbor found", vs partial 6 sealed last time) —
left the bot fully exposed for several seconds at 5 HP, only survived because nothing but passive
bats were nearby; a real mob in range at that moment could have killed it. Panic-eat DID
correctly grab bread this time (food-selection fix confirmed working), but a NEW smaller issue
appeared: "Eating timed out with a time of 3000 milliseconds!" — the eat action itself didn't
complete in time, likely because it's attempted mid-fall/mid-chaos. A 15s driver poll cadence
cannot catch or prevent this — the whole fall-to-panic sequence completes in ~6s, faster than any
reasonable poll interval, so "poll and /stop on a big drop" is not a viable mitigation for this
specific failure; the fix has to be in branchMine's dig-ahead logic itself (don't remove the floor
block the bot is currently standing on or adjacent to without confirming a safe landing surface
first, or don't dig at all until the bot has genuinely arrived at the intended cell). Recommend
holding /branchmine entirely from this hub until that specific fix ships, rather than re-running
for more data points — the two hits so far are identical and conclusive.

## [open] ash engine silently freezes on long-distance goto over the camp-post hillside, short hops fine — Bonk, 2026-09-01 11:00
Trade-path mission (TODO #7). Long single `/goto` calls with `engine:"ash"` over the camp→trading-post
hillside climb (~10+ blocks horiz + vert in one call) froze THREE separate times this session,
twice at the exact same coordinate (16.7,95,47.3): task stayed `state:"running"` for 50+ seconds,
position byte-identical across 2 full polls (no drift at all, not even sub-block), no error, no
`/events` progress lines between task-start and my own `/stop`. Diagnosed per my own 3-signature
taxonomy (FEEDBACK entry below, "3-signature stuck-in-place"): raw `bot.setControlState("jump")`
right after stopping the task produced a REAL 1.17-block y-rise — rules out full-wedge, this is a
pathfinder-computation stall, not a physics/client freeze. Contrast: the exact same terrain, same
direction, broken into short ~5-10 block hops with `engine:"ash"` worked fast and clean essentially
every time (a few individual hops false-failed with "did not reach goal (search status was
\"found\")" while already within the requested range — see the entry below, a range-precision
issue, not a real block). Suggest: ash's path search may be timing out/hanging silently on long
routes over natural uneven terrain instead of erroring — needs either a hard internal timeout that
surfaces as a real task failure, or the goto endpoint itself should auto-chunk a long-distance
request into shorter internal hops rather than trusting one big ashfinder search. Workaround every
driver can use today: for any hillside/natural-terrain leg longer than ~10 blocks, issue a chain of
short (~5-8 block) goto hops instead of one long call — reliable in every trial this session.

## [shipped] ashfinder "did not reach goal (search status found)" fires while already within requested range — Bonk, 2026-09-01 11:00
[shipped 235b5b0 — gotoAsh's settle-retry loop now falls back to a horizDist/vertDist ground-truth check (range+1.0h/1.5v, same margins as rawWalkTo) before throwing, porting the pf-side goalGroundTruth dragon-fix to the ash engine. movement.js gotoAsh(). Verified against real downloaded ashfinder 4.6.2 GoalNear source. — Engineer]
Companion quirk to the entry above, hit repeatedly during the same mission: several `/goto` calls
with a small `range` (1-3) returned `state:"failed"`, `error:"ashfinder: did not reach goal after
gotoWithPath (search status was \"found\")"`, but the bot's actual position (checked immediately via
the same failed task's `pos` in `/status`) was already within the requested range of the goal
(e.g. dist ~1.5-1.7 vs range:2). A same-target retry with a slightly larger range (or just retrying
the identical call) then reported `reached:true` with the SAME unchanged position. So this looks
like a real bug in the reached-check (computed before the final settle tick, or comparing against a
stale/rounded distance) rather than the bot actually failing to arrive — same false-fail family as
the already-logged false-reach-report bugs, just manifesting as a hard `failed` instead of a wrong
`reached:true`. Workaround: on this exact error string, re-check `/status` position against the
goal before treating it as a real failure/retry-from-scratch — if already within range, just
re-issue the same goto once (usually returns reached:true immediately) rather than replanning.

## [open] one-tile placeBlock curse, 2nd coordinate confirmed, 2 different ref techniques both failed — Bonk, 2026-09-01 11:00
3rd data point on Grog's already-logged "one-tile placeBlock curse, hyper-local" entry (different
coordinate, same signature). Building the trade-path fix at (7,104,31): tried (a) side-reference off
an adjacent solid cobblestone block, face vector pointing at the target, and (b) vertical reference
off the solid natural ground one block below, face up — BOTH attempts, fresh equip each time, both
failed identically with `Event blockUpdate:(7, 104, 31) did not fire within timeout of 5000ms`,
target confirmed genuinely `air` after each (not a slow-confirm illusion — polled 4x/400ms). The
very next block over on the SAME build (7,106,31), placed minutes later with an equivalent
technique, worked first try, no retry. Per escalation rule (2x fail, same objective) stopped
retrying and routed around it — built a 1-wide connector instead of the intended 2-wide, matching
the existing z31 tread's own already-1-wide precedent, so no net style regression. Adds to the
"per-coordinate curse, independent of ref/face/technique" pattern Grog already flagged — worth
someone checking for a listener-dedup-keyed-on-coords bug in placeBlock/blockUpdate plumbing, now
2 different bots/coordinates/techniques deep.

## [open] chest A (11,89,55) hit hard 27/27 slot cap, deposit silently failed with no items moved — Bonk, 2026-09-01 11:09
Went to bank 40 leftover cobblestone after the trade-path fix. `/deposit {x:11,y:89,z:55,
items:["cobblestone"]}` returned `state:"done"` with `result.deposited:[]` — task completed
"successfully" but moved zero items (ground-truth confirmed: inventory still held all 40 after).
Direct `/eval` diagnostic (open chest, read `containerItems().length`) confirmed 27/27 slots full,
`win.deposit()` throwing `"destination full"` explicitly when called raw. Matches the exact capacity
scenario Grog logged earlier this session (idle-guard sweep drove chest A to 27/27). The HTTP
`/deposit` endpoint doesn't surface "destination full" as an error or partial-result — it just
reports an empty `deposited` array with `ok:true`/`state:"done"`, indistinguishable at a glance from
"nothing of that item type was found to deposit" (a normal, harmless outcome). A driver not
diffing inventory before/after could easily read this as success and walk away leaving materials
undeposited with no banked record. Suggest: `/deposit` should surface a `full` or `skipped` reason
per item (mirroring the "not found in chest" warn path withdrawFromChest already has) so an empty
`deposited:[]` isn't silently ambiguous between "chest full" and "you don't have that item".
Workaround used: redirected to chest B (12,90,54), had room, deposited clean.

Bonus minor gotcha same incident: right after the failed raw `win.deposit()` throw, a same-eval-call
read of `bot.inventory.items().filter(name==="cobblestone").reduce(...)` came back `0` — but the
NEXT `/status` poll (a few seconds later) correctly showed `cobblestone:40` still held, confirming
nothing was actually lost, just a transient stale/optimistic-client read immediately after a failed
container transaction. Low sample size (1x), flagging in case another driver hits the same scare —
trust `/status` over an inventory read taken in the same eval call as a just-failed chest op.

## [open] driver-lesson: hand-building a multi-block staircase via /eval placeBlock needs horizontal offset per riser, not vertical stacking — Bonk, 2026-09-01 11:05
Not a runner/skills bug — a real mistake worth flagging so the next driver hand-building stairs via
`/eval` doesn't repeat it. First attempt at bridging the z31→z30 gap placed 3 new blocks straight up
in the SAME (x,z) column, each referencing the one below with face `(0,1,0)`. Looked fine in the
moment (each individual `blockAt` verify passed, real cobblestone landed) but a follow-up headroom
check (`blockAt` at tread-top+1 and tread-top+2 in that same column) showed each new block had
buried the standability of the one below it — block N+1 sat exactly where block N's own
feet-standing space needed to be air, so only the TOPMOST block of the pillar was actually usable,
and it sat 2 full blocks above the last real tread — not a valid single jump, the "staircase"
would have been unclimbable despite every individual placement reporting success. Caught it before
declaring the task done by explicitly checking `blockAt` at tread+1 AND tread+2 for every new block
(not just the tread itself), dug the offending block back out, and rebuilt using a proper diagonal
offset (each new tread exactly Δ1 vertical AND Δ1 horizontal from the previous, alternating which
axis/column, referencing off a DIFFERENT already-solid neighbor per riser — sometimes an existing
natural terrain block one z-row over, not always the previous tread). Lesson for skills.js or any
driver doctrine doc: "verify blockAt(target)" alone is NOT enough for a multi-step build — a
staircase needs "verify blockAt(target) AND blockAt(target+1) AND blockAt(target+2) are air" before
moving on to place the next riser, or a same-column pillar can quietly self-bury and pass every
per-block check while still being structurally unwalkable.

## [shipped] fresh full-wedge hazard at (22.7,93,68.7), mine_field zone — Thak, 2026-09-01
SHIPPED (self-rescued): hard runner restart + /trigger home cleared it, per doctrine.
Hit mid-`/mine coal_ore` sweep (task failed with the runner's own wedge-watchdog: "zero progress
over 90s, likely wedged" — watchdog worked correctly, not a silent hang). Ran the full
stuck-taxonomy diagnostic before escalating (per FEEDBACK doctrine, no eval-bypass): no entities
within 2 blocks, not a self-sealed 1x1 pocket (2 of 4 horizontal neighbors were air, not solid),
raw setControlState jump+forward test WITH the look-wake fix applied first = 0 delta on both,
onGround:true throughout — genuine full-wedge signature, not step-snag or torn-goto. `/relog`
reconnected clean but did NOT clear it (position byte-identical before/after, matches Thak's
earlier 07:11 entry and Grog's void-under-minehouse entry — relog alone is never enough for this
class). Escalated to team-lead for a hard runner restart rather than grinding retries or hand-
digging blind. Confirmed cure: hard restart (new pid) + wait 10s+ settle (probe-timing gotcha) +
one more raw-control probe (still 0 delta post-restart, so the restart itself doesn't auto-clear
position) + `/trigger home` — that last step worked clean this time (server tp applied on the
fresh client, matches Grog's precedent), landed back at camp (11.49,91,53.53) instantly. Full
ladder confirmed end-to-end in one incident: diagnose -> relog (insufficient) -> escalate -> hard
restart -> wait -> home-trigger (cure). No hazard-worthy terrain feature found nearby to blame
(no cliff/ravine edge, no known BASE.md hazard coord close by) — logging the coordinate in case a
pattern emerges (2nd+ wedge at/near 22-23,93,68-69 would mean a real terrain-quirk there, not
random desync). Coal 7 in kit survived the whole incident untouched (kit is server-side, unaffected
by client-wedge/restart).

## [open] /mine copper_ore auto-pathed into mine_stair zone edge, dug into a self-made unescapable pocket — Thak, 2026-09-01
Not a wedge — real diagnostic caught the difference this time. `/mine copper_ore` picked its
nearest candidate at (21,87,57) — inside mine_stair zone (z54-60), the corridor Grog was told to
have exclusive anti-clump claim on this mission. Dig-law correctly allowed it (mine_stair IS a
legit zone, just not MY assigned one) but the mission brief's "don't enter the stairwell" rule has
no code enforcement, only driver discipline — a plain `/mine` with a wide maxDistance doesn't know
or care which zone a candidate sits in beyond the dig-law pass/fail. Checked player positions right
after (bot.entities scan) — Grog was 54.7 blocks away at (46.7,38,54.5), already deep past this
shallow spot, so no actual collision/interference happened, just an unintended zone trespass.
Then hit a real stuck: goto back out failed twice (`ashfinder: no path`, then `gotoLoopPf` 5x
false-reach). Ran the diagnostic properly this time instead of assuming wedge: raw jump test gave
a small but NONZERO delta (0.05, onGround:false) — not full-wedge. Followed the taxonomy's actual
fix (face the open direction, forward+jump held together) and got 4 real blocks of movement +
a ~2.5 block fall (open air had been dug/exposed on both x-sides of the spot) — confirms this was
a false-reach/no-path goto limitation on a real, physically fine bot, not a client freeze. Landed
at (25.7,84,57.3), still inside mine_stair's footprint and now sealed (canDig:false correctly
refuses to path out of the self-made pocket, matches the already-logged "legacy dig-pocket
unescapable" pattern — except this one's fresh, not pre-fix). Used `/trigger home` (sanctioned
self-rescue, ~4min after the last home-trigger so spacing was fine) — worked instantly, zero
issue. Suggest: (1) `/mine`'s candidate search should accept an optional zone-name filter (or a
tighter maxDistance from a position solidly inside the driver's own assigned zone) so a wide-radius
mine call can't wander into a DIFFERENT zone that happens to also pass dig-law; (2) worth a BASE.md
hazard-style note for the (20-26,83-87,56-58) pocket area near the mine_stair entrance since it's
now demonstrated to open into unexpected air gaps close to the surface.

## [open] branchmine scar is now a PERSISTENT hazard — plain /goto falls into it too, 3rd hit — Grog, 2026-09-01 11:29
Direct follow-up to the /branchmine corridor-dig entries above (2 incidents, both suspended
fleet-wide pending Engineer's fix). After branchmine was suspended, tried a PLAIN `/goto` from the
grand-staircase hub (45,54,57) toward chest D (14,89,57) — no digging skill involved at all, just
travel. Same exact crash: health 20→5, same landing coords (36,37,62-ish), same seal-in-place
failure (sealed:0, "no solid neighbor found" x3), same "Eating timed out" panic-eat issue (this
run genuinely a timeout, not the wrong-item bug — that part's fixed). Took ~39s this time instead
of ~6s, but same destination and same signature. This confirms the two branchmine incidents left a
REAL, PERSISTENT hole/scar in the terrain at that location — it's not a live-digging issue
anymore, it's now standing terrain damage that ANY nearby pathfinding (branchmine's or plain
goto's) can walk into and fall through. Logged as BASE.md hazard_branchmine_scar. Self-rescue
ladder that worked (3rd time using it, consistent): /trigger home → /goto to tunnel entrance
(15,89,57) → /goto to hub (45,54,57), expect 2-4 attempts (first one or two often wander far off
the direct line — saw it go all the way to x81/x65 on different attempts, right at/past the
mine_grid x-boundary, before eventually converging on a later attempt or after a /stop-and-retry
from wherever it landed). No damage during any of the recovery walks, just inefficient pathing.

Practical driver note for anyone routing hub<->camp until this hazard is patched: a "safe" route
must avoid the (36,37-39,61-62) column entirely — since neither the automated skill nor plain goto
currently detects/avoids it, the driver has to notice a sudden health crash + teleport-like
position jump as the tell, then self-rescue via the home+tunnel ladder above rather than trust
the travel primitive to route around a hole it doesn't know exists yet.

## [open] honeycomb caps drift back to air over time, not a one-and-done seal — Bonk, 2026-09-01 11:32
Board #5 terrain-heal mission, TARGET 2 re-check of hazard_old_shaft (honeycomb, 14-15,85-89,44-48),
previously logged "SEALED... hazard cleared" after a full per-block verify. Re-scanned the same 10
cap cells fresh this session: 4 had REVERTED to air (14,88,44 / 15,88,45 / 15,88,47 / 15,88,48),
each with a real hollow interior confirmed underneath (not a stale-chunk illusion — walked within
~1-4 blocks before reading). This is a different failure mode than the already-logged
placeBlock-false-success family (that one catches itself at verify-time, same session) — these
caps DID verify solid at the time they were sealed, and drifted open sometime after, unattended.
Suspect candidates, none confirmed: block-update desync during a runner blink, another bot's
canDig-adjacent traffic nearby, or genuine server-side chunk reload weirdness on an unvisited
region. Patched all 4 (cobblestone, side-reference off adjacent solid stone/cobble, verified),
re-scanned clean. Lesson for anyone owning a "sealed hazard" row in BASE.md: treat a
verified-at-the-time seal as needing periodic re-confirmation, not a permanent fact — a "SEALED"
status a driver reads from the doc without re-scanning could be stale in a way that isn't the
driver's fault or a technique error, just time + unknown drift.

## [open] Mine House cavity (hazard_minehouse_floor_void) is a real natural cave system, far bigger than the 3-block hazard footprint on record — Bonk, 2026-09-01 11:31
Board #5 TARGET 1. BASE.md's row named the hazard as roughly (13,86-87,56), a 2-cell footprint.
Ground-truth: the y88 walking floor is genuinely solid everywhere across x11-16,z53-58 (Grog's
earlier patch holding, confirmed zero access points at that level — good news, matches the existing
"safe to walk" claim). But a full open-cell scan of the same box down to y78 (after filling
everything reachable from safe stands near the documented coordinate) still found 126 open air
cells — natural cave, not a small pocket, extending well past x11 on the west and x15-16 on the
east, with real depth down to at least y78 (10 blocks below the walking floor) in multiple columns,
true bottom still unconfirmed in the deepest 2 columns (x14,z54 and x13,z55, both open past y79-80
where my scan and reach both ran out). Filled everything safely reachable from outside the void
(11 columns solidified completely, top 3 levels of the 2 deepest shafts filled via side-wall chain
references) — roughly 20 dirt + a bit of cobble spent, a small fraction of what full backfill would
cost. Flagging for whoever plans the real fix: this needs a proper mining-scale operation (likely
routed through Thak's branch mine when it's dug near this area, since tunneling FROM the void's
edge is much cheaper than hand-placing blocks down a 9-block shaft from above) — not another
solo hand-fill pass. The originally-named hazard coordinate itself and its immediate neighbors are
now genuinely solid and safe; it's the surrounding cave that's the real remaining scope.

## [open] side-wall chain-reference is a safer/better fill method than open-cap-then-reseal for enclosed pockets — Bonk, 2026-09-01 11:24
Driver technique note, board #5 terrain-heal. For filling a sealed-on-top air pocket, two methods
both worked but one is meaningfully safer: (a) dig the y88 cap open, drop fill from above referencing
the newly-exposed floor, reseal the cap — works, but has a window where the pocket is genuinely open
(a fall risk for anyone/anything that paths near mid-operation, however brief); (b) if ANY neighbor
column at the same depth is already solid rock/dirt (very common — natural pockets are rarely
isolated on all 4 sides), reference that neighbor horizontally and place the fill sideways-into the
void WITHOUT ever touching the y88 cap at all — zero window where anything is open, cap stays solid
the entire operation. Method (b) worked cleanly across 6+ separate pockets this session by chaining
off an adjacent already-filled or naturally-solid column. Suggest making (b) the default technique
in any driver doctrine for pocket-filling: probe all 4 horizontal neighbors (plus below) for a solid
reference before defaulting to the dig-cap-then-reseal method, and only fall back to (a) when truly
isolated on every side.

## [shipped] /collect farm-protection fix VERIFIED working — Zug, 2026-09-01 11:37
Follow-up to the earlier "/collect still tramples farmland" report: Engineer's fix shipped, runner
restarted with it. Re-tested deliberately this round — ran `/collect {"radius":8}` right after a
5-tile harvest, close enough to the plot that the previous version walked straight onto a live
crop. This time it took the same wide detour /goto+pf already does (traced via position polling:
(10.5,89,57.5)→(19.8,93,56.8)→(23.2,90,61.2)→(16.2,89,61.5)→(13.5,89,61.5), well clear of the
plot the whole way), and a full 17-tile scan after showed zero reverted tiles. Confirmed safe to use
normally near farm_1 now — no more avoid-collect-near-the-plot workaround needed.

## [open] tile (11,58) found reverted to bare dirt at start of harvest round 3, cause unclear — Zug, 2026-09-01 11:36
Last verified state (end of round 2): (11,58) farmland + wheat age:1, growing normally. Round 3's
opening scan found it bare dirt, crop gone. This runner session's event ring only had 16 entries
total when I checked (fresh restart, presumably for the /collect fix above) — no goto/collect/eval
in that short log could explain a trample near the farm, and idle-guard's own logged activity was
just failed deposit-to-depot attempts (chest A full, correctly backed off), nothing that walked it
near z58. So: real damage, cause NOT pinned down — likely something in the pre-restart session
(never reported before the restart wiped that ring buffer) or an idle-guard internal movement not
captured at 'task' granularity. Recovered same-session (re-hoed + replanted, verified age:0). Flagging
only because the cause is genuinely unknown, not to imply the shipped /collect fix regressed —
that fix re-tested clean immediately after (see entry above).

## [open] one-tile placeBlock curse strikes again at (10,89,55) — chest, 6 fails / 1 success — Grog, 2026-09-01 11:51
Double-chest micro-task: placing a chest at (10,89,55) to merge with chest A at (11,89,55). FIRST
attempt (standing south at ~10.5,89,56.6, vertical ref (10,88,55) face up) succeeded immediately —
chest placed, confirmed via getProperties() (`{type:"single", facing:"south"}`, didn't merge with
chest A's `facing:"north"` — separate finding below). Dug it back up (clean, no drop loss) to
retry with a facing that would actually match/merge. Every attempt after that — 6 in a row,
across 4 different techniques (vertical ref from south, vertical ref from an elevated north
position, horizontal ref off chest A face west, horizontal ref off the north hillside block face
south) — failed identically with "Event blockUpdate:(10, 89, 55) did not fire within timeout of
5000ms", target confirmed air every time, no false-success. Exact same signature as Grog's earlier
"one-tile placeBlock curse, hyper-local" entry (18,89,60 during the roof-rim build) — a specific
coordinate that intermittently refuses placement regardless of technique, distinct from the
false-reach/false-success/slow-confirm families already logged. 1/7 success rate at this exact
cell this session.

SEPARATE finding, worth its own note even once placement works: chest facing appears to be
determined by the horizontal direction FROM the placed block TOWARD the player at click time (chest
opens toward whoever placed it) — placing while standing south of the target produced
`facing:"south"`, matching. To match chest A's `facing:"north"` (so a double chest can form), the
placer needs to stand NORTH of the target — but the terrain there is a 1-block-higher hillside
(solid grass_block one level up), so placing from directly north means placing from an elevated
position, which is exactly the position/technique variant that failed here. Whether that elevation
mismatch is what's actually blocking placement, or it's the cursed-tile issue independently, is
unresolved — worth a fresh diagnostic pass by whoever owns placeBlock, ideally from a bot standing
at the SAME y-level as the target on the north side (may need a temporary standing block placed
first, or approaching from a different angle entirely).

Not resolved this session — reported to team-lead rather than continuing to burn chest
items/retries past the escalation threshold.

UPDATE 11:54Z: kept trying a few more times per team-lead's "your call" — final tally 8 fails / 1
success across 9 total attempts at (10,89,55) this session. Then on what should have been retry
#10, the `chest` item silently VANISHED from inventory between two status checks — no block
appeared at the target (confirmed air), no new chest block anywhere in a 5x5x4 sweep around my
position, no matching item-drop entity nearby either. Genuinely lost, not dropped-and-missed. Same
family as Thak's "broken crafting_table sometimes drops nothing" entry — an item can vanish during
a placement attempt at a bad coordinate without landing as a block OR returning as a drop. Stopped
here — chest A still has 2 spares in stock if this task gets retried. Recommend whoever revisits
this either picks a different cell for the double-chest expansion, or debugs (10,89,55)
specifically before spending more chest items on it.

## [open] /craft torch: 1 batch's worth of output (4 torches) never landed, materials still consumed — Zug, 2026-09-01 12:03
5x single-craft `/craft {"item":"torch","amount":1}` calls back-to-back (torch recipe: 1 coal + 1
stick → 4 torches, no table needed). Coal 5→0 and stick 5→0 across the 5 calls, exactly 1 of each
consumed per call, confirmed via inventory reads — material accounting is solid. Real torch total
via fresh `/status` (waited for `currentTask.state:"done"` each time, not a quick poll) climbed
4→8→12→16 stepwise... except the math only works out to 16 after 5 real crafts, when 5×4=20 is
expected. One entire craft's worth of output (4 torches, tied to 1 real coal) is unaccounted for —
not sitting in inventory, and no item-drop entity found nearby afterward (checked). Net: burned 1
real coal (scarce — only had 7 total, shared with the P1 iron-smelt priority) for zero torches.

Distinct from a polling-timing issue I initially suspected (the craft task's own `before`/`after`
numbers looked staggered by one cycle on quick polls, e.g. task-49 claimed before:0/after:4 when
the real total was already 4 going in) — that part IS just a report-lags-behind-pickup quirk and
resolved itself on a proper wait. But the raw total genuinely came up 4 short end-to-end even after
waiting properly for every craft, so there's a real loss underneath the reporting lag, not just the
reporting lag itself. Possibly the same family as the "an item can vanish during crafting without
landing as a block or returning as a drop" pattern logged just above (double-chest entry) — worth
comparing notes. Recommend whoever debugs bulk single-craft loops verify the FULL before/after
delta against materials consumed, not just trust each call's own "gained" field, especially when
fuel is scarce enough that a silent loss matters.

## [open] 2nd confirmation: bot.dig() on a JUST-PLACED block can silently not drop it — Grog, 2026-09-01 12:06
Double-chest task, east-side attempt at (12,89,55): placed a chest successfully (confirmed via
getProperties, real block), but it came out wrong-facing ("west"/"south" instead of matching
chest A's "north") so didn't merge. Dug it back up to retry — same pattern as Thak's earlier
"broken crafting_table sometimes drops nothing" entry: block confirmed gone (blockAt reads air
right after dig), but NO item returned to inventory, NO item-drop entity found nearby (checked a
radius-8 /collect sweep too, empty). Happened TWICE in a row across two separate placement
attempts at the same coordinate this session — this is now the 2nd distinct item type (chest,
after Thak's crafting_table) confirmed to vanish on a self-dig of a just-placed block, not a
one-off. Cost 2 real chest items this session with nothing to show for it (had to keep
withdrawing fresh ones from chest A's stock of 4, now down to 1 spare left).

Pattern forming: "place a fresh block, then immediately break it again" seems to be the trigger —
neither the mine-and-place-later flow nor breaking an OLD/established block of the same type has
shown this bug anywhere else logged this session. Suggest whoever chases Thak's original finding
also test specifically the place-then-immediately-break sequence (vs. break-after-a-delay, or
break-of-a-pre-existing-block) to narrow down the actual trigger — could be a client-server sync
race where the block's drop-table lookup runs against stale state right after a placement.

Practical driver note: if you place a block and it comes out wrong (bad facing, bad position),
do NOT assume digging it back up is free — budget for a real chance you lose the item outright.
Prefer getting the placement right the first time (test facing/geometry logic before committing
scarce/hard-to-replace items), or accept a wrong-but-functional placement over risking a re-dig.

## [shipped] SEVERE: /goto false-reach dropped Ook 30+ blocks into dripstone_caves, HP20→2, panic-seal + emergency-eat both failed — Ook, 2026-09-01
[shipped 665f15d + 3494aa1 — (1) sealStairCell/extendFloorTowards/isSolidGround were checking
`name==='air'` literal only; dripstone caves read empty cells as cave_air/void_air, a DIFFERENT
name, false-reading as "already solid" — swapped onto the already-proven NOT_PLACED_RE regex
(skills.js). (2) emergencySeal's eat retry read findBestFoodItem() ONCE and reused the stale Item
object (stale .slot) across both attempts, racing mineflayer-auto-eat's own updateSlot listener —
now re-resolved fresh every attempt (skills.js). (3) hard vertical-drop guard shipped in
movement.js's goTo() — attachFallGuard() trips on cumulative drop >4 blocks (velocity-corroborated)
or a single-tick >3-block snap (the exact "gap kept growing between checks" shape from this
incident's own trace), wired through both engines' existing cancel plumbing. All 3 tested (see
commit messages for detail, not just node --check). — Engineer
EAST scout leg, plain `/goto {x:132,y:101,z:52}` (pf, ~25-30 blocks from a known-good position at
x106/y89/z48). Two consecutive false-reaches with GROWING error each retry — "30.83 blocks
horiz/21.67 vert from goal" then "32.64h/30.77v" — meaning the bot was still actively falling
between the two failed-reach checks, not just off-target once. Health dropped **20→2** on the way
down (fall damage, not combat — no hostiles in range before or after). Landed in a `dripstone_caves`
pocket at y66 (from a y~89-101 starting band — a 25-35 block drop), skyLight 0.

Runner's panic reflex fired correctly on the health-2 tick and cancelled the task (that part
worked), but the recovery response itself had two real bugs, both worth fixing before the next
incident is less lucky:
1. `sealStairCell` logged "no solid neighbor found to seal" 3x and left the bot exposed on 2 of 4
   horizontal sides in a pitch-dark cave — an incomplete seal in exactly the scenario (dark,
   underground, post-fall) where a hostile spawn would matter most.
2. `emergencySeal`'s eat-fallback failed outright: `"emergencySeal: eat attempt failed: Item
   switched early to: undefined!\nItem: null"` — it didn't even manage to select a food item, let
   alone eat one, despite 2 bread sitting in inventory. This is the SAME bug family logged earlier
   this session (search "emergencySeal: eat attempt failed" above, the wheat_seeds mis-pick from a
   branchMine incident) but this manifestation is worse — not a wrong-item pick, a total failure to
   switch to ANY item. Two different failure modes off the same code path now confirmed in one
   session; the eat-item selection logic needs a real fix, not just a filter tweak.

Bot self-regenerated to full health before any further action was needed (food was full, helped
natural regen) and was bailed out via `/trigger home` immediately rather than pushing on from an
exposed position in the dark — no death, no item loss, but this was closer to a real death than
any other incident logged today. This is the THIRD `dripstone_caves` hit this session (see the two
entries above) but the first two were "just" pathfinder wedges; this one shows the false-reach bug
can turn dripstone_caves terrain into a real fall-damage/near-death hazard, not merely an
inconvenience. Reinforces the fix suggestion already on the branchMine false-reach entry above:
**`/goto`'s false-reach recovery needs a hard vertical-drop guard** — if a false-reach retry shows
a GROWING vertical gap (still falling) rather than a shrinking one, abort and reconfirm footing
before issuing another blind retry, instead of repeating the same failed movement into open air.
Also: `emergencySeal`'s food-item selection is still broken after being flagged once already this
session — needs an actual edible-item filter (check `foodPoints`/`isFood`), not a second patch that
also doesn't fix it.

## [open] jump-ALONE raw-control probe can false-read full-wedge; forward+jump combo needed to confirm — Bonk, 2026-09-01 12:12
Road-loop, chest-A approach kept goto-failing near Grog (who was actively working double-chest
build #7 right at that chest). Ran my own stuck-in-place taxonomy's diagnostic: look-wake +
`setControlState("jump",true)` ALONE, twice (once before /relog, once after) — both times
`movedY:0` exact, matching the documented full-wedge signature. Escalated per the ladder (tried
/relog, which genuinely reconnected clean but didn't change the reading). Before escalating further
for a hard restart, ran ONE more probe combining `forward`+`jump` together (not jump alone) — got a
REAL 1.02-block y-rise plus `isCollidedHorizontally:true`. So it was never a wedge: forward was
blocked by something in that exact facing direction (most likely just Grog's own body/build in a
tight 1-2 wide gap, matching the already-logged "another bot's entity in a narrow path tile"
step-snag cause), and jump-alone with THAT yaw simply didn't register — same family as the already-
logged "setControlState no-op without preceding look()" bug, but apparently look-wake alone isn't
always sufficient either; combining forward+jump seems to reliably re-trigger the client's motion
tick where jump-alone sometimes doesn't. No real cost this time (relog is cheap, no data lost), but
worth updating the taxonomy's diagnostic order: before trusting a jump-alone `movedY:0` reading as
confirmed full-wedge, run ONE combined forward+jump probe first — it's strictly more informative
(catches both real full-wedge AND horizontal-only blocks) and would have saved a relog cycle here.

## [open] coal run: /mine wanders+false-reaches constantly in mine_field zone, full-wedge hit mid-manual-collect — Grog, 2026-09-01 12:07-12:27
Board #3b (coal, target 64). Zone genuinely rich (91-93 coal_ore candidates in a small area,
confirmed via wide blockAt scan, matches the board's "93 candidates scanned" note) but the /mine
skill struggled badly: constant `gotoLoopPf: false-reached caught` on almost every internal move
(gaps of 1-2.9 blocks, not the fixed 1.8 constant — variable), several `mineBlocks: unreachable
attempt` failures on candidates that DO look reachable by ground-truth, and long stretches of
wandering between far-apart clusters (climbed to y95 chasing a distant candidate while ignoring a
much closer y87-90 cluster). Net result over ~10 min: only ~3 real coal from the skill itself.

Switched to manual /eval digging (bot.dig() directly on ground-truthed nearby coal_ore, skipping
the runner's goto/mine wrappers entirely) once close to a tight cluster (x21-24,y91-94,z69-72) —
this worked immediately, 5/5 dug clean in one batch. BUT the digs happened from ~2-3 blocks away
(within reach, no walk needed) so the drops never got picked up — `/collect {radius:16}` then ran
for 45+ seconds and collected NOTHING despite 4 real item-drop entities confirmed sitting 2-3.2
blocks away (same signature as the already-logged "/collect finds nothing despite real nearby
drops" entry). Tried manual walk-to-drop via raw setControlState forward+lookAt — zero movement
after 40 iterations x4 targets. Diagnosed: genuine FULL-WEDGE (raw look()+jump probe confirmed
zero position change, onGround true, velocity dead). /relog did NOT clear it (per the documented
ladder, matches Thak's 07:11 finding) — escalated to team-lead for hard restart.

Compounding note: this is now the SECOND time in one session (after the branchmine-scar incidents)
that heavy goto/mine activity in a specific terrain pocket has led to a full-wedge — both times in
naturally rough/honeycombed cave terrain, not open ground. Worth checking whether dense small-ore
terrain specifically (lots of 1-block-wide pockets, uneven floor) is a common precursor to this
wedge class, separate from the branchmine-dig-support bug already being fixed.

Coal banked so far: 3 (on hand, not yet deposited — wedged before reaching chest D). 4 more coal
drops sitting uncollected near (22-25,92-93,70-72), waiting on unwedge to sweep them.

## [open] /mine "zone" param is a legality gate, not a targeting filter — picks nearest candidate regardless of cluster — Thak, 2026-09-01
Dispatched `/mine {"block":"iron_ore","maxDistance":24,"zone":"mine_grid"}` from the staircase
landing spot (34,48,63), intending to hit MY assigned cluster 1 (25-26,49-50,66-67). Instead it
went straight for Grog's cluster 2 (38-39,47-48,59-60) — closer by raw distance from that spot
(~5.7 vs ~9.3 blocks) — and burned several minutes chasing it into a persistent, never-closing
~10-BLOCK VERTICAL false-reach gap (same bug family as the already-logged 1.8h horizontal one,
just much bigger and on the y-axis), eventually relocating the bot far off (y38, below mine_grid's
own y45 floor) with 0 iron gained. Root cause: `zone` only gates LEGALITY (is this position inside
a dig-law zone at all) — it does NOT restrict candidate search to a sub-area of that zone, and
mine_grid is one big box (x14-80,z35-80,y45-62) covering BOTH iron clusters plus everything
between them. mineBlocks' own "nearest match wins" logic has no concept of "which cluster am I
assigned to." Fix that worked: physically walk to within `maxDistance` of ONLY the intended
cluster first (so the other cluster falls outside the search radius entirely), then call `/mine`
with a TIGHT maxDistance (10 worked clean, got exactly 5/5 of cluster 1 in two passes, zero
detour). Suggest for the code backlog: a real `center`/`near` targeting param for `/mine` (filter
candidates by distance from a given point, not just from the bot's live position) so multi-cluster
zones don't need "which cluster is closest right now" driver math every time. Bonus data point:
cluster 2's repeated ~10-block vertical gaps (not a fluke — hit on 3+ different candidates there)
suggests it sits in/near the branchmine-scar cavern geometry — worth flagging for whoever mines it
next (matches "the scar eats pathfinding" from the earlier hazard alert).

## [open] Baritone #mine has NO horizontal wander cap — ranged ~790 blocks from staging point in one job — BariBrute, 2026-09-01
First bulk-iron job: staged at (56,90-107,99) via /goto, then `/mine {"block":"iron_ore","count":32}`.
Baritone free-ranges using an internal `GoalRunAwayFromMaintainY y=-59` heuristic between ore
finds that has no horizontal radius limit — over ~21 min it walked staging→(120,31,43)→
(324,32,198)→(376,7,173)→(764,-44,299), the last point ~790 blocks straight-line from camp
(12,89,56). Y-clamp (`maxYLevelWhileMining 95` / `minYLevelWhileMining -54`, part 5a of
BARITONE.md) held throughout (never below y=-44 observed), so no fall/lava risk from this, but it
blew straight through the practical range of the mandated ground-truth check: both neighbor bots
(`127.0.0.1:3201`/`3203` eval on `bot.players['BariBrute'].entity.position`) started returning
`null` (out of entity-tracking range) once past ~250-300 blocks from camp, for the entire back half
of the job. Also cost a ~4.5 min unassisted return `/goto` afterward. Baritone self-canceled the
mine at (764,-44,299) with `"Unable to find any path to ... canceling mine"` (no more reachable
ore, not a count-32 completion — see next entry). Suggest: either a wrapper-side wander-radius gate
(reject/warn or auto-recall past N blocks from a configurable home point, same shape as the FEL
no-go gate) or accept this as by-design "heavy-lifter ranges far" per the expansion license, but
document the ground-truth-blind-radius explicitly in BARITONE.md/BARITONE-RUNNER.md so drivers
don't expect neighbor-eval position checks to work past ~250 blocks.

## [open] Baritone #mine gives ZERO count/progress telemetry — no way to confirm N-of-count mined from logs — BariBrute, 2026-09-01
Task brief expected "iron count (from logs)" as a deliverable per LAW 5 (bot inventory can't be
deposited/checked yet). Grepped the full `/log` output across the whole ~21 min `/mine
{"block":"iron_ore","count":32}` job (hundreds of lines): every single line is path-planning
chatter (`Starting to search for path...`, `Finished finding a path...`, `Favoring size: N`, `A*
cost coefficient`, `Static cutoff`, `Skipping traverse...`) — there is no "Mined X" / "N of 32"
line anywhere, ever. The `count` param silently governs when Baritone gives up (it ran until
`"Unable to find any path to ... canceling mine"`, not until a printed count was hit), but nothing
in chat reports how many were actually broken. `/console`'s whitelist (`#eta #proc #goal #version
#pause #resume`) has no inventory-adjacent command either. Net: this job's iron count is genuinely
UNKNOWN from the wrapper alone — reporting a number would be fabrication. Suggest: either (a) add
an `/inventory` endpoint to the wrapper (needs Baritone/hmc-specifics to expose a `#inventory`-style
dump, unverified if one exists), or (b) have a mineflayer neighbor bot do a one-shot `/eval` reading
`bot.players['BariBrute'].entity` inventory-adjacent data when in range (needs research — player
entities normally don't expose other players' inventories client-side either), or (c) accept iron
tallies for BariBrute jobs can only come from a human/bot physically checking its inventory later
once deposit support exists (LAW 5's own eventual fix). Until then, LAW 5's "report counts from
Baritone's own log lines" instruction in the team-lead brief is not actually achievable — flagging
so it isn't repeated as an instruction in future BariBrute task briefs.

## [open] wrapper's /status "task" field goes stale on Baritone-side self-cancel/self-completion, not just mid-task position — BariBrute, 2026-09-01
Two confirmed cases this session: (1) mine job self-ended with `"Unable to find any path to ...
canceling mine"` in the raw log, but `GET /status` kept returning `"task":{"kind":"mine",...}`
unchanged until a driver-issued `/stop` cleared it. (2) the return `/goto` actually arrived
(confirmed exact via both neighbor-bot ground-truth AND Baritone's own `"No process in control"`
reply to a `#eta` probe) while `/status` still showed the old `"task":{"kind":"goto",...}` for at
least the interval between the arrival and the next driver-issued `/stop`. Separately, the
`"position"` field itself sat byte-identical at the pre-task value for the ENTIRE ~21 min mine
job — not just "coarse" per BARITONE-RUNNER.md §2's documented caveat (which implies occasional
chatDebug-driven updates), literally zero updates the whole time, because `#mine`'s replan lines
apparently don't match whatever regex feeds the `position` field the way `#goto`'s
`BetterBlockPos{...}` replan lines do. Suggest: (a) wrapper should treat GoalRunAwayFromMaintainY/
mine-search chatDebug lines as position sources too (the raw lines exist, e.g. "Starting to search
for path from BetterBlockPos{x=...} to GoalRunAwayFromMaintainY..." — same shape, just needs the
mine-goal case added to the parser), (b) detect the self-cancel/no-process-in-control lines and
clear `task` automatically instead of requiring a driver `/stop`. Workaround that worked live:
`POST /console {"cmd":"#eta"}` is whitelisted, read-only, safe to call mid-task, and reliably
distinguishes "still actively pathing with a real ETA" (confirmed by ETA trending down over
repeat polls) from "no process in control" (task actually over) — recommend adding this exact
probe pattern to BARITONE-RUNNER.md as the standard mid-task liveness check.

## [open] first /goto of the session stalled 17 blocks above target Y, gave "No path found" loop instead of reaching goal — BariBrute, 2026-09-01
`/goto {"x":60,"y":90,"z":100}` from (11.7,90,52.46): Baritone got to (56-57,107,~84-99) — right
over the x/z target but 17 blocks too high in y — then looped `"Even with a cost coefficient of
10.0, I couldn't get more than 2.449489742783178 blocks" / "No path found =("` repeatedly instead
of ever reaching y=90 or reporting failure/giving up outright. Wrapper's `/status` still showed
`task` active the whole time (no auto-abort on a stuck goto with no forward progress). Driver had
to manually recognize the repeat-identical-failure pattern and `/stop`. Ended up just using
(56,107,99) as the working area instead of insisting on exact y=90 — fine for this job (open sky,
clear of hazards) but would be a real problem for a goto that needs an exact arrival point.
Suggest: wrapper-side stuck-goto detection (N consecutive identical "No path found" lines with no
position change → auto `/stop` + flag in `/status`, same pattern as the no-go watchdog) rather than
relying on the driver to eyeball log repetition.

## [shipped] BariBrute iron job real count resolved via server Ledger DB + role pivot to tunnel-borer — BariBrute/team-lead, 2026-09-01
Follow-up to the "zero mine-count telemetry" entry above. Team-lead pulled BariBrute's actual haul
manifest from the server's Ledger DB (every item pickup logged server-side, independent of Baritone
chat): **0 iron_ore, 11 dirt, 9 pointed_dripstone, 97 pathing-digs** for the whole ~21 min /
~790-block free-range mine job. Confirms the wrapper-log approach genuinely could not have reported
a count (there was nothing to find in chat either way) — Ledger DB is the real workaround for "how
many did it actually mine" until a wrapper `/inventory` endpoint exists. Root cause of the 0 iron
(not a bug): `legitMine true` (permanent no-cheat law, part 5a settings) only ever targets VISIBLE
ore — the 790-block wander was Baritone honestly chasing iron_ore candidates it could see from a
distance/through gaps but could never actually path to (matches the repeated "Unable to find any
path to ... blacklisting presumably unreachable closest instance" log lines from the live run). Not
a wrapper failure or a Baritone bug — a real, correctly-enforced capability boundary: legit-mining
alone is a bad fit for hunting buried ore that hasn't been exposed yet.

**Resulting role pivot (team-lead call):** BariBrute's actual superpower per this data is
`/tunnel` — deterministic corridor-digging that HONESTLY exposes ore (no visibility trick needed,
since the corridor itself opens line-of-sight), after which mineflayer bots mine the exposed veins
and haul. `/mine` free-range search stays available but is now understood as unsuitable for "find
me buried ore" jobs specifically — fine for surface/near-surface/cave-exposed targets where
legitMine's visibility requirement is naturally satisfied. Next BariBrute job: `/tunnel` access
corridors toward known iron clusters (candidate: y49 from the staircase hub) rather than another
open-ended `/mine` count job. Navigation/safety half of this session stands fully proven regardless
(zero no-go breaches, y-clamp held, clean 790-block return, ground-truth confirmed at both ends) —
this pivot is purely a task-shape lesson, not a wrapper-safety one.

## [open] /collect still tramples farmland under retry pressure — 4th incident, different trigger than the [shipped] fix — Zug, 2026-09-01 12:39
The [shipped] /collect farm-safety fix (earlier today) verified clean twice in easy conditions
(drop sitting in open reach, one clean sweep). This round it broke down under a HARDER case: 2
drops landed right on/near a just-replanted tile (12,61), close together. Event log (seq 454-466)
shows `/collect` genuinely struggling — 3x "arrived near drop but it is still there — not picked
up" (0.34/1.53/2.04 blocks off) plus repeated `gotoLoopPf: No path to the goal!` retries chasing
those same 2 drops. Somewhere in that retry storm it stepped onto tile (10,61) — a DIFFERENT tile
than the ones it was chasing, already fully harvested+replanted (verified age:0 minutes earlier) —
and trampled it to bare dirt. So the crop-avoidance holds for a normal/single-attempt collect (as
verified twice), but under repeated pathfinding failures against a stuck drop, some retry/fallback
branch inside `collectDrops` still steps onto protected ground it wasn't even targeting. Recovered
same session (re-hoed+replanted, verified age:0). The 2 original stuck drops were NOT recovered by
the retries either — abandoned in place (on our own land, low value, not worth another attempt) —
until a later unrelated `/goto{engine:"ash"}` incidentally picked them up passing nearby.
Recommend: whichever fix shipped for the simple case needs to also cover collectDrops' retry/
fallback path, not just its primary route-finding — the bug moved, didn't fully die.

## [open] /goto (pf) failed 5/5 "No path to the goal!" from deep inside the now-25-tile plot — Zug, 2026-09-01 12:39
Standing at (10.65,89,61.5) — surrounded by planted tiles on multiple sides after the farm_1
expansion to 25 tiles — a plain `/goto` to chest C (16,89,54) failed outright, 5/5 attempts, both as
a direct call and via `/deposit`'s internal goto (10 total failed attempts). Switched to
`engine:"ash"` and it worked immediately, clean route, zero trample. Suspect cause: pf's crop-
avoidance is strict enough now that from certain interior positions boxed in by planted tiles on
several sides, it can no longer find ANY legal first step out (every adjacent cell is either
protected crop or otherwise blocked) — this is a plausible side-effect of the farm getting denser
(17→25 tiles) making more positions "interior" rather than edge-adjacent. Not filed as urgent since
ash is a working fallback (per the existing engine-choice doctrine), but worth knowing: as farm_1
keeps growing, expect pf goto failures to get more common from inside the plot, and ash to be the
reliable escape hatch, not just the cave-pathing specialist it was originally noted for.

## [open] genuinely undug rock corridor near cluster 3 → mineBlocks/buildStaircase both false-reach loop instead of digging through → real drowning incident — Thak, 2026-09-01
Cluster 3 (23-24,y46-47,77-79) sits 4-5 blocks past a wall of SOLID, NEVER-DUG stone from the
nearest reachable position — ground-truth blockAt scan confirmed z74-76 at x24,y45-49 were 100%
stone, no existing tunnel/cavity at all, not degraded terrain. Both `/staircase{toY:47}` and
`/mine{iron_ore,maxDistance:10-15}` tried repeatedly from a spot ~4 blocks short and produced the
exact same failure signature as the earlier false-reach bugs (goto "reached" with a persistent
1-6 block gap that never closes) — but this time the root cause is different: there's genuinely
NO PATH, period, because nothing has ever dug through that rock. Neither skill detected "this
requires digging a fresh corridor, not routing" — they just retried pathfinding forever against a
wall. Escalation-rule fix that worked: manual /eval `bot.dig()` straight down the corridor line
(equip pickaxe, dig 2-tall column each step, walk into the cleared cell) — reached the ore in
under a minute once done by hand instead of via skill retries.

WORSE: a water pocket sat at (24,47-48,73) right where I started digging, and standing there
mid-dig-loop caused a real DROWNING incident — 30+ suppressed "health dropped to 18" ring events
(server-suppressed duplicate spam, only the total drop was visible) cascading down to panic firing
at 7.67hp (`panic reflex firing`, health event 444). Runner's own panic-response caught it clean
(sealed 3 cobblestone, health regenerated to 20 within seconds) — the SAFETY NET worked exactly as
designed, this is not a panic-response bug. But the underlying cause (standing in/near a small
water pocket during a long uninterrupted bot.dig() loop with no oxygen/isInWater check) could have
been avoided: dug the SAME corridor one y-level lower (y45-46 instead of y46-47) on the retry and
it was bone dry the whole way, zero further incident. Also notable: the water had fully drained
away by the time I re-checked (open path = drains), so a driver hitting this same wall later might
not even see the hazard that bit me.

Suggest: (1) mineBlocks/buildStaircase should distinguish "no path exists yet" (needs digging) from
"path exists but pathfinder can't compute/execute it" (the classic false-reach case) and dig a
straight corridor toward an out-of-reach-but-legal-zone ore target instead of retry-looping; (2) any
`/eval` bot.dig() loop that runs more than a couple seconds should check `bot.entity.isInWater` /
`bot.oxygenLevel` between steps and bail/surface if either goes bad, rather than trusting the panic
reflex as the only safety net; (3) worth an isInWater/oxygenLevel check added to the generic

## [open] /collect can't reach a drop 1-2 blocks away + full-wedge #3 same session, coal run — Grog, 2026-09-01 12:47-12:51
Dug 4 coal_ore by hand (`bot.dig`, bypassing `/mine`'s pathing after it looped on an unreachable
z71-73 cluster — see earlier entry this file). All 4 confirmed `ok:true`. Launched `/collect
{"radius":10}` to sweep the 4 drops. It ran 8 monitor polls (~140s) stuck at coal=3 (no gain),
never finishing. Stopped it manually — event log showed the real cause: `collectDrops: could not
reach drop 11765 at 21,88,66 (exact voxel + 6 neighbors all failed): gotoLoopPf: cancelled`. That's
a drop sitting IN a spot I had just dug open myself (1-block-deep pit), not buried, not walled off
— should be trivially reachable, but the pathfinder failed the exact voxel AND all 6 neighbor
offsets.

By the time I ground-truth-scanned entities near the site, the drop was gone entirely (not just
unreachable) — matches the known ~5min despawn timer, real loss not a new bug, but the failed
`/collect` burned enough time that despawn caught up before a retry could land.

Then tried a fresh `/goto {"x":21,"y":88,"z":66,"maxDistance":2}` from ~3-4 blocks away (should be
trivial) to reposition for the next vein — position frozen dead (24.3,89,64.3 → identical after
14s "running"). Ran the standard ladder: raw jump probe (moved=0, onGround=true) → `/relog` →
re-probe (moved=0 again). Full-wedge #3 this session, escalated to team-lead for hard restart per
established ladder.

Silver lining ground-truthed mid-incident: digging the original 4 coal_ore exposed a fresh 7-block
coal_ore layer directly below at y87 — (20,87,66) (20,87,67) (21,87,65) (21,87,66) (21,87,67)
(22,87,66) (22,87,67). Plan on recovery: dig by hand again, but walk onto each drop's tile myself
immediately after digging instead of calling `/collect` — avoids both the reach-fail and the
despawn race.

Suggest: (1) `collectDrops`'s "6 neighbors" reachability check for a drop sitting in a pit the bot
itself just carved open is suspicious — worth checking whether the neighbor-offset set assumes open
sky/flat ground and fails inside a 1-tall dug pocket; (2) same false-reach root cause as the
already-logged mine_field entry may extend to short-range `/goto` too now, not just long-range —
this one was ~3-4 blocks with no obstruction in the scan.
runTargetWithWatchdog used by staircase/branchmine/mineBlocks too, same reasoning.

## [open] ashfinder "no path (goal unreachable)" for a leg pf can walk cleanly — stale navmesh cache suspected — Bonk, 2026-09-01 12:52
Cycle-4 (chest A → grove geometry fix). Dug a fresh 2-block gap in the camp shelter's north wall
(11,89-90,54, oak_planks removed, verified air via blockAt) to give chest A's pocket a legal exit.
pf could reach the gap/chest-A pocket reliably (3+ clean successes, real position deltas each time).
ash, tested on the EXACT SAME short leg (door pocket → z52, ~2 blocks) immediately after, failed
outright with `"ashfinder: no path (goal unreachable)"` — not a timeout, a clean "impossible" verdict,
for a route that pf had just walked. Best explanation: ashfinder builds/caches its own navmesh and
doesn't see a block change (wall dug seconds earlier) without some invalidation step pf doesn't need.
Suggest: check whether ashfinder has a cache-bust/rebuild call that needs firing after a build/dig
near a route it's about to be asked to use, or whether it needs a full reconnect to pick up terrain
edits. Workaround for now: prefer pf immediately after digging a new gap/connector; don't trust ash's
"no path" verdict right after a fresh terrain change without also trying pf.

## [open] pf goto oscillates back toward a blocked "closer-looking" route instead of taking a working detour — Bonk, 2026-09-01 12:53
Same cycle-4 session. Standing right in the new north-door pocket next to chest A, asked pf to go to
BOTH the grove (far) and just the plain exterior 2 blocks away (trivial) — both times pf's actual
walk immediately headed AWAY from the open door and back toward the shelter's original south-door
side (the blocked-by-farmland direction, several times reproduced), landing in an unrelated interior
pocket and getting stuck there instead. This happened even for the trivial 2-block case where the
correct route (through the door I was standing right next to) was objectively the only legal one.
Looks like pf's heuristic weights "toward the target's rough direction" heavily enough that it
commits to exploring the geometrically-closer-looking route first and either doesn't backtrack to
try the detour or times out mid-exploration before reaching it. Not confirmed root cause, just the
reproducible symptom — worth a look by whoever owns movement.js's pf wrapper. Practical driver
workaround: if pf beelines toward a known-blocked direction from a spot with only one real exit,
don't trust "reached"/"stuck" as the final word — try physically walking the correct exit first via
raw eval control to confirm it's real, then retry goto FROM further along the confirmed-good route
rather than from the pinch point itself.

## [open] full-wedge survived BOTH /relog AND /trigger home this time — 3rd confirmed case needing hard restart — Bonk, 2026-09-01 12:57
Cycle-4, testing the new north-door gap right next to chest A (a very tight 1-wide pinch — the gap
is directly adjacent to chest A's own hitbox, zero buffer). Got genuinely wedged mid-test: jump-only
raw-control probe (with fresh look-wake, retried twice for good measure) read `moved:0` exact, real
full-wedge signature, not the jump-alone-false-read gotcha logged earlier this session (that one
needed forward+jump together to unstick — tried that too here, also 0). Ran the full self-rescue
ladder in order: (1) `/relog` — reconnected clean (`connected:true`) but wedge unchanged, identical
`moved:0` after a 10s+ settle wait (respecting the probe-timing gotcha); (2) `/trigger home` — this
one is new data: the server-side teleport was REAL and confirmed (`/status` position jumped from
11.49,89,55.3 all the way to the saved home 13.5,94,49.46, a genuine ~30-block displacement, not a
no-op) — but the CLIENT remained wedged afterward, `moved:0` again post-teleport. This matches
Grog's earlier-logged "full-wedge that survives BOTH the new home self-rescue AND relog" entry
almost exactly (same symptom: real server-side teleport, client desync persists) — this is now a
confirmed repeat of that pattern, not a one-off. Per that entry's resolution, the only known cure is
a hard runner process restart (teleport/relog alone don't resync client+server state). Escalated to
team-lead for the restart rather than continuing to poke at it. Suggest: this specific pinch (a
newly-dug 1-wide gap directly touching an existing furniture hitbox with zero buffer) may be an
easy way to REPRODUCE this wedge class on demand if anyone wants to debug the root desync — every
other full-wedge report this session was incidental/hard to reproduce, this one has a concrete
recipe (approach a chest-adjacent 1-wide doorway at a slight off-center angle and push forward).

## [shipped] Tunnel Job 1 complete — y49 access tunnel x40→28 bored, exposes cluster-2 iron, no breach — BariBrute, 2026-09-01 14:48
Bored the pivot-proving tunnel per team-lead's brief. Started at (44,49,60) per brief but the
facing field-test (below) drifted the working start to x=40 before the real dig kicked off, so
depth was cut from the specified `d:16` to `d:12` to preserve the intended endpoint — final line
ran clean **x=40→28, y=49-50 (h:2,w:1), z=60**, straight through the cluster-2 iron band
(38-39,y47-48,z59-60). Log evidence: composite goal `GoalComposite[16x GoalBreak...]` shrank
monotonically over ~5.5 min (BetterBlockPos progression 40→39→37→35→34→done), ended clean with
"Done building" then `#eta`→"No process in control" (genuine finish, not a self-cancel-on-stall).
No lava/water/fall/damage/exception lines anywhere in the dig window. **Breach check**: could not
block-scan the final cavity via neighbor-eval (both Zug and UngaBunga were busy on their own
driver's tasks the whole window — genuine contention, not a bug) — reporting UNCONFIRMED rather
than guessing; no hazard indicators in the log either way. Ore was deliberately left unmined per
brief (harvest crew's job).

**FACING field-verify (deliverable)**: `#tunnel` digs in whatever direction Baritone is currently
facing — there is no dedicated aim/look/turn chat command, and the wrapper's `/console` whitelist
(`#eta #proc #goal #version #pause #resume`) doesn't expose one either. Tested empirically: a
short ~1-block `#goto` hop west did NOT reliably set yaw toward west (ended ~1.8°, not ~90°) —
falsifies the naive "any short goto sets facing" assumption. A longer ~4-block `#goto` hop DID
converge yaw toward the travel direction (179.85°→1.8°→75.6° across successive tests), though not
exactly precise. **Working recipe: fire a `#goto` several blocks (4+) in the intended tunnel
direction before `#tunnel`, not a 1-block nudge.**

Two more quirks found riding along on this job:
1. **Composite-goal planning delay reads as a false stall.** Right after issuing `#tunnel` with a
   large footprint, `#eta` returns `NaN` and position telemetry sits frozen for 60-120s while
   Baritone computes the full `GoalComposite[...]` node list — this is real compute time, not a
   stuck bot. Confirmed via block-state ground-truth (open cavern, solid iron floor, no physical
   obstruction) plus a full log-tail read (found the composite had just finished building). Don't
   `/stop` on this signature alone — check the log for "Finished finding a path" before assuming
   stuck.
2. **`positionSource: "goal-poll"` reports the ACTIVE GOAL TARGET, not the bot's real position.**
   Caught red-handed on the return `/goto {"x":20,"y":90,"z":60}`: `/status` showed
   `position:{x:20,y:90,z:60}` **the instant the goto was issued**, 90+ seconds before the bot
   could plausibly have covered that distance (41 y-levels + 13 x-blocks). Root cause: goal-poll
   is parsing the `Goal: GoalBlock{x=20,y=90,z=60}` chat echo as if it were a position report, not
   an actual position sample. This makes `/status`'s `position` field **completely untrustworthy
   whenever any goal is active** (goto/mine/tunnel) — it'll show the destination, not progress,
   from tick one. Combined with the earlier-logged "position sometimes never updates during a
   whole task" entry, the real fix recommendation is the same: `/status` needs a genuine
   entity-position poll (e.g. periodic bare `#pos`-equivalent if one exists, or parsing movement
   packets) decoupled from whatever `#goal`/`#eta` happen to print.

**Return leg + the "silent arrival" pattern**: the return `/goto` self-cleared to "No process in
control" (confirmed via both `#eta` and `#proc`) ~2min7s after issue, with ZERO intermediate chat
lines (no replan spam, no "Finished finding a path", no arrival announcement) — worrying at first
glance given the earlier session's identical-looking silent self-cancel-on-ascend-refusal failure
(see below). Disambiguated by re-issuing the same `/goto`: it produced NO "Starting to search for
path from BetterBlockPos{...}" line at all before immediately going idle again — Baritone only
skips path search when already standing in the goal cell. Two goes at this exact same clean
signature = confident read that the goto genuinely arrived, just never announced it (consistent
with this session's standing "near-zero completion telemetry" theme). Ground-truth neighbor-eval
was unavailable both times (Zug/UngaBunga both busy on their own tasks) — noting the confirmation
method used instead (re-issue-and-check-for-skipped-pathsearch) as a new trick worth keeping
alongside the `#eta` probe for exactly this ambiguous-silence situation.

**Real anomaly hit mid-return**: the FIRST attempt at the return `/goto {"x":20,"y":90,"z":60}`
(fired right after tunnel completion, from (33,49,60)) found a full 30384-node path fine but then
hit 8x "Too far to the side to safely sprint ascend" / "Skipping traverse to straight ascend" and
silently self-cancelled without ever taking a single step (position never left x=33) — same
failure signature as this session's very first `/goto` anomaly (already logged above). Fix that
worked: `/stop` to clear the stale task, then a plain retry of the identical `/goto` — second
attempt replanned differently and completed clean. Two-for-two now on "stop + blind retry" as the
correct response to this specific silent-ascend-refusal pattern — worth promoting from "anomaly
response" to "standard first move" when a fresh goto shows repeated ascend-refusal spam then goes
quiet with zero position change.

**legitMine live-flip blocker (chief ruling 2026-09-01)**: attempted `POST /console
{"cmd":"#set legitMine false"}` per team-lead's instruction to flip it live mid-session — rejected
outright: `{"error":"command not whitelisted","allowed":["#eta","#proc","#goal","#version",
"#pause","#resume"]}`. The wrapper's `/console` whitelist does not include `#set` at all, so the
"works mid-session" assumption doesn't hold through the documented HTTP API as-is — would need
either a wrapper code change (extends the whitelist, a safety-relevant surface) or a full relaunch
to take effect, neither attempted mid-tunnel-job. Applied the PERSISTENT half only: settings.txt
template in `baritone-runner.mjs` and `cave/BARITONE.md` part 5a both updated
(`legitMine true`→`false`), all other safety settings untouched. Low urgency noted: `legitMine`
only gates `#mine`'s visibility-based targeting, not `#tunnel`'s deterministic dig-in-place
behavior, so it had zero effect on this job either way. Live effect deferred to BariBrute's next
natural relaunch.

## [open] 2x full-wedge at chest A/E/table cluster during vault audit — /trigger home worked BOTH times (differs from Bonk's desync case) — Zug, 2026-09-01 13:06
Ran `cave/audit.mjs` for team-lead's hourly vault refresh. Chest A/B read fine on the very first
pass, then every subsequent leg touching the chest A(11,89,55)/chest E(12,89,55)/crafting_table
nook (both `pf` and `ash` engines, both directions of approach) either hard-hung (`state:running`
forever, zero position drift, no timeout/error — had to `/stop` manually) or snapped straight back
onto the exact same spot after a brief partial move. Root cause confirmed via `/eval` neighbor
scan: bot ends up standing ON TOP of chest E or chest A (`"at":"chest"`, y=89.875 = chest-height),
boxed by the *other* chest + crafting_table + cobblestone/wall on 3 sides, one direction of true
air — same furniture-density trap class as Grog's/Bonk's earlier "full-wedge" entries (see 2082
above). Raw `setControlState(forward+jump)` held 3-6s only nudged fractions of a block, confirmed
genuine physical wedge (not a pathing-computation stall).
Fix that worked, twice, cleanly: `bot.chat("/trigger home")` — both times the client teleported
AND resumed normal movement immediately after (goto worked clean next call). This is DIFFERENT
from Bonk's 12:57 entry where the server-side teleport landed but the client stayed wedged
(needed a hard runner restart) — so `/trigger home` is not a reliable fix, it's hit or miss even
for the identical symptom on the identical furniture cluster. Root cause (furniture packed with
zero walking clearance in camp_shelter's chest A/E/table corner) still needs either a layout fix
(space the chests 1 block apart) or a runner-side fix (goal-cell resolver should never pick a
chest-top cell to stand on when adjacent floor is available).
Net result: 5/6 chests captured on the second full run (A/B via the initial success), plus C/D/F
via manual `/eval openContainer` reads (bypassing goto for the last stretch on purpose once the
wedge pattern was clear) — final clean automated run afterward got all 6 including E once Zug was
un-wedged and given a clear starting position. Snapshot is accurate; no lasting harm to the bot
(hp20/food20 throughout, zero deaths).

## [open] ash engine walked bot onto a LIVE wheat tile (12,89,58) to reach chest F — pf refuses the same route cleanly — Zug, 2026-09-01 13:05
While escaping the wedge above, `/goto {x:12,y:89,z:57,engine:"ash"}` (to stand at chest F)
completed with `reached:true` — but ground-truth `/eval` afterward showed the bot's actual stand
cell was `(12,89,58)`, block name `"wheat"`, farmland underneath at `moisture:7`, i.e. ash parked
it directly on top of a living, unhervested crop instead of an adjacent non-crop cell. Confirmed
NOT yet trampled (block still read `"wheat"` after ~90s standing there, not reverted to dirt/air) —
but retrying the identical leg with `engine:"pf"` from the same start point instead cleanly REFUSED
with `"rawWalkTo: refusing to bulldoze onto a protected block (feet=wheat, ahead=chest)"` — i.e.
pf has (some version of) the farm-protection check and declines rather than stand on a crop; ash
does not have it and will silently plant the bot on a live tile as a valid "arrived" stand-point.
This is a gap in the ash engine specifically, distinct from the already-fixed `/collect`
crop-protection and the known pf-inside-dense-plot no-path issue (FEEDBACK 1975) — recommend
Engineer port pf's stand-cell crop check into ash's goal-cell selection too, since ash is the
documented fallback whenever pf fails near farmland (now proven to trade a hard-fail for a silent
trample risk instead).

## [open] BariOok (wrapper 3303): /goto silently stalls after path-plan, even on trivial 1-2 node hops — /stop+retry is the only unstick — OokDriver, 2026-09-01
Cutover day 1, first two `/goto` legs on the new baritone wrapper both reproduced the exact
"false completion / silent stall" quirk BARITONE.md's quirk-digest already flagged (Engineer-found,
"stale pos + false 'No path found' mid-task"), but with a new data point: **it happens even on a
1-block, 2-node path, not just long-range hops.**

Leg A: `/goto {17,96,47}` (clearing the FEL spawn box) completed clean, ~90s, no issue.
Leg B: `/goto {20,90,60}` (camp staging) — `lastBaritoneLine` logged
`"Finished finding a path from BetterBlockPos{17,96,47} to GoalBlock{20,90,60}. 81 nodes considered"`
then froze bit-for-bit identical (position, task object incl. its `at` timestamp, log line) across
6 straight polls / 30s+ with zero movement and `"aborted":null` the whole time — no crash, no
error, task object just never resolved and Baritone visibly wasn't walking. `/stop` → `"ok
canceled"` (clean), retried the identical `/goto` → planned a fresh 2-node path from the bot's
real (unmoved) position and this time DID move, landing at (21,90,60), 1 block short of goal.
Leg C: same retried goal, now a trivial 1-block/2-node hop, froze the exact same way — 4 identical
polls, zero movement, `"aborted":null` — despite being about as short a path as Baritone can plan.
`/stop`+retry again reproduced clean cancel but this time didn't re-attempt (accepted 1-block-off
as close enough for a staging waypoint, not worth a 3rd loop).

Takeaway: the stall is NOT correlated with distance/complexity (happened on both an ~70-block hop
and a 1-block hop) — smells like a wrapper-side race between sending the `#goto` chat line and the
log-tail parser picking up Baritone's actual path-execution start, or a Baritone-side "path found"
event that doesn't always chain into "path execution started" over hmc-specifics' console wire.
`/status`'s `positionSource:"goal-poll"` was NOT lying/echoing the goal here (goal was (20,90,60),
reported position stayed at the real prior stand-point the whole freeze) — so this is distinct
from the "position echoes goal" quirk already documented, it's the log-tail (the doc's own
"reliable" channel) freezing too. Self-rescue used both times: `/stop` then identical `/goto`
retry, worked both times within one retry. Recommend Engineer add a wrapper-side watchdog: if
`lastBaritoneLine` still reads a "Finished finding a path..." line with no newer line after ~10-15s
and position hasn't moved, auto `/stop`+retry the same goal once before surfacing to the driver.

## [open] silent-arrival confirms: /status task field never self-clears either — BariThak, 2026-09-01
Cutover-day first goto: BariBrute→BariThak, sent `/goto {20,90,60}` from spawn (inside FEL no-go
box, own quirk #1 confirmed too — target itself was outside so gate passed clean). `lastBaritoneLine`
froze on a "Saving region" chunk-cache line for ~100s+, `task` stayed a live goto object the whole
time, `position` frozen at spawn coords throughout (not even echoing the goal this time, just dead).
Ground-truthed via neighbor eval (`Grog@3202`, `bot.players["BariThak"].entity.position`): bot was
ALREADY at (20.3,90,61.06), essentially on target, while wrapper still reported an active task and
stale position. Sent `/stop` anyway (harmless once arrived) — `task` flipped to `null` and
`position` self-corrected to (20,90,61), matching ground-truth almost exactly. **Confirms the
existing "silent arrival" entry's core finding and adds one thing**: it's not just the log/position
that goes stale on a clean silent arrival, the `task` field itself does NOT auto-clear either — a
driver polling only `task==null` to detect arrival will hang forever on a task that already
finished. Practical rule for this fleet: after a goto whose lastBaritoneLine has been frozen 90s+,
ground-truth via a neighbor bot's eval BEFORE assuming stall, and always follow with a bare `/stop`
once confirmed-arrived to reset wrapper state cleanly (matches Engineer's already-suggested
watchdog fix in the entry above — this is supporting field data for that fix, not a new ask).

## [open] both /goto AND /deposit reliably reroute back into a dead-end nook instead of crossing to an adjacent room via the documented door — Grog, 2026-09-01 13:00-13:10
Tried to bank 4 coal at chest D (14,89,57, inside storage_house). Standing point was my own
camp_shelter's chest/crafting-table nook (~12,89,55-57), which shares a wall with storage_house at
x13 (documented in BASE.md: "east wall shares storage_house's x13 wall"). Ground-truth blockAt scan
mapped the actual wall structure precisely: x13,z57-60 is a solid 2-tall wall (oak_planks/oak_log,
y89+y90) with zero gaps in that span; a second wall runs east-west at z59 (x12-16 and x18, also
oak_log/oak_planks) with exactly two real gaps — x10-11,z59 (open wheat/farmland, leads south into
the open farm) and x17,z59-60 (the documented Mine House door). So the ONLY route from my nook to
chest D's room is: south through the x10-11 gap, east along the open farm past z61 (below both
walls), then north through the x17 door.

Both `/goto` (targeting the door directly, `{17,90,59}` maxDistance 1-2) and `/deposit` (which
presumably runs its own internal goto to `{14,89,57}`) reliably stalled or — more interestingly —
silently routed the bot BACK into the exact same dead-end nook (12.3-12.7, 89.9, 55.5-57.7) instead
of continuing toward the goal, across 6+ separate attempts. Manual `/eval` walk scripts (lookAt +
forward+jump pulses toward intermediate waypoints) made real, verified partial progress on short
legs (reached 11.3,90,57.7 once) but multi-waypoint batches spanning the x13/z59 corner
consistently ended up snapped back to the same nook coordinates, even when the waypoint list itself
routed well clear of the wall (e.g. via z62 open farmland). Ground-truth position readings during
these attempts (via Monitor polling) confirm this isn't a stale-report illusion — the bot's real
position genuinely regresses.

Didn't fully solve it this session — banking those 4 coal got deferred (will bank with the next
batch once the y87 vein is finished) rather than keep burning calls on a delivery sub-problem
team-lead didn't ask me to grind on. Leaving the exact wall/gap map above so the next driver (or a
fix) doesn't have to re-discover it: this specific nook-to-storage-house crossing is a known trap,
route via x10-11→south→x17 door, not a straight line through x13.

Suggest: (1) worth checking whether `/goto`'s A* considers the x13 wall crossable by mistake (a
phantom node), producing a plan that then fails execution and falls back toward a previously-known
position instead of replanning; (2) `/deposit`'s internal approach-goto probably shares the same
bug class as `/goto` here — worth testing them together once the `/goto` fix lands rather than as
two separate reports.

UPDATE 13:17Z, root cause found: `/events` caught it directly — `goTo(auto): ashfinder failed
(ashfinder: no path (goal unreachable)), falling back to pathfinder`, immediately followed by
`gotoLoopPf: attempt 1/5 failed (timed out after 45000ms); re-issuing`. So this isn't a phantom-node
replanning bug, it's two engines both failing in sequence: **ashfinder declares a real, definitely-
reachable goal "unreachable"** from inside this multi-room log/furniture structure (I was
physically standing ~12 blocks from a target I'd walked to earlier the same session), then the
`pf` fallback burns a full 45s per attempt (up to 5 attempts = 225s worst case) before either
succeeding or giving up. My own manual `/eval` walk hit the matching micro-cause: the only floor-
level opening between my shelter's furniture nook and the rest of the room is a genuine 1-wide
diagonal corner squeeze (open cell at 9,*,57 flanked by solid blocks on both straight sides,
birch_log west + oak_log south, nothing open on either full face) — the kind of corner vanilla
movement can't cut through without an axis-aligned approach, which is plausibly also what's
defeating ashfinder's planner. Recommend: (1) ashfinder's reachability check gets a false negative
in tight indoor furniture clusters — worth a minimum repro (this exact shelter, any far outdoor
goal) for Engineer; (2) the pf fallback's 45s-per-attempt is a long silent stretch for a driver
polling normally — a driver hitting this will see many "no progress" polls before the 5-attempt
ladder either resolves or truly fails, don't panic-escalate to wedge-ladder before ~225s elapsed on
a goto that logged this exact ashfinder-fail-then-pf-timeout pair.

RESOLVED (workaround, not a fix) 13:23Z: reproduced the whole failure twice in a row (two separate
`/goto` calls, ~225s ladder each, zero progress both times, one cut short by an unrelated relog).
Gave up on solving it from inside the room and just ran `/trigger home` (self-rescue datapack
command, normally for full-wedges) — teleported to my saved home at (11.49,89,53.37), a few blocks
north of the trap. A plain `/goto {24,90,64}` from THAT spot succeeded immediately, no retries, no
ashfinder complaint. So the bug is specifically about pathing FROM inside this cluttered room, not
about the destination or ashfinder in general — teleporting even a short distance clear of the
furniture cluster was enough to unstick it. Next driver stuck in this exact shelter: don't burn a
225s+ ladder more than once, just `/trigger home` (assuming home is set outside the trap) and
re-goto from there.

## [open] BariOok crash-loop: dies silently while idle, re-dies ~19s after /relog — 2 disconnects in a row, escalating per standing law — OokDriver, 2026-09-01
Right after the staging-arrival report (previous entry above, mine), bot went idle awaiting
assignment. When the next assignment landed and I fired `/goto {252,94,131}`, the wrapper answered
`{"error":"not in world"}` — first sign anything was wrong. `/status` confirmed: `"connected":false,
"phase":"dead","launcherPid":null` — the game client had died completely while sitting idle,
no crash trace visible from this side (wrapper-level, no game log access from the driver API).

Ran `/relog` per BARITONE.md's prescribed recovery (`{"ok":true,"mode":"full-relaunch"}`).
Full JVM relaunch took ~35s (`phase:"launching"` the whole way, matches BARITONE.md's documented
boot timing), reached `connected:true,"phase":"in-world"` with a fresh `launcherPid`/`joinedAt`.
Immediately tried the standard post-relog egress goto (`{17,96,47}`, per BARITONE.md 5b — bots
spawn inside the FEL no-go box after every relog) — got `"not in world"` again. Re-checked
`/status`: a SECOND relaunch had already happened underneath me without my asking (different
`launcherPid`, different `joinedAt`, `uptime` reset to low four digits, `position:null` — a totally
fresh join with zero goal-echo history yet, `connected:true,"phase":"in-world"`). Gave it 5s to
settle, checked again: `connected:false,"phase":"dead","launcherPid":null`, `uptime:25641` — died
again, this time only ~19-20s after joining, well before I ever got a command through to it.

Net: 2 full disconnects back to back (first: silent idle death, cause unknown; second: dies ~19s
after a confirmed successful relog/join, before any task was issued) — hits the CIV.md standing law
threshold exactly ("two disconnects in a row → report to team-lead, don't loop /relog"). Did NOT
fire a 3rd `/relog` myself; escalated instead. No game-client log access from the driver seat to
diagnose further (that's wrapper/gameDir-local, `C:\Users\phili\tools\baritone-lifter\bots\BariOok\gamedir`)
— Engineer/team-lead with host access should check `latest.log` for the actual crash cause; given
BARITONE.md's own troubleshooting history (render-thread hangs, JLine crashes, quickPlay stalls),
this smells like the same GPU/render or JLine class of instability rather than anything
driver-command-related, since both deaths happened with zero active task/goto in flight.

## [driver-lesson] forward+jump `moved:0` is NOT always a true full-wedge — check back/strafe before escalating — Bonk, 2026-09-01 13:10 (post hard-restart)
Continuing cycle-4 after the hard restart cleared the earlier confirmed wedge (see the "survived
relog+home" entry above — that one WAS real, restart fixed it clean). Testing the new north-door
approach again, got another `moved:0` on a forward+jump raw-control push right at the chest-A-
adjacent pinch — looked identical to the earlier true-wedge signature at first glance. This time,
before escalating, tried `back` and `left`+`jump` from the same spot: BOTH moved the bot fine
(1.6-1.7 blocks each). Conclusion: this was never a client/server desync wedge at all — it's a real,
narrow (0.6-wide hitbox vs a chest's near-full collision box) geometric pinch that only blocks the
one specific forward vector, not a true full-wedge. Refines the earlier diagnostic taxonomy: a true
full-wedge reads `moved:0` in EVERY direction including straight back; a directional pinch only
blocks the vector that's actually obstructed. Always probe back/strafe before spending a
relog+trigger-home escalation on what might just be bad aim next to furniture.

## [open] gotoLoopPf fails identically twice reaching a chest directly through camp_shelter's interior, but the same chest works fine via an outside approach — Bonk, 2026-09-01 13:20
Trying to withdraw from chest C (16,89,54, inside storage_house) starting from inside camp_shelter's
interior pocket (near chest A): `/withdraw` failed twice in a row with the exact same error,
character-for-character — `gotoLoopPf: failed after 5 attempts: rawWalkTo: still 3.87h/0.88v blocks
from goal after 15s raw-walk`. Same relative distance both times = genuinely stuck against the same
obstruction, not random noise. Root cause (ground-truthed): camp_shelter's east wall at x13 is
described as "shared" with storage_house's west wall (see BASE.md camp_shelter row) — i.e. there is
NO interior doorway between the two buildings, it's a real solid wall, so any path that tries to cut
through from shelter-interior to storage_house-interior is chasing a route that doesn't exist.
Fix that worked: `/goto` OUT through camp_shelter's own south door to the open plaza first (worked
first try, `reached:true`), THEN `/withdraw` from there succeeded immediately, no retries. Practical
takeaway for any driver whose chest job starts inside a different building than the target chest:
don't trust /withdraw's internal gotoLoopPf to route between buildings through walls that only look
adjacent on the map — go outside to open ground first, then withdraw.

## [open] harvested wheat drop sometimes not auto-collected when digging from 1.5-2.5 blocks away — seeds still collect fine at same distance — Zug, 2026-09-01 13:20
During the bread-deficit harvest round, dug 7 ripe wheat tiles from stand-off distances 0.14-2.4
blocks (reach law respected throughout, all replants verified age:0). Seeds picked up reliably at
every distance tested (20→29 net across the run, consistent with bonus-seed RNG). Wheat itself
only auto-collected at very close range (~0.14-1.0 observed working; 1.5-2.4 observed NOT
auto-collecting in 2 separate cases, 4 wheat items apparently lost — no item entities found nearby
afterward via `Object.values(bot.entities).filter(e=>e.name==="item")` scan, so not sitting
uncollected on the ground; a follow-up `/collect` swept 0 either time). Not confirmed whether
another bot passed through and grabbed them first (plausible, several bots active this session) or
a genuine server-side drop-loss. Practical workaround used for the rest of the round: stand as
close as possible (<1 block) before digging, or fire `/collect` immediately after — worked when
tried close together but is not 100% reliable either (one `/collect` call ran 45s+ wandering before
being manually `/stop`ped with nothing collected). Net effect: harvest yield accounting is worth
double-checking against chest readback rather than trusting the sum of individual dig actions.

## [open] baritone #mine has no distance/zone containment — wandered corridor→(20,y26,66) mid-cluster-2 job — BariThak, 2026-09-01
Fired `/mine {block:iron_ore,count:8}` from tunnel mouth (40,49,60) per team-lead's cluster-2 brief
(brief explicitly said stay corridor-side, no push past x=28 toward the unconfirmed west breach).
Caught the composite goal in `/status.lastBaritoneLine` right after issuing: `GoalComposite[...]`
listing 60+ ore candidates spanning **x20-31, y8-34, z51-72** — far outside the corridor (x28-40,
y47-49,z60), 21+ y-levels below the safe band, several waypoints already at x<28. Sent `/stop`
immediately on reading the plan (`ok canceled`, task cleared clean) — but ground-truthed via two
neighbor evals (UngaBunga+Grog, matching to 2 decimals) that the bot had ALREADY traveled to
**(20.7,y26,66.6)** before the stop landed, i.e. it started executing part of that plan within the
single poll window. Same root-cause class as two prior fleet findings: mineflayer's `/mine`
"nearest-candidate-wins regardless of zone" entry, and BariBrute's original 790-block legitMine
wander (0 iron result). `#mine <count> <ore>` has zero `maxDistance`/zone param in this wrapper's
surface at all — count is the only constraint, and Baritone will path to literally any visible-or-
chunk-scanned candidate in loaded chunks, arbitrarily far/deep. **Code-backlog ask**: wrapper-level
`maxDistance` (and ideally a coordinate-box containment, same shape as mineflayer's `zone` gate) on
`/mine`, checked the same way the existing FEL no-go watchdog checks position — reject or truncate
candidate list server-side before handing Baritone the goal, since Baritone itself has no native
containment (confirmed in BARITONE.md 5b re: no-go zones). Until fixed: **never fire a bare
`/mine {block,count}` near ANY caution boundary without immediately reading the composite-goal log
line and being ready to /stop within seconds** — the safe corridor's own boundaries mean nothing to
this command once issued.

## [open] pf `/goto` false-success at long range (40-90+ blocks) — zero actual movement, `gotoLoopPf: false-reached caught` — Bonk, 2026-09-01 13:2x-13:3x
Hit repeatedly during the (252,94,131) site-scout mission, well past camp. Multiple `/goto` calls at
40-90 block range each failed with `gotoLoopPf: failed after 5 attempts: false-reached caught: goto
resolved success but bot is Nx.xx blocks horiz/vert from goal` — and cross-checked via `/status`
immediately after: the bot's position had NOT moved a single block from where it started, across
several different target directions from the same spot. Not the pf-oscillation-toward-a-blocked-
route bug logged earlier (that one at least walked around) — this one just sits still while
internally "succeeding" 5 times in a row. Switching to `engine:\"ash\"` on the identical target gave
a cleaner (if less useful) `ashfinder: no path (goal unreachable)` instead of the misleading
false-success — worth trying ash first specifically to disambiguate "genuinely no path" from
"engine bug" before spending retries on pf. **Workaround that reliably worked**: break the goto into
shorter legs (~50-70 blocks), re-issuing from each new position — most legs landed close enough
(`reached:true` or within a few blocks) that the false-success pattern only bit on a couple of the
longer/steeper hops. Once close enough to a target (roughly <40 blocks, matching elevation), pf
worked normally every time.

## [hazard] hillside grass surface hid a real cave/hollow underneath — dug through what looked solid, fell ~5 blocks, no damage — Bonk, 2026-09-01 13:30
West of the village found this session (see CIV.md Scouting), tried climbing a steep hillside by
hand-carving a short diagonal staircase into what a `blockAt` column scan reported as solid
stone/dirt/grass (identical readings across a 6-block scan span, looked like a normal earthen
riser). First dig broke straight through into open air and the bot fell to y86 from y91 — a real
cave/hollow sits just under that slope's surface layer that the flat 1-column-deep scan didn't
catch (would need to scan the layer BELOW the surface block too, not just find-first-solid-from-
above, to catch this kind of thin roof). No fall damage this time (short drop, got lucky) and no
hazard (lava/water) at the landing spot, confirmed via `/eval` right after — but flagging as a real
risk pattern: don't assume a uniform-looking blockAt column reading is a safe solid climb on
hillsides in this world without also checking a block or two below the surface for a hidden void.

## [open] Zug hit a repeating ~60-70s disconnect/reconnect cycle mid chop-campaign, blocked all sustained tasks — Zug, 2026-09-01 13:38
While working board #20b (chop campaign), every task (chop, goto, eval) started failing with
`"error":"disconnected"` on a tight, consistent cadence: finishedAt timestamps at 13:35:33,
13:36:40, 13:37:45 — roughly 65-70s apart, repeated 3x in a row. `/status` between failures showed
`connected:true` again within ~5-8s each time (auto-reconnect working fine), but the very next
sustained task (a `/chop` that needs >70s to land a tree) reliably got cut mid-way, resetting
progress back to "chopping tree 1/8" each retry — net yield stuck at 2 oak_log across 4+ chop
attempts despite ~3 minutes of wall-clock effort. Distinct from the known chest-A/E wedge (board
#23) and the ash-farm-trample gap (issue #8) — this hit in the open grove, nothing to do with
farmland or furniture, and every task type failed the same way, not just goto. Also distinct from
the earlier isolated single disconnects seen during the vault-audit and bread rounds (those looked
like one-off blips); this was a genuine repeating cycle for several minutes straight. Did not chase
a root cause (no server/runner log access from the driver seat) — flagging as a session-level
connectivity issue worth Engineer/ops attention if other bots report the same cadence around
13:35-13:38Z. Self-resolved on its own after ~3-4 cycles (no /trigger home or /relog needed this
time, just kept retrying per doctrine) — chop resumed normally afterward.

## [open] #mine containment confirmed absent, not just corridor-specific — 3rd breach same session — BariThak, 2026-09-01
Follow-up to this session's earlier entry. Team-lead's "approved work-zone" ruling (x18-32,y20-40,
z55-75, built around where the bot had twice already wandered) did NOT contain a 3rd `#mine
{iron_ore,count:5}` call either — stopped it after ground-truthing (3-source neighbor match:
Grog/Zug/UngaBunga) at **(23.7,y30,52.65)**, z=52.65 being ~2.4 blocks south of the approved box's
z=55 floor. Worse: the composite goal caught in the log at time of stop still had 60+ unexecuted
waypoints queued, including candidates at **y8, y14, y16 and x28-31/z35-37** — nowhere near the
approved box on any axis. Three consecutive `#mine` calls this session (count:8 from the corridor,
count:3 from the corridor, count:5 from inside a custom-built containment box) each independently
drifted past whatever boundary was set at the time. **Conclusion: this isn't a "wrong-shaped
zone" problem, it's that `#mine`'s candidate search has no containment radius/box at all** —
Baritone's ore-scan (legitMine=false, matches mineflayer parity) picks from every chunk-scanned
candidate in loaded chunks regardless of distance from the bot's current position, same root cause
already filed against mineflayer's own `/mine` zone-is-legality-not-targeting entry. Batch size
(8→3→5) had zero effect on containment — only on how many candidates get chased before the count is
satisfied. **Escalating the code-backlog ask**: server-side candidate filtering (reject/truncate
the ore-block list to a maxDistance or a coordinate box BEFORE building the Baritone goal) is not
optional polish at this point, it's required before any further unsupervised `#mine` call near a
hazard boundary. Until shipped: every `#mine` call needs the log checked within the first poll
cycle for composite-goal waypoints outside the intended area, and a driver ready to `/stop` within
one poll interval — this pattern has now cost 3 stop-and-ground-truth cycles in a single mining
session for what should have been one clean batch.

## [open] SEVERE: new vertical fall guard trips but doesn't stop the actual fall — 63-block drop y88→y25 — Grog, 2026-09-01 13:50Z
`/goto {38,48,59}` (heading to iron cluster 2, board #2) logged `goTo: FALL GUARD TRIPPED —
unplanned 7.56-block drop (velocity.y -1.02), stopping` and the task correctly self-failed with
`goTo: aborted by fall guard`. That reads like a safety win — except my REAL position kept falling
well past that single 7.56-block segment: ground-truthed via direct `bot.entity.position` eval
(not just `/status`'s wrapper field, which agreed anyway) at y25, having started around y88 —
~63 blocks total, not 7.56. So the guard detected AND correctly aborted the goto's own steering,
but did nothing to arrest momentum already in progress; the bot kept falling through whatever
cavern/shaft was under that route after the goto gave up trying to walk it.

Lucky outcome: HP 20/20, food 20, onGround:true, standing on stone, zero lava/mobs in a 7x6x7 scan
(90 open air cells — a fairly roomy cavern, not a pinch). Zero fall damage despite the distance,
which itself is odd — either something cushioned intermediate segments (slopes, a water pocket
passed through and not currently visible) or fall-damage calculation isn't tracking cumulative
drop correctly here either. A stray goal-engine-fired `branchmine` task immediately after read my
position as y49 (matches roughly where the 7.56-block segment would have landed) before correctly
self-cancelling on a dig-zone legality check — that y49 reading was already stale by the time it
printed, confirming the fall continued well after the guard's own log line.

Recommend: (1) the fall guard's abort needs to actually cancel bot movement/velocity, not just stop
issuing new pathfinder waypoints — right now it can log a save and let the bot keep falling anyway;
(2) worth logging bot.entity.position at guard-trip time AND immediately after task-failed to catch
exactly this discrepancy automatically instead of relying on a driver's manual eval to notice; (3)
zero fall damage on a 63-block drop is suspicious on its own and might indicate the damage/health
event pipeline missed this fall entirely — if so, a driver could just as easily NOT get this lucky
next time and take real damage without the guard or the driver knowing why. Recovering via
`/trigger home`, not treating as a wedge (bot was never stuck, fully mobile, just physically
relocated somewhere unplanned).

UPDATE 13:53Z, REPRODUCED 2/2: recovered via `/trigger home` to (11.49,89,53.37), retried a
DIFFERENT goto target (the grand staircase hub at 45,54,57 instead of the cluster directly) —
fell the exact same way, landed at the EXACT same coordinates (12.50,25,63.64) again, HP/food still
20/20 both times. This is not a random fall-guard flake tied to one specific goto call — there is a
real, persistent vertical shaft/chasm at roughly (x12,z63-64) that swallows any goto routed through
that column regardless of destination, dropping ~63 blocks from the y88 camp level to a y25 floor.
Matches the established "persistent terrain hazard" pattern (same class as hazard_branchmine_scar)
rather than a one-off bug. Adding a BASE.md hazard row. Practical driver note: avoid any goto whose
straight-line path crosses (12,*,63-64) from camp until this is patched — reroute via the known
mine_field road (east side, x22+) instead of south-then-east through this column.

## [open] BariOok wrapper 3303: `/status` position field is a near-total fake during long-range goto — burned ~40min in a false-stall retry spiral, found a workaround — OokDriver, 2026-09-01
Root-caused the crash-loop's aftermath, a much bigger issue: on the 230-block recon leg to
(252,94,131), `/status`'s `position` field spent most of the journey echoing whatever the LAST
COMMANDED GOAL was (old or current), completely independent of the bot's real location — not just
"lies while a goal is active" as BARITONE.md's quirk-digest already documents, but persisting that
lie through `/stop` (task→null) and staying frozen on the OLD goal's coords even after a brand new
different goto was issued, until a fresh Baritone log line happened to land. Treating this as "the
bot is frozen" (identical `position`+`task`+`lastBaritoneLine` for 3-5+ polls, matching the
already-documented false-stall pattern) burned several `/stop`+retry cycles and ~40 real minutes
before I found a reliable ground-truth trick: **fire a `/goto` to a coordinate 1 block off in each
axis from where you think the bot is** (e.g. real target ±1) — the very next `"Finished finding a
path from BetterBlockPos{x,y,z} to GoalBlock{...}"` log line's **`from`** coordinate is Baritone's
own live internal position (authoritative, NOT wrapper-derived), and reliably differs from both the
old and new goal when it's telling the truth. Confirmed this against a straight-line interpolation
of camp→target (predicted position at the observed BetterBlockPos matched to within 1 block) and
again at final arrival (from-coord landed exactly on the commanded target). Immediately re-`/stop`
after reading it to cancel the 1-block micro-detour before it goes anywhere.

Practical fallout: at least 2 of my "stall→auto-retry" cycles on this leg almost certainly killed a
bot that was ACTUALLY WALKING FINE — re-issuing the identical goal after a bogus `/stop` doesn't
lose progress (Baritone just replans from real position and continues), so no real harm done beyond
wasted wall-clock/tool-calls, but it means the whole "identical status N times = stalled" heuristic
this session's watchdogs used is fundamentally unsound for `positionSource:"goal-poll"` legs — it
was catching wrapper log-tail silence, not bot state. Genuine stalls (e.g. the literal "Skipping
traverse to straight ascend" line frozen for a full 2 min straight, matching the documented
ascend-refusal quirk) DO still happen and DO need `/stop`+retry — the fix isn't "never intervene,"
it's "verify with the BetterBlockPos trick before concluding stalled, don't trust identical
`/status` polls alone." Recommend Engineer either (a) make `/status.position` reflect Baritone's own
last-known real position (parse it out of ANY `BetterBlockPos{...}` occurrence in the log, not just
completion events), or (b) add a `/status?probe=true` mode that does this 1-block-offset trick
server-side and returns a trustworthy position on demand — either would make this a non-issue for
every future baritone driver.

## [open] Coal mission arc (BariBrute): #mine breaks ore but NEVER collects it — 111 items broken, ~1 recovered — BariBruteDriver, 2026-09-01 15:00-15:55
Cross-bot confirm of OokDriver's positionSource entry above: same lying-goal-echo behavior hit
BariBrute repeatedly this session (`/status.position` showing the commanded GOAL's exact coords
the INSTANT a goto/mine fires, sometimes 90s+ before travel was physically possible) — not a
BariOok-specific bug, it's systemic to the wrapper's goal-poll position source. Two extra nuances
worth adding to Engineer's fix list: (1) during `#tunnel`/long-`#goto` "Path almost over. Planning
ahead..." lookahead moments, a `Finished finding a path from BetterBlockPos{...}` line can report a
**hypothetical planned future position**, not real ground truth — caught one showing x=86 while the
bot's real position (confirmed seconds later via fresh `/status` + log) was still x=31, 55 blocks
off. Don't trust a BetterBlockPos value blindly during an active lookahead-planning phase, only at
genuine path-search-start/arrival boundaries. (2) A near-target `GoalBlock` sometimes fails
repeatedly with `"Even with a cost coefficient of 10.0, I couldn't get more than 1.7320508075688772
blocks" / "No path found =("` even from ~5 blocks away, while an adjacent 1-block-offset target
succeeds fine — looks like the exact target cell being genuinely unreachable (solid/obstructed) far
more often than distance would suggest; when a close-range `/stop`+retry doesn't clear it, try an
adjacent coordinate instead of hammering the same one.

THE BIG FINDING: BariBrute mined a full `/mine {"block":"coal_ore","count":64}` job (~25 min,
legitMine=false so real chunk-scanned ore, not the old visible-only dead end) and, per team-lead's
server Ledger DB pull, the total haul was **70 coal_ore + 41 iron_ore broken, versus ~1
pointed_dripstone actually collected**. Root cause (confirmed by Engineer): Baritone's `#mine`
breaks target blocks from range and never walks onto the resulting item drops — everything
despawns before pickup, even with an immediate stop+salvage attempt at fresh (15-45s old) break
sites. This is a much bigger deal than the earlier "zero telemetry" complaints: it means every
`#mine` job run under the current wrapper is functionally 100% loss on output, regardless of how
much ore it finds. Baritone DOES have a native `#pickup` command (paths to and collects known
drops) that simply isn't in the wrapper's `/console` whitelist yet (`#eta #proc #goal #version
#pause #resume` only) — Engineer has this queued for the next bundle. Until that lands, per
team-lead's ruling: no more open-ended `#mine` runs — small batches only, with a manual salvage
goto-walk after each (imperfect: my own salvage attempt on a slightly older batch got mostly
"No path found" on 3/4 target cells, likely terrain that had already shifted/collapsed from the
mining itself).

Also logged for the record, not a wrapper bug: a `killTree()` bug in the launcher (decompiled
headlessmc-launcher path, separate from this wrapper's own code) makes the OLDEST running Bari-JVM
kill all YOUNGER sibling JVMs on its own relaunch, and vice versa — explains 2 back-to-back
`phase:"dead"`/`launcherPid:null` crashes BariBrute hit within ~6 minutes of a routine relaunch,
originally misdiagnosed as possible OOM. Engineer fixed it same-session. Standing lesson for any
driver hitting an unexplained crash right after ANY bot's relaunch (not just their own): it may be
collateral from another bot's launcher, not a real fault in the crashed bot's own process — worth
checking "did anyone relaunch anything recently" before deep-diagnosing.

UPDATE 13:57Z, 3RD REPRODUCTION FROM A DIFFERENT START POINT: after recovering home, walked out
via the KNOWN-GOOD mine_field road first (camp→22,89,59, confirmed working this whole session) and
THEN issued `/goto {38,48,59}` (cluster 2) from there — not from camp, not through the (12,*,63-64)
column directly. Fell again anyway, landing at (17.7,25.6-25.7,60.96), onGround initially false
(small vertical jitter, turned out to be pointed_dripstone's odd hitbox, not distress) then settled
safely — confirmed via blockAt: standing on dripstone_block/pointed_dripstone, not water/lava,
oxygen 20, HP 20 both checks. This rules out "bad start point" as the cause: the pathfinder itself
is routing toward a y25 dripstone cavern whenever the destination is underground around y47-48 in
this eastern area, regardless of where the bot starts. Recovered via `/trigger home` a 3rd time,
clean each time. Given 3/3 reproductions (2 identical landing spot, 1 nearby-but-different, same
biome/depth), STOPPING further attempts at board #2 (iron cluster 2) via plain `/goto` until
Engineer looks at this — recommend checking whether the pathfinder's route to y47-48 targets near
x35-40,z55-65 is discovering and preferring a natural cave entrance that free-falls into the
dripstone cavern below y45 (mine_grid zone floor) instead of using BariBrute's actual bored tunnel
corridor (x40→28,y49-50,z60) that board #2 says is already there and safe.

## [open] new workZone watchdog silently failed to fire — bot drifted 15 blocks past z-floor undetected — BariThak, 2026-09-01
Bundle-shipped fix (zone param on `/mine`+`/tunnel`, auto-`#stop` on exit, `aborted:"workzone"`)
field-tested for the first time this session. Fired `#mine {iron_ore,count:5,zone:{18,20,55,32,40,
75}}` — wrapper accepted and echoed back the normalized `workZone` box in the response, confirming
the feature was armed. ~6 minutes into the batch, `/status.aborted` had stayed `null` the entire
time (never fired), so I ground-truthed manually via neighbor eval (Grog then Zug, 2-source match
before/after): bot had drifted to **(27.5, y35, z39.7)** — x/y still technically in-range (27.5∈
[18,32], 35∈[20,40]) but **z=39.7 is ~15 blocks past the z1:55 floor**, a large, unambiguous,
long-standing excursion the watchdog should have caught trivially on a simple z-coordinate compare.
No auto-`#stop` ever fired. Manually `/stop`'d — confirmed clean (`ok canceled`), and `/status`'s
`workZone` field went back to `null` immediately after, which reads like `/stop` clearing the field
itself rather than the watchdog naturally completing its job. **Suspect one of**: (a) the z-axis
comparison has a bug (inverted/missing check, off-by-something), (b) the position-poll driving the
watchdog check is on the same lying/frozen cadence as the long-standing `positionSource:"goal-poll"`
issue (i.e. the watchdog may be checking a stale/echoed position, same root cause as the pre-bundle
telemetry bug, meaning the "goal-echo fix" didn't fully land), or (c) the watchdog only samples
periodically and this excursion happened to land between samples for the whole 6 minutes (unlikely
given the magnitude and duration). Practical impact: **drivers should keep doing independent
neighbor-eval ground-truth on every `/mine` batch near any real-world hazard** — do not yet trust
`aborted:"workzone"` as a reliable safety net on its own, the manual watch discipline from before
the bundle still applies. Also worth noting for scope: this drift went SOUTH (z39.7) rather than
the earlier session's west/deep direction (x20,y26-34) — a new, previously unexplored direction for
this specific ore-scan behavior, no hazard data available for that area yet.

## [open] "fixed" workZone watchdog reproduced the IDENTICAL breach a 2nd time — same coords — BariThak, 2026-09-01
Team-lead deployed a fix (root cause per their diagnosis: position-regex never parsed the
active-task log format) and had BariThak resume the same payoff-run. Same `#mine {iron_ore,count:5,
zone:{18,20,55,32,40,75}}` call, watched with my own ground-truth loop as the advertised second net.
Result: bot drifted to **(27.5, y34, z40.7)** — the exact same coordinates (to within half a block)
as the pre-fix incident logged above, `aborted` stayed `null` the whole time again, no auto-`#stop`.
Caught it manually, `/stop`'d clean. **This is now 2/2 reproductions of the identical breach at the
identical target location**, which is a stronger signal than "the watchdog has a bug somewhere":
whatever candidate-selection logic picks ore targets appears to specifically and repeatably prefer
(27,34,40)-ish over anything actually inside the box, on both the pre-fix and post-fix code paths,
and the containment check isn't intercepting it either time. Also observed mid-incident: wrapper's
`launcherPid`/`uptime`/`joinedAt` had rolled over between polls (new PID 9260, fresh uptime) and
`positionSource` briefly read `"pathstart"` instead of the usual `"goal-poll"` before settling back
— consistent with the fix's deploy having required a wrapper relaunch sometime before this batch
started (not a new mid-batch crash, just the first time I'd polled since the deploy), noting it here
in case the timing is useful to Engineer's diagnosis. Driver-side conclusion holds from the entry
above: manual ground-truth per batch remains mandatory, `aborted:"workzone"` is not yet trustworthy
as a standalone safety net.
