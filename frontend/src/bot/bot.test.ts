// @vitest-environment node
// SPDX-License-Identifier: GPL-3.0-or-later
import 'fake-indexeddb/auto' // before anything loads Dexie
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportPublicKey } from '../core/crypto'
import { World, groupWith, product } from '../core/testing/harness'
import { startBot, type Bot } from './bot'
import { createIdentity, loadIdentity } from './identity'

const EMAIL = 'station@bot.invalid'
let dir: string
let world: World

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bot-'))
})

afterEach(async () => {
  expect(world.errors()).toEqual([])
  world.devices.forEach((d) => d.close())
  await rm(dir, { recursive: true, force: true })
})

describe('identity', () => {
  it('is kept in a file: the same key comes back, and an existing key is never overwritten', async () => {
    world = new World()
    const publicKey = await createIdentity(dir, 'Station@Bot.invalid')
    const loaded = await loadIdentity(dir)
    expect(loaded.email).toBe(EMAIL)
    expect(await exportPublicKey(loaded.keyPair.publicKey)).toBe(publicKey)
    expect(loaded.keyPair.privateKey.extractable).toBe(false)
    expect(JSON.parse(await readFile(join(dir, 'identity.json'), 'utf8')).deviceId).toBe(loaded.deviceId)
    await expect(createIdentity(dir, EMAIL)).rejects.toThrow(/EEXIST/)
  })
})

describe('bot', () => {
  async function start(link?: string, displayName = 'Bar station'): Promise<Bot> {
    const bot = await startBot({
      dir,
      connect: world.hub.connector,
      displayName,
      joinLink: link,
      now: world.clock.now,
      schedule: () => () => {},
    })
    world.devices.push(bot.client)
    await world.settle()
    return bot
  }

  async function stop(bot: Bot): Promise<void> {
    await bot.stop()
    world.devices = world.devices.filter((d) => d !== bot.client)
  }

  it('joins by invite like any member, books for a member, and continues after a restart', async () => {
    world = new World()
    const alice = await world.device('alice@x.de')
    const g = await groupWith(world, alice)
    await createIdentity(dir, EMAIL)
    const token = ((await alice.createInvite(g, false)).data as { token: string }).token
    const link = `https://example.org/tab/join/${g}?t=${token}`

    let bot = await start(link)
    const members = alice.groups.get(g)!.model.state.members
    expect(members[EMAIL]).toMatchObject({ displayname: 'Bar station', status: 'active', balance: 0 })
    expect(Object.keys(bot.client.groups.get(g)!.model.state.products)).toHaveLength(2)

    await bot.client.purchase(g, product(bot.client, g, 'Beer'), 2, 'alice@x.de')
    await bot.client.flushPending()
    await world.settle()
    expect(alice.groups.get(g)!.model.state.members['alice@x.de'].balance).toBe(-600)
    expect(members[EMAIL].balance).toBe(0)

    await stop(bot) // saves the log
    bot = await start() // no link needed any more: the group comes from the snapshot
    expect(bot.client.visibleGroups().map((x) => x.local.id)).toEqual([g])
    await bot.client.purchase(g, product(bot.client, g, 'Cola'), 1, 'alice@x.de')
    await bot.client.flushPending()
    await world.settle()
    expect(alice.groups.get(g)!.model.state.members['alice@x.de'].balance).toBe(-800)
    const seqs = bot.client.groups.get(g)!.model.entries.filter((e) => e.device === bot.client.deviceId).map((e) => e.seq)
    expect(seqs).toEqual([1, 2]) // numbering continues, no clash

    await stop(bot)
    bot = await start(undefined, 'Bar station 2') // a changed name reaches the group
    expect(alice.groups.get(g)!.model.state.members[EMAIL].displayname).toBe('Bar station 2')
  })
})
