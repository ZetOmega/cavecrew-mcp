# TESTLAB.md — test-bot lane (engineer: Krug)

Production bots (Grog, UngaBunga, Zug, Bonk, Thak, Ook, Durk, Mog, ports
3201-3208) must NEVER risk death or inventory loss in a test. Everything
experimental runs on the dedicated test bot instead.

## Test bot

- **Name:** `TestRock` — **port:** `3209` (HTTP API `http://127.0.0.1:3209`)
- Start (from repo root `C:\Users\phili\tools\cavecrew-mcp`):

  ```powershell
  node cave/runner.js --name TestRock --port 3209
  ```

- Same API as every runner — see `DRIVER_GUIDE.md`. Logs land in
  `cave/logs/TestRock.log`, pid file in `cave/pids/TestRock.json`.
- Stop: read the pid from `cave/pids/TestRock.json`, then `taskkill /F /PID <pid>`.
- Team tag: `cave_TestRock` team add/join goes through RCON, which is
  team-lead's job — ask, don't run RCON yourself.

## Test yard

- **Yard center: (12, ~90, 320)** — straight south of camp on the z axis.
  Distance ~264 blocks from camp (12,89,56) and ~316 from FEL base
  (-3,111,4). Rule: any yard must stay **200+ blocks** from both.
- ALL destructive tests (staircase digs, branch mines, /mine sweeps,
  deliberate deaths, placeBlock experiments) happen at the yard ONLY.
- TestRock spawns at world spawn (near camp). **Dispatch it to the yard
  immediately after boot** — its idle-guard fires after 90s of idle and
  will otherwise sweep drops around camp and can deposit into chest A
  (the deposit branch is distance-gated at 40 blocks, so at the yard it
  can never touch camp chests).
- TestRock never deposits to or withdraws from camp/trading-post chests,
  never touches camp fixtures, never trades. It is not part of the
  economy; its inventory is disposable.
  - ONE chief-ruled exception (2026-09-01, legal-bench redesign): the
    bench (`cave/bench.mjs`) may borrow a SMALL lean test kit from
    chest A (11,89,55) — a few cobble, wood, one pickaxe, some food —
    and must bank leftovers back at the end. Both halves of the loan are
    DEPOT-ledgered in chat so it stays auditable. This exception covers
    the bench flow only, not ad-hoc test driving.

## Procedure per test round

1. Confirm which code TestRock is running (main tree = production code;
   a worktree copy = candidate patch — see smoke-boot below).
2. `POST /goto` to the yard, verify arrival via `/status` pos.
3. Run the skill under test; poll `/status` per DRIVER_GUIDE (15-30s).
4. Ground-truth results via `/eval` (real position/inventory/blocks),
   never trust task result text alone.
5. Log findings in `FEEDBACK.md` (quirks) and report verdicts to
   team-lead. A deliberate test death is fine at the yard — note it so
   the death ledger / scoreboard readers can discount it.

## Smoke-boot check (cheap pre-blink gate for runner.js edits)

Verified pattern for testing a patched `runner.js` WITHOUT touching the
real server or blinking production runners:

1. Put the candidate code in a git worktree; junction `node_modules`
   into it (`cmd /c mklink /J node_modules <repo>\node_modules` — ESM
   imports ignore NODE_PATH, the junction is required).
2. Boot it against a DEAD Minecraft port so it cannot join the world:

   ```powershell
   node cave/runner.js --name SmokeTest --port 3210 --mcport 25599
   ```

3. HTTP API binds immediately even while the MC connection retries —
   `curl.exe -s http://127.0.0.1:3210/status` exercises boot, state
   load, and the endpoint surface. Kill via the pid file when done.
4. MANDATORY (lesson from the 2026-09-01 chat-mirror fleet outage): a
   smoke-boot only counts as green if the log is ALSO clean —
   `grep -iE "error|failed synchronously" cave/logs/SmokeTest.log`
   must return nothing. The API answering `/status` proves almost
   nothing: `connect()` catches synchronous wireBot crashes and quietly
   schedules a reconnect, so a runner whose bot layer is fatally broken
   still looks alive over HTTP. Grep case-INSENSITIVE — logLine writes
   uppercase `ERROR`, and a case-sensitive grep for `error` is exactly
   how the mirror-wrap crash slipped through the first time.

Port map: 3201-3208 production, **3209 TestRock**, **3210 smoke-boot**
(never connects to the real server).

## Standing gates (from team-lead law)

- **Blink law:** restarting any runner needs team-lead green light —
  never blink while an edit/workflow is mid-flight on the same files.
- **Bench gate:** run `node cave/bench.mjs` before any blink.
- No RCON world manipulation, no item spawning, no cheats — test setups
  are built by bot hands or not at all.
