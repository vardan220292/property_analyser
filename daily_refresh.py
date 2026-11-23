# Copyright (c) 2026 RV
"""
Daily background refresh of government spatial intelligence.

Once a day (03:00 local) every scenario's located address is force-refreshed
through state_intel so cached parcel/zoning/hazard data stays current
without the user clicking anything. Also resets the markets SDMX cache so
the next markets view re-pulls the ABS feed.

Only free, keyless government sources are refreshed here — AI-gateway
research stays on-demand because it costs credits.
"""
import datetime
import json
import logging
import os
import threading
import time

log = logging.getLogger("daily_refresh")

_REFRESH_HOUR = 3      # 03:00 local
_running = threading.Event()


def _scenarios_to_refresh():
    """Located addresses across all scenarios, deduped."""
    import db

    out, seen = [], set()
    for row in db.db().fetch_all("SELECT id, inputs_json FROM scenarios"):
        try:
            inputs = json.loads(row["inputs_json"] or "{}")
        except ValueError:
            continue
        props = inputs.get("properties") or []
        if not props and inputs.get("address"):
            props = [inputs]
        for p in props:
            meta = p.get("addressMeta") or {}
            lat, lon = meta.get("lat"), meta.get("lon")
            state = str(meta.get("state") or inputs.get("state") or "").upper()
            if lat is None or lon is None or not state:
                continue
            key = (state, round(float(lat), 4), round(float(lon), 4))
            if key in seen:
                continue
            seen.add(key)
            out.append((state, float(lat), float(lon)))
    return out


def _snapshot_suburb_metrics():
    """Record today's suburb medians/rents/vacancy into metric_history —
    the trend-analysis time series (one snapshot per day, INSERT OR IGNORE)."""
    import db

    period = time.strftime("%Y-%m")
    metrics = ("medianPrice", "medianRent2Bed", "medianRent3Bed",
               "medianRent4Bed", "vacancyPct", "medianDaysOnMarket")
    columns = {"medianPrice": "median_price", "medianRent2Bed": "median_rent_2bed",
               "medianRent3Bed": "median_rent_3bed", "medianRent4Bed": "median_rent_4bed",
               "vacancyPct": "vacancy_pct", "medianDaysOnMarket": "median_days_on_market"}
    saved = 0
    for row in db.db().fetch_all("SELECT * FROM suburbs"):
        for key in metrics:
            value = row[columns[key]]
            if value is None:
                continue
            cur = db.db().execute(
                "INSERT OR IGNORE INTO metric_history "
                "(subject_type, subject_id, metric, period, value, source) "
                "VALUES ('suburb', ?, ?, ?, ?, 'daily snapshot')",
                (row["id"], key, period, float(value)))
            saved += cur
    return saved


def run_once():
    """Force-refresh intelligence for every located scenario address.
    Returns a summary dict; never raises."""
    import markets
    import state_intel

    refreshed, failed = 0, []
    for state, lat, lon in _scenarios_to_refresh():
        try:
            state_intel.property_intel(lat, lon, state, force=True)
            refreshed += 1
        except Exception as exc:  # one bad address must not stop the run
            failed.append(f"{state} {lat:.4f},{lon:.4f}: {str(exc)[:120]}")
    try:
        history_rows = _snapshot_suburb_metrics()
    except Exception as exc:
        history_rows, failed_note = 0, str(exc)[:120]
        failed.append(f"history: {failed_note}")
    # SDMX: clear so the next markets view re-pulls the ABS feed fresh.
    markets._sdmx_cache["data"], markets._sdmx_cache["at"] = None, 0.0
    summary = {"refreshed": refreshed, "failed": failed,
               "historyRows": history_rows,
               "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    log.info("daily refresh: %s", summary)
    try:
        import admin
        admin.record_refresh_summary(summary)
    except Exception as exc:
        log.error("recording refresh summary: %s", exc)
    return summary


def _seconds_until_next(hour):
    now = datetime.datetime.now()
    nxt = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if nxt <= now:
        nxt += datetime.timedelta(days=1)
    return (nxt - now).total_seconds()


def start_scheduler(hour=_REFRESH_HOUR):
    if os.environ.get("PA_NO_SCHEDULER"):
        log.info("daily refresh scheduler disabled (PA_NO_SCHEDULER)")
        return
    if _running.is_set():
        return
    _running.set()

    def loop():
        while True:
            try:
                time.sleep(max(60, _seconds_until_next(hour)))
                run_once()
            except Exception as exc:  # the scheduler must survive anything
                log.error("daily refresh run failed: %s", exc)
                time.sleep(600)

    threading.Thread(target=loop, daemon=True, name="daily-refresh").start()
    log.info("daily refresh scheduler started (hour=%d)", hour)
