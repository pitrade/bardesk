// @vitest-environment node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * WebSocketRelay against a scripted fake WebSocket: handshake, clock sync,
 * re-joining rooms after a reconnect, backoff, keepalive and final close codes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketRelay, type RelayHandlers, type RelayStatus } from './relay'

// Challenge produced by backend/app/crypto.py (same vector as crypto.test.ts)
const JWK = {
  kty: 'EC',
  crv: 'P-256',
  d: '8B9ymSwvLwCStY_5UU3ah4KJKjYtcoDbC6wcUKmux4Y',
  x: 'VYROd5ipAJ4T--uYMypV1nydq_j3PiRjfUx4xQVAjrc',
  y: 'BPjeImlVsMvEcAJVTkjpQX4pJvADzHeG3evH5AEvDu4',
}
const CHALLENGE = {
  t: 'challenge',
  epk: 'BG5a52DgON8U4PzY3z7iEXIAndNWx4G96qG2rgwVlBU-Vie5zlTkjxR02VM3PGnOSPUSI6iExNv1pEZ2ttDjH-I',
  iv: 'Pn3nJLmu52vkftEo',
  ct: 'Gql5-SfrNSmHJmSMbN-ldpilalvyNiTydSGWTsfgTkfJtmddOk20OkVc19MX0M7a',
}
const NONCE = 'YmFyZGVzay1jaGFsbGVuZ2UtdGVzdC12ZWN0b3ItMDE'

class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.drop(1000)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  drop(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  types() {
    return this.sent.map((m) => m.t)
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Wait for real async work (Web Crypto), up to 5 s; setTimeout is faked, Date is not. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) await flush()
  expect(condition()).toBe(true)
}

let statuses: RelayStatus[]
let times: number[]
let handlers: RelayHandlers
let privateKey: CryptoKey

beforeEach(async () => {
  FakeSocket.all = []
  statuses = []
  times = []
  handlers = {
    status: (s) => statuses.push(s),
    serverTime: (ms) => times.push(ms),
    presence: () => {},
    peerJoined: () => {},
    peerLeft: () => {},
    message: () => {},
  }
  privateKey = await crypto.subtle.importKey('jwk', JWK, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Run the auth handshake on the latest socket. */
async function handshake(serverTime = 1_000): Promise<FakeSocket> {
  const ws = FakeSocket.all[FakeSocket.all.length - 1]
  ws.open()
  ws.receive(CHALLENGE)
  await until(() => ws.types().includes('auth'))
  ws.receive({ t: 'welcome', time: serverTime })
  return ws
}

describe('WebSocketRelay', () => {
  it('authenticates by decrypting the challenge, then reports online and server time', async () => {
    const relay = new WebSocketRelay('ws://relay/api/ws', 'alice@x.de', privateKey, handlers)
    const ws = await handshake(42_000)
    expect(ws.sent[0]).toEqual({ t: 'hello', email: 'alice@x.de', version: 'dev' })
    expect(ws.sent[1]).toEqual({ t: 'auth', nonce: NONCE })
    expect(statuses).toEqual(['connecting', 'online'])
    expect(times).toEqual([42_000])
    relay.close()
  })

  it('reconnects with backoff and re-joins its rooms', async () => {
    const relay = new WebSocketRelay('ws://relay/api/ws', 'alice@x.de', privateKey, handlers)
    const first = await handshake()
    relay.join(['room-1', 'room-2'])
    expect(first.sent.at(-1)).toEqual({ t: 'join', rooms: ['room-1', 'room-2'] })

    first.drop(1006) // network gone
    expect(statuses.at(-1)).toBe('offline')
    vi.advanceTimersByTime(999)
    expect(FakeSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.all).toHaveLength(2)

    FakeSocket.all[1].drop(1006) // still down: next wait doubles
    vi.advanceTimersByTime(1999)
    expect(FakeSocket.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    const third = await handshake()
    expect(third.sent.at(-1)).toEqual({ t: 'join', rooms: ['room-1', 'room-2'] })
    expect(statuses.at(-1)).toBe('online')
    relay.close()
  })

  it('pings every 25 seconds and takes the server time from pongs', async () => {
    const relay = new WebSocketRelay('ws://relay/api/ws', 'alice@x.de', privateKey, handlers)
    const ws = await handshake(1_000)
    vi.advanceTimersByTime(25_000)
    expect(ws.types().at(-1)).toBe('ping')
    ws.receive({ t: 'pong', time: 26_000 })
    expect(times).toEqual([1_000, 26_000])
    relay.close()
  })

  it.each([
    [4001, 'replaced'],
    [4002, 'superseded'],
    [4003, 'replaced'],
    [4004, 'deleted'],
    [4005, 'outdated'],
  ])('close code %i ends with status %s and no reconnect', async (code, status) => {
    new WebSocketRelay('ws://relay/api/ws', 'alice@x.de', privateKey, handlers)
    const ws = await handshake()
    ws.drop(code)
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(statuses.at(-1)).toBe(status)
  })

  it('holds a delete request until authenticated', async () => {
    const relay = new WebSocketRelay('ws://relay/api/ws', 'alice@x.de', privateKey, handlers)
    relay.deleteAccount()
    const ws = await handshake()
    expect(ws.types()).toContain('delete_account')
  })
})
