// SPDX-License-Identifier: GPL-3.0-or-later
/** Unit tests: what config.js sets in the browser (see src/brand.ts). */
import { DEV_CONFIG } from '../devConfig'

globalThis.BARDESK_CONFIG = structuredClone(DEV_CONFIG)
