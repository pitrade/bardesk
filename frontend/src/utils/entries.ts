// SPDX-License-Identifier: GPL-3.0-or-later
/** Human-readable log lines and CSV export for group entries. */
import { i18n } from '../i18n'
import { hlcMs } from '../core/hlc'
import { chargedMember, purchaseTotal } from '../core/replay'
import type { Entry, EntryDataMap, GroupState } from '../core/types'

export interface EntryLine {
  who: string
  what: string
  /** money effect in cents on the affected member, if any */
  amount: number | null
  /** member whose balance changes */
  subject: string | null
  time: number
}

function nameOf(state: GroupState, email: string): string {
  return state.members[email]?.displayname ?? email
}

/** Product names by id, including deleted products (taken from the log). */
export function productNames(entries: readonly Entry[]): Record<string, string> {
  const names: Record<string, string> = {}
  for (const e of entries) {
    if (e.type === 'product.added') names[(e.data as EntryDataMap['product.added']).id] = (e.data as { name: string }).name
    if (e.type === 'product.updated') {
      const data = e.data as EntryDataMap['product.updated']
      if (data.name) names[data.id] = data.name
    }
  }
  return names
}

/** "Beer", or "3 × Beer" for more than one. */
export function purchaseLabel(data: EntryDataMap['purchase']): string {
  return (data.quantity ?? 1) > 1 ? `${data.quantity} × ${data.name}` : data.name
}

export function describeEntry(e: Entry, state: GroupState, products: Record<string, string>): EntryLine {
  const t = i18n.global.t
  const line = (what: string, amount: number | null = null, subject: string | null = null): EntryLine => ({
    who: nameOf(state, e.author),
    what,
    amount,
    subject,
    time: hlcMs(e.hlc),
  })
  const d = e.data as never
  switch (e.type) {
    case 'purchase': {
      const data = d as EntryDataMap['purchase']
      const payer = chargedMember(data, e.author)
      const label = payer === e.author ? purchaseLabel(data) : t('entry.purchaseFor', { item: purchaseLabel(data), name: nameOf(state, payer) })
      return line(label, -purchaseTotal(data), payer)
    }
    case 'topup': {
      const data = d as EntryDataMap['topup']
      const label = data.amount >= 0 ? t('entry.topup') : t('entry.correction')
      return line(data.description ? `${label}: ${data.description}` : label, data.amount, e.author)
    }
    case 'settled': {
      const data = d as EntryDataMap['settled']
      return line(t('entry.settled', { name: nameOf(state, data.email) }), data.amount, data.email)
    }
    case 'group.created':
      return line(t('entry.groupCreated', { name: (d as EntryDataMap['group.created']).name }))
    case 'group.updated':
      return line(t('entry.groupUpdated'))
    case 'invite.created':
      return line(t('entry.inviteCreated'))
    case 'invite.revoked':
      return line(t('entry.inviteRevoked'))
    case 'member.joined':
      return line(t('entry.memberJoined', { name: (d as EntryDataMap['member.joined']).displayname }))
    case 'member.renamed':
      return line(t('entry.memberRenamed', { name: (d as EntryDataMap['member.renamed']).displayname }))
    case 'member.role': {
      const data = d as EntryDataMap['member.role']
      return line(t(data.role === 'admin' ? 'entry.promoted' : 'entry.demoted', { name: nameOf(state, data.email) }))
    }
    case 'member.left':
      return line(t('entry.memberLeft'))
    case 'member.removed':
      return line(t('entry.memberRemoved', { name: nameOf(state, (d as EntryDataMap['member.removed']).email) }))
    case 'product.added':
      return line(t('entry.productAdded', { name: (d as EntryDataMap['product.added']).name }))
    case 'product.updated': {
      const id = (d as EntryDataMap['product.updated']).id
      return line(t('entry.productUpdated', { name: products[id] ?? '?' }))
    }
    case 'product.deleted': {
      const id = (d as EntryDataMap['product.deleted']).id
      return line(t('entry.productDeleted', { name: products[id] ?? '?' }))
    }
    default:
      return line(String(e.type))
  }
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The full log as CSV (semicolon-separated, opens directly in Excel/LibreOffice). */
export function toCsv(entries: readonly Entry[], state: GroupState): string {
  const products = productNames(entries)
  const rows: (string | number)[][] = [['time', 'author', 'type', 'description', 'member', 'amount_eur']]
  for (const e of entries) {
    if (e.type.startsWith('chat.')) continue // the chat is not part of the accounts
    const line = describeEntry(e, state, products)
    rows.push([
      new Date(line.time).toISOString(),
      e.author,
      e.type,
      line.what,
      line.subject ?? '',
      line.amount === null ? '' : (line.amount / 100).toFixed(2),
    ])
  }
  return rows.map((row) => row.map(csvCell).join(';')).join('\n')
}

/** Offer a text file to the user (share sheet on phones, download elsewhere). */
export async function saveFile(filename: string, content: string, type: string): Promise<void> {
  const file = new File([content], filename, { type })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      return
    } catch {
      // cancelled or not allowed: fall back to a download
    }
  }
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
