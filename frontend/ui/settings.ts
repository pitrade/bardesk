// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The settings the UI tests render the app with (render step, backend/app/render.py). All are
 * set, so a developer's backend/.env cannot change the look. The name is the default one, as
 * the branding test also takes the README screenshots.
 */
export const UI_SETTINGS: Record<string, string> = {
  BASE_PATH: '/',
  APP_NAME: 'Bardesk',
  APP_SHORT_NAME: '',
  COLOR_PRIMARY: '',
  COLOR_SECONDARY: '',
  THEME: '',
  DEFAULT_LANGUAGE: '',
  CURRENCY: '',
  TOPUP_AMOUNTS: '',
  IMPRINT_URL: 'https://example.org/imprint',
  PRIVACY_URL: '',
  DB_NAME: '',
  BRANDING_DIR: '/nonexistent', // the default icon
}
