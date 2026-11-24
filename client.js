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
/** Host route running one single-model connectivity test. */
const PROBE_ROUTE = '/dsh-today-llm/probe'

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
  'section.diagnostics': 'Diagnostics',
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
  'models.useDefault': 'Use default',
  'models.hideExpensive': 'Hide priced models',
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
  'settings.socket': 'Receive turns over the pushed event stream',
  'settings.usage': 'Report estimated token usage',
  'save': 'Save',
  'saving': 'Saving\u2026',
  'reset': 'Discard',
  'saved': 'Saved.',
  'savedRestart': 'The plugin restarts with the new values.',
  'dirty': 'Unsaved changes',
  'error.heading': 'Today could not be read',
  'diag.socket': 'Event stream',
  'diag.socketOn': 'enabled ({failures} consecutive failures)',
  'diag.socketOff': 'disabled, turns use polling',
  'diag.empty': 'No turns recorded in this run yet.',
  'diag.probeLabel': 'Test one model:',
  'diag.probe': 'Test',
  'diag.probing': 'Testing\u2026',
  'diag.costHint': 'A test spends one real Today request',
  'diag.probeOk': '{model} works: {ms}ms over {path}. Reply: {reply}',
  'diag.probeFail': '{model} failed ({code}): {error}',
  'error.statusRoute': 'The status route answered HTTP {status}.',
  'error.unauthorized': 'This page is no longer signed in to the host. Reload the URL that dsh web printed.',
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
  'section.diagnostics': '诊断',
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
  'models.useDefault': '跟随默认',
  'models.hideExpensive': '隐藏收费模型',
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
  'settings.socket': '用推送的事件流接收回复',
  'settings.usage': '上报估算的 token 用量',
  'save': '保存',
  'saving': '保存中…',
  'reset': '放弃改动',
  'saved': '已保存。',
  'savedRestart': '插件会带着新值重启。',
  'dirty': '有未保存的改动',
  'error.heading': '读不到 Today',
  'diag.socket': '事件流',
  'diag.socketOn': '已启用（连续失败 {failures} 次）',
  'diag.socketOff': '已关闭，改走轮询',
  'diag.empty': '本次运行还没有记录到请求。',
  'diag.probeLabel': '测试单个模型：',
  'diag.probe': '测试',
  'diag.probing': '测试中…',
  'diag.costHint': '每测一次都会真实消耗一次 Today 请求',
  'diag.probeOk': '{model} 可用：{ms}ms，走 {path}。回复：{reply}',
  'diag.probeFail': '{model} 失败（{code}）：{error}',
  'error.statusRoute': '状态接口返回了 HTTP {status}。',
  'error.unauthorized': '这个页面与宿主之间的登录已失效，请重新打开 dsh web 打印的那个地址。',
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
  if (response.status === 401) throw new Error(t('error.unauthorized'))
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

/**
 * Ask the Host to test one model with a real request.
 * @param model - the model id to test.
 * @returns the Host's outcome.
 */
async function writeProbe(model) {
  const response = await fetch(PROBE_ROUTE, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify({ model }),
  })
  try {
    return await response.json()
  } catch {
    return { ok: false, model, errorCode: `HTTP_${response.status}`, error: `HTTP ${response.status}` }
  }
}

/** Shared layout values. */
function styles() {
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  const text = color => ({ color, fontSize: 13, lineHeight: 1.65, margin: 0 })

  /**
   * A pill, used for state and counts.
   * @param color - token carrying the accent.
   * @returns the style record.
   */
  const pill = (color) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '1px 8px',
    borderRadius: 999,
    fontSize: 11,
    lineHeight: 1.7,
    fontWeight: 500,
    color,
    border: `1px solid ${color}`,
  })

  /**
   * A small dot that carries the row's state without competing with the text.
   * @param color - token carrying the state colour.
   * @returns the style record.
   */
  const dot = (color) => ({
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: color,
    flex: '0 0 auto',
    display: 'inline-block',
  })

  return {
    text,
    mono: { fontFamily: MONO, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
    pill,
    dot,

    // Page furniture -------------------------------------------------------
    page: { padding: '6px 0 36px', maxWidth: 820 },
    hero: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 14,
      marginBottom: 22,
    },
    heroTile: {
      flex: '0 0 auto',
      width: 40,
      height: 40,
      borderRadius: 11,
      display: 'grid',
      placeItems: 'center',
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l1)',
    },
    title: {
      margin: 0,
      fontSize: 19,
      fontWeight: 600,
      letterSpacing: '-0.01em',
      color: 'var(--dsw-alias-label-primary)',
    },
    subtitle: {
      ...text('var(--dsw-alias-label-secondary)'),
      fontSize: 12.5,
      marginTop: 3,
      maxWidth: 560,
    },

    // Sections -------------------------------------------------------------
    section: { marginBottom: 26 },
    sectionHead: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      marginBottom: 9,
      minHeight: 22,
    },
    sectionTitle: {
      margin: 0,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.07em',
      textTransform: 'uppercase',
      color: 'var(--dsw-alias-label-secondary)',
    },
    sectionTools: { display: 'flex', alignItems: 'center', gap: 10 },

    // Cards ----------------------------------------------------------------
    card: {
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 12,
      overflow: 'hidden',
      background: 'var(--dsw-alias-bg-layer-1)',
    },
    cardHead: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '11px 14px',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
    },
    cardTitle: {
      margin: 0,
      fontSize: 13,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
    },

    // Rows -----------------------------------------------------------------
    row: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      padding: '11px 14px',
      borderTop: '1px solid var(--dsw-alias-border-l1)',
    },
    rowFirst: { borderTop: 'none' },
    rowLabel: { ...text('var(--dsw-alias-label-secondary)'), flex: '0 0 auto' },
    rowValue: {
      ...text('var(--dsw-alias-label-primary)'),
      textAlign: 'right',
      wordBreak: 'break-all',
      fontFamily: MONO,
      fontSize: 12,
    },
    empty: {
      ...text('var(--dsw-alias-label-secondary)'),
      fontSize: 12.5,
      padding: '22px 14px',
      textAlign: 'center',
    },

    // Controls -------------------------------------------------------------
    input: {
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 7,
      padding: '4px 9px',
      fontSize: 12,
      width: 100,
      fontFamily: MONO,
      outline: 'none',
    },
    button: (disabled) => ({
      appearance: 'none',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 7,
      padding: '4px 11px',
      fontSize: 12,
      fontWeight: 500,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.45 : 1,
      transition: 'opacity 120ms ease',
    }),
    buttonPrimary: (disabled) => ({
      appearance: 'none',
      border: '1px solid transparent',
      background: 'var(--dsw-alias-brand-primary)',
      color: '#fff',
      borderRadius: 7,
      padding: '5px 14px',
      fontSize: 12,
      fontWeight: 600,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.45 : 1,
    }),
    buttonGhost: (disabled) => ({
      appearance: 'none',
      border: '1px solid transparent',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      borderRadius: 7,
      padding: '3px 8px',
      fontSize: 11.5,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.45 : 1,
    }),

    // Layout helpers -------------------------------------------------------
    cluster: { display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' },
    fieldLabel: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      fontSize: 12.5,
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      userSelect: 'none',
    },
    banner: color => ({
      border: `1px solid ${color}`,
      borderRadius: 10,
      padding: '11px 14px',
      marginBottom: 20,
      background: 'var(--dsw-alias-bg-layer-1)',
    }),
  }
}

/**
 * The Settings page.
 * @param props - slot props plus this bundle's own `React`, `t` and `icon`.
 * @returns the rendered page.
 */
/**
 * A small on/off switch.
 *
 * A styled checkbox rather than a new control: the real input stays in the DOM
 * so keyboard focus, space-to-toggle, and screen-reader labelling keep working,
 * and only its box is hidden.
 * @param props - React, checked, onChange, label, id.
 * @returns the rendered switch.
 */
function Toggle(props) {
  const { React, checked, onChange, label, id } = props
  const h = React.createElement
  const track = {
    position: 'relative',
    width: 30,
    height: 17,
    borderRadius: 999,
    flex: '0 0 auto',
    background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
    transition: 'background 140ms ease',
  }
  const thumb = {
    position: 'absolute',
    top: 2,
    left: checked ? 15 : 2,
    width: 13,
    height: 13,
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,.35)',
    transition: 'left 140ms ease',
  }
  return h('label', {
    htmlFor: id,
    style: {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      cursor: 'pointer',
      userSelect: 'none',
    },
  },
  h('input', {
    id,
    type: 'checkbox',
    checked,
    onChange: event => onChange(event.target.checked),
    style: { position: 'absolute', opacity: 0, width: 1, height: 1, margin: 0 },
  }),
  h('span', { style: track }, h('span', { style: thumb })),
  label === undefined ? null : h('span', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' } }, label))
}

/**
 * A horizontal meter, used for the plan's remaining allowance.
 * @param props - React, percent, tone.
 * @returns the rendered bar.
 */
function Meter(props) {
  const { React, percent, tone } = props
  const h = React.createElement
  const width = Math.max(0, Math.min(100, typeof percent === 'number' ? percent : 0))
  return h('div', {
    style: { height: 8, borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' },
  },
  h('div', {
    style: {
      width: `${width}%`,
      height: '100%',
      borderRadius: 999,
      background: tone,
      transition: 'width 240ms ease',
    },
  }))
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
  const [probing, setProbing] = React.useState(undefined)
  const [probeResult, setProbeResult] = React.useState(undefined)

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

  /**
   * Ask the Host to run one real request against a single model.
   *
   * This spends account quota, so it runs only from this explicit click and the
   * section says so before the button.
   * @param model - the model id to test.
   */
  const runProbe = async (model) => {
    setProbing(model)
    setProbeResult(undefined)
    try {
      setProbeResult(await writeProbe(model))
    } catch (error) {
      setProbeResult({ ok: false, model, errorCode: 'CLIENT', error: error instanceof Error ? error.message : String(error) })
    } finally {
      setProbing(undefined)
    }
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

  // ---- building blocks ----
  const data0 = data
  const models = Array.isArray(data0?.models) ? data0.models : []
  const d = draft ?? {}

  /**
   * One titled section.
   * @param titleKey - locale key for the label.
   * @param tools - optional right-hand controls.
   * @param children - the section body.
   * @returns the section element.
   */
  const section = (titleKey, tools, ...children) => h('section', { style: s.section },
    h('div', { style: s.sectionHead },
      h('h3', { style: s.sectionTitle }, t(titleKey)),
      tools === undefined ? null : h('div', { style: s.sectionTools }, tools)),
    ...children)

  /**
   * A labelled row inside a card.
   * @param labelKey - locale key for the label.
   * @param value - the right-hand content.
   * @param first - whether this is the card's first row.
   * @returns the row element.
   */
  const row = (labelKey, value, first) => h('div', {
    style: { ...s.row, ...(first === true ? s.rowFirst : {}) },
  },
  h('span', { style: s.rowLabel }, t(labelKey)),
  h('span', { style: s.rowValue }, value))

  // ---- hero ----
  const identifier = data0?.account?.identifier
  const hero = h('header', { style: s.hero },
    h('div', { style: s.heroTile }, props.icon),
    h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
      h('h2', { style: s.title }, t('page.title')),
      h('p', { style: s.subtitle }, t('page.intro'))),
    h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flex: '0 0 auto' } },
      identifier === undefined
        ? null
        : h('span', { style: { ...s.pill('var(--dsw-alias-border-l2)'), color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } }, identifier),
      h('button', {
        type: 'button',
        onClick: () => { load() },
        disabled: busy,
        style: s.button(busy),
      }, busy ? t('status.refreshing') : t('status.refresh'))))

  const fetchedAt = data0?.fetchedAt === undefined
    ? null
    : h('div', { style: { ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 11, textAlign: 'right', marginBottom: 18 } },
      t('status.fetchedAt', { time: new Date(data0.fetchedAt).toLocaleString() }))

  // ---- failure banner ----
  const errorBox = failing && failureMessage !== undefined
    ? h('div', { style: s.banner('var(--dsw-alias-state-error-primary)') },
      h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 },
      },
      h('span', { style: s.dot('var(--dsw-alias-state-error-primary)') }),
      h('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' } }, t('error.heading'))),
      h('div', { style: s.text('var(--dsw-alias-label-secondary)') }, String(failureMessage)))
    : null

  // ---- account ----
  const accountCard = h('div', { style: s.card },
    row('account.identifier', data0?.account?.identifier ?? t('account.unknown'), true),
    row('account.dataDir', data0?.account?.dataDir ?? '\u2014'))

  // ---- usage ----
  const usage = data0?.usage
  const usageBody = usage?.error !== undefined
    ? h('div', { style: s.empty }, t('usage.unavailable'))
    : usage?.value === undefined
      ? h('div', { style: s.empty }, t('usage.unavailable'))
      : (() => {
        const u = usage.value
        const remaining = typeof u.usedPercent === 'number' ? Math.max(0, 100 - u.usedPercent) : undefined
        const tone = remaining === undefined
          ? 'var(--dsw-alias-state-idle-primary)'
          : remaining <= 15 ? 'var(--dsw-alias-state-error-primary)'
            : remaining <= 40 ? 'var(--dsw-alias-state-warn-primary)'
              : 'var(--dsw-alias-state-success-primary)'
        return h('div', { style: { padding: '14px' } },
          h('div', {
            style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 9 },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 } },
            u.plan === undefined
              ? null
              : h('span', { style: s.pill('var(--dsw-alias-brand-primary)') }, String(u.plan).toUpperCase()),
            remaining === undefined ? null : h('span', {
              style: { ...s.text('var(--dsw-alias-label-primary)'), fontSize: 15, fontWeight: 600 },
            }, u.remainingText ?? `${remaining}%`),
            h('span', { style: { ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 12 } }, t('usage.remaining'))),
          u.resetAt === undefined ? null : h('span', { style: { ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 11.5 } },
            `${t('usage.resetAt')} ${new Date(u.resetAt).toLocaleDateString()}`)),
          remaining === undefined ? null : h(Meter, { React, percent: remaining, tone }),
          Array.isArray(u.items) && u.items.length > 0
            ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 11 } },
              ...u.items.map(item => h('span', { key: item.key, style: { ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 11.5 } },
                `${item.title} ${item.percentText}`)))
            : null)
      })()

  const usageCard = h('div', { style: s.card }, usageBody)

  // ---- models ----
  const hideExpensive = () => {
    setDraft((current) => {
      const base = current ?? toDraft(data0?.config)
      const next = { ...(base.models ?? {}) }
      for (const model of models) {
        if (model.multiplier === undefined) continue
        const weight = Number.parseFloat(String(model.multiplier).replace('\u00d7', ''))
        if (!Number.isFinite(weight) || weight <= 1) continue
        next[model.id] = { ...(next[model.id] ?? {}), hidden: true }
      }
      return { ...base, models: next, dirty: true }
    })
    setSaved(false)
    setSaveError(undefined)
  }

  const modelRow = (model, index) => {
    const entry = draft?.models?.[model.id] ?? {}
    const hidden = entry.hidden === true
    const custom = entry.contextWindow !== undefined
    const stateColor = model.active
      ? 'var(--dsw-alias-state-success-primary)'
      : hidden ? 'var(--dsw-alias-state-idle-primary)' : 'var(--dsw-alias-brand-primary)'

    const contextControl = custom
      ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h('input', {
          type: 'number',
          min: 1000,
          max: 2000000,
          step: 1000,
          value: String(entry.contextWindow),
          onChange: (event) => { setModelContext(model.id, event.target.value) },
          style: { ...s.input, width: 92 },
          'aria-label': `${t('models.context')} ${model.name}`,
        }),
        h('button', {
          type: 'button',
          onClick: () => { setModelContext(model.id, '') },
          title: t('models.useDefault'),
          'aria-label': t('models.useDefault'),
          style: s.buttonGhost(false),
        }, '\u21ba'))
      : h('button', {
        type: 'button',
        onClick: () => { setModelContext(model.id, String(draft?.defaultContextWindow ?? 200000)) },
        style: { ...s.buttonGhost(false), fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
        title: t('models.context'),
      }, t('models.contextDefault', { tokens: (draft?.defaultContextWindow ?? 200000).toLocaleString() }))

    return h('div', {
      key: model.id,
      style: { ...s.row, ...(index === 0 ? s.rowFirst : {}), alignItems: 'center', flexWrap: 'wrap' },
    },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 220px' } },
      h('span', { style: s.dot(stateColor) }),
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' } },
          h('span', { style: { ...s.text('var(--dsw-alias-label-primary)'), fontSize: 13, fontWeight: model.active ? 600 : 450 } }, model.name),
          model.active ? h('span', { style: s.pill('var(--dsw-alias-state-success-primary)') }, t('models.current')) : null,
          hidden ? h('span', {
            style: { ...s.pill('var(--dsw-alias-border-l2)'), color: 'var(--dsw-alias-label-secondary)' },
          }, t('models.hide')) : null),
        h('div', { style: { ...s.mono, fontSize: 11, opacity: 0.85, marginTop: 1 } }, model.id))),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flex: '0 0 auto' } },
      contextControl,
      model.multiplier === undefined
        ? null
        : h('span', {
          style: {
            ...s.pill('var(--dsw-alias-border-l2)'),
            color: 'var(--dsw-alias-label-secondary)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            minWidth: 34,
            justifyContent: 'center',
          },
        }, model.multiplier),
      h(Toggle, {
        React,
        id: `today-model-${model.id}`,
        checked: !hidden,
        onChange: () => { toggleModel(model.id) },
      })))
  }

  const hasPriced = models.some(model => model.multiplier !== undefined
    && Number.parseFloat(String(model.multiplier).replace('\u00d7', '')) > 1)
  const modelsCard = models.length === 0
    ? h('div', { style: s.card }, h('div', { style: s.empty }, t('models.empty')))
    : h('div', { style: s.card }, ...models.map(modelRow))

  // ---- settings ----
  const numberRow = (key, value, onChange, step, first) => h('div', {
    style: { ...s.row, ...(first === true ? s.rowFirst : {}) },
  },
  h('label', { style: s.rowLabel, htmlFor: `today-${key}` }, t(key)),
  h('input', {
    id: `today-${key}`,
    type: 'number',
    step: step ?? 1,
    value: value === undefined ? '' : String(value),
    onChange: event => onChange(event.target.value),
    style: s.input,
  }))

  const toggleRow = (key, checked, onChange, first) => h('div', {
    style: { ...s.row, ...(first === true ? s.rowFirst : {}) },
  },
  h('span', { style: { ...s.rowLabel, color: 'var(--dsw-alias-label-primary)' } }, t(key)),
  h(Toggle, {
    React,
    id: `today-${key}`,
    checked,
    onChange,
  }))

  const settingsRows = [
    numberRow('settings.timeout', d.timeoutMs === undefined ? undefined : Math.round(d.timeoutMs / 1000), (value) => {
      const n = Number(value)
      setField('timeoutMs', Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 300000)
    }, 10, true),
    numberRow('settings.poll', d.pollIntervalMs, (value) => {
      const n = Number(value)
      setField('pollIntervalMs', Number.isFinite(n) ? Math.round(n) : 700)
    }, 50),
    numberRow('settings.refresh', d.refreshModelsMs === undefined ? undefined : Math.round(d.refreshModelsMs / 1000), (value) => {
      const n = Number(value)
      setField('refreshModelsMs', Number.isFinite(n) ? Math.max(0, Math.round(n * 1000)) : 600000)
    }, 60),
    numberRow('settings.context', d.defaultContextWindow, (value) => {
      const n = Number(value)
      setField('defaultContextWindow', Number.isFinite(n) && n > 0 ? Math.round(n) : 200000)
    }, 1000),
    numberRow('settings.concurrency', d.maxConcurrency, (value) => {
      const n = Number(value)
      setField('maxConcurrency', Number.isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : 1)
    }),
    toggleRow('settings.strict', d.strictProtocol === true, checked => setField('strictProtocol', checked)),
    toggleRow('settings.socket', d.useSocket !== false, checked => setField('useSocket', checked)),
    toggleRow('settings.usage', d.reportUsage !== false, checked => setField('reportUsage', checked)),
  ]

  const dirty = draft?.dirty === true
  const saveBar = h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
      padding: '11px 14px',
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
    },
  },
  h('button', {
    type: 'button',
    onClick: save,
    disabled: saving || !dirty,
    style: s.buttonPrimary(saving || !dirty),
  }, saving ? t('saving') : t('save')),
  h('button', {
    type: 'button',
    onClick: () => { setDraft(toDraft(data0?.config)); setSaveError(undefined); setSaved(false) },
    disabled: saving || !dirty,
    style: s.button(saving || !dirty),
  }, t('reset')),
  h('span', { style: { flex: '1 1 auto' } }),
  saved ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--dsw-alias-state-success-primary)' } },
    h('span', { style: s.dot('var(--dsw-alias-state-success-primary)') }), t('savedRestart')) : null,
  saved ? null : dirty ? h('span', { style: { ...s.text('var(--dsw-alias-border-l2)'), fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, t('dirty')) : null,
  saveError === undefined ? null : h('span', {
    style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--dsw-alias-state-error-primary)' },
  }, h('span', { style: s.dot('var(--dsw-alias-state-error-primary)') }), saveError))

  const settingsBody = h('div', { style: s.card }, ...settingsRows, saveBar)

  // ---- diagnostics ----
  const diagnostics = data0?.diagnostics ?? { turns: [], socket: {} }
  const turns = Array.isArray(diagnostics.turns) ? diagnostics.turns.slice().reverse() : []
  const socket = diagnostics.socket ?? {}

  const socketRow = h('div', { style: { ...s.row, ...s.rowFirst } },
    h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('span', {
        style: s.dot(socket.enabled === false
          ? 'var(--dsw-alias-state-warn-primary)'
          : (socket.failures ?? 0) > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)'),
      }),
      h('span', { style: s.rowLabel }, t('diag.socket'))),
    h('span', { style: { ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 12 } },
      socket.enabled === false
        ? t('diag.socketOff')
        : t('diag.socketOn', { failures: socket.failures ?? 0 })))

  const turnRows = turns.length === 0
    ? [h('div', { key: 'none', style: s.empty }, t('diag.empty'))]
    : turns.map((turn, index) => h('div', {
      key: `${turn.at}-${index}`,
      style: { ...s.row, alignItems: 'flex-start', flexWrap: 'wrap' },
    },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, flex: '1 1 260px' } },
      h('span', {
        style: { ...s.dot(turn.ok === true ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)'), marginTop: 6 },
      }),
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { ...s.text('var(--dsw-alias-label-primary)'), fontSize: 12.5, fontWeight: 500 } }, turn.model ?? '?'),
          h('span', { style: s.mono }, `${turn.path ?? '?'}`),
          h('span', { style: s.mono }, `${turn.ms ?? '?'}ms`)),
        turn.errorMessage === undefined
          ? null
          : h('div', {
            style: { ...s.text('var(--dsw-alias-state-error-primary)'), fontSize: 11.5, marginTop: 3, wordBreak: 'break-word', opacity: 0.9 },
          }, String(turn.errorMessage).slice(0, 240)))),
    h('span', {
      style: turn.ok === true
        ? s.pill('var(--dsw-alias-border-l2)')
        : { ...s.pill('var(--dsw-alias-state-error-primary)'), fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      ...(turn.ok === true ? { color: 'var(--dsw-alias-label-secondary)' } : {}),
    }, turn.ok === true ? String(turn.outcome ?? 'ok') : String(turn.errorCode ?? 'error'))))

  const probeRow = h('div', {
    style: { padding: '12px 14px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
  },
  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
    h('span', { style: { ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 12 } }, t('diag.probeLabel')),
    ...models.slice(0, 8).map(model => h('button', {
      key: model.id,
      type: 'button',
      disabled: probing !== undefined,
      style: s.button(probing !== undefined),
      onClick: () => { runProbe(model.id) },
    }, probing === model.id ? t('diag.probing') : model.name))),
  h('div', { style: { ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 11, marginTop: 7, opacity: 0.8 } }, t('diag.costHint')),
  probeResult === undefined
    ? null
    : h('div', {
      style: {
        marginTop: 10,
        padding: '9px 11px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        ...s.text(probeResult.ok === true ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)'),
        fontSize: 12,
        wordBreak: 'break-word',
      },
    },
    probeResult.ok === true
      ? t('diag.probeOk', { model: probeResult.model, ms: probeResult.ms, path: probeResult.path, reply: probeResult.reply })
      : t('diag.probeFail', { model: probeResult.model, code: probeResult.errorCode, error: String(probeResult.error).slice(0, 200) })))

  const diagCard = h('div', { style: s.card }, socketRow, ...turnRows, probeRow)

  // ---- tasks ----
  const tasks = data0?.tasks
  const taskRows = tasks?.value !== undefined && Array.isArray(tasks.value) && tasks.value.length > 0
    ? tasks.value.map((task, index) => h('div', {
      key: task.id,
      style: { ...s.row, ...(index === 0 ? s.rowFirst : {}), alignItems: 'center' },
    },
    h('div', { style: { minWidth: 0 } },
      h('div', {
        style: { ...s.text('var(--dsw-alias-label-primary)'), fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      }, task.name),
      h('div', { style: { ...s.mono, fontSize: 11, marginTop: 1 } },
        `${task.status}${task.taskType === '' ? '' : ` · ${task.taskType}`}`)),
    task.hasUnseenResult
      ? h('span', { style: s.pill('var(--dsw-alias-brand-primary)') }, t('tasks.unseen'))
      : null))
    : [h('div', { key: 'empty', style: s.empty }, tasks?.error !== undefined ? t('tasks.unavailable') : t('tasks.empty'))]
  const tasksCard = h('div', { style: s.card }, ...taskRows)

  // ---- diary ----
  const diary = data0?.diary
  const diaryText = diary?.error !== undefined
    ? t('diary.unavailable')
    : diary?.value === undefined
      ? t('diary.empty')
      : diary.value.excerpt
  const diaryCard = h('div', { style: s.card },
    diary?.value === undefined ? null : h('div', { style: s.cardHead },
      h('span', { style: s.cardTitle }, diary.value.title || diary.value.date),
      h('span', { style: { ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 11.5 } }, diary.value.date ?? '')),
    h('div', {
      style: {
        padding: '13px 14px',
        ...s.text('var(--dsw-alias-label-secondary)'),
        fontSize: 12.5,
        whiteSpace: 'pre-wrap',
        maxHeight: 180,
        overflow: 'auto',
      },
    }, diaryText))

  // ---- notes ----
  const notes = h('div', {
    style: {
      border: '1px dashed var(--dsw-alias-border-l1)',
      borderRadius: 10,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    },
  },
  ...['note.selection', 'note.tokens'].map(key => h('div', {
    key,
    style: { display: 'flex', gap: 8, ...s.text('var(--dsw-alias-label-secondary)'), fontSize: 11.5 },
  },
  h('span', { style: { opacity: 0.6 } }, '\u2022'),
  h('span', null, t(key)))))

  return h('div', { style: s.page },
    hero, fetchedAt, errorBox,
    section('section.account', undefined, accountCard),
    section('section.usage', undefined, usageCard),
    section('section.models', hasPriced
      ? h('button', { type: 'button', onClick: hideExpensive, style: s.buttonGhost(false) }, t('models.hideExpensive'))
      : undefined, modelsCard),
    section('section.settings', undefined, settingsBody),
    section('section.diagnostics', undefined, diagCard),
    section('section.tasks', undefined, tasksCard),
    section('section.diary', undefined, diaryCard),
    notes)
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
    useSocket: source.useSocket,
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
    useSocket: draft.useSocket,
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
