/**
 * Browser half of the Today bundle.
 *
 * Registers one page in the Settings panel's left-hand navigation, plus that
 * row's icon. The page has two halves:
 *
 * - a live status view — account, usage allowance, models, background tasks and
 *   the latest diary — all read from the Host, which reads it from Today;
 * - the editable settings — per-model visibility and context budget, plus the
 *   timing and behaviour knobs — written back through the Host's settings
 *   service so the profile patch stays the single source of truth.
 *
 * Writes are explicit: nothing is saved until the user presses Save, and a
 * failed save says why rather than silently reverting.
 */

/** Package name; also the Settings section id and the module-table id. */
const SECTION_ID = 'dsh-today-llm'
/** Host route carrying the status snapshot. */
const STATUS_ROUTE = '/dsh-today-llm/status'
/** Host route accepting configuration edits. */
const CONFIG_ROUTE = '/dsh-today-llm/config'

/** English dictionary. */
const EN = {
  'nav.label': 'Today',
  'page.title': 'Today models',
  'page.intro': 'The Today desktop app on this machine supplies these models. Each turn is sent to Today\u2019s own agent, so replies arrive complete and that agent\u2019s memory still shapes them.',
  'status.refresh': 'Refresh',
  'status.refreshing': 'Refreshing\u2026',
  'status.fetchedAt': 'Read at {time}',
  'section.account': 'Account',
  'section.usage': 'Plan and usage',
  'section.models': 'Models',
  'section.tasks': 'Recent tasks',
  'section.diary': 'Latest diary',
  'section.settings': 'Settings',
  'account.identifier': 'Signed in as',
  'account.unknown': 'unknown',
  'account.dataDir': 'Credential directory',
  'usage.plan': 'Plan',
  'usage.remaining': 'Remaining',
  'usage.used': '{percent} used',
  'usage.resetAt': 'Resets',
  'usage.serviceState': 'Service',
  'usage.unavailable': 'Usage is unavailable right now.',
  'models.count': '{count} models',
  'models.current': 'Active in Today',
  'models.empty': 'No models were reported for this account.',
  'models.show': 'Show',
  'models.hide': 'Hidden',
  'models.context': 'Context window',
  'models.contextDefault': 'Default ({tokens})',
  'tasks.empty': 'No background tasks.',
  'tasks.unseen': 'New result',
  'tasks.unavailable': 'Tasks are unavailable right now.',
  'diary.empty': 'No diary entry yet.',
  'diary.unavailable': 'The diary is unavailable right now.',
  'settings.hint': 'Changes apply after saving; the plugin restarts with the new values.',
  'settings.timeout': 'Turn timeout (seconds)',
  'settings.poll': 'Poll interval (ms)',
  'settings.refresh': 'Model refresh (seconds, 0 = never)',
  'settings.context': 'Default context window (tokens)',
  'settings.concurrency': 'Concurrent turns',
  'settings.concurrencyHint': 'Today stores the model once per account, so more than one can retarget a turn mid-flight.',
  'settings.strict': 'Strict JSON protocol (needed for tool calls)',
  'settings.usage': 'Report estimated token usage',
  'save': 'Save',
  'saving': 'Saving\u2026',
  'reset': 'Discard',
  'saved': 'Saved.',
  'dirty': 'Unsaved changes',
  'error.heading': 'Today could not be read',
  'error.statusRoute': 'The status route answered HTTP {status}.',
  'error.unreadable': 'The status route answered something that is not JSON.',
  'note.heading': 'Things to keep in mind',
  'note.selection': 'The model choice is stored once per Today account, not per conversation. Selecting a model in the composer changes it for the whole account, including the Today app on your other devices.',
  'note.tokens': 'Today reports no token counts, so usage shown in a conversation is estimated from text length.',
}

/** Simplified Chinese dictionary. */
const ZH = {
  'nav.label': 'Today',
  'page.title': 'Today 模型',
  'page.intro': '这些模型由本机已登录的 Today 桌面端提供。每个请求都交给 Today 自己的 agent，因此回复是完整返回的，且该 agent 的记忆仍会影响回答。',
  'status.refresh': '刷新',
  'status.refreshing': '刷新中…',
  'status.fetchedAt': '读取于 {time}',
  'section.account': '账号',
  'section.usage': '套餐与用量',
  'section.models': '模型',
  'section.tasks': '最近任务',
  'section.diary': '最新日记',
  'section.settings': '设置',
  'account.identifier': '当前登录',
  'account.unknown': '未知',
  'account.dataDir': '凭据目录',
  'usage.plan': '套餐',
  'usage.remaining': '剩余',
  'usage.used': '已用 {percent}',
  'usage.resetAt': '重置于',
  'usage.serviceState': '服务状态',
  'usage.unavailable': '暂时读不到用量。',
  'models.count': '共 {count} 个',
  'models.current': 'Today 当前使用',
  'models.empty': '该账号没有返回任何模型。',
  'models.show': '显示',
  'models.hide': '已隐藏',
  'models.context': '上下文窗口',
  'models.contextDefault': '默认（{tokens}）',
  'tasks.empty': '没有后台任务。',
  'tasks.unseen': '有新结果',
  'tasks.unavailable': '暂时读不到任务。',
  'diary.empty': '还没有日记。',
  'diary.unavailable': '暂时读不到日记。',
  'settings.hint': '改动在保存后生效，插件会带着新值重启。',
  'settings.timeout': '单次超时（秒）',
  'settings.poll': '轮询间隔（毫秒）',
  'settings.refresh': '模型刷新（秒，0 = 不刷新）',
  'settings.context': '默认上下文窗口（token）',
  'settings.concurrency': '并发请求数',
  'settings.concurrencyHint': 'Today 的模型选择按账号保存，大于 1 时其中一个请求可能被改到别的模型上。',
  'settings.strict': '严格 JSON 协议（工具调用需要）',
  'settings.usage': '上报估算的 token 用量',
  'save': '保存',
  'saving': '保存中…',
  'reset': '放弃改动',
  'saved': '已保存。',
  'dirty': '有未保存的改动',
  'error.heading': '读不到 Today',
  'error.statusRoute': '状态接口返回了 HTTP {status}。',
  'error.unreadable': '状态接口返回的内容不是 JSON。',
  'note.heading': '需要知道的事',
  'note.selection': '模型选择按 Today 账号保存，而不是按会话。在输入框里选模型就会改动整个账号，你其它设备上的 Today 也会跟着变。',
  'note.tokens': 'Today 不返回 token 用量，对话里显示的用量是按文本长度估算的。',
}

/**
 * Read the active locale id.
 *
 * `getLocale()` returns a `LocaleSnapshot` whose language field is `active`;
 * an earlier version of this file read a `locale` field that does not exist,
 * so every lookup silently fell through to English.
 * @param ctx - the client plugin context.
 * @returns the BCP 47-style locale id, or `en` when unavailable.
 */
function activeLocaleId(ctx) {
  try {
    const snapshot = ctx.locale?.getLocale?.()
    const active = snapshot?.active
    if (typeof active === 'string' && active !== '') return active
  } catch {
    // Fall through to English.
  }
  return 'en'
}

/**
 * Build a translator for the current locale.
 * @param ctx - the client plugin context.
 * @returns a function mapping a key to text, substituting `{name}` placeholders.
 */
function translator(ctx) {
  const dict = activeLocaleId(ctx).toLowerCase().startsWith('zh') ? ZH : EN
  return (key, vars) => {
    const template = dict[key] ?? EN[key] ?? key
    if (vars === undefined) return template
    return template.replace(/\{(\w+)\}/gu, (whole, name) => (name in vars ? String(vars[name]) : whole))
  }
}

/**
 * Read the status snapshot from the Host.
 * @param t - translator used for the failure message, which is shown to the user.
 * @returns the parsed snapshot.
 * @throws Error when the route answers an unusable body.
 */
async function readStatus(t) {
  const response = await fetch(STATUS_ROUTE, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(t('error.statusRoute', { status: response.status }))
  try {
    return await response.json()
  } catch {
    throw new Error(t('error.unreadable'))
  }
}

/**
 * Send configuration edits to the Host.
 * @param edits - fields to merge into this row's config.
 * @param revision - revision the page read, guarding against a concurrent edit.
 * @returns the Host's result.
 */
async function writeConfig(edits, revision) {
  const response = await fetch(CONFIG_ROUTE, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify({ edits, revision }),
  })
  try {
    return await response.json()
  } catch {
    return { ok: false, error: `HTTP ${response.status}` }
  }
}

/** Shared layout values. */
function styles() {
  const text = color => ({ color, fontSize: 13, lineHeight: 1.6, margin: 0 })
  return {
    text,
    row: {
      display: 'flex',
      justifyContent: 'space-between',
      gap: 16,
      padding: '10px 12px',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
    },
    label: { ...text('var(--dsw-alias-label-secondary)'), flex: '0 0 auto' },
    value: {
      ...text('var(--dsw-alias-label-primary)'),
      textAlign: 'right',
      wordBreak: 'break-all',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    },
    card: {
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 8,
      overflow: 'hidden',
      marginBottom: 20,
    },
    cardHead: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: 16,
      padding: '10px 12px',
      background: 'var(--dsw-alias-bg-layer-2)',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
    },
    heading: {
      fontSize: 13,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
      margin: 0,
    },
    input: {
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 6,
      padding: '3px 8px',
      fontSize: 12,
      width: 96,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    },
    button: (disabled) => ({
      appearance: 'none',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 6,
      padding: '4px 12px',
      fontSize: 12,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
    }),
  }
}

/**
 * The Settings page.
 * @param props - slot props plus this bundle's own `React`, `t` and `icon`.
 * @returns the rendered page.
 */
function TodaySettingsPage(props) {
  const { React } = props
  // Our keys only exist in our dictionary, so ours is authoritative even when
  // the shell also passes a translator.
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const h = React.createElement
  const s = styles()
  const [state, setState] = React.useState({ phase: 'loading', data: undefined, error: undefined })
  const [draft, setDraft] = React.useState(undefined)
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState(undefined)
  const [saved, setSaved] = React.useState(false)

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, phase: current.data === undefined ? 'loading' : 'refreshing' }))
    try {
      const data = await readStatus(t)
      setState({ phase: 'ready', data, error: undefined })
      setDraft(toDraft(data?.config))
      setSaveError(undefined)
      setSaved(false)
    } catch (error) {
      setState((current) => ({
        phase: 'ready',
        data: current.data,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  const data = state.data
  const failing = state.error !== undefined || data?.ok === false
  const failureMessage = state.error ?? (data?.ok === false ? data.error : undefined)
  const busy = state.phase === 'loading' || state.phase === 'refreshing'

  const toggleModel = (id) => {
    setDraft((current) => {
      const base = current ?? toDraft(data?.config)
      const models = { ...(base.models ?? {}) }
      const entry = { ...(models[id] ?? {}) }
      entry.hidden = entry.hidden !== true
      models[id] = entry
      return { ...base, models, dirty: true }
    })
    setSaved(false)
    setSaveError(undefined)
  }

  const setModelContext = (id, value) => {
    setDraft((current) => {
      const base = current ?? toDraft(data?.config)
      const models = { ...(base.models ?? {}) }
      const entry = { ...(models[id] ?? {}) }
      const parsed = Number(value)
      if (value === '' || !Number.isFinite(parsed) || parsed <= 0) delete entry.contextWindow
      else entry.contextWindow = Math.round(parsed)
      models[id] = entry
      return { ...base, models, dirty: true }
    })
    setSaved(false)
    setSaveError(undefined)
  }

  const setField = (key, value) => {
    setDraft((current) => ({ ...(current ?? toDraft(data?.config)), [key]: value, dirty: true }))
    setSaved(false)
    setSaveError(undefined)
  }

  const save = async () => {
    if (draft === undefined) return
    setSaving(true)
    setSaveError(undefined)
    try {
      const result = await writeConfig(editsOf(draft), data?.revision)
      if (result?.ok === true) {
        setSaved(true)
        await load()
      } else {
        setSaveError(result?.error ?? 'Save failed.')
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  // ---- header ----
  const header = h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 } },
    props.icon,
    h('div', { style: { minWidth: 0 } },
      h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('page.title'))))

  const intro = h('p', { style: { ...s.text('var(--dsw-alias-label-secondary)'), marginTop: 8, marginBottom: 16 } }, t('page.intro'))

  const errorBox = failing && failureMessage !== undefined
    ? h('div', {
      style: { border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 8, padding: '10px 12px', marginBottom: 16 },
    },
    h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 4 } }, t('error.heading')),
    h('div', { style: s.text('var(--dsw-alias-label-secondary)') }, String(failureMessage)))
    : null

  const fetchedAt = data?.fetchedAt !== undefined
    ? h('span', { style: s.text('var(--dsw-alias-label-secondary)') },
      t('status.fetchedAt', { time: new Date(data.fetchedAt).toLocaleString() }))
    : null

  const toolbar = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 } },
    fetchedAt,
    h('button', { type: 'button', onClick: () => { load() }, disabled: busy, style: s.button(busy) },
      busy ? t('status.refreshing') : t('status.refresh')))

  const sectionTitle = key => h('h3', { style: { ...s.heading, margin: '0 0 8px' } }, t(key))

  // ---- account ----
  const account = data?.account
  const accountCard = h('div', { style: s.card },
    h('div', { style: { ...s.row, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
      h('span', { style: s.label }, t('account.identifier')),
      h('span', { style: s.value }, account?.identifier ?? t('account.unknown'))),
    h('div', { style: { ...s.row, borderBottom: 'none' } },
      h('span', { style: s.label }, t('account.dataDir')),
      h('span', { style: s.value }, account?.dataDir ?? '\u2014')))

  // ---- usage ----
  const usage = data?.usage
  const usageRows = []
  if (usage?.error !== undefined) {
    usageRows.push(h('div', { key: 'err', style: { ...s.row, borderBottom: 'none' } },
      h('span', { style: s.label }, t('usage.unavailable'))))
  } else if (usage?.value !== undefined) {
    const u = usage.value
    if (u.plan !== undefined) {
      usageRows.push(h('div', { key: 'plan', style: s.row },
        h('span', { style: s.label }, t('usage.plan')),
        h('span', { style: s.value }, u.plan)))
    }
    if (u.remainingText !== undefined || u.usedPercent !== undefined) {
      usageRows.push(h('div', { key: 'left', style: s.row },
        h('span', { style: s.label }, t('usage.remaining')),
        h('span', { style: s.value }, u.remainingText ?? t('usage.used', { percent: `${u.usedPercent}%` }))))
    }
    if (u.resetAt !== undefined) {
      usageRows.push(h('div', { key: 'reset', style: s.row },
        h('span', { style: s.label }, t('usage.resetAt')),
        h('span', { style: s.value }, new Date(u.resetAt).toLocaleString())))
    }
    if (u.serviceState !== undefined) {
      usageRows.push(h('div', { key: 'svc', style: { ...s.row, borderBottom: 'none' } },
        h('span', { style: s.label }, t('usage.serviceState')),
        h('span', { style: s.value }, u.serviceState)))
    }
  }
  const usageCard = usageRows.length === 0 ? null : h('div', { style: s.card },
    h('div', { style: s.cardHead },
      h('span', { style: s.heading }, t('section.usage'))),
    ...usageRows)

  // ---- models (status + edits) ----
  const models = Array.isArray(data?.models) ? data.models : []
  const modelRows = models.length === 0
    ? [h('div', { key: 'empty', style: { ...s.row, borderBottom: 'none' } }, h('span', { style: s.label }, t('models.empty')))]
    : models.map((model) => {
      const entry = draft?.models?.[model.id] ?? {}
      const hidden = entry.hidden === true
      const contextValue = entry.contextWindow === undefined ? '' : String(entry.contextWindow)
      return h('div', {
        key: model.id,
        style: { ...s.row, alignItems: 'center', flexWrap: 'wrap' },
      },
      h('div', { style: { minWidth: 0, flex: '1 1 200px' } },
        h('div', { style: { ...s.text('var(--dsw-alias-label-primary)'), fontWeight: model.active ? 600 : 400 } },
          model.name,
          model.active
            ? h('span', {
              style: {
                marginLeft: 8,
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 999,
                color: 'var(--dsw-alias-state-success-primary)',
                border: '1px solid var(--dsw-alias-state-success-primary)',
              },
            }, t('models.current'))
            : null),
        h('div', {
          style: { ...s.text('var(--dsw-alias-label-secondary)'), fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
        }, model.id)),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flex: '0 0 auto' } },
        h('label', {
          style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
        },
        h('input', {
          type: 'checkbox',
          checked: !hidden,
          onChange: () => { toggleModel(model.id) },
        }),
        hidden ? t('models.hide') : t('models.show')),
        h('input', {
          type: 'number',
          value: contextValue,
          placeholder: t('models.contextDefault', { tokens: draft?.defaultContextWindow ?? '' }),
          onChange: (event) => { setModelContext(model.id, event.target.value) },
          style: s.input,
          'aria-label': `${t('models.context')} ${model.name}`,
        }),
        h('span', { style: { ...s.text('var(--dsw-alias-label-secondary)'), flex: '0 0 auto', minWidth: 28, textAlign: 'right' } },
          model.multiplier ?? '\u2014')))
    })

  const modelsCard = h('div', { style: s.card },
    h('div', { style: s.cardHead },
      h('span', { style: s.heading }, t('section.models')),
      h('span', { style: s.label }, t('models.count', { count: models.length }))),
    ...modelRows)

  // ---- tasks ----
  const tasks = data?.tasks
  const taskRows = tasks?.value !== undefined && Array.isArray(tasks.value) && tasks.value.length > 0
    ? tasks.value.map(task => h('div', { key: task.id, style: { ...s.row, alignItems: 'center' } },
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { ...s.text('var(--dsw-alias-label-primary)'), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, task.name),
        h('div', { style: { ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 12 } },
          `${task.status}${task.taskType === '' ? '' : ` · ${task.taskType}`}`)),
      h('div', { style: { ...s.text('var(--dsw-alias-label-secondary)'), flex: '0 0 auto', textAlign: 'right', fontSize: 12 } },
        task.hasUnseenResult ? t('tasks.unseen') : '')))
    : [h('div', { key: 'empty', style: { ...s.row, borderBottom: 'none' } },
      h('span', { style: s.label }, tasks?.error !== undefined ? t('tasks.unavailable') : t('tasks.empty')))]
  const tasksCard = h('div', { style: s.card },
    h('div', { style: s.cardHead }, h('span', { style: s.heading }, t('section.tasks'))),
    ...taskRows)

  // ---- diary ----
  const diary = data?.diary
  const diaryBody = diary?.error !== undefined
    ? t('diary.unavailable')
    : diary?.value === undefined
      ? t('diary.empty')
      : `${diary.value.title || diary.value.date}\n\n${diary.value.excerpt}`
  const diaryCard = h('div', { style: s.card },
    h('div', { style: s.cardHead },
      h('span', { style: s.heading }, t('section.diary')),
      h('span', { style: s.label }, diary?.value?.date ?? '')),
    h('div', { style: { padding: '10px 12px' } },
      h('div', { style: { ...s.text('var(--dsw-alias-label-secondary)'), whiteSpace: 'pre-wrap' } }, diaryBody)))

  // ---- settings ----
  const numberField = (key, value, onChange, step) => h('div', { style: { ...s.row, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
    h('span', { style: s.label }, t(key)),
    h('input', {
      type: 'number',
      step: step ?? 1,
      value: value === undefined ? '' : String(value),
      onChange: event => onChange(event.target.value),
      style: s.input,
    }))

  const toggleField = (key, value, onChange, hint) => h('div', {
    style: { ...s.row, borderBottom: '1px solid var(--dsw-alias-border-l1)', flexDirection: 'column', gap: 4 },
  },
  h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' } },
    h('input', { type: 'checkbox', checked: value === true, onChange: event => onChange(event.target.checked) }),
    t(key)),
  hint === undefined ? null : h('div', { style: { ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 12 } }, t(hint)))

  const d = draft ?? {}
  const settingsCard = h('div', { style: s.card },
    h('div', { style: s.cardHead },
      h('span', { style: s.heading }, t('section.settings')),
      h('span', { style: s.label }, t('settings.hint'))),
    numberField('settings.timeout', d.timeoutMs === undefined ? undefined : Math.round(d.timeoutMs / 1000),
      (value) => {
        const n = Number(value)
        setField('timeoutMs', Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 300000)
      }),
    numberField('settings.poll', d.pollIntervalMs, (value) => {
      const n = Number(value)
      setField('pollIntervalMs', Number.isFinite(n) ? Math.round(n) : 700)
    }),
    numberField('settings.refresh', d.refreshModelsMs === undefined ? undefined : Math.round(d.refreshModelsMs / 1000), (value) => {
      const n = Number(value)
      setField('refreshModelsMs', Number.isFinite(n) ? Math.max(0, Math.round(n * 1000)) : 600000)
    }),
    numberField('settings.context', d.defaultContextWindow, (value) => {
      const n = Number(value)
      setField('defaultContextWindow', Number.isFinite(n) && n > 0 ? Math.round(n) : 200000)
    }),
    numberField('settings.concurrency', d.maxConcurrency, (value) => {
      const n = Number(value)
      setField('maxConcurrency', Number.isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : 1)
    }),
    toggleField('settings.strict', d.strictProtocol, checked => setField('strictProtocol', checked), undefined),
    toggleField('settings.usage', d.reportUsage, checked => setField('reportUsage', checked), undefined))

  const dirty = draft?.dirty === true
  const saveBar = h('div', {
    style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, marginBottom: 20, flexWrap: 'wrap' },
  },
  h('button', { type: 'button', onClick: save, disabled: saving || !dirty, style: s.button(saving || !dirty) },
    saving ? t('saving') : t('save')),
  h('button', {
    type: 'button',
    onClick: () => { setDraft(toDraft(data?.config)); setSaveError(undefined); setSaved(false) },
    disabled: saving || !dirty,
    style: s.button(saving || !dirty),
  }, t('reset')),
  saved ? h('span', { style: { ...s.text('var(--dsw-alias-state-success-primary)'), fontSize: 12 } }, t('saved')) : null,
  dirty && !saved ? h('span', { style: { ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 12 } }, t('dirty')) : null,
  saveError === undefined ? null : h('span', { style: { ...s.text('var(--dsw-alias-state-error-primary)'), fontSize: 12 } }, saveError))

  const notes = h('ul', {
    style: { margin: 0, paddingLeft: 18, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.7 },
  },
  h('li', null, t('note.selection')),
  h('li', null, t('note.tokens')))

  return h('div', { style: { padding: '4px 0 24px', maxWidth: 760 } },
    header, intro, errorBox, toolbar,
    sectionTitle('section.account'), accountCard,
    usageCard,
    sectionTitle('section.models'), modelsCard,
    sectionTitle('section.settings'), settingsCard, saveBar,
    sectionTitle('section.tasks'), tasksCard,
    sectionTitle('section.diary'), diaryCard,
    sectionTitle('note.heading'), notes)
}

/**
 * Turn a config snapshot into page state.
 *
 * `edits` holds exactly the fields the page writes, so saving never echoes a
 * value the user did not touch. `dirty` starts false and flips on the first
 * change.
 * @param config - the resolved config from the Host.
 * @returns the draft state.
 */
function toDraft(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const models = {}
  if (source.models !== null && typeof source.models === 'object') {
    for (const [id, entry] of Object.entries(source.models)) {
      if (entry !== null && typeof entry === 'object') models[id] = { ...entry }
    }
  }
  return {
    timeoutMs: source.timeoutMs,
    pollIntervalMs: source.pollIntervalMs,
    refreshModelsMs: source.refreshModelsMs,
    defaultContextWindow: source.defaultContextWindow,
    maxConcurrency: source.maxConcurrency,
    strictProtocol: source.strictProtocol,
    reportUsage: source.reportUsage,
    models,
    dirty: false,
  }
}

/**
 * Rebuild the edits payload from the full draft.
 *
 * The page tracks a whole draft for display but only ever sends the fields it
 * owns; this picks them out.
 * @param draft - current draft state.
 * @returns the fields to merge.
 */
function editsOf(draft) {
  const edits = {
    models: pruneModels(draft.models),
    defaultContextWindow: draft.defaultContextWindow,
    timeoutMs: draft.timeoutMs,
    pollIntervalMs: draft.pollIntervalMs,
    refreshModelsMs: draft.refreshModelsMs,
    maxConcurrency: draft.maxConcurrency,
    strictProtocol: draft.strictProtocol,
    reportUsage: draft.reportUsage,
  }
  // Drop keys the page has no value for, so a partial draft cannot write
  // `undefined` into the row and reset a field the user never saw.
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined) delete edits[key]
  }
  return edits
}

/**
 * Drop empty per-model entries so hiding nothing writes nothing.
 * @param models - the draft map.
 * @returns only the entries that carry a real preference.
 */
function pruneModels(models) {
  const out = {}
  if (models === null || typeof models !== 'object') return out
  for (const [id, entry] of Object.entries(models)) {
    if (entry === null || typeof entry !== 'object') continue
    const kept = {}
    if (entry.hidden === true) kept.hidden = true
    if (typeof entry.contextWindow === 'number' && entry.contextWindow > 0) kept.contextWindow = entry.contextWindow
    if (Object.keys(kept).length > 0) out[id] = kept
  }
  return out
}

/** Small sunrise glyph; drawn as SVG so no asset fetch is needed. */
function TodayIcon(props) {
  const { React, size, active } = props
  const h = React.createElement
  const edge = typeof size === 'number' ? size : 16
  return h('svg', {
    width: edge,
    height: edge,
    viewBox: '0 0 36 36',
    'aria-hidden': true,
    style: { display: 'block', opacity: active === false ? 0.75 : 1 },
  },
  h('defs', null,
    h('linearGradient', { id: 'dsh-today-sun', x1: 0, y1: 0, x2: 0, y2: 1 },
      h('stop', { offset: 0, stopColor: '#ff8a3d' }),
      h('stop', { offset: 1, stopColor: '#e4552b' })),
    h('mask', { id: 'dsh-today-cut' },
      h('rect', { width: 36, height: 36, fill: '#000' }),
      h('circle', { cx: 18, cy: 19.5, r: 8.4, fill: '#fff' }),
      h('rect', { x: 9.4, y: 20.6, width: 17.2, height: 1.8, fill: '#000' }))),
  h('circle', { cx: 18, cy: 19.5, r: 8.4, fill: 'url(#dsh-today-sun)', mask: 'url(#dsh-today-cut)' }),
  h('rect', { x: 4.6, y: 20.6, width: 26.8, height: 1.8, rx: 0.9, fill: 'url(#dsh-today-sun)' }),
  h('g', { stroke: 'url(#dsh-today-sun)', strokeWidth: 1.8, strokeLinecap: 'round' },
    h('path', { d: 'M18 5.2v3.4' }),
    h('path', { d: 'M10.1 8.1l2.4 2.4' }),
    h('path', { d: 'M25.9 8.1l-2.4 2.4' })),
  h('path', {
    d: 'M8.6 28.4c3.1 3 6.2 4.4 9.4 4.4s6.3-1.4 9.4-4.4',
    fill: 'none',
    stroke: '#3f6ce0',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
  }))
}

window.__ModuleLoader__.load({
  id: SECTION_ID,
  factory(require) {
    const React = require('react')

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = translator(ctx)
        const disposers = []

        const registerSection = () => {
          disposers.push(ctx.slots.register({
            name: 'settings.section',
            id: SECTION_ID,
            order: 36,
            label: () => t('nav.label'),
          }, (slotProps) => React.createElement(TodaySettingsPage, {
            ...slotProps,
            React,
            t,
            icon: React.createElement(TodayIcon, { React, size: 26 }),
          })))
        }

        const registerIcon = () => {
          disposers.push(ctx.slots.register({
            name: 'settings.section.icon',
            id: SECTION_ID,
          }, (iconProps) => React.createElement(TodayIcon, {
            React,
            size: typeof iconProps?.size === 'number' ? iconProps.size : 16,
            active: iconProps?.active,
          })))
        }

        ctx.slots.inject('settings.section', () => {
          registerSection()
          // The icon is a separate seat addressed by this section's id; losing it
          // must not take the page down with it.
          try {
            ctx.slots.inject('settings.section.icon', () => {
              registerIcon()
              return () => {}
            })
          } catch (error) {
            console.error('[dsh-today-llm] settings icon failed to register (page unaffected):', error)
          }
          return () => {
            for (const dispose of disposers) {
              try { dispose() } catch {}
            }
            disposers.length = 0
          }
        })
      },
    }
  },
})
