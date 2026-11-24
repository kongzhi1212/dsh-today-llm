/**
 * Tests for the API client's transport behaviour.
 *
 * These cover the parts that were wrong before and would silently regress: the
 * per-host `Origin`, the request deadline, and the mapping of a thrown fetch
 * failure onto the plugin's failure vocabulary.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { REGION_CONFIG, TodayApiError, TodayClient } from '../src/api.js'

/**
 * Build a client whose fetch records every call and answers like the service.
 * @param answer - optional per-call override.
 * @returns the client plus the recorded calls.
 */
function recordingClient(answer) {
  const calls = []
  const client = new TodayClient({
    refreshCredential: 'session-token',
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, hasSignal: init.signal !== undefined })
      if (url.includes('/api/auth/token')) {
        return new Response(JSON.stringify({ token: 'header.payload.signature' }), { status: 200 })
      }
      return answer === undefined
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : answer(url, init)
    },
  })
  return { client, calls }
}

describe('region hosts', () => {
  it('exposes a distinct host set per deployment', () => {
    assert.equal(REGION_CONFIG.cn.apiBaseUrl, 'https://api.todayai.cn')
    assert.equal(REGION_CONFIG.global.apiBaseUrl, 'https://api.today.ai')
    assert.notEqual(REGION_CONFIG.cn.authBaseUrl, REGION_CONFIG.global.authBaseUrl)
    assert.notEqual(REGION_CONFIG.cn.webOrigin, REGION_CONFIG.global.webOrigin)
  })

  it('defaults to the mainland deployment', () => {
    const { client } = recordingClient()
    assert.equal(client.region, 'cn')
    assert.equal(client.apiBaseUrl, 'https://api.todayai.cn')
  })

  it('targets the international hosts when asked', async () => {
    const calls = []
    const client = new TodayClient({
      refreshCredential: 's',
      region: 'global',
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers })
        return url.includes('/api/auth/token')
          ? new Response(JSON.stringify({ token: 'a.b.c' }), { status: 200 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    })
    await client.usage()
    assert.ok(calls.every(call => !call.url.includes('todayai.cn')))
    assert.ok(calls.some(call => call.url.startsWith('https://api.today.ai/')))
    assert.ok(calls.some(call => call.url.startsWith('https://auth.today.ai/')))
  })
})

describe('request headers', () => {
  it('sends the auth origin to the auth host and the web origin to the API host', async () => {
    const { client, calls } = recordingClient()
    await client.usage()
    const auth = calls.find(call => call.url.includes('/api/auth/token'))
    const api = calls.find(call => call.url.includes('/v1/'))
    assert.ok(auth, 'expected an auth call')
    assert.ok(api, 'expected an api call')
    assert.equal(auth.headers.origin, 'https://auth.todayai.cn')
    assert.equal(api.headers.origin, 'https://todayai.cn')
  })

  it('identifies itself as the desktop client', async () => {
    const { client, calls } = recordingClient()
    await client.usage()
    for (const call of calls) {
      assert.equal(typeof call.headers['x-app-version'], 'string')
      assert.equal(call.headers['x-client-platform'], 'windows')
      assert.match(call.headers['user-agent'], /deepseek-harness/)
    }
  })

  it('carries a deadline signal on every request', async () => {
    const { client, calls } = recordingClient()
    await client.usage()
    assert.ok(calls.every(call => call.hasSignal === true))
  })
})

describe('failure mapping', () => {
  it('maps a 401 to AUTH', async () => {
    const { client } = recordingClient(() => new Response('denied', { status: 401 }))
    await assert.rejects(client.usage(), (error) => {
      assert.ok(error instanceof TodayApiError)
      assert.equal(error.code, 'AUTH')
      return true
    })
  })

  it('maps a 429 to RATE_LIMIT and a 500 to SERVER', async () => {
    for (const [status, code] of [[429, 'RATE_LIMIT'], [500, 'SERVER']]) {
      const { client } = recordingClient(() => new Response('x', { status }))
      await assert.rejects(client.usage(), (error) => error.code === code)
    }
  })

  it('maps a timeout to TIMEOUT rather than UNKNOWN', async () => {
    const client = new TodayClient({
      refreshCredential: 's',
      fetch: async (url) => {
        if (url.includes('/api/auth/token')) {
          return new Response(JSON.stringify({ token: 'a.b.c' }), { status: 200 })
        }
        const error = new Error('timed out')
        error.name = 'TimeoutError'
        throw error
      },
    })
    await assert.rejects(client.usage(), (error) => {
      assert.equal(error.code, 'TIMEOUT')
      return true
    })
  })

  it('maps a cancellation to ABORTED', async () => {
    const client = new TodayClient({
      refreshCredential: 's',
      fetch: async (url) => {
        if (url.includes('/api/auth/token')) {
          return new Response(JSON.stringify({ token: 'a.b.c' }), { status: 200 })
        }
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      },
    })
    await assert.rejects(client.usage(), (error) => error.code === 'ABORTED')
  })

  it('maps a timed-out token exchange to TIMEOUT, not UNKNOWN', async () => {
    // The token call is a separate fetch from `request`, so it needs the same
    // mapping; without it a stalled auth host looks like a protocol bug.
    const client = new TodayClient({
      refreshCredential: 's',
      fetch: async () => {
        const error = new Error('timed out')
        error.name = 'TimeoutError'
        throw error
      },
    })
    await assert.rejects(client.mintAccessToken(), (error) => {
      assert.equal(error.code, 'TIMEOUT')
      assert.match(error.message, /timed out/)
      return true
    })
  })

  it('maps an unreachable auth host to TRANSPORT', async () => {
    const client = new TodayClient({
      refreshCredential: 's',
      fetch: async () => { throw new Error('ECONNREFUSED') },
    })
    await assert.rejects(client.mintAccessToken(), (error) => {
      assert.equal(error.code, 'TRANSPORT')
      return true
    })
  })
})

describe('token handling', () => {
  it('accepts either token field name', async () => {
    for (const body of [{ token: 'a.b.c' }, { accessToken: 'a.b.c' }, { access_token: 'a.b.c' }]) {
      const client = new TodayClient({
        refreshCredential: 's',
        fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
      })
      assert.equal(await client.mintAccessToken(), 'a.b.c')
    }
  })

  it('refuses a response with no token', async () => {
    const client = new TodayClient({
      refreshCredential: 's',
      fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
    })
    await assert.rejects(client.mintAccessToken(), (error) => error.code === 'AUTH')
  })
})
