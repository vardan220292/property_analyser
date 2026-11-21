# Copyright (c) 2026 RV
"""
Weekly BA activity digest — what clients did on shared proposals in the
last N days (views, comments, approvals, change requests).

Run manually or from cron (weekly):
    /Users/vardangupta/deployment/venv/bin/python3 digest.py            # all BAs
    /Users/vardangupta/deployment/venv/bin/python3 digest.py a@b.com    # one BA

Without SMTP configured the emails are logged, not sent (same as the rest
of the app).
"""

from datetime import datetime, timedelta

import db
import mailer

DAYS = 7
CLIENT_EVENT_TYPES = ("viewed", "comment", "approved", "changes_requested")
TYPE_LABELS = {"viewed": "viewed", "comment": "commented on",
               "approved": "APPROVED", "changes_requested": "requested changes on"}


def build_digest(ba_user_id, days=DAYS):
    """Per-presentation client activity for one BA. Returns a digest dict
    (empty activity list when nothing happened)."""
    since = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    events = db.db().fetch_all(
        "SELECT e.type, e.body, e.created_at, p.title, "
        "u.display_name AS client_name, u.email AS client_email "
        "FROM presentation_events e "
        "JOIN presentations p ON p.id = e.presentation_id "
        "JOIN users u ON u.id = e.user_id "
        "WHERE p.ba_user_id = ? AND e.created_at >= ? "
        "AND e.type IN ('viewed', 'comment', 'approved', 'changes_requested') "
        "ORDER BY e.created_at DESC", (ba_user_id, since))
    per = {}
    for e in events:
        title = e["title"] or "(untitled)"
        item = per.setdefault(title, {"views": 0, "comments": [], "decisions": []})
        if e["type"] == "viewed":
            item["views"] += 1
        elif e["type"] == "comment":
            item["comments"].append({"by": e["client_name"] or e["client_email"],
                                     "body": e["body"][:160], "at": e["created_at"]})
        else:
            item["decisions"].append({"type": e["type"],
                                      "by": e["client_name"] or e["client_email"],
                                      "at": e["created_at"]})
    ba = db.db().fetch_one("SELECT email, display_name FROM users WHERE id = ?",
                           (ba_user_id,))
    return {
        "baEmail": ba["email"],
        "baName": (ba["display_name"] or ba["email"].split("@")[0]),
        "days": days,
        "totalViews": sum(i["views"] for i in per.values()),
        "presentations": [
            {"title": t, **item} for t, item in per.items()
        ],
    }


def send_digest(digest):
    """Email one digest; returns True when handed to SMTP."""
    lines = []
    for p in digest["presentations"]:
        bits = [f"  • {p['title']} — {p['views']} view{'s' if p['views'] != 1 else ''}"]
        for d in p["decisions"]:
            bits.append(f"      {TYPE_LABELS[d['type']]} by {d['by']}")
        for c in p["comments"][:3]:
            bits.append(f"      comment from {c['by']}: {c['body']}")
        lines.extend(bits)
    body = "\n".join(lines) or "  (no client activity)"
    return mailer.send_digest_email(
        digest["baEmail"], digest["baName"], digest["days"],
        digest["totalViews"], len(digest["presentations"]), body)


def main(argv):
    if len(argv) > 1:
        targets = [argv[1].strip().lower()]
        rows = [db.db().fetch_one("SELECT id FROM users WHERE email = ?", (targets[0],))]
        if not rows[0]:
            print(f"no user {targets[0]}")
            return 1
    else:
        rows = db.db().fetch_all(
            "SELECT DISTINCT u.id FROM users u "
            "WHERE u.role = 'ba' AND EXISTS ("
            "  SELECT 1 FROM presentation_events e "
            "  JOIN presentations p ON p.id = e.presentation_id "
            "  WHERE p.ba_user_id = u.id AND e.created_at >= ?)",
            ((datetime.utcnow() - timedelta(days=DAYS)).strftime("%Y-%m-%d %H:%M:%S"),))
    sent = 0
    for r in rows:
        uid = r[0] if not isinstance(r, dict) else list(r.values())[0]
        digest = build_digest(uid)
        if not digest["presentations"]:
            continue
        send_digest(digest)
        sent += 1
    print(f"digest sent to {sent} BA(s)")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv))
