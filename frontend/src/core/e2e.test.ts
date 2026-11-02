// @vitest-environment node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * End-to-end: real TapClients with the real WebSocketRelay against a real
 * backend (uvicorn + temp DB), all headless. Started by scripts/test.sh, which
 * sets E2E_URL and E2E_LOG (the server log, where login codes appear because
 * no mail server is set). Skipped in plain `npm test`.
 */
import 'fake-indexeddb/auto'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startBot, type Bot } from '../bot/bot'
import { createIdentity } from '../bot/identity'
import { TapClient } from './client'
import { exportPublicKey, generateKeyPair } from './crypto'
import { TapDb } from './db'
import { WebSocketRelay } from './relay'

const BASE = process.env.E2E_URL ?? ''
const LOG = process.env.E2E_LOG ?? ''
const WS = BASE.replace(/^http/, 'ws') + '/api/ws'
const run = Math.random().toString(36).slice(2, 8) // unique emails per run

const clients: TapClient[] = []

afterEach(() => {
  clients.forEach((c) => c.close())
  clients.length = 0
})

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

async function until(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function loginCode(email: string): Promise<string> {
  const before = readFileSync(LOG, 'utf8').length
  await post('/auth/request-login', { email, language: 'en' })
  let code = ''
  await until(() => {
    const match = readFileSync(LOG, 'utf8').slice(before).match(new RegExp(`Login code for ${email.replace(/[.+]/g, '\\$&')}: (\\d{6})`))
    code = match?.[1] ?? ''
    return !!code
  }, `login code for ${email}`)
  return code
}

function newClient(dbName: string): TapClient {
  const client = new TapClient({
    db: new TapDb(dbName),
    connect: (identity, _key, handlers) => new WebSocketRelay(WS, identity.email, identity.keyPair.privateKey, handlers),
    undoMs: 30,
  })
  clients.push(client)
  return client
}

/** Log in through the real PIN flow on a fresh device. */
async function device(name: string, dbName = `e2e-${name}-${crypto.randomUUID()}`): Promise<TapClient> {
  const email = `${name}-${run}@example.com`
  const keyPair = await generateKeyPair()
  const code = await loginCode(email)
  const verified = await post<{ email: string; time: number }>('/auth/verify', {
    email,
    code,
    public_key: await exportPublicKey(keyPair.publicKey),
  })
  const client = newClient(dbName)
  await client.init()
  await client.setIdentity(verified.email, keyPair, verified.time)
  await until(() => client.relayStatus === 'online', `${name} online`)
  return client
}

function balanceOf(client: TapClient, groupId: string, email: string): number | undefined {
  return client.groups.get(groupId)?.model.state.members[email]?.balance
}

describe.skipIf(!BASE)('end-to-end against the real relay', () => {
  it('invite, join, buy and sync between two devices', async () => {
    const alice = await device('alice')
    const bob = await device('bob')
    const g = await alice.createGroup('Pub', '', 'Alice')
    await alice.addProduct(g, 'Beer', 250)
    const invite = await alice.createInvite(g, false)

    await bob.joinGroup(g, (invite.data as { token: string }).token, 'Bob')
    await until(() => !!bob.group(g), 'bob joined')
    expect(bob.onlineMembers(g)).toEqual([alice.email])

    const beer = Object.values(bob.groups.get(g)!.model.state.products)[0]
    await bob.purchase(g, beer)
    await until(() => balanceOf(alice, g, bob.email) === -250, 'purchase reaches alice')
    expect(alice.errors.concat(bob.errors)).toEqual([])
  })

  it('offline purchases sync after the app restarts', async () => {
    const alice = await device('alice2')
    const bobDb = `e2e-bob2-${crypto.randomUUID()}`
    const bob = await device('bob2', bobDb)
    const g = await alice.createGroup('Pub', '', 'Alice')
    await alice.addProduct(g, 'Cola', 200)
    const invite = await alice.createInvite(g, true)
    await bob.joinGroup(g, (invite.data as { token: string }).token, 'Bob')
    await until(() => !!bob.group(g), 'bob joined')

    bob.close() // app closed / no network
    const cola = Object.values(bob.groups.get(g)!.model.state.products)[0]
    await bob.purchase(g, cola)
    await bob.flushPending()
    await alice.updateProduct(g, cola.id, { price: 220 })

    const bobAgain = newClient(bobDb) // same storage, same key
    await bobAgain.init()
    await until(() => balanceOf(alice, g, bobAgain.email) === -200, 'offline purchase reaches alice')
    await until(() => bobAgain.groups.get(g)!.model.state.products[cola.id].price === 220, 'price reaches bob')
  })

  it('the bar station bot joins by invite and books drinks for a member', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-e2e-'))
    let bot: Bot | undefined
    try {
      // registered like any device here (a real bot is registered by hand, see bot/README.md)
      const email = `station-${run}@example.com` // the login API refuses .invalid, which a real bot never needs
      const publicKey = await createIdentity(dir, email)
      const code = await loginCode(email)
      await post('/auth/verify', { email, code, public_key: publicKey })

      const alice = await device('alice4')
      const g = await alice.createGroup('Pub', '', 'Alice')
      await alice.addProduct(g, 'Beer', 250)
      const invite = await alice.createInvite(g, false)
      bot = await startBot({
        dir,
        displayName: 'Bar station',
        undoMs: 30,
        joinLink: `${BASE}/join/${g}?t=${(invite.data as { token: string }).token}`,
        connect: (identity, _key, handlers) => new WebSocketRelay(WS, identity.email, identity.keyPair.privateKey, handlers),
      })
      const station = bot.client
      await until(() => !!station.group(g), 'bot joined')
      expect(alice.groups.get(g)!.model.state.members[email].displayname).toBe('Bar station')

      const beer = Object.values(station.groups.get(g)!.model.state.products)[0]
      await station.purchase(g, beer, 3, alice.email)
      await until(() => balanceOf(alice, g, alice.email) === -750, 'booking reaches alice')
      expect(balanceOf(alice, g, email)).toBe(0)
      expect(alice.errors.concat(station.errors)).toEqual([])
    } finally {
      await bot?.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('logging in on a new device logs out the old one', async () => {
    const old = await device('carol')
    await device('carol') // same email, new key
    await until(() => old.notice?.kind === 'replaced', 'old device replaced')
    await until(() => old.identity === null, 'old identity cleared')
  })
})
