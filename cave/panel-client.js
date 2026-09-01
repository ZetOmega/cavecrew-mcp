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

  function build(bot) {
    var c = el('div', 'card');
    var r1 = el('div', 'row1');
    var dot = el('span', 'dot');
    var name = el('span', 'name');
    var port = el('span', 'port');
    var age = el('span', 'age');
    r1.appendChild(dot); r1.appendChild(name); r1.appendChild(port); r1.appendChild(age);

    var pos = el('div', 'pos');

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

    c.appendChild(r1); c.appendChild(pos); c.appendChild(delta); c.appendChild(vitals);
    c.appendChild(task); c.appendChild(errBox); c.appendChild(meta);
    c.appendChild(inv); c.appendChild(evList); c.appendChild(acts);
    grid.appendChild(c);

    return { root: c, dot: dot, name: name, port: port, age: age, pos: pos,
      d30v: d30v, d60v: d60v,
      hp: hp, fd: fd, task: task, tkind: tkind, tstate: tstate, tsrc: tsrc, tdetail: tdetail,
      errBox: errBox, deaths: deaths, lastDeath: lastDeath, guard: guard, engine: engine,
      inv: inv, invSig: null,
      evToggle: evToggle, evList: evList, evState: evState, evSig: null,
      wake: wake, stop: stop, flash: flash };
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

  function paint(bot) {
    var key = String(bot.port);
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

    // Inventory: top 10 stacks by count, rebuilt only when it actually changed.
    var items = (bot.inventory || []).slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 10);
    var sig = items.map(function (i) { return i.name + ':' + i.count; }).join('|');
    if (sig !== c.invSig) {
      c.invSig = sig;
      c.inv.textContent = '';
      if (!items.length) {
        setCls(c.inv, 'inv-empty');
        c.inv.textContent = bot.offline ? '' : 'empty';
      } else {
        setCls(c.inv, 'inv');
        items.forEach(function (i) {
          var chip = el('span', 'chip');
          chip.appendChild(el('span', 'n', i.name));
          chip.appendChild(el('span', 'c', String(i.count)));
          c.inv.appendChild(chip);
        });
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
    var evSig = events.map(function (e) { return e.seq; }).join('|');
    if (evSig !== c.evSig) {
      c.evSig = evSig;
      c.evList.textContent = '';
      if (!events.length) {
        c.evList.appendChild(el('div', 'ev-empty', 'no events yet'));
      } else {
        events.slice().reverse().forEach(function (e) {
          var cls = 'ev-item' + (ALERT_EVENT_TYPES[e.type] ? ' warn' : '') + (SUPPRESSED_RE.test(e.msg) ? ' suppressed' : '');
          var row = el('div', cls);
          var et = el('span', 'et');
          et.dataset.ts = e.ts;
          var em = el('span', 'em', e.msg);
          row.appendChild(et); row.appendChild(em);
          c.evList.appendChild(row);
        });
      }
    }
    var etNodes = c.evList.querySelectorAll('.et');
    for (var ei = 0; ei < etNodes.length; ei++) {
      var ts = etNodes[ei].dataset.ts;
      if (ts) setText(etNodes[ei], fmtDur(Date.now() - Date.parse(ts)) + ' ago');
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
        list.slice(0, ITEM_CAP).forEach(function (it) {
          var chip = el('span', 'chip');
          chip.appendChild(el('span', 'n', it.name));
          chip.appendChild(el('span', 'c', String(it.count)));
          items.appendChild(chip);
        });
        if (list.length > ITEM_CAP) {
          items.appendChild(el('span', 'chip', '+' + (list.length - ITEM_CAP) + ' more'));
        }
        block.appendChild(items);
      }
      vaultChestsEl.appendChild(block);
    });
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
  setInterval(function () {
    lastBots.forEach(function (b) {
      var c = cards[String(b.port)];
      if (c && !b.offline) setText(c.age, taskAge(b));
    });
  }, 1000);

  refresh();
  setInterval(refresh, 3000);
})();
