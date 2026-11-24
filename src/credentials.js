/**
 * Reads the account already signed in by the local Today desktop app.
 *
 * The desktop client stores its session in
 * `<appData>/Today CN/account-credentials.slot-a` as a Chromium `v10` envelope
 * (AES-256-GCM, key derived with PBKDF2-SHA1 from a master key). The master key
 * itself lives in `Local State` as `os_crypt.encrypted_key`, wrapped by the
 * platform's user-scoped secret store: DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux.
 *
 * Everything here is read-only. The desktop app's own files are never written.
 *
 * @module dsh-today-llm/credentials
 */

import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Chromium's fixed PBKDF2 salt for the `v10` envelope. */
const CHROMIUM_SALT = 'saltysalt'
/** Chromium's fixed PBKDF2 iteration count on every desktop platform. */
const CHROMIUM_ITERATIONS = 1
/** AES-256-GCM key length in bytes. */
const KEY_BYTES = 32
/** Length of the `v10` prefix. */
const PREFIX_BYTES = 3
/** Length of the trailing GCM authentication tag. */
const TAG_BYTES = 16
/** Length of the IV Chromium writes after the prefix. */
const IV_BYTES = 12

/**
 * Candidate user-data directories, most specific first. The CN build and the
 * international build use different product names, and both can be present.
 * @returns absolute candidate directories in probe order.
 */
function candidateUserDataDirs() {
  const dirs = []
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData !== undefined && appData !== '') {
      dirs.push(join(appData, 'Today CN'), join(appData, 'Today'))
    }
  } else if (process.platform === 'darwin') {
    const home = homedir()
    dirs.push(
      join(home, 'Library', 'Application Support', 'Today CN'),
      join(home, 'Library', 'Application Support', 'Today'),
    )
  } else {
    const config = process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME !== ''
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), '.config')
    dirs.push(join(config, 'Today CN'), join(config, 'Today'))
  }
  const override = process.env.TODAY_USER_DATA_DIR
  if (override !== undefined && override !== '') dirs.unshift(override)
  return dirs
}

/**
 * Narrow a browser-profile file candidate to one that exists.
 * @param dir - user-data directory.
 * @param name - file name inside it.
 * @returns the absolute path, or undefined when absent.
 */
function existingFile(dir, name) {
  const path = join(dir, name)
  return existsSync(path) ? path : undefined
}

/**
 * Unwrap the Chromium master key with the platform secret store.
 * @param wrapped - the `os_crypt.encrypted_key` bytes, still carrying the `DPAPI`/`safe` prefix.
 * @returns the raw 32-byte AES key.
 * @throws Error naming the platform step that failed.
 */
function unwrapMasterKey(wrapped) {
  const withoutPrefix = wrapped.subarray(5)
  if (process.platform === 'win32') {
    // DPAPI is only reachable from a .NET or native call, so shell out to
    // PowerShell rather than take a native dependency. The wrapped blob is
    // passed on stdin as base64 so it never appears in a process command line.
    const script = [
      'Add-Type -AssemblyName System.Security',
      '$b=[Console]::In.ReadToEnd()',
      '$raw=[Convert]::FromBase64String($b.Trim())',
      '$k=[System.Security.Cryptography.ProtectedData]::Unprotect($raw,$null,\'CurrentUser\')',
      '[Convert]::ToBase64String($k)',
    ].join(';')
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { input: withoutPrefix.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    )
    return Buffer.from(output.trim(), 'base64')
  }
  if (process.platform === 'darwin') {
    const output = execFileSync(
      'security',
      ['find-generic-password', '-w', '-s', 'Today Safe Storage', '-a', 'Today'],
      { encoding: 'utf8', timeout: 15_000 },
    )
    return Buffer.from(output.trim(), 'base64')
  }
  const output = execFileSync(
    'secret-tool',
    ['lookup', 'application', 'today', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2'],
    { encoding: 'utf8', timeout: 15_000 },
  )
  return deriveFromPassword(output.trim())
}

/**
 * Derive the AES key from a stored password, matching Chromium's `v10` KDF.
 * @param password - the secret-store password.
 * @returns the raw 32-byte AES key.
 */
function deriveFromPassword(password) {
  return pbkdf2Sync(password, CHROMIUM_SALT, CHROMIUM_ITERATIONS, KEY_BYTES, 'sha1')
}

/**
 * Decrypt one Chromium `v10` payload.
 * @param key - raw AES key from {@link unwrapMasterKey}.
 * @param payload - the whole file, including its `v10` prefix.
 * @returns the UTF-8 plaintext.
 * @throws Error when the prefix or the authentication tag is wrong.
 */
function decryptV10(key, payload) {
  const prefix = payload.subarray(0, PREFIX_BYTES).toString('ascii')
  if (prefix !== 'v10') throw new Error(`unsupported credential envelope ${JSON.stringify(prefix)}`)
  const iv = payload.subarray(PREFIX_BYTES, PREFIX_BYTES + IV_BYTES)
  const tag = payload.subarray(payload.length - TAG_BYTES)
  const body = payload.subarray(PREFIX_BYTES + IV_BYTES, payload.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/**
 * Read `Local State` and unwrap the master key it carries.
 * @param dir - user-data directory.
 * @returns the raw AES key.
 * @throws Error when the file or its key is missing.
 */
function masterKeyOf(dir) {
  const path = existingFile(dir, 'Local State')
  if (path === undefined) throw new Error(`Today Local State not found under ${dir}`)
  const state = JSON.parse(readFileSync(path, 'utf8'))
  const encoded = state?.os_crypt?.encrypted_key
  if (typeof encoded !== 'string' || encoded === '') {
    throw new Error('Today Local State carries no os_crypt.encrypted_key')
  }
  return unwrapMasterKey(Buffer.from(encoded, 'base64'))
}

/**
 * Pick the credential slot the head names.
 *
 * Today keeps two alternating slots plus a head record that points at the live
 * one; reading the head avoids picking a half-written or stale sibling.
 * @param dir - user-data directory.
 * @param key - raw AES key.
 * @returns plaintext of the slot the head selects, when the head parses.
 */
function slotPlaintext(dir, key) {
  const headPath = existingFile(dir, 'account-credentials.head')
  let index = 0
  if (headPath !== undefined) {
    try {
      const head = JSON.parse(decryptV10(key, readFileSync(headPath)))
      if (Number.isInteger(head?.slotIndex) && head.slotIndex >= 0 && head.slotIndex <= 1) index = head.slotIndex
    } catch {
      // A stale or unreadable head is not fatal: the signed-out tombstone is a
      // separate file, so a present slot is still worth reading.
    }
  }
  const names = index === 0 ? ['.slot-a', '.slot-b'] : ['.slot-b', '.slot-a']
  for (const suffix of names) {
    const path = existingFile(dir, `account-credentials${suffix}`)
    if (path === undefined) continue
    try {
      const parsed = JSON.parse(decryptV10(key, readFileSync(path)))
      if (typeof parsed?.record === 'object' && parsed.record !== null) return parsed.record
    } catch {
      // Try the other slot.
    }
  }
  return undefined
}

/**
 * The signed-out tombstone Today writes when the user logs out.
 * @param dir - user-data directory.
 * @returns whether the tombstone is present.
 */
function signedOut(dir) {
  return existsSync(join(dir, 'account-credentials.signed-out'))
}

/**
 * Read the stored Today account record.
 * @returns the record plus where it was found, or undefined when no signed-in account exists.
 */
export function readStoredAccount() {
  for (const dir of candidateUserDataDirs()) {
    if (signedOut(dir)) continue
    if (!existsSync(join(dir, 'Local State'))) continue
    let key
    try {
      key = masterKeyOf(dir)
    } catch {
      continue
    }
    const record = slotPlaintext(dir, key)
    if (record === undefined) continue
    if (typeof record.refreshCredential !== 'string' || record.refreshCredential === '') continue
    return { record, userDataDir: dir }
  }
  return undefined
}

/**
 * Describe why no account could be read, for a diagnostic that does not guess.
 * @returns one line naming each probed directory and the first failure in it.
 */
export function describeMissingAccount() {
  const lines = []
  for (const dir of candidateUserDataDirs()) {
    if (!existsSync(dir)) {
      lines.push(`${dir}: not found`)
      continue
    }
    if (signedOut(dir)) {
      lines.push(`${dir}: signed out (account-credentials.signed-out)`)
      continue
    }
    if (!existsSync(join(dir, 'Local State'))) {
      lines.push(`${dir}: no Local State`)
      continue
    }
    try {
      masterKeyOf(dir)
    } catch (error) {
      lines.push(`${dir}: master key unavailable (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    lines.push(`${dir}: readable, but no credential slot held a usable record`)
  }
  return lines.join('; ')
}
