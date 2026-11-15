# Copyright (c) 2026 RV
"""
Scenario CRUD API — scoped to the logged-in user.

The calculation engine lives client-side (static/engine.js); the backend
only persists the flat `inputs` object as JSON. Because we don't compute
anything here, validation is structural only — types, ranges, and enum
values — not a duplicate of the engine's business rules.

Every route requires a valid Bearer token (auth.require_auth) and only
ever touches rows belonging to g.user.

All responses use the gk_crm envelope:
    success: {ok: true, data: ...}
    failure: {ok: false, error: "...", fields: {field: message}}
"""

import json
import math

from flask import Blueprint, g, jsonify, request

import db
from auth import require_auth

bp = Blueprint("scenarios", __name__, url_prefix="/api/scenarios")

MAX_NAME = 120
MAX_DESC = 2000

# Known enum-ish fields with allowed values. Anything not listed here is
# still validated as a number/string generically; this only covers fields
# where a wrong value would silently corrupt a projection.
_ENUM_FIELDS = {
    "state": {"QLD", "NSW", "VIC", "SA", "WA", "TAS", "NT", "ACT"},
    "buyerType": {"resident", "foreign"},
    "propertyType": {"house", "unit", "townhouse"},
    "ownershipType": {"sole", "joint_50_50"},
    "ipRepaymentType": {"interest_only", "principal_and_interest"},
    "pporRepaymentType": {"interest_only", "principal_and_interest"},
    "equityLoanRepaymentType": {"interest_only", "principal_and_interest"},
    "lmiTreatment": {"capitalised", "paid_cash"},
}

# Percent fields stored as decimals (0.07 = 7%): bounded 0..1.
_PCT_FIELDS = {
    "ipLvr", "propertyManagementRate", "maintenanceRate", "sellingCostRate",
    "equityLoanPurposePercent", "expectedCapitalGrowthRate",
    "annualRentGrowthRate", "expenseGrowthRate", "otherTaxableIncomeGrowthRate",
    "landValueGrowthRate", "medicareLevyRate", "capitalWorksRate",
}


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


MAX_PROPERTIES = 6


def _structural_fields(pairs, projection_years, prefix=""):
    """Generic enum/pct/number/string checks over (key, value) pairs."""
    fields = {}
    for key, val in pairs:
        fk = prefix + key
        if key in _ENUM_FIELDS:
            if val not in _ENUM_FIELDS[key]:
                fields[fk] = f"must be one of: {', '.join(sorted(_ENUM_FIELDS[key]))}"
        elif key in _PCT_FIELDS:
            if not _is_num(val) or val < 0 or val > 1:
                fields[fk] = "must be a number between 0 and 1"
        elif isinstance(val, bool):
            continue
        elif _is_num(val):
            if val < 0:
                fields[fk] = "must be zero or positive"
        elif isinstance(val, str):
            if len(val) > 500:
                fields[fk] = "too long"
        # unknown types (null, lists, dicts) pass through — engine handles defaults
    if projection_years > 50:
        fields[prefix + "projectionYears"] = "must be 50 years or fewer"
    return fields


def _check_property(prop, idx, projection_years, fields):
    """Structural checks for one properties[i] member, dotted keys."""
    prefix = f"properties.{idx}."
    fields.update(_structural_fields(
        ((k, v) for k, v in prop.items() if k != "addressMeta"), 0, prefix))
    if "saleYear" in prop and _is_num(prop["saleYear"]) and prop["saleYear"] > projection_years:
        fields[prefix + "saleYear"] = "must be within the projection window"


def validate_inputs(inputs):
    """Return {field: message} (empty dict = valid). Structural checks only."""
    fields = {}
    if not isinstance(inputs, dict):
        return {"inputs": "must be an object"}

    projection_years = inputs.get("projectionYears", 20)
    fields.update(_structural_fields(
        ((k, v) for k, v in inputs.items() if k != "properties"), projection_years))

    # Multi-property payloads: validate each member with dotted keys so the
    # UI can attach errors to the right property tab.
    if "properties" in inputs:
        props = inputs["properties"]
        if not isinstance(props, list) or not (1 <= len(props) <= MAX_PROPERTIES):
            fields["properties"] = f"must be a list of 1 to {MAX_PROPERTIES} properties"
        else:
            for i, prop in enumerate(props):
                if not isinstance(prop, dict):
                    fields[f"properties.{i}"] = "must be an object"
                    continue
                _check_property(prop, i, projection_years, fields)

    if "saleYear" in inputs and inputs["saleYear"] > projection_years:
        fields["saleYear"] = "must be within the projection window"

    if inputs.get("ownershipType") == "joint_50_50":
        if inputs.get("owner1OwnershipPercent", 0.5) + inputs.get("owner2OwnershipPercent", 0.5) > 1.001:
            fields["owner1OwnershipPercent"] = "ownership shares must total 100%"
    return fields


def _inputs_address(inputs):
    """Display address: properties[0].address on v3 payloads, flat fallback."""
    if not isinstance(inputs, dict):
        return ""
    props = inputs.get("properties")
    if isinstance(props, list) and props and isinstance(props[0], dict):
        return str(props[0].get("address", "") or "")
    return str(inputs.get("address", "") or "")


def _scenario_row(row, with_inputs=True):
    out = {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "address": row["address"],
        "suburbId": row["suburb_id"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    if with_inputs:
        out["inputs"] = json.loads(row["inputs_json"])
    return out


def _owned(sid):
    """Fetch a scenario owned by the current user, or None."""
    return db.db().fetch_one(
        "SELECT * FROM scenarios WHERE id = ? AND user_id = ?",
        (sid, g.user["id"]),
    )


@bp.get("")
@bp.get("/")
@require_auth
def list_scenarios():
    rows = db.db().fetch_all(
        "SELECT id, name, description, address, suburb_id, created_at, updated_at "
        "FROM scenarios WHERE user_id = ? "
        "ORDER BY updated_at DESC",
        (g.user["id"],),
    )
    return jsonify({"ok": True, "data": [_scenario_row(r, with_inputs=False) for r in rows]})


@bp.get("/<int:sid>")
@require_auth
def get_scenario(sid):
    row = _owned(sid)
    if not row:
        return jsonify({"ok": False, "error": "scenario not found"}), 404
    return jsonify({"ok": True, "data": _scenario_row(row)})


@bp.post("")
@bp.post("/")
@require_auth
def create_scenario():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"ok": False, "error": "body must be JSON"}), 400

    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "name is required",
                        "fields": {"name": "required"}}), 400
    if len(name) > MAX_NAME:
        return jsonify({"ok": False, "error": "name too long",
                        "fields": {"name": f"max {MAX_NAME} chars"}}), 400
    desc = (body.get("description") or "")[:MAX_DESC]

    fields = validate_inputs(body.get("inputs"))
    if fields:
        return jsonify({"ok": False, "error": "validation failed", "fields": fields}), 400

    sid = db.db().execute(
        "INSERT INTO scenarios (user_id, name, description, inputs_json, address, suburb_id) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (g.user["id"], name, desc, json.dumps(body.get("inputs", {})),
         _inputs_address(body.get("inputs", {}))[:300],
         int(body.get("inputs", {}).get("suburbId", 0) or 0)),
    )
    row = db.db().fetch_one("SELECT * FROM scenarios WHERE id = ?", (sid,))
    return jsonify({"ok": True, "data": _scenario_row(row)}), 201


@bp.put("/<int:sid>")
@require_auth
def update_scenario(sid):
    row = _owned(sid)
    if not row:
        return jsonify({"ok": False, "error": "scenario not found"}), 404

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"ok": False, "error": "body must be JSON"}), 400

    name = (body.get("name") or row["name"]).strip() or row["name"]
    desc = (body.get("description") if body.get("description") is not None
            else row["description"])[:MAX_DESC]

    fields = validate_inputs(body.get("inputs", json.loads(row["inputs_json"])))
    if fields:
        return jsonify({"ok": False, "error": "validation failed", "fields": fields}), 400

    version = row["version"] + 1
    inputs = body.get("inputs", json.loads(row["inputs_json"]))
    db.db().execute(
        "UPDATE scenarios SET name = ?, description = ?, inputs_json = ?, "
        "version = ?, address = ?, suburb_id = ?, updated_at = datetime('now') WHERE id = ?",
        (name, desc, json.dumps(inputs), version,
         _inputs_address(inputs)[:300],
         int(inputs.get("suburbId", 0) or 0), sid),
    )
    updated = db.db().fetch_one("SELECT * FROM scenarios WHERE id = ?", (sid,))
    return jsonify({"ok": True, "data": _scenario_row(updated)})


@bp.delete("/<int:sid>")
@require_auth
def delete_scenario(sid):
    row = _owned(sid)
    if not row:
        return jsonify({"ok": False, "error": "scenario not found"}), 404
    db.db().execute("DELETE FROM comps WHERE scenario_id = ?", (sid,))
    db.db().execute("DELETE FROM scenarios WHERE id = ?", (sid,))
    return jsonify({"ok": True, "data": {"deleted": True, "id": sid}})


@bp.post("/<int:sid>/duplicate")
@require_auth
def duplicate_scenario(sid):
    row = _owned(sid)
    if not row:
        return jsonify({"ok": False, "error": "scenario not found"}), 404

    body = request.get_json(silent=True) or {}
    new_name = (body.get("name") or f"{row['name']} (copy)").strip()[:MAX_NAME]
    new_sid = db.db().execute(
        "INSERT INTO scenarios (user_id, name, description, inputs_json, address, suburb_id) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (g.user["id"], new_name, row["description"], row["inputs_json"],
         row["address"], row["suburb_id"]),
    )
    # Copy comparable sales across so the variant keeps its evidence.
    comps = db.db().fetch_all("SELECT * FROM comps WHERE scenario_id = ?", (sid,))
    for c in comps:
        db.db().execute(
            "INSERT INTO comps (scenario_id, address, sold_price, sold_date, beds, "
            "land_m2, rent_estimate, url, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (new_sid, c["address"], c["sold_price"], c["sold_date"], c["beds"],
             c["land_m2"], c["rent_estimate"], c["url"], c["notes"]),
        )
    new_row = db.db().fetch_one("SELECT * FROM scenarios WHERE id = ?", (new_sid,))
    return jsonify({"ok": True, "data": _scenario_row(new_row)}), 201
