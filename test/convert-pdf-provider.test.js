'use strict'

/**
 * 内置 PDF provider（lib/convert/providers/pdf.js）的契约与流程回归。
 *
 * 这里用**假依赖**驱动，验的是编排逻辑：
 *   - png/jpeg → PDF：魔数、页数、单文件失败隔离、全失败不假成功；
 *   - PDF → png/jpg/webp/txt：文件名、魔数校验、多页警告、加密/损坏失败；
 *   - 注册与路由：开箱即用、不截胡 png→jpg。
 *
 * pdfjs 真渲染只可能在 Electron 渲染进程做，由 scripts/e2e-convert-pdf.js 覆盖。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { validateProvider, REASON, WARN } = require('../lib/convert/provider')
const pdfProvider = require('../lib/convert/providers/pdf')
const providersIndex = require('../lib/convert/providers')
const { createRouter } = require('../lib/convert/router')
const { createService } = require('../lib/convert/service')
const { collectWarnings } = require('../lib/convert/main-bridge')

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const WEBP_HEADER = Buffer.concat([
  Buffer.from('RIFF', 'ascii'), Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'), Buffer.alloc(4)
])
const PDF_HEADER = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-pdf-' + tag + '-'))
}

/** 写一个指定魔数的源文件 */
function writeSrc (dir, name, bytes) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, bytes)
  return p
}

/** 一个最小的假 PNG 源文件（内容里带一个可识别标记） */
function pngFile (dir, name, tag) {
  return writeSrc(dir, name, Buffer.concat([PNG_HEADER, Buffer.from('PNG:' + (tag || name))]))
}

/** 一个最小的假 PDF 源文件 */
function pdfFile (dir, name, pages) {
  return writeSrc(dir, name, Buffer.concat([
    PDF_HEADER, Buffer.from('pages=' + (pages == null ? 1 : pages) + '\n%%EOF')
  ]))
}

/**
 * 假 pdf-lib：产出带 %PDF- 魔数、页面数写在正文里的"可断言 PDF"。
 * 不用真 pdf-lib 是为了把"页数 == 输入图片数"变成普通字符串断言。
 */
function fakePdfLib (opts = {}) {
  class PDFDocument {
    static async create () { return new PDFDocument() }

    constructor () {
      this.pages = []
      this.embeds = []
    }

    async embedPng (bytes) {
      return this._embed('png', bytes)
    }

    async embedJpg (bytes) {
      return this._embed('jpg', bytes)
    }

    async _embed (kind, bytes) {
      const text = Buffer.from(bytes).toString('latin1')
      if (opts.failOn && text.includes(opts.failOn)) throw new Error('模拟 embed 失败')
      this.embeds.push({ kind, size: bytes.length })
      // 尺寸故意固定，方便断言 drawImage 用的是原始像素
      return { width: 12, height: 8 }
    }

    addPage (size) {
      this.pages.push(size)
      return {
        drawImage (img, o) {
          if (!img || o.x !== 0 || o.y !== 0) throw new Error('drawImage 参数不对')
        }
      }
    }

    async save () {
      return Buffer.concat([
        PDF_HEADER,
        Buffer.from('pages=' + this.pages.length + '\n'),
        Buffer.from('sizes=' + JSON.stringify(this.pages) + '\n%%EOF')
      ])
    }
  }
  return { PDFDocument }
}

/**
 * 假 workerHost：renderPdf / extractPdfText / encode 都可覆盖。
 */
function fakeWorkerHost (opts = {}) {
  const calls = { renderPdf: [], extractPdfText: [], encode: [] }
  let seq = 0
  return {
    calls,
    async decode () { return { ok: true, canvasId: 'img-c', width: 1, height: 1 } },
    async encode (canvasId, mime) {
      calls.encode.push({ canvasId, mime })
      if (typeof opts.encode === 'function') return opts.encode(canvasId, mime)
      const bytes = mime === 'image/png' ? PNG_HEADER
        : mime === 'image/jpeg' ? JPG_HEADER : WEBP_HEADER
      return { ok: true, bytes, type: mime }
    },
    async renderPdf (bytes, o) {
      calls.renderPdf.push({ bytes, o })
      if (typeof opts.renderPdf === 'function') return opts.renderPdf(bytes, o)
      return {
        ok: true, width: 200, height: 100,
        canvasId: 'pdf-c' + (++seq), numPages: 1
      }
    },
    async extractPdfText (bytes, o) {
      calls.extractPdfText.push({ bytes, o })
      if (typeof opts.extractPdfText === 'function') return opts.extractPdfText(bytes, o)
      return { ok: true, text: '你好 PDF\n第二行', numPages: 1 }
    }
  }
}

function createProvider (opts = {}) {
  return pdfProvider.createPdfProvider(Object.assign({
    pdfLib: opts.pdfLib === undefined ? fakePdfLib() : opts.pdfLib,
    workerHost: opts.workerHost === undefined ? fakeWorkerHost(opts) : opts.workerHost
  }, opts))
}

// ---------------------------------------------------------------- 契约 / 路由

test('★ PDF provider：满足 provider 契约', () => {
  const p = createProvider()
  const v = validateProvider(p)
  assert.equal(v.ok, true, v.error)
  assert.equal(p.id, 'builtin-pdf')
  assert.equal(p.name, '内置 PDF 转换')
})

test('★ PDF provider：capabilities("pdf") 返回 png/jpg/webp/txt', async () => {
  const r = await createProvider().capabilities('pdf')
  assert.equal(r.ok, true)
  assert.equal(r.reason, REASON.OK)
  assert.deepEqual(r.targets, ['png', 'jpg', 'webp', 'txt'])
  assert.equal(r.displayName, 'PDF 文档')
})

test('★ PDF provider：capabilities("png") 对 pdf 目标正确；csv 返回 usage', async () => {
  const p = createProvider()
  const png = await p.capabilities('png')
  assert.equal(png.ok, true)
  assert.deepEqual(png.targets, ['pdf'])

  const jpg = await p.capabilities('jpeg')
  assert.equal(jpg.ok, true)
  assert.deepEqual(jpg.targets, ['pdf'])

  const csv = await p.capabilities('csv')
  assert.equal(csv.ok, false)
  assert.equal(csv.reason, REASON.USAGE)
  assert.deepEqual(csv.targets, [])
})

test('★ PDF provider：canHandle 精确，不截胡别的 provider', async () => {
  const p = createProvider()
  assert.equal(await p.canHandle('pdf', 'png'), true)
  assert.equal(await p.canHandle('pdf', 'jpg'), true)
  assert.equal(await p.canHandle('pdf', 'webp'), true)
  assert.equal(await p.canHandle('pdf', 'txt'), true)
  assert.equal(await p.canHandle('png', 'pdf'), true)
  assert.equal(await p.canHandle('jpeg', 'pdf'), true)
  // 以下组合必须 false —— 否则会把 builtin-image / text-data 的活抢走
  assert.equal(await p.canHandle('pdf', 'csv'), false)
  assert.equal(await p.canHandle('png', 'txt'), false)
  assert.equal(await p.canHandle('png', 'jpg'), false)
  assert.equal(await p.canHandle('gif', 'pdf'), false)
  assert.equal(await p.canHandle('webp', 'pdf'), false)
  assert.equal(await p.canHandle('csv', 'pdf'), false)
  assert.equal(await p.canHandle('pdf', null), true)
})

test('★ PDF provider：available() 同时要求 pdf-lib 与 worker 通道', async () => {
  assert.equal(await createProvider().available(), true)
  assert.equal(await createProvider({ workerHost: null }).available(), false)
  // 传一个"没有 PDFDocument"的库对象模拟缺失，而不是 null
  // （provider 对 null 会回落到真实 pdf-lib，这是刻意设计）
  assert.equal(await createProvider({ pdfLib: {} }).available(), false)
  // 残缺 host（缺 encode）也不能算可用
  assert.equal(await createProvider({
    workerHost: { renderPdf () {}, extractPdfText () {} }
  }).available(), false)
})

// ---------------------------------------------------------------- 图片 → PDF

test('★ 图片→PDF：产物是 %PDF-、页数 == 输入数、文件名 a.pdf', async () => {
  const srcDir = tmpDir('src-img')
  const outDir = tmpDir('out-img')
  const a = pngFile(srcDir, 'a.png', 'a')
  const b = writeSrc(srcDir, 'b.jpg', Buffer.concat([JPG_HEADER, Buffer.from('JPEG-B')]))
  const p = createProvider()

  const r = await p.convert([a, b], 'pdf', outDir)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.outputs.length, 1, '多图必须合并成一个 PDF')
  assert.equal(r.failures.length, 0)
  assert.equal(path.basename(r.outputs[0].output), 'a.pdf', '不能有 a.png.pdf 双扩展名')
  assert.equal(r.outputs[0].pages, 2)
  assert.deepEqual(r.outputs[0].sources, [a, b])

  const buf = fs.readFileSync(r.outputs[0].output)
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-')
  assert.match(buf.toString('latin1'), /pages=2/)
  assert.match(buf.toString('latin1'), /sizes=\[\[12,8\]/, '页面尺寸取图片原始像素')
})

test('★ 图片→PDF：bmp 明确失败，不静默转换（webp/gif 已支持，见 P2 专项）', async () => {
  const srcDir = tmpDir('src-bad')
  const outDir = tmpDir('out-bad')
  const p = createProvider()
  const bmp = writeSrc(srcDir, 'x.bmp', Buffer.from('BM\x00\x00\x00\x00'))
  const tif = writeSrc(srcDir, 'y.tif', Buffer.from('II*\x00'))

  const r = await p.convert([bmp, tif], 'pdf', outDir)
  assert.equal(r.ok, false)
  assert.equal(r.outputs.length, 0)
  assert.equal(r.failures.length, 2)
  assert.match(r.failures[0].error, /不支持/)
  assert.match(r.failures[1].error, /不支持/)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

test('★ 图片→PDF：单文件失败隔离（坏的进 failures，好的照常产出）', async () => {
  const srcDir = tmpDir('src-mix')
  const outDir = tmpDir('out-mix')
  const good1 = pngFile(srcDir, 'good1.png', 'ok1')
  const bad = pngFile(srcDir, 'bad.png', 'TRIGGER_FAIL')
  const good2 = pngFile(srcDir, 'good2.png', 'ok2')
  const p = createProvider({ pdfLib: fakePdfLib({ failOn: 'TRIGGER_FAIL' }) })

  const r = await p.convert([good1, bad, good2], 'pdf', outDir)
  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 1)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].source, bad)
  assert.match(r.failures[0].error, /embed 失败/)
  assert.equal(fs.readFileSync(r.outputs[0].output).toString('latin1').match(/pages=(\d+)/)[1], '2')
})

test('★ 图片→PDF：魔数不对的"假 PNG"明确失败，零产物', async () => {
  const srcDir = tmpDir('src-fakeimg')
  const outDir = tmpDir('out-fakeimg')
  const fake = writeSrc(srcDir, 'fake.png', Buffer.from('this is definitely not a png'))
  const r = await createProvider().convert([fake], 'pdf', outDir)
  assert.equal(r.ok, false)
  assert.match(r.failures[0].error, /魔数/)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

test('★ 图片→PDF：全部失败时 ok:false（零产物不说成功）', async () => {
  const srcDir = tmpDir('src-allfail')
  const outDir = tmpDir('out-allfail')
  const a = pngFile(srcDir, 'a.png', 'TRIGGER')
  const b = pngFile(srcDir, 'b.png', 'TRIGGER')
  const r = await createProvider({ pdfLib: fakePdfLib({ failOn: 'TRIGGER' }) })
    .convert([a, b], 'pdf', outDir)
  assert.equal(r.ok, false)
  assert.equal(r.reason, REASON.FAILED)
  assert.equal(r.outputs.length, 0)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

// ---------------------------------------------------------------- PDF → 图 / 文本

test('★ PDF→PNG：文件名、魔数、worker 调用链都对', async () => {
  const srcDir = tmpDir('src-pdf')
  const outDir = tmpDir('out-pdfpng')
  const src = pdfFile(srcDir, 'doc.pdf', 1)
  const host = fakeWorkerHost()
  const r = await createProvider({ workerHost: host }).convert([src], 'png', outDir)

  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(path.basename(r.outputs[0].output), 'doc.png', '不能有 doc.pdf.png')
  assert.deepEqual([...fs.readFileSync(r.outputs[0].output).slice(0, PNG_HEADER.length)], [...PNG_HEADER])
  assert.equal(host.calls.renderPdf.length, 1)
  assert.equal(host.calls.encode[0].mime, 'image/png')
  assert.equal(host.calls.extractPdfText.length, 0, '转图片不该抽文本')
})

test('★ PDF→JPG / WEBP：mime 映射正确', async () => {
  const dir = tmpDir('src-pdf2')
  const src = pdfFile(dir, 'a.pdf', 1)
  const host = fakeWorkerHost()
  const p = createProvider({ workerHost: host })

  const j = await p.convert([src], 'jpg', tmpDir('out-jpg'))
  assert.equal(j.ok, true)
  assert.equal(host.calls.encode[0].mime, 'image/jpeg')
  assert.deepEqual([...fs.readFileSync(j.outputs[0].output).slice(0, JPG_HEADER.length)], [...JPG_HEADER])

  const w = await p.convert([src], 'webp', tmpDir('out-webp'))
  assert.equal(w.ok, true)
  assert.equal(host.calls.encode[1].mime, 'image/webp')
  assert.deepEqual(
    [...fs.readFileSync(w.outputs[0].output).slice(0, WEBP_HEADER.length)],
    [...WEBP_HEADER]
  )
})

test('★ PDF→TXT：getTextContent 的文本写入 .txt', async () => {
  const dir = tmpDir('src-pdftxt')
  const src = pdfFile(dir, 'note.pdf', 1)
  const host = fakeWorkerHost()
  const r = await createProvider({ workerHost: host }).convert([src], 'txt', tmpDir('out-txt'))

  assert.equal(r.ok, true)
  assert.equal(path.basename(r.outputs[0].output), 'note.txt')
  assert.equal(fs.readFileSync(r.outputs[0].output, 'utf8'), '你好 PDF\n第二行')
  assert.equal(host.calls.renderPdf.length, 0, '抽文本不需要分配画布')
  assert.equal(host.calls.encode.length, 0)
})

test('★ PDF→图片/文本：多页必须带 pdf-multipage 产物警告（软性假成功防线）', async () => {
  const dir = tmpDir('src-multi')
  const src = pdfFile(dir, 'multi.pdf', 7)
  const host = fakeWorkerHost({
    renderPdf: () => ({ ok: true, width: 200, height: 100, canvasId: 'c1', numPages: 7 }),
    extractPdfText: () => ({ ok: true, text: '多页文本', numPages: 7 })
  })
  const p = createProvider({ workerHost: host })

  const png = await p.convert([src], 'png', tmpDir('out-multi-png'))
  assert.equal(png.ok, true)
  const codes = (png.outputs[0].warnings || []).map(w => w.code)
  assert.ok(codes.includes(WARN.PDF_MULTIPAGE), '必须提示只转了第 1 页：' + JSON.stringify(codes))
  assert.match(png.outputs[0].warnings.find(w => w.code === WARN.PDF_MULTIPAGE).message, /7 页/)

  const txt = await p.convert([src], 'txt', tmpDir('out-multi-txt'))
  assert.equal(txt.ok, true)
  assert.ok((txt.outputs[0].warnings || []).some(w => w.code === WARN.PDF_MULTIPAGE))
})

test('★ 非 PDF 魔数 → 明确失败、零产物、不碰 worker', async () => {
  const dir = tmpDir('src-notpdf')
  const outDir = tmpDir('out-notpdf')
  const bad = writeSrc(dir, 'fake.pdf', Buffer.from('just a text file'))
  const host = fakeWorkerHost()

  const p = createProvider({ workerHost: host })
  const r = await p.convert([bad], 'png', outDir)
  const t = await p.convert([bad], 'txt', outDir)

  assert.equal(r.ok, false)
  assert.equal(t.ok, false)
  assert.match(r.failures[0].error, /%PDF-|魔数/)
  assert.match(t.failures[0].error, /%PDF-|魔数/)
  assert.equal(host.calls.renderPdf.length, 0)
  assert.equal(host.calls.extractPdfText.length, 0)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

test('★ 反假成功：编码器回错格式（声称 png 实为 jpg）→ 不落盘', async () => {
  const dir = tmpDir('src-fakeenc')
  const outDir = tmpDir('out-fakeenc')
  const src = pdfFile(dir, 'a.pdf', 1)
  const host = fakeWorkerHost({
    // 明确谎报 type，同时字节也是 JPEG —— 两条防线都应拦住
    encode: () => ({ ok: true, type: 'image/png', bytes: JPG_HEADER })
  })
  const r = await createProvider({ workerHost: host }).convert([src], 'png', outDir)
  assert.equal(r.ok, false)
  assert.match(r.failures[0].error, /假文件|不是有效的/)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

test('★ 反假成功：AVI（只有 RIFF 头）不能冒充 WEBP', async () => {
  const avi = Buffer.concat([
    Buffer.from('RIFF', 'ascii'), Buffer.from([0x24, 0, 0, 0]),
    Buffer.from('AVI ', 'ascii'), Buffer.alloc(8)
  ])
  assert.equal(pdfProvider.looksLike(avi, 'webp'), false)
  assert.equal(pdfProvider.looksLike(WEBP_HEADER, 'webp'), true)
  assert.equal(pdfProvider.looksLike(PDF_HEADER, 'pdf'), true)
})

test('★ 加密 PDF → 明确失败并给出可读原因', async () => {
  const dir = tmpDir('src-enc')
  const outDir = tmpDir('out-enc')
  const src = pdfFile(dir, 'locked.pdf', 1)
  const host = fakeWorkerHost({
    renderPdf: () => ({ ok: false, encrypted: true, error: 'PasswordException' })
  })
  const r = await createProvider({ workerHost: host }).convert([src], 'png', outDir)
  assert.equal(r.ok, false)
  assert.match(r.failures[0].error, /加密|密码/)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

test('★ 无 worker 时：available() 为 false，convert 明确失败', async () => {
  const p = createProvider({ workerHost: null })
  assert.equal(await p.available(), false)
  const caps = await p.capabilities('pdf')
  assert.equal(caps.ok, false)
  assert.equal(caps.reason, REASON.NOT_INSTALLED)

  const dir = tmpDir('src-noworker')
  const src = pdfFile(dir, 'a.pdf', 1)
  const r = await p.convert([src], 'png', tmpDir('out-noworker'))
  assert.equal(r.ok, false)
  assert.equal(r.reason, REASON.NOT_INSTALLED)
})

test('★ 多页警告能穿过 service 到达 attachments[i].warnings', async () => {
  const src = pdfFile(tmpDir('src-svc'), 'multi.pdf', 3)
  const host = fakeWorkerHost({
    renderPdf: () => ({ ok: true, canvasId: 'c1', width: 10, height: 10, numPages: 3 })
  })
  const p = createProvider({ workerHost: host })
  const svc = createService({ userDataDir: tmpDir('ud-svc'), providers: [p] })
  const r = await svc.convert([src], 'png')
  assert.equal(r.ok, true)
  const ws = r.attachments[0].warnings || []
  assert.ok(ws.some(w => w.code === WARN.PDF_MULTIPAGE), JSON.stringify(ws))
})

// ---------------------------------------------------------------- 注册 / 路由

test('★ 默认 provider 列表：builtin-pdf 开箱即用，位置在图片之后、文本之前', async () => {
  const list = providersIndex.createDefaultProviders({
    workerHost: fakeWorkerHost(), withFilee: false, withPlugins: false
  })
  const ids = list.map(p => p.id)
  const i = ids.indexOf('builtin-pdf')
  assert.ok(i >= 0, '内置 PDF 必须在默认列表里：' + JSON.stringify(ids))
  assert.ok(ids.indexOf('builtin-image') < i, '图片优先')
  assert.ok(i < ids.indexOf('builtin-text-data'), '文本在后')

  const router = createRouter({ providers: list })
  const caps = await router.capabilities('pdf')
  assert.equal(caps.ok, true)
  for (const t of ['png', 'jpg', 'webp', 'txt']) {
    assert.ok(caps.targets.includes(t), 'pdf 能力应含 ' + t)
  }
  const capsPng = await router.capabilities('png')
  assert.ok(capsPng.targets.includes('pdf'), 'png 能力应含 pdf')
})

test('★ 不污染既有能力：png→jpg 仍由 builtin-image 提供', async () => {
  const list = providersIndex.createDefaultProviders({
    workerHost: fakeWorkerHost(), withFilee: false, withPlugins: false
  })
  const router = createRouter({ providers: list })
  const src = pngFile(tmpDir('src-route'), 'pic.png', 'route')
  const r = await router.convert([src], 'jpg', tmpDir('out-route'))
  assert.equal(r.ok, true)
  assert.equal(r.provider, 'builtin-image')
})

test('PDF provider：outputName 去掉源扩展名，不产生双扩展名', () => {
  assert.equal(pdfProvider.outputName('C:/a/b.pdf', 'png'), 'b.png')
  assert.equal(pdfProvider.outputName('C:/a/b.PDF', 'txt'), 'b.txt')
  assert.equal(pdfProvider.outputName('C:/a/c.png', 'pdf'), 'c.pdf')
})

test('PDF provider：空文件列表返回 usage 失败', async () => {
  const r = await createProvider().convert([], 'png', tmpDir('out-empty'))
  assert.equal(r.ok, false)
  assert.equal(r.reason, REASON.USAGE)
})

// ---------------------------------------------------------------- 全部页（allPages）

test('★ 全部页常量：WARN.PDF_PAGE_LIMIT / PDF_PAGE_FAILED 与 50 页上限', () => {
  assert.equal(WARN.PDF_PAGE_LIMIT, 'pdf-page-limit')
  assert.equal(WARN.PDF_PAGE_FAILED, 'pdf-page-failed')
  assert.equal(pdfProvider.MAX_ALL_PAGES, 50)
})

/** 按页码返回不同画布的假 host（numPages 由入参决定） */
function multiPageHost (numPages, extra = {}) {
  return fakeWorkerHost({
    renderPdf: (bytes, o) => {
      if (extra.failPage && o && o.pageNumber === extra.failPage) {
        return { ok: false, error: '模拟第 ' + o.pageNumber + ' 页渲染失败' }
      }
      return {
        ok: true,
        width: 200, height: 100,
        canvasId: 'page-' + (o && o.pageNumber),
        numPages
      }
    },
    extractPdfText: (bytes, o) => ({
      ok: true,
      text: ['第一页', '第二页', '第三页'].slice(0, Math.min(numPages, o && o.maxPages || numPages)).join('\n\n'),
      numPages,
      pagesConverted: Math.min(numPages, o && o.maxPages || numPages)
    })
  })
}

test('★ allPages=true → 每页一个 PNG，名字带 -1/-2/-3、pageNumber 正确', async () => {
  const dir = tmpDir('src-allpages')
  const outDir = tmpDir('out-allpages')
  const src = pdfFile(dir, 'book.pdf', 3)
  const host = multiPageHost(3)
  const r = await createProvider({ workerHost: host })
    .convert([src], 'png', outDir, { allPages: true })

  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.outputs.length, 3)
  assert.deepEqual(r.outputs.map(o => path.basename(o.output)),
    ['book-1.png', 'book-2.png', 'book-3.png'])
  assert.deepEqual(r.outputs.map(o => o.page), [1, 2, 3])
  assert.deepEqual(host.calls.renderPdf.map(c => c.o.pageNumber), [1, 2, 3])
  assert.deepEqual(host.calls.encode.map(c => c.canvasId),
    ['page-1', 'page-2', 'page-3'])
  // 每个产物都是真 PNG 魔数
  for (const o of r.outputs) {
    assert.deepEqual([...fs.readFileSync(o.output).slice(0, PNG_HEADER.length)], [...PNG_HEADER])
    // source 带页码伪路径 ⇒ service 的附件名能带页码
    assert.match(path.basename(o.source), /^book-[1-3]\.pdf$/)
    assert.ok(!(o.warnings || []).some(w => w.code === WARN.PDF_MULTIPAGE))
  }
})

test('★ allPages=true 的 TXT：extractPdfText 收到 {allPages:true,maxPages:50}', async () => {
  const dir = tmpDir('src-alltxt')
  const outDir = tmpDir('out-alltxt')
  const src = pdfFile(dir, 'book.pdf', 3)
  const host = multiPageHost(3)
  const r = await createProvider({ workerHost: host })
    .convert([src], 'txt', outDir, { allPages: true })

  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.outputs.length, 1, '全页文本仍是一个文件')
  assert.equal(path.basename(r.outputs[0].output), 'book.txt')
  assert.equal(host.calls.extractPdfText.length, 1)
  assert.deepEqual(host.calls.extractPdfText[0].o, { allPages: true, maxPages: 50 })
  assert.equal(fs.readFileSync(r.outputs[0].output, 'utf8'), '第一页\n\n第二页\n\n第三页')
  assert.ok(!(r.outputs[0].warnings || []).some(w => w.code === WARN.PDF_MULTIPAGE))
  assert.equal(host.calls.renderPdf.length, 0, '抽文本不需要画布')
})

test('★ 回归护栏：不传 opts / allPages:false 与改动前逐字节一致', async () => {
  const dir = tmpDir('src-default')
  const src = pdfFile(dir, 'book.pdf', 7)
  for (const opts of [undefined, {}, { allPages: false }]) {
    const host = multiPageHost(7)
    const outDir = tmpDir('out-default')
    const r = await createProvider({ workerHost: host })
      .convert([src], 'png', outDir, opts)
    assert.equal(r.ok, true)
    assert.equal(r.outputs.length, 1)
    assert.equal(path.basename(r.outputs[0].output), 'book.png')
    assert.equal(r.outputs[0].source, src, '单页模式的 source 必须是真实路径')
    assert.equal(r.outputs[0].page, undefined, '单页模式不写 page 字段')
    assert.deepEqual(host.calls.renderPdf[0].o, {}, '默认必须仍调用 renderPdf(bytes, {})')
    const codes = (r.outputs[0].warnings || []).map(w => w.code)
    assert.deepEqual(codes, [WARN.PDF_MULTIPAGE])
    assert.equal(r.warnings, undefined, '默认模式不能新增顶层 warnings 字段')
  }
})

test('★ 1 页 PDF + allPages=true：仍是 a.png，无页码后缀、无警告', async () => {
  const dir = tmpDir('src-onepage')
  const src = pdfFile(dir, 'solo.pdf', 1)
  const host = multiPageHost(1)
  const r = await createProvider({ workerHost: host })
    .convert([src], 'png', tmpDir('out-onepage'), { allPages: true })

  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 1)
  assert.equal(path.basename(r.outputs[0].output), 'solo.png')
  assert.equal(r.outputs[0].source, src)
  assert.equal(r.outputs[0].page, undefined)
  assert.equal(r.outputs[0].warnings, undefined)
  assert.equal(host.calls.renderPdf.length, 1, '单页只渲染一次')
})

test('★ 超过 50 页：只转前 50 页 + pdf-page-limit 警告（图片）', async () => {
  const dir = tmpDir('src-limit')
  const src = pdfFile(dir, 'huge.pdf', 51)
  const host = multiPageHost(51)
  const r = await createProvider({ workerHost: host })
    .convert([src], 'png', tmpDir('out-limit'), { allPages: true })

  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 50)
  assert.equal(path.basename(r.outputs[0].output), 'huge-1.png')
  assert.equal(path.basename(r.outputs[49].output), 'huge-50.png')
  assert.deepEqual(host.calls.renderPdf.map(c => c.o.pageNumber),
    Array.from({ length: 50 }, (_, i) => i + 1))
  assert.ok((r.warnings || []).some(w => w.code === WARN.PDF_PAGE_LIMIT))
  const w = r.outputs[0].warnings.find(x => x.code === WARN.PDF_PAGE_LIMIT)
  assert.match(w.message, /51 页/)
  assert.match(w.message, /50 页/)
  assert.ok(!(r.outputs[0].warnings || []).some(x => x.code === WARN.PDF_MULTIPAGE))
})

test('★ 超过 50 页：文本也截断 + pdf-page-limit（不再是 multipage）', async () => {
  const dir = tmpDir('src-limittxt')
  const src = pdfFile(dir, 'huge.pdf', 51)
  const host = {
    ...multiPageHost(51),
    async extractPdfText (bytes, o) {
      return {
        ok: true, text: '前 50 页文本', numPages: 51,
        pagesConverted: Math.min(51, o.maxPages || 51)
      }
    }
  }
  const r = await createProvider({ workerHost: host })
    .convert([src], 'txt', tmpDir('out-limittxt'), { allPages: true })

  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 1)
  assert.equal(fs.readFileSync(r.outputs[0].output, 'utf8'), '前 50 页文本')
  assert.ok((r.outputs[0].warnings || []).some(w => w.code === WARN.PDF_PAGE_LIMIT))
  assert.ok(!(r.outputs[0].warnings || []).some(w => w.code === WARN.PDF_MULTIPAGE))
})

test('★ 单页失败隔离：3 页里第 2 页失败，另 2 页仍产出', async () => {
  const dir = tmpDir('src-isolate')
  const src = pdfFile(dir, 'part.pdf', 3)
  const host = multiPageHost(3, { failPage: 2 })
  const r = await createProvider({ workerHost: host })
    .convert([src], 'png', tmpDir('out-isolate'), { allPages: true })

  assert.equal(r.ok, true)
  assert.deepEqual(r.outputs.map(o => path.basename(o.output)),
    ['part-1.png', 'part-3.png'])
  assert.deepEqual(r.outputs.map(o => o.page), [1, 3])
  assert.equal(r.failures.length, 1)
  assert.match(r.failures[0].error, /第 2 页/)
  // ★ 软性假成功：少了一页必须在顶层 warnings 说出来（能一路到 UI 状态栏）
  assert.ok(Array.isArray(r.warnings), '顶层必须带 warnings')
  const w = r.warnings.find(x => x.code === WARN.PDF_PAGE_FAILED)
  assert.ok(w, '必须有 pdf-page-failed：' + JSON.stringify(r.warnings))
  assert.match(w.message, /共 3 页/)
  assert.match(w.message, /成功转换 2 页，1 页失败/)
})

test('★ 部分失败软性假成功：顶层 r.warnings 确实含 pdf-page-failed', async () => {
  const dir = tmpDir('src-partial')
  const src = pdfFile(dir, 'part.pdf', 3)
  const host = multiPageHost(3, { failPage: 2 })
  const r = await createProvider({ workerHost: host })
    .convert([src], 'png', tmpDir('out-partial'), { allPages: true })

  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 2)
  assert.equal(r.failures.length, 1)
  assert.ok(Array.isArray(r.warnings))
  assert.ok(r.warnings.some(w => w.code === WARN.PDF_PAGE_FAILED),
    JSON.stringify(r.warnings))
  assert.match(r.warnings.find(w => w.code === WARN.PDF_PAGE_FAILED).message,
    /成功转换 2 页，1 页失败/)
  // ★ P5：只有该源**第一个成功页产物**挂这条警告（page 最小者）
  const withCode = r.outputs.filter(o => (o.warnings || []).some(w => w.code === WARN.PDF_PAGE_FAILED))
  assert.equal(withCode.length, 1, '只能挂一个产物，不能每个成功页都挂')
  assert.equal(withCode[0].page, 1, '必须挂在 page 最小的那个产物上')
  // ★ 必须是**同一条对象**（同一引用）：collectWarnings 去重键是 code|message
  const top = r.warnings.find(w => w.code === WARN.PDF_PAGE_FAILED)
  const prod = withCode[0].warnings.find(w => w.code === WARN.PDF_PAGE_FAILED)
  assert.equal(top, prod, '顶层与产物级必须是同一条 warning 对象（同一引用）')
  assert.equal(top.message, prod.message)
})

test('★ 全部页都失败：只有 ok:false，不再重复报 pdf-page-failed', async () => {
  const dir = tmpDir('src-allfail-pages')
  const src = pdfFile(dir, 'broken.pdf', 3)
  const host = fakeWorkerHost({
    renderPdf: () => ({ ok: false, error: '模拟每页都渲染失败' })
  })
  const r = await createProvider({ workerHost: host })
    .convert([src], 'png', tmpDir('out-allfail-pages'), { allPages: true })

  assert.equal(r.ok, false)
  assert.equal(r.outputs.length, 0)
  assert.equal(r.failures.length, 1, '第 1 页失败即整源失败，不再尝试后续页')
  assert.ok(!(r.warnings || []).some(w => w.code === WARN.PDF_PAGE_FAILED),
    '全失败走既有 ok:false 路径：' + JSON.stringify(r.warnings))
})

test('★ 多 PDF 批：部分失败警告按 src 维度统计，不误伤全成功的 PDF', async () => {
  const dir = tmpDir('src-multi-src')
  const good = pdfFile(dir, 'good.pdf', 2)
  const bad = pdfFile(dir, 'bad.pdf', 3)
  // pdfFile 把页数写进字节（pages=N），据此区分两个源
  const host = fakeWorkerHost({
    renderPdf: (bytes, o) => {
      const s = Buffer.from(bytes).toString('latin1')
      if (s.includes('pages=2')) {
        return { ok: true, canvasId: 'good-' + o.pageNumber, numPages: 2 }
      }
      if (o.pageNumber === 2) return { ok: false, error: '模拟第 2 页失败' }
      return { ok: true, canvasId: 'bad-' + o.pageNumber, numPages: 3 }
    }
  })
  const r = await createProvider({ workerHost: host })
    .convert([good, bad], 'png', tmpDir('out-multi-src'), { allPages: true })

  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 4, 'good 2 页 + bad 2 页')
  assert.equal(r.failures.length, 1)
  assert.equal(r.warnings.length, 1, '只有 bad 那一份要警告')
  const w = r.warnings[0]
  assert.equal(w.code, WARN.PDF_PAGE_FAILED)
  assert.match(w.message, /共 3 页，成功转换 2 页，1 页失败/)
})

test('★ 顶层 warnings 经 service → collectWarnings 到达 UI 汇总', async () => {
  const src = pdfFile(tmpDir('src-warn-chain'), 'part.pdf', 3)
  const host = multiPageHost(3, { failPage: 2 })
  const p = createProvider({ workerHost: host })
  const svc = createService({ userDataDir: tmpDir('ud-warn-chain'), providers: [p] })
  const r = await svc.convert([src], 'png', { allPages: true })

  assert.equal(r.ok, true)
  assert.ok((r.warnings || []).some(w => w.code === WARN.PDF_PAGE_FAILED),
    'service 必须把 provider 顶层 warnings 带出来：' + JSON.stringify(r.warnings))
  const uiWarnings = collectWarnings(r)
  assert.ok(uiWarnings.some(w => w.code === WARN.PDF_PAGE_FAILED),
    'collectWarnings 必须汇总到 UI 状态栏：' + JSON.stringify(uiWarnings))
})

test('★ 附件名带页码：service 链路把 o.source 的页码带进 attachments[i].name', async () => {
  const dir = tmpDir('src-att')
  const src = pdfFile(dir, 'report.pdf', 3)
  const host = multiPageHost(3)
  const p = createProvider({ workerHost: host })
  const svc = createService({ userDataDir: tmpDir('ud-att'), providers: [p] })
  const r = await svc.convert([src], 'png', { allPages: true })

  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.attachments.length, 3)
  const names = r.attachments.map(a => a.name)
  assert.match(names[0], /^report-1\.png$/)
  assert.match(names[1], /^report-2\.png$/)
  assert.match(names[2], /^report-3\.png$/)
  for (const a of r.attachments) assert.ok(fs.existsSync(a.path))
})
