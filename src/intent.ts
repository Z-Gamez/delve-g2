// Turns what the player said into one of the options on screen.
//
// Whisper is good but fantasy words come out mangled ("firebolt", "fire
// ball", "hunters mark", "rouge"), so phrases are matched fuzzily token by
// token, and joined ("fire bolt" == "firebolt"). Anything that doesn't match
// well -- or matches, but clearly means something else ("throw my potion at
// him" is not "drink potion") -- is handed to the AI Dungeon Master instead.

import type { Option } from './engine/game.ts'

const NUMBER_WORDS: Record<string, number> = {
  one: 1, won: 1, first: 1, two: 2, to: 2, too: 2, second: 2, three: 3, third: 3, four: 4, for: 4, fourth: 4,
  five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10,
}

const STOP = new Set([
  'i', 'the', 'a', 'an', 'to', 'at', 'on', 'my', 'me', 'with', 'and', 'please', 'lets', 'let', 'us', 'try', 'want',
  'will', 'would', 'like', 'go', 'then', 'it', 'that', 'this', 'of', 'in', 'for', 'just', 'now', 'um', 'uh', 'okay',
  'ok', 'so', 'do', 'use', 'cast', 'some', 'again', 'im', 'ill', 'id', 'can', 'you', 'we', 'our', 'your', 'its', 'is',
  'yeah', 'yes', 'well', 'hmm', 'oh', 'him', 'her', 'them', 'his', 'their', 'into', 'up', 'out', 'from', 'one',
  'first', 'second', 'third', 'two', 'three', 'four', 'fourth',
])

/**
 * Verbs that signal "I'm improvising". If one of these is in the sentence and
 * no option mentions it, the sentence goes to the DM even if some other word
 * happened to match an option.
 */
const IMPROV = new Set([
  'throw', 'toss', 'kick', 'push', 'shove', 'climb', 'talk', 'ask', 'tell', 'say', 'seduce', 'bribe', 'intimidate',
  'threaten', 'grab', 'pull', 'examine', 'inspect', 'listen', 'shout', 'yell', 'sing', 'play', 'pour', 'light',
  'burn', 'set', 'trick', 'lie', 'distract', 'taunt', 'insult', 'offer', 'give', 'steal', 'swing', 'hide', 'jump',
  'look', 'search', 'read', 'eat', 'lick', 'touch', 'open', 'break', 'dance', 'pray', 'beg', 'surrender', 'negotiate',
  'befriend', 'pet', 'tame', 'feed', 'poke', 'trip', 'blind', 'disarm', 'tackle', 'wrestle', 'bite', 'climb',
])

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function lev(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/** 1 for identical, 0 for nothing in common. Short words must match exactly. */
function sim(a: string, b: string): number {
  if (a === b) return 1
  const n = Math.max(a.length, b.length)
  if (Math.min(a.length, b.length) <= 3) return 0
  // Plural / verb forms: "missiles" ~ "missile", "attacks" ~ "attack".
  if ((a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 2) return 0.92
  return 1 - lev(a, b) / n
}

const FUZZ = 0.76

interface PhraseHit {
  score: number
  /** Indexes of the spoken tokens this phrase accounted for. */
  used: number[]
}

function matchPhrase(phrase: string, spoken: string[]): PhraseHit | null {
  const pt = tokens(phrase)
  if (!pt.length) return null
  const joined = pt.join('')

  // Exact run of tokens.
  for (let i = 0; i + pt.length <= spoken.length; i++) {
    if (pt.every((t, k) => spoken[i + k] === t)) {
      return { score: joined.length + 2, used: pt.map((_, k) => i + k) }
    }
  }
  // Joined forms: "firebolt" for "fire bolt", or "fire ball" for "fireball".
  for (let i = 0; i < spoken.length; i++) {
    const one = spoken[i]
    const two = i + 1 < spoken.length ? one + spoken[i + 1] : ''
    const s1 = sim(joined, one)
    const s2 = two ? sim(joined, two) : 0
    if (Math.max(s1, s2) >= FUZZ && joined.length >= 4) {
      const best = Math.max(s1, s2)
      return { score: joined.length * best + (best === 1 ? 1.5 : 0), used: s2 > s1 ? [i, i + 1] : [i] }
    }
  }
  // Token by token, in any order.
  const used: number[] = []
  let total = 0
  for (const t of pt) {
    let best = 0
    let at = -1
    spoken.forEach((s, i) => {
      if (used.includes(i)) return
      const v = sim(t, s)
      if (v > best) {
        best = v
        at = i
      }
    })
    if (best < FUZZ) return null
    used.push(at)
    total += best * t.length
  }
  return { score: total, used }
}

export interface IntentMatch {
  option: Option
  score: number
  /** 'low' means "probably meant something else"; prefer the DM if there is one. */
  confidence: 'high' | 'low'
}

/**
 * @param known words that shouldn't count against coverage (enemy names, etc).
 */
export function matchIntent(text: string, options: Option[], known: string[] = []): IntentMatch | null {
  const spoken = tokens(text)
  if (!spoken.length || !options.length) return null
  const visible = options.filter(o => !o.hidden)

  // "two", "number two", "option 2", "the third one".
  const content = spoken.filter(t => !['number', 'option', 'choice', 'choose', 'pick', 'select', 'the', 'one', 'please'].includes(t) || spoken.length === 1)
  if (content.length === 1) {
    const n = NUMBER_WORDS[content[0]] ?? (/^\d+$/.test(content[0]) ? Number(content[0]) : 0)
    if (n >= 1 && n <= visible.length && (spoken.length <= 3)) return { option: visible[n - 1], score: 99, confidence: 'high' }
  }
  const numbered = /\b(?:number|option|choice)\s+(\w+)/.exec(spoken.join(' '))
  if (numbered) {
    const n = NUMBER_WORDS[numbered[1]] ?? Number(numbered[1])
    if (n >= 1 && n <= visible.length) return { option: visible[n - 1], score: 99, confidence: 'high' }
  }

  let best: { option: Option; hit: PhraseHit } | null = null
  for (const option of options) {
    const phrases = [...option.words, option.label.replace(/[×x]\d+$|\d+g$/g, '').trim()]
    for (const p of phrases) {
      const hit = matchPhrase(p, spoken)
      if (hit && (!best || hit.score > best.hit.score)) best = { option, hit }
    }
  }
  if (!best || best.hit.score < 3) return null

  // Coverage: how much of what they said did the option explain?
  const knownSet = new Set(known.flatMap(k => tokens(k)))
  const allOptionWords = new Set(options.flatMap(o => o.words.flatMap(w => tokens(w))))
  const contentIdx = spoken.map((t, i) => ({ t, i })).filter(x => !STOP.has(x.t) && !knownSet.has(x.t))
  const covered = contentIdx.filter(x => best!.hit.used.includes(x.i)).length
  const coverage = contentIdx.length ? covered / contentIdx.length : 1
  const improv = spoken.some((t, i) => IMPROV.has(t) && !best!.hit.used.includes(i) && !allOptionWords.has(t))
  const low = improv || (contentIdx.length >= 4 && coverage < 0.34)
  return { option: best.option, score: best.hit.score, confidence: low ? 'low' : 'high' }
}

export type Command = 'inventory' | 'sheet' | 'help' | 'repeat' | 'handsfree-on' | 'handsfree-off' | 'back' | 'menu'

const COMMANDS: [RegExp, Command][] = [
  [/^(open |check |show |look at |see )?(my )?(inventory|backpack|bag|gear|equipment)( please)?$|^what (do i have|am i carrying)/, 'inventory'],
  [/^(open |check |show )?(my )?(character( sheet)?|sheet|stats|status|skills|abilities)( please)?$|^how am i doing|^how much (health|hp)|^(what is |whats )?my (health|hp)/, 'sheet'],
  [/^(help|what can i (do|say)|commands|how do i play|instructions)$/, 'help'],
  [/^(repeat( that)?|say (that )?again|what was that|read (that|it) again|come again|pardon)$/, 'repeat'],
  [/^(hands ?free|always listen|keep listening)( on| mode)?$|^(turn on|enable) hands ?free/, 'handsfree-on'],
  [/^(stop listening|hands ?free off|turn off hands ?free|disable hands ?free|tap mode)$/, 'handsfree-off'],
  [/^(back|go back|close|done|never mind|nevermind)$/, 'back'],
  [/^((open |go to |back to |show )?(the )?(main )?menu|pause|pause (the )?game|take a break)( please)?$/, 'menu'],
]

export function matchCommand(text: string): Command | null {
  const t = tokens(text).join(' ')
  for (const [re, cmd] of COMMANDS) if (re.test(t)) return cmd
  return null
}
