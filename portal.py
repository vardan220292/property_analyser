# Copyright (c) 2026 RV
"""
Client portal API.

Access model: the ONLY unauthenticated route is resolve/<token> — it maps
a share token to its presentation and returns a JWT for the client user
(the magic-link login). Every other route requires that JWT and re-checks
`presentation.client_user_id == g.user.id AND status = 'active'` on each
call. Clients never pass ids they weren't given — resolve is the only
token→id mapping.

Note: possession of the share link grants the client's session. Revoking
or rotating the link is the mitigation — surfaced to BAs in the UI.
"""

import hashlib
import json
from datetime import datetime
from html import escape as _h

from flask import Blueprint, Response, g, jsonify, request

import auth
import branding
import db
import ratelimit
import scenarios as scenarios_api

bp = Blueprint("portal", __name__, url_prefix="/api/portal")


def _sha256(s):
    return hashlib.sha256(s.encode()).hexdigest()


def _by_token(token):
    row = db.db().fetch_one(
        "SELECT * FROM presentations WHERE share_token_hash = ?", (_sha256(token),))
    if not row:
        return None, (404, "link not found")
    if row["status"] != "active":
        return None, (410, "this link is no longer active")
    if row["expires_at"] and datetime.utcnow() >= datetime.fromisoformat(row["expires_at"]):
        return None, (410, "this link has expired")
    return row, None


def _my_presentation(pid):
    row = db.db().fetch_one(
        "SELECT * FROM presentations WHERE id = ? AND client_user_id = ? AND status = 'active'",
        (pid, g.user["id"]))
    return row


def _presentation_out(row, with_snapshot=True):
    ba = db.db().fetch_one(
        "SELECT display_name, email FROM users WHERE id = ?", (row["ba_user_id"],))
    out = {
        "id": row["id"],
        "title": row["title"],
        "baName": (ba["display_name"] or ba["email"].split("@")[0]) if ba else "",
        "status": row["status"],
        "updatedAt": row["updated_at"],
        "branding": branding.branding_out(row["ba_user_id"]),
    }
    if with_snapshot:
        inputs = json.loads(row["snapshot_json"])
        adj = db.db().fetch_one(
            "SELECT inputs_json FROM presentation_adjustments "
            "WHERE presentation_id = ? AND user_id = ?",
            (row["id"], row["client_user_id"]))
        out["snapshot"] = json.loads(adj["inputs_json"]) if adj else inputs
        out["usingMyAdjustments"] = bool(adj)
    return out


def _log_event(pid, uid, type_, body=""):
    db.db().execute(
        "INSERT INTO presentation_events (presentation_id, user_id, type, body) "
        "VALUES (?, ?, ?, ?)", (pid, uid, type_, body[:2000]))


@bp.get("/resolve/<token>")
def resolve(token):
    if not ratelimit.hit(f"resolve:{request.remote_addr}", 30, 300):
        return jsonify({"ok": False, "error": "too many requests"}), 429
    row, err = _by_token(token)
    if err:
        return jsonify({"ok": False, "error": err[1]}), err[0]

    # 'viewed' at most once an hour per client — keeps the BA feed readable.
    if not ratelimit.hit(f"viewed:{row['id']}:{row['client_user_id']}", 1, 3600):
        pass
    else:
        _log_event(row["id"], row["client_user_id"], "viewed")

    user = db.db().fetch_one(
        "SELECT id, email, display_name, role FROM users WHERE id = ?",
        (row["client_user_id"],))
    return jsonify({"ok": True, "data": {
        "me": {"id": user["id"], "email": user["email"],
               "displayName": user["display_name"] or user["email"].split("@")[0],
               "role": user["role"]},
        "token": auth.make_token(user),
        "presentation": _presentation_out(row),
    }})


@bp.get("/presentations")
@auth.require_auth
def my_presentations():
    rows = db.db().fetch_all(
        "SELECT * FROM presentations WHERE client_user_id = ? AND status = 'active' "
        "ORDER BY updated_at DESC", (g.user["id"],))
    return jsonify({"ok": True,
                    "data": [_presentation_out(r, with_snapshot=False) for r in rows]})


@bp.get("/presentation/<int:pid>")
@auth.require_auth
def get_presentation(pid):
    row = _my_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    out = _presentation_out(row)
    out["events"] = db.db().fetch_all(
        "SELECT type, body, created_at FROM presentation_events "
        "WHERE presentation_id = ? AND type IN ('comment', 'approved', 'changes_requested') "
        "ORDER BY id ASC", (pid,))
    return jsonify({"ok": True, "data": out})


@bp.put("/presentation/<int:pid>/adjustments")
@auth.require_auth
def save_adjustments(pid):
    row = _my_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    body = request.get_json(silent=True)
    inputs = (body or {}).get("inputs")
    fields = scenarios_api.validate_inputs(inputs)
    if fields:
        return jsonify({"ok": False, "error": "validation failed", "fields": fields}), 400
    db.db().execute(
        "INSERT INTO presentation_adjustments (presentation_id, user_id, inputs_json) "
        "VALUES (?, ?, ?) "
        "ON CONFLICT(presentation_id, user_id) DO UPDATE SET "
        "inputs_json = excluded.inputs_json, updated_at = datetime('now')",
        (pid, g.user["id"], json.dumps(inputs)))
    db.db().execute(
        "UPDATE presentations SET updated_at = datetime('now') WHERE id = ?", (pid,))
    return jsonify({"ok": True, "data": {"saved": True}})


@bp.post("/presentation/<int:pid>/comment")
@auth.require_auth
def comment(pid):
    row = _my_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    body = ((request.get_json(silent=True) or {}).get("body") or "").strip()
    if not body:
        return jsonify({"ok": False, "error": "comment body is required"}), 400
    _log_event(pid, g.user["id"], "comment", body)
    db.db().execute(
        "UPDATE presentations SET updated_at = datetime('now') WHERE id = ?", (pid,))
    return jsonify({"ok": True, "data": {"posted": True}}), 201


def _decision(pid, type_, default_body):
    row = _my_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    body = ((request.get_json(silent=True) or {}).get("body") or "").strip() or default_body
    _log_event(pid, g.user["id"], type_, body)
    db.db().execute(
        "UPDATE presentations SET updated_at = datetime('now') WHERE id = ?", (pid,))
    return jsonify({"ok": True, "data": {"recorded": type_}}), 201


@bp.post("/presentation/<int:pid>/approve")
@auth.require_auth
def approve(pid):
    return _decision(pid, "approved", "Approved the proposal")


# ---------------------------------------------------------------------------
# Server-side PDF: the browser posts its computed figures (the engine runs
# client-side); the server renders a static print template and converts it
# with WeasyPrint when installed, otherwise returns the print-HTML for a
# browser print-to-PDF fallback.
# ---------------------------------------------------------------------------

_PDF_CSS = """
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #0f172a;
         margin: 32px; font-size: 12px; }
  .head { display: flex; justify-content: space-between; align-items: center;
          border-bottom: 3px solid ACCENT; padding-bottom: 12px; margin-bottom: 18px; }
  .brand { font-size: 17px; font-weight: 700; color: ACCENT; }
  .client { color: #64748b; font-size: 11px; margin-top: 2px; }
  h1 { font-size: 20px; margin: 0 0 14px; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; min-width: 150px; }
  .card .label { font-size: 9px; color: #64748b; text-transform: uppercase; letter-spacing: .4px; }
  .card .value { font-size: 16px; font-weight: 700; margin: 3px 0; }
  .card .sub { font-size: 9px; color: #64748b; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
  th { font-size: 10px; color: #475569; text-transform: uppercase; letter-spacing: .4px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.bold td { font-weight: 700; }
  .foot { color: #94a3b8; font-size: 9px; margin-top: 24px; border-top: 1px solid #e2e8f0;
          padding-top: 8px; }
"""


def _pdf_html(row, data):
    accent = data.get("accent") or "#6366f1"
    css = _PDF_CSS.replace("ACCENT", accent)
    cards = "".join(
        f'<div class="card"><div class="label">{_h(c.get("label", ""))}</div>'
        f'<div class="value">{_h(c.get("value", ""))}</div>'
        f'<div class="sub">{_h(c.get("sub", ""))}</div></div>'
        for c in data.get("cards", []))
    rows = "".join(
        f'<tr class="{"bold" if r[0].startswith(("Pre-tax", "After-tax")) else ""}>'
        f'<td>{_h(r[0])}</td><td class="num">{_h(r[1])}</td>'
        f'<td class="num">{_h(r[2])}</td><td class="num">{_h(r[3])}</td>'
        f'<td class="num">{_h(r[4])}</td></tr>'
        for r in data.get("cashflow", []))
    facts = "".join(
        f'<tr><td>{_h(f.get("label", ""))}</td><td>{_h(f.get("value", ""))}</td></tr>'
        for f in data.get("propertyFacts", []))
    facts_block = (
        '<h1 style="font-size:14px">About the property</h1>'
        '<table><tbody>' + facts + '</tbody></table>' if facts else '')
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{_h(data.get('title', 'Proposal'))}</title>
<style>{css}</style></head>
<body>
  <div class="head">
    <div><div class="brand">{_h(data.get('baName', ''))}</div>
    <div class="client">Prepared for {_h(data.get('client', ''))}</div></div>
    <div class="client">{_h(data.get('date', ''))}</div>
  </div>
  <h1>{_h(data.get('title', 'Property proposal'))}</h1>
  <div class="cards">{cards}</div>
  {facts_block}
  <h1 style="font-size:14px">Cash flow — first year</h1>
  <table>
    <thead><tr><th>Line item</th><th>Annual</th><th>Monthly</th><th>Fortnightly</th><th>Weekly</th></tr></thead>
    <tbody>{rows}</tbody>
  </table>
  <div class="foot">{_h(data.get('disclaimer', 'Estimates only — not financial or tax advice.'))}</div>
</body></html>"""


@bp.post("/presentation/<int:pid>/pdf")
@auth.require_auth
def pdf(pid):
    row = _my_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    data = request.get_json(silent=True) or {}
    data.setdefault("title", row["title"])
    data.setdefault("baName", _presentation_out(row, with_snapshot=False)["baName"])
    data.setdefault("date", datetime.utcnow().strftime("%d %b %Y"))
    data.setdefault(
        "disclaimer",
        "Illustrative model based on stated assumptions. Excludes some costs; "
        "figures change with the inputs. Not financial or tax advice.")
    html = _pdf_html(row, data)
    try:
        from weasyprint import HTML
        pdf = HTML(string=html).write_pdf()
        safe = "".join(ch for ch in row["title"] if ch.isalnum() or ch in " -").strip() or "proposal"
        return Response(
            pdf, mimetype="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{safe}.pdf"'})
    except ImportError:
        return Response(html, mimetype="text/html; charset=utf-8")


@bp.post("/presentation/<int:pid>/request-changes")
@auth.require_auth
def request_changes(pid):
    return _decision(pid, "changes_requested", "Requested changes")
