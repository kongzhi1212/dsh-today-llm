/**
 * Tests for turn behaviour that is easy to break silently: how a finished reply
 * is presented, what happens to the account's model afterwards, and how a
 * refusal from the service is described.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TodayAdapter } from '../src/adapter.js'
import { TodayClient } from '../src/api.js'

/** Config shared by the adapter cases, matching what `apply` resolves. */
const CONFIG = {
  timeoutMs: 60_000,
  pollIntervalMs: 700,
  refreshModelsMs: 600_000,
  defaultContextWindow: 200_000,
  maxConcurrency: 1,
  strictProtocol: true,
  useSocket: false,
  reportUsage: false,
  restoreModelAfterTurn: true,
  streamChunkChars: 48,
  streamChunkDelayMs: 0,
  deviceId: 'test-device',
  region: 'cn',
  models: {},
}

/**
 * Build an adapter whose client is replaced by a stub.
 * @param options - overrides for the stub's behaviour and the config.
 * @returns the adapter plus the calls the stub recorded.
 */
function stubAdapter(options = {}) {
  const calls = []
  const adapter = new TodayAdapter({
    config: { ...CONFIG, ...(options.config ?? {}) },
    resolveAccount: () => ({ refreshCredential: 'session', region: 'cn', userDataDir: '/tmp/today' }),
  })
  const client = {
    apiBaseUrl: 'https://api.todayai.cn',
    async token() { return 'header.payload.signature' },
    async selection() { calls.push({ kind: 'selection' }); return options.selection ?? 'model.glm-5.3' },
    async selectModel(optionId) { calls.push({ kind: 'select', optionId }) },
    async startTaskConversation() { return 'conv-1' },
    async awaitReply() { return options.reply ?? 'the answer' },
  }
  adapter.client = client
  return { adapter, calls }
}

/**
 * Drain a chunk stream.
 * @param adapter - the adapter to stream from.
 * @param model - model id to request.
 * @returns every chunk.
 */
async function collect(adapter, model = 'deepseek-v4.1-flash') {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'today',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

describe('pseudo-streaming', () => {
  it('splits a long reply into several deltas that rejoin to the original', async () => {
    const reply = 'x'.repeat(200)
    const { adapter } = stubAdapter({ reply })
    const chunks = await collect(adapter)
    const deltas = chunks.filter(c => c.type === 'text-delta')
    assert.ok(deltas.length > 1, 'expected more than one delta')
    assert.equal(deltas.map(d => d.text).join(''), reply)
  })

  it('emits a single delta when chunking is disabled', async () => {
    const { adapter } = stubAdapter({ config: { streamChunkChars: 0 }, reply: 'x'.repeat(200) })
    const chunks = await collect(adapter)
    const deltas = chunks.filter(c => c.type === 'text-delta')
    assert.equal(deltas.length, 1)
    assert.equal(deltas[0].text.length, 200)
  })

  it('leaves a short reply in one delta', async () => {
    const { adapter } = stubAdapter({ reply: 'short' })
    const chunks = await collect(adapter)
    assert.equal(chunks.filter(c => c.type === 'text-delta').length, 1)
  })

  it('never splits a tool call into deltas', async () => {
    // Chunking a tool call would put half a JSON envelope through the renderer.
    const { adapter } = stubAdapter({ reply: '{"tool_call": {"name": "read_file", "arguments": {"path": "a"}}}' })
    const chunks = await collect(adapter)
    const deltas = chunks.filter(c => c.type === 'tool-call-delta')
    assert.equal(deltas.length, 1)
    assert.equal(chunks.filter(c => c.type === 'text-delta').length, 0)
  })

  it('keeps the block-end payload equal to the whole reply', async () => {
    const reply = 'y'.repeat(150)
    const { adapter } = stubAdapter({ reply })
    const chunks = await collect(adapter)
    const end = chunks.find(c => c.type === 'block-end')
    assert.equal(end.block.text, reply)
  })
})

describe('model restoration', () => {
  it('restores the account model after a turn', async () => {
    const { adapter, calls } = stubAdapter({ selection: 'model.glm-5.3' })
    await collect(adapter, 'deepseek-v4.1-flash')
    const selects = calls.filter(c => c.kind === 'select').map(c => c.optionId)
    // Pin the requested model, then put the previous one back.
    assert.deepEqual(selects, ['model.deepseek-v4.1-flash', 'model.glm-5.3'])
  })

  it('does not touch the selection when restoration is off', async () => {
    const { adapter, calls } = stubAdapter({ config: { restoreModelAfterTurn: false } })
    await collect(adapter, 'deepseek-v4.1-flash')
    const selects = calls.filter(c => c.kind === 'select').map(c => c.optionId)
    assert.deepEqual(selects, ['model.deepseek-v4.1-flash'])
  })

  it('captures the baseline only once across several turns', async () => {
    const { adapter, calls } = stubAdapter()
    await collect(adapter, 'deepseek-v4.1-flash')
    await collect(adapter, 'deepseek-v4.1-flash')
    assert.equal(calls.filter(c => c.kind === 'selection').length, 1)
  })

  it('still returns the answer when the restore call fails', async () => {
    const { adapter } = stubAdapter({ selection: 'model.glm-5.3' })
    const client = adapter.client
    client.selectModel = async (optionId) => {
      if (optionId === 'model.glm-5.3') throw new Error('restore refused')
    }
    const chunks = await collect(adapter, 'deepseek-v4.1-flash')
    assert.equal(chunks.find(c => c.type === 'block-end').block.text, 'the answer')
  })

  it('skips restoration entirely when no baseline could be read', async () => {
    const { adapter, calls } = stubAdapter()
    adapter.client.selection = async () => { throw new Error('unavailable') }
    await collect(adapter, 'deepseek-v4.1-flash')
    assert.equal(calls.filter(c => c.kind === 'select').length, 1)
  })
})

describe('failure messages', () => {
  it('names rate limiting and includes the service hint', async () => {
    const client = new TodayClient({
      refreshCredential: 's',
      fetch: async (url) => url.includes('/api/auth/token')
        ? new Response(JSON.stringify({ token: 'a.b.c' }), { status: 200 })
        : new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
    })
    await assert.rejects(client.usage(), (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      assert.match(error.message, /频控/)
      assert.match(error.message, /30/)
      return true
    })
  })

  it('explains an oversized request as a context problem', async () => {
    const client = new TodayClient({
      refreshCredential: 's',
      fetch: async (url) => url.includes('/api/auth/token')
        ? new Response(JSON.stringify({ token: 'a.b.c' }), { status: 200 })
        : new Response('too large', { status: 413 }),
    })
    await assert.rejects(client.usage(), (error) => {
      assert.equal(error.code, 'TOO_LARGE')
      assert.match(error.message, /上下文/)
      return true
    })
  })

  it('maps an exhausted quota to QUOTA', async () => {
    const client = new TodayClient({
      refreshCredential: 's',
      fetch: async (url) => url.includes('/api/auth/token')
        ? new Response(JSON.stringify({ token: 'a.b.c' }), { status: 200 })
        : new Response('pay', { status: 402 }),
    })
    await assert.rejects(client.usage(), (error) => error.code === 'QUOTA')
  })

  it('tells the user to sign in again on 401', async () => {
    const client = new TodayClient({
      refreshCredential: 's',
      fetch: async (url) => url.includes('/api/auth/token')
        ? new Response(JSON.stringify({ token: 'a.b.c' }), { status: 200 })
        : new Response('no', { status: 401 }),
    })
    await assert.rejects(client.usage(), (error) => {
      assert.equal(error.code, 'AUTH')
      assert.match(error.message, /重新登录/)
      return true
    })
  })
})
