// SPDX-License-Identifier: GPL-3.0-or-later
import type { Hlc } from './types'

/**
 * Hybrid logical clock: wall-clock milliseconds plus a counter.
 *
 * Every timestamp this device issues is greater than every timestamp it has
 * issued or seen before, so an edit made after seeing another edit always sorts
 * after it, even if this device's clock is behind.
 */

const MS_DIGITS = 15
const COUNTER_DIGITS = 6
/** Received timestamps further ahead than this don't drag our clock forward. */
const MAX_FORWARD_DRIFT_MS = 60 * 60 * 1000

export function encodeHlc(ms: number, counter: number): Hlc {
  return `${String(ms).padStart(MS_DIGITS, '0')}.${String(counter).padStart(COUNTER_DIGITS, '0')}`
}

export function decodeHlc(hlc: Hlc): { ms: number; counter: number } {
  const [ms, counter] = hlc.split('.')
  return { ms: Number(ms), counter: Number(counter) }
}

export function hlcMs(hlc: Hlc): number {
  return decodeHlc(hlc).ms
}

export class HlcClock {
  private last: Hlc = encodeHlc(0, 0)
  private readonly now: () => number

  /** `now` is the corrected wall clock (device time + server offset). */
  constructor(now: () => number) {
    this.now = now
  }

  next(): Hlc {
    const wall = this.now()
    const { ms, counter } = decodeHlc(this.last)
    this.last = wall > ms ? encodeHlc(wall, 0) : encodeHlc(ms, counter + 1)
    return this.last
  }

  /** Remember a timestamp seen from another device. */
  observe(hlc: Hlc): void {
    if (hlc <= this.last) return
    if (hlcMs(hlc) > this.now() + MAX_FORWARD_DRIFT_MS) return
    this.last = hlc
  }
}
