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
| chest_a_materials | (11,89,55) | built | cavecrew |
| chest_b_tools | (12,90,54) | built | cavecrew |
| furnace_1 | (11,89,57) | planned (rebuild — destroyed w/ shelter) | shared-lease |
| trading_post | (6-8,112,22) | built | inter-tribe (TRADE.md) |
| storage_house | (~x13-21,z53-59) | planned (Grog, FEL-style: stone roof, log frame) | cavecrew |
| path_camp_post | door(11,90,58)→(7,112,23) | planned (Bonk, stepped) | shared |
| farm_1 | (x8-11,z58-59,y88) | planned (Zug, 8 tiles + water hole) | cavecrew |
| mine_main | entrance (15,89,57) | planned (grand staircase → y54) | cavecrew |
| grove_1 | (8,91,68) | built (8 saplings) | cavecrew |
| camp_plaza | around chests (cobble floor + log lamp-posts) | planned | cavecrew |

Foreign territory (hands off, no builds within 10 blocks): FEL base around
(-3,111,4) + their depot chests (-3,111,3) area. Mystery chest (-1,91,56):
unknown owner, do not touch.
