// The controller: one game, one Dungeon Master, one microphone, and the
// state both views (lens and phone) draw from.
//
// Input arrives three ways -- speech, glasses gestures, phone buttons/typing --
// and all of it ends in Game.choose() or Game.resolveRuling(). Speech goes
// through matchIntent first; only what doesn't fit an option (or clearly means
// something else) is sent to the DM, because a local model takes a second or
// two and the options don't.

import { Game, ROOMS_PER_FLOOR, type Option, type Mode, type Ruling } from './engine/game.ts'
import { COMBAT_EFFECTS, EVENT_EFFECTS, CONSUMABLES, themeFor, type EffectKind } from './engine/data.ts'
import { itemWords, type Item } from './engine/items.ts'
import { matchIntent, matchCommand, tokens } from './intent.ts'
import { DungeonMaster } from './dm.ts'
import { SttClient, type SttState } from './stt.ts'
import { KEYS, writeJson, type Settings } from './store.ts'
import type { IconName } from './icons.gen.ts'

export type VoiceState = 'off' | 'idle' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'error'

export interface Page {
  title: string
  icon: IconName
  pages: string[]
  index: number
}

export interface LogEntry {
  kind: 'you' | 'story' | 'dm' | 'note'
  text: string
}

const EXPLORE_EFFECTS: EffectKind[] = ['none', 'heal', 'hurt', 'gold', 'lose_gold', 'item', 'bless', 'curse', 'poison']
const SELECT_MS = 8000
const FLASH_MS = 3500
const HANDS_FREE_MISSES = 3

export const HELP = [
  'Speak to play. Tap the glasses, then say what you do: "attack the goblin", "cast fireball", "drink a potion", "go left", "buy the ring". Or say an option\'s number.',
  'Say anything else and the Dungeon Master rules on it: "kick the brazier onto the orc", "bribe the guard", "look for a secret door". You roll the dice.',
  'Say "inventory", "character", "repeat", or "hands free" to keep the mic open between turns.',
  'No voice? Swipe to highlight an option and tap to pick it. Double-tap goes back. Press and hold for the menu.',
  'Every third floor ends in a boss. Rest at campfires, pray at shrines, recruit companions, and see how deep you get. Death is permanent; your legend goes in the Hall of Fame.',
].join('\n')

export interface AppHooks {
  /** Open or close the glasses mic. */
  mic(on: boolean): Promise<void>
  /** Leave the app (glasses). */
  exit(): void
}

export class App {
  readonly game: Game
  readonly dm: DungeonMaster
  private stt: SttClient | null = null
  settings: Settings

  voice: VoiceState = 'off'
  partial = ''
  /** AI narration for the current turn, when it has arrived. */
  narration: string | null = null
  page: Page | null = null
  highlight: number | null = null
  flash = ''
  busy = ''
  log: LogEntry[] = []

  private turn = 0
  private selectUntil = 0
  private flashTimer: ReturnType<typeof setTimeout> | null = null
  private exitArmed = 0
  private awaiting = false
  private misses = 0
  private listeners: (() => void)[] = []

  constructor(
    game: Game,
    settings: Settings,
    private hooks: AppHooks,
    /** True when running on the glasses, where there is a mic to use. */
    readonly hasMic: boolean,
  ) {
    this.game = game
    this.settings = settings
    this.dm = new DungeonMaster(() => this.settings)
    this.dm.onChange(() => this.emit())
    this.configureVoice()
    if (!this.voiceReady) this.highlight = 0
    const r = game.run
    if (r?.lines.length) this.log.push({ kind: 'story', text: r.lines.join(' ') })
  }

  // --- plumbing --------------------------------------------------------------------------

  onChange(fn: () => void) {
    this.listeners.push(fn)
  }

  emit() {
    for (const fn of this.listeners) fn()
  }

  get voiceReady(): boolean {
    return this.hasMic && !!this.settings.server
  }

  updateSettings(patch: Partial<Settings>) {
    const serverChanged = patch.server !== undefined && patch.server !== this.settings.server
    this.settings = { ...this.settings, ...patch }
    writeJson(KEYS.settings, this.settings)
    if (serverChanged) this.configureVoice()
    void this.dm.check()
    if (!this.voiceReady && this.highlight === null) this.highlight = 0
    this.emit()
  }

  private configureVoice() {
    this.stt?.close()
    this.stt = null
    this.voice = 'off'
    if (!this.voiceReady) return
    this.voice = 'idle'
    this.stt = new SttClient(() => this.settings.server, {
      onState: s => this.onSttState(s),
      onPartial: t => {
        this.partial = t
        this.emit()
      },
      onTranscript: t => void this.onTranscript(t),
    })
  }

  private save() {
    writeJson(KEYS.run, this.game.run)
    writeJson(KEYS.hall, this.game.hall)
  }

  private setFlash(text: string, ms = FLASH_MS) {
    this.flash = text
    if (this.flashTimer) clearTimeout(this.flashTimer)
    this.flashTimer = setTimeout(() => {
      this.flash = ''
      this.emit()
    }, ms)
    this.emit()
  }

  private note(kind: LogEntry['kind'], text: string) {
    if (!text) return
    this.log.push({ kind, text })
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300)
  }

  // --- voice ---------------------------------------------------------------------------

  private onSttState(s: SttState) {
    if (s === 'listening') this.voice = 'listening'
    else if (s === 'transcribing') this.voice = 'transcribing'
    else if (s === 'connecting') this.voice = 'connecting'
    else if (s === 'error') {
      this.voice = 'idle'
      this.awaiting = false
      void this.hooks.mic(false)
      this.setFlash('Speech failed. Is the Delve server running?')
    } else if (this.voice !== 'thinking') this.voice = 'idle'
    this.emit()
  }

  async listen() {
    if (!this.stt || this.stt.listening || this.voice === 'thinking') return
    this.page = null
    this.partial = ''
    this.awaiting = true
    await this.stt.connect()
    if (!this.awaiting) return
    await this.hooks.mic(true)
    this.stt.start()
    this.voice = 'listening'
    this.emit()
  }

  /** Mic audio from the glasses. */
  pushAudio(pcm: Uint8Array) {
    this.stt?.sendPcm(pcm)
  }

  stopListening() {
    if (this.stt?.listening) this.stt.stop()
  }

  cancelListening() {
    this.awaiting = false
    this.stt?.cancel()
    void this.hooks.mic(false)
    this.partial = ''
    this.voice = this.stt ? 'idle' : 'off'
    this.emit()
  }

  private async onTranscript(text: string) {
    void this.hooks.mic(false)
    if (!this.awaiting) return
    this.awaiting = false
    this.partial = ''
    const said = text.trim()
    if (!said) {
      this.voice = 'idle'
      this.misses++
      if (this.settings.handsFree && this.misses < HANDS_FREE_MISSES) this.armHandsFree(this.turn, 400)
      else this.setFlash(this.settings.handsFree ? 'Still there? Tap to speak.' : 'Didn\'t hear anything.')
      this.emit()
      return
    }
    this.misses = 0
    this.voice = 'idle'
    await this.say(said)
  }

  private armHandsFree(turn: number, delay = 900) {
    if (!this.settings.handsFree || !this.voiceReady) return
    setTimeout(() => {
      if (turn !== this.turn || this.voice !== 'idle' || this.page || this.game.mode === 'dead') return
      void this.listen()
    }, delay)
  }

  // --- understanding speech and typing ------------------------------------------------------

  /** Anything the player said or typed. */
  async say(text: string) {
    const said = text.trim()
    if (!said) return
    this.note('you', said)
    const cmd = matchCommand(said)
    if (this.page) {
      if (cmd === 'back' || /^(close|ok|okay|done|thanks)$/i.test(said)) return this.closePage()
      if (/next|more|down/i.test(said)) return this.pageBy(1)
      if (/previous|back|up/i.test(said)) return this.pageBy(-1)
      this.page = null
    }
    if (cmd) return this.command(cmd)

    const g = this.game
    const mode = g.mode
    const options = this.allOptions()

    if (mode === 'name') {
      const m = matchIntent(said, options)
      if (m && m.confidence === 'high' && tokens(said).length <= 3) return this.pick(m.option.id)
      this.setFlash(`» ${said}`)
      g.setName(said)
      return this.afterTurn({ narrate: false })
    }

    const known = mode === 'combat' ? (g.run?.combat?.enemies.flatMap(e => e.words) ?? []) : []
    const m = matchIntent(said, options, known)
    const freeformOk = this.dm.ready && ['combat', 'doors', 'treasure', 'shrine', 'merchant', 'rest', 'trap', 'event', 'recruit', 'stairs'].includes(mode)
    if (m && (m.confidence === 'high' || !freeformOk)) {
      this.setFlash(`» ${said}`)
      return this.pick(m.option.id, g.enemyIndex(tokens(said)))
    }
    if (freeformOk) return this.freeform(said)
    this.setFlash(this.settings.ai && this.dm.status !== 'unset' ? 'The Dungeon Master is away. Say an option.' : `Didn't catch "${said}". Say an option or its number.`, 5000)
  }

  /** Visible options, plus voice-only ones: items by name, selling, and so on. */
  allOptions(): Option[] {
    const g = this.game
    const opts = g.options()
    const mode = g.mode
    if (g.run && !['combat', 'class', 'name', 'dead', 'loot', 'perk'].includes(mode)) {
      for (const it of g.run.hero.pack) {
        const def = CONSUMABLES[it.base]
        if (!def.outside) continue
        opts.push({ id: `use:${it.base}`, label: def.name, words: usePhrases(it), hidden: true })
      }
    }
    return opts
  }

  private command(cmd: NonNullable<ReturnType<typeof matchCommand>>) {
    switch (cmd) {
      case 'inventory':
        return this.openPage('inventory')
      case 'sheet':
        return this.openPage('sheet')
      case 'help':
        return this.openPage('help')
      case 'repeat':
        // Everything is still on the lens; clearing the flash brings it back into view.
        this.flash = ''
        return this.emit()
      case 'handsfree-on':
        this.updateSettings({ handsFree: true })
        this.setFlash('Hands-free on: the mic reopens after each turn.')
        return this.armHandsFree(this.turn, 1200)
      case 'handsfree-off':
        this.updateSettings({ handsFree: false })
        return this.setFlash('Hands-free off. Tap to speak.')
      case 'back':
        return this.back()
    }
  }

  /** Picks an option by id (gestures, buttons, and matched speech). */
  pick(id: string, target?: number) {
    const g = this.game
    this.page = null
    this.selectUntil = 0
    if (id.startsWith('use:')) {
      const res = g.useOutside(id.slice(4))
      if (!res.ok) return this.setFlash(res.reason ?? 'Not now.')
      return this.afterTurn({ narrate: false })
    }
    if (id.startsWith('sell:')) {
      const res = g.sell(id.slice(5))
      if (!res.ok) return this.setFlash(res.reason ?? 'Not now.')
      return this.afterTurn({ narrate: false })
    }
    const before: Mode = g.mode
    if (id === 'items' || id === 'back') {
      g.choose(id)
      this.highlight = this.voiceReady ? null : 0
      return this.emit()
    }
    const res = g.choose(id, target)
    if (!res.ok) return this.setFlash(res.reason ?? 'That isn\'t possible right now.')
    if (before === 'dead' || before === 'class') this.dm.forget()
    const narrate = ['doors', 'combat', 'treasure', 'trap', 'shrine', 'rest', 'stairs'].includes(before)
    this.afterTurn({ narrate })
  }

  private async freeform(said: string) {
    const g = this.game
    const mode = g.mode
    const where = mode === 'combat' ? 'combat' : mode === 'event' ? 'event' : 'explore'
    const effects = where === 'combat' ? COMBAT_EFFECTS : where === 'event' ? EVENT_EFFECTS : EXPLORE_EFFECTS
    const turn = this.turn
    this.voice = 'thinking'
    this.busy = 'The Dungeon Master considers…'
    this.emit()
    const ruling = await this.dm.rule(said, g.context(), effects, where)
    this.busy = ''
    this.voice = this.stt ? 'idle' : 'off'
    if (turn !== this.turn) return this.emit() // they did something else meanwhile
    if (!ruling) {
      this.setFlash('The Dungeon Master didn\'t answer. Try an option.', 5000)
      return
    }
    const withTarget: Ruling = { ...ruling, target: g.enemyIndex(tokens(said)) }
    const res = g.resolveRuling(withTarget)
    if (!res.ok) return this.setFlash(res.reason ?? 'Not now.')
    // The DM already wrote the outcome; narrating it again would only echo.
    this.afterTurn({ narrate: false })
  }

  /** After anything changed the game: save, show, narrate, maybe listen again. */
  private afterTurn(o: { narrate: boolean }) {
    const g = this.game
    this.turn++
    const turn = this.turn
    this.narration = null
    this.highlight = this.voiceReady ? null : 0
    this.save()
    const r = g.run
    if (r?.lines.length) this.note('story', r.lines.join(' '))
    this.emit()

    // A fresh event room: let the DM invent something better than the book.
    if (r && g.mode === 'event' && r.room?.kind === 'event' && !r.room.ai && this.dm.ready) {
      void this.invent(turn)
      return
    }
    if (o.narrate && this.dm.ready && r?.lines.length) {
      void this.dm.narrate(r.lines, g.context()).then(text => {
        if (turn !== this.turn) return
        if (text) {
          this.narration = text
          this.note('dm', text)
          this.emit()
        }
        this.armHandsFree(turn, 1500)
      })
      return
    }
    this.armHandsFree(turn)
  }

  private async invent(turn: number) {
    const g = this.game
    this.voice = 'thinking'
    this.busy = 'The Dungeon Master is weaving a scene…'
    this.emit()
    const ev = await this.dm.invent(g.context(), EVENT_EFFECTS)
    this.busy = ''
    this.voice = this.stt ? 'idle' : 'off'
    if (turn !== this.turn) return this.emit()
    if (ev && g.mode === 'event') {
      g.setEvent(ev)
      this.save()
      this.note('dm', `${ev.title}. ${ev.text}`)
    }
    this.emit()
    this.armHandsFree(turn)
  }

  // --- gestures (glasses) ------------------------------------------------------------------

  get selecting(): boolean {
    return this.highlight !== null && (!this.voiceReady || Date.now() < this.selectUntil)
  }

  tap() {
    if (this.page) return this.closePage()
    if (this.voice === 'listening' || this.voice === 'connecting') return this.stopListening()
    if (this.voice === 'thinking' || this.voice === 'transcribing') return
    if (this.selecting && this.highlight !== null) {
      const opt = this.visibleOptions()[this.highlight]
      if (opt) return this.pick(opt.id)
    }
    if (this.voiceReady) {
      this.misses = 0
      return void this.listen()
    }
    const first = this.visibleOptions()[0]
    if (first) this.pick(first.id)
  }

  swipe(delta: number) {
    if (this.page) return this.pageBy(delta)
    if (this.voice === 'listening') this.cancelListening()
    const n = this.visibleOptions().length
    if (!n) return
    this.highlight = this.highlight === null || !this.selecting ? (delta > 0 ? 0 : n - 1) : (this.highlight + delta + n) % n
    this.selectUntil = Date.now() + SELECT_MS
    this.emit()
    // Let the highlight fade back to "tap to speak" when the timer runs out.
    if (this.voiceReady) {
      setTimeout(() => {
        if (Date.now() >= this.selectUntil) {
          this.highlight = null
          this.emit()
        }
      }, SELECT_MS + 50)
    }
  }

  double() {
    if (this.voice === 'listening' || this.voice === 'connecting') return this.cancelListening()
    if (this.page) return this.closePage()
    if (this.selecting && this.voiceReady) {
      this.highlight = null
      this.selectUntil = 0
      return this.emit()
    }
    if (this.game.run?.combat?.menu === 'items') return this.pick('back')
    if (Date.now() - this.exitArmed < 2500) {
      this.save()
      return this.hooks.exit()
    }
    this.exitArmed = Date.now()
    this.setFlash('Double-tap again to leave. Your run is saved.', 2500)
  }

  back() {
    if (this.page) return this.closePage()
    if (this.game.run?.combat?.menu === 'items') return this.pick('back')
  }

  visibleOptions(): Option[] {
    return this.game.options().filter(o => !o.hidden)
  }

  // --- pages ---------------------------------------------------------------------------

  openPage(which: 'sheet' | 'inventory' | 'help' | 'hall') {
    const g = this.game
    let page: Page
    const paginate = this.paginator
    if ((which === 'sheet' || which === 'inventory') && !g.run) return this.setFlash('Choose a hero first.')
    if (which === 'sheet') page = { title: 'Character', icon: 'progression', pages: paginate(g.sheetText()), index: 0 }
    else if (which === 'inventory') page = { title: 'Inventory', icon: 'open-treasure-chest', pages: paginate(g.inventoryText()), index: 0 }
    else if (which === 'hall') page = { title: 'Hall of Fame', icon: 'crowned-skull', pages: paginate(hallText(g)), index: 0 }
    else page = { title: 'How to play', icon: 'dice-twenty-faces-twenty', pages: paginate(HELP), index: 0 }
    if (this.voice === 'listening') this.cancelListening()
    this.page = page
    this.emit()
  }

  /** Set by the lens so pages break where the lens wraps. */
  paginator: (text: string) => string[] = text => [text]

  pageBy(delta: number) {
    if (!this.page) return
    this.page.index = Math.max(0, Math.min(this.page.pages.length - 1, this.page.index + delta))
    this.emit()
  }

  closePage() {
    this.page = null
    this.emit()
    this.armHandsFree(this.turn, 600)
  }

  toggleHandsFree() {
    const on = !this.settings.handsFree
    this.updateSettings({ handsFree: on })
    this.setFlash(on ? 'Hands-free on.' : 'Hands-free off.')
    if (on) this.armHandsFree(this.turn, 800)
  }

  abandonRun() {
    this.game.run = null
    this.dm.forget()
    this.log = []
    this.afterTurn({ narrate: false })
  }

  // --- what to show ----------------------------------------------------------------------

  headerLeft(): string {
    const r = this.game.run
    if (!r || this.game.mode === 'name') return '◆ DELVE'
    const theme = themeFor(r.floor).replace(/^the /, '')
    return `◆ F${r.floor} ${Math.min(r.step + 1, ROOMS_PER_FLOOR)}/${ROOMS_PER_FLOOR} · ${theme}`
  }

  headerRight(): string {
    const r = this.game.run
    if (!r || this.game.mode === 'name') return 'endless dungeon'
    const h = r.hero
    return `♥ ${Math.max(0, h.hp)}/${this.game.maxHp()}${h.tempHp ? `+${h.tempHp}` : ''}   ${h.gold}g   L${h.level}`
  }

  /** The story text for this turn: the narration if it came, else the engine's lines. */
  story(): { text: string; tally: string } {
    const r = this.game.run
    if (!r) return { text: '', tally: '' }
    if (this.narration) return { text: this.narration, tally: r.tally.join(' · ') }
    return { text: r.lines.join(' '), tally: '' }
  }

  footer(): string {
    if (this.page) return ''
    if (this.voice === 'listening') return `● ${this.partial ? `"${this.partial}"` : 'Listening…'}`
    if (this.voice === 'connecting') return '◐ Opening the mic…'
    if (this.voice === 'transcribing') return `◐ ${this.partial ? `"${this.partial}"` : 'Hearing you…'}`
    if (this.voice === 'thinking') return `◐ ${this.busy || 'Thinking…'}`
    if (this.flash) return this.flash
    const opts = this.visibleOptions()
    if (this.selecting && this.highlight !== null && opts[this.highlight]) {
      return this.voiceReady ? `tap: ${opts[this.highlight].label}   double-tap: cancel` : `tap: ${opts[this.highlight].label}   swipe: move   hold: menu`
    }
    if (this.voiceReady) return this.settings.handsFree ? 'hands-free · tap: speak · swipe: choose' : 'tap: speak   swipe: choose   hold: menu'
    return 'tap: choose   swipe: move   hold: menu'
  }
}

function usePhrases(it: Item): string[] {
  return itemWords(it).flatMap(w => [`drink ${w}`, `use ${w}`, `read ${w}`, `quaff ${w}`])
}

export function hallText(g: Game): string {
  if (!g.hall.length) return 'No legends yet. Yours could be the first.'
  return g.hall
    .map((e, i) => `${i + 1}. ${e.name}, level ${e.level} ${e.cls}: floor ${e.floor}, ${e.kills} kills. Slain by ${e.cause}.`)
    .join('\n')
}
