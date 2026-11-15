# Copyright (c) 2026 RV
"""
Seed loader for reference data (suburb stats, bank rates).

Seed files live in data/seed/*.json and are loaded with INSERT OR IGNORE
keyed on the UNIQUE constraints, so:
  - user edits to a seeded row survive restarts (the row is not replaced)
  - a row deleted by the user is restored on the next boot
  - booting twice never duplicates rows

Seed files are baked at build time from public sources, each field carrying
its own source + as-of date so the UI can show where a number came from.
"""

import json
import os

import db

SUBURB_FILE = "suburbs.json"
BANK_FILE = "bank_rates.json"


def _suburb_row(s):
    return (
        s.get("name"),
        s.get("postcode"),
        s.get("state", "QLD"),
        s.get("medianPrice"),
        s.get("medianRent2Bed"),
        s.get("medianRent3Bed"),
        s.get("medianRent4Bed"),
        s.get("vacancyPct"),
        s.get("growth5yrPct"),
        s.get("populationGrowthPct"),
        s.get("approvalsRatio"),
        s.get("medianDaysOnMarket"),
        json.dumps(s.get("sources", {})),
    )


def _bank_row(r):
    return (
        r.get("bankName"),
        r.get("productName", "investor variable"),
        r.get("investorIoRate"),
        r.get("investorPiRate"),
        r.get("source", ""),
        r.get("checkedAt", ""),
    )


def load(data_dir):
    """Load seed files if present. Safe to call on every boot."""
    seed_dir = os.path.join(data_dir, "seed")
    if not os.path.isdir(seed_dir):
        return

    sfile = os.path.join(seed_dir, SUBURB_FILE)
    if os.path.exists(sfile):
        with open(sfile) as f:
            data = json.load(f)
        for s in data.get("suburbs", []):
            if not s.get("name") or not s.get("postcode"):
                continue
            db.db().execute(
                "INSERT OR IGNORE INTO suburbs (name, postcode, state, median_price, "
                "median_rent_2bed, median_rent_3bed, median_rent_4bed, vacancy_pct, "
                "growth_5yr_pct, population_growth_pct, approvals_ratio, "
                "median_days_on_market, sources_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                _suburb_row(s),
            )

    bfile = os.path.join(seed_dir, BANK_FILE)
    if os.path.exists(bfile):
        with open(bfile) as f:
            data = json.load(f)
        for r in data.get("bankRates", []):
            if not r.get("bankName"):
                continue
            db.db().execute(
                "INSERT OR IGNORE INTO bank_rates (bank_name, product_name, "
                "investor_io_rate, investor_pi_rate, source, checked_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                _bank_row(r),
            )
