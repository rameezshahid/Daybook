"use strict";

/* ------------------------------------------------------------------ config */

// Ross Cameron's 5 pillars for small caps. Large caps never have a scarce
// float, so pillar 5 is off there and the demand thresholds are scaled down.
const DEFAULTS = {
  small: { p1on: true, minChange: 10, p2on: true, minRvol: 5, p3on: true,
           p4on: true, priceMin: 2, priceMax: 20, p5on: true, maxFloat: 20,
           alertMinScore: 3, runPct: 3, runMins: 5 },
  large: { p1on: true, minChange: 3, p2on: true, minRvol: 2, p3on: true,
           p4on: true, priceMin: 10, priceMax: 5000, p5on: false, maxFloat: 500,
           alertMinScore: 3, runPct: 1.5, runMins: 5 },
};
const POLL_MS = 5000;
const FEED_MS = 30000;
const COOLDOWN = { pillars: 15 * 60e3, hod: 60e3, run: 5 * 60e3 };
const LABELS = { small: "Small Caps", large: "Large Caps" };

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const rules = {
  small: { ...DEFAULTS.small, ...store.get("md.rules.small", {}) },
  large: { ...DEFAULTS.large, ...store.get("md.rules.large", {}) },
};

const mk = () => ({ data: null, lastTs: 0, hist: new Map(), highs: new Map(), passing: new Set(),
                    cool: new Map(), alerts: [], seeded: false, unseen: 0,
                    sort: { key: "changePct", dir: -1 } });
const U = { small: mk(), large: mk() };
let active = store.get("md.tab", "small");
if (!U[active]) active = "small";
let selected = null;          // { sym, u }
let app = store.get("md.app", "scanner");      // "scanner" or "journal"
let soundOn = store.get("md.sound", true);
let interval = store.get("md.interval", "5");
let feedItems = [];
const startedAt = Date.now();

/* --------------------------------------------------------------- utilities */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function big(n) {
  if (n == null || isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}
const px = (n) => n == null ? "—" : n >= 1 ? n.toFixed(2) : n.toFixed(4);
const pct = (n, d = 2) => n == null || isNaN(n) ? "—" : (n > 0 ? "+" : "") + n.toFixed(d) + "%";
const mult = (n) => n == null || !isFinite(n) ? "—" : n >= 100 ? n.toFixed(0) + "×" : n.toFixed(1) + "×";
const cls = (n) => n > 0 ? "up" : n < 0 ? "dn" : "";

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const etShort = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const etDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

function ago(sec) {
  const s = Date.now() / 1000 - sec;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return etDay.format(sec * 1000);
}

/* ----------------------------------------------------------------- pillars */

function pillars(r, R) {
  const p = [
    !R.p1on || (r.changePct ?? -1e9) >= R.minChange,
    !R.p2on || (r.rvolRate ?? 0) >= R.minRvol,
    !R.p3on || !!r.hasCatalyst,
    !R.p4on || (r.price >= R.priceMin && r.price <= R.priceMax),
    !R.p5on || (r.float != null && r.float <= R.maxFloat * 1e6),
  ];
  const on = [R.p1on, R.p2on, R.p3on, R.p4on, R.p5on];
  return { p, on, score: p.filter(Boolean).length };
}

function rulesSummary(R) {
  const s = [];
  if (R.p1on) s.push(`≥${R.minChange}%`);
  if (R.p2on) s.push(`≥${R.minRvol}× RVOL`);
  if (R.p3on) s.push("news");
  if (R.p4on) s.push(`$${R.priceMin}–${R.priceMax}`);
  if (R.p5on) s.push(`float <${R.maxFloat}M`);
  return s.join(" · ") || "no rules on";
}

/* ------------------------------------------------------------------ alerts */

let audio;
function beep(kind) {
  if (!soundOn) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const tones = { pillars: [880, 1320], hod: [1046], run: [660, 880] }[kind] || [880];
    tones.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = "sine";
      const t = audio.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(g).connect(audio.destination);
      o.start(t); o.stop(t + 0.12);
    });
  } catch { /* audio blocked until the first click */ }
}

function pushAlert(u, S, type, r, score, note) {
  const now = Date.now();
  const key = type + ":" + r.symbol;
  if (now - (S.cool.get(key) || 0) < COOLDOWN[type]) return false;
  S.cool.set(key, now);
  S.alerts.unshift({ t: now, type, sym: r.symbol, price: r.price, changePct: r.changePct,
                     rvol: r.rvolRate, float: r.float, volume: r.volume, score, note, fresh: true });
  S.alerts.length = Math.min(S.alerts.length, 300);
  if (note !== "on load") {
    if (u !== active) S.unseen++;
    return true;
  }
  return false;
}

function detect(u) {
  const S = U[u], R = rules[u], d = S.data;
  if (!d || d.ts === S.lastTs) return;           // same server snapshot as last poll
  S.lastTs = d.ts;
  const now = Date.now();
  const nowPassing = new Set();
  let sound = null;
  const winMs = R.runMins * 60e3;

  for (const r of d.rows) {
    const { score } = pillars(r, R);
    if (score === 5 && r.newsChecked !== false) {
      nowPassing.add(r.symbol);
      if (!S.passing.has(r.symbol) && pushAlert(u, S, "pillars", r, score, S.seeded ? "" : "on load")) sound = "pillars";
    }

    // price history for the "running up" window
    let h = S.hist.get(r.symbol);
    if (!h) S.hist.set(r.symbol, (h = []));
    h.push({ t: now, p: r.price });
    while (h.length && now - h[0].t > winMs + 60e3) h.shift();

    const prevHigh = S.highs.get(r.symbol);
    S.highs.set(r.symbol, r.high);
    if (!S.seeded || score < R.alertMinScore) continue;

    if (prevHigh != null && r.high > prevHigh * 1.0005 && r.price >= r.high * 0.995) {
      if (pushAlert(u, S, "hod", r, score, "new high of day") && !sound) sound = "hod";
    }
    const base = h.find((x) => now - x.t <= winMs);
    if (base && base.p > 0 && h.length > 1) {
      const g = (r.price / base.p - 1) * 100;
      if (g >= R.runPct && pushAlert(u, S, "run", r, score, `+${g.toFixed(1)}% in ${Math.round((now - base.t) / 60e3) || 1}m`) && !sound) sound = "run";
    }
  }
  S.passing = nowPassing;
  // Stay quiet until the first round of news/float lookups has landed, or
  // every stock that picks up its news pillar would fire at once.
  if (!d.pending || now - startedAt > 90e3) S.seeded = true;
  if (sound) beep(sound);
}

/* --------------------------------------------------------------- rendering */

const COLS = [
  { k: "changePct", h: "Chg %", f: (r) => pct(r.changePct, 1), c: (r) => chgCell(r.changePct) },
  { k: "symbol", h: "Symbol", l: true, f: (r) => symCell(r), c: () => "sym" },
  { k: "price", h: "Price", f: (r) => px(r.price), c: (r, P) => P.p[3] ? "" : "miss" },
  { k: "volume", h: "Volume", f: (r) => big(r.volume), c: (r) => volCell(r) },
  { k: "float", h: "Float", f: (r) => r.float == null ? (r.floatChecked ? "n/a" : "…") : big(r.float), c: (r, P, R) => R.p5on && P.p[4] ? "hit" : "" },
  { k: "rvolRate", h: "RVOL", f: (r) => mult(r.rvolRate), c: (r, P) => P.p[1] ? "up" : "miss" },
  { k: "gapPct", h: "Gap %", f: (r) => pct(r.gapPct, 1), c: (r) => cls(r.gapPct) },
  { k: "shortPct", h: "Short", f: (r) => r.shortPct == null ? "—" : (r.shortPct * 100).toFixed(1) + "%", c: () => "", wide: true },
  { k: "score", h: "Pillars", f: (r, P) => dots(P), c: () => "" },
];

function chgCell(v) {
  return v >= 0 ? "chg" : "dn";
}
function chgStyle(v) {
  if (!(v > 0)) return "";
  const a = Math.min(0.85, 0.12 + Math.log10(1 + v) / 2.6);
  return `background:rgba(25,195,125,${a.toFixed(2)});color:${a > 0.5 ? "#03140b" : "#bdf5d9"}`;
}
function volCell(r) {
  return r.rvolRate >= 5 ? "hit" : "";
}
function symCell(r) {
  const flag = r.hasCatalyst ? '<span class="flag cat" title="News in the last 24h">🔥</span>'
    : r.hasMention ? '<span class="flag men" title="Mentioned in a roundup only">◦</span>' : "";
  return esc(r.symbol) + flag;
}
function dots(P) {
  return `<span class="dots" title="${P.score}/5 pillars">${P.p.map((ok, i) => `<i class="${!P.on[i] ? "" : ok ? "on" : "off"}"></i>`).join("")}</span>`;
}

function sortRows(rows, sort, pmap) {
  const { key, dir } = sort;
  const val = (r) => key === "score" ? pmap.get(r.symbol).score * 1e6 + (r.changePct || 0) : r[key];
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return typeof x === "string" ? dir * x.localeCompare(y) : dir * (x - y);
  });
}

function renderTable(el, rows, cols, S, pmap, R, emptyMsg) {
  const head = "<thead><tr>" + cols.map((c) =>
    `<th data-k="${c.k}" class="${c.l ? "l " : ""}${S.sort.key === c.k ? "sorted" : ""}">${c.h}${S.sort.key === c.k ? (S.sort.dir < 0 ? " ▾" : " ▴") : ""}</th>`).join("") + "</tr></thead>";
  const body = rows.length ? rows.map((r) => {
    const P = pmap.get(r.symbol);
    const sel = selected && selected.sym === r.symbol ? "sel" : "";
    return `<tr data-s="${esc(r.symbol)}" class="${sel}">` + cols.map((c) => {
      const cl = (c.c(r, P, R) || "") + (c.l ? " l" : "");
      const st = c.k === "changePct" ? ` style="${chgStyle(r.changePct)}"` : "";
      return `<td class="${cl}"${st}>${c.f(r, P)}</td>`;
    }).join("") + "</tr>";
  }).join("") : `<tr class="empty"><td colspan="${cols.length}">${emptyMsg}</td></tr>`;
  el.innerHTML = head + "<tbody>" + body + "</tbody>";
}

function renderScans() {
  const S = U[active], R = rules[active], d = S.data;
  $("#rulesSummary").textContent = rulesSummary(R);
  if (!d) {
    $("#gainers").innerHTML = '<tbody><tr class="empty"><td>Loading scanner…</td></tr></tbody>';
    return;
  }
  const pmap = new Map(d.rows.map((r) => [r.symbol, pillars(r, R)]));
  let rows = d.rows;
  if ($("#onlyScore3").checked) rows = rows.filter((r) => pmap.get(r.symbol).score >= 3);
  const g = sortRows(rows, S.sort, pmap);
  renderTable($("#gainers"), g, COLS, S, pmap, R, "Nothing moving yet.");
  $("#gainersCount").textContent = `${rows.length}`;

  const pass = sortRows(d.rows.filter((r) => pmap.get(r.symbol).score === 5), { key: "changePct", dir: -1 }, pmap);
  const pcols = COLS.filter((c) => !c.wide);
  renderTable($("#pillars"), pass, pcols, { sort: { key: "changePct", dir: -1 } }, pmap, R,
    "No stock meets every pillar right now. The best ones usually show up early in the session.");
  $("#pillarsCount").textContent = pass.length ? `${pass.length}` : "";
}

function renderAlerts() {
  const S = U[active];
  const el = $("#alerts");
  const names = { pillars: "5 PILLARS", hod: "NEW HOD", run: "RUNNING UP" };
  const head = "<thead><tr><th class='l'>Time</th><th class='l'>Alert</th><th class='l'>Symbol</th><th>Price</th><th>Chg %</th><th>RVOL</th><th>Float</th><th class='l'>Note</th></tr></thead>";
  const body = S.alerts.length ? S.alerts.slice(0, 150).map((a) => {
    const row = `<tr data-s="${esc(a.sym)}" class="${a.fresh ? "fresh" : ""}"><td class="l">${etFmt.format(a.t)}</td>` +
      `<td class="l"><span class="atype ${a.type}">${names[a.type]}</span></td>` +
      `<td class="l sym">${esc(a.sym)}</td><td>${px(a.price)}</td><td class="${cls(a.changePct)}">${pct(a.changePct, 1)}</td>` +
      `<td>${mult(a.rvol)}</td><td>${big(a.float)}</td><td class="l muted">${esc(a.note || "")}</td></tr>`;
    a.fresh = false;
    return row;
  }).join("") : '<tr class="empty"><td colspan="8">Alerts fire when a stock newly meets all 5 pillars, makes a new high of day, or runs up fast. Keep this tab open.</td></tr>';
  el.innerHTML = head + "<tbody>" + body + "</tbody>";
}

function renderBadges() {
  for (const u of Object.keys(U)) {
    const b = document.querySelector(`[data-badge="${u}"]`);
    b.textContent = u !== active && U[u].unseen ? U[u].unseen : "";
  }
}

function renderStatus() {
  const d = U[active].data;
  const st = d?.marketState || "";
  const pill = $("#mkt");
  const map = { REGULAR: ["MARKET OPEN", "open"], PRE: ["PRE-MARKET", "pre"], PREPRE: ["CLOSED", "closed"],
                POST: ["AFTER HOURS", "post"], POSTPOST: ["CLOSED", "closed"], CLOSED: ["CLOSED", "closed"] };
  const [txt, c] = map[st] || [st || "—", ""];
  pill.textContent = txt;
  pill.className = "pill " + c;

  const banner = $("#banner");
  if (d?.error) {
    banner.hidden = false; banner.className = "banner err";
    banner.textContent = `Data source hiccup (${d.stale ? "showing last good scan" : "no data yet"}): ${d.error}`;
  } else if (st === "PRE" || st === "PREPRE") {
    banner.hidden = false; banner.className = "banner";
    banner.textContent = "Pre-market: Yahoo's screener ranks on the regular session, so today's gappers show up here after 9:30 ET. Use the lookup box to check a pre-market name directly.";
  } else {
    banner.hidden = true;
  }
}

function tickUpdated() {
  const d = U[active].data;
  if (!d) return;
  const s = Math.max(0, Math.round(Date.now() / 1000 - d.ts));
  $("#updated").textContent = `updated ${s}s ago` + (d.pending ? ` · ${d.pending} lookups pending` : "");
}

/* ------------------------------------------------------------ quote panel */

function findRow(sym) {
  for (const u of [active, ...Object.keys(U).filter((x) => x !== active)]) {
    const r = U[u].data?.rows.find((x) => x.symbol === sym);
    if (r) return { r, u };
  }
  return null;
}

let quoteNews = { sym: null, items: [], float: null };

function renderQuote() {
  const el = $("#quote");
  if (!selected) return;
  const sym = selected.sym;
  const hit = findRow(sym);
  const r = hit?.r;
  const R = rules[hit?.u || active];
  const extra = quoteNews.sym === sym ? quoteNews : { items: [], float: null };
  const fl = r?.float ?? extra.float?.float;
  const sp = r?.shortPct ?? extra.float?.shortPct;

  let html = `<div class="q-head"><span class="q-sym">${esc(sym)}</span><span class="q-name">${esc(r?.name || "")}</span>`;
  if (r) html += `<span class="q-price">${px(r.price)} <span class="${cls(r.change)}">${pct(r.changePct)}</span></span>`;
  html += `<button class="btn sm" data-act="log" data-s="${esc(sym)}" title="Start a journal entry for this stock">+ Journal</button>`;
  html += "</div>";

  if (r) {
    const P = pillars(r, R);
    const stat = (k, v) => `<div><span class="muted">${k}</span><span>${v}</span></div>`;
    html += '<div class="q-stats">' + [
      stat("Open", px(r.open)), stat("High", px(r.high)), stat("Low", px(r.low)),
      stat("Prev close", px(r.prevClose)), stat("Gap", pct(r.gapPct, 1)), stat("From HOD", pct(r.fromHighPct, 1)),
      stat("Volume", big(r.volume)), stat("Avg vol 3m", big(r.avgVolume)), stat("RVOL pace", mult(r.rvolRate)),
      stat("RVOL day", mult(r.rvol)), stat("Float", big(fl)), stat("Short/float", sp == null ? "—" : (sp * 100).toFixed(1) + "%"),
      stat("Mkt cap", big(r.marketCap)), stat("Shares out", big(r.sharesOut)), stat("Float rot.", fl ? (r.volume / fl).toFixed(1) + "×" : "—"),
    ].join("") + "</div>";
    if (r.sector) html += `<div class="muted small">${esc(r.sector)} · ${esc(r.industry || "")}</div>`;

    const on = [R.p1on, R.p2on, R.p3on, R.p4on, R.p5on];
    const lines = [
      ["dem", `Up ${pct(r.changePct, 1)} on the day`, `≥ ${R.minChange}%`],
      ["dem", `Relative volume ${mult(r.rvolRate)}`, `≥ ${R.minRvol}×`],
      ["dem", r.newsChecked ? (r.hasCatalyst ? "News today" : r.hasMention ? "Only roundup mentions" : "No news in 24h") : "Checking news…", "catalyst"],
      ["dem", `Price $${px(r.price)}`, `$${R.priceMin}–${R.priceMax}`],
      ["sup", `Float ${big(r.float)}`, `< ${R.maxFloat}M`],
    ];
    html += `<h4>Pillars — ${P.score}/5 (${LABELS[hit.u]} rules)</h4><div class="checks">` + lines.map(([k, a, b], i) => {
      const s = !on[i] ? ["na", "–"] : P.p[i] ? ["ok", "✔"] : ["no", "✘"];
      return `<div><span class="${s[0]}">${s[1]}</span><span class="${k}">${k === "dem" ? "Demand" : "Supply"}</span><span>${a}</span><span class="muted small">${on[i] ? b : "off"}</span></div>`;
    }).join("") + "</div>";
  } else {
    html += `<p class="muted small">Not in today's scanner results${fl ? ` · float ${big(fl)}` : ""}. Charts and news still load.</p>`;
  }

  html += "<h4>Headlines</h4>";
  const items = extra.items.length ? extra.items : r?.news || [];
  html += items.length ? items.map(newsRow).join("") : `<p class="muted small">${quoteNews.sym === sym ? "No recent headlines." : "Loading headlines…"}</p>`;
  el.innerHTML = html;
}

function newsRow(n, withTicker) {
  const fresh = Date.now() / 1000 - n.time < 900 ? '<span class="new">NEW</span>' : "";
  const tk = withTicker ? `<span class="tk" data-s="${esc(n.symbol)}">${esc(n.symbol)}</span><span class="${cls(n.changePct)}">${pct(n.changePct, 1)}</span>` : "";
  return `<a class="news ${n.roundup ? "roundup" : ""}" href="${esc(n.link)}" target="_blank" rel="noopener">` +
    `<div class="meta">${tk}${fresh}<span>${n.time ? etShort.format(n.time * 1000) + " · " + ago(n.time) : ""}</span><span>${esc(n.publisher || "")}</span>${n.roundup ? "<span>roundup</span>" : ""}</div>` +
    `<div>${esc(n.title)}</div></a>`;
}

async function select(sym) {
  sym = sym.toUpperCase().trim();
  if (!sym) return;
  selected = { sym };
  renderScans();
  renderQuote();
  loadCharts(sym);
  try {
    const j = await (await fetch(`/api/news?s=${encodeURIComponent(sym)}`)).json();
    if (selected?.sym !== sym) return;
    quoteNews = { sym, items: j.items || [], float: j.float || null };
  } catch {
    quoteNews = { sym, items: [], float: null };
  }
  renderQuote();
}

/* ----------------------------------------------------------------- charts */

const TV_EXCH = { NMS: "NASDAQ", NGM: "NASDAQ", NCM: "NASDAQ", NYQ: "NYSE", ASE: "AMEX", PCX: "AMEX", BTS: "CBOE" };

function tvSymbol(sym) {
  const r = findRow(sym)?.r;
  const ex = r && TV_EXCH[r.exchange];
  return ex ? `${ex}:${sym}` : sym;
}

function loadCharts(sym) {
  $("#chartSym1").textContent = sym;
  $("#chartSym2").textContent = sym;
  if (!window.TradingView) {
    for (const id of ["tv1", "tv2"]) $("#" + id).innerHTML = '<p class="muted pad">TradingView charts need an internet connection (tv.js did not load).</p>';
    return;
  }
  const base = { autosize: true, symbol: tvSymbol(sym), timezone: "America/New_York", theme: "dark",
                 style: "1", locale: "en", enable_publishing: false, hide_side_toolbar: true,
                 allow_symbol_change: false, save_image: false, backgroundColor: "#121820" };
  new TradingView.widget({ ...base, container_id: "tv1", interval,
    studies: [{ id: "MAExp@tv-basicstudies", inputs: { length: 9 } },
              { id: "MAExp@tv-basicstudies", inputs: { length: 20 } },
              "VWAP@tv-basicstudies"] });
  new TradingView.widget({ ...base, container_id: "tv2", interval: "D",
    studies: [{ id: "MAExp@tv-basicstudies", inputs: { length: 20 } },
              { id: "MASimple@tv-basicstudies", inputs: { length: 200 } }] });
}

/* ------------------------------------------------------------------- feed */

function renderFeed() {
  const hide = $("#hideRoundups").checked;
  const items = feedItems.filter((n) => !hide || !n.roundup);
  $("#feed").innerHTML = items.length ? items.map((n) => newsRow(n, true)).join("")
    : '<p class="muted pad">Headlines for today\'s movers appear here as they are fetched.</p>';
}

async function pollFeed() {
  try {
    const j = await (await fetch(`/api/feed?u=${active}`)).json();
    feedItems = j.items || [];
    renderFeed();
  } catch { /* server restarting */ }
}

/* ------------------------------------------------------------------ polling */

async function poll(u) {
  try {
    const res = await fetch(`/api/scan?u=${u}`);
    const d = await res.json();
    if (!d.rows) throw new Error(d.error || "bad response");
    U[u].data = d;
    detect(u);
  } catch (e) {
    if (!U[u].data) U[u].data = { ts: Date.now() / 1000, rows: [], error: "can't reach the local server — is server.py running?" };
    else U[u].data.error = "can't reach the local server — is server.py running?";
  }
  if (u === active && app === "scanner") {
    renderScans(); renderAlerts(); renderStatus(); tickUpdated();
    if (selected) renderQuote();
  }
  renderBadges();
}

function pollAll() { for (const u of Object.keys(U)) poll(u); }

/* ------------------------------------------------------------------ wiring */

/* Scanner and journal live in one page: the scanner keeps polling and firing
   alerts while the journal is on screen. */
function setApp(which) {
  app = which;
  store.set("md.app", app);
  document.querySelectorAll(".apptab").forEach((b) => b.classList.toggle("on", b.dataset.app === app));
  $(".grid").hidden = app !== "scanner";
  $("#journalView").hidden = app !== "journal";
  if (app === "journal") {
    const f = $("#journalFrame");
    if (!f.src) {
      f.addEventListener("load", () => { f.dataset.ready = "1"; }, { once: true });
      f.src = "/journal.html";
    }
  } else {
    renderScans(); renderAlerts(); renderStatus();
  }
}

/** Open the journal with a trade already started for this symbol. */
function logTrade(sym) {
  const r = findRow(sym)?.r;
  const f = $("#journalFrame");
  const msg = {
    type: "prefill-trade",
    symbol: sym,
    price: r ? r.price : null,
    date: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()),
    time: new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()),
  };
  const send = () => f.contentWindow?.postMessage(msg, window.location.origin);
  // A brand-new iframe reports readyState "complete" while it is still
  // about:blank, so check that the journal itself is the document.
  const loaded = () => {
    if (f.dataset.ready === "1") return true;
    try {
      return f.contentWindow.location.pathname === "/journal.html" &&
        f.contentDocument.readyState === "complete";
    } catch { return false; }
  };
  setApp("journal");
  if (loaded()) { send(); return; }
  // The frame may be mid-load, or have finished before this click.
  f.addEventListener("load", () => { f.dataset.ready = "1"; setTimeout(send, 100); }, { once: true });
  let tries = 0;
  const poll = setInterval(() => {
    if (loaded()) { clearInterval(poll); send(); }
    else if (++tries > 40) clearInterval(poll);
  }, 150);
}

function setTab(u) {
  active = u;
  store.set("md.tab", u);
  U[u].unseen = 0;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.u === u));
  renderScans(); renderAlerts(); renderStatus(); renderBadges(); tickUpdated();
  pollFeed();
  const rows = U[u].data?.rows || [];
  if (rows.length && !rows.some((r) => r.symbol === selected?.sym)) select(rows[0].symbol);
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => { setApp("scanner"); setTab(t.dataset.u); }));
document.querySelectorAll(".apptab").forEach((b) => b.addEventListener("click", () => setApp(b.dataset.app)));

document.addEventListener("click", (e) => {
  const log = e.target.closest('[data-act="log"]');
  if (log) { logTrade(log.dataset.s); return; }
  const th = e.target.closest("#gainers th");
  if (th) {
    const S = U[active], k = th.dataset.k;
    S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: k === "symbol" ? 1 : -1 };
    renderScans();
    return;
  }
  const tk = e.target.closest(".tk");
  if (tk) { e.preventDefault(); select(tk.dataset.s); return; }
  const tr = e.target.closest("tr[data-s]");
  if (tr) select(tr.dataset.s);
});

$("#lookup").addEventListener("submit", (e) => {
  e.preventDefault();
  select($("#lookupInput").value);
  $("#lookupInput").value = "";
});

$("#onlyScore3").addEventListener("change", renderScans);
$("#hideRoundups").addEventListener("change", renderFeed);
$("#clearAlerts").addEventListener("click", () => { U[active].alerts = []; renderAlerts(); });

const soundBtn = $("#soundBtn");
const paintSound = () => { soundBtn.textContent = soundOn ? "🔊" : "🔇"; };
paintSound();
soundBtn.addEventListener("click", () => { soundOn = !soundOn; store.set("md.sound", soundOn); paintSound(); if (soundOn) beep("hod"); });

document.querySelectorAll("#intervalSeg button").forEach((b) => {
  b.classList.toggle("on", b.dataset.i === interval);
  b.addEventListener("click", () => {
    interval = b.dataset.i;
    store.set("md.interval", interval);
    document.querySelectorAll("#intervalSeg button").forEach((x) => x.classList.toggle("on", x === b));
    if (selected) loadCharts(selected.sym);
  });
});

// settings dialog
const dlg = $("#settings"), form = $("#settingsForm");
function fillForm() {
  const R = rules[active];
  $("#settingsTab").textContent = LABELS[active];
  for (const el of form.elements) {
    if (!el.name || !(el.name in R)) continue;
    if (el.type === "checkbox") el.checked = !!R[el.name]; else el.value = R[el.name];
  }
}
function readForm() {
  const R = rules[active];
  for (const el of form.elements) {
    if (!el.name || !(el.name in R)) continue;
    if (el.type === "checkbox") R[el.name] = el.checked;
    else if (el.value !== "" && !isNaN(+el.value)) R[el.name] = +el.value;
  }
  store.set("md.rules." + active, R);
  U[active].passing = new Set(U[active].data?.rows.filter((r) => pillars(r, R).score === 5).map((r) => r.symbol));
  renderScans();
  if (selected) renderQuote();
}
$("#settingsBtn").addEventListener("click", () => { fillForm(); dlg.showModal(); });
form.addEventListener("input", readForm);
$("#resetRules").addEventListener("click", () => { Object.assign(rules[active], DEFAULTS[active]); fillForm(); readForm(); });

setInterval(() => { $("#clock").textContent = etFmt.format(new Date()) + " ET"; tickUpdated(); }, 1000);

/* ------------------------------------------------------------------- start */

(async function start() {
  setApp(app);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.u === active));
  renderScans(); renderAlerts();
  await poll(active);
  const other = Object.keys(U).find((u) => u !== active);
  poll(other);
  const top = U[active].data?.rows?.[0];
  if (top) select(top.symbol);
  pollFeed();
  setInterval(pollAll, POLL_MS);
  setInterval(pollFeed, FEED_MS);
})();
