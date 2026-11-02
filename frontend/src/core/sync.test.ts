// @vitest-environment node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Multi-device scenarios on an in-memory relay: real crypto, fake IndexedDB,
 * controllable clock. Each device is a full TapClient.
 */
import 'fake-indexeddb/auto' // before anything loads Dexie
import { afterEach, describe, expect, it } from 'vitest'
import { INVITE_LIFETIME_MS, type TapClient } from './client'
import { generateKeyPair } from './crypto'
import { hlcMs } from './hlc'
import { TapDb } from './db'
import { formerWithOpenBalance, replay } from './replay'
import { World, buy, groupWith, product } from './testing/harness'

let world: World

afterEach(() => {
  expect(world.errors()).toEqual([])
  world.devices.forEach((d) => d.close())
})

function state(client: TapClient, groupId: string) {
  return client.groups.get(groupId)!.model.state
}

function balance(client: TapClient, groupId: string, email: string): number {
  return state(client, groupId).members[email]?.balance ?? 0
}

function expectConverged(groupId: string, clients: TapClient[]): void {
  const [first, ...rest] = clients.map((c) => JSON.stringify(state(c, groupId)))
  for (const other of rest) expect(other).toBe(first)
}

describe('joining', () => {
  it('a member joins via invite while the admin is online', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])

    expect(bob.group(g)).toBeDefined()
    expect(state(bob, g).members['bob@x.de']).toMatchObject({ status: 'active', role: 'member', displayname: 'bob' })
    expect(bob.activeGroupId).toBe(g)
    expectConverged(g, [alice, bob])
  })

  it('any member can admit a new member, no admin needs to be online', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])
    const invite = await alice.createInvite(g, false)
    await world.settle()
    world.offline(alice)

    const carol = await world.device('carol@x.de')
    await carol.joinGroup(g, (invite.data as { token: string }).token, 'Carol')
    await world.settle()
    expect(carol.group(g)).toBeDefined()

    await world.online(alice)
    expectConverged(g, [alice, bob, carol])
    expect(state(alice, g).members['carol@x.de'].displayname).toBe('Carol')
  })

  it('a joiner waits until a member comes online', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const g = await groupWith(world, alice)
    const token = ((await alice.createInvite(g, false)).data as { token: string }).token
    world.offline(alice)

    const bob = await world.device('bob@x.de')
    await bob.joinGroup(g, token, 'Bob')
    await world.settle()
    expect(bob.joiningGroups().map((j) => j.local.id)).toEqual([g])

    await world.online(alice)
    expect(bob.group(g)).toBeDefined()
  })

  it('single-use invites work once, multi-use ones repeatedly', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const g = await groupWith(world, alice)
    const single = ((await alice.createInvite(g, false)).data as { token: string }).token
    const multi = ((await alice.createInvite(g, true)).data as { token: string }).token
    const [bob, carol, dave, erin] = await Promise.all(
      ['bob@x.de', 'carol@x.de', 'dave@x.de', 'erin@x.de'].map((e) => world.device(e)),
    )

    await bob.joinGroup(g, single, 'Bob')
    await world.settle()
    await carol.joinGroup(g, single, 'Carol')
    await world.settle()
    expect(bob.group(g)).toBeDefined()
    expect(carol.group(g)).toBeUndefined()
    expect(carol.joinErrors.get(g)).toBe('used')

    await dave.joinGroup(g, multi, 'Dave')
    await world.settle()
    await erin.joinGroup(g, multi, 'Erin')
    await world.settle()
    expect(dave.group(g) && erin.group(g)).toBeDefined()
  })

  it('rejects expired, revoked and unknown invites', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const g = await groupWith(world, alice)
    const expired = ((await alice.createInvite(g, false)).data as { token: string }).token
    world.clock.advance(25 * 60 * 60 * 1000)
    const revoked = ((await alice.createInvite(g, false)).data as { token: string }).token
    await alice.revokeInvite(g, revoked)

    const cases: [string | undefined, string][] = [
      [expired, 'expired'],
      [revoked, 'revoked'],
      ['made-up', 'invalid'],
      [undefined, 'not_member'],
    ]
    for (const [token, reason] of cases) {
      const stranger = await world.device(`s${reason}@x.de`)
      await stranger.joinGroup(g, token, 'S')
      await world.settle()
      expect(stranger.joinErrors.get(g)).toBe(reason)
    }
  })

  it('a member on a new device gets everything back via the plain group link', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])
    await buy(bob, g, 'Beer')
    await world.settle()
    world.offline(bob) // phone lost

    const bobNew = await world.device('bob@x.de') // new storage, new key
    await bobNew.joinGroup(g) // no token
    await world.settle()
    expect(bobNew.group(g)).toBeDefined()
    expect(bobNew.balance(g)).toBe(-300)

    await buy(bobNew, g, 'Cola')
    await world.settle()
    expect(balance(alice, g, 'bob@x.de')).toBe(-500)
  })
})

describe('offline sync', () => {
  it('purchases made offline arrive when the device is back online', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])

    world.offline(bob)
    await buy(bob, g, 'Beer')
    await buy(bob, g, 'Beer')
    await alice.updateProduct(g, product(alice, g, 'Beer').id, { price: 350 })
    expect(balance(alice, g, 'bob@x.de')).toBe(0)

    await world.online(bob)
    expect(balance(alice, g, 'bob@x.de')).toBe(-600) // price at purchase time
    expect(product(bob, g, 'Beer').price).toBe(350)
    expectConverged(g, [alice, bob])
  })

  it('entries travel via a third device (forwarding)', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const carol = await world.device('carol@x.de')
    const g = await groupWith(world, alice, [bob, carol])

    world.offline(carol)
    await buy(bob, g, 'Beer')
    await world.settle()
    world.offline(bob)

    await world.online(carol) // bob is gone, alice forwards bob's entry
    expect(balance(carol, g, 'bob@x.de')).toBe(-300)
    expectConverged(g, [alice, carol])
  })

  it('concurrent edits: the later one wins everywhere', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])
    await alice.setRole(g, 'bob@x.de', 'admin')
    await world.settle()

    world.offline(alice)
    world.offline(bob)
    const beer = product(alice, g, 'Beer').id
    await alice.updateProduct(g, beer, { name: 'Pils' })
    world.clock.advance(1000)
    await bob.updateProduct(g, beer, { name: 'Lager' })

    await world.online(alice)
    await world.online(bob)
    expect(product(alice, g, 'Lager')).toBeDefined()
    expectConverged(g, [alice, bob])
  })

  it('random offline activity always converges', async () => {
    world = new World()
    const [alice, bob, carol] = await Promise.all(['alice@x.de', 'bob@x.de', 'carol@x.de'].map((e) => world.device(e)))
    const g = await groupWith(world, alice, [bob, carol])
    await alice.setRole(g, 'carol@x.de', 'admin')
    await world.settle()
    const devices = [alice, bob, carol]

    let seed = 7
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let round = 0; round < 30; round++) {
      const device = devices[random(3)]
      const action = random(6)
      if (action === 0) world.offline(device)
      else if (action === 1) await world.online(device)
      else if (action === 2) await buy(device, g, random(2) ? 'Beer' : 'Cola')
      else if (action === 3) await device.topup(g, (random(5) + 1) * 500)
      else if (action === 4 && device !== bob) await device.updateProduct(g, product(device, g, 'Cola').id, { price: 100 + random(300) })
      else await device.setDisplayName(g, `name-${round}`)
      world.clock.advance(random(3000))
    }
    for (const device of devices) await world.online(device)
    await world.settle()

    expectConverged(g, devices)
    const total = Object.values(state(alice, g).members).reduce((sum, m) => sum + m.balance, 0)
    const entries = alice.groups.get(g)!.model.entries
    const expected = entries.reduce(
      (sum, e) => sum + (e.type === 'topup' ? (e.data as { amount: number }).amount : e.type === 'purchase' ? -(e.data as { price: number }).price : 0),
      0,
    )
    expect(total).toBe(expected)
  })
})

describe('buying', () => {
  it('undo within the window leaves no trace', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])

    const pendingId = await bob.purchase(g, product(bob, g, 'Beer'))
    expect(bob.balance(g)).toBe(-300) // shown immediately
    await bob.undo(pendingId)
    await bob.flushPending()
    await world.settle()
    expect(bob.balance(g)).toBe(0)
    expect(bob.groups.get(g)!.model.entries.some((e) => e.type === 'purchase')).toBe(false)
    expectConverged(g, [alice, bob])
  })

  it('a member can book for another member, who pays; unknown members are refused', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])

    const pendingId = await alice.purchase(g, product(alice, g, 'Beer'), 3, 'bob@x.de')
    expect(alice.balance(g)).toBe(0) // not mine
    await alice.flushPending()
    await world.settle()
    expect(balance(alice, g, 'bob@x.de')).toBe(-900)
    expect(balance(alice, g, 'alice@x.de')).toBe(0)
    expect(bob.balance(g)).toBe(-900)
    expect(await alice.undo(pendingId)).toBe(false) // already committed
    await expect(alice.purchase(g, product(alice, g, 'Beer'), 1, 'nobody@x.de')).rejects.toThrow('Unknown member')
    expectConverged(g, [alice, bob])
  })

  it('a pending purchase survives an app restart', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const g = await groupWith(world, alice)
    await alice.purchase(g, product(alice, g, 'Beer'))

    const restarted = await world.restart(alice)
    expect(restarted.balance(g)).toBe(-300)
    await restarted.flushPending()
    expect(balance(restarted, g, 'alice@x.de')).toBe(-300)
    // seq continues without gaps after the restart
    expect(restarted.groups.get(g)!.model.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })
})

describe('leaving and removal', () => {
  it('leaving offline: the outbox delivers the leave entry later, then the group is gone', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])

    world.offline(bob)
    await bob.leaveGroup(g)
    expect(bob.group(g)).toBeUndefined() // hidden right away
    expect(bob.groups.has(g)).toBe(true) // outbox still there

    await world.online(bob)
    expect(state(alice, g).members['bob@x.de'].status).toBe('left')
    expect(bob.groups.has(g)).toBe(false)
  })

  it('the last member leaving deletes the group immediately', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const g = await groupWith(world, alice)
    await alice.leaveGroup(g)
    expect(alice.groups.has(g)).toBe(false)
    expect(alice.activeGroupId).toBeNull()
  })

  it('a removed member cannot sync and is told so', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])

    world.offline(bob)
    await alice.removeMember(g, 'bob@x.de')
    await buy(bob, g, 'Beer') // after the removal, offline

    await world.online(bob)
    expect(balance(alice, g, 'bob@x.de')).toBe(0) // rejected
    expect(bob.groups.has(g)).toBe(false)
    expect(bob.notice).toMatchObject({ kind: 'removed', group: g })
  })

  it('a member who is online while being removed is told right away', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])

    await alice.removeMember(g, 'bob@x.de')
    await world.settle()
    expect(bob.groups.has(g)).toBe(false)
    expect(bob.notice).toMatchObject({ kind: 'removed', group: g })
  })

  it("Ben's case: a purchase from before the removal arrives via another member", async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const ben = await world.device('ben@x.de')
    const carol = await world.device('carol@x.de')
    const g = await groupWith(world, alice, [ben, carol])

    world.offline(alice)
    await buy(ben, g, 'Beer') // syncs to carol only
    await world.settle()
    world.offline(ben)
    world.offline(carol)
    await world.online(alice)
    await alice.removeMember(g, 'ben@x.de') // alice doesn't know about the beer

    await world.online(carol) // carol forwards ben's beer
    expect(formerWithOpenBalance(state(alice, g)).map((m) => [m.email, m.balance])).toEqual([['ben@x.de', -300]])

    await alice.settle(g, 'ben@x.de')
    await world.settle()
    expect(formerWithOpenBalance(state(carol, g))).toEqual([])
  })

  it('any member can make themselves admin (dead-admin escape hatch)', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])
    world.offline(alice)
    await bob.setRole(g, 'bob@x.de', 'admin')
    expect(state(bob, g).members['bob@x.de'].role).toBe('admin')
  })
})

describe('account', () => {
  it('export and import restore a single-member group on a new device', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const g = await groupWith(world, alice)
    await buy(alice, g, 'Beer')
    const file = JSON.parse(JSON.stringify(alice.exportData()))
    world.offline(alice)

    const fresh = await world.device('alice@x.de')
    expect(await fresh.importData(file)).toBe(file.groups[0].entries.length)
    expect(fresh.balance(g)).toBe(-300)
    await buy(fresh, g, 'Cola')
    expect(fresh.balance(g)).toBe(-500)
  })

  it('deleting the account is only possible after leaving all groups', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const g = await groupWith(world, alice)
    expect(() => alice.deleteAccount()).toThrow()
    await alice.leaveGroup(g)
    alice.deleteAccount()
    await world.settle()
    expect(alice.notice).toEqual({ kind: 'deleted' })
    expect(alice.identity).toBeNull()
  })
})

describe('chat', () => {
  it('messages sync (also when sent offline) and own messages can be deleted', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])

    await alice.sendMessage(g, '  Hello!  ')
    world.offline(bob)
    await bob.sendMessage(g, 'written offline')
    await world.online(bob)

    expect(state(bob, g).messages.map((m) => m.text)).toEqual(['Hello!', 'written offline'])
    expectConverged(g, [alice, bob])

    const id = state(bob, g).messages[1].id
    await bob.deleteMessage(g, id)
    await world.settle()
    expect(state(alice, g).messages.map((m) => m.text)).toEqual(['Hello!'])
    await expect(bob.sendMessage(g, '   ')).rejects.toThrow()
  })
})

describe('clock', () => {
  it('corrects the device clock with the server time from login', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const serverTime = world.clock.ms + 60 * 60 * 1000 // device clock is an hour behind
    await alice.setIdentity('alice@x.de', await generateKeyPair(), serverTime)
    expect(alice.now()).toBe(serverTime)

    const g = await alice.createGroup('Pub', '', 'Alice')
    const invite = await alice.createInvite(g, false)
    expect((invite.data as { expiresAt: number }).expiresAt).toBe(serverTime + INVITE_LIFETIME_MS)
    expect(hlcMs(invite.hlc)).toBe(serverTime)
  })
})

describe('state cache', () => {
  const dbOf = (client: TapClient) => new TapDb((client as unknown as { dbName: string }).dbName)

  it('after a restart the saved state is used instead of replaying', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const g = await groupWith(world, alice)
    await buy(alice, g, 'Beer')

    const db = dbOf(alice)
    const cached = (await db.states.get(g))!
    expect(cached.count).toBe(alice.groups.get(g)!.model.entries.length)
    await db.states.put({ ...cached, state: { ...cached.state, name: 'FROM CACHE' } })
    db.close()

    const restarted = await world.restart(alice)
    expect(state(restarted, g).name).toBe('FROM CACHE')
  })

  it.each([
    ['count', { count: 1 }],
    ['app version', { version: 'older-build' }],
  ])('a different %s forces one replay', async (_what, change) => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const g = await groupWith(world, alice)

    const db = dbOf(alice)
    const cached = (await db.states.get(g))!
    await db.states.put({ ...cached, ...change, state: { ...cached.state, name: 'STALE' } })
    db.close()

    const restarted = await world.restart(alice)
    expect(state(restarted, g).name).toBe('Pub')
    const db2 = dbOf(restarted)
    expect((await db2.states.get(g))!.state.name).toBe('Pub') // saved fresh
    db2.close()
  })

  it('the saved state always equals a full replay (own, synced and imported entries)', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const bob = await world.device('bob@x.de')
    const g = await groupWith(world, alice, [bob])
    world.offline(bob)
    await buy(bob, g, 'Beer') // late entry, older than alice's next ones
    await alice.updateProduct(g, product(alice, g, 'Beer').id, { price: 400 })
    await alice.sendMessage(g, 'hi')
    await world.online(bob)

    for (const client of [alice, bob]) {
      const db = dbOf(client)
      const cached = (await db.states.get(g))!
      const entries = await db.entries.where('group').equals(g).toArray()
      expect(cached.count).toBe(entries.length)
      expect(JSON.stringify(cached.state)).toBe(JSON.stringify(replay(g, entries)))
      db.close()
    }
  })
})
