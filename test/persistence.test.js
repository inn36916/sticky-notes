'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const p = require('../lib/persistence')
const m = require('../lib/migrations')
const g = require('../lib/geometry')

// 测试自管临时目录必须落在 OS 临时目录下（WorkBuddy safe-delete 守卫豁免区）
function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-notes-test-'))
}
function cleanup (dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
}
const expanded = (over = {}) => Object.assign({ x: 100, y: 100, width: 400, height: 500 }, over)

// writeState 既可能同步返回结果对象，也可能返回 Promise。
// 断言只关心「真实落盘结果」，不绑定实现是同步还是异步 —— 用 settle() 统一 await。
async function settle (r) {
  return (r && typeof r.then === 'function') ? await r : r
}

test('fresh：文件不存在时返回默认 state 且不写盘', () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    const r = p.readState(f)
    assert.equal(r.reason, 'fresh')
    assert.equal(r.state.version, m.CURRENT_VERSION)
    assert.equal(r.needsWrite, false)
    assert.equal(fs.existsSync(f), false)
  } finally { cleanup(dir) }
})

test('TC-13 JSON 损坏：先备份、正式文件字节不变、返回可用空库', () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    const broken = '{"version":1,"notes":[{"id":"a"'
    fs.writeFileSync(f, broken, 'utf8')
    const r = p.readState(f)
    assert.equal(r.reason, 'corrupt')
    assert.ok(r.backupPath && fs.existsSync(r.backupPath))
    assert.equal(fs.readFileSync(r.backupPath, 'utf8'), broken)
    assert.equal(fs.readFileSync(f, 'utf8'), broken, '备份前/后都不得改写正式文件')
    assert.equal(r.state.notes.length, 0)
  } finally { cleanup(dir) }
})

test('TC-10 高版本：ok=false、原文件字节不变、不产生任何备份或 .tmp', () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    const raw = JSON.stringify({ version: 99, notes: [], futureTopLevel: 'keep' }, null, 2)
    fs.writeFileSync(f, raw, 'utf8')
    const before = fs.readdirSync(dir).sort()
    const r = p.readState(f)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'future-version')
    assert.equal(r.state, null)
    assert.equal(fs.readFileSync(f, 'utf8'), raw)
    assert.deepEqual(fs.readdirSync(dir).sort(), before, '不得备份/不得写 .tmp')
  } finally { cleanup(dir) }
})

test('TC-04 原子写：正式文件始终是完整合法 JSON，.tmp 不被当成正式数据', async () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    // 模拟强杀后残留写了一半的 .tmp
    fs.writeFileSync(f + '.tmp', '{"version":1,"notes":[{"id":"half"', 'utf8')
    const state = Object.assign(m.emptyState(), { notes: [{ id: 'ok', bounds: expanded() }] })
    const w = await settle(p.writeState(f, state))
    assert.equal(w.ok, true)
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'))
    assert.equal(parsed.notes[0].id, 'ok')
    assert.equal(fs.existsSync(f + '.tmp'), false)
    assert.equal(p.readState(f).reason, '')
  } finally { cleanup(dir) }
})

test('writeState 失败回传真实结果（N-04 的落盘侧依据）', async () => {
  const dir = tmpDir()
  try {
    // 目标写成目录，renameSync 必然失败
    const f = path.join(dir, 'is-a-dir')
    fs.mkdirSync(f)
    const w = await settle(p.writeState(f, m.emptyState()))
    assert.equal(w.ok, false)
    assert.ok(w.error && w.error.length > 0)
  } finally { cleanup(dir) }
})

test('按天快照：同一天只写一份，不随 350ms 写盘爆炸', async () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    fs.writeFileSync(f, JSON.stringify(m.emptyState()), 'utf8')
    const a = await settle(p.writeState(f, Object.assign(m.emptyState(), { marker: 1 }), { snapshot: true }))
    const b = await settle(p.writeState(f, Object.assign(m.emptyState(), { marker: 2 }), { snapshot: true }))
    assert.ok(a.snapshotPath)
    assert.equal(b.snapshotPath, null)
    const baks = fs.readdirSync(dir).filter(n => n.indexOf('.bak-') === 'sticky-notes.json'.length)
    assert.equal(baks.length, 1)
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).marker, 2)
  } finally { cleanup(dir) }
})

test('升级前快照：v1 脏 bounds 迁移写回后，正式文件无 ≤60 宽高', async () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    const raw = {
      version: 1,
      notes: [{ id: 'dirty', collapsed: true, collapseEdge: 'bottom', bounds: { x: 10, y: 20, width: 274, height: 50 } }]
    }
    fs.writeFileSync(f, JSON.stringify(raw, null, 2), 'utf8')
    const r = p.readState(f)
    assert.equal(r.needsWrite, true)
    assert.ok(r.backupPath && fs.existsSync(r.backupPath), '升级前必须有快照')
    assert.deepEqual(r.recoveredIds, ['dirty'])

    // 模拟「收纳态 → 托盘退出 → 落盘」的整条串行链路
    const note = r.state.notes[0]
    const win = { getBounds: () => ({ x: 10, y: 20, width: 274, height: 50 }) }
    const cap = g.collectBoundsForQuit([{ note, win }])
    assert.equal(cap.captured.length, 0, '修复后收纳态退出仍不得写回窄条')
    const w = await settle(p.writeState(f, r.state))
    assert.equal(w.ok, true)

    const disk = JSON.parse(fs.readFileSync(f, 'utf8'))
    const b = disk.notes[0].bounds
    assert.ok(b.width > g.COLLAPSE_MAX && b.height > g.COLLAPSE_MAX,
      `落盘出现窄条几何 ${JSON.stringify(b)}`)
    assert.equal(disk.notes[0].collapsed, true)
    assert.equal(disk.notes[0].collapseEdge, 'bottom')
    assert.equal(p.readState(f).needsWrite, false, '重复启动幂等')
  } finally { cleanup(dir) }
})
