// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppConfig } from './brand'

/**
 * config.js of the dev server and the unit tests. Deployments get theirs from the render step
 * (backend/app/render.py), whose defaults these are.
 */
export const DEV_CONFIG: AppConfig = {
  name: 'Bardesk',
  theme: 'light',
  language: 'auto',
  currency: 'EUR',
  topupAmounts: [5, 10, 20],
  imprintUrl: '',
  privacyUrl: '',
  dbName: 'bardesk',
  version: 'dev',
}
