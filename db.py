# Copyright (c) 2026 RV
"""
Database access layer for Property Analyser.

Thin wrapper over stdlib sqlite3 OR psycopg (Postgres) — no ORM, matching
the gk_crm style (fetch_all / fetch_one / execute). One connection guarded
by a lock; the workload here (scenario CRUD + portal) is tiny.

Driver selection at init():
    DATABASE_URL env set  -> Postgres (Supabase pooler/direct, sslmode=require)
    otherwise             -> SQLite at the given path (dev + test default)

SQLite-isms are translated for Postgres at the execute boundary, so the
callers keep writing plain SQLite-flavoured SQL:
    ?                -> %s
    datetime('now')  -> NOW()::text        (timestamps stay TEXT columns;
                                            the UI slices them as strings)
    INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING
    INSERT (get id)  -> ... RETURNING id
Schema DDL is also transformed (AUTOINCREMENT -> GENERATED ALWAYS AS
IDENTITY). Table/column introspection goes through _table_cols().

There is no migration framework — evolve the CREATE TABLE statements and
the ensure_schema() ALTER checks instead.
"""

import os
import re
import sqlite3
import threading

_SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name  TEXT NOT NULL DEFAULT '',
        role          TEXT NOT NULL DEFAULT 'investor',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    # Onboarding answers (goal, properties owned) — generic key/value so
    # new wizard questions need no migration.
    """
    CREATE TABLE IF NOT EXISTS user_prefs (
        user_id   INTEGER NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (user_id, key)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS client_profiles (
        user_id     INTEGER PRIMARY KEY,
        ba_user_id  INTEGER NOT NULL,
        phone       TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_client_profiles_ba
        ON client_profiles(ba_user_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS otp_codes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        code_hash   TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        consumed_at TEXT,
        attempts    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_otp_codes_user ON otp_codes(user_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS scenarios (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        inputs_json TEXT NOT NULL,
        version     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_scenarios_updated_at
        ON scenarios(updated_at DESC)
    """,
    """
    CREATE TABLE IF NOT EXISTS suburbs (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        name                   TEXT NOT NULL,
        postcode               TEXT NOT NULL,
        state                  TEXT NOT NULL DEFAULT 'QLD',
        median_price           REAL,
        median_rent_2bed       REAL,
        median_rent_3bed       REAL,
        median_rent_4bed       REAL,
        vacancy_pct            REAL,
        growth_5yr_pct         REAL,
        population_growth_pct  REAL,
        approvals_ratio        REAL,
        median_days_on_market  REAL,
        sources_json           TEXT NOT NULL DEFAULT '{}',
        updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, postcode)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS comps (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_id   INTEGER NOT NULL,
        address       TEXT NOT NULL DEFAULT '',
        sold_price    REAL,
        sold_date     TEXT NOT NULL DEFAULT '',
        beds          INTEGER,
        land_m2       REAL,
        rent_estimate REAL,
        url           TEXT NOT NULL DEFAULT '',
        notes         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_comps_scenario ON comps(scenario_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS bank_rates (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        bank_name       TEXT NOT NULL,
        product_name    TEXT NOT NULL DEFAULT '',
        investor_io_rate REAL,
        investor_pi_rate REAL,
        source          TEXT NOT NULL DEFAULT '',
        checked_at      TEXT NOT NULL DEFAULT '',
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(bank_name, product_name)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS presentations (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ba_user_id       INTEGER NOT NULL,
        client_user_id   INTEGER NOT NULL,
        scenario_id      INTEGER,
        title            TEXT NOT NULL DEFAULT '',
        snapshot_json    TEXT NOT NULL,
        share_token_hash TEXT NOT NULL UNIQUE,
        status           TEXT NOT NULL DEFAULT 'active',
        expires_at       TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_presentations_ba ON presentations(ba_user_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_presentations_client ON presentations(client_user_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS presentation_adjustments (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        presentation_id INTEGER NOT NULL,
        user_id         INTEGER NOT NULL,
        inputs_json     TEXT NOT NULL,
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(presentation_id, user_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS presentation_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        presentation_id INTEGER NOT NULL,
        user_id         INTEGER NOT NULL,
        type            TEXT NOT NULL,
        body            TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_presentation_events ON presentation_events(presentation_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS portfolio_actuals (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL,
        scenario_id    INTEGER NOT NULL,
        property_index INTEGER NOT NULL DEFAULT 0,
        period_start   TEXT NOT NULL,
        period_end     TEXT NOT NULL,
        rent_received  REAL NOT NULL DEFAULT 0,
        expenses       REAL NOT NULL DEFAULT 0,
        loan_balance   REAL,
        valuation      REAL,
        notes          TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(scenario_id, property_index, period_start)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_actuals_scenario
        ON portfolio_actuals(scenario_id, property_index, period_start)
    """,
    """
    CREATE TABLE IF NOT EXISTS ba_profiles (
        user_id        INTEGER PRIMARY KEY,
        business_name  TEXT NOT NULL DEFAULT '',
        accent_color   TEXT NOT NULL DEFAULT '',
        logo_url       TEXT NOT NULL DEFAULT '',
        tagline        TEXT NOT NULL DEFAULT '',
        phone          TEXT NOT NULL DEFAULT '',
        email          TEXT NOT NULL DEFAULT '',
        website        TEXT NOT NULL DEFAULT '',
        office_address TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS rental_comps (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_id   INTEGER NOT NULL,
        address       TEXT NOT NULL DEFAULT '',
        rent_weekly   REAL,
        bedrooms      INTEGER,
        property_type TEXT NOT NULL DEFAULT 'house',
        url           TEXT NOT NULL DEFAULT '',
        notes         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_rental_comps_scenario
        ON rental_comps(scenario_id)
    """,
    # Client portfolios: one share link covering N property presentations.
    # Access flows through the PORTFOLIO token; the per-item presentations
    # keep their internal tokens (satisfying the UNIQUE constraint) but are
    # never published.
    """
    CREATE TABLE IF NOT EXISTS portfolios (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ba_user_id       INTEGER NOT NULL,
        client_user_id   INTEGER NOT NULL,
        title            TEXT NOT NULL DEFAULT '',
        share_token_hash TEXT NOT NULL UNIQUE,
        status           TEXT NOT NULL DEFAULT 'active',
        expires_at       TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_portfolios_ba ON portfolios(ba_user_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_portfolios_client ON portfolios(client_user_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS portfolio_items (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolio_id    INTEGER NOT NULL,
        presentation_id INTEGER NOT NULL UNIQUE,
        label           TEXT NOT NULL DEFAULT '',
        summary_json    TEXT NOT NULL DEFAULT '{}',
        position        INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_portfolio_items ON portfolio_items(portfolio_id)
    """,
    # Due-diligence documents per scenario (BA uploads, clients read via
    # an active presentation). Bytes live on disk; this row is metadata.
    """
    CREATE TABLE IF NOT EXISTS attachments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_id  INTEGER NOT NULL,
        user_id      INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        stored_name  TEXT NOT NULL,
        mime         TEXT NOT NULL,
        bytes        INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_attachments_scenario ON attachments(scenario_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS ba_alerts (
        user_id  INTEGER PRIMARY KEY,
        enabled  INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS suburb_sales (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        state         TEXT NOT NULL,
        suburb        TEXT NOT NULL,
        dwelling_type TEXT NOT NULL DEFAULT 'houses',
        period        TEXT NOT NULL,
        median        INTEGER,
        sales_count   INTEGER,
        source        TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(state, suburb, dwelling_type, period)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_suburb_sales_lookup
        ON suburb_sales(state, suburb, dwelling_type, period)
    """,
]

# Postgres DDL transformation: identity columns instead of AUTOINCREMENT,
# and TEXT defaults that match SQLite's datetime('now') output format
# (UTC, "YYYY-MM-DD HH:MM:SS") so the UI's string slicing keeps working.
_PG_DDL_SUBS = [
    (re.compile(r"INTEGER PRIMARY KEY AUTOINCREMENT", re.I),
     "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"),
    (re.compile(r"DEFAULT \(datetime\('now'\)\)", re.I),
     "DEFAULT (NOW()::text)"),
]


def _pg_sql(sql):
    """Translate SQLite-flavoured SQL for Postgres. Order matters."""
    out = sql.replace("?", "%s")
    out = out.replace("datetime('now')", "NOW()::text")
    if re.search(r"\bINSERT\s+OR\s+IGNORE\s+INTO\b", out, re.I):
        out = re.sub(r"\bINSERT\s+OR\s+IGNORE\s+INTO\b", "INSERT INTO", out, flags=re.I)
        if "ON CONFLICT" not in out.upper():
            out = out.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING;"
    if re.match(r"\s*INSERT\b", out, re.I) and "RETURNING" not in out.upper():
        out = out.rstrip().rstrip(";") + " RETURNING id;"
    return out


class Database:
    def __init__(self, path, dsn=None):
        self.dsn = dsn
        # RLock (not Lock): ensure_schema holds it across helper calls that
        # themselves go through fetch_all — re-entry on the same thread.
        self._lock = threading.RLock()
        if dsn:
            self._connect()
        else:
            self._conn = sqlite3.connect(path, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.commit()

    def _connect(self):
        import psycopg
        self._conn = psycopg.connect(
            self.dsn, autocommit=True,
            connect_timeout=10,
            row_factory=psycopg.rows.dict_row,
        )

    def _alive(self):
        try:
            return self._conn is not None and not self._conn.closed
        except Exception:
            return False

    def _reconnect(self):
        """Reopen the pooled connection.

        Supabase's pooler closes idle sessions, so a long-running server
        wakes up to a dead connection. Without this every request 500s with
        'the connection is closed'."""
        try:
            self._conn.close()
        except Exception:
            pass
        self._connect()

    @staticmethod
    def _is_conn_error(exc):
        name = type(exc).__name__
        if name in ("OperationalError", "InterfaceError"):
            return True
        msg = str(exc).lower()
        return ("connection is closed" in msg
                or "server closed the connection" in msg
                or "connection already closed" in msg
                or "terminating connection" in msg
                or "could not connect to server" in msg)

    def fetch_all(self, sql, args=()):
        with self._lock:
            rows = self._run(sql, args).fetchall()
        return [dict(r) for r in rows]

    def fetch_one(self, sql, args=()):
        with self._lock:
            row = self._run(sql, args).fetchone()
        return dict(row) if row else None

    def execute(self, sql, args=()):
        """Run a write; returns lastrowid (inserts) or rowcount (updates).
        Postgres inserts come back via RETURNING id. Tables without an
        `id` column (client_profiles keys on user_id) reject the appended
        RETURNING — retry those plain, returning rowcount."""
        with self._lock:
            try:
                cur = self._run(sql, args)
            except Exception as e:
                if self.dsn and type(e).__name__ == "UndefinedColumn":
                    cur = self._run(sql, args, returning=False)
                else:
                    raise
            if self.dsn and getattr(cur, "description", None):
                row = cur.fetchone()
                return row["id"] if row else 0
            return cur.lastrowid if getattr(cur, "lastrowid", None) else cur.rowcount

    def _run(self, sql, args, returning=True):
        if self.dsn:
            sql = _pg_sql(sql)
            if not returning:
                sql = sql.replace(" RETURNING id;", ";")
            if not self._alive():
                self._reconnect()
        try:
            cur = self._conn.cursor()
            cur.execute(sql, tuple(args))
            return cur
        except Exception as e:
            # The pooler can drop the session between our check and the
            # query — reconnect once and retry before giving up.
            if self.dsn and self._is_conn_error(e):
                self._reconnect()
                cur = self._conn.cursor()
                cur.execute(sql, tuple(args))
                return cur
            raise

    def _table_cols(self, table):
        if self.dsn:
            return [r["column_name"] for r in self.fetch_all(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = %s AND table_schema = current_schema()", (table,))]
        rows = self._conn.execute(f"PRAGMA table_info({table})").fetchall()
        return [r["name"] for r in rows]

    def ensure_schema(self):
        with self._lock:
            for stmt in _SCHEMA:
                ddl = stmt
                if self.dsn:
                    for pat, repl in _PG_DDL_SUBS:
                        ddl = pat.sub(repl, ddl)
                self._exec_raw(ddl)
            # Migration: DBs created before multi-user support lack user_id.
            cols = self._table_cols("scenarios")
            if "user_id" not in cols:
                self._exec_raw(
                    "ALTER TABLE scenarios ADD COLUMN user_id INTEGER")
            if "address" not in cols:
                self._exec_raw(
                    "ALTER TABLE scenarios ADD COLUMN address TEXT NOT NULL DEFAULT ''")
            if "suburb_id" not in cols:
                self._exec_raw(
                    "ALTER TABLE scenarios ADD COLUMN suburb_id INTEGER")
            # Migration: ba_profiles created before BA contact fields existed.
            bp_cols = self._table_cols("ba_profiles")
            for col in ("phone", "email", "website", "office_address"):
                if col not in bp_cols:
                    self._exec_raw(
                        f"ALTER TABLE ba_profiles ADD COLUMN {col} "
                        "TEXT NOT NULL DEFAULT ''")
            # Migration: suburb rows link to their ABS SA2 (census crosswalk).
            sub_cols = self._table_cols("suburbs")
            if "sa2_code" not in sub_cols:
                self._exec_raw("ALTER TABLE suburbs ADD COLUMN sa2_code TEXT")
            self._exec_raw("""
                CREATE TABLE IF NOT EXISTS metric_history (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    subject_type TEXT NOT NULL DEFAULT 'suburb',
                    subject_id   INTEGER NOT NULL,
                    metric       TEXT NOT NULL,
                    period       TEXT NOT NULL,
                    value        REAL,
                    source       TEXT NOT NULL DEFAULT '',
                    recorded_at  TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(subject_type, subject_id, metric, period)
                )
            """)
            self._exec_raw(
                "CREATE INDEX IF NOT EXISTS idx_metric_history_lookup "
                "ON metric_history (subject_type, subject_id, metric, period)")
            # Role column for pre-platform DBs.
            if "role" not in self._table_cols("users"):
                self._exec_raw(
                    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'investor'")
            # Plan column for pre-billing DBs (ba accounts: trial | pro).
            if "plan" not in self._table_cols("users"):
                self._exec_raw(
                    "ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'trial'")
            # One-time adoption: scenarios from before multi-user support
            # belong to whoever ran the tool first (lowest user id). After
            # this, user_id IS NULL rows are never shared or readable.
            self._exec_raw(
                "UPDATE scenarios SET user_id = "
                "(SELECT id FROM users ORDER BY id LIMIT 1) "
                "WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM users)"
            )
            self._exec_raw(
                "CREATE INDEX IF NOT EXISTS idx_scenarios_user ON scenarios(user_id)")
            self._conn.commit()

    def commit(self):
        """Flush pending writes (SQLite only — Postgres autocommits)."""
        if not self.dsn and self._conn is not None:
            self._conn.commit()

    def _exec_raw(self, sql):
        if self.dsn and not self._alive():
            self._reconnect()
        cur = self._conn.cursor()
        cur.execute(sql)
        cur.close()


_db = None


def init(path):
    """Bind the module to a database. Called once from app boot.
    DATABASE_URL env (when present) wins over the SQLite path."""
    global _db
    dsn = os.environ.get("DATABASE_URL")
    _db = Database(path, dsn=dsn)
    _db.ensure_schema()


def db():
    if _db is None:
        raise RuntimeError("db.init() has not been called")
    return _db
