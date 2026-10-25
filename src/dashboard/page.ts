/**
 * Single-file dashboard SPA: dark theme, system fonts, hand-rolled SVG charts,
 * zero external requests (no CDN fonts, no chart libs) — consistent with the
 * package's all-local ethos. Client JS uses string concatenation (no template
 * literals) so this file stays a plain TS template literal.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi-context-engine · dashboard</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --panel2: #1c2129; --border: #2d333b;
    --text: #e6edf3; --muted: #8b949e; --accent: #4493f8; --green: #3fb950;
    --warn: #d29922; --red: #f85149; --mono: ui-monospace, 'Cascadia Code', Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  a { color: var(--accent); text-decoration: none; }
  header { display: flex; align-items: center; gap: 14px; padding: 12px 20px;
           border-bottom: 1px solid var(--border); background: var(--panel); flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .sub { color: var(--muted); font-size: 12px; }
  .badge { font-size: 11px; padding: 2px 9px; border-radius: 10px; border: 1px solid var(--border);
           color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
  .badge .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .badge.live .dot { background: var(--green); }
  .badge.indexing .dot { background: var(--warn); animation: pulse 1.2s infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  .spacer { flex: 1; }
  .btn { font-size: 12px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--border);
         background: var(--panel2); color: var(--text); cursor: pointer; }
  .btn:hover { border-color: var(--accent); }
  nav { display: flex; gap: 2px; padding: 0 20px; border-bottom: 1px solid var(--border); background: var(--panel); }
  nav button { appearance: none; border: none; background: none; color: var(--muted); font: inherit;
               padding: 9px 14px; cursor: pointer; border-bottom: 2px solid transparent; }
  nav button.active { color: var(--text); border-bottom-color: var(--accent); }
  nav button:hover { color: var(--text); }
  main { padding: 20px; max-width: 1200px; margin: 0 auto; }
  .grid { display: grid; gap: 14px; }
  .cards { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card .k { color: var(--muted); font-size: 12px; }
  .card .v { font-size: 22px; font-weight: 650; margin-top: 2px; }
  .card .s { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .panel h2 { font-size: 13px; margin: 0 0 12px; color: var(--muted); font-weight: 600;
              text-transform: uppercase; letter-spacing: .04em; }
  .two-col { grid-template-columns: 1fr 1fr; }
  @media (max-width: 860px) { .two-col { grid-template-columns: 1fr; } }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px;
       padding: 6px 10px; border-bottom: 1px solid var(--border); }
  td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  code, .path { font-family: var(--mono); font-size: 12px; }
  .path { word-break: break-all; }
  .bar-track { background: var(--panel2); border-radius: 4px; height: 8px; overflow: hidden; min-width: 60px; }
  .bar-fill { height: 100%; background: var(--accent); border-radius: 4px; }
  .bar-fill.green { background: var(--green); }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 18px; text-align: center; }
  .donut-wrap { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
  .donut-legend { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .donut-legend b { font-size: 16px; }
  .cfg-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 4px 18px;
              font-size: 12.5px; color: var(--muted); }
  .cfg-list b { color: var(--text); font-weight: 500; }
  .vbars { display: flex; align-items: flex-end; gap: 3px; height: 120px; padding-top: 8px; }
  .vbars .col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
  .vbars .col > div { background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; }
  .vbars .col:hover { outline: 1px solid var(--border); }
  .sess-item { padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
               cursor: pointer; background: var(--panel2); }
  .sess-item:hover { border-color: var(--accent); }
  .sess-item.active { border-color: var(--accent); }
  .sess-item .when { color: var(--muted); font-size: 11.5px; }
  .turn { border-left: 2px solid var(--border); padding: 6px 12px; margin: 8px 0; }
  .turn .tier { font-size: 10.5px; color: var(--accent); text-transform: uppercase; letter-spacing: .05em; }
  .ev { display: inline-block; font-family: var(--mono); font-size: 11px; background: var(--panel2);
        border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; margin: 2px 4px 2px 0; }
  .decision { border-left: 3px solid var(--green); padding: 8px 12px; margin-bottom: 10px;
              background: var(--panel2); border-radius: 0 8px 8px 0; }
  .decision .why { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
  .decision .when { color: var(--muted); font-size: 11px; }
  #toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
           background: var(--panel2); border: 1px solid var(--border); color: var(--text);
           padding: 8px 16px; border-radius: 8px; font-size: 12.5px; display: none; }
</style>
</head>
<body>
<header>
  <h1>pi-context-engine</h1>
  <span class="sub" id="project">…</span>
  <span class="badge" id="state"><span class="dot"></span><span id="state-text">connecting</span></span>
  <span class="spacer"></span>
  <span class="sub" id="counts"></span>
  <a class="btn" href="/api/export" download>Export JSON</a>
</header>
<nav id="nav"></nav>
<main id="main"><div class="empty">Loading…</div></main>
<div id="toast"></div>
<script>
'use strict';
var TABS = ['overview', 'files', 'sessions', 'memory', 'savings'];
var state = { tab: 'overview', sessionId: null, status: null, project: null, filesOffset: 0 };

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmt(n) { return Number(n || 0).toLocaleString(); }
function fmtK(n) {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function fmtUsd(v) {
  if (!isFinite(v)) return '$0';
  if (v > 0 && v < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}
function fmtWhen(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleString();
}
function api(path) {
  return fetch(path).then(function (r) {
    if (!r.ok) return r.json().then(function (b) { throw new Error(b.error || ('HTTP ' + r.status)); });
    return r.json();
  });
}
function toast(msg) {
  var t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast._h);
  toast._h = setTimeout(function () { t.style.display = 'none'; }, 3500);
}
function pctBar(v, max, cls) {
  var w = max > 0 ? Math.max(1, Math.round((v / max) * 100)) : 0;
  return '<div class="bar-track"><div class="bar-fill ' + (cls || '') + '" style="width:' + w + '%"></div></div>';
}

/* ── header / status poll ─────────────────────────────────────────── */
function renderStatus(st) {
  state.status = st;
  $('project').textContent = st.project + ' · ' + st.projectDir;
  var badge = $('state');
  if (st.indexing) { badge.className = 'badge indexing'; $('state-text').textContent = 'indexing…'; }
  else if (st.chunks > 0) { badge.className = 'badge live'; $('state-text').textContent = 'live'; }
  else { badge.className = 'badge'; $('state-text').textContent = 'no index'; }
  $('counts').textContent = fmt(st.chunks) + ' chunks · ' + fmt(st.files) + ' files';
  // Project switch (live engine replaced): drop session selection and refetch
  // the ACTIVE tab, or project A's rows stay on screen under project B's label.
  var projectChanged = state.project !== null && state.project !== st.project;
  state.project = st.project;
  if (projectChanged) {
    state.sessionId = null;
    if (state.tab !== 'overview') { switchTab(state.tab); return; }
  }
  if (state.tab === 'overview') renderOverview(st);
}

function pollStatus() {
  api('/api/status').then(renderStatus).catch(function (e) {
    $('state-text').textContent = 'offline';
    if (e && e.message) toast(e.message);
  });
}

/* ── tabs ─────────────────────────────────────────────────────────── */
function renderNav() {
  var nav = $('nav');
  nav.innerHTML = '';
  TABS.forEach(function (t) {
    var b = document.createElement('button');
    b.textContent = t.charAt(0).toUpperCase() + t.slice(1);
    b.className = t === state.tab ? 'active' : '';
    b.onclick = function () { switchTab(t); };
    nav.appendChild(b);
  });
}

function switchTab(tab) {
  state.tab = tab;
  renderNav();
  $('main').innerHTML = '<div class="empty">Loading…</div>';
  if (tab === 'overview') { if (state.status) renderOverview(state.status); else pollStatus(); }
  else if (tab === 'files') loadFiles();
  else if (tab === 'sessions') loadSessions();
  else if (tab === 'memory') loadMemory();
  else if (tab === 'savings') loadSavings();
}

function setMain(html) { $('main').innerHTML = html; }

/* ── overview ─────────────────────────────────────────────────────── */
function donut(pct) {
  var r = 52, c = 2 * Math.PI * r;
  var p = Math.max(0, Math.min(100, pct || 0));
  return '<svg width="130" height="130" viewBox="0 0 130 130">' +
    '<circle cx="65" cy="65" r="' + r + '" fill="none" stroke="#21262d" stroke-width="14"/>' +
    '<circle cx="65" cy="65" r="' + r + '" fill="none" stroke="#3fb950" stroke-width="14" ' +
    'stroke-linecap="round" stroke-dasharray="' + (c * p / 100).toFixed(1) + ' ' + c.toFixed(1) + '" ' +
    'transform="rotate(-90 65 65)"/>' +
    '<text x="65" y="62" text-anchor="middle" fill="#e6edf3" font-size="24" font-weight="650">' + p + '%</text>' +
    '<text x="65" y="82" text-anchor="middle" fill="#8b949e" font-size="10">tokens saved</text></svg>';
}

function renderOverview(st) {
  var s = st.stats;
  var pct = s.savingsPct == null ? 0 : s.savingsPct;
  setMain(
    '<div class="grid" style="margin-bottom:14px">' +
      '<div class="panel"><div class="donut-wrap">' + donut(pct) +
        '<div class="donut-legend">' +
          '<div><b>' + fmtK(s.fullFileTokensSaved) + '</b> input tokens saved <span class="muted">(full-file baseline)</span></div>' +
          '<div class="muted">' + fmt(s.fullFileTokens) + ' full-file → ' + fmt(s.servedTokens) + ' served</div>' +
          '<div class="muted">' + fmt(s.queries) + ' quer' + (s.queries === 1 ? 'y' : 'ies') + ' recorded' +
            (s.savingsPct == null ? ' — savings appear after the first context_search' : '') + '</div>' +
        '</div></div></div>' +
      '<div class="grid cards">' +
        card('Chunks', fmt(st.chunks), st.files + ' files indexed') +
        card('Queries', fmt(s.queries), 'this project, all sessions') +
        card('Served', fmtK(s.servedTokens), 'raw would be ' + fmtK(s.rawTokens)) +
        card('Index state', st.indexing ? 'Indexing…' : (st.chunks > 0 ? 'Live' : 'Empty'),
             'watch ' + (st.config.watch ? 'on' : 'off') + ' · auto ' + (st.config.autoIndex ? 'on' : 'off')) +
      '</div>' +
    '</div>' +
    '<div class="panel"><h2>Configuration</h2><div class="cfg-list">' +
      cfg('Embedding', st.config.embeddingModel) +
      cfg('Chunking', st.config.chunking) +
      cfg('Compression', st.config.compression) +
      cfg('Top-K', st.config.topK) +
      cfg('Rerank', st.config.rerank) +
      cfg('Storage', '<span class="path">' + esc(st.storageDir) + '</span>') +
    '</div></div>'
  );
}
function card(k, v, s) {
  return '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
         (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
}
function cfg(k, v) { return '<div>' + esc(k) + ': <b>' + v + '</b></div>'; }

/* ── files ────────────────────────────────────────────────────────── */
var FILES_PAGE = 500;
function filesTableHtml(d) {
  var max = d.files.length > 0 ? d.files[0].chunks : 0;
  return d.files.map(function (f) {
    return '<tr><td class="path">' + esc(f.filePath) + '</td>' +
      '<td class="num" style="width:70px">' + fmt(f.chunks) + '</td>' +
      '<td style="width:180px">' + pctBar(f.chunks, max) + '</td></tr>';
  }).join('');
}
function loadFiles() {
  var tab = state.tab;
  state.filesOffset = 0;
  api('/api/files?limit=' + FILES_PAGE).then(function (d) {
    if (state.tab !== tab) return; // tab switched while the request was in flight
    if (d.files.length === 0) { setMain('<div class="empty">No files indexed yet.</div>'); return; }
    setMain('<div class="panel"><h2>' + fmt(d.total) + ' files · ' + fmt(d.chunks) + ' chunks</h2>' +
      '<table><tr><th>File</th><th class="num">Chunks</th><th></th></tr><tbody id="files-body">' +
      filesTableHtml(d) + '</tbody></table>' + moreFilesHtml(d) + '</div>');
    state.filesOffset = d.offset + d.files.length;
    var more = $('files-more');
    if (more) more.onclick = appendFiles;
  }).catch(errPanel);
}
function moreFilesHtml(d) {
  var remaining = d.total - (d.offset + d.files.length);
  if (remaining <= 0) return '';
  return '<div style="margin-top:12px"><button class="btn" id="files-more">Show ' + fmt(remaining) +
         ' more files</button></div>';
}
function appendFiles() {
  var tab = state.tab;
  api('/api/files?limit=' + FILES_PAGE + '&offset=' + state.filesOffset).then(function (d) {
    if (state.tab !== tab) return;
    var body = $('files-body');
    if (!body) return;
    body.insertAdjacentHTML('beforeend', filesTableHtml(d));
    state.filesOffset = d.offset + d.files.length;
    var more = $('files-more');
    if (more) more.parentNode.remove();
    var panel = body.closest('.panel');
    if (panel) panel.insertAdjacentHTML('beforeend', moreFilesHtml(d));
    var next = $('files-more');
    if (next) next.onclick = appendFiles;
  }).catch(errPanel);
}

/* ── sessions ─────────────────────────────────────────────────────── */
function loadSessions() {
  var tab = state.tab;
  api('/api/sessions').then(function (d) {
    if (state.tab !== tab) return; // tab switched while the request was in flight
    if (d.sessions.length === 0) { setMain('<div class="empty">No sessions recorded yet.</div>'); return; }
    var items = d.sessions.map(function (s) {
      var active = s.id === d.activeSessionId;
      return '<div class="sess-item' + (s.id === state.sessionId ? ' active' : '') + '" data-id="' + esc(s.id) + '">' +
        '<div><b>' + esc(s.project) + '</b> <span class="muted">· ' + esc(s.status) +
          (active ? ' · current' : '') + '</span></div>' +
        '<div class="when">' + fmtWhen(s.started_at) + ' · ' + s.promptCount + (s.promptCount === 1 ? ' prompt' : ' prompts') +
          (s.rollup ? ' · ' + esc(String(s.rollup).slice(0, 80)) : '') + '</div></div>';
    }).join('');
    setMain('<div class="grid two-col"><div class="grid" id="sess-list" style="gap:8px">' + items + '</div>' +
            '<div class="panel" id="sess-detail"><div class="empty">Select a session</div></div></div>');
    Array.prototype.forEach.call(document.querySelectorAll('.sess-item'), function (el) {
      el.onclick = function () { openSession(el.getAttribute('data-id')); };
    });
    var keep = state.sessionId && d.sessions.some(function (s) { return s.id === state.sessionId; });
    openSession(keep ? state.sessionId : d.sessions[0].id, true);
  }).catch(errPanel);
}

function openSession(id, silent) {
  state.sessionId = id;
  Array.prototype.forEach.call(document.querySelectorAll('.sess-item'), function (el) {
    el.className = 'sess-item' + (el.getAttribute('data-id') === id ? ' active' : '');
  });
  api('/api/sessions/' + encodeURIComponent(id)).then(function (d) {
    var box = $('sess-detail');
    if (!box || state.sessionId !== id) return; // selection moved on before the response landed
    var html = '';
    if (d.session) {
      html += '<h2>' + esc(d.session.project) + ' · ' + esc(d.session.status) + '</h2>' +
        '<div class="muted" style="font-size:12px;margin-bottom:8px">' + fmtWhen(d.session.started_at) +
        ' → ' + (d.session.ended_at ? fmtWhen(d.session.ended_at) : 'open') + '</div>';
      if (d.session.rollup) html += '<div class="turn">' + esc(d.session.rollup) + '</div>';
    }
    if (d.turns.length === 0 && d.events.length === 0) {
      html += '<div class="empty">No turns or events captured for this session.</div>';
    }
    if (d.turns.length > 0) {
      html += '<h2 style="margin-top:14px">Turns</h2>';
      d.turns.forEach(function (t) {
        html += '<div class="turn"><div class="tier">turn ' + t.promptNumber + ' · ' + esc(t.tier) + '</div>' +
                esc(t.summary) + '</div>';
      });
    }
    if (d.events.length > 0) {
      html += '<h2 style="margin-top:14px">' + d.events.length + ' tool events</h2><div>';
      d.events.forEach(function (e) {
        html += '<span class="ev" title="' + esc(e.createdAt) + '">' + esc(e.tool) + '#' + e.id +
                (e.hasPayload ? '' : ' ·') + '</span>';
      });
      html += '</div><div class="muted" style="font-size:11px;margin-top:6px">· = payload aged out, summary only</div>';
    }
    box.innerHTML = html;
  }).catch(function (e) { if (!silent) toast(e.message); });
}

/* ── memory ───────────────────────────────────────────────────────── */
function loadMemory() {
  var tab = state.tab;
  api('/api/decisions').then(function (d) {
    if (state.tab !== tab) return; // tab switched while the request was in flight
    var html = '<div class="grid two-col"><div class="panel"><h2>Decisions</h2>';
    if (d.decisions.length === 0 && d.consolidated.length === 0) {
      html += '<div class="empty">No recorded decisions yet. The agent saves them with record_decision.</div>';
    }
    d.decisions.forEach(function (x) {
      html += '<div class="decision"><div>' + esc(x.decision) +
        ' <span class="muted">· ' + esc(x.source) + '</span></div>' +
        '<div class="why">' + esc(x.reason) + '</div>' +
        '<div class="when">' + esc(x.createdAt) + '</div></div>';
    });
    d.consolidated.forEach(function (x) {
      html += '<div class="decision"><div>' + esc(x.decision) + ' <span class="muted">· archive</span></div>' +
        '<div class="why">' + esc(x.reason) + '</div></div>';
    });
    html += '</div><div class="panel"><h2>Code areas</h2>';
    if (d.codeAreas.length === 0) html += '<div class="empty">No recorded code areas yet.</div>';
    else {
      html += '<table><tr><th>File</th><th>Description</th></tr>';
      d.codeAreas.forEach(function (x) {
        html += '<tr><td class="path">' + esc(x.filePath) + '</td><td>' + esc(x.description) + '</td></tr>';
      });
      html += '</table>';
    }
    html += '</div></div>';
    setMain(html);
  }).catch(errPanel);
}

/* ── savings ──────────────────────────────────────────────────────── */
function loadSavings() {
  var tab = state.tab;
  api('/api/savings').then(function (d) {
    if (state.tab !== tab) return; // tab switched while the request was in flight
    var t = d.totals;
    var html = '<div class="grid cards" style="margin-bottom:14px">' +
      card('Saved', fmtK(t.savedTokens), 'full-file baseline') +
      card('Estimated value', fmtUsd(t.savedUsd), d.pricing.model + ' input @ $' + d.pricing.inputUsdPer1M + '/1M') +
      card('Savings rate', t.savingsPct == null ? '—' : t.savingsPct + '%', 'served vs full files') +
      '</div>';
    if (d.buckets.length > 0) {
      var max = Math.max.apply(null, d.buckets.map(function (b) { return b.saved; }));
      var rows = d.buckets.map(function (b) {
        return '<tr><td>' + esc(b.bucket) + '</td><td class="num">' + fmt(b.calls) + '</td>' +
          '<td class="num">' + fmtK(b.baseline) + '</td><td class="num">' + fmtK(b.served) + '</td>' +
          '<td class="num">' + fmtK(b.saved) + '</td><td class="num">' + fmtUsd(b.savedUsd) + '</td>' +
          '<td style="width:160px">' + pctBar(b.saved, max, 'green') + '</td></tr>';
      }).join('');
      html += '<div class="panel" style="margin-bottom:14px"><h2>By bucket</h2><table>' +
        '<tr><th>Bucket</th><th class="num">Calls</th><th class="num">Baseline</th><th class="num">Served</th>' +
        '<th class="num">Saved</th><th class="num">Value</th><th></th></tr>' + rows + '</table></div>';
    }
    if (d.byDay.length > 0) {
      var dmax = Math.max.apply(null, d.byDay.map(function (x) { return x.saved; }));
      var cols = d.byDay.map(function (x) {
        var h = dmax > 0 ? Math.max(2, Math.round((x.saved / dmax) * 100)) : 2;
        return '<div class="col" title="' + x.day + ': ' + fmt(x.saved) + ' tokens"><div style="height:' + h + '%"></div></div>';
      }).join('');
      html += '<div class="panel"><h2>Saved tokens · last 30 days</h2><div class="vbars">' + cols + '</div>' +
        '<div class="muted" style="display:flex;justify-content:space-between;font-size:11px;margin-top:6px">' +
        '<span>' + esc(d.byDay[0].day) + '</span><span>' + esc(d.byDay[d.byDay.length - 1].day) + '</span></div></div>';
    }
    if (d.buckets.length === 0 && d.byDay.length === 0) {
      html = '<div class="empty">No savings recorded yet — they accumulate as the agent uses context_search.</div>';
    }
    setMain(html);
  }).catch(errPanel);
}

function errPanel(e) {
  setMain('<div class="empty">Failed to load: ' + esc(e && e.message ? e.message : e) + '</div>');
}

/* ── boot ─────────────────────────────────────────────────────────── */
renderNav();
pollStatus();
setInterval(pollStatus, 5000);
</script>
</body>
</html>`;
