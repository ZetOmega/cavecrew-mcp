# TODO.md — cavecrew shared task board

Drivers: between missions CLAIM (set Status=DOING + your bot name), set DONE
when ground-truth verified, ADD new rows at fitting priority. One quick edit
at a time — read fresh before writing. Orchestrator prunes DONE.

| # | Lane | Task | Who | Status |
|---|------|------|-----|--------|
| 1 | EQUALITY | Iron pickaxes every bot — strip mine feeds chest A, each driver eval-crafts own AT TABLE (never pocket grid, no /craft till patch) | Thak feeds, all craft | todo |
| 2 | ECONOMY | Watch FEL shop (8,112,22) for first trade; restock CAVE shop as it drains | Grog = trade voice | todo |
| 3 | FARM | Plant remaining tiles + expand both plots to 16+, seed sweeps, harvest age=7 only + instant replant, bread at table | Zug | DOING |
| 4 | BUILD | Mine House 9x7: log pillars, plank walls, windows, STONE roof + rim, interior stairwell framed, chests C+D | Grog | DOING — pillars up |
| 5 | MINE | Grand staircase (15,89,57) → y54 via /staircase + cobblestone_stairs surface + torches | Thak | DOING |
| 6 | MINE | Branch grid y54: trunk 24, branches 6x8, torched, all veins | Thak | queued after #5 |
| 7 | INFRA | Stepped 2-wide path camp door (11,90,58) → trading post (6-8,112,22) | Bonk | DOING — segment z58-56 built+verified, 85 cobble on hand, PAUSED: camp table casualty needs fix first |
| 8 | WOOD | Chest A wood ≥40 logs standing stock | UngaBunga | DOING — after plank delivery |
| 9 | EQUALITY | Iron armor for all | all | after #1 |
| 10 | FOOD | Ook first far-range meat run (pigs ~100 west) | Ook | todo |
| 11 | LABEL | Signs: mine house face, both farm plots, path ends (console signs via orchestrator — bot sign-place broken) | orchestrator | todo |
| 12 | ECONOMY | Depot audit skill: chest-scan vs ledger reconciliation | code round | idea |

## DONE

| Task | By |
|------|----|
| Trading post built + stocked + 3 signs | UngaBunga + orchestrator |
| Cooked meat banked chest A (3 porkchop, 1 chicken) | Zug |
| Two farm plots tilled + hydrated (god-water x2) | Zug + orchestrator |
| Camp signs: chest A/B, mine, grove | orchestrator |
| Overseer watchdog v3 (idle/stuck/disconnect autopilot) | orchestrator |
| Alliance sealed + gift exchange (playbook ↔ overseer + caveman kit) | Grog + both crews |
