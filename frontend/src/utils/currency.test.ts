// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { formatCents } from './currency'

describe('formatCents', () => {
  describe('de locale', () => {
    it('formats cents as euro with German locale', () => {
      expect(formatCents(250, 'de')).toMatch(/2,50/)
      expect(formatCents(250, 'de')).toContain('€')
    })

    it('handles zero and negative running tabs', () => {
      expect(formatCents(0, 'de')).toMatch(/0,00/)
      expect(formatCents(-1234, 'de')).toMatch(/-12,34/)
    })

    it('groups thousands', () => {
      expect(formatCents(123456789, 'de')).toMatch(/1\.234\.567,89/)
    })
  })

  describe('en locale', () => {
    it('formats cents as euro with English locale', () => {
      expect(formatCents(250, 'en')).toMatch(/2\.50/)
      expect(formatCents(250, 'en')).toContain('€')
    })

    it('handles zero and negative running tabs', () => {
      expect(formatCents(0, 'en')).toMatch(/0\.00/)
      expect(formatCents(-1234, 'en')).toMatch(/-€?12\.34/)
    })

    it('groups thousands', () => {
      expect(formatCents(123456789, 'en')).toMatch(/1,234,567\.89/)
    })
  })
})
