# PANEL DESIGN HANDOFF — Fleet Panel "Cave Look" Total Revamp

For: external design agent (chief runs it). Date: 2026-09-01.
Goal: complete visual + layout revamp of the cavecrew fleet panel. Chief verdict on
current v3: "general look is still bad, i dislike the general layout" — wants a
"claude design esque total revamp, cave design look".

## 1. What this thing is

Live dashboard for a Minecraft bot tribe (8+ bots, survival, no cheating).
Runs as a plain node HTTP server on `:3200`, polls bot APIs every few seconds,
renders one page. Audience: one human (chief) on a desktop browser, watching
the tribe like a mission-control wall.

Stack (keep it):
- `cave/panel.mjs` — HTTP server + routes (serves HTML shell + JSON APIs)
- `cave/panel-data.mjs` — aggregation layer (polls bots, computes distances, icons)
- `cave/panel-client.js` — frontend, vanilla JS, no framework, no build step
- Deploy: Windows clone of the repo, `:3200`. Assets must be self-hosted or
  Google Fonts (browser loads them directly, internet available).

## 2. Live data (real shapes, do not invent fields)

Endpoints on `:3200`:

| Endpoint | Content |
|---|---|
| `/api/fleet` | roster + per-bot live state (sample below) |
| `/api/economy` | resource stocks over time (graphs source) |
| `/api/vault` | chest audit snapshot = "Lager" view (per-chest item counts) |
| `/api/missions` | mission history/log entries |
| `/api/statwall` | tribe totals (deaths, blocks mined, uptime, etc.) |
| `/api/alerts` | danger feed (low HP, deaths, stuck bots) |
| `/api/todo` | live task board (markdown table parsed) |
| `/api/wake`, `/api/stop` | POST actions per bot (buttons exist today) |

`/api/fleet` sample (trimmed, real):

```json
{ "ts": "...", "quota": { "iron_ingot": 360 },
  "summary": { "total": 9, "online": 5, "idle": 2, "iron_ingot": 0 },
  "bots": [ {
    "port": 3201, "name": "UngaBunga", "team": "yellow", "color": "#ffe14d",
    "kind": "mineflayer", "connected": true, "offline": false,
    "pos": { "x": 26.5, "y": 89, "z": 63.0 },
    "distance": { "horiz": 17.5, "vertical": 0, "compass": "SE" },
    "health": 20, "food": 20, "gamemode": "survival",
    "inventory": [ { "name": "stone_axe", "count": 2,
                     "durability": { "used": 0, "max": 131 } } ],
    "heldItem": { "name": "wooden_pickaxe", "count": 1,
                  "durability": { "used": 8, "max": 59 } },
    "currentTask": { "id": "task-152", "kind": "mine", "state": "running",
                     "detail": "mining coal_ore 5/16" },
    "deathCount": 0, "idleGuard": false, "engine": "auto",
    "phase": null, "lastBaritoneLine": null, "baritoneTask": null
  } ] }
```

TWO bot kinds share the roster — design for both:
- `kind: "mineflayer"` — full detail: health/food/inventory/heldItem/currentTask.
- `kind: "baritone"` — headless client: NO inventory/health data; instead
  `phase` ("launching"/"in-world"), `lastBaritoneLine` (console line),
  `baritoneTask` ({kind:"goto"/"tunnel"/"mine", coords}), position only.
  Card must look intentional with the sparser data, not broken.

Roster is DYNAMIC: bots stop/launch mid-day, names change (Thak → BariThak).
Never hardcode names or count. Offline bots show as dimmed cards with
`offlineReason`.

## 3. Features to preserve (chief-approved earlier)

1. Mission-control card per bot: name, engine badge, current task + detail,
   distance from base + compass, health/food bars.
2. Real Minecraft item icons with durability bars (icons served by panel;
   held item prominent, inventory grid in drilldown).
3. Vault/"Lager" view: per-chest contents (chest A/B/C/D/E/F named in BASE.md),
   item icons + counts, staleness timestamp of the audit snapshot.
4. Economy graphs (stock over time, iron quota progress toward 360).
5. Stat wall (big tribe numbers).
6. Drilldown: click card → full bot detail. Overview wall + drilldown both.
7. Wake/Stop buttons per bot (POST endpoints exist).
8. Alerts strip: deaths, low HP, stuck — must be LOUD.

## 4. Design direction (chief's words: "cave design look")

- Dark cave/stone world: deep charcoal/basalt grounds, rough rock texture
  (CSS gradients/noise — no heavy image assets), carved-stone card feel.
- Torchlight: warm amber glow accents, flicker allowed but subtle.
- Minecraft DNA: pixel-font display headers OK ("Press Start 2P" / "VT323"
  via Google Fonts), MC-style segmented bars for health/food/durability,
  item icons pixelated (`image-rendering: pixelated`).
- Per-bot team colors exist (`color` field) — use as card accent, not wallpaper.
- Mood: mission control in a cave. Readable first, themed second.

## 5. Hard constraints

- Vanilla HTML/CSS/JS. No React, no build step, no npm frontend deps.
- One page, polling refresh 2-5s — design must not jump/flicker on re-render.
- Scales 4-12 bot cards; desktop-first, 1440p primary.
- Degrade gracefully: bot offline, vault snapshot missing/stale, empty feeds.
- Deliverable: static HTML/CSS mock (embed the sample JSON above as fixture)
  OR design-canvas artboards. PanelDev wires it to live data afterwards —
  keep DOM structure/data hooks sane (e.g. `data-bot="<name>"`).

## 6. Being fixed in parallel (do NOT design around these bugs)

- Name/roster autodetect bug (new bots missing/wrong names) — PanelDev hotfix.
- Vault shows `missing:true` on prod (snapshot only lands in WSL repo, Windows
  deploy never sees it) — data-flow fix, design should just handle a
  "stale/missing snapshot" state.
