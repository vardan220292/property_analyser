# Copyright (c) 2026 RV
"""
Open Land Fabric client (https://openlandfabric.org) — the national
parcel/zoning provider behind state_intel for the six states without a
deep QLD/VIC-style integration.

Keyless OGC API – Features over GeoJSON. Per-feature `licence` and
`attribution` fields travel with every record and are surfaced to the UI;
SA/NT parcels carry `LicenseRef-national-cadastre-2026-10`, which permits
redistribution with attribution (per the service's licence register).

Degraded mode: every public function returns (result|None, error|None)
and never raises — a dead OLF must fall back to the legacy per-state
endpoints, not break property intelligence.
"""
import requests

OLF = "https://openlandfabric.org"
TIMEOUT = 20
UA = {"User-Agent": "RV-PropertyAnalyser/1.0"}


def _get_json(url, params):
    try:
        r = requests.get(url, params=params, timeout=TIMEOUT, headers=UA)
        if r.status_code != 200:
            return None, f"OLF HTTP {r.status_code}"
        return r.json(), None
    except (requests.RequestException, ValueError) as exc:
        return None, str(exc)[:180]


def _items(collection, lat, lon):
    """Point-bbox query on one collection. Returns (feature|None, error)."""
    d, err = _get_json(
        f"{OLF}/collections/{collection}/items",
        {"bbox": f"{lon - 0.003:.6f},{lat - 0.003:.6f},"
                 f"{lon + 0.003:.6f},{lat + 0.003:.6f}",
         "limit": 1, "f": "json"})
    if err:
        return None, err
    features = d.get("features") or []
    return (features[0] if features else None), None


def _num(v):
    try:
        f = float(v)
        return f if f == f and abs(f) != float("inf") else None
    except (TypeError, ValueError):
        return None


def parcel(lat, lon, state):
    """Parcel polygon + identifiers for one state. Returns
    ({"parcel":…, "geometry":…}|None, error|None)."""
    st = str(state or "").strip().lower()
    feature, err = _items(f"parcels-{st}", lat, lon)
    if err:
        return None, err
    if not feature:
        return None, None
    attrs = feature.get("properties") or {}
    geometry = (feature.get("geometry") or {}).get("coordinates")
    lot = attrs.get("lot") or attrs.get("parcel_label")
    plan = attrs.get("plan_number")
    pid = f"Lot {lot} {plan}" if lot and plan else (lot or attrs.get("source_parcel_id"))
    title = attrs.get("title_folio") or attrs.get("title_volume")
    parcel = {
        "id": pid,
        "areaSqm": _num(attrs.get("area_stated_m2")),
        "locality": attrs.get("locality") or attrs.get("lga_name"),
        "extra": {
            "lotNumber": lot,
            "planNumber": plan,
            "title": title,
            "lgaName": attrs.get("lga_name"),
            "confidence": attrs.get("confidence"),
            "tenureSource": attrs.get("tenure_source"),
        },
    }
    return ({"parcel": parcel, "geometry": geometry,
             "licence": attrs.get("licence"),
             "attribution": attrs.get("attribution"),
             "source_updated_at": attrs.get("source_updated_at")}, None)


def zoning(lat, lon, state):
    """State zoning overlay at the point.
    Returns ({category, name, licence}|None, error|None)."""
    st = str(state or "").strip().lower()
    feature, err = _items(f"overlay-{st}-zoning", lat, lon)
    if err:
        return None, err
    if not feature:
        return None, None
    attrs = feature.get("properties") or {}
    return ({"category": attrs.get("category") or attrs.get("zone"),
             "name": attrs.get("name") or attrs.get("zone_name"),
             "licence": attrs.get("licence") or attrs.get("licence_url")}, None)
