# Copyright (c) 2026 RV
"""
AI property evidence search — sold comps and rental comps via the gateway.

POST /api/comps/search  {address, beds?} -> comparable SOLD properties
POST /api/rentals/search {address, beds?} -> comparable RENTAL listings

Candidates are reviewed in the UI and selectively saved via the normal
comps/rentals endpoints. Results are transient: nothing is persisted here.

Dormant by design: PA_ULTIMATEAI_API_KEY unset -> 503 "not configured" and
the UI explains itself. Adding the key later flips it on with zero code
change. The gateway bills per web search plus tokens, so the search count
is capped.

Only /v1/responses runs the native web_search tool on this gateway and
text.format json_schema is not enforced, so structured output goes through
a record_* function tool — see gateway_search.py for the transport.

Verified live model: gpt-5.6-sol (default, PA_COMPS_MODEL override).
"""

from datetime import date

import json
import queue

from flask import Blueprint, Response, jsonify, request

from auth import require_auth
from gateway_search import (
    SearchError,
    cached,
    cache_put,
    cached_get,
    collect_parallel_research,
    configured,
    start_parallel_research,
    TIMEOUT,
)

# Re-exported: tests monkeypatch search_sold_comps/search_rentals and
# construct CompsSearchError directly.
CompsSearchError = SearchError

bp = Blueprint("comps_search", __name__, url_prefix="/api/comps")
bp_rentals = Blueprint("rentals_search", __name__, url_prefix="/api/rentals")

MAX_COMPS = 15
# Research runs as two parallel source shards (gateway allows 2 concurrent
# sessions); per-shard budgets keep each session inside the gateway's
# ~100s Cloudflare edge limit.
TTL_30MIN = 30 * 60


# No tool_choice: defaulting to auto so the model searches before recording
# (forcing record_* up front would make it "record" before any searches).

RECORD_COMPS_TOOL = {
    "type": "function",
    "name": "record_comps",
    "description": "Record the comparable sold properties you substantiated. "
    "Call exactly once when your research is done.",
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "required": ["comps"],
        "properties": {
            "comps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["address", "soldPrice", "soldDate", "url", "confidence"],
                    "properties": {
                        "address": {"type": "string"},
                        "soldPrice": {"type": "number"},
                        "soldDate": {"type": "string"},
                        "beds": {"type": "integer"},
                        "distanceKm": {"type": "number"},
                        "landM2": {"type": "number"},
                        "rentEstimate": {"type": "number"},
                        "url": {"type": "string"},
                        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                        "source": {"type": "string"},
                    },
                },
            }
        },
    },
}

RECORD_RENTALS_TOOL = {
    "type": "function",
    "name": "record_rentals",
    "description": "Record the comparable rental listings you substantiated. "
    "Call exactly once when your research is done.",
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "required": ["rentals"],
        "properties": {
            "rentals": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["address", "rentWeekly", "url", "confidence"],
                    "properties": {
                        "address": {"type": "string"},
                        "rentWeekly": {"type": "number"},
                        "bedrooms": {"type": "integer"},
                        "propertyType": {"type": "string", "enum": ["house", "unit", "townhouse"]},
                        "listedDate": {"type": "string"},
                        "distanceKm": {"type": "number"},
                        "url": {"type": "string"},
                        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                        "source": {"type": "string"},
                    },
                },
            }
        },
    },
}

def _shard_prompt(kind, sites):
    """Per-shard instructions: each shard covers distinct sites so the two
    parallel sessions don't duplicate each other's searches."""
    if kind == "sold":
        role = ("You research recent Australian residential property sales, "
                "working like a careful buyer's agent assembling comparable "
                "sales for a valuation.")
        extra_scope = " sold over the last 6 months"
        rules = ("Only report properties actually SOLD (not for sale, not under "
                 "offer); exclude the subject property and duplicates; soldPrice "
                 "is the AUD sale price and soldDate is YYYY-MM; if a price cannot "
                 "be verified, drop the comp rather than estimating it; "
                 "rentEstimate ($/week) only if a source states it; confidence "
                 "high = price and date visible in a snippet or listing, medium = "
                 "inferred from nearby data, low = weak evidence.")
        target = "target 3-6 substantiated comps"
    else:
        role = ("You research the Australian residential rental market, working "
                "like a careful property manager assembling rental evidence for "
                "a rent appraisal.")
        extra_scope = (" currently advertised FOR RENT (or leased within the "
                       "last 3 months)")
        rules = ("Only report listings where the weekly rent is explicitly stated "
                 "(drop the listing rather than estimating it); rentWeekly is the "
                 "AUD per-week rent; exclude the subject property and duplicates; "
                 "confidence high = rent visible in a snippet or listing, medium = "
                 "inferred from nearby data, low = weak evidence.")
        target = "target 3-5 substantiated rentals"
    return (
        f"{role}\n"
        "You are one of two researchers running in parallel over DIFFERENT "
        f"sources — cover ONLY {sites}. SPEED IS CRITICAL: run at most 2 web "
        "searches on your sites and do NOT open listings — record directly "
        "from search snippets (they show sold price, date and beds). Find "
        "properties near the subject within roughly 1-2 km with a comparable "
        f"bedroom count{extra_scope}. Only include comps whose price and date "
        "are visible in the snippet. Set distanceKm to your best estimate of "
        f"straight-line km from the subject. {rules} Work as FAST as possible "
        f"and {target} — your session is killed at 100 seconds, so speed beats "
        "completeness (the other researcher covers the rest). Finish by "
        "calling the record tool exactly once. Never answer in prose."
    )


SOLD_SHARD_SITES = (
    "realestate.com.au and onthehouse.com.au",
    "domain.com.au, propertyvalue.com.au and local agent sold-results pages",
)
RENTAL_SHARD_SITES = (
    "realestate.com.au and rent.com.au",
    "domain.com.au, homely.com.au and local agent current-rentals pages",
)


def _shards(kind, address, beds):
    sites = SOLD_SHARD_SITES if kind == "sold" else RENTAL_SHARD_SITES
    tool, list_key, sanitize = (
        (RECORD_COMPS_TOOL, "comps", _sanitize)
        if kind == "sold" else (RECORD_RENTALS_TOOL, "rentals", _sanitize_rentals))
    ask = ("Find comparable recent sales on your sites and record them."
           if kind == "sold" else
           "Find comparable nearby rental listings on your sites and record them.")
    subject = _subject(address, beds)
    return [
        {"name": f"source {'AB'[i]}", "instructions": _shard_prompt(kind, s),
         "task": subject + ask, "record_tool": tool, "list_key": list_key,
         "sanitize": sanitize}
        for i, s in enumerate(sites)
    ]


def _dedupe_address(row):
    return (row.get("address") or "").lower()[:80]


def search_sold_comps(address, beds=None):
    """Two parallel source shards, merged + deduped. Tests monkeypatch this."""
    return cached(f"comps-{address.lower()}-{beds or 0}", TTL_30MIN,
                  lambda: collect_parallel_research(
                      _shards("sold", address, beds), _dedupe_address))


def search_rentals(address, beds=None):
    """Two parallel rental-evidence shards. Tests monkeypatch this."""
    return cached(f"rentals-{address.lower()}-{beds or 0}", TTL_30MIN,
                  lambda: collect_parallel_research(
                      _shards("rental", address, beds), _dedupe_address))


def _num(v):
    try:
        f = float(v)
        return f if f == f and abs(f) != float("inf") else None
    except (TypeError, ValueError):
        return None


def _sanitize(rows):
    """Coerce/validate model output; drop rows without address+price."""
    if not isinstance(rows, list):
        return []
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        address = str(r.get("address") or "").strip()[:300]
        price = _num(r.get("soldPrice"))
        url = str(r.get("url") or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            url = ""
        if not address or price is None or price <= 0:
            continue
        beds = _num(r.get("beds"))
        confidence = str(r.get("confidence") or "").lower()
        out.append({
            "address": address,
            "soldPrice": price,
            "soldDate": str(r.get("soldDate") or "").strip()[:20],
            "beds": int(beds) if beds else None,
            "distanceKm": _num(r.get("distanceKm")),
            "landM2": _num(r.get("landM2")),
            "rentEstimate": _num(r.get("rentEstimate")),
            "url": url[:500],
            "confidence": confidence if confidence in ("high", "medium", "low") else "low",
            "source": str(r.get("source") or "").strip()[:80],
        })
        if len(out) >= MAX_COMPS:
            break
    return out


def _sanitize_rentals(rows):
    """Coerce/validate model output; drop rows without address+rent."""
    if not isinstance(rows, list):
        return []
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        address = str(r.get("address") or "").strip()[:300]
        rent = _num(r.get("rentWeekly"))
        url = str(r.get("url") or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            url = ""
        if not address or rent is None or rent <= 0:
            continue
        beds = _num(r.get("bedrooms"))
        ptype = str(r.get("propertyType") or "").lower()
        confidence = str(r.get("confidence") or "").lower()
        out.append({
            "address": address,
            "rentWeekly": rent,
            "bedrooms": int(beds) if beds is not None and beds >= 0 else None,
            "propertyType": ptype if ptype in ("house", "unit", "townhouse") else None,
            "listedDate": str(r.get("listedDate") or "").strip()[:20] or None,
            "distanceKm": _num(r.get("distanceKm")),
            "url": url[:500],
            "confidence": confidence if confidence in ("high", "medium", "low") else "low",
            "source": str(r.get("source") or "").strip()[:80],
        })
        if len(out) >= MAX_COMPS:
            break
    return out


def _search_body():
    body = request.get_json(silent=True) or {}
    address = str(body.get("address") or "").strip()
    if not address or len(address) > 300:
        return None
    beds = None
    if isinstance(body.get("beds"), (int, float)) and body["beds"] > 0:
        beds = int(body["beds"])
    return address, beds


def _subject(address, beds):
    subject = address
    if beds:
        subject += f", {beds} bedrooms"
    return (
        f"Today's date is {date.today().isoformat()}.\n"
        f"Subject property: {subject}, Australia\n"
    )


def _search_error_response(e):
    return jsonify({"ok": False, "error": f"comps search failed: {e}"}), e.http_status


@bp.post("/search")
@require_auth
def search_route():
    parsed = _search_body()
    if parsed is None:
        return jsonify({"ok": False, "error": "address is required (max 300 chars)",
                        "fields": {"address": "required"}}), 400
    if not configured():
        return jsonify({"ok": False, "error": "comps search is not configured "
                        "(PA_ULTIMATEAI_API_KEY)"}), 503
    address, beds = parsed
    try:
        comps = search_sold_comps(address, beds)
    except CompsSearchError as e:
        return _search_error_response(e)
    return jsonify({"ok": True, "data": {"comps": comps}})


@bp_rentals.post("/search")
@require_auth
def rental_search_route():
    parsed = _search_body()
    if parsed is None:
        return jsonify({"ok": False, "error": "address is required (max 300 chars)",
                        "fields": {"address": "required"}}), 400
    if not configured():
        return jsonify({"ok": False, "error": "rental search is not configured "
                        "(PA_ULTIMATEAI_API_KEY)"}), 503
    address, beds = parsed
    try:
        rentals = search_rentals(address, beds)
    except CompsSearchError as e:
        return _search_error_response(e)
    return jsonify({"ok": True, "data": {"rentals": rentals}})


# --- Streaming variants -----------------------------------------------------
# Same auth/validation as the JSON routes; returns SSE frames:
#   {"type": "progress", "shard"/"note"/"query": ...}  live research events
#   {"type": "done", "comps"|"rentals": [...]}         final payload
#   {"type": "error", "error": "..."}                  on failure


def _search_stream_response(kind, address, beds, key):
    """kind is "sold" or "rental" (the shard vocabulary); the done frame
    key derives from it."""
    done_key = "comps" if kind == "sold" else "rentals"
    hit = cached_get(key, TTL_30MIN)
    if hit is not None:
        return Response("data: " + json.dumps({"type": "done", done_key: hit}) + "\n\n",
                        mimetype="text/event-stream")
    ev_q = start_parallel_research(_shards(kind, address, beds), _dedupe_address)

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
                {"type": "error", "error": err or "search failed"}) + "\n\n"
            return
        cache_put(key, rows)
        yield "data: " + json.dumps({"type": "done", done_key: rows}) + "\n\n"

    return Response(generate(), mimetype="text/event-stream")


@bp.post("/search/stream")
@require_auth
def search_stream_route():
    parsed = _search_body()
    if parsed is None:
        return jsonify({"ok": False, "error": "address is required (max 300 chars)",
                        "fields": {"address": "required"}}), 400
    if not configured():
        return jsonify({"ok": False, "error": "comps search is not configured "
                        "(PA_ULTIMATEAI_API_KEY)"}), 503
    address, beds = parsed
    return _search_stream_response("sold", address, beds,
                                   f"comps-{address.lower()}-{beds or 0}")


@bp_rentals.post("/search/stream")
@require_auth
def rental_search_stream_route():
    parsed = _search_body()
    if parsed is None:
        return jsonify({"ok": False, "error": "address is required (max 300 chars)",
                        "fields": {"address": "required"}}), 400
    if not configured():
        return jsonify({"ok": False, "error": "rental search is not configured "
                        "(PA_ULTIMATEAI_API_KEY)"}), 503
    address, beds = parsed
    return _search_stream_response("rental", address, beds,
                                   f"rentals-{address.lower()}-{beds or 0}")
