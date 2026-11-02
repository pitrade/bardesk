// @vitest-environment node
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { GroupModel } from './group'
import { encodeHlc } from './hlc'
import { formerWithOpenBalance, replay } from './replay'
import type { Entry, EntryDataMap, EntryType } from './types'

const G = 'group-1'
const seqs: Record<string, number> = {}

function entry<T extends EntryType>(device: string, ms: number, author: string, type: T, data: EntryDataMap[T]): Entry {
  seqs[device] = (seqs[device] ?? 0) + 1
  return { group: G, device, seq: seqs[device], author, type, data, hlc: encodeHlc(ms, 0), v: 1 }
}

function baseLog(): Entry[] {
  for (const key of Object.keys(seqs)) delete seqs[key]
  return [
    entry('A', 1, 'alice', 'group.created', { name: 'Pub', description: '', displayname: 'Alice' }),
    entry('A', 2, 'alice', 'invite.created', { token: 't1', expiresAt: 99, multiUse: false }),
    entry('A', 3, 'alice', 'member.joined', { email: 'bob', displayname: 'Bob', token: 't1' }),
    entry('A', 4, 'alice', 'product.added', { id: 'p1', name: 'Beer', price: 300, sortOrder: 1 }),
    entry('B', 5, 'bob', 'topup', { amount: 1000, description: '' }),
    entry('B', 6, 'bob', 'purchase', { productId: 'p1', name: 'Beer', price: 300 }),
    entry('A', 7, 'alice', 'product.updated', { id: 'p1', name: 'Pils' }),
    entry('B', 8, 'bob', 'purchase', { productId: 'p1', name: 'Pils', price: 300 }),
    entry('A', 9, 'alice', 'product.updated', { id: 'p1', price: 350 }),
    entry('B', 10, 'bob', 'member.renamed', { displayname: 'Bobby' }),
  ]
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

describe('replay', () => {
  it('derives members, products, invites and balances', () => {
    const state = replay(G, baseLog())
    expect(state.name).toBe('Pub')
    expect(state.members.alice).toMatchObject({ role: 'admin', status: 'active', balance: 0 })
    expect(state.members.bob).toMatchObject({ role: 'member', displayname: 'Bobby', balance: 400 })
    expect(state.products.p1).toMatchObject({ name: 'Pils', price: 350 })
    expect(state.invites.t1.usedCount).toBe(1)
    expect(state.members.bob.lastSeen).toBe(encodeHlc(10, 0))
  })

  it('is independent of arrival order', () => {
    const expected = JSON.stringify(replay(G, baseLog()))
    for (let seed = 1; seed <= 50; seed++) {
      expect(JSON.stringify(replay(G, shuffled(baseLog(), seed)))).toBe(expected)
    }
  })

  it('incremental accept gives the same state as a full replay', () => {
    const log = baseLog()
    const expected = JSON.stringify(replay(G, log))
    for (let seed = 1; seed <= 20; seed++) {
      const model = new GroupModel(G)
      // deliver per device in order, but interleave devices randomly
      const byDevice = { A: log.filter((e) => e.device === 'A'), B: log.filter((e) => e.device === 'B') }
      for (const device of shuffled([...byDevice.A.map(() => 'A'), ...byDevice.B.map(() => 'B')], seed)) {
        model.accept([byDevice[device as 'A' | 'B'].shift()!])
      }
      expect(JSON.stringify(model.state)).toBe(expected)
    }
  })

  it('later edits win, deletion is final', () => {
    const log = baseLog()
    log.push(entry('A', 11, 'alice', 'product.deleted', { id: 'p1' }))
    log.push(entry('B', 12, 'bob', 'product.updated', { id: 'p1', name: 'Zombie' }))
    log.push(entry('B', 13, 'bob', 'product.added', { id: 'p1', name: 'Zombie', price: 1, sortOrder: 1 }))
    const state = replay(G, log)
    expect(state.products.p1).toBeUndefined()
  })

  it('a purchase is valid even after the product was deleted', () => {
    const log = baseLog()
    log.push(entry('A', 11, 'alice', 'product.deleted', { id: 'p1' }))
    log.push(entry('B', 12, 'bob', 'purchase', { productId: 'p1', name: 'Pils', price: 300 }))
    expect(replay(G, log).members.bob.balance).toBe(100)
  })

  it('a purchase booked for another member charges that member, not the author', () => {
    const log = baseLog() // bob: 1000 - 300 - 300 = 400
    log.push(entry('A', 11, 'alice', 'purchase', { productId: 'p1', name: 'Pils', price: 350, quantity: 2, for: 'bob' }))
    const state = replay(G, log)
    expect(state.members.bob.balance).toBe(400 - 700)
    expect(state.members.alice.balance).toBe(0)
    expect(state.members.bob.lastSeen).toBe(encodeHlc(10, 0)) // booking for him is not him being active
  })

  it('lists removed members with open balances until settled', () => {
    const log = baseLog()
    log.push(entry('A', 11, 'alice', 'member.removed', { email: 'bob' }))
    let state = replay(G, log)
    expect(formerWithOpenBalance(state).map((m) => m.email)).toEqual(['bob'])
    log.push(entry('A', 12, 'alice', 'settled', { email: 'bob', amount: -400 }))
    state = replay(G, log)
    expect(formerWithOpenBalance(state)).toEqual([])
  })

  it('skips unknown entry types from newer app versions', () => {
    const log = baseLog()
    log.push({ ...entry('A', 11, 'alice', 'topup', { amount: 1, description: '' }), type: 'future.thing' as EntryType })
    expect(JSON.stringify(replay(G, log).members.alice)).toContain('"balance":0')
  })

  it('ties on the timestamp are broken by device and seq', () => {
    const log = baseLog()
    const a = { ...entry('A', 20, 'alice', 'group.updated', { name: 'From A' }) }
    const b = { ...entry('B', 20, 'bob', 'group.updated', { name: 'From B' }) }
    expect(replay(G, [...log, a, b]).name).toBe('From B')
    expect(replay(G, [...log, b, a]).name).toBe('From B')
  })
})

describe('chat', () => {
  it('keeps messages in time order; only the author can delete one', () => {
    const log = baseLog()
    log.push(entry('B', 12, 'bob', 'chat.message', { id: 'm2', text: 'second' }))
    log.push(entry('A', 11, 'alice', 'chat.message', { id: 'm1', text: 'first' }))
    log.push(entry('A', 13, 'alice', 'chat.deleted', { id: 'm2' })) // not alice's: ignored
    let state = replay(G, log)
    expect(state.messages.map((m) => m.text)).toEqual(['first', 'second'])

    log.push(entry('B', 14, 'bob', 'chat.deleted', { id: 'm2' }))
    state = replay(G, log)
    expect(state.messages.map((m) => [m.author, m.text])).toEqual([['alice', 'first']])
  })
})

describe('GroupModel.accept', () => {
  it('accepts entries per device strictly in order', () => {
    const log = baseLog()
    const model = new GroupModel(G)
    const aEntries = log.filter((e) => e.device === 'A')
    const result = model.accept([aEntries[1]])
    expect(result).toEqual({ accepted: [], gap: true })
    model.accept([aEntries[0], aEntries[1]])
    expect(model.vector).toEqual({ A: 2 })
    expect(model.accept([aEntries[0]]).accepted).toEqual([]) // duplicate
  })

  it('missingFor returns exactly what the other side lacks', () => {
    const model = new GroupModel(G, baseLog())
    expect(model.missingFor({ A: 5, B: 2 }).map((e) => `${e.device}${e.seq}`)).toEqual(['A6', 'B3', 'B4'])
    expect(model.missingFor({}).length).toBe(10)
  })
})
