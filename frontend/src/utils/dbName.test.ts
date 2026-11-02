// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_NAME_KEY, deviceDbName } from './dbName'

describe('device database name', () => {
  beforeEach(() => localStorage.clear())

  it('takes the server name at the first start, also on devices from before 0.9.0', () => {
    expect(deviceDbName('taplist')).toBe('taplist')
    expect(localStorage.getItem(DB_NAME_KEY)).toBe('taplist')
  })

  it('keeps its database when the server names another one later', () => {
    deviceDbName('taplist')
    expect(deviceDbName('bardesk')).toBe('taplist')
    expect(localStorage.getItem(DB_NAME_KEY)).toBe('taplist')
  })

  it('uses the server name when storage is blocked', () => {
    const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(deviceDbName('bardesk')).toBe('bardesk')
    blocked.mockRestore()
  })
})
