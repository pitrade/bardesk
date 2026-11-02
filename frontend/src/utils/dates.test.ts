// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { formatDateTime } from './dates'

const iso = '2026-06-13T14:30:00Z'

describe('formatDateTime', () => {
  it('formats with German locale (DD.MM., HH:MM)', () => {
    expect(formatDateTime(iso, 'de')).toMatch(/13\.06\./)
  })

  it('formats with English locale (MM/DD, h:MM AM/PM)', () => {
    expect(formatDateTime(iso, 'en')).toMatch(/06\/13/)
  })
})
