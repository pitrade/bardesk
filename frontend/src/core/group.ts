// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * One group's log in memory: entries, version vector and derived state.
 *
 * Entries from a device are accepted strictly in seq order (#5 waits for #4),
 * so a vector entry "device D up to n" always means "all of D's #1..n".
 */
import { applyEntry, compareEntries, replay } from './replay'
import type { Entry, GroupState, Vector } from './types'

export interface AcceptResult {
  accepted: Entry[]
  /** Some entries were skipped because an earlier one from the same device is missing. */
  gap: boolean
}

function byDeviceAndSeq(a: Entry, b: Entry): number {
  return a.device === b.device ? a.seq - b.seq : a.device < b.device ? -1 : 1
}

export class GroupModel {
  /** sorted by (hlc, device, seq) */
  entries: Entry[] = []
  vector: Vector = {}
  state: GroupState
  readonly id: string

  constructor(id: string, entries: Entry[] = []) {
    this.id = id
    this.state = replay(id, [])
    this.accept(entries)
  }

  /** Rebuild from stored entries plus a cached state, no replay (see CachedState in db.ts). */
  static restore(id: string, entries: Entry[], state: GroupState): GroupModel {
    const model = new GroupModel(id)
    model.entries = [...entries].sort(compareEntries)
    for (const entry of model.entries) {
      model.vector[entry.device] = Math.max(model.vector[entry.device] ?? 0, entry.seq)
    }
    model.state = state
    return model
  }

  accept(incoming: readonly Entry[]): AcceptResult {
    const accepted: Entry[] = []
    let gap = false
    for (const entry of [...incoming].sort(byDeviceAndSeq)) {
      if (entry.group !== this.id) continue
      const have = this.vector[entry.device] ?? 0
      if (entry.seq <= have) continue // duplicate
      if (entry.seq !== have + 1) {
        gap = true
        continue
      }
      this.vector[entry.device] = entry.seq
      accepted.push(entry)
    }
    if (accepted.length) this.integrate(accepted)
    return { accepted, gap }
  }

  /** Entries the holder of `vector` is missing, in the order they must be accepted. */
  missingFor(vector: Vector): Entry[] {
    return this.entries.filter((e) => e.seq > (vector[e.device] ?? 0)).sort(byDeviceAndSeq)
  }

  private integrate(accepted: Entry[]): void {
    const newest = this.entries[this.entries.length - 1]
    const sorted = [...accepted].sort(compareEntries)
    const inOrder = !newest || compareEntries(newest, sorted[0]) < 0
    this.entries.push(...sorted)
    if (inOrder) {
      for (const entry of sorted) applyEntry(this.state, entry)
    } else {
      // a late entry sorts before ones already applied: replay (milliseconds at the scale of a small community)
      this.entries.sort(compareEntries)
      this.state = replay(this.id, this.entries)
    }
  }
}
