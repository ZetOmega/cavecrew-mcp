# TODO.md — cavecrew shared task board

Drivers: between missions CLAIM (set Status=DOING + your bot name), set DONE
when ground-truth verified, ADD new rows at fitting priority. One quick edit
at a time — read fresh before writing. Orchestrator prunes DONE.
Rebuild-phase note (2026-09-01): roadmap + relaunch contract live in
REBUILD.md — rows here are the standing work ledger under that contract.

| # | Lane | Task | Who | Status |
|---|------|------|-----|--------|
| 0 | RESCUE | Pocket evac: walk all trapped bots up ramp → sethome ritual ALL EIGHT at camp surface → terrain-heal issue #5 fills pocket after mine spoil exists | orchestrator + pair drivers | DOING — fleet relaunched, walk-out test running |
| 1 | EQUALITY | Iron pickaxes every bot — strip mine feeds chest A (11,89,55), each driver eval-crafts own AT TABLE | Thak feeds, all craft | todo |
| 2 | ECONOMY | Watch FEL shop (8,112,22) for first trade; restock CAVE shop as it drains | Grog = trade voice | todo |
| 3 | FARM | Harvest loop: 17 tiles, replant same-visit, bake bread, bank chest A. Goal: 5+ bread carried per bot | Zug | DOING |
| 4 | BUILD | Plaza cobble floor x8-15/z52-57 y88 (zone-1 undo strays + fill, zone-2 fill, skip fixture columns, per-placement verify) + 4 corner lamp-posts. Fill chest-A hole (9,88-89,55) while there | Grog | DOING — interrupted by rescue |
| 5 | MINE | Grand staircase (15,89,57) → y54 via /staircase east + torches | Thak | todo — launch AFTER evac+sethome |
| 6 | MINE | Branch grid y54: trunk 24, branches 6x8, torched, all veins | Thak | queued after #5 |
| 7 | INFRA | Stepped 2-wide path camp door (11,90,58) → trading post (6-8,112,22): z29→22 cobble tread missing, needs cobble resupply from mine spoil | Bonk | DOING — blocked on cobble |
| 8 | WOOD | Chest A wood ≥40 logs standing stock + replant every chop | UngaBunga/Durk/Mog | todo |
| 9 | EQUALITY | Iron armor for all | all | after #1 |
| 10 | FOOD | Ook first far-range meat run (pigs ~100 west) | Ook | todo |
| 11 | LABEL | Signs: farm plots, path ends (console signs via orchestrator — bot sign-place broken; Mine House sign DONE) | orchestrator | todo |
| 12 | ECONOMY | depot-ledger.jsonl: runner writes deposit/withdraw events to file, replaces chat-scrape scoreboard accounting (paused since DEPOT de-chat) | Krug | queued — next code round |
| 14 | BARITONE | 1-2 headless baritone gatherers w/ HTTP wrapper (BariBrute recipe in BARITONE.md), cap 2, measure CPU/RAM. Gates met: zones law live, bench law live | Krug | queued after #12 |
| 16 | METRICS | Evolution scoreboard sidebar CAVE vs FEL — repoint depot metric at jsonl ledger once #12 lands | Krug | blocked on #12 |
| 17 | STANDING | Periodic felcrew repo scan (new commits → adopt-worthy findings) — every few hours | orchestrator ticks | law |
| 18 | STANDING | Fleet policy: ground crew ~6; bots beyond 6 idle w/o sensible task = stop their runners | orchestrator ticks | law |
| 19 | QUOTA | Iron: full armor+tools ×8 + 2 backup sets + 128 ingots banked (~41 done) | Thak commands | DOING |
| 20 | PANEL | Panel phase 2: design pass (icons/looks — chief order), driver states, TODO board, Discord feed | Krug | queued |
| 21 | HYGIENE | ISSUES.md rollup (felcrew-style): open issues both repos + one-line state each | orchestrator | todo |
| 22 | AUDIT | Felcrew adoption tickets: species-sum stock bug grep, listener-staleness on /relog, depot-walk-before-craft ordering, hermetic bench fixtures | Krug | queued |

## DONE (pruned 2026-09-01, rebuild phase — full history in git)

| Task | By |
|------|----|
| Mine House complete: walls, pillars, roof 63/63, rim 36, lamp-posts, sealed floor, chests C+D, console sign (18,90,60) | Grog + Bonk + orchestrator |
| Blink #2: chat-quiet routing, dig-law zones, pocket rescue, task-source, 6 quirk fixes | Krug + orchestrator |
| Panel v1.1: dark dashboard :3200, movement deltas 30s/60s, self-poll | Krug |
| ghwatch daemon: GitHub 2-repo watchdog (RETIRED 2026-09-01, chief order — orchestrator ticks scan repos instead) | GhWatch |
| cavehome datapack: /trigger sethome + home, tested green | HomeSmith |
| Overseer v4: idle-defaults safe set, 120s, tp retired → /trigger home ladder | orchestrator |
| Discord 3-webhook wiring: status feed, chat mirror, CaveLead | Krug + orchestrator |
| Evolution scoring round 1 (Grog +30 … UngaBunga +8) | orchestrator |
| Trading post + first FEL trade (6 seeds + 36 logs → 4 bread) | UngaBunga + Grog |
| Honeycomb hazard sealed 7/7, verified per-block | Bonk |
| Alliance issues: #2 #4 closed, pact v2 proposed, felcrew#1 items answered | orchestrator |
