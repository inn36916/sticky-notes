'use strict'

/**
 * state 迁移层（纯函数，不依赖 Electron / fs，便于回归网直接驱动）。
 *
 * E-02：加载时按 version 走 migrations 注册表；高版本明确拒绝而不是静默降级；
 * 存量里被 L-1 写坏的 50 DIP bounds 在这一层自愈；未知字段不再被白名单吞掉。
 */
const { randomUUID } = require('crypto')
const { recoverBounds } = require('./geometry')
const { normalizePopupAppearance, DEFAULT_POPUP_APPEARANCE } = require('./popup-appearance')
const { normalizeTranslateConfig } = require('./pdf-translate')

const CURRENT_VERSION = 4
const EDGES = ['left', 'right', 'top', 'bottom']

function defaultTheme () {
  return {
    fontFamily: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
    fontSize: 15,
    lineHeight: 1.75,
    radius: 14,
    opacity: 1,
    shadow: true,
    showToolbar: true,
    toolbarPos: 'bottom'
  }
}

function defaultSettings () {
  return {
    globalSelect: false,
    popupAppearance: normalizePopupAppearance(DEFAULT_POPUP_APPEARANCE),
    pdfTranslate: normalizeTranslateConfig()
  }
}

function normalizeSettings (raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  return Object.assign(defaultSettings(), src, {
    globalSelect: src.globalSelect === true,
    popupAppearance: normalizePopupAppearance(src.popupAppearance),
    pdfTranslate: normalizeTranslateConfig(src.pdfTranslate)
  })
}

function defaultAi () {
  return { activeId: '', providers: [] }
}

function normalizeAi (raw) {
  const out = defaultAi()
  if (!raw || typeof raw !== 'object') return out
  const list = Array.isArray(raw.providers) ? raw.providers : []
  out.providers = list
    .filter(p => p && typeof p === 'object')
    .map(p => ({
      id: typeof p.id === 'string' && p.id ? p.id : randomUUID(),
      name: typeof p.name === 'string' ? p.name.slice(0, 60) : '',
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '',
      apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
      models: Array.isArray(p.models)
        ? p.models.filter(m => typeof m === 'string').slice(0, 400)
        : [],
      defaultModel: typeof p.defaultModel === 'string' ? p.defaultModel : '',
      createdAt: p.createdAt || Date.now(),
      updatedAt: p.updatedAt || Date.now()
    }))
  const ids = new Set(out.providers.map(p => p.id))
  out.activeId = ids.has(raw.activeId) ? raw.activeId : (out.providers[0] ? out.providers[0].id : '')
  return out
}

/**
 * 归一化单张便签。与旧版白名单实现的差别：保留未知字段（Object.assign({}, base, out)），
 * 避免未来版本/插件字段在旧程序加载时被静默丢弃（N-02）。
 */
function normalizeNote (n) {
  const base = (n && typeof n === 'object') ? n : {}
  const archivedAt = Number.isFinite(base.archivedAt) && base.archivedAt > 0 ? base.archivedAt : null
  const out = {
    id: base.id || randomUUID(),
    archivedAt,
    reminder: base.reminder && Number.isFinite(base.reminder.at) && ['pending', 'delivered'].includes(base.reminder.status) ? { at: base.reminder.at, status: base.reminder.status } : null,
    title: typeof base.title === 'string' ? base.title : '',
    html: typeof base.html === 'string' ? base.html : '',
    preview: typeof base.preview === 'string' ? base.preview : '',
    color: base.color || '#FFF3B0',
    theme: Object.assign({}, defaultTheme(), base.theme || {}),
    bounds: base.bounds || null,
    alwaysOnTop: base.alwaysOnTop !== false,
    visible: !archivedAt && base.visible !== false,
    mode: base.mode === 'read' ? 'read' : 'edit',
    edgeCollapse: base.edgeCollapse !== false,
    collapsed: base.collapsed === true,
    collapseEdge: EDGES.includes(base.collapseEdge) ? base.collapseEdge : null,
    createdAt: base.createdAt || Date.now(),
    updatedAt: base.updatedAt || Date.now()
  }
  return Object.assign({}, base, out)
}

function emptyState () {
  return {
    version: CURRENT_VERSION,
    notes: [],
    ai: defaultAi(),
    settings: defaultSettings()
  }
}

/**
 * migrations 注册表：键为「源版本」，值为纯函数 (state) => state。
 * 新增结构演进时只需追加一条，并同步提升 CURRENT_VERSION。
 */
const migrations = {
  3: (raw) => ({ notes: raw.notes.map(normalizeNote) }),
  2: (raw) => ({
    settings: Object.assign(normalizeSettings(raw.settings), { globalSelect: false })
  }),
  1: (raw) => {
    const recoveredIds = []
    const notes = raw.notes.map(n => {
      const note = normalizeNote(n)
      const r = recoverBounds(note.bounds)
      if (!note.bounds || r.recovered) {
        note.bounds = r.bounds
        note.boundsRecovered = true       // 原值留在升级前快照里
        recoveredIds.push(note.id)
      }
      return note
    })
    return {
      notes,
      ai: normalizeAi(raw.ai),
      settings: normalizeSettings(raw.settings),
      recoveredIds
    }
  }
}

/**
 * @returns {{ok:boolean, reason:string, state:object|null, changed:boolean,
 *            fromVersion:number, recoveredIds:string[]}}
 *   ok=false + reason='future-version' 时调用方必须拒绝加载并给出用户可见提示，
 *   且不得改写原文件（TC-10：原文件字节不变）。
 */
function migrateState (raw, opts = {}) {
  const current = opts.currentVersion || CURRENT_VERSION
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.notes)) {
    return { ok: false, reason: 'invalid-shape', state: null, changed: false, fromVersion: 0, recoveredIds: [] }
  }
  const fromVersion = Number.isFinite(Number(raw.version)) && Number(raw.version) >= 1
    ? Number(raw.version)
    : 1
  if (fromVersion > current) {
    return { ok: false, reason: 'future-version', state: null, changed: false, fromVersion, recoveredIds: [] }
  }
  if (fromVersion === current) {
    // 已是当前版本：仍做一次归一化 + bounds 自愈。
    // 防复发：即使某个未来版本又把 50 DIP 写回了 v2 文件，加载时也不会被当成合法展开态。
    const recoveredIds = []
    const notes = raw.notes.map(n => {
      const note = normalizeNote(n)
      const r = recoverBounds(note.bounds)
      if (!note.bounds || r.recovered) {
        note.bounds = r.bounds
        note.boundsRecovered = true
        recoveredIds.push(note.id)
      }
      return note
    })
    const state = Object.assign({}, raw, {
      version: current,
      notes,
      ai: normalizeAi(raw.ai),
      settings: normalizeSettings(raw.settings)
    })
    return {
      ok: true, reason: '', state,
      changed: recoveredIds.length > 0, fromVersion, recoveredIds
    }
  }

  let cur = raw
  const recoveredIds = []
  for (let v = fromVersion; v < current; v++) {
    const step = migrations[v]
    if (!step) {
      return { ok: false, reason: 'missing-migration', state: null, changed: false, fromVersion, recoveredIds }
    }
    const next = step(cur)
    cur = Object.assign({}, cur, next, { version: v + 1 })
    recoveredIds.push(...(next.recoveredIds || []))
  }
  // 保留 state 级未知字段，避免一次迁移把未来的顶层字段丢掉
  const state = Object.assign({}, raw, cur, { version: current })
  delete state.recoveredIds        // 迁移过程的内部字段不得写进数据文件
  return { ok: true, reason: '', state, changed: true, fromVersion, recoveredIds }
}

module.exports = {
  CURRENT_VERSION, EDGES,
  defaultTheme, defaultSettings, normalizeSettings, defaultAi, normalizeAi, normalizeNote, emptyState,
  migrateState
}
