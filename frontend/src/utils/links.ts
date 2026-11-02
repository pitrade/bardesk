// SPDX-License-Identifier: GPL-3.0-or-later
/** Invite and group links. */

export interface JoinLink {
  id: string
  token?: string
}

/** Extract group id (and invite token) from an invite or group link. */
export function parseJoinLink(text: string): JoinLink | null {
  const match = text.trim().match(/join\/([0-9a-f-]{36})(?:\?t=([\w-]+))?/i)
  if (!match) return null
  return match[2] ? { id: match[1], token: match[2] } : { id: match[1] }
}
