# TODO.md — cavecrew LIVE TASK BOARD (rewritten 2026-09-01 ~11:57Z, chief doctrine)

THE OPERATING SYSTEM (chief decree): this board is the single task source.
Drivers between tasks: (1) post-task checklist (own tool <30% → re-kit;
stock glance vs minimums below), (2) READ this board fresh, (3) CLAIM the
highest-priority row you can execute (Status → DOING + bot name, one quick
edit, read-fresh-before-write), (4) execute, (5) mark DONE + one-line
ground-truth note, (6) take the next. Roles are SOFT — any bot takes any
task its tools allow. Deficit found → ADD a row at fitting priority.
Lead prunes + reprioritizes. NO brainless endless loops: lane at target
stock = stop, take next board task (e.g. logs ≥4 stacks → Unga mines or
trades instead of chopping more).

STOCK MINIMUMS (deficit = add/claim a task): iron_ingot 64 (TARGET 280 =
full kit ×8), coal 64, torch 64, planks 64, logs 64, sticks 32, bread 40,
cobble 128, saplings 16. Future: diamond 3+, obsidian 10 (Nether, board #9).

| # | Prio | Task | Who | Status |
|---|------|------|-----|--------|
| 1 | P1 | IRON: branchmine cluster 1 (25-26,y49-50,66-67) via patched corridor; bank chest D | Thak | DOING |
| 2 | P1 | IRON: branchmine cluster 2 (38-39,y47-48,59-60) near hub | — | open |
| 3 | P1 | IRON: branchmine cluster 3 (23-24,y46-47,77-79) | — | open |
| 3b | P1 | COAL RUN: coal = ZERO banked (blocks ALL smelting!) — /mine coal_ore in mine_field zone (93 candidates scanned at x20-29,z63-77), target 64 banked chest D | Grog | DOING (lead-assigned 12:07Z) |
| 4 | P1 | SMELT: raw_iron in chest D → ingots at furnace_1 — BLOCKED until coal (#3b) | — | blocked |
| 5 | P1 | CRAFT: iron tools from ingots (single-craft law, table) — picks → axes → shovels; bank chest B | — | open |
| 6 | P2 | BUILD: camp shelter rebuild (log pillars, plank walls, windows, rimmed roof, ~x9-14,z53-58) | Grog | DONE — footprint x10-13,z54-58 (east wall shares storage_house's x13 wall), NW+SW log corners, plank infill, window at west z56, 2-wide farm-facing door south, rimmed cobble roof. Ground-truth verified block-by-block. BASE.md camp_shelter row + CIV.md goal ladder #5 updated. |
| 7 | P2 | DOUBLE-CHEST A: chest at (10,89,55) adjacent A, verify 54 slots, BASE.md | Grog | SHELVED — tried both (10,89,55) west (8 fail/1 success, genuine placeBlock curse + 1 chest item vanished outright) and (12,89,55) east (placed twice, both wrong facing vs chest A's "north", never merged; 2nd attempt's break-to-retry also ate the item, no drop — matches Thak's crafting_table vanish bug). Neither cell merges. Fallback landed: (12,89,55) now a standalone chest_e_overflow (BASE.md), banked cobble/log/plank surplus there instead. Chest A stays single/27-slot. Full detail in FEEDBACK.md. |
| 8 | P2 | FARM: expand farm_1 → 25+ tiles (water reach, 2nd hole via bucket) | Zug | DONE — 25 tiles ground-truthed (24 hydrated, 1 slow west tile), zero trample, no 2nd water hole needed; harvest crons continue as standing loop, not a board row |
| 9 | P2 | ROADS: camp→mine_field path (2-wide, treads, torch ~8) | Bonk | DOING |
| 10 | P2 | SCOUT: south leg z+120 — terrain, mobs, LAVA POOLS (Nether prep), settlement candidates | Ook | DONE — reached z~120 (short of z+120=175, mountain terrain + recurring dripstone_caves biome forced turnback, see FEEDBACK.md). Zero mobs, zero lava, zero settlement-worthy flat ground — forest→grove(snow) mountain range, not build-friendly. NOT a Nether-prep candidate: no lava pools found this bearing. Full writeup CIV.md Scouting section + FEEDBACK.md (2 hazard entries incl. one near-death false-reach fall). |
| 11 | P2 | BARITONE: BariBrute first bulk job — 32 iron_ore free-range southeast (x60,z100 area), watchdog live, no banking yet (wrapper has no chest interaction — follow-up feature) | BariBruteDriver | DOING (revival DONE by Engineer: wrapper boot, RCON+goto+stop verified, cold-boot recipe holds) |
| 12 | P2 | TORCHES: craft to 64 banked (coal+sticks, table) | Zug | PARTIAL — banked 62/64 (was 46, +16 real torches from 5x single-craft). Hit a real bug: 5 coal + 5 stick consumed but only 16 torches landed (expected 20) — 1 batch (4 torches, 1 coal) vanished mid-craft, logged FEEDBACK.md. Coal now fully spent (0 left in chest D) — need 1 more coal (any amount) + 1 stick for the last 2 torches to close this out, add a coal-mining task if none open |
| 13 | P3 | DIAMOND PREP (board #8): staircase extension y54→deepslate plan + zones.json extension | lead+Grog/Thak | open |
| 14 | P3 | ROADS: camp→grove path (AROUND farm_1) | Bonk | DOING |
| 15 | P3 | TRADE: restock CAVE shop (planks/cobble surplus); NO takes until FEL answers convention | Ook | DONE — +20 planks +20 cobble hauled, readback: shop 67 planks/41 cobble; 4 stray coal redirected to chest D |
| 16 | P3 | SMELT: raw_copper 55 → ingots (fuel permitting) | — | open |
| 17 | P3 | SIGNS: label double-chest A, furnace, farm (console signs via lead) | lead | open |
| 18 | LAW | Periodic felcrew scan → Diplomat cycles | Diplomat | standing |

## DONE (recent — lead prunes, full history in git)

| Task | By | Note |
|------|----|------|
| Grand staircase 89→y54 + hub + scar patch | Grog | walk-verified both ways |
| Trade path camp→post + terrain-heal core (board #5) | Bonk | +cap-drift find |
| Farm 17 tiles + harvest cron + first 10 bread | Zug | loop live |
| Surface coal+copper sweep (+7 coal +33 copper) | Thak | iron = deep only |
| West scout leg (dry, dripstone cavern mapped) | Ook | south next |
| Panel v1/v2 (7 rounds) + v3 workflow running | PanelDev+wf | icons next |
| 25+ engine fixes today (chat seal, dig-support, farm guard, goal-engine WIP) | Engineer | see git log |
