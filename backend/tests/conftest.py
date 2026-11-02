# SPDX-License-Identifier: GPL-3.0-or-later
"""Test fixtures: in-memory DB, captured login emails, simulated devices.

Every test gets a fresh in-memory SQLite database and a client whose outgoing
login-code emails are captured in `sent_codes` instead of being sent. `device`
creates a key pair and registers it through the real PIN flow; `connect`
opens an authenticated relay WebSocket for it (solving the challenge in Python).
"""
import os

# Must be set before the app modules are imported: keeps the module-level
# engine away from any real DB file.
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["AUTH_RATE_LIMIT_PER_MINUTE"] = "0"  # tests log in many times from one client

from contextlib import contextmanager
from dataclasses import dataclass

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, create_engine

import app.routers.auth as auth_router
from app import database
from app.crypto import b64e, decrypt_with
from app.main import app


@dataclass
class Device:
    email: str
    private_key: ec.EllipticCurvePrivateKey

    @property
    def public_key(self) -> str:
        raw = self.private_key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        return b64e(raw)


@pytest.fixture()
def engine(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(database, "engine", engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def sent_codes(monkeypatch):
    """Capture login codes instead of sending email. Maps email -> last code."""
    codes: dict[str, str] = {}

    def fake_send(email: str, code: str, language: str | None = None) -> bool:
        codes[email] = code
        return True

    monkeypatch.setattr(auth_router, "send_login_code", fake_send)
    return codes


@pytest.fixture()
def client(engine, sent_codes):
    with TestClient(app) as client:
        yield client


@pytest.fixture()
def device(client, sent_codes):
    """Create a key pair and register it for `email` via the full PIN flow."""

    def _device(email: str) -> Device:
        dev = Device(email=email.lower(), private_key=ec.generate_private_key(ec.SECP256R1()))
        assert client.post("/api/auth/request-login", json={"email": email}).status_code == 200
        response = client.post(
            "/api/auth/verify",
            json={"email": email, "code": sent_codes[dev.email], "public_key": dev.public_key},
        )
        assert response.status_code == 200, response.text
        return dev

    return _device


@pytest.fixture()
def connect(client):
    """Open an authenticated relay connection for a device."""

    @contextmanager
    def _connect(dev: Device):
        with client.websocket_connect("/api/ws") as ws:
            ws.send_json({"t": "hello", "email": dev.email})
            challenge = ws.receive_json()
            assert challenge["t"] == "challenge"
            nonce = decrypt_with(dev.private_key, challenge)
            ws.send_json({"t": "auth", "nonce": b64e(nonce)})
            welcome = ws.receive_json()
            assert welcome["t"] == "welcome"
            yield ws

    return _connect
