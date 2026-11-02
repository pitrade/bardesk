// SPDX-License-Identifier: GPL-3.0-or-later
import { brand } from '../brand'

export type Locale = 'de' | 'en'

export const STORAGE_KEY = 'bardesk_language'

/** navigator.language starts with 'de' -> 'de', else 'en'. */
export function detectLocale(navigatorLanguage: string | undefined): Locale {
  return navigatorLanguage?.toLowerCase().startsWith('de') ? 'de' : 'en'
}

/** Map an app locale to a JS Intl locale tag for number/date/currency formatting. */
export function intlLocale(locale: Locale): string {
  return locale === 'de' ? 'de-DE' : 'en-US'
}

/** Validate an arbitrary string as a supported locale, defaulting to 'en'. */
export function toLocale(value: string | null | undefined): Locale {
  return value === 'de' ? 'de' : 'en'
}

/** The device's choice, else the installation's default language, else the browser's. */
export function getInitialLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'de' || stored === 'en') return stored
  if (brand.language !== 'auto') return brand.language
  return detectLocale(typeof navigator !== 'undefined' ? navigator.language : undefined)
}

export function persistLocale(locale: Locale): void {
  localStorage.setItem(STORAGE_KEY, locale)
}
