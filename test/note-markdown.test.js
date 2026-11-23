'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const katex = require('katex')
const domino = require('@mixmark-io/domino')
const md = require('../lib/note-markdown')
const domSnapshot = require('../lib/dom-snapshot')

// 加载浏览器 UMD 模块 lib/exchange-dom.js 在 Domino 环境中验证导入/导出往返
function loadExchangeDom () {
  const vm = require('vm')
  const fs = require('fs')
  const path = require('path')
  const code = fs.readFileSync(path.join(__dirname, '../lib/exchange-dom.js'), 'utf8')
  const sandbox = {
    globalThis: {},
    DOMParser: class {
      parseFromString (html) {
        return domino.createDocument(String(html || ''))
      }
    },
    StickyDomSnapshot: domSnapshot,
    Array,
    Set,
    Number,
    String,
    RegExp
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(code, sandbox, { filename: 'exchange-dom.js' })
  return sandbox.StickyExchange
}

test('Markdown 与 LaTeX 严格隔离：*、_、\\\\、& 不被破坏，代码块内 $ 不被解析', () => {
  const src = [
    '# 标题 **加粗**',
    '',
    '行内公式 $a_1 * b_2 = c_3$ 与 \\(x_i + y_j\\)，还有 **粗体中的 $u_1 * v_2$**。',
    '',
    '$$',
    '\\begin{aligned}',
    'a &= b + c \\\\',
    'd &= e * f',
    '\\end{aligned}',
    '$$',
    '',
    '\\[',
    '\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}',
    '\\]',
    '',
    '```math',
    '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
    '```',
    '',
    '```latex',
    '\\sum_{k=1}^n k = \\frac{n(n+1)}{2}',
    '```',
    '',
    '行内代码 `$not_math$` 与多反引号 ``$also_not_math$`` 与 `\\(nope\\)`。',
    '',
    '```tex',
    '$$not_rendered_in_code$$',
    '```'
  ].join('\n')

  const html = md.parseNoteMarkdown(src)
  const doc = domino.createDocument(html)

  const inlines = Array.from(doc.querySelectorAll('.math-inline'))
  const blocks = Array.from(doc.querySelectorAll('.math-block'))
  assert.equal(inlines.length, 3)
  assert.equal(inlines[0].getAttribute('data-tex'), 'a_1 * b_2 = c_3')
  assert.equal(inlines[1].getAttribute('data-tex'), 'x_i + y_j')
  assert.equal(inlines[1].getAttribute('data-delim'), '\\(')
  assert.equal(inlines[2].getAttribute('data-tex'), 'u_1 * v_2')

  assert.equal(blocks.length, 4)
  assert.ok(blocks[0].getAttribute('data-tex').includes('a &= b + c \\\\'))
  assert.equal(blocks[0].getAttribute('data-delim'), '$$')
  assert.ok(blocks[1].getAttribute('data-tex').includes('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}'))
  assert.equal(blocks[1].getAttribute('data-delim'), '\\[')
  assert.equal(blocks[2].getAttribute('data-delim'), 'math')
  assert.equal(blocks[3].getAttribute('data-delim'), 'latex')

  // 不应生成 <em>1 * b</em> 或吞掉反斜杠
  assert.equal(doc.querySelectorAll('em').length, 0)

  const codes = Array.from(doc.querySelectorAll('code')).map(c => c.textContent)
  assert.ok(codes.includes('$not_math$'))
  assert.ok(codes.includes('$also_not_math$'))
  assert.ok(codes.includes('\\(nope\\)'))
  assert.ok(codes.some(c => c.includes('$$not_rendered_in_code$$')))

  // KaTeX 渲染无报错且不生成 script/href 危险节点
  md.renderMathInElement(doc.body, katex)
  assert.equal(doc.querySelectorAll('.katex').length, 7)
  assert.equal(doc.querySelectorAll('.katex-error').length, 0)
})

test('金额与转义美元符不被误判为公式，也不吞掉后续真公式', () => {
  const src = '价格 $10 到 $20，单价 $5.99，范围 $10-$20，转义 \\$50，混排 $10 其中 $E = mc^2$。'
  const html = md.parseNoteMarkdown(src)
  const doc = domino.createDocument(html)
  const inlines = Array.from(doc.querySelectorAll('.math-inline'))
  assert.equal(inlines.length, 1)
  assert.equal(inlines[0].getAttribute('data-tex'), 'E = mc^2')
  assert.ok(doc.body.textContent.includes('$10 到 $20'))
  assert.ok(doc.body.textContent.includes('$5.99'))
  assert.ok(doc.body.textContent.includes('$10-$20'))
  assert.ok(doc.body.textContent.includes('$50'))
})

test('KaTeX trust:false / throwOnError:false / strict:false 安全契约', () => {
  const html = md.parseNoteMarkdown('$\\href{javascript:alert(1)}{click}$ 与 $\\frac{1}{$')
  const doc = domino.createDocument(html)
  md.renderMathInElement(doc.body, katex)
  assert.equal(doc.querySelectorAll('a').length, 0, 'trust:false 应拦截 \\href 危险链接')
  assert.ok(doc.querySelectorAll('.katex-error').length >= 1)
})

test('GFM 全语法解析与任务复选框可点击', () => {
  const src = [
    '# H1',
    '#### H4',
    '###### H6',
    '',
    '> 引用第一行',
    '',
    '- [x] 已完成任务',
    '- [ ] 未完成任务',
    '',
    '~~删除文字~~ 与 `inline_code`',
    '',
    '| 列A | 列B |',
    '| :--- | ---: |',
    '| 左 | 右 |',
    '',
    '---',
    '',
    '[外链](https://example.com)',
    '',
    '```mermaid',
    'graph TD; A-->B',
    '```'
  ].join('\n')

  const html = md.parseNoteMarkdown(src)
  const doc = domino.createDocument(html)
  assert.equal(doc.querySelector('h1').textContent, 'H1')
  assert.equal(doc.querySelector('h4').textContent, 'H4')
  assert.equal(doc.querySelector('h6').textContent, 'H6')
  assert.ok(doc.querySelector('blockquote'))
  assert.equal(doc.querySelector('del').textContent, '删除文字')
  assert.ok(doc.querySelector('hr'))
  assert.equal(doc.querySelectorAll('table th').length, 2)
  assert.equal(doc.querySelectorAll('table td').length, 2)

  const cbs = Array.from(doc.querySelectorAll('input[type="checkbox"]'))
  assert.equal(cbs.length, 2)
  assert.equal(cbs[0].hasAttribute('checked'), true)
  assert.equal(cbs[0].hasAttribute('disabled'), false, '任务复选框必须去掉 disabled 以可点击')
  assert.equal(cbs[1].hasAttribute('checked'), false)

  const link = doc.querySelector('a')
  assert.equal(link.getAttribute('href'), 'https://example.com')
  assert.equal(link.getAttribute('target'), '_blank')
  assert.equal(link.getAttribute('rel'), 'noreferrer')

  const mmd = doc.querySelector('.mmd')
  assert.ok(mmd)
  assert.equal(mmd.getAttribute('data-code'), 'graph TD; A-->B')
})

test('XSS 消毒与外链 http(s) 图片拦截降级', () => {
  const mdSrc = '![外链图](https://example.com/pic.png) ![本地图](sticky-att://local/a.png)'
  const mdHtml = md.parseNoteMarkdown(mdSrc)
  const mdDoc = domino.createDocument(mdHtml)
  const imgs = Array.from(mdDoc.querySelectorAll('img'))
  assert.equal(imgs.length, 1, 'http(s) 图片不得渲染为 <img>')
  assert.equal(imgs[0].getAttribute('src'), 'sticky-att://local/a.png')
  const degradedLink = mdDoc.querySelector('a[href="https://example.com/pic.png"]')
  assert.ok(degradedLink, '外链图片应降级为安全外部链接')
  assert.ok(degradedLink.textContent.includes('外链图'))

  const dirty = [
    '<script>alert(1)</script>',
    '<svg onload="alert(2)"><circle/></svg>',
    '<iframe src="https://evil.test"></iframe>',
    '<img src="https://cdn.example.com/x.png" alt="远程" onerror="alert(3)">',
    '<img src="javascript:alert(4)" alt="坏图">',
    '<a href="javascript:alert(5)" onclick="evil()">点我</a>',
    '<p style="position:fixed;background:url(https://evil.test)">正文</p>'
  ].join('')
  const clean = md.sanitizeHtml(dirty)
  assert.equal(/<script|<svg|<iframe|onerror|onclick|javascript:|position:fixed/i.test(clean), false, clean)
  assert.equal(/<img/i.test(clean), false, '外链与非法 img 均不得渲染为 <img>: ' + clean)
  assert.ok(clean.includes('https://cdn.example.com/x.png'))
  assert.ok(clean.includes('点我'))
  assert.ok(clean.includes('正文'))
})

test('HTML ↔ Markdown 无损往返（下划线/颜色/Mermaid/公式/表格/删除线/附件）', () => {
  const originalMd = [
    '# 测试标题',
    '',
    '<u>下划线</u> 与 <span style="color:#d93025">红色字</span> 与 ~~删除线~~ 和 foo_bar_baz',
    '',
    '> 引用文本',
    '',
    '- [x] 已办',
    '- [ ] 待办',
    '',
    '行内 $a_1 * b_2$ 与 \\(c_3\\)',
    '',
    '$$',
    '\\int_0^1 x^2 \\, dx',
    '$$',
    '',
    '```math',
    'E = mc^2',
    '```',
    '',
    '| H1 | H2 |',
    '| :--- | ---: |',
    '| $x_1$ | val |',
    '',
    '---',
    '',
    '```mermaid',
    'graph LR; A-->B',
    '```',
    '',
    '<p class="attachment" data-attachment="笔记.txt" data-path="C:\\notes\\附件.txt">📎 笔记.txt</p>'
  ].join('\n')

  const html1 = md.parseNoteMarkdown(originalMd, { allowAttachments: true, allowTrustNodes: true })
  const backMd = md.htmlToNoteMarkdown(html1)
  assert.ok(backMd.includes('<u>下划线</u>'), backMd)
  assert.ok(backMd.includes('color:#d93025') && backMd.includes('红色字'), backMd)
  assert.ok(backMd.includes('~~删除线~~'), backMd)
  assert.ok(backMd.includes('foo_bar_baz'), '单词内下划线不得多余转义: ' + backMd)
  assert.ok(backMd.includes('> 引用文本'), backMd)
  assert.ok(backMd.includes('- [x] 已办') && backMd.includes('- [ ] 待办'), backMd)
  assert.ok(backMd.includes('$a_1 * b_2$') && backMd.includes('\\(c_3\\)'), backMd)
  assert.ok(backMd.includes('$$\n\\int_0^1 x^2 \\, dx\n$$'), backMd)
  assert.ok(backMd.includes('```math\nE = mc^2\n```'), backMd)
  assert.ok(backMd.includes('| $x_1$ | val |'), backMd)
  assert.ok(backMd.includes('```mermaid\ngraph LR; A-->B\n```'), backMd)
  assert.ok(backMd.includes('data-attachment="笔记.txt"') && backMd.includes('C:\\notes\\附件.txt'), backMd)

  // 二次解析仍保持结构一致
  const html2 = md.parseNoteMarkdown(backMd, { allowAttachments: true, allowTrustNodes: true })
  const doc2 = domino.createDocument(html2)
  assert.equal(doc2.querySelector('u').textContent, '下划线')
  assert.equal(doc2.querySelector('del').textContent, '删除线')
  assert.equal(doc2.querySelectorAll('.math-inline').length, 3)
  assert.equal(doc2.querySelectorAll('.math-block').length, 2)
  assert.equal(doc2.querySelector('.mmd').getAttribute('data-code'), 'graph LR; A-->B')
  assert.equal(doc2.querySelector('.attachment').getAttribute('data-path'), 'C:\\notes\\附件.txt')
})

test('纯文本粘贴 Markdown/LaTeX 检测与误判护栏', () => {
  // 真实 Markdown / LaTeX 应命中
  for (const pos of [
    '# 标题',
    '**加粗文字**',
    '*斜体*',
    '~~删除~~',
    '`console.log(1)`',
    '- [ ] 任务',
    '1. 第一步',
    '> 引用内容',
    '---',
    '[OpenAI](https://openai.com)',
    '| A | B |\n| --- | --- |\n| 1 | 2 |',
    '公式 $E = mc^2$',
    '$$\\int_0^1 x dx$$',
    '\\(a + b\\)',
    '\\[c^2\\]',
    '```js\nconst a = 1\n```'
  ]) {
    assert.equal(md.looksLikeMarkdownOrLatex(pos), true, '应识别为 Markdown/LaTeX: ' + pos)
  }

  // 常见误判样本必须拦截
  for (const neg of [
    '',
    '   ',
    '普通中文文本与 English sentence.',
    '$5.99',
    '售价 $10-$20，或者 $10 到 $20，含税 \\$50',
    'foo_bar_baz and SOME_CONST_NAME',
    '{"price": "$5.99", "label": "**not md**", "key_name": 1}',
    '[1, 2, 3]',
    'C:\\Users\\Alice\\Documents\\my_note_v1.txt',
    '\\\\fileserver\\share\\team_docs\\a.pdf',
    '2026-11-23',
    '2026/11/23 14:30',
    'https://example.com/path/with_underscore'
  ]) {
    assert.equal(md.looksLikeMarkdownOrLatex(neg), false, '不得误判为 Markdown/LaTeX: ' + neg)
  }
})

test('lib/exchange-dom.js & lib/note-exchange.js 导入导出修复：DEL、BLOCKQUOTE、HR、TABLE、LaTeX 往返', async () => {
  const exchange = loadExchangeDom()
  const mdInput = [
    '# 导出的标题',
    '',
    '正文含 ~~已删除文字~~ 与 **加粗**。',
    '',
    '> 引用第一行',
    '> 引用第二行',
    '',
    '---',
    '',
    '| 名称 | 表达式 |',
    '| :--- | :--- |',
    '| 质能 | $E = mc^2$ |',
    '',
    '$$',
    '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
    '$$',
    '',
    '![远程](https://example.com/remote.png)'
  ].join('\n')

  const markedMod = await import('marked')
  const rawHtml = md.parseMarkdownToRawHtmlWithMath(mdInput, markedMod.marked, { breaks: true })
  const imported = exchange.importHtml({ title: 'fallback', html: rawHtml })

  assert.equal(imported.title, '导出的标题')
  assert.ok(imported.html.includes('<del>已删除文字</del>'), '<del> 文字不得在导入时被删除: ' + imported.html)
  assert.ok(imported.html.includes('<blockquote>'), '应保留 blockquote: ' + imported.html)
  assert.ok(imported.html.includes('<hr>'), '应保留 hr: ' + imported.html)
  assert.ok(imported.html.includes('<table>'), '应保留 table: ' + imported.html)
  assert.ok(imported.html.includes('data-tex="E = mc^2"'), '应保留行内 LaTeX 源码: ' + imported.html)
  assert.ok(imported.html.includes('data-tex="\\int_0^1 x^2 \\, dx = \\frac{1}{3}"'), '应保留块级 LaTeX 源码: ' + imported.html)
  assert.equal(/<img/i.test(imported.html), false, '导入外链图片不得渲染为 <img>')
  assert.ok(imported.html.includes('https://example.com/remote.png'))
  assert.equal(imported.preview.includes('[公式]'), true)

  const exported = exchange.exportNote({ title: imported.title, html: imported.html })
  assert.ok(exported.markdown.includes('~~已删除文字~~'), exported.markdown)
  assert.ok(exported.markdown.includes('> 引用第一行'), exported.markdown)
  assert.ok(exported.markdown.includes('> 引用第二行'), exported.markdown)
  assert.ok(exported.markdown.includes('---'), exported.markdown)
  assert.ok(exported.markdown.includes('| 名称 | 表达式 |'), exported.markdown)
  assert.ok(exported.markdown.includes('| 质能 | $E = mc^2$ |'), exported.markdown)
  assert.ok(exported.markdown.includes('$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$'), exported.markdown)
  assert.ok(exported.text.includes('[公式]'), exported.text)
})

test('内嵌三反引号代码块与空任务复选框往返、引号路径/裸URL误判护栏、选区去重含 .mmd/.math-block', () => {
  // 1. 内嵌 ``` 的代码块在导出与 htmlToNoteMarkdown 中应自动使用更长围栏
  const innerFenceCode = '```js\nconst inner = 1\n```'
  const preDoc = domino.createDocument(`<pre><code class="language-markdown">${innerFenceCode}</code></pre>`)
  const mdOut = md.htmlToNoteMarkdown(preDoc.body.innerHTML)
  assert.ok(mdOut.includes('````'), '应升级围栏长度避免提前闭合: ' + mdOut)
  const reparsedPre = domino.createDocument(md.parseNoteMarkdown(mdOut))
  assert.equal(reparsedPre.querySelector('pre code').textContent.trim(), innerFenceCode)

  const exchange = loadExchangeDom()
  const exFence = exchange.exportNote({ title: 'Fence', html: preDoc.body.innerHTML })
  assert.ok(exFence.markdown.includes('````'), 'exchange-dom PRE 导出应升级围栏长度: ' + exFence.markdown)

  // 2. 空任务复选框 - [ ] 往返不丢复选框结构
  const emptyTaskHtml = '<ul><li data-task="1"><input type="checkbox"> </li></ul>'
  const emptyTaskMd = md.htmlToNoteMarkdown(emptyTaskHtml)
  assert.match(emptyTaskMd, /^- \[ \] /m)
  const reparsedTask = domino.createDocument(md.parseNoteMarkdown(emptyTaskMd))
  assert.ok(reparsedTask.querySelector('input[type="checkbox"]'), '重解析应保留复选框: ' + emptyTaskMd)

  // 3. 引号包裹 Windows 路径与含下划线裸 URL 不得误判为 Markdown/LaTeX
  for (const neg of [
    '"C:\\Users\\Alice\\_tmp_\\a.txt"',
    "'D:\\_build_\\out_v1.log'",
    'C:\\work\\__init__.py',
    'https://example.com/_test_/path?a=1&b=2'
  ]) {
    assert.equal(md.looksLikeMarkdownOrLatex(neg), false, '不得误判: ' + neg)
  }

  // 4. extractSelectionText 处理 .math-block 换行与 .mmd 工具按钮/SVG 标签隔离
  const selDoc = domino.createDocument(
    '<div id="root">' +
    '<p>Before</p>' +
    '<div class="math-block" data-tex="E = mc^2" data-delim="$$"><div class="math-body"><span class="katex"><span class="katex-mathml"><math>Emc2</math></span><span class="katex-html">E=mc2</span></span></div></div>' +
    '<div class="mmd" data-code="graph TD; A-->B"><div class="mmd-tools"><button>✎</button><button>▦</button></div><div class="mmd-body"><svg><text>SVGNoise</text></svg></div></div>' +
    '<p>After</p>' +
    '</div>'
  )
  const root = selDoc.getElementById('root')
  const fakeRange = {
    commonAncestorContainer: root,
    cloneContents () { return root.cloneNode(true) }
  }
  const cleanSel = md.extractSelectionText(fakeRange, 'raw-fallback')
  assert.ok(cleanSel.includes('Before'), cleanSel)
  assert.ok(cleanSel.includes('E = mc^2'), cleanSel)
  assert.ok(cleanSel.includes('After'), cleanSel)
  assert.equal(cleanSel.includes('Emc2'), false, '不应包含 katex-mathml 重复文本: ' + cleanSel)
  assert.equal(cleanSel.includes('✎'), false, '不应泄露 .mmd-tools 按钮字符: ' + cleanSel)
  assert.equal(cleanSel.includes('SVGNoise'), false, '不应泄露 Mermaid SVG 内部标签: ' + cleanSel)
  assert.ok(/\$\$?E = mc\^2\$\$?[\r\n]+.*After/s.test(cleanSel) || cleanSel.includes('\n'), '块级公式后应保留换行分隔: ' + JSON.stringify(cleanSel))
})

test('exchange-dom.js 导入导出：blockquote 空行折叠、附件非嵌套 <p> 与非 http(s) 链接剥离', () => {
  const exchange = loadExchangeDom()
  const imported = exchange.importHtml({
    title: 'Safety',
    html: '<p><a href="assets/a.txt">📎 a.txt</a></p><p><a href="javascript:alert(1)">JSLink</a> <a href="file:///etc/passwd">FileLink</a> <a href="https://example.com">SafeLink</a></p>'
  })
  const impDoc = domino.createDocument(imported.html)
  assert.equal(impDoc.querySelectorAll('p.attachment').length, 1, '应生成独立 p.attachment: ' + imported.html)
  assert.equal(impDoc.querySelectorAll('p p.attachment').length, 0, '不得产生嵌套 <p><p class="attachment">: ' + imported.html)
  const links = Array.from(impDoc.querySelectorAll('a'))
  assert.equal(links.length, 1, '非 http(s) 链接应降级剥离 <a>: ' + imported.html)
  assert.equal(links[0].getAttribute('href'), 'https://example.com')
  assert.ok(impDoc.body.textContent.includes('JSLink') && impDoc.body.textContent.includes('FileLink'))

  const exported = exchange.exportNote({
    title: 'Quote',
    html: '<blockquote><p>Line 1</p><p>Line 2</p></blockquote>'
  })
  assert.equal(/\n{3,}/.test(exported.markdown), false, 'blockquote 导出不应出现连续 3+ 空行: ' + exported.markdown)
  assert.ok(exported.markdown.includes('> Line 1') && exported.markdown.includes('> Line 2'), exported.markdown)
})

test('parseNoteMarkdownSnapshot 返回完整快照统计与轻量公式骨架', () => {
  const origDOMParser = global.DOMParser
  global.DOMParser = class {
    parseFromString (html) {
      return domino.createDocument(String(html || ''))
    }
  }
  try {
    const snap = md.parseNoteMarkdownSnapshot('# Heading\n\n质能 $E = mc^2$ 公式\n\nEnd', domSnapshot, { allowTrustNodes: true, allowAttachments: true })
    assert.ok(snap.html.includes('<h1>Heading</h1>'))
    assert.ok(snap.html.includes('data-tex="E = mc^2"'))
    assert.equal(snap.html.includes('data-rendered'), false)
    assert.equal(snap.mathCount, 1)
    assert.ok(snap.text.includes('[公式]'))
    assert.equal(domSnapshot.charCount(snap.text), 14) // Heading(7) + 质能(2) + 公式(2) + End(3) = 14
  } finally {
    global.DOMParser = origDOMParser
  }
})
