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
             ("PA_DOMAIN_CLIENT_ID", "PA_DOMAIN_CLIENT_SECRET", "PA_ANTHROPIC_API_KEY")}
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

    os.environ["PA_ANTHROPIC_API_KEY"] = "test-key"

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
         "confidence": "WEIRD"},
    ])
    check("sanitize drops address-less and priceless rows", len(clean) == 2)
    check("sanitize blanks non-http urls",
          all(r2["url"] == "" or r2["url"].startswith("https://") for r2 in clean))
    check("sanitize defaults weird confidence to low",
          [r2["confidence"] for r2 in clean] == ["low", "low"])

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
    "tagline": "Independent advice, data first"})
check("BA saves branding", r.status_code == 200 and r.get_json()["data"]["businessName"] == "Smith Property Buyers")
r = c.put("/api/branding", headers=BA, json={"accentColor": "red"})
check("bad accent colour rejected", r.status_code == 400)

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

print(f"\n{PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
