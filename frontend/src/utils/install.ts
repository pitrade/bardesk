// SPDX-License-Identifier: GPL-3.0-or-later
import { ref } from 'vue'

/** Chrome/Android's deferred install prompt (not part of the TS DOM lib). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
}

export const installPrompt = ref<BeforeInstallPromptEvent | null>(null)

export function listenForInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    installPrompt.value = event as BeforeInstallPromptEvent
  })
}

export function isInstalled(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

export function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent)
}

/** A phone where the app can (and should) be installed to the home screen. */
export function canInstall(): boolean {
  return isIos() || isAndroid() || installPrompt.value !== null
}

/** Ask the browser not to evict our IndexedDB (keys and logs) under storage pressure. */
export async function requestPersistentStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.()
  } catch {
    // not supported: nothing to do
  }
}
