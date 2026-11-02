# Bardesk: Local-first design

Bardesk is a local-first, high-privacy PWA: a trust-based cashbox for small communities.
Goal: the server stores nothing about groups, purchases or balances, every member device
holds the full group data.

## Principles

- **Trust-based.** Permissions prevent accidents, not malice. Admin controls are hidden in
  the UI; replay performs no role checks.
- **Local-first.** Everything works offline except first login, joining and syncing.
- **Server is a blind relay.** It knows emails and public keys, never group content.
- **One log per group.** All state is derived from an append-only log of entries.

## Stack

- **App:** Vue 3 + Vite + TypeScript + Tailwind v4, Dexie (IndexedDB), Web Crypto. PWA,
  path configurable (`BASE_PATH`, default `/`, at run time: see Settings).
- **Server:** FastAPI, single worker: email PIN (SMTP), key registry, WebSocket
  relay; optionally serves the built app (self-hosting).
- **Hosting:** a prebuilt image (GHCR, amd64 + arm64) with Docker Compose and Caddy
  (automatic HTTPS), see README; any reverse proxy with WebSocket support works. Clients send keepalive pings every 25 s, because some
  proxies and CDNs close idle WebSockets (Cloudflare after ~100 s).

## Identity

- Account = email address, **one device per account**. The device generates an ECDH P-256
  key pair (Web Crypto, non-extractable).
- **Login / registration:** enter email → 6-digit PIN by email (5 min, max 5 wrong guesses,
  rate limit in a reverse proxy or in the app) → verify PIN together with the public key → server stores
  `email → public key`. A new verification replaces the previous key: logging in on a new
  device logs out the old one. Groups come back via any invite link of the group (see Joining).
- **No tokens.** On WebSocket connect the server sends a challenge encrypted to the public
  key; the client proves possession by decrypting it.
- **Language:** device-only setting; sent with the PIN request to localize the email.
- **Account deletion:** only after leaving all groups; the server deletes email + key.

### Server data

| Table | Fields |
|---|---|
| `Account` | email, public_key |
| `LoginCode` | email, code, expires_at, attempts |

Live connections and room presence exist in memory only.

## Groups and entries

- A group is an append-only **log of entries**; every member device holds a full copy.
- Group ID = random UUID, also the relay room ID (not secret).
- **Active group** is a device-only setting.
- **No global deletion.** A group ends when its last member has left.
- **Leaving** removes the group from the device immediately. The `member.left` entry and any
  other unsent entries stay in a small **outbox** until a member is online, then are sent
  and dropped.

### Entry

| Field | Meaning |
|---|---|
| `device_id`, `seq` | **unique key**: creating device + per-device counter (see below) |
| `author` | email of the member who created it |
| `type`, `data` | what happened |
| `hlc` | hybrid logical clock timestamp; ties broken by `device_id`, `seq` |
| `version` | entry format version |

**Sequence rules** (sync and future snapshots rely on them):
1. `seq` only increases and is stored on the device; numbers are never reused. It is
   assigned when the entry is sent (after the undo window), so undo leaves no gaps.
2. `device_id` is random per installation; wiped storage means a new `device_id`, so a
   restarted counter never clashes.
3. Entries are accepted in order only: `#5` from a device waits until `#4` is there.

### Entry types

| Type | Data | Who (UI) |
|---|---|---|
| `group.created` | name, description: creator becomes admin | anyone |
| `group.updated` | name, description | admin |
| `invite.created` | token, expires_at (24h), multi_use (default off) | admin |
| `invite.revoked` | token | admin |
| `member.joined` | email, displayname, token | admitting member |
| `member.renamed` | displayname (per group) | self |
| `member.role` | email, role: any member may promote **themselves** (confirmation) | admin / self |
| `member.left` |: (UI: balance zero) | self |
| `member.removed` | email (UI: balance zero) | admin |
| `product.added` | id, name, price, sort_order | admin |
| `product.updated` | name, price, sort_order, sold_out | admin |
| `product.deleted` | id: final, later edits ignored | admin |
| `purchase` | product_id, name, price (per item, at purchase time), quantity (missing = 1), for (member who pays, missing = the author) | self; a bar station for a member |
| `topup` | amount (±), description: covers deposit, correction, cash-out | self |
| `settled` | email, amount: clears a former member's open balance | admin |
| `chat.message` | id, text (max 2000 chars) | any member |
| `chat.deleted` | id: hides the message; only its author's delete counts | self |

### Derived state

Group, members, products, invites, messages and balances are computed by replaying the
log sorted by `hlc`; new entries are applied on top. A late entry older than the newest one
triggers a full replay (milliseconds for a small community: ~10k entries ≈ 3 MB per year).

**State cache:** the replay result is saved per group (Dexie table `states`) with the entry
count and app version. At start it is used as-is if both match, the log is append-only, so
the same count means the same log, otherwise the app replays once and saves it again. The
cache is only a shortcut: it can always be deleted and rebuilt from the log.

- Later entries overwrite earlier ones (last-writer-wins falls out of the sort order).
- `product.deleted` is final; later edits of that product are ignored.
- **Balance** = sum of the member's `purchase`, `topup` and `settled` entries.
- **Last seen** per member = newest entry authored by them.
- **Former members with open balances** = removed/left members whose balance is non-zero.
- Unknown entry types (older app version): kept and forwarded, ignored in replay; after an
  app update the next replay includes them.
- **Replay is deterministic:** the same entries give the same state on every device: no
  local clock, device settings or randomness.
- **State is plain data** (JSON-serializable), so it can become a snapshot later.

## Sync

- **Live only.** Each group has a room on the relay. Devices join the rooms of all their
  groups while the app is open. Nothing is stored on the server, there is no push.
- The server tells each device who is present: verified email + public key.
- **Present = app in the foreground:** an app closes its connection when it goes to the
  background (the others see it leave at once; an app is always hidden before it gets
  killed) and reconnects when it is back. A device that vanishes without closing (crash,
  lost network) is dropped after 60 s without a message (clients ping every 25 s).
- Devices accept entries only from senders who are current members in their own view.
  Removed members cannot sync; a hello from a removed member is answered with `removed`,
  so that device drops the group and shows a notice.
- **Reconciliation:** version vectors: each side sends `{device_id: max seq}`, the other
  replies with exactly the missing entries. Pull before push.
- **Forwarding:** devices share all entries they hold, including other members' entries.
- **Encryption:** per recipient (ECDH + HKDF + AES-GCM via Web Crypto). No group key, no
  signatures.
- **Merge:** append by `device_id` + `seq` (duplicates ignored), then apply (or replay).
- **Clock:** the HLC is corrected with the server time on connect.

## App updates

- Every build has a unique build version (`package.json` version + build id). The app
  version is the build version + a hash of the settings (`0.9.0+<build>.<settings>`); the
  render step writes it to `config.js` and `version.json` (see Settings). So a deploy and a
  settings change both count as an update.
- The app sends its version in the relay `hello`. The relay only lets **exactly the deployed
  version** sync: others are closed with 4005 "update required", on connect and on every
  keepalive ping, so apps that are open during a deploy are caught within ~25 s.
- On 4005 the app updates its service worker and reloads, then syncs. A loop guard offers a
  manual reload if the new version doesn't arrive. Offline use continues meanwhile.
- So devices never sync across app versions; replay must still read every old entry format
  (the logs keep them forever).

## Joining

- An admin creates an invite link (`group id + token`), with a QR code (on request, in the
  foreground) and a share button.
  Valid 24h, multi-use toggle (default off), revocable.
- The new user scans the QR code **inside the app** (Group tab → "Scan invite QR code"; the
  phone's camera app would open the link in the browser instead of the installed app) or
  pastes/opens the link → email PIN login → enters display name → connects to the
  room → **any online member** validates the token against their log, writes
  `member.joined` and sends the full log.
- Requires a member to be online at the same time.
- To avoid double admissions, only the online member with the lowest email (besides the
  joiner) answers a join request. A single-use invite used twice in a rare race is accepted.
- **Rejoin** (new device, lost data): the member opens any invite link of the group, even an
  expired or used one (the Group page says so where a new phone lands: the empty state and the
  join hint), the token is only checked for newcomers. The device joins the room
  with an empty database; any online member sees the server-verified email is a current
  member and sends the full log. (There is no separate group link: anyone can make
  themselves admin and create an invite anyway. A link without a token still works for
  members.)

## Buying

- Tapping a product stores the `purchase` entry immediately (pending) and sends it after
  **8 seconds**. Undo within 8 s deletes it. Afterwards: fix with a negative top-up.
- **Several at once:** a double tap or a long press opens a dialog (− quantity +, Cancel /
  Book) that books one entry with a quantity. A double tap's first tap is still pending, so
  it is simply undone, single taps stay instant.
- A purchase is always valid, even if the product was deleted or repriced meanwhile.
- **Booking for someone else:** `purchase.for` names the member who pays; the author is only
  the booker (a bar station, see below) and shown as such in the log ("2 × Beer for Bob").
  The app UI has no screen for it yet; the client refuses a `for` that is not an active
  member. Trust-based like everything else: anyone can book for anyone.
- **Bar station:** a headless client (`/bot`, Node) is an ordinary member (e.g. "Bar station")
  that books for members. Its key pair lives in a file and its account is registered by hand
  (no mailbox); it is always online, which also helps syncing (see Accepted limitations).

## Screens

Tab, Chat and Group are headed by the active group's name and its online badge (counts
you too; "Offline" while not connected); Settings
has no heading.

- **Tab** (active group): balance card with a "Top up ▼" toggle (± sign button, amount and
  Save on one line, decimal keypads may lack a minus key , , quick amounts, note); a hint
  (tap = one, double tap or hold = how many) above the products; "My activity" (collapsed).
- **Chat** (active group): a very
  simple chat, messages in time order, delete own messages by long press. The
  message field (grows up to ~5 lines, Send beside it) stays at the bottom while scrolling;
  the keyboard behaves natively (no JS keyboard tracking). No read status. Not part of
  the log view or CSV export.
- **Group** (active group), top to bottom: description; "Switch group" picker (the only
  place to switch; shown with two or more groups; Tab and Chat follow it); one slim row with
  "Create a group ▼" and "Join a group ▼" (scan QR in the app or paste a link); members + balances +
  last seen; former members with open balances; collapsed: you in this group (display name),
  admin UI (group details, products, invite links), log + CSV export; leave.
  Errors show in the card whose action failed.
- **Settings:** app version, language, export/import JSON, delete account, install hint,
  legal links.
- **Notices** (top banners) only create focus: in memory, never stored, never carry data.
  They hide after 5 s unless an action is needed ("Use here", "Reload").

## Platform

- **Install first:** on a phone where the app isn't installed yet, the login screen shows
  "Install the app first" (install button on Android, steps on iOS; for invite links: install,
  then scan the QR in the app), the installed app has separate storage, so a browser login
  would not carry over. "Continue in the browser" stays possible. Browser use works, but iOS
  may evict data after 7 days without a visit (recover via email login + an invite link).
- **Layout:** app shell: a fixed full-screen frame, only the content scrolls, the menu bar is
  its last row. Opaque status bar; no `viewport-fit=cover` (WebKit bug 301108 makes installed
  iOS apps short by the status bar with it), so iOS keeps the app inside the safe areas.
- **Branding** (settings, `.env` in Docker): name, short name, primary/secondary colour,
  light/dark theme, default language, currency, quick top-up amounts, imprint/privacy links,
  own icon (`branding/icon.png`). Default look: light, red, dark grey. No theme switch in the
  app. Applied by the render step (see Settings).
- Request persistent storage (`navigator.storage.persist()`).

## Settings

- **The build holds no settings.** It leaves templates in `dist/template/` (page, service
  worker, build version, the default icon on a transparent background). The **render step**
  (`python -m app.render`, backend) reads the settings and writes `index.html` (title,
  colours, theme, `<base href>` = `BASE_PATH`), the web manifest, the icons (Pillow; the
  default mug on the primary colour, or `branding/icon.png`, square, at least 512 px),
  `config.js` (what the app reads: name, defaults, `DB_NAME`, app version), `sw.js` and,
  last, `version.json`. Always from the templates, so it can run again any time. Docker runs
  it at every container start; without Docker it runs after every deploy.
- **Path at run time:** the build uses relative paths; router, API, relay, invite links and
  the service worker (script and scope) take the app's path from `<base href>`. One build
  works under `/` and under e.g. `/tab/`.
- **Precache:** the service worker precaches `index.html`, the manifest and `config.js` with
  the revision `render:<file>`; the render step sets it to the file's MD5 (as Workbox does).
  A settings change thus changes `sw.js`, the relay asks for the new version (4005), the app
  updates its service worker and reloads with the new settings; offline it starts with the
  precached ones.
- **`DB_NAME`** (IndexedDB name, default `bardesk`): a device takes the server's value at its
  first start (also a device from before 0.9.0) and stores it (`localStorage`
  `bardesk_db_name`); from then on it always opens that database, also offline. If the
  server's value changes later, the device keeps its database and shows a notice; new
  devices use the new name.
- **Export:** plain JSON via share sheet (backup, e.g. for single-member groups).
  **Import** merges entries by `device_id` + `seq`.

## Accepted limitations

- Sync only happens while two member devices are online at the same time; balances can be
  stale. An always-open device (e.g. a bar tablet with its own email) is an optional fix.
- Unsynced entries are lost with a lost device; a single-member group is lost with its
  device unless exported.
- A removed member's earlier entries may still arrive via forwarding → open balance.
- Anyone with a group ID can see which emails are online in that room.
- A modified app can create entries in someone else's name.
- After account deletion the email remains in other members' logs.
- A deleted chat message is only hidden: its text stays in every member's log (and exports).
- No push notifications: chat messages are seen when the app is opened.
- A wrong device clock while offline produces wrong timestamps.
- A member who leaves offline and never opens the app again stays as a ghost member
  (zero balance, harmless).

## Testing

- Convergence: applying the same entries in random orders yields identical state
  (property-based tests).
- Reconciliation, encryption round-trip, relay auth and presence.

## Out of scope

Push notifications, native apps, booking for other members in the app UI (the entry supports it), deposit confirmation, log date
filter, email invites, multiple devices per account (QR key linking, later), global group
deletion, snapshots/compaction (later: a `snapshot` entry holding the state, balances,
members, products, per-field `hlc`, plus the version vector it covers; replay = latest
snapshot + all entries its vector does not cover, regardless of timestamp; covered entries
may then be deleted locally).
