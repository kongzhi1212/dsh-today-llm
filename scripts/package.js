#!/usr/bin/env node
/**
 * Build a distributable package.
 *
 * Produces the two artefacts a user can install from without a registry:
 *
 *   dist/dsh-today-llm-<version>.tgz   the package itself
 *   dist/install-windows.bat           a double-clickable installer beside it
 *
 * `npm pack` is used rather than a hand-rolled tar so the `files` list in
 * package.json stays the single source of truth for what ships.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

console.log(`packing dsh-today-llm ${pkg.version}`)

// Prefer npm, fall back to pnpm. A DeepSeek Harness install ships pnpm but not
// npm next to its runtime, and gives it no command shim on Windows, so the last
// resort drives the bundled pnpm script with the running Node.
const packers = []
if (process.platform === 'win32') {
  packers.push({ command: 'npm.cmd', args: ['pack', '--pack-destination', dist] })
  packers.push({ command: 'pnpm.cmd', args: ['pack', '--pack-destination', dist] })
} else {
  packers.push({ command: 'npm', args: ['pack', '--pack-destination', dist] })
  packers.push({ command: 'pnpm', args: ['pack', '--pack-destination', dist] })
}
for (const bundled of bundledPnpmScripts()) {
  packers.push({ command: process.execPath, args: [bundled, 'pack', '--pack-destination', dist] })
}

let packed = false
for (const packer of packers) {
  try {
    execFileSync(packer.command, packer.args, {
      cwd: root,
      stdio: 'inherit',
      // `shell` is only needed to resolve .cmd shims on Windows; it must not be
      // used when the command is node itself, or the path would be re-split.
      shell: process.platform === 'win32' && packer.command.endsWith('.cmd'),
    })
    packed = true
    break
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    console.warn(`  ${packer.command} failed: ${message}`)
  }
}
if (!packed) {
  console.error('\nno packer available: install npm or pnpm, or run `npm pack` yourself')
  process.exit(1)
}

/**
 * Locate pnpm bundled inside a DeepSeek Harness installation.
 * @returns candidate script paths that exist.
 */
function bundledPnpmScripts() {
  const roots = []
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'))
    if (process.env.ProgramFiles) roots.push(join(process.env.ProgramFiles, 'DeepSeek Harness'))
    if (process.env['ProgramFiles(x86)']) roots.push(join(process.env['ProgramFiles(x86)'], 'DeepSeek Harness'))
  } else {
    roots.push('/Applications/DeepSeek Harness.app/Contents/Resources', '/opt/DeepSeek Harness/resources', '/usr/lib/deepseek-harness/resources')
  }
  const found = []
  const homes = [...roots]
  // The Desktop runtime may also live under the user's DSH home rather than the
  // application directory, depending on how the harness was installed.
  if (process.env.USERPROFILE) homes.push(join(process.env.USERPROFILE, '.dsh'))
  if (process.env.HOME) homes.push(join(process.env.HOME, '.dsh'))
  for (const base of homes) {
    for (const segments of [
      ['resources', 'runtime', 'primary-runtime'],
      ['dsh-runtimes', 'dsh-primary-runtime'],
      ['primary-runtime'],
    ]) {
      const candidate = join(base, ...segments, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
      if (existsSync(candidate)) found.push(candidate)
    }
  }
  return found
}

// The packer names the tarball after the package, so find what it produced
// instead of predicting the name and being wrong once a scope is added.
const tarballs = readdirSync(dist).filter(name => name.endsWith('.tgz'))
if (tarballs.length !== 1) {
  console.error(`expected exactly one tarball, found ${tarballs.length}`)
  process.exit(1)
}

copyFileSync(join(root, 'scripts', 'install-windows.bat'), join(dist, 'install-windows.bat'))

console.log('\nartefacts:')
for (const name of ['install-windows.bat', tarballs[0]]) {
  console.log(`  dist/${name}`)
}
console.log('\ninstall with:')
console.log(`  dsh plugin --profile desktop add dist/${tarballs[0]}`)
