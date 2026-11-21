# Copyright (c) 2026 RV
"""
Full property report pack — the PIA-style analysis + evidence the BA used
to assemble by hand from separate PDFs.

The engine runs in the browser, so callers POST the computed figures
(payload); this module renders them with server-side context: sales/rental
comps, suburb reference data, risk overlays, attachments, branding. One
HTML template → WeasyPrint PDF (HTML fallback when WeasyPrint is missing).
Every section degrades gracefully — missing data omits the section.
"""

import base64
import json
import os
import re
from datetime import datetime

from flask import Response, jsonify

import attachments
import branding
import db
from html import escape as _escape


def _h(v):
    return _escape("" if v is None else str(v))


# ---------------------------------------------------------------------------
# Server-side context: everything the browser cannot compute
# ---------------------------------------------------------------------------

def _comps_for(sid):
    return db.db().fetch_all(
        "SELECT address, sold_price, sold_date, beds, land_m2, rent_estimate "
        "FROM comps WHERE scenario_id = ? AND sold_price IS NOT NULL "
        "ORDER BY sold_date DESC", (sid,))


def _rentals_for(sid):
    return db.db().fetch_all(
        "SELECT address, rent_weekly, bedrooms, property_type "
        "FROM rental_comps WHERE scenario_id = ? AND rent_weekly IS NOT NULL "
        "ORDER BY id", (sid,))


def _suburb_for(sid):
    row = db.db().fetch_one(
        "SELECT s.* FROM suburbs s JOIN scenarios c ON c.suburb_id = s.id "
        "WHERE c.id = ?", (sid,))
    if not row:
        return None
    out = dict(row)
    try:
        out["sources"] = json.loads(row.get("sources_json") or "{}")
    except (ValueError, TypeError):
        out["sources"] = {}
    return out


def _overlays_for(inputs):
    """Risk overlays from live government data, when the address is located.
    Best-effort: intel problems never break the report."""
    out = {}
    try:
        meta = ((inputs.get("properties") or [{}])[0].get("addressMeta") or {})
        lat, lon = meta.get("lat"), meta.get("lon")
        state = str(meta.get("state") or inputs.get("state") or "").upper()
        if lat and lon:
            if state == "VIC":
                import vic_intel
                data = vic_intel.property_intel(float(lat), float(lon))
                bf = data.get("bushfire") or {}
                out["bushfireProne"] = bf.get("prone")
            else:
                import qld_intel
                data = qld_intel.property_intel(float(lat), float(lon))
                studies = (data.get("flood") or {}).get("studies") or []
                out["floodStudies"] = [s.get("name") for s in studies if s.get("name")]
    except Exception:
        pass
    return out


def context_for_scenario(scenario_id, ba_user_id):
    """Everything for one scenario; None-safe pieces for degraded reports."""
    if not scenario_id:
        return None
    row = db.db().fetch_one("SELECT * FROM scenarios WHERE id = ?", (scenario_id,))
    if not row:
        return None
    try:
        inputs = json.loads(row["inputs_json"])
    except (ValueError, TypeError):
        inputs = {}
    return {
        "scenario": dict(row),
        "inputs": inputs,
        "comps": _comps_for(scenario_id),
        "rentals": _rentals_for(scenario_id),
        "suburb": _suburb_for(scenario_id),
        "attachments": [a["displayName"] for a in attachments.list_for_scenario(scenario_id)],
        "branding": branding.branding_out(ba_user_id),
        "overlays": _overlays_for(inputs),
    }


def evidence_for_scenario(scenario_id):
    """Client-safe subset for the portal's evidence section."""
    if not scenario_id:
        return None
    row = db.db().fetch_one("SELECT inputs_json, suburb_id FROM scenarios WHERE id = ?",
                            (scenario_id,))
    if not row:
        return None
    try:
        inputs = json.loads(row["inputs_json"])
    except (ValueError, TypeError):
        inputs = {}
    return {
        "comps": _comps_for(scenario_id),
        "rentals": _rentals_for(scenario_id),
        "suburb": _suburb_for(scenario_id),
        "overlays": _overlays_for(inputs),
        "buyRange": {
            "low": inputs.get("buyRangeLow"),
            "high": inputs.get("buyRangeHigh"),
        },
    }


# ---------------------------------------------------------------------------
# Rendering helpers
# ---------------------------------------------------------------------------

def _money(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "—"
    sign = "−" if v < 0 else ""
    return f"{sign}${abs(v):,.0f}"


def _pct(v, dp=2):
    try:
        return f"{float(v) * 100:.{dp}f}%"
    except (TypeError, ValueError):
        return "—"


def _logo_bytes(logo_url):
    """(bytes, mime) for the branding logo, or None when unusable."""
    if not logo_url:
        return None
    m = re.fullmatch(r"/api/branding/file/([0-9a-fA-F-]{8,64}\.(?:png|jpg))",
                     str(logo_url))
    if m:  # locally stored logo — read straight off disk, no HTTP hop
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "data", "branding", m.group(1))
        try:
            with open(path, "rb") as fh:
                data = fh.read()
            return data, "image/png" if path.endswith(".png") else "image/jpeg"
        except OSError:
            return None
    import requests
    try:
        r = requests.get(logo_url, timeout=5)
        ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
        if r.status_code == 200 and len(r.content) <= 1024 * 1024 \
                and ctype in ("image/png", "image/jpeg"):
            return r.content, ctype
    except Exception:
        pass
    return None


def _logo_data_uri(logo_url):
    """Branding logo → data URI for the PDF header; None when unusable."""
    got = _logo_bytes(logo_url)
    if not got:
        return None
    data, ctype = got
    return f"data:{ctype};base64," + base64.b64encode(data).decode()


def _bars(values, color_pos, color_neg):
    if not values:
        return ""
    peak = max((abs(v) for v in values), default=1) or 1
    bars = "".join(
        f'<div class="bar" style="height:{max(1, round(abs(v) / peak * 100))}%;'
        f'background:{color_pos if v >= 0 else color_neg}"></div>'
        if abs(v) > peak / 200 else '<div class="bar zero"></div>'
        for v in values)
    return f'<div class="bars">{bars}</div>'


def _stack(segments):
    """Horizontal stacked bar: [(label, value, color)] → % widths."""
    segs = [(l, float(v or 0), c) for (l, v, c) in segments]
    total = sum(abs(v) for _, v, _ in segs) or 1
    html = '<div class="stack">'
    for label, value, color in segs:
        width = abs(value) / total * 100
        if width < 0.5:
            continue
        html += (f'<div class="seg" style="width:{width:.1f}%;background:{color}">'
                 f'<span>{_h(label)} {_h(_pct(abs(value) / total, 0))}</span></div>')
    html += "</div>"
    return html


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
              padding-bottom: 4px; font-size: 9.5px; font-weight: 700;
              color: ACCENT; }
  .pagehead img { height: 20px; padding: 2px; border: 1px solid #e2e8f0;
                  border-radius: 5px; background: #fff; }
  .pagefoot { position: running(pagefoot); width: 100%; font-size: 8px;
              color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 4px; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #0f172a;
         margin: 0; font-size: 11px; }
  .head { display: flex; justify-content: space-between; align-items: center;
          border-bottom: 3px solid ACCENT; padding-bottom: 10px; margin-bottom: 14px; }
  .brandrow { display: flex; align-items: center; gap: 10px; }
  .brandrow img { height: 34px; padding: 3px; border: 1px solid #e2e8f0;
                  border-radius: 7px; background: #fff; }
  .brand { font-size: 16px; font-weight: 700; color: ACCENT; }
  .tagline { color: #64748b; font-size: 10px; }
  .client { color: #64748b; font-size: 10px; margin-top: 2px; }
  h1 { font-size: 18px; margin: 0 0 10px; }
  h1.sec { font-size: 13px; margin: 22px 0 8px; break-before: page; }
  h1.sec.first { break-before: auto; }
  h1.subsec { font-size: 11.5px; margin: 12px 0 6px; color: #334155; }
  .cards { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .card { border: 1px solid #e2e8f0; border-radius: 7px; padding: 8px 12px; min-width: 140px; }
  .card .label { font-size: 8px; color: #64748b; text-transform: uppercase; letter-spacing: .4px; }
  .card .value { font-size: 14px; font-weight: 700; margin: 2px 0; }
  .card .sub { font-size: 8px; color: #64748b; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th, td { text-align: left; padding: 4px 7px; border-bottom: 1px solid #e2e8f0; }
  th { font-size: 9px; color: #475569; text-transform: uppercase; letter-spacing: .4px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.bold td { font-weight: 700; }
  .bars { display: flex; align-items: flex-end; gap: 2px; height: 58px; margin: 5px 0 10px; }
  .bars .bar { flex: 1; min-width: 2px; border-radius: 2px 2px 0 0; }
  .bars .zero { border-bottom: 1px solid #cbd5e1; height: 1px; }
  .bars-label { color: #475569; font-size: 8px; text-transform: uppercase;
                letter-spacing: .4px; margin-top: 10px; }
  .stack { display: flex; height: 26px; border-radius: 6px; overflow: hidden;
           margin: 6px 0 4px; }
  .stack .seg { color: #fff; font-size: 9px; font-weight: 700; display: flex;
                align-items: center; justify-content: center; white-space: nowrap; }
  .stack-cap { color: #64748b; font-size: 9px; margin-bottom: 10px; }
  .wp-cols { display: flex; align-items: flex-end; gap: 2px; margin: 8px 0 2px; }
  .wp-col { flex: 1; text-align: center; }
  .wp-stack { display: flex; flex-direction: column; height: 64px; border-radius: 2px;
              overflow: hidden; }
  .wp-year { font-size: 6.5px; color: #94a3b8; margin-top: 2px; }
  .kv { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 18px; margin-bottom: 10px; }
  .kv div { border-bottom: 1px solid #f1f5f9; padding: 3px 0; }
  .kv .k { color: #64748b; }
  .note { color: #64748b; font-size: 9px; margin: 3px 0 10px; }
  .docs { margin: 0 0 8px; padding: 0 14px; }
  .docs li { padding: 2px 0; border-bottom: 1px solid #f1f5f9; }
  .foot { color: #94a3b8; font-size: 8px; margin-top: 22px; border-top: 1px solid #e2e8f0;
          padding-top: 7px; }
"""


# ---------------------------------------------------------------------------
# Report HTML
# ---------------------------------------------------------------------------

def _section_cashflow(p, accent):
    y1 = p.get("year1") or {}
    f = p.get("funding") or {}
    m = p.get("metrics") or {}
    ts = p.get("taxSplit") or {}
    money = _money

    cards = "".join(
        f'<div class="card"><div class="label">{_h(lbl)}</div>'
        f'<div class="value">{_h(val)}</div><div class="sub">{_h(sub)}</div></div>'
        for lbl, val, sub in [
            ("Purchase price", money((p.get("subject") or {}).get("price") or m.get("purchasePrice")),
             "duty " + money(f.get("transferDuty")) + " · acquisition " + money(f.get("acquisitionCosts"))),
            ("Total funds required", money(f.get("requiredFunds")),
             "loan " + money(f.get("ipLoanStart")) + " at " + _pct((p.get("loan") or {}).get("rate"))),
            ("Weekly out-of-pocket", money((y1.get("afterTaxCashFlow") or 0) / 52),
             "after tax, year 1"),
            ("Year-1 tax credit", money(max(0, y1.get("taxRefundOrCost") or 0)),
             "negative gearing + depreciation"),
            ("Gross yield / cap rate", _pct(m.get("grossYield")) + " / " + _pct(m.get("netYield")),
             "year-1 income on price"),
            ("IRR", _pct(m.get("irrApproximation"), 1),
             "whole-of-hold internal rate of return"),
            ("Exit proceeds", money(m.get("netSaleProceeds")),
             "sale after costs, CGT and loans"),
        ])

    def line(label, v, bold=False):
        return (f'<tr class="{"bold" if bold else ""}"><td>{_h(label)}</td>'
                f'<td class="num">{_h(money(v))}</td><td class="num">{_h(money((v or 0) / 12))}</td>'
                f'<td class="num">{_h(money((v or 0) / 26))}</td><td class="num">{_h(money((v or 0) / 52))}</td></tr>')

    cf = "".join([
        line("Gross rental income", y1.get("grossRent")),
        line("Vacancy loss", -(y1.get("vacancyLoss") or 0)),
        line("Operating expenses", -(y1.get("operatingExpenses") or 0)),
        line("Loan interest", -(y1.get("ipInterest") or 0) - (y1.get("equityLoanInterest") or 0)),
        line("Pre-tax cash flow", y1.get("preTaxCashFlow"), True),
        line("Tax refund / (cost)", y1.get("taxRefundOrCost")),
        line("After-tax cash flow", y1.get("afterTaxCashFlow"), True),
    ])

    ded = "".join(
        f'<tr><td>{_h(k)}</td><td class="num">{_h(money(v))}</td></tr>'
        for k, v in [
            ("Loan interest claimed", (y1.get("ipInterest") or 0) + (y1.get("equityLoanInterest") or 0)),
            ("Rental expenses", y1.get("operatingExpenses")),
            ("Depreciation: building (capital works)", y1.get("capitalWorksDepreciation")),
            ("Depreciation: plant & equipment", y1.get("plantEquipmentDepreciation")),
            ("Other deductible claims", y1.get("otherDeductibleClaims")),
        ])

    if ts.get("owner2") is not None:
        split_rows = "".join(
            f'<td class="num">{_h(money(v))}</td>' for v in (ts.get("owner1"), ts.get("owner2"), ts.get("total")))
        split = f"""
          <h1 class="subsec">Tax credits by owner</h1>
          <table><thead><tr><th></th><th class="num">Owner 1 ({_pct(ts.get("rate1"), 0)} · {_h(ts.get("bracket1") or "")})</th>
          <th class="num">Owner 2 ({_pct(ts.get("rate2"), 0)} · {_h(ts.get("bracket2") or "")})</th>
          <th class="num">Total</th></tr></thead>
          <tbody><tr><td>Tax credit / (cost)</td>{split_rows}</tr></tbody></table>
          <div class="note">Each owner's {int((ts.get("share") or 0.5) * 100)}% share of the property result is taxed at their own marginal rate
          (incomes {_h(money(ts.get("income1")))} / {_h(money(ts.get("income2")))}).</div>"""
    else:
        split = (f'<div class="note">Sole ownership — tax assessed at the owner\'s marginal rate '
                 f'({_pct(ts.get("rate1"), 0)} · {_h(ts.get("bracket1") or "")}).</div>')

    return f"""
      <h1 class="sec first">Cash flow analysis — first year</h1>
      <div class="cards">{cards}</div>
      <h1 class="subsec">Income &amp; expenditure</h1>
      <table><thead><tr><th>Line item</th><th class="num">Annual</th><th class="num">Monthly</th>
      <th class="num">Fortnightly</th><th class="num">Weekly</th></tr></thead><tbody>{cf}</tbody></table>
      <h1 class="subsec">Tax deductions</h1>
      <table><tbody>{ded}</tbody></table>
      {split}
      <div class="note">Figures change with the input assumptions and are estimates only — not financial or tax advice.</div>"""


def _who_pays_segments(y1):
    total_cost = ((y1.get("ipInterest") or 0) + (y1.get("equityLoanInterest") or 0)
                  + (y1.get("ipPrincipalRepayment") or 0)
                  + (y1.get("equityLoanPrincipalRepayment") or 0)
                  + (y1.get("operatingExpenses") or 0)
                  + (y1.get("otherDeductibleClaims") or 0))
    tenant = min(max(0.0, y1.get("effectiveRent") or 0), total_cost)
    taxman = max(0.0, y1.get("taxRefundOrCost") or 0)
    owner = total_cost - tenant - taxman
    return [("Tenant", tenant, "#22c55e"), ("Taxman", taxman, "#818cf8"), ("You", owner, "#e11d48")]


def _who_pays_yearly_columns(p):
    """PIA-style per-year contribution columns: each year a mini stacked bar
    of tenant/taxman/owner shares, plus the dollar table underneath."""
    years = p.get("years") or []
    if not years:
        return ""
    cols = ""
    for r in years:
        segs = _who_pays_segments(r)
        total = sum(abs(v) for _, v, _ in segs) or 1
        stack = "".join(
            f'<div style="height:{abs(v) / total * 100:.0f}%;background:{c}"></div>'
            for _, v, c in segs if abs(v) > total * 0.004)
        cols += (f'<div class="wp-col"><div class="wp-stack">{stack}</div>'
                 f'<div class="wp-year">Y{int(r.get("year") or 0)}</div></div>')
    table_rows = "".join(
        f'<tr><td>Y{int(r.get("year") or 0)}</td>'
        + "".join(f'<td class="num">{_h(_money(s[1]))}</td>' for s in _who_pays_segments(r))
        + "</tr>"
        for r in years)
    return ('<div class="wp-cols">' + cols + '</div>'
            '<div class="stack-cap">Green tenant · purple taxman · red you (share of each year\'s cost)</div>'
            '<table><thead><tr><th>Year</th><th class="num">Tenant pays</th>'
            '<th class="num">Taxman pays</th><th class="num">You pay</th></tr></thead>'
            f'<tbody>{table_rows}</tbody></table>')


def _section_exit(p):
    x = p.get("exit")
    if not x:
        return ""
    funding = p.get("funding") or {}
    rows = p.get("years") or []
    cum_at_sale = rows[x.get("saleYear", 0) - 1].get("cumulativeAfterTaxCashFlow") if rows and x.get("saleYear") else None

    def line(label, v, bold=False):
        return (f'<tr class="{"bold" if bold else ""}"><td>{_h(label)}</td>'
                f'<td class="num">{_h(_money(v))}</td></tr>')
    body = "".join([
        line(f'Sale price (year {x.get("saleYear")}, {x.get("calendarSaleYear")})', x.get("salePrice")),
        line("Selling costs", -(x.get("sellingCosts") or 0)),
        line("Capital gain", x.get("capitalGain")),
        line("CGT" + (" (50% discount applied)" if x.get("heldMoreThan12Months") else ""),
             -(x.get("capitalGainsTax") or 0)),
        line("Loan payout (IP + equity)", -((x.get("ipLoanBalanceAtSale") or 0)
                                            + (x.get("equityLoanBalanceAtSale") or 0))),
        line("Net sale proceeds", x.get("netSaleProceeds"), True),
        line("Cumulative after-tax cash flow to sale", cum_at_sale),
        line("Cash invested (deposit + acquisition)", -(funding.get("initialCashInvested") or 0)),
        line("Total net position", x.get("totalNetPosition"), True),
    ])
    return (f'<h1 class="sec">Exit &amp; CGT</h1>'
            '<div class="note">Sale at the modelled year — before-tax view of the exit after '
            'selling costs, capital gains tax and loan payouts.</div>'
            '<table><tbody>' + body + '</tbody></table>')


def _dc_score(v):
    return f"{v['score']}/100" if v.get("score") is not None else "—"


def _section_deal_check(p):
    """Deal Check & recommendation — census verdicts (server-scored) plus
    deal verdicts (engine-scored client-side), posted by the client."""
    dc = p.get("dealCheck") or {}
    overall = dc.get("overall") or {}
    verdicts = dc.get("verdicts") or []
    if not overall or overall.get("score") is None or not verdicts:
        return ""
    sa2 = (dc.get("sa2") or {}).get("name") or ""
    score = overall.get("score")
    word = overall.get("verdictWord") or "—"
    icon = {"strong": "✓", "ok": "·", "watch": "⚠", "nodata": "·"}

    def _rows(group, heading):
        rows = "".join(
            f'<div class="kv"><span class="k">{_h(icon.get(v.get("status"), "·"))} {_h(v.get("question", ""))}</span> '
            f'<strong>{_h(_dc_score(v))}</strong></div>'
            for v in verdicts if v.get("group") == group)
        return (f'<div class="note"><strong>{_h(heading)}</strong></div>' + rows) if rows else ""

    drivers = (overall.get("drivers") or {})
    driver_bits = []
    if drivers.get("for"):
        driver_bits.append("For: " + "; ".join(drivers["for"]))
    if drivers.get("against"):
        driver_bits.append("Against: " + "; ".join(drivers["against"]))
    drivers_html = (f'<div class="note">Key drivers — { _h(" ".join(driver_bits)) }</div>'
                    if driver_bits else "")
    return (f'<h1 class="sec">Deal check &amp; recommendation</h1>'
            f'<div class="kv"><div><span class="k">Area ({_h(sa2)})</span> '
            f'<strong>{_h(word)} · {"" if score is None else f"{score}/100"}</strong></div></div>'
            f'<div class="note">{_h(overall.get("headline") or "")}</div>'
            + drivers_html
            + _rows("area", "The area — census fundamentals")
            + _rows("deal", "The deal — your numbers")
            + '<div class="note">Area percentiles compare this SA2 with all SA2s nationally '
              '(ABS 2021 Census); deal verdicts score your numbers against the linked suburb. '
              'One input to the decision — pair with price, yield and cash flow. '
              'Not financial advice.</div>')


def _section_checks(p):
    checks = p.get("checks") or []
    if not checks:
        return ""
    icon = {"ok": "✓", "warn": "⚠", "unknown": "·"}
    rows = "".join(
        f'<div class="kv"><span class="k">{_h(icon.get(c.get("status"), "·"))} {_h(c.get("label", ""))}</span> '
        f'<strong>{_h(c.get("detail", ""))}</strong></div>'
        for c in checks)
    return ('<h1 class="sec">Due-diligence checklist</h1>'
            '<div class="note">Points to verify before committing — unknowns MUST be checked manually.</div>'
            + rows)


def _section_replacement(p):
    rep = p.get("replacement") or {}
    land = rep.get("landValue")
    build = rep.get("capitalWorksBase")
    if not land and not build:
        return ""
    total = (land or 0) + (build or 0)
    return (f'<h1 class="sec">Replacement value</h1><div class="kv">'
            f'<div><span class="k">Land value</span> <strong>{_h(_money(land))}</strong></div>'
            f'<div><span class="k">Building replacement (depreciable base)</span> <strong>{_h(_money(build))}</strong></div>'
            f'<div><span class="k">Total replacement value</span> <strong>{_h(_money(total))}</strong></div>'
            '</div><div class="note">What it would cost to replace the asset today — a sanity check '
            'on the purchase price.</div>')


def _section_who_pays(p):
    y1 = p.get("year1") or {}
    y1_seg = _who_pays_segments(y1)
    html = '<h1 class="sec">Who pays the cost?</h1>'
    html += _stack(y1_seg) + '<div class="stack-cap">First year</div>'
    yearly = _who_pays_yearly_columns(p)
    if yearly:
        html += yearly
    html += ('<div class="note">The tenant pays most of the holding cost through rent; the tax '
             'refund covers part; the remainder is your out-of-pocket contribution.</div>')
    return html


def _section_projections(p):
    years = (p.get("years") or [])[:30]
    if not years:
        return ""
    body = "".join(
        f'<tr><td>Y{int(r.get("year") or i + 1)} · {_h(str(r.get("calendarYear") or ""))}</td>'
        f'<td class="num">{_h(_money(r.get("grossRent")))}</td>'
        f'<td class="num">{_h(_money((r.get("ipInterest") or 0) + (r.get("equityLoanInterest") or 0)))}</td>'
        f'<td class="num">{_h(_money(r.get("operatingExpenses")))}</td>'
        f'<td class="num">{_h(_money(r.get("preTaxCashFlow")))}</td>'
        f'<td class="num">{_h(_money(r.get("taxRefundOrCost")))}</td>'
        f'<td class="num">{_h(_money(r.get("afterTaxCashFlow")))}</td>'
        f'<td class="num">{_h(_money(r.get("cumulativeAfterTaxCashFlow")))}</td></tr>'
        for i, r in enumerate(years))
    html = ('<h1 class="sec">Projections over the hold</h1>'
            '<div class="bars-label">Pre-tax vs after-tax cash flow</div>'
            + _bars(p.get("preTaxSeries") or [], "#818cf8", "#818cf8")
            + _bars(p.get("cashSeries") or [], "#059669", "#e11d48")
            + '<div class="stack-cap">Top strip: pre-tax (purple) · bottom: after-tax (green surplus, red needed)</div>'
            '<table><thead><tr><th>Year</th><th class="num">Rent</th><th class="num">Interest</th>'
            '<th class="num">Expenses</th><th class="num">Pre-tax</th><th class="num">Tax credit</th>'
            '<th class="num">After-tax</th><th class="num">Cumulative</th></tr></thead>'
            f'<tbody>{body}</tbody></table>')
    return html


def _section_rental_evidence(ctx):
    rentals = ctx.get("rentals") or []
    if not rentals:
        return ""
    rents = sorted(r["rent_weekly"] for r in rentals if r["rent_weekly"])
    n = len(rents)
    median = rents[n // 2] if n % 2 else (rents[n // 2 - 1] + rents[n // 2]) / 2
    rows = "".join(
        f'<tr><td>{_h(r["address"])}</td><td class="num">{_h(_money(r["rent_weekly"]))}</td>'
        f'<td class="num">{_h(r.get("bedrooms") or "—")}</td>'
        f'<td>{_h(r.get("property_type") or "")}</td></tr>'
        for r in rentals)
    subject = (ctx.get("inputs") or {}).get("properties", [{}])[0]
    subject_rent = subject.get("weeklyRent")
    return f"""
      <h1 class="sec">Rental evidence</h1>
      <table><thead><tr><th>Comparable rental</th><th class="num">Rent/week</th>
      <th class="num">Beds</th><th>Type</th></tr></thead><tbody>{rows}</tbody></table>
      <div class="kv">
        <div><span class="k">Median of {n} comparables</span> <strong>{_h(_money(median))}/wk</strong></div>
        <div><span class="k">Average of comparables</span> <strong>{_h(_money(sum(rents) / n))}/wk</strong></div>
        <div><span class="k">Subject property rent</span> <strong>{_h(_money(subject_rent))}/wk</strong></div>
        <div><span class="k">Position</span> <strong>{_h("above market" if subject_rent and subject_rent > median else "in line with market")}</strong></div>
      </div>"""


def _section_sales_evidence(ctx):
    comps = ctx.get("comps") or []
    if not comps:
        return ""
    prices = sorted(c["sold_price"] for c in comps if c["sold_price"])
    n = len(prices)
    median = prices[n // 2] if n % 2 else (prices[n // 2 - 1] + prices[n // 2]) / 2
    rows = "".join(
        f'<tr><td>{_h(c["address"])}</td><td class="num">{_h(_money(c["sold_price"]))}</td>'
        f'<td>{_h(c.get("sold_date") or "")}</td><td class="num">{_h(c.get("beds") or "—")}</td>'
        f'<td class="num">{_h(_money(c["land_m2"]) + " m²" if c.get("land_m2") else "—")}</td></tr>'
        for c in comps)
    inputs = ctx.get("inputs") or {}
    subject = (inputs.get("properties") or [{}])[0]
    price = subject.get("purchasePrice")
    br_low, br_high = inputs.get("buyRangeLow"), inputs.get("buyRangeHigh")
    br = (f'<div><span class="k">Target buying range</span> <strong>{_h(_money(br_low))} – {_h(_money(br_high))}</strong></div>'
          if br_low and br_high else "")
    return f"""
      <h1 class="sec">Sales evidence</h1>
      <table><thead><tr><th>Comparable sale</th><th class="num">Sold price</th><th>Sold date</th>
      <th class="num">Beds</th><th class="num">Land</th></tr></thead><tbody>{rows}</tbody></table>
      <div class="kv">
        <div><span class="k">Median of {n} sales</span> <strong>{_h(_money(median))}</strong></div>
        <div><span class="k">Average of sales</span> <strong>{_h(_money(sum(prices) / n))}</strong></div>
        <div><span class="k">Subject purchase price</span> <strong>{_h(_money(price))}</strong></div>
        {br}
      </div>"""


def _section_suburb(ctx):
    sub = ctx.get("suburb")
    overlays = ctx.get("overlays") or {}
    if not sub and not overlays:
        return ""
    kv = ""
    if sub:
        pairs = [
            ("Suburb", f'{sub.get("name", "")} {sub.get("postcode", "")} {sub.get("state", "")}'.strip()),
            ("Median sale price", _money(sub.get("median_price"))),
            ("Median rent (3 bed)", _money(sub.get("median_rent_3bed")) + "/wk" if sub.get("median_rent_3bed") else "—"),
            ("Median rent (4 bed)", _money(sub.get("median_rent_4bed")) + "/wk" if sub.get("median_rent_4bed") else "—"),
            ("Vacancy rate", f'{sub["vacancy_pct"]:.1f}%' if sub.get("vacancy_pct") is not None else "—"),
            ("5-year price growth", f'{sub["growth_5yr_pct"]:.1f}%' if sub.get("growth_5yr_pct") is not None else "—"),
            ("Population growth", f'{sub["population_growth_pct"]:.1f}%' if sub.get("population_growth_pct") is not None else "—"),
            ("Median days on market", str(sub["median_days_on_market"]) if sub.get("median_days_on_market") is not None else "—"),
            ("Supply pipeline (approvals ratio)", f'{sub["approvals_ratio"]:.2f}' if sub.get("approvals_ratio") is not None else "—"),
        ]
        kv = "".join(f'<div><span class="k">{_h(k)}</span> <strong>{_h(v)}</strong></div>' for k, v in pairs)
    ov = ""
    if overlays.get("floodStudies") is not None:
        names = ", ".join(overlays["floodStudies"]) or "none mapped"
        ov += f'<div><span class="k">Flood studies (QLD Govt)</span> <strong>{_h(names)}</strong></div>'
    if overlays.get("bushfireProne") is not None:
        ov += f'<div><span class="k">Bushfire prone (CFA)</span> <strong>{"Yes" if overlays["bushfireProne"] else "No"}</strong></div>'
    sources = ""
    sub_sources = (sub or {}).get("sources") or {}
    if sub_sources:
        items = " · ".join(
            f'{field}: {meta.get("source", "")} ({meta.get("asOf", "")})'
            for field, meta in sub_sources.items() if isinstance(meta, dict) and meta.get("source"))
        if items:
            sources = f'<div class="note">Sources: {_h(items)}</div>'
    if not kv and not ov:
        return ""
    return (f'<h1 class="sec">Suburb snapshot</h1><div class="kv">{kv}{ov}</div>{sources}')


def _section_documents(ctx):
    docs = ctx.get("attachments") or []
    if not docs:
        return ""
    items = "".join(f"<li>{_h(d)}</li>" for d in docs)
    return ('<h1 class="sec">Attached documents</h1><ul class="docs">' + items + "</ul>"
            '<div class="note">All documents are available to open on your shared link.</div>')


def _taxpack_html(p, ctx, brand_html):
    """Accountant pack: ownership, income, deductions, depreciation
    schedule and the per-owner split — no market sections."""
    y1 = p.get("year1") or {}
    ts = p.get("taxSplit") or {}
    years = p.get("years") or []
    money = _money

    inc_rows = "".join(
        f'<tr class="{"bold" if b else ""}"><td>{_h(lbl)}</td><td class="num">{_h(money(v))}</td></tr>'
        for lbl, v, b in [
            ("Rental income (after vacancy)", y1.get("effectiveRent"), True),
            ("Other deductible claims", -(y1.get("otherDeductibleClaims") or 0), False),
            ("Pre-tax cash flow", y1.get("preTaxCashFlow"), True),
        ])
    ded_rows = "".join(
        f'<tr><td>{_h(k)}</td><td class="num">{_h(money(v))}</td></tr>'
        for k, v in [
            ("Loan interest", (y1.get("ipInterest") or 0) + (y1.get("equityLoanInterest") or 0)),
            ("Rental expenses", y1.get("operatingExpenses")),
            ("Capital works (building)", y1.get("capitalWorksDepreciation")),
            ("Plant & equipment", y1.get("plantEquipmentDepreciation")),
            ("Other deductible claims", y1.get("otherDeductibleClaims")),
            ("Total deductions", ((y1.get("ipInterest") or 0) + (y1.get("equityLoanInterest") or 0)
                                  + (y1.get("operatingExpenses") or 0)
                                  + (y1.get("capitalWorksDepreciation") or 0)
                                  + (y1.get("plantEquipmentDepreciation") or 0)
                                  + (y1.get("otherDeductibleClaims") or 0))),
        ])
    dep_rows = "".join(
        f'<tr><td>Y{int(r.get("year") or i + 1)}</td>'
        f'<td class="num">{_h(money(r.get("capitalWorksDepreciation")))}</td>'
        f'<td class="num">{_h(money(r.get("plantEquipmentDepreciation")))}</td>'
        f'<td class="num">{_h(money((r.get("capitalWorksDepreciation") or 0) + (r.get("plantEquipmentDepreciation") or 0)))}</td></tr>'
        for i, r in enumerate(years))
    tax_rows = "".join(
        f'<tr><td>Y{int(r.get("year") or i + 1)}</td>'
        f'<td class="num">{_h(money(r.get("taxablePropertyResult")))}</td>'
        f'<td class="num">{_h(money(r.get("taxRefundOrCost")))}</td>'
        f'<td class="num">{_h(money(r.get("afterTaxCashFlow")))}</td></tr>'
        for i, r in enumerate(years))

    if ts.get("owner2") is not None:
        split = (f'<table><thead><tr><th></th><th class="num">Owner 1 ({_pct(ts.get("rate1"), 0)})</th>'
                 f'<th class="num">Owner 2 ({_pct(ts.get("rate2"), 0)})</th><th class="num">Total</th></tr></thead>'
                 f'<tbody><tr class="bold"><td>Tax credit / (cost)</td>'
                 f'<td class="num">{_h(money(ts.get("owner1")))}</td>'
                 f'<td class="num">{_h(money(ts.get("owner2")))}</td>'
                 f'<td class="num">{_h(money(ts.get("total")))}</td></tr></tbody></table>'
                 f'<div class="note">Ownership {_pct(ts.get("share"), 0)} each. Taxable incomes '
                 f'{_h(money(ts.get("income1")))} / {_h(money(ts.get("income2")))}.</div>')
    else:
        split = (f'<div class="note">Sole ownership — assessed at {_pct(ts.get("rate1"), 0)} marginal.</div>')

    return f"""
      <h1 class="sec first">Income statement — first year</h1>
      <table><tbody>{inc_rows}</tbody></table>
      <h1 class="subsec">Deductions claimed</h1>
      <table><tbody>{ded_rows}</tbody></table>
      <h1 class="subsec">Net tax position by owner</h1>
      {split}
      <h1 class="sec first" style="break-before: page">Depreciation schedule</h1>
      <table><thead><tr><th>Year</th><th class="num">Capital works</th>
      <th class="num">Plant &amp; equipment</th><th class="num">Total</th></tr></thead>
      <tbody>{dep_rows}</tbody></table>
      <h1 class="sec">Taxable result &amp; refund by year</h1>
      <table><thead><tr><th>Year</th><th class="num">Taxable property result</th>
      <th class="num">Tax refund / (cost)</th><th class="num">After-tax cash flow</th></tr></thead>
      <tbody>{tax_rows}</tbody></table>
      <div class="note">Estimates from the stated model inputs — the accountant should verify
      depreciation figures against a compliant quantity surveyor schedule.</div>"""


def _section_properties(payload, accent):
    """One page per added property when the scenario holds several — the
    portfolio sections above aggregate, clients want each property too."""
    props = payload.get("propertySections") or []
    if len(props) < 2:
        return ""
    out = ""
    for i, pr in enumerate(props, 1):
        y1 = pr.get("year1") or {}
        m = pr.get("metrics") or {}
        x = pr.get("exit") or {}
        label = pr.get("label") or f"Property {i}"
        addr = pr.get("address") or ""
        sub = (f' <span style="color:#64748b;font-weight:400;font-size:11px">'
               f'{_h(addr)}</span>' if addr else "")
        cards = "".join(
            f'<div class="card"><div class="label">{_h(lbl)}</div>'
            f'<div class="value">{_h(v)}</div>'
            f'<div class="sub">{_h(s)}</div></div>'
            for lbl, v, s in [
                ("Purchase price", _money(m.get("purchasePrice")), ""),
                ("Gross yield", _pct(m.get("grossYield")), f"net {_pct(m.get('netYield'))}"),
                ("Y1 after-tax cash flow", _money(m.get("year1AfterTaxCashFlow")),
                 f"{_money(m.get('weeklyOutOfPocket'))}/wk out of pocket"),
                ("10-yr equity", _money(m.get("tenYearEquity")), ""),
            ])

        def line(lbl, v, bold=False):
            cls = ' class="bold"' if bold else ""
            return f"<tr{cls}><td>{_h(lbl)}</td><td class='num'>{_h(_money(v))}</td></tr>"

        rows = "".join([
            line("Effective rent", y1.get("effectiveRent"), True),
            line("Less operating expenses", -(y1.get("operatingExpenses") or 0)),
            line("Less land tax", -(y1.get("landTax") or 0)),
            line("Less interest", -((y1.get("ipInterest") or 0)
                                    + (y1.get("equityLoanInterest") or 0))),
            line("Less capital repayments", -((y1.get("ipPrincipalRepayment") or 0)
                                              + (y1.get("equityLoanPrincipalRepayment") or 0))),
            line("Pre-tax cash flow", y1.get("preTaxCashFlow"), True),
            line("Tax refund / (cost)", y1.get("taxRefundOrCost")),
            line("After-tax cash flow", y1.get("afterTaxCashFlow"), True),
        ])
        exit_rows = "".join([
            line(f"Sale in year {int(x.get('saleYear') or 0)} "
                 f"({_h(str(x.get('calendarSaleYear') or ''))})", x.get("salePrice")),
            line("Less CGT", -(x.get("capitalGainsTax") or 0)),
            line("Net sale proceeds", x.get("netSaleProceeds"), True),
            line("Total net position (incl. cash flows)", x.get("totalNetPosition"), True),
        ])
        out += f"""
  <h1 class="sec">Property {i} — {_h(label)}{sub}</h1>
  <div class="cards">{cards}</div>
  <h1 class="subsec">Cash flow — first year</h1>
  <table><tbody>{rows}</tbody></table>
  <h1 class="subsec">Exit</h1>
  <table><tbody>{exit_rows}</tbody></table>"""
    return out


def build_report_html(payload, ctx):
    accent = (payload.get("accent") or "#6366f1").strip()
    if not _h(accent) or not accent.startswith("#"):
        accent = "#6366f1"
    css = _PDF_CSS.replace("ACCENT", accent)
    brand = (ctx or {}).get("branding") or {}
    logo_uri = _logo_data_uri(brand.get("logoUrl"))
    logo_html = f'<img src="{logo_uri}" alt="logo">' if logo_uri else ""
    name = brand.get("businessName") or (payload.get("baName") or "Property Analyser")
    tagline = brand.get("tagline") or ""
    client = payload.get("client") or ""
    date = datetime.utcnow().strftime("%d %b %Y")

    head = f"""
  <div class="head">
    <div class="brandrow">{logo_html}<div>
      <div class="brand">{_h(name)}</div>
      <div class="tagline">{_h(tagline)}</div>
    </div></div>
    <div class="client">Prepared for {_h(client)}<br>{_h(date)}</div>
  </div>
  <h1>{_h(payload.get("title") or "Property report")}</h1>
"""
    # Running header/footer on every page (WeasyPrint margin boxes).
    small_logo = f'<img src="{logo_uri}" alt="">' if logo_uri else ""
    runners = (f'<div class="pagehead">{small_logo}<span>{_h(name)}</span>'
               f'<span style="margin-left:auto;font-weight:400;color:#64748b">'
               f'{_h(client and "Prepared for " + client)}</span></div>'
               f'<div class="pagefoot">{_h(name)} · {_h(tagline or "")} '
               f'Estimates only — not financial or tax advice.</div>')
    if payload.get("taxPack"):
        html = (f'<!doctype html>\n<html><head><meta charset="utf-8">'
                f'<title>{_h("Tax pack — " + str(payload.get("title") or ""))}</title>'
                f'<style>{css}</style></head><body>{runners}{head}'
                + _taxpack_html(payload, ctx, logo_html)
                + '<div class="foot">Estimates from the stated model inputs — not financial or tax advice.</div>'
                + '</body></html>')
        return html
    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{_h(payload.get("title") or "Property report")}</title>
<style>{css}</style></head><body>
  {runners}
  {head}
  {_section_cashflow(payload, accent)}
  {_section_who_pays(payload)}
  {_section_projections(payload)}
  {_section_exit(payload)}
  {_section_properties(payload, accent)}
  {_section_deal_check(payload)}
  {_section_checks(payload)}
  {_section_replacement(payload)}
  {_section_rental_evidence(ctx or {})}
  {_section_sales_evidence(ctx or {})}
  {_section_suburb(ctx or {})}
  {_section_documents(ctx or {})}
  <div class="foot">Illustrative model based on stated assumptions. Excludes some costs; figures
  change with the inputs. Estimates only, not financial or tax advice.</div>
</body></html>"""
    return html


def render_report(payload, ctx):
    """Build the report and return a Flask PDF Response (HTML fallback)."""
    html = build_report_html(payload, ctx or {})
    safe = "".join(ch for ch in (payload.get("title") or "property-report")
                   if ch.isalnum() or ch in " -").strip() or "property-report"
    try:
        from weasyprint import HTML
        pdf = HTML(string=html).write_pdf()
        return Response(pdf, mimetype="application/pdf", headers={
            "Content-Disposition": f'inline; filename="{safe}.pdf"'})
    except ImportError:
        return Response(html, mimetype="text/html; charset=utf-8")


_XL_MONEY = "$#,##0;[Red]($#,##0)"
_XL_PCT = "0.00%"


def _xl_brand_block(ws, payload, ctx, logo_bytes):
    """Logo + business name + tagline + client/date across the top rows.

    Returns the next free row (1-based) after the header block."""
    from openpyxl.drawing.image import Image as XLImage
    from openpyxl.styles import Font

    brand = (ctx or {}).get("branding") or {}
    accent = (payload.get("accent") or "#6366f1").lstrip("#")
    if len(accent) != 6 or not all(c in "0123456789abcdefABCDEF" for c in accent):
        accent = "6366F1"
    name = brand.get("businessName") or (payload.get("baName") or "Property Analyser")
    client = payload.get("client") or ""

    if logo_bytes:
        try:
            from io import BytesIO

            from PIL import Image as PILImage
            img = PILImage.open(BytesIO(logo_bytes))
            w, h = img.size
            img = img.resize((max(1, round(w * 72 / h)), 72))
            buf = BytesIO()
            img.save(buf, format="PNG")
            xl_img = XLImage(buf)
            ws.add_image(xl_img, "A1")
        except Exception:
            pass  # a missing picture must never block the numbers

    c = ws.cell(row=1, column=3, value=name)
    c.font = Font(bold=True, size=16, color="FF" + accent.upper())
    if brand.get("tagline"):
        ws.cell(row=2, column=3, value=brand["tagline"]).font = Font(
            size=10, color="FF64748B")
    who = " · ".join(x for x in (
        f"Prepared for {client}" if client else "",
        datetime.utcnow().strftime("%d %b %Y")) if x)
    if who:
        ws.cell(row=3, column=3, value=who).font = Font(size=10, color="FF64748B")
    ws.row_dimensions[1].height = 54
    t = ws.cell(row=5, column=1, value=payload.get("title") or "Property report")
    t.font = Font(bold=True, size=13)
    return 7


def _xl_table(ws, top, headers, rows, money_cols=(), pct_cols=(), widths=()):
    """Accent-headed table starting at `top`; returns the row after it."""
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    accent = ws.cell(row=1, column=3).font.color.rgb  # brand colour from the name
    fill = PatternFill("solid", fgColor=accent)
    for j, htxt in enumerate(headers, start=1):
        c = ws.cell(row=top, column=j, value=htxt)
        c.font = Font(bold=True, color="FFFFFFFF")
        c.fill = fill
        c.alignment = Alignment(horizontal="right" if j > 1 else "left")
    for i, row in enumerate(rows, start=top + 1):
        for j, v in enumerate(row, start=1):
            c = ws.cell(row=i, column=j, value=v)
            if j > 1:
                c.alignment = Alignment(horizontal="right")
                if j in money_cols:
                    c.number_format = _XL_MONEY
                elif j in pct_cols:
                    c.number_format = _XL_PCT
    for j, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(j)].width = w
    return top + 1 + len(rows)


def render_excel(payload, ctx):
    """Branded XLSX workbook for one scenario — same payload as the PDF."""
    from io import BytesIO

    from openpyxl import Workbook
    from openpyxl.styles import Font

    brand = (ctx or {}).get("branding") or {}
    got = _logo_bytes(brand.get("logoUrl"))
    logo_bytes = got[0] if got else None
    y1 = payload.get("year1") or {}
    years = payload.get("years") or []
    m = payload.get("metrics") or {}
    subj = payload.get("subject") or {}
    ts = payload.get("taxSplit") or {}
    wb = Workbook()

    # --- Overview ---------------------------------------------------------
    ws = wb.active
    ws.title = "Overview"
    row = _xl_brand_block(ws, payload, ctx, logo_bytes)
    row = _xl_table(
        ws, row,
        ["Metric", "Value"],
        [
            ("Address", subj.get("address") or "—"),
            ("Purchase price", subj.get("price")),
            ("Weekly rent", subj.get("weeklyRent")),
            ("Gross yield", m.get("grossYield")),
            ("Net yield", m.get("netYield")),
            ("IRR approximation", m.get("irrApproximation")),
            ("10-year equity", m.get("tenYearEquity")),
            ("Net sale proceeds", m.get("netSaleProceeds")),
        ],
        money_cols=(2,), pct_cols=(4, 5, 6),
        widths=(26, 16))
    if years:
        row += 1
        ws.cell(row=row, column=1, value="Assumptions").font = Font(bold=True)
        row += 1
        row = _xl_table(
            ws, row,
            ["Line item", "Year 1"],
            [
                ("Gross rent", y1.get("grossRent")),
                ("Effective rent (after vacancy)", y1.get("effectiveRent")),
                ("Operating expenses", y1.get("operatingExpenses")),
                ("Pre-tax cash flow", y1.get("preTaxCashFlow")),
                ("Tax refund / (cost)", y1.get("taxRefundOrCost")),
                ("After-tax cash flow", y1.get("afterTaxCashFlow")),
            ],
            money_cols=(2,), widths=(26, 16))

    # --- Year by year -----------------------------------------------------
    ws = wb.create_sheet("Year by year")
    row = _xl_brand_block(ws, payload, ctx, logo_bytes)
    _xl_table(
        ws, row,
        ["Year", "Calendar", "Effective rent", "Operating expenses",
         "Taxable result", "Pre-tax cash flow", "Tax refund / (cost)",
         "After-tax cash flow", "Cumulative"],
        [(r.get("year"), r.get("calendarYear"), r.get("effectiveRent"),
          r.get("operatingExpenses"), r.get("taxablePropertyResult"),
          r.get("preTaxCashFlow"), r.get("taxRefundOrCost"),
          r.get("afterTaxCashFlow"), r.get("cumulativeAfterTaxCashFlow"))
         for r in years],
        money_cols=tuple(range(3, 10)), widths=(7, 10, 14, 15, 14, 14, 14, 14, 14))

    # --- Tax pack ---------------------------------------------------------
    ws = wb.create_sheet("Tax pack")
    row = _xl_brand_block(ws, payload, ctx, logo_bytes)
    deductions = [
        ("Loan interest", (y1.get("ipInterest") or 0) + (y1.get("equityLoanInterest") or 0)),
        ("Rental expenses", y1.get("operatingExpenses")),
        ("Capital works (building)", y1.get("capitalWorksDepreciation")),
        ("Plant & equipment", y1.get("plantEquipmentDepreciation")),
        ("Other deductible claims", y1.get("otherDeductibleClaims")),
    ]
    row = _xl_table(
        ws, row,
        ["Deductions claimed", "Year 1"],
        deductions + [("Total deductions", sum(v or 0 for _, v in deductions))],
        money_cols=(2,), widths=(26, 16))
    row += 1
    row = _xl_table(
        ws, row,
        ["Year", "Capital works", "Plant & equipment", "Total depreciation"],
        [(r.get("year"), r.get("capitalWorksDepreciation"),
          r.get("plantEquipmentDepreciation"),
          (r.get("capitalWorksDepreciation") or 0)
          + (r.get("plantEquipmentDepreciation") or 0)) for r in years],
        money_cols=(2, 3, 4), widths=(8, 16, 16, 18))
    if ts.get("owner2") is not None:
        row += 1
        row = _xl_table(
            ws, row,
            ["Owner split", "Amount"],
            [("Owner 1 tax credit / (cost)", ts.get("owner1")),
             ("Owner 2 tax credit / (cost)", ts.get("owner2")),
             ("Total", ts.get("total"))],
            money_cols=(2,), widths=(26, 16))
    ws.cell(row=row + 1, column=1,
            value="Estimates from the stated model inputs — not financial or tax advice."
            ).font = Font(size=9, color="FF94A3B8")

    safe = "".join(ch for ch in (payload.get("title") or "property-report")
                   if ch.isalnum() or ch in " -").strip() or "property-report"
    buf = BytesIO()
    wb.save(buf)
    return Response(
        buf.getvalue(),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{safe}.xlsx"'})


def error(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code
