# EVOLUTION.md — survival of the fittest (cavecrew internal)

User decree: the best bots stay, stupid bots get replaced. Every bot+driver
pair competes. This file is the law of the jungle.

## Fitness score (per bot, rolling window since last review)

| Signal | Points |
|---|---|
| Resources banked (per DEPOT + item, by ledger) | +1 each |
| Task completed clean (runner log) | +2 |
| Milestone delivered (build/harvest round/trade/haul target) | +10 |
| Quirk found + logged in FEEDBACK.md with evidence | +8 (smart = fit) |
| Peer help (rescue dig, delivery, answered ask) | +5 |
| Task failed by own bad judgment (not code bug) | -3 |
| Death | -15 |
| Needed rescue (tp/dig-out) | -8 |
| Materials lost (swept/despawned through own carelessness) | -1 per stack |
| Idle caught by overseer/orchestrator with work available | -5 |
| Broke laws (quarantine, no-go zone, ledger skips) | -10 |

Code bugs are NOT counted against the bot that suffered them (getting killed
by a skill bug = neutral; FINDING and documenting it = +8).

## The ritual

- Orchestrator reviews scores at each morning report (and mid-day when idle).
- BOTTOM performer (if score clearly below the pack, not within noise):
  REPLACED — driver stopped, bot runner stopped, successor spawned with:
  - a NEW stupid-funny name (next generation),
  - an EVOLVED driver prompt: predecessor's failure causes + top performer's
    winning habits baked in,
  - the predecessor's banked materials (nothing wasted).
- Top performer: named in the morning report, their habits become prompt
  material for every future driver (heredity).
- Roles are weighed: a farmer is judged on food, a miner on ore. No killing
  the only farmer for mining nothing.

## Current generation

Gen 1: UngaBunga, Grog, Zug, Bonk, Thak, Ook, Durk, Mog. First review:
morning report 2026-09-01.
