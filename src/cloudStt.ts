// Speech-to-text in the cloud, for players without the Delve server.
//
//   OpenAI      /v1/audio/transcriptions with a transcription model (the
//               gpt-4o transcribe family, or whisper-1), primed with the
//               words on screen so "Fire Bolt" doesn't come back "fire bowl".
//   OpenRouter  an audio-capable chat model (Gemini Flash by default) asked
//               to transcribe exactly.
//
// Claude isn't offered: it has no speech-to-text and doesn't take audio.
//
// There's no server to stream to, so audio is buffered on the phone, the
// Endpointer decides when the player has stopped, and the whole utterance is
// uploaded as a WAV. No partial transcripts; the footer shows a level meter
// instead. Uses the same whitelisted API origins as the Dungeon Master.

import { OPENAI, OPENROUTER } from './llm.ts'
import { Endpointer, wav, base64, levelOf } from './endpoint.ts'
import type { SpeechClient, SttEvents } from './stt.ts'

export type CloudSpeechProvider = 'openai' | 'openrouter'

export interface CloudSpeechConfig {
  provider: CloudSpeechProvider
  key: string
  model: string
}

const TIMEOUT_MS = 20_000
const LEVEL_EVERY_MS = 250
/** A tap-to-send shorter than this is a mis-tap, not a sentence. */
const MIN_SECONDS = 0.4

/** First match wins when the player hasn't picked a model. */
const PREFERRED: Record<CloudSpeechProvider, RegExp[]> = {
  openai: [/^gpt-4o-mini-transcribe$/, /mini-transcribe/, /transcribe/, /^whisper-1$/, /whisper/],
  openrouter: [/^~google\/gemini-flash-latest$/, /^google\/gemini-[\d.]+-flash-lite$/, /^google\/gemini-[\d.]+-flash$/, /voxtral/],
}

export interface CloudSttEvents extends SttEvents {
  /** Mic loudness 0..1, a few times a second while listening. */
  onLevel?(level: number): void
}

export class CloudStt implements SpeechClient {
  private chunks: Uint8Array[] = []
  private capturing = false
  private endpointer = new Endpointer()
  private abort: AbortController | null = null
  private lastLevelAt = 0
  transport = 'cloud' as const
  private cfg: () => CloudSpeechConfig
  /** Words likely to be said right now (the options on screen), to prime the model. */
  private hints: () => string[]
  private events: CloudSttEvents

  constructor(cfg: () => CloudSpeechConfig, hints: () => string[], events: CloudSttEvents) {
    this.cfg = cfg
    this.hints = hints
    this.events = events
  }

  get listening(): boolean {
    return this.capturing
  }

  async connect(): Promise<void> {
    /* nothing to open: each utterance is one HTTPS request */
  }

  start(): void {
    this.abort?.abort()
    this.chunks = []
    this.endpointer = new Endpointer()
    this.capturing = true
    this.events.onState('listening')
  }

  sendPcm(chunk: Uint8Array): void {
    if (!this.capturing) return
    // Copy: the SDK may reuse the underlying buffer for the next frame.
    this.chunks.push(new Uint8Array(chunk))
    const verdict = this.endpointer.feed(chunk)
    const now = Date.now()
    if (this.events.onLevel && now - this.lastLevelAt >= LEVEL_EVERY_MS) {
      this.lastLevelAt = now
      this.events.onLevel(levelOf(this.endpointer.lastRms))
    }
    if (verdict === 'ended') this.stop()
    else if (verdict === 'no_speech') {
      this.cancel()
      this.events.onTranscript('')
    }
  }

  /** Stop now and transcribe what was said. */
  stop(): void {
    if (!this.capturing) return
    this.capturing = false
    void this.transcribe()
  }

  cancel(): void {
    this.capturing = false
    this.chunks = []
    this.abort?.abort()
    this.abort = null
    this.events.onState('idle')
  }

  close(): void {
    this.cancel()
  }

  private async transcribe(): Promise<void> {
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const pcm = new Uint8Array(total)
    let at = 0
    for (const c of this.chunks) {
      pcm.set(c, at)
      at += c.length
    }
    this.chunks = []
    if (total / 2 / 16000 < MIN_SECONDS) {
      this.events.onState('idle')
      this.events.onTranscript('')
      return
    }
    this.events.onState('transcribing')
    const abort = new AbortController()
    this.abort = abort
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
    try {
      const text = await transcribe(this.cfg(), wav(pcm), this.hints(), abort.signal)
      if (abort.signal.aborted) return
      this.events.onState('idle')
      this.events.onTranscript(text)
    } catch (err) {
      if (abort.signal.aborted && this.abort !== abort) return // cancelled on purpose
      this.events.onState('error', err instanceof Error ? err.message : String(err))
    } finally {
      clearTimeout(timer)
      if (this.abort === abort) this.abort = null
    }
  }
}

/** One utterance (a WAV) to text. Throws on HTTP errors. */
export async function transcribe(cfg: CloudSpeechConfig, audio: Uint8Array<ArrayBuffer>, hints: string[], signal?: AbortSignal): Promise<string> {
  const model = cfg.model || (await defaultSpeechModel(cfg))
  if (!model) throw new Error('No speech model available on this key.')
  const vocab = [...new Set(hints.map(h => h.replace(/[×●·].*$/, '').trim()).filter(Boolean))].join(', ').slice(0, 300)

  if (cfg.provider === 'openai') {
    const form = new FormData()
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', model)
    form.append('language', 'en')
    form.append('response_format', 'json')
    form.append('prompt', `A player giving a command in a fantasy dungeon game.${vocab ? ` Words on screen: ${vocab}.` : ''}`)
    const res = await fetch(new URL('/v1/audio/transcriptions', OPENAI).href, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: form,
      signal,
    })
    if (!res.ok) throw new Error(res.status === 401 ? 'OpenAI rejected the API key.' : `OpenAI HTTP ${res.status}`)
    const j = (await res.json()) as { text?: string }
    return clean(j.text ?? '')
  }

  const res = await fetch(new URL('/api/v1/chat/completions', OPENROUTER).href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}`, 'X-Title': 'Delve' },
    body: JSON.stringify({
      model,
      max_completion_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Transcribe this spoken English exactly. It is a player giving a command in a fantasy dungeon game' +
                `${vocab ? `; these words may appear: ${vocab}` : ''}. ` +
                'Reply with only the words spoken: no quotes, no commentary. If there is no speech, reply with nothing.',
            },
            { type: 'input_audio', input_audio: { data: base64(audio), format: 'wav' } },
          ],
        },
      ],
    }),
    signal,
  })
  if (!res.ok) throw new Error(res.status === 401 ? 'OpenRouter rejected the API key.' : `OpenRouter HTTP ${res.status}`)
  const j = (await res.json()) as { choices?: { message?: { content?: string | null } }[] }
  return clean(j.choices?.[0]?.message?.content ?? '')
}

function clean(text: string): string {
  return text.replace(/^["'“\s]+|["'”\s]+$/g, '').replace(/\s+/g, ' ').trim()
}

/** Speech-capable models the key can use; also checks the key. Throws on a bad key. */
export async function listSpeechModels(cfg: Pick<CloudSpeechConfig, 'provider' | 'key'>): Promise<{ models: string[]; default: string }> {
  let models: string[]
  if (cfg.provider === 'openai') {
    const res = await fetch(new URL('/v1/models', OPENAI).href, { headers: { Authorization: `Bearer ${cfg.key}` } })
    if (!res.ok) throw new Error(res.status === 401 ? 'That API key was rejected.' : `HTTP ${res.status}`)
    const j = (await res.json()) as { data: { id: string }[] }
    models = j.data.map(m => m.id).filter(id => /transcribe|whisper/.test(id) && !/diarize|realtime/.test(id)).sort()
  } else {
    const keyRes = await fetch(new URL('/api/v1/key', OPENROUTER).href, { headers: { Authorization: `Bearer ${cfg.key}` } })
    if (!keyRes.ok) throw new Error(keyRes.status === 401 ? 'That API key was rejected.' : `HTTP ${keyRes.status}`)
    const res = await fetch(new URL('/api/v1/models', OPENROUTER).href)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as { data: { id: string; architecture?: { input_modalities?: string[] } }[] }
    models = j.data
      .filter(m => m.architecture?.input_modalities?.includes('audio') && !m.id.endsWith(':batch'))
      .map(m => m.id)
      .sort()
  }
  const preferred = PREFERRED[cfg.provider].map(re => models.find(m => re.test(m))).find(Boolean)
  return { models, default: preferred ?? models[0] ?? '' }
}

const defaults = new Map<string, string>()

async function defaultSpeechModel(cfg: CloudSpeechConfig): Promise<string> {
  const k = `${cfg.provider}|${cfg.key.slice(-6)}`
  const hit = defaults.get(k)
  if (hit) return hit
  const { default: model } = await listSpeechModels(cfg)
  if (model) defaults.set(k, model)
  return model
}
