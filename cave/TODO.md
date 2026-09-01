# TODO.md — cavecrew shared task board

Drivers: between missions CLAIM (set Status=DOING + your bot name), set DONE
when ground-truth verified, ADD new rows at fitting priority. One quick edit
at a time — read fresh before writing. Orchestrator prunes DONE.

| # | Lane | Task | Who | Status |
|---|------|------|-----|--------|
| 1 | EQUALITY | Iron pickaxes every bot — strip mine feeds chest A, each driver eval-crafts own AT TABLE (never pocket grid, no /craft till patch) | Thak feeds, all craft | todo |
| 2 | ECONOMY | Watch FEL shop (8,112,22) for first trade; restock CAVE shop as it drains | Grog = trade voice | todo |
| 3 | FARM | Both plots full + expanded (17 tiles). First full harvest round done: 15 wheat pulled (8 west + 7 camp-door, all age=7 confirmed via block property not name), instant-replanted all 17, 4 bread baked at table, banked chest A (4 bread + 8 wheat + 21 seeds, DEPOT logged). Method confirmed: /goto within ~2 blocks, check age via getProperties().age, dig only if dist<4.5 (reach law), collect, replant same-visit. Ongoing: repeat harvest loop as tiles ripen, watch for early-planted tiles drying before water lands (found+fixed 2 dead ones at west plot this session) | Zug | DOING — harvest loop live |
| 4 | BUILD | Mine House 9x7: log pillars, plank walls, windows, STONE roof + rim, interior stairwell framed, chests C+D | Grog | DOING — flat roof DONE 63/63 (Bonk delivered 40+23+8), interior floor sealed incl. 2 hidden deep-void hazards patched+verified. Blocked: 36-log rim needs raw oak_log delivery (UngaBunga/Durk/Mog convergence never landed), lamp-posts+sign after that |
| 5 | MINE | Grand staircase (15,89,57) → y54 via /staircase + cobblestone_stairs surface + torches | Thak | DOING |
| 6 | MINE | Branch grid y54: trunk 24, branches 6x8, torched, all veins | Thak | queued after #5 |
| 7 | INFRA | Stepped 2-wide path camp door (11,90,58) → trading post (6-8,112,22) | Bonk | DOING — route confirmed walkable end-to-end (Bonk reached the post live). Surfaced+verified z58 down to ~z30; z29->22 still needs proper cobble tread, currently natural-terrain-only. Chest A+B both out of cobble, need resupply before finishing surface. |
| 8 | WOOD | Chest A wood ≥40 logs standing stock | UngaBunga | DOING — after plank delivery |
| 9 | EQUALITY | Iron armor for all | all | after #1 |
| 10 | FOOD | Ook first far-range meat run (pigs ~100 west) | Ook | todo |
| 11 | LABEL | Signs: mine house face, both farm plots, path ends (console signs via orchestrator — bot sign-place broken) | orchestrator | todo |
| 12 | ECONOMY | Depot audit skill: chest-scan vs ledger reconciliation | code round | idea |
| 13 | NIGHT | Safety-fix round: reach law, depth/locality/no-go, tree-check, staircase watchdog, recover fix → UNBAN skills | workflow wf_ca98d234 | DOING |
| 14 | BARITONE | Baritone gatherer agents (user 2026-09-01): research existing full solutions first (automatone, HMC scripting, bridges, felcrew), then 1-2 headless baritone gatherers w/ HTTP wrapper, mixed fleet, cap ~2 (PC load), measure CPU/RAM. Prototype proven: BariBrute recipe in BARITONE.md | Krug | DOING — research phase |
| 15 | NIGHT | Discord status routing: discord.mjs + webhook config (user supplies channel URL) — status→Discord, game chat = real talk only | in safety round | DOING |
| 16 | NIGHT | SCOREBOARD: tribe evolution metrics (iron banked, deaths, builds, trades, harvests) CAVE vs FEL — scoreboard.mjs + SCOREBOARD.md + in-game sidebar | builder | DOING |
| 17 | STANDING | Periodic felcrew repo scan (new commits → adopt-worthy findings) — every few hours | orchestrator ticks | law |
| 18 | STANDING | Fleet policy: ground crew ~6; bots beyond 6 idle w/o sensible task = stop their runners (restart when work exists) | orchestrator ticks | law |
| 19 | NIGHT | Iron quota: full armor+tools ×8 + 2 backup sets + 128 ingots banked by morning (20 raw in chest, smelting) | Thak commands post-unban | DOING |
| 20 | PANEL | Fleet web dashboard cave/panel.mjs @ localhost:3200 — bot cards (pos/health/task/inventory), wake+stop buttons, alerts feed. Phase 2: driver states, TODO board, scoreboard, Discord feed | Krug | DOING |

## DONE

| Task | By |
|------|----|
| Trading post built + stocked + 3 signs | UngaBunga + orchestrator |
| Cooked meat banked chest A (3 porkchop, 1 chicken) | Zug |
| Two farm plots tilled + hydrated (god-water x2) | Zug + orchestrator |
| Camp signs: chest A/B, mine, grove | orchestrator |
| Overseer watchdog v3 (idle/stuck/disconnect autopilot) | orchestrator |
| Alliance sealed + gift exchange (playbook ↔ overseer + caveman kit) | Grog + both crews |
