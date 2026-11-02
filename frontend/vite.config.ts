// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, type Plugin } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_PRIMARY, mugSvg, png } from './icon'
import { DEV_CONFIG } from './src/devConfig'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/**
 * Files the server's render step (backend/app/render.py) writes from the settings. The SW
 * precaches them with the revision "render:<url>", which the render step replaces by the
 * file's hash, so the precache always matches the rendered files.
 */
const RENDERED = ['index.html', 'manifest.webmanifest', 'config.js']

/**
 * The build holds no settings: it leaves the templates for the render step in dist/template/
 * (index.html and sw.js moved there, the build version, the default icon). The dev server
 * serves config.js and the icons with the defaults instead.
 */
function templatePlugin(appVersion: string): Plugin {
  const devIcons: Record<string, () => Buffer | string> = {
    'favicon.svg': () => mugSvg(DEFAULT_PRIMARY, true),
    'icons/icon-192.png': () => png(mugSvg(DEFAULT_PRIMARY), 192),
    'icons/icon-512.png': () => png(mugSvg(DEFAULT_PRIMARY), 512),
    'icons/apple-touch-icon.png': () => png(mugSvg(DEFAULT_PRIMARY), 180),
  }
  let outDir = '' // set for builds only
  return {
    name: 'bardesk-template',
    configResolved(config) {
      if (config.command === 'build') outDir = resolve(config.root, config.build.outDir)
    },
    generateBundle() {
      const emit = (fileName: string, source: string | Buffer) => this.emitFile({ type: 'asset', fileName, source })
      // the relay reads version.json to know which app version may sync (backend/app/relay.py)
      emit('template/version.json', JSON.stringify({ version: appVersion }))
      emit('template/icon.png', png(mugSvg(null), 512))
      emit('template/favicon.svg', mugSvg('__PRIMARY__', true))
    },
    closeBundle: {
      order: 'post', // after vite-plugin-pwa has written sw.js
      sequential: true,
      handler() {
        if (!outDir) return
        mkdirSync(`${outDir}/template`, { recursive: true })
        for (const file of ['index.html', 'sw.js']) renameSync(`${outDir}/${file}`, `${outDir}/template/${file}`)
      },
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').replace(/^\//, '').split('?')[0]
        if (path === 'config.js') {
          res.setHeader('Content-Type', 'text/javascript')
          return res.end(`self.BARDESK_CONFIG = ${JSON.stringify(DEV_CONFIG)}\n`)
        }
        const icon = devIcons[path]
        if (!icon) return next()
        res.setHeader('Content-Type', path.endsWith('.svg') ? 'image/svg+xml' : 'image/png')
        res.end(icon())
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // unique per build: every deploy makes open apps update before they sync again
  const appVersion = command === 'build' ? `${version}+${Date.now().toString(36)}` : 'dev'
  return {
    // relative asset paths: the app's path comes from <base href> (render step: BASE_PATH)
    base: command === 'build' ? './' : '/',
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    plugins: [
      vue(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: false, // written by the render step
        workbox: {
          globIgnores: ['index.html'],
          additionalManifestEntries: RENDERED.map((url) => ({ url, revision: `render:${url}` })),
        },
      }),
      templatePlugin(appVersion),
    ],
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:8000', ws: true },
      },
    },
    build: {
      rollupOptions: {
        output: {
          // libraries rarely change: in their own file, an app update only downloads our code
          // (jsqr stays with the lazily loaded QR scanner)
          manualChunks(id: string) {
            if (id.includes('node_modules') && !id.includes('node_modules/jsqr')) return 'vendor'
          },
        },
      },
    },
    test: {
      environment: 'happy-dom',
      setupFiles: ['src/testing/setup.ts'],
    },
  }
})
