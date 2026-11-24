#!/usr/bin/env node
/**
 * One-command diagnostics for dsh-today-llm.
 *
 * Run as `npx dsh-today-llm doctor` or `node bin/doctor.js`. It answers the
 * questions that otherwise need the settings page, a log file and a guess:
 * is an account readable, which deployment is it for, can the service be
 * reached, and is the model catalog intact.
 *
 * Nothing here writes: the only network calls are the same read-only ones the
 * settings page makes. Exit code is 0 when everything checked out and 1 when
 * something needs attention, so it can be used in a script.
 */

import process from 'node:process'

import { REGION_CONFIG, TodayClient } from '../src/api.js'
import { REGIONS, describeMissingAccount, readStoredAccount } from '../src/credentials.js'
import { multiplierOf } from '../src/adapter.js'

/** Collected check results. */
const results = []

/**
 * Record and print one check.
 * @param ok - whether it passed.
 * @param label - what was checked.
 * @param detail - the finding.
 * @param fatal - whether a failure should stop the run.
 */
function report(ok, label, detail, fatal = false) {
  results.push({ ok, label, fatal })
  const mark = ok ? '\u2713' : (fatal ? '\u2717' : '!')
  console.log(`${mark} ${label.padEnd(22)} ${detail}`)
}

/** Print a section heading. */
function heading(text) {
  console.log(`\n${text}`)
  console.log('\u2500'.repeat(52))
}

/**
 * Read the stored account and report what was found.
 * @returns the account, or undefined.
 */
function checkAccount() {
  heading('账号')
  const stored = readStoredAccount()
  if (stored === undefined) {
    report(false, '登录态', '读不到已登录的 Today 账号', true)
    console.log(`\n  探测详情: ${describeMissingAccount()}`)
    console.log('\n  处理: 打开 Today 桌面端登录，然后重试。')
    return undefined
  }
  const identifier = typeof stored.record.user?.identifier === 'string'
    ? stored.record.user.identifier
    : '(未标注)'
  report(true, '登录态', identifier)
  report(true, '服务部署', `${stored.region} (${REGION_CONFIG[stored.region].apiBaseUrl})`)
  report(true, '凭据目录', stored.userDataDir)
  const credential = stored.record.refreshCredential
  report(typeof credential === 'string' && credential !== '', '会话凭据', '已读取')
  return stored
}

/**
 * Exchange the session for an access token and read the catalog.
 * @param stored - the account from the disk check.
 */
async function checkService(stored) {
  heading('服务连通性')
  const client = new TodayClient({
    refreshCredential: stored.record.refreshCredential,
    region: stored.region,
  })
  try {
    const token = await client.mintAccessToken()
    report(true, '刷新令牌', `成功（${token.split('.').length === 3 ? 'JWT' : '不透明令牌'}）`)
  } catch (error) {
    report(false, '刷新令牌', `${error.code ?? 'ERROR'}: ${error.message}`, true)
    console.log('\n  处理: 若为 AUTH，请在 Today 桌面端重新登录。')
    return client
  }
  try {
    const catalog = await client.catalog()
    const priced = catalog.filter(item => multiplierOf(item.description) !== undefined).length
    report(true, '模型目录', `${catalog.length} 个模型，其中 ${priced} 个标注了用量倍率`)
    if (priced === 0 && catalog.length > 0) {
      // Not fatal: the service may simply have stopped labelling prices, but it
      // also means the selector will have no badges, so say so.
      report(false, '倍率解析', '一个都没解析出来，选择器将不显示倍率')
    }
  } catch (error) {
    report(false, '模型目录', `${error.code ?? 'ERROR'}: ${error.message}`)
  }
  try {
    const usage = await client.usage()
    report(true, '套餐用量', `${usage.plan ?? '未知套餐'}，剩余 ${usage.remainingText ?? '未知'}`)
  } catch (error) {
    report(false, '套餐用量', `${error.code ?? 'ERROR'}: ${error.message}`)
  }
  try {
    const selection = await client.selection()
    report(true, '账号当前模型', selection)
  } catch (error) {
    report(false, '账号当前模型', `${error.code ?? 'ERROR'}: ${error.message}`)
  }
  return client
}

/** Report the environment the plugin is running in. */
function checkEnvironment() {
  heading('运行环境')
  report(true, 'Node', process.versions.node)
  report(process.versions.node >= '22.4.0' || false, 'WebSocket 支持', typeof globalThis.WebSocket === 'function'
    ? '可用（事件流可启）'
    : '不可用，只能走轮询（需 Node >= 22.4）')
  report(true, '平台', `${process.platform} ${process.arch}`)
  report(true, '已知部署', REGIONS.join(', '))
}

/** Print the summary and exit. */
function finish() {
  heading('结论')
  const failed = results.filter(r => !r.ok)
  const fatal = failed.filter(r => r.fatal)
  if (failed.length === 0) {
    console.log('\u2713 全部通过')
    process.exit(0)
  }
  if (fatal.length > 0) {
    console.log(`\u2717 ${fatal.length} 项致命失败，插件无法工作`)
    process.exit(1)
  }
  console.log(`! ${failed.length} 项需要关注，但插件仍可工作`)
  process.exit(0)
}

async function main() {
  console.log('dsh-today-llm doctor')
  checkEnvironment()
  const stored = checkAccount()
  if (stored !== undefined) await checkService(stored)
  finish()
}

main().catch((error) => {
  console.error('\n诊断脚本自身出错:', error)
  process.exit(1)
})
