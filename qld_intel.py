# Copyright (c) 2026 RV
"""
Queensland property intelligence — live open data for one address.

Everything here comes from the Queensland Government's ArcGIS REST services
(spatial-gis.information.qld.gov.au). No keys, no signup, no per-call cost.

Given a lat/lon (from the address autocomplete) we ask each layer "what is at
this point?" in parallel and merge the answers into one payload:

    parcel        lot/plan, tenure, land area, LGA, locality, parcel outline
    land use      ALUM classification (primary/secondary/tertiary)
    regional plan which regional plan applies, plus areas of regional interest
    flood         flood study coverage + rapid hazard catchment

Layer failures are tolerated: a dead layer lands in "errors" and the rest of
the payload still renders.

Endpoint:
    GET /api/intel/property?lat=<lat>&lon=<lon>  (auth required)
"""

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from flask import Blueprint, g, jsonify, request

import auth
import ratelimit

bp = Blueprint("intel", __name__, url_prefix="/api/intel")

ARCGIS = "https://spatial-gis.information.qld.gov.au/arcgis/rest/services"

# Layer paths (relative to ARCGIS)
P_PARCEL = "PlanningCadastre/QSCF_LandParcelPropertyFramework/MapServer/115"
P_LANDUSE = "PlanningCadastre/LandUse/MapServer/0"
P_REGIONAL = "PlanningCadastre/StatePlanning/MapServer/90"
P_PRIORITY_LIVING = "PlanningCadastre/StatePlanning/MapServer/10"
P_PRIORITY_AG = "PlanningCadastre/StatePlanning/MapServer/15"
P_STRATEGIC_ENV = "PlanningCadastre/StatePlanning/MapServer/20"
P_FLOOD_COMP = "FloodCheck/ComprehensiveStudies/MapServer/0"
P_FLOOD_BASIC = "FloodCheck/BasicStudies/MapServer/0"
P_FLOOD_RHA = "FloodCheck/RapidHazardAssessment/MapServer/0"

HTTP_TIMEOUT = 20
USER_AGENT = "gk-property-analyser/1.0 (personal investment tool; macOS loopback)"
MAX_WORKERS = 6

CACHE_TTL = 12 * 3600
CACHE_MAX = 500

_cache = {}
_cache_lock = threading.Lock()


class IntelError(Exception):
    """Upstream ArcGIS failure; carries the HTTP status to mirror."""

    def __init__(self, message, http_status=502):
        super().__init__(message)
        self.http_status = http_status


def _cache_key(lat, lon):
    return f"{lat:.4f},{lon:.4f}"


def _cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
        if not hit:
            return None
        if time.time() - hit[0] > CACHE_TTL:
            _cache.pop(key, None)
            return None
        return hit[1]


def _cache_put(key, value):
    with _cache_lock:
        if len(_cache) > CACHE_MAX:
            oldest = sorted(_cache.items(), key=lambda kv: kv[1][0])[:100]
            for k, _ in oldest:
                _cache.pop(k, None)
        _cache[key] = (time.time(), value)


def clear_cache():
    """Test helper."""
    with _cache_lock:
        _cache.clear()


def _query(layer_path, lat, lon, geometry=False, out_fields="*"):
    """Query one ArcGIS layer for the point (lat, lon).

    Returns the list of feature dicts (possibly empty).
    """
    params = {
        "f": "json",
        "geometry": f"{lon},{lat}",
        "geometryType": "esriGeometryPoint",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": out_fields,
        "returnGeometry": "true" if geometry else "false",
    }
    if geometry:
        params["outSR"] = "4326"
    url = f"{ARCGIS}/{layer_path}/query"
    try:
        resp = requests.get(url, params=params, headers={"User-Agent": USER_AGENT},
                            timeout=HTTP_TIMEOUT)
    except requests.RequestException as e:
        raise IntelError(f"{layer_path}: {e}") from e
    if resp.status_code != 200:
        raise IntelError(f"{layer_path}: upstream returned {resp.status_code}", 502)
    try:
        body = resp.json()
    except ValueError as e:
        raise IntelError(f"{layer_path}: bad JSON from upstream") from e
    if "error" in body:
        msg = (body["error"] or {}).get("details") or "upstream error"
        raise IntelError(f"{layer_path}: {msg}")
    return body.get("features") or []


def _attr(feature, key, default=None):
    return (feature.get("attributes") or {}).get(key, default)


def _clean(val):
    """Drop NULL/empty values and return plain JSON types."""
    if val is None:
        return None
    if isinstance(val, float) and val != val:  # NaN
        return None
    if isinstance(val, (int, float, str, bool)):
        return val
    return str(val)


# ---------------------------------------------------------------------------
# Layer readers
# ---------------------------------------------------------------------------

def _parcel(lat, lon):
    feats = _query(P_PARCEL, lat, lon, geometry=True)
    if not feats:
        return None, None
    f = feats[0]
    a = f.get("attributes") or {}
    parcel = {
        "lot": _clean(a.get("lot")),
        "plan": _clean(a.get("plan")),
        "lotPlan": _clean(a.get("lotplan")),
        "tenure": _clean(a.get("tenure")),
        "areaSqm": _clean(a.get("statedarea")),
        "areaUnit": _clean(a.get("statedareaunit")),
        "locality": _clean(a.get("locality")),
        "lga": _clean(a.get("lga")),
        "featureName": _clean(a.get("feat_name")),
        "parcelState": _clean(a.get("parcel_state")),
        "isVolumetric": a.get("is_volumetric") == "Yes",
        "isMulti": a.get("is_multi") == "Yes",
        "isStrata": bool(a.get("totalstrata") or 0),
        "strataCount": _clean(a.get("totalstrata")),
        "surveyAccurate": a.get("surv_ind") == "Yes",
    }
    return parcel, f.get("geometry")


def _land_use(lat, lon):
    feats = _query(P_LANDUSE, lat, lon)
    if not feats:
        return None
    a = feats[0].get("attributes") or {}
    return {
        "primary": _clean(a.get("primary_")),
        "secondary": _clean(a.get("secondary")),
        "tertiary": _clean(a.get("tertiary")),
        "code": _clean(a.get("alum_code")),
        "year": _clean(a.get("year")),
    }


def _regional_plan(lat, lon):
    feats = _query(P_REGIONAL, lat, lon)
    if not feats:
        return None
    a = feats[0].get("attributes") or {}
    return {
        "name": _clean(a.get("plan_name")),
        "version": _clean(a.get("version")),
        "status": _clean(a.get("legal_stat")),
    }


def _named_area(layer_path, lat, lon, name_field="name"):
    feats = _query(layer_path, lat, lon)
    out = []
    for f in feats:
        a = f.get("attributes") or {}
        label = _clean(a.get(name_field)) or _clean(a.get("region"))
        if label:
            out.append(label)
    return out


def _flood(lat, lon):
    studies = []
    for path, kind in ((P_FLOOD_COMP, "Comprehensive study"),
                       (P_FLOOD_BASIC, "Basic study")):
        try:
            feats = _query(path, lat, lon, geometry=True)
        except IntelError:
            continue
        for f in feats:
            a = f.get("attributes") or {}
            studies.append({
                "kind": kind,
                "name": _clean(a.get("studyname")),
                "area": _clean(a.get("studyarea")),
                "lga": _clean(a.get("lga")),
                "purpose": _clean(a.get("purpose")),
                "consultant": _clean(a.get("consultantname")),
                "url": _clean(a.get("consultanturl")),
                "geometry": f.get("geometry"),
            })
    catchments = []
    try:
        for f in _query(P_FLOOD_RHA, lat, lon):
            a = f.get("attributes") or {}
            if a.get("sub_name"):
                catchments.append(a["sub_name"])
    except IntelError:
        pass
    return {"studies": studies, "catchments": catchments}


# ---------------------------------------------------------------------------
# Payload assembly
# ---------------------------------------------------------------------------

def _sources():
    return [
        {"label": "Cadastral (Queensland Spatial Information)",
         "url": "https://www.qld.gov.au/environment/land/land-management/land-valuation",
         "note": "land area, tenure, lot/plan"},
        {"label": "FloodCheck (Queensland Government)",
         "url": "https://floodcheck.information.qld.gov.au/", "note": "flood studies"},
        {"label": "Bushfire prone area (QFES)",
         "url": "https://www.qfes.qld.gov.au/opendata", "note": "state-wide mapping"},
        {"label": "QLD Globe",
         "url": "https://globe.qld.gov.au/", "note": "authoritative parcel check"},
    ]


def _fetch_all(lat, lon):
    """Run every layer query in parallel; per-layer failures are collected."""
    errors = []
    result = {}

    def run(name, fn):
        try:
            return name, fn(lat, lon), None
        except IntelError as e:
            return name, None, str(e)
        except Exception as e:  # defensive — never take the endpoint down
            return name, None, f"{type(e).__name__}: {e}"

    jobs = [
        ("parcel", lambda la, lo: _parcel(la, lo)),
        ("landUse", _land_use),
        ("regionalPlan", _regional_plan),
        ("priorityLiving", lambda la, lo: _named_area(P_PRIORITY_LIVING, la, lo)),
        ("priorityAgricultural", lambda la, lo: _named_area(P_PRIORITY_AG, la, lo)),
        ("strategicEnvironmental", lambda la, lo: _named_area(P_STRATEGIC_ENV, la, lo)),
        ("flood", _flood),
    ]
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for name, value, err in pool.map(lambda j: run(*j), jobs):
            if err:
                errors.append({"layer": name, "error": err})
            else:
                result[name] = value

    parcel, geometry = result.get("parcel") or (None, None)
    flood = result.get("flood") or {"studies": [], "catchments": []}

    studies = []
    extent = None
    for s in flood.get("studies", []):
        geom = s.pop("geometry", None)
        if geom and extent is None:
            extent = geom
        studies.append(s)

    return {
        "coords": {"lat": lat, "lon": lon},
        "parcel": parcel,
        "parcelGeometry": geometry,
        "landUse": result.get("landUse"),
        "regionalPlan": result.get("regionalPlan"),
        "areasOfInterest": {
            "priorityLiving": result.get("priorityLiving") or [],
            "priorityAgricultural": result.get("priorityAgricultural") or [],
            "strategicEnvironmental": result.get("strategicEnvironmental") or [],
        },
        "flood": {"studies": studies, "catchments": flood.get("catchments") or [],
                  "extent": extent},
        "sources": _sources(),
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "errors": errors,
    }


def property_intel(lat, lon):
    """Cached property intelligence for a point. Raises IntelError."""
    key = _cache_key(lat, lon)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    payload = _fetch_all(lat, lon)
    _cache_put(key, payload)
    return payload


@bp.get("/property")
@auth.require_auth
def property():
    if not ratelimit.hit(f"intel:{g.user['id']}", 120, 300):
        return jsonify({"ok": False, "error": "too many requests"}), 429
    try:
        lat = float(request.args.get("lat"))
        lon = float(request.args.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "lat and lon are required numbers"}), 400
    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        return jsonify({"ok": False, "error": "lat/lon out of range"}), 400
    try:
        data = property_intel(lat, lon)
    except IntelError as e:
        return jsonify({"ok": False, "error": f"property lookup failed: {e}"}), e.http_status
    return jsonify({"ok": True, "data": data})
