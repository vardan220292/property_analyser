# Copyright (c) 2026 RV
"""
State property parcel intelligence for NSW, ACT, TAS, WA, NT and SA — the
six states not covered by qld_intel.py / vic_intel.py. Each state's public,
keyless government service is point-queried at the subject coordinates:

  NSW  portal.spatial.nsw.gov.au  Land Parcel & Property Theme (Lot)
  ACT  services1.arcgis.com       ACTGOV_BLOCKS (division/block/section)
  TAS  services.thelist.tas.gov.au  LIST Cadastral Parcels (PID)
  WA   services.slip.wa.gov.au    LGATE-001 cadastre (geometry only)
  SA   no public parcel endpoint found (2026-11 probe) — honest fallback
  NT   nrmaps.nt.gov.au WMS reachable but carries no public cadastral layer

Payload mirrors vic_intel.py (parcel, parcelGeometry, sources, errors) so
the frontend renders every jurisdiction with the same card components.
"""
import threading
import time

import requests
from flask import Blueprint, g, jsonify, request

import auth
import olf
import ratelimit

bp = Blueprint("state_intel", __name__, url_prefix="/api/intel")

CACHE_TTL = 12 * 3600
_cache = {}
_lock = threading.Lock()
UA = {"User-Agent": "RV-PropertyAnalyser/1.0"}


def _cache_get(key):
    with _lock:
        item = _cache.get(key)
        if not item:
            return None
        if time.time() - item[0] > CACHE_TTL:
            _cache.pop(key, None)
            return None
        return item[1]


def _cache_put(key, value):
    with _lock:
        if len(_cache) > 500:
            _cache.pop(next(iter(_cache)))
        _cache[key] = (time.time(), value)


def _esri_point_query(url, lat, lon, out_fields):
    """Shared ArcGIS point-intersect query -> (attributes, geometry)."""
    params = {
        "f": "json",
        "geometry": f"{lon},{lat}",
        "geometryType": "esriGeometryPoint",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": out_fields or "*",
        "returnGeometry": "true",
        "outSR": "4326",
    }
    response = requests.get(url, params=params, timeout=18, headers=UA)
    response.raise_for_status()
    body = response.json()
    if body.get("error"):
        raise RuntimeError(f"service error: {str(body['error'])[:150]}")
    features = body.get("features") or []
    if not features:
        return None, None
    return features[0].get("attributes") or {}, features[0].get("geometry")


def _rings_bbox(geometry):
    """Parcel polygon rings -> lat/lon bbox for point-in-polygon checks."""
    try:
        xs, ys = [], []
        for ring in geometry.get("rings") or []:
            for x, y in ring:
                xs.append(x)
                ys.append(y)
        return (min(ys), min(xs), max(ys), max(xs))
    except (AttributeError, TypeError, ValueError):
        return None


def _point_in_rings(lat, lon, geometry):
    bbox = _rings_bbox(geometry)
    if not bbox:
        return None
    miny, minx, maxy, maxx = bbox
    pad = 0.0004
    return bool(miny - pad <= lat <= maxy + pad and minx - pad <= lon <= maxx + pad)


# --- State hazard layers (bushfire / flood point checks) -------------------
# Each follows the vic_intel bushfire pattern: a point-intersect query that
# degrades to prone=None instead of raising.

WA_BUSHFIRE_URL = ("https://services.slip.wa.gov.au/public/rest/services/"
                   "SLIP_Public_Services/Bush_Fire_Prone_Areas/MapServer/23/query")
NSW_BUSHFIRE_URL = ("https://portal.spatial.nsw.gov.au/server/rest/services/"
                    "Hosted/NSW_BushFire_Prone_Land/FeatureServer/0/query")
ACT_BUSHFIRE_URL = ("https://services1.arcgis.com/E5n4f1VY84i0xSjy/arcgis/"
                    "rest/services/Bushfire_Prone_Area_Overview_2026/FeatureServer/0/query")
# TAS SES flood layers are RASTER layers — no point queries; TAS flood is a
# tile overlay only (see floodLayer() in app.js).


def _hazard_check(url, label):
    def check(lat, lon):
        try:
            # outFields "*" — NSW layers use lowercase fid/objectid names, so
            # requesting OBJECTID explicitly 500s on them.
            attrs, _ = _esri_point_query(url, lat, lon, "*")
            return {"prone": attrs is not None, "source": url.split("/query")[0],
                    "layer": label}
        except (requests.RequestException, ValueError, RuntimeError) as exc:
            return {"prone": None, "error": str(exc)[:200]}
    return check


wa_bushfire = _hazard_check(WA_BUSHFIRE_URL, "Bush Fire Prone Areas (SLIP)")
nsw_bushfire = _hazard_check(NSW_BUSHFIRE_URL, "NSW Bush Fire Prone Land (RFS)")
act_bushfire = _hazard_check(ACT_BUSHFIRE_URL, "ACT Bushfire Prone Areas (2026)")


# --- Per-state parcel definitions ------------------------------------------

NSW_LOT_URL = ("https://portal.spatial.nsw.gov.au/server/rest/services/"
               "NSW_Land_Parcel_Property_Theme/FeatureServer/8/query")
ACT_BLOCKS_URL = ("https://services1.arcgis.com/E5n4f1VY84i0xSjy/arcgis/"
                  "rest/services/ACTGOV_BLOCKS/FeatureServer/0/query")
TAS_PARCEL_URL = ("https://services.thelist.tas.gov.au/arcgis/rest/services/"
                  "Public/CadastreAndAdministrative/MapServer/38/query")
WA_CADASTRE_URL = ("https://services.slip.wa.gov.au/public/rest/services/"
                   "SLIP_Public_Services/Property_and_Planning/MapServer/2/query")


def _norm_nsw(attrs):
    lot = attrs.get("lotnumber")
    plan = attrs.get("planlabel")
    return {
        "id": f"Lot {lot} {plan}" if lot and plan else attrs.get("lotidstring"),
        "areaSqm": attrs.get("Shape__Area"),
        "locality": None,
        "extra": {"lotNumber": lot, "planLabel": plan,
                  "sectionNumber": attrs.get("sectionnumber")},
    }


def _norm_act(attrs):
    return {
        "id": attrs.get("BLOCK_SECTION") and f"Block {attrs.get('BLOCK_NUMBER')} "
              f"Section {attrs.get('SECTION_NUMBER')}, {attrs.get('DIVISION_NAME')}",
        "areaSqm": attrs.get("BLOCK_DERIVED_AREA"),
        "locality": attrs.get("DIVISION_NAME"),
        "extra": {"blockKey": attrs.get("BLOCK_KEY"),
                  "planNumbers": attrs.get("PLAN_NUMBERS"),
                  "landUseZone": attrs.get("LAND_USE_POLICY_ZONES"),
                  "district": attrs.get("DISTRICT_NAME")},
    }


def _norm_tas(attrs):
    vol, fol = attrs.get("VOLUME"), attrs.get("FOLIO")
    return {
        "id": f"PID {attrs.get('PID')}" + (f" (Vol {vol}/Fol {fol})" if vol else ""),
        "areaSqm": attrs.get("MEAS_AREA"),
        "locality": attrs.get("PROP_ADD"),
        "extra": {"tenure": attrs.get("TENURE_TY"), "volume": vol, "folio": fol},
    }


def _norm_wa(attrs):
    return {
        "id": None,  # LGATE-001 public layer carries no attributes
        "areaSqm": attrs.get("Shape__Area"),
        "locality": None,
        "extra": {"note": "WA public cadastre (LGATE-001) provides the parcel "
                          "boundary only; landgate attribute access is licensed"},
    }


STATE_DEFINITIONS = {
    "NSW": {
        "provider": "NSW Land Parcel and Property Theme",
        "source": {"label": "NSW Land Parcel and Property Theme — NSW Spatial Services",
                   "url": "https://portal.spatial.nsw.gov.au/portal/services",
                   "licence": "CC BY 4.0 (NSW Government open data)"},
        "parcel_url": NSW_LOT_URL,
        "parcel_fields": "lotnumber,sectionnumber,planlabel,lotidstring,Shape__Area",
        "normalize": _norm_nsw,
        "bushfire": nsw_bushfire,
    },
    "ACT": {
        "provider": "ACT Government Blocks (ACTmapi open data)",
        "source": {"label": "ACT Blocks — ACT Government (ArcGIS Hub)",
                   "url": "https://actmapi-actgov.opendata.arcgis.com",
                   "licence": "CC BY 4.0"},
        "parcel_url": ACT_BLOCKS_URL,
        "parcel_fields": "BLOCK_NUMBER,SECTION_NUMBER,BLOCK_SECTION,DIVISION_NAME,"
                         "BLOCK_KEY,PLAN_NUMBERS,BLOCK_DERIVED_AREA,"
                         "LAND_USE_POLICY_ZONES,DISTRICT_NAME",
        "normalize": _norm_act,
        "bushfire": act_bushfire,
    },
    "TAS": {
        "provider": "LIST Cadastral Parcels",
        "source": {"label": "LIST Cadastral Parcels — Land Information System Tasmania",
                   "url": "https://www.thelist.tas.gov.au",
                   "licence": "Creative Commons Attribution (LIST terms)"},
        "parcel_url": TAS_PARCEL_URL,
        "parcel_fields": "PID,VOLUME,FOLIO,MEAS_AREA,PROP_ADD,TENURE_TY",
        "normalize": _norm_tas,
        # flood layers are rasters — overlay only, no point query
    },
    "WA": {
        "provider": "SLIP Property and Planning (LGATE-001)",
        "source": {"label": "WA Cadastre (LGATE-001) — Landgate SLIP public services",
                   "url": "https://services.slip.wa.gov.au/public/rest/services",
                   "licence": "Landgate open data terms"},
        "parcel_url": WA_CADASTRE_URL,
        "parcel_fields": "*",
        "normalize": _norm_wa,
        "bushfire": wa_bushfire,
    },
    "SA": {
        "provider": "Open Land Fabric (national cadastre)",
        "source": {"label": "SA parcels via Open Land Fabric — © Government of "
                            "South Australia",
                   "url": "https://openlandfabric.org/collections/parcels-sa",
                   "licence": "LicenseRef-national-cadastre-2026-10 "
                              "(redistribution with attribution)"},
    },
    "NT": {
        "provider": "Open Land Fabric (national cadastre)",
        "source": {"label": "NT parcels via Open Land Fabric — © Northern "
                            "Territory of Australia",
                   "url": "https://openlandfabric.org/collections/parcels-nt",
                   "licence": "LicenseRef-national-cadastre-2026-10 "
                              "(redistribution with attribution)"},
    },
}


def property_intel(lat, lon, state, force=False):
    state = str(state or "").upper()
    definition = STATE_DEFINITIONS.get(state)
    if definition is None:
        raise ValueError(f"state '{state}' is not supported by this endpoint")

    key = f"{state}:{lat:.4f},{lon:.4f}"
    if not force:
        cached = _cache_get(key)
        if cached is not None:
            return cached

    parcel, geometry = None, None
    zoning = None
    bushfire = None
    flood = None
    errors = []
    if "unavailable" in definition:
        errors.append({"layer": "parcel", "error": definition["unavailable"]})
    else:
        # OLF is the primary national provider (one normalised source for
        # every state); the per-state service below is the fallback.
        olf_result, olf_err = olf.parcel(lat, lon, state)
        if olf_result:
            parcel = olf_result["parcel"]
            geometry = olf_result["geometry"]
        else:
            try:
                attrs, geometry = _esri_point_query(
                    definition["parcel_url"], lat, lon, definition["parcel_fields"])
                parcel = definition["normalize"](attrs) if attrs else None
                if parcel is None and olf_err:
                    errors.append({"layer": "parcel",
                                   "error": f"OLF: {olf_err}; no legacy parcel either"})
            except (requests.RequestException, ValueError, RuntimeError) as exc:
                errors.append({"layer": "parcel",
                               "error": f"OLF: {olf_err or 'unavailable'}; "
                                        f"legacy: {str(exc)[:150]}"})

        z, z_err = olf.zoning(lat, lon, state)
        if z:
            zoning = z
        elif z_err:
            errors.append({"layer": "zoning", "error": z_err})

        bushfire_fn = definition.get("bushfire")
        if bushfire_fn:
            bushfire = bushfire_fn(lat, lon)
            if bushfire.get("prone") is None and bushfire.get("error"):
                errors.append({"layer": "bushfire", "error": bushfire["error"]})

        flood_fn = definition.get("flood")
        if flood_fn:
            flood = flood_fn(lat, lon)
            if flood.get("prone") is None and flood.get("error"):
                errors.append({"layer": "flood", "error": flood["error"]})

    payload = {
        "provider": definition["provider"],
        "jurisdiction": state,
        "coords": {"lat": lat, "lon": lon},
        "parcel": parcel,
        "parcelGeometry": geometry,
        "bushfire": bushfire,
        "flood": flood,
        "zoning": zoning,
        "sources": [definition["source"]],
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "errors": errors,
    }
    _cache_put(key, payload)
    return payload


@bp.get("/state-property")
@auth.require_auth
def state_property():
    if not ratelimit.hit(f"state-intel:{g.user['id']}", 120, 300):
        return jsonify({"ok": False, "error": "too many requests"}), 429
    try:
        lat = float(request.args.get("lat"))
        lon = float(request.args.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "lat and lon are required numbers"}), 400
    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        return jsonify({"ok": False, "error": "lat/lon out of range"}), 400
    state = str(request.args.get("state") or "").strip().upper()
    try:
        return jsonify({"ok": True, "data": property_intel(lat, lon, state)})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502
