// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * TapClient: the device's local-first engine.
 *
 * Owns the IndexedDB logs, derives group state, exposes the user actions and
 * runs the peer sync protocol over the live relay. Framework-free so tests can
 * run several clients against an in-memory relay (core/testing/memoryRelay.ts).
 *
 * Peer protocol (every message encrypted for exactly one recipient):
 *   hello{vector}        "this is what I have", answered with the missing entries
 *   entries{entries}     log entries; the receiver acks with a hello
 *   join{token?, name?}  a device without the group asks to be let in (no token = rejoin)
 *   join_rejected{reason}
 *   removed              answer to a hello from a removed member, so it drops the group
 */
import { b64e, exportPublicKey, peerKey, seal, unseal } from './crypto'
import type { Identity, LocalGroup, LocalGroupStatus, PendingPurchase, TapDb } from './db'
import { GroupModel } from './group'
import { HlcClock } from './hlc'
import type { PeerInfo, Relay, RelayHandlers, RelayStatus } from './relay'
import { activeMembers, chargedMember, isActiveMember, purchaseTotal, sortedProducts } from './replay'
import { ENTRY_VERSION, type Entry, type EntryDataMap, type EntryType, type Product, type Role, type Vector } from './types'

export const INVITE_LIFETIME_MS = 24 * 60 * 60 * 1000
export const UNDO_WINDOW_MS = 8000
export const MAX_MESSAGE_LENGTH = 2000

export type JoinRejection = 'invalid' | 'expired' | 'used' | 'revoked' | 'not_member'

type PeerMessage =
  | { k: 'hello'; vector: Vector }
  | { k: 'entries'; entries: Entry[] }
  | { k: 'join'; token?: string; displayname?: string }
  | { k: 'join_rejected'; reason: JoinRejection }
  | { k: 'removed' }

export type Notice =
  | { kind: 'removed'; group: string; name: string }
  | { kind: 'replaced' | 'superseded' | 'deleted' | 'outdated' }

export type RelayConnector = (identity: Identity, publicKey: string, handlers: RelayHandlers) => Relay

export interface ClientOptions {
  db: TapDb
  connect: RelayConnector
  /** wall clock in ms (injectable for tests) */
  now?: () => number
  undoMs?: number
  schedule?: (fn: () => void, ms: number) => () => void
}

export interface LocalGroupModel {
  local: LocalGroup
  model: GroupModel
}

export interface ExportFile {
  app: 'bardesk'
  version: 1
  exportedAt: number
  groups: { id: string; entries: Entry[] }[]
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

function randomToken(): string {
  return b64e(crypto.getRandomValues(new Uint8Array(16)))
}

export class TapClient {
  identity: Identity | null = null
  deviceId = ''
  relayStatus: RelayStatus = 'offline'
  activeGroupId: string | null = null
  notice: Notice | null = null
  readonly groups = new Map<string, LocalGroupModel>()
  readonly pending = new Map<string, PendingPurchase>()
  readonly joinErrors = new Map<string, JoinRejection>()
  /** errors from background work (relay messages); tests assert this stays empty */
  readonly errors: unknown[] = []

  private relay: Relay | null = null
  private present = new Map<string, Map<string, string>>() // room -> email -> public key
  private aesKeys = new Map<string, Promise<CryptoKey>>()
  private timers = new Map<string, () => void>()
  private listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  /** number of tasks ever queued, lets tests detect when all clients are quiet */
  tasks = 0
  private offset = 0
  private readonly db: TapDb
  private readonly wallClock: () => number
  private readonly undoMs: number
  private readonly schedule: NonNullable<ClientOptions['schedule']>
  private readonly connector: RelayConnector
  readonly clock: HlcClock

  constructor(options: ClientOptions) {
    this.db = options.db
    this.connector = options.connect
    this.wallClock = options.now ?? Date.now
    this.undoMs = options.undoMs ?? UNDO_WINDOW_MS
    this.schedule = options.schedule ?? defaultSchedule
    this.clock = new HlcClock(() => this.now())
  }

  /** Corrected wall clock: device time plus the offset to the server's time. */
  now(): number {
    return this.wallClock() + this.offset
  }

  get email(): string {
    return this.identity?.email ?? ''
  }

  // ---- lifecycle -----------------------------------------------------------

  async init(): Promise<void> {
    this.deviceId = (await this.db.getMeta<string>('device')) ?? crypto.randomUUID()
    await this.db.setMeta('device', this.deviceId)
    this.identity = (await this.db.getMeta<Identity>('identity')) ?? null
    this.activeGroupId = (await this.db.getMeta<string>('activeGroup')) ?? null

    for (const local of await this.db.groups.toArray()) {
      const entries = await this.db.entries.where('group').equals(local.id).toArray()
      const cached = await this.db.states.get(local.id)
      const fresh = cached?.count === entries.length && cached.version === __APP_VERSION__
      const model = fresh ? GroupModel.restore(local.id, entries, cached.state) : new GroupModel(local.id, entries)
      model.entries.forEach((e) => this.clock.observe(e.hlc))
      const group = { local, model }
      this.groups.set(local.id, group)
      if (!fresh) await this.saveState(group)
    }
    for (const purchase of await this.db.pending.toArray()) {
      this.pending.set(purchase.id, purchase)
      this.clock.observe(purchase.hlc)
      this.schedulePending(purchase)
    }
    this.fixActiveGroup()
    if (this.identity) await this.connectRelay()
    this.changed()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resolves once all queued work (actions and relay messages) has finished. */
  async idle(): Promise<void> {
    let current: Promise<unknown>
    do {
      current = this.queue
      await current
    } while (current !== this.queue)
  }

  close(): void {
    this.relay?.close()
    this.relay = null
    this.timers.forEach((cancel) => cancel())
    this.timers.clear()
  }

  /** Save the replay result (see CachedState). Not atomic with the entries: the count check covers that. */
  private async saveState(group: LocalGroupModel): Promise<void> {
    const { model } = group
    await this.db.states.put({ id: model.id, count: model.entries.length, version: __APP_VERSION__, state: model.state })
  }

  private changed(): void {
    this.listeners.forEach((listener) => listener())
  }

  /** Run tasks one at a time so the log, seq counters and vectors never race. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    this.tasks++
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private background(task: () => Promise<void>): void {
    this.serial(task).catch((error) => {
      this.errors.push(error)
      console.error(error)
    })
  }

  // ---- identity --------------------------------------------------------------

  /** Store the device key after the server verified the email, and go online. */
  async setIdentity(email: string, keyPair: CryptoKeyPair, serverTime?: number): Promise<void> {
    if (serverTime) this.offset = serverTime - this.wallClock()
    this.relay?.close()
    this.identity = { email: email.toLowerCase(), keyPair }
    await this.db.setMeta('identity', this.identity)
    await this.connectRelay()
    this.changed()
  }

  private async clearIdentity(): Promise<void> {
    this.relay?.close()
    this.relay = null
    this.identity = null
    this.present.clear()
    await this.db.meta.delete('identity')
  }

  /** Only possible once all groups are left (see DESIGN.md). */
  deleteAccount(): void {
    if (this.visibleGroups().length) throw new Error('Leave all groups first')
    this.relay?.deleteAccount()
  }

  dismissNotice(): void {
    this.notice = null
    this.changed()
  }

  // ---- relay -------------------------------------------------------------------

  private async connectRelay(): Promise<void> {
    const identity = this.identity
    if (!identity) return
    const publicKey = await exportPublicKey(identity.keyPair.publicKey)
    this.relay = this.connector(identity, publicKey, this.relayHandlers())
    this.relay.join([...this.groups.keys()])
  }

  private relayHandlers(): RelayHandlers {
    return {
      status: (status) => this.onStatus(status),
      serverTime: (ms) => {
        this.offset = ms - this.wallClock()
      },
      presence: (room, peers) => {
        this.present.set(room, new Map(peers.map((p) => [p.email, p.key])))
        this.changed()
        for (const peer of peers) this.background(() => this.greet(room, peer))
      },
      peerJoined: (room, peer) => {
        if (!this.present.has(room)) this.present.set(room, new Map())
        this.present.get(room)!.set(peer.email, peer.key)
        this.changed()
        this.background(() => this.greet(room, peer))
      },
      peerLeft: (room, email) => {
        this.present.get(room)?.delete(email)
        this.changed()
      },
      message: (room, from, data) => this.background(() => this.onMessage(room, from, data)),
    }
  }

  private onStatus(status: RelayStatus): void {
    this.relayStatus = status
    if (status !== 'online') this.present.clear()
    if (status === 'outdated') this.notice = { kind: 'outdated' } // the UI updates the app
    if (status === 'replaced' || status === 'superseded') {
      this.notice = { kind: status }
      if (status === 'replaced') this.background(() => this.clearIdentity())
    }
    if (status === 'deleted') {
      this.notice = { kind: 'deleted' }
      this.background(() => this.wipe())
    }
    this.changed()
  }

  private async wipe(): Promise<void> {
    await this.clearIdentity()
    this.close()
    await this.db.delete()
    this.groups.clear()
    this.pending.clear()
  }

  private aesKey(email: string, publicKey: string): Promise<CryptoKey> {
    const cacheKey = `${email}|${publicKey}`
    let key = this.aesKeys.get(cacheKey)
    if (!key) {
      key = peerKey(this.identity!.keyPair.privateKey, publicKey)
      this.aesKeys.set(cacheKey, key)
    }
    return key
  }

  private async sendTo(room: string, email: string, message: PeerMessage): Promise<void> {
    const publicKey = this.present.get(room)?.get(email)
    if (!publicKey || !this.relay || !this.identity) return
    this.relay.send(room, email, await seal(await this.aesKey(email, publicKey), message))
  }

  /** Present peers of a group that are active members (in our view of the log). */
  onlineMembers(groupId: string): string[] {
    const group = this.groups.get(groupId)
    const present = this.present.get(groupId)
    if (!group || !present) return []
    return [...present.keys()].filter((email) => isActiveMember(group.model.state, email))
  }

  // ---- peer protocol -------------------------------------------------------------

  private async greet(room: string, peer: PeerInfo): Promise<void> {
    const group = this.groups.get(room)
    if (!group) return
    if (group.local.status === 'joining') {
      await this.sendTo(room, peer.email, { k: 'join', token: group.local.token, displayname: group.local.displayname })
    } else if (isActiveMember(group.model.state, peer.email)) {
      await this.sendTo(room, peer.email, { k: 'hello', vector: group.model.vector })
    }
  }

  private async onMessage(room: string, from: string, data: string): Promise<void> {
    const publicKey = this.present.get(room)?.get(from)
    if (!publicKey || !this.identity) return
    let message: PeerMessage
    try {
      message = (await unseal(await this.aesKey(from, publicKey), data)) as PeerMessage
    } catch {
      return // not for us / tampered
    }
    const group = this.groups.get(room)
    if (!group) return
    switch (message.k) {
      case 'hello':
        return this.onHello(group, from, message.vector)
      case 'entries':
        return this.onEntries(group, from, message.entries)
      case 'join':
        return this.onJoin(group, from, message.token, message.displayname)
      case 'join_rejected':
        if (group.local.status === 'joining') {
          this.joinErrors.set(group.local.id, message.reason)
          this.changed()
        }
        return
      case 'removed':
        if (group.local.status !== 'joining') await this.dropRemoved(group)
    }
  }

  private async onHello(group: LocalGroupModel, from: string, vector: Vector): Promise<void> {
    if (group.local.status === 'joining') return
    if (group.model.state.members[from]?.status === 'removed') {
      return this.sendTo(group.local.id, from, { k: 'removed' })
    }
    if (!isActiveMember(group.model.state, from)) return
    const missing = group.model.missingFor(vector)
    if (missing.length) await this.sendTo(group.local.id, from, { k: 'entries', entries: missing })
    if (group.local.status === 'leaving' && (vector[this.deviceId] ?? 0) >= group.local.seq) {
      await this.dropGroup(group.local.id) // our leave entry has been delivered
    }
  }

  private async onEntries(group: LocalGroupModel, from: string, entries: Entry[]): Promise<void> {
    const joining = group.local.status === 'joining'
    // removed members can't sync; a joining device can't check yet and trusts the admitting member
    if (!joining && !isActiveMember(group.model.state, from)) return

    const { accepted, gap } = group.model.accept(entries)
    if (accepted.length) {
      await this.db.entries.bulkPut(accepted)
      accepted.forEach((e) => this.clock.observe(e.hlc))
      await this.saveState(group)
    }

    if (joining) {
      // done once the log shows us as a member, admitted by a member
      const state = group.model.state
      if (!isActiveMember(state, this.email) || !isActiveMember(state, from)) return
      group.local = { id: group.local.id, status: 'member', seq: group.model.vector[this.deviceId] ?? 0 }
      await this.db.groups.put(group.local)
      this.joinErrors.delete(group.local.id)
      if (!this.activeGroupId) await this.setActiveGroup(group.local.id)
      for (const email of this.onlineMembers(group.local.id)) {
        await this.sendTo(group.local.id, email, { k: 'hello', vector: group.model.vector })
      }
    } else if (group.model.state.members[this.email]?.status === 'removed') {
      await this.dropRemoved(group)
    } else if (accepted.length || gap) {
      // ack (lets a leaving device finish) and ask for anything we're still missing
      await this.sendTo(group.local.id, from, { k: 'hello', vector: group.model.vector })
    }
    this.changed()
  }

  private async dropRemoved(group: LocalGroupModel): Promise<void> {
    const name = group.model.state.name
    await this.dropGroup(group.local.id)
    this.notice = { kind: 'removed', group: group.local.id, name }
    this.changed()
  }

  private async onJoin(group: LocalGroupModel, from: string, token?: string, displayname?: string): Promise<void> {
    if (group.local.status !== 'member') return
    const state = group.model.state
    // one admitting member per request: the lowest email among members online (besides the joiner)
    const candidates = [this.email, ...this.onlineMembers(group.local.id)].filter((e) => e !== from).sort()
    if (candidates[0] !== this.email) return

    if (!isActiveMember(state, from)) {
      const invite = token ? state.invites[token] : undefined
      const reason: JoinRejection | null = !invite
        ? token
          ? 'invalid'
          : 'not_member'
        : invite.revoked
          ? 'revoked'
          : invite.expiresAt < this.now()
            ? 'expired'
            : !invite.multiUse && invite.usedCount > 0
              ? 'used'
              : null
      if (reason) return this.sendTo(group.local.id, from, { k: 'join_rejected', reason })
      await this.commitNow(
        group.local.id,
        'member.joined',
        { email: from, displayname: displayname?.trim() || from, token },
        undefined,
        undefined,
        from, // the joiner gets the full log below instead
      )
    }
    await this.sendTo(group.local.id, from, { k: 'entries', entries: group.model.missingFor({}) })
  }

  // ---- committing entries -----------------------------------------------------------

  private commit<T extends EntryType>(groupId: string, type: T, data: EntryDataMap[T]): Promise<Entry> {
    return this.serial(() => this.commitNow(groupId, type, data))
  }

  /** Append an entry to our own log and send it to the members online. Call inside serial(). */
  private async commitNow<T extends EntryType>(
    groupId: string,
    type: T,
    data: EntryDataMap[T],
    hlc?: string,
    pendingId?: string,
    skip?: string,
  ): Promise<Entry> {
    const group = this.groups.get(groupId)
    if (!group || group.local.status === 'joining') throw new Error('Not a member of this group')
    const entry: Entry = {
      group: groupId,
      device: this.deviceId,
      seq: group.local.seq + 1,
      author: this.email,
      type,
      data,
      hlc: hlc ?? this.clock.next(),
      v: ENTRY_VERSION,
    }
    await this.db.transaction('rw', this.db.entries, this.db.groups, this.db.pending, async () => {
      await this.db.entries.add(entry)
      await this.db.groups.update(groupId, { seq: entry.seq })
      if (pendingId) await this.db.pending.delete(pendingId)
    })
    group.local.seq = entry.seq
    // recipients from before the entry, so a member being removed right now still hears about it
    const recipients = this.onlineMembers(groupId).filter((email) => email !== skip)
    group.model.accept([entry])
    await this.saveState(group)
    for (const email of recipients) await this.sendTo(groupId, email, { k: 'entries', entries: [entry] })
    this.changed()
    return entry
  }

  // ---- groups ----------------------------------------------------------------------

  /** Groups shown in the UI (joining and leaving ones are handled separately). */
  visibleGroups(): LocalGroupModel[] {
    return [...this.groups.values()].filter((g) => g.local.status === 'member')
  }

  joiningGroups(): LocalGroupModel[] {
    return [...this.groups.values()].filter((g) => g.local.status === 'joining')
  }

  group(groupId: string | null | undefined): LocalGroupModel | undefined {
    const group = groupId ? this.groups.get(groupId) : undefined
    return group?.local.status === 'member' ? group : undefined
  }

  async setActiveGroup(groupId: string | null): Promise<void> {
    this.activeGroupId = groupId
    await this.db.setMeta('activeGroup', groupId)
    this.changed()
  }

  private fixActiveGroup(): void {
    if (!this.group(this.activeGroupId)) this.activeGroupId = this.visibleGroups()[0]?.local.id ?? null
  }

  private async addLocalGroup(id: string, status: LocalGroupStatus, extra: Partial<LocalGroup> = {}): Promise<LocalGroupModel> {
    const local: LocalGroup = { id, status, seq: 0, ...extra }
    await this.db.groups.put(local)
    const group = { local, model: new GroupModel(id) }
    this.groups.set(id, group)
    this.relay?.join([id])
    return group
  }

  async createGroup(name: string, description: string, displayname: string): Promise<string> {
    const id = crypto.randomUUID()
    await this.serial(async () => {
      await this.addLocalGroup(id, 'member')
      await this.commitNow(id, 'group.created', { name, description, displayname })
    })
    if (!this.group(this.activeGroupId)) await this.setActiveGroup(id)
    return id
  }

  updateGroup(groupId: string, name: string, description: string): Promise<Entry> {
    return this.commit(groupId, 'group.updated', { name, description })
  }

  /** Open an invite or group link. No token = rejoin as an existing member. */
  async joinGroup(groupId: string, token?: string, displayname?: string): Promise<void> {
    await this.serial(async () => {
      const existing = this.groups.get(groupId)
      if (existing && existing.local.status !== 'joining') return
      this.joinErrors.delete(groupId)
      if (existing) this.groups.delete(groupId)
      await this.addLocalGroup(groupId, 'joining', { token, displayname })
      // peers already present: ask them right away
      for (const [email, key] of this.present.get(groupId) ?? []) await this.greet(groupId, { email, key })
    })
    this.changed()
  }

  async cancelJoin(groupId: string): Promise<void> {
    await this.serial(() => this.dropGroup(groupId))
  }

  async leaveGroup(groupId: string): Promise<void> {
    await this.serial(async () => {
      const group = this.groups.get(groupId)
      if (!group || group.local.status !== 'member') return
      await this.commitNow(groupId, 'member.left', {})
      const others = activeMembers(group.model.state).filter((m) => m.email !== this.email)
      if (!others.length) return this.dropGroup(groupId) // nobody left to tell
      group.local.status = 'leaving' // hidden; the outbox waits for a member's ack
      await this.db.groups.put(group.local)
    })
    this.fixActiveGroup()
    this.changed()
  }

  /** Delete a group from this device. Call inside serial(). */
  private async dropGroup(groupId: string): Promise<void> {
    this.relay?.leave(groupId)
    this.present.delete(groupId)
    for (const [id, purchase] of this.pending) {
      if (purchase.group !== groupId) continue
      this.timers.get(id)?.()
      this.timers.delete(id)
      this.pending.delete(id)
    }
    this.groups.delete(groupId)
    await this.db.deleteGroupData(groupId)
    if (this.activeGroupId === groupId) {
      this.fixActiveGroup()
      await this.db.setMeta('activeGroup', this.activeGroupId)
    }
    this.changed()
  }

  // ---- members ------------------------------------------------------------------------

  setDisplayName(groupId: string, displayname: string): Promise<Entry> {
    return this.commit(groupId, 'member.renamed', { displayname })
  }

  setRole(groupId: string, email: string, role: Role): Promise<Entry> {
    return this.commit(groupId, 'member.role', { email, role })
  }

  removeMember(groupId: string, email: string): Promise<Entry> {
    return this.commit(groupId, 'member.removed', { email })
  }

  createInvite(groupId: string, multiUse: boolean): Promise<Entry> {
    return this.commit(groupId, 'invite.created', {
      token: randomToken(),
      expiresAt: this.now() + INVITE_LIFETIME_MS,
      multiUse,
    })
  }

  revokeInvite(groupId: string, token: string): Promise<Entry> {
    return this.commit(groupId, 'invite.revoked', { token })
  }

  settle(groupId: string, email: string): Promise<Entry> {
    const balance = this.groups.get(groupId)?.model.state.members[email]?.balance ?? 0
    return this.commit(groupId, 'settled', { email, amount: -balance })
  }

  // ---- products -------------------------------------------------------------------------

  addProduct(groupId: string, name: string, price: number): Promise<Entry> {
    const products = sortedProducts(this.groups.get(groupId)!.model.state)
    const sortOrder = (products[products.length - 1]?.sortOrder ?? 0) + 1
    return this.commit(groupId, 'product.added', { id: crypto.randomUUID(), name, price, sortOrder })
  }

  updateProduct(groupId: string, id: string, patch: Partial<Omit<Product, 'id'>>): Promise<Entry> {
    return this.commit(groupId, 'product.updated', { id, ...patch })
  }

  deleteProduct(groupId: string, id: string): Promise<Entry> {
    return this.commit(groupId, 'product.deleted', { id })
  }

  /** Swap a product with its neighbour (delta -1 = up, +1 = down). */
  async moveProduct(groupId: string, id: string, delta: -1 | 1): Promise<void> {
    const products = sortedProducts(this.groups.get(groupId)!.model.state)
    const index = products.findIndex((p) => p.id === id)
    const other = products[index + delta]
    if (index < 0 || !other) return
    const a = products[index]
    const [orderA, orderB] = a.sortOrder === other.sortOrder ? [other.sortOrder + delta, a.sortOrder] : [other.sortOrder, a.sortOrder]
    await this.commit(groupId, 'product.updated', { id: a.id, sortOrder: orderA })
    await this.commit(groupId, 'product.updated', { id: other.id, sortOrder: orderB })
  }

  // ---- money ------------------------------------------------------------------------------

  /**
   * Book a purchase with an undo window; returns the pending id for undo().
   * `forEmail` books it for another member (a bar station); default: for myself.
   */
  async purchase(groupId: string, product: Product, quantity = 1, forEmail = this.email): Promise<string> {
    const group = this.group(groupId)
    if (!group) throw new Error('Not a member of this group')
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Invalid quantity')
    if (!isActiveMember(group.model.state, forEmail)) throw new Error('Unknown member')
    const purchase: PendingPurchase = {
      id: crypto.randomUUID(),
      group: groupId,
      author: this.email,
      data: {
        productId: product.id,
        name: product.name,
        price: product.price,
        quantity,
        ...(forEmail !== this.email && { for: forEmail }),
      },
      hlc: this.clock.next(),
      dueAt: this.now() + this.undoMs,
    }
    await this.db.pending.add(purchase)
    this.pending.set(purchase.id, purchase)
    this.schedulePending(purchase)
    this.changed()
    return purchase.id
  }

  async undo(pendingId: string): Promise<boolean> {
    if (!this.pending.has(pendingId)) return false
    this.timers.get(pendingId)?.()
    this.timers.delete(pendingId)
    this.pending.delete(pendingId)
    await this.db.pending.delete(pendingId)
    this.changed()
    return true
  }

  /** Commit all purchases still in their undo window (tests, app start). */
  async flushPending(): Promise<void> {
    for (const id of [...this.pending.keys()]) await this.commitPending(id)
  }

  private schedulePending(purchase: PendingPurchase): void {
    const delay = Math.max(0, purchase.dueAt - this.now())
    this.timers.set(
      purchase.id,
      this.schedule(() => void this.commitPending(purchase.id).catch((e) => this.errors.push(e)), delay),
    )
  }

  private commitPending(id: string): Promise<void> {
    return this.serial(async () => {
      const purchase = this.pending.get(id)
      if (!purchase) return
      this.timers.get(id)?.()
      this.timers.delete(id)
      this.pending.delete(id)
      if (!this.group(purchase.group)) {
        await this.db.pending.delete(id)
        return
      }
      await this.commitNow(purchase.group, 'purchase', purchase.data, purchase.hlc, id)
    })
  }

  /** Top up (positive) or correct / cash out (negative), in cents. */
  topup(groupId: string, amount: number, description = ''): Promise<Entry> {
    return this.commit(groupId, 'topup', { amount, description })
  }

  /** Own balance including purchases still in their undo window. */
  balance(groupId: string): number {
    const committed = this.groups.get(groupId)?.model.state.members[this.email]?.balance ?? 0
    let pending = 0
    for (const purchase of this.pending.values()) {
      if (purchase.group === groupId && chargedMember(purchase.data, purchase.author) === this.email) {
        pending += purchaseTotal(purchase.data)
      }
    }
    return committed - pending
  }

  // ---- chat ---------------------------------------------------------------------------------

  async sendMessage(groupId: string, text: string): Promise<Entry> {
    const trimmed = text.trim().slice(0, MAX_MESSAGE_LENGTH)
    if (!trimmed) throw new Error('Empty message')
    return this.commit(groupId, 'chat.message', { id: crypto.randomUUID(), text: trimmed })
  }

  /** Hide one of your own messages (the entry stays in every member's log). */
  deleteMessage(groupId: string, id: string): Promise<Entry> {
    return this.commit(groupId, 'chat.deleted', { id })
  }

  // ---- export / import ----------------------------------------------------------------------

  exportData(): ExportFile {
    return {
      app: 'bardesk',
      version: 1,
      exportedAt: this.now(),
      groups: this.visibleGroups().map((g) => ({ id: g.local.id, entries: g.model.entries })),
    }
  }

  /** Merge an export file; returns the number of new entries. */
  async importData(file: ExportFile): Promise<number> {
    if (file?.app !== 'bardesk' || !Array.isArray(file.groups)) throw new Error('Not a Bardesk export')
    let added = 0
    await this.serial(async () => {
      for (const { id, entries } of file.groups) {
        const group = this.groups.get(id) ?? (await this.addLocalGroup(id, 'member'))
        if (group.local.status === 'joining') group.local.status = 'member'
        const { accepted } = group.model.accept(entries)
        await this.db.entries.bulkPut(accepted)
        await this.saveState(group)
        accepted.forEach((e) => this.clock.observe(e.hlc))
        group.local.seq = Math.max(group.local.seq, group.model.vector[this.deviceId] ?? 0)
        await this.db.groups.put(group.local)
        added += accepted.length
      }
    })
    this.fixActiveGroup()
    this.changed()
    return added
  }
}
