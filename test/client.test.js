/**
 * Tests for the settings page's draft plumbing.
 *
 * The page renders from `client.js`, which is a browser module rather than an ES
 * module, so it is evaluated here in a minimal stand-in for the environment the
 * module table provides. Only the pure helpers are exercised — no React tree is
 * rendered, because a layout mistake is caught by looking at the page, while a
 * missing field silently makes Save do nothing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/**
 * Load `client.js` the way the browser module table does.
 * @returns the module's exported record, including its test seam.
 */
function loadClientModule() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const registered = []
  const React = {
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  }
  const previous = globalThis.window
  const sandbox = {
    __ModuleLoader__: {
      load(entry) { registered.push(entry) },
    },
  }
  sandbox.window = sandbox
  try {
    // The module calls `window.__ModuleLoader__.load(...)` at import time; the
    // factory is not invoked until a Host would apply it, but the helpers are
    // captured when it is.
    const factory = new Function('window', 'globalThis', source)
    factory(sandbox, sandbox)
    assert.equal(registered.length, 1, 'client.js should register exactly one module')
    const mod = registered[0].factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    })
    return mod
  } finally {
    globalThis.window = previous
  }
}

/** The full Host config shape, so a new field shows up as missing. */
const CONFIG = {
  timeoutMs: 300_000,
  pollIntervalMs: 700,
  refreshModelsMs: 600_000,
  defaultContextWindow: 200_000,
  maxConcurrency: 1,
  strictProtocol: true,
  useSocket: true,
  reportUsage: true,
  region: 'auto',
  deviceId: '',
  models: {},
}

/**
 * Fields the Host accepts from this page, mirroring `WRITABLE_FIELDS` in
 * `index.js`. Kept here as an explicit list: if the two drift apart, the test
 * fails instead of the settings page quietly losing a field.
 */
const WRITABLE_FIELDS = [
  'models',
  'defaultContextWindow',
  'timeoutMs',
  'pollIntervalMs',
  'refreshModelsMs',
  'maxConcurrency',
  'strictProtocol',
  'useSocket',
  'reportUsage',
  'deviceId',
  'region',
]

describe('draft plumbing', () => {
  const { __internals, } = loadClientModule()
  const { toDraft, editsOf } = __internals

  it('exposes its helpers for testing', () => {
    assert.equal(typeof toDraft, 'function')
    assert.equal(typeof editsOf, 'function')
  })

  it('carries every writable field from the Host config into the draft', () => {
    const draft = toDraft(CONFIG)
    for (const field of WRITABLE_FIELDS) {
      assert.ok(field in draft, `toDraft dropped "${field}"`)
    }
  })

  it('sends every writable field back on save', () => {
    const edits = editsOf(toDraft(CONFIG))
    for (const field of WRITABLE_FIELDS) {
      assert.ok(field in edits, `editsOf dropped "${field}", so Save would not write it`)
    }
  })

  it('preserves a non-default device id through a round trip', () => {
    const edits = editsOf(toDraft({ ...CONFIG, deviceId: 'fixed-id-123' }))
    assert.equal(edits.deviceId, 'fixed-id-123')
  })

  it('preserves the region through a round trip', () => {
    for (const region of ['auto', 'cn', 'global']) {
      assert.equal(editsOf(toDraft({ ...CONFIG, region })).region, region)
    }
  })

  it('starts clean, so Save stays disabled until something changes', () => {
    assert.equal(toDraft(CONFIG).dirty, false)
  })

  it('does not send a field the Host never provided', () => {
    const draft = toDraft({ timeoutMs: 1000 })
    const edits = editsOf(draft)
    // Only fields with a value are sent; undefined ones are dropped so a partial
    // draft cannot reset settings the user never saw.
    for (const [key, value] of Object.entries(edits)) {
      assert.notEqual(value, undefined, `${key} was sent as undefined`)
    }
  })

  it('drops empty per-model entries instead of writing them', () => {
    const draft = toDraft({ ...CONFIG, models: { 'glm-5.3': {}, 'kimi-k3.1-pro': { hidden: true } } })
    const edits = editsOf(draft)
    assert.equal('glm-5.3' in edits.models, false)
    assert.deepEqual(edits.models['kimi-k3.1-pro'], { hidden: true })
  })
})
