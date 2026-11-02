// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Connection to the live relay (backend/app/relay.py).
 *
 * The sync engine only talks to the `Relay` interface, so tests can swap in an
 * in-memory relay (core/testing/memoryRelay.ts).
 */
import { decryptChallenge, type ChallengeBox } from './crypto'

export interface PeerInfo {
  email: string
  key: string
}

export type RelayStatus = 'offline' | 'connecting' | 'online' | 'replaced' | 'superseded' | 'deleted' | 'outdated'

export interface RelayHandlers {
  status(status: RelayStatus): void
  /** Full list of other peers present, sent when we join a room. */
  presence(room: string, peers: PeerInfo[]): void
  peerJoined(room: string, peer: PeerInfo): void
  peerLeft(room: string, email: string): void
  message(room: string, from: string, data: string): void
  /** Server time in ms (on connect and every pong) for clock correction. */
  serverTime(ms: number): void
}

export interface Relay {
  join(rooms: string[]): void
  leave(room: string): void
  send(room: string, to: string, data: string): void
  deleteAccount(): void
  close(): void
}

// Cloudflare closes idle WebSockets after ~100s; the relay drops a device after 60s of silence
const PING_INTERVAL_MS = 25_000
const MAX_BACKOFF_MS = 30_000
const FINAL_CLOSE_CODES: Record<number, RelayStatus> = {
  4001: 'replaced',
  4002: 'superseded',
  4004: 'deleted',
  4005: 'outdated', // another app version is deployed: update first, then sync
}

/** Browsers only; tests run in Node, where there is no document. */
function hidden(): boolean {
  return globalThis.document?.visibilityState === 'hidden'
}

/** The relay below the app's path (<base href>). Browsers only. */
export function relayUrl(): string {
  const url = new URL('api/ws', document.baseURI)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

export class WebSocketRelay implements Relay {
  private ws: WebSocket | null = null
  private rooms = new Set<string>()
  private ping: ReturnType<typeof setInterval> | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private backoff = 1000
  private closed = false
  private ready = false
  private pendingDelete = false
  private readonly url: string
  private readonly email: string
  private readonly privateKey: CryptoKey
  private readonly handlers: RelayHandlers
  private readonly version: string

  /** `version`: the app version the relay must see (the deployed one, else 4005) */
  constructor(url: string, email: string, privateKey: CryptoKey, handlers: RelayHandlers, version = __APP_VERSION__) {
    this.url = url
    this.version = version
    this.email = email
    this.privateKey = privateKey
    this.handlers = handlers
    this.reconnectNow()
    // reconnect as soon as the network is back (browsers only; tests run in Node)
    globalThis.addEventListener?.('online', this.reconnectNow)
    globalThis.document?.addEventListener('visibilitychange', this.onVisibility)
  }

  join(rooms: string[]): void {
    const fresh = rooms.filter((room) => !this.rooms.has(room))
    fresh.forEach((room) => this.rooms.add(room))
    if (fresh.length) this.sendRaw({ t: 'join', rooms: fresh })
  }

  leave(room: string): void {
    if (this.rooms.delete(room)) this.sendRaw({ t: 'leave', room })
  }

  send(room: string, to: string, data: string): void {
    this.sendRaw({ t: 'send', room, to, data })
  }

  deleteAccount(): void {
    if (this.ready) this.sendRaw({ t: 'delete_account' })
    else this.pendingDelete = true
  }

  close(): void {
    this.closed = true
    globalThis.removeEventListener?.('online', this.reconnectNow)
    globalThis.document?.removeEventListener('visibilitychange', this.onVisibility)
    clearInterval(this.ping)
    clearTimeout(this.retry)
    this.ws?.close()
    this.handlers.status('offline')
  }

  private sendRaw(message: object): void {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  /**
   * Online means "app in the foreground": a hidden app closes its connection, so the
   * others see it leave at once (an app is always hidden before it gets killed).
   * Only a device that vanishes without a signal is left to the server's idle timeout.
   */
  private onVisibility = (): void => {
    if (!hidden()) return this.reconnectNow()
    clearTimeout(this.retry)
    this.ws?.close()
  }

  private reconnectNow = (): void => {
    if (this.closed || this.ws || hidden()) return
    clearTimeout(this.retry)
    this.backoff = 1000
    this.connect()
  }

  private connect(): void {
    this.handlers.status('connecting')
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', email: this.email, version: this.version }))
    ws.onmessage = (event) => void this.onMessage(ws, JSON.parse(String(event.data)))
    ws.onclose = (event) => this.onClose(event.code)
  }

  private async onMessage(ws: WebSocket, message: Record<string, unknown>): Promise<void> {
    switch (message.t) {
      case 'challenge': {
        const nonce = await decryptChallenge(this.privateKey, message as unknown as ChallengeBox)
        ws.send(JSON.stringify({ t: 'auth', nonce }))
        break
      }
      case 'welcome':
        this.ready = true
        this.backoff = 1000
        this.handlers.serverTime(message.time as number)
        this.handlers.status('online')
        if (this.rooms.size) this.sendRaw({ t: 'join', rooms: [...this.rooms] })
        if (this.pendingDelete) this.sendRaw({ t: 'delete_account' })
        this.ping = setInterval(() => this.sendRaw({ t: 'ping' }), PING_INTERVAL_MS)
        break
      case 'pong':
        this.handlers.serverTime(message.time as number)
        break
      case 'presence':
        this.handlers.presence(message.room as string, message.peers as PeerInfo[])
        break
      case 'peer_joined':
        this.handlers.peerJoined(message.room as string, message.peer as PeerInfo)
        break
      case 'peer_left':
        this.handlers.peerLeft(message.room as string, message.email as string)
        break
      case 'msg':
        this.handlers.message(message.room as string, message.from as string, message.data as string)
        break
    }
  }

  private onClose(code: number): void {
    this.ws = null
    this.ready = false
    clearInterval(this.ping)
    const final = FINAL_CLOSE_CODES[code]
    if (final || code === 4003) {
      this.closed = true
      this.handlers.status(final ?? 'replaced')
      return
    }
    this.handlers.status('offline')
    if (this.closed || hidden()) return
    this.retry = setTimeout(() => this.connect(), this.backoff)
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
  }
}
