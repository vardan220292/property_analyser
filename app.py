# Copyright (c) 2026 RV
"""
Property Analyser — thin Flask entry point.

A personal tool for analysing an Australian (QLD) investment property
purchase funded partly by equity released from the PPOR.

All the investment mathematics lives client-side in static/engine.js so
inputs recalculate instantly while editing. This backend exists only to
persist named scenarios to SQLite.

Endpoints:
    GET  /                              -> static/index.html (SPA shell)
    GET  /app.js, /engine.js, /styles.css -> static assets (no-cache)
    GET  /vendor/<file>                 -> vendored libs (Chart.js)
    /api/auth/...                       -> register / login / me
    /api/scenarios...                   -> scenario CRUD (auth required)
    /api/intel/property                 -> live QLD open data for an address

Config (via .env, all optional):
    PORT     — defaults to 4180
    HOST     — defaults to 127.0.0.1; set 0.0.0.0 to share on your LAN
    DB_PATH  — SQLite file, defaults to ./data/scenarios.db
    PA_JWT_SECRET — token signing secret (auto-generated if absent)
    PA_BOOTSTRAP_EMAIL / PA_BOOTSTRAP_PASSWORD — seed an admin at boot
"""

import os

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

import auth
import ai_research
import admin
import areadata
import attachments
import census
import comps_search
import db
import domain_api
import markets
import portal
import portfolios
import presentations
import actuals
import branding
import qld_intel
import state_intel
import sales
import vic_intel
import ratelimit
import scenarios
import seeds

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

# DB_PATH says "use this SQLite file"; a non-empty DATABASE_URL (env or .env)
# says "use Postgres" — and db.init() lets DATABASE_URL win. Silently running
# against Postgres while the operator thinks they're on a throwaway SQLite
# file has burned real data before, so refuse the ambiguous config.
if os.environ.get("DB_PATH") and os.environ.get("DATABASE_URL"):
    raise SystemExit(
        "Both DB_PATH and DATABASE_URL are set — the app would talk to "
        "Postgres, not DB_PATH. Unset one of them, or export DATABASE_URL= "
        "(empty) to force the SQLite file.")

PORT = int(os.environ.get("PORT", "4180"))
HOST = os.environ.get("HOST", "127.0.0.1")
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "data", "scenarios.db"))

STATIC_DIR = os.path.join(BASE_DIR, "static")
VENDOR_DIR = os.path.join(STATIC_DIR, "vendor")

app = Flask(__name__, static_folder=None)


# ---------------------------------------------------------------------------
# Static routes (explicit, like gk_crm, so we control caching headers)
# ---------------------------------------------------------------------------

@app.route("/")
@app.route("/reset")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/welcome")
def welcome():
    resp = send_from_directory(STATIC_DIR, "landing.html")
    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


@app.route("/app.js")
@app.route("/engine.js")
@app.route("/portal.js")
@app.route("/styles.css")
@app.route("/design-system.css")
@app.route("/dashboard-premium.css")
def static_no_cache():
    # The actively-iterated files; never let the browser cache them.
    name = os.path.basename(request.path)
    resp = send_from_directory(STATIC_DIR, name)
    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


@app.route("/vendor/<path:name>")
def vendor(name):
    # Vendored libs are immutable — cache them hard.
    resp = send_from_directory(VENDOR_DIR, name)
    resp.headers["Cache-Control"] = "public, max-age=604800"
    return resp


@app.route("/p/<token>")
def share_link(token):
    # Client deep link: portal.html resolves the token against /api/portal
    # and logs the client in. Rate-limit hostile token probing.
    if not ratelimit.hit(f"p:{request.remote_addr}", 30, 300):
        return jsonify({"ok": False, "error": "too many requests"}), 429
    resp = send_from_directory(STATIC_DIR, "portal.html")
    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


@app.route("/portal")
def portal_home():
    # Returning clients without a fresh link: OTP login + their list.
    resp = send_from_directory(STATIC_DIR, "portal.html")
    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


# ---------------------------------------------------------------------------
# API blueprint + uniform JSON envelope ({ok, error, fields})
# ---------------------------------------------------------------------------

app.register_blueprint(auth.bp)
app.register_blueprint(auth.otp_bp)
app.register_blueprint(actuals.bp)
app.register_blueprint(areadata.bp)
app.register_blueprint(attachments.bp)
app.register_blueprint(branding.bp)
app.register_blueprint(census.bp)
app.register_blueprint(markets.bp)
app.register_blueprint(sales.bp)
app.register_blueprint(comps_search.bp)
app.register_blueprint(comps_search.bp_rentals)
app.register_blueprint(ai_research.bp_markets)
app.register_blueprint(ai_research.bp_rates)
app.register_blueprint(ai_research.bp_suburbs)
app.register_blueprint(ai_research.bp_property)
app.register_blueprint(ai_research.bp_meta)
app.register_blueprint(admin.bp)
app.register_blueprint(domain_api.bp)
app.register_blueprint(portal.bp)
app.register_blueprint(portfolios.bp)
app.register_blueprint(presentations.bp)
app.register_blueprint(presentations.clients_bp)
app.register_blueprint(qld_intel.bp)
app.register_blueprint(vic_intel.bp)
app.register_blueprint(state_intel.bp)
app.register_blueprint(scenarios.bp)


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"ok": False, "error": "not found"}), 404


@app.errorhandler(405)
def method_not_allowed(_e):
    return jsonify({"ok": False, "error": "method not allowed"}), 405


@app.errorhandler(Exception)
def internal_error(e):
    app.logger.exception("Unhandled error: %s", e)
    return jsonify({"ok": False, "error": "internal server error"}), 500


# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------

def create_db():
    """Ensure the data directory, schema, auth secret and bootstrap user."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db.init(DB_PATH)
    auth.init(os.path.dirname(DB_PATH))
    auth.seed_bootstrap()
    seeds.load(os.path.dirname(DB_PATH))


if __name__ == "__main__":
    create_db()
    import daily_refresh
    daily_refresh.start_scheduler()
    # Personal tool: loopback by default. HOST=0.0.0.0 shares on the LAN —
    # put it behind HTTPS (reverse proxy) before exposing it further.
    app.run(host=HOST, port=PORT, threaded=True)
