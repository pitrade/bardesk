# SPDX-License-Identifier: GPL-3.0-or-later
# Bardesk: one image serving the app and the API/relay (self-hosting).
# It holds no settings: at every start the render step (backend/app/render.py) writes them
# (.env: name, look, BASE_PATH, DB_NAME, branding/icon.png) into the app.

# the built app is the same for every platform: build it once, natively
FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# run as an unprivileged user; it owns /data and the built app (the render step writes there)
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin bardesk \
    && mkdir /data && chown bardesk /data
COPY backend/app ./app
COPY --from=frontend --chown=bardesk /build/dist ./static
# the only server data: email -> public key and pending login codes
ENV DATABASE_URL=sqlite:////data/bardesk.db \
    FRONTEND_DIR=/app/static \
    BRANDING_DIR=/app/branding
VOLUME /data
USER bardesk
EXPOSE 8000
# write the settings into the app, then start the server (CMD)
ENTRYPOINT ["sh", "-c", "python -m app.render && exec \"$@\"", "--"]
# behind Caddy: trust its X-Forwarded-For so the login rate limit sees real client IPs.
# "*" because Caddy's IP on the compose network is not fixed. This is safe only while port 8000
# is not published: never add `ports:` for the app, or clients could fake their IP.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
