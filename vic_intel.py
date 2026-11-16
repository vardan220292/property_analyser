# Copyright (c) 2026 RV
"""
Victorian property parcel intelligence using the public Vicmap Property
ArcGIS FeatureServer. The service is published by Vicmap under CC BY 4.0.

This endpoint returns cadastral/property identifiers and parcel geometry.
It does NOT provide sale history, bedrooms, bathrooms, rent history or a
market valuation; those require separate licensed or statistical sources.
"""
import threading
import time

import requests
from flask import Blueprint, g, jsonify, request

import auth
import ratelimit

bp = Blueprint("vic_intel", __name__, url_prefix="/api/intel")

LAYER_URL = (
    "https://services-ap1.arcgis.com/P744lA0wf4LlBZ84/ArcGIS/rest/services/"
    "Vicmap_Property/FeatureServer/0/query"
)
CACHE_TTL = 12 * 3600
_cache = {}
_lock = threading.Lock()


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


def property_intel(lat, lon):
    key = f"{lat:.4f},{lon:.4f}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    params = {
        "f": "json",
        "geometry": f"{lon},{lat}",
        "geometryType": "esriGeometryPoint",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "prop_ufi,prop_pfi,prop_lga_code,prop_propnum,"
                     "prop_property_type,prop_multi_assessment,prop_status,Shape__Area",
        "returnGeometry": "true",
        "outSR": "4326",
    }
    try:
        response = requests.get(LAYER_URL, params=params, timeout=18,
                                headers={"User-Agent": "RV-PropertyAnalyser/1.0"})
        response.raise_for_status()
        body = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise RuntimeError(f"Vicmap property service unavailable: {exc}") from exc
    if body.get("error"):
        raise RuntimeError("Vicmap property service returned an error")

    features = body.get("features") or []
    feature = features[0] if features else None
    attrs = (feature or {}).get("attributes") or {}
    geometry = (feature or {}).get("geometry")
    area = attrs.get("Shape__Area")
    if area is not None:
        try:
            area = round(float(area), 1)
        except (TypeError, ValueError):
            area = None

    payload = {
        "provider": "Vicmap Property",
        "jurisdiction": "VIC",
        "coords": {"lat": lat, "lon": lon},
        "parcel": ({
            "propertyReference": attrs.get("prop_pfi"),
            "propertyNumber": attrs.get("prop_propnum"),
            "propertyUfi": attrs.get("prop_ufi"),
            "councilCode": attrs.get("prop_lga_code"),
            "propertyTypeCode": attrs.get("prop_property_type"),
            "multiAssessment": attrs.get("prop_multi_assessment"),
            "statusCode": attrs.get("prop_status"),
            "areaSqm": area,
        } if feature else None),
        "parcelGeometry": geometry,
        "sources": [{
            "label": "Vicmap Property — Victorian Government",
            "url": "https://discover.data.vic.gov.au/dataset/vicmap-property-rest-api",
            "licence": "Creative Commons Attribution 4.0 International",
            "note": "Cadastral/property identifiers and parcel polygon",
        }],
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "errors": [],
    }
    _cache_put(key, payload)
    return payload


@bp.get("/vic-property")
@auth.require_auth
def vic_property():
    if not ratelimit.hit(f"vic-intel:{g.user['id']}", 120, 300):
        return jsonify({"ok": False, "error": "too many requests"}), 429
    try:
        lat = float(request.args.get("lat"))
        lon = float(request.args.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "lat and lon are required numbers"}), 400
    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        return jsonify({"ok": False, "error": "lat/lon out of range"}), 400
    try:
        return jsonify({"ok": True, "data": property_intel(lat, lon)})
    except RuntimeError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502
