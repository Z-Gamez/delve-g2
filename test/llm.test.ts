// Offline checks of the cloud provider calls: request shape and reply parsing,
// with fetch stubbed out. (Live calls need the player's own keys.)
//
//   node --experimental-strip-types test/llm.test.ts

import assert from 'node:assert/strict'
import { complete, strict, type LlmConfig } from '../src/llm.ts'

interface Seen {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

let seen: Seen[] = []
let replies: (() => Response)[] = []

globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  seen.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : {} })
  const next = replies.shift()
  if (!next) throw new Error(`unexpected fetch ${url}`)
  return next()
}) as typeof fetch

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const schema = {
  type: 'object',
  properties: {
    ability: { type: 'string', enum: ['str', 'dex'] },
    choices: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } },
  },
  required: ['ability'],
}
const messages = [
  { role: 'system' as const, content: 'You are the DM.' },
  { role: 'user' as const, content: 'Rule on this.' },
]
const opts = { schema, maxTokens: 200, temperature: 0.7, timeoutMs: 5000 }
const answer = '{"ability":"dex","choices":[]}'

// --- strict schema dialect ---
{
  const s = strict(schema) as Record<string, any>
  assert.equal(s.additionalProperties, false)
  assert.deepEqual(s.required, ['ability', 'choices'], 'every property required')
  assert.equal(s.properties.choices.minItems, undefined, 'array bounds dropped')
  assert.equal(s.properties.choices.items.additionalProperties, false, 'nested objects closed')
}

// --- Anthropic ---
{
  seen = []
  replies = [json(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: answer }] })]
  const cfg: LlmConfig = { provider: 'anthropic', server: '', key: 'sk-ant-test', model: '' }
  assert.equal(await complete(cfg, messages, opts), answer)
  const req = seen[0]
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(req.headers['x-api-key'], 'sk-ant-test')
  assert.equal(req.headers['anthropic-version'], '2023-06-01')
  assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true')
  assert.equal(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01')
  assert.equal(req.body.model, 'claude-opus-5')
  assert.equal(req.body.fallbacks, 'default')
  assert.equal(req.body.system, 'You are the DM.')
  assert.deepEqual(req.body.messages, [{ role: 'user', content: 'Rule on this.' }], 'system prompt is top-level, not a message')
  assert.equal(req.body.temperature, undefined, 'no sampling params')
  const oc = req.body.output_config as Record<string, any>
  assert.equal(oc.effort, 'low')
  assert.equal(oc.format.type, 'json_schema')
  assert.equal(oc.format.schema.additionalProperties, false)
  assert.ok((req.body.max_tokens as number) >= 4000, 'room for adaptive thinking')

  replies = [json(200, { stop_reason: 'refusal', content: [] })]
  assert.equal(await complete(cfg, messages, opts), null, 'a refusal yields no text')
  replies = [json(200, { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"abil' }] })]
  assert.equal(await complete(cfg, messages, opts), null, 'truncated JSON is dropped')
  replies = [json(401, { error: { type: 'authentication_error' } })]
  assert.equal(await complete(cfg, messages, opts), null, 'HTTP errors become null')
  assert.equal(await complete({ ...cfg, key: '' }, messages, opts), null, 'no key, no call')
}

// --- OpenAI ---
{
  seen = []
  replies = [
    json(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-5-mini' }, { id: 'whisper-1' }, { id: 'gpt-4o-realtime-preview' }] }),
    json(200, { choices: [{ finish_reason: 'stop', message: { content: answer } }] }),
  ]
  const cfg: LlmConfig = { provider: 'openai', server: '', key: 'sk-test', model: '' }
  assert.equal(await complete(cfg, messages, opts), answer)
  assert.equal(seen[0].url, 'https://api.openai.com/v1/models', 'no model chosen: pick a default from the list')
  const req = seen[1]
  assert.equal(req.url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(req.headers.Authorization, 'Bearer sk-test')
  assert.equal(req.body.model, 'gpt-5-mini', 'preferred default')
  const rf = req.body.response_format as Record<string, any>
  assert.equal(rf.type, 'json_schema')
  assert.equal(rf.json_schema.strict, true)
  assert.equal(rf.json_schema.schema.additionalProperties, false)
  assert.equal(req.body.temperature, undefined)
  assert.ok(req.body.max_completion_tokens)

  replies = [json(200, { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that.' } }] })]
  assert.equal(await complete({ ...cfg, model: 'gpt-5-mini' }, messages, opts), null, 'refusal yields null')
}

// --- OpenRouter ---
{
  seen = []
  replies = [
    json(400, { error: { message: 'response_format json_schema not supported' } }),
    json(200, { choices: [{ finish_reason: 'stop', message: { content: '```json\n' + answer + '\n```' } }] }),
  ]
  const cfg: LlmConfig = { provider: 'openrouter', server: '', key: 'sk-or-test', model: 'some/model' }
  assert.equal(await complete(cfg, messages, opts), answer, 'falls back to JSON mode and unwraps fences')
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(seen[0].headers['X-Title'], 'Delve')
  assert.equal((seen[1].body.response_format as Record<string, string>).type, 'json_object')
}

// --- local ---
{
  seen = []
  replies = [json(200, { content: answer })]
  const cfg: LlmConfig = { provider: 'local', server: 'http://my-pc.example.ts.net:8790', key: '', model: 'qwen3:4b' }
  assert.equal(await complete(cfg, messages, opts), answer)
  assert.equal(seen[0].url, 'http://my-pc.example.ts.net:8790/api/chat')
  assert.deepEqual(seen[0].body.format, schema, 'local keeps the original schema')
  assert.equal(seen[0].body.model, 'qwen3:4b')
}

console.log('llm tests passed')
