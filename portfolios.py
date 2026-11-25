# Copyright (c) 2026 RV
"""
Client portfolios — one share link covering N property presentations.

A portfolio groups snapshot presentations for one client behind a single
token: the BA ticks properties for a client, the client opens ONE link
and sees every property with a per-property decision roll-up. Each item
is an ordinary presentation, so adjustments, comments, approvals and the
per-property PDF keep working unchanged.

Tokens are stored hashed; the raw portfolio token is returned exactly
once (create/rotate). Revoking a portfolio revokes its item
presentations too — unsharing is all-or-nothing per portfolio.
"""

import json
import os

from flask import Blueprint, g, jsonify, request

import auth
import branding
import db
import mailer
import ratelimit
from presentations import (
    MAX_TITLE,
    _expiry,
    _log_event,
    _new_token,
    _sha256,
    create_snapshot_presentation,
    ensure_client_profile,
    row_client_email,
)

bp = Blueprint("portfolios", __name__, url_prefix="/api/portfolios")


def _owned_portfolio(pid):
    return db.db().fetch_one(
        "SELECT * FROM portfolios WHERE id = ? AND ba_user_id = ?",
        (pid, g.user["id"]))


def _items(pid):
    return db.db().fetch_all(
        "SELECT pi.*, p.title, p.status AS presentation_status, p.updated_at "
        "FROM portfolio_items pi JOIN presentations p ON p.id = pi.presentation_id "
        "WHERE pi.portfolio_id = ? ORDER BY pi.position, pi.id", (pid,))


def _latest_decision(presentation_id):
    row = db.db().fetch_one(
        "SELECT type FROM presentation_events WHERE presentation_id = ? "
        "AND type IN ('approved', 'changes_requested') ORDER BY id DESC LIMIT 1",
        (presentation_id,))
    return row["type"] if row else None


def _item_out(item, with_summary=True):
    out = {
        "presentationId": item["presentation_id"],
        "label": item["label"],
        "title": item["title"],
        "status": item["presentation_status"],
        "decision": _latest_decision(item["presentation_id"]),
        "commentCount": db.db().fetch_one(
            "SELECT COUNT(*) AS n FROM presentation_events "
            "WHERE presentation_id = ? AND type = 'comment'",
            (item["presentation_id"],))["n"],
        "lastActivity": db.db().fetch_one(
            "SELECT created_at FROM presentation_events "
            "WHERE presentation_id = ? ORDER BY id DESC LIMIT 1",
            (item["presentation_id"],))["created_at"],
    }
    if with_summary:
        try:
            out["summary"] = json.loads(item["summary_json"])
        except ValueError:
            out["summary"] = {}
    return out


def _portfolio_out(row):
    items = _items(row["id"])
    outs = [_item_out(i) for i in items]
    approved = sum(1 for o in outs if o["decision"] == "approved")
    changes = sum(1 for o in outs if o["decision"] == "changes_requested")
    client = db.db().fetch_one(
        "SELECT display_name, email FROM users WHERE id = ?",
        (row["client_user_id"],))
    return {
        "id": row["id"],
        "title": row["title"],
        "clientId": row["client_user_id"],
        "clientName": (client["display_name"] or (client["email"].split("@")[0]))
        if client else "?",
        "status": row["status"],
        "expiresAt": row["expires_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "itemCount": len(outs),
        "approvedCount": approved,
        "changesCount": changes,
        "pendingCount": len(outs) - approved - changes,
        "commentCount": sum(o["commentCount"] for o in outs),
        "lastActivity": max((o["lastActivity"] for o in outs if o["lastActivity"]),
                            default=None),
        "items": outs,
    }


@bp.post("")
@bp.post("/")
@auth.require_role("ba")
def create_portfolio():
    body = request.get_json(silent=True) or {}
    client_email = (body.get("clientEmail") or "").strip().lower()
    raw_items = body.get("items") or []
    if "@" not in client_email or " " in client_email:
        return jsonify({"ok": False, "error": "a valid clientEmail is required"}), 400
    if not raw_items or not isinstance(raw_items, list):
        return jsonify({"ok": False, "error": "tick at least one property to share"}), 400

    limit_err = branding.check_presentation_limit(g.user["id"])
    if limit_err:
        return jsonify({"ok": False, "error": limit_err}), 403

    client, _ = auth.create_client_user(client_email, (body.get("clientName") or "").strip()[:80])
    if client["role"] != "client":
        return jsonify({"ok": False,
                        "error": "that email belongs to a password account — use a client email"}), 400
    ensure_client_profile(client["id"], g.user["id"], body.get("phone") or "", body.get("notes") or "")

    expires = _expiry(body.get("expiresInDays"))
    title = (body.get("title") or "").strip()[:MAX_TITLE]

    created = []
    for pos, raw in enumerate(raw_items):
        try:
            sid = int(raw.get("scenarioId") or 0)
        except (TypeError, ValueError):
            sid = 0
        scenario = db.db().fetch_one(
            "SELECT * FROM scenarios WHERE id = ? AND user_id = ?", (sid, g.user["id"]))
        if not scenario:
            _rollback(created)
            return jsonify({"ok": False,
                            "error": f"scenario {raw.get('scenarioId')} not found"}), 404
        pid, _ = create_snapshot_presentation(g.user["id"], client["id"], scenario,
                                              (raw.get("label") or scenario["name"])[:MAX_TITLE],
                                              expires)
        _log_event(pid, g.user["id"], "shared", "Shared as a portfolio item")
        try:
            s_inputs = json.loads(scenario["inputs_json"])
        except ValueError:
            s_inputs = {}
        s_props = s_inputs.get("properties") or []
        # Headline chips for the client's portfolio list — derived from the
        # snapshot so they always match what was shared.
        summary = {
            "purchasePrice": sum(p.get("purchasePrice") or 0 for p in s_props) or None,
            "weeklyRent": sum(p.get("weeklyRent") or 0 for p in s_props) or None,
        }
        summary.update(raw.get("summary") or {})
        db.db().execute(
            "INSERT INTO portfolio_items (portfolio_id, presentation_id, label, summary_json, position) "
            "VALUES (?, ?, ?, ?, ?)",
            (-1, pid, (raw.get("label") or scenario["name"]).strip()[:120],
             json.dumps(summary), pos))
        created.append((pid, scenario))

    token = _new_token()
    pfid = db.db().execute(
        "INSERT INTO portfolios (ba_user_id, client_user_id, title, share_token_hash, "
        "status, expires_at) VALUES (?, ?, ?, ?, 'active', ?)",
        (g.user["id"], client["id"], title, _sha256(token), expires))
    # portfolio row now exists — link the items to it
    for i, (pid, _) in enumerate(created):
        db.db().execute(
            "UPDATE portfolio_items SET portfolio_id = ? "
            "WHERE presentation_id = ? AND portfolio_id = -1", (pfid, pid))
        db.db().execute(
            "UPDATE presentations SET updated_at = datetime('now') WHERE id = ?", (pid,))

    row = db.db().fetch_one("SELECT * FROM portfolios WHERE id = ?", (pfid,))
    data = _portfolio_out(row)
    data["shareToken"] = token  # raw token returned exactly once
    return jsonify({"ok": True, "data": data}), 201


def _rollback(created):
    """Best-effort cleanup when a create fails midway."""
    for pid, _ in created:
        db.db().execute("DELETE FROM presentation_events WHERE presentation_id = ?", (pid,))
        db.db().execute("DELETE FROM portfolio_items WHERE presentation_id = ?", (pid,))
        db.db().execute("DELETE FROM presentations WHERE id = ?", (pid,))


@bp.get("")
@bp.get("/")
@auth.require_role("ba")
def list_portfolios():
    rows = db.db().fetch_all(
        "SELECT * FROM portfolios WHERE ba_user_id = ? ORDER BY updated_at DESC",
        (g.user["id"],))
    return jsonify({"ok": True, "data": [_portfolio_out(r) for r in rows]})


@bp.get("/<int:pfid>")
@auth.require_role("ba")
def get_portfolio(pfid):
    row = _owned_portfolio(pfid)
    if not row:
        return jsonify({"ok": False, "error": "portfolio not found"}), 404
    data = _portfolio_out(row)
    data["events"] = db.db().fetch_all(
        "SELECT e.type, e.body, e.created_at, u.display_name, u.email, "
        "pi.label AS item_label "
        "FROM presentation_events e "
        "JOIN users u ON u.id = e.user_id "
        "JOIN portfolio_items pi ON pi.presentation_id = e.presentation_id "
        "WHERE pi.portfolio_id = ? "
        "ORDER BY e.id DESC LIMIT 100", (pfid,))
    return jsonify({"ok": True, "data": data})


@bp.post("/<int:pfid>/rotate")
@auth.require_role("ba")
def rotate_portfolio(pfid):
    row = _owned_portfolio(pfid)
    if not row:
        return jsonify({"ok": False, "error": "portfolio not found"}), 404
    body = request.get_json(silent=True) or {}
    expires = _expiry(body.get("expiresInDays")) if body.get("expiresInDays") else row["expires_at"]
    token = _new_token()
    db.db().execute(
        "UPDATE portfolios SET share_token_hash = ?, status = 'active', "
        "expires_at = ?, updated_at = datetime('now') WHERE id = ?",
        (_sha256(token), expires, pfid))
    db.db().execute(
        "UPDATE presentations SET status = 'active', updated_at = datetime('now') "
        "WHERE id IN (SELECT presentation_id FROM portfolio_items WHERE portfolio_id = ?)",
        (pfid,))
    for item in _items(pfid):
        _log_event(item["presentation_id"], g.user["id"], "rotated",
                   "Portfolio link regenerated — old link no longer works")
    return jsonify({"ok": True, "data": {"id": pfid, "shareToken": token}})


@bp.post("/<int:pfid>/revoke")
@auth.require_role("ba")
def revoke_portfolio(pfid):
    row = _owned_portfolio(pfid)
    if not row:
        return jsonify({"ok": False, "error": "portfolio not found"}), 404
    db.db().execute(
        "UPDATE portfolios SET status = 'revoked', updated_at = datetime('now') WHERE id = ?",
        (pfid,))
    db.db().execute(
        "UPDATE presentations SET status = 'revoked', updated_at = datetime('now') "
        "WHERE id IN (SELECT presentation_id FROM portfolio_items WHERE portfolio_id = ?)",
        (pfid,))
    for item in _items(pfid):
        _log_event(item["presentation_id"], g.user["id"], "revoked",
                   "Portfolio link revoked")
    return jsonify({"ok": True, "data": {"id": pfid, "status": "revoked"}})


@bp.post("/<int:pfid>/email")
@auth.require_role("ba")
def email_portfolio(pfid):
    """Email the portfolio link. The raw token only exists on the BA's
    screen after create/rotate — verify it against the stored hash."""
    row = _owned_portfolio(pfid)
    if not row:
        return jsonify({"ok": False, "error": "portfolio not found"}), 404
    body = request.get_json(silent=True) or {}
    token = (body.get("shareToken") or "").strip()
    email = (body.get("email") or row_client_email(row["client_user_id"])).strip().lower()
    if not token or "@" not in email or " " in email:
        return jsonify({"ok": False, "error": "shareToken and a valid email are required"}), 400
    if _sha256(token) != row["share_token_hash"]:
        return jsonify({"ok": False,
                        "error": "that token is no longer the current link — rotate first"}), 400
    if not ratelimit.hit(f"pres-email:{g.user['id']}", 10, 3600):
        return jsonify({"ok": False, "error": "too many emails — try again later"}), 429

    base = (os.environ.get("PA_BASE_URL") or "http://127.0.0.1:4180").rstrip("/")
    url = f"{base}/p/{token}"
    ba = db.db().fetch_one("SELECT display_name, email FROM users WHERE id = ?", (g.user["id"],))
    items = _items(pfid)
    sent = mailer.send_portfolio_email(
        email, (ba["display_name"] or ba["email"].split("@")[0]) if ba else "Your agent",
        row["title"] or "Portfolio",
        [(i["label"] or i["title"]) for i in items], url)
    for item in items:
        _log_event(item["presentation_id"], g.user["id"], "emailed",
                   f"Portfolio emailed to {email}" + ("" if sent else " (SMTP not configured)"))
    return jsonify({"ok": True, "data": {"emailedTo": email, "sent": bool(sent),
                                         "link": url}})


@bp.delete("/<int:pfid>")
@auth.require_role("ba")
def delete_portfolio(pfid):
    row = _owned_portfolio(pfid)
    if not row:
        return jsonify({"ok": False, "error": "portfolio not found"}), 404
    items = _items(pfid)
    for item in items:
        pid = item["presentation_id"]
        db.db().execute("DELETE FROM presentation_events WHERE presentation_id = ?", (pid,))
        db.db().execute("DELETE FROM presentation_adjustments WHERE presentation_id = ?", (pid,))
        db.db().execute("DELETE FROM presentations WHERE id = ?", (pid,))
    db.db().execute("DELETE FROM portfolio_items WHERE portfolio_id = ?", (pfid,))
    db.db().execute("DELETE FROM portfolios WHERE id = ?", (pfid,))
    return jsonify({"ok": True, "data": {"deleted": True, "id": pfid}})
