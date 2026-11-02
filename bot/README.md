# Headless client (optional)

An optional add-on: a Bardesk client without a screen, for Node.js or Docker. It can run
anywhere, for example as a bar station, or next to a device with buttons or a touchscreen
that calls its local HTTP API (below).

It is an ordinary member of one group: it joins by invite, syncs live like any phone and
stays online, which also helps the members' phones to sync (see "Accepted limitations" in
[`DESIGN.md`](../DESIGN.md)). It books with `purchase.for` (see DESIGN.md, "Buying"), so the
member pays.

Its account has no mailbox: the bot creates its key pair, and you register it once by hand
in the server's database (the login API only registers keys after an emailed code). Use an
address that can never receive mail, e.g. `bot` (the login API refuses it, so nobody can
replace the bot's key). The name the members see is `BOT_NAME`.

```bash
cd frontend && npm ci && APP_VERSION='<version from version.json>' npm run build:bot
cd .. && docker build -f bot/Dockerfile -t bardesk-bot .

# 1. once: create the key pair; it prints how to register the account on the server
docker run --rm -v bardesk-bot:/data bardesk-bot register bot
#    run the printed SQL (or the `docker compose exec` command) on the server

# 2. an admin creates an invite in the group; the bot joins with it on its first start
docker run -d --name bardesk-bot --restart unless-stopped -v bardesk-bot:/data \
  -e BOT_RELAY_URL='wss://tab.example.org/api/ws' \
  -e BOT_JOIN_LINK='https://tab.example.org/join/<group>?t=<token>' bardesk-bot
```

The bot must carry exactly the app version your server serves (the relay lets only that
version sync). Every build gets a new version, so take it from the server: set
`APP_VERSION` to the `version` in `https://<your domain><BASE_PATH>version.json` when you
run `npm run build:bot`. Without `APP_VERSION` it uses the version of `frontend/dist`, which
the render step writes (the version includes the server's settings).

| Setting | Meaning |
|---|---|
| `BOT_RELAY_URL` | **Required** for `run`: the relay of your server, `wss://<your domain><BASE_PATH>api/ws` |
| `BOT_DIR` | Data folder (`/data`): `identity.json` (private key, device id) and `snapshot.json` (the log) |
| `BOT_NAME` | Name shown to the members, default `Bar station`; a changed name is applied on the next start |
| `BOT_JOIN_LINK` | Invite link, only used while the bot is in no group |
| `BOT_UNDO_MS` | How long a booking stays undoable before it syncs; default `0` = syncs at once (then `/undo` answers `false`) |
| `BOT_API_TOKEN` | Turns the local network API on (below); without it there is no API |
| `BOT_API_PORT` | API port, default `8080` |

## API for a device on the local network

Plain HTTP with `Authorization: Bearer <BOT_API_TOKEN>` (small devices may lack the memory
for TLS): keep it on the local network and never expose it. Prices and balances are in
cents; the member is identified by `email`. The bot books in the group it is in.

| Request | Answer |
|---|---|
| `GET /members` | `[{ "email", "name", "balance" }]`, member booked for most recently first (then by name), the bookings in their undo window included |
| `GET /products` | `[{ "id", "name", "price", "soldOut" }]` |
| `POST /book` `{ "member", "product", "quantity" }` | `{ "id", "total", "balance" }`; `quantity` 1 to 99; 404 unknown member/product, 409 sold out, 400 bad quantity |
| `POST /undo` `{ "id" }` | `{ "undone": true }` only while a booking is in its undo window (`BOT_UNDO_MS`, default 0 = never), else `false` |

**After every app update or settings change on the server, rebuild the bot** (the relay only lets the deployed
app version sync; an outdated bot stops with exit code 75 and the restart policy brings it
back once rebuilt).
