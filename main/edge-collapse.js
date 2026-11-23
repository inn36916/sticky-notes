'use strict'

/**
 * 便签贴边收纳状态机与窗口几何计算。
 *
 * 几何真值约定：note.bounds 永远保存展开态几何，运行时窗口按 collapsed 动态投影。
 */

const { MIN_W, MIN_H, DEFAULT_W, DEFAULT_H, safeExpandedBounds } = require('../lib/geometry')
const { clamp } = require('../lib/utils')

const EDGE_SNAP = 18
const COLLAPSE_W = 50
const COLLAPSE_H = 50
const COLLAPSE_MIN = 8
const COLLAPSE_DELAY = 1200

/**
 * 创建贴边收纳管理器。
 * @param {object} deps
 */
function createEdgeCollapse ({ app, screen, getState, findNote, noteWindows, scheduleSave }) {
  let collapsePollTimer = null

  function nextBounds (width = DEFAULT_W, height = DEFAULT_H) {
    const area = screen.getPrimaryDisplay().workArea
    const step = 34
    const n = getState().notes.length
    const baseX = area.x + area.width - width - 40
    const baseY = area.y + 40
    const cols = 4
    const x = baseX - (n % cols) * step
    const y = baseY + (n % cols) * step + Math.floor(n / cols) * 12
    return {
      x: Math.round(clamp(x, area.x, area.x + area.width - width)),
      y: Math.round(clamp(y, area.y, area.y + area.height - height)),
      width,
      height
    }
  }

  function clampBounds (b) {
    const width = Math.max(MIN_W, Math.round(b.width || DEFAULT_W))
    const height = Math.max(MIN_H, Math.round(b.height || DEFAULT_H))
    let x = Math.round(b.x || 0)
    let y = Math.round(b.y || 0)
    const displays = screen.getAllDisplays()
    const visible = displays.some(d => {
      const a = d.workArea
      return x + width > a.x + 60 && x < a.x + a.width - 60 &&
             y + 40 > a.y && y < a.y + a.height - 40
    })
    if (!visible) {
      const a = screen.getPrimaryDisplay().workArea
      x = a.x + a.width - width - 40
      y = a.y + 40
    }
    return { x, y, width, height }
  }

  function areaForBounds (b) {
    try {
      const d = screen.getDisplayMatching({
        x: b.x, y: b.y, width: Math.max(1, b.width), height: Math.max(1, b.height)
      })
      if (d && d.workArea) return d.workArea
    } catch (_) {}
    return screen.getPrimaryDisplay().workArea
  }

  function nearestEdge (b, area, minSpan = 80, maxDist = EDGE_SNAP) {
    const cands = []
    const add = (edge, dist, s, e) => {
      const span = e - s
      if (span < minSpan) return
      cands.push({ edge, dist: Math.max(0, dist), span })
    }
    add('left', b.x - area.x, b.y, b.y + b.height)
    add('right', (area.x + area.width) - (b.x + b.width), b.y, b.y + b.height)
    add('top', b.y - area.y, b.x, b.x + b.width)
    add('bottom', (area.y + area.height) - (b.y + b.height), b.x, b.x + b.width)
    if (!cands.length) return null
    cands.sort((p, q) => (p.dist - q.dist) || (q.span - p.span))
    return cands[0].dist <= maxDist ? cands[0].edge : null
  }

  function snapFlush (b, edge, area) {
    const out = {
      x: Math.round(b.x), y: Math.round(b.y),
      width: Math.round(b.width), height: Math.round(b.height)
    }
    if (edge === 'left') out.x = area.x
    else if (edge === 'right') out.x = area.x + area.width - out.width
    else if (edge === 'top') out.y = area.y
    else if (edge === 'bottom') out.y = area.y + area.height - out.height
    return out
  }

  function collapsedBounds (edge, restore, area) {
    if (edge === 'left' || edge === 'right') {
      const width = COLLAPSE_W
      const height = Math.max(140, Math.min(restore.height, area.height - 8))
      const y = Math.round(clamp(restore.y, area.y, Math.max(area.y, area.y + area.height - height)))
      const x = edge === 'left' ? area.x : area.x + area.width - width
      return { x, y, width, height }
    }
    const height = COLLAPSE_H
    const width = Math.max(140, Math.min(restore.width, area.width - 8))
    const x = Math.round(clamp(restore.x, area.x, Math.max(area.x, area.x + area.width - width)))
    const y = edge === 'top' ? area.y : area.y + area.height - height
    return { x, y, width, height }
  }

  function desiredBounds (note) {
    if (note.collapsed && note.collapseEdge && note.bounds) {
      return collapsedBounds(note.collapseEdge, note.bounds, areaForBounds(note.bounds))
    }
    return clampBounds(note.bounds || nextBounds())
  }

  function programmaticGuard (win) {
    if (!win.__geoGuard) win.__geoGuard = { until: 0 }
    return win.__geoGuard
  }

  function applyGeometry (win, note) {
    if (!win || win.isDestroyed()) return
    const collapsed = !!note.collapsed
    win.setMinimumSize(collapsed ? COLLAPSE_MIN : MIN_W, collapsed ? COLLAPSE_MIN : MIN_H)
    const b = desiredBounds(note)
    programmaticGuard(win).until = Date.now() + 400
    win.setBounds(b)
  }

  function notifyCollapse (note) {
    const win = noteWindows.get(note.id)
    if (win && !win.isDestroyed()) {
      win.webContents.send('note:collapse-state', {
        collapsed: !!note.collapsed,
        edge: note.collapseEdge || null
      })
    }
  }

  function collapseNote (note, win, edge) {
    if (!note || !win || win.isDestroyed()) return false
    const cur = win.getBounds()
    const area = areaForBounds(cur)
    const e = edge || nearestEdge(cur, area, 80, Infinity)
    if (!e) return false
    const snapped = snapFlush(cur, e, area)
    const prev = safeExpandedBounds(note.bounds, snapped)
    note.bounds = { x: snapped.x, y: snapped.y, width: prev.width, height: prev.height }
    note.collapsed = true
    note.collapseEdge = e
    win.__rearm = false
    win.__dragOrigin = null
    applyGeometry(win, note)
    scheduleSave()
    notifyCollapse(note)
    return true
  }

  function expandNote (note, win) {
    if (!note || !win || win.isDestroyed()) return false
    if (!note.collapsed) return false
    note.collapsed = false
    note.collapseEdge = null
    win.__rearm = true
    if (win.__collapseState && win.__collapseState.timer) {
      clearTimeout(win.__collapseState.timer)
      win.__collapseState.timer = null
    }
    applyGeometry(win, note)
    scheduleSave()
    notifyCollapse(note)
    return true
  }

  function expandNoteAt (note, win, x, y) {
    if (!note || !win || win.isDestroyed()) return false
    const size = safeExpandedBounds(note.bounds, { x, y, width: DEFAULT_W, height: DEFAULT_H })
    note.bounds = clampBounds({ x, y, width: size.width, height: size.height })
    note.collapsed = false
    note.collapseEdge = null
    win.__rearm = true
    applyGeometry(win, note)
    scheduleSave()
    notifyCollapse(note)
    return true
  }

  function scheduleCollapseCheck (note, win) {
    clearTimeout(win.__collapseCheck)
    win.__collapseCheck = setTimeout(() => runCollapseCheck(note, win), 220)
  }

  function runCollapseCheck (note, win) {
    if (!note || win.isDestroyed()) return
    const nb = win.getBounds()
    const area = areaForBounds(nb)
    const dragBase = win.__collapseTarget
    win.__dragOrigin = null
    win.__collapseTarget = null

    if (note.collapsed) {
      const target = dragBase || note.bounds
      const e = nearestEdge(nb, area, 36)
      if (e) {
        note.bounds = safeExpandedBounds(snapFlush(target, e, area), note.bounds)
        note.collapseEdge = e
      } else {
        note.bounds = clampBounds(safeExpandedBounds(target, note.bounds))
        note.collapsed = false
        note.collapseEdge = null
      }
      applyGeometry(win, note)
      scheduleSave()
      notifyCollapse(note)
      return
    }

    if (note.edgeCollapse === false) return
    const e = nearestEdge(nb, area)
    if (e) collapseNote(note, win, e)
  }

  function cursorInside (pt, rect, pad) {
    return pt.x >= rect.x - pad && pt.x <= rect.x + rect.width + pad &&
           pt.y >= rect.y - pad && pt.y <= rect.y + rect.height + pad
  }

  function collapsePollTick () {
    if (!app.isReady()) return
    let pt = null
    try { pt = screen.getCursorScreenPoint() } catch (_) { return }
    if (!pt) return

    for (const [id, win] of noteWindows) {
      if (win.isDestroyed() || !win.isVisible()) continue
      const note = findNote(id)
      if (!note) continue

      const b = win.getBounds()

      if (note.collapsed) {
        if (win.__dragOrigin) {
          if (Date.now() - (win.__dragOriginAt || 0) < 1500) continue
          win.__dragOrigin = null
        }
        const area2 = areaForBounds(b)
        const curEdge = nearestEdge(b, area2, 36)
        if (!curEdge) { expandNoteAt(note, win, b.x, b.y); continue }

        let base = Object.assign({}, note.bounds)
        if (curEdge === 'left' || curEdge === 'right') base.y = b.y
        else base.x = b.x
        base = snapFlush(base, curEdge, area2)
        const want = collapsedBounds(curEdge, base, area2)
        if (curEdge !== note.collapseEdge ||
            Math.abs(b.x - want.x) > 4 || Math.abs(b.y - want.y) > 4) {
          note.collapseEdge = curEdge
          note.bounds = safeExpandedBounds(base, note.bounds)
          applyGeometry(win, note)
          scheduleSave()
          notifyCollapse(note)
          continue
        }

        const inside = cursorInside(pt, b, 6)
        if (!inside) { win.__rearm = true; continue }
        if (!win.__rearm) continue
        const g = programmaticGuard(win)
        if (Date.now() < g.until) continue
        expandNote(note, win)
        continue
      }

      if (note.edgeCollapse === false) continue

      const area = areaForBounds(b)
      if (!nearestEdge(b, area)) continue
      if (cursorInside(pt, b, 24)) continue
      if (win.isFocused() && !win.__userDragged) continue

      const st = win.__collapseState || (win.__collapseState = { timer: null })
      if (st.timer) continue
      st.timer = setTimeout(() => {
        st.timer = null
        if (win.isDestroyed() || !win.isVisible()) return
        const note2 = findNote(id)
        if (!note2 || note2.collapsed) return
        if (note2.edgeCollapse === false) return
        if (win.isFocused() && !win.__userDragged) return
        const nb = win.getBounds()
        let p2 = null
        try { p2 = screen.getCursorScreenPoint() } catch (_) { return }
        if (p2 && cursorInside(p2, nb, 24)) return
        if (!nearestEdge(nb, areaForBounds(nb))) return
        collapseNote(note2, win, null)
      }, COLLAPSE_DELAY)
    }
  }

  function startCollapsePoll () {
    if (collapsePollTimer) return
    collapsePollTimer = setInterval(collapsePollTick, 120)
  }

  function stopCollapsePoll () {
    if (collapsePollTimer) {
      clearInterval(collapsePollTimer)
      collapsePollTimer = null
    }
  }

  return {
    COLLAPSE_MIN,
    nextBounds,
    clampBounds,
    areaForBounds,
    nearestEdge,
    snapFlush,
    collapsedBounds,
    desiredBounds,
    programmaticGuard,
    applyGeometry,
    notifyCollapse,
    collapseNote,
    expandNote,
    expandNoteAt,
    scheduleCollapseCheck,
    runCollapseCheck,
    startCollapsePoll,
    stopCollapsePoll
  }
}

module.exports = { createEdgeCollapse }
