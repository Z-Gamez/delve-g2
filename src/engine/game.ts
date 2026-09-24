// The rules engine: one run of Delve, from picking a class to the grave.
//
// Pure TypeScript, no DOM, so the tests can play it headless. Everything the
// run needs to resume lives in `Run`, which is plain JSON and saved after
// every action; the dice are seeded from `run.rng` for the same reason.
//
// The engine only ever offers a list of Options and resolves the one picked.
// Voice, gestures and the phone all funnel into choose(); anything the player
// says that isn't an option is a "ruling" the AI Dungeon Master proposes and
// resolve() applies -- the DM picks a check and the stakes, but the dice and
// the size of every effect stay here, so it can't hand out a +10 sword.

import { Rng } from './rng.ts'
import {
  CLASSES, SKILLS, WEAPONS, ARMORS, CONSUMABLES, TRINKETS, MONSTERS, BOSSES, ELITES, COMPANIONS, PERKS,
  EVENTS, ROOM_INFO, ABILITY_NAME, TRINKET_SLOTS, HERO_NAMES, EVENT_EFFECTS, COMBAT_EFFECTS,
  classDef, themeFor,
  type Ability, type Stats, type ClassId, type Trait, type MonsterDef, type CompanionDef,
  type RoomKind, type EventDef, type EffectKind, type Outcome, type CompanionAbility,
} from './data.ts'
import {
  rollItem, itemName, itemDesc, itemIcon, itemValue, salvageValue, isConsumable, consumable, bestHealing, itemWords,
  type Item,
} from './items.ts'
import type { IconName } from '../icons.gen.ts'

export type { Item } from './items.ts'

/** Effect durations that aren't counted in rounds. */
const FIGHT = 500
const FLOOR = 999
/** Rooms per floor before the stairs; the last is the boss on every third floor. */
export const ROOMS_PER_FLOOR = 5
const HALL_SIZE = 10

export type Mode =
  | 'class' | 'name' | 'doors' | 'combat' | 'loot' | 'treasure' | 'shrine' | 'merchant'
  | 'rest' | 'trap' | 'event' | 'recruit' | 'stairs' | 'perk' | 'dead'

export interface Hero {
  name: string
  cls: ClassId
  level: number
  xp: number
  hp: number
  /** Max HP before Constitution and perks, which are added live. */
  hpBase: number
  tempHp: number
  gold: number
  stats: Stats
  weapon: Item
  armor: Item | null
  trinkets: Item[]
  pack: Item[]
  uses: Record<string, number>
  perks: Record<string, number>
  fx: Record<string, number>
  poison: number
}

export interface Companion {
  id: string
  hp: number
  cooldown: number
  stunned: number
}

export interface Enemy {
  uid: number
  id: string
  name: string
  icon: IconName
  hp: number
  maxHp: number
  ac: number
  atk: number
  dmg: string
  dmgBonus: number
  xp: number
  gold: number
  traits: Trait[]
  verb: string
  death: string
  words: string[]
  tier: number
  boss: boolean
  elite: boolean
  fx: Record<string, number>
  poison: number
  stole: boolean
}

export type CombatKind = 'fight' | 'elite' | 'boss' | 'mimic' | 'event'

export interface Combat {
  kind: CombatKind
  enemies: Enemy[]
  round: number
  focus: number
  menu: 'main' | 'items'
  used: Record<string, boolean>
  xp: number
  gold: number
}

export interface Door {
  kind: RoomKind
  hint: string
  hidden: boolean
}

export type Room =
  | { kind: 'treasure'; locked: boolean; mimic: boolean; jammed: boolean; stuck: boolean }
  | { kind: 'shrine'; cost: number }
  | { kind: 'merchant'; stock: { item: Item; price: number }[] }
  | { kind: 'rest' }
  | { kind: 'trap'; name: string; dc: number; dmg: string }
  | { kind: 'event'; ev: EventDef; ai: boolean }
  | { kind: 'recruit'; comp: string; price: number; tried: boolean }

export type Pending = { kind: 'loot'; item: Item } | { kind: 'perk'; choices: string[]; reason: string }

export interface RunStats {
  kills: number
  bosses: number
  goldEarned: number
  rooms: number
  started: number
}

export interface Run {
  v: 1
  rng: number
  hero: Hero
  companion: Companion | null
  floor: number
  step: number
  mode: Mode
  doors: Door[]
  combat: Combat | null
  room: Room | null
  queue: Pending[]
  stats: RunStats
  nextUid: number
  /** What just happened, as sentences. */
  lines: string[]
  /** The same, as terse numbers for under an AI narration. */
  tally: string[]
  /** Freeform actions already taken in this room (so talk can't farm gold). */
  freeform: number
  merchantSeen: boolean
  recentEvents: string[]
  cause: string
}

export interface HallEntry {
  name: string
  cls: ClassId
  level: number
  floor: number
  kills: number
  cause: string
  date: number
}

export interface Option {
  id: string
  label: string
  /** Spoken aliases, matched fuzzily. */
  words: string[]
  /** Voice-only: understood but not listed on the lens. */
  hidden?: boolean
  /** A few words after the label on the lens pill ("+2 max HP per level"). */
  detail?: string
}

export interface Scene {
  title: string
  icon: IconName
  /** Under the portrait: who or what this is. */
  caption: string
  /** Health of whatever the portrait shows, for a bar. */
  bar: { hp: number; max: number } | null
  dim: boolean
  prompt: string
  options: Option[]
}

/** What the DM proposes for something the player said that isn't an option. */
export interface Ruling {
  ability: Ability | 'none'
  dc: number
  success: Outcome
  failure: Outcome
  /** For combat: which enemy the action is aimed at, if any. */
  target?: number
}

export interface ActResult {
  ok: boolean
  /** Why nothing happened, when ok is false. */
  reason?: string
}

const mod = (score: number) => Math.floor((score - 10) / 2)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

export function xpForLevel(level: number): number {
  return Math.round((40 * Math.pow(level, 1.6)) / 5) * 5
}

export class Game {
  run: Run | null
  hall: HallEntry[]
  private rng: Rng

  constructor(run: Run | null = null, hall: HallEntry[] = [], seed = Date.now()) {
    this.run = run
    this.hall = hall
    this.rng = new Rng(run ? run.rng : seed)
  }

  get mode(): Mode {
    return this.run?.mode ?? 'class'
  }

  private get r(): Run {
    if (!this.run) throw new Error('no run')
    return this.run
  }

  private get hero(): Hero {
    return this.r.hero
  }

  // --- log -----------------------------------------------------------------------

  private say(line: string, tally?: string) {
    if (!this.run) return
    if (line) this.run.lines.push(line)
    if (tally) this.run.tally.push(tally)
  }

  private beginTurn() {
    if (!this.run) return
    this.run.lines = []
    this.run.tally = []
  }

  private endTurn() {
    if (this.run) this.run.rng = this.rng.state
  }

  private uid = () => this.r.nextUid++

  // --- derived hero numbers --------------------------------------------------------

  stat(a: Ability): number {
    const h = this.hero
    let v = h.stats[a]
    const has = (t: string) => h.trinkets.some(x => x.base === t)
    if (a === 'con' && has('amulet-health')) v = Math.max(v, 19)
    if (a === 'str' && has('gauntlets')) v = Math.max(v, 19)
    if (a === 'int' && has('headband')) v = Math.max(v, 19)
    if (a === 'str' && h.fx.giant) v = Math.max(v, 21)
    return v
  }

  mod(a: Ability): number {
    return mod(this.stat(a))
  }

  prof(): number {
    return 2 + Math.floor((this.hero.level - 1) / 4)
  }

  perk(id: string): number {
    return this.hero.perks[id] ?? 0
  }

  hasTrinket(id: string): boolean {
    return this.hero.trinkets.some(t => t.base === id)
  }

  maxHp(): number {
    const h = this.hero
    return Math.max(1, h.hpBase + h.level * (this.mod('con') + 2 * this.perk('tough')))
  }

  ac(): number {
    const h = this.hero
    const c = classDef(h.cls)
    const dex = this.mod('dex')
    let ac: number
    if (h.armor) {
      const a = ARMORS[h.armor.base]
      ac = a.base + h.armor.plus + (a.dexCap === null ? dex : Math.min(dex, a.dexCap))
    } else if (c.unarmored === 'mage') ac = 13 + dex
    else if (c.unarmored === 'barbarian') ac = 10 + dex + this.mod('con')
    else ac = 10 + dex
    ac += c.shield ?? 0
    if (this.hasTrinket('ring-protection')) ac += 1
    if (this.hasTrinket('boots')) ac += 1
    ac += this.perk('iron-skin')
    if (this.hero.fx.shield) ac += 5
    if (this.hero.fx.warded) ac += 2
    return ac
  }

  /** Bonus to every d20 the hero rolls. */
  private luck(): number {
    let n = 0
    if (this.hasTrinket('luckstone')) n += 1
    if (this.companionDef()?.ability === 'luck' && this.run?.companion) n += 1
    return n
  }

  private weaponAbility(): Ability {
    const w = WEAPONS[this.hero.weapon.base]
    if (w.ranged) return 'dex'
    if (w.finesse) return this.stat('dex') > this.stat('str') ? 'dex' : 'str'
    return 'str'
  }

  attackBonus(): number {
    const h = this.hero
    let n = this.prof() + this.mod(this.weaponAbility()) + h.weapon.plus + this.perk('accurate')
    n += this.hitBuffs()
    return n
  }

  private hitBuffs(): number {
    const h = this.hero
    let n = this.luck()
    if (h.fx.blessed) n += 1
    if (h.fx.cursed) n -= 1
    if (h.fx.heroism) n += 2
    const ab = this.companionDef()?.ability
    if (this.run?.companion && ab === 'aim') n += 2
    if (this.run?.companion && ab === 'bless') n += 1
    return n
  }

  spellAbility(): Ability {
    return classDef(this.hero.cls).spell ?? 'wis'
  }

  spellAttack(): number {
    return this.prof() + this.mod(this.spellAbility()) + this.hero.weapon.plus + this.perk('accurate') + this.hitBuffs()
  }

  spellDc(): number {
    return 8 + this.prof() + this.mod(this.spellAbility()) + this.hero.weapon.plus
  }

  private critRange(): number {
    let r = 20 - this.perk('keen')
    if (this.hero.weapon.prop === 'keen') r -= 1
    return Math.max(17, r)
  }

  maxUses(skill: string): number | null {
    const def = SKILLS[skill]
    if (def.uses === null) return null
    return def.uses + this.perk('reserves') + (this.hasTrinket('amulet-devout') ? 1 : 0) + Math.floor((this.hero.level - 1) / 6)
  }

  knownSkills(): string[] {
    return classDef(this.hero.cls).skills.filter(s => s.level <= this.hero.level).map(s => s.id)
  }

  private companionDef(): CompanionDef | undefined {
    const c = this.run?.companion
    return c ? COMPANIONS.find(d => d.id === c.id) : undefined
  }

  companionStats() {
    const def = this.companionDef()
    if (!def) return null
    const lvl = this.hero.level
    const bond = this.perk('beast-bond')
    return {
      def,
      maxHp: Math.round(def.hp * (1 + 0.3 * (lvl - 1)) * (1 + 0.5 * bond)),
      atk: def.atk + Math.floor(lvl / 3),
      dmgBonus: Math.floor(lvl / 2) + 2 * bond,
    }
  }

  // --- creation ------------------------------------------------------------------------

  /** Starts a new hero. Anything from the last run is gone. */
  newHero(cls: ClassId) {
    const c = classDef(cls)
    const uid = { n: 1 }
    const next = () => uid.n++
    const hero: Hero = {
      name: this.rng.pick(HERO_NAMES),
      cls,
      level: 1,
      xp: 0,
      hp: 1,
      // A solo hero, not a party of four: double the hit die at level 1.
      hpBase: c.hitDie * 2,
      tempHp: 0,
      gold: 15,
      stats: { ...c.stats },
      weapon: { uid: next(), kind: 'weapon', base: c.weapon, plus: 0, qty: 1 },
      armor: c.armorPiece ? { uid: next(), kind: 'armor', base: c.armorPiece, plus: 0, qty: 1 } : null,
      trinkets: [],
      pack: [],
      uses: {},
      perks: {},
      fx: {},
      poison: 0,
    }
    this.run = {
      v: 1,
      rng: this.rng.state,
      hero,
      companion: c.companion ? { id: c.companion, hp: 1, cooldown: 0, stunned: 0 } : null,
      floor: 1,
      step: 0,
      mode: 'name',
      doors: [],
      combat: null,
      room: null,
      queue: [],
      stats: { kills: 0, bosses: 0, goldEarned: 0, rooms: 0, started: Date.now() },
      nextUid: uid.n,
      lines: [],
      tally: [],
      freeform: 0,
      merchantSeen: false,
      recentEvents: [],
      cause: '',
    }
    for (const base of c.pack) this.addToPack(consumable(base, this.uid()))
    hero.hp = this.maxHp()
    this.refillUses()
    const cs = this.companionStats()
    if (this.run.companion && cs) this.run.companion.hp = cs.maxHp
  }

  private refillUses() {
    for (const id of this.knownSkills()) {
      const max = this.maxUses(id)
      if (max !== null) this.hero.uses[id] = max
    }
  }

  setName(raw: string): boolean {
    if (this.mode !== 'name') return false
    const name = raw
      .replace(/^(my name is|i am|i'm|call me|it's|its|name)\s+/i, '')
      .replace(/[^\p{L}\p{N}' -]/gu, '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(w => cap(w.toLowerCase()))
      .join(' ')
      .slice(0, 18)
    if (!name) return false
    this.beginTurn()
    this.hero.name = name
    this.startAdventure()
    this.endTurn()
    return true
  }

  private startAdventure() {
    const h = this.hero
    const c = classDef(h.cls)
    this.say(`${h.name} the ${c.name} steps into the dark.`)
    const comp = this.companionDef()
    if (comp) this.say(`${comp.name} the ${comp.kind} pads along beside you.`)
    this.enterFloor()
  }

  // --- floors & doors -------------------------------------------------------------------

  private enterFloor() {
    const r = this.r
    r.step = 0
    r.merchantSeen = false
    for (const [k, v] of Object.entries(this.hero.fx)) if (v === FLOOR) delete this.hero.fx[k]
    delete this.hero.fx.relentlessUsed
    this.say(`Floor ${r.floor}: ${themeFor(r.floor)}.`, `Floor ${r.floor}`)
    this.rollDoors()
  }

  isBossFloor(floor = this.r.floor): boolean {
    return floor % 3 === 0
  }

  private rollDoors() {
    const r = this.r
    r.mode = 'doors'
    r.room = null
    r.combat = null
    r.freeform = 0
    if (this.isBossFloor() && r.step === ROOMS_PER_FLOOR - 1) {
      r.doors = [{ kind: 'boss', hint: ROOM_INFO.boss.hints[0], hidden: false }]
      return
    }
    // The first room of the run is always a fight, so the first thing a new
    // player learns is how to swing a sword.
    if (r.floor === 1 && r.step === 0) {
      r.doors = [
        { kind: 'fight', hint: this.rng.pick(ROOM_INFO.fight.hints), hidden: false },
        { kind: 'treasure', hint: this.rng.pick(ROOM_INFO.treasure.hints), hidden: false },
      ]
      return
    }
    const count = this.rng.chance(0.55) ? 3 : 2
    const doors: Door[] = []
    const used = new Set<RoomKind>()
    for (let i = 0; i < count; i++) {
      const kind = this.rng.weighted<RoomKind>([
        ['fight', used.has('fight') ? 12 : 38],
        ['elite', r.floor >= 2 && !used.has('elite') ? 9 : 0],
        ['treasure', used.has('treasure') ? 0 : 12],
        ['shrine', used.has('shrine') ? 0 : 7],
        ['merchant', used.has('merchant') || r.merchantSeen ? 0 : 8],
        ['rest', used.has('rest') || r.step < 1 ? 0 : 9],
        ['trap', used.has('trap') ? 0 : 6],
        ['event', used.has('event') ? 0 : 13],
        ['recruit', used.has('recruit') ? 0 : r.companion ? 2 : 7],
      ])
      used.add(kind)
      const hidden = this.rng.chance(0.14)
      doors.push({ kind, hint: hidden ? 'only darkness' : this.rng.pick(ROOM_INFO[kind].hints), hidden })
    }
    r.doors = doors
  }

  doorName(i: number, count: number): string {
    if (count === 1) return 'Onward'
    if (count === 2) return i === 0 ? 'Left' : 'Right'
    return ['Left', 'Middle', 'Right'][i] ?? `Door ${i + 1}`
  }

  private chooseDoor(i: number) {
    const r = this.r
    const door = r.doors[i]
    if (!door) return
    let kind = door.kind
    if (door.hidden) {
      kind = this.rng.weighted<RoomKind>([['fight', 40], ['treasure', 20], ['event', 20], ['trap', 10], ['elite', 10]])
    }
    r.doors = []
    this.enterRoom(kind)
  }

  private enterRoom(kind: RoomKind) {
    const r = this.r
    r.freeform = 0
    switch (kind) {
      case 'fight':
      case 'elite':
      case 'boss':
        return this.startCombat(kind)
      case 'treasure':
        r.room = { kind, locked: this.rng.chance(0.4), mimic: r.floor >= 2 && this.rng.chance(0.12), jammed: false, stuck: false }
        r.mode = 'treasure'
        this.say(r.room.locked ? 'An iron-bound chest sits in the dust. It is locked.' : 'A wooden chest sits in the dust, lid slightly open.')
        return
      case 'shrine':
        r.room = { kind, cost: 10 + r.floor * 5 }
        r.mode = 'shrine'
        this.say('A shrine of pale stone glows softly. An offering bowl waits.')
        return
      case 'merchant':
        r.merchantSeen = true
        r.room = { kind, stock: this.merchantStock() }
        r.mode = 'merchant'
        this.say('A hooded merchant unrolls a rug of wares. "Browse, friend. Gold only."')
        return
      case 'rest':
        r.room = { kind }
        r.mode = 'rest'
        this.say('Someone left a campfire burning. It is quiet here. Safe, for now.')
        return
      case 'trap': {
        const trap = this.rng.pick(['a hall of poison darts', 'a pressure plate and a swinging blade', 'a fire-scorched corridor', 'a floor of loose spikes'])
        r.room = { kind, name: trap, dc: clamp(11 + Math.floor(r.floor / 2), 11, 20), dmg: `${1 + Math.ceil(r.floor / 2)}d6` }
        r.mode = 'trap'
        this.say(`You stop short: ${trap}.`)
        return
      }
      case 'event': {
        const pool = EVENTS.filter(e => !r.recentEvents.includes(e.title))
        const ev = this.rng.pick(pool.length ? pool : EVENTS)
        r.recentEvents = [...r.recentEvents, ev.title].slice(-6)
        r.room = { kind, ev, ai: false }
        r.mode = 'event'
        this.say(`${ev.title}. ${ev.text}`)
        return
      }
      case 'recruit': {
        const pool = COMPANIONS.filter(c => c.id !== r.companion?.id)
        const comp = this.rng.pick(pool)
        r.room = { kind, comp: comp.id, price: 25 + r.floor * 10, tried: false }
        r.mode = 'recruit'
        this.say(comp.pitch)
        return
      }
    }
  }

  /** Swaps in an event the AI Dungeon Master invented for this room. */
  setEvent(ev: EventDef) {
    const r = this.r
    if (r.mode !== 'event' || r.room?.kind !== 'event') return
    r.room = { kind: 'event', ev, ai: true }
    r.lines = [`${ev.title}. ${ev.text}`]
    r.tally = []
  }

  private finishRoom() {
    const r = this.r
    r.step++
    r.stats.rooms++
    r.room = null
    r.combat = null
    if (this.hasTrinket('ring-regen')) this.heal(3, true)
    this.advance()
  }

  /** After a room: loot and level-ups first, then the stairs or the next doors. */
  private advance() {
    const r = this.r
    if (this.hero.hp <= 0) return
    const next = r.queue[0]
    if (next?.kind === 'loot') {
      r.mode = 'loot'
      return
    }
    if (next?.kind === 'perk') {
      r.mode = 'perk'
      return
    }
    if (r.step >= ROOMS_PER_FLOOR) {
      r.mode = 'stairs'
      r.room = null
      return
    }
    this.rollDoors()
  }

  // --- combat setup --------------------------------------------------------------------

  private tierFor(floor: number): 1 | 2 | 3 | 4 {
    return floor <= 3 ? 1 : floor <= 7 ? 2 : floor <= 12 ? 3 : 4
  }

  private makeEnemy(def: MonsterDef | (Omit<MonsterDef, 'tier' | 'group'> & { tier?: number }), opts: { boss?: boolean; elite?: boolean; minion?: boolean } = {}): Enemy {
    const r = this.r
    const tier = def.tier ?? this.tierFor(r.floor)
    const tierStart = [1, 1, 4, 8, 13][tier]
    const over = Math.max(0, r.floor - tierStart)
    // A solo hero, not a party of four: tier 3 and 4 stat blocks are trimmed.
    const hpK = [1, 1, 0.85, 0.7, 0.62][tier]
    let hp = def.hp * hpK * (1 + 0.1 * over)
    let atk = def.atk + Math.floor(over / 3)
    let dmgBonus = Math.floor(over / 2)
    let ac = def.ac + Math.floor(over / 6)
    let name = def.name
    let xp = def.xp * (1 + 0.1 * over)
    if (opts.boss) {
      // Bosses come back around every eight: "Ascended", and much tougher.
      const cycle = Math.floor((r.floor / 3 - 1) / BOSSES.length)
      hp = def.hp * (1 + 0.6 * cycle)
      atk = def.atk + cycle * 3
      dmgBonus = cycle * 3
      ac = def.ac + cycle
      xp = def.xp * (1 + cycle)
      if (cycle) name = `Ascended ${name}`
    }
    // Past floor 16 the dungeon keeps getting meaner without limit, so even the
    // best run ends eventually. That's the "endless" in an endless roguelike.
    const depth = Math.max(0, r.floor - 16)
    if (depth) {
      hp *= Math.pow(1.05, depth)
      atk += Math.floor(depth / 2)
      dmgBonus += depth
      ac += Math.floor(depth / 5)
    }
    if (opts.elite) {
      const e = this.rng.pick(ELITES)
      hp *= e.hp
      atk += e.atk
      dmgBonus += e.dmg
      ac += (e as { ac?: number }).ac ?? 0
      xp *= 2
      name = `${e.name} ${name}`
    }
    if (opts.minion) {
      hp *= 0.6
      xp *= 0.5
    }
    const maxHp = Math.max(1, Math.round(hp))
    return {
      uid: this.uid(),
      id: def.id,
      name,
      icon: def.icon,
      hp: maxHp,
      maxHp,
      ac,
      atk,
      dmg: def.dmg,
      dmgBonus,
      xp: Math.round(xp),
      gold: this.rng.int(def.gold[0], def.gold[1]),
      traits: def.traits,
      verb: def.verb,
      death: def.death ?? this.rng.pick(['falls', 'collapses', 'drops dead', 'crumples to the floor']),
      words: [...(def.words ?? []), def.name.toLowerCase()],
      tier,
      boss: !!opts.boss,
      elite: !!opts.elite,
      fx: {},
      poison: 0,
      stole: false,
    }
  }

  private monsterPool(): MonsterDef[] {
    const tier = this.tierFor(this.r.floor)
    return MONSTERS.filter(m => !m.special && (m.tier === tier || m.tier === tier - 1))
  }

  private pickMonster(): MonsterDef {
    const tier = this.tierFor(this.r.floor)
    const pool = this.monsterPool()
    return this.rng.weighted(pool.map(m => [m, m.tier === tier ? 3 : 1] as const))
  }

  startCombat(kind: CombatKind | 'fight' | 'elite' | 'boss') {
    const r = this.r
    const enemies: Enemy[] = []
    if (kind === 'boss') {
      const idx = (r.floor / 3 - 1) % BOSSES.length
      const def = BOSSES[idx]
      const boss = this.makeEnemy({ ...def, tier: this.tierFor(r.floor) }, { boss: true })
      enemies.push(boss)
      this.say(`${boss.name}, ${def.title}, rises to meet you.`, `BOSS ${boss.name}`)
    } else if (kind === 'mimic') {
      const def = MONSTERS.find(m => m.id === 'mimic')!
      enemies.push(this.makeEnemy({ ...def, tier: this.tierFor(r.floor) }))
      this.say('The chest splits open into a mouth full of teeth. Mimic!')
    } else if (kind === 'elite') {
      const e = this.makeEnemy(this.pickMonster(), { elite: true })
      enemies.push(e)
      this.say(`A ${e.name} blocks the way.`)
    } else {
      const first = this.pickMonster()
      const easy = r.floor === 1 && r.step === 0
      const early = r.floor <= 2
      let n = easy ? 1 : this.rng.weighted<number>(early ? [[1, 60], [2, 35], [3, 5]] : [[1, 45], [2, 40], [3, 15]])
      n = Math.min(n, first.group)
      for (let i = 0; i < n; i++) {
        // Sometimes a mixed group.
        const def = i > 0 && this.rng.chance(0.3) ? this.pickMonster() : first
        enemies.push(this.makeEnemy(def))
      }
      this.numberDuplicates(enemies)
      this.say(`${listNames(enemies.map(e => aName(e.name)))} ${enemies.length > 1 ? 'block' : 'blocks'} the way.`)
    }
    r.combat = { kind: kind as CombatKind, enemies, round: 1, focus: 0, menu: 'main', used: {}, xp: 0, gold: 0 }
    r.mode = 'combat'
    // Ambushes: mimics always, otherwise the enemy sometimes wins initiative.
    const ambush = kind === 'mimic' || (!(r.floor === 1 && r.step === 0) && !this.hasTrinket('boots') && this.rng.chance(0.12))
    if (ambush) {
      this.say(kind === 'mimic' ? '' : 'They strike first!')
      this.enemyPhase()
      this.endRound()
    }
  }

  private numberDuplicates(enemies: Enemy[]) {
    const counts: Record<string, number> = {}
    for (const e of enemies) counts[e.name] = (counts[e.name] ?? 0) + 1
    const seen: Record<string, number> = {}
    for (const e of enemies) {
      if (counts[e.name] > 1) {
        seen[e.name] = (seen[e.name] ?? 0) + 1
        e.name = `${e.name} ${seen[e.name]}`
      }
    }
  }

  private alive(): Enemy[] {
    return this.r.combat?.enemies.filter(e => e.hp > 0) ?? []
  }

  /** The enemy an attack goes to: the one asked for, else the focus, else the first alive. */
  private target(i?: number): Enemy | undefined {
    const c = this.r.combat
    if (!c) return undefined
    const pick = (n: number | undefined) => (n !== undefined && c.enemies[n]?.hp > 0 ? c.enemies[n] : undefined)
    const t = pick(i) ?? pick(c.focus) ?? this.alive()[0]
    if (t) c.focus = c.enemies.indexOf(t)
    return t
  }

  // --- hero actions in combat ------------------------------------------------------------

  private d20(adv: number): number {
    const a = this.rng.d(20)
    if (adv === 0) return a
    const b = this.rng.d(20)
    return adv > 0 ? Math.max(a, b) : Math.min(a, b)
  }

  /** Advantage (+1), disadvantage (-1) or neither for the hero's next attack. */
  private heroAdvantage(target: Enemy, extra = 0): number {
    const h = this.hero
    const c = this.r.combat!
    let adv = extra
    if (h.fx.hidden || h.fx.guided) adv++
    if (!c.used.scout && this.companionDef()?.ability === 'scout' && this.r.companion) adv++
    if (target.fx.stunned || target.fx.restrained) adv++
    if (h.fx.webbed) adv--
    return clamp(adv, -1, 1)
  }

  private heroAttack(target: Enemy, o: { adv?: number; forceCrit?: boolean; brutal?: boolean; sneakOk?: boolean } = {}): boolean {
    const h = this.hero
    const c = this.r.combat!
    const w = WEAPONS[h.weapon.base]
    const adv = this.heroAdvantage(target, o.adv ?? 0)
    let natural = this.d20(adv)
    let total = natural + this.attackBonus()
    const crit = o.forceCrit || natural >= this.critRange()
    let hit = crit || (natural !== 1 && total >= target.ac)
    if (!hit && this.perk('lucky') && !c.used.lucky) {
      c.used.lucky = true
      natural = this.rng.d(20)
      total = natural + this.attackBonus()
      hit = natural >= this.critRange() || (natural !== 1 && total >= target.ac)
      if (hit) this.say('Luck turns your miss into a hit!')
    }
    c.used.scout = true
    delete h.fx.guided
    const wasHidden = !!h.fx.hidden
    delete h.fx.hidden

    if (!hit) {
      this.say(this.rng.pick([`You miss the ${target.name}.`, `The ${target.name} dodges your ${w.verb === 'shoot' ? 'shot' : 'swing'}.`, `Your attack glances off the ${target.name}.`]), 'you miss')
      return false
    }

    const isCrit = natural >= this.critRange() || !!o.forceCrit
    let dmg = this.rng.roll(w.dice, isCrit) + (o.brutal ? this.rng.roll(w.dice, isCrit) : 0)
    dmg += this.mod(this.weaponAbility()) + h.weapon.plus + this.damageBuffs()
    if (h.fx.rage && !w.ranged) dmg += 2
    let fire = false
    switch (h.weapon.prop) {
      case 'flaming': dmg += this.rng.roll('1d6', isCrit); fire = true; break
      case 'frost': dmg += this.rng.roll('1d6', isCrit); break
      case 'holy': if (target.traits.includes('undead')) dmg += this.rng.roll('2d6', isCrit); break
      case 'venom': target.poison = Math.max(target.poison, 2 + Math.floor(h.level / 2)); target.fx.poisoned = 3; break
    }
    if (target.fx.marked) dmg += this.rng.roll('1d6', isCrit)
    // Sneak attack: once a turn, when the rogue has an edge.
    if (h.cls === 'rogue' && !c.used.sneakTurn) {
      const edge = wasHidden || adv > 0 || !c.used.firstStrike || !!this.r.companion || (this.perk('cunning') > 0 && target.hp < target.maxHp)
      if (edge || o.sneakOk) {
        c.used.sneakTurn = true
        dmg += this.rng.roll(`${Math.ceil(h.level / 2)}d6`, isCrit)
      }
    }
    c.used.firstStrike = true
    if (target.traits.includes('incorporeal') && !h.weapon.plus && !h.weapon.prop) dmg = Math.floor(dmg / 2)
    const verb = w.verb
    this.say(isCrit ? `Critical! You ${verb} the ${target.name} for ${dmg}.` : `You ${verb} the ${target.name} for ${dmg}.`, `${target.name} −${dmg}${isCrit ? '!' : ''}`)
    this.damageEnemy(target, dmg, fire)
    if (h.weapon.prop === 'vampiric') this.heal(this.rng.roll('1d4'), true)
    return true
  }

  private damageBuffs(): number {
    return 2 * this.perk('savage') + (this.hasTrinket('ring-fury') ? 2 : 0)
  }

  private damageEnemy(e: Enemy, dmg: number, fire = false, quiet = true) {
    if (e.hp <= 0) return
    e.hp -= Math.max(0, dmg)
    if (fire) e.fx.burned = 1
    if (!quiet) this.say('', `${e.name} −${dmg}`)
    if (e.hp <= 0) this.kill(e)
  }

  private kill(e: Enemy, how?: string) {
    const r = this.r
    const c = r.combat!
    e.hp = 0
    this.say(how ?? `The ${e.name} ${e.death}.`, `${e.name} †`)
    c.xp += e.xp
    c.gold += e.gold
    r.stats.kills++
    if (e.boss) r.stats.bosses++
    const bt = this.perk('bloodthirst')
    if (bt) this.heal(bt * (3 + Math.floor(this.hero.level / 2)), true)
  }

  private spellDamage(dice: string): string {
    const extra = this.perk('arcane-might')
    if (!extra) return dice
    const m = /^(\d+)d(\d+)(.*)$/.exec(dice)
    return m ? `${Number(m[1]) + extra}d${m[2]}${m[3]}` : dice
  }

  private spellAttackOn(target: Enemy, dice: string, name: string, fire = false): boolean {
    const adv = this.heroAdvantage(target)
    const natural = this.d20(adv)
    delete this.hero.fx.guided
    delete this.hero.fx.hidden
    const crit = natural === 20
    if (!crit && (natural === 1 || natural + this.spellAttack() < target.ac)) {
      this.say(`Your ${name} misses the ${target.name}.`, 'you miss')
      return false
    }
    const dmg = this.rng.roll(this.spellDamage(dice), crit) + this.damageBuffs() + this.hero.weapon.plus
    this.say(`${crit ? 'Critical! ' : ''}Your ${name} hits the ${target.name} for ${dmg}.`, `${target.name} −${dmg}${crit ? '!' : ''}`)
    this.damageEnemy(target, dmg, fire)
    return true
  }

  /** Damage to every enemy with a save for half. */
  private blast(dice: string, dc: number, name: string, fire = false, useBuffs = true) {
    const hits = this.alive().map(e => {
      let dmg = this.rng.roll(dice) + (useBuffs ? this.damageBuffs() : 0)
      if (this.rng.d(20) + this.enemySave(e) >= dc) dmg = Math.floor(dmg / 2)
      return { e, dmg }
    })
    this.say(`${name} hits ${hits.map(x => `the ${x.e.name} for ${x.dmg}`).join(', ')}.`)
    for (const { e, dmg } of hits) {
      this.say('', `${e.name} −${dmg}`)
      this.damageEnemy(e, dmg, fire)
    }
  }

  private enemySave(e: Enemy): number {
    return Math.floor(e.tier * 1.5) + 1 + (e.boss ? 2 : 0) + (e.elite ? 1 : 0)
  }

  private cantripDice(): number {
    const l = this.hero.level
    return 1 + (l >= 5 ? 1 : 0) + Math.max(0, Math.floor((l - 5) / 6))
  }

  /** Returns false if the skill can't be used now (nothing happens). */
  private useSkill(id: string, targetIndex?: number): ActResult {
    const h = this.hero
    const c = this.r.combat!
    const def = SKILLS[id]
    if (!def || !this.knownSkills().includes(id)) return { ok: false, reason: 'You don\'t know that skill.' }
    const max = this.maxUses(id)
    if (max !== null && (h.uses[id] ?? 0) <= 0) return { ok: false, reason: `${def.name} is spent until you rest.` }
    const t = this.target(targetIndex)
    if (!t) return { ok: false, reason: 'Nothing to target.' }
    const lvl = h.level

    switch (id) {
      case 'second-wind': {
        const n = this.heal(this.rng.roll('1d10') + lvl)
        this.say(`You catch your breath and recover ${n} HP.`, `+${n} HP`)
        break
      }
      case 'action-surge':
      case 'frenzy':
        this.say(id === 'frenzy' ? 'You fly into a frenzy!' : 'You push past your limits!')
        this.heroAttack(t)
        c.used.sneakTurn = false
        this.heroAttack(this.target() ?? t)
        break
      case 'cleave':
      case 'volley':
        this.say(id === 'cleave' ? 'You swing through them all!' : 'Arrows fly at every foe!')
        for (const e of this.alive()) this.heroAttack(e)
        break
      case 'shield-wall':
        h.fx.shield = 3
        this.say('You set your feet and raise your guard. (+5 AC)', '+5 AC')
        break
      case 'hide': {
        const roll = this.d20(0) + this.mod('dex') + this.prof() + this.luck()
        const dc = 10 + Math.floor(this.r.floor / 2) + (t.boss ? 3 : 0)
        if (roll >= dc) {
          h.fx.hidden = 2
          this.say(`You melt into the shadows. (Stealth ${roll})`, 'hidden')
        } else this.say(`The ${t.name} tracks you. (Stealth ${roll} vs ${dc})`, 'spotted')
        break
      }
      case 'poison-blade':
        if (this.heroAttack(t) && t.hp > 0) {
          t.poison = Math.max(t.poison, 2 + this.rng.roll('1d4') + Math.floor(lvl / 2))
          t.fx.poisoned = 3
          this.say(`Poison seeps into the ${t.name}'s wound.`, 'poisoned')
        }
        break
      case 'evasion':
        h.fx.evasion = 2
        this.say('You move like smoke. Enemies struggle to land a hit.', 'evasion')
        break
      case 'assassinate':
        this.heroAttack(t, { forceCrit: true, sneakOk: true })
        break
      case 'fire-bolt':
        // Cantrips add the casting stat: a solo wizard can't wait on a party.
        this.spellAttackOn(t, `${this.cantripDice()}d10+${Math.max(0, this.mod('int'))}`, 'fire bolt', true)
        break
      case 'magic-missile': {
        const darts = 3 + Math.floor((lvl - 1) / 4)
        let dmg = 0
        for (let i = 0; i < darts; i++) dmg += this.rng.roll('1d4+1')
        dmg += this.damageBuffs()
        this.say(`${darts} glowing darts strike the ${t.name} for ${dmg}.`, `${t.name} −${dmg}`)
        this.damageEnemy(t, dmg)
        break
      }
      case 'shield':
        h.fx.shield = 2
        this.say('A shimmering barrier springs up around you. (+5 AC)', '+5 AC')
        break
      case 'thunderwave':
        this.blast(this.spellDamage(`${2 + Math.floor(lvl / 4)}d8`), this.spellDc(), 'Thunderwave')
        break
      case 'fireball':
        this.blast(this.spellDamage(`${8 + Math.max(0, Math.floor((lvl - 5) / 2))}d6`), this.spellDc(), 'Fireball', true)
        break
      case 'lightning':
        this.blast(this.spellDamage(`${8 + Math.max(0, Math.floor((lvl - 7) / 2))}d6`), this.spellDc(), 'Lightning')
        break
      case 'sacred-flame': {
        const save = this.rng.d(20) + this.enemySave(t)
        let dmg = this.rng.roll(this.spellDamage(`${this.cantripDice()}d8`)) + Math.max(0, this.mod('wis')) + this.damageBuffs() + h.weapon.plus
        // House rule for a solo cleric: a save halves it instead of negating it.
        if (save >= this.spellDc()) dmg = Math.floor(dmg / 2)
        this.say(save >= this.spellDc() ? `The ${t.name} is singed by sacred flame for ${dmg}.` : `Holy fire engulfs the ${t.name} for ${dmg}.`, `${t.name} −${dmg}`)
        this.damageEnemy(t, dmg, true)
        break
      }
      case 'cure-wounds': {
        const n = this.heal(this.rng.roll(`${1 + Math.floor(lvl / 2)}d8`) + this.mod('wis'))
        this.say(`Warm light closes your wounds. +${n} HP.`, `+${n} HP`)
        break
      }
      case 'guiding-bolt':
        // 2: it has to outlast this round's end to help next turn.
        if (this.spellAttackOn(t, `${4 + Math.floor(lvl / 3)}d6`, 'guiding bolt')) h.fx.guided = 2
        break
      case 'turn-undead': {
        const undead = this.alive().filter(e => e.traits.includes('undead'))
        if (!undead.length) return { ok: false, reason: 'There are no undead here.' }
        this.say('You raise your holy symbol. Light floods the room!')
        for (const e of undead) {
          const save = this.rng.d(20) + this.enemySave(e)
          if (e.boss) {
            e.fx.stunned = 1
            this.say(`The ${e.name} reels, stunned.`, `${e.name} stunned`)
          } else if (save < this.spellDc()) this.kill(e, `The ${e.name} flees, shrieking, into the dark.`)
          else this.say(`The ${e.name} resists.`)
        }
        break
      }
      case 'spirit-guardians':
        h.fx.guardians = 3
        this.say('Spectral warriors circle you, blades of light raised.', 'guardians')
        break
      case 'hunters-mark':
        t.fx.marked = FIGHT
        this.say(`You mark the ${t.name} as your quarry.`, 'marked')
        this.heroAttack(t)
        break
      case 'ensnare':
        if (this.heroAttack(t) && t.hp > 0) {
          const save = this.rng.d(20) + this.enemySave(t)
          if (save < this.spellDcOrWis()) {
            t.fx.restrained = 1
            this.say(`Thorny vines lash around the ${t.name}.`, `${t.name} snared`)
          } else this.say(`The ${t.name} tears free of the vines.`)
        }
        break
      case 'hail-of-thorns':
        this.blast(`${4 + Math.floor(lvl / 5)}d10`, this.spellDcOrWis(), 'A hail of thorns')
        break
      case 'rage':
        if (h.fx.rage) return { ok: false, reason: 'You are already raging.' }
        h.fx.rage = FIGHT
        this.say('You roar and fly into a rage!', 'RAGE')
        this.heroAttack(t)
        break
      case 'reckless':
        h.fx.reckless = 1
        this.heroAttack(t, { adv: 1 })
        break
      case 'brutal-strike':
        if (this.heroAttack(t, { brutal: true }) && t.hp > 0) {
          t.fx.stunned = 1
          this.say(`The ${t.name} staggers.`, 'staggered')
        }
        break
      default:
        return { ok: false, reason: 'Nothing happens.' }
    }
    if (max !== null) h.uses[id] = (h.uses[id] ?? 0) - 1
    return { ok: true }
  }

  /** Rangers use Wisdom for their tricks; everyone else their spell stat. */
  private spellDcOrWis(): number {
    return 8 + this.prof() + this.mod(classDef(this.hero.cls).spell ?? 'wis')
  }

  private useItem(base: string, targetIndex?: number): ActResult {
    const h = this.hero
    const r = this.r
    const inCombat = r.mode === 'combat'
    const item = h.pack.find(i => i.base === base)
    if (!item) return { ok: false, reason: 'You don\'t have that.' }
    const def = CONSUMABLES[base]
    if (inCombat && !def.combat) return { ok: false, reason: `${def.name} can't be used in a fight.` }
    if (!inCombat && !def.outside) return { ok: false, reason: `Save the ${def.name} for a fight.` }

    switch (base) {
      case 'healing':
      case 'greater-healing':
      case 'superior-healing': {
        const dice = base === 'healing' ? '2d4+2' : base === 'greater-healing' ? '4d4+4' : '8d4+8'
        const n = this.heal(Math.round(this.rng.roll(dice) * (1 + 0.5 * this.perk('alchemist'))))
        this.say(`You drink the ${def.name}. +${n} HP.`, `+${n} HP`)
        break
      }
      case 'giant-strength':
        h.fx.giant = FIGHT
        this.say('Your muscles swell with the strength of giants!', 'STR 21')
        break
      case 'heroism':
        h.tempHp = Math.max(h.tempHp, 10)
        h.fx.heroism = FIGHT
        this.say('Courage floods through you. (+10 temp HP, +2 to hit)', '+10 temp')
        break
      case 'invisibility':
        h.fx.hidden = 2
        h.fx.invisible = 3
        this.say('You fade from sight.', 'invisible')
        break
      case 'antidote':
        h.poison = 0
        delete h.fx.poisoned
        h.fx.antidote = FLOOR
        this.say('The antidote burns going down. You feel clean.', 'cured')
        break
      case 'vigor':
        this.refillUses()
        this.say('Vigor surges through you. Every skill is restored.', 'skills restored')
        break
      case 'fire-breath':
        this.blast('4d6', 13, 'Your fiery breath', true, false)
        break
      case 'scroll-fireball':
        this.blast('8d6', 15, 'The scroll\'s fireball', true, false)
        break
      case 'scroll-lightning': {
        const t = this.target(targetIndex)
        if (!t) return { ok: false, reason: 'Nothing to target.' }
        const dmg = this.rng.roll('6d6')
        this.say(`Lightning leaps from the scroll into the ${t.name} for ${dmg}.`, `${t.name} −${dmg}`)
        this.damageEnemy(t, dmg)
        break
      }
      case 'scroll-teleport':
        if (inCombat) {
          if (r.combat?.kind === 'boss') return { ok: false, reason: 'The boss\'s power holds you here.' }
          this.say('The world folds. You are somewhere else, and safe.')
          this.takeFromPack(base)
          this.finishRoom()
          return { ok: true }
        }
        this.say('The world folds, and you stand before the stairs.')
        this.takeFromPack(base)
        r.step = Math.max(r.step, ROOMS_PER_FLOOR - (this.isBossFloor() ? 1 : 0))
        this.advance()
        return { ok: true }
      case 'scroll-enchant':
        if (h.weapon.plus >= 5) return { ok: false, reason: 'Your weapon can hold no more magic.' }
        h.weapon.plus++
        this.say(`Runes flare along your weapon. It is now ${itemName(h.weapon)}.`, `weapon +${h.weapon.plus}`)
        break
      case 'scroll-protection':
        h.fx.warded = FLOOR
        this.say('A ward settles over you for the rest of this floor. (+2 AC)', '+2 AC')
        break
      default:
        return { ok: false, reason: `You can't use the ${def.name} like that.` }
    }
    this.takeFromPack(base)
    return { ok: true }
  }

  private takeFromPack(base: string) {
    const h = this.hero
    const i = h.pack.findIndex(x => x.base === base)
    if (i < 0) return
    h.pack[i].qty--
    if (h.pack[i].qty <= 0) h.pack.splice(i, 1)
  }

  private addToPack(item: Item) {
    const have = this.hero.pack.find(x => x.base === item.base)
    if (have) have.qty += item.qty
    else this.hero.pack.push({ ...item })
  }

  countOf(base: string): number {
    return this.hero.pack.find(x => x.base === base)?.qty ?? 0
  }

  private flee(): ActResult {
    const r = this.r
    const c = r.combat!
    if (c.kind === 'boss') return { ok: false, reason: 'There is no escaping this fight.' }
    const dc = clamp(10 + Math.floor(r.floor / 2), 10, 18)
    const roll = this.d20(0) + this.mod('dex') + this.luck()
    if (this.hasTrinket('boots') || this.hero.fx.invisible || roll >= dc) {
      this.say('You break away and run!', 'fled')
      this.finishRoom()
      return { ok: true }
    }
    this.say(`You try to run, but they cut you off. (${roll} vs ${dc})`, 'flee failed')
    this.enemyPhase()
    this.endRound()
    return { ok: true }
  }

  /** After the hero acts: the companion, then every enemy, then the round ends. */
  private afterHeroAction() {
    if (this.checkVictory()) return
    this.companionPhase()
    if (this.checkVictory()) return
    this.enemyPhase()
    if (this.checkVictory()) return
    this.endRound()
  }

  private companionPhase() {
    const r = this.r
    const comp = r.companion
    const cs = this.companionStats()
    if (!comp || !cs || comp.hp <= 0) return
    if (comp.stunned > 0) {
      comp.stunned--
      this.say(`${cs.def.name} is stunned.`)
      return
    }
    const h = this.hero
    const ability: CompanionAbility = cs.def.ability
    if (comp.cooldown > 0) comp.cooldown--
    if ((ability === 'heal' || ability === 'bless') && comp.cooldown === 0 && h.hp < this.maxHp() * 0.5) {
      const n = this.heal(this.rng.roll(ability === 'bless' ? '2d8' : '1d8') + h.level)
      comp.cooldown = 3
      this.say(`${cs.def.name} heals you for ${n}.`, `+${n} HP`)
      return
    }
    const t = this.target()
    if (!t) return
    const swings = ability === 'stun' ? 2 : 1
    for (let s = 0; s < swings && t.hp > 0; s++) {
      const natural = this.rng.d(20)
      if (natural !== 20 && (natural === 1 || natural + cs.atk < t.ac)) {
        this.say(`${cs.def.name} misses.`)
        continue
      }
      let dmg = this.rng.roll(cs.def.dmg, natural === 20) + cs.dmgBonus
      let fire = false
      if (ability === 'fire') {
        dmg += this.rng.roll('1d6')
        fire = true
      }
      this.say(`${cs.def.name} hits the ${t.name} for ${dmg}.`, `${t.name} −${dmg}`)
      this.damageEnemy(t, dmg, fire)
      if (t.hp > 0 && (ability === 'trip' || ability === 'stun') && this.rng.chance(0.2)) {
        t.fx.stunned = 1
        this.say(ability === 'trip' ? `${cs.def.name} knocks the ${t.name} off its feet!` : `The ${t.name} is stunned!`)
      }
    }
  }

  private enemyPhase() {
    const r = this.r
    const c = r.combat!
    const h = this.hero
    // Spirit guardians burn every foe first.
    if (h.fx.guardians) {
      for (const e of this.alive()) {
        let dmg = this.rng.roll(this.spellDamage(`${3 + Math.floor(h.level / 6)}d8`))
        if (this.rng.d(20) + this.enemySave(e) >= this.spellDc()) dmg = Math.floor(dmg / 2)
        this.say(`Spirit guardians sear the ${e.name} for ${dmg}.`, `${e.name} −${dmg}`)
        this.damageEnemy(e, dmg)
      }
    }
    for (const e of [...c.enemies]) {
      if (e.hp <= 0 || h.hp <= 0) continue
      if (e.fx.poisoned && e.poison) {
        this.say(`Poison burns the ${e.name} for ${e.poison}.`, `${e.name} −${e.poison}`)
        this.damageEnemy(e, e.poison)
        if (e.hp <= 0) continue
      }
      if (e.traits.includes('regen') && !e.fx.burned && e.hp < e.maxHp) {
        const n = Math.min(e.maxHp - e.hp, Math.max(3, Math.round(e.maxHp * 0.06)))
        e.hp += n
        this.say(`The ${e.name}'s wounds knit closed. (+${n})`, `${e.name} +${n}`)
      }
      if (e.fx.stunned || e.fx.restrained) {
        this.say(`The ${e.name} ${e.fx.restrained ? 'struggles against the vines' : 'is reeling'}.`)
        continue
      }
      // Summoners call for help every third round.
      if (e.traits.includes('summon') && c.round % 3 === 2 && this.alive().length < 3 && (c.used.summons ? 1 : 0) + (c.used.summons2 ? 1 : 0) < 2) {
        if (c.used.summons) c.used.summons2 = true
        c.used.summons = true
        const minionId = e.id.includes('goblin') ? 'goblin' : e.id.includes('web') ? 'spider' : 'skeleton'
        const def = MONSTERS.find(m => m.id === minionId)!
        const minion = this.makeEnemy({ ...def, tier: e.tier }, { minion: true })
        minion.name = `${def.name} ${c.enemies.length + 1}`
        c.enemies.push(minion)
        this.say(`The ${e.name} calls, and a ${def.name} answers!`, `+${def.name}`)
        continue
      }
      // Healers patch up a badly hurt friend instead of attacking.
      if (e.traits.includes('healer')) {
        const hurt = this.alive().find(x => x !== e && x.hp < x.maxHp / 2)
        if (hurt) {
          const n = Math.min(hurt.maxHp - hurt.hp, this.rng.roll('2d4+2') + e.tier)
          hurt.hp += n
          this.say(`The ${e.name} chants, and the ${hurt.name} heals ${n}.`, `${hurt.name} +${n}`)
          continue
        }
      }
      // Breath weapons recharge every third round.
      if (e.traits.includes('breath') && c.round % 3 === 2) {
        this.breath(e)
        continue
      }
      const attacks = e.traits.includes('multi') ? 2 : 1
      for (let a = 0; a < attacks && h.hp > 0; a++) this.enemyAttack(e, a === 0 && c.round === 1 && e.traits.includes('charge'))
    }
  }

  private breath(e: Enemy) {
    const r = this.r
    const dice = `${3 + Math.floor(r.floor / 3)}d6`
    const dc = clamp(11 + Math.floor(r.floor / 2), 11, 22)
    let dmg = this.rng.roll(dice) + e.dmgBonus
    const save = this.heroSave('dex')
    if (save >= dc) dmg = Math.floor(dmg / 2)
    const what = e.traits.includes('undead') ? 'a wave of necrotic power' : e.id.includes('golem') ? 'a cloud of poison gas' : 'a torrent of fire'
    this.say(`The ${e.name} unleashes ${what}! ${save >= dc ? 'You dive aside.' : ''}`)
    this.hurtHero(dmg, e.name)
    const comp = r.companion
    const cs = this.companionStats()
    if (comp && cs && comp.hp > 0) this.hurtCompanion(Math.floor(dmg / 2), cs.def.name)
  }

  heroSave(a: Ability): number {
    const c = classDef(this.hero.cls)
    return this.d20(0) + this.mod(a) + (c.saves.includes(a) ? this.prof() : 0) + (this.hasTrinket('ring-protection') ? 1 : 0) + this.luck()
  }

  private enemyAttack(e: Enemy, charge: boolean) {
    const r = this.r
    const c = r.combat!
    const h = this.hero
    const comp = r.companion
    const cs = this.companionStats()
    const compUp = comp && cs && comp.hp > 0
    const taunt = compUp && cs!.def.ability === 'taunt'
    const atCompanion = compUp && this.rng.chance(taunt ? 0.65 : 0.25)

    let atk = e.atk
    if (e.traits.includes('pack') && this.alive().length > 1) atk += 2
    const enraged = e.traits.includes('enrage') && e.hp < e.maxHp / 2
    if (enraged) atk += 2

    if (atCompanion) {
      const natural = this.rng.d(20)
      if (natural !== 20 && (natural === 1 || natural + atk < cs!.def.ac + Math.floor(h.level / 4))) {
        this.say(`The ${e.name} misses ${cs!.def.name}.`)
        return
      }
      const dmg = this.rng.roll(e.dmg, natural === 20) + e.dmgBonus + (enraged ? 2 : 0)
      this.say(`The ${e.name} ${e.verb} ${cs!.def.name} for ${dmg}.`)
      this.hurtCompanion(dmg, cs!.def.name)
      return
    }

    if (!c.used.cloak && this.hasTrinket('cloak')) {
      c.used.cloak = true
      this.say(`The ${e.name} strikes at your displaced image and hits nothing.`, `${e.name} misses`)
      return
    }
    let adv = 0
    if (h.fx.reckless) adv++
    if (h.fx.hidden || h.fx.invisible || h.fx.evasion) adv--
    const natural = this.d20(clamp(adv, -1, 1))
    const total = natural + atk - this.perk('evasive')
    if (natural !== 20 && (natural === 1 || total < this.ac())) {
      this.say(this.rng.pick([`The ${e.name} misses you.`, `You turn aside the ${e.name}'s attack.`, `The ${e.name}'s attack goes wide.`]), `${e.name} misses`)
      return
    }
    let dmg = this.rng.roll(e.dmg, natural === 20) + e.dmgBonus + (enraged ? 2 : 0)
    if (charge) {
      dmg += this.rng.roll(e.dmg)
      this.say(`The ${e.name} charges!`)
    }
    if (h.fx.rage) dmg = Math.ceil(dmg / 2)
    this.say(`${natural === 20 ? 'Critical! ' : ''}The ${e.name} ${e.verb} you for ${dmg}.`, `you −${dmg}`)
    this.hurtHero(dmg, e.name)
    if (h.hp <= 0) return

    if (e.traits.includes('drain')) {
      const n = Math.min(e.maxHp - e.hp, Math.floor(dmg / 2))
      if (n > 0) e.hp += n
    }
    if (e.traits.includes('poison') && !h.fx.antidote && this.heroSave('con') < 8 + e.tier * 2) {
      h.poison = Math.max(h.poison, e.tier + this.rng.d(2) + Math.floor(this.r.floor / 4))
      h.fx.poisoned = 2
      this.say('You are poisoned!', 'poisoned')
    }
    if (e.traits.includes('steal') && !e.stole && h.gold > 0) {
      const n = Math.min(h.gold, this.rng.roll('2d6') + r.floor)
      h.gold -= n
      e.stole = true
      e.gold += n
      this.say(`The ${e.name} snatches ${n} gold from your purse!`, `−${n}g`)
    }
    if (e.traits.includes('web') && this.rng.chance(0.3)) {
      h.fx.webbed = 2
      this.say('Sticky strands tangle your arms.', 'webbed')
    }
    if ((e.traits.includes('petrify') || e.traits.includes('charm')) && this.rng.chance(0.35)) {
      const a: Ability = e.traits.includes('charm') ? 'wis' : 'con'
      if (this.heroSave(a) < 10 + e.tier * 2) {
        h.fx.stunned = 2 // survives this round's end, costs the next turn
        this.say(a === 'wis' ? 'A haunting song clouds your mind. You lose your next turn.' : 'Your limbs stiffen to stone. You lose your next turn.', 'stunned')
      }
    }
  }

  private hurtCompanion(dmg: number, name: string) {
    const comp = this.r.companion
    if (!comp) return
    comp.hp -= dmg
    if (comp.hp <= 0) {
      this.say(`${name} falls! Your companion is gone.`, `${name} †`)
      this.r.companion = null
    }
  }

  private hurtHero(dmg: number, cause: string) {
    const h = this.hero
    if (h.tempHp > 0) {
      const soak = Math.min(h.tempHp, dmg)
      h.tempHp -= soak
      dmg -= soak
    }
    h.hp -= dmg
    if (h.hp > 0) return
    // Death, unless something intervenes.
    if (this.perk('relentless') && !h.fx.relentlessUsed) {
      h.fx.relentlessUsed = FLOOR
      h.hp = 1
      this.say('You should be dead. You refuse.', 'relentless')
      return
    }
    const feather = h.trinkets.findIndex(t => t.base === 'phoenix')
    if (feather >= 0) {
      h.trinkets.splice(feather, 1)
      h.hp = Math.ceil(this.maxHp() / 2)
      this.say('The Phoenix Feather bursts into flame, and you rise from the ashes!', 'phoenix')
      return
    }
    if (this.countOf('scroll-revivify')) {
      this.takeFromPack('scroll-revivify')
      h.hp = Math.ceil(this.maxHp() / 3)
      this.say('The Scroll of Revivify crumbles to dust as it drags you back to life!', 'revived')
      return
    }
    this.die(cause)
  }

  private die(cause: string) {
    const r = this.r
    const h = this.hero
    h.hp = 0
    r.mode = 'dead'
    r.cause = cause
    r.combat = null
    r.room = null
    r.queue = []
    this.say(`You fall. ${h.name}'s legend ends on floor ${r.floor}.`)
    this.hall.push({ name: h.name, cls: h.cls, level: h.level, floor: r.floor, kills: r.stats.kills, cause, date: Date.now() })
    this.hall.sort((a, b) => b.floor - a.floor || b.level - a.level || b.kills - a.kills)
    this.hall = this.hall.slice(0, HALL_SIZE)
  }

  private endRound() {
    const r = this.r
    const c = r.combat
    const h = this.hero
    if (!c || h.hp <= 0) return
    if (h.fx.poisoned && h.poison) {
      this.say(`Poison burns through you. (${h.poison})`, `you −${h.poison}`)
      this.hurtHero(h.poison, 'poison')
      if (h.hp <= 0) return
    }
    if (this.hasTrinket('ring-regen')) this.heal(1, true)
    for (const [k, v] of Object.entries(h.fx)) {
      if (v >= FIGHT) continue
      if (v <= 1) delete h.fx[k]
      else h.fx[k] = v - 1
    }
    if (!h.fx.poisoned) h.poison = 0
    for (const e of c.enemies) {
      for (const [k, v] of Object.entries(e.fx)) {
        if (v >= FIGHT) continue
        if (v <= 1) delete e.fx[k]
        else e.fx[k] = v - 1
      }
      if (!e.fx.poisoned) e.poison = 0
    }
    c.used.sneakTurn = false
    c.round++
  }

  private checkVictory(): boolean {
    const r = this.r
    const c = r.combat
    if (!c || this.hero.hp <= 0) return this.hero.hp <= 0
    if (this.alive().length) return false
    const h = this.hero
    if (c.used.escaped) {
      for (const [k, v] of Object.entries(h.fx)) if (v < FLOOR) delete h.fx[k]
      h.tempHp = 0
      this.finishRoom()
      return true
    }
    const xp = Math.round(c.xp * (1 + 0.25 * this.perk('quick-study')))
    let gold = Math.round(c.gold * (1 + 0.5 * this.perk('deep-pockets')))
    if (this.companionDef()?.ability === 'fire' && r.companion) gold = Math.round(gold * 1.25)
    h.gold += gold
    r.stats.goldEarned += gold
    this.say(`Victory! +${xp} XP${gold ? `, +${gold} gold` : ''}.`, `+${xp} xp${gold ? ` +${gold}g` : ''}`)

    // Clear everything but floor-long effects.
    for (const [k, v] of Object.entries(h.fx)) if (v < FLOOR) delete h.fx[k]
    h.tempHp = 0
    h.poison = 0

    // Loot.
    const scav = 0.15 * this.perk('scavenger')
    const drops =
      c.kind === 'boss' ? 2 : c.kind === 'elite' || c.kind === 'mimic' ? 1 + (this.rng.chance(0.3 + scav) ? 1 : 0) : this.rng.chance(0.3 + scav) ? 1 : 0
    for (let i = 0; i < drops; i++) this.gainItem(rollItem(this.rng, this.lootOpts(c.kind === 'boss' ? 2 : c.kind === 'elite' ? 1 : 0)))
    if (c.kind === 'boss') {
      this.gainItem(consumable(bestHealing(r.floor), this.uid()))
      const n = this.heal(Math.round(this.maxHp() * 0.3))
      this.say(`The way down opens. You catch your breath. (+${n} HP)`)
    }
    const breather = this.heal(Math.round(this.maxHp() * 0.15), true)
    if (breather && c.kind !== 'boss') this.say(`You catch your breath. (+${breather} HP)`, `+${breather} HP`)
    this.gainXp(xp)
    this.finishRoom()
    return true
  }

  private lootOpts(quality: number) {
    return { floor: this.r.floor, cls: this.hero.cls, quality, owned: this.hero.trinkets.map(t => t.base), uid: this.uid }
  }

  /** Consumables go straight in the pack; gear waits for a decision. */
  private gainItem(item: Item) {
    const h = this.hero
    if (isConsumable(item)) {
      this.addToPack(item)
      this.say(`You find ${aName(itemName(item))}.`, `+${itemName(item)}`)
      return
    }
    if (item.kind === 'trinket' && h.trinkets.length < TRINKET_SLOTS) {
      h.trinkets.push(item)
      this.say(`You find the ${itemName(item)} and put it on. ${itemDesc(item)}`, `+${itemName(item)}`)
      return
    }
    if (item.kind === 'armor' && !this.canWear(item)) {
      const v = salvageValue(item)
      h.gold += v
      this.say(`You find ${aName(itemName(item))}, too heavy for you. Sold for ${v} gold.`, `+${v}g`)
      return
    }
    this.say(`You find ${aName(itemName(item))}!`, `+${itemName(item)}`)
    this.r.queue.push({ kind: 'loot', item })
  }

  canWear(item: Item): boolean {
    const allowed = classDef(this.hero.cls).armor
    if (allowed === 'none') return false
    const order = ['light', 'medium', 'heavy']
    return order.indexOf(ARMORS[item.base].type) <= order.indexOf(allowed)
  }

  gainXp(n: number) {
    const h = this.hero
    h.xp += n
    while (h.xp >= xpForLevel(h.level)) {
      h.xp -= xpForLevel(h.level)
      const before = this.maxHp()
      const known = new Set(this.knownSkills())
      h.level++
      h.hpBase += Math.floor(classDef(h.cls).hitDie / 2) + 2
      // Levelling up fully heals: the one big exhale a run gets.
      h.hp = this.maxHp()
      const learned = this.knownSkills().filter(s => !known.has(s))
      for (const s of learned) h.uses[s] = this.maxUses(s) ?? 0
      this.say(`Level ${h.level}! +${this.maxHp() - before} max HP, fully healed.${learned.length ? ` New skill: ${learned.map(s => SKILLS[s].name).join(', ')}.` : ''}`, `LEVEL ${h.level}`)
      this.r.queue.push({ kind: 'perk', choices: this.perkChoices(), reason: `Level ${h.level}` })
    }
  }

  private perkChoices(): string[] {
    const h = this.hero
    const pool = PERKS.filter(p => !p.filler && (h.perks[p.id] ?? 0) < p.stack && (!p.for || p.for.includes(h.cls)))
      .filter(p => p.id !== 'beast-bond' || this.r.companion)
    const picks = this.rng.shuffle(pool.map(p => p.id)).slice(0, 3)
    for (const f of PERKS.filter(p => p.filler)) if (picks.length < 3) picks.push(f.id)
    return picks
  }

  private applyPerk(id: string) {
    const h = this.hero
    const p = PERKS.find(x => x.id === id)
    if (!p) return
    const before = this.maxHp()
    h.perks[id] = (h.perks[id] ?? 0) + 1
    if (['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(id)) h.stats[id as Ability] += 2
    if (id === 'vitality') h.hpBase += 6
    if (id === 'fortune') h.gold += 25 * this.r.floor
    const gained = this.maxHp() - before
    if (gained > 0) h.hp += gained
    if (id === 'reserves') for (const s of this.knownSkills()) if (h.uses[s] !== undefined) h.uses[s]++
    if (id === 'beast-bond' && this.r.companion) {
      const cs = this.companionStats()
      if (cs) this.r.companion.hp = cs.maxHp
    }
    this.say(`${p.name}: ${p.blurb}`, p.name)
  }

  heal(n: number, quiet = false): number {
    const h = this.hero
    if (this.hasTrinket('periapt')) n *= 2
    const got = Math.max(0, Math.min(this.maxHp() - h.hp, Math.round(n)))
    h.hp += got
    if (!quiet && got) this.say('', `+${got} HP`)
    return got
  }

  // --- rooms -------------------------------------------------------------------------

  private merchantStock(): { item: Item; price: number }[] {
    const f = this.r.floor
    const mark = 1 + f * 0.02
    const stock: Item[] = [consumable(bestHealing(f), this.uid()), consumable('healing', this.uid())]
    const pots = Object.values(CONSUMABLES).filter(c => c.floor <= f && c.kind !== 'key' && c.id !== 'healing')
    stock.push(consumable(this.rng.pick(pots).id, this.uid()))
    const scrolls = Object.values(CONSUMABLES).filter(c => c.floor <= f && c.kind === 'scroll')
    if (scrolls.length) stock.push(consumable(this.rng.pick(scrolls).id, this.uid()))
    stock.push(this.rng.chance(0.5) ? this.gearFor('weapon') : this.gearFor('armor'))
    const trinkets = Object.values(TRINKETS).filter(t => t.floor <= f + 1 && !this.hasTrinket(t.id))
    if (trinkets.length && this.rng.chance(0.7)) stock.push({ uid: this.uid(), kind: 'trinket', base: this.rng.pick(trinkets).id, plus: 0, qty: 1 })
    stock.push(consumable('skeleton-key', this.uid()))
    const seen = new Set<string>()
    return stock
      .filter(i => (seen.has(i.base + i.plus) ? false : (seen.add(i.base + i.plus), true)))
      .map(item => ({ item, price: Math.round(itemValue(item) * mark) }))
  }

  private gearFor(kind: 'weapon' | 'armor'): Item {
    for (let i = 0; i < 20; i++) {
      const it = rollItem(this.rng, this.lootOpts(1))
      if (it.kind === kind && (kind === 'weapon' || this.canWear(it))) return it
    }
    return consumable('greater-healing', this.uid())
  }

  private check(a: Ability, dc: number): { ok: boolean; roll: number } {
    const c = classDef(this.hero.cls)
    // Proficiency when the class is trained in it (their saves double as skills here).
    const roll = this.d20(0) + this.mod(a) + (c.saves.includes(a) ? this.prof() : 0) + this.luck() + (this.hero.fx.blessed ? 1 : 0) - (this.hero.fx.cursed ? 1 : 0)
    return { ok: roll >= dc, roll }
  }

  private checkLine(a: Ability, dc: number, res: { ok: boolean; roll: number }): string {
    return `${ABILITY_NAME[a]} ${res.roll} vs ${dc}: ${res.ok ? 'success' : 'fail'}`
  }

  private openChest() {
    const r = this.r
    const room = r.room
    if (room?.kind !== 'treasure') return
    if (room.mimic) {
      r.room = null
      return this.startCombat('mimic')
    }
    const gold = Math.round((this.rng.roll('2d10') + 8 + r.floor * 6) * (1 + 0.5 * this.perk('deep-pockets')))
    this.hero.gold += gold
    r.stats.goldEarned += gold
    this.say(`Inside: ${gold} gold.`, `+${gold}g`)
    if (this.rng.chance(0.75)) this.gainItem(rollItem(this.rng, this.lootOpts(room.locked ? 1 : 0)))
    this.finishRoom()
  }

  applyOutcome(o: Outcome, targetIndex?: number) {
    const r = this.r
    const h = this.hero
    const f = r.floor
    const max = this.maxHp()
    if (o.text) this.say(o.text)
    switch (o.effect) {
      case 'heal': {
        const n = this.heal(Math.max(4, Math.round(max * 0.2)))
        this.say('', `+${n} HP`)
        break
      }
      case 'hurt':
      case 'hurt_big':
      case 'poison': {
        const n = o.effect === 'hurt_big' ? Math.round(max * 0.25) : Math.max(2, Math.round(max * 0.1) + Math.floor(f / 2))
        this.say('', `you −${n}`)
        this.hurtHero(n, o.effect === 'poison' ? 'poison' : 'misfortune')
        break
      }
      case 'gold':
      case 'gold_big': {
        const n = o.effect === 'gold' ? 10 + f * 6 + this.rng.d(10) : 30 + f * 15 + this.rng.d(20)
        h.gold += n
        r.stats.goldEarned += n
        this.say('', `+${n}g`)
        break
      }
      case 'lose_gold': {
        const n = Math.min(h.gold, Math.max(5, Math.round(h.gold * 0.25)))
        h.gold -= n
        this.say('', `−${n}g`)
        break
      }
      case 'item':
        this.gainItem(rollItem(this.rng, this.lootOpts(0)))
        break
      case 'rare_item':
        this.gainItem(rollItem(this.rng, this.lootOpts(1)))
        break
      case 'bless':
        h.fx.blessed = FLOOR
        delete h.fx.cursed
        this.say('', 'blessed')
        break
      case 'curse':
        h.fx.cursed = FLOOR
        delete h.fx.blessed
        this.say('', 'cursed')
        break
      case 'xp':
        this.gainXp(20 * f + 10)
        this.say('', `+${20 * f + 10} xp`)
        break
      case 'companion': {
        const pool = COMPANIONS.filter(c => c.id !== r.companion?.id)
        this.joinCompanion(this.rng.pick(pool).id)
        break
      }
      case 'damage':
      case 'damage_big': {
        const t = this.target(targetIndex)
        if (!t) break
        const w = WEAPONS[h.weapon.base]
        let n = this.rng.roll(w.dice) + Math.max(0, this.mod(this.weaponAbility())) + h.weapon.plus
        if (o.effect === 'damage_big') n = n * 2 + h.level
        this.say('', `${t.name} −${n}`)
        this.damageEnemy(t, n)
        break
      }
      case 'stun': {
        const t = this.target(targetIndex)
        if (t) {
          t.fx.stunned = 1
          this.say('', `${t.name} stunned`)
        }
        break
      }
      case 'flee_enemy': {
        const t = this.target(targetIndex)
        if (t && !t.boss) {
          t.xp = Math.round(t.xp / 2)
          this.kill(t, `The ${t.name} flees into the dark.`)
        } else if (t) t.fx.stunned = 1
        break
      }
      case 'pacify': {
        const c = r.combat
        if (!c) break
        if (c.kind === 'boss') {
          for (const e of this.alive()) e.fx.stunned = 1
          break
        }
        for (const e of this.alive()) {
          e.xp = Math.round(e.xp / 2)
          e.gold = 0
          e.hp = 0
          c.xp += e.xp
        }
        this.say('', 'pacified')
        break
      }
      case 'advantage':
        h.fx.hidden = 2
        this.say('', 'advantage')
        break
      case 'escape':
        if (r.combat && r.combat.kind !== 'boss') {
          r.combat.used.escaped = true
          r.combat.enemies = []
          r.combat.xp = 0
          r.combat.gold = 0
          this.say('', 'escaped')
        }
        break
      case 'fight':
      case 'none':
        break
    }
  }

  private joinCompanion(id: string) {
    const r = this.r
    const old = this.companionDef()
    r.companion = { id, hp: 1, cooldown: 0, stunned: 0 }
    const cs = this.companionStats()!
    r.companion.hp = cs.maxHp
    this.say(`${cs.def.name} the ${cs.def.kind} joins you!${old ? ` ${old.name} goes their own way.` : ''}`, `+${cs.def.name}`)
  }

  // --- the one entry point for choices -------------------------------------------------

  choose(id: string, targetIndex?: number): ActResult {
    const mode = this.mode
    const valid = this.options().some(o => o.id === id)
    if (!valid) return { ok: false, reason: 'That isn\'t possible right now.' }

    if (mode === 'class') {
      this.newHero(id.split(':')[1] as ClassId)
      this.beginTurn()
      const c = classDef(this.hero.cls)
      this.say(`A ${c.name}. ${c.blurb}`)
      this.endTurn()
      return { ok: true }
    }

    const r = this.r
    // A stunned hero loses the turn to whatever they tried.
    if (mode === 'combat' && this.hero.fx.stunned && id !== 'items' && id !== 'back') {
      this.beginTurn()
      delete this.hero.fx.stunned
      this.say('You can\'t move!')
      this.afterHeroAction()
      this.endTurn()
      return { ok: true }
    }

    if (id === 'items' || id === 'back') {
      if (r.combat) r.combat.menu = id === 'items' ? 'items' : 'main'
      return { ok: true }
    }

    this.beginTurn()
    const res = this.resolve(id, targetIndex)
    if (!res.ok) {
      r.lines = []
      r.tally = []
    }
    this.endTurn()
    return res
  }

  private resolve(id: string, targetIndex?: number): ActResult {
    const r = this.r
    const h = this.hero
    const [verb, arg] = id.split(':')
    switch (r.mode) {
      case 'name':
        this.startAdventure()
        return { ok: true }

      case 'doors':
        this.chooseDoor(Number(arg))
        return { ok: true }

      case 'combat': {
        const c = r.combat!
        c.menu = 'main'
        let res: ActResult = { ok: true }
        if (verb === 'attack') {
          const t = this.target(Number(arg))
          if (!t) return { ok: false, reason: 'Nothing to attack.' }
          this.heroAttack(t)
          if (this.perk('extra-attack') && t.hp > 0 && this.alive().length) {
            c.used.sneakTurn = true
            this.heroAttack(this.target() ?? t)
          }
        } else if (verb === 'skill') res = this.useSkill(arg, targetIndex)
        else if (verb === 'item') res = this.useItem(arg, targetIndex)
        else if (verb === 'flee') return this.flee()
        if (!res.ok || r.mode !== 'combat') return res
        this.afterHeroAction()
        return res
      }

      case 'loot': {
        const p = r.queue.shift()
        if (p?.kind !== 'loot') return this.advanceOk()
        const item = p.item
        if (verb === 'equip') {
          if (item.kind === 'weapon') {
            const old = h.weapon
            h.weapon = item
            const v = salvageValue(old)
            h.gold += v
            this.say(`You now wield the ${itemName(item)}. The old ${itemName(old)} fetches ${v} gold.`)
          } else if (item.kind === 'armor') {
            const old = h.armor
            h.armor = item
            const v = old ? salvageValue(old) : 0
            h.gold += v
            this.say(`You strap on the ${itemName(item)}.${old ? ` The old armor fetches ${v} gold.` : ''}`)
          }
        } else if (verb === 'replace') {
          const i = Number(arg)
          const old = h.trinkets[i]
          h.trinkets[i] = item
          const v = old ? salvageValue(old) : 0
          h.gold += v
          this.say(`You put on the ${itemName(item)}.${old ? ` The ${itemName(old)} fetches ${v} gold.` : ''}`)
        } else {
          const v = salvageValue(item)
          h.gold += v
          this.say(`You salvage the ${itemName(item)} for ${v} gold.`, `+${v}g`)
        }
        return this.advanceOk()
      }

      case 'perk': {
        const p = r.queue.shift()
        if (p?.kind === 'perk') this.applyPerk(arg)
        return this.advanceOk()
      }

      case 'treasure': {
        const room = r.room
        if (room?.kind !== 'treasure') return this.advanceOk()
        if (verb === 'open' || verb === 'key') {
          if (verb === 'key') {
            this.takeFromPack('skeleton-key')
            this.say('The skeleton key turns with a satisfying clunk.')
          }
          this.openChest()
        } else if (verb === 'pick') {
          const res = this.check('dex', 12 + Math.floor(r.floor / 3))
          this.say(this.checkLine('dex', 12 + Math.floor(r.floor / 3), res))
          if (res.ok) {
            this.say('The lock clicks open.')
            this.openChest()
          } else {
            room.jammed = true
            const n = this.rng.roll('1d6') + Math.floor(r.floor / 2)
            this.say(`A hidden needle pricks you. (−${n}) The lock jams.`, `you −${n}`)
            this.hurtHero(n, 'a poisoned lock')
          }
        } else if (verb === 'smash') {
          const res = this.check('str', 13)
          this.say(this.checkLine('str', 13, res))
          if (res.ok) {
            this.say('The lid splinters open.')
            this.openChest()
          } else {
            room.stuck = true
            this.say('The chest won\'t budge.')
          }
        } else if (verb === 'leave') {
          this.say('You leave the chest to the dust.')
          this.finishRoom()
        }
        return { ok: true }
      }

      case 'shrine': {
        const room = r.room
        if (room?.kind !== 'shrine') return this.advanceOk()
        if (verb === 'pray') {
          const res = this.check('wis', 12)
          this.say(this.checkLine('wis', 12, res))
          if (res.ok) {
            h.fx.blessed = FLOOR
            delete h.fx.cursed
            const n = this.heal(Math.round(this.maxHp() * 0.25))
            this.say(`Warm light fills you. Blessed for this floor. (+${n} HP)`, 'blessed')
          } else {
            h.fx.cursed = FLOOR
            this.say('A cold silence answers. You feel cursed.', 'cursed')
          }
        } else if (verb === 'offer') {
          if (h.gold < room.cost) return { ok: false, reason: `You need ${room.cost} gold.` }
          h.gold -= room.cost
          h.fx.blessed = FLOOR
          delete h.fx.cursed
          const n = this.heal(Math.round(this.maxHp() * 0.5))
          for (const s of this.knownSkills()) {
            const m = this.maxUses(s)
            if (m !== null) h.uses[s] = Math.min(m, (h.uses[s] ?? 0) + 1)
          }
          this.say(`Your gold vanishes in light. Blessed, healed ${n}, and your skills stir.`, `+${n} HP`)
        } else if (verb === 'pact') {
          const loss = Math.max(2, Math.round(this.maxHp() * 0.1))
          h.hpBase -= loss
          h.hp = Math.min(h.hp, this.maxHp())
          this.say(`You cut your palm on the altar. (−${loss} max HP) Power answers.`, `−${loss} max HP`)
          r.queue.push({ kind: 'perk', choices: this.perkChoices(), reason: 'Blood pact' })
        } else if (verb === 'leave') this.say('You leave the shrine in peace.')
        this.finishRoom()
        return { ok: true }
      }

      case 'merchant': {
        const room = r.room
        if (room?.kind !== 'merchant') return this.advanceOk()
        if (verb === 'buy') {
          const entry = room.stock[Number(arg)]
          if (!entry) return { ok: false, reason: 'Sold out.' }
          if (h.gold < entry.price) return { ok: false, reason: `That costs ${entry.price} gold. You have ${h.gold}.` }
          const item = entry.item
          if (item.kind === 'armor' && !this.canWear(item)) return { ok: false, reason: 'That armor is too heavy for you.' }
          h.gold -= entry.price
          room.stock.splice(Number(arg), 1)
          if (isConsumable(item)) this.addToPack(item)
          else if (item.kind === 'weapon') {
            const v = salvageValue(h.weapon)
            h.gold += v
            h.weapon = item
          } else if (item.kind === 'armor') {
            if (h.armor) h.gold += salvageValue(h.armor)
            h.armor = item
          } else if (item.kind === 'trinket') {
            if (h.trinkets.length >= TRINKET_SLOTS) {
              const old = h.trinkets.shift()!
              h.gold += salvageValue(old)
              this.say(`You trade in the ${itemName(old)}.`)
            }
            h.trinkets.push(item)
          }
          this.say(`You buy ${aName(itemName(item))} for ${entry.price} gold.`, `−${entry.price}g`)
          return { ok: true }
        }
        if (verb === 'sell') {
          const item = h.pack.find(i => i.base === arg)
          if (!item) return { ok: false, reason: 'You don\'t have that.' }
          const v = salvageValue(item)
          this.takeFromPack(arg)
          h.gold += v
          this.say(`The merchant pays ${v} gold for the ${itemName(item)}.`, `+${v}g`)
          return { ok: true }
        }
        this.say('"Come back alive," the merchant calls.')
        this.finishRoom()
        return { ok: true }
      }

      case 'rest': {
        if (verb === 'rest') {
          const n = this.heal(Math.round(this.maxHp() * 0.5))
          this.refillUses()
          const cs = this.companionStats()
          if (r.companion && cs) r.companion.hp = cs.maxHp
          this.say(`You rest by the fire. +${n} HP, and every skill is restored.`, `+${n} HP`)
        } else if (verb === 'sharpen') {
          if (h.weapon.plus >= 3) return { ok: false, reason: 'Only magic can improve this weapon now.' }
          h.weapon.plus++
          this.say(`You hone your weapon by the fire. It is now ${itemName(h.weapon)}.`, `weapon +${h.weapon.plus}`)
        } else this.say('You move on.')
        this.finishRoom()
        return { ok: true }
      }

      case 'trap': {
        const room = r.room
        if (room?.kind !== 'trap') return this.advanceOk()
        if (verb === 'search') {
          const res = this.check('wis', room.dc)
          this.say(this.checkLine('wis', room.dc, res))
          if (res.ok) {
            const gold = 5 + r.floor * 4 + this.rng.d(10)
            h.gold += gold
            this.say(`You find the trigger and jam it. Among the old victims: ${gold} gold.`, `+${gold}g`)
            if (this.rng.chance(0.4)) this.gainItem(rollItem(this.rng, this.lootOpts(0)))
          } else this.springTrap(room.dmg, room.dc)
        } else {
          const res = this.check('dex', room.dc)
          this.say(this.checkLine('dex', room.dc, res))
          if (res.ok) this.say('You dive through unscathed!')
          else this.springTrap(room.dmg, room.dc, true)
        }
        if (h.hp > 0) this.finishRoom()
        return { ok: true }
      }

      case 'event': {
        const room = r.room
        if (room?.kind !== 'event') return this.advanceOk()
        if (verb === 'leave') {
          this.say('You leave it be.')
          this.finishRoom()
          return { ok: true }
        }
        const choice = room.ev.choices[Number(arg)]
        if (!choice) return { ok: false }
        this.resolveCheck(choice)
        return { ok: true }
      }

      case 'recruit': {
        const room = r.room
        if (room?.kind !== 'recruit') return this.advanceOk()
        const def = COMPANIONS.find(c => c.id === room.comp)!
        if (verb === 'recruit') {
          room.tried = true
          const dc = clamp(12 + Math.floor(r.floor / 3), 12, 18)
          const res = this.check('cha', dc)
          this.say(this.checkLine('cha', dc, res))
          if (!res.ok) {
            this.say(`${def.name} isn't convinced. "Gold talks."`)
            return { ok: true }
          }
          this.joinCompanion(def.id)
        } else if (verb === 'pay') {
          if (h.gold < room.price) return { ok: false, reason: `${def.name} wants ${room.price} gold. You have ${h.gold}.` }
          h.gold -= room.price
          this.say(`You pay ${room.price} gold.`, `−${room.price}g`)
          this.joinCompanion(def.id)
        } else this.say(`You leave ${def.name} behind.`)
        this.finishRoom()
        return { ok: true }
      }

      case 'stairs':
        r.floor++
        this.say(`You descend.`)
        this.enterFloor()
        return { ok: true }

      case 'dead':
        this.run = null
        return { ok: true }
    }
    return { ok: false }
  }

  private advanceOk(): ActResult {
    this.advance()
    return { ok: true }
  }

  private springTrap(dmg: string, dc: number, rolledDex = false) {
    let n = this.rng.roll(dmg)
    if (!rolledDex && this.heroSave('dex') >= dc) {
      n = Math.floor(n / 2)
      this.say(`The trap springs! You twist away from the worst of it. (−${n})`, `you −${n}`)
    } else this.say(`The trap springs! (−${n})`, `you −${n}`)
    this.hurtHero(n, 'a trap')
  }

  /** An event choice, or an event-room ruling: roll, apply, move on. */
  private resolveCheck(choice: { ability: Ability | 'none'; dc: number; success: Outcome; failure: Outcome }) {
    const r = this.r
    let ok = true
    if (choice.ability !== 'none') {
      const res = this.check(choice.ability, choice.dc)
      ok = res.ok
      this.say(this.checkLine(choice.ability, choice.dc, res))
    }
    const outcome = ok ? choice.success : choice.failure
    this.applyOutcome(outcome)
    if (this.hero.hp <= 0) return
    if (outcome.effect === 'fight') {
      r.room = null
      this.startCombat('event')
      return
    }
    this.finishRoom()
  }

  /**
   * Applies a DM ruling for something the player said. The DM's numbers are
   * clamped and its effects restricted to what makes sense where the hero is.
   */
  resolveRuling(raw: Ruling): ActResult {
    const r = this.r
    const mode = r.mode
    if (!['combat', 'doors', 'treasure', 'shrine', 'merchant', 'rest', 'trap', 'event', 'recruit', 'stairs'].includes(mode)) {
      return { ok: false, reason: 'Not now.' }
    }
    const allowed = mode === 'combat' ? COMBAT_EFFECTS : EVENT_EFFECTS
    const clean = (o: Outcome | undefined): Outcome => {
      let effect: EffectKind = o && allowed.includes(o.effect) ? o.effect : 'none'
      // Outside events, talking your way into loot is capped at once per room.
      if (mode !== 'combat' && mode !== 'event' && r.freeform > 0 && ['gold', 'gold_big', 'item', 'rare_item', 'xp', 'companion', 'heal', 'bless'].includes(effect)) effect = 'none'
      if (mode !== 'event' && ['gold_big', 'rare_item', 'companion'].includes(effect)) effect = effect === 'gold_big' ? 'gold' : effect === 'rare_item' ? 'item' : 'none'
      if (mode !== 'combat' && mode !== 'event' && effect === 'fight') effect = 'hurt'
      return { effect, text: (o?.text ?? '').slice(0, 280) }
    }
    const ability: Ability | 'none' = ['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(raw.ability) ? raw.ability : 'none'
    const ruling = {
      ability,
      dc: clamp(Math.round(Number(raw.dc) || 12), 5, 25),
      success: clean(raw.success),
      failure: clean(raw.failure),
    }
    this.beginTurn()
    r.freeform++

    if (mode === 'combat') {
      if (this.hero.fx.stunned) {
        delete this.hero.fx.stunned
        this.say('You can\'t move!')
      } else {
        let ok = true
        if (ruling.ability !== 'none') {
          const res = this.check(ruling.ability, ruling.dc)
          ok = res.ok
          this.say(this.checkLine(ruling.ability, ruling.dc, res))
        }
        this.applyOutcome(ok ? ruling.success : ruling.failure, raw.target)
      }
      if (this.hero.hp > 0 && r.mode === 'combat') this.afterHeroAction()
      this.endTurn()
      return { ok: true }
    }

    if (mode === 'event') {
      this.resolveCheck(ruling)
      this.endTurn()
      return { ok: true }
    }

    // Anywhere else: the action happens, but the room stays open.
    let ok = true
    if (ruling.ability !== 'none') {
      const res = this.check(ruling.ability, ruling.dc)
      ok = res.ok
      this.say(this.checkLine(ruling.ability, ruling.dc, res))
    }
    this.applyOutcome(ok ? ruling.success : ruling.failure)
    // Anything found or learned here waits in the queue for the end of the room.
    this.endTurn()
    return { ok: true }
  }

  /** Voice-only merchant selling ("sell my antidote"). */
  sell(base: string): ActResult {
    if (this.mode !== 'merchant') return { ok: false, reason: 'There is no one to sell to.' }
    this.beginTurn()
    const res = this.resolve(`sell:${base}`)
    this.endTurn()
    return res
  }

  /** Drinking a potion outside a fight, from the inventory. */
  useOutside(base: string): ActResult {
    if (this.mode === 'combat' || this.mode === 'dead' || this.mode === 'class' || this.mode === 'name') return { ok: false, reason: 'Not now.' }
    this.beginTurn()
    const res = this.useItem(base)
    if (!res.ok) {
      this.r.lines = []
      this.r.tally = []
    }
    this.endTurn()
    return res
  }

  // --- options ------------------------------------------------------------------------

  options(): Option[] {
    const mode = this.mode
    if (mode === 'class') {
      return CLASSES.map(c => ({ id: `class:${c.id}`, label: c.name, words: c.words, detail: c.blurb }))
    }
    const r = this.r
    const h = this.hero
    switch (mode) {
      case 'name':
        return [{ id: 'name:keep', label: `Keep "${h.name}"`, words: ['keep', 'random', 'skip', 'that is fine', 'ok', 'okay', 'yes', h.name.toLowerCase()] }]
      case 'doors':
        return r.doors.map((d, i) => {
          const name = this.doorName(i, r.doors.length)
          const kind = d.hidden ? '???' : ROOM_INFO[d.kind].name
          const words = [name.toLowerCase(), ...(d.hidden ? ['dark', 'darkness', 'unknown', 'mystery'] : [ROOM_INFO[d.kind].name.toLowerCase(), d.kind])]
          if (name === 'Middle') words.push('center', 'centre', 'straight', 'ahead', 'forward')
          if (name === 'Onward') words.push('go', 'enter', 'open', 'forward', 'onward', 'boss', 'fight')
          return { id: `door:${i}`, label: `${name}: ${kind}`, words, detail: d.hint }
        })
      case 'combat':
        return this.combatOptions()
      case 'loot': {
        const p = r.queue[0]
        if (p?.kind !== 'loot') return [{ id: 'skip', label: 'Continue', words: ['continue', 'ok'] }]
        const v = salvageValue(p.item)
        const salvage = { id: 'salvage', label: `Salvage ${v}g`, words: ['salvage', 'sell', 'leave', 'leave it', 'no', 'keep mine', 'skip', 'scrap'] }
        if (p.item.kind === 'trinket') {
          return [
            ...h.trinkets.map((t, i) => ({ id: `replace:${i}`, label: `Swap ${shortName(itemName(t))}`, words: [`replace ${itemName(t).toLowerCase()}`, `swap ${itemName(t).toLowerCase()}`, itemName(t).toLowerCase(), i === 0 ? 'first' : 'second'] })),
            salvage,
          ]
        }
        return [{ id: 'equip', label: 'Equip', words: ['equip', 'take', 'take it', 'use it', 'wear', 'wield', 'yes', 'swap', 'keep it'] }, salvage]
      }
      case 'perk': {
        const p = r.queue[0]
        if (p?.kind !== 'perk') return [{ id: 'skip', label: 'Continue', words: ['continue'] }]
        return p.choices.map(id => {
          const def = PERKS.find(x => x.id === id)!
          return { id: `perk:${id}`, label: def.name, words: def.words, detail: def.blurb }
        })
      }
      case 'treasure': {
        const room = r.room
        if (room?.kind !== 'treasure') return []
        const leave = { id: 'leave', label: 'Leave', words: ['leave', 'leave it', 'walk away', 'move on', 'ignore'] }
        if (!room.locked) return [{ id: 'open', label: 'Open', words: ['open', 'open it', 'loot', 'look inside', 'take'] }, leave]
        const opts: Option[] = []
        if (this.countOf('skeleton-key')) opts.push({ id: 'key', label: 'Use key', words: ['key', 'use key', 'skeleton key', 'unlock'] })
        if (!room.jammed) opts.push({ id: 'pick', label: 'Pick lock', words: ['pick', 'pick the lock', 'lockpick', 'pick lock', 'unlock'] })
        if (!room.stuck) opts.push({ id: 'smash', label: 'Smash', words: ['smash', 'break', 'bash', 'force', 'smash it', 'kick'] })
        opts.push(leave)
        return opts
      }
      case 'shrine': {
        const room = r.room
        if (room?.kind !== 'shrine') return []
        return [
          { id: 'pray', label: 'Pray', words: ['pray', 'prayer', 'kneel', 'worship'] },
          { id: 'offer', label: `Offer ${room.cost}g`, words: ['offer', 'offering', 'donate', 'pay', 'gold', 'tithe'] },
          { id: 'pact', label: 'Blood pact', words: ['blood', 'pact', 'blood pact', 'sacrifice', 'cut'] },
          { id: 'leave', label: 'Leave', words: ['leave', 'move on', 'walk away'] },
        ]
      }
      case 'merchant': {
        const room = r.room
        if (room?.kind !== 'merchant') return []
        const opts: Option[] = room.stock.map((s, i) => ({
          id: `buy:${i}`,
          label: `${shortName(itemName(s.item))} ${s.price}g`,
          detail: itemDesc(s.item),
          words: itemWords(s.item).flatMap(w => [w, `buy ${w}`]),
        }))
        for (const it of h.pack) {
          opts.push({ id: `sell:${it.base}`, label: `Sell ${itemName(it)}`, words: itemWords(it).map(w => `sell ${w}`), hidden: true })
        }
        opts.push({ id: 'leave', label: 'Leave', words: ['leave', 'goodbye', 'bye', 'done', 'move on', 'nothing'] })
        return opts
      }
      case 'rest': {
        const opts: Option[] = [{ id: 'rest', label: 'Rest', words: ['rest', 'sleep', 'camp', 'heal', 'recover', 'sit'] }]
        if (h.weapon.plus < 3) opts.push({ id: 'sharpen', label: 'Sharpen', words: ['sharpen', 'hone', 'improve weapon', 'whetstone', 'train'] })
        opts.push({ id: 'leave', label: 'Move on', words: ['leave', 'move on', 'keep going', 'continue'] })
        return opts
      }
      case 'trap':
        return [
          { id: 'search', label: 'Disarm (WIS)', words: ['search', 'disarm', 'look', 'careful', 'carefully', 'find'] },
          { id: 'dash', label: 'Dash (DEX)', words: ['dash', 'run', 'sprint', 'jump', 'rush', 'dodge'] },
        ]
      case 'event': {
        const room = r.room
        if (room?.kind !== 'event') return []
        return [
          ...room.ev.choices.map((c, i) => ({ id: `choice:${i}`, label: c.label, detail: c.ability === 'none' ? '' : c.ability.toUpperCase(), words: [c.label.toLowerCase(), ...c.label.toLowerCase().split(' ').filter(w => w.length > 3)] })),
          { id: 'leave', label: 'Leave', words: ['leave', 'walk away', 'ignore', 'move on'] },
        ]
      }
      case 'recruit': {
        const room = r.room
        if (room?.kind !== 'recruit') return []
        const opts: Option[] = []
        if (!room.tried) opts.push({ id: 'recruit', label: 'Recruit (CHA)', words: ['recruit', 'ask', 'join', 'persuade', 'convince', 'come with me', 'invite'] })
        opts.push({ id: 'pay', label: `Hire ${room.price}g`, words: ['pay', 'hire', 'gold', 'buy'] })
        opts.push({ id: 'leave', label: 'Leave', words: ['leave', 'no', 'no thanks', 'move on'] })
        return opts
      }
      case 'stairs':
        return [{ id: 'descend', label: 'Descend', words: ['descend', 'down', 'go down', 'stairs', 'continue', 'next floor', 'onward', 'yes'] }]
      case 'dead':
        return [{ id: 'new', label: 'New hero', words: ['new', 'new hero', 'again', 'restart', 'new game', 'play again', 'yes'] }]
    }
    return []
  }

  private combatOptions(): Option[] {
    const c = this.r.combat!
    const h = this.hero
    if (c.menu === 'items') {
      const opts: Option[] = h.pack
        .filter(i => CONSUMABLES[i.base].combat)
        .map(i => ({ id: `item:${i.base}`, label: `${shortName(itemName(i))}${i.qty > 1 ? ` ×${i.qty}` : ''}`, words: itemWords(i) }))
      opts.push({ id: 'back', label: 'Back', words: ['back', 'never mind', 'cancel', 'return'] })
      return opts
    }
    const opts: Option[] = []
    const alive = c.enemies.map((e, i) => ({ e, i })).filter(x => x.e.hp > 0)
    const attackWords = ['attack', 'hit', 'strike', 'slash', 'stab', 'swing', 'shoot', 'kill', 'fight', 'charge', 'smash', 'cut', 'punch']
    for (const { e, i } of alive) {
      opts.push({
        id: `attack:${i}`,
        label: alive.length > 1 ? `Hit ${shortName(e.name)}` : 'Attack',
        words: alive.length > 1 ? [...e.words.map(w => `attack ${w}`), ...e.words, `attack ${e.name.toLowerCase()}`] : attackWords,
      })
    }
    if (alive.length > 1) {
      // "attack" alone goes to the current focus.
      const focus = c.enemies[c.focus]?.hp > 0 ? c.focus : alive[0].i
      opts.push({ id: `attack:${focus}`, label: 'Attack', words: attackWords, hidden: true })
    }
    for (const id of this.knownSkills()) {
      const def = SKILLS[id]
      const max = this.maxUses(id)
      const left = h.uses[id] ?? 0
      if (max !== null && left <= 0) continue
      if (id === 'turn-undead' && !alive.some(x => x.e.traits.includes('undead'))) continue
      if (id === 'rage' && h.fx.rage) continue
      opts.push({ id: `skill:${id}`, label: `${def.name}${max !== null ? ` ×${left}` : ''}`, words: def.words, detail: def.blurb })
    }
    const heal = ['superior-healing', 'greater-healing', 'healing'].find(b => this.countOf(b))
    if (heal) {
      const total = ['superior-healing', 'greater-healing', 'healing'].reduce((n, b) => n + this.countOf(b), 0)
      opts.push({ id: `item:${heal}`, label: `Potion ×${total}`, words: ['potion', 'drink', 'drink potion', 'heal', 'healing', 'health potion', 'healing potion', 'quaff'] })
    }
    const usable = h.pack.filter(i => CONSUMABLES[i.base].combat)
    if (usable.some(i => !i.base.includes('healing'))) opts.push({ id: 'items', label: 'Items', words: ['items', 'item', 'bag', 'inventory', 'pack', 'backpack', 'use item'] })
    // Every usable item is also reachable by name without opening the bag.
    for (const i of usable) opts.push({ id: `item:${i.base}`, label: itemName(i), words: itemWords(i).flatMap(w => [w, `use ${w}`, `drink ${w}`, `read ${w}`]), hidden: true })
    if (c.kind !== 'boss') opts.push({ id: 'flee', label: 'Flee', words: ['flee', 'run', 'run away', 'escape', 'retreat'] })
    return opts
  }

  // --- what the lens shows --------------------------------------------------------------

  scene(): Scene {
    const mode = this.mode
    if (mode === 'class') {
      return {
        title: 'DELVE',
        icon: 'dice-twenty-faces-twenty',
        caption: 'Pick a hero',
        bar: null,
        dim: false,
        prompt: 'Welcome to Delve, an endless dungeon. Choose your hero.',
        options: this.options(),
      }
    }
    const r = this.r
    const h = this.hero
    const c = classDef(h.cls)
    const base = { title: `Floor ${r.floor}`, icon: c.icon as IconName, caption: h.name, bar: { hp: h.hp, max: this.maxHp() }, dim: false, options: this.options() }
    switch (mode) {
      case 'name':
        return { ...base, title: c.name, prompt: `What do they call you, ${c.name}? Say your name, or keep "${h.name}".` }
      case 'doors': {
        const parts = r.doors.map((d, i) => `${this.doorName(i, r.doors.length)}: ${d.hint}.`)
        const intro = r.doors.length === 1 ? (r.doors[0].kind === 'boss' ? 'A great door, carved with warnings. Something waits beyond.' : parts[0]) : 'Which way?'
        return { ...base, icon: r.doors[0]?.kind === 'boss' ? 'crowned-skull' : 'wooden-door', caption: `Room ${r.step + 1}/${ROOMS_PER_FLOOR}`, bar: null, prompt: intro }
      }
      case 'combat': {
        const cb = r.combat!
        const t = cb.enemies[cb.focus]?.hp > 0 ? cb.enemies[cb.focus] : this.alive()[0]
        const foes = this.alive().map(e => `${e.name} ${e.hp}/${e.maxHp}`).join(' · ')
        const prompt = cb.menu === 'items' ? 'Which item?' : `${this.alive().length > 1 ? foes : ''}${h.fx.stunned ? ' You are stunned!' : ''}`.trim()
        return { ...base, icon: t?.icon ?? base.icon, caption: t?.name ?? '', bar: t ? { hp: t.hp, max: t.maxHp } : null, prompt }
      }
      case 'loot': {
        const p = r.queue[0]
        if (p?.kind !== 'loot') return { ...base, prompt: '' }
        const it = p.item
        const current = it.kind === 'weapon' ? h.weapon : it.kind === 'armor' ? h.armor : null
        const vs = it.kind === 'trinket'
          ? `Your slots are full: ${h.trinkets.map(t => itemName(t)).join(' and ')}.`
          : current ? `Yours: ${itemName(current)} (${itemDesc(current)}).` : 'You have none.'
        return { ...base, icon: itemIcon(it), caption: 'Loot', bar: null, prompt: `${itemName(it)}: ${itemDesc(it)}. ${vs}` }
      }
      case 'perk': {
        const p = r.queue[0]
        if (p?.kind !== 'perk') return { ...base, prompt: '' }
        const list = p.choices.map(id => {
          const d = PERKS.find(x => x.id === id)!
          return `${d.name}: ${d.blurb}`
        })
        return { ...base, icon: 'progression', caption: p.reason, bar: null, prompt: `Choose a power. ${list.join(' ')}` }
      }
      case 'treasure':
        return { ...base, icon: (r.room as { locked?: boolean })?.locked ? 'locked-chest' : 'open-treasure-chest', caption: 'Treasure', bar: null, prompt: (r.room as { locked?: boolean })?.locked ? 'The chest is locked.' : 'Open it?' }
      case 'shrine':
        return { ...base, icon: 'crystal-shrine', caption: 'Shrine', bar: null, prompt: 'Pray (Wisdom), leave an offering for sure healing, or make a blood pact: max HP for a new power.' }
      case 'merchant':
        return { ...base, icon: 'shop', caption: 'Merchant', bar: null, prompt: `You have ${h.gold} gold. Say "buy" and an item.` }
      case 'rest':
        return { ...base, icon: 'campfire', caption: 'Campfire', bar: null, prompt: `Rest to heal half and restore skills${h.weapon.plus < 3 ? ', or sharpen your weapon (+1)' : ''}.` }
      case 'trap':
        return { ...base, icon: 'wolf-trap', caption: 'Trap', bar: null, prompt: 'Disarm it carefully (Wisdom), or dash through (Dexterity)?' }
      case 'event': {
        const room = r.room
        const ev = room?.kind === 'event' ? room.ev : null
        return { ...base, icon: ev?.icon ?? 'scroll-unfurled', caption: ev?.title ?? '', bar: null, prompt: 'What do you do?' }
      }
      case 'recruit': {
        const room = r.room
        const def = room?.kind === 'recruit' ? COMPANIONS.find(x => x.id === room.comp) : undefined
        return {
          ...base,
          icon: def?.icon ?? 'hooded-figure',
          caption: def?.name ?? '',
          bar: null,
          prompt: `${def ? `${def.name}, ${def.kind}: ${def.blurb}` : ''}${r.companion ? ` (Replaces ${this.companionDef()?.name}.)` : ''}`,
        }
      }
      case 'stairs':
        return { ...base, icon: 'stairs', caption: `Floor ${r.floor} clear`, bar: null, prompt: `Stairs spiral down to floor ${r.floor + 1}, ${themeFor(r.floor + 1)}.` }
      case 'dead':
        return { ...base, icon: 'dead-head', caption: 'Fallen', bar: null, dim: true, prompt: `Slain by ${r.cause} on floor ${r.floor}, at level ${h.level}, with ${r.stats.kills} foes felled.` }
    }
    return { ...base, prompt: '' }
  }

  // --- information pages -------------------------------------------------------------------

  sheetText(): string {
    const h = this.hero
    const c = classDef(h.cls)
    const stats = (['str', 'dex', 'con', 'int', 'wis', 'cha'] as Ability[])
      .map(a => `${a.toUpperCase()} ${this.stat(a)} (${signed(this.mod(a))})`)
      .join('  ')
    const skills = this.knownSkills().map(id => {
      const m = this.maxUses(id)
      return `${SKILLS[id].name}${m !== null ? ` ${h.uses[id] ?? 0}/${m}` : ''}`
    })
    const perks = Object.entries(h.perks).map(([id, n]) => `${PERKS.find(p => p.id === id)?.name ?? id}${n > 1 ? ` ×${n}` : ''}`)
    const cs = this.companionStats()
    const fx = Object.keys(h.fx).filter(k => !['relentlessUsed'].includes(k))
    return [
      `${h.name}, level ${h.level} ${c.name}. HP ${h.hp}/${this.maxHp()}${h.tempHp ? ` +${h.tempHp}` : ''}. AC ${this.ac()}. XP ${h.xp}/${xpForLevel(h.level)}. Gold ${h.gold}.`,
      stats,
      `Attack ${signed(this.attackBonus())} with ${itemName(h.weapon)} (${itemDesc(h.weapon)}).${c.spell ? ` Spell attack ${signed(this.spellAttack())}, save DC ${this.spellDc()}.` : ''}`,
      `Skills: ${skills.join(', ')}.`,
      perks.length ? `Powers: ${perks.join(', ')}.` : '',
      cs && this.r.companion ? `Companion: ${cs.def.name} the ${cs.def.kind}, HP ${this.r.companion.hp}/${cs.maxHp}. ${cs.def.blurb}` : '',
      fx.length ? `Effects: ${fx.join(', ')}.` : '',
    ].filter(Boolean).join('\n\n')
  }

  inventoryText(): string {
    const h = this.hero
    const gear = [
      `Weapon: ${itemName(h.weapon)} (${itemDesc(h.weapon)})`,
      `Armor: ${h.armor ? `${itemName(h.armor)} (${itemDesc(h.armor)})` : classDef(h.cls).unarmored === 'mage' ? 'Mage Armor (13 + DEX)' : classDef(h.cls).unarmored === 'barbarian' ? 'Unarmored (10 + DEX + CON)' : 'none'}`,
      ...h.trinkets.map(t => `${itemName(t)}: ${itemDesc(t)}`),
    ]
    const pack = h.pack.map(i => `${itemName(i)}${i.qty > 1 ? ` ×${i.qty}` : ''}: ${itemDesc(i)}`)
    return `${gear.join('\n')}\n\n${pack.length ? pack.join('\n') : 'Your pack is empty.'}\n\nGold: ${h.gold}`
  }

  /** Facts for the AI Dungeon Master: who, where, what's around. */
  context(): string {
    if (!this.run) return 'The player is choosing a hero.'
    const r = this.r
    const h = this.hero
    const c = classDef(h.cls)
    const cs = this.companionStats()
    const bits = [
      `Hero: ${h.name}, level ${h.level} ${c.name}, HP ${h.hp}/${this.maxHp()}, wielding ${itemName(h.weapon)}.`,
      cs && r.companion ? `Companion: ${cs.def.name} the ${cs.def.kind}.` : '',
      `Location: floor ${r.floor}, ${themeFor(r.floor)}.`,
    ]
    if (r.mode === 'combat' && r.combat) bits.push(`In combat with: ${this.alive().map(e => `${e.name} (${e.hp}/${e.maxHp} HP)`).join(', ')}.`)
    if (r.room?.kind === 'event') bits.push(`Scene: ${r.room.ev.title}. ${r.room.ev.text}`)
    if (r.room?.kind === 'merchant') bits.push('A merchant is here.')
    if (r.room?.kind === 'treasure') bits.push(`A ${r.room.locked ? 'locked ' : ''}chest is here.`)
    if (r.room?.kind === 'shrine') bits.push('A glowing stone shrine is here.')
    if (r.room?.kind === 'trap') bits.push(`A trap: ${r.room.name}.`)
    if (r.room?.kind === 'rest') bits.push('A campfire, safe for now.')
    if (r.mode === 'doors') bits.push(`Paths ahead: ${r.doors.map((d, i) => `${this.doorName(i, r.doors.length)} (${d.hint})`).join(', ')}.`)
    return bits.filter(Boolean).join(' ')
  }

  /** Which enemy a phrase refers to, e.g. "the second goblin" or "the orc". */
  enemyIndex(words: string[]): number | undefined {
    const c = this.run?.combat
    if (!c) return undefined
    const text = ` ${words.join(' ')} `
    const ord = /\b(first|one|1|second|two|2|third|three|3|fourth|four|4)\b/.exec(text)
    const n = ord ? { first: 1, one: 1, '1': 1, second: 2, two: 2, '2': 2, third: 3, three: 3, '3': 3, fourth: 4, four: 4, '4': 4 }[ord[1]] : undefined
    const alive = c.enemies.map((e, i) => ({ e, i })).filter(x => x.e.hp > 0)
    const named = alive.filter(x => x.e.words.some(w => text.includes(` ${w} `)) || text.includes(` ${x.e.name.toLowerCase()} `))
    if (named.length === 1) return named[0].i
    if (named.length > 1 && n) return named[n - 1]?.i ?? named[0].i
    if (named.length > 1) return named[0].i
    if (n && alive.length > 1) return alive[n - 1]?.i
    return undefined
  }
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`
}

function aName(name: string): string {
  if (/^(the |\+|[A-Z][a-z]+ [A-Z][a-z]+ the )/.test(name)) return name
  return /^[aeiou]/i.test(name) ? `an ${name}` : `a ${name}`
}

function listNames(names: string[]): string {
  if (names.length <= 1) return cap(names[0] ?? '')
  return cap(`${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
}

/** Lens labels have to be short. */
export function shortName(name: string): string {
  return name
    .replace(/^Potion of /, '')
    .replace(/^Scroll of /, '')
    .replace(/ Potion$/, '')
    .replace(/Gauntlets of Ogre Power/, 'Ogre Gauntlets')
    .replace(/Periapt of Wound Closure/, 'Periapt')
    .replace(/Headband of Intellect/, 'Headband')
    .replace(/Amulet of the Devout/, 'Devout Amulet')
    .replace(/Cloak of Displacement/, 'Displacer Cloak')
}

