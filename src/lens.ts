// Layout and text fitting for the 576x288 lens.
//
//   F3 · The Ruined Temple          ♥ 18/24  34g
//  ┌────────┐ ╭──────────────────────────────────╮
//  │portrait│ │ You slash the Goblin for 9. It    │
//  │ 136px  │ │ falls. The Orc hits you for 6.    │
//  └────────┘ │ Orc 9/15                          │
//   Orc       │                                   │
//   ━━━━━──   │ 1 Attack  ▶Fire Bolt  3 Missile×4 │
//             ╰──────────────────────────────────╯
//   ● Listening… "cast fire bo"
//
// All glyphs were checked against the G2 font with pretext's getAdvW: ♥ ◆ ▶
// ● ◐ ━ ─ × † · — exist; ⚔ ☠ ✦ and emoji do not, and lensSafe() drops any
// that slip through rather than letting the firmware draw tofu.

import { getAdvW, getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext'

export const LENS_W = 576
export const LINE_H = 27

// Header and footer need one 27px line plus padding, or the firmware draws a
// scrollbar beside them. Images are capped at 288x144 by the firmware.
export const HEADER = { id: 1, name: 'hdr', x: 0, y: 0, w: LENS_W, h: 35, pad: 4, brightness: 2 }
export const BODY = { id: 2, name: 'body', x: 146, y: 37, w: LENS_W - 146, h: 214, pad: 7, border: 1, radius: 8, brightness: 4 }
export const FOOTER = { id: 3, name: 'ftr', x: 0, y: 253, w: LENS_W, h: 35, pad: 4, brightness: 2 }
export const CAPTION = { id: 5, name: 'cap', x: 0, y: 180, w: 144, h: 70, pad: 4, brightness: 3 }
export const ART = { id: 4, name: 'art', x: 4, y: 40, w: 136, h: 136 }

// The game layout: a three-line story strip, then the options as a native
// list. The firmware draws the hovered item as a rounded pill and moves it on
// swipe by itself (no round trip per move), and reports the index on tap.
// Rows are ~40px apart, so 122px shows three pills with a fourth peeking to
// say "there's more".
export const STORY = { id: 2, name: 'story', x: 146, y: 37, w: LENS_W - 146, h: 92, pad: 4, brightness: 4 }
export const LIST = { id: 6, name: 'opts', x: 146, y: 129, w: LENS_W - 146, h: 122, pad: 2 }
export const STORY_INNER_W = STORY.w - 2 * STORY.pad
export const STORY_ROWS = Math.floor((STORY.h - 2 * STORY.pad) / LINE_H) // 3
/** Width a pill's text may take: the list's inner width less the pill's own padding. */
const PILL_TEXT_W = LIST.w - 2 * LIST.pad - 28

export const BODY_INNER = {
  width: BODY.w - 2 * (BODY.pad + BODY.border),
  height: BODY.h - 2 * (BODY.pad + BODY.border),
}
export const BODY_ROWS = Math.floor(BODY_INNER.height / LINE_H) // 7
const HEADER_INNER_W = HEADER.w - 2 * HEADER.pad - 8
const FOOTER_INNER_W = FOOTER.w - 2 * FOOTER.pad - 8
const CAPTION_INNER_W = CAPTION.w - 2 * CAPTION.pad - 4
const SPACE_W = Math.max(1, getTextWidth(' '))

const w = (s: string) => getTextWidth(s)
const spaces = (px: number) => ' '.repeat(Math.max(1, Math.floor(px / SPACE_W)))

/** Left text, then right text pushed to the far edge. */
export function spread(left: string, right: string, width = HEADER_INNER_W): string {
  if (!right) return pxTruncate(left, width)
  const room = width - w(right) - SPACE_W * 2
  const l = pxTruncate(left, Math.max(0, room))
  return l + spaces(width - w(l) - w(right) - SPACE_W) + right
}

export function footerLine(text: string): string {
  return pxTruncate(text, FOOTER_INNER_W)
}

/** Drops glyphs the G2 font doesn't have (or swaps in the unaccented letter). */
export function lensSafe(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp === 10 || getAdvW(cp) > 0) {
      out += ch
      continue
    }
    const base = ch.normalize('NFD').replace(/\p{Mn}/gu, '')
    if (base && base !== ch && [...base].every(c => getAdvW(c.codePointAt(0)!) > 0)) out += base
  }
  return out
}

export function lines(text: string, width = BODY_INNER.width): number {
  if (!text) return 0
  return text.split('\n').reduce((n, para) => n + Math.max(1, measureTextWrap(para, width).lineCount), 0)
}

/** Cuts text to at most `max` wrapped lines, ending in an ellipsis. */
export function clampLines(text: string, max: number, width = BODY_INNER.width): string {
  if (max <= 0) return ''
  if (lines(text, width) <= max) return text
  const words = text.split(' ')
  let lo = 0
  let hi = words.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (lines(`${words.slice(0, mid).join(' ')}…`, width) <= max) lo = mid
    else hi = mid - 1
  }
  return `${words.slice(0, lo).join(' ')}…`
}

/** Keeps the end of the text (the newest events) when it doesn't all fit. */
export function clampLinesFromStart(text: string, max: number, width = BODY_INNER.width): string {
  if (max <= 0) return ''
  if (lines(text, width) <= max) return text
  const words = text.split(' ')
  let lo = 0
  let hi = words.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (lines(`…${words.slice(mid).join(' ')}`, width) <= max) hi = mid
    else lo = mid + 1
  }
  return `…${words.slice(lo).join(' ')}`
}

export interface OptionItem {
  label: string
}

/**
 * The option row: "1 Attack   2 Fire Bolt   ▶Missile ×4". Numbers are there so
 * a player can just say "two". Labels never break across lines.
 */
export function optionRows(options: OptionItem[], highlight: number | null, width = BODY_INNER.width): string {
  const gap = '   '
  const rows: string[] = []
  let row = ''
  options.forEach((o, i) => {
    // Rows are packed to fit, so the firmware never has to wrap inside a label.
    const cell = `${highlight === i ? '▶' : `${i + 1} `}${o.label}`
    const candidate = row ? `${row}${gap}${cell}` : cell
    if (row && w(candidate) > width - 4) {
      rows.push(row)
      row = cell
    } else row = candidate
  })
  if (row) rows.push(row)
  return rows.join('\n')
}

/** A health bar in caption width: ━ for health, ─ for what's gone. */
export function hpBar(hp: number, max: number, width = CAPTION_INNER_W): string {
  const full = w('━')
  const cells = Math.max(4, Math.floor(width / Math.max(1, full)) - 1)
  const on = max > 0 ? Math.max(hp > 0 ? 1 : 0, Math.round((hp / max) * cells)) : 0
  return '━'.repeat(on) + '─'.repeat(cells - on)
}

export function captionText(caption: string, bar: { hp: number; max: number } | null): string {
  const name = pxTruncate(caption, CAPTION_INNER_W)
  if (!bar) return name
  const nums = `${Math.max(0, bar.hp)}/${bar.max} `
  return `${name}\n${nums}${hpBar(bar.hp, bar.max, CAPTION_INNER_W - w(nums))}`
}

/**
 * The body: what happened, what now, and the options -- fitted to 7 lines.
 * Options win, then the prompt, then as much of the story as fits (newest
 * part kept).
 */
export function fitBody(story: string, prompt: string, options: string, keep: 'start' | 'end' = 'end'): string {
  const optLines = lines(options)
  const room = BODY_ROWS - optLines - (options ? 1 : 0)
  const promptText = clampLines(prompt, Math.max(1, room - (story ? 1 : 0)))
  const storyRoom = room - lines(promptText)
  const storyText = story && storyRoom > 0 ? fitSentences(story, storyRoom, keep) : ''
  const top = [storyText, promptText].filter(Boolean).join('\n')
  return options ? `${top}\n\n${options}` : top
}

/**
 * Fits whole sentences where possible. 'end' keeps the newest events (the
 * engine's log); 'start' keeps the opening of a narration, which is where a
 * model puts the action. Only a lone sentence too long for the room is cut.
 */
export function fitSentences(text: string, max: number, keep: 'start' | 'end'): string {
  if (lines(text) <= max) return text
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) ?? [text]
  const order = keep === 'start' ? sentences : [...sentences].reverse()
  const kept: string[] = []
  for (const s of order) {
    const next = keep === 'start' ? [...kept, s] : [s, ...kept]
    if (lines(next.join(' ')) > max) break
    kept.splice(0, kept.length, ...next)
  }
  if (kept.length) return kept.join(' ')
  return keep === 'start' ? clampLines(text, max) : clampLinesFromStart(text, max)
}

/** The story strip: the prompt always shows; the story gets what's left. */
export function fitStory(story: string, prompt: string, keep: 'start' | 'end'): string {
  const w = STORY_INNER_W
  const promptText = prompt ? clampLines(prompt, story ? 1 : STORY_ROWS, w) : ''
  const room = STORY_ROWS - lines(promptText, w)
  const storyText = story && room > 0 ? fitSentencesIn(story, room, keep, w) : ''
  return [storyText, promptText].filter(Boolean).join('\n')
}

function fitSentencesIn(text: string, max: number, keep: 'start' | 'end', width: number): string {
  if (lines(text, width) <= max) return text
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) ?? [text]
  const order = keep === 'start' ? sentences : [...sentences].reverse()
  let kept: string[] = []
  for (const s of order) {
    const next = keep === 'start' ? [...kept, s] : [s, ...kept]
    if (lines(next.join(' '), width) > max) break
    kept = next
  }
  if (kept.length) return kept.join(' ')
  return keep === 'start' ? clampLines(text, max, width) : clampLinesFromStart(text, max, width)
}

/** One pill: the label, then its detail if there's room. */
export function pillText(label: string, detail?: string): string {
  const full = detail ? `${label} · ${detail}` : label
  if (w(full) <= PILL_TEXT_W) return full
  if (detail && w(label) + w(' · ') + w('abc…') < PILL_TEXT_W) return pxTruncate(full, PILL_TEXT_W)
  return pxTruncate(label, PILL_TEXT_W)
}

/** Splits a long page (character sheet, inventory, help) into lens pages. */
export function paginate(source: string, maxLines = BODY_ROWS - 1): string[] {
  const paras = source.split(/\n+/).map(p => p.trim()).filter(Boolean)
  const pages: string[] = []
  let buf: string[] = []
  let used = 0
  for (const p of paras) {
    let para = p
    let n = lines(para)
    while (n > maxLines) {
      // A paragraph longer than a page: split it by words.
      const head = clampLines(para, maxLines - used || maxLines).replace(/…$/, '')
      if (buf.length && used) {
        pages.push(buf.join('\n'))
        buf = []
        used = 0
        continue
      }
      pages.push(head)
      para = para.slice(head.length).trim()
      n = lines(para)
    }
    if (!para) continue
    if (used + n > maxLines) {
      pages.push(buf.join('\n'))
      buf = []
      used = 0
    }
    buf.push(para)
    used += n
  }
  if (buf.length) pages.push(buf.join('\n'))
  return pages.length ? pages : ['']
}

export function pageDots(index: number, total: number): string {
  if (total <= 1) return ''
  if (total > 8) return `${index + 1}/${total}`
  return Array.from({ length: total }, (_, i) => (i === index ? '●' : '○')).join(' ')
}
