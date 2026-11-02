// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * IndexedDB storage (Dexie). Stores only the logs plus device-local data , 
 * all group state is derived in memory by replay.
 */
import Dexie, { type Table } from 'dexie'
import type { Entry, EntryDataMap, GroupState, Hlc } from './types'

export type LocalGroupStatus = 'joining' | 'member' | 'leaving'

export interface LocalGroup {
  id: string
  status: LocalGroupStatus
  /** last seq this device assigned in this group */
  seq: number
  /** join request details while status is 'joining' (no token = rejoin) */
  token?: string
  displayname?: string
}

/** A purchase in its undo window: saved immediately, committed (seq assigned) later. */
export interface PendingPurchase {
  id: string
  group: string
  author: string
  data: EntryDataMap['purchase']
  hlc: Hlc
  dueAt: number
}

export interface Identity {
  email: string
  keyPair: CryptoKeyPair
}

/**
 * Saved result of replaying a group's log, so the app doesn't replay at every start.
 * Valid only while `count` equals the number of entries (the log is append-only, so
 * same count = same log) and `version` equals the app version (replay rules may change).
 */
export interface CachedState {
  id: string
  count: number
  version: string
  state: GroupState
}

interface Meta {
  key: string
  value: unknown
}

export class TapDb extends Dexie {
  meta!: Table<Meta, string>
  entries!: Table<Entry, [string, string, number]>
  groups!: Table<LocalGroup, string>
  pending!: Table<PendingPurchase, string>
  states!: Table<CachedState, string>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      meta: 'key',
      entries: '[group+device+seq], group',
      groups: 'id',
      pending: 'id, group',
    })
    this.version(2).stores({ states: 'id' })
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.meta.get(key))?.value as T | undefined
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.meta.put({ key, value })
  }

  async deleteGroupData(id: string): Promise<void> {
    await this.transaction('rw', [this.entries, this.groups, this.pending, this.states], async () => {
      await this.entries.where('group').equals(id).delete()
      await this.pending.where('group').equals(id).delete()
      await this.states.delete(id)
      await this.groups.delete(id)
    })
  }
}
