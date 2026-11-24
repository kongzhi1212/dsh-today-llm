/**
 * The adapter that drives the Today agent.
 *
 * Shape of one call:
 * 1. resolve the account and pin the model the harness asked for;
 * 2. send the whole harness request as one prompt to a fresh task conversation;
 * 3. poll that conversation until the assistant message finalizes;
 * 4. translate the reply into harness stream chunks.
 *
 * Today streams nothing: the assistant message appears once, already complete.
 * The adapter therefore emits one text block carrying the whole answer.
 *
 * ### Why this file imports nothing from the harness
 *
 * A bundle installed into a profile resolves its own dependencies, and the
 * harness packages are not part of a profile's dependency tree — an
 * `import '@deepseek-ai/dsh-llm'` here would only resolve when this package
 * happens to sit inside the harness installation. Nothing the harness needs from
 * an adapter requires that import: `LlmAdapter` is a documentation base class
 * that `registerAdapter` never checks with `instanceof`, and failures are
 * normalized from any thrown `Error` by its own `code` property. Duck-typing the
 * contract keeps the bundle installable from an ordinary directory.
 *
 * @module dsh-today-llm/adapter
 */

import { createHash } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { TodayClient, TodayApiError } from './api.js'
import { buildPrompt, parseReply } from './protocol.js'
import { ModelLock } from './model-lock.js'
import { TodaySocketStream } from './socket.js'

/** Harness reasoning-effort id accepted by every Today model. */
const EFFORT_NONE = 'none'
/** Harness reasoning-effort id that asks the agent to think harder. */
const EFFORT_DEEP = 'deep'

/** Consecutive socket failures before the event stream pauses. */
const MAX_SOCKET_FAILURES = 3

/** How long the event stream stays paused before it is retried. */
const SOCKET_COOLDOWN_MS = 5 * 60_000

/** How many turns the diagnostics view keeps. */
const MAX_TURNS = 20

/**
 * Derive a machine-stable device id.
 *
 * Today registers a device per `clientMachineId`, so a random value would add a
 * new device to the account on every restart. This hashes what identifies the
 * install — host, user and profile — into the UUID shape the service expects, so
 * the same install keeps one identity and two profiles stay distinct.
 * @param profile - the Harness profile name, when the runtime exposes one.
 * @returns a stable UUID-shaped string.
 */
function deriveDeviceId(profile) {
  let user = 'unknown'
  try {
    user = userInfo().username
  } catch {
    // A container without a user database still gets a stable id.
  }
  let host = 'unknown'
  try {
    host = hostname()
  } catch {
    // Same fallback as above.
  }
  const digest = createHash('sha256')
    .update(['dsh-today-llm', process.platform, host, user, profile ?? ''].join('\u0000'))
    .digest()
  // Shape the first 16 bytes as a version-4-looking UUID; the version nibble is
  // marked as derived (v5-style) rather than random so it is self-describing.
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Context window reported for every Today model. */
const CONTEXT_WINDOW = 200_000
/** Output cap reported for every Today model. */
const MAX_OUTPUT_TOKENS = 8_192

/** Catalog option prefix the API uses for built-in models. */
const OFFICIAL_PREFIX = 'model.'

/**
 * Resolved, frozen retry policy for this route.
 *
 * `registerAdapter` validates this value with the runtime's resolved-policy
 * rules, which reject the unresolved configuration shape, so the backoff fields
 * are spelled out here rather than nested under `backoff`.
 */
const RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT']),
  initialDelayMs: 1_000,
  maxDelayMs: 15_000,
  jitterRatio: 0.1,
})

/** Display names for ids the catalog reports, so the selector reads naturally. */
const DISPLAY_NAMES = new Map([
  ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
  ['deepseek-v4-flash', 'DeepSeek V4 Flash'],
  ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['glm-5.3', 'GLM 5.3'],
  ['glm-5.3-flash', 'GLM 5.3 Flash'],
  ['glm-5.2', 'GLM 5.2'],
  ['glm-5.1', 'GLM 5.1'],
  ['minimax-m31-flash', 'MiniMax M3.1 Flash'],
  ['minimax-m3.1-flash', 'MiniMax M3.1 Flash'],
  ['minimax-m3', 'MiniMax M3'],
  ['kimi-k3.1-pro', 'Kimi K3.1 Pro'],
  ['kimi-k3.1-pro-highspeed', 'Kimi K3.1 Pro Highspeed'],
  ['kimi-k2.6', 'Kimi K2.6'],
  ['qwen3.8-max', 'Qwen3.8 Max'],
  ['qwen3.7-max', 'Qwen3.7 Max'],
  ['qwen3.7-plus', 'Qwen3.7 Plus'],
])

/**
 * Turn a catalog option id into the model id the harness shows.
 * @param optionId - catalog id such as `model.glm-5.3`.
 * @returns the bare model id.
 */
function modelIdOf(optionId) {
  return typeof optionId === 'string' && optionId.startsWith(OFFICIAL_PREFIX)
    ? optionId.slice(OFFICIAL_PREFIX.length)
    : String(optionId ?? '')
}

/**
 * Turn a harness model id back into the catalog option id.
 * @param model - the harness model id.
 * @returns the catalog option id to send upstream.
 */
function optionIdOf(model) {
  return typeof model === 'string' && model.startsWith(OFFICIAL_PREFIX) ? model : `${OFFICIAL_PREFIX}${model}`
}

/**
 * Render the usage multiplier from a catalog description, e.g. `4× usage`.
 * @param description - the catalog description.
 * @returns the multiplier text, or undefined when the catalog states none.
 */
function multiplierOf(description) {
  if (typeof description !== 'string') return undefined
  const match = /(\d+(?:\.\d+)?)\s*[×x]\s*usage/iu.exec(description)
  return match === null ? undefined : `${match[1]}×`
}

/**
 * Approximate a token count for mixed CJK and Latin text.
 *
 * Today discloses no usage numbers, and the harness token meter feeds on these
 * chunks. Reporting zeros would make every turn look free and would keep
 * context-pressure compaction from ever firing, so a rough count is the better
 * answer.
 * @param text - the text to measure.
 * @returns the approximate count.
 */
function approximateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/u.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / 1.5 + other / 3.6)
}

/**
 * Estimate token counts from the prompt and the reply.
 * @param prompt - the prompt text that was sent.
 * @param reply - the reply text received.
 * @returns the usage record.
 */
function estimateUsage(prompt, reply) {
  return { inputTokens: approximateTokens(prompt), outputTokens: approximateTokens(reply) }
}

/**
 * Adapter serving the single `today` provider route.
 */
export class TodayAdapter {
  /**
   * @param options - provider wiring.
   * @param options.config - resolved plugin config.
   * @param options.resolveCredential - returns the refresh credential, or throws a diagnosable error.
   */
  constructor({ config, resolveCredential }) {
    this.config = config
    this.resolveCredential = resolveCredential
    this.catalog = []
    this.selection = undefined
    this.client = undefined
    this.modelLock = new ModelLock()
    /** Consecutive event-stream failures, used to pause a broken channel. */
    this.socketFailures = 0
    /**
     * When the paused event stream may be retried.
     *
     * Kept beside the config rather than written into it: a transport failure is
     * not a user preference, and mutating `config.useSocket` made the settings
     * page report a switch the user never touched, with no way back short of a
     * restart. A cooldown retries on its own once the channel may have recovered.
     */
    this.socketDisabledUntil = 0
    /**
     * A machine id that is stable for this install.
     *
     * Today keys device registration on it. A random value — what this used to
     * be — registered a new device on every DSH restart, which piles up in the
     * account's device list. The configured value wins when present, so a user
     * who needs a fixed id can set one.
     */
    this.socketDeviceId = typeof config.deviceId === 'string' && config.deviceId.trim() !== ''
      ? config.deviceId.trim()
      : deriveDeviceId(process.env.DSH_PROFILE)
    /**
     * The last few turns, newest last.
     *
     * Every failure this plugin can produce — a rejected session, a model the
     * account cannot use, a socket that silently fell back to polling — is
     * otherwise invisible: the user sees a generic error or a slow answer and
     * has nothing to go on. Keeping the recent turns turns that into a readable
     * list. Bounded so a long session cannot grow it without limit.
     */
    this.turns = []
  }

  /**
   * Record one finished turn.
   * @param record - what the turn did; `ok` is inferred from `errorCode`.
   */
  record(record) {
    this.turns.push(Object.freeze({
      at: new Date().toISOString(),
      ...record,
      ok: record.errorCode === undefined,
    }))
    if (this.turns.length > MAX_TURNS) this.turns.splice(0, this.turns.length - MAX_TURNS)
  }

  /**
   * Whether the event stream may be used right now.
   *
   * Two independent reasons can stop it: the user switched it off, or a cooldown
   * is still running after repeated transport failures.
   * @returns whether a turn should try the socket.
   */
  socketAllowed() {
    if (this.config.useSocket === false) return false
    return Date.now() >= this.socketDisabledUntil
  }

  /**
   * Read the recorded turns plus the connection facts beside them.
   * @returns a detached diagnostics view.
   */
  diagnostics() {
    const paused = this.config.useSocket !== false && Date.now() < this.socketDisabledUntil
    return {
      turns: this.turns.map(turn => ({ ...turn })),
      socket: {
        enabled: this.socketAllowed(),
        failures: this.socketFailures,
        paused,
        retryInMs: paused ? Math.max(0, this.socketDisabledUntil - Date.now()) : 0,
        deviceId: this.socketDeviceId,
      },
    }
  }

  /**
   * Return the cached client, building one from the stored account when needed.
   * @returns the authenticated client.
   */
  currentClient() {
    if (this.client !== undefined) return this.client
    this.client = new TodayClient({ refreshCredential: this.resolveCredential() })
    return this.client
  }

  /**
   * Describe this provider route.
   * @param provider - the registered route.
   * @returns display metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: 'Today' }
  }

  /**
   * Retry policy captured at registration.
   * @returns the resolved policy.
   */
  providerRetryPolicy() {
    return RETRY_POLICY
  }

  /**
   * Declare no provider-side image pricing.
   *
   * Every Today route is text-only, so no request carries an image the provider
   * could charge visual tokens for. The runtime calls this method without
   * checking that it exists — it reads the adapter straight out of the registry
   * — so returning `undefined` here is required, not optional.
   * @returns always undefined.
   */
  imageRequestPricing() {
    return undefined
  }

  /**
   * Project one image for this adapter's request serializer.
   *
   * Text-only routes receive no image bytes at all: request assembly replaces
   * every durable image with placeholder text before dispatch, so this is never
   * reached with a value that must be honoured. The identity projection is
   * returned anyway because the runtime resolves it synchronously on paths that
   * price durable history whose route may have changed since.
   * @param _provider - registered provider route.
   * @param _model - exact model id.
   * @param image - the normalized image whose projection is being resolved.
   * @returns the image's own dimensions and byte count, unchanged.
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /**
   * Read the model catalog and remember the account's current selection.
   *
   * Models the user hid are dropped here rather than filtered at every call
   * site, so the selector, the resolver and the settings page all agree.
   * @returns the models this account may choose.
   */
  async listModels() {
    const client = this.currentClient()
    const items = await client.catalog()
    this.selection = await client.selection().catch(() => undefined)
    this.catalog = items
      .map((item) => {
        const id = modelIdOf(item.optionId)
        const multiplier = multiplierOf(item.description)
        return {
          provider: 'today',
          id,
          name: DISPLAY_NAMES.get(id) ?? item.name ?? id,
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
          inputModalities: ['text'],
          ...(multiplier === undefined ? {} : { badge: { text: multiplier, tone: 'neutral' } }),
        }
      })
      .filter(model => this.preference(model.id).hidden !== true)
    return this.catalog
  }

  /**
   * Read the effective override for one model.
   * @param model - exact model id.
   * @returns the override object, empty when the user set none.
   */
  preference(model) {
    const entry = this.config.models?.[model]
    return entry !== null && typeof entry === 'object' ? entry : {}
  }

  /**
   * Read a fresh view of the account's model state for a settings surface.
   *
   * This is a live read rather than a cache read: the settings page exists to
   * answer "which account, which models, which one is active right now", and
   * Today stores that selection server-side where it can change from another
   * device between refreshes.
   * @returns the catalog plus the account's current selection.
   */
  async snapshot() {
    const client = this.currentClient()
    const items = await client.catalog()
    const selection = await client.selection()
    const models = items.map((item) => {
      const id = modelIdOf(item.optionId)
      return {
        id,
        optionId: typeof item.optionId === 'string' ? item.optionId : `${OFFICIAL_PREFIX}${id}`,
        name: DISPLAY_NAMES.get(id) ?? item.name ?? id,
        multiplier: multiplierOf(item.description),
        active: typeof item.optionId === 'string' && item.optionId === selection,
      }
    })
    this.selection = selection
    // Deliberately NOT writing `this.catalog` here. The settings page wants the
    // complete catalog including models the user hid, while `this.catalog` is
    // the advertised set that `listModels()` keeps filtered and carries
    // descriptions. Overwriting it from here dropped both facts and made a
    // hidden model reappear in later lookups.
    return { models, selection }
  }

  /**
   * Run one minimal turn against a single model, for the diagnostics page.
   *
   * This spends a real Today request, so the caller decides when to call it;
   * nothing here is invoked on a timer.
   * @param model - the model to probe.
   * @param options - cancellation.
   * @returns the outcome with how long it took and which path carried it.
   */
  async probe(model, options = {}) {
    const client = this.currentClient()
    const startedAt = Date.now()
    try {
      const outcome = await this.modelLock.run(async () => {
        await this.pinModel(model, client)
        const conversationId = await client.startTaskConversation('只回复两个字：可用')
        return await this.awaitTurn(client, conversationId, {
          signal: options.signal,
          timeoutMs: Math.min(this.config.timeoutMs, 120_000),
        })
      }, this.config.maxConcurrency)
      return {
        ok: true,
        model,
        ms: Date.now() - startedAt,
        path: outcome.path,
        reply: outcome.text.slice(0, 80),
      }
    } catch (error) {
      const failure = toFailure(error)
      return {
        ok: false,
        model,
        ms: Date.now() - startedAt,
        errorCode: failure.failure?.code ?? 'UNKNOWN',
        error: failure.message,
      }
    }
  }

  /**
   * Resolve one model's metadata.
   * @param provider - the registered route.
   * @param model - exact model id.
   * @returns the resolved metadata.
   */
  async resolveModel(provider, model) {
    if (this.catalog.length === 0) await this.listModels().catch(() => {})
    const known = this.catalog.find(entry => entry.id === model)
    const preference = this.preference(model)
    const contextWindow = typeof preference.contextWindow === 'number'
      ? preference.contextWindow
      : this.config.defaultContextWindow ?? CONTEXT_WINDOW
    return {
      provider,
      id: model,
      name: known?.name ?? DISPLAY_NAMES.get(model) ?? model,
      ...(known?.description === undefined ? {} : { description: known.description }),
      inputModalities: ['text'],
      context: { contextWindow },
      defaultMaxTokens: MAX_OUTPUT_TOKENS,
      reasoning: {
        efforts: [
          { id: EFFORT_NONE, name: 'Standard' },
          { id: EFFORT_DEEP, name: 'Deep' },
        ],
        defaultEffort: EFFORT_NONE,
      },
    }
  }

  /**
   * Bind one model's metadata to its dispatch.
   *
   * The runtime calls this for every call and dispatches through the returned
   * `stream`, so an adapter that omits it cannot be used at all. This adapter
   * has no dynamic connection state to pin per generation — the account is
   * re-read on every request — so binding is just the model resolution.
   * @param provider - the registered route.
   * @param model - exact model id.
   * @param signal - cancellation for the metadata lookup.
   * @returns the model metadata and the stream entry point.
   */
  async prepareCall(provider, model, signal) {
    const info = await this.resolveModel(provider, model, signal)
    return { model: info, stream: options => this.stream(options) }
  }

  /**
   * Pin the account's active model to the one this request named.
   *
   * Today keeps one server-side selection per account, so this is the only way
   * the choice made in the harness reaches the turn. A selection that already
   * matches is left alone to avoid a pointless write.
   * @param model - the model this request asked for.
   * @param client - the authenticated client.
   */
  async pinModel(model, client) {
    const optionId = optionIdOf(model)
    if (this.selection === optionId) return
    await client.selectModel(optionId)
    this.selection = optionId
  }

  /**
   * Wait for one turn's reply, preferring the pushed event stream.
   *
   * The WebSocket reports the turn as soon as Today writes it, which is earlier
   * and cheaper than polling. It is not required for correctness, so any
   * handshake failure falls back to the HTTP poll rather than failing the call:
   * a flaky socket must not cost the user their answer.
   * @param client - the authenticated client.
   * @param conversationId - conversation to observe.
   * @param options - the harness request, for cancellation.
   * @returns the final assistant text.
   */
  async awaitTurn(client, conversationId, options) {
    const settings = {
      signal: options.signal,
      timeoutMs: this.config.timeoutMs,
      pollIntervalMs: this.config.pollIntervalMs,
    }
    if (this.socketAllowed()) {
      const stream = new TodaySocketStream({
        apiBaseUrl: client.apiBaseUrl,
        accessToken: await client.token(),
        deviceId: this.socketDeviceId,
      })
      try {
        await stream.connect()
        const text = await stream.awaitTurn(conversationId, settings)
        // A successful socket turn clears the failure streak: the count exists to
        // pause a broken channel, not to remember old bad luck.
        this.socketFailures = 0
        this.socketDisabledUntil = 0
        return { text, path: 'socket' }
      } catch (error) {
        if (options.signal?.aborted === true) throw error
        this.socketFailures += 1
        // After repeated failures the channel is paused rather than abandoned:
        // mutating the user's config made the settings page show a switch they
        // never touched, and nothing ever retried. A cooldown retries on its own.
        if (this.socketFailures >= MAX_SOCKET_FAILURES) {
          this.socketDisabledUntil = Date.now() + SOCKET_COOLDOWN_MS
          this.socketFailures = 0
        }
        console.warn(`[dsh-today-llm] event stream unavailable, falling back to polling: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        stream.close()
      }
    }
    const reason = this.config.useSocket === false
      ? 'poll'
      : Date.now() < this.socketDisabledUntil ? 'poll (paused)' : 'poll (fallback)'
    return { text: await client.awaitReply(conversationId, settings), path: reason }
  }

  /**
   * Run one harness request through the Today agent.
   *
   * The reply is collected in full before it is classified, because a tool call
   * has to be parsed out of the whole text: emitting deltas as they arrive would
   * put the raw protocol envelope on screen. Deltas are therefore used only to
   * keep the turn alive, and the final text is yielded once.
   * @param options - the assembled harness request.
   * @returns the chunk stream.
   */
  async *stream(options) {
    const client = this.currentClient()
    let reply
    let prompt
    let path = 'unknown'
    const startedAt = Date.now()
    try {
      prompt = buildPrompt(options, { strict: this.config.strictProtocol !== false })
      // The model selection is account-wide, so the whole pin-and-observe
      // sequence holds the lock; releasing it earlier would let a concurrent
      // turn retarget the model before this conversation finished. The pool
      // starts at one for that reason; raising it is a deliberate trade.
      const outcome = await this.modelLock.run(async () => {
        await this.pinModel(options.model, client)
        const conversationId = await client.startTaskConversation(prompt)
        return await this.awaitTurn(client, conversationId, options)
      }, this.config.maxConcurrency)
      reply = outcome.text
      path = outcome.path
    } catch (error) {
      const failure = toFailure(error)
      this.record({
        model: options.model,
        path,
        ms: Date.now() - startedAt,
        errorCode: failure.failure?.code ?? 'UNKNOWN',
        errorMessage: failure.message,
      })
      throw failure
    }

    const parsed = parseReply(reply)
    this.record({
      model: options.model,
      path,
      ms: Date.now() - startedAt,
      outcome: parsed.kind === 'tool-call' ? 'tool-call' : 'text',
    })
    const usage = () => (this.config.reportUsage === false ? undefined : estimateUsage(prompt, reply))
    if (parsed.kind === 'tool-call') {
      const callId = `today_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: parsed.name, argumentsDelta: parsed.arguments }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: callId, name: parsed.name, arguments: parsed.arguments },
      }
      const counted = usage()
      if (counted !== undefined) yield { type: 'usage', usage: counted }
      yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState: REPLAY('tool_calls') }
      return
    }

    if (parsed.text === '') {
      throw toFailure(new TodayApiError('Today finished the turn without any text', 'EMPTY_RESPONSE'))
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: parsed.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: parsed.text } }
    const counted = usage()
    if (counted !== undefined) yield { type: 'usage', usage: counted }
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: REPLAY('stop') }
  }
}

/**
 * Adapter-private replay metadata carried on a successful finish chunk.
 * @param stop - the native stop label.
 * @returns the replay envelope.
 */
function REPLAY(stop) {
  return { response: { provider: 'today', stop } }
}

/**
 * Convert any thrown value into a failure the runtime will classify.
 *
 * `normalizeLlmFailure` prefers an own `failure` snapshot whose `code` equals
 * the error's own `code`; anything else degrades to `UNKNOWN`. Both are
 * therefore attached as data properties (never accessors) so the runtime can
 * read them without invoking getters and without importing a harness class.
 * @param error - the observed failure.
 * @returns the error to throw.
 */
export function toFailure(error) {
  if (error instanceof TodayApiError) {
    const status = error.status
    return annotate(new Error(error.message), error.code, status)
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return annotate(error, 'ABORTED')
    if (typeof error.code === 'string' && error.code !== 'UNKNOWN') return annotate(error, error.code)
    return annotate(error, 'UNKNOWN')
  }
  return annotate(new Error(String(error)), 'UNKNOWN')
}

/**
 * Attach the failure code, and the matching failure snapshot, to one error.
 * @param error - the error to annotate.
 * @param code - the harness failure code.
 * @param status - the HTTP status, when one was observed.
 * @returns the same error.
 */
function annotate(error, code, status) {
  const failure = {
    message: error.message,
    code,
    ...(typeof status === 'number' ? { status } : {}),
  }
  Object.defineProperties(error, {
    code: { value: code, enumerable: true, configurable: true },
    failure: { value: Object.freeze(failure), enumerable: true, configurable: true },
  })
  return error
}
