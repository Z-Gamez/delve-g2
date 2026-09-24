// Headless tests for the rules engine, plus a bot that plays full runs.
//
//   npm test                -> unit checks + 150 bot runs per class
//   npm test -- --runs=1000 -> more runs, for balancing
//
// The bot is deliberately mediocre (no clever targeting, no shopping sense),
// so its median death floor is a floor for how far a real player gets.

import assert from 'node:assert/strict'
import { Game, type Option } from '../src/engine/game.ts'
import { CLASSES, type ClassId } from '../src/engine/data.ts'
import { Rng } from '../src/engine/rng.ts'
import { matchIntent } from '../src/intent.ts'

const runsArg = process.argv.find(a => a.startsWith('--runs='))
const RUNS = runsArg ? Number(runsArg.split('=')[1]) : 150

// --- dice ---------------------------------------------------------------------------
{
  const rng = new Rng(42)
  for (let i = 0; i < 2000; i++) {
    const n = rng.roll('2d6+3')
    assert.ok(n >= 5 && n <= 15, `2d6+3 out of range: ${n}`)
  }
  const a = new Rng(7)
  const b = new Rng(7)
  assert.equal(a.roll('8d6'), b.roll('8d6'), 'same seed, same rolls')
}

// --- creation & save round trip -------------------------------------------------------
{
  const g = new Game(null, [], 1)
  assert.equal(g.mode, 'class')
  assert.ok(g.choose('class:wizard').ok)
  assert.equal(g.mode, 'name')
  assert.ok(g.setName('my name is gandalf the grey'))
  assert.equal(g.run!.hero.name, 'Gandalf The')
  assert.equal(g.mode, 'doors')
  // The very first room choice always includes a fight.
  assert.ok(g.run!.doors.some(d => d.kind === 'fight'))
  const saved = JSON.parse(JSON.stringify(g.run))
  const again = new Game(saved, [])
  assert.deepEqual(again.options(), g.options(), 'a reloaded run offers the same choices')
}

// --- rulings are clamped ----------------------------------------------------------------
{
  const g = new Game(null, [], 3)
  g.choose('class:fighter')
  g.choose('name:keep')
  const fightDoor = g.run!.doors.findIndex(d => d.kind === 'fight')
  g.choose(`door:${fightDoor}`)
  assert.equal(g.mode, 'combat')
  const goldBefore = g.run!.hero.gold
  // A DM trying to hand out a rare item mid-fight gets downgraded.
  g.resolveRuling({ ability: 'none', dc: 99, success: { effect: 'rare_item' as never, text: 'You find a legendary sword!' }, failure: { effect: 'none', text: '' } })
  assert.ok(!g.run || g.run.hero.pack.length <= 3, 'no rare item from a combat ruling')
  assert.ok(!g.run || g.run.hero.gold >= goldBefore - 50)
}

// --- intent matching ----------------------------------------------------------------------
{
  const opts: Option[] = [
    { id: 'attack:0', label: 'Attack', words: ['attack', 'hit', 'strike'] },
    { id: 'skill:fire-bolt', label: 'Fire Bolt', words: ['fire bolt', 'firebolt', 'bolt'] },
    { id: 'skill:fireball', label: 'Fireball ×1', words: ['fireball', 'fire ball'] },
    { id: 'skill:magic-missile', label: 'Magic Missile ×3', words: ['magic missile', 'missile'] },
    { id: 'item:healing', label: 'Potion ×2', words: ['potion', 'drink potion', 'heal'] },
    { id: 'flee', label: 'Flee', words: ['flee', 'run away', 'escape'] },
  ]
  const pick = (t: string) => matchIntent(t, opts)?.option.id
  assert.equal(pick('I cast fire bolt at the goblin'), 'skill:fire-bolt')
  assert.equal(pick('Firebolt!'), 'skill:fire-bolt')
  assert.equal(pick('fireball'), 'skill:fireball')
  assert.equal(pick('cast a fire ball'), 'skill:fireball')
  assert.equal(pick('magic missiles'), 'skill:magic-missile')
  assert.equal(pick('drink a potion'), 'item:healing')
  assert.equal(pick('Run away!'), 'flee')
  assert.equal(pick('number two'), 'skill:fire-bolt')
  assert.equal(pick('option 5'), 'item:healing')
  assert.equal(pick('attack'), 'attack:0')
  assert.equal(pick('I try to seduce the dragon with a lute solo'), undefined, 'freeform goes to the DM')
}

// --- the bot ---------------------------------------------------------------------------------

function botChoice(g: Game): string {
  const opts = g.options().filter(o => !o.hidden)
  const has = (id: string) => opts.find(o => o.id === id)
  const starts = (p: string) => opts.filter(o => o.id.startsWith(p))
  const run = g.run!
  const h = run.hero
  const hpPct = h.hp / g.maxHp()
  switch (g.mode) {
    case 'name':
      return 'name:keep'
    case 'doors': {
      const rest = run.doors.findIndex(d => d.kind === 'rest')
      if (hpPct < 0.6 && rest >= 0) return `door:${rest}`
      const safe = run.doors.findIndex(d => d.kind !== 'elite')
      return `door:${hpPct < 0.5 && safe >= 0 ? safe : 0}`
    }
    case 'combat': {
      if (run.combat!.menu === 'items') return 'back'
      const potion = starts('item:').find(o => o.label.startsWith('Potion'))
      if (hpPct < 0.35 && potion) return potion.id
      const heal = has('skill:cure-wounds') ?? has('skill:second-wind')
      if (hpPct < 0.45 && heal) return heal.id
      const alive = run.combat!.enemies.filter(e => e.hp > 0).length
      const aoe = ['skill:fireball', 'skill:lightning', 'skill:thunderwave', 'skill:cleave', 'skill:volley', 'skill:hail-of-thorns', 'skill:spirit-guardians'].find(id => has(id))
      if (alive > 1 && aoe) return aoe
      const buff = ['skill:rage', 'skill:hunters-mark'].find(id => has(id))
      if (buff) return buff
      const nuke = ['skill:fire-bolt', 'skill:sacred-flame'].find(id => has(id))
      const strong = ['skill:action-surge', 'skill:frenzy', 'skill:guiding-bolt', 'skill:magic-missile', 'skill:brutal-strike', 'skill:poison-blade'].find(id => has(id))
      const boss = run.combat!.kind === 'boss' || run.combat!.kind === 'elite'
      if (boss && strong) return strong
      if (nuke) return nuke
      return starts('attack:')[0]?.id ?? opts[0].id
    }
    case 'loot': {
      const p = run.queue[0]
      if (p?.kind === 'loot') {
        const it = p.item
        if (it.kind === 'weapon' && it.plus + (it.prop ? 1 : 0) > h.weapon.plus + (h.weapon.prop ? 1 : 0)) return 'equip'
        if (it.kind === 'armor') {
          const before = g.ac()
          const old = h.armor
          h.armor = it
          const after = g.ac()
          h.armor = old
          if (after > before) return 'equip'
        }
      }
      return 'salvage'
    }
    case 'perk':
      return opts[0].id
    case 'treasure':
      return (has('key') ?? has('open') ?? has('pick') ?? has('smash') ?? has('leave'))!.id
    case 'shrine':
      return hpPct < 0.5 && h.gold >= Number(opts[1].label.replace(/\D/g, '')) ? 'offer' : 'pray'
    case 'merchant': {
      const pot = starts('buy:').find(o => /Heal/i.test(o.label) && h.gold >= Number(o.label.match(/(\d+)g$/)?.[1] ?? 1e9))
      return pot?.id ?? 'leave'
    }
    case 'rest':
      return hpPct < 0.8 || !has('sharpen') ? 'rest' : 'sharpen'
    case 'trap':
      return 'search'
    case 'event':
      return 'choice:0'
    case 'recruit':
      return has('recruit')?.id ?? (h.gold > 60 ? 'pay' : 'leave')
    case 'stairs':
      return 'descend'
  }
  return opts[0].id
}

function playRun(cls: ClassId, seed: number): { floor: number; level: number; cause: string; actions: number } {
  const g = new Game(null, [], seed)
  g.choose(`class:${cls}`)
  let actions = 0
  while (g.mode !== 'dead') {
    if (++actions > 20000) throw new Error(`run ${cls}/${seed} never ended (mode ${g.mode})`)
    const id = botChoice(g)
    const res = g.choose(id)
    if (!res.ok) {
      // A refused choice must never wedge the run: fall back to anything else.
      const other = g.options().find(o => o.id !== id && !o.hidden && o.id !== 'items' && o.id !== 'back')
      if (!other) throw new Error(`stuck in ${g.mode} (${res.reason})`)
      g.choose(other.id)
    }
    // Save/restore round trip every so often, like closing the app.
    if (actions % 97 === 0 && g.run) {
      const copy = new Game(JSON.parse(JSON.stringify(g.run)), g.hall)
      Object.assign(g, { run: copy.run })
    }
    if (g.run) {
      const h = g.run.hero
      assert.ok(Number.isFinite(h.hp) && Number.isFinite(h.gold) && h.gold >= 0, `bad numbers ${JSON.stringify({ hp: h.hp, gold: h.gold })}`)
      assert.ok(g.mode === 'dead' || h.hp > 0, `alive at ${h.hp} HP in ${g.mode}`)
      assert.ok(g.options().length > 0, `no options in ${g.mode}`)
    }
  }
  const r = g.run!
  return { floor: r.floor, level: r.hero.level, cause: r.cause, actions }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const pctl = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)]

console.log(`bot: ${RUNS} runs per class`)
for (const c of CLASSES) {
  const results = Array.from({ length: RUNS }, (_, i) => playRun(c.id, 1000 + i * 7919))
  const floors = results.map(r => r.floor)
  const causes: Record<string, number> = {}
  for (const r of results) causes[r.cause] = (causes[r.cause] ?? 0) + 1
  const top = Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')
  console.log(
    `${c.name.padEnd(10)} floor median ${median(floors)}, p10 ${pctl(floors, 0.1)}, p90 ${pctl(floors, 0.9)}, max ${Math.max(...floors)}; ` +
      `level median ${median(results.map(r => r.level))}; killers: ${top}`,
  )
}
console.log('engine tests passed')
