'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const pa = require('../lib/popup-appearance')
const m = require('../lib/migrations')

test('normalizePopupAppearance 支持缩写色值、部分更新与默认值回退', () => {
  const def = pa.normalizePopupAppearance()
  assert.deepEqual(def, pa.DEFAULT_POPUP_APPEARANCE)

  const partial = pa.normalizePopupAppearance({ toolbar: { color: '#FFF', opacity: 0.75 } }, def)
  assert.deepEqual(partial, {
    toolbar: { color: '#ffffff', opacity: 0.75 },
    answer: { color: '#1e222a', opacity: 1 }
  })

  const invalid = pa.normalizePopupAppearance({
    toolbar: { color: 'not-a-color', opacity: 'abc' },
    answer: { color: '#12345', opacity: null }
  })
  assert.deepEqual(invalid, pa.DEFAULT_POPUP_APPEARANCE)
})

test('normalizeOpacity 严格钳制到 [0.2, 1] 并保留两位小数', () => {
  assert.equal(pa.normalizeOpacity(0, 1), 0.2)
  assert.equal(pa.normalizeOpacity(0.05, 1), 0.2)
  assert.equal(pa.normalizeOpacity(1.8, 0.5), 1)
  assert.equal(pa.normalizeOpacity(0.654, 1), 0.65)
  assert.equal(pa.normalizeOpacity('', 0.8), 0.8)
  assert.equal(pa.normalizeOpacity(undefined, 0.7), 0.7)
})

test('isLightColor 与 rgbaString 正确区分明暗色调与透明度', () => {
  assert.equal(pa.isLightColor('#23272f'), false)
  assert.equal(pa.isLightColor('#162033'), false)
  assert.equal(pa.isLightColor('#ffffff'), true)
  assert.equal(pa.isLightColor('#fff6d6'), true)
  assert.equal(pa.isLightColor('#e6f4ea'), true)

  assert.equal(pa.rgbaString('#fff6d6', 0.75), 'rgba(255, 246, 214, 0.75)')
  assert.equal(pa.rgbaString('#23272f', 0.1), 'rgba(35, 39, 47, 0.2)')
})

test('applyPopupAppearance 将背景变量与明暗 tone 写入 documentElement', () => {
  const props = {}
  const fakeDoc = {
    documentElement: {
      dataset: {},
      style: {
        setProperty (k, v) { props[k] = v }
      }
    }
  }
  const applied = pa.applyPopupAppearance(fakeDoc, {
    toolbar: { color: '#fff6d6', opacity: 0.75 },
    answer: { color: '#162033', opacity: 0.85 }
  })
  assert.equal(applied.toolbar.color, '#fff6d6')
  assert.equal(props['--ai-bar-bg'], 'rgba(255, 246, 214, 0.75)')
  assert.equal(props['--ai-panel-bg'], 'rgba(22, 32, 51, 0.85)')
  assert.equal(fakeDoc.documentElement.dataset.aiBarTone, 'light')
  assert.equal(fakeDoc.documentElement.dataset.aiPanelTone, 'dark')
})

test('migrations 保留 popupAppearance 且迁移后幂等', () => {
  const empty = m.emptyState()
  assert.deepEqual(empty.settings.popupAppearance, pa.DEFAULT_POPUP_APPEARANCE)

  const raw = {
    version: m.CURRENT_VERSION,
    notes: [],
    settings: {
      globalSelect: true,
      customFlag: 'keep',
      popupAppearance: {
        toolbar: { color: '#FFF6D6', opacity: 0.8 },
        answer: { color: '#162033', opacity: 0.9 }
      }
    }
  }
  const res = m.migrateState(raw)
  assert.equal(res.ok, true)
  assert.equal(res.changed, false)
  assert.equal(res.state.settings.customFlag, 'keep')
  assert.deepEqual(res.state.settings.popupAppearance, {
    toolbar: { color: '#fff6d6', opacity: 0.8 },
    answer: { color: '#162033', opacity: 0.9 }
  })
})
