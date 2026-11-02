# Contributing

Thank you for helping. Bug reports, fixes, tests and documentation are welcome. For a
larger change or a new feature, please open an issue first, so we can agree on it before
you spend time on it.

Read [`DESIGN.md`](DESIGN.md) before changing behaviour (it is the source of truth for the
design) and [`AGENTS.md`](AGENTS.md) for the code map.

## Setup

You need Python 3.12 or newer and Node.js 24.

```bash
cd backend
python3 -m venv venv
./venv/bin/pip install -r requirements.txt -r requirements-dev.txt

cd ../frontend
npm ci
npx playwright install --with-deps --only-shell chromium   # browser for the UI tests
```

Run it for development (two terminals):

```bash
cd backend && ./venv/bin/uvicorn app.main:app --port 8000   # no SMTP_HOST: login codes in this log
cd frontend && npx vite --port 5173
```

Open <http://localhost:5173>. The dev server serves `config.js` with the default settings
(`src/devConfig.ts`); deployments get theirs from the render step (`python -m app.render`). `http://127.0.0.1:5173` is a second device (separate
storage), so you can try syncing with a second account.

## Tests

```bash
./scripts/test.sh        # all suites, one line each; -v for the full output
```

It runs the backend tests (pytest), the frontend and core tests (Vitest), end-to-end tests
against a real server, the UI tests (Playwright, headless) and the type-checked build. All
must pass. CI runs the same script.

`./scripts/test-docker.sh` tests the Docker image (needs Docker, not part of `test.sh`).

Add a headless test for every change in behaviour. UI checks go into `frontend/ui/*.pw.ts`.

## Rules

- Minimal, best-practice code. No workaround code: find the cause from evidence (research,
  measurements). If a platform bug only has workarounds, describe it in the issue or pull
  request and let the maintainer decide.
- Keep the German and English texts in `frontend/src/i18n/` in step (a test checks that the
  keys match).
- New source files start with `SPDX-License-Identifier: GPL-3.0-or-later` in a comment.
- The version stays 0.x.x until the maintainer declares 1.0.0.

## Commits

- One topic per commit; a short subject in the imperative ("Fix …", "Add …"), a body that
  says why.
- If an AI tool wrote or changed part of the commit, say so in a trailer, for example:

  ```
  Assisted-by: Claude Opus 5.5
  ```

  Do not use `Co-authored-by` for AI tools; it is for human co-authors. You stay
  responsible for the change and must be able to explain it. See [`AI.md`](AI.md).
- By contributing you agree that your contribution is licensed under the
  [GPL-3.0-or-later](LICENSE).
