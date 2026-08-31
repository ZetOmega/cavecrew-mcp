# BARITONE.md — heavy-lifter bots: headless real-client + Baritone

Blueprint for adding Baritone-driven REAL Minecraft Java clients alongside the
mineflayer fleet. Mineflayer stays primary; baritone bots are ADDITIONAL
heavy-lifters for long-haul pathing, bulk mining, and big travel. Prototype
bot: **BariBrute**.

Decision date: 2026-09-01. Verdict: **PATH 1 — HeadlessMc + official Baritone
v1.17.0** (real cabaletta release, built FOR 1.21.11, Fabric supported).
Community forks (Nevarielle, chasteboymc-boop) are obsolete — skip. Minosoft
(no baritone hook) and Automatone (server-side mod, violates client-only
spirit) rejected.

---

## 1. Chosen stack — exact versions + URLs

| Component | Version | URL |
|---|---|---|
| HeadlessMc launcher | 2.10.0 | `https://github.com/headlesshq/headlessmc/releases/download/2.10.0/headlessmc-launcher-2.10.0.jar` |
| Baritone (official, standalone fabric) | v1.17.0 | `https://github.com/cabaletta/baritone/releases/download/v1.17.0/baritone-standalone-fabric-1.17.0.jar` |
| hmc-specifics (console→game control wire) | 1.21.11-fabric, mod 2.4.0 | `https://github.com/headlesshq/hmc-specifics/releases/download/1.21.11-latest/hmc-specifics-1.21.11-fabric-latest.jar` |
| Fabric API | match 1.21.11 (~0.141.3+1.21.11) | pull via HMC `mod add fabric:1.21.11 fabric-api` (Modrinth) — safer than hand-URL |
| Java | 21 (already installed) | `C:\Program Files\Java\jdk-21.0.10\bin\java.exe` |

Fallback if hmc-specifics jar clashes with baritone at mod load (rare): drop
hmc-specifics, relaunch with `-commands` flag (built-in headlessmc-runtime,
weaker console — basic chat send still works). That is PATH 2; try only if
PATH 1 breaks.

Known non-issue: server-side plugin "BaritoneRemover" exists in the wild and
kicks baritone users — irrelevant here, our own localhost server, not
installed.

---

## 2. Install layout — `C:\Users\phili\tools\baritone-lifter\`

Per-bot directory = per-bot game dir. Each launcher runs with cwd set to its
bot dir so `.minecraft\logs\latest.log` (the state channel) and
`.minecraft\baritone\settings.txt` are isolated per bot. Disk cost of the
duplicated version files is accepted for isolation.

```
C:\Users\phili\tools\baritone-lifter\
  baritone-runner.mjs                  <- HTTP wrapper (this blueprint, part 4)
  shared\                              <- downloaded jars, copied into each bot
    headlessmc-launcher-2.10.0.jar
    baritone-standalone-fabric-1.17.0.jar
    hmc-specifics-1.21.11-fabric-latest.jar
  bots\BariBrute\                      <- cwd for BariBrute's launcher process
    headlessmc-launcher.jar            (copy from shared)
    .minecraft\
      mods\                            (fabric-api + baritone + hmc-specifics)
      logs\latest.log                  (state channel — wrapper tails this)
      baritone\settings.txt            (safety config, pre-written by wrapper)
  pids\  logs\                         <- wrapper-level, same shape as cave/
```

### Install steps (one-time, PowerShell)

```powershell
New-Item -ItemType Directory -Force C:\Users\phili\tools\baritone-lifter\shared
New-Item -ItemType Directory -Force C:\Users\phili\tools\baritone-lifter\bots\BariBrute
cd C:\Users\phili\tools\baritone-lifter\shared
curl.exe -L -o headlessmc-launcher.jar https://github.com/headlesshq/headlessmc/releases/download/2.10.0/headlessmc-launcher-2.10.0.jar
curl.exe -L -o baritone-standalone-fabric-1.17.0.jar https://github.com/cabaletta/baritone/releases/download/v1.17.0/baritone-standalone-fabric-1.17.0.jar
curl.exe -L -o hmc-specifics-1.21.11-fabric-latest.jar https://github.com/headlesshq/hmc-specifics/releases/download/1.21.11-latest/hmc-specifics-1.21.11-fabric-latest.jar
copy headlessmc-launcher.jar ..\bots\BariBrute\

# interactive first-run inside bot dir (installs fabric + fabric-api):
cd ..\bots\BariBrute
& "C:\Program Files\Java\jdk-21.0.10\bin\java.exe" -jar headlessmc-launcher.jar
```

Inside the HMC console, one line at a time:

```
config --property hmc.offline.username=BariBrute
fabric 1.21.11
mod add fabric:1.21.11 fabric-api
specifics fabric:1.21.11 hmc-specifics
```

If `specifics` doesn't know 1.21.11 yet, hand-copy instead. Baritone always
needs hand-copy (not on Modrinth):

```powershell
copy ..\..\shared\baritone-standalone-fabric-1.17.0.jar .minecraft\mods\
copy ..\..\shared\hmc-specifics-1.21.11-fabric-latest.jar .minecraft\mods\   # only if specifics cmd failed
```

### Launch line (what the wrapper sends after boot, or manual test)

```
launch fabric:1.21.11 -offline -lwjgl --jvm "-Xmx3G -XX:+UseG1GC -Djava.awt.headless=true" --game-args "--quickPlayMultiplayer localhost:25565"
```

- `-offline` + `hmc.offline.username` = no Microsoft OAuth (server is
  offline-mode, matches).
- `-lwjgl` = headless LWJGL patch, no window.
- `--quickPlayMultiplayer` = auto-join, zero GUI clicking.

---

## 3. Control + feedback channels

**Command wire (in):** launcher process stdin. hmc-specifics adds console
words once the game is loaded: `msg <text>` (send chat exactly like a player),
plus `connect`/`disconnect` and `/` for slash commands. A `#`-prefixed chat
line is intercepted CLIENT-SIDE by Baritone (`chatControl` setting, on by
default) before it leaves for the server — baritone commands never appear in
real server chat.

```
msg #goto 100 64 200
msg #mine 64 iron_ore
msg #stop
```

**Feedback wire (out):** NOT the HMC console — the client's own
`.minecraft\logs\latest.log`. Baritone replies go to the local chat HUD only,
and vanilla logs HUD lines with the `[CHAT]` marker. Tail that file, regex:

```
/\[CHAT\].*?\[(Baritone|B)\]\s*(.+)/
```

At boot send `msg #set chatDebug true` for coordinate-bearing path/segment
debug lines (BetterBlockPos-shaped `(x,y,z)` text upstream — FIELD-VERIFY the
exact 1.17.0 string once live). Fallback position poll: `msg #eta` every few
seconds while a task runs, parse the reply line.

Baritone command surface (verified from cabaletta USAGE.md): `#goto x y z`,
`#goal`/`#path`, `#mine <count> <ore>`, `#follow <player>`, `#farm [range]`,
`#tunnel [h] [w] [d]`, `#build <schematic>`, `#explore`, `#stop`/`#cancel`/
`#forcecancel`, `#wp save/goal`, `#come`, `#find`, `#eta`, `#proc`. `#farm`
args beyond `<range> <waypoint>` unverified — field-check.

**No RCON anywhere in this path.** Commands in via client stdin-fed chat,
state out via client's own log file. The only RCON touch remains the
orchestrator's later cosmetic `team join` for the BariBrute name tag —
separate process, never through this wrapper. LAW.

---

## 4. Wrapper design — `baritone-runner.mjs`

Same shape as `cave/runner.js`: one process per bot, HTTP control API on
127.0.0.1, state polled not pushed. Difference: no in-process mineflayer
object — this is a **process-pipe + log-tail driver** around an external JVM.

```
node baritone-runner.mjs --name BariBrute --port 3301 [--host localhost --mcport 25565]
```

**Port registry:** baritone heavy-lifters own **3301-3309** (mineflayer keeps
3200-3299 per CIV.md — add a cross-note there). BariBrute = 3301.

**Boot sequence:**
1. Pre-write `.minecraft\baritone\settings.txt` with the safety block (part 5)
   — config-file level, survives relaunch, no chat-push race.
2. `spawn('C:\\Program Files\\Java\\jdk-21.0.10\\bin\\java.exe', ['-jar','headlessmc-launcher.jar'], { cwd: BOT_DIR, stdio: ['pipe','pipe','pipe'] })`
3. Write the `launch fabric:1.21.11 ...` line (part 2) to stdin.
4. Start log tail (fs.watch + read-from-last-offset on
   `.minecraft\logs\latest.log`); wait for join marker before accepting tasks.
5. Send `msg #set chatDebug true`.

**HTTP surface (mirrors cave/runner.js task-endpoint shape):**

| Endpoint | Body | Action |
|---|---|---|
| `POST /goto` | `{x,y,z}` | no-go gate → `msg #goto x y z` |
| `POST /mine` | `{block,count}` | `msg #mine <count> <block>` (Y-clamped by settings) |
| `POST /tunnel` | `{h,w,d}` | no-go gate on projected end → `msg #tunnel h w d` |
| `POST /farm` | `{range}` | `msg #farm <range>` |
| `POST /follow` | `{player}` | `msg #follow <player>` |
| `POST /stop` | — | `msg #stop` |
| `POST /relog` | — | hmc-specifics `disconnect` + `connect`; full JVM relaunch if that fails |
| `GET /status` | — | `{name, position, task, lastBaritoneLine, connected, uptime}` from parsed log state |

`/status` and `/stop` semantics match what `overseer.mjs` already polls, so
the overseer can adopt BariBrute with one BOTS-array row (part 6).

---

## 5. Safety config

### 5a. Boot settings — written to `.minecraft\baritone\settings.txt`

```
legitMine true                # honest visible-only mining, no X-ray scan
allowDownward false           # never mine block under own feet (fall-safety, matches fleet doctrine)
minYLevelWhileMining -54      # floor: stay above bedrock chaos
maxYLevelWhileMining 95       # ceiling: all ore-hunting stays BELOW both bases (camp y~89 surface, FEL y=111)
blocksToDisallowBreaking [chest,trapped_chest,crafting_table,furnace,blast_furnace,oak_sign,oak_wall_sign,barrel]
shortBaritonePrefix true      # "[B]" — stable short tag for the log regex
chatDebug true                # belt+braces with the boot msg push
```

### 5b. FEL no-go zone (-3, 111, 4) ±15 — WRAPPER-LEVEL, MANDATORY

**Baritone has NO native coordinate keep-out zone.** Verified upstream:
issues #2597 ("Blacklisted zones"), #3847 ("safearea/No break zone"), #1165
("Blacklisting coordinates") — all open, never shipped. `#blacklist` only
skips the single closest matched block; `#sel` is a build-area selector, not
an exclusion. So the wrapper enforces, two layers:

**Layer 1 — command gate.** Every coordinate-bearing task (`/goto`, `/tunnel`
projected end, future `/goal`) is checked before piping. Reject with HTTP 403
if the target lands inside the padded full-height column:

```js
const NOGO = { x: -3, z: 4, r: 15, pad: 5 };   // padded box: x [-23,17], z [-16,24], all y
function inNoGo(x, z) {
  return x >= NOGO.x - NOGO.r - NOGO.pad && x <= NOGO.x + NOGO.r + NOGO.pad
      && z >= NOGO.z - NOGO.r - NOGO.pad && z <= NOGO.z + NOGO.r + NOGO.pad;
}
```

Full-height column (not a y-slab): break-capable pathing under or over the
FEL base is foundation risk, not worth the shortcut.

**Layer 2 — position watchdog.** `#mine`/`#explore`/`#farm` take no coords
and a legal `#goto` can still PATH THROUGH the zone (baritone cannot be told
to route around it). So the log-tail position parser doubles as watchdog:
parsed position inside the padded box → immediately `msg #stop`, then
`msg #goto <camp waypoint>`, mark task `aborted:nogo` in `/status`, log loud.
Watchdog is the backstop; the gate is the front door. Drivers should also
prefer targets whose straight line to the bot doesn't cross the box.

### 5c. Standing laws inherited from the fleet

- NO RCON world commands from wrapper or driver, ever.
- Team tag = orchestrator RCON `team join CAVE BariBrute` later, cosmetic
  only, allowed.
- Stupid-funny naming law: BariBrute, future siblings same spirit
  (BariBonk, LiftLug...).

---

## 6. RAM budget

| Item | Each | Count | Total |
|---|---|---|---|
| MC headless client (`-Xmx3G`, working set 1.5-3GB) | 3.0 GB worst | 2 | 6.0 GB |
| HMC launcher JVM | 0.2 GB | 2 | 0.4 GB |
| baritone-runner.mjs node | 0.05 GB | 2 | 0.1 GB |
| mineflayer runners (existing) | ~0.35 GB | 8 | 2.8 GB |
| overseer + misc node | — | — | 0.3 GB |
| **Total fleet** | | | **~9.6 GB** |

Against 21 GB free: fits with ~11 GB headroom. **Law: max 2 baritone bots**
alongside the 8-bot mineflayer fleet. A third only if measured working sets
come in under 2 GB each after a real mining session.

---

## 7. Integration

- **overseer.mjs:** add `{ name: 'BariBrute', port: 3301, color: 'dark_red', kind: 'baritone' }`
  to BOTS. `/status` + `/stop` + `/relog` already line up. Guard
  mineflayer-only autopilot moves (deposit chores, teleport-to-spawn) behind
  `kind !== 'baritone'` — baritone recovery = `/stop` + `/relog` only.
- **CIV.md:** port-registry note "3301-3309 = baritone heavy-lifters (see
  BARITONE.md)" + roster row BariBrute / 3301 / heavy-lift miner-hauler /
  BariBruteDriver / planned.
- **TODO.md:** this is row #14 (wf_dd72675c). On prototype green: mark DONE,
  add follow-up rows (BariBrute first bulk job; orchestrator team-tag).
- **Drivers:** BariBruteDriver talks HTTP exactly like other drivers, per
  DRIVER_GUIDE.md conventions; task vocabulary is the part-4 table.

## 8. Field-verify checklist (prototype session)

1. hmc-specifics + baritone coexist at mod load (else PATH 2 `-commands`).
2. Exact `[B]`/`[Baritone]` chatDebug line format in latest.log → pin regex.
3. `#farm` argument shape.
4. `msg` vs `.` alias behavior in HMC 2.10.0 console.
5. Real working-set RSS after 30 min of `#mine` (updates part-6 table).
6. Log rotation: does a `/relog` rotate latest.log (tail must reopen).
