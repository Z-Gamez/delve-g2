// Item instances: names, descriptions, values and loot rolls.

import type { Rng } from './rng.ts'
import {
  WEAPONS, ARMORS, CONSUMABLES, TRINKETS, PROPS, CLASS_WEAPONS,
  type ClassId, type WeaponProp,
} from './data.ts'
import type { IconName } from '../icons.gen.ts'

export type ItemKind = 'weapon' | 'armor' | 'trinket' | 'potion' | 'scroll' | 'key'

export interface Item {
  uid: number
  kind: ItemKind
  base: string
  plus: number
  prop?: WeaponProp
  qty: number
}

export function isConsumable(item: Item): boolean {
  return item.kind === 'potion' || item.kind === 'scroll' || item.kind === 'key'
}

export function itemName(item: Item): string {
  const plus = item.plus ? `+${item.plus} ` : ''
  switch (item.kind) {
    case 'weapon': {
      const prop = item.prop ? `${PROPS[item.prop].name} ` : ''
      return `${plus}${prop}${WEAPONS[item.base].name}`
    }
    case 'armor':
      return `${plus}${ARMORS[item.base].name}`
    case 'trinket':
      return TRINKETS[item.base].name
    default:
      return CONSUMABLES[item.base].name
  }
}

/** A few words of what it does, for the lens. */
export function itemDesc(item: Item): string {
  switch (item.kind) {
    case 'weapon': {
      const w = WEAPONS[item.base]
      const bits = [`${w.dice}${item.plus ? `+${item.plus}` : ''}`]
      if (w.ranged) bits.push('ranged')
      else if (w.finesse) bits.push('finesse')
      if (w.heavy) bits.push('two-handed')
      if (item.prop) bits.push(PROPS[item.prop].blurb)
      return bits.join(', ')
    }
    case 'armor': {
      const a = ARMORS[item.base]
      const dex = a.dexCap === null ? ' + DEX' : a.dexCap ? ` + DEX (max ${a.dexCap})` : ''
      return `AC ${a.base + item.plus}${dex}, ${a.type}`
    }
    case 'trinket':
      return TRINKETS[item.base].blurb
    default:
      return CONSUMABLES[item.base].blurb
  }
}

export function itemIcon(item: Item): IconName {
  switch (item.kind) {
    case 'weapon':
      return WEAPONS[item.base].heavy ? 'two-handed-sword' : 'broadsword'
    case 'armor':
      return 'chest-armor'
    case 'trinket':
      return TRINKETS[item.base].icon
    default:
      return CONSUMABLES[item.base].icon
  }
}

export function itemValue(item: Item): number {
  switch (item.kind) {
    case 'weapon':
      return WEAPONS[item.base].value + item.plus * 120 + (item.prop ? 150 : 0)
    case 'armor':
      return ARMORS[item.base].value + item.plus * 150
    case 'trinket':
      return TRINKETS[item.base].value
    default:
      return CONSUMABLES[item.base].value
  }
}

export function salvageValue(item: Item): number {
  return Math.max(1, Math.floor(itemValue(item) / 2))
}

/** Spoken aliases for an item, so "drink the red potion" finds it. */
export function itemWords(item: Item): string[] {
  const name = itemName(item).toLowerCase()
  if (isConsumable(item)) return [...CONSUMABLES[item.base].words, name]
  return [name, name.replace(/^\+\d+ /, '')]
}

export interface LootOptions {
  floor: number
  cls: ClassId
  /** 0 normal, 1 better, 2 boss. */
  quality: number
  /** Trinkets the hero already owns aren't dropped twice. */
  owned: string[]
  uid: () => number
}

export function rollItem(rng: Rng, o: LootOptions): Item {
  const f = o.floor + o.quality * 3
  const kind = rng.weighted<ItemKind>([
    ['potion', o.quality ? 22 : 40],
    ['scroll', 15],
    ['weapon', 14 + o.quality * 8],
    ['armor', 11 + o.quality * 6],
    ['trinket', f >= 2 ? 8 + o.quality * 8 : 0],
    ['key', o.quality ? 0 : 6],
  ])

  if (kind === 'weapon' || kind === 'armor') {
    const plus = rng.weighted<number>([
      [0, 10],
      [1, 2 + f * 0.5],
      [2, Math.max(0, f - 4) * 0.35],
      [3, Math.max(0, f - 9) * 0.25],
      [4, Math.max(0, f - 14) * 0.2],
      [5, Math.max(0, f - 19) * 0.2],
    ])
    if (kind === 'weapon') {
      const pool = rng.chance(0.75) ? CLASS_WEAPONS[o.cls] : Object.keys(WEAPONS)
      const propChance = f >= 3 ? Math.min(0.45, 0.12 + f * 0.015) : 0
      const prop = rng.chance(propChance) ? rng.pick(Object.keys(PROPS) as WeaponProp[]) : undefined
      return { uid: o.uid(), kind, base: rng.pick(pool), plus, prop, qty: 1 }
    }
    // Better armor turns up deeper.
    const armors = Object.values(ARMORS).filter(a => a.value <= 40 + f * 30)
    return { uid: o.uid(), kind, base: rng.pick(armors).id, plus, qty: 1 }
  }

  if (kind === 'trinket') {
    const pool = Object.values(TRINKETS).filter(t => t.floor <= f && !o.owned.includes(t.id))
    if (pool.length) return { uid: o.uid(), kind, base: rng.pick(pool).id, plus: 0, qty: 1 }
  }

  let want = kind === 'trinket' ? 'potion' : kind
  // No scrolls turn up on floor 1; fall back to a potion there.
  if (!Object.values(CONSUMABLES).some(c => c.kind === want && c.floor <= f)) want = 'potion'
  const pool = Object.values(CONSUMABLES).filter(c => c.kind === want && c.floor <= f)
  // Healing is the one thing you always want more of.
  const pick = want === 'potion' && rng.chance(0.45) ? bestHealing(f) : rng.pick(pool).id
  return { uid: o.uid(), kind: CONSUMABLES[pick].kind, base: pick, plus: 0, qty: 1 }
}

export function bestHealing(floor: number): string {
  return floor >= 9 ? 'superior-healing' : floor >= 4 ? 'greater-healing' : 'healing'
}

export function consumable(base: string, uid: number, qty = 1): Item {
  return { uid, kind: CONSUMABLES[base].kind, base, plus: 0, qty }
}
