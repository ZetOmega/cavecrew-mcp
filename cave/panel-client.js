// cave/panel-client.js — the fleet panel's entire client-side script, served
// as a real static file via GET /panel.js (see panel.mjs) and loaded with
// <script src="/panel.js"></script> from the page panel.mjs renders.
//
// Moved out of panel.mjs's inline template-literal <script> block (PANEL V3
// SPEC, architecture note, phase 1) specifically to kill a bug class at its
// root: as a template-literal string, a literal backslash in a client-side
// regex had to be doubled to survive the OUTER literal's own escape
// processing before the browser ever saw it (bit twice — round 5 and round
// 7). As a real .js file there is no outer literal to fight: every regex
// below is written the normal, single-backslash way, and `node --check` can
// verify this file as JavaScript entirely on its own.
//
// Zero feature/visual change from the inline version this replaces — see
// cave/PANEL.md for the full behavioural contract this implements.
(function () {
  'use strict';
  var grid = document.getElementById('grid');
  var cards = Object.create(null);
  var flashes = Object.create(null);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function setText(node, s) { if (node.textContent !== s) node.textContent = s; }
  function setCls(node, s) { if (node.className !== s) node.className = s; }

  function fmtPos(p) {
    if (!p) return 'position unknown';
    return 'xyz ' + Math.round(p.x) + ' ' + Math.round(p.y) + ' ' + Math.round(p.z);
  }
  // Distance-from-base badge (v3) — bot.distance is already the fully-formed
  // {horiz, vertical, compass} object from panel-data.mjs's distanceFromBase(),
  // or null when pos itself is unknown (offline/unspawned). Hidden entirely
  // in that case by the caller, never rendered as a fake "0m".
  function fmtDistance(d) {
    if (!d) return null;
    var vert = d.vertical == null ? '' : ' Δy' + (d.vertical > 0 ? '+' + d.vertical : d.vertical);
    var compass = d.compass ? ' ' + d.compass : '';
    return d.horiz.toFixed(1) + 'm' + compass + vert + ' from base';
  }
  function fmtDur(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    var h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }
  function taskAge(bot) {
    var t = bot.currentTask;
    if (!t) return '';
    var start = bot.taskStartedAt ? Date.parse(bot.taskStartedAt) : NaN;
    if (t.state === 'running') {
      if (!isFinite(start)) return 'running';
      return 'running ' + fmtDur(Date.now() - start);
    }
    if (t.finishedAt) {
      var fin = Date.parse(t.finishedAt);
      if (isFinite(fin)) return t.state + ' ' + fmtDur(Date.now() - fin) + ' ago';
    }
    return t.state;
  }
  // Shared by both HP and FD bars — same 0-20 scale, same thresholds. FD used
  // to render a constant blue-grey regardless of value, so a bot starving at
  // 2 food looked exactly like one sitting at a full 20: a real gap against
  // the green/amber/red mandate, not just a missed lick of paint.
  //
  // These hex literals intentionally mirror panel.mjs's :root token values
  // (--health-track/--red/--amber/--green) rather than reading them via
  // getComputedStyle — a DOM round-trip for a value that only changes when a
  // human edits the CSS isn't worth the complexity. If a future skin pass
  // repoints those tokens, update the matching literal here by hand.
  function healthColor(v) {
    if (v == null) return '#3a4150';
    if (v <= 6) return '#ff6b63';
    if (v <= 12) return '#f2b035';
    return '#5fe36b';
  }

  // Event feed (phase-2 item, PANEL.md) — /api/fleet already carries each
  // bot's last ~10 events, this just finally renders them. Kept as a small
  // per-card toggle rather than a fleet-wide stream: a merged feed would
  // compete with the Alerts column for the same "something's wrong" job,
  // where this is closer to "what has this bot actually been doing lately."
  var ALERT_EVENT_TYPES = { death: 1, error: 1, panic: 1, kicked: 1, disconnect: 1 };
  // Matches runner.js's RING RATE CAP rollup line verbatim
  // ("...suppressed N similar <type> event(s)") — detected by message shape
  // since the rollup keeps the original type, not a type of its own. Single
  // backslashes here are correct and final now that this is a real .js file
  // — see the file header for why this line used to need doubling.
  var SUPPRESSED_RE = /^\.\.\.suppressed \d+ similar/;
  function renderEvToggle(toggleEl, listEl, state) {
    var n = state.count || 0;
    setText(toggleEl, (state.expanded ? '▾' : '▸') + ' events' + (n ? ' (' + n + ')' : ''));
    setCls(listEl, 'ev-list' + (state.expanded ? ' open' : ''));
  }
  // Movement delta colouring. Red is the wedge flag — under half a block of
  // travel in the window means the bot is very likely stuck, which pairs with
  // the runner's own wedge watchdog. Same "mirrors the CSS tokens by hand"
  // note as healthColor above applies to these literals too.
  function deltaColor(v) {
    if (v == null) return '#5d6675';
    if (v > 5) return '#5fe36b';
    if (v >= 0.5) return '#f2b035';
    return '#ff6b63';
  }
  function setDelta(node, v) {
    setText(node, v == null ? '—' : v.toFixed(1));
    var col = deltaColor(v);
    if (node.dataset.col !== col) { node.style.color = col; node.dataset.col = col; }
  }

  // Tool/durability chips (v3, G1's per-item {used,max} field). Colour
  // thresholds match PANEL_V3_SPEC.md §3.4 exactly: green >= 30% remaining,
  // amber 10-30%, red under 10% — a deliberately different curve from the
  // HP/FD bars above (a tool genuinely breaks at 0%; health has no equivalent
  // hard wall at the same fraction). Referenced via var(--token) directly
  // rather than mirrored hex literals (unlike healthColor/deltaColor above,
  // which predate this file's CSS-token pass) — inline styles resolve
  // custom properties natively, so there is nothing to keep in sync by hand.
  function durabilityColor(remaining) {
    if (remaining >= 0.30) return 'var(--green)';
    if (remaining >= 0.10) return 'var(--amber)';
    return 'var(--red)';
  }
  // Builds one inventory/chest item chip. When the item carries a genuine
  // {used, max} durability pair (some runners' items do — G1 — some don't
  // yet; real fleet data today is a live mix of both on the SAME bot, see
  // PANEL.md) it grows a bottom bar; every other item renders byte-for-byte
  // the same markup as before this round — zero fake bars, ever.
  // Real Minecraft item icons (v3, §3.4, integration round) — served by
  // panel.mjs from the already-installed minecraft-assets package (see that
  // file's GET /mc-icon/<name>.png route + panel-data.mjs's getIcon()).
  // alt="" + loading="lazy": a chip's meaning is fully carried by its own
  // .n text regardless of whether the image loads, and most icons for a
  // given fleet are the same handful of names reused across every card —
  // the browser's own image cache (server sends a long max-age) makes this
  // effectively free after the first paint.
  function buildIcon(name) {
    var img = document.createElement('img');
    img.className = 'chip-icon';
    img.src = '/mc-icon/' + encodeURIComponent(name) + '.png';
    img.alt = '';
    img.loading = 'lazy';
    return img;
  }
  function buildItemChip(item) {
    var d = item.durability;
    var hasDur = !!(d && typeof d.used === 'number' && typeof d.max === 'number' && d.max > 0);
    var chip = el('span', 'chip' + (hasDur ? ' has-dur' : ''));
    if (!hasDur) {
      chip.appendChild(buildIcon(item.name));
      chip.appendChild(el('span', 'n', item.name));
      chip.appendChild(el('span', 'c', String(item.count)));
      return chip;
    }
    var top = el('span', 'chip-top');
    top.appendChild(buildIcon(item.name));
    top.appendChild(el('span', 'n', item.name));
    top.appendChild(el('span', 'c', String(item.count)));
    chip.appendChild(top);
    var remaining = Math.max(0, Math.min(1, 1 - d.used / d.max));
    var bar = el('span', 'dur-bar');
    var fill = el('span', 'dur-fill');
    fill.style.width = (remaining * 100) + '%';
    fill.style.background = durabilityColor(remaining);
    bar.appendChild(fill);
    chip.appendChild(bar);
    chip.title = item.name + ' — ' + Math.max(0, d.max - d.used) + '/' + d.max + ' durability remaining';
    return chip;
  }
  // Rebuild-detection signature for an item list — extends the existing
  // name:count signature with durability wear, so a tool visibly losing
  // durability (count unchanged) still triggers a chip rebuild instead of
  // sitting frozen at whatever fraction it had when the chip was first built.
  function invSignature(items) {
    return items.map(function (i) {
      return i.name + ':' + i.count + ':' + (i.durability ? i.durability.used + '/' + i.durability.max : '');
    }).join('|');
  }

  // Held-tool hero line (v3, Mission Control §3.4) — three real, distinct
  // states per G1's own shape: `undefined` (this runner hasn't shipped G1
  // yet — hide the row, don't show a fake "empty hand"), `null` (a G1
  // runner, hand genuinely empty — show it as exactly that), or a real
  // item (icon + name, durability bar only when the item actually carries
  // one — a held block/food item has none, correctly no bar).
  function toolSignature(heldItem) {
    if (heldItem === undefined) return 'undef';
    if (heldItem === null) return 'empty';
    var d = heldItem.durability;
    return heldItem.name + ':' + heldItem.count + ':' + (d ? d.used + '/' + d.max : '');
  }
  function renderTool(container, heldItem) {
    container.textContent = '';
    if (heldItem === undefined) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    if (heldItem === null) {
      container.appendChild(el('span', 'tool-empty', 'empty hand'));
      return;
    }
    container.appendChild(buildIcon(heldItem.name));
    container.appendChild(el('span', 'tool-name', heldItem.name));
    var d = heldItem.durability;
    if (d && typeof d.used === 'number' && typeof d.max === 'number' && d.max > 0) {
      var remaining = Math.max(0, Math.min(1, 1 - d.used / d.max));
      var durWrap = el('span', 'tool-dur');
      var bar = el('span', 'tool-dur-bar');
      var fill = el('span', 'tool-dur-fill');
      fill.style.width = (remaining * 100) + '%';
      fill.style.background = durabilityColor(remaining);
      bar.appendChild(fill);
      durWrap.appendChild(bar);
      durWrap.appendChild(el('span', 'tool-dur-text', Math.max(0, d.max - d.used) + '/' + d.max));
      container.appendChild(durWrap);
    }
  }

  // Relative-timestamp refresh, shared by every ledger-style list on the page
  // (the per-card event log, and v3's drilldown event/mission copies below) —
  // same reasoning each already followed: "12s ago" left stale for minutes on
  // an unchanged list would be a quiet honesty bug, so timestamps re-derive
  // from data-ts on every call regardless of whether the list itself rebuilt.
  function refreshTimestamps(container) {
    var nodes = container.querySelectorAll('.et');
    for (var i = 0; i < nodes.length; i++) {
      var ts = nodes[i].dataset.ts;
      if (ts) setText(nodes[i], fmtDur(Date.now() - Date.parse(ts)) + ' ago');
    }
  }
  // Renders one events list (ev-item rows) from a raw events array, gated on
  // a seq-based signature so an open/scrolled list doesn't rebuild (and jump)
  // on a poll that brought nothing new. Shared by the existing per-card mini
  // event toggle AND v3's drilldown event copy (same data, two presentations
  // — see build() below) rather than duplicating this logic twice.
  function renderEventList(listEl, events, prevSig) {
    var sig = events.map(function (e) { return e.seq; }).join('|');
    if (sig !== prevSig) {
      listEl.textContent = '';
      if (!events.length) {
        listEl.appendChild(el('div', 'ev-empty', 'no events yet'));
      } else {
        events.slice().reverse().forEach(function (e) {
          var cls = 'ev-item' + (ALERT_EVENT_TYPES[e.type] ? ' warn' : '') + (SUPPRESSED_RE.test(e.msg) ? ' suppressed' : '');
          var row = el('div', cls);
          var et = el('span', 'et');
          et.dataset.ts = e.ts;
          var em = el('span', 'em', e.msg);
          row.appendChild(et); row.appendChild(em);
          listEl.appendChild(row);
        });
      }
    }
    refreshTimestamps(listEl);
    return sig;
  }
  // Renders the mission-history drilldown section from an /api/missions
  // response (or null while a fetch is in flight). `missing:true` (G2's
  // durable log has no file for this bot yet — a not-upgraded runner, or a
  // bot that has simply never finished a task) gets the exact quiet line the
  // launch brief specifies, distinct from an actual read error and from "the
  // file exists but is empty" (which can't happen — getMissionsForBot never
  // returns missing:false with zero entries unless the file truly has none).
  function renderMissions(container, data) {
    container.textContent = '';
    if (!data) {
      container.appendChild(el('div', 'ev-empty', 'loading…'));
      return;
    }
    if (data.missing) {
      container.appendChild(el('div', 'ev-empty', 'keine Missions-Historie (runner-update ausstehend)'));
      return;
    }
    if (data.ok === false) {
      container.appendChild(el('div', 'ev-empty', data.error || 'missions unavailable'));
      return;
    }
    var entries = data.entries || [];
    if (!entries.length) {
      container.appendChild(el('div', 'ev-empty', 'no missions recorded yet'));
      return;
    }
    entries.forEach(function (m) {
      var failed = m.state === 'failed' || !!m.error;
      var row = el('div', 'ev-item' + (failed ? ' warn' : ''));
      var et = el('span', 'et');
      et.dataset.ts = m.ts;
      var label = m.kind || '?';
      if (m.state) label += ' · ' + m.state;
      if (typeof m.durationMs === 'number') label += ' · ' + fmtDur(m.durationMs);
      if (m.detail) label += ' — ' + m.detail;
      if (m.error) label += ' (' + m.error + ')';
      var em = el('span', 'em', label);
      row.appendChild(et); row.appendChild(em);
      container.appendChild(row);
    });
    refreshTimestamps(container);
  }

  function build(bot) {
    var c = el('div', 'card');
    var r1 = el('div', 'row1 clickable');
    r1.title = 'click for full inventory, events, and mission history';
    var dot = el('span', 'dot');
    var name = el('span', 'name');
    var port = el('span', 'port');
    var age = el('span', 'age');
    var ddArrow = el('span', 'dd-toggle', '▸ details');
    r1.appendChild(dot); r1.appendChild(name); r1.appendChild(port); r1.appendChild(age); r1.appendChild(ddArrow);

    var pos = el('div', 'pos');
    // Distance-from-base (v3, Mission Control) — see fmtDistance above.
    var dist = el('div', 'distance');

    var delta = el('div', 'delta');
    var d30v = el('span', 'dv');
    var d60v = el('span', 'dv');
    delta.appendChild(el('span', 'dl', 'Δ30s'));
    delta.appendChild(d30v);
    delta.appendChild(el('span', 'dsep', '|'));
    delta.appendChild(el('span', 'dl', 'Δ60s'));
    delta.appendChild(d60v);

    var vitals = el('div', 'vitals');
    function vital(label, color) {
      var v = el('div', 'vital');
      var l = el('span', 'lbl', label);
      var track = el('div', 'track');
      var fill = el('div', 'fill');
      track.appendChild(fill);
      var num = el('span', 'num');
      v.appendChild(l); v.appendChild(track); v.appendChild(num);
      vitals.appendChild(v);
      return { fill: fill, num: num, color: color };
    }
    var hp = vital('HP', healthColor);
    var fd = vital('FD', healthColor);

    // Held-tool hero line (v3, Mission Control §3.4) — /status.heldItem
    // (G1). Built empty here; paint() below fills it in (icon+name, or
    // .tool-empty text, or hides the whole row) since which of those three
    // applies depends on live data, not anything known at build time.
    var tool = el('div', 'tool');
    tool.hidden = true;

    var task = el('div', 'task');
    var thead = el('div', 'head');
    var tkind = el('span', 'kind');
    var tstate = el('span', 'state');
    var tsrc = el('span', 'src');
    thead.appendChild(tkind); thead.appendChild(tstate); thead.appendChild(tsrc);
    var tdetail = el('div', 'detail');
    task.appendChild(thead); task.appendChild(tdetail);

    var errBox = el('div', 'err-box');
    errBox.hidden = true;

    var meta = el('div', 'meta');
    var deaths = el('span');
    var lastDeath = el('span');
    var guard = el('span', 'guard');
    var engine = el('span');
    var evState = { expanded: false, count: 0 };
    var evToggle = el('span', 'ev-toggle');
    var evList = el('div', 'ev-list');
    evToggle.addEventListener('click', function () {
      evState.expanded = !evState.expanded;
      renderEvToggle(evToggle, evList, evState);
    });
    renderEvToggle(evToggle, evList, evState);
    meta.appendChild(deaths); meta.appendChild(lastDeath); meta.appendChild(guard);
    meta.appendChild(engine); meta.appendChild(evToggle);

    var inv = el('div', 'inv');
    var acts = el('div', 'acts');
    var wake = el('button', 'wake', 'WAKE');
    var stop = el('button', 'stop', 'stop');
    var flash = el('span', 'flash');
    acts.appendChild(wake); acts.appendChild(stop); acts.appendChild(flash);

    // Keyed by PORT, never by name: a runner that comes up after the card was
    // built renames it (":3209" -> "TestRock"), which would orphan a
    // name-keyed flash and strand the button's feedback. The port is the card
    // identity and never changes; the server resolves a port just as happily
    // as a name.
    var key = bot.port;
    wake.addEventListener('click', function () { act('/api/wake', key, wake, flash); });
    stop.addEventListener('click', function () { act('/api/stop', key, stop, flash); });

    // Mission Control drilldown (v3) — click the card's header row to reveal
    // full inventory (all stacks, not just today's top-10), this bot's recent
    // events (same ~10-deep data as the mini toggle above, fuller
    // presentation), and durable mission history from /api/missions. Full
    // inventory + events ride along on the normal 3s poll like everything
    // else on the card (paint() only bothers rebuilding them while the panel
    // is actually open, see below); missions is fetched once per open
    // transition, deliberately off the fast cycle — see panel.mjs's route.
    var dd = el('div', 'dd');
    var ddState = { expanded: false, missionsData: null, missionsLoading: false };
    var ddInvHead = el('div', 'dd-head', 'Full inventory');
    var ddInv = el('div', 'dd-inv inv');
    var ddEvHead = el('div', 'dd-head', 'Recent events');
    var ddEvList = el('div', 'dd-list');
    var ddMissHead = el('div', 'dd-head', 'Mission history');
    var ddMissList = el('div', 'dd-list');
    dd.appendChild(ddInvHead); dd.appendChild(ddInv);
    dd.appendChild(ddEvHead); dd.appendChild(ddEvList);
    dd.appendChild(ddMissHead); dd.appendChild(ddMissList);

    r1.addEventListener('click', function () {
      ddState.expanded = !ddState.expanded;
      setCls(dd, 'dd' + (ddState.expanded ? ' open' : ''));
      setText(ddArrow, (ddState.expanded ? '▾' : '▸') + ' details');
      if (ddState.expanded && !ddState.missionsData && !ddState.missionsLoading) {
        ddState.missionsLoading = true;
        renderMissions(ddMissList, null);
        fetch('/api/missions?bot=' + encodeURIComponent(key))
          .then(function (r) { return r.json(); })
          .then(function (j) { ddState.missionsData = j; })
          .catch(function (e) { ddState.missionsData = { ok: false, error: String((e && e.message) || e), entries: [] }; })
          .then(function () {
            ddState.missionsLoading = false;
            renderMissions(ddMissList, ddState.missionsData);
          });
      }
    });

    c.appendChild(r1); c.appendChild(pos); c.appendChild(dist); c.appendChild(delta); c.appendChild(vitals);
    c.appendChild(tool);
    c.appendChild(task); c.appendChild(errBox); c.appendChild(meta);
    c.appendChild(inv); c.appendChild(evList); c.appendChild(acts);
    c.appendChild(dd);
    grid.appendChild(c);

    return { root: c, dot: dot, name: name, port: port, age: age, pos: pos, dist: dist, tool: tool, toolSig: null,
      d30v: d30v, d60v: d60v,
      hp: hp, fd: fd, task: task, tkind: tkind, tstate: tstate, tsrc: tsrc, tdetail: tdetail,
      errBox: errBox, deaths: deaths, lastDeath: lastDeath, guard: guard, engine: engine,
      inv: inv, invSig: null,
      evToggle: evToggle, evList: evList, evState: evState, evSig: null,
      wake: wake, stop: stop, flash: flash,
      ddState: ddState, ddInv: ddInv, ddInvSig: null, ddEvList: ddEvList, ddEvSig: null, ddMissList: ddMissList };
  }

  function act(path, port, btn, flash) {
    btn.disabled = true;
    flash.className = 'flash';
    flash.textContent = 'sending...';
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bot: port })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.busy) { flash.className = 'flash bad'; flash.textContent = j.message || 'busy'; }
        else if (j.ok) { flash.className = 'flash'; flash.textContent = j.pushed ? ('pushed ' + j.pushed.ep) : 'stopped'; }
        else { flash.className = 'flash bad'; flash.textContent = j.error || 'failed'; }
      })
      .catch(function (e) { flash.className = 'flash bad'; flash.textContent = String(e.message || e); })
      .then(function () {
        btn.disabled = false;
        flashes[String(port)] = { text: flash.textContent, cls: flash.className, until: Date.now() + 8000 };
        refresh();
      });
  }

  // BariBrute / baritone-controlled bots (v3, integration round) — a
  // completely different HTTP API shape than a mineflayer runner, ground-
  // truthed live before writing any of this: {name, position,
  // positionSource, task:{kind,block,count,at}, lastBaritoneLine,
  // connected, phase, uptime, aborted} — no health/food/inventory/
  // idleGuard/mineflayer-shaped currentTask at all. A deliberately SEPARATE
  // builder rather than branching the mineflayer build()/paint() in a dozen
  // places — reuses the exact same classes (card/row1/dot/pos/distance/
  // task/head/kind/state/detail/err-box/meta, idle/offline/err severity)
  // so it reads as the same visual language with a lot less content, and
  // gets NO wake/stop buttons at all: this control surface is unproven,
  // and panel-data.mjs's doWake/doStop refuse it outright regardless.
  function buildBaritoneCard() {
    var c = el('div', 'card baritone');
    var r1 = el('div', 'row1');
    var dot = el('span', 'dot');
    var brain = el('span', 'brain', '🧠');
    brain.title = 'baritone-controlled bot — different control surface, no wake/stop here';
    var name = el('span', 'name');
    var port = el('span', 'port');
    var age = el('span', 'age');
    r1.appendChild(dot); r1.appendChild(brain); r1.appendChild(name); r1.appendChild(port); r1.appendChild(age);

    var pos = el('div', 'pos');
    var dist = el('div', 'distance');

    var task = el('div', 'task');
    var thead = el('div', 'head');
    var tkind = el('span', 'kind');
    var tstate = el('span', 'state');
    thead.appendChild(tkind); thead.appendChild(tstate);
    var tdetail = el('div', 'detail');
    task.appendChild(thead); task.appendChild(tdetail);

    var errBox = el('div', 'err-box');
    errBox.hidden = true;

    var meta = el('div', 'meta');
    var uptimeEl = el('span');
    meta.appendChild(uptimeEl);

    c.appendChild(r1); c.appendChild(pos); c.appendChild(dist);
    c.appendChild(task); c.appendChild(errBox); c.appendChild(meta);
    grid.appendChild(c);

    return { root: c, dot: dot, name: name, port: port, age: age, pos: pos, dist: dist,
      task: task, tkind: tkind, tstate: tstate, tdetail: tdetail, errBox: errBox, uptime: uptimeEl };
  }

  // "Task presence IS the state" (ground-truthed: no running/done/failed
  // field anywhere in this API) — age is derived from the task's own `at`
  // timestamp rather than the mineflayer taskAge()'s event-log-derived
  // start time, which this bot's API has no equivalent of at all.
  function fmtBaritoneAge(bot) {
    var at = bot.baritoneTask && typeof bot.baritoneTask.at === 'number' ? bot.baritoneTask.at : null;
    if (at == null) return bot.phase || '';
    return 'running ' + fmtDur(Date.now() - at);
  }

  function paintBaritoneCard(c, bot) {
    var idle = !bot.offline && bot.idle;
    setCls(c.root, 'card baritone' + (bot.offline ? ' offline' : '') + (idle ? ' idle' : '') + (bot.aborted ? ' err' : ''));
    setCls(c.dot, 'dot ' + (bot.offline ? 'off' : (bot.connected ? 'on' : 'warn')));
    setText(c.name, bot.name);
    setText(c.port, ':' + bot.port);
    setText(c.age, bot.offline ? (bot.offlineReason || 'offline') : fmtBaritoneAge(bot));

    // positionSource IS the honesty hint (e.g. "goal-poll") — surfaced
    // verbatim rather than invented wording, since this bot's own API
    // already says how derived/potentially-lagged its position reading is.
    var posText = bot.offline
      ? 'runner not answering'
      : (bot.connected ? fmtPos(bot.pos) + (bot.positionSource ? ' (' + bot.positionSource + ')' : '') : 'runner up, bot disconnected');
    setText(c.pos, posText);

    var distText = bot.offline ? null : fmtDistance(bot.distance);
    c.dist.hidden = !distText;
    if (distText) setText(c.dist, distText);

    var bt = bot.baritoneTask;
    setText(c.tstate, bot.phase || '');
    setCls(c.tstate, 'state');
    if (bt) {
      c.task.hidden = false;
      setText(c.tkind, bt.kind || '?');
      // Field-presence driven, not kind-driven on purpose: "mine" carries
      // block/count, "goto" carries x/y/z, "tunnel" carries h/w/d (all three
      // shapes ground-truthed live, PANEL_V3_SPEC.md integration-round notes
      // + 2026-09-01 live QA) — checking the fields directly means a bare
      // {kind,at} or a future 4th shape still renders whatever it actually
      // has instead of silently dropping to just the raw log line.
      var parts = [];
      if (bt.block) parts.push(bt.block);
      if (typeof bt.count === 'number') parts.push('x' + bt.count);
      if (typeof bt.x === 'number' && typeof bt.y === 'number' && typeof bt.z === 'number') {
        parts.push('(' + bt.x + ',' + bt.y + ',' + bt.z + ')');
      }
      var dims = [];
      if (typeof bt.h === 'number') dims.push('h' + bt.h);
      if (typeof bt.w === 'number') dims.push('w' + bt.w);
      if (typeof bt.d === 'number') dims.push('d' + bt.d);
      if (dims.length) parts.push(dims.join(' '));
      var head = parts.join(' ');
      // Raw baritone pathfinder log lines run long ("Finished finding a
      // path from BetterBlockPos{...} to GoalComposite[...]. 2029 nodes
      // considered") — capped for the glanceable wall state, full text
      // still reachable via the title tooltip rather than lost.
      var line = bot.lastBaritoneLine || '';
      var LINE_CAP = 140;
      var shownLine = line.length > LINE_CAP ? line.slice(0, LINE_CAP) + '…' : line;
      var det = [head, shownLine].filter(Boolean).join(' — ');
      setText(c.tdetail, det);
      c.tdetail.title = line;
      c.tdetail.hidden = !det;
    } else {
      c.task.hidden = false;
      setText(c.tkind, bot.offline ? 'no data' : 'no task');
      var idleLine = bot.lastBaritoneLine || '';
      setText(c.tdetail, bot.offline ? '' : idleLine);
      c.tdetail.title = idleLine;
      c.tdetail.hidden = bot.offline || !idleLine;
    }

    // aborted is unproven in practice (every live observation so far has
    // it null) — rendered as a plain fact rather than an interpreted
    // message, since this codebase's own rule is never fabricate meaning
    // beyond what the data actually says.
    if (bot.aborted) {
      c.errBox.hidden = false;
      setText(c.errBox, 'aborted: ' + JSON.stringify(bot.aborted));
    } else {
      c.errBox.hidden = true;
    }

    setText(c.uptime, typeof bot.uptime === 'number' ? 'uptime ' + fmtDur(bot.uptime) : '');
  }

  function paint(bot) {
    var key = String(bot.port);
    if (bot.kind === 'baritone') {
      var bc = cards[key] || (cards[key] = buildBaritoneCard());
      return paintBaritoneCard(bc, bot);
    }
    var c = cards[key] || (cards[key] = build(bot));

    var idle = !bot.offline && bot.idle;
    // panic-response is the runner's own low-health flee/seal reflex taking
    // the wheel — rarest and most urgent state a card can be in, so it gets
    // its own flag on top of (not instead of) idle/err, and CSS gives it
    // priority for the border colour. Persists until the next task replaces
    // currentTask, same STATUS-HOLD rule lastError already follows.
    var isPanic = !!(bot.currentTask && bot.currentTask.kind === 'panic-response');
    var cls = 'card' + (bot.offline ? ' offline' : '') + (idle ? ' idle' : '') + (bot.lastError ? ' err' : '') + (isPanic ? ' panic' : '');
    setCls(c.root, cls);

    // Three real states, three colours: offline (runner unreachable, grey),
    // connected (bot live in-world, green), and the gap between them — runner
    // process up but the bot entity isn't (mid-reconnect) — which used to
    // share "off" with true offline and hide a real distinction the pos line
    // already spelled out in words. Amber matches that in-between meaning
    // everywhere else on the card.
    setCls(c.dot, 'dot ' + (bot.offline ? 'off' : (bot.connected ? 'on' : 'warn')));
    setText(c.name, bot.name);
    if (c.name.style.color !== bot.color) c.name.style.color = bot.color;
    setText(c.port, ':' + bot.port);
    setText(c.age, bot.offline ? (bot.offlineReason || 'offline') : taskAge(bot));

    setText(c.pos, bot.offline ? 'runner not answering' : (bot.connected ? fmtPos(bot.pos) : 'runner up, bot disconnected'));

    // Distance from base (v3) — hidden entirely (not "0m") whenever bot.pos
    // itself is unknown; distanceFromBase() already encodes that as a null
    // bot.distance, so there's nothing extra to check here beyond offline.
    var distText = bot.offline ? null : fmtDistance(bot.distance);
    c.dist.hidden = !distText;
    if (distText) setText(c.dist, distText);

    setDelta(c.d30v, bot.delta30);
    setDelta(c.d60v, bot.delta60);

    function vit(v, val) {
      var pct = val == null ? 0 : Math.max(0, Math.min(100, (val / 20) * 100));
      var w = pct + '%';
      if (v.fill.style.width !== w) v.fill.style.width = w;
      var col = v.color(val);
      if (v.fill.dataset.col !== col) { v.fill.style.background = col; v.fill.dataset.col = col; }
      setText(v.num, val == null ? '-' : String(Math.round(val)));
    }
    vit(c.hp, bot.health);
    vit(c.fd, bot.food);

    // Held-tool hero line (v3, Mission Control §3.4) — signature-gated
    // like inventory/events above, so an unchanged tool doesn't churn the
    // <img> element (and its src) every 3s poll for nothing.
    var toolSig = toolSignature(bot.heldItem);
    if (toolSig !== c.toolSig) {
      c.toolSig = toolSig;
      renderTool(c.tool, bot.heldItem);
    }

    var t = bot.currentTask;
    setCls(c.task, 'task' + (isPanic ? ' panic' : ''));
    if (t) {
      c.task.hidden = false;
      setText(c.tkind, t.kind);
      setText(c.tstate, t.state || '');
      setCls(c.tstate, 'state ' + (t.state || ''));
      // Origin tag — who commanded this task (issue #6 arbitration: was this
      // the panel's own WAKE, the runner's idle-guard filler, the panic
      // reflex, or a driver that self-identified). "http" is the sanitizer's
      // fallback for a plain caller that didn't say who it was — the common
      // case today since most drivers don't tag themselves yet — so it's
      // deliberately not shown: a chip that reads the same thing on every
      // card forever is noise, not information.
      var src = t.source;
      c.tsrc.hidden = !src || src === 'http';
      if (!c.tsrc.hidden) setText(c.tsrc, 'via ' + src);
      var det = t.detail || (t.result && t.result.error) || '';
      setText(c.tdetail, det);
      c.tdetail.hidden = !det;
    } else {
      c.task.hidden = false;
      setText(c.tkind, bot.offline ? 'no data' : 'no task');
      setText(c.tstate, '');
      setCls(c.tstate, 'state');
      c.tsrc.hidden = true;
      setText(c.tdetail, bot.offline ? '' : 'runner idle since start');
      c.tdetail.hidden = bot.offline;
    }

    if (bot.lastError) {
      c.errBox.hidden = false;
      setText(c.errBox, bot.lastError);
    } else {
      c.errBox.hidden = true;
    }

    setText(c.deaths, 'deaths ' + (bot.deathCount == null ? '-' : bot.deathCount));

    if (bot.lastDeath && bot.lastDeath.ts) {
      var diedAgo = fmtDur(Date.now() - Date.parse(bot.lastDeath.ts));
      setText(c.lastDeath, diedAgo ? '(' + diedAgo + ' ago)' : '');
      c.lastDeath.hidden = !diedAgo;
    } else {
      c.lastDeath.hidden = true;
    }

    if (bot.offline || bot.idleGuard == null) {
      c.guard.hidden = true;
    } else {
      c.guard.hidden = false;
      // Guard OFF is the driver's own doing while it actively drives (issue
      // #6) — not a fault — but it is the one state worth a glance, since a
      // bot that reads idle AND guard-off for a while means the driver went
      // quiet without re-arming it. Guard ON is the boring default: no colour.
      setText(c.guard, bot.idleGuard ? 'guard on' : 'guard off');
      setCls(c.guard, 'guard' + (bot.idleGuard ? '' : ' warn'));
    }

    setText(c.engine, bot.engine ? 'engine ' + bot.engine : '');

    // Inventory: top 10 stacks by count, rebuilt only when it actually
    // changed (name/count/durability — see invSignature). Durability chips
    // (v3) render via the shared buildItemChip() so a bot card's top-10 view
    // and the drilldown's full-inventory view (below) never drift apart.
    var items = (bot.inventory || []).slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 10);
    var sig = invSignature(items);
    if (sig !== c.invSig) {
      c.invSig = sig;
      c.inv.textContent = '';
      if (!items.length) {
        setCls(c.inv, 'inv-empty');
        c.inv.textContent = bot.offline ? '' : 'empty';
      } else {
        setCls(c.inv, 'inv');
        items.forEach(function (i) { c.inv.appendChild(buildItemChip(i)); });
      }
    }

    // Event log toggle + list. bot.events is already the last ~10 entries
    // (server-side ring, see EVENTS_PER_BOT) — the list itself is only
    // rebuilt when the actual set of events changed (by seq), same signature
    // pattern as inventory above, so an open/scrolled list doesn't jump or
    // flicker on every 3s poll that brought nothing new. Relative timestamps
    // ARE refreshed every poll regardless (below), since "12s ago" left
    // stale for minutes on an unchanged list would be a quiet honesty bug —
    // same reasoning as the movement-delta and task-age clocks elsewhere on
    // this card.
    var events = bot.events || [];
    c.evState.count = events.length;
    renderEvToggle(c.evToggle, c.evList, c.evState);
    c.evSig = renderEventList(c.evList, events, c.evSig);

    // Drilldown (v3) — full inventory + the same event data as above, fuller
    // presentation, but only actually rebuilt while the panel is open: no
    // reason to keep two hidden copies of every card's DOM in sync on every
    // 3s poll when at most one or two cards are expanded at a time.
    if (c.ddState.expanded) {
      var fullItems = (bot.inventory || []).slice().sort(function (a, b) { return b.count - a.count; });
      var fullSig = invSignature(fullItems);
      if (fullSig !== c.ddInvSig) {
        c.ddInvSig = fullSig;
        c.ddInv.textContent = '';
        if (!fullItems.length) {
          setCls(c.ddInv, 'dd-inv inv-empty');
          c.ddInv.textContent = bot.offline ? '' : 'empty';
        } else {
          setCls(c.ddInv, 'dd-inv inv');
          var INV_CAP = 30;
          fullItems.slice(0, INV_CAP).forEach(function (i) { c.ddInv.appendChild(buildItemChip(i)); });
          if (fullItems.length > INV_CAP) {
            c.ddInv.appendChild(el('span', 'chip', '+' + (fullItems.length - INV_CAP) + ' more'));
          }
        }
      }
      c.ddEvSig = renderEventList(c.ddEvList, events, c.ddEvSig);
      // Mission history isn't part of the fleet poll (fetched once per open
      // transition, see build()'s click handler) but its "N ago" timestamps
      // still need to keep aging on every poll like every other clock here.
      if (c.ddState.missionsData) refreshTimestamps(c.ddMissList);
    }

    var showWake = !bot.offline && idle;
    var showStop = !bot.offline && !idle;
    c.wake.hidden = !showWake;
    c.stop.hidden = !showStop;

    var f = flashes[key];
    if (f && f.until > Date.now()) {
      c.flash.textContent = f.text;
      c.flash.className = f.cls;
    } else if (c.flash.textContent) {
      c.flash.textContent = '';
      c.flash.className = 'flash';
    }
  }

  var alertsBox = document.getElementById('alerts');
  var alertSig = '';
  function paintAlerts(logAlerts, bots) {
    var list = [];
    bots.forEach(function (b) {
      if (b.lastError) list.push({ src: b.name, msg: b.lastError, ts: null, bot: true });
    });
    logAlerts.forEach(function (a) { list.push({ src: 'overseer', msg: a.msg, ts: a.ts, bot: false }); });

    var sig = list.map(function (a) { return a.src + a.ts + a.msg; }).join('|');
    if (sig === alertSig) return;
    alertSig = sig;
    alertsBox.textContent = '';
    if (!list.length) {
      alertsBox.appendChild(el('div', 'none', 'all quiet'));
      return;
    }
    list.forEach(function (a) {
      var d = el('div', 'alert' + (a.bot ? ' bot' : ''));
      var head = el('div', 't');
      head.textContent = (a.ts ? a.ts.replace('T', ' ').replace(/\.\d+Z?$/, '') : 'now') + '  ';
      var src = el('span', 'src', a.src);
      head.appendChild(src);
      d.appendChild(head);
      d.appendChild(el('div', 'm', a.msg));
      alertsBox.appendChild(d);
    });
  }

  // Tribe board (round 5) — /api/todo already grouped+bucketed everything
  // server-side; this just paints it. Whole-payload signature gate (same
  // idea as invSig/evSig on the cards) since TODO.md changes rarely and a
  // full teardown/rebuild on every 3s poll would fight the DONE section's
  // open/closed state and any text the operator is mid-selecting.
  var boardSig = '';
  var boardDoneOpen = false;
  var boardDoneToggle = document.getElementById('bd-done-toggle');
  var boardDoneArrow = document.getElementById('bd-done-arrow');
  var boardDoneRows = document.getElementById('bd-done');
  boardDoneToggle.addEventListener('click', function () {
    boardDoneOpen = !boardDoneOpen;
    setCls(boardDoneRows, 'board-rows' + (boardDoneOpen ? ' open' : ''));
    setText(boardDoneArrow, (boardDoneOpen ? '▾' : '▸') + ' DONE');
  });

  function renderBoardRows(container, rows, emptyMsg) {
    container.textContent = '';
    if (!rows.length) {
      container.appendChild(el('div', 'board-empty', emptyMsg));
      return;
    }
    rows.forEach(function (r) {
      var row = el('div', 'board-row');
      row.appendChild(el('span', 'board-lane', r.lane || '—'));
      row.appendChild(el('span', 'board-task', r.task));
      var who = el('span', 'board-who');
      (r.who || []).forEach(function (w) {
        var chip = el('span', 'board-chip', w.name);
        if (w.color) { chip.style.color = w.color; chip.style.borderColor = w.color; }
        who.appendChild(chip);
      });
      row.appendChild(who);
      row.appendChild(el('span', 'board-status', r.detail || ''));
      container.appendChild(row);
    });
  }

  function paintBoard(data) {
    var sig = JSON.stringify(data);
    if (sig === boardSig) return;
    boardSig = sig;

    var sub = document.getElementById('board-sub');
    var doing = (data && data.doing) || [];
    var todo = (data && data.todo) || [];
    var done = (data && data.done) || [];

    if (data && data.ok === false) {
      setText(sub, 'board unavailable' + (data.error ? ' (' + data.error + ')' : ''));
    } else {
      var extra = data && data.skipped ? ' — ' + data.skipped + ' row' + (data.skipped === 1 ? '' : 's') + ' skipped (malformed)' : '';
      setText(sub, 'cave/TODO.md' + extra);
    }

    setText(document.getElementById('bd-doing-n'), String(doing.length));
    setText(document.getElementById('bd-todo-n'), String(todo.length));
    setText(document.getElementById('bd-done-n'), String(done.length));
    renderBoardRows(document.getElementById('bd-doing'), doing, 'nothing in flight');
    renderBoardRows(document.getElementById('bd-todo'), todo, 'queue empty');
    renderBoardRows(boardDoneRows, done, 'none pruned yet');
  }

  // Vault (round 7) — /api/vault carries missing:true when audit.mjs has
  // never run; that's the ONE case that hides the whole section outright
  // rather than showing an empty/error state, since "never audited yet" is
  // normal, not broken. Every other non-ok response still shows the
  // section, with the failure reason where the age would be.
  var vaultSection = document.getElementById('vault');
  var vaultAgeEl = document.getElementById('vault-age');
  var vaultChestsEl = document.getElementById('vault-chests');
  var vaultSig = '';
  function paintVault(data) {
    if (!data || data.missing) {
      vaultSection.hidden = true;
      return;
    }
    vaultSection.hidden = false;
    var sig = JSON.stringify(data);
    if (sig === vaultSig) return;
    vaultSig = sig;

    if (data.ok === false) {
      setText(vaultAgeEl, data.error || 'unavailable');
      setCls(vaultAgeEl, 'vault-age stale');
    } else {
      var stale = typeof data.ageMs === 'number' && typeof data.staleMs === 'number' && data.ageMs > data.staleMs;
      var ageText = typeof data.ageMs === 'number' ? fmtDur(data.ageMs) + ' ago' : 'age unknown';
      setText(vaultAgeEl, ageText);
      setCls(vaultAgeEl, 'vault-age' + (stale ? ' stale' : ''));
    }

    vaultChestsEl.textContent = '';
    var chests = data.chests || [];
    if (!chests.length) {
      vaultChestsEl.appendChild(el('div', 'board-empty', 'snapshot has no chests'));
      return;
    }
    var ITEM_CAP = 30;
    chests.forEach(function (c) {
      var block = el('div', 'vault-chest' + (c.error ? ' err' : ''));
      var head = el('div', 'vault-head');
      head.appendChild(el('span', 'vault-label', c.label));
      if (c.pos) head.appendChild(el('span', 'vault-pos', c.pos.x + ',' + c.pos.y + ',' + c.pos.z));
      if (!c.error) head.appendChild(el('span', 'vault-total', c.total + ' items'));
      block.appendChild(head);
      if (c.error) {
        block.appendChild(el('div', 'vault-error', 'read failed: ' + c.error));
      } else if (!(c.items || []).length) {
        block.appendChild(el('div', 'board-empty', 'empty'));
      } else {
        var items = el('div', 'inv');
        var list = c.items;
        // buildItemChip() (v3, §3.4) — same shared chip builder a bot
        // card's own inventory uses, so a chest's contents and a bot's
        // pockets read as the same kind of fact (real icon, durability bar
        // if the item happens to carry one — chest reads don't today, see
        // audit.mjs, but the function already handles that honestly).
        list.slice(0, ITEM_CAP).forEach(function (it) {
          items.appendChild(buildItemChip(it));
        });
        if (list.length > ITEM_CAP) {
          items.appendChild(el('span', 'chip', '+' + (list.length - ITEM_CAP) + ' more'));
        }
        block.appendChild(items);
      }
      vaultChestsEl.appendChild(block);
    });
  }

  // Economy (v3, §3.2) — /api/economy's per-item, time-bucketed net-flow
  // series over cave/ledger/*.jsonl. Hand-rolled inline SVG (no lib, matches
  // the file's zero-deps doctrine) — a sparkline is just N numbers mapped to
  // a path, per the architecture note's own sparklinePath() sketch, extended
  // here with a zero baseline and dot markers so a mostly-flat 36-bucket
  // window with only 1-4 real movements still reads as "activity happened
  // here", not as a flat, information-free line.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  // One fixed hue per tracked item (ECONOMY_KEY_ITEMS, panel-data.mjs) via
  // the --econ-* tokens (panel.mjs :root) — referenced live through
  // var(--token) exactly like durabilityColor() above, so a future skin pass
  // only ever touches the :root block, never this file.
  var ECON_ITEM_TOKEN = {
    iron_ingot: 'var(--econ-iron)',
    raw_iron: 'var(--econ-raw-iron)',
    wheat: 'var(--econ-wheat)',
    bread: 'var(--econ-bread)',
    oak_log: 'var(--econ-oak)',
    cobblestone: 'var(--econ-cobble)'
  };
  var ECON_W = 160, ECON_H = 30, ECON_PAD = 3;
  function buildSparkline(itemData) {
    var values = itemData.buckets || [];
    var color = ECON_ITEM_TOKEN[itemData.item] || 'var(--muted)';
    var svg = svgEl('svg', { width: String(ECON_W), height: String(ECON_H), viewBox: '0 0 ' + ECON_W + ' ' + ECON_H, class: 'econ-svg' });
    if (values.length < 2) return svg;
    var max = 0, min = 0;
    values.forEach(function (v) { if (v > max) max = v; if (v < min) min = v; });
    // A window that's entirely zero (no bucket has moved) still needs a
    // non-zero range to divide by — widen it symmetrically around zero
    // rather than special-casing an all-flat render.
    if (max === min) { max += 1; min -= 1; }
    var range = max - min;
    var innerH = ECON_H - ECON_PAD * 2;
    var stepX = (ECON_W - ECON_PAD * 2) / (values.length - 1);
    function xAt(i) { return ECON_PAD + i * stepX; }
    function yAt(v) { return ECON_PAD + innerH - ((v - min) / range) * innerH; }
    var zeroY = yAt(0);
    svg.appendChild(svgEl('line', { x1: String(ECON_PAD), x2: String(ECON_W - ECON_PAD), y1: zeroY.toFixed(1), y2: zeroY.toFixed(1), stroke: 'var(--line)', 'stroke-width': '1' }));
    var d = '';
    values.forEach(function (v, i) {
      d += (i === 0 ? 'M' : 'L') + xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1) + ' ';
    });
    svg.appendChild(svgEl('path', { d: d.trim(), fill: 'none', stroke: color, 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    // Dots only at buckets that actually moved — 36 mostly-zero buckets
    // would otherwise drown a real 1-4-datapoint window in near-invisible
    // markers sitting right on the zero baseline.
    values.forEach(function (v, i) {
      if (!v) return;
      var dot = svgEl('circle', { cx: xAt(i).toFixed(1), cy: yAt(v).toFixed(1), r: '2.4', fill: color });
      var title = svgEl('title', {});
      title.textContent = (v > 0 ? '+' : '') + v + ' ' + itemData.item;
      dot.appendChild(title);
      svg.appendChild(dot);
    });
    return svg;
  }
  function renderEconomyRow(itemData) {
    var row = el('div', 'econ-row');
    row.appendChild(el('div', 'econ-name', itemData.item));
    var spark = el('div', 'econ-spark');
    spark.appendChild(buildSparkline(itemData));
    row.appendChild(spark);
    var netCls = 'econ-net' + (itemData.net > 0 ? ' pos' : (itemData.net < 0 ? ' neg' : ''));
    row.appendChild(el('div', netCls, (itemData.net > 0 ? '+' : '') + itemData.net));
    // 'et' (event-timestamp) is the shared class refreshTimestamps() scans
    // for — reusing it here means this ticks on the same rule as every other
    // relative clock on the page instead of needing its own refresh loop.
    var last = el('div', 'econ-last et');
    if (itemData.lastTs) {
      last.dataset.ts = itemData.lastTs;
      last.textContent = fmtDur(Date.now() - Date.parse(itemData.lastTs)) + ' ago';
    }
    row.appendChild(last);
    return row;
  }
  var economySection = document.getElementById('economy');
  var economyItemsEl = document.getElementById('economy-items');
  var economySig = '';
  function paintEconomy(data) {
    if (!data || data.missing) {
      economySection.hidden = true;
      return;
    }
    economySection.hidden = false;
    var sig = JSON.stringify(data);
    if (sig === economySig) {
      // Nothing changed server-side, but "N ago" still needs to keep ticking
      // the same honesty-over-shortcuts rule every other relative clock on
      // this page follows.
      refreshTimestamps(economyItemsEl);
      return;
    }
    economySig = sig;
    economyItemsEl.textContent = '';
    if (data.ok === false) {
      economyItemsEl.appendChild(el('div', 'econ-empty', data.error || 'economy unavailable'));
      return;
    }
    if (data.empty) {
      economyItemsEl.appendChild(el('div', 'econ-empty', 'Ledger leer — Bewegungen erscheinen ab jetzt'));
      return;
    }
    var items = data.items || [];
    if (!items.length) {
      // Real ledger movement exists (empty:false), just nothing for a
      // tracked item in this window — a different honest fact from "leer"
      // above, so it gets its own line rather than reusing that message.
      economyItemsEl.appendChild(el('div', 'econ-empty', 'keine Bewegung bei erfassten Items (letzte 6h)'));
      return;
    }
    items.forEach(function (it) { economyItemsEl.appendChild(renderEconomyRow(it)); });
  }

  // Tribe Stat Wall (v3, §3.3) — /api/statwall's five tiles. Simple text/
  // visibility updates on static, single-instance elements (unlike
  // paintBoard/paintVault/paintEconomy's list rebuilds) so this always
  // repaints on every poll, same as paint(bot) itself — no signature gate
  // needed since there's no scroll position or expanded state a rebuild
  // could disturb, and the ageMs field on ore/bread changes every call
  // anyway (getVault() computes it fresh, never cached), so a gate would
  // never actually skip anything.
  var swEls = {
    deaths: { tile: document.getElementById('sw-deaths'), num: document.getElementById('sw-deaths-num'), unit: document.getElementById('sw-deaths-unit'), sub: document.getElementById('sw-deaths-sub') },
    ore: { tile: document.getElementById('sw-ore'), num: document.getElementById('sw-ore-num'), sub: document.getElementById('sw-ore-sub') },
    bread: { tile: document.getElementById('sw-bread'), num: document.getElementById('sw-bread-num'), sub: document.getElementById('sw-bread-sub') },
    missions: { tile: document.getElementById('sw-missions'), num: document.getElementById('sw-missions-num') },
    fel: { tile: document.getElementById('sw-fel'), status: document.getElementById('sw-fel-status'), sub: document.getElementById('sw-fel-sub') }
  };
  function fmtShortDate(ts) {
    var d = ts ? new Date(ts) : null;
    if (!d || isNaN(d.getTime())) return '';
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    return dd + '.' + mm + '.' + d.getFullYear();
  }
  // Deaths tile's number+unit is re-derived from the last statwall payload on
  // every 1s tick too (see the age-ticker interval below) — same "every
  // relative clock on this page keeps counting between polls" rule
  // taskAge/refreshTimestamps/econ-last already follow, even though at
  // day/hour granularity a 20s poll gap would rarely be visible either way.
  var lastStatWall = null;
  function tickDeathsTile() {
    if (!lastStatWall) return;
    var dt = lastStatWall.deaths || {};
    var since = dt.sinceTs ? Date.parse(dt.sinceTs) : NaN;
    if (!isFinite(since)) { setText(swEls.deaths.num, '—'); setText(swEls.deaths.unit, ''); return; }
    var ms = Math.max(0, Date.now() - since);
    var days = Math.floor(ms / 86400000);
    if (days >= 1) {
      setText(swEls.deaths.num, String(days));
      setText(swEls.deaths.unit, days === 1 ? 'Tag' : 'Tage');
    } else {
      setText(swEls.deaths.num, String(Math.floor(ms / 3600000)));
      setText(swEls.deaths.unit, 'Std');
    }
  }
  function paintStatWall(data) {
    // A transient fetch failure (network hiccup, panel restart mid-poll)
    // keeps whatever was last painted rather than blanking a wall built
    // specifically to be glanceable — a flicker to dashes would be worse
    // than one stale poll.
    if (!data || data.ok === false) return;
    lastStatWall = data;

    var dt = data.deaths || {};
    tickDeathsTile();
    setText(swEls.deaths.sub, dt.everDied
      ? ('letzter Tod' + (dt.lastBot ? ' (' + dt.lastBot + ')' : '') + ' — Zähler läuft seitdem')
      : ('0 Tode seit Relaunch (' + fmtShortDate(dt.sinceTs) + ')'));

    var ore = data.ore || {};
    swEls.ore.tile.hidden = !!ore.missing;
    if (!ore.missing) {
      var oreErr = ore.ok === false;
      setText(swEls.ore.num, oreErr ? '—' : String(ore.total));
      var oreStale = !oreErr && typeof ore.ageMs === 'number' && typeof ore.staleMs === 'number' && ore.ageMs > ore.staleMs;
      setText(swEls.ore.sub, oreErr ? (ore.error || 'audit unavailable') : ('Snapshot ' + fmtDur(ore.ageMs) + ' alt'));
      setCls(swEls.ore.tile, 'sw-tile' + (oreErr || oreStale ? ' sw-warn' : ''));
    }

    // Bread — same Vault source/staleness as ore (audit-snapshot only, per
    // the launch brief; see panel-data.mjs's vaultTile()/BREAD_ITEMS comment
    // for how this differs from PANEL_V3_SPEC.md §3.3's fuller "banked +
    // carried" recommendation).
    var bread = data.bread || {};
    swEls.bread.tile.hidden = !!bread.missing;
    if (!bread.missing) {
      var breadErr = bread.ok === false;
      setText(swEls.bread.num, breadErr ? '—' : String(bread.total));
      var breadStale = !breadErr && typeof bread.ageMs === 'number' && typeof bread.staleMs === 'number' && bread.ageMs > bread.staleMs;
      setText(swEls.bread.sub, breadErr ? (bread.error || 'audit unavailable') : ('Snapshot ' + fmtDur(bread.ageMs) + ' alt'));
      setCls(swEls.bread.tile, 'sw-tile' + (breadErr || breadStale ? ' sw-warn' : ''));
    }

    var missions = data.missionsToday || {};
    swEls.missions.tile.hidden = !!missions.missing;
    if (!missions.missing) setText(swEls.missions.num, String(missions.count));

    // FEL relation — hidden when the hand-maintained file (G4) has never
    // been written, or on a genuine read/parse error (both distinct from "a
    // real status exists"). Status word drives the tile's accent colour via
    // a fel-<status> class (tokens in :root); an unrecognised status string
    // still renders (no CSS match = default border, never a broken tile).
    var fel = data.fel || {};
    var felHide = !!fel.missing || fel.ok === false || !fel.data;
    swEls.fel.tile.hidden = felHide;
    if (!felHide) {
      var status = fel.data.status || 'unknown';
      setText(swEls.fel.status, status);
      setCls(swEls.fel.tile, 'sw-tile fel-' + status);
      setText(swEls.fel.sub, fel.data.headline || '');
    }
  }
  // Rides the same slower cadence as Economy (§3.2/§3.3's own cadence note:
  // none of these five sources changes sub-minute — deaths/missions files
  // only get written on a death/task-finish event, Vault only on an audit
  // run, fel-relation.json only by hand).
  function refreshStatWall() {
    return fetch('/api/statwall')
      .then(function (r) { return r.json(); })
      .catch(function () { return null; })
      .then(paintStatWall);
  }

  var tick = document.getElementById('tick');
  var lastBots = [];

  function refresh() {
    return Promise.all([
      fetch('/api/fleet').then(function (r) { return r.json(); }),
      fetch('/api/alerts').then(function (r) { return r.json(); }).catch(function () { return { alerts: [] }; }),
      fetch('/api/todo').then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: 'unreachable', doing: [], todo: [], done: [] }; }),
      fetch('/api/vault').then(function (r) { return r.json(); }).catch(function () { return { ok: false, missing: false, error: 'unreachable' }; })
    ]).then(function (out) {
      var fleet = out[0], al = out[1], td = out[2], vt = out[3];
      lastBots = fleet.bots || [];
      lastBots.forEach(paint);

      var s = fleet.summary || {};
      setText(document.getElementById('s-online'), (s.online || 0) + '/' + (s.total || 0));
      setText(document.getElementById('s-idle'), String(s.idle || 0));
      setText(document.getElementById('s-iron'), String(s.iron_ingot || 0));
      // Quota comes from the fleet payload itself (fleet.quota.iron_ingot),
      // not a server-templated constant — this script is now a plain static
      // file with no per-request interpolation, and the payload already
      // carries the same number the page's header span was rendered with.
      var quota = (fleet.quota && fleet.quota.iron_ingot) || 1;
      var pct = Math.max(0, Math.min(100, ((s.iron_ingot || 0) / quota) * 100));
      document.getElementById('s-iron-bar').style.width = pct + '%';
      setText(document.getElementById('s-when'), new Date().toLocaleTimeString());
      if (al.file) setText(document.getElementById('alert-src'), al.file.split(/[\\/]/).slice(-2).join('/') + ' + live bot errors');
      paintAlerts(al.alerts || [], lastBots);
      paintBoard(td);
      paintVault(vt);

      tick.classList.add('live');
      setTimeout(function () { tick.classList.remove('live'); }, 450);
    }).catch(function () {
      setText(document.getElementById('s-when'), 'panel unreachable');
    });
  }

  // Age labels tick locally between polls so "running 1m 4s" keeps counting.
  // The deaths tile's day/hour counter rides the same 1s tick for the same
  // reason (see tickDeathsTile's own comment).
  setInterval(function () {
    lastBots.forEach(function (b) {
      var c = cards[String(b.port)];
      if (!c || b.offline) return;
      // taskAge() assumes the mineflayer currentTask shape (.state/
      // .finishedAt) — a baritone bot's currentTask is always null (see
      // pollBot()'s baritone branch), so calling it here would silently
      // blank out whatever paintBaritoneCard() just set, once a second,
      // forever. Same "running Xs" reasoning, different data source.
      setText(c.age, b.kind === 'baritone' ? fmtBaritoneAge(b) : taskAge(b));
    });
    tickDeathsTile();
  }, 1000);

  // Economy rides its own, slower timer (architecture note, §3.2's cadence
  // recommendation) — ledger files only change on a deposit/withdraw event,
  // not sub-second like task status, so re-scanning them at the main loop's
  // 3s cadence would be pure waste, not diligence.
  function refreshEconomy() {
    return fetch('/api/economy')
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: 'unreachable' }; })
      .then(paintEconomy);
  }

  refresh();
  setInterval(refresh, 3000);
  refreshEconomy();
  setInterval(refreshEconomy, 20000);
  refreshStatWall();
  setInterval(refreshStatWall, 20000);
})();
