// The AI Dungeon Master: a local model (Ollama, through the Delve server in
// server/) or a cloud model (Claude, ChatGPT or OpenRouter; see llm.ts). It
// narrates, rules on anything the player says that isn't an option, and
// invents encounters.
//
// It is an embellishment, never a dependency. Every call has a timeout and a
// null fallback, and the engine clamps whatever comes back (see
// Game.resolveRuling), so a slow, offline or confused model costs flavor, not
// the run. Every reply is constrained to a JSON schema, which keeps even a 4B
// local model on the rails far better than asking nicely.

import type { Ability, EffectKind, EventDef, Outcome } from './engine/data.ts'
import type { Ruling } from './engine/game.ts'
import type { IconName } from './icons.gen.ts'
import type { Settings } from './store.ts'
import { complete, listModels, type ChatMessage, type LlmConfig } from './llm.ts'

export type DmStatus = 'off' | 'unset' | 'checking' | 'ready' | 'offline' | 'old-server' | 'no-key' | 'bad-key'

const NARRATE_MS = 12_000
const RULE_MS = 20_000
const INVENT_MS = 25_000

const SYSTEM = `You are the Dungeon Master of DELVE, an endless D&D-style dungeon crawl played by voice on smart glasses.
Style: vivid, punchy, second person ("you"), present tense, dark fantasy with a wink of humor.
Everything you write is read on a tiny display: be brief. Never use markdown, emoji or lists.
Never contradict the facts you are given, and never invent outcomes the facts don't state.`

const EFFECT_HELP: Record<EffectKind, string> = {
  none: 'no mechanical effect, only story',
  heal: 'the hero recovers a little health',
  hurt: 'the hero takes minor damage',
  hurt_big: 'the hero takes serious damage',
  gold: 'the hero gains a little gold',
  gold_big: 'the hero gains a lot of gold',
  lose_gold: 'the hero loses some gold',
  item: 'the hero finds a useful item',
  rare_item: 'the hero finds a valuable magic item',
  bless: 'good luck for the rest of this floor',
  curse: 'bad luck for the rest of this floor',
  xp: 'the hero learns something (experience)',
  fight: 'a fight breaks out',
  companion: 'someone joins the hero as a companion',
  poison: 'the hero is poisoned',
  damage: 'the target enemy takes a solid hit',
  damage_big: 'the target enemy takes a devastating blow',
  stun: 'the target enemy loses its next turn',
  flee_enemy: 'the target enemy runs away',
  pacify: 'the enemies stop fighting and leave',
  advantage: "the hero's next attack has advantage",
  escape: 'the hero escapes the fight',
}

/** Portraits the DM may choose for an invented encounter. */
export const EVENT_ICONS: IconName[] = [
  'star-altar', 'crystal-shrine', 'scroll-unfurled', 'hooded-figure', 'floating-ghost', 'spotted-mushroom',
  'crowned-skull', 'medusa-head', 'goblin-head', 'dwarf-face', 'black-knight-helm', 'wooden-door', 'stairs',
  'campfire', 'open-treasure-chest', 'skull-staff', 'fairy', 'cultist', 'imp-laugh', 'monk-face', 'nun-face',
  'bandit', 'woman-elf-face', 'cat', 'barn-owl', 'kenku-head', 'mimic-chest', 'shop',
]

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha', 'none']

function outcomeSchema(effects: EffectKind[]) {
  return {
    type: 'object',
    properties: { effect: { type: 'string', enum: effects }, text: { type: 'string' } },
    required: ['effect', 'text'],
  }
}

export class DungeonMaster {
  status: DmStatus = 'unset'
  private listeners: (() => void)[] = []

  constructor(private settings: () => Settings) {}

  onChange(fn: () => void) {
    this.listeners.push(fn)
  }

  private set(s: DmStatus) {
    if (this.status === s) return
    this.status = s
    for (const fn of this.listeners) fn()
  }

  get ready(): boolean {
    return this.status === 'ready' && this.settings().ai
  }

  /** The provider, key and model the DM would use right now. */
  config(): LlmConfig {
    const s = this.settings()
    return { provider: s.provider, server: s.server, key: s.keys[s.provider] ?? '', model: s.models[s.provider] ?? '' }
  }

  /** Checks the chosen provider answers: the Delve server's health, or a cloud key. */
  async check(): Promise<DmStatus> {
    const s = this.settings()
    const cfg = this.config()
    if (cfg.provider !== 'local') {
      if (!cfg.key) {
        this.set('no-key')
        return this.status
      }
      this.set('checking')
      try {
        await listModels(cfg)
        this.set(s.ai ? 'ready' : 'off')
      } catch (err) {
        this.set(err instanceof Error && /rejected/.test(err.message) ? 'bad-key' : 'offline')
      }
      return this.status
    }
    if (!s.server) {
      this.set('unset')
      return this.status
    }
    this.set('checking')
    try {
      const res = await fetchWithTimeout(`${s.server}/api/health`, { method: 'GET' }, 5000)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const h = (await res.json()) as { ollama?: boolean; features?: string[] }
      if (!h.features?.includes('chat')) this.set('old-server')
      else this.set(h.ollama === false ? 'offline' : s.ai ? 'ready' : 'off')
    } catch {
      this.set('offline')
    }
    return this.status
  }

  /** Called when a run ends. Nothing is carried between prompts today. */
  forget() {}

  private async chat(messages: ChatMessage[], opts: { format: Record<string, unknown>; maxTokens: number; temperature: number; timeout: number }): Promise<string | null> {
    const cfg = this.config()
    const text = await complete(cfg, messages, {
      schema: opts.format,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      // Cloud models think before answering and cross the internet; give them longer.
      timeoutMs: cfg.provider === 'local' ? opts.timeout : opts.timeout * 2,
    })
    // One failure doesn't mean the provider is gone; re-check in the background.
    if (text === null) void this.check()
    return text
  }

  /** A sentence or two of story for what the engine says just happened. */
  async narrate(facts: string[], context: string): Promise<string | null> {
    if (!this.ready || !facts.length) return null
    const text = await this.chat(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            `${context}\n\nThese things just happened, in this order:\n- ${facts.join('\n- ')}\n\n` +
            'Retell exactly these events as vivid narration: one or two short sentences, 30 words at most. ' +
            'Rules: describe only the listed events; a creature only dies if the list says it falls or dies; ' +
            'nobody finds anything unless the list says so; if something only appears or blocks the way, describe it arriving ' +
            'and nothing more -- no one has struck a blow yet; no digits or numbers; no game terms like HP or XP; ' +
            'do not ask what happens next.',
        },
      ],
      {
        // A schema even for plain prose: some models (qwen3's thinking builds)
        // ignore think:false and reason into the reply. Constrained output
        // can't, and it costs nothing.
        format: { type: 'object', properties: { narration: { type: 'string' } }, required: ['narration'] },
        maxTokens: 140,
        temperature: 0.7,
        timeout: NARRATE_MS,
      },
    )
    if (!text) return null
    let narration = ''
    try {
      narration = String((JSON.parse(text) as { narration?: string }).narration ?? '')
    } catch {
      return null
    }
    const clean = tidy(narration)
    // Digits mean it just echoed the facts back; the engine's lines say that better.
    if (!clean || /\d/.test(clean)) return null
    return clean
  }

  /**
   * How to resolve something the player said that isn't one of the options.
   * @param where 'combat', 'event' or 'explore' -- decides which effects exist.
   */
  async rule(said: string, context: string, effects: EffectKind[], where: 'combat' | 'event' | 'explore'): Promise<Ruling | null> {
    if (!this.ready) return null
    const help = effects.map(e => `${e}: ${EFFECT_HELP[e]}`).join('\n')
    const guidance =
      where === 'combat'
        ? 'This is the hero\'s turn in a fight. Creative attacks deserve a fair chance (damage or stun); wild ones a high DC.'
        : where === 'event'
          ? 'This is the hero\'s answer to the scene. Rewards should match the risk.'
          : 'Nothing is at stake unless the action makes it so. Most actions like looking or talking are ability "none" with effect "none": just describe what they notice. Rewards are rare and small.'
    const raw = await this.chat(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            `${context}\nThe player says: "${said}"\n\n${guidance}\n` +
            'Rule on it like a fair D&D Dungeon Master:\n' +
            '- ability: the ability check it needs, or "none" if it just happens.\n' +
            '- dc: 5 trivial, 10 easy, 15 hard, 20 very hard, 25 nearly impossible.\n' +
            '- success: what happens if the check passes (a good outcome for the hero).\n' +
            '- failure: what happens if it fails (neutral or bad for the hero).\n' +
            'Each text is one vivid sentence, at most 22 words, describing that outcome.\n' +
            `Effects:\n${help}\n` +
            'If the action is impossible or nonsense, use ability "none" and effect "none" and say so in character.',
        },
      ],
      {
        format: {
          type: 'object',
          properties: {
            ability: { type: 'string', enum: ABILITIES },
            dc: { type: 'integer' },
            success: outcomeSchema(effects),
            failure: outcomeSchema(effects),
          },
          required: ['ability', 'dc', 'success', 'failure'],
        },
        maxTokens: 260,
        temperature: 0.7,
        timeout: RULE_MS,
      },
    )
    if (!raw) return null
    try {
      const j = JSON.parse(raw) as { ability: string; dc: number; success: Outcome; failure: Outcome }
      const fix = (o: Outcome): Outcome => ({ effect: effects.includes(o?.effect) ? o.effect : 'none', text: tidy(o?.text ?? '') })
      return {
        ability: (ABILITIES.includes(j.ability) ? j.ability : 'none') as Ability | 'none',
        dc: Number(j.dc) || 12,
        success: fix(j.success),
        failure: fix(j.failure),
      }
    } catch {
      return null
    }
  }

  /** A brand-new encounter for an event room. */
  async invent(context: string, effects: EffectKind[]): Promise<EventDef | null> {
    if (!this.ready) return null
    const help = effects.filter(e => e !== 'none').map(e => `${e}: ${EFFECT_HELP[e]}`).join('\n')
    const choice = {
      type: 'object',
      properties: {
        label: { type: 'string' },
        ability: { type: 'string', enum: ABILITIES.filter(a => a !== 'none') },
        dc: { type: 'integer' },
        success: outcomeSchema(effects),
        failure: outcomeSchema(effects),
      },
      required: ['label', 'ability', 'dc', 'success', 'failure'],
    }
    const raw = await this.chat(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            `${context}\n\nInvent a short, original encounter for this room: a strange person, creature, object or situation. ` +
            'Not a straight fight (though one may break out). Fit the floor\'s theme. Surprise the player.\n' +
            '- title: 2 to 4 words.\n- text: the scene, at most 30 words.\n' +
            '- icon: the picture that fits best.\n' +
            '- choices: 2 or 3 things the hero could do. label is 1 to 3 words (spoken aloud to pick it). ' +
            'Each has an ability check, a dc (8 easy to 18 hard) and success/failure outcomes, each one sentence of at most 20 words. ' +
            'Success should be good for the hero; failure neutral or bad. Riskier choices pay better.\n' +
            `Effects:\n${help}`,
        },
      ],
      {
        format: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            text: { type: 'string' },
            icon: { type: 'string', enum: EVENT_ICONS },
            choices: { type: 'array', items: choice, minItems: 2, maxItems: 3 },
          },
          required: ['title', 'text', 'icon', 'choices'],
        },
        maxTokens: 600,
        temperature: 0.95,
        timeout: INVENT_MS,
      },
    )
    if (!raw) return null
    try {
      const j = JSON.parse(raw) as EventDef
      const fix = (o: Outcome): Outcome => ({ effect: effects.includes(o?.effect) ? o.effect : 'none', text: tidy(o?.text ?? '') })
      const choices = (Array.isArray(j.choices) ? j.choices : [])
        .slice(0, 3)
        .map(c => ({
          label: tidy(String(c.label ?? '')).replace(/[.!]$/, '').split(/\s+/).slice(0, 3).join(' '),
          ability: (ABILITIES.includes(c.ability) && c.ability !== 'none' ? c.ability : 'wis') as Ability,
          dc: Math.max(8, Math.min(18, Math.round(Number(c.dc) || 12))),
          success: fix(c.success),
          failure: fix(c.failure),
        }))
        .filter(c => c.label && !/^leave$/i.test(c.label))
      if (choices.length < 2 || !j.title || !j.text) return null
      return {
        title: tidy(j.title).split(/\s+/).slice(0, 5).join(' ').replace(/[.!]$/, ''),
        text: tidy(j.text),
        icon: EVENT_ICONS.includes(j.icon) ? j.icon : 'scroll-unfurled',
        choices,
      }
    } catch {
      return null
    }
  }
}

/** Strips what a small model likes to add: quotes, markdown, stage directions. */
function tidy(text: string): string {
  let t = text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/[*_#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // Strip quotes only when they wrap the whole reply. Stripping a trailing
  // quote on its own ate the closing quote of dialogue: 'Gold only. -> 'Gold only.
  const wrapped = /^["'“](.*)["'”]$/.exec(t)
  if (wrapped && !/["“”]/.test(wrapped[1])) t = wrapped[1].trim()
  return t
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}
