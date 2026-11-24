/**
 * Tests for the reply protocol.
 *
 * The protocol is the plugin's correctness boundary: Today returns prose, and
 * everything the harness sees is reconstructed from it. A regression here is
 * silent — the turn still "works", it just does the wrong thing.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildPrompt, parseReply } from '../src/protocol.js'

/**
 * Build a one-message harness request.
 * @param content - content blocks for the user message.
 * @param options - builder options.
 * @returns the flattened prompt.
 */
function promptOf(content, options = { strict: true }) {
  return buildPrompt({ messages: [{ role: 'user', content }] }, options)
}

describe('buildPrompt', () => {
  it('forwards plain text unchanged', () => {
    const prompt = promptOf([{ type: 'text', text: 'hello there' }])
    assert.match(prompt, /hello there/)
  })

  it('drops reasoning blocks instead of leaking them into the prompt', () => {
    const prompt = promptOf([
      { type: 'reasoning', text: 'a private chain of thought' },
      { type: 'text', text: 'visible' },
    ])
    assert.doesNotMatch(prompt, /private chain of thought/)
    assert.match(prompt, /visible/)
  })

  it('says an attachment was not forwarded rather than inviting the agent to read it', () => {
    const prompt = promptOf([
      { type: 'text', text: 'what does it say?' },
      { type: 'file', attachment: { name: 'notes.txt' } },
    ])
    assert.match(prompt, /notes\.txt/)
    assert.match(prompt, /NOT forwarded/)
    // The old wording told the agent to use its own file access, which the same
    // protocol forbids. It must not come back.
    assert.doesNotMatch(prompt, /read it with your own file access/)
  })

  it('names an unnamed file without throwing', () => {
    const prompt = promptOf([{ type: 'file', attachment: {} }])
    assert.match(prompt, /unnamed/)
  })

  it('includes the reply protocol in strict mode and omits it otherwise', () => {
    const strict = promptOf([{ type: 'text', text: 'hi' }], { strict: true })
    const loose = promptOf([{ type: 'text', text: 'hi' }], { strict: false })
    assert.match(strict, /tool_call/)
    assert.doesNotMatch(loose, /tool_call/)
  })
})

describe('parseReply', () => {
  it('parses a final answer', () => {
    const parsed = parseReply('{"final": "the answer"}')
    assert.equal(parsed.kind, 'text')
    assert.equal(parsed.text, 'the answer')
  })

  it('parses a tool call', () => {
    const parsed = parseReply('{"tool_call": {"name": "read_file", "arguments": {"path": "a.txt"}}}')
    assert.equal(parsed.kind, 'tool-call')
    assert.equal(parsed.name, 'read_file')
    assert.deepEqual(JSON.parse(parsed.arguments), { path: 'a.txt' })
  })

  it('treats unparseable prose as a final answer rather than a tool call', () => {
    const parsed = parseReply('I think the answer is 42.')
    assert.equal(parsed.kind, 'text')
    assert.match(parsed.text, /42/)
  })

  it('recovers a JSON object embedded in surrounding prose', () => {
    const parsed = parseReply('Sure, here it is:\n{"final": "recovered"}\nHope that helps.')
    assert.equal(parsed.kind, 'text')
    assert.equal(parsed.text, 'recovered')
  })

  it('does not treat an object with neither key as a tool call', () => {
    const parsed = parseReply('{"something": "else"}')
    assert.equal(parsed.kind, 'text')
  })
})
