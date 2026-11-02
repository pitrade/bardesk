# SPDX-License-Identifier: GPL-3.0-or-later
from datetime import timedelta

from sqlmodel import Session

from app.models import Account, LoginCode
from app.utils import utcnow


def request(client, email="alice@example.com"):
    return client.post("/api/auth/request-login", json={"email": email, "language": "de"})


def verify(client, code, public_key, email="alice@example.com"):
    return client.post("/api/auth/verify", json={"email": email, "code": code, "public_key": public_key})


def test_verify_registers_public_key(client, engine, sent_codes, device):
    dev = device("Alice@Example.com")
    with Session(engine) as session:
        account = session.get(Account, "alice@example.com")
    assert account.public_key == dev.public_key


def test_verify_returns_server_time(client, sent_codes, device):
    dev = device("alice@example.com")
    request(client)
    response = verify(client, sent_codes["alice@example.com"], dev.public_key)
    assert response.json()["email"] == "alice@example.com"
    assert response.json()["time"] > 1_700_000_000_000


def test_new_login_replaces_key(client, engine, device):
    first = device("alice@example.com")
    second = device("alice@example.com")
    assert first.public_key != second.public_key
    with Session(engine) as session:
        assert session.get(Account, "alice@example.com").public_key == second.public_key


def test_wrong_code_rejected_and_code_dies_after_five_guesses(client, sent_codes, device):
    key = device("bob@example.com").public_key
    request(client)
    code = sent_codes["alice@example.com"]
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(5):
        assert verify(client, wrong, key).status_code == 400
    assert verify(client, code, key).status_code == 400  # discarded


def test_code_is_single_use(client, sent_codes, device):
    key = device("bob@example.com").public_key
    request(client)
    code = sent_codes["alice@example.com"]
    assert verify(client, code, key).status_code == 200
    assert verify(client, code, key).status_code == 400


def test_expired_code_rejected(client, engine, sent_codes, device):
    key = device("bob@example.com").public_key
    request(client)
    with Session(engine) as session:
        stored = session.get(LoginCode, "alice@example.com")
        stored.expires_at = utcnow() - timedelta(seconds=1)
        session.add(stored)
        session.commit()
    assert verify(client, sent_codes["alice@example.com"], key).status_code == 400


def test_invalid_public_key_rejected(client, sent_codes):
    request(client)
    assert verify(client, sent_codes["alice@example.com"], "not-a-key").status_code == 400


def test_invalid_email_rejected(client):
    assert client.post("/api/auth/request-login", json={"email": "nope"}).status_code == 422
