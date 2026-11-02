// SPDX-License-Identifier: GPL-3.0-or-later
import { getLocale, intlLocale } from '../i18n'

/** Short date + time, e.g. "13.06., 14:30". Accepts epoch ms or an ISO string. */
export function formatDateTime(value: number | string, locale = getLocale()): string {
  return new Date(value).toLocaleString(intlLocale(locale), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
