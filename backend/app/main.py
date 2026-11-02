# SPDX-License-Identifier: GPL-3.0-or-later
import re
from contextlib import asynccontextmanager
from functools import lru_cache

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import database, relay
from .config import settings
from .routers import auth
from .services.auth import purge_expired


@asynccontextmanager
async def lifespan(_app: FastAPI):
    database.init_db()
    with Session(database.engine) as session:
        purge_expired(session)
    yield


app = FastAPI(title="Bardesk relay", lifespan=lifespan)

app.include_router(auth.router)
app.include_router(relay.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "time": relay.now_ms()}


# ---- self-hosting: serve the built frontend (or let a web server like nginx do it) ----

IMMUTABLE = re.compile(r"^(assets/|workbox-[^/]+\.js$)")


@lru_cache
def _frontend(directory: str) -> StaticFiles:
    return StaticFiles(directory=directory, html=True)


@app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
async def frontend(path: str, request: Request):
    """Files of FRONTEND_DIR; unknown paths get index.html (client-side routes like /groups)."""
    if not settings.frontend_dir or path.startswith("api/"):
        raise HTTPException(status_code=404)
    files = _frontend(settings.frontend_dir)
    try:
        response = await files.get_response(path, request.scope)
        immutable = bool(IMMUTABLE.match(path))
    except StarletteHTTPException as exc:
        # a missing file stays a 404; only page routes (no file extension) fall back to the app
        if exc.status_code != 404 or "." in path.rsplit("/", 1)[-1]:
            raise
        response = await files.get_response("index.html", request.scope)
        immutable = False
    # hashed build files never change; everything else must be revalidated so updates show up
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if immutable else "no-cache"
    return response
