'use strict'

/**
 * 落盘层新增契约（紧凑 JSON + 异步写 + 串行化）。
 *
 * 背景：本轮把「带缩进的同步写盘」改成「紧凑 JSON + 异步写」。
 * 这里锁三件事：
 *   1) 紧凑 JSON 仍能被 readState 读回，字段无损；
 *   2) .tmp + rename 的原子替换语义不变；
 *   3) 写盘串行化：并发的 writeState 不会丢最后一次的内容。
 *
 * 写法上刻意兼容「同步返回」和「Promise 返回」两种实现：
 * settle() 会把可能是 Promise 的结果 await 掉，测试本身不绑定具体实现。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const p = require('../lib/persistence')
const m = require('../lib/migrations')

// 测试自管临时目录必须落在 OS 临时目录下（WorkBuddy safe-delete 守卫豁免区）
function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-notes-async-'))
}
function cleanup (dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
}

/** writeState 可能同步返回对象、也可能返回 Promise —— 两种都接受 */
async function settle (r) {
  return (r && typeof r.then === 'function') ? await r : r
}

const theme = { fontFamily: 'Microsoft YaHei', fontSize: 15, lineHeight: 1.75, radius: 14 }

function richState (marker) {
  const s = m.emptyState()
  s.notes = [{
    id: 'n-async',
    title: '标题 ' + marker,
    html: '<p>' + marker + '</p><div class="mmd"><div class="mmd-body"></div></div>',
    preview: marker,
    color: '#FFF3B0',
    theme: Object.assign({}, theme),
    bounds: { x: 10, y: 20, width: 400, height: 500 },
    collapsed: false,
    collapseEdge: null,
    edgeCollapse: true,
    visible: true,
    alwaysOnTop: false,
    mode: 'edit',
    createdAt: 1700000000000,
    updatedAt: 1700000000001,
    // 未知字段必须无损透传（TC-10 白名单不得吞字段）
    futureNoteField: 'keep-' + marker
  }]
  s.settings = { globalSelect: false, futureSetting: 42 }
  s.ai = { activeId: 'p1', providers: [{ id: 'p1', name: 'x', apiKey: 'sk-1', models: ['m1'] }] }
  return s
}

// ---------------------------------------------------------------- 紧凑 JSON

test('紧凑 JSON：落盘不含缩进换行，且能被 readState 原样读回（字段无损）', async () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    const state = richState('MARK-COMPACT')
    const w = await settle(p.writeState(f, state))
    assert.equal(w.ok, true, '写盘失败: ' + JSON.stringify(w))

    const raw = fs.readFileSync(f, 'utf8')
    // 紧凑 = 内部没有缩进换行。允许文件末尾一个换行（常见实现习惯），
    // 但正文里不得出现「换行 + 缩进」的排版。
    const body = raw.replace(/\r?\n$/, '')
    assert.ok(body.indexOf('\n') === -1,
      '落盘文件仍带换行（未去缩进）: ' + JSON.stringify(raw.slice(0, 160)))
    assert.ok(body.indexOf(': ') === -1,
      '落盘文件仍带 ": " 缩进分隔: ' + JSON.stringify(raw.slice(0, 160)))
    // 体积上必须真的比缩进版小（去缩进的实际收益）
    const pretty = JSON.stringify(state, null, 2)
    assert.ok(body.length < pretty.length,
      '紧凑后体积没有变小，去缩进没生效: ' + body.length + ' vs ' + pretty.length)

    const r = p.readState(f)
    assert.equal(r.ok, true)
    assert.equal(r.reason, '')
    assert.equal(r.needsWrite, false, '紧凑 JSON 读回后不应触发迁移写回')

    // 读回结果必须与「同一份数据的缩进版」读回结果完全一致。
    // 注意：不能拿 readState 的输出跟「写进去的 state」直接 deepEqual ——
    // readState 会走 migrations.normalizeNote 补齐 theme 默认值
    // （opacity/shadow/showToolbar/toolbarPos 等，见 lib/migrations.js:21-24），
    // 这是**既有**的归一化行为，与本轮紧凑/异步化无关。
    // 真正要锁的是：磁盘上的字节 → 解析 → state，这一条链路上不丢东西。
    //
    // 比对前先抹掉时间戳：normalizeAi 会给没写 createdAt/updatedAt 的
    // provider 补 Date.now()，两次 readState 的毫秒可能不同 → 不可比。
    const stripTs = (v) => JSON.parse(JSON.stringify(v, (k, val) =>
      (k === 'createdAt' || k === 'updatedAt') ? 0 : val))

    const fPretty = path.join(dir, 'pretty.json')
    fs.writeFileSync(fPretty, JSON.stringify(state, null, 2), 'utf8')
    const rPretty = p.readState(fPretty)
    assert.deepEqual(stripTs(r.state), stripTs(rPretty.state),
      '紧凑版读回的结果与缩进版不一致（数据有丢或被改）')

    // 关键字段逐个点名（防止被白名单吞掉）
    assert.equal(r.state.notes[0].futureNoteField, 'keep-MARK-COMPACT', '未知字段被吞')
    assert.equal(r.state.notes[0].html, state.notes[0].html, '正文丢失')
    assert.equal(r.state.notes[0].preview, 'MARK-COMPACT')
    assert.deepEqual(r.state.notes[0].bounds, state.notes[0].bounds, '几何被改写')
    assert.equal(r.state.notes[0].title, '标题 MARK-COMPACT')
    assert.equal(r.state.settings.futureSetting, 42, '未知设置项被吞')
    assert.equal(r.state.ai.providers[0].apiKey, 'sk-1', 'AI 配置丢失')
    assert.equal(r.state.version, m.CURRENT_VERSION)
  } finally { cleanup(dir) }
})

test('紧凑 JSON 与缩进 JSON 语义等价（同一 state 的解析结果完全一致）', async () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    const state = richState('MARK-EQUIV')
    await settle(p.writeState(f, state))
    const compact = JSON.parse(fs.readFileSync(f, 'utf8'))
    const pretty = JSON.parse(JSON.stringify(state, null, 2))
    assert.deepEqual(compact, pretty, '紧凑写法改变了数据本身')
  } finally { cleanup(dir) }
})

// ---------------------------------------------------------------- 原子替换

test('原子替换：写完后无 .tmp 残留，正式文件是完整合法 JSON', async () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    // 模拟强杀后残留写了一半的 .tmp
    fs.writeFileSync(f + '.tmp', '{"version":2,"notes":[{"id":"half"', 'utf8')
    const w = await settle(p.writeState(f, richState('MARK-ATOMIC')))
    assert.equal(w.ok, true)
    assert.equal(fs.existsSync(f + '.tmp'), false, '写完后 .tmp 残留')
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'))
    assert.equal(parsed.notes[0].id, 'n-async')
  } finally { cleanup(dir) }
})

test('原子替换：写盘失败必须回传真实失败结果（N-04 落盘侧依据）', async () => {
  const dir = tmpDir()
  try {
    // 目标写成目录，rename 必然失败
    const f = path.join(dir, 'is-a-dir')
    fs.mkdirSync(f)
    const w = await settle(p.writeState(f, m.emptyState()))
    assert.equal(w.ok, false, '写盘失败却返回 ok=true')
    assert.ok(w.error && String(w.error).length > 0, '失败时必须带 error 文案')
  } finally { cleanup(dir) }
})

// ---------------------------------------------------------------- 串行化

test('写盘串行化：并发多次 writeState 后，磁盘上是最后一次的内容', async () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    const markers = ['M1', 'M2', 'M3', 'M4', 'M5']
    // 不 await 就连发：模拟「按键连打 + 250ms 兜底」造成的并发写盘
    const results = markers.map(mk => p.writeState(f, richState(mk)))
    const settled = await Promise.all(results.map(r => settle(r)))
    for (const w of settled) assert.equal(w.ok, true, '并发写盘有失败: ' + JSON.stringify(w))

    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'))
    assert.equal(parsed.notes[0].title, '标题 M5',
      '并发写盘丢了最新内容，磁盘上是: ' + parsed.notes[0].title)
  } finally { cleanup(dir) }
})

test('写盘串行化：并发写盘后磁盘内容始终是完整合法 JSON（不得出现半截 JSON）', async () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    const big = richState('M-BIG')
    big.notes[0].html = '<p>' + 'X'.repeat(200000) + '</p>'
    const ps = [p.writeState(f, big), p.writeState(f, richState('M-SMALL')), p.writeState(f, big)]
    await Promise.all(ps.map(r => settle(r)))
    const raw = fs.readFileSync(f, 'utf8')
    let ok = true
    try { JSON.parse(raw) } catch (_) { ok = false }
    assert.ok(ok, '并发写盘后磁盘是半截 JSON')
  } finally { cleanup(dir) }
})

// ---------------------------------------------------------------- 既有契约（紧凑/异步化后仍成立）

test('既有契约：JSON 损坏仍先备份、正式文件字节不变', async () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    const broken = '{"version":1,"notes":[{"id":"a"'
    fs.writeFileSync(f, broken, 'utf8')
    const r = p.readState(f)
    assert.equal(r.reason, 'corrupt')
    assert.ok(r.backupPath && fs.existsSync(r.backupPath))
    assert.equal(fs.readFileSync(r.backupPath, 'utf8'), broken)
    assert.equal(fs.readFileSync(f, 'utf8'), broken, '备份前后都不得改写正式文件')
    assert.equal(r.state.notes.length, 0)
  } finally { cleanup(dir) }
})

test('既有契约：高版本原文件字节不变、不备份、不产生 .tmp', async () => {
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

test('既有契约：按天快照同一天只写一份', async () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'sticky-notes.json')
    fs.writeFileSync(f, JSON.stringify(m.emptyState()), 'utf8')
    const a = await settle(p.writeState(f, richState('S1'), { snapshot: true }))
    const b = await settle(p.writeState(f, richState('S2'), { snapshot: true }))
    assert.ok(a.snapshotPath, '首次写盘应产生按天快照')
    assert.equal(b.snapshotPath, null, '同一天不得重复产生快照')
    const baks = fs.readdirSync(dir).filter(n => n.indexOf('.bak-') === 'sticky-notes.json'.length)
    assert.equal(baks.length, 1)
  } finally { cleanup(dir) }
})
