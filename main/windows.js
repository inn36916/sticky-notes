'use strict'

/**
 * 窗口生命周期管理：便签窗、便签中心、格式选择小窗、Mermaid 画板与图片预览窗口。
 */

const path = require('path')
const { pathToFileURL } = require('url')
const { randomUUID } = require('crypto')
const { MIN_W, MIN_H, captureBounds, safeExpandedBounds } = require('../lib/geometry')
const { normalizeNote } = require('../lib/migrations')

/**
 * 创建窗口管理器。
 * @param {object} deps
 */
function createWindowManager ({
  BrowserWindow, screen, shell, ROOT, SRC, ICON,
  getState, findNote, noteWindows, edgeCollapse,
  scheduleSave, broadcast, flushSave, isQuiting
}) {
  let dashboardWin = null
  let diagramWin = null
  let diagramCtx = null
  let previewWin = null
  let convertWin = null
  let convertWinFiles = []

  function noteWindowOf (webContents) {
    for (const [id, w] of noteWindows) {
      if (!w.isDestroyed() && w.webContents === webContents) return { id, win: w }
    }
    return null
  }

  function createNoteWindow (note, { focus = true } = {}) {
    if (note.archivedAt) return null
    if (noteWindows.has(note.id)) {
      const exist = noteWindows.get(note.id)
      if (exist.isDestroyed()) {
        noteWindows.delete(note.id)
      } else {
        exist.show()
        if (focus) exist.focus()
        return exist
      }
    }

    note.bounds = safeExpandedBounds(note.bounds, edgeCollapse.clampBounds(edgeCollapse.nextBounds()))
    const b = edgeCollapse.desiredBounds(note)
    const startCollapsed = !!note.collapsed

    const win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      minWidth: startCollapsed ? edgeCollapse.COLLAPSE_MIN : MIN_W,
      minHeight: startCollapsed ? edgeCollapse.COLLAPSE_MIN : MIN_H,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      title: note.title || '便签',
      icon: ICON,
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false
      }
    })

    noteWindows.set(note.id, win)
    win.setAlwaysOnTop(note.alwaysOnTop, 'screen-saver')
    win.setMenuBarVisibility(false)

    win.loadFile(path.join(SRC, 'note.html'), { query: { id: note.id } })

    const noteUrlPrefix = pathToFileURL(path.join(SRC, 'note.html')).href
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        if (shell && typeof shell.openExternal === 'function') {
          void shell.openExternal(url).catch(() => {})
        }
      }
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
      if (typeof url === 'string' && (url === noteUrlPrefix || url.startsWith(noteUrlPrefix + '?') || url.startsWith(noteUrlPrefix + '#'))) return
      e.preventDefault()
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        if (shell && typeof shell.openExternal === 'function') {
          void shell.openExternal(url).catch(() => {})
        }
      }
    })

    win.once('ready-to-show', () => {
      edgeCollapse.programmaticGuard(win).until = Date.now() + 400
      win.setBounds(edgeCollapse.desiredBounds(note))
      if (note.visible && !note.archivedAt && !(note.collapsed && getState().settings.edgeGroups === true)) {
        win.showInactive()
        if (focus) win.focus()
      }
    })

    let boundsDirty = false
    let moveTimer = null
    const markDirty = () => { boundsDirty = true }
    const isProgrammatic = () => Date.now() < edgeCollapse.programmaticGuard(win).until

    const commitBounds = () => {
      if (!boundsDirty || win.isDestroyed()) return
      boundsDirty = false
      clearTimeout(moveTimer)
      moveTimer = setTimeout(() => {
        if (win.isDestroyed()) return
        const target = findNote(note.id)
        if (!target) return
        const cap = captureBounds(target, win)
        if (!cap.ok) return
        target.bounds = cap.bounds
        scheduleSave()
      }, 200)
    }

    win.on('will-move', () => {
      if (isProgrammatic()) return
      if (!win.__dragOrigin) win.__dragOrigin = win.getBounds()
      win.__dragOriginAt = Date.now()
      win.__userDragged = true
      markDirty()
    })
    win.on('will-resize', () => {
      if (isProgrammatic()) return
      markDirty()
    })
    win.on('resized', () => {
      commitBounds()
      const t = findNote(note.id)
      if (t && !t.collapsed) edgeCollapse.scheduleCollapseCheck(t, win)
    })
    win.on('moved', () => {
      commitBounds()
      const t = findNote(note.id)
      if (!t || isProgrammatic()) return
      if (t.collapsed) {
        const nb = win.getBounds()
        const from = win.__dragOrigin || nb
        const base = t.bounds || nb
        win.__collapseTarget = {
          x: base.x + (nb.x - from.x),
          y: base.y + (nb.y - from.y),
          width: base.width,
          height: base.height
        }
      }
      edgeCollapse.scheduleCollapseCheck(t, win)
    })
    win.on('blur', () => {
      const t = findNote(note.id)
      if (t && !t.collapsed) edgeCollapse.scheduleCollapseCheck(t, win)
    })
    win.on('focus', () => { win.__userDragged = false })

    // 页面重载后校正一次窗口几何（透明窗口偶发被系统改尺寸）
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed() || boundsDirty || isProgrammatic()) return
      const t = findNote(note.id)
      if (!t || !t.bounds) return
      const cur = win.getBounds()
      const want = edgeCollapse.desiredBounds(t)
      if (cur.width !== want.width || cur.height !== want.height || cur.x !== want.x || cur.y !== want.y) {
        edgeCollapse.programmaticGuard(win).until = Date.now() + 400
        win.setBounds(want)
      }
    })

    win.on('close', (e) => {
      if (isQuiting() || win.__forceClose) return
      e.preventDefault()
      const target = findNote(note.id)
      if (target) { target.visible = false; scheduleSave() }
      win.hide()
      broadcast()
    })

    win.on('closed', () => {
      clearTimeout(win.__collapseCheck)
      if (win.__collapseState && win.__collapseState.timer) clearTimeout(win.__collapseState.timer)
      noteWindows.delete(note.id)
    })

    return win
  }

  function createNote (seed = {}) {
    const note = normalizeNote(Object.assign({
      id: randomUUID(),
      bounds: edgeCollapse.nextBounds(),
      visible: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }, seed))
    getState().notes.push(note)
    scheduleSave()
    createNoteWindow(note)
    broadcast()
    return note
  }

  function deleteNote (id) {
    const notes = getState().notes
    const idx = notes.findIndex(n => n.id === id)
    if (idx < 0) return
    notes.splice(idx, 1)
    const win = noteWindows.get(id)
    if (win && !win.isDestroyed()) {
      win.__forceClose = true
      noteWindows.delete(id)
      win.destroy()
    }
    scheduleSave()
    broadcast()
  }

  async function archiveNote (id) {
    const note = findNote(id)
    if (!note || note.archivedAt) return { ok: false, error: '便签已归档或不存在' }
    const previous = { archivedAt: note.archivedAt, visible: note.visible, reminder: note.reminder, bounds: note.bounds }
    const win = noteWindows.get(id)
    if (win && !win.isDestroyed()) {
      const saved = await win.webContents.executeJavaScript('typeof flushSave === "function" ? flushSave() : true')
      if (!saved) return { ok: false, error: '正文保存失败，请重试' }
      if (!note.collapsed) note.bounds = safeExpandedBounds(win.getBounds(), note.bounds)
    }
    note.archivedAt = Date.now()
    note.visible = false
    note.reminder = null
    scheduleSave()
    const result = flushSave ? await flushSave() : { ok: true }
    if (result.ok) { if (win && !win.isDestroyed()) win.hide() }
    else { Object.assign(note, previous); scheduleSave() }
    broadcast()
    return result
  }

  function restoreNote (id) {
    const note = findNote(id)
    if (!note) return
    note.archivedAt = null
    note.visible = false
    scheduleSave()
    broadcast()
  }

  function toggleVisible (id) {
    const note = findNote(id)
    if (!note || note.archivedAt) return
    if (note.visible) {
      note.visible = false
      const w = noteWindows.get(id)
      if (w && !w.isDestroyed()) w.hide()
    } else {
      note.visible = true
      const w = noteWindows.get(id)
      if (w && !w.isDestroyed()) { w.show(); w.focus() } else { createNoteWindow(note) }
    }
    scheduleSave()
    broadcast()
  }

  function setAllVisible (visible) {
    for (const n of getState().notes) {
      if (n.archivedAt) continue
      n.visible = visible
      const w = noteWindows.get(n.id)
      if (!w || w.isDestroyed()) {
        if (visible) createNoteWindow(n, { focus: false })
        continue
      }
      if (visible) w.show()
      else w.hide()
    }
    scheduleSave()
    broadcast()
  }

  function openConvertWindow (files, errInfo) {
    if (!files || !files.length) return
    if (convertWin && !convertWin.isDestroyed()) {
      const sameBatch = files.length === convertWinFiles.length &&
        files.every((f, i) => String(f) === String(convertWinFiles[i]))
      if (!errInfo || !sameBatch) {
        convertWin.webContents.send('convert:files', files)
        convertWinFiles = files.slice()
      }
      if (errInfo) convertWin.webContents.send('convert:error', errInfo)
      convertWin.show()
      convertWin.focus()
      return
    }
    const area = screen.getPrimaryDisplay().workArea
    const width = 420
    const height = Math.min(520, Math.max(320, area.height - 200))
    convertWin = new BrowserWindow({
      width,
      height,
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      title: '格式转换',
      icon: ICON,
      backgroundColor: '#F6F7F9',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    convertWin.setMenuBarVisibility(false)
    convertWin.loadFile(path.join(SRC, 'convert.html'))
    convertWin.webContents.on('did-finish-load', () => {
      if (convertWin.isDestroyed()) return
      convertWin.webContents.send('convert:files', files)
      convertWinFiles = files.slice()
      if (errInfo) convertWin.webContents.send('convert:error', errInfo)
    })
    convertWin.on('closed', () => { convertWin = null; convertWinFiles = [] })
  }

  function openDashboard () {
    if (dashboardWin && !dashboardWin.isDestroyed()) {
      dashboardWin.show()
      dashboardWin.focus()
      return
    }
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(940, Math.max(640, area.width - 140))
    const height = Math.min(660, Math.max(460, area.height - 140))
    dashboardWin = new BrowserWindow({
      width,
      height,
      x: Math.round(area.x + Math.max(48, (area.width - width) * 0.16)),
      y: Math.round(area.y + (area.height - height) / 2),
      minWidth: 620,
      minHeight: 460,
      title: '便签中心',
      icon: ICON,
      backgroundColor: '#F6F7F9',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    dashboardWin.setMenuBarVisibility(false)
    dashboardWin.loadFile(path.join(SRC, 'dashboard.html'))
    dashboardWin.on('closed', () => { dashboardWin = null })
  }

  function suppressNoteTop (on) {
    for (const [id, w] of noteWindows) {
      if (w.isDestroyed()) continue
      const note = findNote(id)
      if (!note) continue
      w.setAlwaysOnTop(on ? false : note.alwaysOnTop, on ? 'normal' : 'screen-saver')
    }
  }

  function openDiagram (ctx) {
    diagramCtx = ctx || {}

    if (diagramWin && !diagramWin.isDestroyed()) {
      suppressNoteTop(true)
      diagramWin.show()
      diagramWin.focus()
      diagramWin.webContents.send('diagram:init', diagramCtx)
      return
    }

    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(1240, Math.round(area.width * 0.84))
    const height = Math.min(840, Math.round(area.height * 0.88))

    diagramWin = new BrowserWindow({
      width,
      height,
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      minWidth: 900,
      minHeight: 580,
      title: 'Mermaid 画板',
      icon: ICON,
      backgroundColor: '#F5F6F8',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    suppressNoteTop(true)
    diagramWin.setMenuBarVisibility(false)
    diagramWin.loadFile(path.join(SRC, 'diagram.html'))

    diagramWin.webContents.on('did-finish-load', () => {
      if (!diagramWin || diagramWin.isDestroyed()) return
      diagramWin.webContents.send('diagram:init', diagramCtx || {})
    })

    diagramWin.on('closed', () => {
      diagramWin = null
      diagramCtx = null
      suppressNoteTop(false)
    })
  }

  function closeDiagram () {
    if (diagramWin && !diagramWin.isDestroyed()) diagramWin.close()
  }

  function openPreview (payload) {
    const dataUrl = payload && payload.dataUrl
    if (!dataUrl) return false

    if (previewWin && !previewWin.isDestroyed()) {
      previewWin.webContents.send('preview:init', payload)
      previewWin.show()
      previewWin.focus()
      return true
    }

    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(1120, Math.round(area.width * 0.82))
    const height = Math.min(840, Math.round(area.height * 0.84))

    previewWin = new BrowserWindow({
      width,
      height,
      minWidth: 360,
      minHeight: 280,
      title: (payload && payload.title) || '查看图片',
      icon: ICON,
      backgroundColor: '#111318',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    previewWin.setMenuBarVisibility(false)
    previewWin.setAlwaysOnTop(true, 'screen-saver')
    previewWin.loadFile(path.join(SRC, 'preview.html'))

    previewWin.webContents.once('did-finish-load', () => {
      if (previewWin && !previewWin.isDestroyed()) {
        previewWin.webContents.send('preview:init', payload)
      }
    })

    previewWin.on('closed', () => { previewWin = null })
    return true
  }

  return {
    noteWindowOf,
    createNoteWindow,
    archiveNote,
    restoreNote,
    createNote,
    deleteNote,
    toggleVisible,
    setAllVisible,
    openConvertWindow,
    openDashboard,
    openDiagram,
    closeDiagram,
    getDiagramCtx: () => diagramCtx,
    openPreview
  }
}

module.exports = { createWindowManager }
