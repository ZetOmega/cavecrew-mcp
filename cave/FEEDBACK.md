# FEEDBACK.md — append-only quirk/bug/idea log (FEL-style learning loop)

Every driver logs each quirk/bug/idea THE MOMENT it is found. Engine work
cycles consume open entries. Format:

```
## [open|shipped] short-title — BotName, YYYY-MM-DD HH:MM
symptom / evidence / suggested fix
```

## [open] craft pocket-grid voids materials — Grog, 2026-09-01
/craft birch_planks ate 19 logs, made 4 torches, usedTable:false. FEL confirms:
2x2 pocket batch crafts VOID materials. Fix: ALWAYS craft at table (in flight).

## [open] pathfinder digs with held tool — FEL intel, 2026-09-01
Traversal digging uses currently held tool — long moves eat iron durability.
Fix: equip cheap/no tool before travel legs.

## [open] nuisance block wedges movement — FEL intel, 2026-09-01
Torch/leaf_litter in bot's own tile = path reported but no movement. Detect +
dig block underfoot when goto frozen.

## [open] bucket fill: activateBlock fails — FEL intel, 2026-09-01
Use lookAt(water) + bot.activateItem(), not activateBlock.

## [open] blockAt stale for unvisited chunks — FEL intel, 2026-09-01
Walk near before trusting scans.

## [open] Movements safety config — FEL intel (their fall death), 2026-09-01
Set allowParkour=false, maxDropDown=3, allow1by1towers=false,
allowSprinting=false, infiniteLiquidDropdownDistance=false, scafoldingBlocks=[].
Also stops ugly self-built dirt towers on landscape.

## [open] ledger lines must stay REAL white chat — FEL intel, 2026-09-01
tellraw system msgs don't fire chat events — other bots parse DEPOT/TRADE/USING
lines from real chat. Grey wiring must EXCLUDE protocol-prefixed lines
(DEPOT |TRADE |USING |FREE |LEASE-BREAK |BASE |CLAIM |HELLO |OFFER ).

## [open] health<8 panic listener at game speed — FEL intel, 2026-09-01
Injected health listener: abort task, announce, flee home — BUT when deep/far,
wall off line-of-sight with cobble + eat instead. Game-speed reflex, not LLM.

## [open] torch kit rule — FEL intel (their 3 deaths in dark pockets), 2026-09-01
Every bot carries ≥8 torches on excursions, lights workspace ~7 spacing.
Deep kit below y0: 40 torches, armor, 2 picks, 8 food, durability tracking.

## [open] sign placement via bot fails (blockUpdate timeout) — UngaBunga, 2026-09-01
Orchestrator RCON setblock works; bot-side placeSign needs investigation.

## [open] toss self-repickup — UngaBunga, 2026-08-31
bot.toss reports ok but bot re-grabs own drop; toss + walk 3 back (giveItems
helper in flight).
