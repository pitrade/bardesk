// SPDX-License-Identifier: GPL-3.0-or-later
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import { useTap } from './stores/tap'
import { listenForInstallPrompt, requestPersistentStorage } from './utils/install'
import './style.css'

listenForInstallPrompt()
void requestPersistentStorage()

const app = createApp(App)
app.use(createPinia())
app.use(i18n)

// load the local database (and the device key) before the first route guard runs
void useTap()
  .start()
  .then(() => {
    app.use(router)
    app.mount('#app')
    preloadWhenIdle()
  })

/** Fetch the QR scanner (the only lazy part) once the app is idle, so the first scan opens instantly. */
function preloadWhenIdle() {
  const load = () => void import('./components/QrScanner.vue')
  if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 5000 })
  else setTimeout(load, 2000)
}
