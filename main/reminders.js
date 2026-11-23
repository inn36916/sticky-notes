'use strict'

function createReminders ({ getNotes, save, notify, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer
  let running = false
  async function scan () {
    clearTimer(timer)
    if (running) return
    running = true
    try {
      const due = getNotes().filter(n => !n.archivedAt && n.reminder && n.reminder.status === 'pending' && n.reminder.at <= now()).map(note => ({ note, reminder: note.reminder }))
      for (const entry of due) entry.reminder.status = 'delivered'
      if (due.length) {
        const result = await save()
        if (!result.ok) {
          for (const entry of due) if (entry.note.reminder === entry.reminder) entry.reminder.status = 'pending'
          timer = setTimer(scan, 30000)
          return
        }
        for (const entry of due) {
          if (getNotes().includes(entry.note) && !entry.note.archivedAt && entry.note.reminder === entry.reminder && entry.reminder.status === 'delivered') notify(entry.note)
        }
      }
    } finally { running = false }
    const next = getNotes().filter(n => !n.archivedAt && n.reminder && n.reminder.status === 'pending').sort((a, b) => a.reminder.at - b.reminder.at)[0]
    if (next) timer = setTimer(scan, Math.min(2147483647, Math.max(0, next.reminder.at - now())))
  }
  function set (note, at) {
    if (at !== null && (!Number.isFinite(at) || at <= now())) return { ok: false, error: '请选择未来时间' }
    if (note.archivedAt) return { ok: false, error: '请先恢复归档便签' }
    note.reminder = at === null ? null : { at, status: 'pending' }
    return { ok: true }
  }
  return { scan, set, stop: () => clearTimer(timer) }
}
module.exports = { createReminders }
