'use strict'

/**
 * 截屏选区工具（主进程侧：全屏透明选区层、缩略图抓屏、全局 Esc 护栏、裁剪与保存）。
 */

const fs = require('fs')
const path = require('path')

/**
 * 创建截屏管理器。
 * @param {object} deps
 */
function createCaptureManager ({
  BrowserWindow, screen, desktopCapturer, globalShortcut, dialog,
  clipboard, nativeImage, app, ROOT, SRC,
  noteWindowOf, noteWindows, findNote, scheduleSave, broadcast
}) {
  let captureWin = null
  let captureState = null
  let escGuard = false

  function registerEscGuard () {
    if (escGuard) return
    try {
      escGuard = globalShortcut.register('Escape', () => {
        const win = captureWin
        if (!win || win.isDestroyed()) { releaseEscGuard(); return }
        try {
          win.webContents.send('capture:escape')
        } catch (_) {
          closeCaptureWin()
        }
      })
      if (!escGuard) console.warn('[capture] Esc 全局快捷键注册失败，退回窗口内按键')
    } catch (_) {
      escGuard = false
    }
  }

  function releaseEscGuard () {
    if (!escGuard) return
    escGuard = false
    try { globalShortcut.unregister('Escape') } catch (_) {}
  }

  function closeCaptureWin () {
    const win = captureWin
    captureWin = null
    releaseEscGuard()
    if (win && !win.isDestroyed()) {
      win.__forceClose = true
      win.destroy()
    }
    if (captureState) {
      for (const id of captureState.restore) {
        const w = noteWindows.get(id)
        if (w && !w.isDestroyed() && !findNote(id)?.archivedAt) w.showInactive()
      }
      captureState = null
    }
  }

  async function grabScreen (display, scale, divisor = 1) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(64, Math.round(display.bounds.width * scale / divisor)),
        height: Math.max(64, Math.round(display.bounds.height * scale / divisor))
      }
    })
    const src = sources.find(s => String(s.display_id) === String(display.id)) || sources[0]
    if (!src || src.thumbnail.isEmpty()) throw new Error('未获取到屏幕内容')
    return src.thumbnail
  }

  async function openCaptureForNote (noteId) {
    if (captureWin && !captureWin.isDestroyed()) return { error: '截图正在进行中' }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const scale = display.scaleFactor || 1

    const restore = []
    captureState = { noteId, restore, display, scale }

    const b = display.bounds
    captureWin = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      enableLargerThanScreen: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })

    captureWin.setAlwaysOnTop(true, 'screen-saver')
    captureWin.setMenuBarVisibility(false)
    captureWin.loadFile(path.join(SRC, 'capture.html'))

    captureWin.webContents.once('did-fail-load', () => closeCaptureWin())

    captureWin.webContents.once('did-finish-load', async () => {
      const win = captureWin
      if (!win || win.isDestroyed()) return

      // 先 show 并重新 setBounds 铺满整屏（包括任务栏），再藏便签防止前台丢失
      win.show()
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
      win.focus()
      win.webContents.focus()

      registerEscGuard()

      for (const [id, w] of noteWindows) {
        if (!w.isDestroyed() && w.isVisible()) {
          w.hide()
          restore.push(id)
        }
      }
      if (restore.length) await new Promise(r => setTimeout(r, 260))

      let thumb = ''
      let thumbSize = { width: 0, height: 0 }
      try {
        const img = await grabScreen(display, scale, 2)
        thumbSize = img.getSize()
        thumb = img.toDataURL()
      } catch (err) {
        console.warn('[capture] 缩略图抓取失败，吸附功能不可用:', err.message)
      }

      if (!captureWin || captureWin.isDestroyed()) return

      const wb = captureWin.getBounds()
      captureWin.webContents.send('capture:init', {
        thumb,
        thumbSize,
        viewport: { width: wb.width, height: wb.height },
        display: {
          x: b.x, y: b.y,
          width: b.width, height: b.height,
          scale
        },
        align: { dx: wb.x - b.x, dy: wb.y - b.y }
      })
    })

    captureWin.on('closed', () => {
      captureWin = null
      releaseEscGuard()
      if (captureState) {
        for (const id of captureState.restore) {
          const w = noteWindows.get(id)
          if (w && !w.isDestroyed()) w.showInactive()
        }
        captureState = null
      }
    })

    return { ok: true }
  }

  function registerIpc (ipcMain) {
    ipcMain.handle('capture:start', async (e) => {
      const hit = noteWindowOf(e.sender)
      if (!hit) return { error: '窗口未就绪' }
      return openCaptureForNote(hit.id)
    })

    ipcMain.handle('capture:grab', async (_e, rect) => {
      if (!captureState) return { error: '截图会话已结束' }
      const { display, scale } = captureState
      const sd = scale || 1
      try {
        const full = await grabScreen(display, sd, 1)
        const size = full.getSize()

        const sx = Math.round(rect.x * sd)
        const sy = Math.round(rect.y * sd)
        const sw = Math.max(1, Math.round(rect.w * sd))
        const sh = Math.max(1, Math.round(rect.h * sd))

        const cx = Math.max(0, Math.min(size.width - 1, sx))
        const cy = Math.max(0, Math.min(size.height - 1, sy))
        const cw = Math.max(1, Math.min(size.width - cx, sw))
        const ch = Math.max(1, Math.min(size.height - cy, sh))

        const img = full.crop({ x: cx, y: cy, width: cw, height: ch })
        return { dataUrl: img.toDataURL(), width: cw, height: ch, scale: sd }
      } catch (err) {
        return { error: err.message }
      }
    })

    ipcMain.handle('capture:done', (_e, payload) => {
      const target = captureState ? noteWindows.get(captureState.noteId) : null
      if (target && !target.isDestroyed() && payload && payload.dataUrl) {
        const noted = findNote(captureState.noteId)
        if (!noted || noted.archivedAt) { closeCaptureWin(); return false }
        noted.visible = true; noted.updatedAt = Date.now()
        target.webContents.send('capture:done', { dataUrl: payload.dataUrl })
        target.showInactive()
        scheduleSave()
        broadcast()
      }
      closeCaptureWin()
      return true
    })

    ipcMain.handle('capture:cancel', () => {
      closeCaptureWin()
      return true
    })

    ipcMain.handle('capture:copy', (_e, payload) => {
      try {
        const img = nativeImage.createFromDataURL(String((payload && payload.dataUrl) || ''))
        if (img.isEmpty()) return { error: '图片为空' }
        clipboard.writeImage(img)
        closeCaptureWin()
        return { ok: true }
      } catch (err) {
        return { error: err.message }
      }
    })

    ipcMain.handle('capture:save', async (_e, payload) => {
      const dataUrl = String((payload && payload.dataUrl) || '')
      if (!dataUrl) return { error: '图片为空' }

      const d = new Date()
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
        `_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
      let defaultPath = `截图_${stamp}.png`
      try { defaultPath = path.join(app.getPath('pictures'), `截图_${stamp}.png`) } catch (_) {}

      const parent = captureWin && !captureWin.isDestroyed() ? captureWin : undefined
      releaseEscGuard()
      const { canceled, filePath } = await dialog.showSaveDialog(parent, {
        title: '保存截图',
        defaultPath,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      })
      if (canceled || !filePath) {
        registerEscGuard()
        return { canceled: true }
      }

      try {
        const buf = Buffer.from(dataUrl.split(',')[1] || '', 'base64')
        await fs.promises.writeFile(filePath, buf)
        closeCaptureWin()
        return { ok: true, filePath }
      } catch (err) {
        return { error: err.message }
      }
    })
  }

  return {
    openCaptureForNote,
    closeCaptureWin,
    registerIpc
  }
}

module.exports = { createCaptureManager }
