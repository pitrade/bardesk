# SPDX-License-Identifier: GPL-3.0-or-later
import time

import pytest
from sqlmodel import Session
from starlette.websockets import WebSocketDisconnect

from app import relay
from app.crypto import b64e, decrypt_with
from app.models import Account

ROOM = "7f0c1c9e-2a53-4a4e-9a55-2b7d0f5a1c11"


def test_unknown_email_is_rejected(client):
    with client.websocket_connect("/api/ws") as ws:
        ws.send_json({"t": "hello", "email": "nobody@example.com"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 4003


def test_wrong_key_cannot_answer_challenge(client, device):
    device("alice@example.com")
    with client.websocket_connect("/api/ws") as ws:
        ws.send_json({"t": "hello", "email": "alice@example.com"})
        assert ws.receive_json()["t"] == "challenge"
        ws.send_json({"t": "auth", "nonce": b64e(b"guess" * 6)})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 4003


def test_ping_returns_server_time(connect, device):
    with connect(device("alice@example.com")) as ws:
        ws.send_json({"t": "ping"})
        pong = ws.receive_json()
    assert pong["t"] == "pong" and pong["time"] > 0


def test_presence_and_relay(connect, device):
    alice, bob = device("alice@example.com"), device("bob@example.com")
    with connect(alice) as a, connect(bob) as b:
        a.send_json({"t": "join", "rooms": [ROOM]})
        assert a.receive_json() == {"t": "presence", "room": ROOM, "peers": []}

        b.send_json({"t": "join", "rooms": [ROOM]})
        assert b.receive_json() == {
            "t": "presence",
            "room": ROOM,
            "peers": [{"email": "alice@example.com", "key": alice.public_key}],
        }
        assert a.receive_json() == {
            "t": "peer_joined",
            "room": ROOM,
            "peer": {"email": "bob@example.com", "key": bob.public_key},
        }

        b.send_json({"t": "send", "room": ROOM, "to": "alice@example.com", "data": "opaque"})
        assert a.receive_json() == {"t": "msg", "room": ROOM, "from": "bob@example.com", "data": "opaque"}

        b.send_json({"t": "leave", "room": ROOM})
        assert a.receive_json() == {"t": "peer_left", "room": ROOM, "email": "bob@example.com"}


def test_relay_only_within_shared_room(connect, device):
    alice, bob = device("alice@example.com"), device("bob@example.com")
    with connect(alice) as a, connect(bob) as b:
        a.send_json({"t": "join", "rooms": [ROOM]})
        a.receive_json()
        # bob is not in the room: his message is dropped
        b.send_json({"t": "send", "room": ROOM, "to": "alice@example.com", "data": "x"})
        a.send_json({"t": "ping"})
        assert a.receive_json()["t"] == "pong"


def test_disconnect_announces_peer_left(connect, device):
    alice, bob = device("alice@example.com"), device("bob@example.com")
    with connect(alice) as a:
        a.send_json({"t": "join", "rooms": [ROOM]})
        a.receive_json()
        with connect(bob) as b:
            b.send_json({"t": "join", "rooms": [ROOM]})
            b.receive_json()
            assert a.receive_json()["t"] == "peer_joined"
        assert a.receive_json() == {"t": "peer_left", "room": ROOM, "email": "bob@example.com"}


def test_silent_device_is_dropped(connect, device, monkeypatch):
    monkeypatch.setattr(relay, "IDLE_TIMEOUT_SECONDS", 0.5)
    alice, bob = device("alice@example.com"), device("bob@example.com")
    with connect(bob) as b:
        b.send_json({"t": "join", "rooms": [ROOM]})
        b.receive_json()
        # bob falls silent without closing (crash, lost network); alice keeps pinging
        with connect(alice) as a:
            a.send_json({"t": "join", "rooms": [ROOM]})
            assert a.receive_json()["peers"][0]["email"] == "bob@example.com"
            for _ in range(20):
                time.sleep(0.1)
                a.send_json({"t": "ping"})
                message = a.receive_json()
                if message["t"] != "pong":
                    break
            assert message == {"t": "peer_left", "room": ROOM, "email": "bob@example.com"}


def test_new_login_kicks_old_device(client, connect, device, sent_codes):
    alice = device("alice@example.com")
    with connect(alice) as ws:
        client.post("/api/auth/request-login", json={"email": "alice@example.com"})
        new_key = device("carol@example.com").public_key  # any valid key
        client.post(
            "/api/auth/verify",
            json={"email": "alice@example.com", "code": sent_codes["alice@example.com"], "public_key": new_key},
        )
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 4001


def test_second_connection_supersedes_first(connect, device):
    alice = device("alice@example.com")
    with connect(alice) as first:
        with connect(alice):
            with pytest.raises(WebSocketDisconnect) as exc:
                first.receive_json()
    assert exc.value.code == 4002


def test_delete_account(client, connect, device, engine):
    alice = device("alice@example.com")
    with connect(alice) as ws:
        ws.send_json({"t": "delete_account"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 4004
    with Session(engine) as session:
        assert session.get(Account, "alice@example.com") is None


def test_old_key_cannot_connect_after_replacement(client, device):
    old = device("alice@example.com")
    device("alice@example.com")  # new login, new key
    with client.websocket_connect("/api/ws") as ws:
        ws.send_json({"t": "hello", "email": "alice@example.com"})
        challenge = ws.receive_json()
        with pytest.raises(Exception):
            decrypt_with(old.private_key, challenge)


def test_outdated_app_must_update_before_syncing(client, device, tmp_path, monkeypatch):
    from app.config import settings

    version_file = tmp_path / "version.json"
    version_file.write_text('{"version": "3.0.0-new"}')
    monkeypatch.setattr(settings, "frontend_version_file", str(version_file))
    device("alice@example.com")

    for version in ("3.0.0-old", None):
        with client.websocket_connect("/api/ws") as ws:
            ws.send_json({"t": "hello", "email": "alice@example.com", "version": version})
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
        assert exc.value.code == 4005

    with client.websocket_connect("/api/ws") as ws:
        ws.send_json({"t": "hello", "email": "alice@example.com", "version": "3.0.0-new"})
        assert ws.receive_json()["t"] == "challenge"


def test_missing_version_file_does_not_lock_anyone_out(client, device, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "frontend_version_file", str(tmp_path / "missing.json"))
    device("alice@example.com")
    with client.websocket_connect("/api/ws") as ws:
        ws.send_json({"t": "hello", "email": "alice@example.com", "version": "anything"})
        assert ws.receive_json()["t"] == "challenge"


def test_open_app_is_sent_to_update_after_a_deploy(client, connect, device, tmp_path, monkeypatch):
    from app.config import settings

    version_file = tmp_path / "version.json"
    monkeypatch.setattr(settings, "frontend_version_file", str(version_file))
    version_file.write_text('{"version": "v1"}')
    alice = device("alice@example.com")

    with client.websocket_connect("/api/ws") as ws:
        ws.send_json({"t": "hello", "email": alice.email, "version": "v1"})
        challenge = ws.receive_json()
        ws.send_json({"t": "auth", "nonce": b64e(decrypt_with(alice.private_key, challenge))})
        assert ws.receive_json()["t"] == "welcome"
        ws.send_json({"t": "ping"})
        assert ws.receive_json()["t"] == "pong"

        version_file.write_text('{"version": "v2"}')  # frontend deployed
        ws.send_json({"t": "ping"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 4005
