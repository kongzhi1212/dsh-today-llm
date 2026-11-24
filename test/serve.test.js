/**
 * Tests for the OpenAI-compatible translation layer.
 *
 * The HTTP surface is checked against a live account by hand; what is pinned
 * here is the part that fails quietly — turning another tool's message list into
 * a Today prompt, and finding the model that client asked for.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { promptFromOpenAi, resolveOptionId } from '../src/serve.js'

const CATALOG = [
  { optionId: 'model.deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { optionId: 'model.glm-5.3', name: 'GLM 5.3' },
]

describe('promptFromOpenAi', () => {
  it('forwards a plain user turn', () => {
    const prompt = promptFromOpenAi([{ role: 'user', content: 'hello' }])
    assert.match(prompt, /hello/)
  })

  it('keeps assistant turns so the model sees alternation', () => {
    const prompt = promptFromOpenAi([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
    assert.match(prompt, /first/)
    assert.match(prompt, /second/)
    assert.match(prompt, /third/)
  })

  it('labels a system turn, because Today has no system slot', () => {
    const prompt = promptFromOpenAi([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ])
    assert.match(prompt, /system instruction/)
    assert.match(prompt, /be terse/)
  })

  it('joins the array content shape', () => {
    const prompt = promptFromOpenAi([{ role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: ' part two' }] }])
    assert.match(prompt, /part one part two/)
  })

  it('skips empty messages rather than emitting blank turns', () => {
    const prompt = promptFromOpenAi([
      { role: 'user', content: '' },
      { role: 'user', content: 'the only real turn' },
    ])
    assert.match(prompt, /the only real turn/)
    assert.doesNotMatch(prompt, /\n\n\n\n/)
  })

  it('survives a malformed messages field', () => {
    assert.doesNotThrow(() => promptFromOpenAi(undefined))
    assert.doesNotThrow(() => promptFromOpenAi('not an array'))
  })
})

describe('resolveOptionId', () => {
  it('accepts the catalog id', () => {
    assert.equal(resolveOptionId(CATALOG, 'model.glm-5.3'), 'model.glm-5.3')
  })

  it('accepts the bare model id', () => {
    assert.equal(resolveOptionId(CATALOG, 'glm-5.3'), 'model.glm-5.3')
  })

  it('accepts the display name', () => {
    assert.equal(resolveOptionId(CATALOG, 'DeepSeek V4.1 Flash'), 'model.deepseek-v4.1-flash')
  })

  it('falls back to the first model for an unknown name', () => {
    assert.equal(resolveOptionId(CATALOG, 'no-such-model'), CATALOG[0].optionId)
  })

  it('returns undefined when the catalog is empty', () => {
    assert.equal(resolveOptionId([], 'glm-5.3'), undefined)
  })
})
