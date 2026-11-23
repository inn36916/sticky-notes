'use strict'

/**
 * 主进程核心业务 IPC 注册（便签读写、便签中心、Mermaid 画板、选图预览、剪贴板与异常上报）。
 */

const fs = require('fs')
const path = require('path')
const { importFile, exportFile, attachmentFile } = require('../lib/note-exchange')
const { storeImage, backupImages } = require('../lib/image-store')
const { createSearchService } = require('./note-search')
const { EDGES, defaultSettings } = require('../lib/migrations')
const { normalizePopupAppearance } = require('../lib/popup-appearance')
const { safeExpandedBounds } = require('../lib/geometry')

function registerCoreIpc ({
  ipcMain, BrowserWindow, dialog, shell, clipboard, nativeImage, screen, app,
  PAD, findNote, meta, getState, noteWindows, windows, edgeCollapse,
  scheduleSave, flushSave, broadcast, appendErrorLog, setGlobalSelect, reminders
}) {
  let imagesBackedUp = false
  ipcMain.on('image:store', (e, dataUrl, legacy) => {
    try {
      if (legacy && !imagesBackedUp) { backupImages(app.getPath('userData')); imagesBackedUp = true }
      e.returnValue = { ok: true, src: storeImage(app.getPath('userData'), dataUrl) }
    } catch (err) { e.returnValue = { ok: false, error: err.message } }
  })

  ipcMain.handle('settings:global-select', (_e, on) => {
    if (typeof on === 'boolean') setGlobalSelect(on)
    return getState().settings.globalSelect === true
  })

  ipcMain.handle('settings:popup-appearance', (_e, patch) => {
    const state = getState()
    const cur = normalizePopupAppearance(state.settings && state.settings.popupAppearance)
    if (patch && typeof patch === 'object') {
      const next = normalizePopupAppearance(patch, cur)
      state.settings = Object.assign(defaultSettings(), state.settings || {}, { popupAppearance: next })
      scheduleSave()
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('settings:popup-appearance-changed', next)
      }
      return next
    }
    return cur
  })

  ipcMain.handle('note:get', (e) => {
    const hit = windows.noteWindowOf(e.sender)
    if (!hit) return null
    const note = findNote(hit.id)
    if (!note) return null
    return Object.assign(meta(note), { html: note.html, pad: PAD })
  })

  // N-01：内容变更走同步 IPC，确保返回时主进程内存已是最新
  ipcMain.on('note:update', (e, patch) => {
    e.returnValue = applyNotePatch(e.sender, patch)
  })

  ipcMain.handle('note:flush', async () => {
    const r = await flushSave()
    if (r.ok) broadcast()
    return r
  })

  function applyNotePatch (sender, patch) {
    const p = (patch && typeof patch === 'object') ? patch : {}
    const hit = windows.noteWindowOf(sender)
    if (!hit) return { ok: false, error: '未找到便签窗口' }
    const note = findNote(hit.id)
    if (!note) return { ok: false, error: '便签不存在' }

    for (const key of ['title', 'html', 'preview', 'color']) {
      if (typeof p[key] === 'string') note[key] = p[key]
    }
    if (p.mode === 'read' || p.mode === 'edit') note.mode = p.mode
    if (p.theme && typeof p.theme === 'object') {
      note.theme = Object.assign({}, note.theme, p.theme)
    }
    if (typeof p.alwaysOnTop === 'boolean') {
      note.alwaysOnTop = p.alwaysOnTop
      const w = noteWindows.get(note.id)
      if (w && !w.isDestroyed()) w.setAlwaysOnTop(note.alwaysOnTop, 'screen-saver')
    }
    if (typeof p.visible === 'boolean') note.visible = p.visible
    if (typeof p.edgeCollapse === 'boolean') {
      note.edgeCollapse = p.edgeCollapse
      if (!note.edgeCollapse && note.collapsed) {
        const w = noteWindows.get(note.id)
        if (w && !w.isDestroyed()) edgeCollapse.expandNote(note, w)
      }
    }
    note.updatedAt = Date.now()
    scheduleSave()
    return { ok: true, persisted: false }
  }

  ipcMain.handle('note:get-bounds', (e) => {
    const hit = windows.noteWindowOf(e.sender)
    if (!hit || hit.win.isDestroyed()) return null
    return hit.win.getBounds()
  })

  ipcMain.handle('note:set-bounds', (e, b) => {
    const hit = windows.noteWindowOf(e.sender)
    if (!hit || hit.win.isDestroyed()) return null
    const note = findNote(hit.id)
    if (note && note.collapsed) return hit.win.getBounds()
    const candidate = {
      x: Math.round(b.x), y: Math.round(b.y),
      width: Math.round(b.width), height: Math.round(b.height)
    }
    const nb = safeExpandedBounds(candidate, note && note.bounds)
    edgeCollapse.programmaticGuard(hit.win).until = Date.now() + 400
    hit.win.setBounds(nb)
    if (note) { note.bounds = nb; scheduleSave() }
    return nb
  })

  ipcMain.handle('note:engage', (e) => {
    const hit = windows.noteWindowOf(e.sender)
    if (hit && !hit.win.isDestroyed()) hit.win.__userDragged = false
    return true
  })

  ipcMain.handle('note:collapse', (e, edge) => {
    const hit = windows.noteWindowOf(e.sender)
    if (!hit) return null
    const note = findNote(hit.id)
    if (!note || hit.win.isDestroyed()) return null
    const ok = edgeCollapse.collapseNote(note, hit.win, EDGES.includes(edge) ? edge : null)
    return { ok, collapsed: note.collapsed, edge: note.collapseEdge || null }
  })

  ipcMain.handle('note:expand', (e) => {
    const hit = windows.noteWindowOf(e.sender)
    if (!hit) return null
    const note = findNote(hit.id)
    if (!note || hit.win.isDestroyed()) return null
    const ok = edgeCollapse.expandNote(note, hit.win)
    return { ok, collapsed: note.collapsed, edge: note.collapseEdge || null }
  })

  ipcMain.handle('note:collapse-get', (e) => {
    const hit = windows.noteWindowOf(e.sender)
    if (!hit) return null
    const note = findNote(hit.id)
    if (!note) return null
    return { collapsed: !!note.collapsed, edge: note.collapseEdge || null }
  })

  ipcMain.handle('note:create', (_e, seed) => {
    const n = windows.createNote(seed || {})
    return meta(n)
  })

  ipcMain.handle('note:duplicate', (e) => {
    const hit = windows.noteWindowOf(e.sender)
    if (!hit) return null
    const src = findNote(hit.id)
    if (!src) return null
    const b = src.bounds || edgeCollapse.nextBounds()
    const n = windows.createNote({
      title: src.title,
      html: src.html,
      preview: src.preview,
      color: src.color,
      theme: Object.assign({}, src.theme),
      bounds: { x: b.x + 30, y: b.y + 30, width: b.width, height: b.height },
      alwaysOnTop: src.alwaysOnTop
    })
    return meta(n)
  })

  ipcMain.handle('note:delete', (e) => {
    const hit = windows.noteWindowOf(e.sender)
    if (!hit) return false
    windows.deleteNote(hit.id)
    void reminders.scan()
    return true
  })

  ipcMain.handle('note:hide', (e) => {
    const hit = windows.noteWindowOf(e.sender)
    if (!hit) return false
    const note = findNote(hit.id)
    if (note) note.visible = false
    hit.win.hide()
    scheduleSave()
    broadcast()
    return true
  })

  ipcMain.handle('note:focus', (e) => {
    const hit = windows.noteWindowOf(e.sender)
    if (hit && !hit.win.isDestroyed()) hit.win.focus()
  })

  // ---- 便签中心
  const search = createSearchService(BrowserWindow)
  ipcMain.handle('notes:import', async (e) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: '导入便签', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown / 纯文本', extensions: ['md', 'markdown', 'txt'] }] })
    if (canceled) return { canceled: true }
    const created = []
    try {
      const seeds = []
      for (const file of filePaths) {
        const seed = await importFile(file, app.getPath('userData'), search.convert)
        created.push(...seed.createdAttachments)
        delete seed.createdAttachments
        seeds.push(seed)
      }
      for (const seed of seeds) windows.createNote(seed)
      return { ok: true, count: seeds.length }
    } catch (err) {
      for (const file of created) fs.unlinkSync(file)
      return { ok: false, error: err.message }
    }
  })
  ipcMain.handle('note:export', async (e, format) => {
    const hit = windows.noteWindowOf(e.sender)
    const note = hit && findNote(hit.id)
    if (!note) return { ok: false, error: '便签不存在' }
    const plain = format === 'txt'
    if (plain) {
      const answer = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), { type: 'info', message: '纯文本仅保留标题、正文文字与图片/图表占位符；任务状态、格式和附件文件请用 Markdown 导出。', buttons: ['继续导出', '取消'], defaultId: 0, cancelId: 1 })
      if (answer.response !== 0) return { canceled: true }
    }
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: (note.title || '便签').replace(/[<>:"/\\|?*]/g, '_') + (plain ? '.txt' : '.md'), filters: [{ name: plain ? '纯文本' : 'Markdown', extensions: [plain ? 'txt' : 'md'] }] })
    if (canceled || !filePath) return { canceled: true }
    return exportFile(note, filePath, app.getPath('userData'), search.convert)
  })
  ipcMain.handle('notes:search', (_e, keyword) => search.query(getState().notes, keyword))
  ipcMain.handle('notes:list', () => getState().notes.map(meta))

  ipcMain.handle('notes:action', async (_e, { id, action, value }) => {
    const note = findNote(id)
    if (!note) return false
    if (note.archivedAt && !['restore', 'delete', 'reminder'].includes(action)) return false
    switch (action) {
      case 'show':
        if (note.archivedAt) return false
        note.lastUsedAt = Date.now()
        note.visible = true
        if (noteWindows.has(id) && !noteWindows.get(id).isDestroyed()) {
          const w = noteWindows.get(id)
          w.show()
          if (note.collapsed) edgeCollapse.expandNote(note, w)
          w.focus()
        } else { windows.createNoteWindow(note) }
        break
      case 'archive': {
        const result = await windows.archiveNote(id)
        void reminders.scan()
        return result
      }
      case 'restore':
        windows.restoreNote(id)
        return true
      case 'reminder': {
        const result = reminders.set(note, value)
        if (!result.ok) return result
        scheduleSave()
        const saved = await flushSave()
        if (!saved.ok) return saved
        void reminders.scan()
        broadcast()
        return result
      }
      case 'hide': {
        note.visible = false
        const w = noteWindows.get(id)
        if (w && !w.isDestroyed()) w.hide()
        break
      }
      case 'pin':
        note.alwaysOnTop = !note.alwaysOnTop
        if (noteWindows.has(id) && !noteWindows.get(id).isDestroyed()) {
          noteWindows.get(id).setAlwaysOnTop(note.alwaysOnTop, 'screen-saver')
        }
        break
      case 'delete':
        windows.deleteNote(id)
        void reminders.scan()
        return true
      case 'color':
        note.color = value
        note.updatedAt = Date.now()
        break
      case 'center': {
        const w = noteWindows.get(id)
        const area = screen.getPrimaryDisplay().workArea
        const b = safeExpandedBounds(note.bounds, edgeCollapse.nextBounds())
        const nx = Math.round(area.x + (area.width - b.width) / 2)
        const ny = Math.round(area.y + (area.height - b.height) / 2)
        note.bounds = Object.assign({}, b, { x: nx, y: ny })
        note.collapsed = false
        note.collapseEdge = null
        if (w && !w.isDestroyed()) edgeCollapse.applyGeometry(w, note)
        edgeCollapse.notifyCollapse(note)
        break
      }
      case 'collapse': {
        const w = noteWindows.get(id)
        if (w && !w.isDestroyed()) edgeCollapse.collapseNote(note, w, null)
        break
      }
      case 'expand': {
        const w = noteWindows.get(id)
        if (w && !w.isDestroyed()) edgeCollapse.expandNote(note, w)
        break
      }
      case 'edge-collapse':
        note.edgeCollapse = value !== false
        break
      default:
        return false
    }
    scheduleSave()
    broadcast()
    return true
  })

  ipcMain.handle('notes:create', (_e, seed) => meta(windows.createNote(seed || {})))
  ipcMain.handle('notes:show-all', () => { windows.setAllVisible(true); return true })
  ipcMain.handle('notes:hide-all', () => { windows.setAllVisible(false); return true })
  ipcMain.handle('app:open-dashboard', () => { windows.openDashboard(); return true })
  ipcMain.handle('app:backup', async () => {
    const result = await flushSave()
    if (!result.ok) return result
    try { return { ok: true, path: backupImages(app.getPath('userData')) } }
    catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('app:open-data-dir', () => shell.openPath(app.getPath('userData')))

  ipcMain.handle('app:client-error', (_e, payload) => {
    const p = (payload && typeof payload === 'object') ? payload : {}
    const msg = String(p.message || '未知错误').slice(0, 1000)
    const head = new Date().toISOString() + ' [' + String(p.kind || 'error').slice(0, 20) + '] ' + msg
    console.error('[renderer]', head)
    const detail = [
      head,
      p.url ? '  url: ' + String(p.url).slice(0, 300) : '',
      p.source ? '  at: ' + String(p.source).slice(0, 300) + ':' + (Number(p.line) || 0) : '',
      p.stack ? String(p.stack).slice(0, 4000) : ''
    ].filter(Boolean).join('\n')
    appendErrorLog(detail)
    return true
  })

  ipcMain.handle('app:copy-text', (_e, text) => {
    const str = typeof text === 'string' ? text : String(text == null ? '' : text)
    try {
      clipboard.writeText(str)
      if (str.length <= 200000) {
        const back = clipboard.readText().replace(/\r\n/g, '\n')
        if (back !== str.replace(/\r\n/g, '\n')) {
          return { ok: false, error: '剪贴板被其他程序占用，请稍后重试' }
        }
      }
      return { ok: true }
    } catch (err) {
      console.error('[copy] 写入剪贴板失败:', err && err.message)
      return { ok: false, error: (err && err.message) || '写入剪贴板失败' }
    }
  })

  // ---- Mermaid 画板
  ipcMain.handle('diagram:open', (e, ctx) => {
    const hit = windows.noteWindowOf(e.sender)
    if (!hit) return false
    windows.openDiagram({
      noteId: hit.id,
      blockId: (ctx && ctx.blockId) || null,
      code: (ctx && ctx.code) || ''
    })
    return true
  })

  ipcMain.handle('diagram:apply', (_e, payload) => {
    const ctx = windows.getDiagramCtx()
    if (!ctx || !ctx.noteId) return false
    const target = noteWindows.get(ctx.noteId)
    const noted = findNote(ctx.noteId)

    if (target && !target.isDestroyed()) {
      if (noted && !noted.visible) noted.visible = true
      target.show()
      target.webContents.send('diagram:applied', {
        code: (payload && payload.code) || '',
        blockId: ctx.blockId || null
      })
      target.focus()
      scheduleSave()
      broadcast()
    }
    windows.closeDiagram()
    return true
  })

  ipcMain.handle('diagram:close', () => { windows.closeDiagram(); return true })

  // ---- 图片
  ipcMain.handle('image:pick', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      title: '选择图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
    })
    if (canceled || !filePaths.length) return null
    const p = filePaths[0]
    const ext = path.extname(p).toLowerCase()
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
          : ext === '.bmp' ? 'image/bmp' : 'image/png'
    try {
      const st = await fs.promises.stat(p)
      if (st.size > 12 * 1024 * 1024) return { error: '图片超过 12MB，请先压缩' }
      const buf = await fs.promises.readFile(p)
      if (buf.length > 12 * 1024 * 1024) return { error: '图片超过 12MB，请先压缩' }
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, name: path.basename(p) }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('image:copy', (_e, source) => {
    try {
      if (typeof source !== 'string') throw new Error('无效图片')
      const image = source.startsWith('data:image/') ? nativeImage.createFromDataURL(source) : nativeImage.createFromPath(attachmentFile(app.getPath('userData'), source))
      if (image.isEmpty()) throw new Error('图片无法解码')
      clipboard.writeImage(image)
      return { ok: true }
    } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('image:preview', (_e, payload) => windows.openPreview(payload))
}

module.exports = { registerCoreIpc }
