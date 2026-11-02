// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test harness: several TapClients (each with its own fake IndexedDB) on one
 * in-memory relay, a controllable clock, and settle() to wait until all
 * devices have finished exchanging messages.
 */
import 'fake-indexeddb/auto'
import { TapClient } from '../client'
import { generateKeyPair } from '../crypto'
import { TapDb } from '../db'
import { MemoryHub } from './memoryRelay'

export class FakeClock {
  ms = Date.UTC(2026, 5, 1, 18, 0, 0)
  now = (): number => this.ms
  advance(ms: number): void {
    this.ms += ms
  }
}

export interface Device {
  client: TapClient
  dbName: string
}

export class World {
  hub = new MemoryHub()
  clock = new FakeClock()
  devices: TapClient[] = []

  /** A new device (fresh storage) logged in as `email`. Purchases only commit via flushPending(). */
  async device(email: string, dbName = `db-${crypto.randomUUID()}`): Promise<TapClient> {
    const client = new TapClient({
      db: new TapDb(dbName),
      connect: this.hub.connector,
      now: this.clock.now,
      schedule: () => () => {},
    })
    await client.init()
    if (!client.identity) await client.setIdentity(email, await generateKeyPair())
    ;(client as unknown as { dbName: string }).dbName = dbName
    this.devices.push(client)
    await this.settle()
    return client
  }

  /** Restart the app on the same storage (same device). */
  async restart(client: TapClient): Promise<TapClient> {
    const dbName = (client as unknown as { dbName: string }).dbName
    client.close()
    this.devices = this.devices.filter((c) => c !== client)
    return this.device(client.email, dbName)
  }

  offline(client: TapClient): void {
    this.hub.offline(client.email)
  }

  async online(client: TapClient): Promise<void> {
    this.hub.online(client.email)
    await this.settle()
  }

  /** Wait until no device has work left (all relay messages handled). */
  async settle(): Promise<void> {
    for (let round = 0; round < 200; round++) {
      const before = this.devices.reduce((sum, c) => sum + c.tasks, 0)
      await Promise.all(this.devices.map((c) => c.idle()))
      await new Promise((resolve) => setTimeout(resolve, 0))
      const after = this.devices.reduce((sum, c) => sum + c.tasks, 0)
      if (after === before) return
    }
    throw new Error('devices did not settle')
  }

  errors(): unknown[] {
    return this.devices.flatMap((c) => c.errors)
  }
}

/** Create a group on `admin` and let `members` join via invite links. Returns the group id. */
export async function groupWith(world: World, admin: TapClient, members: TapClient[] = []): Promise<string> {
  const id = await admin.createGroup('Pub', 'Our local', admin.email.split('@')[0])
  await admin.addProduct(id, 'Beer', 300)
  await admin.addProduct(id, 'Cola', 200)
  for (const member of members) {
    const invite = await admin.createInvite(id, false)
    await member.joinGroup(id, (invite.data as { token: string }).token, member.email.split('@')[0])
    await world.settle()
  }
  return id
}

export function product(client: TapClient, groupId: string, name: string) {
  const found = Object.values(client.groups.get(groupId)!.model.state.products).find((p) => p.name === name)
  if (!found) throw new Error(`no product ${name}`)
  return found
}

export async function buy(client: TapClient, groupId: string, name: string): Promise<void> {
  await client.purchase(groupId, product(client, groupId, name))
  await client.flushPending()
}
