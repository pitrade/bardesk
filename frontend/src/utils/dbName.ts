// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The IndexedDB name of this device. A device takes the server's DB_NAME (config.js) at its
 * first start and keeps it, so a later change on the server never hides its data.
 */
export const DB_NAME_KEY = 'bardesk_db_name'

export function deviceDbName(serverName: string): string {
  try {
    const stored = localStorage.getItem(DB_NAME_KEY)
    if (stored) return stored
    localStorage.setItem(DB_NAME_KEY, serverName)
  } catch {
    // storage blocked: the server's name
  }
  return serverName
}
