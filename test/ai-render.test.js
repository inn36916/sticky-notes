'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const katex = require('katex')
const { renderAiMarkdown } = require('../src/ai-render')

test('renderAiMarkdown 使用 KaTeX 渲染行内与多行块级 LaTeX 公式', () => {
  const src = [
    '质能方程：$E = mc^2$，以及 \\(\\alpha + \\beta\\)。',
    '',
    '$$',
    '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
    '$$',
    '',
    '\\[',
    '\\sum_{i=1}^n i = \\frac{n(n+1)}{2}',
    '\\]'
  ].join('\n')

  const html = renderAiMarkdown(src, { katex })
  assert.ok(html.includes('class="ai-math-inline"'))
  assert.ok(html.includes('class="ai-math-block"'))
  assert.ok(html.includes('class="katex"'))
  assert.ok(html.includes('class="katex-display"'))
  assert.equal(html.includes('katex-error'), false)
})

test('公式内的 * 与 _ 不被 Markdown 加粗吞掉', () => {
  const html = renderAiMarkdown('**结果**：$a_1 * b_2 = c_3$', { katex })
  assert.ok(html.includes('<b>结果</b>'))
  assert.ok(html.includes('class="katex"'))
  assert.equal(html.includes('<b>1 * b</b>'), false)
  assert.equal(html.includes('katex-error'), false)
})

test('金额与转义美元符号不被误判为 LaTeX 公式', () => {
  const html = renderAiMarkdown('售价 $10 到 $20，或者$10到$20，以及 \\$50。', { katex })
  assert.equal(html.includes('class="katex"'), false)
  assert.ok(html.includes('$10 到 $20'))
  assert.ok(html.includes('$10到$20'))
  assert.ok(html.includes('$50'))
})

test('代码块与行内代码中的公式分隔符保持原样不渲染', () => {
  const src = [
    '行内代码 `$not_math$` 与 `\\(x\\)`。',
    '```tex',
    '$$a^2 + b^2 = c^2$$',
    '```'
  ].join('\n')
  const html = renderAiMarkdown(src, { katex })
  assert.equal(html.includes('class="katex"'), false)
  assert.ok(html.includes('<code>$not_math$</code>'))
  assert.ok(html.includes('<pre><code>$$a^2 + b^2 = c^2$$</code></pre>'))
})

test('流式未闭合块级公式平滑降级且阻止不安全链接命令', () => {
  const streaming = renderAiMarkdown('$$\nx^2 + y^2', { katex })
  assert.ok(streaming.includes('ai-math-pending'))
  assert.equal(streaming.includes('katex-error'), false)

  const xss = renderAiMarkdown('$\\href{javascript:alert(1)}{click}$ <script>alert(1)</script>', { katex })
  assert.equal(/<a\b|href=/i.test(xss), false)
  assert.ok(xss.includes('color:#cc0000'))
  assert.equal(xss.includes('<script>'), false)
})
