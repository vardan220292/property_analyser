# Copyright (c) 2026 RV
"""
BA branding + plan management.

Branding flows into every client portal the BA shares (header name,
tagline, accent colour). Plan gates the number of ACTIVE presentations a
trial BA can hold — the switch endpoint is a placeholder until Stripe (or
similar) is wired; payment should be the only writer in production.
"""

import os
import re

import requests

from flask import Blueprint, g, jsonify, request

import db

bp = Blueprint("branding", __name__, url_prefix="/api")

TRIAL_ACTIVE_LIMIT = 3
MAX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_LOGO_BYTES = 1024 * 1024
LOGO_MIMETYPES = {"image/png": "png", "image/jpeg": "jpg"}


def get_branding(ba_user_id):
    return db.db().fetch_one("SELECT * FROM ba_profiles WHERE user_id = ?", (ba_user_id,))


def branding_out(ba_user_id):
    """Branding for a BA (or defaults when unset) — safe for the portal."""
    r = get_branding(ba_user_id)
    return {
        "businessName": (r and r["business_name"]) or "",
        "accentColor": (r and r["accent_color"]) or "",
        "logoUrl": (r and r["logo_url"]) or "",
        "tagline": (r and r["tagline"]) or "",
    }


def check_presentation_limit(ba_user_id):
    """Return an error string when the plan blocks another ACTIVE share."""
    user = db.db().fetch_one("SELECT plan FROM users WHERE id = ?", (ba_user_id,))
    if user and user["plan"] == "pro":
        return None
    n = db.db().fetch_one(
        "SELECT COUNT(*) AS n FROM presentations WHERE ba_user_id = ? AND status = 'active'",
        (ba_user_id,))["n"]
    if n >= TRIAL_ACTIVE_LIMIT:
        return (f"Trial plan holds up to {TRIAL_ACTIVE_LIMIT} active proposals at once — "
                "upgrade to Pro for unlimited, or revoke an existing link")
    return None


@bp.get("/branding")
def get_branding_route():
    user = auth_user()
    if not user or user["role"] != "ba":
        return jsonify({"ok": False, "error": "not allowed for this account"}), 403
    return jsonify({"ok": True, "data": branding_out(user["id"])})


@bp.put("/branding")
def put_branding():
    user = auth_user()
    if not user or user["role"] != "ba":
        return jsonify({"ok": False, "error": "not allowed for this account"}), 403
    body = request.get_json(silent=True) or {}
    color = (body.get("accentColor") or "").strip()
    if color and not MAX_COLOR.match(color):
        return jsonify({"ok": False, "error": "accentColor must be a #rrggbb hex colour"}), 400
    db.db().execute(
        "INSERT INTO ba_profiles (user_id, business_name, accent_color, logo_url, tagline) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET business_name = excluded.business_name, "
        "accent_color = excluded.accent_color, logo_url = excluded.logo_url, "
        "tagline = excluded.tagline",
        (user["id"],
         (body.get("businessName") or "").strip()[:80],
         color,
         (body.get("logoUrl") or "").strip()[:300],
         (body.get("tagline") or "").strip()[:140]))
    return jsonify({"ok": True, "data": branding_out(user["id"])})


@bp.post("/billing/plan")
def set_plan():
    user = auth_user()
    if not user or user["role"] != "ba":
        return jsonify({"ok": False, "error": "not allowed for this account"}), 403
    body = request.get_json(silent=True) or {}
    plan = body.get("plan")
    if plan not in ("trial", "pro"):
        return jsonify({"ok": False, "error": "plan must be trial or pro"}), 400
    db.db().execute("UPDATE users SET plan = ? WHERE id = ?", (plan, user["id"]))
    return jsonify({"ok": True, "data": {"plan": plan}})


def _save_logo_url(user_id, url):
    db.db().execute(
        "INSERT INTO ba_profiles (user_id, logo_url) VALUES (?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET logo_url = excluded.logo_url",
        (user_id, url))


@bp.post("/branding/logo")
def upload_logo():
    user = auth_user()
    if not user or user["role"] != "ba":
        return jsonify({"ok": False, "error": "not allowed for this account"}), 403
    sb_url = os.environ.get("PA_SUPABASE_URL")
    sb_key = os.environ.get("PA_SUPABASE_SERVICE_ROLE_KEY")
    bucket = os.environ.get("PA_SUPABASE_BUCKET", "pa-branding")
    if not sb_url or not sb_key:
        return jsonify({"ok": False,
                        "error": "logo storage not configured (PA_SUPABASE_* env)"}), 400
    f = request.files.get("file")
    if not f:
        return jsonify({"ok": False, "error": "choose a PNG or JPG file"}), 400
    ext = LOGO_MIMETYPES.get(f.mimetype)
    if not ext:
        return jsonify({"ok": False, "error": "logo must be a PNG or JPG"}), 400
    data = f.read()
    if len(data) > MAX_LOGO_BYTES:
        return jsonify({"ok": False, "error": "logo must be under 1 MB"}), 400

    path = f"{user['id']}.{ext}"
    r = requests.post(
        f"{sb_url}/storage/v1/object/{bucket}/{path}",
        headers={
            "Authorization": f"Bearer {sb_key}",
            "Content-Type": f.mimetype,
            "x-upsert": "true",
        },
        data=data, timeout=20,
    )
    if r.status_code not in (200, 201):
        return jsonify({"ok": False,
                        "error": f"storage upload failed ({r.status_code})"}), 502
    public = f"{sb_url}/storage/v1/object/public/{bucket}/{path}"
    _save_logo_url(user["id"], public)
    return jsonify({"ok": True, "data": branding_out(user["id"])})


def auth_user():
    """Local import-free user lookup reusing the auth machinery."""
    from auth import user_from_request
    return user_from_request()
