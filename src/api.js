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

/**
 * Hosts per deployment.
 *
 * Today ships a mainland-China build and an international one; they are
 * separate services with separate accounts, so a plugin that hardcoded one could
 * never work for a user of the other. `webOrigin` is the site the API calls
 * belong to and is what the `Origin` header must name.
 */
export const REGION_CONFIG = Object.freeze({
  cn: Object.freeze({
    apiBaseUrl: 'https://api.todayai.cn',
    authBaseUrl: 'https://auth.todayai.cn',
    webOrigin: 'https://todayai.cn',
    clientPlatform: 'windows',
  }),
  global: Object.freeze({
    apiBaseUrl: 'https://api.today.ai',
    authBaseUrl: 'https://auth.today.ai',
    webOrigin: 'https://today.ai',
    clientPlatform: 'windows',
  }),
})

/** Region used when the caller does not name one. */
export const DEFAULT_REGION = 'cn'

/**
 * Auth host that mints access tokens from the stored session.
 *
 * Kept exported for the CN deployment so existing imports keep working; the
 * client itself reads the per-region table.
 */
export const AUTH_BASE = REGION_CONFIG.cn.authBaseUrl
/** API host that serves conversations, tasks and the model catalog. */
export const API_BASE = REGION_CONFIG.cn.apiBaseUrl
/** Web origin the API calls belong to, sent as `Origin`. */
export const APP_ORIGIN = REGION_CONFIG.cn.webOrigin

/**
 * Desktop client version this plugin presents itself as.
 *
 * The upstream service sees a desktop client talking to it; sending no version,
 * or a browser user agent, is both less accurate and more conspicuous. Bump it
 * only when the request shape changes, not to chase the app's own releases.
 */
const DESKTOP_VERSION = '1.23.0'

/**
 * Attribution value sent on every request, matching the harness default.
 *
 * The adapter contract asks provider requests to identify the product. This
 * bundle cannot import the harness attribution helper without taking a
 * dependency on the installation, so the same product token is spelled here.
 */
const USER_AGENT = 'deepseek-harness'

/**
 * Deadline for one HTTP request.
 *
 * The status page reads several endpoints at once; without a bound, one stalled
 * response kept the whole page loading with no way to tell what was wrong.
 */
const REQUEST_TIMEOUT_MS = 20_000

/** Refresh an access token this many milliseconds before it would expire. */
const TOKEN_REFRESH_MARGIN_MS = 60_000
/** Poll interval while waiting for the assistant message to finalize. */
const POLL_INTERVAL_MS = 700
/** Smallest accepted poll interval, so a bad config cannot spin. */
const MIN_POLL_INTERVAL_MS = 250

/**
 * Map a thrown fetch failure onto the plugin's failure vocabulary.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError`, and a caller cancellation
 * arrives as an `AbortError`; both would otherwise reach the adapter as an
 * unclassified `UNKNOWN` and lose the distinction between "too slow" and
 * "cancelled".
 * @param error - the rejection from fetch.
 * @param path - the request path, for the message.
 * @param method - the request method, for the message.
 * @returns the error to throw.
 */
function transportError(error, path, method) {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError') {
    return new TodayApiError(
      `Today ${method} ${path} timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`,
      'TIMEOUT',
    )
  }
  if (name === 'AbortError') {
    return new TodayApiError(`Today ${method} ${path} was cancelled`, 'ABORTED')
  }
  return new TodayApiError(
    `Today ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
    'TRANSPORT',
  )
}

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
   * @param options - session credential, region and fetch override.
   * @param options.refreshCredential - the long-lived better-auth session token.
   * @param options.region - `cn` (default) or `global`.
   * @param options.fetch - fetch implementation; defaults to the global.
   */
  constructor({ refreshCredential, region, fetch: fetchImpl }) {
    this.refreshCredential = refreshCredential
    this.fetch = fetchImpl ?? globalThis.fetch
    this.region = region === 'global' ? 'global' : DEFAULT_REGION
    this.hosts = REGION_CONFIG[this.region]
    this.accessToken = undefined
    this.expiresAt = 0
    /** Origin the socket layer derives its URL from. */
    this.apiBaseUrl = this.hosts.apiBaseUrl
    this.authBaseUrl = this.hosts.authBaseUrl
    this.webOrigin = this.hosts.webOrigin
  }

  /**
   * Standard headers for one request.
   *
   * `origin` names the site the call belongs to, so it differs by host: the auth
   * host owns `/api/auth/*`, while the API host is a different origin and must
   * not receive the auth origin. Sending one origin for both was wrong for every
   * API call.
   *
   * The `x-app-version` and `x-client-platform` pair mirrors what the desktop
   * client sends, because that is what the service expects this traffic to be.
   * @param target - which origin this request is bound for.
   * @param extra - additional headers to merge.
   * @returns the header record.
   */
  headers(target, extra = {}) {
    const origin = target === 'api' ? this.webOrigin : this.authBaseUrl
    return {
      accept: 'application/json',
      'accept-language': 'zh-CN,zh;q=0.9',
      origin,
      referer: `${this.webOrigin}/`,
      'user-agent': USER_AGENT,
      'x-app-version': DESKTOP_VERSION,
      'x-client-platform': this.hosts.clientPlatform,
      ...extra,
    }
  }

  /**
   * Build a deadline signal, composed with the caller's cancellation when given.
   *
   * Without this a stalled internal endpoint left the settings page loading
   * forever: the status snapshot fans out to several of them at once, so one
   * hung request held up all of them.
   * @param callerSignal - the caller's cancellation, when any.
   * @returns a signal for one request.
   */
  deadline(callerSignal) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    if (callerSignal === undefined) return timeout
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([callerSignal, timeout]) : timeout
  }

  /**
   * Exchange the stored session for a fresh access token.
   * @returns the bearer token.
   * @throws {TodayApiError} when the session was rejected.
   */
  async mintAccessToken() {
    const response = await this.fetch(`${this.authBaseUrl}/api/auth/token`, {
      method: 'GET',
      signal: this.deadline(undefined),
      headers: this.headers('auth', { authorization: `Bearer ${this.refreshCredential}` }),
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
  async request(path, { retryOnAuth = true, signal, ...init } = {}) {
    const token = await this.token()
    let response
    try {
      response = await this.fetch(`${this.apiBaseUrl}${path}`, {
        ...init,
        signal: this.deadline(signal),
        headers: this.headers('api', { authorization: `Bearer ${token}`, ...init.headers }),
      })
    } catch (error) {
      throw transportError(error, path, init.method ?? 'GET')
    }
    if (response.status === 401 && retryOnAuth) {
      // The JWT is short lived and may have been revoked between mint and use.
      this.accessToken = undefined
      return await this.request(path, { ...init, signal, retryOnAuth: false })
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
