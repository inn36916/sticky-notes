'use strict'

/**
 * 桌面便签 - 主进程入口
 * 职责：应用生命周期引导、数据加载/异步落盘（SaveWriter）、领域模块装配与退出收口
 */

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage,
  screen, dialog, Notification, powerMonitor, desktopCapturer, shell, globalShortcut, clipboard, safeStorage
} = require('electron')
const path = require('path')
const fs = require('fs')

const { collectBoundsForQuit } = require('./lib/geometry')
const { defaultSettings, emptyState } = require('./lib/migrations')
const persistence = require('./lib/persistence')
const { SaveWriter } = require('./lib/save-writer')
const convertBridge = require('./lib/convert/main-bridge')
const convertProviders = require('./lib/convert/providers')
const workerHostLib = require('./lib/convert/worker-host')

const { execFileAsync, registerExplorerVerbIpc } = require('./main/explorer-verb')
const { createAiService } = require('./main/ai-service')
const { createEdgeCollapse } = require('./main/edge-collapse')
const { createPdfTranslateService } = require('./main/pdf-translate')
const { createWindowManager } = require('./main/windows')
const { createCaptureManager } = require('./main/capture')
const { createGlobalOverlay } = require('./main/global-overlay')
const { createTrayManager } = require('./main/tray')
const { createEdgeGroups } = require('./main/edge-groups')
const { createReminders } = require('./main/reminders')
const { registerCoreIpc } = require('./main/ipc')

process.on('uncaughtException', (err) => {
  const detail = err && err.stack ? err.stack : String(err)
  console.error('[uncaughtException]', detail)
  appendErrorLog('[main] uncaughtException\n' + detail)
})
process.on('unhandledRejection', (err) => {
  const detail = err && err.stack ? err.stack : String(err)
  console.error('[unhandledRejection]', detail)
  appendErrorLog('[main] unhandledRejection\n' + detail)
})

const PAD = 10
const ROOT = __dirname
const SRC = path.join(ROOT, 'src')
const ICON = path.join(ROOT, 'assets', 'icon.png')

let DATA_FILE = null
let state = emptyState()
let startupWarning = null
let snapshotPending = true

let convertRuntime = null
let convertWorkerHost = null
let isQuiting = false
let quitFlushDone = false
let quitFlushRounds = 0
let quitWatchdog = null
let stateVersion = 0
let flushedVersion = -1
const noteWindows = new Map()

// ---------------------------------------------------------------- 数据层与日志
function initPaths () {
  DATA_FILE = path.join(app.getPath('userData'), 'sticky-notes.json')
}

const RENDER_LOG_MAX = 512 * 1024
function appendErrorLog (text) {
  if (!DATA_FILE) return
  try {
    const file = path.join(path.dirname(DATA_FILE), 'app-errors.log')
    try {
      if (fs.statSync(file).size > RENDER_LOG_MAX) {
        try { fs.rmSync(file + '.1', { force: true }) } catch (_) {}
        fs.renameSync(file, file + '.1')
      }
    } catch (_) {}
    fs.appendFileSync(file, text + '\n', 'utf8')
  } catch (err) {
    console.error('[renderer] 写日志失败:', err.message)
  }
}

function loadState () {
  const r = persistence.readState(DATA_FILE)
  if (!r.ok) {
    state = emptyState()
    startupWarning = (r.error || '数据文件无法读取') +
      '\n\n为避免损坏数据，本次以空数据启动，原文件未做任何修改。请升级程序或手动恢复后再启动。'
    console.error('[load]', startupWarning)
    return
  }
  if (r.reason === 'corrupt') {
    startupWarning = '数据文件损坏，已备份为：\n' + (r.backupPath || '(备份失败)') +
      '\n\n本次以空数据启动，原文件保持不变，可从备份恢复。'
    console.error('[load]', startupWarning)
  } else if (r.reason === 'invalid-shape') {
    startupWarning = '数据文件结构不可识别，已备份为：\n' + (r.backupPath || '(备份失败)')
    console.error('[load]', startupWarning)
  }
  state = r.state
  if (r.needsWrite) {
    void (async () => {
      const res = await getSaveWriter().save(state, { snapshot: false })
      if (!res.ok) console.error('[load] 迁移写回失败:', res.error)
      else snapshotPending = false
    })()
    console.log('[load] 已完成迁移，自愈便签几何:', r.recoveredIds.length, '张')
  }
}

let saveTimer = null
let saveWriter = null

function getSaveWriter () {
  if (!saveWriter) {
    saveWriter = new SaveWriter({
      dataFile: DATA_FILE,
      onFallback: (err) => console.error('[save] 落盘 worker 不可用，退回主进程写:', err && err.message)
    })
  }
  return saveWriter
}

function scheduleSave () {
  stateVersion++
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushSave() }, 250)
}

/**
 * 落盘并返回真实结果；N-04 的「已保存」必须以这里的 ok 为准。
 * @returns {Promise<{ok:boolean, error:string|null, snapshotPath:string|null}>}
 */
async function flushSave () {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  if (!DATA_FILE) return { ok: false, error: '数据路径未初始化', snapshotPath: null }
  const versionAtStart = stateVersion
  // 落盘链路：getSaveWriter().save() → worker 线程 → persistence.writeState()
  //   → 紧凑 JSON + .tmp + rename 原子替换 + 按天快照
  // 返回的 r 就是 persistence.writeState 的真实结果（ok/error 原样透传）
  const r = await getSaveWriter().save(state, { snapshot: snapshotPending })
  if (r.ok) {
    snapshotPending = false
    if (stateVersion === versionAtStart) flushedVersion = versionAtStart
  } else {
    console.error('[save] 写入失败:', r.error)
  }
  return r
}

// ---------------------------------------------------------------- 状态查询与广播
const getState = () => state
const findNote = (id) => state.notes.find(n => n.id === id) || null

function meta (n) {
  return {
    id: n.id,
    archivedAt: n.archivedAt,
    reminder: n.reminder,
    title: n.title,
    preview: n.preview,
    color: n.color,
    theme: n.theme,
    alwaysOnTop: n.alwaysOnTop,
    visible: n.visible,
    mode: n.mode,
    edgeCollapse: n.edgeCollapse !== false,
    collapsed: n.collapsed === true,
    collapseEdge: n.collapseEdge || null,
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
    bounds: n.bounds
  }
}

let trayMgr = null

function broadcast () {
  const payload = state.notes.map(meta)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('notes:changed', payload)
  }
  if (trayMgr) trayMgr.refreshTray()
}

// ---------------------------------------------------------------- 领域模块装配
const aiService = createAiService({ safeStorage, getState, scheduleSave })
const edgeCollapse = createEdgeCollapse({ app, screen, getState, findNote, noteWindows, scheduleSave })
const pdfTranslate = createPdfTranslateService({
  app,
  BrowserWindow,
  dialog,
  shell,
  execFileAsync,
  getState,
  scheduleSave,
  aiService
})
const windows = createWindowManager({
  BrowserWindow, screen, shell, ROOT, SRC, ICON,
  getState, findNote, noteWindows, edgeCollapse,
  scheduleSave, broadcast, flushSave, isQuiting: () => isQuiting
})
const captureMgr = createCaptureManager({
  BrowserWindow, screen, desktopCapturer, globalShortcut, dialog,
  clipboard, nativeImage, app, ROOT, SRC,
  noteWindowOf: windows.noteWindowOf, noteWindows, findNote, scheduleSave, broadcast
})
const globalOverlay = createGlobalOverlay({
  app, BrowserWindow, screen, shell, ROOT, SRC,
  getState, isQuiting: () => isQuiting, execFileAsync, aiService
})

const edgeGroups = createEdgeGroups({ BrowserWindow, screen, ipcMain, getState, noteWindows, edgeCollapse, scheduleSave, broadcast })

function setGlobalSelect (on) {
  state.settings = Object.assign(defaultSettings(), state.settings || {}, { globalSelect: !!on })
  scheduleSave()
  if (on) void globalOverlay.startSelectionProbe()
  else { globalOverlay.stopSelectionProbe(); globalOverlay.hideOverlay() }
  if (trayMgr) trayMgr.refreshTray()
}

trayMgr = createTrayManager({
  Tray, Menu, nativeImage, shell, app, ICON,
  getState,
  createNote: windows.createNote,
  openDashboard: windows.openDashboard,
  toggleVisible: windows.toggleVisible,
  setAllVisible: windows.setAllVisible,
  setGlobalSelect,
  openEdgeGroups: () => edgeGroups.open(),
  requestQuit: () => { isQuiting = true; app.quit() }
})

const reminders = createReminders({
  getNotes: () => state.notes,
  save: async () => { scheduleSave(); const result = await flushSave(); broadcast(); return result },
  notify: (note) => {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: note.title || '便签提醒', body: note.preview || '到时间了，点击打开便签' })
    notification.on('click', () => {
      const current = findNote(note.id)
      if (!current || current.archivedAt) return
      current.visible = true
      const win = windows.createNoteWindow(current)
      if (current.collapsed) edgeCollapse.expandNote(current, win)
      win.show(); win.focus(); scheduleSave(); broadcast()
    })
    notification.show()
  }
})

function registerIpc () {
  registerCoreIpc({
    ipcMain, BrowserWindow, dialog, shell, clipboard, nativeImage, screen, app,
    PAD, findNote, meta, getState, noteWindows, windows, edgeCollapse,
    scheduleSave, flushSave, broadcast, appendErrorLog, setGlobalSelect, reminders
  })
  registerExplorerVerbIpc(ipcMain, { app, appDir: ROOT })
  aiService.registerIpc(ipcMain)
  pdfTranslate.registerIpc(ipcMain)
  captureMgr.registerIpc(ipcMain)
  globalOverlay.registerIpc(ipcMain)
  if (process.env.STICKY_E2E === '1') {
    globalThis.__stickyTestHooks = { globalOverlay, windows }
  }
}

function welcomeHtml () {
  return [
    '<p><b>欢迎使用桌面便签</b></p>',
    '<p>试试这几件事：</p>',
    '<ul>',
    '<li>Ctrl+V 粘贴截图，或点相机一键截屏</li>',
    '<li>点「画板」拖拽画图，或直接写 Mermaid</li>',
    '<li>眼睛图标切阅读模式，鼠标移入才出按钮</li>',
    '<li>点「—」只是收起，内容一直存在本地</li>',
    '</ul>',
    '<p>下图可改代码：</p>',
    '<div class="mmd" contenteditable="false" data-code="graph LR&#10;  A[想法] --&gt; B{可行?}&#10;  B --&gt;|是| C[开工]&#10;  B --&gt;|否| D[再想想]">',
    '<div class="mmd-tools"><button type="button" data-mmd="edit" title="编辑代码">✎</button>',
    '<button type="button" data-mmd="del" title="删除图表">✕</button></div>',
    '<div class="mmd-body"></div>',
    '</div>',
    '<p><br></p>'
  ].join('')
}

// ---------------------------------------------------------------- 应用生命周期
if (app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), 'portable.txt')) && !process.argv.some(arg => arg.startsWith('--user-data-dir'))) {
  const portableData = path.join(path.dirname(process.execPath), 'data')
  fs.mkdirSync(portableData, { recursive: true })
  app.setPath('userData', portableData)
}
// Electron 会重排 second-instance 的 argv，另传原始参数以保持文件边界。
const gotLock = app.requestSingleInstanceLock({ argv: process.argv })
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    const launchArgv = additionalData && Array.isArray(additionalData.argv) ? additionalData.argv : argv
    if (convertRuntime && Array.isArray(launchArgv) && convertRuntime.handleArgv(launchArgv)) {
      return
    }
    for (const [id, w] of noteWindows) if (!w.isDestroyed() && !findNote(id)?.archivedAt) w.show()
    windows.openDashboard()
  })

  app.whenReady().then(() => {
    initPaths()
    loadState()
    aiService.protectStoredAiKeys()
    console.log('[boot] 数据加载完成，便签数:', state.notes.length)
    if (startupWarning) {
      try { dialog.showErrorBox('桌面便签 · 数据文件', startupWarning) } catch (_) {}
    }

    if (app.isPackaged) app.setAppUserModelId('com.sticky.notes')

    convertBridge.registerAttachProtocol({ app })
    registerIpc()
    void reminders.scan()
    powerMonitor.on('resume', () => { void reminders.scan() })
    trayMgr.createTray()
    if (state.settings.globalSelect === true) void globalOverlay.startSelectionProbe()
    edgeCollapse.startCollapsePoll()
    edgeGroups.start()
    console.log('[boot] 托盘就绪')

    convertWorkerHost = workerHostLib.createWorkerHost({ BrowserWindow, srcDir: SRC })

    convertRuntime = convertBridge.setup({
      app,
      providers: convertProviders.createDefaultProviders({
        workerHost: convertWorkerHost,
        appDir: app.getAppPath ? app.getAppPath() : process.execPath,
        userDataDir: app.getPath('userData'),
        log: (m) => {
          try { appendErrorLog(m) } catch (_) {}
        }
      }),
      onOpenConvertWindow: (files, errInfo) => windows.openConvertWindow(files, errInfo),
      onError: (info) => {
        try {
          appendErrorLog('[convert] ' + (info.reason || 'failed') + ' ' + (info.error || ''))
        } catch (_) {}
      }
    })

    convertRuntime.handleArgv(process.argv)

    try {
      globalShortcut.register('CommandOrControl+Alt+N', () => windows.createNote())
      globalShortcut.register('CommandOrControl+Alt+G', () => edgeGroups.open())
      globalShortcut.register('CommandOrControl+Alt+H', () => windows.openDashboard())
    } catch (e) { console.warn('[hotkey]', e.message) }

    const visible = state.notes.filter(n => n.visible && !n.archivedAt)
    if (visible.length === 0 && state.notes.length === 0) {
      windows.createNote({
        title: '欢迎使用桌面便签',
        html: welcomeHtml(),
        preview: '欢迎使用桌面便签 这是一张随手记的便签，试试下面几件事：Ctrl+V 直接粘贴截图，或点工具栏相机图标一键截屏'
      })
    } else {
      visible.forEach((n, i) => setTimeout(() => windows.createNoteWindow(n, { focus: false }), i * 60))
      if (visible.length === 0) setTimeout(() => windows.openDashboard(), 400)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) windows.openDashboard()
    })
  }).catch((err) => {
    const detail = err && err.stack ? err.stack : String(err)
    console.error('[boot] 启动失败:', detail)
    appendErrorLog('[boot] 启动失败\n' + detail)
    try {
      dialog.showErrorBox('桌面便签 · 启动失败',
        '程序初始化时出错，即将退出。\n\n' + String((err && err.message) || err) +
        '\n\n详细日志：' + (DATA_FILE ? path.dirname(DATA_FILE) : '(未知)'))
    } catch (_) {}
    app.quit()
  })

  app.on('before-quit', (e) => {
    if (quitFlushRounds >= 5) {
      console.error('[quit] 落盘反复变化，放弃继续等待，强制退出')
      return
    }
    if (quitFlushDone && stateVersion === flushedVersion) return

    e.preventDefault()
    isQuiting = true
    globalOverlay.stopSelectionProbe()
    const entries = []
    for (const [id, w] of noteWindows) {
      if (w.isDestroyed()) continue
      const note = findNote(id)
      if (note) entries.push({ note, win: w })
    }
    const cap = collectBoundsForQuit(entries)
    if (cap.skipped.length) console.log('[quit] 跳过几何写回:', JSON.stringify(cap.skipped))

    quitFlushRounds++
    void (async () => {
      try {
        const r = await flushSave()
        if (!r.ok) console.error('[quit] 落盘失败:', r.error)
      } catch (err) {
        console.error('[quit] 落盘异常:', err && err.message)
      }
      quitFlushDone = true
      if (quitWatchdog) { clearTimeout(quitWatchdog); quitWatchdog = null }
      app.quit()
    })()

    if (!quitWatchdog) {
      quitWatchdog = setTimeout(() => {
        console.error('[quit] 落盘超时，强制退出')
        quitFlushDone = true
        flushedVersion = stateVersion
        app.exit(0)
      }, 10000)
    }
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    try { globalOverlay.dispose() } catch (_) {}
    edgeCollapse.stopCollapsePoll()
    edgeGroups.stop()
    reminders.stop()
    if (convertWorkerHost) {
      try { convertWorkerHost.dispose() } catch (_) {}
      convertWorkerHost = null
    }
    try { pdfTranslate.dispose().catch(() => {}) } catch (_) {}
  })

  app.on('window-all-closed', () => {
    // 托盘常驻，不退出
  })
}
