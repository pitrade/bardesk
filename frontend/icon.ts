// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The default app icon: a white beer mug. The build pre-renders it on a transparent
 * background; the server's render step (backend/app/render.py) puts it on the primary colour.
 */
import { Resvg } from '@resvg/resvg-js'

/** Primary colour of the default look (the dev server's icons; deployments: COLOR_PRIMARY). */
export const DEFAULT_PRIMARY = '#d5121e'

/**
 * The mug on `background` (null: transparent, the slats are holes). Full-bleed, fits the
 * maskable safe zone; `rounded` corners for the favicon.
 */
export function mugSvg(background: string | null, rounded = false): string {
  const fill = background ? `<rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="${background}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <mask id="slats"><rect width="512" height="512" fill="#fff"/><g fill="#000"><rect x="196" y="226" width="18" height="112" rx="9"/><rect x="258" y="226" width="18" height="112" rx="9"/></g></mask>
  ${fill}
  <g fill="#fff" mask="url(#slats)">
    <circle cx="186" cy="180" r="34"/><circle cx="236" cy="162" r="40"/><circle cx="290" cy="174" r="36"/>
    <rect x="156" y="182" width="170" height="190" rx="22"/>
  </g>
  <path d="M326 222h30a34 34 0 0 1 34 34v44a34 34 0 0 1-34 34h-30" fill="none" stroke="#fff" stroke-width="26"/>
</svg>`
}

export function png(svg: string, size: number): Buffer {
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng())
}
