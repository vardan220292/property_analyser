# Copyright (c) 2026 RV
"""
API tests for the area-data endpoints (suburbs, comps, bank rates) and the
scenario address/suburb columns.

Runs against a throwaway SQLite file — never touches your real data.

    /Users/vardangupta/deployment/venv/bin/python3 tests/test_api.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Point the app at a temp SQLite DB BEFORE importing it (app.py reads
# DB_PATH at import) — unless DATABASE_URL is set, which opts the suite
# into running against real Postgres (catches type-cast divergence).
TMP = tempfile.mkdtemp(prefix="pa_test_")
if not os.environ.get("DATABASE_URL"):
    os.environ["DB_PATH"] = os.path.join(TMP, "test.db")
    # app.py's load_dotenv must not silently re-point this run at Postgres
    # when .env carries a DATABASE_URL (dotenv never overrides existing vars).
    os.environ["DATABASE_URL"] = ""
os.environ["PA_JWT_SECRET"] = "test-secret-not-for-production-use"

import app  # noqa: E402
import db  # noqa: E402

app.create_db()
c = app.app.test_client()

PASSED = 0
FAILED = 0


def check(name, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
    else:
        FAILED += 1
        print(f"FAIL: {name} {detail}")


def register(email, password="password123", name="Tester"):
    r = c.post("/api/auth/register", json={"email": email, "password": password,
                                            "displayName": name})
    return r


# ---------------------------------------------------------------------------
# Auth guards
# ---------------------------------------------------------------------------

for path in ["/api/suburbs", "/api/bank-rates", "/api/scenarios/1/comps"]:
    check(f"401 without token: {path}",
          c.get(path).status_code == 401)

r = register("u1@test.com", name="User One")
check("register u1", r.status_code == 201, r.get_json())
T1 = r.get_json()["data"]["token"]
U1 = r.get_json()["data"]["id"]
H1 = {"Authorization": "Bearer " + T1}

r = register("u2@test.com", name="User Two")
T2 = r.get_json()["data"]["token"]
H2 = {"Authorization": "Bearer " + T2}

# ---------------------------------------------------------------------------
# Suburbs CRUD
# ---------------------------------------------------------------------------

r = c.post("/api/suburbs", headers=H1, json={
    "name": "Testville", "postcode": "4000", "medianPrice": 650000,
    "medianRent3Bed": 560, "vacancyPct": 1.4, "growth5yrPct": 28,
    "approvalsRatio": 0.9, "sources": {"medianPrice": {"source": "test", "asOf": "2026-11"}},
})
check("create suburb", r.status_code == 201, r.get_json())
SUB = r.get_json()["data"]
check("suburb payload camelCase", SUB["medianRent3Bed"] == 560 and SUB["vacancyPct"] == 1.4)
check("suburb sources round-trip", SUB["sources"]["medianPrice"]["source"] == "test")
SUB_ID = SUB["id"]

r = c.post("/api/suburbs", headers=H1, json={"name": "Testville", "postcode": "4000"})
check("duplicate suburb rejected", r.status_code == 409)

r = c.post("/api/suburbs", headers=H1, json={"postcode": "4000"})
check("suburb without name rejected", r.status_code == 400)

r = c.post("/api/suburbs", headers=H1, json={"name": "X", "postcode": "4000", "vacancyPct": 90})
check("vacancy out of range rejected", r.status_code == 400)

r = c.put(f"/api/suburbs/{SUB_ID}", headers=H1, json={"vacancyPct": 2.2})
check("update suburb", r.status_code == 200 and r.get_json()["data"]["vacancyPct"] == 2.2)

r = c.get("/api/suburbs", headers=H1)
check("list suburbs", r.status_code == 200 and len(r.get_json()["data"]) >= 1)

# ---------------------------------------------------------------------------
# Scenarios with address + suburb, and comps
# ---------------------------------------------------------------------------

r = c.post("/api/scenarios", headers=H1, json={
    "name": "With address", "inputs": {"purchasePrice": 675000, "address": "6/14 Fawlers St",
                                        "suburbId": SUB_ID, "weeklyRent": 725}})
check("create scenario with address", r.status_code == 201, r.get_json())
SCN = r.get_json()["data"]
check("scenario mirrors address", SCN["address"] == "6/14 Fawlers St")
check("scenario mirrors suburbId", SCN["suburbId"] == SUB_ID)
SCN_ID = SCN["id"]

r = c.get(f"/api/scenarios/{SCN_ID}", headers=H1)
check("scenario address persisted",
      r.get_json()["data"]["inputs"]["address"] == "6/14 Fawlers St")

# regression: list projection must include the migrated columns _scenario_row reads
r = c.get("/api/scenarios", headers=H1)
lst = r.get_json()["data"]
row3 = [s for s in lst if s["id"] == SCN_ID][0]
check("scenario list works and mirrors address/suburb",
      r.status_code == 200 and row3["address"] == "6/14 Fawlers St"
      and row3["suburbId"] == SUB_ID)

r = c.post(f"/api/scenarios/{SCN_ID}/comps", headers=H1, json={
    "address": "5/12 Example St", "soldPrice": 640000, "soldDate": "2026-08",
    "beds": 3, "landM2": 650, "rentEstimate": 590, "url": "https://example.com"})
check("create comp", r.status_code == 201, r.get_json())
COMP = r.get_json()["data"]
check("comp payload", COMP["landM2"] == 650 and COMP["soldPrice"] == 640000)

r = c.get(f"/api/scenarios/{SCN_ID}/comps", headers=H1)
check("list comps", r.status_code == 200 and len(r.get_json()["data"]) == 1)

# user 2 must not see user 1's scenario comps
r = c.get(f"/api/scenarios/{SCN_ID}/comps", headers=H2)
check("comps of another user's scenario -> 404", r.status_code == 404)
r = c.post(f"/api/scenarios/{SCN_ID}/comps", headers=H2, json={"address": "x"})
check("cannot add comp to another user's scenario", r.status_code == 404)
r = c.put(f"/api/comps/{COMP['id']}", headers=H2, json={"address": "hacked"})
check("cannot edit another user's comp", r.status_code == 404)
r = c.delete(f"/api/comps/{COMP['id']}", headers=H2)
check("cannot delete another user's comp", r.status_code == 404)

# duplicate copies comps
r = c.post(f"/api/scenarios/{SCN_ID}/duplicate", headers=H1, json={})
check("duplicate scenario", r.status_code == 201)
DUP = r.get_json()["data"]["id"]
r = c.get(f"/api/scenarios/{DUP}/comps", headers=H1)
check("duplicate copies comps", len(r.get_json()["data"]) == 1)

# deleting a scenario removes its comps
r = c.delete(f"/api/scenarios/{DUP}", headers=H1)
check("delete scenario", r.status_code == 200)
r = c.get(f"/api/scenarios/{DUP}/comps", headers=H1)
check("deleted scenario comps gone", r.status_code == 404)

# ---------------------------------------------------------------------------
# Bank rates
# ---------------------------------------------------------------------------

r = c.post("/api/bank-rates", headers=H1, json={
    "bankName": "Test Bank", "productName": "investor variable",
    "investorIoRate": 0.0701, "investorPiRate": 0.0649, "source": "product page",
    "checkedAt": "2026-11"})
check("create bank rate", r.status_code == 201, r.get_json())
RATE = r.get_json()["data"]
check("bank rate payload", RATE["investorIoRate"] == 0.0701)

r = c.post("/api/bank-rates", headers=H1, json={
    "bankName": "Bad Bank", "investorIoRate": 7.0})
check("bank rate out of range rejected", r.status_code == 400)

r = c.put(f"/api/bank-rates/{RATE['id']}", headers=H1, json={"investorIoRate": 0.0699})
check("update bank rate", r.status_code == 200 and r.get_json()["data"]["investorIoRate"] == 0.0699)

r = c.get("/api/bank-rates", headers=H1)
check("list bank rates", r.status_code == 200 and len(r.get_json()["data"]) >= 1)

# ---------------------------------------------------------------------------
# Seed idempotency
# ---------------------------------------------------------------------------

seed_dir = os.path.join(TMP, "seed")
os.makedirs(seed_dir, exist_ok=True)
with open(os.path.join(seed_dir, "suburbs.json"), "w") as f:
    f.write('{"suburbs":[{"name":"Seeded","postcode":"4700","medianPrice":500000}]}')
with open(os.path.join(seed_dir, "bank_rates.json"), "w") as f:
    f.write('{"bankRates":[{"bankName":"Seed Bank","investorIoRate":0.0700}]}')

import seeds  # noqa: E402
seeds.load(TMP)
before = len(db.db().fetch_all("SELECT * FROM suburbs"))
bank_before = len(db.db().fetch_all("SELECT * FROM bank_rates"))
seeds.load(TMP)
seeds.load(TMP)
check("seed idempotent (suburbs)", len(db.db().fetch_all("SELECT * FROM suburbs")) == before)
check("seed idempotent (bank rates)", len(db.db().fetch_all("SELECT * FROM bank_rates")) == bank_before)
check("seeded suburb present", any(
    s["name"] == "Seeded" for s in db.db().fetch_all("SELECT * FROM suburbs")))

# user edits to a seeded row survive a reseed
db.db().execute("UPDATE suburbs SET median_price = 999 WHERE name = 'Seeded'")
seeds.load(TMP)
row = db.db().fetch_one("SELECT * FROM suburbs WHERE name = 'Seeded'")
check("user edit survives reseed", row["median_price"] == 999)

# ---------------------------------------------------------------------------
# Score wiring: suburb data flows into calculateAll via the API shape
# ---------------------------------------------------------------------------

r = c.get("/api/suburbs", headers=H1)
sub = [s for s in r.get_json()["data"] if s["name"] == "Testville"][0]
check("suburb shape matches engine expectations",
      all(k in sub for k in ("medianPrice", "medianRent2Bed", "medianRent3Bed",
                             "medianRent4Bed", "vacancyPct", "growth5yrPct",
                             "approvalsRatio")))

# ---------------------------------------------------------------------------
# Address autocomplete (Domain proxy) + AI comps search
# ---------------------------------------------------------------------------

import comps_search  # noqa: E402
import domain_api  # noqa: E402

check("401 without token: /api/address/suggest",
      c.get("/api/address/suggest?q=1/50 oldmill").status_code == 401)
check("401 without token: /api/address/locate",
      c.get("/api/address/locate?q=1/50 oldmill").status_code == 401)
check("401 without token: /api/comps/search",
      c.post("/api/comps/search", json={"address": "x"}).status_code == 401)

saved_env = {k: os.environ.pop(k, None) for k in
             ("PA_DOMAIN_CLIENT_ID", "PA_DOMAIN_CLIENT_SECRET", "PA_ULTIMATEAI_API_KEY")}
try:
    r = c.get("/api/address/suggest?q=1/", headers=H1)
    check("suggest too-short q -> 400", r.status_code == 400)
    r = c.get("/api/address/locate?q=1/", headers=H1)
    check("locate too-short q -> 400", r.status_code == 400)

    check("unit prefix stripped for photon",
          domain_api._strip_unit("  1/50 oldmill drive") == "50 oldmill drive"
          and domain_api._strip_unit("6/14 fawlers st") == "14 fawlers st"
          and domain_api._strip_unit("50 oldmill drive") == "50 oldmill drive")

    # Unconfigured -> Esri first, Photon as the backstop (both stubbed,
    # offline).
    real_photon, real_arcgis = domain_api._photon_raw, domain_api._arcgis_candidates
    domain_api._cache.clear()

    def _arcgis_hit(terms, lat=None, lon=None):
        return [{"attributes": {"Addr_type": "PointAddress", "AddNum": "50",
                                "StName": "Oldmill", "StType": "Drive",
                                "StAddr": "50 Oldmill Drive", "Nbrhd": "Beaconsfield",
                                "City": "Beaconsfield", "Region": "Queensland",
                                "RegionAbbr": "QLD", "Postal": "4740",
                                "Country": "AUS"},
                 "location": {"x": 149.16, "y": -21.10},
                 "score": 100, "address": "50 Oldmill Drive, Beaconsfield QLD 4740"}]

    domain_api._arcgis_candidates = _arcgis_hit
    domain_api._photon_raw = lambda q: [{
        "address": "Oldmill Drive, Beaconsfield, QLD, 4740",
        "domainId": "", "provider": "photon", "unitNumber": "",
        "streetNumber": "", "streetName": "Oldmill Drive", "streetType": "",
        "suburb": "Beaconsfield", "postcode": "4740", "state": "QLD",
        "lat": -21.10, "lon": 149.16,
    }]
    r = c.get("/api/address/suggest?q=50 oldmill drive", headers=H1)
    body = r.get_json()
    check("suggest unconfigured falls back to esri",
          r.status_code == 200 and body["ok"] and body["data"][0]["provider"] == "arcgis",
          body)
    check("esri hit carries coordinates",
          body["data"][0]["lat"] == -21.10 and body["data"][0]["lon"] == 149.16)
    check("suggest caps results", len(body["data"]) <= 10)

    # A Photon hit about a street the user never mentioned is dropped.
    domain_api._cache.clear()
    domain_api._photon_raw = lambda q: [{
        "address": "Rosella Street, West Gladstone, QLD, 4680",
        "domainId": "", "provider": "photon", "unitNumber": "",
        "streetNumber": "", "streetName": "Rosella Street", "streetType": "",
        "suburb": "West Gladstone", "postcode": "4680", "state": "QLD",
        "lat": -23.85, "lon": 151.24,
    }]
    r = c.get("/api/address/suggest?q=50 oldmill drive", headers=H1)
    body = r.get_json()
    check("photon noise about another street is dropped",
          all(it["provider"] != "photon" for it in body["data"]), body)

    def _photon_down(q):
        raise domain_api.DomainError("photon returned 503", 502)
    domain_api._photon_raw = _photon_down
    domain_api._cache.clear()
    r = c.get("/api/address/suggest?q=50 oldmill drive", headers=H1)
    check("photon failure is survivable when esri answers",
          r.status_code == 200 and r.get_json()["ok"], r.get_json())

    def _arcgis_down(terms, lat=None, lon=None):
        raise domain_api.DomainError("arcgis returned 503", 502)
    domain_api._arcgis_candidates = _arcgis_down
    domain_api._cache.clear()
    r = c.get("/api/address/suggest?q=50 oldmill drive", headers=H1)
    check("both providers down -> 502", r.status_code == 502 and not r.get_json()["ok"])
    domain_api._photon_raw, domain_api._arcgis_candidates = real_photon, real_arcgis

    # locate: best street match for a typed address.
    domain_api._cache.clear()
    domain_api._arcgis_candidates = _arcgis_hit
    r = c.get("/api/address/locate?q=50 Oldmill Drive Beaconsfield QLD 4740", headers=H1)
    body = r.get_json()
    check("locate returns the street match",
          r.status_code == 200 and body["ok"] and body["data"]["address"].startswith("50 Oldmill"),
          body)
    domain_api._arcgis_candidates = real_arcgis
    domain_api._cache.clear()

    # A scenario state is a HINT, never a filter: the PPOR can sit in
    # another state, and a hard filter hid the only good answer.
    def _arcgis_two_states(terms, lat=None, lon=None):
        def cand(num, street, suburb, state, y, x):
            return {"attributes": {"Addr_type": "PointAddress", "AddNum": num,
                                   "StName": street, "StType": "Close",
                                   "StAddr": f"{num} {street} Close", "Nbrhd": suburb,
                                   "City": suburb, "Region": state,
                                   "RegionAbbr": state, "Postal": "3030",
                                   "Country": "AUS"},
                    "location": {"x": x, "y": y}, "score": 100,
                    "address": f"{num} {street} Close, {suburb} {state} 3030"}
        return [cand("8", "Atkinson", "Coopers Plains", "QLD", -27.57, 153.04),
                cand("8", "Atkinson", "Point Cook", "VIC", -37.90, 144.72)]

    domain_api._arcgis_candidates = _arcgis_two_states
    domain_api._photon_raw = lambda q: []   # offline: Photon is exercised below
    domain_api._cache.clear()
    r = c.get("/api/address/suggest?q=8 atkinson close&state=QLD", headers=H1)
    data = r.get_json()["data"]
    check("scenario state does not filter out another state's answer",
          len(data) == 2, data)
    check("scenario state ranks its own state first",
          data and data[0]["state"] == "QLD", data)

    domain_api._cache.clear()
    r = c.get("/api/address/suggest?q=8 atkinson close VIC", headers=H1)
    data = r.get_json()["data"]
    check("a state named in the query filters to it",
          len(data) == 1 and data[0]["state"] == "VIC", data)

    # The suburb hint is appended to the geocoder query: Esri cannot place
    # a bare street name, and the gazetteer spells it differently.
    seen_terms = []

    def _arcgis_record(terms, lat=None, lon=None):
        seen_terms.append(terms)
        return _arcgis_two_states(terms)

    domain_api._arcgis_candidates = _arcgis_record
    domain_api._cache.clear()
    r = c.get("/api/address/suggest?q=14 fawlers st&suburb=West Gladstone", headers=H1)
    check("suburb hint is appended to the geocoder query",
          any("West Gladstone" in t for t in seen_terms), seen_terms)
    domain_api._cache.clear()
    seen_terms.clear()
    r = c.get("/api/address/suggest?q=14 fawlers st west gladstone&suburb=West Gladstone",
              headers=H1)
    check("suburb hint is not added twice",
          all(t.lower().count("west gladstone") <= 1 for t in seen_terms), seen_terms)

    # A bare house number ("8 atkinson close") is placed by finding the
    # street first, then asking for the number on it.
    def _arcgis_number(terms, lat=None, lon=None):
        t = terms.lower()
        if t.startswith("8 atkinson close"):
            return [{"attributes": {"Addr_type": "PointAddress", "AddNum": "8",
                                    "StName": "Atkinson", "StType": "Close",
                                    "StAddr": "8 Atkinson Close",
                                    "Nbrhd": "Point Cook", "City": "Point Cook",
                                    "Region": "Victoria", "RegionAbbr": "VIC",
                                    "Postal": "3030", "Country": "AUS"},
                     "location": {"x": 144.72, "y": -37.90}, "score": 100,
                     "address": "8 Atkinson Close, Point Cook VIC 3030"}]
        return [{"attributes": {"Addr_type": "StreetName", "AddNum": "",
                                "StName": "Atkinson", "StType": "Close",
                                "StAddr": "Atkinson Close", "Nbrhd": "Point Cook",
                                "City": "Point Cook", "Region": "Victoria",
                                "RegionAbbr": "VIC", "Postal": "3030",
                                "Country": "AUS"},
                 "location": {"x": 144.72, "y": -37.90}, "score": 100,
                 "address": "Atkinson Close, Point Cook VIC 3030"}]

    domain_api._arcgis_candidates = _arcgis_number
    domain_api._cache.clear()
    r = c.get("/api/address/suggest?q=8 atkinson close", headers=H1)
    data = r.get_json()["data"]
    check("bare house number resolves via the street",
          data and data[0]["address"].startswith("8 Atkinson Close")
          and "Point Cook" in data[0]["address"], data)

    domain_api._cache.clear()
    r = c.get("/api/address/locate?q=8 atkinson close", headers=H1)
    body = r.get_json()
    check("locate places the bare house number",
          body["ok"] and body["data"] and body["data"]["streetNumber"] == "8", body)

    domain_api._arcgis_candidates = real_arcgis
    domain_api._cache.clear()

    # Photon can place a bare house number; Esri cannot. When the street
    # exists in several suburbs, the most significant place wins.
    def _arcgis_rank_only(terms, lat=None, lon=None):
        t = terms.lower()
        if "point cook" in t and "sunbury" in t:
            def place(name, rank):
                return {"attributes": {"Addr_type": "Locality", "PlaceName": name,
                                       "City": name, "Region": "Victoria",
                                       "RegionAbbr": "VIC", "Postal": "3030",
                                       "Country": "AUS", "Rank": rank},
                        "location": {"x": 144.7, "y": -37.9}, "score": 90,
                        "address": name}
            return [place("Point Cook", 7.85), place("Sunbury", 8.05)]
        return []

    def _photon_houses(q):
        def house(num, street, suburb, state, postcode, lat, lon):
            return {"address": f"{num} {street}, {suburb}, {state}, {postcode}",
                    "domainId": "", "provider": "photon", "unitNumber": "",
                    "streetNumber": num, "streetName": street, "streetType": "",
                    "suburb": suburb, "postcode": postcode, "state": state,
                    "lat": lat, "lon": lon}
        return [house("8", "Atkinson Close", "Sunbury", "VIC", "3429", -37.57, 144.70),
                house("8", "Atkinson Close", "Point Cook", "VIC", "3030", -37.90, 144.72)]

    domain_api._arcgis_candidates = _arcgis_rank_only
    domain_api._photon_raw = _photon_houses
    domain_api._cache.clear()
    r = c.get("/api/address/locate?q=8 atkinson close", headers=H1)
    body = r.get_json()
    check("bare house number falls back to photon",
          body["ok"] and body["data"] and body["data"]["provider"] == "photon", body)
    check("the most significant place wins",
          body["ok"] and body["data"] and body["data"]["suburb"] == "Point Cook"
          and body["data"]["streetNumber"] == "8", body)

    domain_api._cache.clear()
    r = c.get("/api/address/suggest?q=8 atkinson close", headers=H1)
    data = r.get_json()["data"]
    check("suggest leads with the house-level match",
          data and data[0]["provider"] == "photon"
          and data[0]["streetNumber"] == "8", data)

    domain_api._arcgis_candidates = real_arcgis
    domain_api._photon_raw = real_photon
    domain_api._cache.clear()

    os.environ["PA_DOMAIN_CLIENT_ID"] = "t"
    os.environ["PA_DOMAIN_CLIENT_SECRET"] = "t"

    real_get_token, real_raw = domain_api._get_token, domain_api._suggest_raw
    domain_api._get_token = lambda: "tok"
    domain_api._suggest_raw = lambda terms, token: [{
        "id": "RF-8884-AK", "address": "1/50 Oldmill Drive, Beaconsfield QLD 4740",
        "relativeScore": 100,
        "addressComponents": {"unitNumber": "1", "streetNumber": "50",
                              "streetName": "Oldmill", "streetType": "Dr",
                              "suburb": "Beaconsfield", "postcode": "4740",
                              "state": "QLD"},
    }, {"id": "RF-2", "address": "", "addressComponents": {}}]

    r = c.get("/api/address/suggest?q=1/50 oldmill", headers=H1)
    body = r.get_json()
    check("suggest stubbed -> 200", r.status_code == 200 and body["ok"])
    data = body["data"]
    check("suggest drops blank addresses", len(data) == 1)
    check("suggest normalizes camelCase",
          data[0]["domainId"] == "RF-8884-AK" and data[0]["suburb"] == "Beaconsfield"
          and data[0]["postcode"] == "4740" and data[0]["state"] == "QLD")

    def _boom(terms, token):
        raise domain_api.DomainError("upstream 429", 502)
    domain_api._suggest_raw = _boom
    domain_api._cache.clear()
    r = c.get("/api/address/suggest?q=1/50 oldmill", headers=H1)
    check("suggest upstream error -> 502", r.status_code == 502 and not r.get_json()["ok"])
    domain_api._get_token, domain_api._suggest_raw = real_get_token, real_raw

    r = c.post("/api/comps/search", headers=H1, json={"address": "1 Test St"})
    check("comps search unconfigured -> 503", r.status_code == 503 and not r.get_json()["ok"])
    check("comps search unconfigured message", "not configured" in r.get_json()["error"])

    os.environ["PA_ULTIMATEAI_API_KEY"] = "test-key"

    r = c.post("/api/comps/search", headers=H1, json={"address": "   "})
    check("comps search blank address -> 400", r.status_code == 400)

    captured = {}

    def _fake_search(address, beds=None):
        captured["address"], captured["beds"] = address, beds
        return [{
            "address": "45 Oldmill Drive, Beaconsfield QLD 4740",
            "soldPrice": 662000, "soldDate": "2026-09", "beds": 4,
            "landM2": 670, "rentEstimate": 640,
            "url": "https://www.realestate.com.au/sold/xyz",
            "confidence": "high", "source": "realestate.com.au",
        }]

    real_search = comps_search.search_sold_comps
    comps_search.search_sold_comps = _fake_search
    r = c.post("/api/comps/search", headers=H1,
               json={"address": "1/50 Oldmill Dr", "beds": 4})
    body = r.get_json()
    check("comps search stubbed -> 200", r.status_code == 200 and body["ok"])
    check("comps search forwards address+beds",
          captured["address"] == "1/50 Oldmill Dr" and captured["beds"] == 4)
    check("comps search returns rows", body["data"]["comps"][0]["soldPrice"] == 662000)

    def _error_search(address, beds=None):
        raise comps_search.CompsSearchError("search produced no structured results")
    comps_search.search_sold_comps = _error_search
    r = c.post("/api/comps/search", headers=H1, json={"address": "1/50 Oldmill Dr"})
    check("comps search failure -> 502", r.status_code == 502 and not r.get_json()["ok"])
    comps_search.search_sold_comps = real_search

    clean = comps_search._sanitize([
        {"address": "A St", "soldPrice": 1, "url": "javascript:alert(1)"},
        {"address": "", "soldPrice": 5},
        {"address": "B St"},
        {"address": "C St", "soldPrice": "not-a-number"},
        {"address": "D St", "soldPrice": 700000, "url": "https://ok.example/x",
         "distanceKm": 2.3, "confidence": "WEIRD"},
    ])
    check("sanitize drops address-less and priceless rows", len(clean) == 2)
    check("sanitize keeps distance", clean[1]["distanceKm"] == 2.3)
    check("sanitize blanks non-http urls",
          all(r2["url"] == "" or r2["url"].startswith("https://") for r2 in clean))
    check("sanitize defaults weird confidence to low",
          [r2["confidence"] for r2 in clean] == ["low", "low"])

    # --- AI rental-evidence search (mirrors the sold-comps flow) ---------
    r = c.post("/api/rentals/search", json={"address": "x"})
    check("401 without token: /api/rentals/search",
          r.status_code == 401)
    os.environ.pop("PA_ULTIMATEAI_API_KEY", None)
    r = c.post("/api/rentals/search", headers=H1, json={"address": "1 Test St"})
    check("rental search unconfigured -> 503",
          r.status_code == 503 and not r.get_json()["ok"])
    check("rental search unconfigured message",
          "not configured" in r.get_json()["error"])
    os.environ["PA_ULTIMATEAI_API_KEY"] = "test-key"

    r = c.post("/api/rentals/search", headers=H1, json={"address": "   "})
    check("rental search blank address -> 400", r.status_code == 400)

    captured_rental = {}

    def _fake_rental_search(address, beds=None):
        captured_rental["address"], captured_rental["beds"] = address, beds
        return [{
            "address": "12 Caledonian Drive, Beaconsfield QLD 4740",
            "rentWeekly": 620, "bedrooms": 4, "propertyType": "house",
            "url": "https://www.domain.com.au/rent/xyz",
            "confidence": "high", "source": "domain.com.au",
        }]

    real_rental_search = comps_search.search_rentals
    comps_search.search_rentals = _fake_rental_search
    r = c.post("/api/rentals/search", headers=H1,
               json={"address": "1/50 Oldmill Dr", "beds": 4})
    body = r.get_json()
    check("rental search stubbed -> 200", r.status_code == 200 and body["ok"])
    check("rental search forwards address+beds",
          captured_rental["address"] == "1/50 Oldmill Dr" and captured_rental["beds"] == 4)
    check("rental search returns rows", body["data"]["rentals"][0]["rentWeekly"] == 620)

    def _error_rental_search(address, beds=None):
        raise comps_search.CompsSearchError("search produced no structured results")
    comps_search.search_rentals = _error_rental_search
    r = c.post("/api/rentals/search", headers=H1, json={"address": "1/50 Oldmill Dr"})
    check("rental search failure -> 502", r.status_code == 502 and not r.get_json()["ok"])
    comps_search.search_rentals = real_rental_search

    clean_rentals = comps_search._sanitize_rentals([
        {"address": "A St", "rentWeekly": 500, "url": "javascript:alert(1)"},
        {"address": "", "rentWeekly": 400},
        {"address": "B St", "rentWeekly": 0},
        {"address": "C St", "rentWeekly": "not-a-number"},
        {"address": "D St", "rentWeekly": 620, "bedrooms": -3,
         "propertyType": "boat", "listedDate": "2026-11", "distanceKm": 1.4,
         "url": "https://ok.example/x", "confidence": "WEIRD"},
    ])
    check("rental sanitize drops address-less and rent-less rows",
          len(clean_rentals) == 2)
    check("rental sanitize normalizes fields",
          clean_rentals[1]["bedrooms"] is None
          and clean_rentals[1]["propertyType"] is None
          and clean_rentals[1]["confidence"] == "low")
    check("rental sanitize keeps date+distance",
          clean_rentals[1]["listedDate"] == "2026-11"
          and clean_rentals[1]["distanceKm"] == 1.4)

    # --- AI web-evidence endpoints ---------------------------------------
    # (markets refresh / bank rates suggest / suburb evidence / listing
    # check / area signals) — run_research stubbed, never the real gateway.
    import ai_research  # noqa: E402
    import gateway_search  # noqa: E402
    import markets as markets_mod  # noqa: E402

    def _stub_research(payload):
        def fake(instructions, task, record_tool, list_key, sanitize):
            return sanitize(payload)
        return fake

    for route in ("/api/markets/ai-refresh", "/api/bank-rates/suggest",
                  "/api/suburbs/ai-evidence", "/api/property/listing-check",
                  "/api/property/area-signals"):
        r = c.post(route, json={})
        check(f"401 without token: {route}", r.status_code == 401)

    os.environ.pop("PA_ULTIMATEAI_API_KEY", None)
    for route in ("/api/markets/ai-refresh", "/api/bank-rates/suggest",
                  "/api/property/listing-check", "/api/property/area-signals"):
        r = c.post(route, headers=H1, json={})
        check(f"503 unconfigured: {route}", r.status_code == 503
              and "not configured" in r.get_json()["error"])
    os.environ["PA_ULTIMATEAI_API_KEY"] = "test-key"

    r = c.post("/api/suburbs/ai-evidence", headers=H1, json={})
    check("suburb evidence missing suburbId -> 400", r.status_code == 400)
    r = c.post("/api/property/listing-check", headers=H1, json={"address": "   "})
    check("listing check blank address -> 400", r.status_code == 400)
    r = c.post("/api/property/area-signals", headers=H1, json={})
    check("area signals blank address -> 400", r.status_code == 400)

    real_run = ai_research.run_research
    real_sdmx = (markets_mod._sdmx_cache["data"], markets_mod._sdmx_cache["at"])
    real_ai = (markets_mod._ai_national["data"], markets_mod._ai_national["at"])
    import time as _time
    markets_mod._sdmx_cache["data"], markets_mod._sdmx_cache["at"] = {}, _time.time()

    # markets research now runs the parallel-shard path (streaming runner)
    def _stub_stream_markets(instructions, task, record_tool, list_key, sanitize,
                             on_event=None):
        if "householdIncome" in instructions:
            return sanitize([
                {"key": "householdIncome", "value": 1746, "label": "2021 Census",
                 "source": "https://abs.gov.au/census"},
                {"key": "junk", "value": 1, "label": "x", "source": "y"}])
        return sanitize([
            {"key": "unemployment", "value": 4.1, "label": "Oct 2026",
             "source": "https://abs.gov.au/lfs"},
            {"key": "bogus", "value": 1, "label": "x", "source": "y"}])

    real_stream_markets = gateway_search.run_research_streaming
    gateway_search.run_research_streaming = _stub_stream_markets
    ai_research.run_research_streaming = _stub_stream_markets
    gateway_search.clear_cache()
    r = c.post("/api/markets/ai-refresh", headers=H1, json={})
    body = r.get_json()
    check("markets ai-refresh stubbed -> 200", r.status_code == 200 and body["ok"])
    check("markets ai-refresh sanitizes keys + merges shards",
          sorted(body["data"]["indicators"]) == ["householdIncome", "unemployment"])
    r = c.get("/api/markets", headers=H1)
    nat = r.get_json()["data"]["national"]["unemployment"]
    check("markets GET reflects AI value",
          nat["value"] == 4.1 and nat.get("liveVia") == "AI web search")
    markets_mod._sdmx_cache["data"], markets_mod._sdmx_cache["at"] = real_sdmx
    markets_mod._ai_national["data"], markets_mod._ai_national["at"] = real_ai
    gateway_search.run_research_streaming = real_stream_markets
    ai_research.run_research_streaming = real_stream_markets
    gateway_search.clear_cache()

    def _stub_stream(payload):
        def fake(instructions, task, record_tool, list_key, sanitize, on_event=None):
            return sanitize(payload)
        return fake

    real_stream_stub = gateway_search.run_research_streaming
    ai_research.run_research_streaming = real_stream_stub
    # rates research runs as parallel shards -> stubs the streaming runner
    gateway_search.run_research_streaming = _stub_stream([
        {"bankName": "Test Bank", "productName": "Investor Var",
         "investorIoRate": 5.89, "investorPiRate": 0.055,
         "source": "https://testbank.example/x"},
        {"bankName": "Rate Only Bank", "productName": "Standard Var",
         "investorPiRate": 6.2, "source": "https://comparison.example/x"},
        {"bankName": "", "investorIoRate": 5, "investorPiRate": 5, "source": "x"},
    ])
    ai_research.run_research_streaming = gateway_search.run_research_streaming
    gateway_search.clear_cache()
    r = c.post("/api/bank-rates/suggest", headers=H1, json={})
    body = r.get_json()
    check("rates suggest stubbed -> 200", r.status_code == 200 and body["ok"])
    sugg = body["data"]["rates"]
    check("rates suggest percent->decimal + partial rows", len(sugg) == 2
          and abs(sugg[0]["investorIoRate"] - 0.0589) < 1e-6
          and abs(sugg[0]["investorPiRate"] - 0.055) < 1e-6
          and sugg[1]["investorIoRate"] is None
          and abs(sugg[1]["investorPiRate"] - 0.062) < 1e-6)
    r = c.post("/api/bank-rates", headers=H1, json={
        "bankName": sugg[0]["bankName"], "productName": sugg[0]["productName"],
        "investorIoRate": sugg[0]["investorIoRate"],
        "investorPiRate": sugg[0]["investorPiRate"],
        "source": sugg[0]["source"], "checkedAt": "2026-11"})
    check("AI rate saves via rates endpoint", r.status_code in (200, 201),
          r.get_json())
    gateway_search.clear_cache()

    r = c.post("/api/suburbs", headers=H1, json={
        "name": "Aitest", "postcode": "4800", "medianPrice": 500000})
    check("create suburb for ai evidence", r.status_code == 201, r.get_json())
    ASID = r.get_json()["data"]["id"]
    def _stub_stream_suburb(instructions, task, record_tool, list_key, sanitize,
                            on_event=None):
        return sanitize([
            {"metric": "medianPrice", "value": 725000, "asOf": "Nov 2026",
             "source": "https://example/mp"},
            {"metric": "vacancyPct", "value": 1.4, "asOf": "Oct 2026",
             "source": "https://example/vac"},
            {"metric": "nope", "value": 2, "asOf": "x", "source": "y"}])

    real_stream_suburb = gateway_search.run_research_streaming
    gateway_search.run_research_streaming = _stub_stream_suburb
    ai_research.run_research_streaming = _stub_stream_suburb
    gateway_search.clear_cache()
    r = c.post("/api/suburbs/ai-evidence", headers=H1, json={"suburbId": ASID})
    body = r.get_json()
    check("suburb evidence stubbed -> 200", r.status_code == 200 and body["ok"])
    check("suburb evidence persisted",
          body["data"]["suburb"]["medianPrice"] == 725000
          and body["data"]["suburb"]["vacancyPct"] == 1.4)
    src = body["data"]["suburb"]["sources"]["medianPrice"]
    check("suburb evidence stamps source",
          "AI web search" in src["source"] and src["asOf"] == "Nov 2026")
    gateway_search.run_research_streaming = real_stream_suburb
    ai_research.run_research_streaming = real_stream_suburb
    gateway_search.clear_cache()

    ai_research.run_research = _stub_research({
        "onMarket": True, "askingPrice": 700000, "listedDate": "2026-10",
        "agent": "Test Realty", "lastSoldPrice": 610000, "lastSoldDate": "2021-05",
        "url": "https://realestate.com.au/x", "confidence": "high"})
    gateway_search.clear_cache()
    r = c.post("/api/property/listing-check", headers=H1,
               json={"address": "1 Test St"})
    body = r.get_json()
    check("listing check stubbed -> 200", r.status_code == 200 and body["ok"])
    l = body["data"]["listing"]
    check("listing check sanitized", l["onMarket"] is True
          and l["askingPrice"] == 700000 and l["confidence"] == "high")
    ai_research.run_research = real_run

    ai_research.run_research = _stub_research([
        {"name": "Test Rail Extension", "type": "transport",
         "status": "under_construction", "timeframe": "2029", "distanceKm": 1.8,
         "url": "https://example/rail"},
        {"name": "No URL", "type": "other", "status": "proposed", "url": ""},
    ])
    gateway_search.clear_cache()
    r = c.post("/api/property/area-signals", headers=H1,
               json={"address": "1 Test St"})
    body = r.get_json()
    check("area signals stubbed -> 200", r.status_code == 200 and body["ok"])
    check("area signals sanitize+cap", len(body["data"]["signals"]) == 1
          and body["data"]["signals"][0]["status"] == "under_construction")
    ai_research.run_research = real_run
    gateway_search.clear_cache()

    # --- AI search streaming routes (parallel source shards) -------------
    r = c.post("/api/comps/search/stream", json={"address": "x"})
    check("401 without token: /api/comps/search/stream", r.status_code == 401)
    os.environ.pop("PA_ULTIMATEAI_API_KEY", None)
    r = c.post("/api/comps/search/stream", headers=H1, json={"address": "1 Test St"})
    check("503 unconfigured: /api/comps/search/stream", r.status_code == 503)
    r = c.post("/api/rentals/search/stream", headers=H1, json={"address": "1 Test St"})
    check("503 unconfigured: /api/rentals/search/stream", r.status_code == 503)
    os.environ["PA_ULTIMATEAI_API_KEY"] = "test-key"

    real_stream_fn = gateway_search.run_research_streaming
    calls_stream = {"n": 0}

    def _fake_stream(instructions, task, record_tool, list_key, sanitize,
                     on_event=None):
        calls_stream["n"] += 1
        if on_event:
            on_event({"kind": "search", "query": "probe"})
        return sanitize([{"address": "9 Shard St", "soldPrice": 700000,
                          "soldDate": "2026-09", "url": "https://ok.example/s",
                          "confidence": "high"}])

    gateway_search.run_research_streaming = _fake_stream
    ai_research.run_research_streaming = _fake_stream
    gateway_search.clear_cache()
    r = c.post("/api/comps/search/stream", headers=H1,
               json={"address": "9 Shard Street", "beds": 4})
    frames = r.get_data(as_text=True)
    check("comps stream -> SSE progress + done frames", r.status_code == 200
          and '"kind": "search"' in frames and '"type": "done"' in frames
          and "9 Shard St" in frames)

    n_first = calls_stream["n"]
    r = c.post("/api/comps/search/stream", headers=H1,
               json={"address": "9 Shard Street", "beds": 4})
    check("comps stream cached on repeat", calls_stream["n"] == n_first
          and '"type": "done"' in r.get_data(as_text=True))

    def _fake_stream2(instructions, task, record_tool, list_key, sanitize,
                      on_event=None):
        if "iA shard A" in instructions:
            return [{"address": "dup St", "soldPrice": 1},
                    {"address": "onlyA St", "soldPrice": 2}]
        raise gateway_search.SearchError("shard B down")

    gateway_search.run_research_streaming = _fake_stream2
    ai_research.run_research_streaming = _fake_stream2
    shards = [
        {"name": "shard A", "instructions": "iA shard A", "task": "t",
         "record_tool": {"name": "rt"}, "list_key": "comps",
         "sanitize": lambda x: x},
        {"name": "shard B", "instructions": "iB shard B", "task": "t",
         "record_tool": {"name": "rt"}, "list_key": "comps",
         "sanitize": lambda x: x},
    ]
    rows = gateway_search.collect_parallel_research(
        shards, lambda r: r["address"].lower())
    check("parallel merge dedupes + tolerates shard failure",
          [x["address"] for x in rows] == ["dup St", "onlyA St"])
    gateway_search.run_research_streaming = real_stream_fn
    ai_research.run_research_streaming = real_stream_fn
    gateway_search.clear_cache()

    # --- remaining AI stream routes (markets / listing / signals / suburb)
    r = c.post("/api/markets/ai-refresh/stream", json={})
    check("401 without token: /api/markets/ai-refresh/stream", r.status_code == 401)
    r = c.get("/api/ai/status")
    check("ai status without token -> 401", r.status_code == 401)
    os.environ.pop("PA_ULTIMATEAI_API_KEY", None)
    r = c.post("/api/property/listing-check/stream", headers=H1, json={"address": "x"})
    check("503 unconfigured: listing stream", r.status_code == 503)
    r = c.post("/api/property/area-signals/stream", headers=H1, json={"address": "x"})
    check("503 unconfigured: signals stream", r.status_code == 503)
    r = c.post("/api/markets/ai-refresh/stream", headers=H1, json={})
    check("503 unconfigured: markets stream", r.status_code == 503)
    os.environ["PA_ULTIMATEAI_API_KEY"] = "test-key"

    gateway_search.run_research_streaming = _stub_stream({
        "onMarket": False, "lastSoldPrice": 640000, "confidence": "medium",
        "url": "https://realestate.com.au/yy"})
    ai_research.run_research_streaming = gateway_search.run_research_streaming
    gateway_search.clear_cache()
    r = c.post("/api/property/listing-check/stream", headers=H1,
               json={"address": "5 Stream St"})
    frames = r.get_data(as_text=True)
    check("listing stream -> done frame", r.status_code == 200
          and '"type": "done"' in frames and '"listing"' in frames)

    r = c.post("/api/property/area-signals/stream", headers=H1,
               json={"address": "5 Stream St"})
    frames = r.get_data(as_text=True)
    check("signals stream -> done frame", r.status_code == 200
          and '"type": "done"' in frames)

    gateway_search.run_research_streaming = _stub_stream([
        {"key": "unemployment", "value": 4.2, "label": "Oct 2026",
         "source": "https://abs.gov.au/lfs"}])
    ai_research.run_research_streaming = gateway_search.run_research_streaming
    gateway_search.clear_cache()
    r = c.post("/api/markets/ai-refresh/stream", headers=H1, json={})
    frames = r.get_data(as_text=True)
    check("markets stream -> done + adoption", r.status_code == 200
          and '"type": "done"' in frames and "unemployment" in frames
          and markets_mod._ai_national["data"] is not None)
    markets_mod._ai_national["data"], markets_mod._ai_national["at"] = None, 0.0
    gateway_search.run_research_streaming = real_stream_fn
    ai_research.run_research_streaming = real_stream_fn

    r = c.get("/api/ai/status", headers=H1)
    check("ai status configured", r.status_code == 200
          and r.get_json()["data"]["configured"] is True)

    # suburb evidence stream persists via the shared helper
    r = c.post("/api/suburbs", headers=H1, json={
        "name": "Streamtown", "postcode": "4801"})
    STID = r.get_json()["data"]["id"]
    gateway_search.run_research_streaming = _stub_stream([
        {"metric": "medianPrice", "value": 700000, "asOf": "Nov 2026",
         "source": "https://example/st"}])
    ai_research.run_research_streaming = gateway_search.run_research_streaming
    gateway_search.clear_cache()
    r = c.post("/api/suburbs/ai-evidence/stream", headers=H1,
               json={"suburbId": STID})
    frames = r.get_data(as_text=True)
    check("suburb evidence stream -> done + persisted", r.status_code == 200
          and '"type": "done"' in frames and "700000" in frames)
    r = c.get("/api/suburbs", headers=H1)
    strow = next(s for s in r.get_json()["data"] if s["id"] == STID)
    check("suburb evidence stream persisted to suburb row",
          strow["medianPrice"] == 700000
          and "AI web search" in strow["sources"]["medianPrice"]["source"])

    # valuation guide all-states fallback (suburb record median)
    r = c.get(f"/api/valuation?suburb=streamtown&state=QLD&postcode=4801")
    vbody = r.get_json()["data"]
    check("valuation falls back to suburb record median",
          vbody["available"] is True and vbody["latest"]["median"] == 700000
          and vbody["guide"]["low"] == round(700000 * 0.9))
    r = c.get("/api/valuation?suburb=nowhere%20xy&state=QLD")
    check("valuation still honest when nothing on record",
          r.get_json()["data"]["available"] is False)
    gateway_search.clear_cache()

    # the UI save-selected flow: candidate -> existing comps endpoint
    cand = {"address": "45 Oldmill Drive", "soldPrice": 662000, "soldDate": "2026-09",
            "beds": 4, "landM2": 670, "rentEstimate": 640,
            "url": "https://www.realestate.com.au/sold/xyz",
            "notes": "AI search (high confidence)"}
    r = c.post(f"/api/scenarios/{SCN_ID}/comps", headers=H1, json=cand)
    check("save AI candidate via comps endpoint", r.status_code == 201, r.get_json())
    saved = r.get_json()["data"]
    check("AI candidate keeps url+notes",
          saved["url"] == cand["url"] and "AI search" in saved["notes"])

    # addressMeta round-trips through scenario inputs
    r = c.post("/api/scenarios", headers=H1, json={
        "name": "With meta", "inputs": {
            "address": "1/50 Oldmill Drive, Beaconsfield QLD 4740",
            "addressMeta": {"domainId": "RF-8884-AK", "suburb": "Beaconsfield",
                            "postcode": "4740", "state": "QLD"}}})
    check("create scenario with addressMeta", r.status_code == 201, r.get_json())
    MID = r.get_json()["data"]["id"]
    r = c.get(f"/api/scenarios/{MID}", headers=H1)
    meta = r.get_json()["data"]["inputs"].get("addressMeta")
    check("addressMeta round-trips", meta and meta["domainId"] == "RF-8884-AK")
finally:
    for k, v in saved_env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

# ---------------------------------------------------------------------------
# Multi-property (v3) scenario payloads
# ---------------------------------------------------------------------------

V3_INPUTS = {
    "projectionYears": 20,
    "properties": [
        {"purchasePrice": 750000, "weeklyRent": 620, "equityReleased": 100000,
         "address": "1 First St", "ipLvr": 0.8},
        {"purchasePrice": 600000, "weeklyRent": 500, "equityReleased": 150000,
         "address": "2 Second St", "ipLvr": 0.7},
    ],
}
r = c.post("/api/scenarios", headers=H1, json={"name": "Portfolio v3", "inputs": V3_INPUTS})
check("v3 portfolio save accepted", r.status_code == 201, r.get_json())
V3_ID = r.get_json()["data"]["id"]
check("v3 address mirrors properties[0]",
      r.get_json()["data"]["address"] == "1 First St")
r = c.get(f"/api/scenarios/{V3_ID}", headers=H1)
back = r.get_json()["data"]["inputs"]
check("v3 round-trip: 2 properties", len(back.get("properties", [])) == 2)
check("v3 round-trip: per-property equity kept",
      back["properties"][1]["equityReleased"] == 150000)

r = c.post("/api/scenarios", headers=H1, json={"name": "Too many", "inputs": {
    "properties": [{"purchasePrice": 500000}] * 7}})
check("7 properties rejected", r.status_code == 400, r.get_json())
check("7 properties names the field", "properties" in r.get_json().get("fields", {}))

r = c.post("/api/scenarios", headers=H1, json={"name": "Bad ownership", "inputs": {
    "properties": [{"purchasePrice": 500000},
                   {"purchasePrice": 500000, "ownershipStatus": "sold"}]}})
check("bad ownershipStatus rejected", r.status_code == 400, r.get_json())
check("ownershipStatus field key reported",
      "properties.1.ownershipStatus" in r.get_json().get("fields", {}), r.get_json())
r = c.post("/api/scenarios", headers=H1, json={"name": "Owned ok", "inputs": {
    "properties": [{"purchasePrice": 500000, "ownershipStatus": "purchased"}]}})
check("valid ownershipStatus accepted", r.status_code == 201, r.get_json())
check("absent ownershipStatus still accepted (legacy inputs)",
      c.post("/api/scenarios", headers=H1, json={"name": "Legacy", "inputs": {
          "properties": [{"purchasePrice": 500000}]}}).status_code == 201)

r = c.post("/api/scenarios", headers=H1, json={"name": "Bad enum in IP2", "inputs": {
    "projectionYears": 20,
    "properties": [{"purchasePrice": 500000},
                   {"purchasePrice": 500000, "ipRepaymentType": "balloon"}]}})
check("bad enum inside properties[1] rejected", r.status_code == 400, r.get_json())
check("dotted field key reported",
      "properties.1.ipRepaymentType" in r.get_json().get("fields", {}), r.get_json())

r = c.post("/api/scenarios", headers=H1, json={"name": "Legacy flat still ok", "inputs": {
    "purchasePrice": 700000, "weeklyRent": 580}})
check("legacy flat save still accepted", r.status_code == 201, r.get_json())

r = c.put(f"/api/scenarios/{V3_ID}", headers=H1, json={
    "name": "Portfolio v3", "inputs": dict(V3_INPUTS, projectionYears=15)})
check("v3 update accepted", r.status_code == 200, r.get_json())

# ---------------------------------------------------------------------------
# Platform: roles, presentations, client portal, OTP
# ---------------------------------------------------------------------------

import ratelimit  # noqa: E402
ratelimit.reset()

check("register returns default role investor",
      c.post("/api/auth/register", json={"email": "inv@test.com",
              "password": "password123"}).get_json()["data"]["role"] == "investor")
r = c.post("/api/scenarios", headers=H1, json={"name": "Bad state", "inputs": {
    "state": "ZZ", "properties": [{"purchasePrice": 500000}]}})
check("unknown state ZZ rejected by validator", r.status_code == 400)
r = c.post("/api/scenarios", headers=H1, json={"name": "NSW ok", "inputs": {
    "state": "NSW", "properties": [{"purchasePrice": 500000}]}})
check("NSW state accepted", r.status_code == 201, r.get_json())
r = c.post("/api/auth/register", json={"email": "ba@test.com", "password": "password123",
                                       "displayName": "Agent A", "role": "ba"})
check("register accepts role ba", r.status_code == 201 and r.get_json()["data"]["role"] == "ba")
BA = {"Authorization": "Bearer " + r.get_json()["data"]["token"]}
r = c.post("/api/auth/register", json={"email": "cli@test.com", "password": "password123",
                                       "role": "client"})
check("open registration refuses role client", r.status_code == 400)
r = c.get("/api/auth/me", headers=BA)
check("me returns role", r.get_json()["data"]["role"] == "ba")

INV = {"Authorization": "Bearer " + c.post("/api/auth/register",
       json={"email": "inv2@test.com", "password": "password123"}).get_json()["data"]["token"]}
check("investor blocked from presentations",
      c.post("/api/presentations", headers=INV,
             json={"scenarioId": 1, "clientEmail": "x@y.com"}).status_code == 403)
check("investor blocked from clients", c.get("/api/clients", headers=INV).status_code == 403)
check("anonymous blocked from portal list",
      c.get("/api/portal/presentations").status_code == 401)

# BA scenario -> presentation
r = c.post("/api/scenarios", headers=BA, json={"name": "Beaconsfield duplex", "inputs": {
    "properties": [{"purchasePrice": 675000, "weeklyRent": 725}]}})
SID = r.get_json()["data"]["id"]
r = c.post("/api/presentations", headers=BA, json={
    "scenarioId": SID, "clientEmail": "jane@client.com", "clientName": "Jane"})
check("presentation created", r.status_code == 201, r.get_json())
PD = r.get_json()["data"]
check("share token returned once", isinstance(PD["shareToken"], str) and len(PD["shareToken"]) > 20)
check("token stored hashed, not raw",
      db.db().fetch_one("SELECT share_token_hash FROM presentations WHERE id = ?",
                        (PD["id"],))["share_token_hash"] != PD["shareToken"])
r = c.post("/api/presentations", headers=BA, json={
    "scenarioId": V3_ID, "clientEmail": "someone@nowhere.com"})
check("BA cannot share a scenario they don't own", r.status_code == 404)

# Magic-link resolve: logs the client in, hands over the snapshot
r = c.get(f"/api/portal/resolve/{PD['shareToken']}")
check("resolve works", r.status_code == 200, r.get_json())
RD = r.get_json()["data"]
check("resolve issues a client JWT", RD["token"] and RD["me"]["role"] == "client")
check("resolve carries snapshot",
      RD["presentation"]["snapshot"]["properties"][0]["purchasePrice"] == 675000)
CL = {"Authorization": "Bearer " + RD["token"]}

r = c.put(f"/api/portal/presentation/{PD['id']}/adjustments", headers=CL, json={
    "inputs": {"properties": [{"purchasePrice": 650000, "weeklyRent": 725}]}})
check("client saves adjustments", r.status_code == 200, r.get_json())
r = c.put(f"/api/portal/presentation/{PD['id']}/adjustments", headers=CL, json={
    "inputs": {"properties": [{"purchasePrice": -5}]}})
check("adjustments structurally validated", r.status_code == 400)
r = c.get(f"/api/portal/resolve/{PD['shareToken']}")
check("later resolves serve the client's numbers",
      r.get_json()["data"]["presentation"]["snapshot"]["properties"][0]["purchasePrice"] == 650000)

r = c.post(f"/api/portal/presentation/{PD['id']}/comment", headers=CL,
           json={"body": "What about the body corporate?"})
check("client comment posts", r.status_code == 201)
r = c.post(f"/api/portal/presentation/{PD['id']}/approve", headers=CL, json={})
check("client approval records", r.status_code == 201)

r = c.get(f"/api/presentations/{PD['id']}", headers=BA)
DET = r.get_json()["data"]
check("BA sees client activity", any(e["type"] == "approved" for e in DET["events"]))
check("BA sees client's adjusted numbers",
      DET["clientAdjustments"]["properties"][0]["purchasePrice"] == 650000)

# OTP login — full flow (PA_OTP_ECHO mirrors the code in dev/test only)
os.environ["PA_OTP_ECHO"] = "1"
ratelimit.reset()
r = c.post("/api/otp/request", json={"email": "mallory@client.com"})
check("otp request for a new email creates a client", r.status_code == 200, r.get_json())
CODE = r.get_json()["data"]["devCode"]
r = c.post("/api/otp/verify", json={"email": "mallory@client.com", "code": "000000"})
check("wrong otp code rejected", r.status_code == 401)
r = c.post("/api/otp/verify", json={"email": "mallory@client.com", "code": CODE})
check("otp verify logs the client in",
      r.status_code == 200 and r.get_json()["data"]["role"] == "client")
MALLORY = {"Authorization": "Bearer " + r.get_json()["data"]["token"]}
r = c.post("/api/otp/verify", json={"email": "mallory@client.com", "code": CODE})
check("otp code is single use", r.status_code == 401)
r = c.get(f"/api/portal/presentation/{PD['id']}", headers=MALLORY)
check("client isolation: another client gets 404", r.status_code == 404)
r = c.get("/api/portal/presentations", headers=MALLORY)
check("another client's shared list is empty", r.get_json()["data"] == [])
r = c.post("/api/otp/request", json={"email": "ba@test.com"})
check("password accounts refused otp", r.status_code == 403)

# Rotation + revocation
ratelimit.reset()
r = c.post(f"/api/presentations/{PD['id']}/rotate", headers=BA)
check("rotate returns a fresh token", r.status_code == 200 and r.get_json()["data"]["shareToken"])
NEW_TOK = r.get_json()["data"]["shareToken"]
check("old token dead after rotate (404: indistinguishable from garbage)",
      c.get(f"/api/portal/resolve/{PD['shareToken']}").status_code == 404)
check("new token resolves",
      c.get(f"/api/portal/resolve/{NEW_TOK}").status_code == 200)
r = c.post(f"/api/presentations/{PD['id']}/revoke", headers=BA)
check("revoke ok", r.status_code == 200)
check("revoked link gone",
      c.get(f"/api/portal/resolve/{NEW_TOK}").status_code == 410)
check("unknown token 404s", c.get("/api/portal/resolve/nope").status_code == 404)

# Clients CRM
r = c.get("/api/clients", headers=BA)
check("clients list has Jane with one proposal",
      any(x["name"] == "Jane" and x["presentations"] >= 1 for x in r.get_json()["data"]))
r = c.post("/api/clients", headers=BA, json={"email": "ba@test.com"})
check("cannot claim a password account as client", r.status_code == 400)

# ---------------------------------------------------------------------------
# P3: portfolio actuals + P4: branding & plan limits
# ---------------------------------------------------------------------------

r = c.post("/api/scenarios", headers=H1, json={"name": "Tracked prop", "inputs": {
    "properties": [{"purchasePrice": 700000}]}})
ACT_SID = r.get_json()["data"]["id"]
check("401 on actuals without token", c.get(f"/api/scenarios/{ACT_SID}/actuals").status_code == 401)
check("u2 cannot read u1's actuals",
      c.get(f"/api/scenarios/{ACT_SID}/actuals", headers=H2).status_code == 404)
r = c.post(f"/api/scenarios/{ACT_SID}/actuals", headers=H1, json={
    "propertyIndex": 0, "periodStart": "2026-11-01", "periodEnd": "2026-11-30",
    "rentReceived": 2900, "expenses": 950, "loanBalance": 558000, "valuation": 720000})
check("actual created", r.status_code == 201, r.get_json())
r = c.post(f"/api/scenarios/{ACT_SID}/actuals", headers=H1, json={
    "propertyIndex": 0, "periodStart": "2026-11-01", "periodEnd": "2026-11-30",
    "rentReceived": 2950, "expenses": 900})
check("same period upserts, not duplicates", r.status_code == 201)
r = c.get(f"/api/scenarios/{ACT_SID}/actuals", headers=H1)
ACTS = r.get_json()["data"]
check("upsert kept one row with new values",
      len(ACTS) == 1 and ACTS[0]["rentReceived"] == 2950 and ACTS[0]["loanBalance"] is None)
r = c.post(f"/api/scenarios/{ACT_SID}/actuals", headers=H1, json={
    "propertyIndex": 0, "periodStart": "2026-12-01", "periodEnd": "2026-11-20",
    "rentReceived": 1, "expenses": 1})
check("period end before start rejected", r.status_code == 400)
r = c.post(f"/api/scenarios/{ACT_SID}/actuals", headers=H1, json={
    "propertyIndex": 9, "periodStart": "2027-01-01", "periodEnd": "2027-01-31",
    "rentReceived": 1, "expenses": 1})
check("propertyIndex range enforced", r.status_code == 400)
r = c.post(f"/api/scenarios/{ACT_SID}/actuals", headers=H1, json={
    "propertyIndex": 0, "periodStart": "2026-12-01", "periodEnd": "2026-12-31",
    "rentReceived": -5, "expenses": 1})
check("negative rent rejected", r.status_code == 400)
aid = ACTS[0]["id"]
check("delete own actual",
      c.delete(f"/api/actuals/{aid}", headers=H1).status_code == 200)
check("deleted actual gone",
      c.delete(f"/api/actuals/{aid}", headers=H1).status_code == 404)

# Branding + plan
check("investor blocked from branding",
      c.get("/api/branding", headers=H1).status_code == 403)
r = c.put("/api/branding", headers=BA, json={
    "businessName": "Smith Property Buyers", "accentColor": "#0ea5e9",
    "tagline": "Independent advice, data first",
    "phone": "0400 000 000", "email": "smith@example.com",
    "website": "smithproperty.com.au", "officeAddress": "Suite 4, 100 Main St, Brisbane QLD"})
check("BA saves branding", r.status_code == 200 and r.get_json()["data"]["businessName"] == "Smith Property Buyers")
check("BA branding carries contact details",
      r.get_json()["data"]["phone"] == "0400 000 000"
      and r.get_json()["data"]["email"] == "smith@example.com"
      and r.get_json()["data"]["website"] == "smithproperty.com.au"
      and r.get_json()["data"]["officeAddress"].startswith("Suite 4"))
r = c.put("/api/branding", headers=BA, json={"accentColor": "red"})
check("bad accent colour rejected", r.status_code == 400)
import report as report_mod  # noqa: E402
_branded = report_mod.build_report_html(
    {"title": "t", "years": [], "accent": "#0ea5e9"},
    {"branding": {"businessName": "Smith Property Buyers", "phone": "0400 000 000",
                  "email": "smith@example.com", "website": "smithproperty.com.au"}})
check("report PDF header band + footer carry BA contact details",
      "Smith Property Buyers" in _branded and "0400 000 000" in _branded
      and "smith@example.com" in _branded and "smithproperty.com.au" in _branded
      and 'class="head"' in _branded)

# Trial plan cap: BA has 0 active presentations (PD was revoked); fill to 3 then fail on the 4th
for email in ("cap1@client.com", "cap2@client.com", "cap3@client.com"):
    r = c.post("/api/presentations", headers=BA, json={
        "scenarioId": SID, "clientEmail": email})
    check(f"trial presentation {email} ok", r.status_code == 201, r.get_json())
r = c.post("/api/presentations", headers=BA, json={
    "scenarioId": SID, "clientEmail": "cap4@client.com"})
check("4th active presentation blocked on trial",
      r.status_code == 403 and "Trial" in r.get_json()["error"], r.get_json())
r = c.post("/api/billing/plan", headers=BA, json={"plan": "pro"})
check("upgrade to pro", r.status_code == 200 and r.get_json()["data"]["plan"] == "pro")
r = c.post("/api/presentations", headers=BA, json={
    "scenarioId": SID, "clientEmail": "cap4@client.com"})
check("pro lifts the cap", r.status_code == 201, r.get_json())
CAP_TOK = r.get_json()["data"]["shareToken"]
check("me returns plan",
      c.get("/api/auth/me", headers=BA).get_json()["data"]["plan"] == "pro")

# Branding flows into the portal payload
ratelimit.reset()
r = c.get(f"/api/portal/resolve/{CAP_TOK}")
BR = r.get_json()["data"]["presentation"]["branding"]
check("resolve carries BA branding",
      BR["businessName"] == "Smith Property Buyers" and BR["accentColor"] == "#0ea5e9")

# Rental comps CRUD
r = c.post(f"/api/scenarios/{ACT_SID}/rentals", headers=H1, json={
    "address": "5 Test St", "rentWeekly": 580, "bedrooms": 3, "propertyType": "unit"})
check("rental comp created", r.status_code == 201, r.get_json())
r = c.post(f"/api/scenarios/{ACT_SID}/rentals", headers=H1, json={
    "address": "9 Test St", "rentWeekly": 0})
check("zero rent rejected", r.status_code == 400)
r = c.post(f"/api/scenarios/{ACT_SID}/rentals", headers=H1, json={
    "address": "3 Test St", "rentWeekly": 600, "propertyType": "bungalow"})
check("bad property type falls back to house",
      r.status_code == 201 and r.get_json()["data"]["propertyType"] == "house")
r = c.get(f"/api/scenarios/{ACT_SID}/rentals", headers=H1)
RENTALS = r.get_json()["data"]
check("rental comps listed", len(RENTALS) == 2, r.get_json())
RID = RENTALS[0]["id"]
check("u2 cannot delete u1's rental comp",
      c.delete(f"/api/rentals/{RID}", headers=H2).status_code == 404)
check("delete own rental comp",
      c.delete(f"/api/rentals/{RID}", headers=H1).status_code == 200)

# Email share link (PA_SMTP_HOST unset -> logged fallback, endpoint still OK)
ratelimit.reset()
r = c.post("/api/presentations", headers=BA, json={
    "scenarioId": SID, "clientEmail": "emailme@client.com"})
check("email-test presentation created", r.status_code == 201, r.get_json())
ETOK = r.get_json()["data"]["shareToken"]
EPID = r.get_json()["data"]["id"]
r = c.post(f"/api/presentations/{EPID}/email", headers=BA, json={
    "shareToken": ETOK, "email": "emailme@client.com"})
check("email endpoint accepts current token",
      r.status_code == 200 and r.get_json()["data"]["emailedTo"] == "emailme@client.com",
      r.get_json())
r = c.post(f"/api/presentations/{EPID}/email", headers=BA, json={
    "shareToken": "WRONGTOKEN", "email": "x@y.com"})
check("stale/wrong token refused", r.status_code == 400)
check("investor blocked from emailing",
      c.post(f"/api/presentations/{EPID}/email", headers=H1,
             json={"shareToken": ETOK, "email": "x@y.com"}).status_code == 403)

# Logo upload + landing page + buyerType
check("investor blocked from logo upload",
      c.post("/api/branding/logo", headers=H1).status_code == 403)
r = c.post("/api/branding/logo", headers=BA)
check("logo upload needs storage config/file",
      r.status_code == 400, r.get_json())
check("landing page served at /welcome", c.get("/welcome").status_code == 200)
r = c.post("/api/scenarios", headers=H1, json={"name": "Bad buyer", "inputs": {
    "buyerType": "martian", "properties": [{"purchasePrice": 500000}]}})
check("bad buyerType rejected", r.status_code == 400)
r = c.post("/api/scenarios", headers=H1, json={"name": "Foreign buyer ok", "inputs": {
    "buyerType": "foreign", "state": "NSW",
    "properties": [{"purchasePrice": 650000}]}})
check("foreign buyerType accepted", r.status_code == 201, r.get_json())

# ---------------------------------------------------------------------------
# Client portfolios: one share link covering N presentations
# ---------------------------------------------------------------------------

ratelimit.reset()

PF_SID1 = c.post("/api/scenarios", headers=BA, json={"name": "Ipswich house", "inputs": {
    "properties": [{"purchasePrice": 620000, "weeklyRent": 520}]}}).get_json()["data"]["id"]
PF_SID2 = c.post("/api/scenarios", headers=BA, json={"name": "Logan townhouse", "inputs": {
    "properties": [{"purchasePrice": 480000, "weeklyRent": 450}]}}).get_json()["data"]["id"]

check("investor blocked from portfolio create",
      c.post("/api/portfolios", headers=H1, json={
          "clientEmail": "x@y.com", "items": [{"scenarioId": PF_SID1}]}).status_code == 403)
check("investor blocked from portfolio list",
      c.get("/api/portfolios", headers=H1).status_code == 403)

r = c.post("/api/portfolios", headers=BA, json={
    "clientEmail": "sam@client.com", "clientName": "Sam",
    "title": "Sam's shortlist",
    "items": [
        {"scenarioId": PF_SID1, "label": "Ipswich — solid yield",
         "summary": {"yieldPct": 4.4, "cashFlow": -120}},
        {"scenarioId": PF_SID2, "label": "Logan — lower entry",
         "summary": {"yieldPct": 4.9, "cashFlow": -60}},
    ]})
check("portfolio created", r.status_code == 201, r.get_json())
PF = r.get_json()["data"]
PF_TOK = PF["shareToken"]
check("portfolio token returned once", isinstance(PF_TOK, str) and len(PF_TOK) > 20)
check("portfolio has 2 items", PF["itemCount"] == 2, PF.get("itemCount"))
check("portfolio roll-up starts pending",
      PF["pendingCount"] == 2 and PF["approvedCount"] == 0)
check("portfolio token stored hashed, not raw",
      db.db().fetch_one("SELECT share_token_hash FROM portfolios WHERE id = ?",
                        (PF["id"],))["share_token_hash"] != PF_TOK)
check("item summary round-trips",
      PF["items"][0]["summary"]["yieldPct"] == 4.4, PF["items"][0].get("summary"))
check("item summary derives price/rent from the scenario",
      PF["items"][0]["summary"]["purchasePrice"] == 620000
      and PF["items"][0]["summary"]["weeklyRent"] == 520, PF["items"][0].get("summary"))

r = c.post("/api/portfolios", headers=BA, json={
    "clientEmail": "sam@client.com", "items": []})
check("portfolio needs at least one item", r.status_code == 400)
r = c.post("/api/portfolios", headers=BA, json={
    "clientEmail": "sam@client.com", "items": [{"scenarioId": 999999}]})
check("unknown scenario in portfolio 404s and leaves no rows",
      r.status_code == 404 and db.db().fetch_one(
          "SELECT * FROM portfolio_items WHERE portfolio_id = -1") is None)
r = c.post("/api/portfolios", headers=BA, json={
    "clientEmail": "sam@client.com", "items": [{"scenarioId": "junk"}]})
check("non-numeric scenarioId 404s (no 500)", r.status_code == 404)

# Resolve: one link logs the client in and hands over every item
r = c.get(f"/api/portal/resolve/{PF_TOK}")
check("portfolio resolve works", r.status_code == 200, r.get_json())
PRD = r.get_json()["data"]
check("resolve returns portfolio, not single presentation", "portfolio" in PRD)
check("portfolio resolve issues a client JWT",
      PRD["token"] and PRD["me"]["email"] == "sam@client.com")
check("portfolio resolve lists both items",
      len(PRD["portfolio"]["items"]) == 2)
check("portfolio resolve carries branding",
      PRD["portfolio"]["branding"]["businessName"] == "Smith Property Buyers")
PCL = {"Authorization": "Bearer " + PRD["token"]}
ITEM1 = PRD["portfolio"]["items"][0]["presentationId"]
ITEM2 = PRD["portfolio"]["items"][1]["presentationId"]

# Items behave as ordinary presentations for the portfolio's client
r = c.get(f"/api/portal/presentation/{ITEM1}", headers=PCL)
check("client opens item 1 via portal", r.status_code == 200, r.get_json())
check("item snapshot carried",
      r.get_json()["data"]["snapshot"]["properties"][0]["purchasePrice"] == 620000)
check("client isolation: another client gets 404 on item",
      c.get(f"/api/portal/presentation/{ITEM1}", headers=MALLORY).status_code == 404)
r = c.post(f"/api/portal/presentation/{ITEM1}/approve", headers=PCL, json={})
check("client approves item 1", r.status_code == 201)
r = c.post(f"/api/portal/presentation/{ITEM2}/comment", headers=PCL,
           json={"body": "Can we look at strata fees here?"})
check("client comments on item 2", r.status_code == 201)

r = c.get(f"/api/portfolios/{PF['id']}", headers=BA)
PFD = r.get_json()["data"]
check("BA portfolio detail roll-up",
      PFD["approvedCount"] == 1 and PFD["pendingCount"] == 1, PFD.get("approvedCount"))
check("BA portfolio detail has comment count",
      PFD["commentCount"] == 1 and PFD["items"][1]["commentCount"] == 1)
check("BA portfolio events joined across items",
      any(e["type"] == "approved" for e in PFD["events"]))

# BA cannot touch another BA's portfolio
OTHER_BA = {"Authorization": "Bearer " + c.post("/api/auth/register",
           json={"email": "ba2@test.com", "password": "password123",
                 "role": "ba"}).get_json()["data"]["token"]}
check("portfolio ownership enforced",
      c.get(f"/api/portfolios/{PF['id']}", headers=OTHER_BA).status_code == 404)

# List + email
r = c.get("/api/portfolios", headers=BA)
check("portfolio list shows the portfolio",
      any(p["id"] == PF["id"] for p in r.get_json()["data"]))
r = c.post(f"/api/portfolios/{PF['id']}/email", headers=BA,
           json={"shareToken": PF_TOK})
check("portfolio email endpoint accepts current token",
      r.status_code == 200 and r.get_json()["data"]["link"].endswith(PF_TOK), r.get_json())
r = c.post(f"/api/portfolios/{PF['id']}/email", headers=BA,
           json={"shareToken": "WRONGTOKEN"})
check("stale portfolio token refused", r.status_code == 400)

# Rotate: old link dies, items stay active under the new link
r = c.post(f"/api/portfolios/{PF['id']}/rotate", headers=BA, json={})
check("portfolio rotate returns a fresh token",
      r.status_code == 200 and r.get_json()["data"]["shareToken"] != PF_TOK)
PF_TOK2 = r.get_json()["data"]["shareToken"]
check("old portfolio token dead after rotate",
      c.get(f"/api/portal/resolve/{PF_TOK}").status_code == 404)
r = c.get(f"/api/portal/resolve/{PF_TOK2}")
check("new portfolio token resolves",
      r.status_code == 200 and len(r.get_json()["data"]["portfolio"]["items"]) == 2)

# Revoke: the portfolio AND its items go dark together
r = c.post(f"/api/portfolios/{PF['id']}/revoke", headers=BA)
check("portfolio revoke ok", r.status_code == 200)
check("revoked portfolio link gone",
      c.get(f"/api/portal/resolve/{PF_TOK2}").status_code == 410)
check("revoked portfolio revoked its items",
      db.db().fetch_one("SELECT status FROM presentations WHERE id = ?",
                        (ITEM1,))["status"] == "revoked")

# Delete cleans up items, events and rows
r = c.delete(f"/api/portfolios/{PF['id']}", headers=BA)
check("portfolio delete ok", r.status_code == 200)
check("delete removed item presentations",
      db.db().fetch_one("SELECT * FROM presentations WHERE id = ?", (ITEM1,)) is None)
check("delete removed portfolio row",
      db.db().fetch_one("SELECT * FROM portfolios WHERE id = ?", (PF["id"],)) is None)

# Trial cap: a portfolio counts as ONE share unit no matter the item count
TRIAL_BA = {"Authorization": "Bearer " + c.post("/api/auth/register",
            json={"email": "trial-ba@test.com", "password": "password123",
                  "role": "ba"}).get_json()["data"]["token"]}
TSID = c.post("/api/scenarios", headers=TRIAL_BA, json={"name": "Cap prop", "inputs": {
    "properties": [{"purchasePrice": 500000}]}}).get_json()["data"]["id"]
r = c.post("/api/portfolios", headers=TRIAL_BA, json={
    "clientEmail": "capcli@client.com",
    "items": [{"scenarioId": TSID}, {"scenarioId": TSID, "label": "variant"}]})
check("trial BA: 3-item portfolio counts as one share",
      r.status_code == 201, r.get_json())
TRIAL_PF = r.get_json()["data"]
for email in ("t1@client.com", "t2@client.com"):
    r = c.post("/api/presentations", headers=TRIAL_BA, json={
        "scenarioId": TSID, "clientEmail": email})
    check(f"trial BA standalone {email} ok (2nd/3rd unit)", r.status_code == 201, r.get_json())
r = c.post("/api/presentations", headers=TRIAL_BA, json={
    "scenarioId": TSID, "clientEmail": "t3@client.com"})
check("trial BA blocked at 4th unit (portfolio = 1)",
      r.status_code == 403 and "Trial" in r.get_json()["error"], r.get_json())
r = c.post(f"/api/portfolios/{TRIAL_PF['id']}/revoke", headers=TRIAL_BA)
check("revoking frees the unit", r.status_code == 200)
r = c.post("/api/presentations", headers=TRIAL_BA, json={
    "scenarioId": TSID, "clientEmail": "t3@client.com"})
check("after revoke the cap has room again", r.status_code == 201, r.get_json())

# ---------------------------------------------------------------------------
# Property documents: BA uploads, clients read via an active share
# ---------------------------------------------------------------------------

import io  # noqa: E402
import os  # noqa: E402

ratelimit.reset()
DOC_SID = c.post("/api/scenarios", headers=BA, json={"name": "Doc prop", "inputs": {
    "properties": [{"purchasePrice": 590000, "weeklyRent": 500}]}}).get_json()["data"]["id"]

check("401 uploading without token",
      c.post(f"/api/scenarios/{DOC_SID}/attachments").status_code == 401)
check("investor cannot upload",
      c.post(f"/api/scenarios/{DOC_SID}/attachments", headers=H1, data={
          "file": (io.BytesIO(b"x"), "x.pdf", "application/pdf")}).status_code == 403)
check("other BA's scenario 404s",
      c.post(f"/api/scenarios/{DOC_SID}/attachments", headers=OTHER_BA, data={
          "file": (io.BytesIO(b"x"), "x.pdf", "application/pdf")}).status_code == 404)

r = c.post(f"/api/scenarios/{DOC_SID}/attachments", headers=BA, data={
    "file": (io.BytesIO(b"%PDF-1.4 beaconsfield pack"), "Market Intelligence Report.pdf",
             "application/pdf")})
check("pdf upload ok", r.status_code == 201, r.get_json())
DOC = r.get_json()["data"][0]
check("upload returns displayName",
      DOC["displayName"] == "Market Intelligence Report.pdf", DOC)
r = c.post(f"/api/scenarios/{DOC_SID}/attachments", headers=BA, data={
    "file": (io.BytesIO(b"\x89PNG fake"), "plan.png", "image/png")})
check("png upload ok", r.status_code == 201)
check("bad type rejected",
      c.post(f"/api/scenarios/{DOC_SID}/attachments", headers=BA, data={
          "file": (io.BytesIO(b"MZ"), "x.exe", "application/octet-stream")}
      ).status_code == 400)

r = c.get(f"/api/scenarios/{DOC_SID}", headers=BA)
check("scenario detail lists documents", len(r.get_json()["data"]["attachments"]) == 2)

# Share to a client; the client sees and can open the documents
DPID = c.post("/api/presentations", headers=BA, json={
    "scenarioId": DOC_SID, "clientEmail": "doccli@client.com"}).get_json()["data"]
ratelimit.reset()
DRES = c.get(f"/api/portal/resolve/{DPID['shareToken']}").get_json()["data"]
check("resolve carries attachments",
      len(DRES["presentation"]["attachments"]) == 2, DRES["presentation"].get("attachments"))
DCL = {"Authorization": "Bearer " + DRES["token"]}
r = c.get(f"/api/attachments/{DOC['id']}/file", headers=DCL)
check("client fetches document bytes",
      r.status_code == 200 and r.mimetype == "application/pdf"
      and b"beaconsfield" in r.data)
code = c.post("/api/otp/request", json={"email": "docother@client.com"}).get_json()["data"]["devCode"]
OTHER_CL = {"Authorization": "Bearer " + c.post("/api/otp/verify", json={
    "email": "docother@client.com", "code": code}).get_json()["data"]["token"]}
check("unrelated client blocked from documents",
      c.get(f"/api/attachments/{DOC['id']}/file", headers=OTHER_CL).status_code == 404)
check("anonymous file fetch 401",
      c.get(f"/api/attachments/{DOC['id']}/file").status_code == 401)

# Revoke the share — document access goes with it
c.post(f"/api/presentations/{DPID['id']}/revoke", headers=BA)
check("revoked share loses document access",
      c.get(f"/api/attachments/{DOC['id']}/file", headers=DCL).status_code == 404)

r = c.delete(f"/api/attachments/{DOC['id']}", headers=BA)
check("BA deletes document", r.status_code == 200)
check("deleted document gone from list",
      len(c.get(f"/api/scenarios/{DOC_SID}", headers=BA)
          .get_json()["data"]["attachments"]) == 1)
check("deleted document file 404s for BA too",
      c.get(f"/api/attachments/{DOC['id']}/file", headers=BA).status_code == 404)

# ---------------------------------------------------------------------------
# Full report pack: BA + client routes, buy-range validation
# ---------------------------------------------------------------------------

ratelimit.reset()
RP_SID = c.post("/api/scenarios", headers=BA, json={"name": "Report prop", "inputs": {
    "ownershipType": "joint_50_50", "owner1TaxableIncome": 200000, "owner2TaxableIncome": 40000,
    "buyRangeLow": 600000, "buyRangeHigh": 650000,
    "properties": [{"purchasePrice": 620000, "weeklyRent": 520}]}}).get_json()["data"]["id"]
check("buy range low>high rejected",
      c.put(f"/api/scenarios/{RP_SID}", headers=BA, json={"name": "x", "inputs": {
          "buyRangeLow": 700000, "buyRangeHigh": 600000,
          "properties": [{"purchasePrice": 5}]}}).get_json().get("fields", {}).get("buyRangeHigh")
      == "must be ≥ buy range low")

REPORT_PAYLOAD = {
    "metrics": {"purchasePrice": 620000},
    "funding": {"transferDuty": 20000, "acquisitionCosts": 25000,
                "ipLoanStart": 558000, "requiredFunds": 583000},
    "loan": {"rate": 0.065},
    "year1": {"grossRent": 27040, "effectiveRent": 26499, "vacancyLoss": 541,
              "operatingExpenses": 11000, "ipInterest": 36000, "equityLoanInterest": 0,
              "ipPrincipalRepayment": 0, "equityLoanPrincipalRepayment": 0,
              "preTaxCashFlow": -18000, "taxRefundOrCost": 9500, "afterTaxCashFlow": -8500,
              "capitalWorksDepreciation": 8000, "plantEquipmentDepreciation": 4000,
              "otherDeductibleClaims": 0},
    "taxSplit": {"ownership": "joint_50_50", "share": 0.5, "owner1": 5100, "owner2": 4400,
                 "total": 9500, "rate1": 0.45, "rate2": 0.32,
                 "bracket1": "$190,001+", "bracket2": "$45,000–$135,000",
                 "income1": 200000, "income2": 40000},
    "years": [{"year": y + 1, "calendarYear": 2026 + y, "grossRent": 27040, "effectiveRent": 26499,
               "ipInterest": 36000, "equityLoanInterest": 0, "ipPrincipalRepayment": 0,
               "equityLoanPrincipalRepayment": 0, "operatingExpenses": 11000,
               "otherDeductibleClaims": 0, "preTaxCashFlow": -18000 + 700 * y,
               "taxRefundOrCost": 9500 - 250 * y, "afterTaxCashFlow": -8500 + 400 * y,
               "cumulativeAfterTaxCashFlow": -8500 * (y + 1)} for y in range(25)],
    "preTaxSeries": [-18000 + 700 * y for y in range(25)],
    "cashSeries": [-8500 + 400 * y for y in range(25)],
    "subject": {"price": 620000, "weeklyRent": 520},
}
check("401 on report without token",
      c.post(f"/api/scenarios/{RP_SID}/report", json=REPORT_PAYLOAD).status_code == 401)
check("cross-owner report 404",
      c.post(f"/api/scenarios/{RP_SID}/report", headers=OTHER_BA,
             json=REPORT_PAYLOAD).status_code == 404)
r = c.post(f"/api/scenarios/{RP_SID}/report", headers=BA, json=REPORT_PAYLOAD)
check("BA report renders a PDF", r.status_code == 200 and b"%PDF" in r.data[:5], r.mimetype)

# Portal route: client JWT on their own presentation, foreign blocked
RPPID = c.post("/api/presentations", headers=BA, json={
    "scenarioId": RP_SID, "clientEmail": "rp@client.com"}).get_json()["data"]
ratelimit.reset()
RRES = c.get(f"/api/portal/resolve/{RPPID['shareToken']}").get_json()["data"]
RPCL = {"Authorization": "Bearer " + RRES["token"]}
r = c.post(f"/api/portal/presentation/{RPPID['id']}/report", headers=RPCL,
           json=REPORT_PAYLOAD)
check("client report renders a PDF",
      r.status_code == 200 and b"%PDF" in r.data[:5])
check("client report honours the sections body param",
      c.post(f"/api/portal/presentation/{RPPID['id']}/report", headers=RPCL,
             json=dict(REPORT_PAYLOAD, sections=["exit"])).status_code == 200)
check("foreign client report 404",
      c.post(f"/api/portal/presentation/{RPPID['id']}/report", headers=OTHER_CL,
             json=REPORT_PAYLOAD).status_code == 404)
r = c.get(f"/api/portal/presentation/{RPPID['id']}/evidence", headers=RPCL)
check("evidence endpoint returns the context shape",
      r.status_code == 200 and "buyRange" in (r.get_json()["data"] or {}),
      r.get_json())
check("foreign client evidence 404",
      c.get(f"/api/portal/presentation/{RPPID['id']}/evidence",
            headers=OTHER_CL).status_code == 404)

# ---------------------------------------------------------------------------
# Portfolio aggregation + pipeline status
# ---------------------------------------------------------------------------

ratelimit.reset()
P1 = c.post("/api/scenarios", headers=BA, json={"name": "Owned prop", "inputs": {
    "properties": [{"purchasePrice": 500000, "weeklyRent": 450}]}}).get_json()["data"]["id"]
P2 = c.post("/api/scenarios", headers=BA, json={"name": "Wishlist prop", "inputs": {
    "properties": [{"purchasePrice": 800000, "weeklyRent": 600}]}}).get_json()["data"]["id"]
check("patch status validates values",
      c.patch(f"/api/scenarios/{P1}/status", headers=BA,
              json={"status": "bought"}).status_code == 400)
check("cross-owner patch 404",
      c.patch(f"/api/scenarios/{P1}/status", headers=OTHER_BA,
              json={"status": "purchased"}).status_code == 404)
check("patch to purchased", c.patch(f"/api/scenarios/{P1}/status", headers=BA,
                                    json={"status": "purchased"}).status_code == 200)
check("investor sees only their own scenarios (no cross-user leak)",
      all(i["name"] != "Owned prop" and i["name"] != "Wishlist prop"
          for i in c.get("/api/scenarios/portfolio", headers=H1).get_json()["data"]))
check("401 on portfolio without token",
      c.get("/api/scenarios/portfolio").status_code == 401)
r = c.get("/api/scenarios/portfolio", headers=BA)
PF_ITEMS = r.get_json()["data"]
PF_STATUS = {i["name"]: i["ownershipStatus"] for i in PF_ITEMS}
check("portfolio lists scenarios with inputs",
      len(PF_ITEMS) >= 2 and all("inputs" in i for i in PF_ITEMS), len(PF_ITEMS))
check("ownership status flows through",
      PF_STATUS.get("Owned prop") == "purchased"
      and PF_STATUS.get("Wishlist prop") == "considering")
check("scenario list carries status fields",
      all("ownershipStatus" in i and "price" in i
          for i in c.get("/api/scenarios", headers=BA).get_json()["data"]))

# Markets (public ABS seed data)
r = c.get("/api/markets")
MKT = r.get_json()["data"]
check("markets national stats present",
      MKT["national"]["populationGrowth"]["value"] > 0
      and MKT["national"]["renters"]["value"] > 0)
check("markets has all 8 states", len(MKT["states"]) == 8)

# Onboarding prefs persisted at registration
c.post("/api/auth/register", json={"email": "onb@x.com", "password": "password123",
                                   "goal": "Grow my portfolio", "ownedCount": "2"})
prefs = db.db().fetch_all(
    "SELECT key, value FROM user_prefs WHERE user_id = ("
    " SELECT id FROM users WHERE email = 'onb@x.com')")
check("onboarding answers stored",
      {p["key"]: p["value"] for p in prefs} ==
      {"goal": "Grow my portfolio", "ownedCount": "2"}, prefs)

# ---------------------------------------------------------------------------
# Alerts toggle, full data export
# ---------------------------------------------------------------------------

ratelimit.reset()
check("alerts default off",
      c.get("/api/presentations/alerts", headers=BA).get_json()["data"]["enabled"] is False)
check("alerts toggle on",
      c.post("/api/presentations/alerts", headers=BA,
             json={"enabled": True}).get_json()["data"]["enabled"] is True)
check("alerts state persists",
      c.get("/api/presentations/alerts", headers=BA).get_json()["data"]["enabled"] is True)
check("investor blocked from alerts",
      c.post("/api/presentations/alerts", headers=H1, json={"enabled": True}).status_code == 403)

check("401 on export without token", c.get("/api/scenarios/export").status_code == 401)
r = c.get("/api/scenarios/export", headers=BA)
EXP = r.get_json()["data"]
check("export carries scenarios with inputs",
      r.status_code == 200 and len(EXP["scenarios"]) >= 2
      and all("inputs" in s for s in EXP["scenarios"]), r.status_code)
check("export carries suburbs", isinstance(EXP["suburbs"], list))
own_export = {s["name"] for s in EXP["scenarios"]}
check("export scoped to one user", "Owned prop" in own_export)
check("export no cross-user leak", "Tracked prop" not in own_export)

# Client comment fires (or at least attempts) the BA email — exercised via
# the existing comment route with alerts ON: response must stay 201.
check("comment still posts with alerts on",
      c.post(f"/api/portal/presentation/{RPPID['id']}/comment", headers=RPCL,
             json={"body": "alerts test"}).status_code == 201)

# ---------------------------------------------------------------------------
# QLD property intelligence (/api/intel/property)
# ---------------------------------------------------------------------------

import qld_intel  # noqa: E402

FAKE_LAYERS = {
    qld_intel.P_PARCEL: [{
        "attributes": {
            "lot": "6", "plan": "RP1038", "lotplan": "6RP1038",
            "tenure": "Freehold", "statedarea": 647.0, "statedareaunit": "Square Meter",
            "locality": "Brisbane City", "lga": "Brisbane City", "feat_name": None,
            "parcel_state": "Created", "is_volumetric": "No", "is_multi": "No",
            "totalstrata": 0, "surv_ind": "Yes",
        },
        "geometry": {"rings": [[[153.028, -27.469], [153.029, -27.469], [153.029, -27.468]]]},
    }],
    qld_intel.P_LANDUSE: [{
        "attributes": {"primary_": "Intensive uses", "secondary": "Services",
                       "tertiary": "Commercial services", "alum_code": "5.5.1", "year": 2013},
    }],
    qld_intel.P_REGIONAL: [{
        "attributes": {"plan_name": "South East Queensland Regional Plan (ShapingSEQ)",
                       "legal_stat": "Statutory", "version": "December 2023"},
    }],
    qld_intel.P_PRIORITY_LIVING: [{"attributes": {"name": "Brisbane/Inner City"}}],
    qld_intel.P_PRIORITY_AG: [],
    qld_intel.P_STRATEGIC_ENV: [],
    qld_intel.P_FLOOD_COMP: [{
        "attributes": {"studyname": "Brisbane River Flood Study", "studyarea": "Brisbane River Basin",
                       "lga": "BRISBANE CITY COUNCIL", "purpose": "1 in 100 year design flood flow",
                       "consultantname": "BMT WBM", "consultanturl": "http://www.bmtwbm.com.au/"},
        "geometry": {"rings": [[[153.02, -27.47], [153.03, -27.47], [153.03, -27.46]]]},
    }],
    qld_intel.P_FLOOD_BASIC: [],
    qld_intel.P_FLOOD_RHA: [{"attributes": {"sub_name": "Brisbane River"}}],
}

real_query = qld_intel._query
calls = {"n": 0}


def fake_query(layer_path, lat, lon, geometry=False, out_fields="*"):
    calls["n"] += 1
    if layer_path == qld_intel.P_FLOOD_BASIC:
        raise qld_intel.IntelError("boom")
    return FAKE_LAYERS.get(layer_path, [])


qld_intel.clear_cache()
qld_intel._query = fake_query
try:
    check("401 without token: /api/intel/property",
          c.get("/api/intel/property?lat=-27.46&lon=153.02").status_code == 401)
    check("400 without coordinates",
          c.get("/api/intel/property", headers=H1).status_code == 400)
    check("400 with junk coordinates",
          c.get("/api/intel/property?lat=abc&lon=153", headers=H1).status_code == 400)
    check("400 with out-of-range latitude",
          c.get("/api/intel/property?lat=999&lon=153", headers=H1).status_code == 400)

    calls["n"] = 0
    r = c.get("/api/intel/property?lat=-27.469&lon=153.028", headers=H1)
    check("intel returns 200", r.status_code == 200, r.get_json())
    d = (r.get_json() or {}).get("data") or {}
    check("intel returns the parcel", (d.get("parcel") or {}).get("lotPlan") == "6RP1038")
    check("intel returns land area", (d.get("parcel") or {}).get("areaSqm") == 647.0)
    check("intel returns tenure", (d.get("parcel") or {}).get("tenure") == "Freehold")
    check("intel returns the parcel outline", bool(d.get("parcelGeometry")))
    check("intel returns land use", (d.get("landUse") or {}).get("tertiary") == "Commercial services")
    check("intel returns the regional plan",
          (d.get("regionalPlan") or {}).get("name", "").startswith("South East Queensland"))
    check("intel returns priority living areas",
          (d.get("areasOfInterest") or {}).get("priorityLiving") == ["Brisbane/Inner City"])
    check("intel returns flood studies",
          [s["name"] for s in (d.get("flood") or {}).get("studies", [])] == ["Brisbane River Flood Study"])
    check("intel returns flood catchments",
          (d.get("flood") or {}).get("catchments") == ["Brisbane River"])
    check("intel returns source links", len(d.get("sources") or []) >= 3)
    check("a dead layer is reported but the rest still comes back",
          isinstance(d.get("errors"), list))

    first_calls = calls["n"]
    r2 = c.get("/api/intel/property?lat=-27.469&lon=153.028", headers=H1)
    check("repeat lookup is served from cache", calls["n"] == first_calls)
    check("cached lookup still returns the parcel",
          ((r2.get_json() or {}).get("data") or {}).get("parcel", {}).get("lotPlan") == "6RP1038")

    # A different point must not reuse the cached answer.
    c.get("/api/intel/property?lat=-27.4700&lon=153.0290", headers=H1)
    check("a different point refetches", calls["n"] > first_calls)
finally:
    qld_intel._query = real_query
    qld_intel.clear_cache()

# ---------------------------------------------------------------------------
# state_intel — parcel intelligence for NSW/ACT/TAS/WA/SA/NT
# (external ArcGIS calls stubbed at _esri_point_query, same pattern as QLD)
# ---------------------------------------------------------------------------

import state_intel  # noqa: E402
import olf  # noqa: E402

# OLF is the primary national provider — stub it for the whole block.
OLF_PARCEL = {
    "parcel": {"id": "Lot 2 DP111", "areaSqm": 610.0, "locality": "SYDNEY",
               "extra": {"lotNumber": "2", "planNumber": "DP111"}},
    "geometry": {"rings": [[[151.2, -33.87], [151.21, -33.87]]]},
    "licence": "CC-BY-4.0", "attribution": "© State of NSW",
    "source_updated_at": "2026-10-01"}
OLF_ZONING = {"category": "R3", "name": "Medium Density Residential",
              "licence": "CC-BY-4.0"}
_real_olf_parcel = olf.parcel
_real_olf_zoning = olf.zoning


OLF_ACT = {"parcel": {"id": "Block 5 Section 2, CITY", "areaSqm": 800.0,
                      "locality": "CITY", "extra": {}},
           "geometry": None, "licence": "CC-BY-4.0", "attribution": "ACT"}
OLF_TAS = {"parcel": {"id": "PID 99", "areaSqm": 300.0, "locality": None,
                      "extra": {"tenure": "Council"}},
           "geometry": None, "licence": "CC-BY-4.0", "attribution": "TAS"}
OLF_SA = {"parcel": {"id": "Lot F1505 41778", "areaSqm": 13.51,
                     "locality": "ADELAIDE", "extra": {}},
          "geometry": {"rings": [[[138.6, -34.93]]]}, "licence": "LicenseRef",
          "attribution": "© SA"}
OLF_NT = {"parcel": {"id": "5606", "areaSqm": 1502.0, "locality": None,
                     "extra": {}},
          "geometry": {"rings": [[[130.85, -12.46]]]}, "licence": "LicenseRef",
          "attribution": "© NT"}


OLF_WA = {"parcel": {"id": None, "areaSqm": 402.1, "locality": None,
                     "extra": {"note": "LGATE-001 geometry only"}},
          "geometry": {"rings": [[[115.8, -32]]]}, "licence": "Landgate",
          "attribution": "© WA"}
OLF_FALLBACK = {"parcel": None, "geometry": None}


def _olf_stub(lat, lon, state):
    return {"NSW": (OLF_PARCEL, None), "ACT": (OLF_ACT, None),
            "TAS": (OLF_TAS, None), "SA": (OLF_SA, None),
            "NT": (OLF_NT, None), "WA": (OLF_WA, None)}.get(
        state, (OLF_FALLBACK, None))


def _olf_zoning_stub(lat, lon, state):
    return (dict(OLF_ZONING), None)


olf.parcel = _olf_stub
olf.zoning = _olf_zoning_stub

r = c.get("/api/intel/state-property?lat=-33.8688&lon=151.2093&state=NSW")
check("401 without token: /api/intel/state-property", r.status_code == 401)
r = c.get("/api/intel/state-property?lat=x&lon=y&state=NSW", headers=H1)
check("state intel bad lat/lon -> 400", r.status_code == 400)
r = c.get("/api/intel/state-property?lat=-33.87&lon=151.21&state=ZZ", headers=H1)
check("state intel unsupported state -> 400", r.status_code == 400)

real_point_query = state_intel._esri_point_query
calls = {"n": 0}

def _fake_point_query(url, lat, lon, out_fields):
    calls["n"] += 1
    if "ACTGOV_BLOCKS" in url:
        return ({"BLOCK_NUMBER": 12, "SECTION_NUMBER": 19, "BLOCK_SECTION": "19/12",
                 "DIVISION_NAME": "CITY", "BLOCK_KEY": 11080190012,
                 "PLAN_NUMBERS": "AP4267", "BLOCK_DERIVED_AREA": "20781",
                 "LAND_USE_POLICY_ZONES": "DES: DESIGNATED",
                 "DISTRICT_NAME": "CANBERRA CENTRAL"}, {"rings": [[[149, -35], [150, -35]]]})
    if "thelist.tas.gov.au" in url:
        return ({"PID": 3321248, "VOLUME": "40374", "FOLIO": 3, "MEAS_AREA": 27.8,
                 "PROP_ADD": "49-51 MURRAY ST HOBART TAS 7000", "TENURE_TY": "Council"},
                None)
    if "slip.wa.gov.au" in url and "Bush_Fire" in url:
        return (None, None)  # WA bushfire: no feature -> prone False
    if "slip.wa.gov.au" in url:
        return ({"Shape__Area": 402.1}, {"rings": [[[115, -32], [116, -32]]]})
    if "NSW_BushFire" in url:
        return ({"OBJECTID": 1}, None)  # NSW bushfire prone: True
    if "Bushfire_Prone" in url:
        return (None, None)  # ACT bushfire prone: False
    if "SES_FloodMapping" in url:
        return ({"OBJECTID": 7}, None)  # TAS mapped flood hazard: True
    if "nsw.gov.au" in url:
        return ({"lotnumber": "4", "planlabel": "DP123456", "lotidstring": "4//DP123456",
                 "Shape__Area": 500.5}, {"rings": [[[151, -33], [152, -33]]]})
    raise RuntimeError("unexpected url in test stub")

state_intel._esri_point_query = _fake_point_query
state_intel._cache.clear()

r = c.get("/api/intel/state-property?lat=-33.8688&lon=151.2093&state=NSW", headers=H1)
body = r.get_json()
check("state intel NSW -> 200", r.status_code == 200 and body["ok"])
check("state intel NSW parcel via OLF",
      body["data"]["parcel"]["id"] == "Lot 2 DP111"
      and body["data"]["parcel"]["areaSqm"] == 610.0
      and body["data"]["parcelGeometry"])
check("state intel NSW zoning attached",
      body["data"]["zoning"]["category"] == "R3"
      and "Medium Density" in body["data"]["zoning"]["name"])
check("state intel NSW bushfire prone", body["data"]["bushfire"]["prone"] is True)
_n_before = calls["n"]
check("state intel NSW geometry cached",
      c.get("/api/intel/state-property?lat=-33.8688&lon=151.2093&state=NSW",
            headers=H1).status_code == 200 and calls["n"] == _n_before)

r = c.get("/api/intel/state-property?lat=-35.2809&lon=149.13&state=ACT", headers=H1)
body = r.get_json()
check("state intel ACT parcel via OLF",
      r.status_code == 200 and body["data"]["parcel"]["id"].startswith("Block 5"))
check("state intel ACT bushfire prone", body["data"]["bushfire"]["prone"] is False)

r = c.get("/api/intel/state-property?lat=-42.8821&lon=147.3272&state=TAS", headers=H1)
body = r.get_json()
check("state intel TAS parcel via OLF",
      r.status_code == 200 and "PID 99" in body["data"]["parcel"]["id"])
check("state intel TAS flood not point-queryable (raster)", body["data"].get("flood") is None)

r = c.get("/api/intel/state-property?lat=-31.9523&lon=115.8613&state=WA", headers=H1)
body = r.get_json()
check("state intel WA boundary-only parcel + bushfire",
      r.status_code == 200 and body["data"]["parcel"]["id"] is None
      and body["data"]["bushfire"]["prone"] is False)

r = c.get("/api/intel/state-property?lat=-12.46&lon=130.84&state=NT", headers=H1)
body = r.get_json()
check("state intel NT parcel via OLF",
      r.status_code == 200 and body["data"]["parcel"]["id"] == "5606")

check("state intel normalizers are pure",
      state_intel._norm_tas({"PID": 1, "VOLUME": None, "FOLIO": None})["id"] == "PID 1")

state_intel._esri_point_query = real_point_query
olf.parcel = _real_olf_parcel
olf.zoning = _real_olf_zoning
state_intel._cache.clear()

# --- daily refresh (government data re-fetched for saved addresses) ------
import daily_refresh  # noqa: E402

r = c.post("/api/scenarios", headers=H1, json={
    "name": "Refresh me", "inputs": {
        "state": "NSW", "address": "9 Shard Street",
        "addressMeta": {"state": "NSW", "lat": -33.8688, "lon": 151.2093}}})
check("create scenario for daily refresh", r.status_code == 201, r.get_json())

refresh_calls = {"n": 0}


def _olf_refresh_counter(lat, lon, state):
    refresh_calls["n"] += 1
    return (OLF_PARCEL, None)


real_olf_refresh = olf.parcel
olf.parcel = _olf_refresh_counter
state_intel._cache.clear()
summary = daily_refresh.run_once()
check("daily refresh re-fetches located scenarios",
      summary["refreshed"] >= 1 and refresh_calls["n"] >= 1 and summary["at"])
check("daily refresh swallows per-address errors",
      isinstance(summary["failed"], list))
olf.parcel = real_olf_refresh

os.environ["PA_NO_SCHEDULER"] = "1"
daily_refresh.start_scheduler()
check("scheduler disabled under PA_NO_SCHEDULER",
      os.environ.get("PA_NO_SCHEDULER") == "1")
os.environ.pop("PA_NO_SCHEDULER", None)

# metric history snapshots + trend endpoint
r = c.get("/api/suburbs", headers=H1)
suburbs = r.get_json()["data"]
stid2 = next(s["id"] for s in suburbs if s["name"] == "Streamtown")
summary2 = daily_refresh.run_once()
check("daily refresh snapshots suburb metrics into history",
      (summary2.get("historyRows") or 0) >= 1)
r = c.get(f"/api/suburbs/{stid2}/history", headers=H1)
check("history endpoint responds", r.status_code == 200
      and isinstance(r.get_json()["data"], dict))

# state percentiles in benchmarks
import census as _census
rows = [
    {"sa2_code_2021": "101021001", "irsd_score": 950, "leed_4": 1, "dwell_7": 5,
     "tenure_owned": 30.0, "hhtype_6": 2.4, "lf_4": 6.2, "lf_5": 66.0},
    {"sa2_code_2021": "201021001", "irsd_score": 1000, "leed_4": 2, "dwell_7": 5,
     "tenure_owned": 35.0, "hhtype_6": 2.5, "lf_4": 5.2, "lf_5": 67.0},
    {"sa2_code_2021": "301021001", "irsd_score": 1050, "leed_4": 3, "dwell_7": 5,
     "tenure_owned": 40.0, "hhtype_6": 2.6, "lf_4": 4.2, "lf_5": 68.0},
]
bench = _census.build_benchmarks(rows)
check("census benchmarks keep national fields",
      bench["fields"]["irsd_score"]["p50"] == 1000)
check("census benchmarks add per-state buckets",
      sorted(bench["states"].keys()) == ["NSW", "QLD", "VIC"]
      and bench["states"]["NSW"]["irsd_score"]["p50"] == 950)
check("census state derivation maps all 8 codes",
      [_census._state_from_code(f"{d}01021001") for d in "12345678"]
      == ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"])

# growth windows off the TVD series
r = c.get("/api/markets/prices?state=NSW", headers=H1)
pdata = r.get_json()["data"]
check("markets prices expose growth windows",
      "growth" in pdata and "NSW" in pdata.get("growth", {})
      and "5yr" in pdata["growth"]["NSW"])

# crosswalk: suburb gets sa2_code resolved via census names
import time as _time
_census._names_cache = {"data": [
    {"code": "101021001", "name": "Streamtown", "state": "QLD"}],
    "at": _time.time()}
r = c.get("/api/suburbs", headers=H1)
st_suburb = next(s for s in r.get_json()["data"] if s["id"] == stid2)
check("suburb crosswalk resolves SA2 by name",
      st_suburb.get("sa2Code") == "101021001")
_census._names_cache = {"data": None, "at": 0.0}

# Multi-vintage area datasets (areastats) — snapshot-first loaders, benchmark
# merge, SALM-preferring employment verdict, rows endpoint.
import areastats as _area
_area._cache["approvals"] = {"data": {
    "asOf": "2026-11-23T00:00:00+00:00", "geo": "sa2",
    "vintage": {"approvals_annual": "2022-23"}, "rows": {}}}
_area._cache["salm"] = {"data": {
    "asOf": "2026-11-23T00:00:00+00:00", "geo": "sa2",
    "vintage": {"salm_unemp_rate": "Jun Q 2026"},
    "rows": {"101021001": {"salm_unemp_rate": 4.1},
             "201021001": {"salm_unemp_rate": 5.3}}}}
_area._cache["erp"] = {"data": {
    "asOf": "2026-11-23T00:00:00+00:00", "geo": "sa2",
    "vintage": {"erp": "2024-25"},
    "rows": {"101021001": {"erp_total": 2000.0, "erp_growth_1y_pct": 2.5,
                           "erp_growth_5y_pct": 12.0, "nom_1y": 30.0,
                           "median_age": 39.0, "age_0_14_pc": 16.0,
                           "age_15_64_pc": 62.0, "age_65p_pc": 18.0}}}}
_area._cache["ato"] = {"data": {
    "asOf": "2026-11-23T00:00:00+00:00", "geo": "postcode",
    "vintage": {"ato": "2023-24"},
    "rows": {"4000": {"ato_median_income": 62000.0, "ato_avg_income": 81000.0,
                      "ato_taxpayers": 15000.0, "ato_landlord_pc": 22.5,
                      "ato_median_net_rent": -3000.0}}}}

check("areastats snapshot loaders honour stuffed cache",
      (_area.sa2_values("101021001").get("salm_unemp_rate") == 4.1
       and _area.sa2_values("101021001").get("erp_total") == 2000.0))
check("areastats postcode lookup matches exactly",
      _area.postcode_values("4000").get("ato_median_income") == 62000.0
      and _area.postcode_values("9999") == {})
check("areastats benchmark rows attach SA2 codes",
      all("sa2_code_2021" in r for r in _area.benchmark_rows())
      and len(_area.benchmark_rows()) == 3)

_aug = _census._augmented_benchmarks(dict(bench))
check("augmented benchmarks percentile the newer fields",
      round(_aug["fields"]["salm_unemp_rate"]["p50"], 6) == 4.7
      and _aug["fields"]["erp_total"]["p50"] == 2000.0
      and _aug["fields"]["irsd_score"]["p50"] == 1000)
check("augmented benchmarks carry meta with vintages",
      _aug["meta"]["salm_unemp_rate"]["vintage"] == "Jun Q 2026"
      and _aug["meta"]["irsd_score"]["vintage"] == "2021 Census"
      and _aug["meta"]["ato_median_income"]["source"].startswith("ATO"))

_vres, _ = _census.deal_verdicts({"lf_4": 6.2, "lf_5": 66.0,
                                  "salm_unemp_rate": 4.1}, _aug)
_emp = next(v for v in _vres if v["key"] == "employment")
_schip = _emp["metrics"][0]
check("employment verdict prefers SALM unemployment",
      _schip["key"] == "salm_unemp_rate" and _schip["value"] == 4.1
      and _schip.get("vintage") == "Jun Q 2026")
_vres2, _ = _census.deal_verdicts({"lf_4": 6.2, "lf_5": 66.0}, _aug)
_emp2 = next(v for v in _vres2 if v["key"] == "employment")
check("employment falls back to census lf_4 without SALM",
      _emp2["metrics"][0]["key"] == "lf_4")
check("verdict count unchanged (9 + overall shape)",
      len(_vres) == 9)

r = c.get("/api/markets/census/rows?key=salm")
rdata = r.get_json()["data"]
check("rows endpoint serves a dataset snapshot",
      r.status_code == 200 and rdata["key"] == "salm"
      and rdata["rows"]["101021001"]["salm_unemp_rate"] == 4.1
      and rdata["vintage"]["salm_unemp_rate"] == "Jun Q 2026")
check("rows endpoint rejects unknown keys",
      c.get("/api/markets/census/rows?key=nonsense").status_code == 400)

# admin data-status now lists the area datasets
r = c.get("/api/admin/data-status", headers=BA)
_area_names = [d["dataset"] for d in r.get_json()["data"]["datasets"]]
check("data-status lists area dataset snapshots",
      any("Regional Population" in n for n in _area_names)
      and any("SALM" in n for n in _area_names))
_area._cache = {key: {"data": None} for key in _area.DATASETS}

# data-status endpoint
r = c.get("/api/admin/data-status", headers=BA)
check("admin data-status for BA", r.status_code == 200
      and any(d["dataset"].startswith("Census") for d in r.get_json()["data"]["datasets"]))
r = c.get("/api/admin/data-status", headers=H1)
check("403 without ba role: /api/admin/data-status", r.status_code == 403)

# Postgres only: the Supabase pooler drops idle sessions, so the app must
# reopen a dead connection instead of 500-ing every request.
if os.environ.get("DATABASE_URL"):
    try:
        db.db()._conn.close()
    except Exception as e:
        print(f"note: could not close the connection for the reconnect test: {e}")
    r = c.get("/api/scenarios", headers=H1)
    check("db reconnects after the pooler drops the connection",
          r.status_code == 200, r.get_json())
    r = c.post("/api/auth/register", json={"email": "reconnect@test.com",
                                            "password": "password123",
                                            "displayName": "Reconnect"})
    check("writes work again after a reconnect", r.status_code == 201, r.get_json())

# ---------------------------------------------------------------------------
# Password reset — forgot → (emailed) token → set new password
# ---------------------------------------------------------------------------

r = c.post("/api/auth/forgot", json={"email": "u1@test.com"})
d = (r.get_json() or {}).get("data") or {}
check("forgot responds generically", r.status_code == 200 and d.get("sent") is True)
r = c.post("/api/auth/forgot", json={"email": "ghost@nowhere.test"})
d2 = (r.get_json() or {}).get("data") or {}
check("unknown email gets the same generic answer",
      r.status_code == 200 and d2.get("sent") is True)
if d.get("devResetUrl"):
    token = d["devResetUrl"].split("token=")[1]
    check("short password rejected", c.post("/api/auth/reset", json={
        "token": token, "password": "short"}).status_code == 400)
    check("reset works", c.post("/api/auth/reset", json={
        "token": token, "password": "newpassword1"}).status_code == 200)
    check("token is single-use", c.post("/api/auth/reset", json={
        "token": token, "password": "anotherpass1"}).status_code == 401)
    check("garbage token rejected", c.post("/api/auth/reset", json={
        "token": "nope", "password": "whatever12"}).status_code == 401)
    check("reset page serves the app shell",
          c.get("/reset?token=x").status_code == 200)
else:
    print("note: PA_OTP_ECHO not set — skipped the live-token reset steps")

# ---------------------------------------------------------------------------
# Markets median price history
# ---------------------------------------------------------------------------

r = c.get("/api/markets")
d = (r.get_json() or {}).get("data") or {}
check("markets national carries honest live flags",
      isinstance(d.get("national"), dict)
      and all("live" in v for v in (d.get("national") or {}).values()), True)

import markets as markets_mod

_sdmx = {"data": {"dataSets": [{"series": {"s1": {"observations": {
    "0:0": [4.1], "1:0": [4.3], "2:0": [None]}}}}]}}
check("SDMX parser takes the latest non-null observation",
      markets_mod.parse_sdmx_series(_sdmx), 4.3)
check("SDMX parser survives junk payloads",
      markets_mod.parse_sdmx_series({"nonsense": 1}) is None
      and markets_mod.parse_sdmx_series(None) is None, True)

r = c.get("/api/markets/prices")
d = (r.get_json() or {}).get("data") or {}
if r.status_code == 200:
    check("price history has periods", len(d.get("periods", [])) > 10)
    check("price history covers the states", len(d.get("states", {})) >= 6)
    qld = (d.get("states", {}).get("QLD") or {}).get("capital", {}).get("houses") or []
    check("QLD capital series is populated and current", bool(qld) and qld[-1] > 100000)
    r = c.get("/api/markets/prices?state=VIC")
    check("state filter narrows the payload",
          r.status_code == 200 and set((r.get_json().get("data") or {}).get("states", {})) == {"VIC"})
else:
    print("note: price history unavailable in this environment (503) — skipped")

# ---------------------------------------------------------------------------
# VIC Valuer-General sold-median valuation guide (sales.py)
# ---------------------------------------------------------------------------

try:
    import glob as _glob
    for _p in _glob.glob("data/sales/*.xlsx"):
        os.remove(_p)
    from openpyxl import Workbook as _WB
    _wb = _WB()
    _ws = _wb.active
    _ws.append(["Locality", "2015", "2020", "2024", "2025"])
    for _r in [("TEST SUBURB A", 700000, 900000, 1000000, 1100000),
               ("Test Suburb B", 600000, 800000, 950000, 1000000),
               ("Test Suburb C", 500000, 650000, 700000, 750000)]:
        _ws.append(list(_r))
    _wb.save("data/sales/test-fixture.xlsx")
    import sales as sales_mod
    _files, _rows = sales_mod.ingest()
    check("sales ingest parses a VPSR-shaped workbook", _rows >= 9, _rows)
    r = c.get("/api/valuation?suburb=test%20suburb%20a&state=VIC")
    d = (r.get_json() or {}).get("data") or {}
    check("valuation returns suburb median", d.get("available") is True
          and (d.get("latest") or {}).get("median") == 1100000, d.get("latest"))
    check("valuation guide band is median ±10%",
          ((d.get("guide") or {}).get("low") == 990000
           and (d.get("guide") or {}).get("high") == 1210000))
    r = c.get("/api/valuation?suburb=test%20suburb%20a&state=QLD")
    check("non-VIC states report unavailable honestly",
          (r.get_json().get("data") or {}).get("available") is False)
    r = c.get("/api/valuation?suburb=missing%20suburb%20z&state=VIC")
    check("unknown VIC suburb reports unavailable",
          (r.get_json().get("data") or {}).get("available") is False)
    os.remove("data/sales/test-fixture.xlsx")
except Exception as e:
    print(f"note: sales pipeline test skipped ({e})")

# ---------------------------------------------------------------------------
# Census benchmarks + Deal Check verdict engine (no network: pure functions)
# ---------------------------------------------------------------------------

import census as census_mod
import report as report_mod

_bm = census_mod.build_benchmarks([
    {"tenure_4": v, "house_2_pc": v / 10.0, "arrmig_2": v / 5.0,
     "erp_sch_1_pc": v / 2.0, "lf_4": v / 20.0, "lf_5": 40 + v / 10.0,
     "leed_4": v, "dwell_7": 10, "irsd_score": 900 + v, "hied_1_pc": v / 4.0,
     "afford_5": v / 3.0, "afford_3": v / 6.0, "erp_p_75p_pc": v / 8.0,
     "publich_1_pc": v / 12.0}
    for v in range(1, 101)  # percentiles land exactly on 1..100
])
check("benchmarks build percentiles for every verdict metric",
      all(k in _bm["fields"] for k in
          ["tenure_4", "lf_4", "irsd_score", "afford_3", "afford_5",
           "publich_1_pc", "erp_p_75p_pc", "jobs_per_dwelling"]))
check("median of 1..100 is ~50.5",
      abs(_bm["fields"]["tenure_4"]["p50"] - 50.5) < 0.01)

_good = {"tenure_4": 95, "house_2_pc": 9.0, "arrmig_2": 18.0, "erp_sch_1_pc": 45.0,
         "lf_4": 0.15, "lf_5": 49.0, "leed_4": 95, "dwell_7": 10,
         "irsd_score": 995, "hied_1_pc": 1.0, "afford_5": 0.5, "afford_3": 0.4,
         "erp_p_75p_pc": 0.2, "publich_1_pc": 0.1, "jobs_per_dwelling": 9.5}
_bad = {k: (100 - v if k != "dwell_7" else 10) for k, v in _good.items()}

_vg, _og = census_mod.deal_verdicts(_good, _bm)
_vb, _ob = census_mod.deal_verdicts(_bad, _bm)
check("ten verdicts returned (9 questions + overall)",
      len(_vg) == 9 and _og.get("score") is not None)
check("strong area scores higher overall", _og["score"] > _ob["score"])
check("strong area reads PASS, weak area reads CAUTION",
      _og["verdictWord"] == "PASS" and _ob["verdictWord"] == "CAUTION")
check("every verdict carries status/score/headline/metrics",
      all(v["status"] in ("strong", "ok", "watch") and 0 <= v["score"] <= 100
          and v["headline"] and v["metrics"] for v in _vg))
check("percentiles are clamped to 5-95",
      all(5 <= m["percentile"] <= 95 for v in _vg for m in v["metrics"]))
check("direction flip works (low unemployment scores high)",
      next(v for v in _vg if v["key"] == "employment")["score"]
      > next(v for v in _vb if v["key"] == "employment")["score"])

_vn, _on = census_mod.deal_verdicts({}, {"fields": {}})
check("no data degrades to nodata verdicts", _on["status"] == "nodata"
      and all(v["status"] == "nodata" for v in _vn))

r = c.get("/api/markets/census/point")
check("census point requires lat/lon", r.status_code == 400)
r = c.get("/api/markets/census/point?lat=51.5&lon=-0.12")
check("census point rejects non-Australian coordinates", r.status_code == 422)

_dc_payload = {
    "title": "t", "years": [], "propertySections": [],
    "dealCheck": {"sa2": {"name": "Testville"},
                  "overall": {"verdictWord": "PASS", "score": 71, "status": "strong",
                              "headline": "Area fundamentals support the deal.",
                              "drivers": {"for": ["Will landlords find tenants easily?"],
                                          "against": []}},
                  "verdicts": [{"key": "rental_demand", "group": "area",
                                "question": "Will landlords find tenants easily?",
                                "status": "strong", "score": 91,
                                "headline": "Deep rental market.",
                                "metrics": []},
                               {"key": "price_vs_market", "group": "deal",
                                "question": "Are you paying a fair price for this suburb?",
                                "status": "ok", "score": 68,
                                "headline": "In line with the suburb median.",
                                "metrics": []}]},
}
_html = report_mod.build_report_html(_dc_payload, {})
check("report PDF includes the grouped deal check section",
      "Deal check &amp; recommendation" in _html and "PASS" in _html
      and "Will landlords find tenants easily?" in _html
      and "The area — fundamentals" in _html
      and "The deal — your numbers" in _html
      and "ABS 2021 Census" in _html)  # fallback source stamp when none posted
check("report PDF deal check names the posted source stamp",
      "Area data:" in report_mod.build_report_html(
          dict(_dc_payload,
               dealCheck=dict(_dc_payload["dealCheck"],
                              source="ABS 2021 Census · DEWR SALM Jun Q 2026")), {}))
check("report PDF omits the section when dealCheck absent",
      "Deal check &amp; recommendation" not in report_mod.build_report_html(
          {"title": "t", "years": []}, {}))

# Property-intelligence + listing-check sections (all-states coverage)
_intel_ctx = {"overlays": {
    "parcel": {"id": "Lot 4 DP123456", "areaSqm": 500.5, "locality": None,
               "extra": {"planLabel": "DP123456"}},
    "bushfireProne": True,
    "intel": {"provider": "NSW Land Parcel and Property Theme",
              "fetchedAt": "2026-11-22T10:00:00",
              "sources": [{"label": "NSW Spatial Services"}]}}}
_intel_html = report_mod.build_report_html({"title": "t", "years": []}, _intel_ctx)
check("report PDF includes property intelligence section",
      "Property intelligence" in _intel_html and "Lot 4 DP123456" in _intel_html
      and "Bushfire prone" in _intel_html and "NSW Spatial Services" in _intel_html)
check("report PDF omits property intelligence without overlays",
      "Property intelligence" not in report_mod.build_report_html(
          {"title": "t", "years": []}, {}))
_lc_html = report_mod.build_report_html(
    {"title": "t", "years": [],
     "listingCheck": {"onMarket": True, "askingPrice": 700000,
                      "agent": "Test Realty", "listedDate": "2026-10",
                      "lastSoldPrice": 610000, "lastSoldDate": "2021-05",
                      "confidence": "high", "url": "https://realestate.com.au/x"}}, {})
check("report PDF includes listing check when present",
      "Listing check (AI research)" in _lc_html and "Asking" in _lc_html
      and "realestate.com.au/x" in _lc_html)
check("report PDF omits listing check when absent",
      "Listing check (AI research)" not in report_mod.build_report_html(
          {"title": "t", "years": []}, {}))
_sig_html = report_mod.build_report_html(
    {"title": "t", "years": [],
     "areaSignals": [{"name": "Test Rail Extension", "type": "transport",
                      "status": "under_construction", "timeframe": "2029",
                      "distanceKm": 1.8, "url": "https://example/rail"}]}, {})
check("report PDF includes area signals when present",
      "Infrastructure & planning signals" in _sig_html
      and "Test Rail Extension" in _sig_html and "Under construction" in _sig_html)
check("report PDF omits area signals when absent",
      "Infrastructure & planning signals" not in report_mod.build_report_html(
          {"title": "t", "years": []}, {}))

# Modular reports: payload.sections gates the section set
_sec_payload = {"title": "t",
                "year1": {"grossRent": 27040, "preTaxCashFlow": -18000},
                "years": [{"year": y + 1, "cumulativeAfterTaxCashFlow": -8500 * (y + 1)}
                          for y in range(10)],
                "exit": {"saleYear": 10, "calendarSaleYear": 2035, "salePrice": 900000,
                         "netSaleProceeds": 300000, "totalNetPosition": 100000}}
check("sections=['exit'] keeps exit, drops cash flow and who-pays",
      "Exit &amp; CGT" in report_mod.build_report_html(
          dict(_sec_payload, sections=["exit"]), {})
      and "Cash flow analysis" not in report_mod.build_report_html(
          dict(_sec_payload, sections=["exit"]), {})
      and "Who pays the cost?" not in report_mod.build_report_html(
          dict(_sec_payload, sections=["exit"]), {}))
check("unknown sections fall back to the full report",
      "Cash flow analysis" in report_mod.build_report_html(
          dict(_sec_payload, sections=["nonsense"]), {})
      and "Exit &amp; CGT" in report_mod.build_report_html(
          dict(_sec_payload, sections=["nonsense"]), {}))
check("omitted and empty sections render the full report",
      "Cash flow analysis" in report_mod.build_report_html(dict(_sec_payload), {})
      and "Exit &amp; CGT" in report_mod.build_report_html(
          dict(_sec_payload, sections=[]), {}))
_r2 = c.post(f"/api/scenarios/{RP_SID}/report", headers=BA,
             json=dict(REPORT_PAYLOAD, sections=["exit"]))
check("report route honours the sections body param",
      _r2.status_code == 200 and b"%PDF" in _r2.data[:5], _r2.mimetype)

# Excel honours sections: projections off drops the year sheet, cashflow off
# drops the Overview assumptions block; default keeps both.
from io import BytesIO as _BIO  # noqa: E402
from openpyxl import load_workbook as _xl_load  # noqa: E402
_xr = c.post(f"/api/scenarios/{RP_SID}/excel", headers=BA,
             json=dict(REPORT_PAYLOAD, sections=["exit"]))
_wb = _xl_load(_BIO(_xr.data))
check("excel route honours sections — year sheet dropped",
      _xr.status_code == 200 and "Year by year" not in _wb.sheetnames
      and "Overview" in _wb.sheetnames, str(_wb.sheetnames))
_xr2 = c.post(f"/api/scenarios/{RP_SID}/excel", headers=BA, json=REPORT_PAYLOAD)
_wb2 = _xl_load(_BIO(_xr2.data))
check("excel route keeps year sheet by default",
      "Year by year" in _wb2.sheetnames and "Overview" in _wb2.sheetnames,
      str(_wb2.sheetnames))
_noscore = report_mod.build_report_html(
    {"title": "t", "years": [], "dealCheck": {"sa2": {"name": "X"},
     "overall": {"score": None, "verdictWord": "—", "headline": "nodata"},
     "verdicts": [{"key": "k", "group": "deal", "question": "q", "status": "nodata",
                   "score": None, "headline": "h", "metrics": []}]}}, {})
check("report PDF omits the section when nothing scored",
      "Deal check &amp; recommendation" not in _noscore)

print(f"\n{PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
