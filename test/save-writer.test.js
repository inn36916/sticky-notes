'use strict'

/**
 * 落盘写入器（lib/save-writer.js）的契约回归。
 *
 * 锁三件事：
 *   1) 串行化：同一 dataFile 上最多一次写盘在飞（.tmp 文件名固定，并发会互相覆盖）；
 *   2) 不丢新内容：排队时用**最新**的 state，磁盘终态 = 最后一次的内容；
 *   3) 真实结果：调用方拿到的必须是「真的落盘成功 / 失败」（N-04）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SaveWriter } = require('../lib/save-writer')
const m = require('../lib/migrations')

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-notes-writer-'))
}
function cleanup (dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
}

function stateWith (marker) {
  const s = m.emptyState()
  s.notes = [{
    id: 'n-writer',
    title: '标题 ' + marker,
    html: '<p>' + marker + '</p>',
    preview: marker,
    color: '#FFF3B0',
    theme: {},
    bounds: { x: 10, y: 20, width: 400, height: 500 },
    collapsed: false,
    collapseEdge: null,
    edgeCollapse: true,
    visible: true,
    alwaysOnTop: false,
    mode: 'edit',
    createdAt: 1700000000000,
    updatedAt: 1700000000001
  }]
  return s
}

test('save：落盘成功返回 ok=true，磁盘内容与传入 state 一致', async () => {
  const dir = tmpDir()
  const w = new SaveWriter({ dataFile: path.join(dir, 'sticky-notes.json') })
  try {
    const r = await w.save(stateWith('M1'))
    assert.equal(r.ok, true, '落盘失败: ' + JSON.stringify(r))
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'sticky-notes.json'), 'utf8'))
    assert.equal(disk.notes[0].title, '标题 M1')
  } finally {
    await w.close()
    cleanup(dir)
  }
})

test('save：落盘失败返回 ok=false 且带 error 文案（N-04 的落盘侧依据）', async () => {
  const dir = tmpDir()
  // 目标写成目录 → rename 必然失败
  const target = path.join(dir, 'is-a-dir')
  fs.mkdirSync(target)
  const w = new SaveWriter({ dataFile: target })
  try {
    const r = await w.save(stateWith('M-FAIL'))
    assert.equal(r.ok, false, '写盘失败却返回 ok=true')
    assert.ok(r.error && String(r.error).length > 0, '失败时必须带 error 文案')
  } finally {
    await w.close()
    cleanup(dir)
  }
})

test('★ 串行化：并发 save 时磁盘终态是最后一次的内容，且无 .tmp 残留', async () => {
  const dir = tmpDir()
  const f = path.join(dir, 'sticky-notes.json')
  const w = new SaveWriter({ dataFile: f })
  try {
    const markers = ['M1', 'M2', 'M3', 'M4', 'M5']
    // 不 await 就连发：模拟「按键连打 + 250ms 兜底」造成的并发写盘
    const results = await Promise.all(markers.map(mk => w.save(stateWith(mk))))
    for (const r of results) assert.equal(r.ok, true, '并发写盘有失败: ' + JSON.stringify(r))

    const disk = JSON.parse(fs.readFileSync(f, 'utf8'))
    assert.equal(disk.notes[0].title, '标题 M5',
      '并发写盘丢了最新内容，磁盘上是: ' + disk.notes[0].title)
    assert.equal(fs.existsSync(f + '.tmp'), false, '.tmp 残留')
  } finally {
    await w.close()
    cleanup(dir)
  }
})

test('★ 串行化：并发 save 后磁盘内容始终是完整合法 JSON（不得半截）', async () => {
  const dir = tmpDir()
  const f = path.join(dir, 'sticky-notes.json')
  const w = new SaveWriter({ dataFile: f })
  try {
    const big = stateWith('BIG')
    big.notes[0].html = '<p>' + 'X'.repeat(200000) + '</p>'
    const results = await Promise.all([
      w.save(big), w.save(stateWith('SMALL')), w.save(big)
    ])
    for (const r of results) assert.equal(r.ok, true, '并发写盘有失败: ' + JSON.stringify(r))
    const raw = fs.readFileSync(f, 'utf8')
    let ok = true
    try { JSON.parse(raw) } catch (_) { ok = false }
    assert.ok(ok, '并发写盘后磁盘是半截 JSON')
  } finally {
    await w.close()
    cleanup(dir)
  }
})

test('await save() 拿到的是「包含本次 state 的那次写盘」的结果', async () => {
  const dir = tmpDir()
  const f = path.join(dir, 'sticky-notes.json')
  const w = new SaveWriter({ dataFile: f })
  try {
    // 先发一次大的（慢），再发一次小的
    const big = stateWith('BIG')
    big.notes[0].html = '<p>' + 'X'.repeat(300000) + '</p>'
    const p1 = w.save(big)
    const p2 = w.save(stateWith('LATEST'))
    await Promise.all([p1, p2])
    const disk = JSON.parse(fs.readFileSync(f, 'utf8'))
    assert.equal(disk.notes[0].title, '标题 LATEST',
      '最新内容没落盘，磁盘上是: ' + disk.notes[0].title)
  } finally {
    await w.close()
    cleanup(dir)
  }
})

test('drain()：等所有在飞 + 排队的写盘真正落地', async () => {
  const dir = tmpDir()
  const f = path.join(dir, 'sticky-notes.json')
  const w = new SaveWriter({ dataFile: f })
  try {
    const ps = [w.save(stateWith('D1')), w.save(stateWith('D2')), w.save(stateWith('D3'))]
    await w.drain()
    const disk = JSON.parse(fs.readFileSync(f, 'utf8'))
    assert.equal(disk.notes[0].title, '标题 D3')
    await Promise.all(ps)
  } finally {
    await w.close()
    cleanup(dir)
  }
})

test('按天快照：同一天只写一份', async () => {
  const dir = tmpDir()
  const f = path.join(dir, 'sticky-notes.json')
  fs.writeFileSync(f, JSON.stringify(m.emptyState()), 'utf8')
  const w = new SaveWriter({ dataFile: f })
  try {
    const a = await w.save(stateWith('S1'), { snapshot: true })
    const b = await w.save(stateWith('S2'), { snapshot: true })
    assert.ok(a.snapshotPath, '首次写盘应产生按天快照')
    assert.equal(b.snapshotPath, null, '同一天不得重复产生快照')
    const baks = fs.readdirSync(dir).filter(n => n.indexOf('.bak-') === 'sticky-notes.json'.length)
    assert.equal(baks.length, 1)
  } finally {
    await w.close()
    cleanup(dir)
  }
})

test('紧凑 JSON：落盘文件不含缩进换行', async () => {
  const dir = tmpDir()
  const f = path.join(dir, 'sticky-notes.json')
  const w = new SaveWriter({ dataFile: f })
  try {
    await w.save(stateWith('M-COMPACT'))
    const raw = fs.readFileSync(f, 'utf8')
    const body = raw.replace(/\r?\n$/, '')
    assert.ok(body.indexOf('\n') === -1, '落盘文件仍带换行: ' + JSON.stringify(raw.slice(0, 120)))
    assert.ok(body.indexOf(': ') === -1, '落盘文件仍带 ": " 缩进分隔')
  } finally {
    await w.close()
    cleanup(dir)
  }
})

test('关闭后再 save：返回明确失败而不是抛异常', async () => {
  const dir = tmpDir()
  const w = new SaveWriter({ dataFile: path.join(dir, 'sticky-notes.json') })
  try {
    await w.save(stateWith('BEFORE-CLOSE'))
    await w.close()
    const r = await w.save(stateWith('AFTER-CLOSE'))
    assert.equal(r.ok, false, '关闭后写入应返回 ok=false')
    assert.ok(r.error && String(r.error).length > 0)
  } finally {
    cleanup(dir)
  }
})
