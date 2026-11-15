# Copyright (c) 2026 RV
"""
Authentication — same pattern as gk_crm's erp/auth.py, kept simpler.

- Local HS256 JWTs (PyJWT), 30-day expiry, Bearer tokens.
- Passwords hashed with werkzeug pbkdf2 (never stored in plain text).
- Single role: any registered user sees only their own scenarios.
- Registration is open — this is a trusted-circle tool. If you expose it
  beyond your LAN, put it behind HTTPS and reconsider.

The signing secret comes from PA_JWT_SECRET (env, min 16 chars) or is
auto-generated once and persisted to data/.jwt_secret so tokens survive
restarts.
"""

import functools
import hashlib
import os
import secrets
from datetime import datetime, timedelta

import jwt
from flask import Blueprint, g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

import db
import mailer
import ratelimit

bp = Blueprint("auth", __name__, url_prefix="/api/auth")
otp_bp = Blueprint("otp", __name__, url_prefix="/api/otp")

SECRET = None
TOKEN_TTL_DAYS = 30
MAX_EMAIL = 120

ROLES = {"investor", "ba", "client"}
# Self-registration may pick these; 'client' accounts are only created via
# OTP login or a BA invitation — never open registration.
OPEN_ROLES = {"investor", "ba"}

OTP_TTL_MINUTES = 10
OTP_MAX_ATTEMPTS = 5


def init(data_dir):
    """Resolve the JWT signing secret. Called once from app boot."""
    global SECRET
    env = os.environ.get("PA_JWT_SECRET")
    if env and len(env) >= 16:
        SECRET = env
        return
    path = os.path.join(data_dir, ".jwt_secret")
    if os.path.exists(path):
        with open(path) as f:
            SECRET = f.read().strip()
    if not SECRET:
        SECRET = secrets.token_hex(32)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(SECRET)


def make_token(user):
    payload = {
        "sub": str(user["id"]),
        "email": user["email"],
        "exp": datetime.utcnow() + timedelta(days=TOKEN_TTL_DAYS),
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


def user_from_request():
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    try:
        payload = jwt.decode(header[7:], SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    return db.db().fetch_one(
        "SELECT id, email, display_name, role, plan FROM users WHERE id = ?",
        (int(payload.get("sub", 0)),),
    )


def require_auth(fn):
    """Route wrapper: 401 unless a valid Bearer token names a real user."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        user = user_from_request()
        if not user:
            return jsonify({"ok": False, "error": "authentication required"}), 401
        g.user = user
        return fn(*args, **kwargs)
    return wrapper


def require_role(*roles):
    """Route wrapper: 401 unauthenticated, 403 wrong role. Role is read from
    the DB per request (no role claim in the JWT), so role changes apply
    immediately."""
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            user = user_from_request()
            if not user:
                return jsonify({"ok": False, "error": "authentication required"}), 401
            if user["role"] not in roles:
                return jsonify({"ok": False, "error": "not allowed for this account"}), 403
            g.user = user
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def _create_user(email, password, display_name="", role="investor"):
    """Insert a user. Clients get an unusable random password (OTP only)."""
    uid = db.db().execute(
        "INSERT INTO users (email, password_hash, display_name, role) VALUES (?, ?, ?, ?)",
        (email, generate_password_hash(password), display_name, role),
    )
    return db.db().fetch_one(
        "SELECT id, email, display_name, role, plan FROM users WHERE id = ?", (uid,)
    )


def create_client_user(email, display_name=""):
    """Find or create a client-role user. Returns (user, created)."""
    row = db.db().fetch_one(
        "SELECT id, email, display_name, role FROM users WHERE email = ?", (email,))
    if row:
        return row, False
    return _create_user(email, secrets.token_hex(16), display_name, role="client"), True


def _user_payload(user):
    return {
        "id": user["id"],
        "email": user["email"],
        "displayName": user["display_name"] or user["email"].split("@")[0],
        "role": user["role"],
        "plan": user.get("plan", "trial"),
        "token": make_token(user),
    }


@bp.post("/register")
def register():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    display_name = (body.get("displayName") or "").strip()[:80]
    role = body.get("role") or "investor"

    if "@" not in email or len(email) > MAX_EMAIL or " " in email:
        return jsonify({"ok": False, "error": "enter a valid email address",
                        "fields": {"email": "invalid"}}), 400
    if len(password) < 8:
        return jsonify({"ok": False, "error": "password must be at least 8 characters",
                        "fields": {"password": "too short"}}), 400
    if role not in OPEN_ROLES:
        return jsonify({"ok": False, "error": "role must be investor or ba"}), 400
    if db.db().fetch_one("SELECT id FROM users WHERE email = ?", (email,)):
        return jsonify({"ok": False, "error": "an account with that email already exists"}), 409

    user = _create_user(email, password, display_name, role=role)
    return jsonify({"ok": True, "data": _user_payload(user)}), 201


@bp.post("/login")
def login():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    row = db.db().fetch_one(
        "SELECT * FROM users WHERE email = ?", (email,)
    )
    if not row or not check_password_hash(row["password_hash"], password):
        return jsonify({"ok": False, "error": "wrong email or password"}), 401

    user = {"id": row["id"], "email": row["email"],
            "display_name": row["display_name"], "role": row["role"], "plan": row["plan"]}
    return jsonify({"ok": True, "data": _user_payload(user)})


@bp.get("/me")
@require_auth
def me():
    return jsonify({"ok": True, "data": {
        "id": g.user["id"],
        "email": g.user["email"],
        "displayName": g.user["display_name"] or g.user["email"].split("@")[0],
        "role": g.user["role"],
        "plan": g.user["plan"],
    }})


# ---------------------------------------------------------------------------
# OTP login — client accounts (no passwords)
# ---------------------------------------------------------------------------

def _sha256(s):
    return hashlib.sha256(s.encode()).hexdigest()


def _issue_otp(user):
    code = f"{secrets.randbelow(1000000):06d}"
    db.db().execute(
        "INSERT INTO otp_codes (user_id, code_hash, expires_at) VALUES (?, ?, ?)",
        (user["id"], _sha256(code),
         (datetime.utcnow() + timedelta(minutes=OTP_TTL_MINUTES)).isoformat()),
    )
    mailer.send_otp_email(user["email"], code)
    return code


@otp_bp.post("/request")
def otp_request():
    if not ratelimit.hit(f"otp-request:{request.remote_addr}", 5, 300):
        return jsonify({"ok": False, "error": "too many code requests — wait a few minutes"}), 429
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    if "@" not in email or len(email) > MAX_EMAIL or " " in email:
        return jsonify({"ok": False, "error": "enter a valid email address"}), 400

    row = db.db().fetch_one("SELECT id, email, role FROM users WHERE email = ?", (email,))
    if row and row["role"] != "client":
        # Don't let OTP bypass password accounts; message stays role-agnostic.
        return jsonify({"ok": False, "error": "this account signs in with a password"}), 403
    if row:
        user = row
    else:
        user, _ = create_client_user(email)

    code = _issue_otp(user)
    data = {"sent": True}
    # Dev/test only: echo the code so local flows and the test suite work
    # without SMTP.
    if os.environ.get("PA_OTP_ECHO"):
        data["devCode"] = code
    return jsonify({"ok": True, "data": data})


@otp_bp.post("/verify")
def otp_verify():
    if not ratelimit.hit(f"otp-verify:{request.remote_addr}", 20, 300):
        return jsonify({"ok": False, "error": "too many attempts — wait a few minutes"}), 429
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    code = (body.get("code") or "").strip()
    row = db.db().fetch_one("SELECT id FROM users WHERE email = ?", (email,))
    if not row:
        return jsonify({"ok": False, "error": "wrong or expired code"}), 401

    otp = db.db().fetch_one(
        "SELECT * FROM otp_codes WHERE user_id = ? AND consumed_at IS NULL "
        "ORDER BY id DESC LIMIT 1", (row["id"],))
    if not otp or otp["attempts"] >= OTP_MAX_ATTEMPTS:
        return jsonify({"ok": False, "error": "wrong or expired code"}), 401
    db.db().execute("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?", (otp["id"],))
    expired = datetime.utcnow() >= datetime.fromisoformat(otp["expires_at"])
    if expired or _sha256(code) != otp["code_hash"]:
        return jsonify({"ok": False, "error": "wrong or expired code"}), 401

    db.db().execute("UPDATE otp_codes SET consumed_at = ? WHERE id = ?",
                    (datetime.utcnow().isoformat(), otp["id"]))
    user = db.db().fetch_one("SELECT id, email, display_name, role, plan FROM users WHERE id = ?",
                             (row["id"],))
    return jsonify({"ok": True, "data": _user_payload(user)})


def seed_bootstrap():
    """Optionally seed an admin from env (gk_crm convention):
    PA_BOOTSTRAP_EMAIL / PA_BOOTSTRAP_PASSWORD."""
    email = (os.environ.get("PA_BOOTSTRAP_EMAIL") or "").strip().lower()
    password = os.environ.get("PA_BOOTSTRAP_PASSWORD") or ""
    if not email or not password:
        return
    if db.db().fetch_one("SELECT id FROM users WHERE email = ?", (email,)):
        return
    _create_user(email, password, "Admin")
