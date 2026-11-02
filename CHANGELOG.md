# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (0.x.x until 1.0.0).

Development started in 2026-06. Earlier versions are not listed.

## [1.0.0] - 2026-11-02

First public release as Bardesk (formerly TapList). No changes since 0.9.1 except the
version, new README screenshots and the image tag `1.0` as the default in `docker-compose.yaml`.

- The bundled Caddy is optional (`COMPOSE_PROFILES=caddy`); the README explains how to use
  your own reverse proxy (app on `127.0.0.1:BARDESK_PORT`).

## [0.9.1] - 2026-11-02

Hardening of the Docker setup.

### Changed

- The container runs as the unprivileged user `bardesk` (UID 10001), not as root. The `data`
  volume keeps working only if its files belong to that user: an existing volume made by
  0.9.0 (root) needs a one-time
  `docker compose run --rm --user root --entrypoint chown app -R bardesk /data`.
- `docker-compose.yaml` pins the image to `${BARDESK_VERSION:-0.9}` instead of `latest`.
  Download the files from the release tag; update by changing `BARDESK_VERSION`.
- `AUTH_RATE_LIMIT_PER_MINUTE` defaults to `10` (was `0` = off), as in `.env.example`.
  **Upgrade note:** behind a reverse proxy that passes no proxy headers to uvicorn, the server
  sees every client as the proxy IP, so one limit of 10 applies to all users together. Either
  pass proxy headers (the Docker image does) or set `AUTH_RATE_LIMIT_PER_MINUTE=0` and limit in
  your proxy.
- CI runs with read-only token permissions; `.env*` files are ignored by git (except
  `.env.example`).

## [0.9.0] - 2026-11-02

A prebuilt Docker image: no build step for self-hosters.

### Changed

- Name, look, icon, `BASE_PATH` and `DB_NAME` are no longer built into the app. A render
  step (`python -m app.render`) writes them into the built app: the Docker image runs it at
  every start, other setups run it after every deploy. A settings change reaches installed
  apps like an update.
- Self-hosting uses the image `ghcr.io/pitrade/bardesk` (amd64, arm64): download
  `docker-compose.yaml` and `.env.example`, then `docker compose up -d`; update with
  `docker compose pull && docker compose up -d`. The Caddyfile is part of
  `docker-compose.yaml`. To build from source, use `compose.override.example.yaml`.
- An own icon must be a PNG: `branding/icon.png`, square, at least 512 px. **SVG icons
  (`icon.svg`) are no longer supported**; the render step stops with an error if it finds one.
- The app takes its path from `<base href>`; one build works under any `BASE_PATH`.
- The app version includes a hash of the settings (`0.9.0+<build>.<settings>`).
- `DB_NAME`: a device takes the server's value at its first start and keeps it (new key
  `bardesk_db_name`). If it changes later, existing devices keep their data and show a
  notice; only new devices use the new name. Devices from before 0.9.0 take the value once,
  so set the `DB_NAME` the app was built with.

### Added

- Release workflow: on a tag `vX.Y.Z`, all tests, then the image for amd64 and arm64 on
  GHCR (tags `X.Y.Z`, `X.Y`, `latest`).
- Backend dependency Pillow (icons).

## [0.8.0] - 2026-11-02

First public release.

### Changed

- Renamed from TapList to Bardesk: names, storage keys (`bardesk_*`, the language choice
  resets once), crypto constants, export file (`app: "bardesk"`, `bardesk-<date>.json`),
  server database default `bardesk.db`, Docker and CI names.
- Texts that name the app use the configured `APP_NAME`.
- Defaults without site-specific values: `BASE_PATH` `/`, `FROM_EMAIL`
  `bardesk@example.org`, `SMTP_HOST` empty in `.env.example` (login codes in the log).
- The headless client (`bot/`) is a generic, optional add-on: `BOT_RELAY_URL` is
  required, default `BOT_NAME` "Bar station", `register` prints generic instructions.
- The amount field no longer names a currency.
- New documentation: README, AI.md, CONTRIBUTING.md, SECURITY.md; CLAUDE.md is a
  contributor guide.

### Added

- `DB_NAME`: build setting for the IndexedDB name on the devices (default `bardesk`).
- Licence: GPL-3.0-or-later (`LICENSE`, SPDX headers).

### Removed

- The Mailjet API: login mail goes through SMTP only (any provider, also Mailjet's SMTP).
- Export files of TapList (`app: "taplist"`) can no longer be imported.
- Unused code and dependencies (`python-dotenv`, SQLite foreign-key setting).
