# AGENTS.md

Guide for contributors and coding agents (any AI coding assistant) working in this repository.
Setup and commit conventions: `CONTRIBUTING.md`. User documentation: `README.md`.

## Project Overview

Bardesk, a self-hosted, trust-based cashbox for small communities (local-first, high
privacy), built as a PWA. **`DESIGN.md` is the source of truth** for every design decision (data model, sync,
joining, accepted limitations); read it before changing behavior.

In one paragraph: each group is an append-only log of entries that every member device holds
in IndexedDB. State (members, products, balances) is derived by deterministic replay. Devices
sync live, peer to peer, through a relay that stores nothing and cannot read the (per-recipient
encrypted) messages. The server only keeps `email → public key` plus pending login codes.

## Engineering Rules

- **Minimal changes:** only what the task needs; no new features or settings on the side.
- **Headless automated tests** (incl. Playwright) instead of clicking through a browser.
- **Never write workaround code.** Only best-practice, minimal code; find causes from evidence
  (research, measurements), no guessing. If a platform bug only has workarounds, explain and
  let the maintainer decide.
- **Version stays 0.x.x** until the maintainer declares 1.0.0; bump the patch/minor per
  release (`frontend/package.json`, `CHANGELOG.md`).
- **`./scripts/test.sh` must be green** before every commit you hand in.
- **AI assistance is disclosed** in the commit trailer (see `AI.md`).

## Code Map

**Frontend** (`frontend/src/`), Vue 3 + Vite + TypeScript, Pinia, vue-i18n, Tailwind v4
- `core/`: framework-free engine (runs in Node for tests):
  - `types.ts` entry/state types · `replay.ts` deterministic replay + derived views ·
    `group.ts` per-group log with version vector and in-order acceptance ·
    `hlc.ts` hybrid logical clock · `crypto.ts` Web Crypto (P-256 ECDH, HKDF, AES-GCM) ·
    `db.ts` Dexie schema (logs, local groups, pending purchases, meta) ·
    `relay.ts` WebSocket relay client · `client.ts` TapClient: actions + peer protocol
  - `testing/`: `memoryRelay.ts` (in-memory relay) and `harness.ts` (multi-device World)
  - `db.ts` also caches the replayed state per group (`states`: count + app version)
- `stores/tap.ts`: bridges TapClient to Vue: rebuilds a plain `view` snapshot on every change
- `views/`: Tab, Chat, Group (active group: picker + `JoinOrCreate` + `GroupManage`), Join,
  Profile (tab "Settings"), auth/Login + Verify
- `components/`: BottomNav, QrScanner (camera + jsQR, lazy-loaded, preloaded when idle),
  QrCode (invite QR), QrDialog (QR in a modal `<dialog>`), QuantityDialog (book several of a product), InstallHint, LegalLinks, GroupManage (one group's page, keyed by id),
  JoinOrCreate, GroupHeader (active group name + online badge), CollapsibleCard
- `bot/`: the optional headless client, e.g. for a bar station (Node, not part of the app bundle):
  `identity.ts` (key pair in a file), `bot.ts` (TapClient + snapshot + join), `api.ts` (HTTP
  API for a device on the local network: members, products, book, undo), `main.ts`
  (`register` / `run`); `npm run build:bot` bundles it (`vite.bot.config.ts`, version taken
  from `APP_VERSION` or the rendered `dist/version.json`) into `bot/dist/bot.mjs`; Dockerfile
  and guide in `/bot`.
- `utils/`: `entries.ts` (log lines, CSV, file save/share), `update.ts` (self-update on
  4005, version display, "Updated to …" note), `dbName.ts` (the device keeps the IndexedDB
  name of its first start), `links.ts` (invite/group link parsing),
  `qr.ts` (QR decoding), `install.ts` (install prompt, standalone detection), currency, dates
- All pages are bundled (no lazy routes); libraries go to a stable `vendor` chunk.
- **Layout = app shell** (`App.vue`): a `fixed inset-0` flex column; only `<main>` scrolls,
  `BottomNav` is its last row (not `position: fixed`), overlays (banner, undo toast, QR
  scanner) are `absolute` inside the shell. Opaque status bar (`default`/`black`). No
  `viewport-fit=cover` (see the comment in `index.html`: WebKit bug 301108), so iOS keeps the
  app inside the safe areas and there is no `env(safe-area-inset-*)` code. Plain CSS, no
  device checks, **no workarounds** for platform bugs.
- Design system in `src/style.css` (`@theme` tokens + `.card`, `.row`, `.btn-*`, `.banner`,
  `.toast`, …). Light theme by default, dark via `[data-theme='dark']`. Never name a component
  class after a Tailwind utility (hence `.row`, not `.list-item`). Tailwind v4 can't `@apply`
  own component classes.
- **Settings at run time, no brand in the build:** APP_NAME, APP_SHORT_NAME,
  COLOR_PRIMARY/SECONDARY, THEME, DEFAULT_LANGUAGE, CURRENCY, TOPUP_AMOUNTS, IMPRINT_URL,
  PRIVACY_URL, DB_NAME, BASE_PATH and `branding/icon.png` are written into the build by the
  backend's render step (`backend/app/render.py`, see DESIGN.md "Settings"). The build
  (`vite.config.ts`) leaves its templates in `dist/template/` (`index.html`, `sw.js`,
  build version, the default mug from `frontend/icon.ts`, pre-rendered transparent by
  `@resvg/resvg-js`) and precaches rendered files with revision `render:<file>`. The app reads
  `config.js` (`self.BARDESK_CONFIG`) as `brand` (`src/brand.ts`, incl. `brand.version` =
  build + settings hash, sent to the relay); `__APP_VERSION__` is only the build version
  (state cache). Paths are relative: router, API, relay and links use `<base href>`.
  The dev server and unit tests use `src/devConfig.ts`. Default look: light, red, dark grey.
  UI strings that name the app interpolate `{app}` with `brand.name`, never a fixed name.
  The backend's `APP_NAME` goes into the login emails.

**Backend** (`backend/app/`), FastAPI + SQLModel + SQLite, single uvicorn worker
- `routers/auth.py`: `POST /api/auth/request-login`, `POST /api/auth/verify` (binds the
  device's public key; kicks the previous device's connection)
- `relay.py`: `WS /api/ws`: challenge-response auth, rooms, presence, forwarding (in memory)
- `crypto.py`: ECIES challenge encryption; must stay compatible with `core/crypto.ts`
  (a test vector in `crypto.test.ts` checks this)
- `services/mail.py`: login-code email (de/en, uses `APP_NAME`) via SMTP; without
  `SMTP_HOST` the code is only logged
- `main.py`: also serves the built frontend when `FRONTEND_DIR` is set (self-hosting)
- `render.py`: the render step (`python -m app.render [FOLDER]`): settings → `index.html`,
  manifest, icons (Pillow), `config.js`, `sw.js` precache revisions, `version.json`
- Relay version gate: `FRONTEND_VERSION_FILE` (or `FRONTEND_DIR/version.json`); other app
  versions are closed with 4005 on connect and on every ping

## Internationalization

German and English catalogs in `frontend/src/i18n/de.ts` / `en.ts` (identical key sets,
checked by a test). Language is a device-only setting (`localStorage` `bardesk_language`,
default from the setting `DEFAULT_LANGUAGE`, else `navigator.language`); it is sent with the
PIN request to localize the email.
Don't use `@` or `|` in catalog strings (vue-i18n syntax).

## Testing

Prefer headless automated tests over browser checks, they are cheap to rerun. Run
everything before committing; output is one line per suite, details only on failure (`-v` for
full output):

```bash
./scripts/test.sh
```

- **backend**: `cd backend && ./venv/bin/python -m pytest tests/ -q`: auth, key replacement,
  relay auth/presence/forwarding, account deletion, render step (`test_render.py`). `conftest.py` provides `device(email)`
  (real PIN flow with a Python key pair) and `connect(device)` (authenticated WebSocket).
- **frontend**: `cd frontend && npm test`: `core/*.test.ts` run in Node with fake IndexedDB,
  real Web Crypto and the in-memory relay: replay convergence under random orders,
  multi-device scenarios (joining, forwarding, offline, removal, leaving, undo, export).
- **e2e**: `core/e2e.test.ts` (skipped unless `E2E_URL` is set): real `WebSocketRelay`
  clients in Node against a real uvicorn started by `scripts/test.sh` with a temp DB; login
  codes are read from the server log (no mail server set).
- **ui**: Playwright, headless mobile Chromium (`frontend/ui/*.pw.ts`,
  `frontend/playwright.config.ts`, which builds the app into a temp dir, renders it with
  `ui/settings.ts` and serves it from its own backend on port 18767; `render()` in
  `ui/helpers.ts` renders again with other settings).
  `phone()` in `ui/helpers.ts` = an isolated device (own browser context, storage and key);
  covers login, create group, invite → join, buy + undo, several at once (double tap / long press dialog), live sync, presence (app in the background), top-up/correction,
  later sync, rejoin on a new phone with an old invite link, removal notice, group picker, language, leave + delete account, group chat, and joining by
  scanning the invite QR in the app (Chromium fake camera fed a generated Y4M video,
  `qrVideo()` in `ui/helpers.ts`), and changed settings reaching an open app (update via
  4005, kept database, offline start). **Add UI checks here instead
  of clicking through the app in a browser.**
  The branding test writes `look-group.png` / `look-tab.png` to `frontend/test-results/`;
  copy them to `docs/screenshots/` when the look changes.
- **bot**: `src/bot/bot.test.ts` (identity file, join by invite, booking for a member,
  restart with continuing seq), `api.test.ts` (token, lists, booking, undo, refusals) and one e2e test against the real relay.
- **build**: `npm run build` is the type-check (vue-tsc).
- **Self-hosting image** (not in `test.sh`, needs Docker, ~2 min): `./scripts/test-docker.sh`
  builds the image once, starts it with two different settings behind Caddy (`/` and
  `/pub/`), checks the rendered files, that all linked files load under the path, cache
  headers, runs the e2e tests against the container and validates `docker-compose.yaml`
  (with its inline Caddyfile) and `compose.override.example.yaml`.
- Manual browser run (last resort): `.claude/launch.json` starts backend (no mail server)
  and Vite (dev `config.js` from `src/devConfig.ts`); `localhost:5173` and `127.0.0.1:5173`
  act as two devices (separate IndexedDB).

## Self-hosting (Docker)

`Dockerfile` (one image without settings: the entrypoint runs the render step, then the
backend serves the app via `FRONTEND_DIR` with SPA fallback + cache headers),
`docker-compose.yaml` (the GHCR image + Caddy for automatic HTTPS; inline Caddyfile strips
`BASE_PATH`, proxies WebSockets; `./branding` mounted), `compose.override.example.yaml`
(build from source), `.env.example`. `.github/workflows/release.yml`: on a tag `vX.Y.Z`,
CI, then a multi-arch image to `ghcr.io/<owner>/bardesk` (X.Y.Z, X.Y, latest).
Mail via SMTP (`SMTP_*`); without `SMTP_HOST`, login codes are only logged.
`AUTH_RATE_LIMIT_PER_MINUTE` limits login requests in the app (behind another reverse proxy,
that proxy can do it instead). Guide: `README.md`.

## Open / Future Work

See "Out of scope" in `DESIGN.md`: push notifications, native apps (Capacitor), multiple
devices per account (QR key linking), snapshots/compaction. iOS-only details (notch,
install flow, camera) can only be verified on a real iPhone.
