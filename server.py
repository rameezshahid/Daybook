"""
Daybook: a local Warrior-style scanner and trade journal for small and large caps.

    python scanner/server.py            ->  http://localhost:8765

The server is only a data pump. It pulls the day's movers from Yahoo's
screener, enriches them with float / short interest (cached on disk, floats
barely move) and recent headlines (cached a few minutes), and hands the raw
numbers to the browser. The 5-pillar rules are applied in the browser so the
thresholds can be tuned live without restarting anything.

Yahoo is free and close to real time for US listings, but it is not a direct
feed: expect a few seconds of lag, occasional timeouts, and no pre-market
gappers until the regular session opens (the screener ranks on the regular
session's change). Good enough to find what's moving; not good enough to
time a fill.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import yfinance as yf
from yfinance import EquityQuery as Q
from yfinance.data import YfData

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
CACHE_DIR = os.path.join(HERE, "cache")
os.makedirs(CACHE_DIR, exist_ok=True)
FLOAT_FILE = os.path.join(CACHE_DIR, "floats.json")

PORT = int(os.environ.get("SCANNER_PORT", "8765"))

# The trade journal lives beside the scanner so both reach you at one address.
JOURNAL_FILE = os.path.join(HERE, "journal.json")
JOURNAL_BACKUP = os.path.join(CACHE_DIR, "journal.backup.json")
_journal_lock = threading.Lock()

SCAN_TTL = 15            # seconds between screener pulls per universe
NEWS_TTL = 180           # seconds a symbol's headlines stay cached
FLOAT_TTL = 5 * 86400    # floats change on offerings/splits, not intraday
NEWS_LIMIT = 120         # only the top N movers get a news lookup each cycle

# Listed US exchanges only - Yahoo's screener is full of OTC/grey-market
# names showing +2000% on 300 shares.
EXCHANGES = ["NMS", "NCM", "NGM", "NYQ", "ASE", "PCX", "BTS"]

# The candidate pool is deliberately looser than the pillars so the browser
# can show near-misses and let you tighten or loosen the rules on the fly.
UNIVERSES = {
    "small": {
        "label": "Small caps",
        "query": lambda: Q("and", [
            Q("is-in", ["exchange", *EXCHANGES]),
            Q("gt", ["percentchange", 3]),
            Q("btwn", ["intradayprice", 0.5, 50]),
            Q("gt", ["dayvolume", 100_000]),
            Q("lt", ["intradaymarketcap", 2e9]),
        ]),
    },
    "large": {
        "label": "Large caps",
        "query": lambda: Q("and", [
            Q("is-in", ["exchange", *EXCHANGES]),
            Q("gt", ["percentchange", 0.5]),
            Q("gte", ["intradaymarketcap", 10e9]),
            Q("gt", ["dayvolume", 200_000]),
        ]),
    },
}

_yf = YfData()
_pool = ThreadPoolExecutor(max_workers=8)
_lock = threading.Lock()
_scan_cache: dict[str, dict] = {}
_news_cache: dict[str, tuple[float, list]] = {}
_floats: dict[str, dict] = {}


# ------------------------------------------------------------------ helpers --

def _load_floats() -> None:
    global _floats
    try:
        with open(FLOAT_FILE, "r", encoding="utf-8") as f:
            _floats = json.load(f)
    except (OSError, ValueError):
        _floats = {}


def _save_floats() -> None:
    tmp = FLOAT_FILE + ".tmp"
    with _lock:
        snapshot = dict(_floats)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(snapshot, f)
    os.replace(tmp, FLOAT_FILE)


# ------------------------------------------------------------------ journal --

def journal_read() -> list[dict]:
    try:
        with open(JOURNAL_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        trades = data.get("trades") if isinstance(data, dict) else data
        return [t for t in (trades or []) if isinstance(t, dict) and t.get("id")]
    except (OSError, ValueError):
        return []


def journal_write(trades: list[dict]) -> None:
    """Atomic write, keeping the previous file as a backup. This is the only
    copy of the journal, so it is worth the extra few milliseconds."""
    tmp = JOURNAL_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"trades": trades, "savedAt": time.time()}, f, indent=1)
    if os.path.exists(JOURNAL_FILE):
        try:
            os.replace(JOURNAL_FILE, JOURNAL_BACKUP)
        except OSError:
            pass
    os.replace(tmp, JOURNAL_FILE)


# Only these fields are stored, and only in these shapes - whatever the
# browser posts.
_J_STR = {"id": 40, "date": 10, "exitDate": 10, "timeIn": 5, "timeOut": 5,
          "symbol": 12, "side": 6, "kind": 6, "setup": 60, "grade": 1, "notes": 4000}
_J_NUM = ["qty", "entry", "exit", "stop", "fees", "pnlManual", "createdAt", "updatedAt"]


def journal_clean(t: dict) -> dict | None:
    if not isinstance(t, dict) or not t.get("id") or not t.get("date"):
        return None
    out: dict = {}
    for k, limit in _J_STR.items():
        v = t.get(k)
        if isinstance(v, str) and v.strip():
            out[k] = v.strip()[:limit]
    if "id" not in out or "date" not in out:
        return None
    for k in _J_NUM:
        v = t.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = v
    out["side"] = "short" if out.get("side") == "short" else "long"
    out["kind"] = "swing" if out.get("kind") == "swing" else "day"
    out["sample"] = bool(t.get("sample"))
    return out


def _num(v):
    """quoteSummary sometimes returns {'raw': x, 'fmt': ...} and sometimes x."""
    if isinstance(v, dict):
        v = v.get("raw")
    return v if isinstance(v, (int, float)) else None


def fetch_float(symbol: str) -> dict:
    """Float and short interest for one symbol, from the disk cache if fresh."""
    now = time.time()
    with _lock:
        hit = _floats.get(symbol)
    if hit and now - hit.get("ts", 0) < FLOAT_TTL:
        return hit
    rec = {"ts": now, "float": None, "shortPct": None, "sector": None, "industry": None}
    try:
        j = _yf.get_raw_json(
            f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{symbol}",
            params={"modules": "defaultKeyStatistics,assetProfile", "formatted": "false"},
            timeout=15,
        )
        res = (j.get("quoteSummary", {}).get("result") or [{}])[0]
        ks = res.get("defaultKeyStatistics", {}) or {}
        ap = res.get("assetProfile", {}) or {}
        rec["float"] = _num(ks.get("floatShares"))
        rec["shortPct"] = _num(ks.get("shortPercentOfFloat"))
        rec["sector"] = ap.get("sector")
        rec["industry"] = ap.get("industry")
    except Exception:                                     # noqa: BLE001
        # Don't pin a failure for five days - retry in ten minutes.
        rec["ts"] = now - FLOAT_TTL + 600
    with _lock:
        _floats[symbol] = rec
    return rec


ROUNDUP_WORDS = ("most active", "top gainers", "top losers", "movers", "premarket",
                 "pre-market", "after-hours", "stocks moving", "midday", "biggest")


def fetch_news(symbol: str, force: bool = False) -> list:
    now = time.time()
    with _lock:
        hit = _news_cache.get(symbol)
    if hit and not force and now - hit[0] < NEWS_TTL:
        return hit[1]
    items = []
    try:
        j = _yf.get_raw_json(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": symbol, "newsCount": 12, "quotesCount": 0,
                    "enableFuzzyQuery": "false"},
            timeout=10,
        )
        for n in j.get("news", []) or []:
            rel = n.get("relatedTickers") or []
            if symbol not in rel:
                continue            # search is fuzzy; keep only stories tagged with the ticker
            title = n.get("title", "")
            roundup = len(rel) > 4 or any(w in title.lower() for w in ROUNDUP_WORDS)
            items.append({
                "title": title,
                "publisher": n.get("publisher"),
                "link": n.get("link"),
                "time": n.get("providerPublishTime"),
                "tickers": rel[:8],
                "roundup": roundup,   # a list article that merely mentions it - not a catalyst
            })
    except Exception:                                     # noqa: BLE001
        if hit:
            return hit[1]
    items.sort(key=lambda x: x["time"] or 0, reverse=True)
    with _lock:
        _news_cache[symbol] = (now, items)
    return items


# Approximate cumulative share of a US session's volume by minutes after the
# open. Volume is U-shaped (heavy open, heavy close), so a straight-line pace
# would overstate RVOL at lunchtime and understate it in the first half hour.
_VOL_CURVE = [(0, 0.0), (15, 0.10), (30, 0.17), (60, 0.27), (120, 0.40),
              (180, 0.50), (240, 0.59), (300, 0.68), (360, 0.80), (390, 1.0)]


def session_fraction(gmt_offset_ms: int) -> float:
    et = time.gmtime(time.time() + gmt_offset_ms / 1000)
    if et.tm_wday >= 5:
        return 1.0
    m = et.tm_hour * 60 + et.tm_min - (9 * 60 + 30)
    if m <= 0:
        return 0.05     # pre-market: compare against a small slice of a normal day
    if m >= 390:
        return 1.0
    for (m0, f0), (m1, f1) in zip(_VOL_CURVE, _VOL_CURVE[1:]):
        if m <= m1:
            return max(0.03, f0 + (f1 - f0) * (m - m0) / (m1 - m0))
    return 1.0


def _row(q: dict, frac: float) -> dict:
    sym = q["symbol"]
    prev = q.get("regularMarketPreviousClose")
    opn = q.get("regularMarketOpen")
    vol = q.get("regularMarketVolume") or 0
    avg = q.get("averageDailyVolume3Month") or q.get("averageDailyVolume10Day") or 0
    avg10 = q.get("averageDailyVolume10Day") or avg
    price = q.get("regularMarketPrice")
    high = q.get("regularMarketDayHigh")
    return {
        "symbol": sym,
        "name": q.get("displayName") or q.get("shortName") or q.get("longName") or sym,
        "exchange": q.get("exchange"),
        "price": price,
        "change": q.get("regularMarketChange"),
        "changePct": q.get("regularMarketChangePercent"),
        "prevClose": prev,
        "open": opn,
        "high": high,
        "low": q.get("regularMarketDayLow"),
        "gapPct": (opn / prev - 1) * 100 if opn and prev else None,
        "fromHighPct": (price / high - 1) * 100 if price and high else None,
        "volume": vol,
        "avgVolume": avg,
        "avgVolume10": avg10,
        # full-day ratio, and the time-of-day adjusted pace ("daily rate")
        "rvol": vol / avg if avg else None,
        "rvolRate": vol / (avg * frac) if avg else None,
        "marketCap": q.get("marketCap"),
        "sharesOut": q.get("sharesOutstanding"),
        "preMarketPct": q.get("preMarketChangePercent"),
        "postMarketPct": q.get("postMarketChangePercent"),
        "marketState": q.get("marketState"),
        "quoteTime": q.get("regularMarketTime"),
    }


def _screen(universe: str) -> list[dict]:
    last_exc = None
    for attempt in range(3):
        try:
            r = yf.screen(UNIVERSES[universe]["query"](), size=250,
                          sortField="percentchange", sortAsc=False)
            return r.get("quotes", []) or []
        except Exception as exc:                          # noqa: BLE001
            last_exc = exc
            time.sleep(1 + attempt)
    raise RuntimeError(f"screener failed: {last_exc}")


def _enrich(rows: list[dict], now: float) -> None:
    """Attach whatever float/news is cached; queue lookups for what isn't."""
    day_ago = now - 24 * 3600
    for i, r in enumerate(rows):
        sym = r["symbol"]
        with _lock:
            f = _floats.get(sym)
            n = _news_cache.get(sym)
        if f is None or now - f.get("ts", 0) >= FLOAT_TTL:
            _queue(("float", sym))
        f = f or {}
        r["float"] = f.get("float")
        r["floatChecked"] = "ts" in f
        r["shortPct"] = f.get("shortPct")
        r["sector"] = f.get("sector")
        r["industry"] = f.get("industry")
        if i < NEWS_LIMIT and (n is None or now - n[0] >= NEWS_TTL):
            _queue(("news", sym))
        if n is None:
            r["newsChecked"] = False
            r["news"] = []
        else:
            r["newsChecked"] = True
            r["news"] = [x for x in n[1] if (x["time"] or 0) >= day_ago][:5]
        r["hasCatalyst"] = any(not x["roundup"] for x in r["news"])
        r["hasMention"] = bool(r["news"])


_pending: set = set()


def _queue(job: tuple) -> None:
    with _lock:
        if job in _pending:
            return
        _pending.add(job)

    def run():
        try:
            (fetch_float if job[0] == "float" else fetch_news)(job[1])
        finally:
            with _lock:
                _pending.discard(job)
    _pool.submit(run)


_last_access: dict[str, float] = {}


def _refresh(universe: str) -> None:
    now = time.time()
    with _lock:
        prev = _scan_cache.get(universe)
    try:
        quotes = _screen(universe)
    except Exception as exc:                              # noqa: BLE001
        with _lock:
            if prev:
                _scan_cache[universe] = {**prev, "error": str(exc), "stale": True}
            else:
                _scan_cache[universe] = {"ts": now, "universe": universe, "rows": [],
                                         "error": str(exc)}
        return

    quotes = [q for q in quotes if q.get("quoteType") == "EQUITY" and q.get("regularMarketPrice")]
    offset = next((q.get("gmtOffSetMilliseconds") for q in quotes
                   if q.get("gmtOffSetMilliseconds") is not None), -4 * 3600 * 1000)
    frac = session_fraction(offset)
    rows = [_row(q, frac) for q in quotes]
    market_state = next((q.get("marketState") for q in quotes if q.get("marketState")), None)
    out = {"ts": now, "universe": universe, "rows": rows, "sessionFraction": frac,
           "marketState": market_state, "gmtOffsetMs": offset, "error": None}
    with _lock:
        _scan_cache[universe] = out


def _refresher() -> None:
    """Keep each universe fresh while a browser is looking at it."""
    saved = 0.0
    while True:
        now = time.time()
        for uni in UNIVERSES:
            if now - _last_access.get(uni, 0) < 120:
                with _lock:
                    hit = _scan_cache.get(uni)
                if not hit or now - hit["ts"] >= SCAN_TTL:
                    _refresh(uni)
        if now - saved > 60:
            _save_floats()
            saved = now
        time.sleep(1)


def scan(universe: str) -> dict:
    """Latest snapshot for a universe, with cached enrichment merged in."""
    _last_access[universe] = time.time()
    with _lock:
        hit = _scan_cache.get(universe)
    if not hit:
        _refresh(universe)
        with _lock:
            hit = _scan_cache.get(universe)
    rows = [dict(r) for r in hit.get("rows", [])]
    _enrich(rows, time.time())
    with _lock:
        pending = len(_pending)
    return {**hit, "rows": rows, "pending": pending, "serverTime": time.time()}


def news_feed(universe: str) -> list:
    """Every recent headline across the universe's movers, newest first."""
    data = scan(universe)
    seen, feed = set(), []
    for r in data.get("rows", [])[:NEWS_LIMIT]:
        for n in r.get("news", []):
            key = n["link"] or n["title"]
            if key in seen:
                continue
            seen.add(key)
            feed.append({**n, "symbol": r["symbol"], "changePct": r["changePct"]})
    feed.sort(key=lambda x: x["time"] or 0, reverse=True)
    return feed[:80]


# ------------------------------------------------------------------- server --

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):     # keep the console quiet
        if not self.path.startswith("/api/"):
            return
        sys.stderr.write("%s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _json(self, obj, status=200):
        body = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        arg = lambda k, d=None: (qs.get(k) or [d])[0]          # noqa: E731
        try:
            if u.path == "/api/scan":
                uni = arg("u", "small")
                if uni not in UNIVERSES:
                    return self._json({"error": "unknown universe"}, 400)
                return self._json(scan(uni))
            if u.path == "/api/feed":
                uni = arg("u", "small")
                if uni not in UNIVERSES:
                    return self._json({"error": "unknown universe"}, 400)
                return self._json({"items": news_feed(uni)})
            if u.path == "/api/news":
                sym = (arg("s", "") or "").upper().strip()
                if not sym or len(sym) > 12:
                    return self._json({"error": "bad symbol"}, 400)
                return self._json({"symbol": sym, "items": fetch_news(sym, force=True),
                                   "float": fetch_float(sym)})
            if u.path == "/api/trades":
                with _journal_lock:
                    return self._json({"trades": journal_read()})
        except Exception as exc:                          # noqa: BLE001
            return self._json({"error": str(exc)}, 500)
        return super().do_GET()

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 1_000_000:
            raise ValueError("bad body size")
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def do_POST(self):
        if urlparse(self.path).path != "/api/trades":
            return self._json({"error": "not found"}, 404)
        try:
            trade = journal_clean(self._body())
            if trade is None:
                return self._json({"error": "a trade needs an id and a date"}, 400)
            with _journal_lock:
                trades = [t for t in journal_read() if t.get("id") != trade["id"]]
                trades.append(trade)
                trades.sort(key=lambda t: (t.get("date", ""), t.get("createdAt", 0)))
                journal_write(trades)
                return self._json({"trades": trades, "saved": trade["id"]})
        except Exception as exc:                          # noqa: BLE001
            return self._json({"error": str(exc)}, 500)

    def do_DELETE(self):
        u = urlparse(self.path)
        if u.path != "/api/trades":
            return self._json({"error": "not found"}, 404)
        tid = (parse_qs(u.query).get("id") or [""])[0]
        if not tid:
            return self._json({"error": "no id"}, 400)
        try:
            with _journal_lock:
                trades = [t for t in journal_read() if t.get("id") != tid]
                journal_write(trades)
                return self._json({"trades": trades, "deleted": tid})
        except Exception as exc:                          # noqa: BLE001
            return self._json({"error": str(exc)}, 500)


def tailscale_url() -> str | None:
    """
    The URL this machine is reachable at from the other devices on the
    tailnet, when `tailscale serve` is proxying the scanner. Returns None
    when Tailscale is not signed in or not serving.
    """
    import json as _json
    import subprocess
    exe = os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Tailscale", "tailscale.exe")
    if not os.path.exists(exe):
        exe = "tailscale"
    try:
        st = _json.loads(subprocess.run([exe, "status", "--json"], capture_output=True,
                                        text=True, timeout=10).stdout)
        host = (st.get("Self", {}).get("DNSName") or "").rstrip(".")
        if not host:
            return None
        cfg = subprocess.run([exe, "serve", "status", "--json"], capture_output=True,
                             text=True, timeout=10).stdout.strip()
        if cfg and cfg not in ("null", "{}"):
            served = _json.loads(cfg)
            for hostport in (served.get("TCP") or {}):
                return f"http://{host}:{hostport}"
            if served.get("Web"):
                return f"https://{host}"
        return f"http://{host}:{PORT}  (run share_on_tailscale.bat to publish it)"
    except Exception:                                     # noqa: BLE001
        return None


def main():
    _load_floats()
    threading.Thread(target=_refresher, daemon=True).start()
    host = os.environ.get("SCANNER_HOST", "127.0.0.1")
    srv = ThreadingHTTPServer((host, PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"Daybook running at {url}  (Ctrl+C to stop)")
    ts = tailscale_url()
    if ts:
        print(f"On your other devices (Tailscale): {ts}")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
