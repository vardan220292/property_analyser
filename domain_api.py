# Copyright (c) 2026 RV
"""
Address lookup — Domain.com.au developer API, with free fallbacks.

Primary: Domain GET /v1/properties/_suggest (free tier, canonical AU
addresses including unit numbers). Proxied behind the app's own auth so
the browser never sees Domain credentials; the OAuth2 client-credentials
token is cached in memory (single-process dev server).

Fallbacks (no signup): Esri's World Geocoding Service, then Photon.
Esri is the accurate one — it resolves AU house numbers and unit numbers
to a point (Photon is OSM-derived and often lands on the wrong street
in regional towns). Photon is kept as a backstop for streets Esri has
never heard of.

Endpoints:
    GET /api/address/suggest?q=<terms>  -> [{address, domainId, provider, ...}]
    GET /api/address/locate?q=<terms>   -> one best match (or null)
"""

import os
import re
import difflib
import threading
import time

import requests
from flask import Blueprint, jsonify, request

from auth import require_auth
import ratelimit

bp = Blueprint("domain", __name__, url_prefix="/api/address")

TOKEN_URL = "https://auth.domain.com.au/v1/connect/token"
SUGGEST_URL = "https://api.domain.com.au/v1/properties/_suggest"
PHOTON_URL = "https://photon.komoot.io/api/"
# Esri World Geocoding Service. The keyless host serves anonymous calls at
# low volume; PA_ARCGIS_API_KEY switches to the token host.
ARCGIS_URL = ("https://geocode.arcgis.com/arcgis/rest/services/World/"
              "GeocodeServer/findAddressCandidates")
ARCGIS_API_URL = ("https://geocode-api.arcgis.com/arcgis/rest/services/World/"
                  "GeocodeServer/findAddressCandidates")
SCOPE = "api_properties_read"
MAX_RESULTS = 10
HTTP_TIMEOUT = 10
USER_AGENT = "gk-property-analyser/1.0 (personal investment tool; macOS loopback)"

# Suggestion cache: the UI asks on every keystroke, the upstream services
# don't need to hear about it twice.
CACHE_TTL = 12 * 3600
CACHE_MAX = 300

# Soft location bias toward QLD (Photon ranks closer results first).
PHOTON_LAT, PHOTON_LON = -22.5, 145.0

_STATE_ABBR = {
    "Queensland": "QLD", "New South Wales": "NSW", "Victoria": "VIC",
    "South Australia": "SA", "Western Australia": "WA", "Tasmania": "TAS",
    "Australian Capital Territory": "ACT", "Northern Territory": "NT",
}

_token_lock = threading.Lock()
_token_cache = {"token": None, "expires_at": 0.0}

_cache_lock = threading.Lock()
_cache = {}          # cache key -> (expires_at, value)


def _cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
        if not hit:
            return None
        expires_at, value = hit
        if expires_at < time.time():
            _cache.pop(key, None)
            return None
        return value


def _cache_set(key, value):
    with _cache_lock:
        if len(_cache) >= CACHE_MAX:
            oldest = min(_cache.items(), key=lambda kv: kv[1][0])[0]
            _cache.pop(oldest, None)
        _cache[key] = (time.time() + CACHE_TTL, value)


class DomainError(Exception):
    """Upstream Domain API failure; carries the HTTP status to mirror."""

    def __init__(self, message, http_status=502):
        super().__init__(message)
        self.http_status = http_status


def configured():
    return bool(
        os.environ.get("PA_DOMAIN_CLIENT_ID") and os.environ.get("PA_DOMAIN_CLIENT_SECRET")
    )


def _fetch_token():
    try:
        resp = requests.post(
            TOKEN_URL,
            auth=(os.environ["PA_DOMAIN_CLIENT_ID"], os.environ["PA_DOMAIN_CLIENT_SECRET"]),
            data={"grant_type": "client_credentials", "scope": SCOPE},
            timeout=HTTP_TIMEOUT,
        )
    except requests.RequestException as e:
        raise DomainError(f"token request failed: {e}") from e
    if resp.status_code != 200:
        raise DomainError(f"token request returned {resp.status_code}", 502)
    body = resp.json()
    token = body.get("access_token")
    if not token:
        raise DomainError("token response had no access_token")
    _token_cache["token"] = token
    _token_cache["expires_at"] = time.time() + int(body.get("expires_in", 0) or 0) - 60
    return token


def _get_token():
    with _token_lock:
        if _token_cache["token"] and time.time() < _token_cache["expires_at"]:
            return _token_cache["token"]
        return _fetch_token()


def _suggest_raw(terms, token):
    try:
        resp = requests.get(
            SUGGEST_URL,
            headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
            params={"terms": terms, "channel": "All"},
            timeout=HTTP_TIMEOUT,
        )
    except requests.RequestException as e:
        raise DomainError(f"suggest request failed: {e}") from e
    if resp.status_code != 200:
        raise DomainError(f"suggest returned {resp.status_code}", 502)
    items = resp.json()
    if not isinstance(items, list):
        raise DomainError("unexpected suggest response shape")
    return items


def _normalize(item):
    c = item.get("addressComponents") or {}
    return {
        "address": item.get("address") or "",
        "domainId": item.get("id") or "",
        "provider": "domain",
        "unitNumber": c.get("unitNumber") or "",
        "streetNumber": c.get("streetNumber") or "",
        "streetName": c.get("streetName") or "",
        "streetType": c.get("streetType") or "",
        "suburb": c.get("suburb") or "",
        "postcode": c.get("postcode") or "",
        "state": c.get("state") or "",
        # Domain doesn't expose coordinates; the map geocodes via Photon instead.
        "lat": None,
        "lon": None,
    }


def suggest(terms):
    """Fetch and normalize Domain address suggestions. Raises DomainError."""
    raw = _suggest_raw(terms, _get_token())
    out = [_normalize(i) for i in raw]
    return [r for r in out if r["address"]][:MAX_RESULTS]


_UNIT_PREFIX = re.compile(r"^\s*\d+\s*/\s*")


def _strip_unit(q):
    """Photon chokes on AU unit prefixes ('1/50 Oldmill Dr') — drop them."""
    return _UNIT_PREFIX.sub("", q)


def _photon_raw(q):
    q = _strip_unit(q)
    try:
        resp = requests.get(
            PHOTON_URL,
            params={"q": q, "limit": MAX_RESULTS, "lang": "en",
                    "lat": PHOTON_LAT, "lon": PHOTON_LON},
            headers={"User-Agent": USER_AGENT},
            timeout=HTTP_TIMEOUT,
        )
    except requests.RequestException as e:
        raise DomainError(f"photon request failed: {e}") from e
    if resp.status_code != 200:
        raise DomainError(f"photon returned {resp.status_code}", 502)
    try:
        feats = resp.json().get("features") or []
    except ValueError as e:
        raise DomainError("photon returned bad JSON") from e
    out = []
    for f in feats:
        p = f.get("properties") or {}
        if p.get("country") and p["country"] != "Australia":
            continue
        # Street-level hits carry the street in "name" (osm_key highway);
        # house-level hits use "street" + "housenumber".
        street = str(p.get("street") or "").strip()
        if not street and (p.get("osm_key") == "highway" or p.get("type") == "street"):
            street = str(p.get("name") or "").strip()
        if not street:
            continue  # suburb/city-level hits aren't addresses
        housenumber = str(p.get("housenumber") or "").strip()
        unit, num = "", housenumber
        if "/" in housenumber:
            unit, num = (s.strip() for s in housenumber.split("/", 1))
        street_label = (f"{unit}/{num} {street}" if unit else f"{num} {street}").strip()
        # AU OSM: district is the suburb, city the broader town.
        suburb = str(p.get("district") or p.get("city") or p.get("locality") or "").strip()
        state = _STATE_ABBR.get(p.get("state") or "", p.get("state") or "")
        postcode = str(p.get("postcode") or "").strip()
        parts = [x for x in (street_label, suburb, state, postcode) if x]
        # Photon returns [lon, lat]; the map + property intel need both.
        coords = ((f.get("geometry") or {}).get("coordinates") or [None, None])
        lon, lat = (coords[0], coords[1]) if len(coords) > 1 else (None, None)
        out.append({
            "address": ", ".join(parts),
            "domainId": "",
            "provider": "photon",
            "unitNumber": unit,
            "streetNumber": num,
            "streetName": street,
            "streetType": "",
            "suburb": suburb,
            "postcode": postcode,
            "state": state,
            "lat": lat,
            "lon": lon,
        })
    return out


def suggest_any(terms, state=None, lat=None, lon=None, suburb=None):
    """Domain suggestions when configured, Esri + Photon otherwise."""
    if configured():
        return suggest(terms)
    return _merged_suggest(terms, state=state, lat=lat, lon=lon, suburb=suburb)


# --------------------------------------------------------------------------
# Esri World Geocoding Service
# --------------------------------------------------------------------------

# Address types worth showing as a suggestion. Esri labels an AU house
# "PointAddress" (a unit is "Subaddress"); the rest are places, not
# addresses, and only stand in when no street-level hit exists.
_STREET_TYPES = {"PointAddress", "Subaddress", "Street", "Address"}
_PLACE_TYPES = {"POI", "Postal", "PostalLoc", "Locality", "Neighborhood", "Region"}

# Words that carry no meaning when matching a street name against the query.
_GENERIC_WORDS = {
    "street", "road", "avenue", "lane", "drive", "place", "circuit", "terrace",
    "highway", "parade", "court", "esplanade", "boulevard", "close", "way",
    "crescent", "rise", "vista", "walk", "loop", "square", "walkway", "cres",
    "st", "rd", "ave", "ln", "dr", "pl", "cct", "tce", "hwy", "par", "ct", "esq",
}

# State names a user can type, so "14 Main St NSW" doesn't search QLD.
_STATE_TOKENS = {
    "qld": "QLD", "queensland": "QLD", "nsw": "NSW", "new south wales": "NSW",
    "vic": "VIC", "victoria": "VIC", "sa": "SA", "south australia": "SA",
    "wa": "WA", "western australia": "WA", "tas": "TAS", "tasmania": "TAS",
    "nt": "NT", "northern territory": "NT", "act": "ACT",
}


def _state_from_query(q):
    for token in str(q).lower().replace(",", " ").split():
        if token in _STATE_TOKENS:
            return _STATE_TOKENS[token]
    return None


def _arcgis_key():
    return os.environ.get("PA_ARCGIS_API_KEY", "").strip()


def _arcgis_candidates(terms, lat=None, lon=None):
    """Raw Esri candidates for a free-text address. Raises DomainError."""
    key = _arcgis_key()
    url = ARCGIS_API_URL if key else ARCGIS_URL
    params = {
        "SingleLine": terms,
        "f": "json",
        "outFields": "*",
        "maxLocations": MAX_RESULTS,
        "countryCode": "AUS",
    }
    if lat is not None and lon is not None:
        params["location"] = f"{lon},{lat}"  # bias toward the last known point
    if key:
        params["token"] = key
    try:
        resp = requests.get(url, params=params,
                            headers={"User-Agent": USER_AGENT}, timeout=HTTP_TIMEOUT)
    except requests.RequestException as e:
        raise DomainError(f"arcgis request failed: {e}") from e
    if resp.status_code == 403:
        raise DomainError("arcgis rejected the request (403)", 502)
    if resp.status_code != 200:
        raise DomainError(f"arcgis returned {resp.status_code}", 502)
    try:
        body = resp.json()
    except ValueError as e:
        raise DomainError("arcgis returned bad JSON") from e
    if body.get("error"):
        raise DomainError(f"arcgis error {body['error'].get('code')}", 502)
    return body.get("candidates") or []


def _arcgis_item(cand):
    """Map one Esri candidate onto the app's suggestion shape."""
    attrs = cand.get("attributes") or {}
    loc = cand.get("location") or {}
    addr_type = str(attrs.get("Addr_type") or "")
    num = str(attrs.get("AddNum") or "").strip()
    st_name = str(attrs.get("StName") or "").strip()
    st_type = str(attrs.get("StType") or "").strip()
    unit = str(attrs.get("UnitName") or "").strip()
    place = str(attrs.get("PlaceName") or "").strip()
    street = " ".join(x for x in (st_name, st_type) if x)
    suburb = str(attrs.get("Nbrhd") or attrs.get("City") or "").strip()
    region = str(attrs.get("Region") or "").strip()
    state = str(attrs.get("RegionAbbr") or "").strip() or _STATE_ABBR.get(region, region)
    postcode = str(attrs.get("Postal") or "").strip()
    if addr_type == "POI" and place:
        # A place is named after the place, not after the street it sits on.
        st_name = place
        label = place
    else:
        label = " ".join(x for x in (num, street) if x)
    if unit and label:
        label = f"{unit}/{label}"
    parts = [x for x in (label, suburb, state, postcode) if x]
    return {
        "address": ", ".join(parts) or str(cand.get("address") or ""),
        "domainId": "",
        "provider": "arcgis",
        "unitNumber": unit,
        "streetNumber": num,
        "streetName": st_name,
        "streetFull": str(attrs.get("StAddr") or "").strip(),
        "streetType": st_type,
        "suburb": suburb,
        "postcode": postcode,
        "state": state,
        "lat": loc.get("y"),
        "lon": loc.get("x"),
        "score": cand.get("score"),
        "addressType": addr_type,
    }


def _with_suburb(terms, suburb):
    """Esri cannot place a street without a locality, and the gazetteer
    spells things differently ("Fawlers St" is "Fowler Street"). Appending
    the suburb the user is working in turns a bare street into a match."""
    if not suburb:
        return terms
    words = {w.strip(".,").lower() for w in str(suburb).split() if len(w.strip(".,")) > 2}
    qwords = {w.strip(".,").lower() for w in str(terms).split()}
    if words & qwords:
        return terms  # the query already names it
    return f"{terms} {suburb}"


def _arcgis_items(terms, state=None, lat=None, lon=None, street_only=False,
                  suburb=None):
    """Normalised Esri suggestions: street-level hits, state-preferred."""
    query_state = _state_from_query(terms)
    scenario_state = (state or "").upper() or None
    # A state named in the query is the user being explicit, so filter to it.
    # A scenario-level state is only a hint — the PPOR can sit in another
    # state entirely, and a hard filter would hide the only good answer.
    wanted = query_state or scenario_state
    cands = _arcgis_candidates(_with_suburb(terms, suburb), lat=lat, lon=lon)
    items = [_arcgis_item(c) for c in cands]

    if wanted:
        same = [i for i in items if (i.get("state") or "").upper() == wanted]
        if same:
            if query_state:
                items = same
            else:
                items = same + [i for i in items if i not in same]

    street = [i for i in items
              if (i["addressType"] in _STREET_TYPES
                  or (i["addressType"] == "POI" and i["streetNumber"]))
              and (i.get("score") or 0) >= 70
              and _street_matches_query(i, terms)]
    if street:
        return street[:MAX_RESULTS]
    if street_only:
        # A bare house number ("8 atkinson close") needs the street first.
        return _arcgis_number_fallback(terms, wanted, query_state, lat, lon,
                                        want_house=True, suburb=suburb)
    place = [i for i in items if i["addressType"] in _PLACE_TYPES]
    fallback = _arcgis_number_fallback(terms, wanted, query_state, lat, lon,
                                        suburb=suburb)
    if fallback and _LEADING_NUMBER.match(str(terms or "")):
        # The user typed a house number: streets beat a locality centroid.
        return (fallback + place)[:MAX_RESULTS]
    if place:
        return place[:5]
    return (fallback or items)[:MAX_RESULTS]


_LEADING_NUMBER = re.compile(r"^\s*(\d+[A-Za-z]?(?:/\d+[A-Za-z]?)?)\s+(.+)$")


def _arcgis_number_fallback(terms, wanted=None, hard=False, lat=None, lon=None,
                             want_house=False, suburb=None):
    """Resolve a bare house number by finding the street first.

    Esri will not place "8 atkinson close" on its own — it wants a locality.
    But "atkinson close" returns the street, so look the street up and then
    ask Esri for the number on it.
    """
    m = _LEADING_NUMBER.match(str(terms or ""))
    if not m:
        return []
    num, rest = m.group(1), m.group(2)
    try:
        cands = _arcgis_candidates(_with_suburb(rest, suburb))
    except DomainError:
        return []
    streets = []
    for c in cands:
        item = _arcgis_item(c)
        if item["addressType"] not in ("StreetName", "Street", "Address"):
            continue
        if (item.get("score") or 0) < 70:
            continue
        if not _street_matches_query(item, terms):
            continue
        streets.append(item)
    if not streets:
        return []
    if wanted:
        same = [i for i in streets if (i.get("state") or "").upper() == wanted]
        if same:
            if hard:
                streets = same
            else:
                streets = same + [i for i in streets if i not in same]

    if want_house:
        # Only one street the user could have meant? Put the number on it.
        # Anything else would point the map at a street they never named.
        if len(streets) != 1:
            return []
        st = streets[0]
        query = " ".join(x for x in (num, st.get("streetName"), st.get("streetType"),
                                     st.get("suburb"), st.get("state")) if x)
        try:
            for c in _arcgis_candidates(query):
                item = _arcgis_item(c)
                if (item["addressType"] in _STREET_TYPES
                        and (item.get("score") or 0) >= 70
                        and _street_matches_query(item, terms)):
                    return [item]
        except DomainError:
            pass
        return [_street_with_number(st, num)]

    # Suggestion mode: every street that could be it, with the house number
    # the user typed so the label still reads like their address. The house
    # point is looked up when the user picks one — one request per keystroke
    # keeps the dropdown quick.
    return [_street_with_number(st, num) for st in streets[:5]]


def _street_with_number(st, num):
    """Label a street-level hit with the house number the user typed."""
    label = " ".join(x for x in (num, st.get("streetName"), st.get("streetType"))
                     if x)
    st["address"] = ", ".join(x for x in (label, st.get("suburb"),
                                          st.get("state"), st.get("postcode"))
                              if x)
    return st


def _query_words(q):
    return [w.strip(".,").lower() for w in str(q).split() if len(w.strip(".,")) > 2]


def _similar(a, b):
    """Loose word match — the gazetteer spells "Fawlers St" as "Fowler"."""
    a = a.strip(".,").lower()
    b = b.strip(".,").lower()
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.72


def _street_matches_query(item, q):
    """True when a candidate is about a street the user actually typed."""
    qwords = _query_words(q)
    if not qwords:
        return True
    street = item.get("streetName") or item.get("streetFull") or ""
    cwords = {w.strip(".,").lower()
              for w in str(street).split()
              if len(w.strip(".,")) > 2}
    cwords -= _GENERIC_WORDS
    if not cwords:
        return True  # nothing to compare (a place, not a street)
    return any(_similar(qw, cw) for qw in qwords for cw in cwords)


def _suburb_matches_query(item, q):
    """True when a candidate sits in a place the user named."""
    suburb = str(item.get("suburb") or "").strip()
    if not suburb:
        return True
    qwords = _query_words(q)
    subwords = [w.strip(".,").lower() for w in suburb.split() if len(w.strip(".,")) > 2]
    if not subwords or not qwords:
        return True
    return any(_similar(qw, sw) for qw in qwords for sw in subwords)


def _photon_matches_query(item, q, check_suburb=True):
    """True when a Photon hit is about a street the user actually typed.

    Photon's AU coverage is patchy — asking it for an unknown street
    happily returns unrelated streets in the same suburb, which is how
    the map ended up pointing at the wrong parcel. Those hits are dropped
    unless their street AND suburb both match the query.
    """
    if not _street_matches_query(item, q):
        return False
    if check_suburb:
        return _suburb_matches_query(item, q)
    return True


def _query_house_number(q):
    """The house number the user typed, if any ("8", "6/14")."""
    m = _LEADING_NUMBER.match(str(q or ""))
    return m.group(1) if m else ""


def _place_ranks(places):
    """Esri's significance rank per place name (lower = more important).

    "8 atkinson close" exists in several Australian suburbs, so the most
    significant match is the one most likely meant.
    """
    names = [p for p in dict.fromkeys(places) if p]
    if not names:
        return {}
    try:
        cands = _arcgis_candidates(", ".join(names))
    except DomainError:
        return {}
    ranks = {}
    for c in cands:
        a = c.get("attributes") or {}
        if a.get("Addr_type") != "Locality":
            continue
        name = str(a.get("PlaceName") or a.get("City") or "").strip().lower()
        r = a.get("Rank")
        if not name or r is None:
            continue
        try:
            r = float(r)
        except (TypeError, ValueError):
            continue
        if name not in ranks or r < ranks[name]:
            ranks[name] = r
    return ranks


def _photon_house_candidates(terms):
    """Photon's house-level hits for a typed address.

    Esri needs a locality to place anything; Photon (OSM) will place a
    bare house number and street, which is how a PPOR typed as
    "8 atkinson close" can be found at all.
    """
    try:
        hits = _photon_raw(terms)
    except DomainError:
        return []
    num = _query_house_number(terms)
    out = []
    for p in hits:
        if num:
            if p.get("streetNumber") != num:
                continue
        elif not p.get("streetNumber"):
            continue
        if not _street_matches_query(p, terms):
            continue
        out.append(p)
    return out


def _rank_by_place(cands):
    """Put the most significant place first."""
    if len(cands) < 2:
        return cands
    ranks = _place_ranks(
        [f"{c.get('suburb') or ''} {c.get('state') or ''}".strip() for c in cands])
    if not ranks:
        return cands
    return sorted(cands, key=lambda c: ranks.get((c.get("suburb") or "").strip().lower(), 99))


def _merged_suggest(terms, state=None, lat=None, lon=None, suburb=None):
    """Esri first, Photon as a backstop. Photon noise is filtered out."""
    items = []
    arcgis_error = None
    try:
        items = _arcgis_items(terms, state=state, lat=lat, lon=lon, suburb=suburb)
    except DomainError as e:
        arcgis_error = e
    try:
        photon = _photon_raw(terms)
    except DomainError as e:
        if arcgis_error:
            raise arcgis_error
        photon = []
    extra = [p for p in photon if _photon_matches_query(p, terms)]
    # A bare house number ("8 atkinson close") has no suburb to check
    # against, so let Photon's house-level hits through on the number.
    num = _query_house_number(terms)
    if num:
        for p in photon:
            if (p.get("streetNumber") == num
                    and _street_matches_query(p, terms)
                    and not any(e["address"] == p["address"] for e in extra)):
                extra.append(p)
    extra = _rank_by_place(extra)
    # When Esri could only place the street, Photon's house hits are the
    # better answer — and they are ranked by how significant the place is.
    if items and extra and not any(i.get("streetNumber") for i in items):
        merged = extra + items
    else:
        merged = items + extra
    # De-duplicate on the displayed address, keeping the best hit: a
    # house-level match beats a street-level one for the same address.
    seen, out = {}, []
    for it in merged:
        key = it["address"].lower().strip()
        if not key:
            continue
        prev = seen.get(key)
        if prev is None:
            seen[key] = [len(out), it]
            out.append(it)
        elif not prev[1].get("streetNumber") and it.get("streetNumber"):
            out[prev[0]] = it
            prev[1] = it
    return out[:MAX_RESULTS]


def locate(terms, state=None, lat=None, lon=None, suburb=None):
    """Best single STREET match for a full address, or None."""
    cache_key = "loc:" + terms.lower().strip() + "|" + (state or "") + "|" + (suburb or "") + "|" + str((lat, lon))
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    item = None
    try:
        items = _arcgis_items(terms, state=state, lat=lat, lon=lon,
                              street_only=True, suburb=suburb)
        if items:
            item = items[0]
    except DomainError:
        item = None
    if item is None:
        # Esri could not place it (no locality in the query) — Photon can.
        cands = _photon_house_candidates(terms)
        if state:
            same = [p for p in cands if (p.get("state") or "").upper() == state]
            if same:
                cands = same
        if cands:
            item = _rank_by_place(cands)[0]
    _cache_set(cache_key, item)
    return item


def _hint_args():
    """Optional state + suburb + map bias from the query string."""
    state = (request.args.get("state") or "").strip().upper() or None
    suburb = (request.args.get("suburb") or "").strip() or None
    lat = _float_arg(request.args.get("lat"))
    lon = _float_arg(request.args.get("lon"))
    return state, suburb, lat, lon


def _float_arg(v):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if -90 <= n <= 90 else None


@bp.get("/suggest")
@require_auth
def suggest_route():
    q = (request.args.get("q") or "").strip()
    if len(q) < 3 or len(q) > 100:
        return jsonify({"ok": False, "error": "q must be 3-100 characters"}), 400
    if not ratelimit.hit(f"addr-sug:{request.remote_addr}", 120, 300):
        return jsonify({"ok": False, "error": "too many lookups — wait a moment"}), 429
    state, suburb, lat, lon = _hint_args()
    cache_key = "sug:" + q.lower().strip() + "|" + (state or "") + "|" + (suburb or "") + "|" + str((lat, lon))
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify({"ok": True, "data": cached})
    try:
        items = suggest_any(q, state=state, lat=lat, lon=lon, suburb=suburb)
    except DomainError as e:
        return jsonify({"ok": False, "error": f"address lookup failed: {e}"}), e.http_status
    _cache_set(cache_key, items)
    return jsonify({"ok": True, "data": items})


@bp.get("/locate")
@require_auth
def locate_route():
    q = (request.args.get("q") or "").strip()
    if len(q) < 4 or len(q) > 120:
        return jsonify({"ok": False, "error": "q must be 4-120 characters"}), 400
    if not ratelimit.hit(f"addr-loc:{request.remote_addr}", 60, 300):
        return jsonify({"ok": False, "error": "too many lookups — wait a moment"}), 429
    state, suburb, lat, lon = _hint_args()
    try:
        item = locate(q, state=state, lat=lat, lon=lon, suburb=suburb)
    except DomainError as e:
        return jsonify({"ok": False, "error": f"address lookup failed: {e}"}), e.http_status
    return jsonify({"ok": True, "data": item})
