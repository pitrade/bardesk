# SPDX-License-Identifier: GPL-3.0-or-later
"""The only data the server keeps: who owns which public key, and pending login codes.

Groups, entries and balances never reach the server in readable form (see DESIGN.md).
"""
from datetime import datetime

from sqlmodel import Field, SQLModel


class Account(SQLModel, table=True):
    email: str = Field(primary_key=True)  # lowercased
    public_key: str  # base64url of the raw uncompressed P-256 point (65 bytes)


class LoginCode(SQLModel, table=True):
    email: str = Field(primary_key=True)
    code: str
    expires_at: datetime
    attempts: int = 0  # failed guesses; the code is discarded after MAX_CODE_ATTEMPTS
