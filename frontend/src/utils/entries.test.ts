// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../i18n'
import { encodeHlc } from '../core/hlc'
import { replay } from '../core/replay'
import type { Entry, EntryDataMap, EntryType } from '../core/types'
import { describeEntry, productNames, toCsv } from './entries'

const T0 = Date.UTC(2026, 5, 1, 18, 0, 0)
let seq = 0

function entry<T extends EntryType>(author: string, type: T, data: EntryDataMap[T]): Entry {
  seq += 1
  return { group: 'g', device: 'd', seq, author, type, data, hlc: encodeHlc(T0 + seq * 1000, 0), v: 1 }
}

function log(): Entry[] {
  seq = 0
  return [
    entry('alice@x.de', 'group.created', { name: 'Pub', description: '', displayname: 'Alice' }),
    entry('alice@x.de', 'member.joined', { email: 'bob@x.de', displayname: 'Bob' }),
    entry('alice@x.de', 'product.added', { id: 'p1', name: 'Beer', price: 250, sortOrder: 1 }),
    entry('bob@x.de', 'purchase', { productId: 'p1', name: 'Beer', price: 250 }),
    entry('bob@x.de', 'topup', { amount: 1000, description: 'cash' }),
    entry('bob@x.de', 'topup', { amount: -150, description: '' }),
    entry('alice@x.de', 'product.updated', { id: 'p1', name: 'Pils; "cold"' }),
    entry('alice@x.de', 'product.deleted', { id: 'p1' }),
    entry('alice@x.de', 'member.role', { email: 'bob@x.de', role: 'admin' }),
    entry('alice@x.de', 'settled', { email: 'bob@x.de', amount: -600 }),
  ]
}

describe('describeEntry', () => {
  beforeEach(() => setLocale('en'))

  it('renders money entries with amount and affected member', () => {
    const entries = log()
    const state = replay('g', entries)
    const names = productNames(entries)
    const [purchase, topup, correction] = entries.slice(3, 6).map((e) => describeEntry(e, state, names))
    expect(purchase).toMatchObject({ who: 'Bob', what: 'Beer', amount: -250, subject: 'bob@x.de' })
    expect(topup).toMatchObject({ what: 'Top-up: cash', amount: 1000 })
    expect(correction).toMatchObject({ what: 'Correction', amount: -150 })
    expect(describeEntry(entries[9], state, names)).toMatchObject({ what: 'Settled for Bob', amount: -600, subject: 'bob@x.de' })
  })

  it('shows the quantity of a purchase and charges all of it', () => {
    const entries = [...log(), entry('bob@x.de', 'purchase', { productId: 'p1', name: 'Beer', price: 250, quantity: 3 })]
    const state = replay('g', entries)
    expect(describeEntry(entries[10], state, productNames(entries))).toMatchObject({ what: '3 × Beer', amount: -750 })
    expect(state.members['bob@x.de'].balance).toBe(-250 + 1000 - 150 - 600 - 750) // older entries count 1
  })

  it('a purchase booked for another member names who it is for and charges them', () => {
    const entries = [...log(), entry('alice@x.de', 'purchase', { productId: 'p1', name: 'Beer', price: 250, quantity: 2, for: 'bob@x.de' })]
    const state = replay('g', entries)
    const names = productNames(entries)
    expect(describeEntry(entries[10], state, names)).toMatchObject({
      who: 'Alice',
      what: '2 × Beer for Bob',
      amount: -500,
      subject: 'bob@x.de',
    })
    expect(toCsv(entries, state).split('\n')[11]).toContain(';alice@x.de;purchase;2 × Beer for Bob;bob@x.de;-5.00')
  })

  it('names deleted products from the log and describes structural entries', () => {
    const entries = log()
    const state = replay('g', entries)
    const names = productNames(entries)
    expect(describeEntry(entries[7], state, names).what).toBe('Deleted Pils; "cold"')
    expect(describeEntry(entries[8], state, names).what).toBe('Made Bob an admin')
    expect(describeEntry(entries[1], state, names)).toMatchObject({ who: 'Alice', what: 'Bob joined', amount: null })
    expect(describeEntry(entries[3], state, names).time).toBe(T0 + 4000)
  })

  it('follows the UI language', () => {
    setLocale('de')
    const entries = log()
    const state = replay('g', entries)
    expect(describeEntry(entries[5], state, productNames(entries)).what).toBe('Korrektur')
  })
})

describe('toCsv', () => {
  beforeEach(() => setLocale('en'))

  it('has a header, one row per entry, euro amounts and escaped cells', () => {
    const entries = log()
    const lines = toCsv(entries, replay('g', entries)).split('\n')
    expect(lines[0]).toBe('time;author;type;description;member;amount_eur')
    expect(lines).toHaveLength(entries.length + 1)
    expect(lines[4]).toBe(`${new Date(T0 + 4000).toISOString()};bob@x.de;purchase;Beer;bob@x.de;-2.50`)
    expect(lines[7]).toContain(';"Changed Pils; ""cold""";') // ; and " are quoted
    expect(lines[1].endsWith(';;')).toBe(true) // no member, no amount
  })
})
