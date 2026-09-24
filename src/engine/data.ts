// Everything the dungeon is made of: heroes, skills, monsters, loot,
// companions, perks and the hand-written events used when no AI is around.
//
// Numbers start from D&D 5e and are then cut for a solo hero (5e assumes a
// party of four). test/engine.test.ts plays thousands of floors with a bot to
// keep the curve honest; retune there, not by feel.

import type { IconName } from '../icons.gen.ts'

export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
export type Stats = Record<Ability, number>
export const ABILITIES: Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha']
export const ABILITY_NAME: Record<Ability, string> = {
  str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma',
}

// --- classes -------------------------------------------------------------------

export type ClassId = 'fighter' | 'rogue' | 'wizard' | 'cleric' | 'ranger' | 'barbarian'
export type ArmorType = 'light' | 'medium' | 'heavy'

export interface ClassDef {
  id: ClassId
  name: string
  icon: IconName
  hitDie: number
  stats: Stats
  /** Heaviest armor worn without penalty. */
  armor: ArmorType | 'none'
  /** A shield on the off arm, always carried. */
  shield?: number
  /** Armor class with no armor on: mage armor, or a barbarian's hide. */
  unarmored?: 'mage' | 'barbarian'
  saves: Ability[]
  /** Casting ability, for spell attacks and save DCs. */
  spell?: Ability
  weapon: string
  armorPiece: string | null
  pack: string[]
  skills: { id: string; level: number }[]
  companion?: string
  blurb: string
  words: string[]
}

export const CLASSES: ClassDef[] = [
  {
    id: 'fighter', name: 'Fighter', icon: 'visored-helm', hitDie: 10,
    stats: { str: 16, dex: 12, con: 15, int: 8, wis: 12, cha: 10 },
    armor: 'heavy', saves: ['str', 'con'], weapon: 'longsword', armorPiece: 'chain-mail',
    pack: ['healing', 'healing'],
    skills: [{ id: 'second-wind', level: 1 }, { id: 'action-surge', level: 1 }, { id: 'cleave', level: 3 }, { id: 'shield-wall', level: 6 }],
    blurb: 'Heavy armor, a big sword, and the nerve to use both.',
    words: ['fighter', 'warrior', 'knight', 'soldier'],
  },
  {
    id: 'rogue', name: 'Rogue', icon: 'hooded-assassin', hitDie: 8,
    stats: { str: 10, dex: 16, con: 14, int: 12, wis: 12, cha: 12 },
    armor: 'light', saves: ['dex', 'int'], weapon: 'rapier', armorPiece: 'leather',
    pack: ['healing', 'skeleton-key'],
    skills: [{ id: 'hide', level: 1 }, { id: 'poison-blade', level: 1 }, { id: 'evasion', level: 4 }, { id: 'assassinate', level: 7 }],
    blurb: 'Strike from the shadows. Sneak attacks hit very hard.',
    words: ['rogue', 'thief', 'assassin', 'rouge', 'road'],
  },
  {
    id: 'wizard', name: 'Wizard', icon: 'wizard-face', hitDie: 6,
    stats: { str: 8, dex: 14, con: 14, int: 16, wis: 12, cha: 10 },
    armor: 'none', unarmored: 'mage', saves: ['int', 'wis'], spell: 'int', weapon: 'quarterstaff', armorPiece: null,
    pack: ['healing'],
    skills: [{ id: 'fire-bolt', level: 1 }, { id: 'magic-missile', level: 1 }, { id: 'shield', level: 1 }, { id: 'thunderwave', level: 3 }, { id: 'fireball', level: 5 }, { id: 'lightning', level: 8 }],
    blurb: 'Fragile, but the spells. Oh, the spells.',
    words: ['wizard', 'mage', 'sorcerer', 'magician', 'wizzard'],
  },
  {
    id: 'cleric', name: 'Cleric', icon: 'sun-priest', hitDie: 8,
    stats: { str: 14, dex: 10, con: 14, int: 10, wis: 16, cha: 12 },
    armor: 'medium', shield: 2, saves: ['wis', 'cha'], spell: 'wis', weapon: 'mace', armorPiece: 'scale',
    pack: ['healing'],
    skills: [{ id: 'sacred-flame', level: 1 }, { id: 'cure-wounds', level: 1 }, { id: 'guiding-bolt', level: 1 }, { id: 'turn-undead', level: 3 }, { id: 'spirit-guardians', level: 5 }],
    blurb: 'Heals, smites, and sends the dead back to their graves.',
    words: ['cleric', 'priest', 'healer', 'paladin', 'clerk'],
  },
  {
    id: 'ranger', name: 'Ranger', icon: 'robin-hood-hat', hitDie: 10,
    stats: { str: 12, dex: 16, con: 14, int: 10, wis: 14, cha: 8 },
    armor: 'medium', saves: ['str', 'dex'], weapon: 'longbow', armorPiece: 'leather',
    pack: ['healing'],
    skills: [{ id: 'hunters-mark', level: 1 }, { id: 'ensnare', level: 1 }, { id: 'volley', level: 3 }, { id: 'hail-of-thorns', level: 6 }],
    companion: 'wolf',
    blurb: 'A longbow, a keen eye, and a loyal wolf at your side.',
    words: ['ranger', 'archer', 'hunter', 'strider'],
  },
  {
    id: 'barbarian', name: 'Barbarian', icon: 'barbarian', hitDie: 12,
    stats: { str: 16, dex: 14, con: 16, int: 8, wis: 10, cha: 8 },
    armor: 'medium', unarmored: 'barbarian', saves: ['str', 'con'], weapon: 'greataxe', armorPiece: null,
    pack: ['healing'],
    skills: [{ id: 'rage', level: 1 }, { id: 'reckless', level: 1 }, { id: 'frenzy', level: 3 }, { id: 'brutal-strike', level: 5 }],
    blurb: 'Rage, a greataxe, and a lot of hit points.',
    words: ['barbarian', 'berserker', 'brute', 'barbarians'],
  },
]

export const classDef = (id: ClassId) => CLASSES.find(c => c.id === id)!

// --- skills --------------------------------------------------------------------

export type SkillTarget = 'enemy' | 'all' | 'self'

export interface SkillDef {
  id: string
  name: string
  /** Uses between rests; null means at will. */
  uses: number | null
  target: SkillTarget
  /** Short and spoken-friendly, for the phone and the help page. */
  blurb: string
  words: string[]
}

export const SKILLS: Record<string, SkillDef> = {
  // fighter
  'second-wind': { id: 'second-wind', name: 'Second Wind', uses: 2, target: 'self', blurb: 'Heal 1d10 + level.', words: ['second wind', 'wind', 'catch my breath', 'recover'] },
  'action-surge': { id: 'action-surge', name: 'Action Surge', uses: 1, target: 'enemy', blurb: 'Attack twice this turn.', words: ['action surge', 'surge', 'attack twice', 'double attack'] },
  cleave: { id: 'cleave', name: 'Cleave', uses: 2, target: 'all', blurb: 'Swing through every enemy.', words: ['cleave', 'sweep', 'hit them all', 'whirlwind'] },
  'shield-wall': { id: 'shield-wall', name: 'Shield Wall', uses: 1, target: 'self', blurb: '+5 armor for 3 rounds.', words: ['shield wall', 'defend', 'block', 'guard', 'brace'] },
  // rogue
  hide: { id: 'hide', name: 'Hide', uses: null, target: 'self', blurb: 'Stealth check. Next attack is a sneak attack.', words: ['hide', 'stealth', 'sneak', 'shadows', 'vanish'] },
  'poison-blade': { id: 'poison-blade', name: 'Poison Blade', uses: 2, target: 'enemy', blurb: 'Attack and poison for 3 rounds.', words: ['poison blade', 'poison', 'venom', 'poisoned blade'] },
  evasion: { id: 'evasion', name: 'Evasion', uses: 2, target: 'self', blurb: 'Enemies attack at disadvantage for 2 rounds.', words: ['evasion', 'evade', 'dodge', 'duck'] },
  assassinate: { id: 'assassinate', name: 'Assassinate', uses: 1, target: 'enemy', blurb: 'A guaranteed critical sneak attack.', words: ['assassinate', 'assassination', 'execute', 'throat'] },
  // wizard
  'fire-bolt': { id: 'fire-bolt', name: 'Fire Bolt', uses: null, target: 'enemy', blurb: 'Spell attack, 1d10 fire. Grows with level.', words: ['fire bolt', 'firebolt', 'bolt', 'fire bolts'] },
  'magic-missile': { id: 'magic-missile', name: 'Magic Missile', uses: 4, target: 'enemy', blurb: 'Three darts, 1d4+1 each. Never misses.', words: ['magic missile', 'missile', 'missiles', 'magic missiles', 'darts'] },
  shield: { id: 'shield', name: 'Shield', uses: 2, target: 'self', blurb: '+5 armor for 2 rounds.', words: ['shield', 'shield spell', 'barrier', 'protect'] },
  thunderwave: { id: 'thunderwave', name: 'Thunderwave', uses: 2, target: 'all', blurb: '2d8 thunder to all, CON save for half.', words: ['thunderwave', 'thunder wave', 'thunder', 'shockwave'] },
  fireball: { id: 'fireball', name: 'Fireball', uses: 1, target: 'all', blurb: '8d6 fire to all, DEX save for half.', words: ['fireball', 'fire ball', 'fireballs', 'explosion'] },
  lightning: { id: 'lightning', name: 'Lightning Bolt', uses: 1, target: 'all', blurb: '8d6 lightning to all, DEX save for half.', words: ['lightning bolt', 'lightning', 'lightening'] },
  // cleric
  'sacred-flame': { id: 'sacred-flame', name: 'Sacred Flame', uses: null, target: 'enemy', blurb: '1d8 radiant, DEX save. Grows with level.', words: ['sacred flame', 'flame', 'holy fire', 'smite'] },
  'cure-wounds': { id: 'cure-wounds', name: 'Cure Wounds', uses: 3, target: 'self', blurb: 'Heal 1d8 + Wisdom per 2 levels.', words: ['cure wounds', 'cure', 'heal', 'heal me', 'healing spell', 'cure wound'] },
  'guiding-bolt': { id: 'guiding-bolt', name: 'Guiding Bolt', uses: 2, target: 'enemy', blurb: '4d6 radiant. Your next attack has advantage.', words: ['guiding bolt', 'guiding', 'holy bolt'] },
  'turn-undead': { id: 'turn-undead', name: 'Turn Undead', uses: 1, target: 'all', blurb: 'Undead that fail a WIS save flee.', words: ['turn undead', 'turn', 'banish', 'holy symbol'] },
  'spirit-guardians': { id: 'spirit-guardians', name: 'Spirit Guardians', uses: 1, target: 'self', blurb: '3d8 radiant to every enemy each round, 3 rounds.', words: ['spirit guardians', 'guardians', 'spirits', 'spirit guardian'] },
  // ranger
  'hunters-mark': { id: 'hunters-mark', name: "Hunter's Mark", uses: 3, target: 'enemy', blurb: '+1d6 on every hit against the target.', words: ["hunter's mark", 'hunters mark', 'mark', 'mark the target', 'hunter mark'] },
  ensnare: { id: 'ensnare', name: 'Ensnaring Strike', uses: 2, target: 'enemy', blurb: 'Attack; on a failed STR save it loses a turn.', words: ['ensnaring strike', 'ensnare', 'snare', 'vines', 'entangle'] },
  volley: { id: 'volley', name: 'Volley', uses: 2, target: 'all', blurb: 'An attack against every enemy.', words: ['volley', 'rain of arrows', 'arrows', 'multishot'] },
  'hail-of-thorns': { id: 'hail-of-thorns', name: 'Hail of Thorns', uses: 1, target: 'all', blurb: '4d10 piercing to all, DEX save for half.', words: ['hail of thorns', 'thorns', 'hail'] },
  // barbarian
  rage: { id: 'rage', name: 'Rage', uses: 2, target: 'self', blurb: 'For the fight: +2 damage and half damage taken.', words: ['rage', 'berserk', 'anger', 'fury', 'go berserk'] },
  reckless: { id: 'reckless', name: 'Reckless Attack', uses: null, target: 'enemy', blurb: 'Attack with advantage; enemies get advantage on you.', words: ['reckless attack', 'reckless', 'all out', 'wild swing'] },
  frenzy: { id: 'frenzy', name: 'Frenzy', uses: 2, target: 'enemy', blurb: 'Attack twice this turn.', words: ['frenzy', 'frenzied', 'attack twice'] },
  'brutal-strike': { id: 'brutal-strike', name: 'Brutal Strike', uses: 2, target: 'enemy', blurb: 'Attack; a hit deals double dice and staggers.', words: ['brutal strike', 'brutal', 'crushing blow', 'smash'] },
}

// --- gear ------------------------------------------------------------------------

export interface WeaponDef {
  id: string
  name: string
  dice: string
  /** Uses the better of STR and DEX. */
  finesse?: boolean
  /** Always DEX. */
  ranged?: boolean
  heavy?: boolean
  verb: string
  value: number
}

export const WEAPONS: Record<string, WeaponDef> = {
  dagger: { id: 'dagger', name: 'Dagger', dice: '1d4', finesse: true, verb: 'stab', value: 4 },
  shortsword: { id: 'shortsword', name: 'Shortsword', dice: '1d6', finesse: true, verb: 'slash', value: 10 },
  rapier: { id: 'rapier', name: 'Rapier', dice: '1d8', finesse: true, verb: 'skewer', value: 25 },
  mace: { id: 'mace', name: 'Mace', dice: '1d6', verb: 'smash', value: 8 },
  quarterstaff: { id: 'quarterstaff', name: 'Quarterstaff', dice: '1d6', verb: 'crack', value: 4 },
  longsword: { id: 'longsword', name: 'Longsword', dice: '1d8', verb: 'slash', value: 15 },
  warhammer: { id: 'warhammer', name: 'Warhammer', dice: '1d8', verb: 'hammer', value: 15 },
  battleaxe: { id: 'battleaxe', name: 'Battleaxe', dice: '1d8', verb: 'hack', value: 15 },
  greatsword: { id: 'greatsword', name: 'Greatsword', dice: '2d6', heavy: true, verb: 'cleave', value: 50 },
  greataxe: { id: 'greataxe', name: 'Greataxe', dice: '1d12', heavy: true, verb: 'cleave', value: 40 },
  longbow: { id: 'longbow', name: 'Longbow', dice: '1d8', ranged: true, verb: 'shoot', value: 50 },
  crossbow: { id: 'crossbow', name: 'Heavy Crossbow', dice: '1d10', ranged: true, heavy: true, verb: 'shoot', value: 50 },
}

/** Which weapons each class tends to find, so loot is usually useful. */
export const CLASS_WEAPONS: Record<ClassId, string[]> = {
  fighter: ['longsword', 'greatsword', 'warhammer', 'battleaxe'],
  rogue: ['rapier', 'shortsword', 'dagger'],
  wizard: ['quarterstaff', 'dagger'],
  cleric: ['mace', 'warhammer'],
  ranger: ['longbow', 'crossbow', 'shortsword'],
  barbarian: ['greataxe', 'greatsword', 'battleaxe'],
}

export interface ArmorDef {
  id: string
  name: string
  base: number
  dexCap: number | null
  type: ArmorType
  value: number
}

export const ARMORS: Record<string, ArmorDef> = {
  leather: { id: 'leather', name: 'Leather Armor', base: 11, dexCap: null, type: 'light', value: 10 },
  studded: { id: 'studded', name: 'Studded Leather', base: 12, dexCap: null, type: 'light', value: 45 },
  'chain-shirt': { id: 'chain-shirt', name: 'Chain Shirt', base: 13, dexCap: 2, type: 'medium', value: 50 },
  scale: { id: 'scale', name: 'Scale Mail', base: 14, dexCap: 2, type: 'medium', value: 50 },
  'half-plate': { id: 'half-plate', name: 'Half Plate', base: 15, dexCap: 2, type: 'medium', value: 150 },
  'chain-mail': { id: 'chain-mail', name: 'Chain Mail', base: 16, dexCap: 0, type: 'heavy', value: 75 },
  splint: { id: 'splint', name: 'Splint Armor', base: 17, dexCap: 0, type: 'heavy', value: 200 },
  plate: { id: 'plate', name: 'Plate Armor', base: 18, dexCap: 0, type: 'heavy', value: 400 },
}

export type WeaponProp = 'flaming' | 'frost' | 'keen' | 'vampiric' | 'venom' | 'holy'

export const PROPS: Record<WeaponProp, { name: string; blurb: string }> = {
  flaming: { name: 'Flaming', blurb: '+1d6 fire; stops regeneration' },
  frost: { name: 'Frost', blurb: '+1d6 cold' },
  keen: { name: 'Keen', blurb: 'crits on 19-20' },
  vampiric: { name: 'Vampiric', blurb: 'heal 1d4 on a hit' },
  venom: { name: 'Venomous', blurb: 'poisons on a hit' },
  holy: { name: 'Holy', blurb: '+2d6 against undead' },
}

export type ConsumableKind = 'potion' | 'scroll' | 'key'

export interface ConsumableDef {
  id: string
  name: string
  kind: ConsumableKind
  icon: IconName
  /** Deepest floor it starts to appear on. */
  floor: number
  value: number
  combat: boolean
  outside: boolean
  blurb: string
  words: string[]
}

export const CONSUMABLES: Record<string, ConsumableDef> = {
  healing: { id: 'healing', name: 'Potion of Healing', kind: 'potion', icon: 'health-potion', floor: 1, value: 25, combat: true, outside: true, blurb: 'Heal 2d4+2.', words: ['healing potion', 'potion of healing', 'health potion', 'red potion', 'potion', 'heal'] },
  'greater-healing': { id: 'greater-healing', name: 'Greater Healing', kind: 'potion', icon: 'health-potion', floor: 4, value: 60, combat: true, outside: true, blurb: 'Heal 4d4+4.', words: ['greater healing', 'greater potion', 'big potion', 'greater healing potion'] },
  'superior-healing': { id: 'superior-healing', name: 'Superior Healing', kind: 'potion', icon: 'health-potion', floor: 9, value: 140, combat: true, outside: true, blurb: 'Heal 8d4+8.', words: ['superior healing', 'superior potion', 'superior healing potion'] },
  'giant-strength': { id: 'giant-strength', name: 'Giant Strength', kind: 'potion', icon: 'magic-potion', floor: 2, value: 70, combat: true, outside: false, blurb: 'Strength 21 for this fight.', words: ['giant strength', 'strength potion', 'potion of strength', 'giants strength'] },
  heroism: { id: 'heroism', name: 'Potion of Heroism', kind: 'potion', icon: 'round-potion', floor: 1, value: 50, combat: true, outside: false, blurb: '10 temporary HP and +2 to hit this fight.', words: ['heroism', 'hero potion', 'potion of heroism', 'courage'] },
  invisibility: { id: 'invisibility', name: 'Invisibility', kind: 'potion', icon: 'standing-potion', floor: 3, value: 60, combat: true, outside: false, blurb: 'Vanish: sneak attack, enemies can barely hit you.', words: ['invisibility', 'invisible', 'invisibility potion', 'vanish potion'] },
  antidote: { id: 'antidote', name: 'Antidote', kind: 'potion', icon: 'round-potion', floor: 1, value: 20, combat: true, outside: true, blurb: 'Cure poison; immune for the floor.', words: ['antidote', 'anti venom', 'cure poison'] },
  vigor: { id: 'vigor', name: 'Elixir of Vigor', kind: 'potion', icon: 'magic-potion', floor: 3, value: 90, combat: true, outside: true, blurb: 'Restore every skill use.', words: ['vigor', 'elixir', 'elixir of vigor', 'vigour'] },
  'fire-breath': { id: 'fire-breath', name: 'Fire Breath', kind: 'potion', icon: 'potion-of-madness', floor: 2, value: 70, combat: true, outside: false, blurb: '4d6 fire to every enemy.', words: ['fire breath', 'breathe fire', 'dragon breath', 'breath'] },
  'scroll-fireball': { id: 'scroll-fireball', name: 'Scroll of Fireball', kind: 'scroll', icon: 'tied-scroll', floor: 3, value: 150, combat: true, outside: false, blurb: '8d6 fire to every enemy.', words: ['fireball scroll', 'scroll of fireball', 'fire scroll'] },
  'scroll-lightning': { id: 'scroll-lightning', name: 'Scroll of Lightning', kind: 'scroll', icon: 'tied-scroll', floor: 2, value: 90, combat: true, outside: false, blurb: '6d6 lightning to one enemy.', words: ['lightning scroll', 'scroll of lightning', 'thunder scroll'] },
  'scroll-teleport': { id: 'scroll-teleport', name: 'Scroll of Teleport', kind: 'scroll', icon: 'scroll-unfurled', floor: 2, value: 80, combat: true, outside: true, blurb: 'Escape a fight, or skip to the stairs.', words: ['teleport', 'teleport scroll', 'scroll of teleport', 'teleportation'] },
  'scroll-enchant': { id: 'scroll-enchant', name: 'Enchant Weapon', kind: 'scroll', icon: 'scroll-unfurled', floor: 3, value: 200, combat: false, outside: true, blurb: 'Your weapon gains +1 (max +5).', words: ['enchant', 'enchant weapon', 'enchantment scroll', 'scroll of enchant'] },
  'scroll-protection': { id: 'scroll-protection', name: 'Scroll of Warding', kind: 'scroll', icon: 'scroll-unfurled', floor: 2, value: 80, combat: true, outside: true, blurb: '+2 armor for the rest of the floor.', words: ['warding', 'protection', 'ward', 'scroll of warding', 'protection scroll'] },
  'scroll-revivify': { id: 'scroll-revivify', name: 'Scroll of Revivify', kind: 'scroll', icon: 'tied-scroll', floor: 5, value: 300, combat: false, outside: false, blurb: 'Used by itself when you would die.', words: ['revivify', 'revive', 'resurrection'] },
  'skeleton-key': { id: 'skeleton-key', name: 'Skeleton Key', kind: 'key', icon: 'skeleton-key', floor: 1, value: 15, combat: false, outside: false, blurb: 'Opens any locked chest.', words: ['key', 'skeleton key', 'use key', 'unlock'] },
}

export interface TrinketDef {
  id: string
  name: string
  icon: IconName
  floor: number
  value: number
  blurb: string
}

export const TRINKETS: Record<string, TrinketDef> = {
  'ring-protection': { id: 'ring-protection', name: 'Ring of Protection', icon: 'ring', floor: 1, value: 250, blurb: '+1 armor and saves.' },
  'ring-regen': { id: 'ring-regen', name: 'Ring of Regeneration', icon: 'power-ring', floor: 4, value: 400, blurb: 'Heal 1 each round and 3 each room.' },
  'ring-fury': { id: 'ring-fury', name: 'Ring of Fury', icon: 'power-ring', floor: 2, value: 300, blurb: '+2 damage on attacks.' },
  'amulet-health': { id: 'amulet-health', name: 'Amulet of Health', icon: 'torc', floor: 3, value: 350, blurb: 'Constitution becomes 19.' },
  gauntlets: { id: 'gauntlets', name: 'Gauntlets of Ogre Power', icon: 'torc', floor: 3, value: 350, blurb: 'Strength becomes 19.' },
  headband: { id: 'headband', name: 'Headband of Intellect', icon: 'torc', floor: 3, value: 350, blurb: 'Intelligence becomes 19.' },
  periapt: { id: 'periapt', name: 'Periapt of Wound Closure', icon: 'torc', floor: 2, value: 250, blurb: 'Healing you receive is doubled.' },
  boots: { id: 'boots', name: 'Boots of Speed', icon: 'torc', floor: 2, value: 300, blurb: 'Fleeing always works. +1 armor.' },
  luckstone: { id: 'luckstone', name: 'Luckstone', icon: 'ring', floor: 1, value: 200, blurb: '+1 to every d20 roll.' },
  phoenix: { id: 'phoenix', name: 'Phoenix Feather', icon: 'torc', floor: 4, value: 500, blurb: 'Once: rise at half HP instead of dying.' },
  'amulet-devout': { id: 'amulet-devout', name: 'Amulet of the Devout', icon: 'torc', floor: 2, value: 300, blurb: '+1 use of every skill.' },
  cloak: { id: 'cloak', name: 'Cloak of Displacement', icon: 'torc', floor: 5, value: 450, blurb: 'The first attack on you each fight misses.' },
}

export const TRINKET_SLOTS = 2

// --- monsters -------------------------------------------------------------------

export type Trait =
  | 'undead' | 'poison' | 'drain' | 'regen' | 'pack' | 'steal' | 'petrify' | 'breath'
  | 'multi' | 'charge' | 'web' | 'incorporeal' | 'healer' | 'summon' | 'enrage' | 'charm'

export interface MonsterDef {
  id: string
  name: string
  icon: IconName
  tier: 1 | 2 | 3 | 4
  hp: number
  ac: number
  atk: number
  dmg: string
  xp: number
  gold: [number, number]
  traits: Trait[]
  /** Largest group it shows up in. */
  group: number
  verb: string
  /** How it dies, for the narration. */
  death?: string
  /** Only from specific rooms (mimics come from chests). */
  special?: boolean
  words?: string[]
}

export const MONSTERS: MonsterDef[] = [
  // tier 1: floors 1-3
  { id: 'rat', name: 'Giant Rat', icon: 'rat', tier: 1, hp: 7, ac: 12, atk: 3, dmg: '1d4+1', xp: 10, gold: [0, 2], traits: ['pack'], group: 3, verb: 'bites', death: 'squeals and goes still', words: ['rat', 'rats'] },
  { id: 'goblin', name: 'Goblin', icon: 'goblin-head', tier: 1, hp: 7, ac: 13, atk: 4, dmg: '1d6+1', xp: 15, gold: [2, 8], traits: ['steal'], group: 3, verb: 'slashes', words: ['goblin', 'goblins', 'gobbler'] },
  { id: 'skeleton', name: 'Skeleton', icon: 'skeleton', tier: 1, hp: 12, ac: 13, atk: 4, dmg: '1d6+1', xp: 20, gold: [0, 5], traits: ['undead'], group: 2, verb: 'hacks at', death: 'clatters apart into bones', words: ['skeleton', 'skeletons', 'bones'] },
  { id: 'bat', name: 'Cave Bat', icon: 'evil-bat', tier: 1, hp: 8, ac: 12, atk: 4, dmg: '1d4+1', xp: 12, gold: [0, 0], traits: ['drain'], group: 3, verb: 'bites', words: ['bat', 'bats'] },
  { id: 'slime', name: 'Gray Ooze', icon: 'slime', tier: 1, hp: 18, ac: 8, atk: 3, dmg: '1d6+1', xp: 20, gold: [0, 6], traits: [], group: 2, verb: 'engulfs', death: 'dissolves into a puddle', words: ['ooze', 'slime', 'blob'] },
  { id: 'bandit', name: 'Bandit', icon: 'bandit', tier: 1, hp: 11, ac: 12, atk: 3, dmg: '1d6+1', xp: 15, gold: [5, 15], traits: ['steal'], group: 2, verb: 'cuts', words: ['bandit', 'bandits', 'thief', 'robber'] },
  { id: 'spider', name: 'Giant Spider', icon: 'long-legged-spider', tier: 1, hp: 13, ac: 13, atk: 4, dmg: '1d6+1', xp: 30, gold: [0, 4], traits: ['poison', 'web'], group: 1, verb: 'bites', words: ['spider', 'spiders'] },
  { id: 'zombie', name: 'Zombie', icon: 'shambling-zombie', tier: 1, hp: 20, ac: 8, atk: 3, dmg: '1d6+1', xp: 20, gold: [0, 4], traits: ['undead'], group: 2, verb: 'claws at', death: 'collapses for good', words: ['zombie', 'zombies', 'corpse'] },
  { id: 'myconid', name: 'Myconid', icon: 'spotted-mushroom', tier: 1, hp: 9, ac: 10, atk: 3, dmg: '1d4+1', xp: 12, gold: [0, 3], traits: [], group: 3, verb: 'spores', words: ['mushroom', 'myconid', 'fungus', 'shroom'] },
  { id: 'snapvine', name: 'Snapvine', icon: 'venus-flytrap', tier: 1, hp: 12, ac: 11, atk: 4, dmg: '1d8', xp: 15, gold: [0, 0], traits: ['web'], group: 2, verb: 'snaps at', words: ['vine', 'plant', 'snapvine', 'flytrap'] },
  // tier 2: floors 4-7
  { id: 'orc', name: 'Orc', icon: 'orc-head', tier: 2, hp: 15, ac: 13, atk: 5, dmg: '1d12+2', xp: 50, gold: [4, 14], traits: ['enrage'], group: 2, verb: 'cleaves at', words: ['orc', 'orcs', 'ork'] },
  { id: 'direwolf', name: 'Dire Wolf', icon: 'direwolf', tier: 2, hp: 30, ac: 14, atk: 5, dmg: '2d4+3', xp: 70, gold: [0, 0], traits: ['pack'], group: 2, verb: 'mauls', words: ['wolf', 'wolves', 'dire wolf'] },
  { id: 'gnoll', name: 'Gnoll', icon: 'hyena-head', tier: 2, hp: 22, ac: 14, atk: 4, dmg: '1d8+2', xp: 45, gold: [3, 10], traits: ['pack'], group: 3, verb: 'bites', words: ['gnoll', 'gnolls', 'hyena', 'noel'] },
  { id: 'cultist', name: 'Cultist', icon: 'cultist', tier: 2, hp: 20, ac: 12, atk: 4, dmg: '1d6+2', xp: 40, gold: [5, 15], traits: ['healer'], group: 2, verb: 'stabs', words: ['cultist', 'cultists', 'priest', 'cult'] },
  { id: 'harpy', name: 'Harpy', icon: 'harpy', tier: 2, hp: 30, ac: 12, atk: 4, dmg: '2d4+1', xp: 50, gold: [2, 10], traits: ['charm'], group: 1, verb: 'rakes', words: ['harpy', 'harpies', 'bird'] },
  { id: 'mimic', name: 'Mimic', icon: 'mimic-chest', tier: 2, hp: 32, ac: 12, atk: 5, dmg: '1d8+3', xp: 110, gold: [20, 60], traits: ['web'], group: 1, verb: 'chomps', special: true, words: ['mimic', 'chest'] },
  { id: 'lizardfolk', name: 'Lizardfolk', icon: 'lizardman', tier: 2, hp: 22, ac: 15, atk: 4, dmg: '1d6+2', xp: 50, gold: [2, 10], traits: ['multi'], group: 2, verb: 'bites', words: ['lizard', 'lizardfolk', 'lizardman', 'lizard man'] },
  { id: 'ghost', name: 'Specter', icon: 'floating-ghost', tier: 2, hp: 22, ac: 12, atk: 4, dmg: '3d6', xp: 60, gold: [0, 0], traits: ['incorporeal', 'drain', 'undead'], group: 1, verb: 'touches', death: 'fades with a wail', words: ['ghost', 'specter', 'spectre', 'spirit'] },
  { id: 'mummy', name: 'Mummy', icon: 'mummy-head', tier: 2, hp: 45, ac: 11, atk: 5, dmg: '2d6+3', xp: 100, gold: [5, 25], traits: ['undead', 'poison'], group: 1, verb: 'pummels', death: 'crumbles into dust and linen', words: ['mummy', 'mummies'] },
  { id: 'scorpion', name: 'Giant Scorpion', icon: 'scorpion', tier: 2, hp: 40, ac: 15, atk: 4, dmg: '1d8+2', xp: 110, gold: [0, 0], traits: ['multi', 'poison'], group: 1, verb: 'stings', words: ['scorpion', 'scorpions'] },
  { id: 'viper', name: 'Giant Viper', icon: 'snake', tier: 2, hp: 11, ac: 14, atk: 6, dmg: '1d4+4', xp: 30, gold: [0, 0], traits: ['poison'], group: 2, verb: 'bites', words: ['snake', 'viper', 'serpent'] },
  { id: 'bear', name: 'Cave Bear', icon: 'bear-head', tier: 2, hp: 34, ac: 11, atk: 5, dmg: '2d6+3', xp: 80, gold: [0, 0], traits: ['multi'], group: 1, verb: 'mauls', words: ['bear', 'bears'] },
  { id: 'kenku', name: 'Kenku', icon: 'kenku-head', tier: 2, hp: 13, ac: 13, atk: 5, dmg: '1d6+3', xp: 30, gold: [5, 18], traits: ['steal'], group: 3, verb: 'pecks', words: ['kenku', 'crow', 'raven', 'bird man'] },
  // tier 3: floors 8-12
  { id: 'ogre', name: 'Ogre', icon: 'ogre', tier: 3, hp: 59, ac: 11, atk: 6, dmg: '2d8+4', xp: 150, gold: [10, 40], traits: ['charge'], group: 1, verb: 'clubs', words: ['ogre', 'ogres', 'giant'] },
  { id: 'troll', name: 'Troll', icon: 'troll', tier: 3, hp: 70, ac: 15, atk: 7, dmg: '2d6+4', xp: 300, gold: [5, 30], traits: ['multi', 'regen'], group: 1, verb: 'claws', words: ['troll', 'trolls'] },
  { id: 'minotaur', name: 'Minotaur', icon: 'minotaur', tier: 3, hp: 70, ac: 14, atk: 6, dmg: '2d12+4', xp: 250, gold: [10, 40], traits: ['charge'], group: 1, verb: 'gores', words: ['minotaur', 'bull'] },
  { id: 'werewolf', name: 'Werewolf', icon: 'werewolf', tier: 3, hp: 58, ac: 12, atk: 5, dmg: '2d4+3', xp: 200, gold: [5, 25], traits: ['multi', 'regen'], group: 1, verb: 'savages', words: ['werewolf', 'wolf', 'lycanthrope'] },
  { id: 'vampire-spawn', name: 'Vampire Spawn', icon: 'vampire-cape', tier: 3, hp: 70, ac: 15, atk: 6, dmg: '2d6+3', xp: 300, gold: [15, 50], traits: ['drain', 'undead', 'regen'], group: 1, verb: 'bites', death: 'burns away to ash', words: ['vampire', 'spawn', 'vampire spawn'] },
  { id: 'medusa', name: 'Medusa', icon: 'medusa-head', tier: 3, hp: 90, ac: 15, atk: 5, dmg: '2d6+2', xp: 400, gold: [20, 60], traits: ['petrify', 'poison'], group: 1, verb: 'lashes', words: ['medusa', 'gorgon', 'snake woman'] },
  { id: 'wraith', name: 'Wraith', icon: 'hooded-figure', tier: 3, hp: 60, ac: 13, atk: 6, dmg: '3d8+2', xp: 350, gold: [0, 20], traits: ['drain', 'undead', 'incorporeal'], group: 1, verb: 'drains', death: 'unravels into shadow', words: ['wraith', 'shade', 'shadow'] },
  { id: 'golem', name: 'Stone Golem', icon: 'rock-golem', tier: 3, hp: 90, ac: 17, atk: 7, dmg: '3d8+3', xp: 400, gold: [0, 0], traits: [], group: 1, verb: 'pounds', death: 'shatters into rubble', words: ['golem', 'statue', 'stone golem'] },
  { id: 'wyvern', name: 'Wyvern', icon: 'wyvern', tier: 3, hp: 90, ac: 13, atk: 7, dmg: '2d6+4', xp: 450, gold: [10, 40], traits: ['poison', 'multi'], group: 1, verb: 'stings', words: ['wyvern', 'dragon', 'drake'] },
  // tier 4: floors 13+
  { id: 'vampire', name: 'Vampire', icon: 'vampire-dracula', tier: 4, hp: 130, ac: 16, atk: 9, dmg: '3d8+4', xp: 900, gold: [40, 120], traits: ['drain', 'undead', 'regen', 'charm'], group: 1, verb: 'bites', death: 'bursts into ash and bats', words: ['vampire', 'dracula', 'count'] },
  { id: 'lich', name: 'Lich', icon: 'skull-staff', tier: 4, hp: 120, ac: 17, atk: 10, dmg: '3d6+3', xp: 1100, gold: [50, 150], traits: ['undead', 'summon', 'breath'], group: 1, verb: 'blasts', death: 'screams as its phylactery cracks', words: ['lich', 'necromancer', 'skull'] },
  { id: 'hydra', name: 'Hydra', icon: 'hydra', tier: 4, hp: 150, ac: 15, atk: 8, dmg: '1d10+5', xp: 1000, gold: [20, 100], traits: ['multi', 'regen'], group: 1, verb: 'bites', words: ['hydra', 'heads'] },
  { id: 'fiend', name: 'Barbed Fiend', icon: 'horned-skull', tier: 4, hp: 110, ac: 15, atk: 8, dmg: '3d6+2', xp: 900, gold: [30, 90], traits: ['multi', 'enrage'], group: 1, verb: 'rends', death: 'is dragged back to the hells', words: ['devil', 'demon', 'fiend'] },
  { id: 'young-dragon', name: 'Young Dragon', icon: 'dragon-head', tier: 4, hp: 150, ac: 18, atk: 9, dmg: '2d10+5', xp: 1300, gold: [80, 200], traits: ['breath', 'multi'], group: 1, verb: 'bites', words: ['dragon', 'wyrm'] },
  { id: 'ice-golem', name: 'Frost Golem', icon: 'ice-golem', tier: 4, hp: 140, ac: 16, atk: 9, dmg: '3d8+5', xp: 1000, gold: [0, 0], traits: ['petrify'], group: 1, verb: 'crushes', death: 'shatters like a frozen lake', words: ['golem', 'ice golem', 'frost golem'] },
  { id: 'iron-golem', name: 'Iron Golem', icon: 'metal-golem-head', tier: 4, hp: 170, ac: 20, atk: 11, dmg: '3d8+6', xp: 1400, gold: [0, 0], traits: ['breath'], group: 1, verb: 'slams', death: 'grinds to a halt', words: ['golem', 'iron golem', 'robot'] },
  { id: 'death-knight', name: 'Death Knight', icon: 'black-knight-helm', tier: 4, hp: 160, ac: 20, atk: 10, dmg: '3d8+5', xp: 1400, gold: [50, 150], traits: ['multi', 'undead'], group: 1, verb: 'cleaves', death: 'kneels, and is still', words: ['knight', 'death knight', 'black knight'] },
]

export interface BossDef extends Omit<MonsterDef, 'tier' | 'group'> {
  title: string
}

/** One every third floor, in order; after the last they come back "Ascended". */
export const BOSSES: BossDef[] = [
  { id: 'goblin-king', name: 'Grukk', title: 'the Goblin King', icon: 'goblin', hp: 32, ac: 14, atk: 5, dmg: '1d10+2', xp: 200, gold: [40, 80], traits: ['summon', 'enrage', 'steal'], verb: 'bashes', words: ['grukk', 'king', 'goblin king', 'goblin'] },
  { id: 'bone-tyrant', name: 'The Bone Tyrant', title: 'lord of the ossuary', icon: 'crowned-skull', hp: 70, ac: 15, atk: 6, dmg: '1d10+3', xp: 500, gold: [60, 120], traits: ['undead', 'summon', 'multi'], verb: 'smites', death: 'collapses into a heap of crowns and bones', words: ['tyrant', 'bone tyrant', 'skeleton', 'king'] },
  { id: 'web-mother', name: 'Mother of Webs', title: 'the brood queen', icon: 'masked-spider', hp: 95, ac: 15, atk: 7, dmg: '2d6+4', xp: 900, gold: [80, 160], traits: ['web', 'poison', 'multi', 'summon'], verb: 'bites', words: ['mother', 'spider', 'queen', 'mother of webs'] },
  { id: 'minotaur-lord', name: 'Ironhorn', title: 'lord of the labyrinth', icon: 'minotaur', hp: 130, ac: 16, atk: 8, dmg: '2d12+5', xp: 1400, gold: [100, 200], traits: ['charge', 'multi', 'enrage'], verb: 'gores', words: ['ironhorn', 'minotaur', 'lord'] },
  { id: 'arch-lich', name: 'Vessanth', title: 'the Undying', icon: 'skull-staff', hp: 150, ac: 17, atk: 10, dmg: '3d8+4', xp: 2000, gold: [120, 250], traits: ['undead', 'summon', 'breath', 'drain'], verb: 'blasts', death: 'shrieks as the phylactery breaks', words: ['vessanth', 'lich', 'undying'] },
  { id: 'red-dragon', name: 'Vermithrax', title: 'the Red Ruin', icon: 'spiked-dragon-head', hp: 190, ac: 19, atk: 11, dmg: '2d10+7', xp: 3000, gold: [300, 600], traits: ['breath', 'multi', 'enrage'], verb: 'rends', death: 'crashes down, and the depths go quiet', words: ['vermithrax', 'dragon', 'red dragon'] },
  { id: 'hydra-queen', name: 'The Hydra Queen', title: 'of the black lake', icon: 'hydra', hp: 220, ac: 17, atk: 11, dmg: '2d10+6', xp: 3500, gold: [300, 600], traits: ['multi', 'regen', 'poison'], verb: 'bites', words: ['hydra', 'queen', 'hydra queen'] },
  { id: 'triple-skull', name: 'The Tri-Skull', title: 'last warden of the deep', icon: 'triple-skulls', hp: 250, ac: 18, atk: 12, dmg: '3d10+6', xp: 4500, gold: [400, 800], traits: ['undead', 'summon', 'breath', 'multi', 'drain'], verb: 'devours', words: ['tri skull', 'skulls', 'warden'] },
]

/** Elite prefixes: tougher, meaner, better loot. */
export const ELITES = [
  { name: 'Vicious', hp: 1.3, atk: 2, dmg: 3 },
  { name: 'Armored', hp: 1.4, atk: 1, dmg: 1, ac: 3 },
  { name: 'Ancient', hp: 1.7, atk: 2, dmg: 2 },
  { name: 'Frenzied', hp: 1.2, atk: 3, dmg: 2 },
  { name: 'Hulking', hp: 1.9, atk: 1, dmg: 2 },
]

// --- companions ----------------------------------------------------------------

export type CompanionAbility = 'trip' | 'taunt' | 'aim' | 'scout' | 'fire' | 'heal' | 'strike' | 'stun' | 'bless' | 'luck'

export interface CompanionDef {
  id: string
  name: string
  kind: string
  icon: IconName
  hp: number
  ac: number
  atk: number
  dmg: string
  ability: CompanionAbility
  blurb: string
  pitch: string
}

export const COMPANIONS: CompanionDef[] = [
  { id: 'wolf', name: 'Bramble', kind: 'wolf', icon: 'wolf-head', hp: 16, ac: 13, atk: 4, dmg: '2d4+2', ability: 'trip', blurb: 'Bites, and knocks foes off their feet.', pitch: 'A gray wolf with a torn ear watches you, then pads closer.' },
  { id: 'dwarf', name: 'Brakka Stonebeard', kind: 'dwarf', icon: 'dwarf-face', hp: 26, ac: 16, atk: 4, dmg: '1d8+2', ability: 'taunt', blurb: 'Draws enemy attacks onto her shield.', pitch: 'A dwarf sits on her upturned shield, sharpening an axe. "Need a wall?"' },
  { id: 'elf', name: 'Sylvaine', kind: 'elf archer', icon: 'woman-elf-face', hp: 16, ac: 14, atk: 6, dmg: '1d8+3', ability: 'aim', blurb: 'Calls out weak points: +2 to your attacks.', pitch: 'An elf archer lowers her bow. "You look like you could use a second eye."' },
  { id: 'owl', name: 'Hoot', kind: 'owl', icon: 'barn-owl', hp: 8, ac: 13, atk: 3, dmg: '1d4', ability: 'scout', blurb: 'Your first attack each fight has advantage.', pitch: 'A great white owl lands on a broken statue and tilts its head at you.' },
  { id: 'imp', name: 'Snivel', kind: 'imp', icon: 'imp-laugh', hp: 12, ac: 13, atk: 5, dmg: '1d4+3', ability: 'fire', blurb: 'Adds fire to its bites, and pockets extra gold.', pitch: 'A tiny imp grins from a crack in the wall. "I work for snacks. And gold."' },
  { id: 'fairy', name: 'Pip', kind: 'fairy', icon: 'fairy', hp: 8, ac: 15, atk: 2, dmg: '1d4', ability: 'heal', blurb: 'Heals you when you are hurt.', pitch: 'A fairy caught in a lantern jar beats against the glass.' },
  { id: 'sellsword', name: 'Kestra', kind: 'sellsword', icon: 'swordwoman', hp: 24, ac: 15, atk: 5, dmg: '1d10+3', ability: 'strike', blurb: 'A professional. Hits hard.', pitch: 'A scarred sellsword leans on her blade. "My rate is fair. My sword is fairer."' },
  { id: 'monk', name: 'Brother Tamsin', kind: 'monk', icon: 'monk-face', hp: 20, ac: 15, atk: 5, dmg: '1d6+3', ability: 'stun', blurb: 'Strikes twice, and can stun.', pitch: 'A monk meditates in the dark, perfectly calm. "The path goes down. So do I."' },
  { id: 'nun', name: 'Sister Orla', kind: 'war priest', icon: 'nun-face', hp: 18, ac: 15, atk: 3, dmg: '1d6+1', ability: 'bless', blurb: 'Heals and blesses you.', pitch: 'A war priest kneels by a candle. "The light sent me. Or you did."' },
  { id: 'clay', name: 'Clay', kind: 'golem', icon: 'golem-head', hp: 36, ac: 14, atk: 4, dmg: '1d10+3', ability: 'taunt', blurb: 'Slow, huge, and happy to be hit.', pitch: 'A small clay golem stands inert. A word of command is carved on its brow.' },
  { id: 'cat', name: 'Mister Whiskers', kind: 'cat', icon: 'cat', hp: 6, ac: 15, atk: 3, dmg: '1d3', ability: 'luck', blurb: 'Brings luck: +1 to every roll you make.', pitch: 'A black cat winds between your ankles and purrs as though it owns you.' },
]

// --- perks (level-up and shrine power-ups) ------------------------------------------

export interface PerkDef {
  id: string
  name: string
  blurb: string
  stack: number
  /** Only offered to some heroes. */
  for?: ClassId[]
  /** Offered only to fill out a choice once the real perks run dry (very deep runs). */
  filler?: boolean
  words: string[]
}

export const PERKS: PerkDef[] = [
  { id: 'str', name: 'Mighty', blurb: '+2 Strength.', stack: 5, words: ['mighty', 'strength', 'strong'] },
  { id: 'dex', name: 'Nimble', blurb: '+2 Dexterity.', stack: 5, words: ['nimble', 'dexterity', 'agile'] },
  { id: 'con', name: 'Hardy', blurb: '+2 Constitution.', stack: 5, words: ['hardy', 'constitution', 'hearty'] },
  { id: 'int', name: 'Brilliant', blurb: '+2 Intelligence.', stack: 5, for: ['wizard'], words: ['brilliant', 'intelligence', 'smart'] },
  { id: 'wis', name: 'Wise', blurb: '+2 Wisdom.', stack: 5, for: ['cleric', 'ranger'], words: ['wise', 'wisdom'] },
  { id: 'cha', name: 'Charming', blurb: '+2 Charisma.', stack: 3, words: ['charming', 'charisma', 'charm'] },
  { id: 'tough', name: 'Tough', blurb: '+2 max HP per level.', stack: 2, words: ['tough', 'toughness', 'health', 'hit points'] },
  { id: 'keen', name: 'Keen Eye', blurb: 'Critical hits on one lower roll.', stack: 2, words: ['keen', 'keen eye', 'critical', 'crits'] },
  { id: 'bloodthirst', name: 'Bloodthirst', blurb: 'Heal 3 + level/2 when you slay a foe.', stack: 2, words: ['bloodthirst', 'blood', 'thirst', 'bloodthirsty'] },
  { id: 'iron-skin', name: 'Iron Skin', blurb: '+1 armor.', stack: 3, words: ['iron skin', 'skin', 'armor', 'iron'] },
  { id: 'savage', name: 'Savage', blurb: '+2 damage on attacks and spells.', stack: 3, words: ['savage', 'damage', 'brutal'] },
  { id: 'accurate', name: 'Deadeye', blurb: '+1 to hit with attacks and spells.', stack: 3, words: ['deadeye', 'dead eye', 'accurate', 'accuracy', 'aim'] },
  { id: 'deep-pockets', name: 'Deep Pockets', blurb: '+50% gold.', stack: 2, words: ['deep pockets', 'pockets', 'gold', 'greed'] },
  { id: 'quick-study', name: 'Quick Study', blurb: '+25% experience.', stack: 2, words: ['quick study', 'study', 'experience', 'learn'] },
  { id: 'reserves', name: 'Deep Reserves', blurb: '+1 use of every skill.', stack: 3, words: ['reserves', 'deep reserves', 'more uses', 'stamina'] },
  { id: 'lucky', name: 'Lucky', blurb: 'Once per fight, reroll a missed attack.', stack: 1, words: ['lucky', 'luck', 'reroll'] },
  { id: 'alchemist', name: 'Alchemist', blurb: 'Potions heal 50% more.', stack: 2, words: ['alchemist', 'alchemy', 'potions'] },
  { id: 'scavenger', name: 'Scavenger', blurb: 'Enemies drop loot more often.', stack: 2, words: ['scavenger', 'scavenge', 'loot'] },
  { id: 'beast-bond', name: 'Kindred', blurb: 'Your companion gains 50% HP and +2 damage.', stack: 2, words: ['kindred', 'companion', 'bond', 'friend'] },
  { id: 'relentless', name: 'Relentless', blurb: 'Once per floor, drop to 1 HP instead of 0.', stack: 1, words: ['relentless', 'endurance', 'survive'] },
  { id: 'evasive', name: 'Evasive', blurb: 'Enemies have -1 to hit you.', stack: 3, words: ['evasive', 'evade', 'slippery'] },
  { id: 'arcane-might', name: 'Empowered Spells', blurb: 'Spells deal +1 die of damage.', stack: 2, for: ['wizard', 'cleric'], words: ['empowered', 'empowered spells', 'spell damage', 'arcane'] },
  { id: 'extra-attack', name: 'Extra Attack', blurb: 'Your plain attacks strike twice.', stack: 1, for: ['fighter', 'ranger', 'barbarian'], words: ['extra attack', 'two attacks', 'double'] },
  { id: 'vitality', name: 'Vitality', blurb: '+6 max HP.', stack: 999, filler: true, words: ['vitality', 'health', 'hit points', 'life'] },
  { id: 'fortune', name: 'Fortune', blurb: 'Gold: 25 per floor you have reached.', stack: 999, filler: true, words: ['fortune', 'gold', 'money', 'treasure'] },
  { id: 'cunning', name: 'Cunning Strike', blurb: 'Sneak attack every turn you hit a wounded foe.', stack: 1, for: ['rogue'], words: ['cunning', 'cunning strike'] },
]

// --- events (used when there is no AI Dungeon Master) ------------------------------------

export type EffectKind =
  | 'none' | 'heal' | 'hurt' | 'hurt_big' | 'gold' | 'gold_big' | 'lose_gold' | 'item' | 'rare_item'
  | 'bless' | 'curse' | 'xp' | 'fight' | 'companion' | 'poison'
  // combat only
  | 'damage' | 'damage_big' | 'stun' | 'flee_enemy' | 'pacify' | 'advantage' | 'escape'

export const EVENT_EFFECTS: EffectKind[] = ['none', 'heal', 'hurt', 'hurt_big', 'gold', 'gold_big', 'lose_gold', 'item', 'rare_item', 'bless', 'curse', 'xp', 'fight', 'companion', 'poison']
export const COMBAT_EFFECTS: EffectKind[] = ['none', 'heal', 'hurt', 'hurt_big', 'gold', 'lose_gold', 'bless', 'curse', 'poison', 'damage', 'damage_big', 'stun', 'flee_enemy', 'pacify', 'advantage', 'escape']

export interface Outcome {
  effect: EffectKind
  text: string
}

export interface EventChoice {
  label: string
  ability: Ability | 'none'
  dc: number
  success: Outcome
  failure: Outcome
}

export interface EventDef {
  title: string
  icon: IconName
  text: string
  choices: EventChoice[]
}

export const EVENTS: EventDef[] = [
  {
    title: 'The Wishing Well', icon: 'star-altar',
    text: 'A mossy well glitters with old coins. Something hums far below.',
    choices: [
      { label: 'Toss a coin', ability: 'cha', dc: 10, success: { effect: 'bless', text: 'The water glows. You feel watched over.' }, failure: { effect: 'none', text: 'The coin plinks into the dark. Nothing.' } },
      { label: 'Climb down', ability: 'dex', dc: 14, success: { effect: 'gold_big', text: 'You fill your pockets with drowned wishes.' }, failure: { effect: 'hurt', text: 'You slip on the slick stones and fall hard.' } },
      { label: 'Drink', ability: 'con', dc: 12, success: { effect: 'heal', text: 'Cold, sweet, restoring.' }, failure: { effect: 'poison', text: 'Brackish. Your stomach turns.' } },
    ],
  },
  {
    title: 'A Wounded Knight', icon: 'black-knight-helm',
    text: 'A knight slumps against the wall, armor dented, breathing shallow.',
    choices: [
      { label: 'Tend wounds', ability: 'wis', dc: 12, success: { effect: 'item', text: 'The knight presses a gift into your hand before passing out.' }, failure: { effect: 'none', text: 'You do what you can. It is not much.' } },
      { label: 'Rob him', ability: 'dex', dc: 13, success: { effect: 'gold', text: 'His purse is heavier than his conscience would like.' }, failure: { effect: 'fight', text: 'His squire was watching, and draws steel.' } },
    ],
  },
  {
    title: "The Sphinx's Riddle", icon: 'medusa-head',
    text: 'A stone face in the wall opens its eyes. "Answer, and be rewarded. Fail, and be judged."',
    choices: [
      { label: 'Answer', ability: 'int', dc: 15, success: { effect: 'rare_item', text: '"Correct." A hidden niche slides open.' }, failure: { effect: 'hurt_big', text: '"Wrong." The floor gives way beneath you.' } },
      { label: 'Flatter it', ability: 'cha', dc: 14, success: { effect: 'xp', text: 'The face laughs, and teaches you something old.' }, failure: { effect: 'curse', text: 'It is not amused. A chill settles on you.' } },
    ],
  },
  {
    title: 'Forgotten Library', icon: 'scroll-unfurled',
    text: 'Shelves of rotting books lean in the dark. A few spines still glint with gold leaf.',
    choices: [
      { label: 'Study', ability: 'int', dc: 12, success: { effect: 'xp', text: 'A treatise on monsters. You learn their weaknesses.' }, failure: { effect: 'none', text: 'Mold and nonsense.' } },
      { label: 'Search shelves', ability: 'wis', dc: 13, success: { effect: 'item', text: 'Tucked behind a book: something useful.' }, failure: { effect: 'hurt', text: 'A shelf collapses on you.' } },
    ],
  },
  {
    title: 'Gambling Goblins', icon: 'goblin-head',
    text: 'Three goblins roll bone dice around a candle. "You play? You pay!"',
    choices: [
      { label: 'Play dice', ability: 'cha', dc: 13, success: { effect: 'gold_big', text: 'Snake eyes for them. The pot is yours.' }, failure: { effect: 'lose_gold', text: 'They are very, very lucky. Suspiciously so.' } },
      { label: 'Cheat', ability: 'dex', dc: 15, success: { effect: 'gold_big', text: 'Loaded dice, meet sleight of hand.' }, failure: { effect: 'fight', text: '"CHEATER!" The table flips.' } },
    ],
  },
  {
    title: 'Mushroom Circle', icon: 'spotted-mushroom',
    text: 'A perfect ring of glowing mushrooms pulses softly, like breathing.',
    choices: [
      { label: 'Eat one', ability: 'con', dc: 13, success: { effect: 'heal', text: 'Warmth floods your limbs.' }, failure: { effect: 'poison', text: 'The world spins green.' } },
      { label: 'Dance', ability: 'cha', dc: 12, success: { effect: 'bless', text: 'Tiny voices sing along. You feel fey luck on you.' }, failure: { effect: 'curse', text: 'The voices laugh at you, not with you.' } },
    ],
  },
  {
    title: 'The Cursed Idol', icon: 'crowned-skull',
    text: 'A golden idol with ruby eyes sits on a plinth. Bones litter the floor around it.',
    choices: [
      { label: 'Take it', ability: 'dex', dc: 15, success: { effect: 'rare_item', text: 'You swap it for a rock. Nothing happens. Nothing!' }, failure: { effect: 'hurt_big', text: 'Darts hiss from the walls.' } },
      { label: 'Smash it', ability: 'str', dc: 13, success: { effect: 'xp', text: 'It shatters, and a trapped spirit thanks you.' }, failure: { effect: 'curse', text: 'The idol laughs as it cracks.' } },
    ],
  },
  {
    title: 'The Chained Prisoner', icon: 'dwarf-face',
    text: 'Someone is chained to the wall, gagged, eyes pleading.',
    choices: [
      { label: 'Break the chains', ability: 'str', dc: 13, success: { effect: 'companion', text: 'The chains snap. "I owe you my life. Let me repay it."' }, failure: { effect: 'hurt', text: 'You wrench your shoulder. The chains hold.' } },
      { label: 'Pick the lock', ability: 'dex', dc: 12, success: { effect: 'companion', text: 'Click. "Finally! Which way are we going?"' }, failure: { effect: 'none', text: 'The lock is rusted solid.' } },
    ],
  },
  {
    title: 'Underground River', icon: 'wooden-door',
    text: 'Black water rushes through the cave. Something glints on the far bank.',
    choices: [
      { label: 'Swim across', ability: 'str', dc: 14, success: { effect: 'item', text: 'Soaked, but rewarded.' }, failure: { effect: 'hurt', text: 'The current slams you into the rocks.' } },
      { label: 'Rest by the water', ability: 'none', dc: 0, success: { effect: 'heal', text: 'The sound of the water eases your mind.' }, failure: { effect: 'none', text: '' } },
    ],
  },
  {
    title: 'Shrine of a Forgotten God', icon: 'crystal-shrine',
    text: 'A cracked statue holds out empty hands. A gemstone glints in its eye.',
    choices: [
      { label: 'Pray', ability: 'wis', dc: 13, success: { effect: 'bless', text: 'Something ancient notices you, kindly.' }, failure: { effect: 'curse', text: 'Something ancient notices you.' } },
      { label: 'Pry the gem', ability: 'dex', dc: 14, success: { effect: 'gold_big', text: 'It pops free. It is worth a fortune.' }, failure: { effect: 'hurt', text: 'The statue\'s hand closes on yours.' } },
    ],
  },
  {
    title: "The Merchant's Ghost", icon: 'floating-ghost',
    text: 'A translucent peddler floats over a spectral cart. "Deals! Deals to die for!"',
    choices: [
      { label: 'Haggle', ability: 'cha', dc: 14, success: { effect: 'item', text: '"You drive a hard bargain, for the living."' }, failure: { effect: 'lose_gold', text: 'Your purse feels lighter. Ghost tax.' } },
      { label: 'Lay him to rest', ability: 'wis', dc: 15, success: { effect: 'xp', text: 'He smiles, and fades. "Finally, a sale I can close."' }, failure: { effect: 'fight', text: 'He does not want to rest.' } },
    ],
  },
  {
    title: 'Collapsed Tunnel', icon: 'stairs',
    text: 'Rubble blocks the way, but a draft suggests a gap near the ceiling.',
    choices: [
      { label: 'Dig through', ability: 'str', dc: 12, success: { effect: 'gold', text: 'You unearth a dead miner\'s savings.' }, failure: { effect: 'hurt', text: 'Rocks tumble onto you.' } },
      { label: 'Squeeze through', ability: 'dex', dc: 13, success: { effect: 'item', text: 'On the other side, a forgotten pack.' }, failure: { effect: 'hurt', text: 'You scrape through, bleeding.' } },
    ],
  },
  {
    title: 'The Fortune Teller', icon: 'hooded-figure',
    text: 'A crone shuffles cards by candlelight. "Cross my palm and learn your fate."',
    choices: [
      { label: 'Pay and listen', ability: 'none', dc: 0, success: { effect: 'bless', text: '"Your fate is long, dearie. Longer than you think."' }, failure: { effect: 'none', text: '' } },
      { label: 'See through her', ability: 'wis', dc: 14, success: { effect: 'gold', text: 'Her "magic" is a trick. She pays you to keep quiet.' }, failure: { effect: 'curse', text: 'She sees through you instead.' } },
    ],
  },
]

// --- flavor --------------------------------------------------------------------

export const THEMES = [
  'the Crypt of Ashes', 'the Fungal Warrens', 'the Drowned Sewers', 'the Ruined Temple',
  'the Dwarven Forge', 'the Bone Halls', 'the Spider Deeps', 'the Frozen Vaults',
  'the Sunken Library', 'the Obsidian Caves', 'the Blood Catacombs', 'the Infernal Gate',
]

export function themeFor(floor: number): string {
  return THEMES[(floor - 1) % THEMES.length]
}

export const HERO_NAMES = [
  'Aria', 'Bram', 'Cora', 'Dain', 'Elka', 'Finn', 'Gwen', 'Hask', 'Ilsa', 'Joss', 'Kael', 'Lyra',
  'Mira', 'Nox', 'Orin', 'Pell', 'Quill', 'Rook', 'Sable', 'Thane', 'Una', 'Vex', 'Wren', 'Yara', 'Zed',
]

export type RoomKind = 'fight' | 'elite' | 'treasure' | 'shrine' | 'merchant' | 'rest' | 'trap' | 'event' | 'recruit' | 'boss'

export const ROOM_INFO: Record<RoomKind, { name: string; hints: string[]; icon: IconName }> = {
  fight: { name: 'Fight', icon: 'crossed-swords', hints: ['growling in the dark', 'scraping claws', 'harsh voices', 'something shuffling'] },
  elite: { name: 'Elite', icon: 'crossed-swords', hints: ['heavy footsteps', 'a deep, rumbling breath', 'bones crunching'] },
  treasure: { name: 'Treasure', icon: 'locked-chest', hints: ['a glint of gold', 'an old chest', 'coins underfoot'] },
  shrine: { name: 'Shrine', icon: 'crystal-shrine', hints: ['soft holy light', 'chanting', 'incense'] },
  merchant: { name: 'Merchant', icon: 'shop', hints: ['a lantern and jingling coins', 'someone humming a tune'] },
  rest: { name: 'Campfire', icon: 'campfire', hints: ['warm air and woodsmoke', 'a crackling fire'] },
  trap: { name: 'Trap', icon: 'wolf-trap', hints: ['an unnatural silence', 'scorched stone', 'a faint click'] },
  event: { name: 'Mystery', icon: 'scroll-unfurled', hints: ['strange whispers', 'an odd glow', 'music, faintly'] },
  recruit: { name: 'Stranger', icon: 'hooded-figure', hints: ['a voice calling for help', 'someone waiting'] },
  boss: { name: 'Boss', icon: 'crowned-skull', hints: ['a great door, carved with warnings'] },
}
