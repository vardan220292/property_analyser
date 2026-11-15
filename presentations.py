# Copyright (c) 2026 RV
"""
BA workspace API — presentations and clients.

A presentation is a SHARE SNAPSHOT of one scenario, tied to one client
user. The snapshot is the source of truth for what the client sees; the
BA can keep editing the source scenario freely. Share tokens are stored
hashed (sha256); the raw token is returned exactly once, on create or
rotate.
"""

import hashlib
import json
import os
import secrets
from datetime import datetime, timedelta

from flask import Blueprint, g, jsonify, request

import auth
import branding
import db
import mailer
import ratelimit

bp = Blueprint("presentations", __name__, url_prefix="/api/presentations")
clients_bp = Blueprint("clients", __name__, url_prefix="/api/clients")

MAX_TITLE = 120
DEFAULT_EXPIRY_DAYS = 30


def _sha256(s):
    return hashlib.sha256(s.encode()).hexdigest()


def _new_token():
    return secrets.token_urlsafe(32)


def _expiry(days):
    days = int(days or DEFAULT_EXPIRY_DAYS)
    if days <= 0:
        return None
    return (datetime.utcnow() + timedelta(days=min(days, 365))).isoformat()


def _owned_presentation(pid):
    return db.db().fetch_one(
        "SELECT * FROM presentations WHERE id = ? AND ba_user_id = ?",
        (pid, g.user["id"]),
    )


def _client_display(uid):
    row = db.db().fetch_one("SELECT display_name, email FROM users WHERE id = ?", (uid,))
    if not row:
        return "?"
    return row["display_name"] or row["email"].split("@")[0]


def _row_out(row, with_snapshot=False):
    out = {
        "id": row["id"],
        "title": row["title"],
        "clientId": row["client_user_id"],
        "clientName": _client_display(row["client_user_id"]),
        "scenarioId": row["scenario_id"],
        "status": row["status"],
        "expiresAt": row["expires_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    if with_snapshot:
        out["snapshot"] = json.loads(row["snapshot_json"])
        adj = db.db().fetch_one(
            "SELECT inputs_json, updated_at FROM presentation_adjustments "
            "WHERE presentation_id = ? AND user_id = ?",
            (row["id"], row["client_user_id"]))
        if adj:
            out["clientAdjustments"] = json.loads(adj["inputs_json"])
            out["clientAdjustedAt"] = adj["updated_at"]
    return out


def _log_event(pid, uid, type_, body=""):
    db.db().execute(
        "INSERT INTO presentation_events (presentation_id, user_id, type, body) "
        "VALUES (?, ?, ?, ?)", (pid, uid, type_, body[:2000]))


def ensure_client_profile(user_id, ba_user_id, phone="", notes=""):
    """Create the BA-client link if missing (idempotent)."""
    db.db().execute(
        "INSERT OR IGNORE INTO client_profiles (user_id, ba_user_id, phone, notes) "
        "VALUES (?, ?, ?, ?)", (user_id, ba_user_id, phone[:40] if phone else "",
                                notes[:2000] if notes else ""))


# ---------------------------------------------------------------------------
# Presentations
# ---------------------------------------------------------------------------

@bp.get("")
@bp.get("/")
@auth.require_role("ba")
def list_presentations():
    rows = db.db().fetch_all(
        "SELECT * FROM presentations WHERE ba_user_id = ? ORDER BY updated_at DESC",
        (g.user["id"],))
    out = []
    for r in rows:
        item = _row_out(r)
        events = db.db().fetch_all(
            "SELECT type, created_at FROM presentation_events "
            "WHERE presentation_id = ? ORDER BY id DESC LIMIT 20", (r["id"],))
        item["lastActivity"] = events[0]["created_at"] if events else None
        item["commentCount"] = sum(1 for e in events if e["type"] == "comment")
        out.append(item)
    return jsonify({"ok": True, "data": out})


@bp.post("")
@bp.post("/")
@auth.require_role("ba")
def create_presentation():
    body = request.get_json(silent=True) or {}
    scenario_id = body.get("scenarioId")
    client_email = (body.get("clientEmail") or "").strip().lower()
    if not scenario_id or "@" not in client_email or " " in client_email:
        return jsonify({"ok": False, "error": "scenarioId and a valid clientEmail are required"}), 400

    limit_err = branding.check_presentation_limit(g.user["id"])
    if limit_err:
        return jsonify({"ok": False, "error": limit_err}), 403

    scenario = db.db().fetch_one(
        "SELECT * FROM scenarios WHERE id = ? AND user_id = ?",
        (int(scenario_id), g.user["id"]))
    if not scenario:
        return jsonify({"ok": False, "error": "scenario not found"}), 404

    client, _ = auth.create_client_user(client_email, (body.get("clientName") or "").strip()[:80])
    if client["role"] != "client":
        return jsonify({"ok": False,
                        "error": "that email belongs to a password account — use a client email"}), 400
    ensure_client_profile(client["id"], g.user["id"], body.get("phone") or "", body.get("notes") or "")

    title = (body.get("title") or scenario["name"]).strip()[:MAX_TITLE]
    token = _new_token()
    pid = db.db().execute(
        "INSERT INTO presentations (ba_user_id, client_user_id, scenario_id, title, "
        "snapshot_json, share_token_hash, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
        (g.user["id"], client["id"], scenario["id"], title,
         scenario["inputs_json"], _sha256(token), _expiry(body.get("expiresInDays"))),
    )
    _log_event(pid, g.user["id"], "shared", f"Shared with {client['email']}")
    row = db.db().fetch_one("SELECT * FROM presentations WHERE id = ?", (pid,))
    data = _row_out(row)
    data["shareToken"] = token  # raw token returned exactly once
    return jsonify({"ok": True, "data": data}), 201


@bp.get("/<int:pid>")
@auth.require_role("ba")
def get_presentation(pid):
    row = _owned_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    data = _row_out(row, with_snapshot=True)
    data["events"] = db.db().fetch_all(
        "SELECT e.type, e.body, e.created_at, u.display_name, u.email "
        "FROM presentation_events e JOIN users u ON u.id = e.user_id "
        "WHERE e.presentation_id = ? ORDER BY e.id DESC LIMIT 100", (pid,))
    return jsonify({"ok": True, "data": data})


@bp.post("/<int:pid>/rotate")
@auth.require_role("ba")
def rotate_token(pid):
    row = _owned_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    body = request.get_json(silent=True) or {}
    expires = _expiry(body.get("expiresInDays")) if body.get("expiresInDays") else row["expires_at"]
    token = _new_token()
    db.db().execute(
        "UPDATE presentations SET share_token_hash = ?, status = 'active', "
        "expires_at = ?, updated_at = datetime('now') WHERE id = ?",
        (_sha256(token), expires, pid))
    _log_event(pid, g.user["id"], "rotated", "Share link regenerated — old link no longer works")
    return jsonify({"ok": True, "data": {"id": pid, "shareToken": token}})


@bp.post("/<int:pid>/revoke")
@auth.require_role("ba")
def revoke_presentation(pid):
    row = _owned_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    db.db().execute(
        "UPDATE presentations SET status = 'revoked', updated_at = datetime('now') "
        "WHERE id = ?", (pid,))
    _log_event(pid, g.user["id"], "revoked", "Share link revoked")
    return jsonify({"ok": True, "data": {"id": pid, "status": "revoked"}})


@bp.post("/<int:pid>/email")
@auth.require_role("ba")
def email_presentation(pid):
    """Email the share link to the client (or any address). The raw token
    only exists on the BA's screen after create/rotate — it is POSTed back
    and verified against the stored hash before sending."""
    row = _owned_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
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
    sent = mailer.send_presentation_email(
        email, (ba["display_name"] or ba["email"].split("@")[0]) if ba else "Your agent",
        row["title"], url)
    _log_event(pid, g.user["id"], "emailed", f"Link emailed to {email}" + ("" if sent else " (SMTP not configured — logged only)"))
    return jsonify({"ok": True, "data": {"emailedTo": email, "sent": bool(sent),
                                         "link": url}})


def row_client_email(client_user_id):
    row = db.db().fetch_one("SELECT email FROM users WHERE id = ?", (client_user_id,))
    return (row and row["email"]) or ""


@bp.delete("/<int:pid>")
@auth.require_role("ba")
def delete_presentation(pid):
    row = _owned_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    db.db().execute("DELETE FROM presentation_events WHERE presentation_id = ?", (pid,))
    db.db().execute("DELETE FROM presentation_adjustments WHERE presentation_id = ?", (pid,))
    db.db().execute("DELETE FROM presentations WHERE id = ?", (pid,))
    return jsonify({"ok": True, "data": {"deleted": True, "id": pid}})


# ---------------------------------------------------------------------------
# Clients (BA-owned CRM)
# ---------------------------------------------------------------------------

@clients_bp.get("")
@clients_bp.get("/")
@auth.require_role("ba")
def list_clients():
    rows = db.db().fetch_all(
        "SELECT cp.*, u.email, u.display_name FROM client_profiles cp "
        "JOIN users u ON u.id = cp.user_id WHERE cp.ba_user_id = ? "
        "ORDER BY cp.created_at DESC", (g.user["id"],))
    data = [{
        "id": r["user_id"],
        "email": r["email"],
        "name": r["display_name"] or r["email"].split("@")[0],
        "phone": r["phone"],
        "notes": r["notes"],
        "status": r["status"],
        "createdAt": r["created_at"],
        "presentations": db.db().fetch_one(
            "SELECT COUNT(*) AS n FROM presentations WHERE client_user_id = ?",
            (r["user_id"],))["n"],
    } for r in rows]
    return jsonify({"ok": True, "data": data})


@clients_bp.post("")
@clients_bp.post("/")
@auth.require_role("ba")
def create_client():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    if "@" not in email or " " in email:
        return jsonify({"ok": False, "error": "a valid email is required"}), 400
    client, _ = auth.create_client_user(email, (body.get("name") or "").strip()[:80])
    if client["role"] != "client":
        return jsonify({"ok": False,
                        "error": "that email belongs to a password account — use a client email"}), 400
    ensure_client_profile(client["id"], g.user["id"], body.get("phone") or "", body.get("notes") or "")
    return jsonify({"ok": True, "data": {
        "id": client["id"], "email": email,
        "name": body.get("name") or email.split("@")[0],
    }}), 201


@clients_bp.put("/<int:uid>")
@auth.require_role("ba")
def update_client(uid):
    prof = db.db().fetch_one(
        "SELECT * FROM client_profiles WHERE user_id = ? AND ba_user_id = ?",
        (uid, g.user["id"]))
    if not prof:
        return jsonify({"ok": False, "error": "client not found"}), 404
    body = request.get_json(silent=True) or {}
    db.db().execute(
        "UPDATE client_profiles SET phone = ?, notes = ?, status = ? WHERE user_id = ?",
        ((body.get("phone") if body.get("phone") is not None else prof["phone"])[:40],
         (body.get("notes") if body.get("notes") is not None else prof["notes"])[:2000],
         body.get("status") if body.get("status") in ("active", "archived") else prof["status"],
         uid))
    return jsonify({"ok": True, "data": {"id": uid}})
