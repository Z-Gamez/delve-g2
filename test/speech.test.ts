// Cloud speech: the on-phone end-of-speech detector, WAV encoding, and the
// OpenAI / OpenRouter request shapes (fetch stubbed; live calls need keys).
//
//   node --experimental-strip-types test/speech.test.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Endpointer, wav } from '../src/endpoint.ts'
import { transcribe } from '../src/cloudStt.ts'

const RATE = 16000

/** 100 ms frames of PCM: noise at a given RMS, optionally with a tone on top. */
function frames(ms: number, noiseRms: number, toneAmp = 0, seed = 1): Uint8Array {
  const n = Math.round((RATE * ms) / 1000)
  const out = new Uint8Array(n * 2)
  const v = new DataView(out.buffer)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const noise = ((s / 0x7fffffff) * 2 - 1) * noiseRms * 1.73 // uniform: RMS = amp/sqrt(3)
    const tone = toneAmp * Math.sin((2 * Math.PI * 220 * i) / RATE)
    v.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(noise + tone))), true)
  }
  return out
}

/** Feeds in 100 ms chunks like the G2 does; returns the verdict and when it came. */
function run(ep: Endpointer, pcm: Uint8Array): { verdict: string; atMs: number } {
  for (let o = 0, t = 100; o < pcm.length; o += 3200, t += 100) {
    const v = ep.feed(pcm.subarray(o, o + 3200))
    if (v !== 'continue') return { verdict: v, atMs: t }
  }
  return { verdict: 'continue', atMs: pcm.length / 32 }
}

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// --- end of speech ---
{
  // Quiet room, a sentence, then quiet: ends about a second after speech stops.
  const r = run(new Endpointer(), cat(frames(800, 250), frames(1500, 250, 9000), frames(2000, 250)))
  assert.equal(r.verdict, 'ended')
  assert.ok(r.atMs >= 3200 && r.atMs <= 3600, `ended at ${r.atMs}ms`)
}
{
  // The failure the real G2 hit: a loud steady room (TV at RMS ~1000-3000).
  // The floor must follow it up, so speech still starts AND still ends.
  const tv = 2500
  const r = run(new Endpointer(), cat(frames(2000, tv), frames(1500, tv, 14000), frames(2500, tv)))
  assert.equal(r.verdict, 'ended', 'a noisy room must not hold the mic open')
  assert.ok(r.atMs < 5500, `ended at ${r.atMs}ms`)
}
{
  // Nobody speaks: give up after the no-speech timeout.
  const r = run(new Endpointer({ noSpeechMs: 3000 }), frames(5000, 400))
  assert.equal(r.verdict, 'no_speech')
}
{
  // A cough (150 ms blip) is not speech.
  const ep = new Endpointer({ noSpeechMs: 3000 })
  const r = run(ep, cat(frames(1000, 300), frames(150, 300, 12000), frames(2500, 300)))
  assert.equal(r.verdict, 'no_speech')
  assert.equal(ep.hadSpeech, false)
}
{
  // Real speech: the TTS fixtures, over a G2-like noisy room.
  for (const name of ['bolt', 'kick', 'left']) {
    const clip = readFileSync(new URL(`./fixtures/${name}.wav`, import.meta.url)).subarray(44)
    const noisy = new Uint8Array(clip.length)
    const a = new DataView(clip.buffer, clip.byteOffset, clip.byteLength)
    const room = frames(clip.length / 32, 900, 0, 7)
    const b = new DataView(room.buffer)
    const o = new DataView(noisy.buffer)
    for (let i = 0; i < clip.length / 2; i++) o.setInt16(i * 2, Math.max(-32768, Math.min(32767, a.getInt16(i * 2, true) + b.getInt16(i * 2, true))), true)
    const ep = new Endpointer()
    const r = run(ep, cat(frames(500, 900, 0, 3), noisy, frames(2000, 900, 0, 5)))
    assert.equal(r.verdict, 'ended', `${name}: ${r.verdict}`)
    assert.ok(ep.hadSpeech, `${name}: heard speech`)
  }
}

// --- WAV ---
{
  const pcm = frames(500, 100)
  const w = wav(pcm)
  const v = new DataView(w.buffer)
  assert.equal(String.fromCharCode(...w.subarray(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...w.subarray(8, 12)), 'WAVE')
  assert.equal(v.getUint32(24, true), 16000, 'sample rate')
  assert.equal(v.getUint16(34, true), 16, 'bits')
  assert.equal(v.getUint32(40, true), pcm.length, 'data size')
  assert.equal(w.length, 44 + pcm.length)
}

// --- request shapes ---
interface Seen { url: string; init: RequestInit }
let seen: Seen[] = []
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  seen.push({ url: String(url), init })
  const u = String(url)
  if (u.endsWith('/v1/audio/transcriptions')) return new Response(JSON.stringify({ text: ' Cast Fire Bolt at the goblin. ' }), { status: 200 })
  if (u.endsWith('/api/v1/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: '"drink a potion"' } }] }), { status: 200 })
  return new Response('{}', { status: 404 })
}) as typeof fetch

{
  seen = []
  const text = await transcribe({ provider: 'openai', key: 'sk-test', model: 'gpt-4o-mini-transcribe' }, wav(frames(500, 100)), ['● Speak', 'Fire Bolt ×3', 'Goblin'])
  assert.equal(text, 'Cast Fire Bolt at the goblin.')
  assert.equal(seen[0].url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal((seen[0].init.headers as Record<string, string>).Authorization, 'Bearer sk-test')
  const form = seen[0].init.body as FormData
  assert.equal(form.get('model'), 'gpt-4o-mini-transcribe')
  assert.equal(form.get('language'), 'en')
  assert.ok(String(form.get('prompt')).includes('Fire Bolt'), 'primed with on-screen words')
  assert.ok(!String(form.get('prompt')).includes('×'), 'labels cleaned of counts')
  const file = form.get('file') as File
  assert.equal(file.type, 'audio/wav')
}
{
  seen = []
  const text = await transcribe({ provider: 'openrouter', key: 'sk-or-test', model: 'google/gemini-3.5-flash-lite' }, wav(frames(500, 100)), ['Potion ×1'])
  assert.equal(text, 'drink a potion', 'quotes stripped')
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/chat/completions')
  const body = JSON.parse(String(seen[0].init.body))
  assert.equal(body.model, 'google/gemini-3.5-flash-lite')
  const parts = body.messages[0].content
  assert.equal(parts[1].type, 'input_audio')
  assert.equal(parts[1].input_audio.format, 'wav')
  assert.ok(atob(parts[1].input_audio.data).startsWith('RIFF'), 'base64 WAV')
}

console.log('speech tests passed')
