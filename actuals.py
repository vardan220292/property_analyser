# Copyright (c) 2026 RV
"""
Portfolio actuals — what ACTUALLY happened vs the projection.

Rows are keyed (scenario, property, period_start): posting the same period
again UPDATES it, so the entry form can be re-saved freely. Actuals belong
to the scenario's owner (investor or BA); clients don't see this module.
"""

import datetime
import math

from flask import Blueprint, g, jsonify, request

import auth
import db

bp = Blueprint("actuals", __name__, url_prefix="/api")

MAX_NOTES = 2000
MAX_PROPERTY_INDEX = 5


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _valid_date(s):
    if not isinstance(s, str) or len(s) != 10:
        return False
    try:
        datetime.date.fromisoformat(s)
        return True
    except ValueError:
        return False


def _owned_scenario(sid):
    return db.db().fetch_one(
        "SELECT id FROM scenarios WHERE id = ? AND user_id = ?", (sid, g.user["id"]))


def _row_out(r):
    return {
        "id": r["id"],
        "scenarioId": r["scenario_id"],
        "propertyIndex": r["property_index"],
        "periodStart": r["period_start"],
        "periodEnd": r["period_end"],
        "rentReceived": r["rent_received"],
        "expenses": r["expenses"],
        "loanBalance": r["loan_balance"],
        "valuation": r["valuation"],
        "notes": r["notes"],
        "createdAt": r["created_at"],
    }


def _validate(body):
    fields = {}
    idx = body.get("propertyIndex", 0)
    if not isinstance(idx, int) or isinstance(idx, bool) or not (0 <= idx <= MAX_PROPERTY_INDEX):
        fields["propertyIndex"] = f"must be 0 to {MAX_PROPERTY_INDEX}"
    for key in ("periodStart", "periodEnd"):
        if not _valid_date(body.get(key)):
            fields[key] = "must be a date (YYYY-MM-DD)"
    if not fields.get("periodStart") and not fields.get("periodEnd"):
        if body["periodEnd"] < body["periodStart"]:
            fields["periodEnd"] = "must not be before the period start"
    for key in ("rentReceived", "expenses"):
        v = body.get(key, 0)
        if not _is_num(v) or v < 0:
            fields[key] = "must be zero or more"
    for key in ("loanBalance", "valuation"):
        v = body.get(key)
        if v is not None and (not _is_num(v) or v < 0):
            fields[key] = "must be zero or more (or empty)"
    return fields


@bp.get("/scenarios/<int:sid>/actuals")
@auth.require_auth
def list_actuals(sid):
    if not _owned_scenario(sid):
        return jsonify({"ok": False, "error": "scenario not found"}), 404
    rows = db.db().fetch_all(
        "SELECT * FROM portfolio_actuals WHERE scenario_id = ? "
        "ORDER BY property_index, period_start", (sid,))
    return jsonify({"ok": True, "data": [_row_out(r) for r in rows]})


@bp.post("/scenarios/<int:sid>/actuals")
@auth.require_auth
def upsert_actual(sid):
    if not _owned_scenario(sid):
        return jsonify({"ok": False, "error": "scenario not found"}), 404
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"ok": False, "error": "body must be JSON"}), 400
    fields = _validate(body)
    if fields:
        return jsonify({"ok": False, "error": "validation failed", "fields": fields}), 400

    args = (
        g.user["id"], sid, body.get("propertyIndex", 0),
        body["periodStart"], body["periodEnd"],
        float(body.get("rentReceived", 0)), float(body.get("expenses", 0)),
        body.get("loanBalance"), body.get("valuation"),
        (body.get("notes") or "")[:MAX_NOTES],
    )
    db.db().execute(
        "INSERT INTO portfolio_actuals (user_id, scenario_id, property_index, "
        "period_start, period_end, rent_received, expenses, loan_balance, valuation, notes) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(scenario_id, property_index, period_start) DO UPDATE SET "
        "period_end = excluded.period_end, rent_received = excluded.rent_received, "
        "expenses = excluded.expenses, loan_balance = excluded.loan_balance, "
        "valuation = excluded.valuation, notes = excluded.notes",
        args)
    row = db.db().fetch_one(
        "SELECT * FROM portfolio_actuals WHERE scenario_id = ? AND property_index = ? "
        "AND period_start = ?",
        (sid, body.get("propertyIndex", 0), body["periodStart"]))
    return jsonify({"ok": True, "data": _row_out(row)}), 201


@bp.delete("/actuals/<int:aid>")
@auth.require_auth
def delete_actual(aid):
    row = db.db().fetch_one(
        "SELECT id FROM portfolio_actuals WHERE id = ? AND user_id = ?",
        (aid, g.user["id"]))
    if not row:
        return jsonify({"ok": False, "error": "entry not found"}), 404
    db.db().execute("DELETE FROM portfolio_actuals WHERE id = ?", (aid,))
    return jsonify({"ok": True, "data": {"deleted": True, "id": aid}})
