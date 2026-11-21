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
import mailer
import ratelimit
import report as report_mod
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


def _portfolio_by_token(token):
    row = db.db().fetch_one(
        "SELECT * FROM portfolios WHERE share_token_hash = ?", (_sha256(token),))
    if not row:
        return None, (404, "link not found")
    if row["status"] != "active":
        return None, (410, "this link is no longer active")
    if row["expires_at"] and datetime.utcnow() >= datetime.fromisoformat(row["expires_at"]):
        return None, (410, "this link has expired")
    return row, None


def _decision_of(pid):
    row = db.db().fetch_one(
        "SELECT type FROM presentation_events WHERE presentation_id = ? "
        "AND type IN ('approved', 'changes_requested') ORDER BY id DESC LIMIT 1", (pid,))
    return row["type"] if row else None


def _portfolio_out(row):
    ba = db.db().fetch_one(
        "SELECT display_name, email FROM users WHERE id = ?", (row["ba_user_id"],))
    items = db.db().fetch_all(
        "SELECT pi.*, p.title FROM portfolio_items pi "
        "JOIN presentations p ON p.id = pi.presentation_id "
        "WHERE pi.portfolio_id = ? AND p.status = 'active' "
        "ORDER BY pi.position, pi.id", (row["id"],))
    return {
        "id": row["id"],
        "title": row["title"],
        "baName": (ba["display_name"] or ba["email"].split("@")[0]) if ba else "",
        "branding": branding.branding_out(row["ba_user_id"]),
        "items": [{
            "presentationId": i["presentation_id"],
            "label": i["label"] or i["title"],
            "title": i["title"],
            "summary": json.loads(i["summary_json"] or "{}"),
            "decision": _decision_of(i["presentation_id"]),
        } for i in items],
    }


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
        out["attachments"] = db.db().fetch_all(
            "SELECT id, display_name AS displayName, mime, bytes, "
            "created_at AS createdAt FROM attachments "
            "WHERE scenario_id = ? ORDER BY id", (row["scenario_id"],))
    return out


def _log_event(pid, uid, type_, body=""):
    db.db().execute(
        "INSERT INTO presentation_events (presentation_id, user_id, type, body) "
        "VALUES (?, ?, ?, ?)", (pid, uid, type_, body[:2000]))


def _notify_ba(row, event_type, body=""):
    """Email the owning BA when they've opted in (max 2 emails / 15 min
    per presentation+client so a chatty session can't spam)."""
    if not ratelimit.hit(f"ba-alert:{row['id']}:{row['client_user_id']}", 2, 900):
        return
    ba = db.db().fetch_one(
        "SELECT u.email, u.display_name FROM users u "
        "JOIN ba_alerts a ON a.user_id = u.id AND a.enabled = 1 "
        "WHERE u.id = ?", (row["ba_user_id"],))
    if not ba:
        return
    client = db.db().fetch_one("SELECT display_name, email FROM users WHERE id = ?",
                               (row["client_user_id"],))
    client_name = ((client["display_name"] or "") if client else "") \
        or ((client["email"].split("@")[0]) if client else "Client")
    mailer.send_activity_email(
        ba["email"], ba["display_name"] or ba["email"].split("@")[0],
        client_name, row["title"], event_type, body[:500])


@bp.get("/resolve/<token>")
def resolve(token):
    if not ratelimit.hit(f"resolve:{request.remote_addr}", 30, 300):
        return jsonify({"ok": False, "error": "too many requests"}), 429
    row, err = _by_token(token)
    if err:
        if err[0] != 404:
            return jsonify({"ok": False, "error": err[1]}), err[0]
        pf, pf_err = _portfolio_by_token(token)
        if pf_err:
            return jsonify({"ok": False, "error": pf_err[1]}), pf_err[0]
        return _resolve_portfolio(pf)

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


def _resolve_portfolio(row):
    items = db.db().fetch_all(
        "SELECT presentation_id FROM portfolio_items WHERE portfolio_id = ? "
        "ORDER BY position, id LIMIT 1", (row["id"],))
    if not ratelimit.hit(f"viewed:pf{row['id']}:{row['client_user_id']}", 1, 3600):
        pass
    elif items:
        _log_event(items[0]["presentation_id"], row["client_user_id"],
                   "viewed", "Opened the portfolio")
    user = db.db().fetch_one(
        "SELECT id, email, display_name, role FROM users WHERE id = ?",
        (row["client_user_id"],))
    return jsonify({"ok": True, "data": {
        "me": {"id": user["id"], "email": user["email"],
               "displayName": user["display_name"] or user["email"].split("@")[0],
               "role": user["role"]},
        "token": auth.make_token(user),
        "portfolio": _portfolio_out(row),
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
    _notify_ba(row, "comment", body)
    db.db().execute(
        "UPDATE presentations SET updated_at = datetime('now') WHERE id = ?", (pid,))
    return jsonify({"ok": True, "data": {"posted": True}}), 201


def _decision(pid, type_, default_body):
    row = _my_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    body = ((request.get_json(silent=True) or {}).get("body") or "").strip() or default_body
    _log_event(pid, g.user["id"], type_, body)
    _notify_ba(row, type_, body)
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
  @page {
    size: A4;
    margin: 30mm 15mm 20mm 15mm;
    @top-center { content: element(pagehead); }
    @bottom-left { content: element(pagefoot); }
    @bottom-right { content: "Page " counter(page) " of " counter(pages);
                    font-size: 8px; color: #94a3b8; }
  }
  @page :first { @top-center { content: none; } }
  .pagehead { position: running(pagehead); width: 100%; display: flex;
              align-items: center; gap: 7px; border-bottom: 1.5px solid ACCENT;
              padding-bottom: 4px; font-size: 10px; font-weight: 700;
              color: ACCENT; }
  .pagehead img { height: 20px; padding: 2px; border: 1px solid #e2e8f0;
                  border-radius: 5px; background: #fff; }
  .pagefoot { position: running(pagefoot); width: 100%; font-size: 8px;
              color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 4px; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #0f172a;
         margin: 0; font-size: 12px; }
  .head { display: flex; justify-content: space-between; align-items: center;
          border-bottom: 3px solid ACCENT; padding-bottom: 12px; margin-bottom: 18px; }
  .brandrow { display: flex; align-items: center; gap: 10px; }
  .brandrow img { height: 40px; padding: 3px; border: 1px solid #e2e8f0;
                  border-radius: 8px; background: #fff; }
  .brand { font-size: 17px; font-weight: 700; color: ACCENT; }
  .tagline { color: #64748b; font-size: 10px; }
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
  .bars { display: flex; align-items: flex-end; gap: 2px; height: 64px;
          margin: 6px 0 14px; }
  .bars .bar { flex: 1; min-width: 2px; border-radius: 2px 2px 0 0; }
  .bars-label { color: #475569; font-size: 9px; text-transform: uppercase;
                letter-spacing: .4px; margin-top: 14px; }
  .zero { border-bottom: 1px solid #cbd5e1; height: 1px; }
  .foot { color: #94a3b8; font-size: 9px; margin-top: 24px; border-top: 1px solid #e2e8f0;
          padding-top: 8px; }
  .docs { margin: 0 0 8px; padding: 0; list-style: none; }
  .docs li { padding: 3px 0; border-bottom: 1px solid #f1f5f9; }
"""


def _bars(values, color_pos, color_neg):
    """CSS bar strip — WeasyPrint has no JS charts, so the hold-period
    charts are drawn as flex divs scaled to the max absolute value."""
    if not values:
        return ''
    peak = max((abs(v) for v in values), default=1) or 1
    bars = ''.join(
        f'<div class="bar" style="height:{max(1, round(abs(v) / peak * 100))}%;'
        f'background:{color_pos if v >= 0 else color_neg}"></div>'
        if abs(v) > peak / 200 else '<div class="bar zero"></div>'
        for v in values)
    return f'<div class="bars">{bars}</div>'


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

    years = data.get("years") or []
    hold_block = ''
    if years:
        year_rows = "".join(
            f'<tr><td>Y{r.get("year")} · {_h(str(r.get("calendarYear", "")))}</td>'
            f'<td class="num">{_h(r.get("value", ""))}</td>'
            f'<td class="num">{_h(r.get("debt", ""))}</td>'
            f'<td class="num">{_h(r.get("equity", ""))}</td>'
            f'<td class="num">{_h(r.get("cashflow", ""))}</td>'
            f'<td class="num">{_h(r.get("cumulative", ""))}</td></tr>'
            for r in years)
        hold_block = (
            '<h1 style="font-size:14px">Over the hold period</h1>'
            '<div class="bars-label">Net equity over time</div>'
            + _bars(data.get("equitySeries") or [], accent, "#e11d48")
            + '<div class="bars-label">After-tax cash flow by year (green surplus, red needs funding)</div>'
            + _bars(data.get("cashSeries") or [], "#059669", "#e11d48")
            + '<table><thead><tr><th>Year</th><th>Property value</th><th>Total debt</th>'
              '<th>Net equity</th><th>After-tax cash flow</th><th>Cumulative position</th></tr></thead>'
              '<tbody>' + year_rows + '</tbody></table>')
    docs = data.get("documents") or []
    docs_block = ''
    if docs:
        items = "".join(f'<li>{_h(d)}</li>' for d in docs)
        docs_block = ('<h1 style="font-size:14px">Attached documents</h1>'
                      '<ul class="docs">' + items + '</ul>'
                      '<div class="source" style="color:#94a3b8;font-size:9px">'
                      'All documents are available to open on your shared link.</div>')
    small_logo = (f'<img src="{_h(data.get("logo", ""))}" alt="">'
                  if data.get('logo') else '')
    runners = (f'<div class="pagehead">{small_logo}<span>{_h(data.get("baName", ""))}</span>'
               f'<span style="margin-left:auto;font-weight:400;color:#64748b">'
               f'{_h(data.get("client", "") and "Prepared for " + data.get("client", ""))}</span></div>'
               f'<div class="pagefoot">{_h(data.get("baName", ""))} · '
               f'{_h(data.get("disclaimer", "Estimates only — not financial or tax advice."))}</div>')
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{_h(data.get('title', 'Proposal'))}</title>
<style>{css}</style></head>
<body>
  {runners}
  <div class="head">
    <div class="brandrow">{'<img src="' + _h(data.get('logo', '')) + '" alt="logo">' if data.get('logo') else ''}<div>
      <div class="brand">{_h(data.get('baName', ''))}</div>
      <div class="tagline">{_h(data.get('tagline', ''))}</div>
      <div class="client">Prepared for {_h(data.get('client', ''))}</div>
    </div></div>
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
  {hold_block}
  {docs_block}
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
    brand = branding.branding_out(row["ba_user_id"]) or {}
    if brand.get("businessName"):
        data.setdefault("baName", brand["businessName"])
    data.setdefault("baName", _presentation_out(row, with_snapshot=False)["baName"])
    if brand.get("logoUrl"):
        data.setdefault("logo", report_mod._logo_data_uri(brand["logoUrl"]))
    if brand.get("tagline"):
        data.setdefault("tagline", brand["tagline"])
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


@bp.post("/presentation/<int:pid>/report")
@auth.require_auth
def report(pid):
    """Full branded report pack — same figures pipeline as the PDF route,
    with server-side evidence/context sections added."""
    row = _my_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    payload = request.get_json(silent=True) or {}
    payload.setdefault("title", row["title"])
    client_user = db.db().fetch_one(
        "SELECT display_name FROM users WHERE id = ?", (row["client_user_id"],))
    payload.setdefault("client", (client_user["display_name"] or "") if client_user else "")
    ba_user_id = db.db().fetch_one(
        "SELECT ba_user_id FROM presentations WHERE id = ?", (pid,))["ba_user_id"]
    ctx = report_mod.context_for_scenario(row["scenario_id"], ba_user_id)
    return report_mod.render_report(payload, ctx)


@bp.get("/presentation/<int:pid>/evidence")
@auth.require_auth
def evidence(pid):
    """Comps, rentals, suburb data and overlays for the portal's evidence section."""
    row = _my_presentation(pid)
    if not row:
        return jsonify({"ok": False, "error": "presentation not found"}), 404
    data = report_mod.evidence_for_scenario(row["scenario_id"])
    return jsonify({"ok": True, "data": data or {"comps": [], "rentals": [], "suburb": None,
                                                 "overlays": {}, "buyRange": {}}})


@bp.post("/presentation/<int:pid>/request-changes")
@auth.require_auth
def request_changes(pid):
    return _decision(pid, "changes_requested", "Requested changes")
