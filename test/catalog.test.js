/**
 * Tests for catalog interpretation.
 *
 * Today localizes the catalog description, and the plugin parses the usage
 * multiplier out of it. That made the badge depend on upstream wording: when the
 * client began asking for Chinese, the service switched from `4× usage` to
 * `消耗 4 倍` and every multiplier silently disappeared from both the model
 * selector and the settings page. These cases pin both shapes.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { multiplierOf } from '../src/adapter.js'

describe('multiplierOf', () => {
  it('reads the English shape', () => {
    assert.equal(multiplierOf('4× usage'), '4×')
    assert.equal(multiplierOf('1× usage | Chat and task are free'), '1×')
    assert.equal(multiplierOf('16x usage'), '16×')
  })

  it('reads the Chinese shape', () => {
    assert.equal(multiplierOf('消耗 4 倍'), '4×')
    assert.equal(multiplierOf('消耗 1 倍 | 对话、任务执行免费'), '1×')
    assert.equal(multiplierOf('消耗 16 倍'), '16×')
  })

  it('accepts a bare unit word without a prefix', () => {
    assert.equal(multiplierOf('4 倍'), '4×')
  })

  it('keeps a fractional multiplier', () => {
    assert.equal(multiplierOf('0.5× usage'), '0.5×')
    assert.equal(multiplierOf('消耗 0.5 倍'), '0.5×')
  })

  it('returns undefined when the description states no price', () => {
    assert.equal(multiplierOf('Chat and task are free'), undefined)
    assert.equal(multiplierOf('对话、任务执行免费'), undefined)
    assert.equal(multiplierOf(''), undefined)
  })

  it('returns undefined for a non-string description', () => {
    assert.equal(multiplierOf(undefined), undefined)
    assert.equal(multiplierOf(null), undefined)
    assert.equal(multiplierOf(4), undefined)
  })

  it('does not mistake an unrelated number for a multiplier', () => {
    assert.equal(multiplierOf('Supports a 200000 token window'), undefined)
  })
})
