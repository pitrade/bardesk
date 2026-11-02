// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Headless UI tests (Playwright, mobile Chromium) against the built app as it is deployed:
 * built into a temp dir, settings written by the render step, served by a real backend with a
 * throwaway DB, started here, stopped afterwards. No mail server is set (SMTP_HOST empty),
 * so login codes land in the backend log, which the tests read (ui/helpers.ts).
 *
 *   npx playwright test          (or ./scripts/test.sh, suite "ui")
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { UI_SETTINGS } from './ui/settings'

const PORT = 18767

// the config is loaded again in every worker: keep one temp dir per run
process.env.UI_DIR ??= mkdtempSync(join(tmpdir(), 'bardesk-ui-'))
const dir = process.env.UI_DIR
process.env.UI_LOG = join(dir, 'backend.log')
process.env.UI_DIST = join(dir, 'dist')

export default defineConfig({
  testDir: 'ui',
  testMatch: '*.pw.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    command:
      `npx vite build --outDir ${process.env.UI_DIST} --emptyOutDir --logLevel error && cd ../backend && ` +
      `./venv/bin/python -m app.render ${process.env.UI_DIST} && ` +
      `exec ./venv/bin/uvicorn app.main:app --host 127.0.0.1 --port ${PORT} > ${process.env.UI_LOG} 2>&1`,
    env: {
      ...UI_SETTINGS,
      FRONTEND_DIR: process.env.UI_DIST,
      SMTP_HOST: '',
      DATABASE_URL: `sqlite:///${dir}/ui.db`,
      AUTH_RATE_LIMIT_PER_MINUTE: "0",
    },
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
})
