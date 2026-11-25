# Copyright (c) 2026 RV
"""
Whole-database JSON backups.

The live database is the only copy of everything (Supabase Postgres), so
this script dumps every table to data/backups/ and prunes old ones.

Run manually or from cron:
    /Users/vardangupta/deployment/venv/bin/python3 backup.py

Target follows the same env rules as the app: DATABASE_URL (Postgres) wins
over DB_PATH (SQLite). Every run logs which target it dumped.
"""

import json
import os
import sys
from datetime import datetime

import db

BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "data", "backups")
KEEP = 14  # newest backups to retain


def _list_tables():
    if os.environ.get("DATABASE_URL"):
        rows = db.db().fetch_all(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' "
            "AND tablename NOT LIKE 'pg_%' ORDER BY tablename")
    else:
        rows = db.db().fetch_all(
            "SELECT name FROM sqlite_master WHERE type = 'table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name")
    return [r[0] if isinstance(r, (list, tuple)) else list(r.values())[0]
            for r in rows]


def create_backup(backup_dir=BACKUP_DIR, keep=KEEP):
    target = os.environ.get("DATABASE_URL") or os.environ.get("DB_PATH") or "(default)"
    tables = {}
    for t in _list_tables():
        rows = db.db().fetch_all(f"SELECT * FROM {t}")
        tables[t] = [dict(r) if not isinstance(r, dict) else r for r in rows]
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(backup_dir, f"backup-{stamp}.json")
    n = 1
    while os.path.exists(path):
        path = os.path.join(backup_dir, f"backup-{stamp}-{n}.json")
        n += 1
    payload = {
        "createdAt": datetime.utcnow().isoformat(),
        "target": ("postgres" if os.environ.get("DATABASE_URL") else "sqlite"),
        "tables": {k: len(v) for k, v in tables.items()},
        "rows": tables,
    }
    with open(path, "w") as f:
        json.dump(payload, f, default=str)
    backups = sorted(f for f in os.listdir(backup_dir)
                     if f.startswith("backup-") and f.endswith(".json"))
    for old in backups[:-keep]:
        os.remove(os.path.join(backup_dir, old))
    size = os.path.getsize(path)
    print(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} backup {path} "
          f"({sum(len(v) for v in tables.values())} rows, {size / 1024:.0f} KB) "
          f"target={target}")
    return path


if __name__ == "__main__":
    create_backup()
