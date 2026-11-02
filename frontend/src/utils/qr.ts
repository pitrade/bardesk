// SPDX-License-Identifier: GPL-3.0-or-later
/** QR decoding for the in-app scanner, only loaded together with the scanner. */
import jsQR from 'jsqr'

/** Decode a QR code from RGBA pixels (a camera frame drawn to a canvas); null if none found. */
export function decodeQr(image: { data: Uint8ClampedArray; width: number; height: number }): string | null {
  return jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })?.data ?? null
}
