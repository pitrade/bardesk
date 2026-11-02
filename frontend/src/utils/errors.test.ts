// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/auth'
import { errorMessage } from './errors'

describe('errorMessage', () => {
  it('surfaces API error details', () => {
    expect(errorMessage(new ApiError(400, 'Invalid or expired login code'))).toBe(
      'Invalid or expired login code',
    )
  })

  it('falls back to a generic message for unknown errors', () => {
    expect(errorMessage(new TypeError('fetch failed'))).toBe('Something went wrong.')
    expect(errorMessage('boom')).toBe('Something went wrong.')
    expect(errorMessage(undefined)).toBe('Something went wrong.')
  })
})
