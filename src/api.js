/**
 * Minimal client for the Today cloud API that the desktop app itself uses.
 *
 * Only four shapes matter to this plugin: exchange the stored session for a
 * short-lived access token, read the model catalog, pin the account's active
 * model, and run one agent turn in a throwaway task conversation.
 *
 * @module dsh-today-llm/api
 */

import { randomUUID } from 'node:crypto'

/** Auth host that mints access tokens from the stored session. */
export const AUTH_BASE = 'https://auth.todayai.cn'
/** API host that serves conversations, tasks and the model catalog. */
export const API_BASE = 'https://api.todayai.cn'

/**
 * Attribution value sent on every request, matching the harness default.
 *
 * The adapter contract asks provider requests to identify the product. This
 * bundle cannot import the harness attribution helper without taking a
 * dependency on the installation, so the same product token is spelled here.
 */
const USER_AGENT = 'deepseek-harness'

/** Refresh an access token this many milliseconds before it would expire. */
const TOKEN_REFRESH_MARGIN_MS = 60_000
/** Poll interval while waiting for the assistant message to finalize. */
const POLL_INTERVAL_MS = 700
/** Smallest accepted poll interval, so a bad config cannot spin. */
const MIN_POLL_INTERVAL_MS = 250

/**
 * Caller-visible failure with a stable machine code mirroring the LLM failure vocabulary.
 */
export class TodayApiError extends Error {
  /**
   * @param message - human-readable summary.
   * @param code - stable failure code such as `AUTH`, `RATE_LIMIT`, or `SERVER`.
   * @param status - HTTP status when one was observed.
   */
  constructor(message, code, status) {
    super(message)
    this.name = 'TodayApiError'
    this.code = code
    this.status = status
  }
}

/**
 * Map an HTTP status to the provider-neutral failure vocabulary.
 * @param status - observed HTTP status.
 * @returns the stable code.
 */
function failureCodeFor(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 404) return 'HTTP_404'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  if (status >= 400) return 'INVALID_REQUEST'
  return 'UNKNOWN'
}

/**
 * One authenticated client bound to a stored Today session.
 */
export class TodayClient {
  /**
   * @param options - session credential and fetch override.
   * @param options.refreshCredential - the long-lived better-auth session token.
   * @param options.fetch - fetch implementation; defaults to the global.
   */
  constructor({ refreshCredential, fetch: fetchImpl }) {
    this.refreshCredential = refreshCredential
    this.fetch = fetchImpl ?? globalThis.fetch
    this.accessToken = undefined
    this.expiresAt = 0
    /** Origin the socket layer derives its URL from. */
    this.apiBaseUrl = API_BASE
  }

  /**
   * Standard headers for every request.
   * @param extra - additional headers to merge.
   * @returns the header record.
   */
  headers(extra = {}) {
    return { accept: 'application/json', origin: AUTH_BASE, 'user-agent': USER_AGENT, ...extra }
  }

  /**
   * Exchange the stored session for a fresh access token.
   * @returns the bearer token.
   * @throws {TodayApiError} when the session was rejected.
   */
  async mintAccessToken() {
    const response = await this.fetch(`${AUTH_BASE}/api/auth/token`, {
      method: 'GET',
      headers: this.headers({ authorization: `Bearer ${this.refreshCredential}` }),
    })
    if (!response.ok) {
      throw new TodayApiError(
        `Today rejected the stored session (HTTP ${response.status}); sign in again in the Today app`,
        'AUTH',
        response.status,
      )
    }
    const body = await response.json()
    // The desktop client reads `access_token`; the CN deployment answers
    // `token`. Accept either rather than depend on one build.
    const token = body?.token ?? body?.accessToken ?? body?.access_token
    if (typeof token !== 'string' || token === '') {
      throw new TodayApiError('Today returned no access token for the stored session', 'AUTH', response.status)
    }
    this.accessToken = token
    this.expiresAt = expiryOf(token)
    return token
  }

  /**
   * Return a usable access token, minting one when the cached value is stale.
   * @returns the bearer token.
   */
  async token() {
    if (this.accessToken !== undefined && Date.now() < this.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.accessToken
    }
    return await this.mintAccessToken()
  }

  /**
   * Perform one authenticated JSON request.
   * @param path - path beginning with `/`.
   * @param init - fetch init, plus an optional `retryOnAuth` flag.
   * @returns the parsed JSON body.
   * @throws {TodayApiError} on any non-2xx status.
   */
  async request(path, { retryOnAuth = true, ...init } = {}) {
    const token = await this.token()
    const response = await this.fetch(`${API_BASE}${path}`, {
      ...init,
      headers: this.headers({ authorization: `Bearer ${token}`, ...init.headers }),
    })
    if (response.status === 401 && retryOnAuth) {
      // The JWT is short lived and may have been revoked between mint and use.
      this.accessToken = undefined
      return await this.request(path, { ...init, retryOnAuth: false })
    }
    if (!response.ok) {
      const detail = await safeText(response)
      throw new TodayApiError(
        `Today ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`,
        failureCodeFor(response.status),
        response.status,
      )
    }
    return await response.json()
  }

  /**
   * Read the account's plan and usage allowance.
   * @returns the normalized usage summary.
   */
  async usage() {
    const body = await this.request('/v1/pricing/status')
    const status = body?.data?.status ?? {}
    const usage = status.usage ?? {}
    const breakdown = Array.isArray(usage?.breakdown?.items) ? usage.breakdown.items : []
    return {
      plan: typeof status.plan === 'string' ? status.plan : undefined,
      serviceState: typeof status.serviceState === 'string' ? status.serviceState : undefined,
      accessPhase: typeof status.accessPhase === 'string' ? status.accessPhase : undefined,
      entitlementEndsAt: typeof status.entitlementEndsAt === 'string' ? status.entitlementEndsAt : undefined,
      usedPercent: typeof usage.progress === 'number' ? usage.progress : undefined,
      remainingText: typeof usage?.breakdown?.display?.remainingPercentText === 'string'
        ? usage.breakdown.display.remainingPercentText
        : undefined,
      resetAt: typeof usage.resetAt === 'string' ? usage.resetAt : undefined,
      items: breakdown.map(item => ({
        key: String(item?.key ?? ''),
        title: String(item?.display?.title ?? item?.key ?? ''),
        percentText: String(item?.display?.percentText ?? ''),
        usedPercent: typeof item?.usedPercent === 'number' ? item.usedPercent : undefined,
      })),
    }
  }

  /**
   * Read the account's background tasks, newest first.
   * @param limit - maximum entries to return.
   * @returns the task summaries.
   */
  async tasks(limit = 10) {
    const body = await this.request('/v1/tasks')
    const items = Array.isArray(body?.data) ? body.data : []
    return items.slice(0, limit).map(task => ({
      id: String(task?.id ?? ''),
      name: String(task?.name ?? ''),
      status: String(task?.status ?? ''),
      taskType: String(task?.taskType ?? ''),
      createdAt: typeof task?.createdAt === 'string' ? task.createdAt : undefined,
      completedAt: typeof task?.completedAt === 'string' ? task.completedAt : undefined,
      hasUnseenResult: task?.hasUnseenResult === true,
    }))
  }

  /**
   * Read the account's most recent diary entry.
   * @returns the entry, or undefined when the account has none.
   */
  async latestDiary() {
    const body = await this.request('/v1/diaries')
    const items = Array.isArray(body?.data) ? body.data : []
    const entry = items[0]
    if (entry === undefined) return undefined
    return {
      date: String(entry?.date ?? ''),
      title: String(entry?.title ?? ''),
      generatedAt: typeof entry?.generatedAt === 'string' ? entry.generatedAt : undefined,
      // The diary is long; the page shows an excerpt and links nowhere, so a
      // bounded prefix keeps the payload from dominating the snapshot.
      excerpt: String(entry?.diary ?? '').slice(0, 600),
    }
  }

  /**
   * Read the models this account may select.
   * @returns official catalog entries in server order.
   */
  async catalog() {
    const body = await this.request('/v1/model-services/catalog')
    const items = body?.data?.official?.items
    return Array.isArray(items) ? items : []
  }

  /**
   * Read the account's currently selected model option.
   * @returns the option id, or undefined when the server reports none.
   */
  async selection() {
    const body = await this.request('/v1/model-services/selection')
    const optionId = body?.data?.selection?.optionId
    return typeof optionId === 'string' && optionId !== '' ? optionId : undefined
  }

  /**
   * Pin the account's active model.
   * @param optionId - catalog option id such as `model.glm-5.3`.
   */
  async selectModel(optionId) {
    await this.request('/v1/model-services/selection', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId }),
    })
  }

  /**
   * Start a turn in a fresh, isolated task conversation.
   *
   * A new task keeps the agent's own memory and the user's main chat out of the
   * request: the prompt this plugin sends is the complete conversation.
   * @param text - the single user text part.
   * @returns the conversation id to poll.
   */
  async startTaskConversation(text) {
    const body = await this.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: { parts: [{ id: randomUUID(), type: 'text', text }] },
        clientMessageId: randomUUID(),
        target: { type: 'new_task', surface: 'task_panel' },
      }),
    })
    const conversationId = body?.canonicalMessage?.conversationId
    if (typeof conversationId !== 'string' || conversationId === '') {
      throw new TodayApiError('Today accepted the message but returned no conversation id', 'MALFORMED_RESPONSE')
    }
    return conversationId
  }

  /**
   * Read the messages of one conversation.
   * @param conversationId - conversation to read.
   * @param limit - page size.
   * @returns the items, oldest first.
   */
  async messages(conversationId, limit = 30) {
    const query = new URLSearchParams({ conversationId, limit: String(limit) })
    const body = await this.request(`/v1/conversations/messages?${query.toString()}`)
    const items = body?.data?.items
    return Array.isArray(items) ? items : []
  }

  /**
   * Wait for the assistant message of a conversation to finalize.
   * @param conversationId - conversation to watch.
   * @param options - cancellation, deadline and poll cadence.
   * @returns the final assistant text.
   * @throws {TodayApiError} on timeout or cancellation.
   */
  async awaitReply(conversationId, { signal, timeoutMs, pollIntervalMs = POLL_INTERVAL_MS } = {}) {
    const deadline = Date.now() + (timeoutMs ?? 300_000)
    const interval = Math.max(MIN_POLL_INTERVAL_MS, pollIntervalMs)
    let lastSeen = ''
    for (;;) {
      if (signal?.aborted === true) throw new TodayApiError('Today request cancelled', 'ABORTED')
      const items = await this.messages(conversationId)
      const assistant = items.filter(item => item?.role === 'assistant').at(-1)
      if (assistant !== undefined) {
        const text = textOf(assistant)
        if (text !== '') lastSeen = text
        if (assistant.isFinal === true) {
          if (text !== '') return text
          throw new TodayApiError('Today finished the turn without any text', 'EMPTY_RESPONSE')
        }
      }
      if (Date.now() > deadline) {
        throw new TodayApiError(
          `Today did not answer within ${Math.round((timeoutMs ?? 300_000) / 1000)}s${lastSeen === '' ? '' : ' (a partial reply was seen)'}`,
          'TIMEOUT',
        )
      }
      await delay(interval, signal)
    }
  }
}

/**
 * Read the JWT expiry, falling back to one hour when the token is opaque.
 * @param token - access token.
 * @returns the expiry timestamp in milliseconds.
 */
function expiryOf(token) {
  const segments = token.split('.')
  if (segments.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
      if (typeof claims?.exp === 'number' && Number.isFinite(claims.exp)) return claims.exp * 1000
    } catch {
      // Fall through to the conservative default.
    }
  }
  return Date.now() + 60 * 60 * 1000
}

/**
 * Concatenate the text parts of one canonical message.
 * @param message - a conversation message.
 * @returns its visible text.
 */
export function textOf(message) {
  const parts = message?.body?.parts
  if (!Array.isArray(parts)) return typeof message?.content === 'string' ? message.content : ''
  return parts.map(part => (typeof part?.content?.text === 'string' ? part.content.text : '')).join('')
}

/**
 * Read a response body as short text for diagnostics.
 * @param response - the failed response.
 * @returns trimmed text, or an empty string.
 */
async function safeText(response) {
  try {
    const text = await response.text()
    return text.replace(/\s+/gu, ' ').trim().slice(0, 300)
  } catch {
    return ''
  }
}

/**
 * Sleep, honoring cancellation.
 * @param ms - delay in milliseconds.
 * @param signal - optional cancellation.
 * @returns a promise settling after the delay.
 */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new TodayApiError('Today request cancelled', 'ABORTED'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new TodayApiError('Today request cancelled', 'ABORTED'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
