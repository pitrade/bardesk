// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Build version baked in at build time (vite.config.ts); 'dev' when not built. The app syncs
 * with brand.version (build version + settings hash, src/brand.ts).
 */
declare const __APP_VERSION__: string
