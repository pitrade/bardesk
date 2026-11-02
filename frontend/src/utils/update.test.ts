// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest'
import { displayVersion, takeUpdateNote } from './update'

describe('app version', () => {
  beforeEach(() => localStorage.clear())

  it('formats the build id readably', () => {
    expect(displayVersion('3.0.0+muio6dhl')).toBe('3.0.0 (muio6dhl)')
    expect(displayVersion('dev')).toBe('dev')
  })

  it('notes an update once, but not on the very first start', () => {
    expect(takeUpdateNote('3.0.0+a')).toBeNull() // first start
    expect(takeUpdateNote('3.0.0+a')).toBeNull() // same version
    expect(takeUpdateNote('3.0.0+b')).toBe('3.0.0+b') // updated
    expect(takeUpdateNote('3.0.0+b')).toBeNull() // only once
  })
})
