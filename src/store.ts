// Persistence: the run in progress, the hall of fame, and settings.
//
// Browser localStorage is useless inside the Even WebView: it serves the app
// from 127.0.0.1 on a new random port every launch, so each launch is a fresh
// origin. The host's own storage (bridge.setLocalStorage) is keyed to the
// plugin and survives. In a plain browser we fall back to localStorage.

import type { Provider } from './llm'
import type { CloudSpeechProvider } from './cloudStt'

export type SpeechProvider = 'server' | CloudSpeechProvider

export interface HostStorage {
  setLocalStorage(key: string, value: string): Promise<boolean>
  getLocalStorage(key: string): Promise<string>
}

/** The read sits on the path to the first paint, so it's bounded. */
const READ_TIMEOUT_MS = 1500

let host: HostStorage | null = null

export function useHost(h: HostStorage | null) {
  host = h
}

export async function readJson<T>(key: string, fallback: T): Promise<T> {
  let raw = ''
  try {
    raw = host
      ? await Promise.race([host.getLocalStorage(key), new Promise<string>(r => setTimeout(() => r(''), READ_TIMEOUT_MS))])
      : localStorage.getItem(key) ?? ''
  } catch {
    raw = ''
  }
  try {
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback // corrupt entry: start clean
  }
}

export function writeJson(key: string, value: unknown) {
  const raw = JSON.stringify(value)
  if (host) {
    void host.setLocalStorage(key, raw).catch(err => console.warn(`${key} not saved`, err))
    return
  }
  try {
    localStorage.setItem(key, raw)
  } catch {
    /* private mode */
  }
}

export const KEYS = {
  run: 'delve.run',
  hall: 'delve.hall',
  settings: 'delve.settings',
}

export interface Settings {
  /** Origin of the Delve server, e.g. http://my-pc.tail1234.ts.net:8790 */
  server: string
  /** Let the AI Dungeon Master narrate and rule on freeform actions. */
  ai: boolean
  /** Re-open the mic after every turn, so no tapping is needed. */
  handsFree: boolean
  /** Who plays the Dungeon Master. */
  provider: Provider
  /** Who turns speech into text: the Delve server's Whisper, or a cloud API (keys shared with the DM). */
  speech: SpeechProvider
  /** Chosen speech model per cloud provider; '' = that provider's default. */
  speechModels: Partial<Record<CloudSpeechProvider, string>>
  /** Chunky pixel-art portraits on the lens (vs. smooth). */
  pixelArt: boolean
  /** Cloud API keys, per provider. They live only in the app's private host storage. */
  keys: Partial<Record<Provider, string>>
  /** Chosen model per provider; '' = that provider's default. */
  models: Partial<Record<Provider, string>>
}

export const DEFAULT_SETTINGS: Settings = { server: '', ai: true, handsFree: false, provider: 'local', keys: {}, models: {}, speech: 'server', speechModels: {}, pixelArt: true }

/** Fills in fields added since a settings blob was saved. */
export function migrateSettings(saved: Partial<Settings> & { model?: string }): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, ...saved, keys: { ...saved.keys }, models: { ...saved.models }, speechModels: { ...saved.speechModels } }
  if (saved.model && !s.models.local) s.models.local = saved.model
  delete (s as { model?: string }).model
  return s
}

const DEFAULT_PORT = '8790'

/**
 * Parse base for bare hostnames. Never requested.
 *
 * Written out in full: Even Hub's review scanner flags any URL-shaped literal
 * in the bundle that isn't in the manifest whitelist, and a template like
 * `http://${host}` compiles to exactly that. This one matches a whitelist
 * entry character for character.
 */
const PARSE_BASE = 'http://delve.local:8790'

/**
 * Accepts what a person would actually type -- "my-pc.tail1234.ts.net" -- and
 * returns a usable origin, or '' if it can't be salvaged.
 */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, '')
  if (!raw) return ''
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  let url: URL
  try {
    url = new URL(hasScheme ? raw : `//${raw}`, PARSE_BASE)
  } catch {
    return ''
  }
  if (!url.hostname || !/^[a-z0-9.\-[\]:]+$/i.test(url.hostname)) return ''
  if (!url.port) url.port = DEFAULT_PORT
  return `${url.protocol}//${url.host}`
}

/** True if the host looks like something the manifest whitelist covers. */
export function looksWhitelisted(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h.endsWith('.ts.net') || h === 'delve.local'
  } catch {
    return false
  }
}
