/**
 * Reads the account already signed in by the local Today desktop app.
 *
 * The desktop client stores its session in `<appData>/<product>/account-credentials.slot-a`
 * in one of two envelopes:
 *
 * - `v10` — Chromium's safeStorage envelope, AES-256-GCM with a key derived by
 *   PBKDF2-SHA1 from the master key in `Local State` (`os_crypt.encrypted_key`),
 *   itself wrapped by DPAPI on Windows, Keychain on macOS, or libsecret on Linux.
 * - `TDK1` — Today's own key-store envelope, AES-256-GCM with a key read from
 *   the macOS Keychain item `ai.today.desktop.account-credentials`, which is
 *   what the macOS build uses instead of safeStorage.
 *
 * Both layouts carry the same plaintext. Everything here is read-only: the
 * desktop app's own files are never written.
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
const V10_PREFIX_BYTES = 3
/** Length of the `TDK1` prefix. */
const TDK1_PREFIX_BYTES = 4
/** Length of the trailing GCM authentication tag. */
const TAG_BYTES = 16
/** Length of the IV Chromium writes after the `v10` prefix. */
const IV_BYTES = 12

/** The two builds and the user-data directory each one uses. */
export const REGION_PRODUCT_DIRS = Object.freeze({
  cn: 'Today CN',
  global: 'Today',
})

/** Regions this module knows how to locate. */
export const REGIONS = Object.freeze(['cn', 'global'])

/**
 * Candidate user-data directories as `{ dir, region }`, most specific first.
 *
 * `region` narrows the probe to one build; without it both are tried, CN first,
 * which matches the order this plugin supported before it knew about regions.
 * @param region - `cn`, `global`, or undefined to probe both.
 * @returns absolute candidate directories in probe order.
 */
function candidateUserDataDirs(region) {
  const wanted = region === 'cn' || region === 'global' ? [region] : ['cn', 'global']
  const bases = []
  for (const name of wanted) {
    const product = REGION_PRODUCT_DIRS[name]
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA
      if (appData === undefined || appData === '') continue
      bases.push({ dir: join(appData, product), region: name })
    } else if (process.platform === 'darwin') {
      bases.push({ dir: join(homedir(), 'Library', 'Application Support', product), region: name })
    } else {
      const config = process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME !== ''
        ? process.env.XDG_CONFIG_HOME
        : join(homedir(), '.config')
      bases.push({ dir: join(config, product), region: name })
    }
  }
  const override = process.env.TODAY_USER_DATA_DIR
  if (override !== undefined && override !== '') {
    bases.unshift({ dir: override, region: region === 'global' ? 'global' : 'cn' })
  }
  return bases
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
 * Read the key-store master key the macOS build keeps in the Keychain.
 *
 * This is a different secret from the Chromium safeStorage password: the macOS
 * build puts its own envelope key here instead of using `v10`.
 * @returns the raw AES key.
 * @throws Error when the item is absent, which means the account was never
 *   stored in the `TDK1` envelope.
 */
function keyStoreMasterKey() {
  const output = execFileSync(
    'security',
    ['find-generic-password', '-s', 'ai.today.desktop.account-credentials', '-a', 'credential-key', '-w'],
    { encoding: 'utf8', timeout: 15_000 },
  )
  const decoded = Buffer.from(output.trim(), 'base64')
  if (decoded.length !== KEY_BYTES) {
    throw new Error(`Today key-store key has ${decoded.length} bytes, expected ${KEY_BYTES}`)
  }
  return decoded
}

/**
 * Decrypt one Chromium `v10` payload.
 * @param key - raw AES key from {@link unwrapMasterKey}.
 * @param payload - the whole file, including its `v10` prefix.
 * @returns the UTF-8 plaintext.
 * @throws Error when the prefix or the authentication tag is wrong.
 */
function decryptV10(key, payload) {
  const prefix = payload.subarray(0, V10_PREFIX_BYTES).toString('ascii')
  if (prefix !== 'v10') throw new Error(`unsupported credential envelope ${JSON.stringify(prefix)}`)
  const iv = payload.subarray(V10_PREFIX_BYTES, V10_PREFIX_BYTES + IV_BYTES)
  const tag = payload.subarray(payload.length - TAG_BYTES)
  const body = payload.subarray(V10_PREFIX_BYTES + IV_BYTES, payload.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/**
 * Decrypt one `TDK1` payload.
 *
 * Layout differs from `v10`: a four-byte magic, then the IV, then the
 * authentication tag, then the ciphertext. The magic is authenticated as
 * additional data, so a rewritten header fails to decrypt rather than silently
 * yielding the wrong branch.
 * @param key - raw AES key from {@link keyStoreMasterKey}.
 * @param payload - the whole file, including its `TDK1` prefix.
 * @returns the UTF-8 plaintext.
 * @throws Error when the magic or the authentication tag is wrong.
 */
function decryptTdk1(key, payload) {
  const magic = payload.subarray(0, TDK1_PREFIX_BYTES).toString('ascii')
  if (magic !== 'TDK1') throw new Error(`unsupported credential envelope ${JSON.stringify(magic)}`)
  const iv = payload.subarray(TDK1_PREFIX_BYTES, TDK1_PREFIX_BYTES + IV_BYTES)
  const tagStart = TDK1_PREFIX_BYTES + IV_BYTES
  const tag = payload.subarray(tagStart, tagStart + TAG_BYTES)
  const body = payload.subarray(tagStart + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from('TDK1', 'ascii'))
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
 * A per-directory reader that decrypts whichever envelope the files use.
 *
 * The envelope is chosen by the file's own magic rather than guessed from the
 * platform, so a macOS install that uses `v10` and one that uses `TDK1` both
 * work, and the two master keys are only read when their envelope appears.
 * @param dir - user-data directory.
 * @returns a function that decrypts one file to JSON.
 */
function readerFor(dir) {
  let v10Key
  let keyStoreKey
  return (filePath) => {
    const payload = readFileSync(filePath)
    const magic4 = payload.subarray(0, 4).toString('ascii')
    try {
      if (magic4 === 'TDK1') {
        // Absent on anything but the macOS key store; surface that plainly.
        if (keyStoreKey === undefined) keyStoreKey = keyStoreMasterKey()
        return JSON.parse(decryptTdk1(keyStoreKey, payload))
      }
      if (v10Key === undefined) v10Key = masterKeyOf(dir)
      return JSON.parse(decryptV10(v10Key, payload))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`cannot decrypt ${filePath}: ${message}`)
    }
  }
}

/**
 * Pick the credential slot the head names.
 *
 * Today keeps two alternating slots plus a head record that points at the live
 * one; reading the head avoids picking a half-written or stale sibling.
 * @param dir - user-data directory.
 * @param read - the directory's envelope-aware reader.
 * @returns the record the head selects, when one parses.
 */
function slotRecord(dir, read) {
  const headPath = existingFile(dir, 'account-credentials.head')
  let index = 0
  if (headPath !== undefined) {
    try {
      const head = read(headPath)
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
      const parsed = read(path)
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
 * @param options - optional `region` narrowing the probe to one build.
 * @returns the record, the directory and region it came from, or undefined.
 */
export function readStoredAccount(options = {}) {
  for (const { dir, region } of candidateUserDataDirs(options.region)) {
    if (signedOut(dir)) continue
    // `Local State` is only needed for the `v10` envelope; a `TDK1` install has
    // its key in the Keychain, so its absence must not skip the directory.
    const read = readerFor(dir)
    const record = slotRecord(dir, read)
    if (record === undefined) continue
    if (typeof record.refreshCredential !== 'string' || record.refreshCredential === '') continue
    return { record, userDataDir: dir, region }
  }
  return undefined
}

/**
 * Describe why no account could be read, for a diagnostic that does not guess.
 * @param options - optional `region` narrowing the probe to one build.
 * @returns one line naming each probed directory and the first failure in it.
 */
export function describeMissingAccount(options = {}) {
  const lines = []
  for (const { dir, region } of candidateUserDataDirs(options.region)) {
    if (!existsSync(dir)) {
      lines.push(`${dir} (${region}): not found`)
      continue
    }
    if (signedOut(dir)) {
      lines.push(`${dir} (${region}): signed out (account-credentials.signed-out)`)
      continue
    }
    const read = readerFor(dir)
    const headPath = existingFile(dir, 'account-credentials.head')
    if (headPath !== undefined) {
      try {
        read(headPath)
      } catch (error) {
        lines.push(`${dir} (${region}): ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
    }
    lines.push(`${dir} (${region}): readable, but no credential slot held a usable record`)
  }
  return lines.join('; ')
}
