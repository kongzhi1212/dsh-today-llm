/**
 * Host half of the Today provider bundle.
 *
 * Registers one `today` LLM route backed by the account the local Today desktop
 * app already signed in. No sign-in flow is started and the desktop app's files
 * are only ever read.
 *
 * The plugin declares a `Config` schema even though every field has a working
 * default: the settings form service skips any loader row without a schema, so
 * a schema-less row could never be edited from the UI.
 *
 * @module dsh-today-llm
 */

import z from '@deepseek-ai/schemastery'
import { TodayAdapter } from './src/adapter.js'
import { readStoredAccount, describeMissingAccount } from './src/credentials.js'

/** The provider route this bundle owns. */
const PROVIDER = 'today'

/**
 * Model visibility and per-model overrides.
 *
 * One entry per model the account can see. A model absent from this list is
 * visible; adding an entry exists only to hide a model or give it a different
 * context budget, so the map starts empty and stays small.
 */
const ModelPreference = z.object({
  hidden: z.boolean().default(false).description('Hide this model from the DSH model selector.'),
  contextWindow: z.number().min(1_000).max(2_000_000).description(
    'Context window to report for this model, in tokens. Leave unset to use the plugin default.',
  ),
})

/**
 * Plugin configuration.
 */
export const Config = z.object({
  timeoutMs: z.number().min(10_000).max(3_600_000).default(300_000)
    .description('How long to wait for one Today turn before giving up, in milliseconds.'),
  pollIntervalMs: z.number().min(250).max(30_000).default(700)
    .description('How often to re-read the Today conversation while a turn is running, in milliseconds.'),
  refreshModelsMs: z.number().min(0).max(86_400_000).default(600_000)
    .description('How often to re-read the Today model catalog, in milliseconds. Zero disables the refresh.'),
  defaultContextWindow: z.number().min(1_000).max(2_000_000).default(200_000)
    .description('Context window reported for every model that sets no override, in tokens.'),
  maxConcurrency: z.number().min(1).max(8).default(1)
    .description(
      'How many Today turns may run at once. Today stores the model choice per account, '
      + 'so more than one lets a turn be retargeted mid-flight; raise it only if you accept that.',
    ),
  strictProtocol: z.boolean().default(true)
    .description(
      'Require the agent to answer with one JSON object so tool calls work. '
      + 'Turn this off for more natural prose, at the cost of tool calls.',
    ),
  useSocket: z.boolean().default(true)
    .description(
      'Receive turns over the pushed event stream instead of polling. '
      + 'Falls back to polling automatically if the connection cannot be made.',
    ),
  reportUsage: z.boolean().default(true)
    .description('Report estimated token counts. Today reports none, so these are approximations.'),
  models: z.dict(ModelPreference).default({})
    .description('Per-model overrides, keyed by model id. Hidden models also leave the selector.'),
})

/** Defaults for every field, used to normalize whatever the loader passed. */
const CONFIG_DEFAULTS = Object.freeze({
  timeoutMs: 300_000,
  pollIntervalMs: 700,
  refreshModelsMs: 600_000,
  defaultContextWindow: 200_000,
  maxConcurrency: 1,
  strictProtocol: true,
  useSocket: true,
  reportUsage: true,
  models: Object.freeze({}),
})

/**
 * Merge the row's config over the defaults, ignoring unusable values.
 *
 * The loader may hand over a partial object (an older patch, a hand-edited
 * row), so every field is validated here rather than trusted.
 * @param raw - the config the loader passed, when any.
 * @returns the resolved config.
 */
function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const number = (key, min, max) => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
      ? value
      : CONFIG_DEFAULTS[key]
  }
  const flag = key => (typeof source[key] === 'boolean' ? source[key] : CONFIG_DEFAULTS[key])
  const models = source.models !== null && typeof source.models === 'object' && !Array.isArray(source.models)
    ? source.models
    : CONFIG_DEFAULTS.models
  return {
    timeoutMs: number('timeoutMs', 10_000, 3_600_000),
    pollIntervalMs: number('pollIntervalMs', 250, 30_000),
    refreshModelsMs: number('refreshModelsMs', 0, 86_400_000),
    defaultContextWindow: number('defaultContextWindow', 1_000, 2_000_000),
    maxConcurrency: number('maxConcurrency', 1, 8),
    strictProtocol: flag('strictProtocol'),
    useSocket: flag('useSocket'),
    reportUsage: flag('reportUsage'),
    models,
  }
}

/**
 * Register the Today provider.
 * @param ctx - the plugin context.
 * @param rawConfig - the row's config, when the patch supplies one.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  /**
   * Return the stored session credential, or explain why there is none.
   * @returns the refresh credential.
   */
  const resolveCredential = () => {
    const stored = readStoredAccount()
    if (stored === undefined) {
      throw new Error(
        'No signed-in Today account was found. Sign in with the Today desktop app, then retry. '
        + describeMissingAccount(),
      )
    }
    return stored.record.refreshCredential
  }

  const adapter = new TodayAdapter({ config, resolveCredential })

  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter))

  // A changed catalog must reach the selector without a restart.
  //
  // Re-reading the catalog is not enough on its own: the model selector keeps
  // its own copy and only reloads when `llm/models-updated(provider)` fires.
  // Without that emit a model Today adds later stays invisible until DSH
  // restarts, which is exactly how a newly released model appeared "missing".
  // The event is emitted whenever the advertised set actually changes, so a
  // steady catalog does not churn every subscriber on each poll.
  let advertised = undefined
  const refresh = async () => {
    try {
      const models = await adapter.listModels()
      const signature = models.map(model => `${model.id}:${model.name}:${model.badge?.text ?? ''}`).join('|')
      if (signature !== advertised) {
        advertised = signature
        ctx.emit('llm/models-updated', PROVIDER)
      }
    } catch (error) {
      ctx.logger?.warn?.(`today: model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void refresh()
  // `ctx.interval` registers its own effect and returns that disposer.
  if (config.refreshModelsMs > 0) ctx.interval(() => { void refresh() }, config.refreshModelsMs)

  // Three JSON endpoints for the Settings page.
  //
  // They are `handler` routes, not `resource` routes: the web server answers a
  // resource with GET and HEAD only and returns 405 for anything else, which
  // would make the two POST endpoints unreachable over real HTTP even though
  // calling the resource directly in a test appears to work.
  //
  // Each one passes the host's own admission check first, so an unauthenticated
  // request is refused exactly as it would be on any other Host route. `admit`
  // takes the raw request, the same way the /api carrier uses it.
  const serve = (path, handle) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      const connection = ctx.get('connection')
      if (connection !== undefined) {
        const admission = connection.admit(req)
        if (admission !== undefined && 'rejection' in admission) {
          res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
      }
      try {
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined
        sendJson(res, 200, await handle({ method: req.method, body }))
      } catch (error) {
        sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  // The Settings page renders from this route.
  serve(STATUS_ROUTE, () => statusSnapshot(adapter, config))

  // Configuration writes go through the settings service, which owns the
  // profile patch: it validates the candidate against this row's Config schema,
  // preserves every other row and comment, and restarts the plugin so `apply`
  // rebuilds from the stored values.
  serve(CONFIG_ROUTE, request => handleConfigWrites(request, ctx))

  // One optional connectivity test, driven only by an explicit user action on
  // the diagnostics section. It is a separate route from CONFIG_ROUTE because it
  // spends a real Today request: keeping the write route free of side effects
  // makes "did this change my setup" answerable without qualification.
  serve(PROBE_ROUTE, request => handleProbe(request, adapter))
}

/**
 * Read a JSON request body from the raw request stream.
 *
 * Bounded, because these routes sit on a server a browser talks to and an
 * unbounded read would let one request hold memory for as long as it likes.
 * @param req - the incoming request.
 * @param limit - maximum accepted bytes.
 * @returns the parsed body, or undefined for an empty body.
 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`Request body exceeds ${limit} bytes.`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? undefined : JSON.parse(text)
}

/**
 * Write one JSON response onto the raw server response.
 * @param res - the server response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * Apply one settings edit from the page.
 *
 * Only the fields this page owns are accepted; anything else is refused rather
 * than merged, so a page bug cannot rewrite unrelated configuration.
 * @param request - the parsed request carrying `{ body: { edits, revision } }`.
 * @param ctx - the plugin context, for the settings service and this row's id.
 * @returns a result describing what was written.
 */
async function handleConfigWrites(request, ctx) {
  if (request.method !== 'POST') return { ok: false, error: 'This route accepts POST only.' }
  const settings = ctx.get('settings')
  if (settings === undefined) return { ok: false, error: 'This profile does not accept configuration edits.' }
  const entry = ctx.fiber?.entry
  if (entry === undefined) return { ok: false, error: 'This plugin is not mounted from a profile row.' }

  const edits = request.body?.edits
  if (edits === null || typeof edits !== 'object' || Array.isArray(edits)) {
    return { ok: false, error: 'Expected an `edits` object.' }
  }
  const rejected = Object.keys(edits).filter(key => !WRITABLE_FIELDS.has(key))
  if (rejected.length > 0) {
    return { ok: false, error: `These fields are not editable from this page: ${rejected.join(', ')}.` }
  }
  try {
    await settings.update(entry.id, edits, request.body?.revision)
    return { ok: true, written: Object.keys(edits) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Fields the settings page may write. */
const WRITABLE_FIELDS = new Set([
  'models',
  'defaultContextWindow',
  'timeoutMs',
  'pollIntervalMs',
  'refreshModelsMs',
  'maxConcurrency',
  'strictProtocol',
  'useSocket',
  'reportUsage',
])

/** Path the Settings page posts configuration edits to. */
export const CONFIG_ROUTE = '/dsh-today-llm/config'

/** Path the diagnostics section posts a single-model connectivity test to. */
export const PROBE_ROUTE = '/dsh-today-llm/probe'

/**
 * Answer one connectivity test.
 *
 * POST only, because the test is a real request that consumes account quota and
 * must never be triggered by a stray navigation or a prefetch.
 * @param request - the parsed request carrying `{ body: { model } }`.
 * @param adapter - the live adapter.
 * @returns the probe outcome, or a refusal.
 */
async function handleProbe(request, adapter) {
  if (request.method !== 'POST') return { ok: false, error: 'This route accepts POST only.' }
  const model = typeof request.body?.model === 'string' ? request.body.model : ''
  if (model === '') return { ok: false, error: 'Expected a `model` string.' }
  return await adapter.probe(model)
}

/**
 * Path the Settings page reads.
 *
 * Deliberately outside `/api`: the connection layer claims that whole prefix
 * with a `prefix` route and answers every request under it itself, so a
 * resource registered at `/api/...` is never reached and the page sees a 404.
 * A `prefix` match beats an `exact` one only because it is the only match —
 * this path belongs to no shipped route.
 */
export const STATUS_ROUTE = '/dsh-today-llm/status'

/**
 * Build one status snapshot for the Settings page.
 *
 * Failures are reported as data rather than as an HTTP error: the page's job
 * includes telling the user *why* nothing works, which it cannot do from a
 * blanket 500.
 * @param adapter - the live adapter.
 * @param config - the resolved plugin config.
 * @returns a JSON-serializable snapshot.
 */
async function statusSnapshot(adapter, config) {
  const base = {
    config,
    fetchedAt: new Date().toISOString(),
  }
  const stored = readStoredAccount()
  if (stored === undefined) {
    return { ...base, ok: false, error: `No signed-in Today account. ${describeMissingAccount()}` }
  }
  const account = {
    identifier: typeof stored.record.user?.identifier === 'string' ? stored.record.user.identifier : undefined,
    dataDir: stored.userDataDir,
    source: typeof stored.record.source === 'string' ? stored.record.source : undefined,
  }
  // The model snapshot is the page's core; the rest is supplementary. A failure
  // in usage, tasks or the diary must not blank out the account section, so each
  // is awaited separately and degrades to its own message.
  const optional = async (read) => {
    try {
      return { value: await read() }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    const { models, selection } = await adapter.snapshot()
    const client = adapter.currentClient()
    const [usage, tasks, diary] = await Promise.all([
      optional(() => client.usage()),
      optional(() => client.tasks(8)),
      optional(() => client.latestDiary()),
    ])
    return {
      ...base,
      ok: true,
      account,
      models,
      selection,
      selectionId: modelIdOf(selection),
      usage,
      tasks,
      diary,
      // Diagnostics come from the adapter's own memory, so they are always
      // available even when every Today call above failed.
      diagnostics: adapter.diagnostics(),
    }
  } catch (error) {
    return {
      ...base,
      ok: false,
      account,
      error: error instanceof Error ? error.message : String(error),
      diagnostics: adapter.diagnostics(),
    }
  }
}

/**
 * Strip the catalog prefix from a model option id.
 * @param optionId - catalog option id.
 * @returns the bare model id, or undefined.
 */
function modelIdOf(optionId) {
  if (typeof optionId !== 'string' || optionId === '') return undefined
  return optionId.startsWith('model.') ? optionId.slice('model.'.length) : optionId
}

/** The services this plugin needs before it can activate. */
export const inject = ['llm', 'timer', 'webServer']
