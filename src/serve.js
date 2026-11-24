/**
 * An OpenAI-compatible endpoint backed by the Today account.
 *
 * This is for the tools that only speak the OpenAI wire protocol — an editor
 * plugin, a terminal assistant — so they can use the same Today quota this
 * plugin already exposes to the harness. It is a thin translation layer, not a
 * second model path: the turn still goes through Today's own agent, with all the
 * limits that implies (no token streaming, the agent's persona, account-wide
 * model selection).
 *
 * Deliberately small: one route, one model name mapping, no tool calling and no
 * embeddings. Advertising capabilities it cannot honour would produce confusing
 * failures in whichever client tried to use them.
 *
 * @module dsh-today-llm/serve
 */

import { createServer } from 'node:http'

import { TodayClient } from './api.js'
import { buildPrompt, parseReply } from './protocol.js'

/** Default port. Chosen high to stay out of the way of common services. */
export const DEFAULT_PORT = 8787
/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * Read a JSON request body.
 * @param req - the incoming request.
 * @returns the parsed body.
 * @throws Error when the body is unparseable or oversized.
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error(`request body over ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/**
 * Flatten an OpenAI `messages` array into the prompt this plugin already builds.
 *
 * The harness content-block shape is reused rather than duplicated, so the
 * protocol rules (including "attachments are not forwarded") stay in one place.
 * @param messages - OpenAI chat messages.
 * @returns the prompt text.
 */
export function promptFromOpenAi(messages) {
  const blocks = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = typeof message?.role === 'string' ? message.role : 'user'
    const text = typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
        : ''
    if (text === '') continue
    // The protocol builder understands assistant turns; a system message is
    // folded into the user turn with a label, because Today has no system slot.
    if (role === 'assistant') blocks.push({ role: 'assistant', content: [{ type: 'text', text }] })
    else if (role === 'system') blocks.push({ role: 'user', content: [{ type: 'text', text: `[system instruction] ${text}` }] })
    else blocks.push({ role: 'user', content: [{ type: 'text', text }] })
  }
  return buildPrompt({ messages: blocks }, { strict: false })
}

/**
 * Map a requested model name onto the catalog.
 *
 * Accepts the harness id, the catalog id, or a display name, so a client that
 * echoes back whatever the models endpoint returned keeps working.
 * @param catalog - the catalog entries.
 * @param requested - the model the client asked for.
 * @returns the option id to pin.
 */
export function resolveOptionId(catalog, requested) {
  if (typeof requested === 'string' && requested !== '') {
    const hit = catalog.find(item => item.optionId === requested)
    if (hit) return hit.optionId
    const bySuffix = catalog.find(item => item.optionId.endsWith(`.${requested}`))
    if (bySuffix) return bySuffix.optionId
    const byName = catalog.find(item => item.name === requested)
    if (byName) return byName.optionId
  }
  return catalog[0]?.optionId
}

/**
 * Write one JSON response.
 * @param res - the server response.
 * @param status - HTTP status.
 * @param payload - JSON body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

/** Write an OpenAI-shaped error. */
function sendError(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type, code: null } })
}

/**
 * Start the proxy.
 * @param options - credential source, port, host and an optional bearer token.
 * @returns a handle with the bound port and a `close` method.
 */
export function startProxy(options) {
  const {
    resolveAccount,
    port = DEFAULT_PORT,
    host = '127.0.0.1',
    token,
    region,
    timeoutMs = 300_000,
    log = () => {},
  } = options

  /** One client per region, reused across requests so the token is not re-minted. */
  const clients = new Map()

  /**
   * Get or build the client for a region.
   * @param regionName - `cn` or `global`.
   * @returns the client.
   */
  const clientFor = (regionName) => {
    let client = clients.get(regionName)
    if (client === undefined) {
      const account = resolveAccount()
      client = new TodayClient({ refreshCredential: account.refreshCredential, region: regionName ?? account.region })
      clients.set(regionName, client)
    }
    return client
  }

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      })
      res.end()
      return
    }

    if (token !== undefined && token !== '') {
      const header = req.headers.authorization ?? ''
      if (header !== `Bearer ${token}`) {
        sendError(res, 401, 'Missing or wrong bearer token.', 'authentication_error')
        return
      }
    }

    const url = new URL(req.url ?? '/', `http://${host}`)
    try {
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const account = resolveAccount()
        const client = clientFor(region ?? account.region)
        const catalog = await client.catalog()
        sendJson(res, 200, {
          object: 'list',
          data: catalog.map(item => ({
            id: item.optionId,
            object: 'model',
            created: 0,
            owned_by: item.publisher?.name ?? 'today',
          })),
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJson(req)
        const account = resolveAccount()
        const client = clientFor(region ?? account.region)
        const catalog = await client.catalog()
        const optionId = resolveOptionId(catalog, body.model)
        if (optionId === undefined) {
          sendError(res, 400, 'No model is available on this Today account.', 'model_not_found')
          return
        }
        await client.selectModel(optionId)
        const prompt = promptFromOpenAi(body.messages)
        const conversationId = await client.startTaskConversation(prompt)
        const reply = await client.awaitReply(conversationId, { timeoutMs })
        const parsed = parseReply(reply)
        const text = parsed.kind === 'text' ? parsed.text : ''
        // A tool call cannot be expressed in this shape, so it is reported as
        // text rather than dropped; silently returning an empty message would
        // look like the model produced nothing.
        const content = text !== '' ? text : `[Today requested a tool the proxy cannot relay: ${parsed.name ?? 'unknown'}]`
        sendJson(res, 200, {
          id: `chatcmpl-${conversationId}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: optionId,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
        return
      }

      sendError(res, 404, `No route for ${req.method} ${url.pathname}`)
    } catch (error) {
      const status = typeof error?.status === 'number' && error.status >= 400 ? error.status : 502
      log(`${req.method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`)
      sendError(res, status === 429 ? 429 : 502, error instanceof Error ? error.message : String(error), 'upstream_error')
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : port,
        host,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}
