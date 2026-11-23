'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const m = require('../lib/migrations')
const g = require('../lib/geometry')

const note = (over = {}) => Object.assign({
  id: 'n1', title: 't', html: '<p>x</p>', preview: 'x',
  bounds: { x: 100, y: 100, width: 400, height: 500 },
  collapsed: false, collapseEdge: null
}, over)

// ---------------------------------------------------------------- TC-10
test('TC-10 version 高于当前：明确拒绝，不静默降级', () => {
  const raw = {
    version: m.CURRENT_VERSION + 1,
    notes: [note({ futureField: 'keep-me' })],
    futureTopLevel: 'keep-me-too'
  }
  const r = m.migrateState(raw)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'future-version')
  assert.equal(r.fromVersion, m.CURRENT_VERSION + 1)
  assert.equal(r.state, null)
  assert.equal(r.changed, false)
})

test('TC-10 未知字段不再被白名单吞掉（note 级 + state 级）', () => {
  const raw = {
    version: m.CURRENT_VERSION,
    notes: [note({ futureField: 'note-level' })],
    futureTopLevel: 'state-level',
    settings: { globalSelect: true }
  }
  const r = m.migrateState(raw)
  assert.equal(r.ok, true)
  assert.equal(r.state.notes[0].futureField, 'note-level')
  assert.equal(r.state.futureTopLevel, 'state-level')
})

test('invalid-shape 明确拒绝', () => {
  for (const raw of [null, [], { version: 1 }, { version: 1, notes: 'x' }]) {
    assert.equal(m.migrateState(raw).reason, 'invalid-shape')
  }
})

// ---------------------------------------------------------------- TC-14
test('TC-14 v1→v2 自愈 50 DIP 污染 bounds，保留合法维度', () => {
  const raw = {
    version: 1,
    notes: [note({
      id: 'dirty',
      collapsed: true,
      collapseEdge: 'bottom',
      bounds: { x: 100, y: 900, width: 274, height: 50 }
    })]
  }
  const r = m.migrateState(raw)
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  assert.deepEqual(r.recoveredIds, ['dirty'])
  const n = r.state.notes[0]
  assert.equal(n.version, undefined)
  assert.equal(n.bounds.height, g.DEFAULT_H)
  assert.equal(n.bounds.width, 274)
  assert.equal(n.bounds.x, 100)
  assert.equal(n.boundsRecovered, true)
  assert.equal(n.collapsed, true, '不得清掉收纳状态')
  assert.equal(n.collapseEdge, 'bottom', '不得清掉贴边边')
  assert.equal(n.html, '<p>x</p>', '正文不得丢失')
  assert.equal(r.state.recoveredIds, undefined, '迁移内部字段不得落进 state')
})

test('TC-14 幂等：第二次加载不再 changed、不再改 bounds', () => {
  const raw = {
    version: 1,
    notes: [note({ id: 'd', bounds: { x: 1, y: 2, width: 50, height: 50 } })]
  }
  const first = m.migrateState(raw)
  const second = m.migrateState(first.state)
  assert.equal(second.changed, false)
  assert.deepEqual(second.recoveredIds, [])
  assert.deepEqual(second.state.notes[0].bounds, first.state.notes[0].bounds)
  assert.equal(second.state.version, m.CURRENT_VERSION)
})

test('v1→v2 合法 bounds 不被误改', () => {
  const b = { x: 12, y: 34, width: 260, height: 200 }
  const r = m.migrateState({ version: 1, notes: [note({ bounds: b })] })
  assert.deepEqual(r.recoveredIds, [])
  assert.deepEqual(r.state.notes[0].bounds, b)
  assert.equal(r.state.notes[0].boundsRecovered, undefined)
})

test('迁移保留 AI 配置与 settings', () => {
  const raw = {
    version: 1,
    notes: [note()],
    ai: { activeId: 'p1', providers: [{ id: 'p1', name: 'x', apiKey: 'sk-test', models: ['m1'] }] },
    settings: { customFlag: true }
  }
  const r = m.migrateState(raw)
  assert.equal(r.state.ai.providers[0].apiKey, 'sk-test')
  assert.equal(r.state.settings.customFlag, true)
  assert.equal(r.state.settings.globalSelect, false)
})

test('已是当前版本但 bounds 被污染：仍自愈并标记 changed（防复发）', () => {
  const raw = {
    version: m.CURRENT_VERSION,
    notes: [note({ id: 'v2dirty', collapsed: true, collapseEdge: 'left', bounds: { x: 0, y: 10, width: 50, height: 400 } })]
  }
  const r = m.migrateState(raw)
  assert.equal(r.changed, true)
  assert.deepEqual(r.recoveredIds, ['v2dirty'])
  assert.ok(r.state.notes[0].bounds.width >= g.MIN_W)
  assert.equal(r.state.notes[0].bounds.height, 400)
  assert.equal(r.state.notes[0].collapsed, true)
  assert.equal(r.state.notes[0].collapseEdge, 'left')
  assert.equal(m.migrateState(r.state).changed, false, '修完后重复启动幂等')
})

test('missing-migration 有明确失败原因而不是静默放行', () => {
  const r = m.migrateState({ version: 1, notes: [] }, { currentVersion: 99 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'missing-migration')
})


test('全局划词新装默认关闭', () => {
  assert.equal(m.emptyState().settings.globalSelect, false)
})

for (const version of [1, 2]) {
  for (const globalSelect of [true, false]) {
    test('全局划词旧配置只关闭一次 v' + version + ': ' + globalSelect, () => {
      const raw = { version, notes: [note()], settings: { globalSelect, customFlag: 42 } }
      const result = m.migrateState(raw)
      assert.equal(result.changed, true)
      assert.equal(result.state.settings.globalSelect, false)
      assert.equal(result.state.settings.customFlag, 42)
      assert.equal(raw.settings.globalSelect, globalSelect)
      result.state.settings.globalSelect = true
      const restarted = m.migrateState(JSON.parse(JSON.stringify(result.state)))
      assert.equal(restarted.changed, false)
      assert.equal(restarted.state.settings.globalSelect, true)
    })
  }
}
