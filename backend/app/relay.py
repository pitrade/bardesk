# SPDX-License-Identifier: GPL-3.0-or-later
"""Live relay: rendezvous rooms where member devices meet and exchange encrypted messages.

Nothing is stored, rooms and connections live in memory only. The server never
sees group content: payloads are encrypted per recipient by the clients. It only
authenticates devices (challenge encrypted to the registered public key) and
tells room participants who else is present (verified email + public key).

Protocol (JSON text frames, `t` = type):
  client: hello{email,version} -> server: challenge{epk,iv,ct} -> client: auth{nonce}
  server: welcome{time}
  client: join{rooms}          -> server: presence{room,peers} to the joiner,
                                  peer_joined{room,peer} to the others
  client: leave{room}          -> server: peer_left{room,email} to the others
  client: send{room,to,data}   -> server: msg{room,from,data} to `to`
  client: ping                 -> server: pong{time}
  client: delete_account       -> account removed, socket closed (4004)
Close codes: 4001 key replaced by a new login, 4002 superseded by another
connection of the same account, 4003 authentication failed, 4004 deleted,
4005 app version differs from the deployed frontend (update first, then sync) , 
checked on connect and on every ping, so open apps are sent to update after a deploy.
Presence: apps close their connection when they go to the background; a device that
vanishes without closing (crash, lost network) is dropped after IDLE_TIMEOUT_SECONDS
without a message (clients ping every 25 s).
"""
import asyncio
import json
import secrets
import time
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlmodel import Session

from . import database
from .config import settings
from .crypto import b64e, encrypt_to
from .models import Account

router = APIRouter()

AUTH_TIMEOUT_SECONDS = 10
IDLE_TIMEOUT_SECONDS = 60  # two missed pings plus a margin
MAX_ROOMS_PER_CONNECTION = 200
MAX_ROOM_ID_LENGTH = 64


def now_ms() -> int:
    return int(time.time() * 1000)


class Peer:
    def __init__(self, ws: WebSocket, email: str, public_key: str, version: str | None = None):
        self.ws = ws
        self.email = email
        self.public_key = public_key
        self.version = version
        self.rooms: set[str] = set()
        self._lock = asyncio.Lock()

    def info(self) -> dict[str, str]:
        return {"email": self.email, "key": self.public_key}

    async def send(self, message: dict) -> None:
        async with self._lock:
            try:
                await self.ws.send_json(message)
            except Exception:
                pass  # the socket is closing; its own handler cleans up


class Hub:
    def __init__(self) -> None:
        self.peers: dict[str, Peer] = {}  # email -> the account's live connection
        self.rooms: dict[str, set[str]] = {}  # room -> emails present

    async def add(self, peer: Peer) -> None:
        # one connection per account: a new one (e.g. second tab) replaces the old
        await self.kick(peer.email, code=4002, reason="superseded")
        self.peers[peer.email] = peer

    async def remove(self, peer: Peer) -> None:
        if self.peers.get(peer.email) is not peer:
            return  # already replaced by a newer connection
        del self.peers[peer.email]
        for room in list(peer.rooms):
            await self.leave(peer, room)

    async def kick(self, email: str, code: int, reason: str) -> None:
        peer = self.peers.get(email)
        if not peer:
            return
        await self.remove(peer)
        try:
            await peer.ws.close(code=code, reason=reason)
        except Exception:
            pass

    async def join(self, peer: Peer, room: str) -> None:
        present = self.rooms.setdefault(room, set())
        if peer.email in present:
            return
        others = [self.peers[email] for email in present if email in self.peers]
        present.add(peer.email)
        peer.rooms.add(room)
        await peer.send({"t": "presence", "room": room, "peers": [o.info() for o in others]})
        for other in others:
            await other.send({"t": "peer_joined", "room": room, "peer": peer.info()})

    async def leave(self, peer: Peer, room: str) -> None:
        present = self.rooms.get(room)
        if not present or peer.email not in present:
            return
        present.discard(peer.email)
        peer.rooms.discard(room)
        if not present:
            del self.rooms[room]
        for email in present:
            other = self.peers.get(email)
            if other:
                await other.send({"t": "peer_left", "room": room, "email": peer.email})

    async def relay(self, peer: Peer, room: str, to: str, data: str) -> None:
        if room not in peer.rooms or to not in self.rooms.get(room, ()):
            return
        target = self.peers.get(to)
        if target:
            await target.send({"t": "msg", "room": room, "from": peer.email, "data": data})


hub = Hub()


def deployed_version() -> str | None:
    """Version of the deployed frontend, read per connection (frontend deploys need no restart)."""
    if not settings.version_file:
        return None
    try:
        return json.loads(Path(settings.version_file).read_text())["version"]
    except (OSError, ValueError, KeyError, TypeError):
        return None  # missing or broken file: don't lock everyone out


def _valid_room(room: object) -> bool:
    return isinstance(room, str) and 0 < len(room) <= MAX_ROOM_ID_LENGTH


async def _authenticate(ws: WebSocket, hello: dict) -> Peer | None:
    email = str(hello.get("email", "")).strip().lower()
    with Session(database.engine) as session:
        account = session.get(Account, email) if hello.get("t") == "hello" else None
        public_key = account.public_key if account else None
    if not public_key:
        return None

    nonce = secrets.token_bytes(32)
    await ws.send_json({"t": "challenge", **encrypt_to(public_key, nonce)})
    reply = await asyncio.wait_for(ws.receive_json(), AUTH_TIMEOUT_SECONDS)
    if reply.get("t") != "auth" or not secrets.compare_digest(str(reply.get("nonce", "")), b64e(nonce)):
        return None
    return Peer(ws, email, public_key, hello.get("version"))


def _delete_account(email: str) -> None:
    with Session(database.engine) as session:
        account = session.get(Account, email)
        if account:
            session.delete(account)
            session.commit()


@router.websocket("/api/ws")
async def relay_endpoint(ws: WebSocket):
    await ws.accept()
    peer: Peer | None = None
    try:
        hello = await asyncio.wait_for(ws.receive_json(), AUTH_TIMEOUT_SECONDS)
        required = deployed_version()
        if required and hello.get("version") != required:
            await ws.close(code=4005, reason="update required")
            return
        peer = await _authenticate(ws, hello)
        if not peer:
            await ws.close(code=4003, reason="authentication failed")
            return
        await hub.add(peer)
        await peer.send({"t": "welcome", "time": now_ms()})

        while True:
            message = await asyncio.wait_for(ws.receive_json(), IDLE_TIMEOUT_SECONDS)
            kind = message.get("t")
            if kind == "ping":
                required = deployed_version()
                if required and peer.version != required:
                    await hub.kick(peer.email, code=4005, reason="update required")
                    return
                await peer.send({"t": "pong", "time": now_ms()})
            elif kind == "join":
                for room in message.get("rooms", []):
                    if _valid_room(room) and len(peer.rooms) < MAX_ROOMS_PER_CONNECTION:
                        await hub.join(peer, room)
            elif kind == "leave":
                if _valid_room(message.get("room")):
                    await hub.leave(peer, message["room"])
            elif kind == "send":
                room, to, data = message.get("room"), message.get("to"), message.get("data")
                if _valid_room(room) and isinstance(to, str) and isinstance(data, str):
                    await hub.relay(peer, room, to, data)
            elif kind == "delete_account":
                _delete_account(peer.email)
                await hub.kick(peer.email, code=4004, reason="deleted")
                return
    except (WebSocketDisconnect, asyncio.TimeoutError, ValueError, AttributeError, RuntimeError):
        pass
    finally:
        if peer:
            await hub.remove(peer)
