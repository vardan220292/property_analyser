# Copyright (c) 2026 RV
"""
Free sold-price valuation feed.

The only genuinely free sold-property data in Australia is the Victorian
Valuer-General's Property Sales Report (CC BY 4.0): quarterly suburb-level
median prices for houses and units. QLD (QVAS) and NSW (VG sales) are paid
products — this feed is VIC-only by necessity.

Files: put the VPSR workbooks in data/sales/ (or let ingest try to download
them — land.vic.gov.au sometimes blocks automated clients, in which case
download them by hand in a browser):
    data/sales/houses-by-suburb-2015-2025.xlsx
    data/sales/units-by-suburb-<quarter>.xls

Run: /Users/vardangupta/deployment/venv/bin/python3 sales.py

The endpoint serves suburb median series + a clearly-labelled median-guide
band (±10% of the latest suburb median) — a guide, not a valuation.
"""

import glob
import os
import re

from flask import Blueprint, jsonify, request

import db

bp = Blueprint("sales", __name__, url_prefix="/api")

SALES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "sales")
VIC_HOUSES_URL = ("https://www.land.vic.gov.au/__data/assets/excel_doc/0033/775617/"
                  "houses-by-suburb-2015-2025.xlsx")
UA = "Mozilla/5.0 (compatible; PropertyAnalyser/1.0)"

# Suburb names look like this; anything else in the label column is noise.
_SUBURB_RE = re.compile(r"^[A-Za-z][A-Za-z'' -]{1,58}\.?(?:\d{4})?$")
_NOT_SUBURB_RE = re.compile(
    r"^(total|melbourne|victoria|country|regional|metropolitan|average|rest of|"
    r"ballarat|bendigo|geelong)\b", re.I)
_PERIOD_RE = re.compile(r"^(20\d\d)(?:[-/ .](q?[1-4]|Q\d|0?[1-9]|jan|feb|mar|apr|may|jun|"
                        r"jul|aug|sep|oct|nov|dec)[a-z]*)?$", re.I)


def _normalise_suburb(name):
    s = re.sub(r"\s+", " ", str(name)).strip().upper()
    return s[:-1] if s.endswith(".") else s


def _normalise_period(cell, fallback_year=None):
    """'2024', 'Mar-24', '2024 Q1', 2024.0 → '2024' or '2024Q1' style key."""
    if cell is None:
        return None
    if isinstance(cell, (int, float)) and 1990 < float(cell) < 2100:
        return str(int(cell))
    m = _PERIOD_RE.match(str(cell).strip())
    if not m:
        return None
    year = m.group(1)
    q = m.group(2)
    if not q:
        return year
    q = re.sub(r"^q", "", q, flags=re.I)
    months = {"jan": "Q1", "feb": "Q1", "mar": "Q1", "apr": "Q2", "may": "Q2",
              "jun": "Q2", "jul": "Q3", "aug": "Q3", "sep": "Q3", "oct": "Q4",
              "nov": "Q4", "dec": "Q4"}
    if q.isdigit():
        return f"{year}Q{int(q)}"
    return f"{year}{months.get(q.lower(), '')}"


def _parse_workbook(path, dwelling_type, source):
    """Tolerant VPSR parser. VIC layouts put suburb labels in one column and
    year/quarter medians across the rest; we sniff each sheet for that shape
    rather than hardcoding offsets, since the report format has shifted."""
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True, read_only=True)
    rows_out = []
    for ws in wb.worksheets:
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        if len(rows) < 3:
            continue
        # Find the header row: a row where >=3 cells parse as periods.
        header_i, period_cols = None, {}
        for i, row in enumerate(rows[:15]):
            cols = {}
            for j, cell in enumerate(row):
                p = _normalise_period(cell)
                if p:
                    cols[j] = p
            if len(cols) >= 3:
                header_i, period_cols = i, cols
                break
        if header_i is None:
            continue
        # Suburb label column: the column with the most label-like cells
        # below the header.
        best_col, best_hits = None, 0
        for j in range(next(iter(period_cols), 0)):
            hits = 0
            for row in rows[header_i + 1: header_i + 200]:
                v = row[j] if j < len(row) else None
                if v and _SUBURB_RE.match(str(v).strip()):
                    hits += 1
            if hits > best_hits:
                best_col, best_hits = j, hits
        if best_col is None or best_hits < 3:
            continue
        for row in rows[header_i + 1:]:
            label = row[best_col] if best_col < len(row) else None
            if not label or not _SUBURB_RE.match(str(label).strip()) \
                    or _NOT_SUBURB_RE.match(str(label).strip()):
                continue
            suburb = _normalise_suburb(label)
            for j, period in period_cols.items():
                if j >= len(row):
                    continue
                v = row[j]
                if isinstance(v, (int, float)) and 10000 <= v <= 30000000:
                    rows_out.append({
                        "state": "VIC", "suburb": suburb,
                        "dwelling_type": dwelling_type, "period": period,
                        "median": round(float(v)), "source": source,
                    })
    return rows_out


def _download_vic_houses(dest):
    import requests
    r = requests.get(VIC_HOUSES_URL, timeout=40, headers={"User-Agent": UA})
    if r.status_code != 200 or not r.content[:2] in (b"PK", b"\xd0\xcf"):
        return False
    os.makedirs(SALES_DIR, exist_ok=True)
    with open(dest, "wb") as f:
        f.write(r.content)
    return True


def _dwelling_type_for(path):
    name = os.path.basename(path).lower()
    return "units" if re.search(r"unit|flat|apartment|strata", name) else "houses"


def ingest(paths=None):
    """Parse every workbook in data/sales/ (or the given paths) into the
    suburb_sales table. Returns (files_ingested, rows_upserted)."""
    paths = paths or sorted(
        p for p in glob.glob(os.path.join(SALES_DIR, "*.xls*"))
        if not os.path.basename(p).startswith("~"))
    if not paths:
        dest = os.path.join(SALES_DIR, "houses-by-suburb-2015-2025.xlsx")
        if _download_vic_houses(dest):
            paths = [dest]
    files, rows = 0, 0
    for path in paths:
        try:
            parsed = _parse_workbook(path, _dwelling_type_for(path),
                                     "VIC Valuer-General Property Sales Report")
        except Exception as e:
            print(f"sales: could not parse {os.path.basename(path)}: {e}")
            continue
        if not parsed:
            print(f"sales: no suburb/period table recognised in "
                  f"{os.path.basename(path)} — send me the sheet layout and "
                  f"I'll adjust the parser")
            continue
        for r in parsed:
            db.db().execute(
                "INSERT INTO suburb_sales (state, suburb, dwelling_type, period, "
                "median, sales_count, source) VALUES (?, ?, ?, ?, ?, NULL, ?) "
                "ON CONFLICT(state, suburb, dwelling_type, period) "
                "DO UPDATE SET median = excluded.median, source = excluded.source",
                (r["state"], r["suburb"], r["dwelling_type"], r["period"],
                 r["median"], r["source"]))
        files += 1
        rows += len(parsed)
        print(f"sales: {os.path.basename(path)} → {len(parsed)} suburb-period rows")
    if rows:
        db.db().commit()  # CLI ingest runs outside Flask — SQLite needs this
    return files, rows


@bp.get("/valuation")
def valuation():
    """Suburb median guide: series + latest median ±10% band."""
    suburb = _normalise_suburb(request.args.get("suburb") or "")
    state = (request.args.get("state") or "").strip().upper()[:3]
    if not suburb or len(suburb) < 3:
        return jsonify({"ok": False, "error": "suburb required"}), 400
    if state != "VIC":
        return jsonify({"ok": True, "data": {"available": False,
                        "reason": "free sold data is VIC-only (other states are paid products)"}})
    rows = db.db().fetch_all(
        "SELECT dwelling_type, period, median, source FROM suburb_sales "
        "WHERE state = ? AND suburb = ? ORDER BY dwelling_type, period",
        (state, suburb))
    if not rows:
        return jsonify({"ok": True, "data": {"available": False,
                        "reason": "no suburb match ingested yet — check spelling "
                                  "or run sales.py after adding the VPSR files"}})
    series, latest, source = {}, None, ""
    for r in rows:
        series.setdefault(r["dwelling_type"], []).append(
            {"period": r["period"], "median": r["median"]})
        if r["median"] is not None:
            cur = (r["dwelling_type"], r["period"], r["median"])
            if latest is None or cur[1] > latest[1]:
                latest = cur
            source = r["source"] or source
    data = {"available": True, "state": state, "suburb": suburb.title(),
            "series": series, "source": source}
    if latest:
        data["latest"] = {"dwellingType": latest[0], "period": latest[1],
                          "median": latest[2]}
        data["guide"] = {"low": round(latest[2] * 0.9), "high": round(latest[2] * 1.1),
                         "note": "Suburb-median guide (±10%) — an indication "
                                 "from sold-data medians, not a valuation"}
    return jsonify({"ok": True, "data": data})


if __name__ == "__main__":
    files, rows = ingest()
    print(f"sales: ingested {files} file(s), {rows} rows")
