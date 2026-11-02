// SPDX-License-Identifier: GPL-3.0-or-later
import { createI18n } from 'vue-i18n'
import de from './de'
import en from './en'
import { getInitialLocale, persistLocale, type Locale } from './locale'

export const i18n = createI18n({
  legacy: false,
  locale: getInitialLocale(),
  fallbackLocale: 'en',
  messages: { en, de },
})

/** Switch the active UI locale and persist the choice. */
export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale
  persistLocale(locale)
}

export function getLocale(): Locale {
  return i18n.global.locale.value as Locale
}

export { detectLocale, getInitialLocale, intlLocale, toLocale, type Locale } from './locale'
