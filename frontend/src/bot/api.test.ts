// @vitest-environment node
// SPDX-License-Identifier: GPL-3.0-or-later
import 'fake-indexeddb/auto' // before anything loads Dexie
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { World, groupWith } from '../core/testing/harness'
import { startApi } from './api'
import { startBot, type Bot } from './bot'
import { createIdentity } from './identity'

const TOKEN = 'secret-token'
let dir: string
let world: World
let bot: Bot
let server: Server
let base: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bot-api-'))
  world = new World()
  const alice = await world.device('alice@x.de')
  const bob = await world.device('bob@x.de')
  const g = await groupWith(world, alice, [bob]) // Beer 300, Cola 200
  await bob.topup(g, 1000)
  await createIdentity(dir, 'bot')
  const token = ((await alice.createInvite(g, false)).data as { token: string }).token
  bot = await startBot({
    dir,
    connect: world.hub.connector,
    displayName: 'Bar station',
    joinLink: `https://x/tab/join/${g}?t=${token}`,
    now: world.clock.now,
    schedule: () => () => {},
  })
  world.devices.push(bot.client)
  await world.settle()
  server = await startApi({ client: bot.client, token: TOKEN, port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  expect(world.errors()).toEqual([])
  await new Promise((resolve) => server.close(resolve))
  world.devices.forEach((d) => d.close())
  await rm(dir, { recursive: true, force: true })
})

async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const balanceOf = (email: string) => world.devices[0].groups.values().next().value!.model.state.members[email].balance

describe('bar station API', () => {
  it('needs the token', async () => {
    expect((await call('GET', '/members', undefined, null)).status).toBe(401)
    expect((await call('GET', '/members', undefined, 'wrong')).status).toBe(401)
    expect((await call('POST', '/book', { member: 'bob@x.de', product: 'x', quantity: 1 }, 'wrong')).status).toBe(401)
  })

  it('lists members (without the station itself) and products with prices', async () => {
    const members = await call('GET', '/members')
    expect(members.body).toEqual([
      { email: 'alice@x.de', name: 'alice', balance: 0 },
      { email: 'bob@x.de', name: 'bob', balance: 1000 },
    ])
    const products = await call('GET', '/products')
    expect(products.body.map((p: { name: string; price: number }) => [p.name, p.price])).toEqual([
      ['Beer', 300],
      ['Cola', 200],
    ])
  })

  it('orders members by who was booked for most recently, then by name', async () => {
    const [beer] = (await call('GET', '/products')).body
    const names = async () => (await call('GET', '/members')).body.map((m: { name: string }) => m.name)
    expect(await names()).toEqual(['alice', 'bob'])
    await call('POST', '/book', { member: 'bob@x.de', product: beer.id, quantity: 1 })
    expect(await names()).toEqual(['bob', 'alice']) // pending counts at once
    await bot.client.flushPending()
    world.clock.advance(1000)
    await call('POST', '/book', { member: 'alice@x.de', product: beer.id, quantity: 1 })
    await bot.client.flushPending()
    await world.settle()
    expect(await names()).toEqual(['alice', 'bob'])
  })

  it('books n items of a product for a member, who pays; the balance shows it at once', async () => {
    const [beer] = (await call('GET', '/products')).body
    const booked = await call('POST', '/book', { member: 'bob@x.de', product: beer.id, quantity: 3 })
    expect(booked.status).toBe(200)
    expect(booked.body).toMatchObject({ total: 900, balance: 100 })
    expect((await call('GET', '/members')).body[0]).toMatchObject({ email: 'bob@x.de', balance: 100 }) // booked last: first

    await bot.client.flushPending()
    await world.settle()
    expect(balanceOf('bob@x.de')).toBe(100)
    expect(balanceOf('alice@x.de')).toBe(0)
  })

  it('undo within the window leaves no trace', async () => {
    const [beer] = (await call('GET', '/products')).body
    const { body } = await call('POST', '/book', { member: 'bob@x.de', product: beer.id, quantity: 1 })
    expect((await call('POST', '/undo', { id: body.id })).body).toEqual({ undone: true })
    expect((await call('POST', '/undo', { id: body.id })).body).toEqual({ undone: false })
    await bot.client.flushPending()
    await world.settle()
    expect(balanceOf('bob@x.de')).toBe(1000)
  })

  it('refuses bad requests', async () => {
    const [beer] = (await call('GET', '/products')).body
    const book = (patch: object) => call('POST', '/book', { member: 'bob@x.de', product: beer.id, quantity: 1, ...patch })
    expect((await book({ member: 'nobody@x.de' })).status).toBe(404)
    expect((await book({ member: 'bot' })).status).toBe(404) // the station does not buy for itself
    expect((await book({ product: 'nope' })).status).toBe(404)
    for (const quantity of [0, -1, 1.5, 100, '2', null]) expect((await book({ quantity })).status).toBe(400)
    expect((await call('POST', '/book', [1])).status).toBe(400)
    expect((await call('GET', '/nope')).status).toBe(404)
    expect(balanceOf('bob@x.de')).toBe(1000)
  })

  it('refuses sold-out products', async () => {
    const alice = world.devices[0]
    const g = alice.visibleGroups()[0].local.id
    const [beer] = (await call('GET', '/products')).body
    await alice.updateProduct(g, beer.id, { soldOut: true })
    await world.settle()
    expect((await call('POST', '/book', { member: 'bob@x.de', product: beer.id, quantity: 1 })).status).toBe(409)
  })
})
