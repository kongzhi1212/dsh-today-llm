/**
 * Translation between the harness message vocabulary and Today's agent turn.
 *
 * Today exposes no completion endpoint: a turn is one user message sent to the
 * vendor's agent, which owns the system prompt, the model choice and any tool
 * use. The adapter therefore sends a single self-describing prompt and asks the
 * agent to answer with one JSON object, which is parsed back into harness
 * blocks. Anything the agent writes outside that envelope is still delivered as
 * text rather than discarded.
 *
 * @module dsh-today-llm/protocol
 */

/**
 * Marker that introduces the machine-readable reply contract.
 *
 * The first half exists because the Today agent runs inside its own product: it
 * has connectors and file tools of its own, and left to itself it will use them
 * and answer in prose. It cannot be disabled from the API, so the prompt has to
 * forbid them explicitly and insist that anything the turn needs arrives as a
 * harness tool call instead.
 */
const REPLY_PROTOCOL = [
  'You are acting as the language model of DeepSeek Harness, a separate application.',
  '',
  'Rules that override your own habits:',
  '1. Do not call your own tools. Do not read files, run commands, browse, or use connectors,',
  '   even if you have them and the task looks like it needs them.',
  '2. Do not use your own memories or the user profile. Everything you may rely on is in this message.',
  '3. When the task needs an action, request a harness tool. The harness executes it and sends you',
  '   the result in the next message.',
  '4. Never claim you performed an action yourself, and never invent its result. If you did not call a',
  '   tool, you did not read, write, run, or change anything.',
  '',
  'Reply with exactly one JSON object and nothing else: no prose, no markdown fences.',
  '',
  'To call a harness tool:',
  '{"tool_call":{"name":"<tool name>","arguments":{...}}}',
  '',
  'To answer the user:',
  '{"final":"<your answer>"}',
].join('\n')

/**
 * Flatten one harness content block into prompt text.
 * @param block - a content block.
 * @returns the text it contributes, or an empty string.
 */
function blockText(block) {
  switch (block?.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : ''
    case 'reasoning':
      return ''
    case 'image':
      return '[an image was attached; it is not forwarded to this provider]'
    case 'file':
      return `[a file was attached: ${block.attachment?.name ?? 'unnamed'}; read it with your own file access]`
    case 'tool-call':
      return `[assistant requested tool ${block.name} with arguments ${typeof block.arguments === 'string' ? block.arguments : ''}]`
    case 'tool-addition':
    case 'tool-removal':
      return ''
    default:
      return ''
  }
}

/**
 * Render one harness message as a labelled transcript line.
 * @param message - a request message.
 * @returns the rendered line.
 */
function renderMessage(message) {
  const content = message?.content
  if (typeof message?.content === 'string') {
    return `[${message.role ?? message.role}]\n${content}`
  }
  const blocks = Array.isArray(content) ? content : []
  if (message?.role === 'tool') {
    const body = blocks.map(blockText).filter(text => text !== '').join('\n')
    const failed = message.isError === true ? ' (failed)' : ''
    return `[tool result${failed} for ${message.toolCallId ?? 'a call'}]\n${body}`
  }
  const body = blocks.map(blockText).filter(text => text !== '').join('\n')
  return `[${message?.role ?? 'user'}]\n${body}`
}

/**
 * Describe the tools the harness offered, in the shape the reply contract expects.
 * @param tools - tool schemas from the request.
 * @returns the tool catalog text, or an empty string when no tools were offered.
 */
function renderTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const lines = tools.map((tool) => {
    const schema = tool?.parameters === undefined ? '{}' : JSON.stringify(tool.parameters)
    return `- ${tool.name}: ${tool.description ?? ''}\n  arguments JSON Schema: ${schema}`
  })
  return ['Harness tools you may request:', ...lines].join('\n')
}

/**
 * Build the single user message that carries the whole harness request.
 * @param options - the harness request plus the system prompt to prepend.
 * @param behavior - protocol settings.
 * @param behavior.strict - when false, drop the JSON envelope so the agent
 *   answers in prose; tool calls then stop working, which is the documented cost.
 * @returns the prompt text.
 */
export function buildPrompt(options, behavior = {}) {
  const strict = behavior.strict !== false
  const sections = []
  if (typeof options.system === 'string' && options.system.trim() !== '') {
    sections.push(`# System instructions\n\n${options.system.trim()}`)
  }
  const tools = strict ? renderTools(options.tools) : ''
  if (tools !== '') sections.push(`# Tools\n\n${tools}`)
  if (strict) sections.push(`# Reply protocol\n\n${REPLY_PROTOCOL}`)
  const transcript = (options.messages ?? []).map(renderMessage).filter(line => line.trim() !== '')
  if (transcript.length > 0) sections.push(`# Conversation\n\n${transcript.join('\n\n')}`)
  return sections.join('\n\n')
}

/**
 * Strip a leading or trailing markdown fence from a reply.
 * @param text - the raw agent reply.
 * @returns the text without a fenced-code wrapper.
 */
function unfence(text) {
  const trimmed = text.trim()
  const match = /^```(?:[a-z0-9_-]+)?\s*\n([\s\S]*?)\n?```$/iu.exec(trimmed)
  return match === null ? trimmed : match[1].trim()
}

/**
 * Locate the outermost balanced JSON object in arbitrary text.
 * @param text - text that may surround the object.
 * @returns the substring holding the object, or undefined.
 */
function extractObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/**
 * Parse an agent reply into either one tool call or final text.
 *
 * A reply that does not satisfy the contract is returned as final text: the
 * agent usually ignored the envelope and answered the user directly, and
 * dropping that answer would be worse than delivering unparsed prose.
 * @param raw - the agent's reply text.
 * @returns the parsed outcome.
 */
export function parseReply(raw) {
  const candidate = extractObject(unfence(raw))
  if (candidate !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      parsed = undefined
    }
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
      const call = parsed.tool_call ?? parsed.toolCall
      if (call !== undefined && call !== null && typeof call === 'object' && typeof call.name === 'string' && call.name !== '') {
        const args = call.arguments ?? call.args
        return {
          kind: 'tool-call',
          name: call.name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        }
      }
      const final = parsed.final ?? parsed.answer
      if (typeof final === 'string') return { kind: 'text', text: final }
    }
  }
  return { kind: 'text', text: raw.trim() }
}

/**
 * Render an assistant tool call back into prompt text for the next turn.
 * @param name - tool name.
 * @param args - raw JSON argument string.
 * @returns the transcript line describing the earlier call.
 */
export function renderToolCall(name, args) {
  return `[assistant tool call ${name}]\n${args}`
}
