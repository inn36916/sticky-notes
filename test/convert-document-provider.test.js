'use strict'

/**
 * 内置文档 provider（document.js）与 PDF→Markdown（pdf-to-markdown.js）单测。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')

const { validateProvider, REASON, WARN } = require('../lib/convert/provider')
const docProvider = require('../lib/convert/providers/document')
const { pdfToMarkdown } = require('../lib/convert/providers/pdf-to-markdown')
const textData = require('../lib/convert/providers/text-data')
const { createRouter } = require('../lib/convert/router')
const { createService } = require('../lib/convert/service')
const { MAX_ALL_PAGES } = require('../lib/convert/providers/pdf-helpers')

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const PDF_HEADER = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-doc-' + tag + '-'))
}

/** 用 jszip 构造最小合法 .docx（含标题、正文、表格与可选内嵌图片） */
async function buildSampleDocx (dest, opts = {}) {
  const zip = new JSZip()
  const withImage = !!opts.withImage
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (withImage ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>')
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>')
  zip.file('word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    (withImage
      ? '<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'
      : '') +
    '</Relationships>')

  const imgXml = withImage
    ? '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImg1"/></pic:blipFill>' +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
    : ''

  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目报告</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>这是第一段正文内容。</w:t></w:r></w:p>' +
    '<w:tbl>' +
    '<w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>分数</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>张三</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>98</w:t></w:r></w:p></w:tc></w:tr>' +
    '</w:tbl>' +
    imgXml +
    '</w:body></w:document>')

  if (withImage) zip.file('word/media/image1.png', PNG_1PX)
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  fs.writeFileSync(dest, buf)
  return dest
}

function fakeHost (over = {}) {
  const calls = { renderHtmlToPdf: [], extractPdfStructured: [] }
  return {
    calls,
    async renderHtmlToPdf (html) {
      calls.renderHtmlToPdf.push(html)
      if (typeof over.renderHtmlToPdf === 'function') return over.renderHtmlToPdf(html)
      return { ok: true, bytes: Buffer.concat([PDF_HEADER, Buffer.from('%FAKE-PDF')]) }
    },
    async extractPdfStructured (bytes, opts) {
      calls.extractPdfStructured.push({ bytes, opts })
      if (typeof over.extractPdfStructured === 'function') return over.extractPdfStructured(bytes, opts)
      return {
        ok: true,
        numPages: 1,
        pagesConverted: 1,
        pages: [{
          pageNumber: 1,
          width: 595,
          height: 842,
          items: [
            { str: '主标题', x: 50, y: 760, width: 80, height: 24, fontSize: 24, fontName: 'Sans' },
            { str: '正文第一行内容', x: 50, y: 710, width: 120, height: 12, fontSize: 12, fontName: 'Sans' }
          ]
        }]
      }
    }
  }
}

test('★ document provider：满足契约且不截胡 builtin-text-data', async () => {
  const host = fakeHost()
  const p = docProvider.createDocumentProvider({ workerHost: host })
  const v = validateProvider(p)
  assert.equal(v.ok, true, v.error)
  assert.equal(p.id, 'builtin-document')

  // md → json/csv 等必须返回 false，让 builtin-text-data 处理
  for (const t of ['json', 'csv', 'xml', 'yaml', 'yml', 'toml', 'txt', 'md']) {
    assert.equal(await p.canHandle('md', t), false, 'md → ' + t + ' 不应被 document 截胡')
  }
  assert.equal(await p.canHandle('md', 'html'), true)
  assert.equal(await p.canHandle('md', 'pdf'), true)
  assert.equal(await p.canHandle('pdf', 'md'), true)
  assert.equal(await p.canHandle('docx', 'md'), true)

  const router = createRouter({
    providers: [textData.createTextDataProvider(), p]
  })
  const dir = tmpDir('route')
  const mdFile = path.join(dir, 'tbl.md')
  fs.writeFileSync(mdFile, '| a | b |\n| --- | --- |\n| 1 | 2 |\n')
  const rJson = await router.convert([mdFile], 'json', tmpDir('route-out'))
  assert.equal(rJson.ok, true)
  assert.equal(rJson.provider, 'builtin-text-data')
})

test('★ document provider：docx → md（含内嵌图片提取到伴生目录与无图时不建目录）', async t => {
  const dir = tmpDir('docx-md')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const withImg = await buildSampleDocx(path.join(dir, 'report.docx'), { withImage: true })
  const noImg = await buildSampleDocx(path.join(dir, 'plain.docx'), { withImage: false })

  const svc = createService({
    userDataDir: path.join(dir, 'ud'),
    providers: [docProvider.createDocumentProvider({ workerHost: fakeHost() })]
  })

  const r1 = await svc.convert([withImg], 'md')
  assert.equal(r1.ok, true, JSON.stringify(r1))
  assert.equal(r1.attachments.length, 1)
  const mdPath = r1.attachments[0].path
  const assetsDir = r1.attachments[0].assetsDir
  assert.ok(assetsDir && fs.existsSync(assetsDir), '含图片时必须创建伴生目录')
  const extracted = path.join(assetsDir, 'image-1.png')
  assert.ok(fs.existsSync(extracted), '内嵌图片必须落地')
  assert.deepEqual(fs.readFileSync(extracted), PNG_1PX)
  const mdText = fs.readFileSync(mdPath, 'utf8')
  assert.ok(mdText.includes('项目报告'))
  assert.ok(mdText.includes('report_assets/image-1.png'), mdText)

  const r2 = await svc.convert([noImg], 'md')
  assert.equal(r2.ok, true)
  assert.equal(r2.attachments[0].assetsDir, undefined)
  assert.equal(fs.existsSync(path.join(dir, 'plain_assets')), false, '无图片时不能建空目录')
})

test('★ document provider：docx → html / txt / pdf，假 docx 明确失败', async t => {
  const dir = tmpDir('docx-other')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const outDir = tmpDir('docx-out')
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }))

  const src = await buildSampleDocx(path.join(dir, 'sample.docx'))
  const host = fakeHost()
  const p = docProvider.createDocumentProvider({ workerHost: host })

  const rHtml = await p.convert([src], 'html', outDir)
  assert.equal(rHtml.ok, true)
  const html = fs.readFileSync(rHtml.outputs[0].output, 'utf8')
  assert.ok(html.includes('<meta charset="utf-8"'))
  assert.ok(html.includes('项目报告'))

  const rTxt = await p.convert([src], 'txt', outDir)
  assert.equal(rTxt.ok, true)
  assert.ok(fs.readFileSync(rTxt.outputs[0].output, 'utf8').includes('这是第一段正文内容'))

  const rPdf = await p.convert([src], 'pdf', outDir)
  assert.equal(rPdf.ok, true)
  assert.equal(host.calls.renderHtmlToPdf.length, 1)
  assert.equal(fs.readFileSync(rPdf.outputs[0].output).slice(0, 5).toString('ascii'), '%PDF-')

  const fakeDocx = path.join(dir, 'fake.docx')
  fs.writeFileSync(fakeDocx, 'not a zip')
  const failOut = tmpDir('docx-fail')
  t.after(() => fs.rmSync(failOut, { recursive: true, force: true }))
  const rBad = await p.convert([fakeDocx], 'md', failOut)
  assert.equal(rBad.ok, false)
  assert.match(rBad.failures[0].error, /ZIP|DOCX/)
  assert.equal(fs.readdirSync(failOut).length, 0)
})

test('★ document provider：html / htm → md / txt / pdf（剥离脚本与样式）', async t => {
  const dir = tmpDir('html')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const outDir = tmpDir('html-out')
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }))

  const src = path.join(dir, 'page.htm')
  fs.writeFileSync(src,
    '<!DOCTYPE html><html><head><style>.a{color:red}</style><script>window.pwn=1</script></head>' +
    '<body><h1>标题</h1><p>第一段 &amp; 实体</p><table><tr><th>列1</th></tr><tr><td>值1</td></tr></table></body></html>')

  const host = fakeHost()
  const p = docProvider.createDocumentProvider({ workerHost: host })

  const rMd = await p.convert([src], 'md', outDir)
  assert.equal(rMd.ok, true)
  const md = fs.readFileSync(rMd.outputs[0].output, 'utf8')
  assert.ok(md.includes('# 标题'))
  assert.ok(!md.includes('window.pwn'))
  assert.ok(!md.includes('.a{color:red}'))
  assert.ok(md.includes('| 列1 |'))

  const rTxt = await p.convert([src], 'txt', outDir)
  assert.equal(rTxt.ok, true)
  const txt = fs.readFileSync(rTxt.outputs[0].output, 'utf8')
  assert.ok(txt.includes('第一段 & 实体'))
  assert.ok(!txt.includes('window.pwn'))

  const rPdf = await p.convert([src], 'pdf', outDir)
  assert.equal(rPdf.ok, true)
  assert.equal(fs.readFileSync(rPdf.outputs[0].output).slice(0, 5).toString('ascii'), '%PDF-')
})

test('★ document provider：md → html / pdf（marked ESM 异步加载正常）', async t => {
  const dir = tmpDir('md')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const outDir = tmpDir('md-out')
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }))

  const src = path.join(dir, 'note.md')
  fs.writeFileSync(src, '# 标题一\n\n- 列表项\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n')

  const host = fakeHost()
  const p = docProvider.createDocumentProvider({ workerHost: host })

  const rHtml = await p.convert([src], 'html', outDir)
  assert.equal(rHtml.ok, true)
  const html = fs.readFileSync(rHtml.outputs[0].output, 'utf8')
  assert.ok(html.includes('<h1>标题一</h1>'))
  assert.ok(html.includes('<table>'))

  const rPdf = await p.convert([src], 'pdf', outDir)
  assert.equal(rPdf.ok, true)
  assert.equal(host.calls.renderHtmlToPdf.length, 1)
  assert.ok(host.calls.renderHtmlToPdf[0].includes('<h1>标题一</h1>'))
})

test('★ pdfToMarkdown：标题层级、代码块、列表（含悬挂缩进不误判表格）、简单表格、段落合并与英文断词', () => {
  const res = pdfToMarkdown({
    pages: [{
      pageNumber: 1,
      width: 595,
      height: 842,
      items: [
        // 标题 H1 / H2 / H3（正文基准 12）
        { str: '一级标题', x: 50, y: 800, width: 100, fontSize: 22, fontName: 'Sans' },
        { str: '二级标题', x: 50, y: 770, width: 90, fontSize: 17, fontName: 'Sans' },
        { str: '三级标题', x: 50, y: 745, width: 80, fontSize: 14, fontName: 'Sans' },
        // 正文段落（连续换行 + 英文连字符 + 中文续行）
        { str: '这是第一行中文', x: 50, y: 710, width: 100, fontSize: 12, fontName: 'Sans' },
        { str: '接续第二行以及', x: 50, y: 695, width: 100, fontSize: 12, fontName: 'Sans' },
        { str: 'hyphen-', x: 50, y: 680, width: 50, fontSize: 12, fontName: 'Sans' },
        { str: 'ated word', x: 50, y: 665, width: 60, fontSize: 12, fontName: 'Sans' },
        // 悬挂缩进列表（gap >= 2 * fontSize，不能被误判为表格）
        { str: '•', x: 50, y: 620, width: 6, fontSize: 12, fontName: 'Sans' },
        { str: '项目一内容较长用于拉高正文众数权重', x: 90, y: 620, width: 220, fontSize: 12, fontName: 'Sans' },
        { str: '•', x: 50, y: 604, width: 6, fontSize: 12, fontName: 'Sans' },
        { str: '项目二内容较长用于拉高正文众数权重', x: 90, y: 604, width: 220, fontSize: 12, fontName: 'Sans' },
        // 等宽代码块
        { str: 'const x = 1', x: 50, y: 560, width: 80, fontSize: 11, fontName: 'Consolas' },
        { str: 'return x + 2', x: 50, y: 545, width: 90, fontSize: 11, fontName: 'Consolas' },
        // 简单两列表格
        { str: '名称', x: 50, y: 500, width: 30, fontSize: 12, fontName: 'Sans' },
        { str: '数值', x: 200, y: 500, width: 30, fontSize: 12, fontName: 'Sans' },
        { str: 'CPU', x: 50, y: 484, width: 30, fontSize: 12, fontName: 'Sans' },
        { str: '42%', x: 200, y: 484, width: 30, fontSize: 12, fontName: 'Sans' }
      ]
    }]
  })

  assert.equal(res.isEmpty, false)
  assert.ok(res.markdown.includes('# 一级标题'))
  assert.ok(res.markdown.includes('## 二级标题'))
  assert.ok(res.markdown.includes('### 三级标题'))
  assert.ok(res.markdown.includes('这是第一行中文接续第二行以及 hyphenated word'))
  assert.ok(res.markdown.includes('- 项目一内容较长用于拉高正文众数权重'))
  assert.ok(!res.markdown.includes('| • |'), '悬挂缩进列表不能误判为表格')
  assert.ok(res.markdown.includes('```\nconst x = 1\nreturn x + 2\n```'))
  assert.ok(res.markdown.includes('| 名称 | 数值 |\n| --- | --- |\n| CPU | 42% |'))
})

test('★ document provider：pdf → md 多页/超限/无文本层告警与无 worker 降级', async t => {
  const dir = tmpDir('pdfmd')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const outDir = tmpDir('pdfmd-out')
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }))

  const src = path.join(dir, 'doc.pdf')
  fs.writeFileSync(src, PDF_HEADER)

  // 无 workerHost
  const noHost = docProvider.createDocumentProvider({})
  assert.equal(await noHost.canHandle('pdf', 'md'), false)
  const capsNo = await noHost.capabilities('pdf')
  assert.equal(capsNo.ok, false)
  assert.equal(capsNo.reason, REASON.NOT_INSTALLED)

  // 多页默认仅第 1 页 ⇒ pdf-multipage
  const multiHost = fakeHost({
    extractPdfStructured: async () => ({
      ok: true,
      numPages: 4,
      pagesConverted: 1,
      pages: [{ pageNumber: 1, width: 595, height: 842, items: [{ str: '第一页', x: 50, y: 700, fontSize: 12 }] }]
    })
  })
  const p1 = docProvider.createDocumentProvider({ workerHost: multiHost })
  const r1 = await p1.convert([src], 'md', outDir)
  assert.equal(r1.ok, true)
  assert.ok((r1.outputs[0].warnings || []).some(w => w.code === WARN.PDF_MULTIPAGE))

  // allPages 超过 MAX_ALL_PAGES ⇒ pdf-page-limit
  const limitHost = fakeHost({
    extractPdfStructured: async () => ({
      ok: true,
      numPages: MAX_ALL_PAGES + 5,
      pagesConverted: MAX_ALL_PAGES,
      pages: [{ pageNumber: 1, width: 595, height: 842, items: [{ str: '页1', x: 50, y: 700, fontSize: 12 }] }]
    })
  })
  const p2 = docProvider.createDocumentProvider({ workerHost: limitHost })
  const r2 = await p2.convert([src], 'md', outDir, { allPages: true })
  assert.equal(r2.ok, true)
  assert.ok((r2.warnings || []).some(w => w.code === WARN.PDF_PAGE_LIMIT))

  // 扫描件空文本层 ⇒ pdf-no-text-layer
  const scanHost = fakeHost({
    extractPdfStructured: async () => ({
      ok: true,
      numPages: 1,
      pagesConverted: 1,
      pages: [{ pageNumber: 1, width: 595, height: 842, items: [] }]
    })
  })
  const p3 = docProvider.createDocumentProvider({ workerHost: scanHost })
  const r3 = await p3.convert([src], 'md', outDir)
  assert.equal(r3.ok, true)
  assert.ok((r3.outputs[0].warnings || []).some(w => w.code === WARN.PDF_NO_TEXT_LAYER))
})
