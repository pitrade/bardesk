// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * In-memory stand-in for the relay server, for tests.
 *
 * Behaves like backend/app/relay.py (rooms, presence, per-recipient forwarding)
 * but lets a test switch devices on and offline at will. Authentication is
 * skipped: the email passed to connect() is trusted.
 */
import type { Identity } from '../db'
import type { Relay, RelayHandlers } from '../relay'

interface Connection {
  email: string
  key: string
  handlers: RelayHandlers
  rooms: Set<string>
  online: boolean
}

export class MemoryHub {
  private connections = new Map<string, Connection>()
  private rooms = new Map<string, Set<string>>()

  /** RelayConnector for TapClient: `new TapClient({ connect: hub.connector, ... })` */
  connector = (identity: Identity, key: string, handlers: RelayHandlers): Relay => {
    const email = identity.email
    const previous = this.connections.get(email)
    if (previous) this.goOffline(previous)
    const connection: Connection = { email, key, handlers, rooms: new Set(previous?.rooms ?? []), online: false }
    this.connections.set(email, connection)
    this.goOnline(connection)
    const hub = this
    return {
      join(rooms) {
        for (const room of rooms) {
          if (connection.rooms.has(room)) continue
          connection.rooms.add(room)
          if (connection.online && hub.connections.get(email) === connection) hub.enter(connection, room)
        }
      },
      leave(room) {
        connection.rooms.delete(room)
        hub.exit(connection, room)
      },
      send(room, to, data) {
        if (!connection.online || !hub.rooms.get(room)?.has(email)) return
        const target = hub.connections.get(to)
        if (target?.online && hub.rooms.get(room)?.has(to)) target.handlers.message(room, email, data)
      },
      deleteAccount() {
        hub.goOffline(connection)
        hub.connections.delete(email)
        connection.handlers.status('deleted')
      },
      close() {
        hub.goOffline(connection)
      },
    }
  }

  /** Take a device offline (app closed, no network). */
  offline(email: string): void {
    const connection = this.connections.get(email)
    if (connection) this.goOffline(connection)
  }

  /** Bring a device back online; it re-enters all its rooms. */
  online(email: string): void {
    const connection = this.connections.get(email)
    if (connection && !connection.online) this.goOnline(connection)
  }

  present(room: string): string[] {
    return [...(this.rooms.get(room) ?? [])]
  }

  private goOnline(connection: Connection): void {
    connection.online = true
    connection.handlers.status('online')
    for (const room of connection.rooms) this.enter(connection, room)
  }

  private goOffline(connection: Connection): void {
    if (!connection.online) return
    connection.online = false
    for (const room of connection.rooms) this.exit(connection, room)
    connection.handlers.status('offline')
  }

  private enter(connection: Connection, room: string): void {
    const present = this.rooms.get(room) ?? new Set<string>()
    this.rooms.set(room, present)
    if (present.has(connection.email)) return
    const others = [...present].map((email) => this.connections.get(email)!)
    present.add(connection.email)
    connection.handlers.presence(room, others.map((o) => ({ email: o.email, key: o.key })))
    for (const other of others) other.handlers.peerJoined(room, { email: connection.email, key: connection.key })
  }

  private exit(connection: Connection, room: string): void {
    const present = this.rooms.get(room)
    if (!present?.delete(connection.email)) return
    for (const email of present) this.connections.get(email)?.handlers.peerLeft(room, connection.email)
  }
}
