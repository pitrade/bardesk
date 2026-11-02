# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this
repository: the **Security** tab → **Report a vulnerability**.

Please include what is affected, how to reproduce it and what an attacker could do. We will
answer in the report.

## What counts as a vulnerability

Bardesk is **trust-based**: it is made for groups whose members trust each other.
Permissions in the app prevent accidents, not malice (see "Security model" in the
[README](README.md) and "Accepted limitations" in [`DESIGN.md`](DESIGN.md)).

These are **vulnerabilities** (please report):

- The server or anyone outside a group can read group data (entries, balances, chat).
- Someone can log in as another account, or register a key for an email without the
  emailed code.
- Someone who is not a member can add entries to a group, or a removed member can keep
  syncing.
- The server stores or logs group data, or more personal data than documented.
- Common web problems: cross-site scripting, injection, missing rate limits on login
  codes, and similar.

These are **known and accepted** (not vulnerabilities):

- A member with a modified app can create entries in someone else's name, make themselves
  admin or change products and prices. Every entry stays in the group's log.
- Anyone with a group ID can see which emails are online in that group's room.
- After account deletion the email stays in other members' logs; a deleted chat message is
  only hidden.
- The rest of the list in DESIGN.md, "Accepted limitations".

The optional headless client's HTTP API (`bot/`) uses plain HTTP with a token and is meant
for the local network only.
