// Speech-to-text through the Ollama-on-G2 bridge (Whisper on the PC).
//
// Adapted from that app's client. The G2 mic emits PCM s16le @ 16 kHz mono,
// which is exactly what Whisper wants, so chunks are forwarded verbatim.
//
//   WebSocket  audio streams while you talk; the bridge's voice detector
//              decides you've finished (~1s of silence) and sends the text.
//   HTTP POST  fallback: the buffer is re-posted as partials, and the reply
//              says when speech has ended. Slower, but always allowed.
//
// A listen with no speech at all gives up after MAX_LISTEN_MS, so hands-free
// mode can't leave the mic open forever.

export type SttState = 'idle' | 'connecting' | 'listening' | 'transcribing' | 'error'

export interface SttEvents {
  onState(state: SttState, detail?: string): void
  onPartial(text: string): void
  onTranscript(text: string): void
}

const SAMPLE_RATE = 16000
const WS_CONNECT_TIMEOUT_MS = 2500
const PARTIAL_INTERVAL_MS = 600
const MAX_LISTEN_MS = 12_000

/** What the app needs from any speech-to-text: the Delve server, or a cloud API. */
export interface SpeechClient {
  readonly listening: boolean
  connect(): Promise<void>
  start(): void
  stop(): void
  cancel(): void
  sendPcm(chunk: Uint8Array): void
  close(): void
}

export class SttClient implements SpeechClient {
  private ws: WebSocket | null = null
  private chunks: Uint8Array[] = []
  private capturing = false
  private partialTimer: ReturnType<typeof setInterval> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private partialInFlight = false
  private wsBlocked = false
  private heardSomething = false
  transport: 'websocket' | 'http' = 'http'

  constructor(private base: () => string, private events: SttEvents) {}

  get listening(): boolean {
    return this.capturing
  }

  /** Tries the socket, falls back to HTTP. Never rejects. */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return
    if (this.wsBlocked) {
      this.transport = 'http'
      return
    }
    this.events.onState('connecting')
    try {
      await this.openSocket()
      this.transport = 'websocket'
    } catch {
      this.ws = null
      this.wsBlocked = true
      this.transport = 'http'
    }
    this.events.onState('idle')
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let ws: WebSocket
      try {
        ws = new WebSocket(`${this.base().replace(/^http/, 'ws')}/stt`)
      } catch {
        reject(new Error('WebSocket unavailable'))
        return
      }
      ws.binaryType = 'arraybuffer'
      // A blocked socket can hang without firing onerror, so bound the wait.
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          ws.close()
        } catch {
          /* already dead */
        }
        reject(new Error('WebSocket timed out'))
      }, WS_CONNECT_TIMEOUT_MS)
      ws.onopen = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.ws = ws
        resolve()
      }
      ws.onerror = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error('WebSocket failed'))
      }
      ws.onclose = () => {
        this.ws = null
      }
      ws.onmessage = event => {
        if (typeof event.data !== 'string') return
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case 'auto_stop':
          case 'waiting':
            this.endCapture()
            break
          case 'listening':
            this.events.onState('listening')
            break
          case 'transcribing':
            this.events.onState('transcribing')
            break
          case 'partial':
            if (this.capturing && msg.text) {
              this.heardSomething = true
              this.events.onPartial(msg.text)
            }
            break
          case 'final':
            this.endCapture()
            this.events.onState('idle')
            this.events.onTranscript(msg.text ?? '')
            break
          case 'error':
            this.endCapture()
            this.events.onState('error', msg.error)
            break
        }
      }
    })
  }

  /** Starts listening; the bridge stops by itself when you go quiet. */
  start(): void {
    this.capturing = true
    this.heardSomething = false
    this.chunks = []
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = setTimeout(() => {
      if (!this.capturing) return
      if (this.heardSomething) return this.stop()
      // Nobody spoke: report an empty transcript so the caller closes the mic.
      this.cancel()
      this.events.onTranscript('')
    }, MAX_LISTEN_MS)
    if (this.transport === 'websocket' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'start', auto_stop: true }))
      return
    }
    this.events.onState('listening')
    this.stopPartials()
    this.partialTimer = setInterval(() => void this.sendPartial(), PARTIAL_INTERVAL_MS)
  }

  /** Stop now and transcribe what was said. */
  stop(): void {
    if (!this.capturing) return
    this.endCapture()
    if (this.transport === 'websocket' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }))
      return
    }
    void this.postBuffered()
  }

  /** Stop and throw the audio away. */
  cancel(): void {
    const was = this.capturing
    this.endCapture()
    this.chunks = []
    if (was && this.transport === 'websocket' && this.ws?.readyState === WebSocket.OPEN) {
      // The bridge still decodes and answers; the controller ignores it.
      this.ws.send(JSON.stringify({ type: 'stop' }))
    }
    this.events.onState('idle')
  }

  private endCapture() {
    this.capturing = false
    this.stopPartials()
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = null
  }

  private stopPartials(): void {
    if (this.partialTimer) clearInterval(this.partialTimer)
    this.partialTimer = null
  }

  /** Forwards one mic chunk: straight out on a socket, buffered otherwise. */
  sendPcm(chunk: Uint8Array): void {
    if (!this.capturing) return
    if (this.transport === 'websocket' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
      return
    }
    // Copy: the SDK may reuse the underlying buffer for the next frame.
    this.chunks.push(new Uint8Array(chunk))
  }

  private joinChunks(): Uint8Array<ArrayBuffer> {
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const body = new Uint8Array(new ArrayBuffer(total))
    let offset = 0
    for (const c of this.chunks) {
      body.set(c, offset)
      offset += c.length
    }
    return body
  }

  private async sendPartial(): Promise<void> {
    if (!this.capturing || this.partialInFlight || !this.chunks.length) return
    this.partialInFlight = true
    try {
      const reply = await this.postPcm(this.joinChunks(), true)
      if (!this.capturing) return
      if (reply.text) {
        this.heardSomething = true
        this.events.onPartial(reply.text)
      }
      if (reply.ended) this.stop()
    } catch {
      /* partials are cosmetic */
    } finally {
      this.partialInFlight = false
    }
  }

  private async postPcm(body: Uint8Array<ArrayBuffer>, partial: boolean): Promise<{ text: string; ended?: boolean }> {
    const res = await fetch(`${this.base()}/api/stt${partial ? '?partial=1&auto=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    })
    if (!res.ok) throw new Error(`Bridge HTTP ${res.status}`)
    const j = await res.json()
    return { text: j.text ?? '', ended: j.ended }
  }

  private async postBuffered(): Promise<void> {
    const body = this.joinChunks()
    this.chunks = []
    if (body.length < SAMPLE_RATE / 5) {
      this.events.onState('idle')
      this.events.onTranscript('')
      return
    }
    this.events.onState('transcribing')
    try {
      const { text } = await this.postPcm(body, false)
      this.events.onState('idle')
      this.events.onTranscript(text)
    } catch (err) {
      this.events.onState('error', err instanceof Error ? err.message : String(err))
    }
  }

  close(): void {
    this.endCapture()
    this.chunks = []
    this.ws?.close()
    this.ws = null
  }
}
