# BASE.md — infrastructure registry (FEL-protocol compatible)

Every shared placed structure gets a row. Reserve `planned` BEFORE gathering
materials (prevents duplicate builds). Flip to `built` + announce
`BASE +<id> at (x,y,z)` in chat right after placement. Leases for contended
blocks (furnace!): `USING <id>` / `FREE <id>` in chat, heartbeat ≤4 min,
`LEASE-BREAK <id> (stale)` after ~5 silent min — but NEVER break a furnace
lease if ANY slot non-empty.

| id | coords | status | access |
|----|--------|--------|--------|
| table_1 | (12,89,56) | built | shared |
| chest_a_materials | (11,89,55) | built — CANONICAL depot (truth fix 2026-09-01: the "duplicate" here was the live account all along — every code constant (skills DEPOT_POS, runner IDLE_GUARD_DEPOT_POS, bench CHEST_A) and all session deposits point here; the (9,89,55) rebuild was destroyed by Bonk mid-escape (blind ceiling-dig, no drop, contents were the post-incident restock). Hole at (9,88-89,55) → terrain-heal/plaza fill. Lesson: block.name check before EVERY dig near furniture. DESTROYED AGAIN (found gone 2026-09-01 ~08:56Z, ground-truth blockAt+wide-scan, not stale-read). REBUILT 2026-09-01 by UngaBunga at (11,89,55) — floor under it was also a hole (11,88,55 air), capped with 1 cobblestone support first, chest placed on top, both verified via blockAt. Contents post-rebuild: 2 oak_log. GROG GROUND-TRUTH 2026-09-01 09:10Z: blockAt confirmed chest present (still alive, not destroyed again). No oak_log found on open (contradicts "2 oak_log" note above — gone/moved by someone since). Banked wheat 23, wheat_seeds 98, raw_iron 5, chest 4, oak_sapling 24, leaf_litter 45, feather 2 — openContainer readback after deposit matches exactly, chest now holds only those 7 stacks. | cavecrew |
| chest_b_tools | (12,90,54) | built — GROG GROUND-TRUTH 2026-09-01 09:10Z: openContainer readback = dirt 126 (2 stacks), leaf_litter 100 (2 stacks), torch 83 (2 stacks), cobblestone_stairs 12, cobblestone 3. ZERO tools present — "tools" in the id is stale, contents are building/torch supplies, not tools. Not withdrawn, audit only. | cavecrew |
| furnace_1 | (11,89,57) | built — GROG GROUND-TRUTH 2026-09-01 09:17Z: blockAt confirmed a furnace ALREADY sitting here (not planned/missing as this row claimed), openFurnace read empty/unlit (no fuel/input/output) — never used. Row was stale, someone rebuilt it before this session or the "destroyed w/ shelter" note never got flipped back. Did not place anything (spot occupied by the real thing already); kept spare furnace on Grog, held pending team-lead. | shared-lease |
| trading_post | (6-8,112,22) | built | inter-tribe (TRADE.md) |
| storage_house | (~x13-21,z53-59) | BUILT + verified 2026-09-01 (Mine House: walls, 4 pillars, window, door, sealed floor, stone roof 63/63, log rim 36, 4 lamp-posts; chests C+D inside; console sign (18,90,60) facing south, waxed). GROG GROUND-TRUTH 2026-09-01 09:11Z (audit only, no withdraw): chest C (16,89,54) = wheat_seeds 11 + wheat 2, thin but food-consistent with "food chest" label. Chest D (14,89,57) = EMPTY, 0 items — contradicts "ore" label in CIV.md, no ore currently stored. | cavecrew |
| path_camp_post | door(11,90,58)→(7,112,23) | planned (Bonk, stepped) | shared |
| farm_1 | (x8-11,z58-59,y88) | planned (Zug, 8 tiles + water hole) | cavecrew |
| mine_main | entrance (15,89,57) | planned (grand staircase → y54) | cavecrew |
| grove_1 | (8,91,68) | built (8 saplings) | cavecrew |
| camp_plaza | around chests (cobble floor + log lamp-posts) | planned | cavecrew |
| hazard_old_shaft | honeycomb (14-15,85-89,44-48) | SEALED — all 7 real pit columns capped at y88, each individually verified block-by-block from outside (stand-beside + horizontal reference, never re-entered the pit). Earlier "5/7 done" report was wrong — those caps didn't actually stick (placeBlock false-success), caught on redo via fresh per-block verification. Hazard cleared. | cavecrew |
| hazard_seal_pocket | (~23,86,61) | HAZARD — sealed dig-pocket from pre-canDig-fix era (old FEL→camp drop route). Trapped Ook 2026-09-01, tp-rescued. No path in/out with canDig:false — bots must not path through; fill when Bonk seals honeycomb. | cavecrew |

Foreign territory (hands off, no builds within 10 blocks): FEL base around
(-3,111,4) + their depot chests (-3,111,3) area. Mystery chest (-1,91,56):
unknown owner, do not touch.

Chief's builds (NEVER touch, not ours to modify): glass row (13-16,88,60).

Elevated-risk chunks (server-op ruling 2026-09-01, no regen — route AROUND):
chunks (0,-1),(0,0),(-1,-1) near FEL base — desync class: position-freeze
wedges + client-air/server-solid suffocation + dead lighting. Avoid pathing
through; wedge there = straight to tp+restart rescue.
