'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const g = require('../lib/geometry')

const fakeWin = (b) => ({ getBounds: () => b })
const expanded = (over = {}) => Object.assign({ x: 100, y: 100, width: 400, height: 500 }, over)

// ---------------------------------------------------------------- 断言器
test('assertExpandedBounds 接受合法展开态几何', () => {
  const r = g.assertExpandedBounds(expanded())
  assert.equal(r.ok, true)
  assert.deepEqual(r.bounds, expanded())
})

test('assertExpandedBounds 拒绝四边收纳窄条（50 DIP）', () => {
  const bars = [
    expanded({ width: 50, height: 500 }),   // 贴左/右
    expanded({ width: 400, height: 50 }),   // 贴顶/底
    expanded({ width: 8, height: 8 }),      // COLLAPSE_MIN
    expanded({ width: 60, height: 500 })    // 边界值
  ]
  for (const b of bars) {
    const r = g.assertExpandedBounds(b)
    assert.equal(r.ok, false, JSON.stringify(b))
    assert.equal(r.reason, 'too-small')
    assert.equal(r.bounds, null, '不得把窄条钳成 260 的面条尺寸')
    assert.equal(g.isCollapsedGeometry(b), true)
  }
})

test('assertExpandedBounds 拒绝非法数值与空对象', () => {
  for (const b of [null, {}, { x: 1, y: 2, width: NaN, height: 500 }, { x: 1, y: 2, width: 400, height: 'x' }]) {
    const r = g.assertExpandedBounds(b)
    assert.equal(r.ok, false)
    assert.equal(r.bounds, null)
  }
})

test('assertExpandedBounds 带 areas 时校验窗口落在工作区', () => {
  const areas = [{ x: 0, y: 0, width: 1920, height: 1080 }]
  assert.equal(g.assertExpandedBounds(expanded(), { areas }).ok, true)
  assert.equal(g.assertExpandedBounds(expanded({ x: 9000 }), { areas }).reason, 'off-screen')
})

// ---------------------------------------------------------------- L-1 回归基线
test('TC-01 收纳态托盘退出：50 DIP 窄条绝不写回 note.bounds', () => {
  const note = {
    id: 'n-collapsed',
    collapsed: true,
    collapseEdge: 'bottom',
    bounds: expanded({ width: 274, height: 473 })
  }
  const before = Object.assign({}, note.bounds)
  const win = fakeWin(expanded({ x: 100, y: 900, width: 274, height: 50 }))

  const r = g.collectBoundsForQuit([{ note, win }])
  assert.deepEqual(note.bounds, before, '展开态几何必须逐字段不变')
  assert.equal(r.captured.length, 0)
  assert.equal(r.skipped[0].reason, 'collapsed')
  assert.equal(note.collapsed, true)
  assert.equal(note.collapseEdge, 'bottom')
})

test('TC-02 展开态托盘退出：写回窗口当前几何', () => {
  const note = { id: 'n-expanded', collapsed: false, bounds: expanded() }
  const cur = expanded({ x: 320, y: 240, width: 520, height: 610 })
  const r = g.collectBoundsForQuit([{ note, win: fakeWin(cur) }])
  assert.equal(r.captured.length, 1)
  assert.deepEqual(note.bounds, cur)
})

test('TC-01 负向断言：混合窗口退出后，任何落盘 bounds 都不含 ≤60 宽高', () => {
  const entries = [
    { note: { id: 'a', collapsed: true, collapseEdge: 'left', bounds: expanded() }, win: fakeWin(expanded({ width: 50, height: 500 })) },
    { note: { id: 'b', collapsed: true, collapseEdge: 'top', bounds: expanded() }, win: fakeWin(expanded({ width: 400, height: 50 })) },
    { note: { id: 'c', collapsed: false, bounds: expanded() }, win: fakeWin(expanded({ x: 10, y: 20, width: 300, height: 260 })) },
    { note: { id: 'd', collapsed: false, bounds: expanded() }, win: fakeWin(expanded({ width: 50, height: 50 })) }
  ]
  const r = g.collectBoundsForQuit(entries)
  assert.equal(r.captured.length, 1, '只有展开态且几何合法的窗口可写回')
  assert.equal(r.skipped.length, 3)
  for (const { note } of entries) {
    assert.ok(note.bounds.width > g.COLLAPSE_MAX && note.bounds.height > g.COLLAPSE_MAX,
      `${note.id} 出现了窄条几何 ${JSON.stringify(note.bounds)}`)
  }
})

test('窗口已销毁 / getBounds 抛错时不写回', () => {
  const note = { id: 'x', collapsed: false, bounds: expanded() }
  const broken = { getBounds: () => { throw new Error('destroyed') } }
  const r = g.captureBounds(note, broken)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'window-gone')
  assert.equal(g.captureBounds(note, null).reason, 'no-target')
})

// ---------------------------------------------------------------- 10 处写回点冒烟
test('8 处联调冒烟：各写回点候选 bounds 全部过 assertExpandedBounds', () => {
  // 对应 main.js :626/:658/:687/:690/:753/:813/:880/:1770/:1895/:2316 的候选值
  const candidates = [
    { name: 'collapseNote', b: expanded({ x: 0, y: 0 }) },
    { name: 'expandNoteAt', b: expanded({ x: 60, y: 80 }) },
    { name: 'runCollapseCheck换边', b: expanded({ x: 1870, y: 200 }) },
    { name: 'runCollapseCheck展开', b: expanded({ x: 500, y: 300 }) },
    { name: 'collapsePollTick', b: expanded({ x: 900, y: 0 }) },
    { name: 'createNoteWindow restore', b: expanded() },
    { name: 'commitBounds', b: expanded({ x: 12, y: 34, width: 260, height: 200 }) },
    { name: 'note:set-bounds', b: expanded({ width: 260, height: 200 }) },
    { name: 'notes:action center', b: expanded({ x: 760, y: 290, width: 400, height: 500 }) }
  ]
  for (const c of candidates) {
    const r = g.assertExpandedBounds(c.b)
    assert.equal(r.ok, true, `${c.name} 产出非法 bounds: ${JSON.stringify(c.b)} / ${r.reason}`)
    assert.ok(r.bounds.width >= g.MIN_W && r.bounds.height >= g.MIN_H)
  }
})

test('存量污染候选（width=50）必须被所有写回点拦下', () => {
  const dirty = expanded({ width: 50, height: 473 })
  assert.equal(g.assertExpandedBounds(dirty).ok, false)
  assert.equal(g.captureBounds({ id: 'x', collapsed: false }, fakeWin(dirty)).ok, false)
})

// ---------------------------------------------------------------- 迁移自愈
test('safeExpandedBounds：候选非法时回退上一份合法 bounds，二者都脏则自愈', () => {
  const good = expanded({ width: 274, height: 473 })
  const dirty = expanded({ width: 50, height: 473 })
  assert.deepEqual(g.safeExpandedBounds(good, dirty), good)
  assert.deepEqual(g.safeExpandedBounds(dirty, good), good, '不得把 50 钳成 260')
  const healed = g.safeExpandedBounds(dirty, dirty)
  assert.ok(healed.width >= g.MIN_W && healed.height >= g.MIN_H)
  assert.equal(healed.height, 473, '合法维度应保留')
})

test('recoverBounds 只回退非法维度、保留合法维度', () => {
  const r = g.recoverBounds({ x: 100, y: 200, width: 50, height: 473 })
  assert.equal(r.recovered, true)
  assert.equal(r.bounds.width, g.DEFAULT_W)
  assert.equal(r.bounds.height, 473)
  assert.equal(r.bounds.x, 100)

  const ok = g.recoverBounds(expanded())
  assert.equal(ok.recovered, false)
  assert.deepEqual(ok.bounds, expanded())
})
