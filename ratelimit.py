# Copyright (c) 2026 RV
"""
Tiny in-memory sliding-window rate limiter.

Single-process Flask dev server + SQLite workload — an in-process dict with
a lock is the right size. Swap for Redis-backed only when there's more than
one worker process.

Usage:
    if not ratelimit.hit(f"otp-request:{ip}", 5, 300):
        return jsonify({"ok": False, "error": "too many requests"}), 429
"""

import threading
import time

_lock = threading.Lock()
_hits = {}  # key -> [timestamps]


def hit(key, limit, window_seconds):
    """Record a hit; return True if still within `limit` per window."""
    now = time.monotonic()
    cutoff = now - window_seconds
    with _lock:
        stamps = [t for t in _hits.get(key, []) if t > cutoff]
        if len(stamps) >= limit:
            _hits[key] = stamps
            return False
        stamps.append(now)
        _hits[key] = stamps
        # Opportunistic cleanup so the dict can't grow unbounded.
        if len(_hits) > 10000:
            for k in [k for k, v in _hits.items() if not v or v[-1] <= cutoff]:
                _hits.pop(k, None)
        return True


def reset(key=""):
    """Test helper."""
    with _lock:
        if key:
            _hits.pop(key, None)
        else:
            _hits.clear()
