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
| chest_a_materials | (11,89,55) | built — CANONICAL depot (truth fix 2026-09-01: the "duplicate" here was the live account all along — every code constant (skills DEPOT_POS, runner IDLE_GUARD_DEPOT_POS, bench CHEST_A) and all session deposits point here; the (9,89,55) rebuild was destroyed by Bonk mid-escape (blind ceiling-dig, no drop, contents were the post-incident restock). Hole at (9,88-89,55) → terrain-heal/plaza fill. Lesson: block.name check before EVERY dig near furniture. | cavecrew |
| chest_b_tools | (12,90,54) | built | cavecrew |
| furnace_1 | (11,89,57) | planned (rebuild — destroyed w/ shelter) | shared-lease |
| trading_post | (6-8,112,22) | built | inter-tribe (TRADE.md) |
| storage_house | (~x13-21,z53-59) | BUILT + verified 2026-09-01 (Mine House: walls, 4 pillars, window, door, sealed floor, stone roof 63/63, log rim 36, 4 lamp-posts; chests C+D inside; console sign (18,90,60) facing south, waxed) | cavecrew |
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
