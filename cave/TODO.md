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
| 1 | P1 | IRON: branchmine cluster 1 (25-26,y49-50,66-67) via patched corridor; bank chest D | Thak | DONE — branchmine's y-param doesn't descend + branches went wrong direction (0 iron, logged FEEDBACK); real fix was staircase{toY:49} landing IN the cluster then /mine{maxDistance:10} to keep cluster 2 from out-competing on distance. 5/5 ore mined, +5 raw_iron banked chest D, readback-verified. First real deep iron of the tribe. |
| 2 | P1 | IRON: cluster 2 (38-39,y47-48,59-60) — TUNNEL BORED durch das Band (BariBrute x40→28,y49-50,z60, 13:01Z), ore EXPOSED + untouched. Next: harvest via Korridor (mineflayer mit iron pick, oder Baritone #mine nach legitMine-Relaunch). Breach zur alten Scar-Höhle UNCONFIRMED — vorsichtig rein | — | ready-to-harvest |
| 3 | P1 | IRON: branchmine cluster 3 (23-24,y46-47,77-79) | Thak | DONE — cluster sat behind genuinely undug solid rock (no path existed, not a pathing bug); hand-dug a 2-tall corridor via /eval after staircase+mine both false-reach-looped against the wall. Hit a real drowning incident mid-dig (water pocket, panic reflex caught it clean, HP 20 recovered) — redug one y-level lower, dry. 8 raw_iron banked chest D (running total 13), pick durability spent to 34% (re-kit due). Full writeup FEEDBACK.md. |
| 3b | P1 | COAL RUN: target 64 banked chest D. Grog: +4 banked 13:0xZ, hand-dig y87-Vein (7 ore, 20-22,87,65-67) — Zone hat false-reach-Familie, /collect unzuverlässig. UngaBunga: /mine läuft ~x26,z72. RELIEF: BariBrute nach legitMine-Relaunch → #mine coal_ore Volumen | Grog + UngaBunga + BariBrute | DOING |
| 4 | P1 | SMELT: raw_iron in chest D → ingots at furnace_1 — BLOCKED until coal (#3b) | — | blocked |
| 5 | P1 | CRAFT: iron tools from ingots (single-craft law, table) — picks → axes → shovels; bank chest B | — | open |
| 6 | P2 | BUILD: camp shelter rebuild (log pillars, plank walls, windows, rimmed roof, ~x9-14,z53-58) | Grog | DONE — footprint x10-13,z54-58 (east wall shares storage_house's x13 wall), NW+SW log corners, plank infill, window at west z56, 2-wide farm-facing door south, rimmed cobble roof. Ground-truth verified block-by-block. BASE.md camp_shelter row + CIV.md goal ladder #5 updated. |
| 7 | P2 | DOUBLE-CHEST A: chest at (10,89,55) adjacent A, verify 54 slots, BASE.md | Grog | SHELVED — tried both (10,89,55) west (8 fail/1 success, genuine placeBlock curse + 1 chest item vanished outright) and (12,89,55) east (placed twice, both wrong facing vs chest A's "north", never merged; 2nd attempt's break-to-retry also ate the item, no drop — matches Thak's crafting_table vanish bug). Neither cell merges. Fallback landed: (12,89,55) now a standalone chest_e_overflow (BASE.md), banked cobble/log/plank surplus there instead. Chest A stays single/27-slot. Full detail in FEEDBACK.md. |
| 8 | P2 | FARM: expand farm_1 → 25+ tiles (water reach, 2nd hole via bucket) | Zug | DONE — 25 tiles ground-truthed (24 hydrated, 1 slow west tile), zero trample, no 2nd water hole needed; harvest crons continue as standing loop, not a board row |
| 9 | P2 | ROADS: camp→mine_field path (2-wide, treads, torch ~8) | Bonk | DONE — full 2-wide z58-65, walk-verified, tree-gap + off-lane pit hazard (23,86,61) both closed same pass. BASE.md path_camp_minefield. |
| 10 | P2 | SCOUT: south leg z+120 — terrain, mobs, LAVA POOLS (Nether prep), settlement candidates | Ook | DONE — reached z~120 (short of z+120=175, mountain terrain + recurring dripstone_caves biome forced turnback, see FEEDBACK.md). Zero mobs, zero lava, zero settlement-worthy flat ground — forest→grove(snow) mountain range, not build-friendly. NOT a Nether-prep candidate: no lava pools found this bearing. Full writeup CIV.md Scouting section + FEEDBACK.md (2 hazard entries incl. one near-death false-reach fall). |
| 11 | P2 | BARITONE: TUNNEL JOB 1 DONE (13:01Z) — Korridor x40→28,y49-50,z60 durch Cluster-2, ore exposed, zero incident, BariBrute home+stopped. legitMine=false persistent committed (live nach Relaunch). FLEET CONVERSION KOMPLETT: BariBrute 3301 + BariThak 3302 + BariOok 3303 alle in-world, Teams joined, RAM idle ~7.05GB/Budget ok | BariBruteDriver | DONE |
| 12 | P2 | TORCHES: craft to 64 banked (coal+sticks, table) | Ook | STILL PARTIAL — crafted +4 (1 coal + 1 stick, single-craft, table_1, clean 8→12→banked 4) and deposited to chest B, but ground-truth readback right AFTER banking shows chest B torch = 40, not the 66 expected (62+4) — camp consumption (lamp-posts, lighting, other bots' kit withdraws) is drawing the stock down faster than it's being banked. Gap is now 24, not 2 — needs another coal-mining pass, not just 1 more batch. Chest D coal is 0 again after my withdraw. | 
| 13 | P3 | DIAMOND PREP (board #8): staircase extension y54→deepslate plan + zones.json extension | lead+Grog/Thak | open |
| 14 | P3 | ROADS: camp→grove path (AROUND farm_1) | Bonk | DONE — full 12/12 cells x4-5, walk-verified, torch side-mounted. BASE.md path_camp_grove. |
| 15 | P3 | TRADE: restock CAVE shop (planks/cobble surplus); NO takes until FEL answers convention | Ook | DONE — +20 planks +20 cobble hauled, readback: shop 67 planks/41 cobble; 4 stray coal redirected to chest D |
| 16 | P3 | SMELT: raw_copper 55 → ingots (fuel permitting) | — | open |
| 17 | P3 | SIGNS: label double-chest A, furnace, farm (console signs via lead) | lead | open |
| 18 | LAW | Periodic felcrew scan → Diplomat cycles | Diplomat | standing |
| 19 | P1 | BASE 2.0 (CHIEF LONG-TERM IDEA 2026-09-01): Umzug nach ~(252,94,131) Ost-Plains, evtl. DORF daneben — Recon läuft: BariOok Vorhut (goto + path-viability), Bonk Detail-Survey (Dorf-Census: Betten/Villagers/Berufe/Glocke/Golem + Hügel für Haus #20). Plains-Fakten von Ook-Scout: flach x100-257+, tierreich, Lava-Pool ~(96-101,y83,z18-23) unterirdisch für Nether. Alt-Camp bleibt Mining-Outpost | BariOok+Bonk | RECON |
| 20 | P1 | HOUSE+FARM (CHIEF ORDER): SCHEMATIC GEWÄHLT = `cave/schematics/github_v2_house.schem` (Spruce/Oak/Cobble-Cottage 14×18×21, sponge-v2 = Baritone-ready). Subs: spruce→oak, deepslate_bricks→cobblestone (Judge-Verdict, Details Workflow-Log). Site: Base-2.0-Zone bevorzugt (#19). Blocker: Engineer /build endpoint + Site-Wahl. Warnung: Palette top15/69 — vor Build volle Palette exportieren + Blanket-Sub-Regel | lead | schematic ✓ |
| 20b | P1 | HOUSE MATERIALS (v2_house nach Subs): oak_log +123 (250 tot, 127 da) + ~172 logs FUEL für Smelt, cobble +384 (464 tot, 80 da), smelt-chain: 258 cobble→stone→stone_bricks + craft 110 stone_brick_stairs, oak_planks 185 (67 da) + 25 slabs. Bucket+2 Öfen = da. Chop-Kampagne + Cobble-Mining = Dauerprogramm für freie Hände; Smelt parallel starten, nicht seriell. Haul-Plan nach Site-Fix | all | open |
| 21 | P1 | SITE SCOUT für #20 (UPDATED: Zone verschoben zu Base-2.0-Gebiet): Hügel-Kandidaten um (252,94,131) ±100 mit Blick über Dorf/Plains, 2-3 Summits top ~20x20, Wasser nah. Dorf-Verifikation zuerst (siehe #19). Alt-Zone x60-120 nur en passant | Bonk | DOING (update 13:2xZ) |
| 22 | P2 | FARM 2 am Haus-Site (#20): 25+ tiles, Wasser, Zaun, Torch-Ring — mineflayer crew (Zug hat farm_1 Erfahrung). BLOCKED bis Site gewählt | Zug | blocked (site) |
| 23 | P2 | CAMP DE-CLUTTER: Möbel-Ecke chest A/E/crafting_table = Wedge-Falle (3 Vorfälle heute: Bonk, Zug 2x — zero walking clearance). Crafting table versetzen oder 1-Block-Clearance um jede Kiste schaffen, danach pf-Walk-Test alle Kisten | — | open |
| 24 | P1 | BREAD DEFICIT: 8 banked, Minimum 40. Wheat ernten (reife farm_1 tiles) + craften (3 wheat = 3 bread am Table), Ziel 40+ in chest C. Seeds 130 = genug | Zug | DOING (assigned 13:1xZ) |

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
