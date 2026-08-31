# cave/

Standalone bot-fleet layer bolted onto this repo's mineflayer bot. Plain
ESM JavaScript, no TypeScript, no build step. Does not touch `src/` or
`dist/` — this repo's original MCP server keeps working untouched.

## Three-layer architecture

1. **Deterministic runner** (`runner.js` + `skills.js`) — one Node
   process per bot, connects to the Minecraft server via mineflayer, and
   exposes a small HTTP API on `127.0.0.1:<port>`. All the actually
   reliable behavior (chop a tree, mine a block, path to a point, deposit
   to a chest) lives here as plain algorithms, with known field quirks
   (re-equip tools per swing, snipe-proof drop collection, safe descents,
   etc.) encoded directly in the code rather than left to chance.
2. **LLM drivers** — one driver agent per bot, talking to that bot's HTTP
   API. Drivers decide *what* to do and narrate it in-game; the runner
   handles *how*. See `DRIVER_GUIDE.md` for the full API reference and
   conventions a driver must follow.
3. **Orchestrator** — coordinates drivers across the fleet, tracks tribe
   state in `CIV.md`, and is the one who updates `skills.js` when a
   driver reports a quirk that keeps tripping up the deterministic layer.

## Commands

Run from the repo root (`cavecrew-mcp/`):

```powershell
# start a bot — refuses if it's already running or the port is taken
node cave/spawn.mjs start UngaBunga 3201

# stop a bot — best-effort /stop, then kills the process tree
node cave/spawn.mjs stop UngaBunga

# list every bot with a pid file, and whether it's actually alive
node cave/spawn.mjs list
```

`spawn.mjs` never talks to Minecraft itself — it only manages the
`runner.js` OS processes (pid files in `cave/pids/`, logs in
`cave/logs/`, both gitignored). Once a bot is up, drive it over HTTP per
`DRIVER_GUIDE.md`.

## File map

| File               | What it is                                                |
|--------------------|------------------------------------------------------------|
| `runner.js`        | Per-bot process: mineflayer connection + HTTP task API.     |
| `skills.js`        | Deterministic algorithms the runner's endpoints call into.  |
| `spawn.mjs`        | CLI to start/stop/list bot processes.                       |
| `DRIVER_GUIDE.md`  | API reference and conventions for LLM driver agents.        |
| `CIV.md`           | Tribe state: naming scheme, port registry, roster, goals.   |
| `logs/`            | Per-bot log files (gitignored).                              |
| `pids/`            | Per-bot pid-file records used by `spawn.mjs` (gitignored).  |
