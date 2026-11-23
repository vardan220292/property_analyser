# Copyright (c) 2026 RV
"""
Admin data-status endpoint — the lightweight alternative to a full data
platform dashboard: what datasets the app holds, when each was last
refreshed, and how many rows back it.
"""
import json
import logging
import os

from flask import Blueprint, jsonify

import auth
import db
import markets

bp = Blueprint("admin", __name__, url_prefix="/api/admin")
log = logging.getLogger("admin")

_last_refresh_summary = {"at": None, "detail": {}}


def record_refresh_summary(summary):
    """Called by the daily refresh so /data-status can show it."""
    _last_refresh_summary["at"] = summary.get("at")
    _last_refresh_summary["detail"] = {
        "refreshed": summary.get("refreshed"),
        "failed": len(summary.get("failed") or []),
        "historyRows": summary.get("historyRows"),
    }


@bp.get("/data-status")
@auth.require_role("ba")
def data_status():
    datasets = []

    def _json_mtime(path):
        try:
            with open(path) as fh:
                return json.load(fh).get("builtAt") or json.load(open(path)).get("release")
        except (OSError, ValueError):
            return None

    tvd = markets._load_prices()
    datasets.append({
        "dataset": "ABS median prices (TVD Table 2)",
        "lastRefresh": tvd.get("release") if tvd else None,
        "notes": "quarterly medians, capital vs rest, per state" if tvd
                 else "unavailable (ABS unreachable and no snapshot)",
    })

    import census
    bench = census.load_benchmarks() or {}
    datasets.append({
        "dataset": "Census SA2 benchmarks",
        "lastRefresh": bench.get("builtAt"),
        "rows": bench.get("n"),
        "notes": f"{len(bench.get('fields') or {})} fields, "
                 f"{len(bench.get('states') or {})} states with percentiles",
    })

    import state_intel
    datasets.append({
        "dataset": "Open Land Fabric parcel/zoning (via state_intel cache)",
        "rows": len(state_intel._cache),
        "notes": "daily refresh re-queries per saved address (OLF primary, "
                 "state services fallback)",
    })

    try:
        srow = db.db().fetch_one("SELECT COUNT(*) AS n, "
                                 "SUM(CASE WHEN median_price IS NOT NULL THEN 1 ELSE 0 END) AS wm "
                                 "FROM suburbs")
        hrow = db.db().fetch_one("SELECT MAX(period) AS p, COUNT(*) AS n "
                                 "FROM metric_history WHERE subject_type = 'suburb'")
        datasets.append({
            "dataset": "Suburb reference data",
            "lastRefresh": hrow["p"] if hrow else None,
            "rows": f"{srow['n']} suburbs, {srow['wm'] or 0} with median price",
            "notes": f"metric_history: {hrow['n'] or 0} snapshots",
        })
    except Exception as exc:
        log.error("data-status suburbs: %s", exc)

    datasets.append({
        "dataset": "Daily refresh (spatial + suburb snapshot)",
        "lastRefresh": _last_refresh_summary["at"],
        "notes": _last_refresh_summary["detail"] or "runs at 03:00 local",
    })

    return jsonify({"ok": True, "data": {"datasets": datasets}})
