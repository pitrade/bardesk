// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic replay: the same entries produce the same state on every device.
 *
 * No local clock, device settings or randomness may be used here. Entries are
 * applied in (hlc, device, seq) order; later entries overwrite earlier ones.
 * There are no permission checks, the design is trust-based and admin
 * controls are only hidden in the UI.
 */
import type { Entry, EntryDataMap, EntryType, GroupState, Member } from './types'

export function compareEntries(a: Entry, b: Entry): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1
  if (a.device !== b.device) return a.device < b.device ? -1 : 1
  return a.seq - b.seq
}

export function emptyState(id: string): GroupState {
  return { id, name: '', description: '', members: {}, products: {}, deletedProducts: {}, invites: {}, messages: [] }
}

export function replay(id: string, entries: readonly Entry[]): GroupState {
  const state = emptyState(id)
  for (const entry of [...entries].sort(compareEntries)) applyEntry(state, entry)
  return state
}

/** A member that shows up without a join entry (shouldn't happen) still gets a row. */
function member(state: GroupState, email: string): Member {
  state.members[email] ??= {
    email,
    displayname: email,
    role: 'member',
    status: 'active',
    balance: 0,
    lastSeen: null,
  }
  return state.members[email]
}

type Handlers = { [T in EntryType]: (state: GroupState, data: EntryDataMap[T], entry: Entry<T>) => void }

const handlers: Handlers = {
  'group.created'(state, data, entry) {
    state.name = data.name
    state.description = data.description
    const creator = member(state, entry.author)
    creator.role = 'admin'
    creator.status = 'active'
    creator.displayname = data.displayname || creator.displayname
  },
  'group.updated'(state, data) {
    if (data.name !== undefined) state.name = data.name
    if (data.description !== undefined) state.description = data.description
  },
  'invite.created'(state, data, entry) {
    state.invites[data.token] = {
      token: data.token,
      createdBy: entry.author,
      expiresAt: data.expiresAt,
      multiUse: data.multiUse,
      usedCount: 0,
      revoked: false,
    }
  },
  'invite.revoked'(state, data) {
    const invite = state.invites[data.token]
    if (invite) invite.revoked = true
  },
  'member.joined'(state, data) {
    const joined = member(state, data.email)
    joined.status = 'active'
    if (data.displayname) joined.displayname = data.displayname
    const invite = data.token ? state.invites[data.token] : undefined
    if (invite) invite.usedCount += 1
  },
  'member.renamed'(state, data, entry) {
    if (data.displayname) member(state, entry.author).displayname = data.displayname
  },
  'member.role'(state, data) {
    if (state.members[data.email]) state.members[data.email].role = data.role
  },
  'member.left'(state, _data, entry) {
    member(state, entry.author).status = 'left'
  },
  'member.removed'(state, data) {
    if (state.members[data.email]) state.members[data.email].status = 'removed'
  },
  'product.added'(state, data) {
    if (state.deletedProducts[data.id]) return
    state.products[data.id] = { id: data.id, name: data.name, price: data.price, sortOrder: data.sortOrder, soldOut: false }
  },
  'product.updated'(state, data) {
    const product = state.products[data.id]
    if (!product) return
    if (data.name !== undefined) product.name = data.name
    if (data.price !== undefined) product.price = data.price
    if (data.sortOrder !== undefined) product.sortOrder = data.sortOrder
    if (data.soldOut !== undefined) product.soldOut = data.soldOut
  },
  'product.deleted'(state, data) {
    // final: later edits of this product are ignored
    delete state.products[data.id]
    state.deletedProducts[data.id] = true
  },
  purchase(state, data, entry) {
    member(state, chargedMember(data, entry.author)).balance -= purchaseTotal(data)
  },
  topup(state, data, entry) {
    member(state, entry.author).balance += data.amount
  },
  settled(state, data) {
    member(state, data.email).balance += data.amount
  },
  'chat.message'(state, data, entry) {
    state.messages.push({ id: data.id, author: entry.author, text: data.text, hlc: entry.hlc })
  },
  'chat.deleted'(state, data, entry) {
    // only the author can delete (hide) a message; the entry itself stays in the log
    state.messages = state.messages.filter((m) => !(m.id === data.id && m.author === entry.author))
  },
}

/** Who pays for a purchase: the member it was booked for, else its author. */
export function chargedMember(data: EntryDataMap['purchase'], author: string): string {
  return data.for ?? author
}

/** What a purchase costs in total. */
export function purchaseTotal(data: EntryDataMap['purchase']): number {
  return data.price * (data.quantity ?? 1)
}

/** Apply one entry in place. Unknown types (newer app versions) are skipped. */
export function applyEntry(state: GroupState, entry: Entry): void {
  const handler = handlers[entry.type] as ((s: GroupState, d: unknown, e: Entry) => void) | undefined
  if (!handler) return
  handler(state, entry.data, entry)
  const author = state.members[entry.author]
  if (author) author.lastSeen = entry.hlc
}

// ---- derived views -------------------------------------------------------

export function activeMembers(state: GroupState): Member[] {
  return Object.values(state.members).filter((m) => m.status === 'active')
}

export function isActiveMember(state: GroupState, email: string): boolean {
  return state.members[email]?.status === 'active'
}

export function isAdmin(state: GroupState, email: string): boolean {
  const m = state.members[email]
  return m?.status === 'active' && m.role === 'admin'
}

/** Removed or departed members who still owe or are owed money. */
export function formerWithOpenBalance(state: GroupState): Member[] {
  return Object.values(state.members).filter((m) => m.status !== 'active' && m.balance !== 0)
}

export function sortedProducts(state: GroupState): GroupState['products'][string][] {
  return Object.values(state.products).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}
