# RESUME.md — Post-Reboot-Anleitung (Stand 2026-09-01 ~14:35Z, Spin-down vor Chef-PC-Reboot)

Der nächste CaveLead (oder derselbe nach Resume) startet HIER. Alles unten
ist ground-truth vom Spin-down-Moment, committed auf main.

## 1. Hochfahren (Reihenfolge)

1. Windows: MC-Server starten (start.ps1), dann Panel
   (Start-Process node panel.mjs, stdout→cave/logs/panel-stdout.log,
   WorkingDirectory = Windows-Clone-Root, PanelDev-Rezept).
2. Baritone-Wrapper: `node baritone-runner.mjs --name <Bot> --port 330x`
   für BariBrute/3301, BariThak/3302, BariOok/3303 — Bots loggen an ihrer
   letzten Position ein (BariOok = W-Ridge Site-Wache!). Alle spawnen ggf.
   in der FEL-No-Go-Box → erster Move = goto raus (Watchdog fängt's).
3. Mineflayer: `node cave/spawn.mjs start <Name> <Port>` für UngaBunga/3201,
   Grog/3202, Zug/3203, Bonk/3204.
4. Teammates neu spawnen: 7 Driver + Engineer + PanelDev + Diplomat
   (alle wurden auf Chef-Befehl gekillt). Driver-Briefs: DRIVER_GUIDE.md +
   CIV.md Regel 12 (Funk-Disziplin!) + BARITONE.md für die 3 Bari-Driver.

## 2. Chef-Inputs offen

- **DeepSeek-Key** → `cave/local.json` als `"deepseek":{"apiKey":"sk-..."}`
  → dann `cave/drives.json`: global:true + Durk:true → Durk auf 3207
  booten = Drive-Engine-Pilot (Chefs eigene Spec, DRIVES-SPEC.md).
- Panel-Design: Chef füttert externen Design-Agent mit
  `cave/PANEL_DESIGN_HANDOFF.md`, PanelDev verdrahtet danach.
- `.wslconfig` memory 32GB→12-16GB: der Reboot WAR das Wartungsfenster —
  prüfen ob Chef es gemacht hat (Engineer-Empfehlung, Issue-#11-Kontext).

## 3. Wo wir standen (P1-Fäden)

- **HAUS (Board 20/20b)**: Site FIX = W-Ridge (160,127,225), Schematic
  `cave/schematics/github_v2_house.schem` (sponge-v2, subs spruce→oak,
  deepslate_bricks→cobble). Fehlend: cobble +~320 (65 frisch von Grog in
  chest_e), Smelt-Chain (258 Ops, Holz-Fuel), Haul-Caravan Camp→Ridge
  (~240 Blöcke), volle Palette exportieren (top15/69 bekannt!).
- **EISEN**: BariThak-Mission = Pocket x18-32/y15-40/z30-75 + Cluster-2-
  Korridor, MIT zone-Param + `#pickup` nach jedem Batch (Baritone sammelt
  sonst NICHTS — Tageslektion, ~139 Ore an Despawn verloren).
- **Basis-Ökonomie**: Kohle ~24/64, Brot 8/40 (Tiles age0, wachsen),
  Logs 158 ✓, Planks 71 ✓, Sticks 32 ✓, Torches 92 ✓, Werkzeug-Regal ✓.
- **Claims**: east_village + east_ridge live in monkeorg/tribes-common
  (da5c8f0), FEL-Ping raus (botnet-tasks#6) — auf Antwort achten.

## 4. Tages-Lektionen (nicht wieder lernen müssen)

1. Baritone `#mine` sammelt NIE Drops → immer Batch → `#pickup` → weiter.
2. Baritone-Scanner hat kein Containment → zone-Watchdog (jetzt mit
   RCON-Poll-Feed, 7s) + Fahrer-Ground-truth als zweites Netz.
3. /status-Position lügt bei aktivem Goal (goal-echo gefixt; RCON-Poll auf
   Brute+Ook live, Thak kriegt's beim nächsten Relaunch).
4. Runner leaken CPU über Task-Anzahl (Issue #11) → bei >50% CPU am
   nächsten natürlichen Moment restarten.
5. Overseer-Goals sind gefährlich mächtig: nur noch 3 camp-sichere übrig
   (iron-smelt, torch-craft, pickaxe-rekit) — Scan-lastige Goals braten
   Runner, Deficit-Checks können stale sein.
6. Ledger-DB (world/ledger.sqlite, python3 sqlite3, old_object_id für
   echte Broken-Blocks) = Ground-truth für jede Ertrags-Frage.
7. grove_1-Chop kickte Zug reproduzierbar (Issue #10) — bis Diagnose:
   Chop woanders.
8. Offene Engineer-Fäden: /toss unzuverlässig (Log-Diagnose jetzt möglich,
   wrapper-stdout.log existiert), legitMine-Zeilen-Race (3× gesehen,
   ab 4. Mal eine Stunde investieren), Issue #9-Doku (zone=Watchdog).

## 5. Standing Laws (unverändert gültig)

Total-De-Chat · Funk-Disziplin (CIV Regel 12) · No parked bots ·
Board = OS (TODO.md) · Fair-Play-Pakt v2 · RCON = chat/display +
Own-Bot-Telemetrie (LAW-Kommentar im Wrapper) · Live-Docs oft committen.
