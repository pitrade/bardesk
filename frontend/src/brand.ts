// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Settings of this installation. The server's render step (backend/app/render.py) writes
 * them into config.js, which index.html loads before the app.
 */
export interface AppConfig {
  name: string
  theme: 'light' | 'dark'
  language: 'de' | 'en' | 'auto'
  currency: string
  topupAmounts: number[]
  imprintUrl: string
  privacyUrl: string
  /** IndexedDB name for a device's first start (see utils/dbName.ts) */
  dbName: string
  /** build version + hash of the settings: the relay lets only this version sync */
  version: string
}

declare global {
  var BARDESK_CONFIG: AppConfig | undefined
}

const config = globalThis.BARDESK_CONFIG
if (!config) throw new Error('config.js is missing: run the render step (python -m app.render)')

export const brand: AppConfig = config
