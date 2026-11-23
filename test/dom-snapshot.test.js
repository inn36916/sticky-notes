'use strict'

/**
 * 「单次克隆」快照的语义回归（lib/dom-snapshot.js）。
 *
 * 这一层刻意**不依赖 Electron**：用一个极简的 DOM 替身（FakeDom）驱动，
 * 直接验证纯函数的语义口径。这样：
 *   - node --test 就能跑，不用起 Electron；
 *   - 断言的是「口径」，不是「实现细节」。
 *
 * 口径必须与历史实现（src/note.js 的 serializeHtml / plainText / updateStats）逐字一致：
 *   - 规范 html：清空 .mmd-body 的 innerHTML、移除 .mmd 的 data-rendered；
 *   - 纯文本：.mmd → ' [图表] '、img → ' [图片] '（前后各一个空格）；
 *   - 纯文本末尾 .replace(/\s+/g,' ').trim()；
 *   - 字数 = 纯文本.replace(/\[(图表|图片)\]/g,'').replace(/\s/g,'').length；
 *   - preview = 纯文本.slice(0,160)。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const dom = require('../lib/dom-snapshot')

// ---------------------------------------------------------------- DOM 替身

class FakeText {
  constructor (data) {
    this.nodeType = 3
    this.data = data || ''
    this.childNodes = []
  }
  get textContent () { return this.data }
  cloneNode () { return new FakeText(this.data) }
}

class FakeElement {
  constructor (tag, opts = {}) {
    this.nodeType = 1
    this.nodeName = String(tag).toUpperCase()
    this.attributes = Object.assign({}, opts.attrs || {})
    this.childNodes = []
    this.classList = {
      contains: (c) => String(this.attributes.class || '').split(/\s+/).indexOf(c) >= 0
    }
  }
  get className () { return this.attributes.class || '' }
  getAttribute (name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }
  removeAttribute (name) { delete this.attributes[name] }
  set innerHTML (v) { this._innerHTML = v; this.childNodes = [] }
  get innerHTML () {
    if (this._innerHTML !== undefined) return this._innerHTML
    return this.childNodes.map(c => c.outerHTML).join('')
  }
  get textContent () {
    return this.childNodes.map(c => c.textContent).join('')
  }
  get outerHTML () {
    const attrs = Object.keys(this.attributes)
      .map(k => ' ' + k + '="' + this.attributes[k] + '"').join('')
    const inner = this._innerHTML !== undefined
      ? this._innerHTML
      : this.childNodes.map(c => c.outerHTML).join('')
    return '<' + this.nodeName.toLowerCase() + attrs + '>' + inner + '</' + this.nodeName.toLowerCase() + '>'
  }
  appendChild (child) { this.childNodes.push(child); return child }
  querySelectorAll (sel) {
    const out = []
    // 只支持本测试用到的三种选择器：.mmd / .mmd-body / img
    const match = (el) => {
      if (sel === 'img') return el.nodeName === 'IMG'
      if (sel === '.mmd') return el.classList.contains('mmd')
      if (sel === '.mmd-body') return el.classList.contains('mmd-body')
      return false
    }
    const walk = (n) => {
      n.childNodes.forEach(c => {
        if (c.nodeType !== 1) return
        if (match(c)) out.push(c)
        walk(c)
      })
    }
    walk(this)
    return out
  }
  cloneNode () {
    const c = new FakeElement(this.nodeName, { attrs: Object.assign({}, this.attributes) })
    if (this._innerHTML !== undefined) c.innerHTML = this._innerHTML
    else this.childNodes.forEach(ch => c.appendChild(ch.cloneNode(true)))
    return c
  }
}

/** 构造一棵编辑区 DOM：文字 + 一个已渲染的 Mermaid 块 + 一张图片 */
function buildEditor () {
  const editor = new FakeElement('div', { attrs: { id: 'editor' } })

  const p1 = new FakeElement('p')
  p1.appendChild(new FakeText('Hello'))
  editor.appendChild(p1)

  const mmd = new FakeElement('div', { attrs: { class: 'mmd', 'data-rendered': '1', 'data-code': 'graph TD; A-->B;' } })
  const body = new FakeElement('div', { attrs: { class: 'mmd-body' } })
  body.appendChild(new FakeText('SVGWORD'))
  mmd.appendChild(body)
  editor.appendChild(mmd)

  const p2 = new FakeElement('p')
  const img = new FakeElement('img', { attrs: { src: 'data:image/png;base64,AAAA' } })
  p2.appendChild(img)
  editor.appendChild(p2)

  const p3 = new FakeElement('p')
  p3.appendChild(new FakeText('World'))
  editor.appendChild(p3)

  return editor
}

// ---------------------------------------------------------------- 语义

test('规范 html：清空 .mmd-body、移除 .mmd 的 data-rendered，保留 data-code', () => {
  const editor = buildEditor()
  const snap = dom.snapshot(editor)
  assert.ok(snap.html.indexOf('data-rendered') === -1, '仍带 data-rendered: ' + snap.html)
  assert.ok(snap.html.indexOf('SVGWORD') === -1, 'SVG 渲染产物落盘了: ' + snap.html)
  assert.ok(snap.html.indexOf('data-code') >= 0, 'data-code 源码必须保留: ' + snap.html)
  assert.ok(/class="mmd-body"><\/div>/.test(snap.html), '.mmd-body 未被清空: ' + snap.html)
})

test('纯文本：.mmd → " [图表] "、img → " [图片] "（前后各一个空格）', () => {
  const editor = buildEditor()
  const snap = dom.snapshot(editor)
  assert.equal(snap.text, 'Hello [图表] [图片] World')
  assert.ok(snap.text.indexOf(' [图表] ') >= 0, '缺少 " [图表] "（两侧空格）: ' + JSON.stringify(snap.text))
  assert.ok(snap.text.indexOf(' [图片] ') >= 0, '缺少 " [图片] "（两侧空格）: ' + JSON.stringify(snap.text))
})

test('纯文本：SVG 里的文字不得进正文', () => {
  const editor = buildEditor()
  const snap = dom.snapshot(editor)
  assert.ok(snap.text.indexOf('SVGWORD') === -1, 'SVG 文字混进正文: ' + snap.text)
})

test('纯文本：连续空白折叠成单个空格并去首尾', () => {
  const editor = new FakeElement('div')
  const p = new FakeElement('p')
  p.appendChild(new FakeText('  a \n\t b  '))
  editor.appendChild(p)
  const snap = dom.snapshot(editor)
  assert.equal(snap.text, 'a b')
})

test('统计口径：字数 = 纯文本去占位符去空白；图片/图表数各归各', () => {
  const editor = buildEditor()
  const snap = dom.snapshot(editor)
  assert.equal(dom.charCount(snap.text), dom.charCount('Hello [图表] [图片] World'))
  assert.equal(dom.charCount(snap.text), 'HelloWorld'.length)
  assert.equal(snap.imgCount, 1)
  assert.equal(snap.mmdCount, 1)
  assert.equal(dom.statsText(snap), '10 字 · 1 图 · 1 图表')
})

test('统计栏文案：无图无图表时只有字数', () => {
  const editor = new FakeElement('div')
  const p = new FakeElement('p')
  p.appendChild(new FakeText('abc'))
  editor.appendChild(p)
  const snap = dom.snapshot(editor)
  assert.equal(dom.statsText(snap), '3 字')
})

test('preview 口径：纯文本前 160 字', () => {
  const editor = new FakeElement('div')
  const p = new FakeElement('p')
  p.appendChild(new FakeText('A'.repeat(400)))
  editor.appendChild(p)
  const snap = dom.snapshot(editor)
  assert.equal(dom.previewText(snap).length, 160)
  assert.equal(dom.previewText(snap), 'A'.repeat(160))
})

test('空编辑区：html/text 为空串，计数为 0', () => {
  const editor = new FakeElement('div')
  const snap = dom.snapshot(editor)
  assert.equal(snap.html, '')
  assert.equal(snap.text, '')
  assert.equal(snap.imgCount, 0)
  assert.equal(snap.mmdCount, 0)
  assert.equal(dom.statsText(snap), '0 字')
})

test('非法根节点：返回空快照而不是抛异常', () => {
  for (const bad of [null, undefined, {}, 42]) {
    const snap = dom.snapshot(bad)
    assert.equal(snap.html, '')
    assert.equal(snap.text, '')
    assert.equal(snap.imgCount, 0)
    assert.equal(snap.mmdCount, 0)
  }
})

test('★ DOM 树只克隆一次', () => {
  const editor = buildEditor()
  let cloneCount = 0
  const orig = editor.cloneNode.bind(editor)
  editor.cloneNode = function (deep) { cloneCount++; return orig(deep) }

  const snap = dom.snapshot(editor)
  assert.equal(cloneCount, 1, 'snapshot() 必须只克隆一次，实际 ' + cloneCount + ' 次')
  // 消费快照的三个消费者不得再触发克隆
  dom.charCount(snap.text)
  dom.statsText(snap)
  dom.previewText(snap)
  assert.equal(cloneCount, 1, '消费快照的过程中又克隆了')
})

test('快照的 html 与 text 两个视图互不干扰（取 text 不影响 html）', () => {
  const editor = buildEditor()
  const snap = dom.snapshot(editor)
  const html = snap.html
  const text = snap.text
  // 再取一次同样的快照，结果必须完全一致（视图之间没有互相污染）
  const again = dom.snapshot(editor)
  assert.equal(again.html, html)
  assert.equal(again.text, text)
})

test('公式骨架：剥离 .math-body / data-rendered，纯文本输出 " [公式] "，字数排除 [公式]，mathCount=0 时状态栏字节级一致', () => {
  const editor = new FakeElement('div', { attrs: { id: 'editor' } })
  const p = new FakeElement('p')
  p.appendChild(new FakeText('质能'))
  const mathInline = new FakeElement('span', {
    attrs: { class: 'math-inline', 'data-rendered': '1', 'data-tex': 'E = mc^2', 'data-delim': '$' }
  })
  const mBody = new FakeElement('span', { attrs: { class: 'math-body' } })
  mBody.appendChild(new FakeText('E=mc2E=mc2E=mc2'))
  mathInline.appendChild(mBody)
  p.appendChild(mathInline)
  p.appendChild(new FakeText('定理'))
  editor.appendChild(p)

  const mathBlock = new FakeElement('div', {
    attrs: { class: 'math-block', 'data-rendered': '1', 'data-tex': 'a^2 + b^2 = c^2', 'data-delim': '$$' }
  })
  const bBody = new FakeElement('div', { attrs: { class: 'math-body' } })
  bBody.appendChild(new FakeText('a2+b2=c2'))
  mathBlock.appendChild(bBody)
  editor.appendChild(mathBlock)

  const snap = dom.snapshot(editor)
  assert.equal(snap.html.includes('data-rendered'), false)
  assert.equal(snap.html.includes('E=mc2E=mc2E=mc2'), false, 'KaTeX 重复 DOM 不得落盘')
  assert.equal(snap.html.includes('data-tex="E = mc^2"'), true)
  assert.equal(snap.text, '质能 [公式] 定理 [公式]')
  assert.equal(dom.charCount(snap.text), 4)
  assert.equal(snap.mathCount, 2)
  assert.equal(dom.statsText(snap), '4 字 · 2 公式')

  // searchTextFromRoot 提取 LaTeX 源码而非 KaTeX 重复文本
  const searchTxt = dom.searchTextFromRoot(editor)
  assert.ok(searchTxt.includes('$E = mc^2$'))
  assert.ok(searchTxt.includes('$$a^2 + b^2 = c^2$$'))
  assert.equal(searchTxt.includes('E=mc2E=mc2E=mc2'), false)

  // searchTextFromRoot 在相邻块级元素间补空格，不粘连为 AlphaBeta
  const multiRoot = new FakeElement('div')
  const h1 = new FakeElement('h1'); h1.appendChild(new FakeText('AlphaTitle'))
  const p1 = new FakeElement('p'); p1.appendChild(new FakeText('BetaBody'))
  const p2 = new FakeElement('p'); p2.appendChild(new FakeText('GammaEnd'))
  multiRoot.appendChild(h1); multiRoot.appendChild(p1); multiRoot.appendChild(p2)
  const spaced = dom.searchTextFromRoot(multiRoot)
  assert.equal(spaced, 'AlphaTitle BetaBody GammaEnd')
})
