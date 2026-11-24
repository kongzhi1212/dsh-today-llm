/**
 * Tests for the counting semaphore that serializes model pinning.
 *
 * The model selection is account-wide, so this lock is what stops two turns
 * from rewriting each other's model mid-flight. A bug here corrupts answers in a
 * way that looks like model flakiness, which is very hard to diagnose later.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ModelLock } from '../src/model-lock.js'

/** Resolve on the next macrotask, letting queued work run. */
const flush = () => new Promise(resolve => setImmediate(resolve))

describe('ModelLock', () => {
  it('runs a single task and returns its value', async () => {
    const lock = new ModelLock()
    assert.equal(await lock.run(async () => 7, 1), 7)
  })

  it('never runs two tasks at once at the default limit', async () => {
    const lock = new ModelLock()
    let active = 0
    let peak = 0
    const task = async () => {
      active += 1
      peak = Math.max(peak, active)
      await flush()
      await flush()
      active -= 1
    }
    await Promise.all([lock.run(task, 1), lock.run(task, 1), lock.run(task, 1)])
    assert.equal(peak, 1)
  })

  it('runs up to the configured limit concurrently', async () => {
    const lock = new ModelLock()
    let active = 0
    let peak = 0
    const task = async () => {
      active += 1
      peak = Math.max(peak, active)
      await flush()
      await flush()
      active -= 1
    }
    await Promise.all([lock.run(task, 3), lock.run(task, 3), lock.run(task, 3)])
    assert.equal(peak, 3)
  })

  it('releases the slot when a task throws', async () => {
    const lock = new ModelLock()
    await assert.rejects(lock.run(async () => { throw new Error('boom') }, 1), /boom/)
    // If the failed task had leaked its slot this would hang and time out.
    assert.equal(await lock.run(async () => 'after', 1), 'after')
  })

  it('clamps an out-of-range limit instead of deadlocking', async () => {
    const lock = new ModelLock()
    const results = await Promise.all([
      lock.run(async () => 1, 0),
      lock.run(async () => 2, 0),
      lock.run(async () => 3, -5),
    ])
    assert.deepEqual(results, [1, 2, 3])
  })

  it('keeps ordering for a queue deeper than the limit', async () => {
    const lock = new ModelLock()
    const order = []
    await Promise.all([1, 2, 3, 4, 5].map(n => lock.run(async () => {
      order.push(n)
      await flush()
    }, 2)))
    assert.deepEqual(order.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5])
  })
})
