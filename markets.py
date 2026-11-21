# Copyright (c) 2026 RV
"""
Markets — macro statistics for Australia (state, capital city and council
level). Seeded with published ABS figures so the page works offline; swap
in a live ABS feed (data.api.abs.gov.au) later without touching the UI.
"""

import json
import os
import re
import time

import requests
from flask import Blueprint, jsonify, request

bp = Blueprint("markets", __name__, url_prefix="/api/markets")

NATIONAL = {
    "populationGrowth": {"value": 1.54, "unit": "%", "label": "Year to June 2025",
                         "source": "ABS National, state and territory population"},
    "unemployment": {"value": 4.30, "unit": "%", "label": "June quarter 2026",
                     "source": "ABS Labour Force"},
    "householdIncome": {"value": 2176, "unit": "$/wk", "label": "2021 Census, in today's dollars",
                        "source": "ABS Census"},
    "businessGrowth": {"value": 3.25, "unit": "%", "label": "June 2021 to June 2025",
                       "source": "ABS Counts of Australian Businesses"},
    "renters": {"value": 30.60, "unit": "%", "label": "2021 Census",
                "source": "ABS Census"},
    "medianAge": {"value": 38.40, "unit": "yrs", "label": "June 2025",
                  "source": "ABS Demographics"},
}

STATES = {
    "WA": {"name": "Western Australia", "populationGrowth": 2.22,
           "capitalVsRest": {"capital": 2.41, "rest": 1.48}},
    "VIC": {"name": "Victoria", "populationGrowth": 1.77,
            "capitalVsRest": {"capital": 1.94, "rest": 1.24}},
    "QLD": {"name": "Queensland", "populationGrowth": 1.76,
            "capitalVsRest": {"capital": 2.09, "rest": 1.43}},
    "NT": {"name": "Northern Territory", "populationGrowth": 1.41,
           "capitalVsRest": {"capital": 1.56, "rest": 1.18}},
    "ACT": {"name": "Australian Capital Territory", "populationGrowth": 1.30,
            "capitalVsRest": None},
    "NSW": {"name": "New South Wales", "populationGrowth": 1.18,
            "capitalVsRest": {"capital": 1.35, "rest": 0.86}},
    "SA": {"name": "South Australia", "populationGrowth": 1.09,
           "capitalVsRest": {"capital": 1.24, "rest": 0.57}},
    "TAS": {"name": "Tasmania", "populationGrowth": 0.26,
            "capitalVsRest": {"capital": 0.20, "rest": 0.31}},
}

CAPITALS = {
    "NSW": "Sydney", "VIC": "Melbourne", "QLD": "Brisbane", "WA": "Perth",
    "SA": "Adelaide", "TAS": "Hobart", "ACT": "Canberra", "NT": "Darwin",
}


@bp.get("")
@bp.get("/")
def markets():
    return jsonify({"ok": True, "data": {
        "national": NATIONAL,
        "states": STATES,
        "capitals": CAPITALS,
        "asOf": "ABS releases, as labelled per statistic",
    }})


# ---------------------------------------------------------------------------
# Median price history — ABS Total Value of Dwellings, Table 2 (quarterly
# median established-house/unit price, capital city vs rest of state, back
# to 2002). Ships as a bundled snapshot of real published figures; refreshed
# live from abs.gov.au when reachable, falling back silently to the file.
# ---------------------------------------------------------------------------

PRICES_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "data", "markets", "median-prices.json")
TVD_BASE = ("https://www.abs.gov.au/statistics/economy/"
            "price-indexes-and-inflation/total-value-dwellings")
TVD_UA = "Mozilla/5.0 (compatible; PropertyAnalyser/1.0)"
PRICE_TTL_SECONDS = 24 * 3600
TVD_WORKBOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "data", "markets", ".tvd-cache.xlsx")

_capital_state = {"Sydney": "NSW", "Melbourne": "VIC", "Brisbane": "QLD",
                  "Adelaide": "SA", "Perth": "WA", "Hobart": "TAS",
                  "Darwin": "NT", "Canberra": "ACT"}
_rest_state = {"Rest of NSW": "NSW", "Rest of Vic.": "VIC", "Rest of Qld.": "QLD",
               "Rest of SA": "SA", "Rest of WA": "WA", "Rest of Tas.": "TAS",
               "Rest of NT": "NT"}
_prices_cache = {"data": None, "at": 0.0}


def _parse_tvd_workbook(path):
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True, read_only=True)
    rows = list(wb["Data1"].iter_rows(values_only=True))
    ids = None
    for i, r in enumerate(rows):
        if str(r[0]) == "Series ID":
            ids = r[1:]
            data_start = i + 1
            break
    if ids is None:
        raise ValueError("unexpected ABS workbook layout")
    colmap = {}
    for col, (d, sid) in enumerate(zip(rows[0][1:], ids), start=1):
        if not sid:
            continue
        text = str(d)
        if "Median Price" not in text:
            continue
        kind = "houses" if "Established House" in text else "units"
        region = text.split(";")[1].strip()
        state = _capital_state.get(region) or _rest_state.get(region)
        if not state:
            continue
        colmap[col] = (state, "capital" if region in _capital_state else "rest", kind)
    periods = []
    for r in rows[data_start:]:
        if not r[0]:
            break
        periods.append(str(r[0])[:10])
    states = {}
    for col, (state, area, kind) in colmap.items():
        vals = [round(r[col] * 1000) if r[col] is not None else None
                for r in rows[data_start:data_start + len(periods)]]
        states.setdefault(state, {}).setdefault(area, {})[kind] = vals
    return {"source": "ABS Total Value of Dwellings — Table 2: median price and "
                      "number of transfers, capital city and rest of state",
            "release": "quarterly, ABS", "unit": "AUD",
            "periods": periods, "states": states}


def _refresh_prices():
    """Best-effort live refresh; returns fresh data or None. Keeps the last
    good workbook bytes on disk so a blocked host doesn't re-download."""
    try:
        if os.path.exists(TVD_WORKBOOK) \
                and time.time() - os.path.getmtime(TVD_WORKBOOK) < PRICE_TTL_SECONDS:
            path = TVD_WORKBOOK
        else:
            r = requests.get(f"{TVD_BASE}/latest-release/643202.xlsx",
                             timeout=30, headers={"User-Agent": TVD_UA},
                             allow_redirects=True)
            if r.status_code != 200:
                page = requests.get(f"{TVD_BASE}/latest-release", timeout=30,
                                    headers={"User-Agent": TVD_UA})
                m = re.search(r'href="([^"]*total-value-dwellings/[^"]*?/643202\.xlsx)"',
                              page.text)
                if not m:
                    return None
                r = requests.get(f"https://www.abs.gov.au{m.group(1)}",
                                 timeout=30, headers={"User-Agent": TVD_UA},
                                 allow_redirects=True)
            if r.status_code != 200:
                return None
            os.makedirs(os.path.dirname(TVD_WORKBOOK), exist_ok=True)
            with open(TVD_WORKBOOK, "wb") as fh:
                fh.write(r.content)
            path = TVD_WORKBOOK
        data = _parse_tvd_workbook(path)
        os.makedirs(os.path.dirname(PRICES_JSON), exist_ok=True)
        with open(PRICES_JSON, "w") as fh:
            json.dump(data, fh)
        return data
    except Exception:
        return None


def _load_prices():
    """Bundled snapshot first, then a live ABS refresh when reachable."""
    now = time.time()
    if _prices_cache["data"] is not None and now - _prices_cache["at"] < PRICE_TTL_SECONDS:
        return _prices_cache["data"]
    try:
        with open(PRICES_JSON) as fh:
            data = json.load(fh)
    except OSError:
        data = None
    fresh = _refresh_prices()
    if fresh:
        data = fresh
    if data:
        _prices_cache["data"] = data
        _prices_cache["at"] = now
    return data


@bp.get("/prices")
def prices():
    """Median price history per state. `state` filter optional; the last
    ~10 years of quarters is plenty for a chart."""
    data = _load_prices()
    if not data:
        return jsonify({"ok": False,
                        "error": "price history unavailable (ABS unreachable and no snapshot)"}), 503
    periods = data["periods"][-41:]
    keep = slice(-41, None)
    want = (request.args.get("state") or "").upper()
    out_states = {k: {area: {kind: v[kind][keep] for kind in v}
                      for area, v in areas.items()}
                  for k, areas in data["states"].items() if not want or k == want}
    return jsonify({"ok": True, "data": {
        "source": data["source"],
        "release": data["release"],
        "unit": data["unit"],
        "periods": periods,
        "states": out_states,
        "capitals": CAPITALS,
    }})
