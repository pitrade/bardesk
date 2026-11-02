// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The headless client's small HTTP API for a device on the local network (e.g. a small
 * board with a touchscreen or buttons): list members with balances and products with prices,
 * book n items of a product for a member, undo within the undo window. Plain HTTP (small
 * devices may lack the memory for TLS) protected by a bearer token: keep it on the local
 * network, never expose it.
 *
 *   GET  /members   -> [{ email, name, balance }]            most recently booked first, then by name; balance in cents, bookings in their undo window included
 *   GET  /products  -> [{ id, name, price, soldOut }]        price in cents
 *   POST /book      { member, product, quantity } -> { id, total, balance }
 *   POST /undo      { id } -> { undone }
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { TapClient } from '../core/client'
import type { Entry, EntryDataMap } from '../core/types'
import { activeMembers, chargedMember, purchaseTotal, sortedProducts } from '../core/replay'

export interface ApiOptions {
  client: TapClient
  token: string
  port: number
  host?: string
  /** the group to book in; default: the one the bot is in */
  groupId?: string
}

const MAX_BODY = 4096
const MAX_QUANTITY = 99

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const digest = (text: string) => createHash('sha256').update(text).digest()

function authorized(req: IncomingMessage, token: string): boolean {
  const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
  return timingSafeEqual(digest(given), digest(token))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large')
    chunks.push(chunk as Buffer)
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // falls through
  }
  throw new HttpError(400, 'Expected a JSON object')
}

export function startApi(options: ApiOptions): Promise<Server> {
  const { client, token } = options

  const group = () => {
    const found = options.groupId ? client.group(options.groupId) : client.visibleGroups()[0]
    if (!found) throw new HttpError(503, 'Not in a group yet')
    return { id: found.local.id, state: found.model.state, entries: found.model.entries }
  }

  /** Balance including the bookings of this station that are still in their undo window. */
  const balance = (groupId: string, email: string, committed: number) => {
    let pending = 0
    for (const p of client.pending.values()) {
      if (p.group === groupId && chargedMember(p.data, p.author) === email) pending += purchaseTotal(p.data)
    }
    return committed - pending
  }

  /** When each member last had something booked (own or by this station), newest hlc. */
  const lastBooked = (groupId: string, entries: readonly Entry[]) => {
    const last = new Map<string, string>()
    const note = (email: string, hlc: string) => hlc > (last.get(email) ?? '') && last.set(email, hlc)
    for (const e of entries) if (e.type === 'purchase') note(chargedMember(e.data as EntryDataMap['purchase'], e.author), e.hlc)
    for (const p of client.pending.values()) if (p.group === groupId) note(chargedMember(p.data, p.author), p.hlc)
    return last
  }

  async function handle(req: IncomingMessage): Promise<unknown> {
    const route = `${req.method} ${new URL(req.url ?? '/', 'http://x').pathname}`
    if (route === 'GET /members') {
      const { id, state, entries } = group()
      const last = lastBooked(id, entries)
      return activeMembers(state)
        .filter((m) => m.email !== client.email)
        .sort((a, b) => (last.get(b.email) ?? '').localeCompare(last.get(a.email) ?? '') || a.displayname.localeCompare(b.displayname))
        .map((m) => ({ email: m.email, name: m.displayname, balance: balance(id, m.email, m.balance) }))
    }
    if (route === 'GET /products') {
      return sortedProducts(group().state).map((p) => ({ id: p.id, name: p.name, price: p.price, soldOut: p.soldOut }))
    }
    if (route === 'POST /book') {
      const { id, state } = group()
      const { member, product: productId, quantity } = await readJson(req)
      const target = typeof member === 'string' ? state.members[member] : undefined
      if (!target || target.status !== 'active' || target.email === client.email) throw new HttpError(404, 'Unknown member')
      const product = typeof productId === 'string' ? state.products[productId] : undefined
      if (!product) throw new HttpError(404, 'Unknown product')
      if (product.soldOut) throw new HttpError(409, 'Sold out')
      if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > MAX_QUANTITY) {
        throw new HttpError(400, `Quantity must be 1 to ${MAX_QUANTITY}`)
      }
      const pendingId = await client.purchase(id, product, quantity as number, target.email)
      return { id: pendingId, total: product.price * (quantity as number), balance: balance(id, target.email, target.balance) }
    }
    if (route === 'POST /undo') {
      const { id } = await readJson(req)
      return { undone: typeof id === 'string' && (await client.undo(id)) }
    }
    throw new HttpError(404, 'Not found')
  }

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Connection: 'close' })
      res.end(text)
    }
    if (!authorized(req, token)) return send(401, { error: 'Unauthorized' })
    handle(req).then(
      (body) => send(200, body),
      (error) => (error instanceof HttpError ? send(error.status, { error: error.message }) : send(500, { error: 'Internal error' })),
    )
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => resolve(server))
  })
}
