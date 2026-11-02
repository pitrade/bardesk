// SPDX-License-Identifier: GPL-3.0-or-later
import { brand } from '../brand'
import { getLocale, intlLocale } from '../i18n'

export function formatCents(cents: number, locale = getLocale()): string {
  return (cents / 100).toLocaleString(intlLocale(locale), {
    style: 'currency',
    currency: brand.currency,
  })
}
