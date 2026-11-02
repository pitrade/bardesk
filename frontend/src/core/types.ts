// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Data model of the local-first design (see DESIGN.md).
 *
 * A group is an append-only log of entries. Every entry is uniquely keyed by
 * (device, seq); all other state is derived by replaying the log.
 */

/** Hybrid logical clock timestamp, lexicographically sortable (see hlc.ts). */
export type Hlc = string

export type Role = 'admin' | 'member'

export interface EntryDataMap {
  'group.created': { name: string; description: string; displayname: string }
  'group.updated': { name?: string; description?: string }
  'invite.created': { token: string; expiresAt: number; multiUse: boolean }
  'invite.revoked': { token: string }
  'member.joined': { email: string; displayname: string; token?: string }
  'member.renamed': { displayname: string }
  'member.role': { email: string; role: Role }
  'member.left': Record<string, never>
  'member.removed': { email: string }
  'product.added': { id: string; name: string; price: number; sortOrder: number }
  'product.updated': { id: string; name?: string; price?: number; sortOrder?: number; soldOut?: boolean }
  'product.deleted': { id: string }
  /**
   * price per item; quantity is missing in entries before 0.6.17 (= 1).
   * `for`: the member who pays when someone else books it (e.g. a bar station); missing = the author.
   */
  purchase: { productId: string; name: string; price: number; quantity?: number; for?: string }
  topup: { amount: number; description: string }
  settled: { email: string; amount: number }
  'chat.message': { id: string; text: string }
  'chat.deleted': { id: string }
}

export type EntryType = keyof EntryDataMap

export interface Entry<T extends EntryType = EntryType> {
  group: string
  device: string
  seq: number
  author: string
  type: T
  data: EntryDataMap[T]
  hlc: Hlc
  /** entry format version, lets older app versions keep, forward and skip unknown types */
  v: number
}

export const ENTRY_VERSION = 1

/** Version vector: highest seq held per device. */
export type Vector = Record<string, number>

export interface Member {
  email: string
  displayname: string
  role: Role
  status: 'active' | 'left' | 'removed'
  balance: number
  lastSeen: Hlc | null
}

export interface Product {
  id: string
  name: string
  price: number
  sortOrder: number
  soldOut: boolean
}

export interface ChatMessage {
  id: string
  author: string
  text: string
  hlc: Hlc
}

export interface Invite {
  token: string
  createdBy: string
  expiresAt: number
  multiUse: boolean
  usedCount: number
  revoked: boolean
}

/** Derived group state. Plain JSON data so it can become a snapshot later. */
export interface GroupState {
  id: string
  name: string
  description: string
  members: Record<string, Member>
  products: Record<string, Product>
  deletedProducts: Record<string, true>
  invites: Record<string, Invite>
  /** in timestamp order; deleted messages are removed */
  messages: ChatMessage[]
}
