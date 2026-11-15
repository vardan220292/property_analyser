# Copyright (c) 2026 RV
"""
AI sold-comps search — Claude with the server-side web search tool.

POST /api/comps/search {address, beds?} -> candidate comparables that the
user reviews in the UI and selectively saves via the normal comps endpoint.
Results are transient: nothing is persisted here.

Dormant by design: PA_ANTHROPIC_API_KEY unset -> 503 "not configured" and
the UI explains itself. Adding the key later flips it on with zero code
change. API usage is billed per web search (~$10/1000 searches) plus
tokens, so the search count is capped.
"""

import os
from datetime import date

from flask import Blueprint, jsonify, request

from auth import require_auth

bp = Blueprint("comps_search", __name__, url_prefix="/api/comps")

MODEL = "claude-sonnet-4-6"
MAX_COMPS = 15
MAX_SEARCHES = 10


class CompsSearchError(Exception):
    def __init__(self, message, http_status=502):
        super().__init__(message)
        self.http_status = http_status


def configured():
    return bool(os.environ.get("PA_ANTHROPIC_API_KEY"))


# Auto tool_choice is deliberate: forcing record_comps up front would make
# the model "record" before running any searches.
TOOLS = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": MAX_SEARCHES},
    {"type": "web_fetch_20260209", "name": "web_fetch"},
    {
        "name": "record_comps",
        "description": "Record the comparable sold properties you substantiated. "
        "Call exactly once when your research is done.",
        "input_schema": {
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
    },
]

SYSTEM_PROMPT = (
    "You research recent Australian residential property sales. Work like a "
    "careful buyer's agent assembling comparable sales for a valuation.\n"
    "Method: use web_search to find properties SOLD near the subject within "
    "roughly 1-2 km over the last 6 months with a comparable bedroom count "
    "(and similar land size where discoverable). Prefer sold listings on "
    "realestate.com.au, domain.com.au, onthehouse.com.au and propertyvalue.com.au; "
    "use web_fetch to read promising pages instead of guessing from snippets.\n"
    "Rules: only report properties actually SOLD (not for sale, not under offer); "
    "exclude the subject property and duplicates; soldPrice is the AUD sale "
    "price and soldDate is YYYY-MM; if a price cannot be verified, drop the "
    "comp rather than estimating it; rentEstimate ($/week) only if a source "
    "states it; confidence high = price and date read from a sold listing, "
    "medium = inferred from nearby data, low = weak evidence.\n"
    "Finish by calling record_comps exactly once with every comp you can "
    "substantiate (5-15 if available, fewer is fine when the evidence is thin). "
    "Never answer in prose."
)


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
            "landM2": _num(r.get("landM2")),
            "rentEstimate": _num(r.get("rentEstimate")),
            "url": url[:500],
            "confidence": confidence if confidence in ("high", "medium", "low") else "low",
            "source": str(r.get("source") or "").strip()[:80],
        })
        if len(out) >= MAX_COMPS:
            break
    return out


def search_sold_comps(address, beds=None):
    """Run the AI search and return sanitized comp rows. Tests monkeypatch this."""
    try:
        import anthropic
    except ImportError as e:
        raise CompsSearchError("anthropic SDK not installed") from e

    subject = f"{address} (Queensland, Australia)"
    if beds:
        subject += f", {beds} bedrooms"
    task = (
        f"Today's date is {date.today().isoformat()}.\n"
        f"Subject property: {subject}\n"
        f"Find comparable recent sales near the subject and finish by calling "
        f"record_comps."
    )
    try:
        client = anthropic.Anthropic(
            api_key=os.environ["PA_ANTHROPIC_API_KEY"], timeout=120.0
        )
        response = client.messages.create(
            model=MODEL,
            max_tokens=8000,
            system=SYSTEM_PROMPT,
            thinking={"type": "adaptive"},
            tools=TOOLS,
            messages=[{"role": "user", "content": task}],
        )
    except anthropic.APIError as e:
        raise CompsSearchError(f"Anthropic API error: {e}") from e

    for block in response.content:
        if block.type == "tool_use" and block.name == "record_comps":
            payload = block.input if isinstance(block.input, dict) else {}
            return _sanitize(payload.get("comps"))
    raise CompsSearchError("search produced no structured results")


@bp.post("/search")
@require_auth
def search_route():
    body = request.get_json(silent=True) or {}
    address = str(body.get("address") or "").strip()
    if not address or len(address) > 300:
        return jsonify({"ok": False, "error": "address is required (max 300 chars)",
                        "fields": {"address": "required"}}), 400
    if not configured():
        return jsonify({"ok": False, "error": "comps search is not configured "
                        "(PA_ANTHROPIC_API_KEY)"}), 503
    beds = None
    if isinstance(body.get("beds"), (int, float)) and body["beds"] > 0:
        beds = int(body["beds"])
    try:
        comps = search_sold_comps(address, beds)
    except CompsSearchError as e:
        return jsonify({"ok": False, "error": f"comps search failed: {e}"}), e.http_status
    return jsonify({"ok": True, "data": {"comps": comps}})
