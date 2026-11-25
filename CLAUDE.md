# CLAUDE.md

Working notes for Claude Code sessions on this repo.

## Run & test

```bash
./run.sh                                    # dev server, http://127.0.0.1:4180
/Users/vardangupta/deployment/venv/bin/python3 tests/test_api.py    # API suite
node tests/test_engine.js                   # engine maths suite
```

- The API suite is self-contained: throwaway SQLite unless `DATABASE_URL`
  is set. **Never** point it at the real database — `.env` carries a live
  Supabase `DATABASE_URL`; the suite pre-sets `DATABASE_URL=""` to defeat
  dotenv.
- Playwright browsers are cached at `~/Library/Caches/ms-playwright`; no
  playwright module in the project venv — use a temp venv. The first-visit
  product tour blocks normal clicks; click via `page.evaluate("el.click()")`.

## Architecture map

| Module | Role |
|---|---|
| `app.py` | Flask shell, blueprint registration, dotenv |
| `db.py` | SQLite/Postgres (Supabase) schema + migrations (PRAGMA + ALTER pattern in `ensure_schema`) |
| `scenarios.py` / `areadata.py` | Scenario CRUD, suburbs/comps/rentals/bank-rates |
| `gateway_search.py` | UltimateAI gateway transport: `run_research`, `run_research_streaming` (SSE), `start_parallel_research`/`collect_parallel_research` (2-worker pool), TTL cache |
| `comps_search.py` | AI sold-comps + rental-evidence searches (parallel site shards) + `/stream` routes |
| `ai_research.py` | Markets refresh, bank-rate suggest, suburb evidence (persisted), listing check, area signals + `/stream` routes; `/api/ai/status` |
| `state_intel.py` | All-states parcel/zoning/hazard intelligence — `olf.py` (Open Land Fabric, national, keyless) is the primary parcel+zoning source for the six state-intel states, with the per-state ArcGIS/WMS services as fallbacks |
| `olf.py` | Open Land Fabric client (OGC Features, GeoJSON; SA/NT licence = national-cadastre-2026-10, redistribution with attribution OK) |
| `daily_refresh.py` | Daemon at 03:00 local: force-refreshes state_intel for every located scenario address + resets the ABS SDMX cache (`PA_NO_SCHEDULER=1` disables; started only from `app.py __main__`) |
| `qld_intel.py` / `vic_intel.py` | Deep QLD (QLD Globe) / VIC (Vicmap) intelligence |
| `markets.py` / `census.py` / `sales.py` | ABS macro + median prices (with 1/3/5/10-yr growth windows), census SA2 benchmarks (national + per-state percentiles, suburb→SA2 crosswalk, Deal Check verdict engine), VIC VGO sold series |
| `areastats.py` | Multi-vintage area datasets newer than the census — ABS Regional Population/ERP 2024-25 + age-sex 2024, DEWR SALM unemployment, ABS building approvals (all SA2), ATO 2023-24 income (postcode-keyed, exact match via addressMeta.postcode). Snapshot-first (`data/markets/sa2-<key>.json`, baked; runtime never fetches); `refresh()` staleness-gated from daily_refresh; `GET /api/markets/census/rows?key=` serves heat-map joins; census `_augmented_benchmarks` merges percentiles + per-field `meta` vintages. Deal Check employment verdict prefers SALM over census `lf_4` |
| `admin.py` | `/api/admin/data-status` (BA role) — dataset freshness inventory |
| `metric_history` table | daily suburb snapshots via daily_refresh; trends at `/api/suburbs/<id>/history` |
| `report.py` | Client PDF (WeasyPrint) — `PDF_CSS`, `report_head_html`/`report_runners_html` shared with `portal.py` |
| `portal.py` / `presentations.py` / `branding.py` | Client portal, share snapshots (transient AI extras ride `snapshot_json.extras`), BA branding incl. contact fields |
| `static/app.js` / `portal.js` / `engine.js` | SPA, client portal, pure calc engine |

## AI gateway constraints (probed, see memory `ultimateai-gateway`)

- Web search works **only** on `POST /v1/responses` (chat/completions ignores
  `web_search_options`); structured output via record_* function tools
  (`text.format` json_schema is not enforced).
- Concurrency cap: **2 sessions per key** (3+ → 429); Cloudflare edge 524s
  sessions past ~100 s — keep per-session search budgets small.
- Latency lever = number of searches (each costs seconds server-side);
  snippets-only prompts beat listing reads. `reasoning.effort=low` passes
  through (default, `PA_RESEARCH_EFFORT`); `minimal` is rejected. Only
  `gpt-5.6-sol` is proven with web search.
- Tests must stub BOTH `gateway_search.run_research_streaming` and
  `ai_research.run_research_streaming` (the latter binds it via import).

## Conventions

- Flask envelope `{ok, data|error, fields}`; errors never HTML.
- AI data always carries source + as-of stamps; UI renders provenance next
  to every value; "unknown" beats invented numbers.
- Branding (BA name/accent/logo/contact) drives the client PDF header/footer
  via the ACCENT token in `report.PDF_CSS`. `report.py` owns ALL report
  styling — `portal._pdf_html` and the presentation route reuse
  `report.PDF_CSS` + `report_head_html`/`report_runners_html`; never
  duplicate CSS in portal.py.
- Transient AI research (listingCheck/areaSignals) rides presentation
  shares in `snapshot_json.extras` (whitelisted keys) and is stripped from
  model inputs on the portal side (`delete state.inputs.extras`).
- Schema migrations use the PRAGMA `table_info` + guarded ALTER pattern in
  `db.ensure_schema` (see ba_profiles contact columns).
