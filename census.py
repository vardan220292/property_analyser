# Copyright (c) 2026 RV
"""
Census — 2021 Census socio-economic data by SA2 from the free ABS
FeatureServer that powers the heat maps (static/app.js HEAT_SOURCE).

Provides:
  * national benchmark percentiles per field (all ~2,450 SA2s, attributes
    only — cached in memory and snapshotted to data/markets/)
  * a point lookup: lat/lng -> the SA2 containing it, with every metric
  * the Deal Check verdict engine (10 verdicts) shared by the Deal Check
    page and the client report PDF, so both read identically.
"""

import json
import math
import os
import re
import threading
import time
from datetime import datetime, timezone

import requests
from flask import Blueprint, jsonify, request

import areastats

bp = Blueprint("census", __name__, url_prefix="/api/markets/census")

LAYER = ("https://services1.arcgis.com/v8Kimc579yljmjSP/arcgis/rest/services/"
         "SA2_ABS_SEIFACS_2024_Apr/FeatureServer/0/query")

SNAPSHOT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "data", "markets", "census-benchmarks.json")
SNAPSHOT_TTL = 24 * 3600  # benchmarks re-read daily; the ABS layer updates only when ABS publishes
PAGE = 1000  # the service's maxRecordCount

FIELDS = [
    "sa2_code_2021", "sa2_name_2021", "erp_p_20", "dwell_7", "leed_4",
    "irsd_score", "hied_1_pc", "lf_3", "lf_4", "lf_5", "arrmig_2",
    "erp_sch_1_pc", "erp_p_75p_pc", "tenure_4", "publich_1_pc",
    "afford_3", "afford_5", "house_2_pc", "tenure_owned", "tenure_3",
    "house_3_pc", "unpaidw_3", "vehd_1_pc", "hhtype_6", "ing_erp_p_pc",
]

# ASGS: the first digit of an SA2 code identifies its state/territory.
_STATE_BY_DIGIT = {"1": "NSW", "2": "VIC", "3": "QLD", "4": "SA",
                   "5": "WA", "6": "TAS", "7": "NT", "8": "ACT"}


def _state_from_code(sa2_code):
    digits = re.sub(r"\D", "", str(sa2_code or ""))
    return _STATE_BY_DIGIT.get(digits[:1])


_names_cache = {"data": None, "at": 0.0}


def _sa2_names():
    """[{code, name, state}] for every SA2 — used by the suburb crosswalk."""
    now = time.time()
    if _names_cache["data"] and now - _names_cache["at"] < SNAPSHOT_TTL:
        return _names_cache["data"]
    rows = _fs_all_attributes()
    data = [{"code": r.get("sa2_code_2021"), "name": r.get("sa2_name_2021"),
             "state": _state_from_code(r.get("sa2_code_2021"))}
            for r in rows]
    _names_cache["data"], _names_cache["at"] = data, now
    return data


def match_sa2_for_suburb(name, state):
    """Match a suburb name to an ABS SA2 within its state (normalised
    equality, then unique prefix match). Returns sa2_code or None."""
    want = re.sub(r"[^a-z0-9]+", " ", str(name or "")).lower().strip()
    if len(want) < 3:
        return None
    st = str(state or "").strip().upper()
    candidates = [s for s in _sa2_names()
                  if not st or s["state"] == st]
    if not candidates:
        return None
    norm = [(s, re.sub(r"[^a-z0-9]+", " ", str(s["name"] or "")).lower().strip())
            for s in candidates]
    exact = [s for s, n in norm if n == want]
    if len(exact) == 1:
        return exact[0]["code"]
    prefixes = [s for s, n in norm if n.startswith(want) or want.startswith(n)]
    if len(prefixes) == 1:
        return prefixes[0]["code"]
    return None

METRIC_DEFS = {
    "tenure_4": {"label": "Renting households", "unit": "%", "dp": 1},
    "house_2_pc": {"label": "Overcrowded households", "unit": "%", "dp": 1,
                   "note": "Households needing extra bedrooms"},
    "arrmig_2": {"label": "Recent migrants (5 yr)", "unit": "%", "dp": 1},
    "erp_sch_1_pc": {"label": "School-age residents (5-19)", "unit": "%", "dp": 1},
    "lf_4": {"label": "Unemployment", "unit": "%", "dp": 1},
    "lf_5": {"label": "Participation", "unit": "%", "dp": 1},
    "jobs_per_dwelling": {"label": "Jobs per dwelling", "unit": "", "dp": 2},
    "irsd_score": {"label": "SEIFA disadvantage", "unit": "", "dp": 0,
                   "note": "Higher = less disadvantaged"},
    "hied_1_pc": {"label": "Low-income households", "unit": "%", "dp": 1},
    "afford_5": {"label": "Rent stress", "unit": "%", "dp": 1,
                 "note": "Renters paying >30% of income on rent"},
    "afford_3": {"label": "Mortgage stress", "unit": "%", "dp": 1,
                 "note": "Owners paying >30% of income on the mortgage"},
    "erp_p_75p_pc": {"label": "Residents 75+", "unit": "%", "dp": 1},
    "publich_1_pc": {"label": "Public housing", "unit": "%", "dp": 1},
    "tenure_owned": {"label": "Owned outright", "unit": "%", "dp": 1},
    "tenure_3": {"label": "Owned with mortgage", "unit": "%", "dp": 1},
    "house_3_pc": {"label": "Spare bedrooms", "unit": "%", "dp": 1},
    "unpaidw_3": {"label": "Volunteers", "unit": "%", "dp": 1},
    "vehd_1_pc": {"label": "Households without a car", "unit": "%", "dp": 1},
    "hhtype_6": {"label": "Avg household size", "unit": "", "dp": 1},
    "ing_erp_p_pc": {"label": "First Nations residents", "unit": "%", "dp": 1},
}

# (key, question, headline per status, [(metric, "high"|"low"), ...]).
# A metric listed "low" scores better when its percentile is low; verdict
# scores are direction-adjusted so 100 is always best-for-the-deal.
VERDICT_DEFS = [
    ("rental_demand", "Will landlords find tenants easily?", {
        "strong": "Deep rental market — tenant demand looks reliable.",
        "ok": "Rental demand is mid-range — check vacancy and leasing history.",
        "watch": "Thin rental market — long vacancies are a real risk."},
     [("tenure_4", "high"), ("house_2_pc", "high")]),
    ("population_pipeline", "Is the future pool of renters and buyers growing?", {
        "strong": "Strong population pipeline — new households keep forming.",
        "ok": "Population pipeline is steady rather than standout.",
        "watch": "Weak population pipeline — demand may fade over the hold."},
     [("arrmig_2", "high"), ("erp_sch_1_pc", "high")]),
    ("employment", "Can people here find work?", {
        "strong": "Healthy employment — people can pay their rent.",
        "ok": "Employment is unremarkable — no red flag either way.",
        "watch": "Weak employment — income risk for tenants."},
     [("lf_4", "low"), ("lf_5", "high")]),
    ("local_jobs", "Are there enough local jobs?", {
        "strong": "Job-rich area — short commutes support prices and rents.",
        "ok": "Local jobs are middling — many residents commute out.",
        "watch": "Jobs-poor area — demand depends on elsewhere."},
     [("jobs_per_dwelling", "high")]),
    ("income_strength", "Are household incomes healthy?", {
        "strong": "Strong income base — a resilient tenant pool.",
        "ok": "Incomes are around the national spread.",
        "watch": "Low-income area — rent ceilings and arrears risk."},
     [("irsd_score", "high"), ("hied_1_pc", "low")]),
    ("rental_affordability", "Are tenants over-stretched by rent?", {
        "strong": "Rents are manageable for local incomes.",
        "ok": "Some rental strain — watch rent growth assumptions.",
        "watch": "Heavy rent stress — rents may be near the ceiling."},
     [("afford_5", "low")]),
    ("owner_stress", "Are local owners financially stressed?", {
        "strong": "Owners look comfortable — low forced-sale risk.",
        "ok": "Typical mortgage stress — not a price signal by itself.",
        "watch": "High mortgage stress — forced sales can drag prices."},
     [("afford_3", "low")]),
    ("downsizing_wave", "Will an ageing population add selling pressure?", {
        "strong": "Younger age profile — little downsizing supply ahead.",
        "ok": "Mixed age profile — some downsizing supply over the hold.",
        "watch": "Older age profile — expect extra supply as households downsize."},
     [("erp_p_75p_pc", "low")]),
    ("social_housing", "Is public housing concentrated here?", {
        "strong": "Little public housing — private market dominates.",
        "ok": "Some public housing — normal for most suburbs.",
        "watch": "High public-housing share — check street-level impact."},
     [("publich_1_pc", "low")]),
]

STATUS_OF_SCORE = (65, 40)  # >=65 strong, >=40 ok, else watch
VERDICT_WORD = {"strong": "PASS", "ok": "CONDITIONAL", "watch": "CAUTION"}


# ---------------------------------------------------------------------------
# FeatureServer plumbing
# ---------------------------------------------------------------------------

def _fs_query(**params):
    params.setdefault("where", "1=1")
    params.setdefault("outFields", ",".join(FIELDS))
    params["f"] = "json"
    r = requests.get(LAYER, params=params, timeout=25)
    r.raise_for_status()
    d = r.json()
    if d.get("error"):
        raise RuntimeError(d["error"].get("message") or "ABS service error")
    return d


def _fs_all_attributes():
    """Every SA2's attributes, paged past maxRecordCount."""
    rows, offset, exceeded = [], 0, True
    while exceeded:
        d = _fs_query(returnGeometry="false", resultRecordCount=PAGE,
                      resultOffset=offset)
        rows.extend(f["attributes"] for f in d.get("features", []))
        exceeded = bool(d.get("exceededTransferLimit"))
        offset += PAGE
    return rows


# ---------------------------------------------------------------------------
# Benchmarks — national percentiles per field, cached and snapshotted
# ---------------------------------------------------------------------------

_bench = {"data": None, "at": 0.0}
_bench_lock = threading.Lock()


def _percentiles(values):
    vs = sorted(v for v in values
                if isinstance(v, (int, float)) and math.isfinite(v))
    if not vs:
        return None

    def at(p):
        i = (len(vs) - 1) * p / 100.0
        lo = math.floor(i)
        hi = math.ceil(i)
        return vs[lo] if lo == hi else vs[lo] + (vs[hi] - vs[lo]) * (i - lo)

    return {"p10": at(10), "p25": at(25), "p50": at(50), "p75": at(75),
            "p90": at(90), "n": len(vs)}


def build_benchmarks(rows):
    """Pure: rows of SA2 attributes -> percentile benchmarks per field,
    nationally and per state."""
    out = {}
    for f in FIELDS[2:]:  # skip the two id fields
        p = _percentiles([row.get(f) for row in rows])
        if p:
            out[f] = p
    out["jobs_per_dwelling"] = _percentiles(
        r["leed_4"] / r["dwell_7"] for r in rows
        if r.get("leed_4") is not None and r.get("dwell_7"))

    # Per-state buckets: first digit of the SA2 code identifies the state.
    by_state = {}
    for row in rows:
        st = _state_from_code(row.get("sa2_code_2021"))
        if st:
            by_state.setdefault(st, []).append(row)
    states = {}
    for st, srows in by_state.items():
        sb = {}
        for f in FIELDS[2:]:
            p = _percentiles([r.get(f) for r in srows])
            if p:
                sb[f] = p
        states[st] = sb
    return {"n": len(rows),
            "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "fields": out, "states": states}


def load_benchmarks():
    """Memory -> fresh snapshot -> live build (updating the snapshot)."""
    now = time.time()
    if _bench["data"] and now - _bench["at"] < SNAPSHOT_TTL:
        return _bench["data"]
    with _bench_lock:
        if _bench["data"] and time.time() - _bench["at"] < SNAPSHOT_TTL:
            return _bench["data"]
        data = None
        try:
            with open(SNAPSHOT) as fh:
                snap = json.load(fh)
            if now - os.path.getmtime(SNAPSHOT) < SNAPSHOT_TTL:
                data = snap
        except (OSError, ValueError):
            pass
        if data is None:
            try:
                data = build_benchmarks(_fs_all_attributes())
                os.makedirs(os.path.dirname(SNAPSHOT), exist_ok=True)
                with open(SNAPSHOT, "w") as fh:
                    json.dump(data, fh)
            except Exception:
                data = None  # fall back to a stale snapshot if one exists
        if data is None:
            try:
                with open(SNAPSHOT) as fh:
                    data = json.load(fh)  # stale beats nothing
            except (OSError, ValueError):
                return None
        data = _augmented_benchmarks(data)
        _bench["data"], _bench["at"] = data, time.time()
        return data


def refresh_benchmarks():
    """Force a live rebuild (admin/testing)."""
    data = build_benchmarks(_fs_all_attributes())
    os.makedirs(os.path.dirname(SNAPSHOT), exist_ok=True)
    with open(SNAPSHOT, "w") as fh:
        json.dump(data, fh)
    data = _augmented_benchmarks(data)
    _bench["data"], _bench["at"] = data, time.time()
    return data


# Newer-dataset folds (areastats) — fields percentile over their own
# distributions and are merged into the census benchmarks in memory, so the
# on-disk census snapshot keeps its pure shape.
def _benchmarks_meta():
    """field -> {label, unit, dp, vintage, source} across census + areastats."""
    meta = {}
    for f, d in METRIC_DEFS.items():
        meta[f] = {"label": d["label"], "unit": d["unit"], "dp": d["dp"],
                   "vintage": "2021 Census", "source": "ABS 2021 Census"}
    meta["erp_p_20"] = {"label": "Population (2021 ERP)", "unit": "", "dp": 0,
                        "vintage": "2021 Census", "source": "ABS 2021 Census"}
    meta.update(areastats.vintage_meta())
    return meta


def _augmented_benchmarks(data):
    if not data:
        return data
    fields = data.setdefault("fields", {})
    states = data.setdefault("states", {})
    extra = areastats.benchmark_rows()
    if extra:
        for f in areastats.FIELD_META:
            p = _percentiles([r.get(f) for r in extra])
            if p and f not in fields:
                fields[f] = p
        by_state = {}
        for r in extra:
            st = _state_from_code(r.get("sa2_code_2021"))
            if st:
                by_state.setdefault(st, []).append(r)
        for st, srows in by_state.items():
            sb = states.setdefault(st, {})
            for f in areastats.FIELD_META:
                p = _percentiles([r.get(f) for r in srows])
                if p:
                    sb[f] = p
    data["meta"] = _benchmarks_meta()
    return data


# ---------------------------------------------------------------------------
# Point lookup
# ---------------------------------------------------------------------------

def point_lookup(lat, lon):
    d = _fs_query(geometry=json.dumps({"x": lon, "y": lat}),
                  geometryType="esriGeometryPoint", inSR=4326,
                  spatialRel="esriSpatialRelIntersects",
                  returnGeometry="false", resultRecordCount=1)
    feats = d.get("features") or []
    if not feats:
        return None
    a = feats[0]["attributes"]
    a["jobs_per_dwelling"] = (a["leed_4"] / a["dwell_7"]
                              if a.get("leed_4") is not None and a.get("dwell_7")
                              else None)
    a["state"] = _state_from_code(a.get("sa2_code_2021"))
    return a


# ---------------------------------------------------------------------------
# Deal Check verdict engine (pure — unit-tested without network)
# ---------------------------------------------------------------------------

def _percentile_of(value, b):
    anchors = [(10, b["p10"]), (25, b["p25"]), (50, b["p50"]),
               (75, b["p75"]), (90, b["p90"])]
    if value <= anchors[0][1]:
        return 5.0
    for (pa, va), (pb, vb) in zip(anchors, anchors[1:]):
        if value <= vb:
            return pa + (pb - pa) * (value - va) / (vb - va) if vb > va else pb
    return 95.0


def _score_to_status(score):
    strong, ok = STATUS_OF_SCORE
    return "strong" if score >= strong else "ok" if score >= ok else "watch"


def deal_verdicts(values, benchmarks):
    """values: SA2 attributes (with jobs_per_dwelling); benchmarks: the
    snapshot dict. Returns the 9 question verdicts + the composite overall."""
    fields = (benchmarks or {}).get("fields") or {}
    out = []
    for key, question, headlines, comps in VERDICT_DEFS:
        chips, scores = [], []
        for metric, better in comps:
            v = values.get(metric)
            b = fields.get(metric)
            if metric == "lf_4":
                # Prefer the fresher DEWR SALM unemployment when present.
                sv, sb = values.get("salm_unemp_rate"), fields.get("salm_unemp_rate")
                if sv is not None and sb:
                    metric, v, b = "salm_unemp_rate", sv, sb
            if v is None or not b:
                continue
            pct = _percentile_of(v, b)
            pos = pct if better == "high" else 100 - pct
            scores.append(pos)
            d = METRIC_DEFS.get(metric) or areastats.chip_def(metric) or {}
            vintage = ((benchmarks.get("meta") or {}).get(metric) or {}).get("vintage")
            chips.append({"key": metric, "label": d.get("label", metric),
                          "unit": d.get("unit", ""), "dp": d.get("dp", 1),
                          "value": v,
                          "benchmark": b["p50"], "percentile": round(pct),
                          "better": better, "vintage": vintage,
                          "note": d.get("note")})
        if not scores:
            out.append({"key": key, "question": question, "status": "nodata",
                        "score": None, "headline": "No census data for this metric.",
                        "metrics": []})
            continue
        score = round(sum(scores) / len(scores))
        out.append({"key": key, "question": question,
                    "status": _score_to_status(score), "score": score,
                    "headline": headlines[_score_to_status(score)],
                    "metrics": chips})
    scored = [v["score"] for v in out if v["score"] is not None]
    if not scored:
        overall = {"score": None, "status": "nodata", "headline":
                   "Not enough census data to score this area."}
    else:
        score = round(sum(scored) / len(scored))
        status = _score_to_status(score)
        ranked = sorted((v for v in out if v["score"] is not None),
                        key=lambda v: v["score"], reverse=True)
        best = [v["question"] for v in ranked[:2]]
        worst = [v["question"] for v in ranked[-2:] if v["score"] < 50]
        overall = {"score": score, "status": status,
                   "verdictWord": VERDICT_WORD[status],
                   "headline": {
                       "strong": "Area fundamentals support the deal.",
                       "ok": "Area fundamentals are acceptable — mind the flags below.",
                       "watch": "Area fundamentals are weak — proceed only with a clear thesis."}[status],
                   "drivers": {"for": best, "against": worst}}
    return out, overall


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@bp.get("/benchmarks")
def benchmarks_endpoint():
    data = load_benchmarks()
    if not data:
        return jsonify({"ok": False,
                        "error": "census benchmarks unavailable (ABS unreachable)"}), 503
    return jsonify({"ok": True, "data": data})


@bp.get("/point")
def point_endpoint():
    lat, lon = request.args.get("lat"), request.args.get("lon")
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "lat and lon are required numbers"}), 400
    if not (-44.5 <= lat <= -9) or not (112 <= lon <= 155):
        return jsonify({"ok": False, "error": "point is outside Australia"}), 422
    postcode = (request.args.get("postcode") or "").strip()
    try:
        attrs = point_lookup(lat, lon)
    except Exception as e:
        return jsonify({"ok": False, "error": f"census lookup failed: {e}"}), 502
    if not attrs:
        return jsonify({"ok": False, "error": "no SA2 covers this point"}), 404
    sa2_values = areastats.sa2_values(attrs.get("sa2_code_2021"))
    pc_values = areastats.postcode_values(postcode)
    attrs.update(sa2_values)
    benchmarks = load_benchmarks() or {"fields": {}}
    verdicts, overall = deal_verdicts(attrs, benchmarks)
    values = {k: attrs.get(k) for k in list(METRIC_DEFS) + ["erp_p_20"]}
    values.update(sa2_values)
    values.update(pc_values)
    stamps = ["ABS 2021 Census (SEIFA/ERP/LEP), SA2 level"] + areastats.dataset_labels()
    if pc_values:
        stamps.append("ATO 2023-24 (postcode match)")
    return jsonify({"ok": True, "data": {
        "sa2": {"code": attrs.get("sa2_code_2021"),
                "name": attrs.get("sa2_name_2021")},
        "state": attrs.get("state"),
        "values": values,
        "verdicts": verdicts,
        "overall": overall,
        "benchmarks": benchmarks,
        "source": " · ".join(stamps),
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }})


@bp.get("/rows")
def rows_endpoint():
    """Lightweight rows for one areastats dataset (heat-map client join)."""
    key = (request.args.get("key") or "").strip()
    if key not in areastats.DATASETS:
        return jsonify({"ok": False, "error": "unknown dataset key"}), 400
    snap = areastats.load(key)
    if not snap:
        return jsonify({"ok": False, "error": "dataset snapshot not available"}), 503
    return jsonify({"ok": True, "data": {
        "key": key, "geo": snap.get("geo"), "asOf": snap.get("asOf"),
        "release": snap.get("release"),
        "vintage": snap.get("vintage"), "rows": snap.get("rows"),
    }})
