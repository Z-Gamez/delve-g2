// Where the Dungeon Master's words come from: the local Delve server (Ollama)
// or a cloud API -- Claude, ChatGPT or OpenRouter -- with the player's own key.
//
// Every call asks for JSON matching a schema, and every provider has a way to
// enforce that: Ollama's `format`, Anthropic's `output_config.format`, and
// OpenAI/OpenRouter's `response_format: json_schema`. Returns the raw JSON
// text, or null on any failure; the DM treats null as "no flavor this turn".
//
// Plain fetch, not the vendor SDKs, on purpose: Even Hub's review statically
// scans the bundle for URL literals and rejects any not in the manifest's
// network whitelist, and the SDKs carry documentation links in their error
// strings. Here the only URL literals are the three API origins below, each
// whitelisted verbatim; paths are resolved with new URL() so a minifier can't
// fold them into new, unlisted literals.

export type Provider = 'local' | 'anthropic' | 'openai' | 'openrouter'

export const PROVIDERS: { id: Provider; name: string; keyHint: string }[] = [
  { id: 'local', name: 'Local (Delve server + Ollama)', keyHint: '' },
  { id: 'anthropic', name: 'Claude (Anthropic)', keyHint: 'sk-ant-…' },
  { id: 'openai', name: 'ChatGPT (OpenAI)', keyHint: 'sk-…' },
  { id: 'openrouter', name: 'OpenRouter', keyHint: 'sk-or-…' },
]

const ANTHROPIC = 'https://api.anthropic.com'
export const OPENAI = 'https://api.openai.com'
export const OPENROUTER = 'https://openrouter.ai'

/** Used when the player hasn't picked a model for a provider. */
export const DEFAULT_MODELS: Record<Provider, string> = {
  local: '',
  anthropic: 'claude-opus-5',
  openai: '',
  openrouter: '',
}

/** First of these that the account can see becomes the default. */
const PREFERRED: Record<'openai' | 'openrouter', string[]> = {
  openai: ['gpt-5-mini', 'gpt-5', 'gpt-4.1-mini', 'gpt-4o-mini'],
  openrouter: ['anthropic/claude-opus-5', 'openai/gpt-5-mini', 'google/gemini-2.5-flash'],
}

export interface LlmConfig {
  provider: Provider
  /** Delve server origin, for 'local'. */
  server: string
  key: string
  model: string
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface CompleteOptions {
  schema: Record<string, unknown>
  maxTokens: number
  /** Only sent to local models; the cloud reasoning models reject sampling knobs. */
  temperature: number
  timeoutMs: number
}

export async function complete(cfg: LlmConfig, messages: ChatMessage[], o: CompleteOptions): Promise<string | null> {
  try {
    switch (cfg.provider) {
      case 'local':
        return await local(cfg, messages, o)
      case 'anthropic':
        return await anthropic(cfg, messages, o)
      case 'openai':
      case 'openrouter':
        return await openaiCompatible(cfg, messages, o)
    }
  } catch (err) {
    console.warn(`${cfg.provider} call failed`, err instanceof Error ? err.message : err)
    return null
  }
}

// --- providers ---------------------------------------------------------------------

async function local(cfg: LlmConfig, messages: ChatMessage[], o: CompleteOptions): Promise<string | null> {
  if (!cfg.server) return null
  const res = await timed(`${cfg.server}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model || undefined,
      messages,
      format: o.schema,
      think: false,
      options: { temperature: o.temperature, num_predict: o.maxTokens },
    }),
  }, o.timeoutMs)
  if (!res.ok) throw new Error(`Delve server HTTP ${res.status}`)
  const body = (await res.json()) as { content?: string }
  return (body.content ?? '').trim() || null
}

async function anthropic(cfg: LlmConfig, messages: ChatMessage[], o: CompleteOptions): Promise<string | null> {
  if (!cfg.key) return null
  const model = cfg.model || DEFAULT_MODELS.anthropic
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const res = await timed(new URL('/v1/messages', ANTHROPIC).href, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(cfg.key),
      // A declined request is re-run server-side on Anthropic's recommended
      // fallback model instead of coming back empty.
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model,
      // Adaptive thinking counts toward this, so leave real headroom.
      max_tokens: Math.max(4000, o.maxTokens * 8),
      system,
      messages: messages.filter(m => m.role === 'user').map(m => ({ role: 'user', content: m.content })),
      // Low effort: a turn of narration should arrive in seconds, not minutes.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: strict(o.schema) } },
      fallbacks: 'default',
    }),
  }, o.timeoutMs)
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { stop_reason?: string; content?: { type: string; text?: string }[] }
  // Check the stop reason before reading content: a refusal or a cut-off
  // reply isn't usable JSON.
  if (body.stop_reason === 'refusal' || body.stop_reason === 'max_tokens') return null
  const text = (body.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('')
  return text.trim() || null
}

async function openaiCompatible(cfg: LlmConfig, messages: ChatMessage[], o: CompleteOptions): Promise<string | null> {
  if (!cfg.key) return null
  const openrouter = cfg.provider === 'openrouter'
  const model = cfg.model || (await defaultModel(cfg))
  if (!model) return null
  const url = openrouter ? new URL('/api/v1/chat/completions', OPENROUTER).href : new URL('/v1/chat/completions', OPENAI).href
  const send = (structured: boolean) =>
    timed(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.key}`,
        ...(openrouter ? { 'X-Title': 'Delve' } : {}),
      },
      body: JSON.stringify({
        model,
        messages: structured ? messages : [...messages, { role: 'system', content: 'Reply with a single JSON object and nothing else.' }],
        // Reasoning models spend part of this thinking.
        max_completion_tokens: Math.max(4000, o.maxTokens * 8),
        ...(structured
          ? { response_format: { type: 'json_schema', json_schema: { name: 'delve', strict: true, schema: strict(o.schema) } } }
          : { response_format: { type: 'json_object' } }),
      }),
    }, o.timeoutMs)
  let res = await send(true)
  // Some OpenRouter models don't do schemas; plain JSON mode still works.
  if (res.status === 400 && openrouter) res = await send(false)
  if (!res.ok) throw new Error(`${cfg.provider} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[] }
  const choice = body.choices?.[0]
  if (!choice?.message?.content || choice.message.refusal || choice.finish_reason === 'length') return null
  return extractJson(choice.message.content)
}

// --- models & keys -------------------------------------------------------------------

function anthropicHeaders(key: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    // Required for calls straight from a web page. The key is the player's own
    // and stays in the glasses app's private storage.
    'anthropic-dangerous-direct-browser-access': 'true',
  }
}

export interface ModelList {
  models: string[]
  default: string
}

/** Models the key can use; also how the key gets checked. Throws on a bad key. */
export async function listModels(cfg: LlmConfig): Promise<ModelList> {
  switch (cfg.provider) {
    case 'local': {
      const res = await timed(`${cfg.server}/api/models`, {}, 8000)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = (await res.json()) as { models: string[]; default: string }
      return { models: j.models, default: j.default }
    }
    case 'anthropic': {
      const res = await timed(new URL('/v1/models?limit=100', ANTHROPIC).href, { headers: anthropicHeaders(cfg.key) }, 8000)
      if (!res.ok) throw new Error(res.status === 401 ? 'That API key was rejected.' : `HTTP ${res.status}`)
      const j = (await res.json()) as { data: { id: string }[] }
      const models = j.data.map(m => m.id)
      return { models, default: models.includes(DEFAULT_MODELS.anthropic) ? DEFAULT_MODELS.anthropic : models[0] ?? DEFAULT_MODELS.anthropic }
    }
    case 'openai': {
      const res = await timed(new URL('/v1/models', OPENAI).href, { headers: { Authorization: `Bearer ${cfg.key}` } }, 8000)
      if (!res.ok) throw new Error(res.status === 401 ? 'That API key was rejected.' : `HTTP ${res.status}`)
      const j = (await res.json()) as { data: { id: string }[] }
      const models = j.data
        .map(m => m.id)
        .filter(id => /^(gpt-|o\d|chatgpt-)/.test(id) && !/audio|realtime|tts|transcribe|image|search|embedding|instruct/.test(id))
        .sort()
      return { models, default: PREFERRED.openai.find(p => models.includes(p)) ?? models[0] ?? '' }
    }
    case 'openrouter': {
      // The catalog is public; the key is checked separately.
      const keyRes = await timed(new URL('/api/v1/key', OPENROUTER).href, { headers: { Authorization: `Bearer ${cfg.key}` } }, 8000)
      if (!keyRes.ok) throw new Error(keyRes.status === 401 ? 'That API key was rejected.' : `HTTP ${keyRes.status}`)
      const res = await timed(new URL('/api/v1/models', OPENROUTER).href, {}, 10000)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = (await res.json()) as { data: { id: string; supported_parameters?: string[] }[] }
      const models = j.data
        .filter(m => !m.id.endsWith(':batch'))
        .filter(m => !m.supported_parameters || m.supported_parameters.includes('response_format') || m.supported_parameters.includes('structured_outputs'))
        .map(m => m.id)
        .sort()
      return { models, default: PREFERRED.openrouter.find(p => models.includes(p)) ?? models[0] ?? '' }
    }
  }
}

const defaults = new Map<string, string>()

async function defaultModel(cfg: LlmConfig): Promise<string> {
  const cacheKey = `${cfg.provider}|${cfg.key.slice(-6)}`
  const hit = defaults.get(cacheKey)
  if (hit) return hit
  const list = await listModels(cfg)
  defaults.set(cacheKey, list.default)
  return list.default
}

// --- helpers ---------------------------------------------------------------------------

/**
 * The strict schema dialect the cloud APIs want: every object closed and every
 * property required, no array length bounds (the DM trims arrays itself).
 */
export function strict(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strict)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'minItems' || k === 'maxItems') continue
    out[k] = strict(v)
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false
    out.required = Object.keys(out.properties as object)
  }
  return out
}

/** The first {...} in a reply, for models that wrap JSON in prose or fences. */
function extractJson(text: string): string | null {
  const t = text.trim()
  if (t.startsWith('{')) return t
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  return start >= 0 && end > start ? t.slice(start, end + 1) : null
}

async function timed(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}
