'use strict'
const path = require('path')

function groupNotes (notes, displays) {
  const groups = new Map(displays.map(d => [String(d.id), []]))
  for (const note of notes) {
    if (!note.visible || note.archivedAt || !note.collapsed) continue
    const b = note.bounds || displays[0].workArea
    let display = displays[0]
    let largest = 0
    for (const candidate of displays) {
      const a = candidate.workArea
      const overlap = Math.max(0, Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)) * Math.max(0, Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y))
      if (overlap > largest) { largest = overlap; display = candidate }
    }
    groups.get(String(display.id)).push(note)
  }
  for (const list of groups.values()) list.sort((a, b) => (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0))
  return groups
}
function createEdgeGroups ({ BrowserWindow, screen, ipcMain, getState, noteWindows, edgeCollapse, scheduleSave, broadcast }) {
  const groups = new Map()
  const hidden = new Set()
  let timer
  function layout (entry) {
    if (entry.win.isDestroyed()) return
    const area = entry.display.workArea
    const width = entry.expanded ? Math.min(300, area.width) : 90
    const height = entry.expanded ? Math.min(400, area.height) : 52
    entry.win.setBounds({ x: area.x + area.width - width, y: area.y + Math.round((area.height - height) / 2), width, height })
    entry.win.webContents.send('edge-group:state', { expanded: entry.expanded, notes: entry.notes.map(n => ({ id: n.id, title: n.title || n.preview || '未命名便签', color: n.color, due: !!n.reminder && n.reminder.at <= Date.now() })) })
  }
  function refresh () {
    const displays = screen.getAllDisplays()
    const enabled = getState().settings.edgeGroups === true
    const lists = enabled ? groupNotes(getState().notes, displays) : new Map()
    const wanted = new Set()
    for (const [id, notes] of lists) {
      if (!notes.length) continue
      wanted.add(id)
      let entry = groups.get(id)
      if (!entry) {
        const win = new BrowserWindow({ show: false, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: { preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } })
        entry = { win, display: displays.find(d => String(d.id) === id), expanded: false, notes, signature: '' }
        groups.set(id, entry)
        win.loadFile(path.join(__dirname, '../src/edge-group.html'))
        win.webContents.on('did-finish-load', () => layout(entry))
        win.on('closed', () => groups.delete(id))
        win.on('blur', () => { entry.expanded = false; layout(entry) })
        win.showInactive()
      }
      entry.display = displays.find(d => String(d.id) === id)
      entry.notes = notes
      const signature = JSON.stringify([entry.display.workArea, notes.map(n => [n.id, n.title, n.preview, n.color, n.reminder, !!n.reminder && n.reminder.at <= Date.now()])])
      if (entry.signature !== signature) { entry.signature = signature; layout(entry) }
      for (const note of notes) {
        const win = noteWindows.get(note.id)
        if (win && !win.isDestroyed()) { hidden.add(note.id); win.hide() }
      }
    }
    for (const [id, entry] of groups) if (!wanted.has(id)) { entry.win.destroy(); groups.delete(id) }
    for (const id of hidden) {
      const note = getState().notes.find(n => n.id === id)
      if (enabled && note && note.visible && note.collapsed && !note.archivedAt) continue
      hidden.delete(id)
      const win = noteWindows.get(id)
      if (note && note.visible && !note.archivedAt && win && !win.isDestroyed()) win.showInactive()
    }
  }
  function open () {
    refresh()
    const entry = groups.values().next().value
    if (!entry) return
    entry.expanded = true; layout(entry); entry.win.show(); entry.win.focus()
  }
  function repairDisplays () {
    const displays = screen.getAllDisplays()
    for (const note of getState().notes) {
      const b = note.bounds
      if (!b) continue
      const present = displays.some(d => { const a = d.workArea; return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y })
      if (present) continue
      note.bounds = edgeCollapse.clampBounds(b)
      const win = noteWindows.get(note.id)
      if (win && !win.isDestroyed()) edgeCollapse.applyGeometry(win, note)
    }
    scheduleSave(); broadcast(); refresh()
  }
  ipcMain.handle('edge-group:toggle', (e, expanded) => {
    const entry = [...groups.values()].find(g => g.win.webContents === e.sender)
    if (!entry) return false
    entry.expanded = expanded === true
    layout(entry)
    return true
  })
  ipcMain.handle('settings:edge-groups', (_e, enabled) => {
    if (typeof enabled === 'boolean') { getState().settings.edgeGroups = enabled; scheduleSave(); refresh() }
    return getState().settings.edgeGroups === true
  })
  return { open, start: () => { repairDisplays(); timer = setInterval(refresh, 250); screen.on('display-removed', repairDisplays); screen.on('display-metrics-changed', repairDisplays) }, stop: () => { clearInterval(timer); for (const entry of groups.values()) if (!entry.win.isDestroyed()) entry.win.destroy(); groups.clear() } }
}
module.exports = { groupNotes, createEdgeGroups }
