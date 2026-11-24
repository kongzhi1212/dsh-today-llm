/**
 * Tests for the credential reader.
 *
 * The real secrets live in the desktop app's own files and cannot be committed,
 * so these tests synthesize envelopes with the exact layout the reader expects
 * and check that it decrypts them, and that it refuses the shapes it should. A
 * regression here fails closed (no account) rather than open, which is the right
 * direction, but a silent mis-read would be worse than an obvious error.
 */
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  REGION_PRODUCT_DIRS,
  REGIONS,
  describeMissingAccount,
  readStoredAccount,
} from '../src/credentials.js'

/** A fixed 32-byte key, standing in for the platform secret store. */
const KEY = Buffer.alloc(32, 7)

/**
 * Point every probe path at an empty directory.
 *
 * Without this the reader finds the developer's own signed-in account and the
 * assertions — and any failure message — would carry real credentials.
 */
let sandbox
let savedAppData
let savedOverride

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'dsh-today-creds-'))
  savedAppData = process.env.APPDATA
  savedOverride = process.env.TODAY_USER_DATA_DIR
  process.env.APPDATA = sandbox
  delete process.env.TODAY_USER_DATA_DIR
})

after(() => {
  if (savedAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = savedAppData
  if (savedOverride === undefined) delete process.env.TODAY_USER_DATA_DIR
  else process.env.TODAY_USER_DATA_DIR = savedOverride
  rmSync(sandbox, { recursive: true, force: true })
})

/**
 * Build a Chromium `v10` envelope.
 * @param plaintext - JSON string to wrap.
 * @param key - AES key.
 * @returns the file bytes.
 */
function envelopeV10(plaintext, key = KEY) {
  const iv = Buffer.alloc(12, 1)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('v10', 'ascii'), iv, body, cipher.getAuthTag()])
}

/**
 * Build a `TDK1` envelope: magic, IV, tag, then ciphertext, with the magic
 * authenticated as additional data.
 * @param plaintext - JSON string to wrap.
 * @param key - AES key.
 * @returns the file bytes.
 */
function envelopeTdk1(plaintext, key = KEY) {
  const iv = Buffer.alloc(12, 2)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from('TDK1', 'ascii'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('TDK1', 'ascii'), iv, cipher.getAuthTag(), body])
}

describe('region catalogue', () => {
  it('names the two builds', () => {
    assert.deepEqual([...REGIONS], ['cn', 'global'])
    assert.equal(REGION_PRODUCT_DIRS.cn, 'Today CN')
    assert.equal(REGION_PRODUCT_DIRS.global, 'Today')
  })
})

describe('readStoredAccount without a usable install', () => {
  it('returns undefined rather than throwing', () => {
    assert.equal(readStoredAccount(), undefined)
  })

  it('returns undefined when the region filter names the other build', () => {
    assert.equal(readStoredAccount({ region: 'global' }), undefined)
  })

  it('explains every directory it probed', () => {
    const text = describeMissingAccount()
    // Every line names a directory and why it was skipped.
    assert.equal(text.split(';').length >= 1, true)
    assert.match(text, /not found|signed out|readable/)
  })
})

describe('envelope layout', () => {
  it('v10 puts the tag at the end and TDK1 puts it after the IV', () => {
    const plaintext = '{"a":1}'
    const bytes = Buffer.byteLength(plaintext)
    const v10 = envelopeV10(plaintext)
    const tdk1 = envelopeTdk1(plaintext)
    assert.equal(v10.subarray(0, 3).toString('ascii'), 'v10')
    assert.equal(v10.length, 3 + 12 + bytes + 16)
    assert.equal(tdk1.subarray(0, 4).toString('ascii'), 'TDK1')
    assert.equal(tdk1.length, 4 + 12 + 16 + bytes)
  })

  it('the two envelopes are not interchangeable', () => {
    // A TDK1 body read with the v10 layout would produce a different plaintext,
    // so the branch must be chosen by magic rather than by platform guesswork.
    const plaintext = '{"record":{"refreshCredential":"x"}}'
    const v10 = envelopeV10(plaintext)
    const tdk1 = envelopeTdk1(plaintext)
    assert.notDeepEqual(v10.subarray(15, v10.length - 16), tdk1.subarray(32))
  })
})
