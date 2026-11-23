'use strict'

/**
 * 公共工具函数回归测试（lib/utils.js）
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { SAFE_NAME, clamp, escapeHtml } = require('../lib/utils')

test('escapeHtml 正确转义五类 HTML 特殊字符且对空值安全', () => {
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
  assert.equal(escapeHtml(123), '123')
  assert.equal(
    escapeHtml(`<a href="x" data-x='y'>A & B</a>`),
    '&lt;a href=&quot;x&quot; data-x=&#39;y&#39;&gt;A &amp; B&lt;/a&gt;'
  )
})

test('clamp 正常钳制区间并在 hi < lo 时安全回落到 lo', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-3, 0, 10), 0)
  assert.equal(clamp(99, 0, 10), 10)
  assert.equal(clamp(5, 100, 20), 100)
})

test('SAFE_NAME 保留合法中文与常用标点并替换路径危险字符', () => {
  const cleaned = '报告/2026:第1版*?.pdf'.replace(SAFE_NAME, '_')
  assert.equal(cleaned, '报告_2026_第1版_.pdf')
})
