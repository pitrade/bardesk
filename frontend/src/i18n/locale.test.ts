// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { detectLocale, intlLocale, toLocale } from './locale'
import de from './de'
import en from './en'

describe('detectLocale', () => {
  it('maps German browser languages to de', () => {
    expect(detectLocale('de')).toBe('de')
    expect(detectLocale('de-DE')).toBe('de')
    expect(detectLocale('de-AT')).toBe('de')
  })

  it('falls back to en for any non-German language', () => {
    expect(detectLocale('en')).toBe('en')
    expect(detectLocale('en-US')).toBe('en')
    expect(detectLocale('fr-FR')).toBe('en')
    expect(detectLocale(undefined)).toBe('en')
  })
})

describe('toLocale', () => {
  it('accepts de and en, defaults everything else to en', () => {
    expect(toLocale('de')).toBe('de')
    expect(toLocale('en')).toBe('en')
    expect(toLocale('fr')).toBe('en')
    expect(toLocale(null)).toBe('en')
    expect(toLocale(undefined)).toBe('en')
  })
})

describe('intlLocale', () => {
  it('maps app locales to Intl locale tags', () => {
    expect(intlLocale('de')).toBe('de-DE')
    expect(intlLocale('en')).toBe('en-US')
  })
})

describe('locale catalogs', () => {
  function keys(obj: object, prefix = ''): string[] {
    return Object.entries(obj).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key
      return typeof value === 'object' && value !== null ? keys(value, path) : [path]
    })
  }

  it('en and de have identical key sets', () => {
    expect(keys(de).sort()).toEqual(keys(en).sort())
  })
})
