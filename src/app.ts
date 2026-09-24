// The controller: one game, one Dungeon Master, one microphone, and the
// state both views (lens and phone) draw from.
//
// Input arrives three ways -- speech, glasses gestures, phone buttons/typing --
// and all of it ends in Game.choose() or Game.resolveRuling(). Speech goes
// through matchIntent first; only what doesn't fit an option (or clearly means
// something else) is sent to the DM, because a local model takes a second or
// two and the options don't.

import { Game, ROOMS_PER_FLOOR, heroPreview, type Option, type Mode, type Ruling } from './engine/game.ts'
import { COMBAT_EFFECTS, EVENT_EFFECTS, CONSUMABLES, CLASSES, themeFor, classDef, type EffectKind } from './engine/data.ts'
import { LIST_ROWS, STORY_INNER_W, lines } from './lens.ts'
import { itemWords, type Item } from './engine/items.ts'
import { matchIntent, matchCommand, tokens } from './intent.ts'
import { DungeonMaster } from './dm.ts'
import { SttClient, type SttState, type SpeechClient } from './stt.ts'
import { CloudStt } from './cloudStt.ts'
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
const FLASH_MS = 3500
const HANDS_FREE_MISSES = 3

/**
 * The hero picker's pills. The labels never change as you browse, so the
 * list isn't rebuilt and the selection stays on "Next": tap, tap, tap.
 */
const HERO_PILLS: Option[] = [
  { id: 'hero:choose', label: 'Choose this hero', words: ['choose this hero', 'choose', 'this one', 'pick this one', 'select', 'yes', 'play this'] },
  { id: 'hero:next', label: 'Next hero ▶', words: ['next', 'next hero', 'another', 'show me another', 'next one'] },
  // Voice only: with Speak, three pills is all the lens shows without paging.
  { id: 'hero:prev', label: '◀ Previous hero', words: ['previous', 'previous hero', 'go back', 'last one'], hidden: true },
]

/** The first pill when voice is set up: a tap without swiping means "talk". */
export const SPEAK: Option = { id: 'speak', label: '● Speak', words: [] }

export const HELP = [
  'Speak to play. Tap Speak, then say what you do: "attack the goblin", "cast fireball", "drink a potion", "go left", "buy the ring".',
  'Say anything else and the Dungeon Master rules on it: "kick the brazier onto the orc", "bribe the guard", "look for a secret door". You roll the dice.',
  'Swipe to move between options and tap to pick one. Double-tap any time for the main menu: pause, start over, or leave.',
  'Say "menu", "inventory", "character", "repeat", or "hands free" to keep the mic open between turns.',
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
  private stt: SpeechClient | null = null
  /** Mic loudness while listening to cloud speech (no partial transcripts there). */
  level = 0
  settings: Settings

  voice: VoiceState = 'off'
  partial = ''
  /** AI narration for the current turn, when it has arrived. */
  narration: string | null = null
  page: Page | null = null
  /** The main menu: open at launch, and on double-tap from anywhere (pause). */
  menu = { open: true, confirm: false }
  /** Which hero the picker is showing. */
  heroIndex = 0
  /** Which page of pills the lens shows (see lensItems). */
  lensPage = 0
  private pageKey = ''
  flash = ''
  busy = ''
  log: LogEntry[] = []

  private turn = 0
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

  /** Voice needs the glasses mic, plus somewhere to send it: the Delve server or a cloud key. */
  get voiceReady(): boolean {
    if (!this.hasMic) return false
    const s = this.settings
    return s.speech === 'server' ? !!s.server : !!s.keys[s.speech]
  }

  updateSettings(patch: Partial<Settings>) {
    const before = this.speechKey()
    this.settings = { ...this.settings, ...patch }
    writeJson(KEYS.settings, this.settings)
    if (this.speechKey() !== before) this.configureVoice()
    void this.dm.check()
    this.emit()
  }

  /** Everything that decides which speech client to build. */
  private speechKey(): string {
    const s = this.settings
    return s.speech === 'server' ? `server|${s.server}` : `${s.speech}|${s.keys[s.speech] ?? ''}|${this.hasMic}`
  }

  private configureVoice() {
    this.stt?.close()
    this.stt = null
    this.voice = 'off'
    if (!this.voiceReady) return
    this.voice = 'idle'
    const events = {
      onState: (s: SttState, detail?: string) => this.onSttState(s, detail),
      onPartial: (t: string) => {
        this.partial = t
        this.emit()
      },
      onTranscript: (t: string) => void this.onTranscript(t),
      onLevel: (l: number) => {
        this.level = l
        this.emit()
      },
    }
    const speech = this.settings.speech
    this.stt = speech === 'server'
      ? new SttClient(() => this.settings.server, events)
      : new CloudStt(
          () => ({ provider: speech, key: this.settings.keys[speech] ?? '', model: this.settings.speechModels[speech] ?? '' }),
          // Prime the transcriber with what's on screen: option labels and foes' names.
          () => [...this.visibleOptions().map(o => o.label), ...(this.game.run?.combat?.enemies.map(e => e.name) ?? [])],
          events,
        )
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

  private onSttState(s: SttState, detail?: string) {
    if (s === 'listening') this.voice = 'listening'
    else if (s === 'transcribing') this.voice = 'transcribing'
    else if (s === 'connecting') this.voice = 'connecting'
    else if (s === 'error') {
      this.voice = 'idle'
      this.awaiting = false
      void this.hooks.mic(false)
      this.setFlash(this.settings.speech === 'server' ? 'Speech failed. Is the Delve server running?' : `Speech failed: ${detail ?? 'no answer'}`, 5000)
    } else if (this.voice !== 'thinking') this.voice = 'idle'
    this.emit()
  }

  async listen() {
    if (!this.stt || this.stt.listening || this.voice === 'thinking') return
    this.page = null
    this.partial = ''
    this.level = 0
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
      if (turn !== this.turn || this.voice !== 'idle' || this.page || this.menu.open || this.game.mode === 'dead') return
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

    if (this.menu.open) {
      const m = matchIntent(said, this.menuOptions())
      if (m) return this.pick(m.option.id)
      return this.setFlash(`Didn't catch "${said}". Say "continue" or "new run".`, 4000)
    }

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
    if (this.menu.open) return this.menuOptions()
    const g = this.game
    const opts = g.options()
    if (g.mode === 'class') opts.push(...HERO_PILLS.map(o => ({ ...o, hidden: true })))
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
      case 'menu':
        return this.openMenu()
    }
  }

  /** Picks an option by id (gestures, buttons, and matched speech). */
  pick(id: string, target?: number): void {
    const g = this.game
    this.page = null
    if (id === 'speak') {
      this.misses = 0
      return void this.listen()
    }
    if (id.startsWith('menu:')) return this.onMenuPick(id.slice(5))
    if (id === 'nav:more') {
      this.lensPage++
      return this.emit()
    }
    if (id === 'hero:next' || id === 'hero:prev') {
      this.heroIndex = (this.heroIndex + (id === 'hero:next' ? 1 : CLASSES.length - 1)) % CLASSES.length
      return this.emit()
    }
    if (id === 'hero:choose') return this.pick(`class:${CLASSES[this.heroIndex % CLASSES.length].id}`)
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

  /**
   * The pills on the lens, in order. With voice set up, Speak comes first, so
   * a tap without swiping still means "talk" -- the list's selection starts
   * there after every change.
   */
  lensItems(): Option[] {
    const opts = !this.menu.open && this.game.mode === 'class' ? HERO_PILLS.filter(o => !o.hidden) : this.visibleOptions()
    const all = this.voiceReady ? [SPEAK, ...opts] : opts
    // New options, new first page.
    const key = all.map(o => o.id).join('|')
    if (key !== this.pageKey) {
      this.pageKey = key
      this.lensPage = 0
    }
    if (all.length <= LIST_ROWS) return all
    // Real glasses don't scroll a list past its box, so page it ourselves:
    // LIST_ROWS - 1 options per page, then a pill that turns the page.
    const per = LIST_ROWS - 1
    const pages = Math.ceil(all.length / per)
    const page = this.lensPage % pages
    const last = page === pages - 1
    return [
      ...all.slice(page * per, page * per + per),
      { id: 'nav:more', label: last ? '▲ Back to the top' : `More ▼ ${page + 1}/${pages}`, words: [] },
    ]
  }

  /** The hero picker's card for the lens: who they are and what they start with. */
  heroCard(): { icon: IconName; caption: string; text: string } {
    const c = CLASSES[this.heroIndex % CLASSES.length]
    const p = heroPreview(c.id)
    // Three lines: background, what they carry, and the six scores. Skills
    // join the middle line only if it still fits on one.
    const kit = `HP ${p.hp} · AC ${p.ac} · ${p.weapon}`
    const withSkills = `${kit} · ${p.skills.join(', ')}`
    return {
      icon: c.icon,
      caption: `${p.name} ${this.heroIndex % CLASSES.length + 1}/${CLASSES.length}`,
      text: [p.blurb, lines(withSkills, STORY_INNER_W) <= 1 ? withSkills : kit, p.stats].join('\n'),
    }
  }

  /** A tap on the pill list: whichever pill the firmware had selected. */
  tapItem(index: number) {
    if (this.page) return this.closePage()
    // Mid-sentence, any tap means "that's all": send what was said.
    if (this.voice === 'listening' || this.voice === 'connecting') return this.stopListening()
    if (this.voice === 'thinking' || this.voice === 'transcribing') return
    const item = this.lensItems()[index]
    if (item) this.pick(item.id)
  }

  /** A tap anywhere else (pages, the phone's mic button, tests): talk, or pick the first pill. */
  tap() {
    this.tapItem(0)
  }

  /** Swipes only matter on text pages; the pill list scrolls itself. */
  swipe(delta: number) {
    if (this.page) this.pageBy(delta)
  }

  /** Double-tap: back out of whatever is open, then to the main menu. */
  double() {
    if (this.voice === 'listening' || this.voice === 'connecting') return this.cancelListening()
    if (this.page) return this.closePage()
    if (this.menu.confirm) {
      this.menu.confirm = false
      return this.emit()
    }
    if (this.menu.open) {
      // From the menu, double-tap resumes a run in progress, or leaves.
      if (this.runAlive) return this.onMenuPick('continue')
      if (Date.now() - this.exitArmed < 2500) return this.onMenuPick('exit')
      this.exitArmed = Date.now()
      return this.setFlash('Double-tap again to leave.', 2500)
    }
    if (this.game.run?.combat?.menu === 'items') return this.pick('back')
    this.openMenu()
  }

  back() {
    if (this.page) return this.closePage()
    if (this.game.run?.combat?.menu === 'items') return this.pick('back')
  }

  visibleOptions(): Option[] {
    if (this.menu.open) return this.menuOptions()
    return this.game.options().filter(o => !o.hidden)
  }

  // --- main menu -------------------------------------------------------------------------

  /** A run that can be continued (not one that just ended in death). */
  get runAlive(): boolean {
    return !!this.game.run && this.game.mode !== 'dead'
  }

  openMenu() {
    if (this.voice === 'listening' || this.voice === 'connecting') this.cancelListening()
    this.page = null
    this.menu = { open: true, confirm: false }
    this.save()
    this.emit()
  }

  menuOptions(): Option[] {
    if (this.menu.confirm) {
      return [
        { id: 'menu:restart', label: 'Start over', words: ['start over', 'yes', 'restart', 'confirm', 'do it', 'new run'], detail: 'this hero is lost' },
        { id: 'menu:cancel', label: 'Cancel', words: ['cancel', 'no', 'never mind', 'keep playing', 'back'] },
      ]
    }
    const opts: Option[] = []
    if (this.runAlive) {
      opts.push({ id: 'menu:continue', label: 'Continue', words: ['continue', 'resume', 'play', 'unpause', 'keep playing', 'back to the game', 'go back'], detail: this.runSummary() })
    }
    opts.push(
      { id: 'menu:new', label: 'New run', words: ['new run', 'new game', 'new hero', 'restart', 'start over', 'start', 'play', 'begin'], detail: this.runAlive ? 'abandon this hero' : 'choose a hero' },
      { id: 'menu:hall', label: 'Hall of Fame', words: ['hall of fame', 'hall', 'legends', 'high scores', 'scores'] },
      { id: 'menu:help', label: 'How to play', words: ['how to play', 'help', 'instructions', 'tutorial'] },
      { id: 'menu:hands', label: `Hands-free: ${this.settings.handsFree ? 'on' : 'off'}`, words: ['hands free', 'handsfree', 'toggle hands free'], detail: 'mic reopens every turn' },
      { id: 'menu:exit', label: 'Exit', words: ['exit', 'quit', 'leave', 'close', 'goodbye'], detail: this.runAlive ? 'your run is saved' : '' },
    )
    return opts
  }

  private runSummary(): string {
    const r = this.game.run
    if (!r) return ''
    return `${r.hero.name}, floor ${r.floor}`
  }

  private onMenuPick(what: string) {
    switch (what) {
      case 'continue':
        this.menu = { open: false, confirm: false }
        this.emit()
        return this.armHandsFree(this.turn, 800)
      case 'new':
        if (this.runAlive) {
          this.menu.confirm = true
          return this.emit()
        }
        return this.startOver()
      case 'restart':
        return this.startOver()
      case 'cancel':
        this.menu.confirm = false
        return this.emit()
      case 'hall':
        return this.openPage('hall')
      case 'help':
        return this.openPage('help')
      case 'hands':
        return this.toggleHandsFree()
      case 'exit':
        this.save()
        return this.hooks.exit()
    }
  }

  /** Drops the current hero (abandoned runs don't enter the Hall of Fame) and goes to hero select. */
  private startOver() {
    this.game.run = null
    this.dm.forget()
    this.log = []
    this.menu = { open: false, confirm: false }
    this.afterTurn({ narrate: false })
  }

  /** What the lens shows behind the menu. */
  menuScene(): { icon: IconName; caption: string; text: string } {
    const r = this.game.run
    if (this.menu.confirm && r) {
      return { icon: 'dead-head', caption: 'Start over?', text: `${r.hero.name}, level ${r.hero.level} ${classDef(r.hero.cls).name} on floor ${r.floor}, will be lost for good.` }
    }
    if (this.runAlive && r) {
      return { icon: classDef(r.hero.cls).icon, caption: r.hero.name, text: `Paused. ${r.hero.name}, level ${r.hero.level} ${classDef(r.hero.cls).name}, is waiting on floor ${r.floor} of ${themeFor(r.floor)}.` }
    }
    return { icon: 'dice-twenty-faces-twenty', caption: 'Main menu', text: 'An endless dungeon. Every run ends in death: how deep can you go?' }
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

  /** From the phone's Settings: drop the hero and go back to the main menu. */
  abandonRun() {
    this.game.run = null
    this.dm.forget()
    this.log = []
    this.afterTurn({ narrate: false })
    this.openMenu()
  }

  // --- what to show ----------------------------------------------------------------------

  headerLeft(): string {
    const r = this.game.run
    if (this.menu.open || !r || this.game.mode === 'name') return '◆ DELVE'
    const theme = themeFor(r.floor).replace(/^the /, '')
    return `◆ F${r.floor} ${Math.min(r.step + 1, ROOMS_PER_FLOOR)}/${ROOMS_PER_FLOOR} · ${theme}`
  }

  headerRight(): string {
    const r = this.game.run
    if (this.menu.open) return 'main menu'
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
    if (this.voice === 'listening') return `● ${this.partial ? `"${this.partial}"` : `Listening ${meter(this.level)} tap to send`}`
    if (this.voice === 'connecting') return '◐ Opening the mic…'
    if (this.voice === 'transcribing') return `◐ ${this.partial ? `"${this.partial}"` : 'Hearing you…'}`
    if (this.voice === 'thinking') return `◐ ${this.busy || 'Thinking…'}`
    if (this.flash) return this.flash
    const swipe = 'swipe + tap to choose'
    if (this.menu.open) return this.runAlive ? `${swipe}   double-tap: resume` : swipe
    // Under an AI narration, the numbers it left out.
    const tally = this.story().tally
    if (tally) return tally
    return `${swipe}   double-tap: menu`
  }
}

/** A tiny level meter from the block glyphs the G2 font has. */
function meter(level: number): string {
  const bars = '▁▂▃▄▅▆▇█'
  return bars[Math.max(0, Math.min(bars.length - 1, Math.round(level * (bars.length - 1))))].repeat(3)
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
