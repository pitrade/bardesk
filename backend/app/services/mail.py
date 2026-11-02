# SPDX-License-Identifier: GPL-3.0-or-later
import logging
import smtplib
from html import escape
import ssl
from email.message import EmailMessage
from email.utils import formataddr

from ..config import settings

logger = logging.getLogger(__name__)


_TEMPLATES = {
    "de": {
        "subject": "Dein {app} Login-Code",
        "text": (
            "Dein {app} Login-Code lautet: {code}\n"
            "Er ist {minutes} Minuten gültig."
        ),
        "html": (
            "<h3>Dein {app} Login-Code:</h3><h1>{code}</h1>"
            "<p>Er ist {minutes} Minuten gültig.</p>"
        ),
    },
    "en": {
        "subject": "Your {app} login code",
        "text": (
            "Your {app} login code is: {code}\n"
            "It is valid for {minutes} minutes."
        ),
        "html": (
            "<h3>Your {app} login code:</h3><h1>{code}</h1>"
            "<p>It is valid for {minutes} minutes.</p>"
        ),
    },
}


def send_login_code(email: str, code: str, language: str | None = None) -> bool:
    """Send the login code, localized in de/en (default en). Returns True on success."""
    template = _TEMPLATES["de"] if language == "de" else _TEMPLATES["en"]
    minutes = settings.login_code_expiry_minutes
    app = settings.app_name
    subject = template["subject"].format(app=app)
    text = template["text"].format(app=app, code=code, minutes=minutes)
    html = template["html"].format(app=escape(app), code=code, minutes=minutes)

    if settings.smtp_host:
        return _send_smtp(email, subject, text, html)
    logger.warning("No mail configured. Login code for %s: %s", email, code)
    return True


def _send_smtp(email: str, subject: str, text: str, html: str) -> bool:
    message = EmailMessage()
    message["From"] = formataddr((settings.from_name, settings.from_email))
    message["To"] = email
    message["Subject"] = subject
    message.set_content(text)
    message.add_alternative(html, subtype="html")
    context = ssl.create_default_context()
    try:
        if settings.smtp_security == "ssl":
            server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, context=context, timeout=15)
        else:
            server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15)
            if settings.smtp_security == "starttls":
                server.starttls(context=context)
        with server:
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_password or "")
            server.send_message(message)
    except Exception:
        logger.exception("SMTP send failed for %s", email)
        return False
    return True

