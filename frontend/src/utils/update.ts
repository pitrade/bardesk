// SPDX-License-Identifier: GPL-3.0-or-later
import { brand } from '../brand'

/**
 * Load the deployed app version (the relay refused ours with "update required").
 *
 * Fetches the new service worker, waits until it takes over, then reloads. Returns
 * false instead of reloading if we already tried a minute ago, so a stale cache
 * can never cause a reload loop, the UI then offers a manual reload.
 */
const GUARD_KEY = 'bardesk_update_attempt'

export async function updateApp(): Promise<boolean> {
  try {
    if (Date.now() - Number(sessionStorage.getItem(GUARD_KEY) ?? 0) < 60_000) return false
    sessionStorage.setItem(GUARD_KEY, String(Date.now()))
  } catch {
    // storage blocked: still try once
  }
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
  if (registration) {
    await registration.update().catch(() => undefined)
    if (registration.installing || registration.waiting) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
        setTimeout(resolve, 10_000)
      })
    }
  }
  location.reload()
  return true
}

const VERSION_KEY = 'bardesk_version'

/** "3.0.0+muio6dhl" -> "3.0.0 (muio6dhl)" */
export function displayVersion(version = brand.version): string {
  const [release, build] = version.split('+')
  return build ? `${release} (${build})` : release
}

/**
 * The version this app just updated to, or null on first start / no change.
 * Remembers the current version for next time.
 */
export function takeUpdateNote(current = brand.version): string | null {
  try {
    const previous = localStorage.getItem(VERSION_KEY)
    localStorage.setItem(VERSION_KEY, current)
    return previous && previous !== current ? current : null
  } catch {
    return null
  }
}
