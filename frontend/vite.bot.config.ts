// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// The relay lets exactly the deployed app version sync: the bot carries the version of the
// deployed app (APP_VERSION, e.g. from https://<your domain><BASE_PATH>version.json), else of
// dist/, written by the render step, as the version includes the settings.
const VERSION_FILE = new URL('./dist/version.json', import.meta.url)
if (!process.env.APP_VERSION && !existsSync(VERSION_FILE)) {
  throw new Error('Set APP_VERSION, or build and render the app first (dist/version.json)')
}
const version: string = process.env.APP_VERSION ?? JSON.parse(readFileSync(VERSION_FILE, 'utf8')).version

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  ssr: { noExternal: true },
  build: {
    ssr: 'src/bot/main.ts',
    outDir: '../bot/dist',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'bot.mjs' } },
  },
})
