# SPDX-License-Identifier: GPL-3.0-or-later
import time
from collections import defaultdict, deque
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import AfterValidator, BaseModel, EmailStr
from sqlmodel import Session

from ..config import settings
from ..crypto import load_public_key
from ..database import get_session
from ..relay import hub, now_ms
from ..services.auth import generate_login_code, register_key, store_login_code, verify_login_code
from ..services.mail import send_login_code

_requests: dict[str, deque[float]] = defaultdict(deque)


def rate_limit(request: Request) -> None:
    """At most N login requests per minute and client IP (off when a reverse proxy such as nginx limits instead)."""
    limit = settings.auth_rate_limit_per_minute
    if limit <= 0:
        return
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    recent = _requests[ip]
    while recent and now - recent[0] > 60:
        recent.popleft()
    if len(recent) >= limit:
        raise HTTPException(status_code=429, detail="Too many requests. Please wait a minute.")
    recent.append(now)


router = APIRouter(prefix="/api/auth", tags=["auth"], dependencies=[Depends(rate_limit)])

SessionDep = Annotated[Session, Depends(get_session)]

# Emails are identities; normalize case so Bob@x.com and bob@x.com are one account.
Email = Annotated[EmailStr, AfterValidator(str.lower)]


class RequestLoginIn(BaseModel):
    email: Email
    language: str | None = None  # only localizes the email, never stored


class VerifyIn(BaseModel):
    email: Email
    code: str
    public_key: str


class VerifyOut(BaseModel):
    email: str
    time: int  # server time in ms, lets the client correct its clock


@router.post("/request-login")
def request_login(payload: RequestLoginIn, session: SessionDep):
    code = generate_login_code()
    store_login_code(session, payload.email, code)
    if not send_login_code(payload.email, code, language=payload.language):
        raise HTTPException(status_code=502, detail="Could not send the login email. Please try again.")
    return {"message": "Login code sent"}


@router.post("/verify", response_model=VerifyOut)
async def verify(payload: VerifyIn, session: SessionDep):
    # async: kicking the previous device's WebSocket must run on the event loop
    try:
        load_public_key(payload.public_key)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid public key")

    if not verify_login_code(session, payload.email, payload.code.strip()):
        raise HTTPException(status_code=400, detail="Invalid or expired login code")

    register_key(session, payload.email, payload.public_key)
    await hub.kick(payload.email, code=4001, reason="replaced")
    return VerifyOut(email=payload.email, time=now_ms())
