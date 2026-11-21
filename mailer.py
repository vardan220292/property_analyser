# Copyright (c) 2026 RV
"""
Minimal email sender — OTP codes and client share links.

SMTP is configured entirely via env (any provider works — SES, Postmark,
Gmail app password):
    PA_SMTP_HOST, PA_SMTP_PORT (587), PA_SMTP_USER, PA_SMTP_PASS,
    PA_SMTP_FROM (defaults to PA_SMTP_USER)
    PA_BASE_URL — public origin for share links (default loopback dev URL)

Without PA_SMTP_HOST everything is logged instead — the dev/test path.
Deliverability (SPF/DKIM) is a production-deploy concern, not code.
"""

import logging
import os
import smtplib
from email.message import EmailMessage

log = logging.getLogger("pa.mailer")


def _send(msg):
    host = os.environ.get("PA_SMTP_HOST")
    if not host:
        return False
    port = int(os.environ.get("PA_SMTP_PORT", "587"))
    user = os.environ.get("PA_SMTP_USER", "")
    with smtplib.SMTP(host, port, timeout=15) as smtp:
        smtp.starttls()
        smtp.login(user, os.environ.get("PA_SMTP_PASS", ""))
        smtp.send_message(msg)
    return True


def _from():
    return os.environ.get("PA_SMTP_FROM", os.environ.get("PA_SMTP_USER", ""))


def send_otp_email(to_email, code):
    msg = EmailMessage()
    msg["Subject"] = "Your Property Analyser sign-in code"
    msg["From"] = _from()
    msg["To"] = to_email
    msg.set_content(
        f"Your sign-in code is {code}\n\n"
        "It expires in 10 minutes. If you didn't request it, ignore this email."
    )
    if not _send(msg):
        log.warning("PA_SMTP_HOST not set — OTP code for %s logged, not emailed: %s",
                    to_email, code)
        return False
    return True


def send_presentation_email(to_email, ba_name, title, url):
    msg = EmailMessage()
    msg["Subject"] = f"Property proposal: {title}"
    msg["From"] = _from()
    msg["To"] = to_email
    msg.set_content(
        f"{ba_name} has prepared an investment analysis for you:\n\n"
        f"  {title}\n  {url}\n\n"
        "Open the link to see the full analysis and change the assumptions "
        "yourself. No account needed — this link is your access."
    )
    if not _send(msg):
        log.warning("PA_SMTP_HOST not set — share link for %s logged, not emailed: %s",
                    to_email, url)
        return False
    return True


def send_portfolio_email(to_email, ba_name, title, item_labels, url):
    lines = "\n".join(f"  • {label}" for label in item_labels) or "  (no properties listed)"
    msg = EmailMessage()
    msg["Subject"] = f"Property portfolio: {title}"
    msg["From"] = _from()
    msg["To"] = to_email
    msg.set_content(
        f"{ba_name} has prepared an investment analysis covering "
        f"{len(item_labels)} propert{'y' if len(item_labels) == 1 else 'ies'}:\n\n"
        f"{lines}\n\n"
        f"Open the link to see the full portfolio:\n  {url}\n\n"
        "Each property has its own analysis you can adjust and comment on. "
        "No account needed — this link is your access."
    )
    if not _send(msg):
        log.warning("PA_SMTP_HOST not set — portfolio link for %s logged, not emailed: %s",
                    to_email, url)
        return False
    return True


def send_activity_email(to_email, ba_name, client_name, title, event_type, body):
    """Client-activity alert: comment / approval / change request."""
    headings = {"comment": "New comment", "approved": "Proposal approved",
                "changes_requested": "Changes requested"}
    subject = f"{headings.get(event_type, 'Client activity')}: {title}"
    detail = f"\n\n{body}\n" if body else "\n"
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = _from()
    msg["To"] = to_email
    msg.set_content(
        f"{client_name} on '{title}':\n"
        f"{headings.get(event_type, event_type)}{detail}\n"
        f"Open your workspace to respond.\n\n— {ba_name}, via Property Analyser"
    )
    return _send(msg)


def send_password_reset_email(to_email, reset_url):
    msg = EmailMessage()
    msg["Subject"] = "Reset your Property Analyser password"
    msg["From"] = _from()
    msg["To"] = to_email
    msg.set_content(
        "A password reset was requested for your account.\n\n"
        f"Open this link to choose a new password:\n  {reset_url}\n\n"
        "The link expires in 30 minutes and can be used once. If you didn't "
        "request it, ignore this email — your password stays unchanged."
    )
    if not _send(msg):
        log.warning("PA_SMTP_HOST not set — reset link for %s logged, not emailed: %s",
                    to_email, reset_url)
        return False
    return True


def send_digest_email(to_email, ba_name, days, total_views, n_props, body):
    subject = (f"This week: {total_views} client view"
               f"{'s' if total_views != 1 else ''} across {n_props} proposal"
               f"{'s' if n_props != 1 else ''}")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = _from()
    msg["To"] = to_email
    msg.set_content(
        f"Client activity on your shared proposals over the last {days} days:\n\n"
        f"{body}\n\n"
        "Open your workspace to respond to comments.\n\n"
        f"— Property Analyser (weekly digest for {ba_name})"
    )
    if not _send(msg):
        log.warning("PA_SMTP_HOST not set — weekly digest for %s logged, not emailed",
                    to_email)
        return False
    return True
