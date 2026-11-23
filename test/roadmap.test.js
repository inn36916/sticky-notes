'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { storeImage, backupImages } = require('../lib/image-store')
const { createReminders } = require('../main/reminders')
const { normalizeNote } = require('../lib/migrations')

test('图片外置：去重、原字节、配对快照、无效输入不改原文', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-images-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'sticky-notes.json'), '{"notes":[]}')
  const data = 'data:image/png;base64,' + Buffer.from('fixture-bytes').toString('base64')
  const url = storeImage(dir, data)
  assert.equal(storeImage(dir, data), url)
  assert.equal(fs.readdirSync(path.join(dir, 'attachments')).length, 1)
  assert.equal(fs.readFileSync(path.join(dir, 'attachments', url.split('/').pop()), 'utf8'), 'fixture-bytes')
  const backup = backupImages(dir)
  assert.equal(fs.readFileSync(path.join(backup, 'sticky-notes.json'), 'utf8'), '{"notes":[]}')
  assert.equal(fs.readdirSync(path.join(backup, 'attachments')).length, 1)
  assert.throws(() => storeImage(dir, 'file:///private'))
})

test('提醒：改期、取消、删除、休眠跨期和重启不重发', async () => {
  let clock = 1000
  let callback
  let scheduled
  const notes = [normalizeNote({ id: 'one' }), normalizeNote({ id: 'two' })]
  const notified = []
  const deps = { getNotes: () => notes, now: () => clock, save: async () => ({ ok: true }), notify: n => notified.push(n.id), setTimer: (fn, ms) => { callback = fn; scheduled = ms; return 1 }, clearTimer: () => {} }
  const reminders = createReminders(deps)
  assert.equal(reminders.set(notes[0], 900).ok, false)
  reminders.set(notes[0], 2000); reminders.set(notes[1], 3000)
  await reminders.scan(); assert.equal(scheduled, 1000)
  reminders.set(notes[0], 4000)
  await reminders.scan(); assert.equal(scheduled, 2000)
  reminders.set(notes[1], null)
  await reminders.scan(); assert.equal(scheduled, 3000)
  clock = 5000; await callback()
  assert.deepEqual(notified, ['one'])
  await createReminders(deps).scan()
  assert.deepEqual(notified, ['one'])
  reminders.set(notes[1], 6000); notes.pop(); clock = 7000
  await reminders.scan(); assert.deepEqual(notified, ['one'])
})

test('提醒：退出期间到期在启动补发；保存失败不通知；归档不触发', async () => {
  const note = normalizeNote({ id: 'late', reminder: { at: 100, status: 'pending' } })
  let saved = false
  let count = 0
  const reminders = createReminders({ getNotes: () => [note], now: () => 200, save: async () => ({ ok: saved }), notify: () => count++, setTimer: () => 1, clearTimer: () => {} })
  await reminders.scan(); assert.equal(count, 0); assert.equal(note.reminder.status, 'pending')
  saved = true; await reminders.scan(); assert.equal(count, 1)
  note.archivedAt = 1; note.reminder.status = 'pending'
  await reminders.scan(); assert.equal(count, 1)
  assert.equal(reminders.set(note, 300).ok, false)
})


test('提醒在保存期间取消，不发送已经失效的通知', async () => {
  const note = normalizeNote({ reminder: { at: 100, status: 'pending' } })
  let finish
  let count = 0
  const service = createReminders({ getNotes: () => [note], now: () => 200, save: () => new Promise(resolve => { finish = resolve }), notify: () => count++, setTimer: () => 1, clearTimer: () => {} })
  const pending = service.scan()
  service.set(note, null)
  finish({ ok: true })
  await pending
  assert.equal(count, 0)
})

test('边缘卡组按屏幕归组，兼容不同缩放、归档与最近使用', () => {
  const { groupNotes } = require('../main/edge-groups')
  const displays = [{ id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }, { id: 2, scaleFactor: 1.5, workArea: { x: 1920, y: 0, width: 1280, height: 720 } }]
  const notes = [{ id: 'a', visible: true, collapsed: true, bounds: { x: 2100, y: 100, width: 400, height: 400 }, lastUsedAt: 1 }, { id: 'b', visible: true, collapsed: true, bounds: { x: 2400, y: 200, width: 400, height: 400 }, lastUsedAt: 2 }, { id: 'c', visible: true, collapsed: true, bounds: { x: 20, y: 100, width: 400, height: 400 } }, { id: 'archived', archivedAt: 1, visible: true, collapsed: true }]
  assert.deepEqual(groupNotes(notes, displays).get('2').map(n => n.id), ['b', 'a'])
  assert.deepEqual(groupNotes(notes, displays).get('1').map(n => n.id), ['c'])
  assert.deepEqual(groupNotes(notes, displays.slice(0, 1)).get('1').map(n => n.id), ['b', 'a', 'c'])
})

test('导入资源限定所选目录，导出失败保留已有文件', async t => {
  const { insideFile, exportFile } = require('../lib/note-exchange')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-exchange-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'selected')); fs.writeFileSync(path.join(dir, 'outside.txt'), 'private')
  assert.throws(() => insideFile(path.join(dir, 'selected'), '../outside.txt'))
  assert.throws(() => insideFile(path.join(dir, 'selected'), 'https://example.com/remote.png'))
  const target = path.join(dir, 'old.md'); fs.writeFileSync(target, 'original')
  const result = await exportFile({}, target, dir, async () => ({ markdown: 'new', resources: [{ source: 'missing', token: 'x' }] }))
  assert.equal(result.ok, false)
  assert.equal(fs.readFileSync(target, 'utf8'), 'original')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['old.md', 'outside.txt', 'selected'])
})


test('归档写入失败保留活跃状态，成功后恢复不自动显示', async () => {
  const { createWindowManager } = require('../main/windows')
  const note = normalizeNote({ id: 'archive', html: '<img src="sticky-att://local/sample.png">', bounds: { x: 20, y: 30, width: 400, height: 500 }, reminder: { at: 2000, status: 'pending' } })
  let ok = false
  let hidden = false
  const win = { isDestroyed: () => false, webContents: { executeJavaScript: async () => true }, getBounds: () => note.bounds, hide: () => { hidden = true } }
  const state = { notes: [note] }
  const manager = createWindowManager({ getState: () => state, findNote: () => note, noteWindows: new Map([[note.id, win]]), scheduleSave: () => {}, broadcast: () => {}, flushSave: async () => ({ ok }), edgeCollapse: {} })
  assert.equal((await manager.archiveNote(note.id)).ok, false)
  assert.equal(note.archivedAt, null); assert.equal(note.visible, true); assert.equal(hidden, false)
  assert.equal(note.reminder.status, 'pending')
  ok = true
  await manager.archiveNote(note.id)
  assert.equal(hidden, true); assert.equal(note.reminder, null); assert.equal(note.visible, false)
  manager.restoreNote(note.id)
  assert.equal(note.archivedAt, null); assert.equal(note.visible, false)
  assert.equal(note.html, '<img src="sticky-att://local/sample.png">')
  assert.deepEqual(note.bounds, { x: 20, y: 30, width: 400, height: 500 })
})

test('拔掉副屏后移动到可用工作区，保持展开尺寸', () => {
  const { createEdgeGroups } = require('../main/edge-groups')
  let displays = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }, { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 720 } }]
  const events = {}
  const note = { id: 'offscreen', bounds: { x: 2100, y: 30, width: 420, height: 520 }, collapsed: true, visible: true }
  const state = { settings: {}, notes: [note] }
  const manager = createEdgeGroups({ BrowserWindow: class {}, screen: { getAllDisplays: () => displays, on: (name, cb) => { events[name] = cb } }, ipcMain: { handle: () => {} }, getState: () => state, noteWindows: new Map(), edgeCollapse: { clampBounds: b => ({ ...b, x: 0 }) }, scheduleSave: () => {}, broadcast: () => {} })
  try { manager.start(); displays = displays.slice(0, 1); events['display-removed'](); assert.deepEqual(note.bounds, { x: 0, y: 30, width: 420, height: 520 }) }
  finally { manager.stop() }
})
