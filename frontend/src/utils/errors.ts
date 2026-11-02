// SPDX-License-Identifier: GPL-3.0-or-later
import { ApiError } from '../api/auth'
import { i18n } from '../i18n'

export function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : i18n.global.t('common.error.generic')
}
