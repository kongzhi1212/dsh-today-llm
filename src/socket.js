/**
 * WebSocket transport for one Today turn.
 *
 * Today pushes the assistant message it is building as `event.push` frames
 * carrying a complete snapshot; this module re-reads the snapshot on every
 * frame and reports only the newly appended text. That is the only way to see
 * a turn before it finishes, because the reply is written in place rather than
 * streamed token by token.
 *
 * The lifecycle mirrors Today's own desktop client:
 *   POST /registry/devices -> POST /ws-ticket -> GET /ws?ticket=...
 *   -> device.hello -> device.heartbeat -> (event.push ...) -> close
 *
 * @module dsh-today-llm/socket
 */

/** How long to wait for the socket handshake before giving up. */
const HANDSHAKE_TIMEOUT_MS = 15_000
/** Fallback heartbeat when the server does not state its interval. */
const DEFAULT_HEARTBEAT_MS = 25_000
/** Smallest heartbeat the server may ask for. */
const MIN_HEARTBEAT_MS = 5_000
/** Safety margin subtracted from the server's heartbeat interval. */
const HEARTBEAT_MARGIN_MS = 5_000

/**
 * Read the accumulated text of one canonical message.
 * @param message - a canonical message snapshot.
 * @returns its visible text.
 */
function textOfMessage(message) {
  const parts = message?.body?.parts
  if (!Array.isArray(parts)) return typeof message?.content === 'string' ? message.content : ''
  return parts
    .map(part => (typeof part?.content?.text === 'string' ? part.content.text : ''))
    .join('')
}

/**
 * One WebSocket connection that reports the progress of a single conversation.
 */
export class TodaySocketStream {
  /**
   * @param options - connection inputs.
   * @param options.apiBaseUrl - the HTTP API origin.
   * @param options.accessToken - bearer token for the REST calls.
   * @param options.deviceId - a stable per-machine id for device registration.
   * @param options.fetch - fetch implementation; defaults to the global.
   * @param options.WebSocket - WebSocket constructor; defaults to the global.
   */
  constructor({ apiBaseUrl, accessToken, deviceId, fetch: fetchImpl, WebSocket: SocketImpl }) {
    this.apiBaseUrl = apiBaseUrl
    this.accessToken = accessToken
    this.machineId = deviceId
    this.fetch = fetchImpl ?? globalThis.fetch
    this.SocketImpl = SocketImpl ?? globalThis.WebSocket
    this.ws = undefined
    this.deviceId = undefined
    this.heartbeat = undefined
    this.closed = false
    /** Text already reported per message id, so deltas stay accurate. */
    this.reported = new Map()
  }

  /**
   * Build the headers every REST call needs.
   * @param json - whether a JSON body is being sent.
   * @returns the header record.
   */
  headers(json) {
    return {
      authorization: `Bearer ${this.accessToken}`,
      accept: 'application/json',
      ...(json === true ? { 'content-type': 'application/json' } : {}),
    }
  }

  /**
   * Register this machine as a Today device.
   *
   * The profile fields mirror the desktop client's own registration body; a
   * shorter body is refused with a validation error.
   * @returns the server-assigned device id.
   */
  async registerDevice() {
    const response = await this.fetch(`${this.apiBaseUrl}/registry/devices`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        name: 'Today Web',
        clientPlatform: 'web',
        clientType: 'web-dashboard',
        platform: process.platform === 'win32' ? 'windows' : process.platform,
        version: '2.0.0',
        notificationEnabled: false,
        clientMachineId: this.machineId,
      }),
    })
    if (!response.ok) throw new Error(`Today device registration failed: HTTP ${response.status}`)
    const body = await response.json()
    const id = body?.device?.id
    if (typeof id !== 'string' || id === '') throw new Error('Today device registration returned no device id')
    return id
  }

  /**
   * Exchange the access token for a one-time socket ticket.
   * @returns the ticket string.
   */
  async ticket() {
    const response = await this.fetch(`${this.apiBaseUrl}/ws-ticket`, {
      method: 'POST',
      headers: this.headers(false),
    })
    if (!response.ok) throw new Error(`Today ws-ticket failed: HTTP ${response.status}`)
    const body = await response.json()
    if (typeof body?.ticket !== 'string' || body.ticket === '') throw new Error('Today ws-ticket returned no ticket')
    return body.ticket
  }

  /**
   * Open the socket and complete the hello handshake.
   * @returns a promise settling once the server acknowledged the hello.
   */
  async connect() {
    this.deviceId = await this.registerDevice()
    const ticket = await this.ticket()
    const base = this.apiBaseUrl.replace(/^http/u, 'ws')
    const url = `${base}/ws?ticket=${encodeURIComponent(ticket)}`

    await new Promise((resolve, reject) => {
      const socket = new this.SocketImpl(url)
      this.ws = socket
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { socket.close() } catch {}
        reject(new Error('Today WebSocket handshake timed out'))
      }, HANDSHAKE_TIMEOUT_MS)

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          type: 'device.hello',
          deviceId: this.deviceId,
          tools: [],
          messageProtocolVersion: 'canonical-v1',
        }))
      })
      socket.addEventListener('message', (event) => {
        let frame
        try { frame = JSON.parse(String(event.data)) } catch { return }
        // Acknowledge every sequenced frame, as the desktop client does; the
        // server stops redelivering only after this arrives.
        if (typeof frame.seq === 'number' && typeof frame.id === 'string') {
          try {
            socket.send(JSON.stringify({
              type: 'client.received',
              originId: frame.id,
              originType: frame.type,
              originSeq: frame.seq,
              originTimestamp: frame.timestamp,
            }))
          } catch {}
        }
        if (frame.type === 'cloud.hello_ack') {
          clearTimeout(timer)
          this.startHeartbeat(frame.heartbeatIntervalMs)
          if (!settled) {
            settled = true
            resolve()
          }
        }
      })
      socket.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error('Today WebSocket failed to connect'))
      })
      socket.addEventListener('close', () => {
        this.stopHeartbeat()
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error('Today WebSocket closed before the handshake completed'))
        }
      })
    })
  }

  /**
   * Keep the connection alive at the interval the server asked for.
   * @param requested - the server's stated interval in milliseconds.
   */
  startHeartbeat(requested) {
    this.stopHeartbeat()
    const interval = typeof requested === 'number' && requested >= MIN_HEARTBEAT_MS
      ? Math.max(MIN_HEARTBEAT_MS, requested - HEARTBEAT_MARGIN_MS)
      : DEFAULT_HEARTBEAT_MS
    this.heartbeat = setInterval(() => {
      if (this.closed || this.ws === undefined) return
      try {
        this.ws.send(JSON.stringify({ type: 'device.heartbeat', deviceId: this.deviceId }))
      } catch {}
    }, interval)
  }

  /** Stop sending heartbeats. */
  stopHeartbeat() {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
  }

  /**
   * Wait for one conversation's turn to finish, reporting text as it appears.
   * @param conversationId - the conversation to watch.
   * @param options - cancellation and deadline.
   * @param options.signal - caller cancellation.
   * @param options.timeoutMs - deadline for the whole turn.
   * @param options.onDelta - called with each newly appended text fragment.
   * @returns the final assistant text.
   */
  async awaitTurn(conversationId, { signal, timeoutMs, onDelta } = {}) {
    const deadline = Date.now() + (timeoutMs ?? 300_000)
    return await new Promise((resolve, reject) => {
      let settled = false
      const finish = (outcome) => {
        if (settled) return
        settled = true
        clearTimeout(deadlineTimer)
        clearInterval(pollTimer)
        signal?.removeEventListener?.('abort', onAbort)
        this.close()
        if (outcome.error !== undefined) reject(outcome.error)
        else resolve(outcome.text)
      }
      const onAbort = () => finish({ error: new Error('Today request cancelled') })
      if (signal?.aborted === true) {
        finish({ error: new Error('Today request cancelled') })
        return
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })

      const deadlineTimer = setTimeout(() => {
        finish({ error: new Error(`Today did not answer within ${Math.round((timeoutMs ?? 300_000) / 1000)}s`) })
      }, Math.max(1, deadline - Date.now()))

      const onFrame = (event) => {
        let frame
        try { frame = JSON.parse(String(event.data)) } catch { return }
        if (frame.type !== 'event.push') return
        const payload = frame.payload
        if (payload?.event !== 'chat.message_ready.v2' && payload?.event !== 'chat.message_updated.v2') return
        const message = payload?.data?.message
        if (message === undefined || message?.conversationId !== conversationId) return
        if (message.role !== 'assistant') return

        const text = textOfMessage(message)
        const reported = this.reported.get(message.id) ?? 0
        if (text.length > reported) {
          onDelta?.(text.slice(reported))
          this.reported.set(message.id, text.length)
        }
        if (message.isFinal === true) {
          if (text.trim() === '') {
            finish({ error: new Error('Today finished the turn without any text') })
            return
          }
          finish({ text })
        }
      }
      this.ws?.addEventListener('message', onFrame)

      // The socket only reports changes the server chooses to push; a fallback
      // poll keeps a dropped frame from stalling the turn forever.
      const pollTimer = setInterval(() => {
        if (settled) return
        if (Date.now() > deadline) return
        const socket = this.ws
        if (socket === undefined || socket.readyState !== 1) {
          finish({ error: new Error('Today WebSocket disconnected during the turn') })
        }
      }, 2_000)
    })
  }

  /** Close the socket and stop all timers. */
  close() {
    this.closed = true
    this.stopHeartbeat()
    this.reported.clear()
    if (this.ws !== undefined) {
      try { this.ws.close() } catch {}
      this.ws = undefined
    }
  }
}
