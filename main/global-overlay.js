'use strict'

/**
 * 系统级全局划词探针（assets/sel-probe.py）、浮动工具条窗（bar）与可多开独立回答窗口（card）管理。
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { pathToFileURL } = require('url')

/**
 * 创建全局划词悬浮层与独立回答窗口管理器。
 * @param {object} deps
 */
function createGlobalOverlay ({
  app,
  BrowserWindow,
  screen,
  shell,
  ROOT,
  SRC,
  getState,
  isQuiting,
  execFileAsync,
  aiService,
  blurDelayMs
}) {
  let probeProc = null
  let probeBuf = ''
  let probeRestarts = 0

  let cardSeq = 0
  let barEntry = null
  const cardEntries = new Set()
  const entriesByWc = new Map()
  let lastInteractedEntry = null
  let blurTimer = null
  let internalFocusGuardUntil = 0
  const BLUR_DELAY_MS = typeof blurDelayMs === 'number' ? blurDelayMs : 80

  let pythonBinCache = null
  let pythonBinPromise = null
  let probeStarting = false

  function isOverlayWindow (win) {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false
    if (barEntry && barEntry.win === win) return true
    for (const c of cardEntries) {
      if (c.win === win) return true
    }
    return false
  }

  function isAnyDragging () {
    if (barEntry && barEntry.activeDrag) return true
    for (const c of cardEntries) {
      if (c.activeDrag) return true
    }
    return false
  }

  function clearBlurTimer () {
    if (blurTimer) {
      clearTimeout(blurTimer)
      blurTimer = null
    }
  }

  function armFocusGuard (ms = 350) {
    clearBlurTimer()
    internalFocusGuardUntil = Math.max(internalFocusGuardUntil, Date.now() + ms)
  }

  if (app && typeof app.on === 'function') {
    app.on('browser-window-focus', (_ev, win) => {
      clearBlurTimer()
      if (!win) return
      if (isOverlayWindow(win)) {
        const entry = entriesByWc.get(win.webContents)
        if (entry) {
          lastInteractedEntry = entry
          if (entry.kind === 'card' && barEntry && barEntry.active && !barEntry.activeDrag && Date.now() >= internalFocusGuardUntil) {
            hideBarOnly()
          }
        }
        return
      }
      if (!isAnyDragging() && Date.now() >= internalFocusGuardUntil) {
        dismissUnpinned({ includeBar: true })
      }
    })
  }

  function probeScriptPath () {
    return path.join(ROOT, 'assets', 'sel-probe.py')
  }

  async function pythonBin () {
    if (pythonBinCache !== null) return pythonBinCache
    if (pythonBinPromise) return pythonBinPromise
    pythonBinPromise = (async () => {
      const cands = []
      if (process.env.STICKY_PYTHON) cands.push(process.env.STICKY_PYTHON)
      cands.push('python', 'python3', 'py')
      for (const c of cands) {
        try {
          const r = await execFileAsync(c, ['-c', 'import sys;print(sys.version_info[0])'], {
            timeout: 4000, windowsHide: true, encoding: 'utf8'
          })
          if (r && r.status === 0 && String(r.stdout).trim() === '3') {
            pythonBinCache = c
            return c
          }
        } catch (_) {}
      }
      pythonBinCache = ''
      return ''
    })()
    try {
      return await pythonBinPromise
    } finally {
      pythonBinPromise = null
    }
  }

  function isOwnWindow (hwnd) {
    if (!hwnd) return false
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      try {
        const buf = w.getNativeWindowHandle()
        const v = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0)
        if (v === hwnd) return true
      } catch (_) {}
    }
    return false
  }

  function physicalToDip (x, y) {
    const displays = screen.getAllDisplays()
    const hit = displays.find((d) => {
      const b = d.bounds
      const s = d.scaleFactor || 1
      return x >= b.x * s && x < (b.x + b.width) * s && y >= b.y * s && y < (b.y + b.height) * s
    }) || screen.getPrimaryDisplay()
    const s = hit.scaleFactor || 1
    return { x: x / s, y: y / s }
  }

  function safeDisplayAt (pt) {
    if (screen && typeof screen.getDisplayNearestPoint === 'function') {
      return screen.getDisplayNearestPoint(pt || { x: 0, y: 0 })
    }
    if (screen && typeof screen.getPrimaryDisplay === 'function') {
      return screen.getPrimaryDisplay()
    }
    return { workArea: { x: 0, y: 0, width: 1536, height: 816 }, scaleFactor: 1 }
  }

  function safeCursor () {
    if (screen && typeof screen.getCursorScreenPoint === 'function') {
      try {
        const pt = screen.getCursorScreenPoint()
        if (pt && typeof pt.x === 'number' && typeof pt.y === 'number') {
          return { x: Math.round(pt.x), y: Math.round(pt.y) }
        }
      } catch (_) {}
    }
    return null
  }

  function toDipPoint (x, y, fallbackPt) {
    if (screen && typeof screen.screenToDipPoint === 'function') {
      return screen.screenToDipPoint({ x: Math.round(x), y: Math.round(y) })
    }
    const d = safeDisplayAt(fallbackPt)
    const s = d.scaleFactor || 1
    return { x: x / s, y: y / s }
  }

  function entryContainsPhysical (entry, x, y) {
    if (!entry || !entry.win || entry.win.isDestroyed() || !entry.win.isVisible()) return false
    const hasBox = entry.box.w > 0 && entry.box.h > 0
    const b = hasBox ? null : (typeof entry.win.getBounds === 'function' ? entry.win.getBounds() : null)
    const bx = hasBox ? entry.box.x : (b ? b.x : 0)
    const by = hasBox ? entry.box.y : (b ? b.y : 0)
    const bw = hasBox ? entry.box.w : (b ? b.width : 0)
    const bh = hasBox ? entry.box.h : (b ? b.height : 0)
    const pt = toDipPoint(x, y, entry.userPos || entry.anchor)
    return pt.x >= bx && pt.x <= bx + bw && pt.y >= by && pt.y <= by + bh
  }

  function overlayContainsPhysical (x, y) {
    if (entryContainsPhysical(barEntry, x, y)) return true
    for (const c of cardEntries) {
      if (entryContainsPhysical(c, x, y)) return true
    }
    return false
  }

  function syncEntryTopmost (entry) {
    if (!entry || !entry.win || entry.win.isDestroyed()) return
    const shouldTop = entry.mode === 'bar' || entry.pinned
    if (typeof entry.win.setAlwaysOnTop === 'function') {
      entry.win.setAlwaysOnTop(shouldTop, shouldTop ? 'screen-saver' : 'normal')
    }
    if (shouldTop && typeof entry.win.moveTop === 'function') {
      try { entry.win.moveTop() } catch (_) {}
    }
  }

  function attachWindowGuards (win) {
    if (!win || !win.webContents) return
    const overlayUrlPrefix = pathToFileURL(path.join(SRC, 'overlay.html')).href
    if (typeof win.webContents.setWindowOpenHandler === 'function') {
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (typeof url === 'string' && /^https?:\/\//i.test(url) && shell && typeof shell.openExternal === 'function') {
          void shell.openExternal(url).catch(() => {})
        }
        return { action: 'deny' }
      })
    }
    if (typeof win.webContents.on === 'function') {
      win.webContents.on('will-navigate', (e, url) => {
        if (typeof url === 'string' && (url === overlayUrlPrefix || url.startsWith(overlayUrlPrefix + '?') || url.startsWith(overlayUrlPrefix + '#'))) {
          return
        }
        if (e && typeof e.preventDefault === 'function') e.preventDefault()
        if (typeof url === 'string' && /^https?:\/\//i.test(url) && shell && typeof shell.openExternal === 'function') {
          void shell.openExternal(url).catch(() => {})
        }
      })
    }
  }

  function findFallbackCard (excludeEntry) {
    const arr = Array.from(cardEntries)
    for (let i = arr.length - 1; i >= 0; i--) {
      const c = arr[i]
      if (c !== excludeEntry && c.active && c.win && !c.win.isDestroyed() && c.win.isVisible()) {
        return c
      }
    }
    return null
  }

  function hideBarOnly () {
    if (!barEntry) return
    const e = barEntry
    const winVisible = !!(e.win && !e.win.isDestroyed() && e.win.isVisible())
    if (!e.active && !e.pending && !winVisible && !e.activeDrag) return
    e.active = false
    e.pending = false
    e.pinned = false
    e.mode = 'bar'
    e.box = { x: 0, y: 0, w: 0, h: 0 }
    e.contentSize = { w: 0, h: 0 }
    e.activeDrag = null
    e.pendingLoadSender = null
    e.sourceWebContents = null
    e.sourceCardEntry = null
    if (e.win && !e.win.isDestroyed()) {
      if (typeof e.win.setAlwaysOnTop === 'function') {
        e.win.setAlwaysOnTop(false, 'normal')
      }
      if (winVisible) e.win.hide()
    }
  }

  function closeCardEntry (entry, { focusFallback = true } = {}) {
    if (!entry) return
    cardEntries.delete(entry)
    entry.active = false
    entry.pending = false
    entry.pendingLoadSender = null
    entry.activeDrag = null
    if (barEntry && barEntry.active && barEntry.sourceCardEntry === entry) {
      hideBarOnly()
    }
    const wc = entry.wc || (entry.win && !entry.win.isDestroyed() ? entry.win.webContents : null)
    if (wc) {
      entriesByWc.delete(wc)
      if (aiService && typeof aiService.abortByWebContents === 'function') {
        aiService.abortByWebContents(wc)
      }
    }
    let fallback = null
    if (focusFallback) {
      fallback = findFallbackCard(entry)
      if (fallback && fallback.win && typeof fallback.win.focus === 'function') {
        armFocusGuard(320)
        try { fallback.win.focus() } catch (_) {}
        lastInteractedEntry = fallback
      }
    }
    if (!fallback && lastInteractedEntry === entry) {
      lastInteractedEntry = findFallbackCard(entry) || (barEntry && barEntry.active ? barEntry : null)
    }
    if (entry.win && !entry.win.isDestroyed()) {
      if (typeof entry.win.setAlwaysOnTop === 'function') {
        entry.win.setAlwaysOnTop(false, 'normal')
      }
      if (entry.win.isVisible()) entry.win.hide()
      if (typeof entry.win.destroy === 'function') entry.win.destroy()
      else if (typeof entry.win.close === 'function') entry.win.close()
    }
  }

  function dismissUnpinned ({ includeBar = true } = {}) {
    clearBlurTimer()
    if (includeBar && barEntry && !(barEntry.mode === 'card' && barEntry.pinned)) {
      hideBarOnly()
    }
    for (const c of Array.from(cardEntries)) {
      if (!c.pinned && !c.activeDrag) {
        closeCardEntry(c, { focusFallback: false })
      }
    }
  }

  function handleEntryBlur (entry) {
    if (!entry || !entry.active || entry.pinned || isAnyDragging()) return
    if (Date.now() < internalFocusGuardUntil) return

    if (typeof BrowserWindow.getFocusedWindow === 'function') {
      const focused = BrowserWindow.getFocusedWindow()
      if (isOverlayWindow(focused)) {
        if (entry.kind === 'bar' && focused !== entry.win) {
          hideBarOnly()
        }
        return
      }
      if (focused) {
        dismissUnpinned({ includeBar: true })
        return
      }
      clearBlurTimer()
      blurTimer = setTimeout(() => {
        blurTimer = null
        if (isAnyDragging() || Date.now() < internalFocusGuardUntil) return
        const cur = BrowserWindow.getFocusedWindow()
        if (isOverlayWindow(cur)) return
        dismissUnpinned({ includeBar: true })
      }, BLUR_DELAY_MS)
      return
    }

    dismissUnpinned({ includeBar: true })
  }

  function createEntry (kind) {
    const isCard = kind === 'card'
    const id = isCard ? ++cardSeq : 0
    const win = new BrowserWindow({
      width: isCard ? 436 : 240,
      height: isCard ? 260 : 40,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      focusable: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })
    win.setMenuBarVisibility(false)
    attachWindowGuards(win)
    const wc = win.webContents

    const entry = {
      id,
      kind: isCard ? 'card' : 'bar',
      win,
      wc,
      ready: false,
      pending: false,
      active: false,
      mode: isCard ? 'card' : 'bar',
      pinned: false,
      focusOnShow: false,
      anchor: { x: 0, y: 0 },
      box: { x: 0, y: 0, w: 0, h: 0 },
      contentSize: { w: 0, h: 0 },
      userPos: null,
      activeDrag: null,
      pendingLoadSender: null,
      sourceWebContents: null,
      canInsert: false,
      sourceCardEntry: null
    }

    if (isCard) cardEntries.add(entry)
    else barEntry = entry
    entriesByWc.set(wc, entry)

    wc.on('did-finish-load', () => {
      entry.ready = true
      if (entry.pendingLoadSender && !win.isDestroyed()) {
        const fn = entry.pendingLoadSender
        entry.pendingLoadSender = null
        fn(entry)
      }
    })

    const query = isCard ? { role: 'card', id: String(id) } : { role: 'bar' }
    win.loadFile(path.join(SRC, 'overlay.html'), { query })

    win.on('blur', () => handleEntryBlur(entry))
    win.on('closed', () => {
      if (entry.kind === 'bar') {
        if (barEntry === entry) barEntry = null
      } else {
        cardEntries.delete(entry)
        if (barEntry && barEntry.sourceCardEntry === entry) {
          barEntry.sourceCardEntry = null
        }
      }
      if (wc) {
        entriesByWc.delete(wc)
        if (aiService && typeof aiService.abortByWebContents === 'function') {
          aiService.abortByWebContents(wc)
        }
      }
      entry.active = false
      entry.pending = false
      entry.activeDrag = null
      entry.pendingLoadSender = null
      if (lastInteractedEntry === entry) {
        lastInteractedEntry = findFallbackCard(entry) || (barEntry && barEntry.active ? barEntry : null)
      }
    })

    return entry
  }

  function ensureBarEntry () {
    if (barEntry && barEntry.win && !barEntry.win.isDestroyed()) return barEntry
    return createEntry('bar')
  }

  function deliverWhenReady (entry, sendFn) {
    if (entry.ready) {
      entry.pendingLoadSender = null
      sendFn(entry)
    } else {
      entry.pendingLoadSender = sendFn
    }
    return entry
  }

  function showOverlay (text, anchor, opts = {}) {
    clearBlurTimer()
    const entry = ensureBarEntry()
    entry.active = true
    entry.mode = 'bar'
    entry.pinned = false
    entry.userPos = null
    entry.activeDrag = null
    entry.anchor = {
      x: Math.round(anchor.x),
      y: Math.round(anchor.y),
      bottomY: anchor.bottomY != null ? Math.round(anchor.bottomY) : null
    }
    entry.pending = true
    entry.box = { x: 0, y: 0, w: 0, h: 0 }
    entry.contentSize = { w: 0, h: 0 }
    entry.sourceWebContents = opts.sourceWebContents || null
    entry.sourceCardEntry = opts.sourceCardEntry || null
    lastInteractedEntry = entry
    deliverWhenReady(entry, (ent) => ent.win.webContents.send('overlay:show', { text, managed: true }))
    syncEntryTopmost(entry)
  }

  function computeCardPosition (desiredX, desiredY, estW, estH, skipCascade = false) {
    const d = safeDisplayAt({ x: desiredX, y: desiredY })
    const wa = d.workArea
    const minX = wa.x + 4
    const maxX = Math.max(minX, wa.x + wa.width - estW - 4)
    const minY = wa.y + 4
    const maxY = Math.max(minY, wa.y + wa.height - estH - 4)

    let x = Math.max(minX, Math.min(Math.round(desiredX), maxX))
    let y = Math.max(minY, Math.min(Math.round(desiredY), maxY))

    if (!skipCascade) {
      for (let iter = 0; iter < 12; iter++) {
        let hit = false
        for (const c of cardEntries) {
          if (!c.active || !c.win || c.win.isDestroyed()) continue
          if (c.box.w > 0 && Math.abs(c.box.x - x) < 22 && Math.abs(c.box.y - y) < 22) {
            hit = true
            break
          }
        }
        if (!hit) break
        x += 28
        y += 28
        if (x > maxX) x = minX + ((iter * 19) % Math.max(28, maxX - minX + 1))
        if (y > maxY) y = minY + ((iter * 19) % Math.max(28, maxY - minY + 1))
        x = Math.max(minX, Math.min(x, maxX))
        y = Math.max(minY, Math.min(y, maxY))
      }
    }
    return { x, y }
  }

  function openCard (payload, senderWebContents, { forcePinned = false } = {}) {
    armFocusGuard(450)
    const p = (payload && typeof payload === 'object') ? payload : {}
    const senderEntry = senderWebContents ? entriesByWc.get(senderWebContents) : null
    const senderWin = (senderWebContents && typeof BrowserWindow.fromWebContents === 'function')
      ? BrowserWindow.fromWebContents(senderWebContents)
      : null

    let sourceWebContents = null
    let canInsert = false
    if (p.canInsert && senderWebContents && !senderEntry) {
      sourceWebContents = senderWebContents
      canInsert = true
    } else if (senderEntry && senderEntry.sourceWebContents && !senderEntry.sourceWebContents.isDestroyed()) {
      sourceWebContents = senderEntry.sourceWebContents
      canInsert = true
    }

    const estW = Math.max(40, Math.round(Number(p.rect && p.rect.w) || 436))
    const estH = Math.max(30, Math.round(Number(p.rect && p.rect.h) || 260))

    let rawX
    let rawY
    if (senderEntry && senderEntry.kind === 'bar') {
      if (senderEntry.userPos) {
        rawX = senderEntry.userPos.x
        rawY = senderEntry.userPos.y
      } else {
        const dAnchor = safeDisplayAt(senderEntry.anchor)
        const waAnchor = dAnchor.workArea
        rawX = Math.round(senderEntry.anchor.x - estW / 2)
        const baseBottom = senderEntry.anchor.bottomY != null ? senderEntry.anchor.bottomY : senderEntry.anchor.y
        rawY = Math.round(baseBottom + 18)
        if (rawY + estH > waAnchor.y + waAnchor.height - 4) {
          rawY = Math.round(senderEntry.anchor.y - estH - 18)
        }
      }
    } else if (senderWin && !senderWin.isDestroyed() && typeof senderWin.getContentBounds === 'function' && p.rect) {
      const cb = senderWin.getContentBounds()
      if (forcePinned) {
        rawX = Math.round(cb.x + (Number(p.rect.x) || 0) - 8)
        rawY = Math.round(cb.y + (Number(p.rect.y) || 0) - 8)
      } else {
        const dWin = safeDisplayAt({ x: cb.x, y: cb.y })
        const waWin = dWin.workArea
        rawX = Math.round(cb.x + (Number(p.rect.x) || 0))
        const rectBottom = p.rect.bottom != null ? Number(p.rect.bottom) : ((Number(p.rect.y) || 0) + (Number(p.rect.h) || 20))
        rawY = Math.round(cb.y + rectBottom + 10)
        if (rawY + estH > waWin.y + waWin.height - 4) {
          const above = Math.round(cb.y + (Number(p.rect.y) || 0) - estH - 10)
          if (above >= waWin.y + 4) rawY = above
        }
      }
    } else if (p.rect && typeof p.rect.x === 'number' && typeof p.rect.y === 'number') {
      rawX = Math.round(p.rect.x)
      rawY = Math.round(p.rect.y)
    } else {
      const primary = (screen && typeof screen.getPrimaryDisplay === 'function')
        ? screen.getPrimaryDisplay()
        : safeDisplayAt({ x: 0, y: 0 })
      const wa = primary.workArea
      rawX = Math.round(wa.x + (wa.width - estW) / 2)
      rawY = Math.round(wa.y + (wa.height - estH) / 2)
    }

    const pos = computeCardPosition(rawX, rawY, estW, estH, forcePinned && cardEntries.size === 0)
    if (senderEntry && senderEntry.kind === 'bar') {
      hideBarOnly()
    }

    const cardEntry = createEntry('card')
    cardEntry.active = true
    cardEntry.pending = true
    cardEntry.mode = 'card'
    cardEntry.pinned = forcePinned || !!p.pinned
    cardEntry.focusOnShow = true
    cardEntry.userPos = { x: pos.x, y: pos.y }
    cardEntry.anchor = { x: pos.x, y: pos.y }
    cardEntry.box = { x: pos.x, y: pos.y, w: estW, h: estH }
    cardEntry.contentSize = { w: estW, h: estH }
    cardEntry.sourceWebContents = sourceWebContents
    cardEntry.canInsert = canInsert
    lastInteractedEntry = cardEntry

    const hasHydration = !!(p.turns || p.raw || p.requestId)
    const cardPayload = {
      action: p.action || 'explain',
      text: String(p.text || ''),
      question: String(p.question || ''),
      requestId: String(p.requestId || ''),
      raw: String(p.raw || ''),
      done: !!p.done,
      error: String(p.error || ''),
      provider: String(p.provider || ''),
      model: String(p.model || ''),
      turns: Array.isArray(p.turns) ? p.turns : null,
      pinned: cardEntry.pinned,
      canInsert,
      autoRun: hasHydration ? false : (p.autoRun !== false)
    }

    deliverWhenReady(cardEntry, (ent) => ent.win.webContents.send('overlay:show-card', cardPayload))

    if (p.requestId && !p.done && aiService && typeof aiService.retargetRequest === 'function') {
      aiService.retargetRequest(String(p.requestId), cardEntry.win.webContents)
    }

    syncEntryTopmost(cardEntry)
    return {
      ok: true,
      id: cardEntry.id,
      pinned: cardEntry.pinned,
      alwaysOnTop: typeof cardEntry.win.isAlwaysOnTop === 'function' ? cardEntry.win.isAlwaysOnTop() : cardEntry.pinned
    }
  }

  function hideOverlay () {
    dismissUnpinned({ includeBar: true })
  }

  function dispose () {
    stopSelectionProbe()
    clearBlurTimer()
    if (barEntry) {
      const b = barEntry
      barEntry = null
      if (b.wc) entriesByWc.delete(b.wc)
      if (b.win && !b.win.isDestroyed()) {
        if (typeof b.win.destroy === 'function') b.win.destroy()
        else if (b.win.isVisible()) b.win.hide()
      }
    }
    for (const c of Array.from(cardEntries)) {
      closeCardEntry(c, { focusFallback: false })
    }
  }

  function layoutEntry (entry, w, h, mode) {
    if (!entry || !entry.active || !entry.win || entry.win.isDestroyed()) return
    const win = entry.win
    const prevMode = entry.mode
    entry.mode = entry.kind === 'card' ? 'card' : (mode === 'card' ? 'card' : 'bar')
    const width = Math.max(40, Math.round(w))
    const height = Math.max(30, Math.round(h))
    entry.contentSize = { w: width, h: height }

    const d = safeDisplayAt(entry.userPos || entry.anchor)
    const wa = d.workArea
    const gap = 12

    let x
    let y

    if (entry.userPos) {
      x = entry.userPos.x
      y = entry.userPos.y
    } else if (entry.activeDrag) {
      x = entry.activeDrag.startX
      y = entry.activeDrag.startY
    } else {
      x = Math.round(entry.anchor.x - width / 2)
      y = entry.mode === 'card'
        ? Math.round((entry.anchor.bottomY != null ? entry.anchor.bottomY : entry.anchor.y) + 18)
        : Math.round(entry.anchor.y - height - gap)

      if (entry.mode !== 'card' && y < wa.y + 4) {
        y = entry.anchor.bottomY != null ? Math.round(entry.anchor.bottomY + 8) : Math.round(entry.anchor.y + 22)
      }
      if (entry.mode === 'card' && y + height > wa.y + wa.height - 4) {
        y = Math.round(entry.anchor.y - height - 18)
      }
    }

    y = Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - height - 4))
    x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - width - 4))

    entry.box = { x, y, w: width, h: height }
    win.setBounds({ x, y, width, height })
    syncEntryTopmost(entry)

    if (entry.pending || !win.isVisible()) {
      entry.pending = false
      if (entry.kind === 'card') armFocusGuard(350)
      win.showInactive()
      syncEntryTopmost(entry)
      if (entry.kind === 'card' && entry.focusOnShow) {
        entry.focusOnShow = false
        if (typeof win.focus === 'function') {
          try { win.focus() } catch (_) {}
        }
        if (!entry.pinned && typeof win.moveTop === 'function') {
          try { win.moveTop() } catch (_) {}
        }
      }
    } else if (entry.kind === 'bar' && entry.mode === 'card' && !entry.pinned && prevMode !== 'card' && typeof win.moveTop === 'function') {
      try { win.moveTop() } catch (_) {}
    }
  }

  function handleProbeEvent (ev) {
    if (!ev || typeof ev !== 'object') return
    if (ev.t === 'ready') { probeRestarts = 0; return }
    if (ev.t === 'skip-own') {
      console.log('[probe] 跳过自家窗口的选择')
      return
    }
    if (ev.t === 'down') {
      if (overlayContainsPhysical(ev.x, ev.y)) {
        armFocusGuard(250)
        return
      }
      dismissUnpinned({ includeBar: true })
      return
    }
    if (ev.t !== 'sel') return
    if (barEntry && barEntry.active && barEntry.mode === 'card' && barEntry.pinned) return
    const state = getState()
    if (!state.settings || state.settings.globalSelect !== true) return
    if (isOwnWindow(ev.hwnd)) { console.log('[probe] 忽略自家窗口的选择'); return }
    const text = String(ev.text || '').trim()
    if (text.length < 2) return
    console.log('[probe] 选中', text.length, '字 ·', ev.cls)
    const a = physicalToDip(ev.x0 != null ? ev.x0 : ev.x, ev.y0 != null ? ev.y0 : ev.y)
    const b = physicalToDip(ev.x, ev.y)
    showOverlay(text, { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) })
  }

  async function startSelectionProbe () {
    const state = getState()
    if (probeProc || probeStarting || isQuiting()) return
    if (!state.settings || state.settings.globalSelect !== true) return

    const script = probeScriptPath()
    if (!fs.existsSync(script)) {
      console.warn('[probe] 缺少脚本:', script)
      return
    }
    probeStarting = true
    let py = ''
    try {
      py = await pythonBin()
    } catch (_) {
      py = ''
    } finally {
      probeStarting = false
    }
    const curState = getState()
    if (isQuiting() || probeProc) return
    if (!curState.settings || curState.settings.globalSelect !== true) return

    if (!py) {
      console.warn('[probe] 没有可用的 Python 3，全局划词已禁用（页面内划词不受影响）')
      return
    }

    try {
      probeProc = spawn(py, ['-u', script, '--parent-pid', String(process.pid),
        '--owner-pid', String(process.pid)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      console.warn('[probe] 启动失败:', err.message)
      probeProc = null
      return
    }

    probeProc.on('error', (err) => {
      console.warn('[probe] 无法启动 Python（全局划词不可用）:', err.message)
      probeProc = null
    })

    probeProc.stdout.setEncoding('utf8')
    probeProc.stdout.on('data', (chunk) => {
      probeBuf += chunk
      const lines = probeBuf.split('\n')
      probeBuf = lines.pop()
      for (const line of lines) {
        const s = line.trim()
        if (!s) continue
        try { handleProbeEvent(JSON.parse(s)) } catch (_) {}
      }
    })

    probeProc.stderr.setEncoding('utf8')
    probeProc.stderr.on('data', (t) => console.warn('[probe]', String(t).trim().slice(0, 300)))

    probeProc.on('exit', () => {
      probeProc = null
      if (isQuiting()) return
      const s = getState()
      if (!s.settings || s.settings.globalSelect !== true) return
      if (probeRestarts >= 3) { console.warn('[probe] 反复退出，停止重启'); return }
      probeRestarts += 1
      setTimeout(() => { void startSelectionProbe() }, 1500)
    })
  }

  function stopSelectionProbe () {
    const p = probeProc
    probeProc = null
    if (p && !p.killed) { try { p.kill() } catch (_) {} }
  }

  function registerIpc (ipcMain) {
    ipcMain.handle('overlay:size', (e, payload) => {
      const entry = entriesByWc.get(e.sender)
      if (!entry || !entry.win || entry.win.isDestroyed()) return false
      const p = payload || {}
      layoutEntry(entry, p.w, p.h, p.mode)
      return true
    })

    ipcMain.handle('overlay:close', (e) => {
      const entry = entriesByWc.get(e.sender)
      if (!entry) {
        hideOverlay()
        return true
      }
      if (entry.kind === 'bar' && !(entry.mode === 'card' && cardEntries.has(entry))) {
        const srcCard = entry.sourceCardEntry
        hideBarOnly()
        if (srcCard && srcCard.active && srcCard.win && !srcCard.win.isDestroyed() && srcCard.win.isVisible()) {
          if (typeof srcCard.win.focus === 'function') {
            armFocusGuard(250)
            try { srcCard.win.focus() } catch (_) {}
          }
        }
        return true
      }
      closeCardEntry(entry, { focusFallback: true })
      return true
    })

    ipcMain.handle('overlay:focus', (e) => {
      const entry = entriesByWc.get(e.sender)
      if (!entry || !entry.win || entry.win.isDestroyed()) return false
      armFocusGuard(350)
      entry.win.focus()
      return true
    })

    ipcMain.handle('overlay:move', (e, payload) => {
      const entry = entriesByWc.get(e.sender)
      if (!entry || !entry.win || entry.win.isDestroyed()) return false
      const win = entry.win
      const p = payload || {}
      const b = win.getBounds()
      const hasBox = entry.box.w > 0 && entry.box.h > 0
      const curX = hasBox ? entry.box.x : b.x
      const curY = hasBox ? entry.box.y : b.y
      const w = entry.contentSize.w || entry.box.w || b.width
      const h = entry.contentSize.h || entry.box.h || b.height

      if (p.phase === 'start') {
        armFocusGuard(200)
        entry.activeDrag = {
          id: p.dragId,
          startX: curX,
          startY: curY,
          startCursor: safeCursor(),
          useCursor: false
        }
        return { ok: true, x: curX, y: curY, pinned: entry.pinned }
      }

      let rawX
      let rawY
      if (typeof p.dx === 'number' && typeof p.dy === 'number') {
        if (!entry.activeDrag || entry.activeDrag.id !== p.dragId) {
          entry.activeDrag = {
            id: p.dragId,
            startX: curX,
            startY: curY,
            startCursor: safeCursor(),
            useCursor: false
          }
        }
        const cur = safeCursor()
        if (entry.activeDrag.startCursor && cur && (
          entry.activeDrag.useCursor ||
          cur.x !== entry.activeDrag.startCursor.x ||
          cur.y !== entry.activeDrag.startCursor.y
        )) {
          entry.activeDrag.useCursor = true
          rawX = entry.activeDrag.startX + (cur.x - entry.activeDrag.startCursor.x)
          rawY = entry.activeDrag.startY + (cur.y - entry.activeDrag.startCursor.y)
        } else {
          rawX = entry.activeDrag.startX + p.dx
          rawY = entry.activeDrag.startY + p.dy
        }
      } else if (typeof p.x === 'number' && typeof p.y === 'number') {
        rawX = p.x
        rawY = p.y
      } else if (p.phase === 'end' || p.end) {
        entry.activeDrag = null
        return { ok: true, x: curX, y: curY, pinned: entry.pinned }
      } else {
        return false
      }

      const d = safeDisplayAt({ x: Math.round(rawX), y: Math.round(rawY) })
      const wa = d.workArea
      const x = Math.max(wa.x + 2, Math.min(Math.round(rawX), wa.x + wa.width - w - 2))
      const y = Math.max(wa.y + 2, Math.min(Math.round(rawY), wa.y + wa.height - h - 2))
      entry.userPos = { x, y }
      entry.box = { x, y, w, h }
      win.setBounds({ x, y, width: w, height: h })
      if (p.end || p.phase === 'end') entry.activeDrag = null
      return { ok: true, x, y, pinned: entry.pinned }
    })

    ipcMain.handle('overlay:pin', (e, on) => {
      const entry = entriesByWc.get(e.sender)
      if (!entry || !entry.win || entry.win.isDestroyed()) return false
      entry.pinned = !!on
      const b = entry.win.getBounds()
      if (entry.userPos) {
        entry.userPos = { x: entry.userPos.x, y: entry.userPos.y }
      } else if (entry.box.w > 0) {
        entry.userPos = { x: entry.box.x, y: entry.box.y }
      } else {
        entry.userPos = { x: b.x, y: b.y }
      }
      syncEntryTopmost(entry)
      if (!entry.pinned && entry.win.isVisible() && typeof entry.win.focus === 'function') {
        const focused = typeof entry.win.isFocused === 'function' ? entry.win.isFocused() : false
        if (!focused) {
          try { entry.win.focus() } catch (_) {}
        }
      }
      return {
        ok: true,
        pinned: entry.pinned,
        alwaysOnTop: typeof entry.win.isAlwaysOnTop === 'function' ? entry.win.isAlwaysOnTop() : entry.pinned
      }
    })

    ipcMain.handle('overlay:open-card', (e, payload) => openCard(payload, e.sender, { forcePinned: false }))
    ipcMain.handle('overlay:pin-card', (e, payload) => openCard(payload, e.sender, { forcePinned: true }))

    ipcMain.handle('overlay:show-bar', (e, payload) => {
      const p = (payload && typeof payload === 'object') ? payload : {}
      const senderEntry = entriesByWc.get(e.sender)
      const senderWin = senderEntry
        ? senderEntry.win
        : ((typeof BrowserWindow.fromWebContents === 'function') ? BrowserWindow.fromWebContents(e.sender) : null)
      const cb = (senderWin && !senderWin.isDestroyed())
        ? (typeof senderWin.getContentBounds === 'function'
            ? senderWin.getContentBounds()
            : (typeof senderWin.getBounds === 'function' ? senderWin.getBounds() : { x: 0, y: 0 }))
        : { x: 0, y: 0 }
      const rect = p.rect || { left: 100, top: 60, width: 40, height: 20, bottom: 80 }
      const anchorX = Math.round(cb.x + (Number(rect.left) || 0) + (Number(rect.width) || 0) / 2)
      const anchorY = Math.round(cb.y + (Number(rect.top) || 0))
      const bottomY = Math.round(cb.y + (rect.bottom != null ? Number(rect.bottom) : ((Number(rect.top) || 0) + (Number(rect.height) || 20))))
      armFocusGuard(250)
      showOverlay(
        String(p.text || ''),
        { x: anchorX, y: anchorY, bottomY },
        {
          sourceWebContents: senderEntry ? senderEntry.sourceWebContents : null,
          sourceCardEntry: (senderEntry && senderEntry.kind === 'card') ? senderEntry : null
        }
      )
      return { ok: true }
    })

    ipcMain.handle('overlay:hide-bar', () => {
      hideBarOnly()
      return true
    })

    ipcMain.handle('overlay:dismiss-unpinned', () => {
      dismissUnpinned({ includeBar: true })
      return true
    })

    ipcMain.handle('overlay:insert-note', (e, text) => {
      const entry = entriesByWc.get(e.sender)
      const targetWc = entry && entry.sourceWebContents
      if (!targetWc || (typeof targetWc.isDestroyed === 'function' && targetWc.isDestroyed())) {
        return { ok: false, error: '原便签窗口已关闭' }
      }
      targetWc.send('note:ai-insert', { text: String(text || '') })
      return { ok: true }
    })
  }

  function getOverlayWindow () {
    if (lastInteractedEntry && lastInteractedEntry.win && !lastInteractedEntry.win.isDestroyed()) {
      if (lastInteractedEntry.active || lastInteractedEntry.kind === 'bar') {
        return lastInteractedEntry.win
      }
    }
    const cards = Array.from(cardEntries).filter(c => c.win && !c.win.isDestroyed())
    if (cards.length) return cards[cards.length - 1].win
    return (barEntry && barEntry.win && !barEntry.win.isDestroyed()) ? barEntry.win : null
  }

  function getAnswerWindows () {
    return Array.from(cardEntries)
      .filter(c => c.win && !c.win.isDestroyed())
      .map(c => c.win)
  }

  function getBarWindow () {
    return (barEntry && barEntry.win && !barEntry.win.isDestroyed()) ? barEntry.win : null
  }

  return {
    startSelectionProbe,
    stopSelectionProbe,
    showOverlay,
    openCard,
    showPinnedCard: (payload, sender) => openCard(payload, sender, { forcePinned: true }),
    hideOverlay,
    dispose,
    handleProbeEvent,
    getOverlayWindow,
    getAnswerWindows,
    getBarWindow,
    registerIpc
  }
}

module.exports = { createGlobalOverlay }
