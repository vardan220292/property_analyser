# Copyright (c) 2026 RV
"""
Scenario attachments — the BA's due-diligence documents for a property
(plans, appraisal, market reports…), shown to clients in the portal.

Files live on disk under data/attachments/<scenario_id>/ (Supabase Storage
is not configured on this deployment); the DB row carries metadata only.
Clients reach a file only through an ACTIVE presentation on its scenario —
revoking the share cuts document access with it.
"""

import os
import secrets

from flask import Blueprint, g, jsonify, request, send_file

import auth
import db

bp = Blueprint("attachments", __name__)

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_FILES_PER_SCENARIO = 12
MIME_EXTS = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
}


def storage_dir():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "data", "attachments")


def list_for_scenario(sid):
    return db.db().fetch_all(
        "SELECT id, display_name AS displayName, mime, bytes, "
        "created_at AS createdAt FROM attachments "
        "WHERE scenario_id = ? ORDER BY id", (sid,))


def _owned_scenario(sid):
    return db.db().fetch_one(
        "SELECT * FROM scenarios WHERE id = ? AND user_id = ?",
        (sid, g.user["id"]))


@bp.post("/api/scenarios/<int:sid>/attachments")
@auth.require_role("ba")
def upload(sid):
    if not _owned_scenario(sid):
        return jsonify({"ok": False, "error": "scenario not found"}), 404
    n = db.db().fetch_one(
        "SELECT COUNT(*) AS n FROM attachments WHERE scenario_id = ?", (sid,))["n"]
    if n >= MAX_FILES_PER_SCENARIO:
        return jsonify({"ok": False,
                        "error": f"up to {MAX_FILES_PER_SCENARIO} documents per property"}), 400
    f = request.files.get("file")
    if not f:
        return jsonify({"ok": False, "error": "choose a file to upload"}), 400
    ext = MIME_EXTS.get(f.mimetype)
    if not ext:
        return jsonify({"ok": False,
                        "error": "document must be a PDF, PNG, JPG or WebP"}), 400
    data = f.read()
    if len(data) > MAX_FILE_BYTES:
        return jsonify({"ok": False,
                        "error": "documents must be under 20 MB"}), 400

    stored = secrets.token_urlsafe(16) + "." + ext
    folder = os.path.join(storage_dir(), str(sid))
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, stored), "wb") as fh:
        fh.write(data)
    db.db().execute(
        "INSERT INTO attachments (scenario_id, user_id, display_name, stored_name, mime, bytes) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (sid, g.user["id"], (f.filename or "document")[:200], stored,
         f.mimetype, len(data)))
    return jsonify({"ok": True, "data": list_for_scenario(sid)}), 201


@bp.get("/api/scenarios/<int:sid>/attachments")
@auth.require_role("ba")
def list_attachments(sid):
    if not _owned_scenario(sid):
        return jsonify({"ok": False, "error": "scenario not found"}), 404
    return jsonify({"ok": True, "data": list_for_scenario(sid)})


@bp.delete("/api/attachments/<int:aid>")
@auth.require_role("ba")
def delete(aid):
    row = db.db().fetch_one(
        "SELECT a.*, s.user_id AS owner_id FROM attachments a "
        "JOIN scenarios s ON s.id = a.scenario_id WHERE a.id = ?", (aid,))
    if not row or row["owner_id"] != g.user["id"]:
        return jsonify({"ok": False, "error": "document not found"}), 404
    db.db().execute("DELETE FROM attachments WHERE id = ?", (aid,))
    try:
        os.remove(os.path.join(storage_dir(), str(row["scenario_id"]),
                               row["stored_name"]))
    except OSError:
        pass
    return jsonify({"ok": True, "data": {"deleted": True, "id": aid}})


@bp.get("/api/attachments/<int:aid>/file")
@auth.require_auth
def fetch_file(aid):
    """BA owner, or a client holding an active share of the scenario."""
    row = db.db().fetch_one(
        "SELECT a.*, s.user_id AS owner_id FROM attachments a "
        "JOIN scenarios s ON s.id = a.scenario_id WHERE a.id = ?", (aid,))
    if not row:
        return jsonify({"ok": False, "error": "document not found"}), 404
    if row["owner_id"] != g.user["id"]:
        shared = db.db().fetch_one(
            "SELECT 1 AS ok FROM presentations WHERE scenario_id = ? "
            "AND client_user_id = ? AND status = 'active' LIMIT 1",
            (row["scenario_id"], g.user["id"]))
        if not shared:
            return jsonify({"ok": False, "error": "document not found"}), 404
    path = os.path.join(storage_dir(), str(row["scenario_id"]), row["stored_name"])
    if not os.path.exists(path):
        return jsonify({"ok": False, "error": "document file is missing"}), 404
    return send_file(path, mimetype=row["mime"],
                     download_name=row["display_name"], conditional=False)
