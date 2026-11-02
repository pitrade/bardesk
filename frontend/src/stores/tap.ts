// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bridges the framework-free TapClient to Vue.
 *
 * The client mutates its state in place; after every change the store builds a
 * fresh, plain `view` snapshot so Vue re-renders reliably.
 */
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { TapClient, type JoinRejection, type Notice } from '../core/client'
import { TapDb, type PendingPurchase } from '../core/db'
import { brand } from '../brand'
import { WebSocketRelay, relayUrl, type RelayStatus } from '../core/relay'
import { deviceDbName } from '../utils/dbName'
import { isAdmin, sortedProducts } from '../core/replay'
import type { ChatMessage, Entry, GroupState, Member, Product } from '../core/types'

export interface GroupView {
  id: string
  name: string
  description: string
  state: GroupState
  me: Member | undefined
  isAdmin: boolean
  /** own balance including purchases in their undo window */
  balance: number
  products: Product[]
  entries: Entry[]
  pending: PendingPurchase[]
  /** members connected right now, me included ([] while I'm offline) */
  online: string[]
  messages: ChatMessage[]
}

export interface JoiningView {
  id: string
  hasToken: boolean
  error: JoinRejection | undefined
}

export interface AppView {
  email: string
  relayStatus: RelayStatus
  notice: Notice | null
  activeGroupId: string | null
  groups: GroupView[]
  joining: JoiningView[]
}

function buildView(client: TapClient): AppView {
  const pending = [...client.pending.values()]
  return {
    email: client.email,
    relayStatus: client.relayStatus,
    notice: client.notice,
    activeGroupId: client.activeGroupId,
    groups: client.visibleGroups().map(({ local, model }) => {
      const state = structuredClone(model.state)
      return {
        id: local.id,
        name: state.name,
        description: state.description,
        state,
        me: state.members[client.email],
        isAdmin: isAdmin(state, client.email),
        balance: client.balance(local.id),
        products: sortedProducts(state),
        entries: [...model.entries],
        pending: pending.filter((p) => p.group === local.id),
        online: client.relayStatus === 'online' ? [client.email, ...client.onlineMembers(local.id)] : [],
        messages: state.messages,
      }
    }),
    joining: client.joiningGroups().map(({ local }) => ({
      id: local.id,
      hasToken: !!local.token,
      error: client.joinErrors.get(local.id),
    })),
  }
}

export const useTap = defineStore('tap', () => {
  const view = shallowRef<AppView>({
    email: '',
    relayStatus: 'offline',
    notice: null,
    activeGroupId: null,
    groups: [],
    joining: [],
  })
  let client: TapClient | null = null
  let scheduled = false
  // this device's database: the server's DB_NAME at its first start (brand.dbName may differ later)
  const dbName = deviceDbName(brand.dbName)

  async function start(): Promise<void> {
    if (client) return
    client = new TapClient({
      db: new TapDb(dbName),
      connect: (identity, _publicKey, handlers) =>
        new WebSocketRelay(relayUrl(), identity.email, identity.keyPair.privateKey, handlers, brand.version),
    })
    client.subscribe(() => {
      // batch bursts of changes (e.g. a full log arriving) into one rebuild
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        view.value = buildView(client!)
      })
    })
    await client.init()
    view.value = buildView(client)
  }

  function tap(): TapClient {
    if (!client) throw new Error('TapClient not started')
    return client
  }

  function group(id: string | null | undefined): GroupView | undefined {
    return view.value.groups.find((g) => g.id === id)
  }

  return { view, dbName, start, tap, group }
})
