// Seeded dice. The state is one 32-bit number stored in the save, so a run
// reloaded mid-fight rolls exactly as it would have (and tests can replay).

export class Rng {
  state: number

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9
  }

  /** mulberry32: tiny, fast, and good enough for dice. */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Inclusive on both ends. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)]
  }

  /** Picks by weight; entries with weight <= 0 never come up. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((n, [, w]) => n + Math.max(0, w), 0)
    let r = this.next() * total
    for (const [value, w] of entries) {
      if (w <= 0) continue
      r -= w
      if (r < 0) return value
    }
    return entries[entries.length - 1][0]
  }

  shuffle<T>(list: T[]): T[] {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
    }
    return list
  }

  d(sides: number): number {
    return this.int(1, sides)
  }

  /** "2d6+3", "1d4", "8d6", "5". Crits double the dice, not the modifier. */
  roll(expr: string, crit = false): number {
    const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(expr.replace(/\s+/g, ''))
    if (!m) return Number(expr) || 0
    const count = Number(m[1]) * (crit ? 2 : 1)
    let total = Number(m[3] ?? 0)
    for (let i = 0; i < count; i++) total += this.d(Number(m[2]))
    return total
  }
}

/** Average of a dice expression, for balancing and level-up HP. */
export function average(expr: string): number {
  const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(expr.replace(/\s+/g, ''))
  if (!m) return Number(expr) || 0
  return (Number(m[1]) * (Number(m[2]) + 1)) / 2 + Number(m[3] ?? 0)
}

/** Adds dice of the same size together: "1d6" + 2 more -> "3d6". */
export function moreDice(expr: string, extra: number): string {
  const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(expr)
  if (!m) return expr
  return `${Number(m[1]) + extra}d${m[2]}${m[3] ?? ''}`
}
