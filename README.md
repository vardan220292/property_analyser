# Property Analyser

Australian (QLD) investment property analysis tool: full-tax cash flow,
long-term projections, borrowing capacity, and scenario comparison — built
for a purchase funded partly by equity released from the PPOR.

## Run

```bash
./run.sh
# -> http://127.0.0.1:4180
```

First visit: create an account (email + password, min 8 chars) — each
person's scenarios are private to them. The very first account claims any
scenarios that predate logins. Share on your LAN with `HOST=0.0.0.0`
in `.env`; put it behind HTTPS before exposing it beyond your home.

## What it models

- **Cash flow (after tax)** — rent, vacancy, QLD property management norms,
  rates/water/insurance/strata/maintenance, land tax (recomputed yearly as
  land values grow), IP loan (IO then P&I over remaining term), the
  equity-release loan against the PPOR (real cash cost AND deductible via
  the purpose test), depreciation (Div 43 capital works 2.5%/yr + Div 40
  plant & equipment for new builds only), negative-gearing refund at your
  marginal rate.
- **Projections** — year-by-year value/debt/equity, cash flow, cumulative
  position over up to 50 years.
- **Exit / CGT** — cost base (price + duty + acquisition costs − capital
  works claimed), 50% discount, CGT at each owner's marginal rate,
  waterfall to net proceeds.
- **Borrowing capacity** — APRA-style: all loans assessed as P&I at
  rate + 3% buffer, 20% rent shading, max additional loan, DTI.
- **Scenarios** — save/load/duplicate in SQLite, compare up to 3 side by
  side. Drafts auto-save to localStorage.

## Area report (no AI, no paid APIs)

Reference data you can edit in-app, seeded from public sources with an
"as of" date and source per field:

- **Suburb snapshot** — median sale price, median rents by bedroom, vacancy
  rate, 5-yr capital growth, population growth, days on market, plus
  link-outs to REA, RTA, SQM, QLD land valuation and QLD Globe.
- **Investment score (0-100)** — seven transparent factors: gross yield,
  price vs suburb median, land-to-value ratio, suburb vacancy, suburb
  growth, your rent vs the suburb median for the bedroom count, and supply
  pressure from building approvals. Each factor shows its points, band,
  rationale and source. Factors without data are dropped from the total
  rather than guessed.
- **Comparable sales** — paste from realestate.com.au; the app derives
  $/m², implied gross yield and price vs the subject property.
- **Bank investor rates** — advertised IO/P&I rates per bank, editable.

Seed files live in `data/seed/*.json` and load idempotently at boot, so
your edits to seeded rows survive restarts.

## Property intelligence (live QLD open data)

Pick an address in Inputs and the **Property** section pulls live data for
that exact point from the Queensland Government's spatial services — no API
keys, no signup:

**Finding the address.** Both the investment property and the PPOR home have
autocomplete, and a typed address is located on the way out of the field, so
the map always lands on the right parcel:

- **Esri World Geocoding Service** (keyless at low volume; set
  `PA_ARCGIS_API_KEY` for a free key) resolves AU house numbers and units to
  a point. It also fixes spelling — "14 Fawlers St" comes back as
  "14 Fowler Street".
- **Domain.com.au** (`PA_DOMAIN_CLIENT_ID`/`SECRET`) stays the canonical
  source when registered.
- **Photon** (OSM) is the last-resort backstop, and its hits are filtered so
  a street you never mentioned can't show up.

Esri will not place a street on its own — it wants a locality — so the app
sends the suburb it already knows (the property's own match, or the
scenario's suburb) as a hint, and the state as a hint only: a state named in
the typed address wins, a scenario state merely ranks first, and the PPOR
never inherits the investment property's state or suburb. Map coordinates
are never shared between addresses: each field biases a lookup only on its
own saved point, and only while the text still names that street.

A PPOR typed without a suburb ("8 atkinson close") is the hard case — that
street exists in several Australian suburbs. Photon can still place the
house, and where several places match, Esri's place-significance rank
decides, so the most likely one is chosen and shown under the field. The
dropdown still lists every match, so a different one is one click away.

- **Cadastral parcel** — lot/plan, land area, tenure, LGA, locality, strata
  and volumetric flags, with the parcel outline drawn on the map.
- **Land use** — the ALUM classification (primary/secondary/tertiary).
- **Regional planning** — which regional plan applies (name, version,
  statutory status) plus areas of regional interest (priority living,
  priority agricultural, strategic environmental).
- **Flood** — flood study coverage and rapid-hazard catchment for the
  parcel. That is *study coverage*, not a modelled AEP at the address; use
  QLD Globe for the flood extent.
- **Bushfire prone area** — QFES state-wide mapping as a map overlay (the
  July 2017 mapping; the service publishes tiles, not queryable data, so the
  app shows the overlay rather than inventing an in/out flag).

The same facts appear in the client share link and in the proposal PDF.

## Tax rates used (labels shown in-app)

| Item | Source |
|---|---|
| QLD transfer duty (no investor concession) | QRO standard rates |
| QLD land tax, individuals, AU-wide aggregation | QRO |
| Income tax 2026-27 + 2% Medicare levy | ATO |
| LMI premium bands | Helia-style estimate, lender-specific |
| Serviceability buffer | APRA-style 3% |

**CGT caveat**: a 2026 reform bill proposes changes from 1 July 2027
(discount → indexation, negative-gearing limits) with grandfathering for
existing holdings. The app implements current law and shows a standing
warning — confirm with a registered tax adviser.

## Layout

- `app.py` + `db.py` + `scenarios.py` — thin Flask backend, scenario CRUD (per user)
- `auth.py` — JWT login (HS256, PyJWT), pbkdf2 password hashes, open registration
- `static/engine.js` — all calculation logic (pure functions)
- `static/app.js` — SPA wiring, charts, scenario UI, login session
- `tests/test_engine.js` — known-answer suite (`node tests/test_engine.js`)

## AI research features (UltimateAI gateway)

When `PA_ULTIMATEAI_API_KEY` is set in `.env`, the app gains live
web-research features powered by an OpenAI-compatible gateway
(server-side web search):

- **Find sold comps / rental evidence** (Area & suburb research) — two
  parallel source shards, merged + source-stamped; results stream live
  into the UI as the research runs.
- **AI suburb evidence** (Deal Check / Reference data) — median price,
  rents, vacancy, days on market persisted into the suburb record with
  provenance; feeds the area report, Deal Check, portal and PDF.
- **Listing check** (Property intelligence) — is the subject on market,
  asking price, agent, last sale.
- **Area signals** (Deal Check) — infrastructure/planning projects within
  ~5 km.
- **Markets refresh** — live ABS national indicators when the direct SDMX
  feed is unreachable.
- **Bank rate suggestions** — current investor variable rates from
  comparison sites, saved into the rates table.

Endpoints: `POST /api/comps/search/stream`, `POST /api/rentals/search/stream`,
`POST /api/suburbs/ai-evidence[/stream]`,
`POST /api/property/listing-check[/stream]`,
`POST /api/property/area-signals[/stream]`,
`POST /api/markets/ai-refresh[/stream]`,
`POST /api/bank-rates/suggest[/stream]`, `GET /api/ai/status`.
Stream routes emit SSE progress frames then a `done` frame; each holds one
worker for the session duration, so run gunicorn with
`--worker-class gthread` in production.

Env vars: `PA_ULTIMATEAI_API_KEY` (enables everything above; unset = the AI
buttons explain themselves), `PA_COMPS_MODEL` (default `gpt-5.6-sol`),
`PA_RESEARCH_EFFORT` (default `low`).

Government data coverage is all-states: parcels, zoning and hazards via
[Open Land Fabric](https://openlandfabric.org) (free, keyless, national —
`olf.py`) with each state's own open services as fallbacks
(`state_intel.py`), national census benchmarks, and a sold-price series for
VIC with a suburb-record median fallback elsewhere. A background job
re-fetches this intelligence daily at 03:00 for every saved address
(`PA_NO_SCHEDULER=1` disables). Clients see the BA's branding — logo, accent colour
and contact details — on the portal and in the branded PDF header/footer.

Estimates only — not tax or financial advice.

Estimates only — not tax or financial advice.
