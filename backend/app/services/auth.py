# SPDX-License-Identifier: GPL-3.0-or-later
"""Login codes and the email -> public key registry.

Codes are 6-digit, short-lived, single-use, and allow only a few wrong guesses.
A successful verification binds the email to the device's public key, replacing
any previous key (one device per account).
"""
import secrets
from datetime import timedelta

from sqlmodel import Session, select

from ..config import settings
from ..models import Account, LoginCode
from ..utils import utcnow

MAX_CODE_ATTEMPTS = 5


def generate_login_code() -> str:
    return f"{secrets.randbelow(900000) + 100000}"


def store_login_code(session: Session, email: str, code: str) -> None:
    expires_at = utcnow() + timedelta(minutes=settings.login_code_expiry_minutes)
    existing = session.get(LoginCode, email)
    if existing:
        existing.code = code
        existing.expires_at = expires_at
        existing.attempts = 0
    else:
        session.add(LoginCode(email=email, code=code, expires_at=expires_at))
    session.commit()


def verify_login_code(session: Session, email: str, code: str) -> bool:
    stored = session.get(LoginCode, email)
    if not stored:
        return False

    if utcnow() > stored.expires_at:
        session.delete(stored)
        session.commit()
        return False

    if not secrets.compare_digest(stored.code, code):
        stored.attempts += 1
        if stored.attempts >= MAX_CODE_ATTEMPTS:
            session.delete(stored)
        session.commit()
        return False

    session.delete(stored)
    session.commit()
    return True


def register_key(session: Session, email: str, public_key: str) -> None:
    account = session.get(Account, email)
    if account:
        account.public_key = public_key
    else:
        session.add(Account(email=email, public_key=public_key))
    session.commit()


def purge_expired(session: Session) -> None:
    """Delete expired login codes. Called once at startup."""
    for code in session.exec(select(LoginCode).where(LoginCode.expires_at < utcnow())).all():
        session.delete(code)
    session.commit()
