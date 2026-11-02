// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The headless client: a normal TapClient (same code as the app) that runs in Node, joins
 * a group by invite like any member and stays online. The browser's IndexedDB is replaced
 * by an in-memory one; the log is kept in `snapshot.json` (the export format) and the
 * device id in the identity file, so a restart continues where it stopped.
 */
import 'fake-indexeddb/auto' // before anything loads Dexie
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TapClient, type ExportFile, type RelayConnector } from '../core/client'
import { TapDb } from '../core/db'
import type { RelayStatus } from '../core/relay'
import { parseJoinLink } from '../utils/links'
import { loadIdentity } from './identity'

export interface BotOptions {
  dir: string
  connect: RelayConnector
  /** shown to the members of the group */
  displayName: string
  /** invite link, only used while the bot is in no group yet */
  joinLink?: string
  /** save the log this often when it changed; 0 = only on save()/stop() */
  saveEveryMs?: number
  /** the connection ended for good (outdated app, replaced key, …): restart or fix it */
  onFatal?: (status: RelayStatus) => void
  now?: () => number
  undoMs?: number
  schedule?: (fn: () => void, ms: number) => () => void
}

export interface Bot {
  client: TapClient
  save(): Promise<void>
  stop(): Promise<void>
}

const FATAL: RelayStatus[] = ['outdated', 'replaced', 'superseded', 'deleted']
const snapshotPath = (dir: string) => join(dir, 'snapshot.json')

async function readSnapshot(dir: string): Promise<ExportFile | null> {
  try {
    return JSON.parse(await readFile(snapshotPath(dir), 'utf8')) as ExportFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function startBot(options: BotOptions): Promise<Bot> {
  const { dir } = options
  const identity = await loadIdentity(dir)
  const db = new TapDb(`bot-${crypto.randomUUID()}`)
  await db.setMeta('device', identity.deviceId)
  const client = new TapClient({
    db,
    connect: options.connect,
    now: options.now,
    undoMs: options.undoMs,
    schedule: options.schedule,
  })
  await client.init()
  const snapshot = await readSnapshot(dir)
  if (snapshot) await client.importData(snapshot)
  await client.setIdentity(identity.email, identity.keyPair)
  // the name comes from the settings: a changed name is applied to the groups we are already in
  for (const { local, model } of client.visibleGroups()) {
    if (model.state.members[client.email]?.displayname !== options.displayName) {
      await client.setDisplayName(local.id, options.displayName)
    }
  }

  if (!client.visibleGroups().length && options.joinLink) {
    const link = parseJoinLink(options.joinLink)
    if (!link) throw new Error('BOT_JOIN_LINK is not an invite link')
    await client.joinGroup(link.id, link.token, options.displayName)
  }

  let dirty = false
  let fatal = false
  const unsubscribe = client.subscribe(() => {
    dirty = true
    if (!fatal && FATAL.includes(client.relayStatus)) {
      fatal = true
      options.onFatal?.(client.relayStatus)
    }
  })

  const save = async () => {
    await client.idle()
    dirty = false
    const temporary = `${snapshotPath(dir)}.tmp`
    await writeFile(temporary, JSON.stringify(client.exportData()), { mode: 0o600 })
    await rename(temporary, snapshotPath(dir)) // never a half-written snapshot
  }
  const saver = options.saveEveryMs ? setInterval(() => dirty && void save(), options.saveEveryMs) : undefined

  return {
    client,
    save,
    async stop() {
      clearInterval(saver)
      unsubscribe()
      await save()
      client.close()
    },
  }
}
