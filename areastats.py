# Copyright (c) 2026 RV
"""
Multi-vintage area intelligence — SA2/postcode datasets newer than the
2021 Census (see census.py for that baseline):

  * ABS Regional Population 2025 + age/sex 2024 (ArcGIS FeatureServer,
    sa2) — ERP total, growth, net overseas migration, median age, age bands
  * DEWR Small Area Labour Markets (quarterly xlsx, sa2) — smoothed
    unemployment rate; release lags the reference quarter
  * ABS Building Approvals by SA2 (annual FeatureServer, sa2) — dwelling
    approvals per financial year
  * ATO taxation statistics 2023-24 (ArcGIS FeatureServer, postcode) —
    income and landlord measures keyed on postcode (exact match, not derived)

Snapshots under data/markets/sa2-<key>.json are the primary read path:
runtime never depends on ABS/DEWR reachability. refresh(key) is
staleness-gated (cadence_days) and best-effort — daily_refresh calls it;
on failure the stale snapshot stays. Bake with:
    python -c "import areastats; areastats.refresh_all(force=True)"
"""

import io
import json
import os
import re
import threading
import time
from datetime import datetime, timezone

import requests

SNAP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "markets")
ABS_ARCGIS = ("https://services-ap1.arcgis.com/ypkPEy1AmwPKGNNv/"
              "arcgis/rest/services")
ERP_SVC = ABS_ARCGIS + "/SA2_Regional_Population_2025/FeatureServer/3"
ERP_AGESVC = ABS_ARCGIS + "/ERP_Age_Sex_2024_SA2_2021/FeatureServer/0"
BAPS_SVC = ABS_ARCGIS + "/ABS_BAPS_SA2_1415_2223/FeatureServer/0"
ATO_SVC = ABS_ARCGIS + "/Taxation_Statistics_23_24/FeatureServer/0"
SALM_URL = ("https://www.dewr.gov.au/download/17068/"
            "salm-smoothed-sa2-datafiles-asgs-2021-june-quarter-2026/"
            "43875/salm-smoothed-sa2-datafiles-asgs-2021-june-quarter-2026"
            "/xlsx")
SALM_PAGE = "https://www.dewr.gov.au/employment-research/small-area-labour-markets"
# The download URL embeds the quarter, so discover the current one instead of
# pinning it: SALM landing page -> stable resource page -> quartered download
# links (SALM_URL stays as the fallback).
_SALM_RESOURCE_RE = re.compile(
    r"/employment-research/resources/salm-smoothed-sa2-datafiles-[a-z0-9-]+")
_SALM_LINK_RE = re.compile(
    r"/download/(\d+)/(salm-smoothed-sa2-datafiles-asgs-2021-[a-z0-9-]+?)/(\d+)/\2/xlsx")
_SALM_MONTHS = {"march": 3, "june": 6, "september": 9, "december": 12}
UA = {"User-Agent": "Mozilla/5.0 (property-analyser; research data refresh)"}

# Stable field keys with their per-field vintage + label + chip formatting
# (unit/dp mirror census.METRIC_DEFS' vocabulary). Labels mirror the ABS
# column names loosely — the UI shows label + vintage next to every value.
FIELD_META = {
    # ABS Regional Population / age-sex
    "erp_total":         {"label": "Population (ERP)", "vintage": "2025", "unit": "", "dp": 0,
                          "source": "ABS Regional Population"},
    "erp_growth_1y_pct": {"label": "Population growth (1 yr)", "vintage": "2024-25", "unit": "%", "dp": 1,
                          "source": "ABS Regional Population"},
    "erp_growth_5y_pct": {"label": "Population growth (5 yr)", "vintage": "2020-25", "unit": "%", "dp": 1,
                          "source": "ABS Regional Population"},
    "nom_1y":            {"label": "Net overseas migration (yr)", "vintage": "2024-25", "unit": "", "dp": 0,
                          "source": "ABS Regional Population"},
    "median_age":        {"label": "Median age", "vintage": "2024", "unit": "yrs", "dp": 0,
                          "source": "ABS Regional Population (age & sex)"},
    "age_0_14_pc":       {"label": "Aged 0-14", "vintage": "2024", "unit": "%", "dp": 1,
                          "source": "ABS Regional Population (age & sex)"},
    "age_15_64_pc":      {"label": "Aged 15-64", "vintage": "2024", "unit": "%", "dp": 1,
                          "source": "ABS Regional Population (age & sex)"},
    "age_65p_pc":        {"label": "Aged 65+", "vintage": "2024", "unit": "%", "dp": 1,
                          "source": "ABS Regional Population (age & sex)"},
    # DEWR SALM
    "salm_unemp_rate":   {"label": "Unemployment (SALM, smoothed)", "vintage": "", "unit": "%", "dp": 1,
                          "source": "DEWR Small Area Labour Markets"},
    # ABS Building Approvals
    "approvals_annual":      {"label": "Dwelling approvals (yr)", "vintage": "2022-23", "unit": "", "dp": 0,
                              "source": "ABS Building Approvals"},
    "approvals_annual_prev": {"label": "Dwelling approvals (prior yr)", "vintage": "2021-22", "unit": "", "dp": 0,
                              "source": "ABS Building Approvals"},
    # ATO taxation statistics — postcode-keyed
    "ato_median_income":  {"label": "Median taxable income", "vintage": "2023-24", "unit": "$", "dp": 0,
                           "source": "ATO Taxation Statistics (postcode)"},
    "ato_avg_income":     {"label": "Average taxable income", "vintage": "2023-24", "unit": "$", "dp": 0,
                           "source": "ATO Taxation Statistics (postcode)"},
    "ato_taxpayers":      {"label": "Taxpayers", "vintage": "2023-24", "unit": "", "dp": 0,
                           "source": "ATO Taxation Statistics (postcode)"},
    "ato_landlord_pc":    {"label": "Landlords (% of taxpayers)", "vintage": "2023-24", "unit": "%", "dp": 1,
                           "source": "ATO Taxation Statistics (postcode)"},
    "ato_median_net_rent": {"label": "Median net rent (landlords, typically negative)",
                            "vintage": "2023-24", "unit": "$", "dp": 0,
                            "source": "ATO Taxation Statistics (postcode)"},
}

# key -> {label, geo, cadence_days, fetch}
DATASETS = {
    "erp":       {"label": "ABS Regional Population", "geo": "sa2",
                  "cadence_days": 200, "fetch": "_fetch_erp"},
    "salm":      {"label": "DEWR SALM", "geo": "sa2",
                  "cadence_days": 100, "fetch": "_fetch_salm"},
    "approvals": {"label": "ABS Building Approvals", "geo": "sa2",
                  "cadence_days": 120, "fetch": "_fetch_approvals"},
    "ato":       {"label": "ATO Taxation Statistics", "geo": "postcode",
                  "cadence_days": 300, "fetch": "_fetch_ato"},
}

_cache = {key: {"data": None} for key in DATASETS}
_lock = threading.Lock()


def snapshot_path(key):
    return os.path.join(SNAP_DIR, "sa2-%s.json" % key)


def _num(v):
    try:
        f = float(v)
        return f
    except (TypeError, ValueError):
        return None


def _arcgis_rows(url, fields_map, code_field):
    """Paged FeatureServer attribute fetch -> {str(code): {field: value}}.
    fields_map maps source column -> snapshot field name (pass-through if
    the values are equal)."""
    if not isinstance(fields_map, dict):
        fields_map = {f: f for f in fields_map}
    rows, offset = {}, 0
    fields = ",".join([code_field] + list(fields_map))
    while True:
        params = {
            "f": "json", "where": "1=1", "outFields": fields,
            "resultRecordCount": 1000, "resultOffset": offset,
        }
        r = requests.get(url + "/query", params=params, headers=UA, timeout=60)
        r.raise_for_status()
        data = r.json()
        feats = data.get("features") or []
        for feat in feats:
            a = feat.get("attributes") or {}
            code = str(a.get(code_field) or "").strip()
            if not code:
                continue
            rows[code] = {dst: _num(a.get(src)) for src, dst in fields_map.items()}
        offset += len(feats)
        if not feats or not (data.get("exceededTransferLimit")):
            break
    return rows


def _fetch_erp(vintage_box):
    pop = _arcgis_rows(ERP_SVC,
                       {"erp_2020": "erp_2020", "erp_2024": "erp_2024",
                        "erp_2025": "erp_2025",
                        "erp_change_per_cent_2024_25": "erp_growth_1y_pct",
                        "net_overseas_migration_2024_25": "nom_1y"},
                       "sa2_code_2021")
    age = _arcgis_rows(ERP_AGESVC,
                       {"persons": "erp_total",
                        "median_age_persons": "median_age",
                        "age_0_14_per_cent": "age_0_14_pc",
                        "age_15_64_per_cent": "age_15_64_pc",
                        "age_65_plus_per_cent": "age_65p_pc"},
                       "sa2_code_2021")
    rows = {}
    for code, p in pop.items():
        g5 = None
        if p.get("erp_2020") and p.get("erp_2025"):
            g5 = round((p["erp_2025"] / p["erp_2020"] - 1) * 100, 1)
        a = age.get(code) or {}
        rows[code] = {
            "erp_total": p.get("erp_2025") or a.get("erp_total"),
            "erp_growth_1y_pct": p.get("erp_growth_1y_pct"),
            "erp_growth_5y_pct": g5,
            "nom_1y": p.get("nom_1y"),
            "median_age": a.get("median_age"),
            "age_0_14_pc": a.get("age_0_14_pc"),
            "age_15_64_pc": a.get("age_15_64_pc"),
            "age_65p_pc": a.get("age_65p_pc"),
        }
    for code, a in age.items():
        if code not in rows:
            rows[code] = {
                "erp_total": a.get("persons"),
                "erp_growth_1y_pct": None, "erp_growth_5y_pct": None,
                "nom_1y": None, "median_age": a.get("median_age"),
                "age_0_14_pc": a.get("age_0_14_pc"),
                "age_15_64_pc": a.get("age_15_64_pc"),
                "age_65p_pc": a.get("age_65p_pc"),
            }
    # Per-field vintages: the age/sex layer runs a year behind the ERP release.
    vintage_box["erp_total"] = "2025"
    vintage_box["erp_growth_1y_pct"] = "2024-25"
    vintage_box["erp_growth_5y_pct"] = "2020-25"
    vintage_box["nom_1y"] = "2024-25"
    vintage_box["median_age"] = "2024"
    vintage_box["age_0_14_pc"] = "2024"
    vintage_box["age_15_64_pc"] = "2024"
    vintage_box["age_65p_pc"] = "2024"
    return rows


def _salm_latest_url():
    """Latest SA2 xlsx via the DEWR SALM pages: the landing page links a
    stable resource page, which carries the quartered download URLs. None on
    any failure — callers fall back to the pinned SALM_URL."""
    try:
        r = requests.get(SALM_PAGE, headers=UA, timeout=30)
        r.raise_for_status()
        m = _SALM_RESOURCE_RE.search(r.text.replace("\\/", "/"))
        if not m:
            return None
        r = requests.get("https://www.dewr.gov.au" + m.group(0),
                         headers=UA, timeout=30)
        r.raise_for_status()
        text = r.text.replace("\\/", "/")
        best = None  # ((year, quarter), nid, slug, rid)
        for nid, slug, rid in _SALM_LINK_RE.findall(text):
            m = re.search(r"-([a-z]+)-quarter-(\d{4})$", slug)
            if not m or m.group(1) not in _SALM_MONTHS:
                continue
            key = (int(m.group(2)), _SALM_MONTHS[m.group(1)])
            if best is None or key > best[0]:
                best = (key, nid, slug, rid)
        if best:
            _, nid, slug, rid = best
            return "https://www.dewr.gov.au/download/%s/%s/%s/%s/xlsx" % (
                nid, slug, rid, slug)
    except Exception:
        return None
    return None


def _fetch_salm(vintage_box):
    from openpyxl import load_workbook
    url = _salm_latest_url() or SALM_URL
    r = requests.get(url, headers=UA, timeout=120)
    r.raise_for_status()
    wb = load_workbook(io.BytesIO(r.content), data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]  # "Smoothed SA2 unemployment rate"
    header_row, last_col, qdate = None, None, None
    rows_out = {}
    for row in ws.iter_rows(values_only=True):
        cells = list(row)
        if header_row is None:
            if cells and cells[0] and "Statistical Area Level" in str(cells[0]):
                header_row = True
                for j, c in enumerate(cells[2:], start=2):
                    if c is not None:
                        last_col, qdate = j, c
                continue
            continue
        code = str(cells[1]).strip() if len(cells) > 1 and cells[1] else ""
        if not code or last_col is None or last_col >= len(cells):
            continue
        rows_out[code] = {"salm_unemp_rate": _num(cells[last_col])}
    if qdate is not None:
        try:
            d = qdate
            q = {1: "Mar", 2: "Jun", 3: "Sep", 4: "Dec"}[((d.month - 1) // 3) + 1]
            vintage_box["salm_unemp_rate"] = "%s Q %d" % (q, d.year)
        except Exception:
            vintage_box["salm_unemp_rate"] = "latest quarter"
    return rows_out


def _fetch_approvals(vintage_box):
    rows = _arcgis_rows(BAPS_SVC, ["totdwl_dwl_2122", "totdwl_dwl_2223"],
                        "sa2_code_2021")
    for row in rows.values():
        row["approvals_annual"] = row.pop("totdwl_dwl_2223", None)
        row["approvals_annual_prev"] = row.pop("totdwl_dwl_2122", None)
    vintage_box["approvals_annual"] = "2022-23"
    vintage_box["approvals_annual_prev"] = "2021-22"
    return rows


def _fetch_ato(vintage_box):
    rows = _arcgis_rows(ATO_SVC,
                        ["median_taxable_income_or_loss",
                         "average_taxable_income_or_loss",
                         "count_taxable_income_or_loss",
                         "proportion_with_net_rent", "median_net_rent"],
                        "postcode")
    out = {}
    max_ll = 0.0
    for code, a in rows.items():
        max_ll = max(max_ll, a.get("proportion_with_net_rent") or 0)
    landlord_is_fraction = max_ll <= 1.0
    for code, a in rows.items():
        ll = a.get("proportion_with_net_rent")
        out[code] = {
            "ato_median_income": a.get("median_taxable_income_or_loss"),
            "ato_avg_income": a.get("average_taxable_income_or_loss"),
            "ato_taxpayers": a.get("count_taxable_income_or_loss"),
            "ato_landlord_pc": round(ll * 100, 1) if (ll is not None and landlord_is_fraction) else (round(ll, 1) if ll is not None else None),
            "ato_median_net_rent": a.get("median_net_rent"),
        }
    return out


def _vintage_meta(vintage_box):
    meta = {}
    for field, base in FIELD_META.items():
        m = dict(base)
        m["vintage"] = vintage_box.get(field) or base["vintage"] or "latest"
        meta[field] = m
    return meta


def load(key, field=None):
    """Snapshot rows for one dataset — memory cache first, never network."""
    c = _cache[key]
    if c["data"] is not None:
        return c["data"]
    with _lock:
        if c["data"] is None:
            try:
                with open(snapshot_path(key), "r", encoding="utf-8") as fh:
                    c["data"] = json.load(fh)
            except (OSError, ValueError):
                c["data"] = None
    return c["data"]


def refresh(key, force=False):
    """Staleness-gated fetch + snapshot write. Best-effort; keeps stale data."""
    ds = DATASETS[key]
    snap = load(key)
    now = time.time()
    if not force and snap:
        try:
            age = now - datetime.fromisoformat(snap["asOf"]).timestamp()
            if age < ds["cadence_days"] * 86400:
                return {"key": key, "status": "fresh", "asOf": snap["asOf"]}
        except (KeyError, ValueError):
            pass
    box = {}
    try:
        rows = getattr(__import__(__name__), ds["fetch"])(box)
        if not rows:
            raise RuntimeError("no rows returned")
        vintage = (snap or {}).get("vintage") or {}
        vintage.update(box)
        payload = {
            "asOf": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "release": ds["label"], "geo": ds["geo"],
            "vintage": vintage, "rows": rows,
        }
        with _lock:
            with open(snapshot_path(key), "w", encoding="utf-8") as fh:
                json.dump(payload, fh, separators=(",", ":"))
            _cache[key]["data"] = payload
        return {"key": key, "status": "refreshed", "rows": len(rows)}
    except Exception as exc:  # keep the stale snapshot; report honestly
        return {"key": key, "status": "error", "error": str(exc)[:200]}


def refresh_all(force=False):
    return [refresh(key, force=force) for key in DATASETS]


def vintage_meta():
    """field -> {label, vintage, source} across all loaded datasets."""
    box = {}
    for key in DATASETS:
        snap = load(key) or {}
        box.update(snap.get("vintage") or {})
    return _vintage_meta(box)


def sa2_values(sa2_code):
    """Merged sa2-keyed values for one SA2 code across loaded datasets."""
    out = {}
    for key, ds in DATASETS.items():
        if ds["geo"] != "sa2":
            continue
        snap = load(key)
        if not snap:
            continue
        row = (snap.get("rows") or {}).get(str(sa2_code)) or {}
        out.update(row)
    return out


def postcode_values(postcode):
    snap = load("ato")
    if not snap:
        return {}
    pc = str(postcode or "").strip()
    return (snap.get("rows") or {}).get(pc, {}) if pc else {}


def chip_def(field):
    """Chip formatting for one area-stats field (label/unit/dp), for
    census.deal_verdicts and the Deal Check UI."""
    m = FIELD_META.get(field)
    if not m:
        return None
    return {"label": m["label"], "unit": m["unit"], "dp": m["dp"]}


def benchmark_rows():
    """All sa2-keyed dataset rows as attribute dicts (sa2_code_2021 attached
    so per-state buckets work) — the shape census.build_benchmarks consumes."""
    out = []
    for key, ds in DATASETS.items():
        if ds["geo"] != "sa2":
            continue
        snap = load(key)
        if not snap:
            continue
        for code, row in (snap.get("rows") or {}).items():
            r = dict(row)
            r["sa2_code_2021"] = code
            out.append(r)
    return out


def dataset_labels():
    """Loaded-dataset vintage summary for source stamps, e.g.
    "DEWR SALM Jun Q 2026"."""
    out = []
    for key, ds in DATASETS.items():
        snap = load(key)
        if not snap:
            continue
        vintage = snap.get("vintage") or {}
        tail = ""
        if key == "salm":
            tail = " " + str(vintage.get("salm_unemp_rate") or "")
        elif key == "erp":
            tail = " 2024-25"
        elif key == "ato":
            tail = " 2023-24"
        elif key == "approvals":
            tail = " 2022-23"
        out.append(ds["label"] + tail)
    return out
