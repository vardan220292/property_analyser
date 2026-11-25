# Copyright (c) 2026 RV
"""
Area data API — suburbs, comparable sales, bank rates.

Reference data the investor can edit in-app:
  - suburbs:   per-suburb stats (median price, median rents by bedroom,
               vacancy, 5-yr growth, supply pressure) with per-field sources
  - comps:     manually-entered comparable sales, per scenario
  - bank rates: investor loan rate reference table

Field naming: the engine expects camelCase (medianPrice, medianRent3Bed,
vacancyPct, growth5yrPct, approvalsRatio), so rows are mapped on the way
out. Percent fields are stored as percent numbers (1.6 = 1.6%); bank rates
as decimals (0.0649).
"""

import json
import math

from flask import Blueprint, g, jsonify, request

import db
from auth import require_auth

bp = Blueprint("areadata", __name__, url_prefix="/api")

MAX_TEXT = 300


def _num(v):
    """Coerce to float or None (empty string / None -> None)."""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _int(v):
    f = _num(v)
    return int(f) if f is not None else None


# ---------------------------------------------------------------------------
# Suburbs
# ---------------------------------------------------------------------------

def _suburb_payload(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "postcode": row["postcode"],
        "state": row["state"],
        "sa2Code": row["sa2_code"] if "sa2_code" in row.keys() else None,
        "medianPrice": row["median_price"],
        "medianRent2Bed": row["median_rent_2bed"],
        "medianRent3Bed": row["median_rent_3bed"],
        "medianRent4Bed": row["median_rent_4bed"],
        "vacancyPct": row["vacancy_pct"],
        "growth5yrPct": row["growth_5yr_pct"],
        "populationGrowthPct": row["population_growth_pct"],
        "approvalsRatio": row["approvals_ratio"],
        "medianDaysOnMarket": row["median_days_on_market"],
        "sources": json.loads(row["sources_json"] or "{}"),
        "updatedAt": row["updated_at"],
    }


def _validate_suburb(body, partial=False):
    """Return (values, fields). values = cleaned column values."""
    fields = {}
    values = {}

    if not partial or "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            fields["name"] = "required"
        elif len(name) > 120:
            fields["name"] = "too long"
        else:
            values["name"] = name
    if not partial or "postcode" in body:
        pc = str(body.get("postcode") or "").strip()
        if not pc:
            fields["postcode"] = "required"
        elif len(pc) > 10:
            fields["postcode"] = "too long"
        else:
            values["postcode"] = pc

    numeric = {
        "medianPrice": (0, 100e6),
        "medianRent2Bed": (0, 5000),
        "medianRent3Bed": (0, 5000),
        "medianRent4Bed": (0, 5000),
        "vacancyPct": (0, 30),
        "growth5yrPct": (-50, 200),
        "populationGrowthPct": (-20, 50),
        "approvalsRatio": (0, 20),
        "medianDaysOnMarket": (0, 2000),
    }
    for key, (lo, hi) in numeric.items():
        if key not in body:
            continue
        v = _num(body.get(key))
        if v is not None and (v < lo or v > hi):
            fields[key] = f"must be between {lo} and {hi}"
        else:
            values[key] = v

    if "sources" in body:
        src = body.get("sources")
        if isinstance(src, dict):
            values["sources_json"] = json.dumps(src)
        elif src in (None, ""):
            values["sources_json"] = "{}"
        else:
            fields["sources"] = "must be an object"
    return values, fields


@bp.get("/suburbs")
@require_auth
def list_suburbs():
    rows = db.db().fetch_all("SELECT * FROM suburbs ORDER BY name, postcode")
    _resolve_sa2_crosswalk(rows)
    return jsonify({"ok": True, "data": [_suburb_payload(r) for r in rows]})


def _resolve_sa2_crosswalk(rows, cap=25):
    """Fill in sa2_code for suburb rows missing it (lazy crosswalk via the
    ABS SA2 name list). Bounded per call so first loads stay responsive."""
    import census

    missing = [r for r in rows if not r["sa2_code"]]
    if not missing:
        return 0
    resolved = 0
    for r in missing[:cap]:
        try:
            code = census.match_sa2_for_suburb(r["name"], r["state"])
        except Exception:
            code = None
        if code:
            db.db().execute("UPDATE suburbs SET sa2_code = ? WHERE id = ?",
                            (code, r["id"]))
            r["sa2_code"] = code
            resolved += 1
    return resolved


@bp.post("/suburbs")
@require_auth
def create_suburb():
    body = request.get_json(silent=True) or {}
    values, fields = _validate_suburb(body)
    if fields:
        return jsonify({"ok": False, "error": "validation failed", "fields": fields}), 400

    exists = db.db().fetch_one(
        "SELECT id FROM suburbs WHERE name = ? AND postcode = ?",
        (values["name"], values["postcode"]))
    if exists:
        return jsonify({"ok": False, "error": "that suburb already exists"}), 409

    cols = ["name", "postcode", "state", "median_price", "median_rent_2bed",
            "median_rent_3bed", "median_rent_4bed", "vacancy_pct",
            "growth_5yr_pct", "population_growth_pct", "approvals_ratio",
            "median_days_on_market", "sources_json"]
    vals = [
        values["name"], values["postcode"], body.get("state", "QLD"),
        values.get("medianPrice"), values.get("medianRent2Bed"),
        values.get("medianRent3Bed"), values.get("medianRent4Bed"),
        values.get("vacancyPct"), values.get("growth5yrPct"),
        values.get("populationGrowthPct"), values.get("approvalsRatio"),
        values.get("medianDaysOnMarket"), values.get("sources_json", "{}"),
    ]
    sid = db.db().execute(
        f"INSERT INTO suburbs ({', '.join(cols)}) VALUES ({', '.join(['?'] * len(cols))})",
        vals)
    row = db.db().fetch_one("SELECT * FROM suburbs WHERE id = ?", (sid,))
    return jsonify({"ok": True, "data": _suburb_payload(row)}), 201


@bp.put("/suburbs/<int:sid>")
@require_auth
def update_suburb(sid):
    row = db.db().fetch_one("SELECT * FROM suburbs WHERE id = ?", (sid,))
    if not row:
        return jsonify({"ok": False, "error": "suburb not found"}), 404

    body = request.get_json(silent=True) or {}
    values, fields = _validate_suburb(body, partial=True)
    if fields:
        return jsonify({"ok": False, "error": "validation failed", "fields": fields}), 400
    if not values:
        return jsonify({"ok": True, "data": _suburb_payload(row)})

    column_map = {
        "name": "name", "postcode": "postcode", "medianPrice": "median_price",
        "medianRent2Bed": "median_rent_2bed", "medianRent3Bed": "median_rent_3bed",
        "medianRent4Bed": "median_rent_4bed", "vacancyPct": "vacancy_pct",
        "growth5yrPct": "growth_5yr_pct", "populationGrowthPct": "population_growth_pct",
        "approvalsRatio": "approvals_ratio", "medianDaysOnMarket": "median_days_on_market",
        "sources_json": "sources_json",
    }
    sets = []
    vals = []
    for key, value in values.items():
        sets.append(f"{column_map[key]} = ?")
        vals.append(value)
    if "state" in body:
        sets.append("state = ?")
        vals.append(body.get("state", "QLD"))
    vals.append(sid)
    db.db().execute(
        f"UPDATE suburbs SET {', '.join(sets)}, updated_at = datetime('now') WHERE id = ?",
        vals)
    updated = db.db().fetch_one("SELECT * FROM suburbs WHERE id = ?", (sid,))
    return jsonify({"ok": True, "data": _suburb_payload(updated)})


@bp.delete("/suburbs/<int:sid>")
@require_auth
def delete_suburb(sid):
    count = db.db().execute("DELETE FROM suburbs WHERE id = ?", (sid,))
    if not count:
        return jsonify({"ok": False, "error": "suburb not found"}), 404
    return jsonify({"ok": True, "data": {"deleted": True, "id": sid}})


# ---------------------------------------------------------------------------
# Comparable sales (per scenario, ownership via the scenario)
# ---------------------------------------------------------------------------

def _comp_payload(row):
    return {
        "id": row["id"],
        "scenarioId": row["scenario_id"],
        "address": row["address"],
        "soldPrice": row["sold_price"],
        "soldDate": row["sold_date"],
        "beds": row["beds"],
        "landM2": row["land_m2"],
        "rentEstimate": row["rent_estimate"],
        "url": row["url"],
        "notes": row["notes"],
    }


def _owned_scenario(sid):
    return db.db().fetch_one(
        "SELECT * FROM scenarios WHERE id = ? AND user_id = ?",
        (sid, g.user["id"]))


def _validate_comp(body):
    fields = {}
    values = {}
    address = (body.get("address") or "").strip()[:MAX_TEXT]
    values["address"] = address
    values["sold_date"] = (body.get("soldDate") or "").strip()[:40]
    values["url"] = (body.get("url") or "").strip()[:MAX_TEXT]
    values["notes"] = (body.get("notes") or "").strip()[:500]

    price = _num(body.get("soldPrice"))
    if price is not None and price < 0:
        fields["soldPrice"] = "must be zero or positive"
    values["sold_price"] = price

    rent = _num(body.get("rentEstimate"))
    if rent is not None and rent < 0:
        fields["rentEstimate"] = "must be zero or positive"
    values["rent_estimate"] = rent

    land = _num(body.get("landM2"))
    if land is not None and land < 0:
        fields["landM2"] = "must be zero or positive"
    values["land_m2"] = land

    beds = _int(body.get("beds"))
    if beds is not None and (beds < 0 or beds > 10):
        fields["beds"] = "must be between 0 and 10"
    values["beds"] = beds
    return values, fields


@bp.get("/suburbs/<int:sid>/history")
@require_auth
def suburb_history(sid):
    """Daily metric snapshots for one suburb — trend analysis over time.
    Metrics with fewer than two recorded points are omitted."""
    rows = db.db().fetch_all(
        "SELECT metric, period, value FROM metric_history "
        "WHERE subject_type = 'suburb' AND subject_id = ? "
        "ORDER BY metric, period", (sid,))
    by_metric = {}
    for r in rows:
        by_metric.setdefault(r["metric"], []).append(
            {"period": r["period"], "value": r["value"]})
    return jsonify({"ok": True, "data": {
        k: v for k, v in by_metric.items() if len(v) >= 2}})


@bp.get("/scenarios/<int:sid>/comps")
@require_auth
def list_comps(sid):
    if not _owned_scenario(sid):
        return jsonify({"ok": False, "error": "scenario not found"}), 404
    rows = db.db().fetch_all(
        "SELECT * FROM comps WHERE scenario_id = ? ORDER BY sold_date DESC, id DESC", (sid,))
    return jsonify({"ok": True, "data": [_comp_payload(r) for r in rows]})


@bp.post("/scenarios/<int:sid>/comps")
@require_auth
def create_comp(sid):
    if not _owned_scenario(sid):
        return jsonify({"ok": False, "error": "scenario not found"}), 404
    body = request.get_json(silent=True) or {}
    values, fields = _validate_comp(body)
    if fields:
        return jsonify({"ok": False, "error": "validation failed", "fields": fields}), 400

    cid = db.db().execute(
        "INSERT INTO comps (scenario_id, address, sold_price, sold_date, beds, "
        "land_m2, rent_estimate, url, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (sid, values["address"], values["sold_price"], values["sold_date"],
         values["beds"], values["land_m2"], values["rent_estimate"],
         values["url"], values["notes"]),
    )
    row = db.db().fetch_one("SELECT * FROM comps WHERE id = ?", (cid,))
    return jsonify({"ok": True, "data": _comp_payload(row)}), 201


def _owned_comp(cid):
    return db.db().fetch_one(
        "SELECT c.* FROM comps c JOIN scenarios s ON s.id = c.scenario_id "
        "WHERE c.id = ? AND s.user_id = ?",
        (cid, g.user["id"]))


@bp.put("/comps/<int:cid>")
@require_auth
def update_comp(cid):
    row = _owned_comp(cid)
    if not row:
        return jsonify({"ok": False, "error": "comp not found"}), 404
    body = request.get_json(silent=True) or {}
    values, fields = _validate_comp(body)
    if fields:
        return jsonify({"ok": False, "error": "validation failed", "fields": fields}), 400

    db.db().execute(
        "UPDATE comps SET address = ?, sold_price = ?, sold_date = ?, beds = ?, "
        "land_m2 = ?, rent_estimate = ?, url = ?, notes = ? WHERE id = ?",
        (values["address"], values["sold_price"], values["sold_date"], values["beds"],
         values["land_m2"], values["rent_estimate"], values["url"], values["notes"], cid),
    )
    updated = db.db().fetch_one("SELECT * FROM comps WHERE id = ?", (cid,))
    return jsonify({"ok": True, "data": _comp_payload(updated)})


@bp.delete("/comps/<int:cid>")
@require_auth
def delete_comp(cid):
    row = _owned_comp(cid)
    if not row:
        return jsonify({"ok": False, "error": "comp not found"}), 404
    db.db().execute("DELETE FROM comps WHERE id = ?", (cid,))
    return jsonify({"ok": True, "data": {"deleted": True, "id": cid}})


# ---------------------------------------------------------------------------
# Comparable RENTALS — manually captured rental evidence, per scenario.
# Mirrors the sales comps pattern; no rental-listing data source exists
# without scraping portals, so entries are manual.
# ---------------------------------------------------------------------------

def _rental_payload(row):
    return {
        "id": row["id"],
        "scenarioId": row["scenario_id"],
        "address": row["address"],
        "rentWeekly": row["rent_weekly"],
        "bedrooms": row["bedrooms"],
        "propertyType": row["property_type"],
        "url": row["url"],
        "notes": row["notes"],
    }


def _validate_rental(body):
    fields = {}
    values = {
        "address": (body.get("address") or "").strip()[:MAX_TEXT],
        "url": (body.get("url") or "").strip()[:MAX_TEXT],
        "notes": (body.get("notes") or "").strip()[:500],
        "property_type": body.get("propertyType") if body.get("propertyType") in ("house", "unit", "townhouse") else "house",
    }
    rent = _num(body.get("rentWeekly"))
    if rent is None or rent <= 0:
        fields["rentWeekly"] = "must be a positive weekly rent"
    values["rent_weekly"] = rent
    beds = _int(body.get("bedrooms"))
    if beds is not None and (beds < 0 or beds > 10):
        fields["bedrooms"] = "must be between 0 and 10"
    values["bedrooms"] = beds
    return values, fields


@bp.get("/scenarios/<int:sid>/rentals")
@require_auth
def list_rentals(sid):
    if not _owned_scenario(sid):
        return jsonify({"ok": False, "error": "scenario not found"}), 404
    rows = db.db().fetch_all(
        "SELECT * FROM rental_comps WHERE scenario_id = ? ORDER BY rent_weekly", (sid,))
    return jsonify({"ok": True, "data": [_rental_payload(r) for r in rows]})


@bp.post("/scenarios/<int:sid>/rentals")
@require_auth
def create_rental(sid):
    if not _owned_scenario(sid):
        return jsonify({"ok": False, "error": "scenario not found"}), 404
    body = request.get_json(silent=True) or {}
    values, fields = _validate_rental(body)
    if fields:
        return jsonify({"ok": False, "error": "validation failed", "fields": fields}), 400
    rid = db.db().execute(
        "INSERT INTO rental_comps (scenario_id, address, rent_weekly, bedrooms, "
        "property_type, url, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, values["address"], values["rent_weekly"], values["bedrooms"],
         values["property_type"], values["url"], values["notes"]),
    )
    row = db.db().fetch_one("SELECT * FROM rental_comps WHERE id = ?", (rid,))
    return jsonify({"ok": True, "data": _rental_payload(row)}), 201


def _owned_rental(rid):
    return db.db().fetch_one(
        "SELECT r.* FROM rental_comps r JOIN scenarios s ON s.id = r.scenario_id "
        "WHERE r.id = ? AND s.user_id = ?",
        (rid, g.user["id"]))


@bp.delete("/rentals/<int:rid>")
@require_auth
def delete_rental(rid):
    row = _owned_rental(rid)
    if not row:
        return jsonify({"ok": False, "error": "rental comp not found"}), 404
    db.db().execute("DELETE FROM rental_comps WHERE id = ?", (rid,))
    return jsonify({"ok": True, "data": {"deleted": True, "id": rid}})


# ---------------------------------------------------------------------------
# Bank rates
# ---------------------------------------------------------------------------

def _bank_payload(row):
    return {
        "id": row["id"],
        "bankName": row["bank_name"],
        "productName": row["product_name"],
        "investorIoRate": row["investor_io_rate"],
        "investorPiRate": row["investor_pi_rate"],
        "source": row["source"],
        "checkedAt": row["checked_at"],
        "updatedAt": row["updated_at"],
    }


def _validate_bank(body, partial=False):
    fields = {}
    values = {}
    if not partial or "bankName" in body:
        bank = (body.get("bankName") or "").strip()
        if not bank:
            fields["bankName"] = "required"
        elif len(bank) > 80:
            fields["bankName"] = "too long"
        else:
            values["bank_name"] = bank
    if not partial or "productName" in body:
        values["product_name"] = (body.get("productName") or "investor variable").strip()[:80]
    if not partial or "source" in body:
        values["source"] = (body.get("source") or "").strip()[:MAX_TEXT]
    if not partial or "checkedAt" in body:
        values["checked_at"] = (body.get("checkedAt") or "").strip()[:20]

    for key in ("investorIoRate", "investorPiRate"):
        if key not in body:
            continue
        v = _num(body.get(key))
        if v is not None and (v < 0 or v > 0.2):
            fields[key] = "must be a rate between 0 and 0.2 (e.g. 0.0649)"
        else:
            values["investor_io_rate" if key == "investorIoRate" else "investor_pi_rate"] = v
    return values, fields


@bp.get("/bank-rates")
@require_auth
def list_bank_rates():
    rows = db.db().fetch_all(
        "SELECT * FROM bank_rates ORDER BY investor_io_rate IS NULL, investor_io_rate, bank_name")
    return jsonify({"ok": True, "data": [_bank_payload(r) for r in rows]})


@bp.post("/bank-rates")
@require_auth
def create_bank_rate():
    body = request.get_json(silent=True) or {}
    values, fields = _validate_bank(body)
    if fields:
        return jsonify({"ok": False, "error": "validation failed", "fields": fields}), 400
    exists = db.db().fetch_one(
        "SELECT id FROM bank_rates WHERE bank_name = ? AND product_name = ?",
        (values["bank_name"], values["product_name"]))
    if exists:
        return jsonify({"ok": False, "error": "that rate row already exists"}), 409
    rid = db.db().execute(
        "INSERT INTO bank_rates (bank_name, product_name, investor_io_rate, "
        "investor_pi_rate, source, checked_at) VALUES (?, ?, ?, ?, ?, ?)",
        (values["bank_name"], values["product_name"], values.get("investor_io_rate"),
         values.get("investor_pi_rate"), values["source"], values["checked_at"]),
    )
    row = db.db().fetch_one("SELECT * FROM bank_rates WHERE id = ?", (rid,))
    return jsonify({"ok": True, "data": _bank_payload(row)}), 201


@bp.put("/bank-rates/<int:rid>")
@require_auth
def update_bank_rate(rid):
    row = db.db().fetch_one("SELECT * FROM bank_rates WHERE id = ?", (rid,))
    if not row:
        return jsonify({"ok": False, "error": "rate not found"}), 404
    body = request.get_json(silent=True) or {}
    values, fields = _validate_bank(body, partial=True)
    if fields:
        return jsonify({"ok": False, "error": "validation failed", "fields": fields}), 400
    db.db().execute(
        "UPDATE bank_rates SET bank_name = ?, product_name = ?, investor_io_rate = ?, "
        "investor_pi_rate = ?, source = ?, checked_at = ?, "
        "updated_at = datetime('now') WHERE id = ?",
        (values.get("bank_name", row["bank_name"]),
         values.get("product_name", row["product_name"]),
         values.get("investor_io_rate", row["investor_io_rate"]),
         values.get("investor_pi_rate", row["investor_pi_rate"]),
         values.get("source", row["source"]),
         values.get("checked_at", row["checked_at"]),
         rid),
    )
    updated = db.db().fetch_one("SELECT * FROM bank_rates WHERE id = ?", (rid,))
    return jsonify({"ok": True, "data": _bank_payload(updated)})


@bp.delete("/bank-rates/<int:rid>")
@require_auth
def delete_bank_rate(rid):
    count = db.db().execute("DELETE FROM bank_rates WHERE id = ?", (rid,))
    if not count:
        return jsonify({"ok": False, "error": "rate not found"}), 404
    return jsonify({"ok": True, "data": {"deleted": True, "id": rid}})
