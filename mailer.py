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
