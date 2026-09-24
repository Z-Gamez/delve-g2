// Knowing when the player has finished talking, on the phone, for cloud speech.
//
// The Delve server does this with a neural voice detector (Silero). Cloud
// speech has no server in the loop, so this is an energy detector -- but not
// a naive one. On a real G2 the room sat at RMS ~1000 (fan, TV) while speech
// peaked at 10-18k, and a detector whose noise floor only learned from
// "quiet" frames locked itself into "speaking" for minutes. Here the floor is
// a low percentile of *all* recent levels, so it follows a noisy room up
// within seconds, and speech has to stand well clear of it. A tap always
// sends immediately, so a miss costs a tap, not a stuck mic.

const SAMPLE_RATE = 16000
const FRAME_BYTES = (SAMPLE_RATE / 10) * 2 // 100 ms of s16le mono
const FRAME_MS = 100

export type Verdict = 'continue' | 'ended' | 'no_speech'

export interface EndpointOptions {
  /** Quiet after speech that ends the utterance. */
  endSilenceMs?: number
  /** Give up if nobody speaks for this long. */
  noSpeechMs?: number
  /** Hard cap on one utterance. */
  maxMs?: number
}

export class Endpointer {
  hadSpeech = false
  private levels: number[] = []
  private leftover = new Uint8Array(0)
  private speechMs = 0
  private quietMs = 0
  private totalMs = 0
  private readonly endSilenceMs: number
  private readonly noSpeechMs: number
  private readonly maxMs: number
  /** RMS of the most recent frame, for a level meter. */
  lastRms = 0

  constructor(o: EndpointOptions = {}) {
    this.endSilenceMs = o.endSilenceMs ?? 1000
    this.noSpeechMs = o.noSpeechMs ?? 8000
    this.maxMs = o.maxMs ?? 30000
  }

  get seconds(): number {
    return this.totalMs / 1000
  }

  /** Feeds mic audio (any chunk size); returns what to do now. */
  feed(pcm: Uint8Array): Verdict {
    const data = new Uint8Array(this.leftover.length + pcm.length)
    data.set(this.leftover)
    data.set(pcm, this.leftover.length)
    let offset = 0
    let verdict: Verdict = 'continue'
    while (data.length - offset >= FRAME_BYTES && verdict === 'continue') {
      verdict = this.frame(data.subarray(offset, offset + FRAME_BYTES))
      offset += FRAME_BYTES
    }
    this.leftover = data.slice(offset)
    return verdict
  }

  private frame(bytes: Uint8Array): Verdict {
    const rms = frameRms(bytes)
    this.lastRms = rms
    this.totalMs += FRAME_MS
    this.levels.push(rms)
    if (this.levels.length > 50) this.levels.shift() // the last 5 s

    const floor = Math.max(120, percentile(this.levels, 0.15))
    const loud = rms > Math.max(floor * 3, 900)
    const quiet = rms < Math.max(floor * 2, 700)

    if (loud) {
      this.speechMs += FRAME_MS
      this.quietMs = 0
      // A quarter second of clear speech, so a cough or a door doesn't count.
      if (this.speechMs >= 250) this.hadSpeech = true
    } else if (quiet) {
      this.speechMs = 0
      if (this.hadSpeech) this.quietMs += FRAME_MS
    }
    // In between (a trailing syllable): neither starts nor ends anything.

    if (this.totalMs >= this.maxMs) return 'ended'
    if (this.hadSpeech && this.quietMs >= this.endSilenceMs) return 'ended'
    if (!this.hadSpeech && this.totalMs >= this.noSpeechMs) return 'no_speech'
    return 'continue'
  }
}

function frameRms(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = Math.floor(bytes.byteLength / 2)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true)
    sum += v * v
  }
  return n ? Math.sqrt(sum / n) : 0
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

/** 0..1 on a log scale: the G2 mic idles near 200 and peaks near 16000. */
export function levelOf(rms: number): number {
  return Math.max(0, Math.min(1, (Math.log10(Math.max(rms, 1)) - 2.4) / 1.8))
}

/** Wraps raw PCM s16le 16 kHz mono in a WAV header, for upload. */
export function wav(pcm: Uint8Array, rate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(44 + pcm.length))
  const v = new DataView(out.buffer)
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // PCM chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}

export function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
