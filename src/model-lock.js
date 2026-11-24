/**
 * Caps concurrent access to the one server-side model selection.
 *
 * Today stores the active model once per account, not once per conversation,
 * and its message endpoint ignores any per-request model field. Selecting a
 * model is therefore a global mutation, and two overlapping turns that want
 * different models would race: the second write would silently retarget the
 * first turn's conversation before its assistant message finalized.
 *
 * The default limit is one, which makes "pin the model, run the turn, observe
 * the reply" atomic. A higher limit is offered because it is occasionally the
 * right trade — two turns on the *same* model cannot retarget each other — but
 * it is not the default, and the caller has to ask for it.
 *
 * @module dsh-today-llm/model-lock
 */

/**
 * Clamp a requested concurrency limit to a usable integer.
 * @param value - requested limit.
 * @returns one through eight.
 */
function normalizeLimit(value, fallback = 1) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(8, Math.max(1, number))
}

/**
 * A counting semaphore whose waiters are served in arrival order.
 */
export class ModelLock {
  /**
   * @param limit - how many operations may run at once; one serializes.
   */
  constructor(limit = 1) {
    /** Operations currently holding a slot. */
    this.active = 0
    /** Queued waiters, each resolved when it may take a slot. */
    this.queue = []
    /** How many operations are holding or waiting, for diagnostics. */
    this.waiting = 0
    this.limit = normalizeLimit(limit)
  }

  /**
   * Take one slot, waiting until one is free.
   * @param limit - effective limit for this acquisition.
   * @returns a function releasing the slot.
   */
  async acquire(limit) {
    this.waiting += 1
    if (this.active < limit) {
      this.active += 1
      this.waiting -= 1
      return () => this.release(limit)
    }
    // Wait for a release to hand its slot straight to this waiter, so the slot
    // count never drops and no late arrival can jump the queue.
    await new Promise((resolve) => {
      this.queue.push(resolve)
    })
    this.waiting -= 1
    return () => this.release(limit)
  }

  /**
   * Release one slot, waking the next waiter if any.
   * @param limit - effective limit for the woken waiter.
   */
  release(limit) {
    const next = this.queue.shift()
    if (next !== undefined) {
      // Hand the slot over without decrementing: `active` is unchanged.
      next()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }

  /**
   * Run one operation within the concurrency limit.
   * @param operation - the work to perform while holding a slot.
   * @param limit - override for this call only; omitted uses the constructor value.
   * @returns whatever the operation returns.
   */
  async run(operation, limit) {
    const effective = normalizeLimit(limit, this.limit)
    const release = await this.acquire(effective)
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
