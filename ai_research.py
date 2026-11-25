# Copyright (c) 2026 RV
"""
AI web-evidence endpoints on the UltimateAI gateway (see gateway_search.py).

Every endpoint is an explicit on-demand call — one gateway web-search
session, memoized in-memory with a TTL — and returns values stamped with
source + as-of so the UI can show provenance:

  POST /api/markets/ai-refresh       ABS national indicators (fills SDMX gaps)
  POST /api/bank-rates/suggest       current investor variable rates
  POST /api/suburbs/ai-evidence      suburb stats persisted into the suburb row
  POST /api/property/listing-check   is the subject on market + last sale
  POST /api/property/area-signals    infra/planning projects near the subject
"""

import json
import queue
import threading
import time
from datetime import date

from flask import Blueprint, Response, jsonify, request

import db
import markets
from auth import require_auth
from gateway_search import (
    SearchError,
    _model,
    cached,
    cache_put,
    cached_get,
    collect_parallel_research,
    configured,
    run_research,
    run_research_streaming,
    start_parallel_research,
    TIMEOUT,
)

TTL_12H = 12 * 3600
TTL_24H = 24 * 3600

bp_markets = Blueprint("ai_markets", __name__, url_prefix="/api/markets")
bp_rates = Blueprint("ai_rates", __name__, url_prefix="/api/bank-rates")
bp_suburbs = Blueprint("ai_suburbs", __name__, url_prefix="/api/suburbs")
bp_property = Blueprint("ai_property", __name__, url_prefix="/api/property")
bp_meta = Blueprint("ai_meta", __name__, url_prefix="/api/ai")


# --- SSE plumbing shared by the research stream routes ----------------------

def _stream_session(cache_key, ttl, run):
    """Run one research job on a background thread; run(on_event) returns the
    final payload. Emits progress frames, then {"type": "result", "payload"}
    (cache hits emit the cached payload immediately), then a None sentinel."""
    ev_q = queue.Queue()

    def job():
        try:
            hit = cached_get(cache_key, ttl)
            if hit is not None:
                ev_q.put({"type": "result", "payload": hit})
            else:
                rows = run(lambda ev: ev_q.put(ev))
                cache_put(cache_key, rows)
                ev_q.put({"type": "result", "payload": rows})
        except SearchError as e:
            ev_q.put({"type": "error", "error": str(e)})
        except Exception as e:  # defensive: never leave the stream hanging
            ev_q.put({"type": "error", "error": str(e)[:200]})
        ev_q.put(None)

    threading.Thread(target=job, daemon=True).start()
    return ev_q


def _ai_stream_response(ev_q, done_fn):
    """SSE generator draining a research queue; done_fn(payload) builds the
    final {"type": "done", ...} frame."""
    def generate():
        payload = None
        err = None
        while True:
            try:
                ev = ev_q.get(timeout=TIMEOUT + 60)
            except queue.Empty:
                yield 'data: {"type": "progress", "note": "still researching…"}\n\n'
                continue
            if ev is None:
                break
            if ev.get("type") == "result":
                payload = ev["payload"]
            elif ev.get("type") == "error":
                err = ev.get("error")
            else:
                yield "data: " + json.dumps(ev) + "\n\n"
        if payload is None:
            yield "data: " + json.dumps(
                {"type": "error", "error": err or "research failed"}) + "\n\n"
            return
        yield "data: " + json.dumps({"type": "done", **done_fn(payload)}) + "\n\n"

    return Response(generate(), mimetype="text/event-stream")


def _num(v):
    try:
        f = float(v)
        return f if f == f and abs(f) != float("inf") else None
    except (TypeError, ValueError):
        return None


def _not_configured(what):
    return jsonify({"ok": False, "error": f"{what} is not configured "
                    "(PA_ULTIMATEAI_API_KEY)"}), 503


def _research_error(e):
    return jsonify({"ok": False, "error": f"AI research failed: {e}"}), e.http_status


@bp_meta.get("/status")
@require_auth
def ai_status():
    """Feature gate for the UI: is AI research configured, and on what model."""
    return jsonify({"ok": True, "data": {"configured": configured(),
                                         "model": _model()}})


# ---------------------------------------------------------------------------
# 1. Markets — ABS national indicators
# ---------------------------------------------------------------------------

MARKET_DEFS = {
    "populationGrowth": "populationGrowth: national annual population growth rate (%)",
    "unemployment": "unemployment: national unemployment rate, seasonally adjusted (%)",
    "householdIncome": "householdIncome: median household income ($/week)",
    "businessGrowth": "businessGrowth: annual growth in the count of actively trading businesses (%)",
    "renters": "renters: share of households that rent (%)",
    "medianAge": "medianAge: national median age (years)",
}

MARKET_UNITS = {"populationGrowth": "%", "unemployment": "%", "householdIncome": "$/wk",
                "businessGrowth": "%", "renters": "%", "medianAge": "yrs"}

# Two short gateway sessions instead of one long one: the gateway's
# Cloudflare edge returns 524 for sessions much past ~100s, so keep each
# research call small enough to finish well inside that.
MARKET_GROUPS = {
    "macro": ("populationGrowth", "unemployment", "medianAge"),
    "households": ("householdIncome", "businessGrowth", "renters"),
}

RECORD_INDICATORS_TOOL = {
    "type": "function",
    "name": "record_indicators",
    "description": "Record the current ABS national indicators you substantiated. "
    "Call exactly once when done.",
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "required": ["indicators"],
        "properties": {
            "indicators": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["key", "value", "label", "source"],
                    "properties": {
                        "key": {"type": "string", "enum": list(MARKET_DEFS)},
                        "value": {"type": "number"},
                        "unit": {"type": "string"},
                        "label": {"type": "string"},
                        "source": {"type": "string"},
                    },
                },
            }
        },
    },
}

def _markets_prompt(keys):
    return (
        "You research current official Australian Bureau of Statistics national "
        "figures. Find the LATEST published value for each indicator, preferring "
        "abs.gov.au pages (a reliable source quoting ABS is acceptable if an ABS "
        "page is unreachable):\n"
        + "\n".join("- " + MARKET_DEFS[k] for k in keys) + "\n"
        "Put the as-of period in label (e.g. 'March quarter 2026') and the "
        "publication page URL in source. Skip any indicator you cannot "
        "substantiate rather than estimating. Research quickly: at most 3 web "
        "searches per indicator. Finish by calling record_indicators exactly "
        "once. Never answer in prose."
    )


def _sanitize_indicators(rows):
    out = {}
    if not isinstance(rows, list):
        return out
    for r in rows:
        if not isinstance(r, dict):
            continue
        key = str(r.get("key") or "").strip()
        if key not in MARKET_UNITS:
            continue
        v = _num(r.get("value"))
        if v is None:
            continue
        out[key] = {
            "value": round(v, 2),
            "unit": str(r.get("unit") or MARKET_UNITS[key]).strip()[:10],
            "label": str(r.get("label") or "").strip()[:80],
            "source": str(r.get("source") or "").strip()[:200],
        }
    return out


def _markets_task():
    return (f"Today's date is {date.today().isoformat()}.\n"
            "Research the current ABS national indicators and record them.")


def _markets_research(task):
    """Both indicator groups run in parallel (2-worker pool), merged."""
    shards = [
        {"name": f"group {i + 1}", "instructions": _markets_prompt(keys),
         "task": task, "record_tool": RECORD_INDICATORS_TOOL,
         "list_key": "indicators", "sanitize": _sanitize_indicators}
        for i, keys in enumerate(MARKET_GROUPS.values())
    ]
    merged = collect_parallel_research(shards)
    if not merged:
        raise SearchError("no substantiated indicators found")
    return merged


@bp_markets.post("/ai-refresh")
@require_auth
def markets_ai_refresh():
    if not configured():
        return _not_configured("markets refresh")
    try:
        indicators = cached("national-ai", TTL_12H,
                            lambda: _markets_research(_markets_task()))
    except SearchError as e:
        return _research_error(e)
    if not indicators:
        return jsonify({"ok": False, "error": "no substantiated indicators found"}), 502
    markets.set_ai_national(indicators)
    return jsonify({"ok": True, "data": {"indicators": indicators,
                                         "asAt": date.today().isoformat()}})


@bp_markets.post("/ai-refresh/stream")
@require_auth
def markets_ai_refresh_stream():
    if not configured():
        return _not_configured("markets refresh")

    def run(on_event):
        payload = _markets_research(_markets_task())
        if not payload:
            raise SearchError("no substantiated indicators found")
        return payload

    ev_q = _stream_session("national-ai", TTL_12H, run)

    def done_fn(payload):
        # payload is the merged indicators dict from _markets_research
        markets.set_ai_national(payload)
        return {"indicators": payload, "asAt": date.today().isoformat()}

    return _ai_stream_response(ev_q, done_fn)


# ---------------------------------------------------------------------------
# 2. Bank rates — suggested current investor variable rates
# ---------------------------------------------------------------------------

RECORD_RATES_TOOL = {
    "type": "function",
    "name": "record_rates",
    "description": "Record the investor variable rates you substantiated. "
    "Call exactly once when done.",
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "required": ["rates"],
        "properties": {
            "rates": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["bankName", "productName", "source"],
                    "properties": {
                        "bankName": {"type": "string"},
                        "productName": {"type": "string"},
                        "investorIoRate": {"type": "number"},
                        "investorPiRate": {"type": "number"},
                        "source": {"type": "string"},
                    },
                },
            }
        },
    },
}

# Three very short gateway sessions (2 lenders each): the gateway's
# Cloudflare edge kills sessions past ~100s with 524, and lender-rate
# research proved too long even at 3 lenders. Each group should resolve
# from a single comparison page.
RATE_GROUPS = {
    "majors-1": ("CBA", "Westpac"),
    "majors-2": ("NAB", "ANZ"),
    "majors-3": ("Macquarie", "Suncorp"),
}

def _rates_prompt(lenders):
    return (
        "You research current Australian home-loan variable interest rates. "
        "For these lenders: " + ", ".join(lenders) + ", "
        "find their advertised variable home-loan rate. Comparison sites "
        "(RateCity, Canstar, Finder) list every lender in one table — that "
        "is your target. Record investorPiRate only when the source explicitly "
        "identifies an investor principal-and-interest rate, and investorIoRate "
        "only when it explicitly identifies an investor interest-only rate. "
        "Do not substitute owner-occupier or unspecified rates. Rates are PERCENT numbers (e.g. 5.89, never "
        "0.0589); source is the page URL you read. Work fast: at most 2 web "
        "searches, then read one comparison table and record. Skip any "
        "lender missing from the table rather than doing more searches. "
        "Long sessions time out. Finish by calling record_rates exactly "
        "once. Never answer in prose."
    )


def _sanitize_rates(rows):
    """Percent numbers -> decimal fractions (the bank_rates convention)."""
    out = []
    if not isinstance(rows, list):
        return out
    for r in rows:
        if not isinstance(r, dict):
            continue
        bank = str(r.get("bankName") or "").strip()[:80]
        product = str(r.get("productName") or "").strip()[:80] or "investor variable"
        io, pi = _num(r.get("investorIoRate")), _num(r.get("investorPiRate"))
        if not bank or (io is None and pi is None):
            continue
        if io is not None and io > 1:
            io = round(io / 100, 4)
        if pi is not None and pi > 1:
            pi = round(pi / 100, 4)
        if io is not None and not 0 < io < 0.2:
            io = None
        if pi is not None and not 0 < pi < 0.2:
            pi = None
        if io is None and pi is None:
            continue
        out.append({
            "bankName": bank,
            "productName": product,
            "investorIoRate": io,
            "investorPiRate": pi,
            "source": str(r.get("source") or "").strip()[:200],
        })
        if len(out) >= 12:
            break
    return out


@bp_rates.post("/suggest")
@require_auth
def rates_suggest():
    if not configured():
        return _not_configured("bank rate suggestions")
    task = f"Today's date is {date.today().isoformat()}.\n"

    def research():
        shards = [
            {"name": ", ".join(lenders), "instructions": _rates_prompt(lenders),
             "task": task, "record_tool": RECORD_RATES_TOOL,
             "list_key": "rates", "sanitize": _sanitize_rates}
            for lenders in RATE_GROUPS.values()
        ]
        return collect_parallel_research(
            shards, lambda r: (r.get("bankName", "").lower(),
                               r.get("productName", "").lower()))

    try:
        rates = cached("rates-ai", TTL_12H, research)
    except SearchError as e:
        return _research_error(e)
    return jsonify({"ok": True, "data": {"rates": rates,
                                         "asAt": date.today().isoformat()}})


@bp_rates.post("/suggest/stream")
@require_auth
def rates_suggest_stream():
    if not configured():
        return _not_configured("bank rate suggestions")
    task = f"Today's date is {date.today().isoformat()}.\n"

    hit = cached_get("rates-ai", TTL_12H)
    if hit is not None:
        return Response("data: " + json.dumps(
            {"type": "done", "rates": hit, "asAt": date.today().isoformat()}) + "\n\n",
            mimetype="text/event-stream")

    shards = [
        {"name": ", ".join(lenders), "instructions": _rates_prompt(lenders),
         "task": task, "record_tool": RECORD_RATES_TOOL,
         "list_key": "rates", "sanitize": _sanitize_rates}
        for lenders in RATE_GROUPS.values()
    ]
    ev_q = start_parallel_research(
        shards, lambda r: (r.get("bankName", "").lower(),
                           r.get("productName", "").lower()))

    def generate():
        rows = None
        err = None
        while True:
            try:
                ev = ev_q.get(timeout=TIMEOUT + 60)
            except queue.Empty:
                yield 'data: {"type": "progress", "note": "still researching…"}\n\n'
                continue
            if ev is None:
                break
            if ev.get("type") == "result":
                rows = ev["rows"]
            elif ev.get("type") == "error":
                err = ev.get("error")
            else:
                yield "data: " + json.dumps(ev) + "\n\n"
        if rows is None:
            yield "data: " + json.dumps(
                {"type": "error", "error": err or "rate research failed"}) + "\n\n"
            return
        cache_put("rates-ai", rows)
        yield "data: " + json.dumps({"type": "done", "rates": rows,
                                     "asAt": date.today().isoformat()}) + "\n\n"

    return Response(generate(), mimetype="text/event-stream")


# ---------------------------------------------------------------------------
# 3. Suburb evidence — persisted into the suburbs row with stamped sources
# ---------------------------------------------------------------------------

# metric key -> suburbs table column (payload field name == metric key)
SUBURB_METRICS = {
    "medianPrice": "median_price",
    "medianRent3Bed": "median_rent_3bed",
    "medianRent4Bed": "median_rent_4bed",
    "vacancyPct": "vacancy_pct",
    "medianDaysOnMarket": "median_days_on_market",
}

RECORD_EVIDENCE_TOOL = {
    "type": "function",
    "name": "record_evidence",
    "description": "Record the suburb market figures you substantiated. "
    "Call exactly once when done.",
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "required": ["evidence"],
        "properties": {
            "evidence": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["metric", "value", "asOf", "source"],
                    "properties": {
                        "metric": {"type": "string", "enum": list(SUBURB_METRICS)},
                        "value": {"type": "number"},
                        "asOf": {"type": "string"},
                        "source": {"type": "string"},
                    },
                },
            }
        },
    },
}

SUBURB_PROMPT = (
    "You research the Australian residential market for one suburb. Find the "
    "latest figures you can substantiate (plain numbers, no symbols):\n"
    "- medianPrice: median SOLD house price ($) — recent months\n"
    "- medianRent3Bed / medianRent4Bed: median weekly advertised rent for "
    "3-bed / 4-bed houses ($/wk)\n"
    "- vacancyPct: rental vacancy rate (%)\n"
    "- medianDaysOnMarket: median days on market for houses\n"
    "Run at most 6 web searches; a suburb profile page or two may cover "
    "several metrics at once. asOf is the period (e.g. 'Nov 2026', 'Sep "
    "quarter 2026'); source is the page URL. Skip any metric you cannot "
    "substantiate rather than estimating. Work briskly — long sessions time "
    "out. Finish by calling record_evidence exactly once. Never answer in "
    "prose."
)


def _sanitize_evidence(rows):
    out = {}
    if not isinstance(rows, list):
        return out
    for r in rows:
        if not isinstance(r, dict):
            continue
        metric = str(r.get("metric") or "").strip()
        if metric not in SUBURB_METRICS:
            continue
        v = _num(r.get("value"))
        if v is None or v <= 0:
            continue
        out[metric] = {
            "value": round(v, 2),
            "asOf": str(r.get("asOf") or "").strip()[:40],
            "source": str(r.get("source") or "").strip()[:200],
        }
    return out


def _persist_suburb_evidence(sid, row, evidence):
    """Write researched figures into the suburb row; sources stamped like
    manual saves so the area report, Deal Check, portal and PDF all show
    provenance. Returns the refreshed payload."""
    new_sources = json.loads(row["sources_json"] or "{}")
    sets, vals = [], []
    for metric, item in evidence.items():
        sets.append(f"{SUBURB_METRICS[metric]} = ?")
        vals.append(item["value"])
        new_sources[metric] = {
            "source": f"AI web search — {item['source']}",
            "asOf": item["asOf"] or date.today().strftime("%Y-%m"),
        }
    sets.append("sources_json = ?")
    vals.append(json.dumps(new_sources))
    vals.append(sid)
    db.db().execute(
        f"UPDATE suburbs SET {', '.join(sets)}, updated_at = datetime('now') "
        "WHERE id = ?", vals)
    updated = db.db().fetch_one("SELECT * FROM suburbs WHERE id = ?", (sid,))

    from areadata import _suburb_payload  # local import: avoids import cycle
    return _suburb_payload(updated)


def _suburb_evidence_run(sid, row):
    def research_run(on_event=None):
        subject = f"{row['name']} {row['postcode']}, {row['state']}, Australia"
        task = (f"Today's date is {date.today().isoformat()}.\n"
                f"Subject suburb: {subject}\n"
                "Research the suburb's current market figures and record them.")
        evidence = run_research_streaming(SUBURB_PROMPT, task, RECORD_EVIDENCE_TOOL,
                                          "evidence", _sanitize_evidence, on_event)
        if not evidence:
            raise SearchError("no substantiated figures found for this suburb")
        return {"evidence": evidence,
                "suburb": _persist_suburb_evidence(sid, row, evidence)}
    return research_run


@bp_suburbs.post("/ai-evidence")
@require_auth
def suburb_ai_evidence():
    if not configured():
        return _not_configured("suburb evidence")
    body = request.get_json(silent=True) or {}
    sid = body.get("suburbId")
    if not isinstance(sid, int):
        return jsonify({"ok": False, "error": "suburbId is required"}), 400
    row = db.db().fetch_one("SELECT * FROM suburbs WHERE id = ?", (sid,))
    if not row:
        return jsonify({"ok": False, "error": "suburb not found"}), 404

    try:
        result = cached(f"suburb-{sid}", TTL_12H, _suburb_evidence_run(sid, row))
    except SearchError as e:
        return _research_error(e)
    return jsonify({"ok": True, "data": result})


@bp_suburbs.post("/ai-evidence/stream")
@require_auth
def suburb_ai_evidence_stream():
    if not configured():
        return _not_configured("suburb evidence")
    body = request.get_json(silent=True) or {}
    sid = body.get("suburbId")
    if not isinstance(sid, int):
        return jsonify({"ok": False, "error": "suburbId is required"}), 400
    row = db.db().fetch_one("SELECT * FROM suburbs WHERE id = ?", (sid,))
    if not row:
        return jsonify({"ok": False, "error": "suburb not found"}), 404
    ev_q = _stream_session(f"suburb-{sid}", TTL_12H, _suburb_evidence_run(sid, row))
    return _ai_stream_response(ev_q, lambda p: p)


# ---------------------------------------------------------------------------
# 4. Listing check — subject property on-market status + last sale
# ---------------------------------------------------------------------------

RECORD_LISTING_TOOL = {
    "type": "function",
    "name": "record_listing",
    "description": "Record what you substantiated about the subject property. "
    "Call exactly once when done.",
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "required": ["listing"],
        "properties": {
            "listing": {
                "type": "object",
                "additionalProperties": False,
                "required": ["onMarket"],
                "properties": {
                    "onMarket": {"type": "boolean"},
                    "askingPrice": {"type": "number"},
                    "listedDate": {"type": "string"},
                    "agent": {"type": "string"},
                    "lastSoldPrice": {"type": "number"},
                    "lastSoldDate": {"type": "string"},
                    "url": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    "source": {"type": "string"},
                },
            }
        },
    },
}

LISTING_PROMPT = (
    "You research Australian property listings. Determine whether the EXACT "
    "subject property is currently advertised FOR SALE on realestate.com.au, "
    "domain.com.au or property.com.au: askingPrice (AUD number; use the "
    "midpoint of any price guide), listedDate (YYYY-MM), agent (agency name). "
    "Also find the property's most recent SOLD record: lastSoldPrice (AUD) "
    "and lastSoldDate (YYYY-MM). Run at most 3 web searches — a sold-listing "
    "page often covers everything. Only report what listing pages actually "
    "show for this exact address — never confuse it with a similarly "
    "addressed property; omit (null) anything you cannot verify. url is the "
    "best-matching listing page. Work briskly — long sessions time out. "
    "Finish by calling record_listing exactly once. Never answer in prose."
)


def _sanitize_listing(rows):
    r = rows if isinstance(rows, dict) else (
        rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict)
        else None)
    if not isinstance(r, dict):
        return {}
    out = {"onMarket": bool(r.get("onMarket"))}
    for k in ("askingPrice", "lastSoldPrice"):
        v = _num(r.get(k))
        out[k] = v if v is not None and v > 0 else None
    for k in ("listedDate", "lastSoldDate", "agent", "source"):
        s = str(r.get(k) or "").strip()
        out[k] = s[:200] or None
    url = str(r.get("url") or "").strip()
    out["url"] = url[:500] if url.lower().startswith(("http://", "https://")) else None
    conf = str(r.get("confidence") or "").lower()
    out["confidence"] = conf if conf in ("high", "medium", "low") else "low"
    return out


@bp_property.post("/listing-check")
@require_auth
def listing_check():
    if not configured():
        return _not_configured("listing check")
    body = request.get_json(silent=True) or {}
    address = str(body.get("address") or "").strip()
    if not address or len(address) > 300:
        return jsonify({"ok": False, "error": "address is required (max 300 chars)",
                        "fields": {"address": "required"}}), 400

    def research():
        task = (f"Today's date is {date.today().isoformat()}.\n"
                f"Subject property: {address}, Australia\n"
                "Check whether it is currently listed for sale and its most "
                "recent sold record, then record_listing.")
        return run_research(LISTING_PROMPT, task, RECORD_LISTING_TOOL,
                            "listing", _sanitize_listing)

    try:
        listing = cached(f"listing-{address.lower()}", TTL_24H, research)
    except SearchError as e:
        return _research_error(e)
    return jsonify({"ok": True, "data": {"listing": listing,
                                         "asAt": date.today().isoformat()}})


# ---------------------------------------------------------------------------
# 5. Area signals — infrastructure / planning projects near the subject
# ---------------------------------------------------------------------------

SIGNAL_TYPES = ("transport", "education", "health", "retail", "rezoning", "other")

RECORD_SIGNALS_TOOL = {
    "type": "function",
    "name": "record_signals",
    "description": "Record the projects you substantiated. Call exactly once "
    "when done.",
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "required": ["signals"],
        "properties": {
            "signals": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["name", "type", "status", "url"],
                    "properties": {
                        "name": {"type": "string"},
                        "type": {"type": "string", "enum": list(SIGNAL_TYPES)},
                        "status": {"type": "string",
                                   "enum": ["proposed", "under_construction", "completed"]},
                        "timeframe": {"type": "string"},
                        "distanceKm": {"type": "number"},
                        "url": {"type": "string"},
                        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    },
                },
            }
        },
    },
}

SIGNALS_PROMPT = (
    "You research Australian infrastructure and planning around a subject "
    "property. Find MAJOR projects within roughly 5 km that materially "
    "affect livability or values: transport (rail, motorway, airport), "
    "education (schools, universities), health (hospitals), retail or major "
    "developments, and planning/rezoning schemes. Run at most 6 web searches "
    "and record up to 8 of the strongest finds. status is proposed, "
    "under_construction or completed as best documented; timeframe is the "
    "expected completion or stage (e.g. '2032'); distanceKm is approximate. "
    "Only include projects you can substantiate with a URL; skip routine "
    "maintenance works. Work briskly — long sessions time out. Finish by "
    "calling record_signals exactly once. Never answer in prose."
)


def _sanitize_signals(rows):
    out = []
    if not isinstance(rows, list):
        return out
    for r in rows:
        if not isinstance(r, dict):
            continue
        name = str(r.get("name") or "").strip()[:120]
        url = str(r.get("url") or "").strip()
        if not name or not url.lower().startswith(("http://", "https://")):
            continue
        stype = str(r.get("type") or "").lower()
        status = str(r.get("status") or "").lower()
        dist = _num(r.get("distanceKm"))
        conf = str(r.get("confidence") or "").lower()
        out.append({
            "name": name,
            "type": stype if stype in SIGNAL_TYPES else "other",
            "status": status if status in ("proposed", "under_construction", "completed")
            else "proposed",
            "timeframe": str(r.get("timeframe") or "").strip()[:40] or None,
            "distanceKm": round(dist, 1) if dist is not None else None,
            "url": url[:500],
            "confidence": conf if conf in ("high", "medium", "low") else "low",
        })
        if len(out) >= 12:
            break
    return out


@bp_property.post("/area-signals")
@require_auth
def area_signals():
    if not configured():
        return _not_configured("area signals")
    body = request.get_json(silent=True) or {}
    address = str(body.get("address") or "").strip()
    if not address or len(address) > 300:
        return jsonify({"ok": False, "error": "address is required (max 300 chars)",
                        "fields": {"address": "required"}}), 400

    def research():
        task = (f"Today's date is {date.today().isoformat()}.\n"
                f"Subject property: {address}, Australia\n"
                "Find major nearby infrastructure and planning projects, then "
                "record_signals.")
        return run_research(SIGNALS_PROMPT, task, RECORD_SIGNALS_TOOL,
                            "signals", _sanitize_signals)

    try:
        signals = cached(f"signals-{address.lower()}", TTL_24H, research)
    except SearchError as e:
        return _research_error(e)
    return jsonify({"ok": True, "data": {"signals": signals,
                                         "asAt": date.today().isoformat()}})


# --- Streaming variants (single-session; live web_search progress) ----------

@bp_property.post("/listing-check/stream")
@require_auth
def listing_check_stream():
    if not configured():
        return _not_configured("listing check")
    body = request.get_json(silent=True) or {}
    address = str(body.get("address") or "").strip()
    if not address or len(address) > 300:
        return jsonify({"ok": False, "error": "address is required (max 300 chars)",
                        "fields": {"address": "required"}}), 400

    def run(on_event):
        task = (f"Today's date is {date.today().isoformat()}.\n"
                f"Subject property: {address}, Australia\n"
                "Check whether it is currently listed for sale and its most "
                "recent sold record, then record_listing.")
        return run_research_streaming(LISTING_PROMPT, task, RECORD_LISTING_TOOL,
                                      "listing", _sanitize_listing, on_event)

    ev_q = _stream_session(f"listing-{address.lower()}", TTL_24H, run)
    return _ai_stream_response(
        ev_q, lambda payload: {"listing": payload, "asAt": date.today().isoformat()})


@bp_property.post("/area-signals/stream")
@require_auth
def area_signals_stream():
    if not configured():
        return _not_configured("area signals")
    body = request.get_json(silent=True) or {}
    address = str(body.get("address") or "").strip()
    if not address or len(address) > 300:
        return jsonify({"ok": False, "error": "address is required (max 300 chars)",
                        "fields": {"address": "required"}}), 400

    def run(on_event):
        task = (f"Today's date is {date.today().isoformat()}.\n"
                f"Subject property: {address}, Australia\n"
                "Find major nearby infrastructure and planning projects, then "
                "record_signals.")
        return run_research_streaming(SIGNALS_PROMPT, task, RECORD_SIGNALS_TOOL,
                                      "signals", _sanitize_signals, on_event)

    ev_q = _stream_session(f"signals-{address.lower()}", TTL_24H, run)
    return _ai_stream_response(
        ev_q, lambda payload: {"signals": payload, "asAt": date.today().isoformat()})
