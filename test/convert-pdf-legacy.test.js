'use strict'

/**
 * PDF provider 遗留项（P2 / P4 / P5）单测。
 *
 * 覆盖：
 *   P2（图片→PDF 支持 webp/gif）：魔数、动图判定、原子性口径（部分成功+警告）、
 *        零损路径（png/jpg 原始字节）、全部源不可用 ⇒ ok:false 零产物。
 *   P4（进度）：provider 侧 onProgress 调用序列（每页 1 次、编码完成时推、total 未知阶段）。
 *   P5（pdf-page-failed 产物级）：顶层 + 产物级同一条对象、去重后只 1 条、不误伤其他源。
 *
 * 这里用**假依赖**驱动（假 pdf-lib / 假 workerHost），不依赖 Electron。
 * 真机渲染与真 webp/gif 转码由 scripts/e2e-convert-pdf-legacy.js 覆盖。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { REASON, WARN } = require('../lib/convert/provider')
const pdfProvider = require('../lib/convert/providers/pdf')
const animated = require('../lib/convert/providers/animated-image')
const { collectWarnings } = require('../lib/convert/main-bridge')

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const PDF_HEADER = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-legacy-' + tag + '-'))
}

function writeSrc (dir, name, bytes) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, bytes)
  return p
}

// ---------------------------------------------------------------- 测试素材构造

/**
 * 构造一个最小但**结构合法**的 GIF。
 *
 * @param {number} frames 帧数
 * @param {number} w 宽
 * @param {number} h 高
 * @returns {Buffer}
 */
function makeGif (frames = 1, w = 2, h = 2) {
  const parts = []
  // 头 + 逻辑屏幕描述（2x2，全局颜色表 2 色）
  parts.push(Buffer.from('GIF89a', 'ascii'))
  parts.push(Buffer.from([w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]))
  parts.push(Buffer.from([0x80, 0x00, 0x00]))   // packed: 有全局颜色表(2色)
  parts.push(Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]))  // 2 色全局色表
  for (let i = 0; i < frames; i++) {
    // 图像描述符（0x2C）：左/上/宽/高 + packed(无局部色表)
    parts.push(Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00, w & 0xff, (w >> 8) & 0xff,
      h & 0xff, (h >> 8) & 0xff, 0x00]))
    parts.push(Buffer.from([0x02]))   // LZW 最小码长
    parts.push(Buffer.from([0x02, 0x44, 0x01, 0x00]))  // 图像数据子块
  }
  parts.push(Buffer.from([0x3b]))     // trailer
  return Buffer.concat(parts)
}

/**
 * 构造一个最小但**结构合法**的 WEBP（RIFF 容器）。
 *
 * @param {boolean} animated 是否含 ANIM chunk
 * @returns {Buffer}
 */
function makeWebp (animated) {
  const chunks = []
  const pushChunk = (fourcc, payload) => {
    const head = Buffer.from(fourcc, 'ascii')
    const len = Buffer.alloc(4)
    len.writeUInt32LE(payload.length, 0)
    chunks.push(head, len, payload)
    if (payload.length % 2) chunks.push(Buffer.from([0]))  // RIFF 奇数长度补齐
  }
  if (animated) {
    pushChunk('ANIM', Buffer.from([0x00, 0x00, 0x00, 0x00]))  // 动画控制块
    pushChunk('ANMF', Buffer.from([0x00, 0x00, 0x00, 0x00]))
  } else {
    pushChunk('VP8 ', Buffer.from([0x00, 0x00, 0x00, 0x00]))
  }
  const body = Buffer.concat(chunks)
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length + 4, 4)
  return Buffer.concat([riff, Buffer.from('WEBP', 'ascii'), body])
}

/**
 * 假 pdf-lib：产出带 %PDF- 魔数、页面数写在正文里的"可断言 PDF"。
 * 记录每次 embed 的字节长度，用来验证 png/jpg 走的是**原始字节**。
 */
function fakePdfLib (opts = {}) {
  class PDFDocument {
    static async create () { return new PDFDocument() }
    constructor () { this.pages = []; this.embeds = [] }
    async embedPng (bytes) { return this._embed('png', bytes) }
    async embedJpg (bytes) { return this._embed('jpg', bytes) }
    async _embed (kind, bytes) {
      const text = Buffer.from(bytes).toString('latin1')
      if (opts.failOn && text.includes(opts.failOn)) throw new Error('模拟 embed 失败')
      this.embeds.push({ kind, size: bytes.length })
      // ★ 记录最后一次 embed 的字节长度：用它断言"原始字节零损路径"与"转码路径"的差别
      fakePdfLib.lastEmbedSize = bytes.length
      fakePdfLib.lastEmbedKind = kind
      if (opts.embedSize) return { width: opts.embedSize, height: opts.embedSize }
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
 * 假 workerHost：
 *   - renderPdf / extractPdfText / encode：PDF→图/文本方向
 *   - transcodeImage：图片→PDF 的 webp/gif 转码通道
 */
function fakeWorkerHost (opts = {}) {
  const calls = { renderPdf: [], extractPdfText: [], encode: [], transcodeImage: [] }
  let seq = 0
  return {
    calls,
    async decode () { return { ok: true, canvasId: 'img-c', width: 1, height: 1 } },
    async encode (canvasId, mime) {
      calls.encode.push({ canvasId, mime })
      if (typeof opts.encode === 'function') return opts.encode(canvasId, mime)
      const bytes = mime === 'image/png' ? PNG_HEADER
        : mime === 'image/jpeg' ? JPG_HEADER : Buffer.from('RIFF____WEBP')
      return { ok: true, bytes, type: mime }
    },
    async transcodeImage (bytes, mime, o) {
      calls.transcodeImage.push({ bytes, mime, o })
      if (typeof opts.transcodeImage === 'function') return opts.transcodeImage(bytes, mime, o)
      // 默认：返回一段真 PNG 字节（魔数正确）+ 声称的类型
      return { ok: true, bytes: PNG_HEADER, type: mime, width: 12, height: 8 }
    },
    async renderPdf (bytes, o) {
      calls.renderPdf.push({ bytes, o })
      if (typeof opts.renderPdf === 'function') return opts.renderPdf(bytes, o)
      return { ok: true, width: 200, height: 100, canvasId: 'pdf-c' + (++seq), numPages: 1 }
    },
    async extractPdfText (bytes, o) {
      calls.extractPdfText.push({ bytes, o })
      if (typeof opts.extractPdfText === 'function') return opts.extractPdfText(bytes, o)
      return { ok: true, text: '你好 PDF', numPages: 1 }
    }
  }
}

function createProvider (opts = {}) {
  const base = {
    pdfLib: opts.pdfLib === undefined ? fakePdfLib() : opts.pdfLib,
    workerHost: opts.workerHost === undefined ? fakeWorkerHost(opts) : opts.workerHost
  }
  return pdfProvider.createPdfProvider(Object.assign(base, opts))
}

/** 多页 PDF 的假 host（可指定失败页） */
function multiPageHost (numPages, extra = {}) {
  return fakeWorkerHost({
    renderPdf: (bytes, o) => {
      if (extra.failPage && o && o.pageNumber === extra.failPage) {
        return { ok: false, error: '模拟第 ' + o.pageNumber + ' 页渲染失败' }
      }
      return {
        ok: true, width: 200, height: 100,
        canvasId: 'page-' + (o && o.pageNumber), numPages
      }
    },
    extractPdfText: (bytes, o) => ({
      ok: true, text: '全文', numPages,
      pagesConverted: Math.min(numPages, (o && o.maxPages) || numPages)
    })
  })
}

// ================================================================ P2：魔数

test('★ P2：魔数表含 webp / gif（webp 必须查 RIFF+WEBP，gif 认两个版本头）', () => {
  assert.ok(pdfProvider.MAGIC.webp, 'MAGIC 表必须有 webp')
  assert.ok(pdfProvider.MAGIC.gif, 'MAGIC 表必须有 gif')

  assert.equal(pdfProvider.looksLike(makeWebp(false), 'webp'), true)
  assert.equal(pdfProvider.looksLike(makeWebp(true), 'webp'), true)
  assert.equal(pdfProvider.looksLike(makeGif(1), 'gif'), true)
  // GIF87a 也要认
  const g87 = makeGif(1)
  g87.write('GIF87a', 0, 'ascii')
  assert.equal(pdfProvider.looksLike(g87, 'gif'), true)

  // 伪扩展名：PNG 字节改名成 .webp / .gif ⇒ 明确不认
  assert.equal(pdfProvider.looksLike(PNG_HEADER, 'webp'), false)
  assert.equal(pdfProvider.looksLike(PNG_HEADER, 'gif'), false)
  // AVI（只有 RIFF 头）不能冒充 WEBP
  const avi = Buffer.concat([
    Buffer.from('RIFF', 'ascii'), Buffer.from([0x24, 0, 0, 0]),
    Buffer.from('AVI ', 'ascii'), Buffer.alloc(8)
  ])
  assert.equal(pdfProvider.looksLike(avi, 'webp'), false)
  // 文本内容改名成 .gif ⇒ 不认
  assert.equal(pdfProvider.looksLike(Buffer.from('hello world'), 'gif'), false)
})

// ================================================================ P2：动图判定

test('★ P2：动图判定是纯函数（不依赖 Electron，可被 node:test 直接驱动）', () => {
  assert.equal(typeof animated.detectAnimation, 'function')
  assert.equal(typeof animated.countGifFrames, 'function')
  assert.equal(typeof animated.webpHasAnimChunk, 'function')
})

test('★ P2：多帧 gif 判为动图，单帧 gif 判为静态', () => {
  const two = animated.detectAnimation(makeGif(2))
  assert.equal(two.animated, true)
  assert.equal(two.frames, 2)
  assert.equal(two.type, 'gif')

  const one = animated.detectAnimation(makeGif(1))
  assert.equal(one.animated, false)
  assert.equal(one.frames, 1)
})

test('★ P2：webp 含 ANIM chunk 判为动图，不含则静态', () => {
  assert.equal(animated.detectAnimation(makeWebp(true)).animated, true)
  assert.equal(animated.detectAnimation(makeWebp(false)).animated, false)
})

test('★ P2：动图判定不看扩展名（2 帧 gif 改名成 .png 仍判为动图）', () => {
  const r = animated.detectAnimation(makeGif(2), 'png')
  assert.equal(r.animated, true, '改名不能骗过判定')
  assert.equal(r.type, 'gif')
})

test('★ P2：畸形文件解析不出块结构时按静态处理（宁可少报不误报）', () => {
  // GIF 头但块结构坏掉
  const broken = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(6)])
  const r = animated.detectAnimation(broken)
  assert.equal(r.animated, false)
  assert.match(r.reason, /unparsable|static/)
})

test('★ P2：png/jpg 永远判为静态', () => {
  assert.equal(animated.detectAnimation(PNG_HEADER).animated, false)
  assert.equal(animated.detectAnimation(JPG_HEADER).animated, false)
})

// ================================================================ P2：webp/gif 作为源

test('★ P2：webp 可作为图片→PDF 源（经转码通道），不进 failures', async () => {
  const dir = tmpDir('src-webp')
  const outDir = tmpDir('out-webp')
  const src = writeSrc(dir, 'shot.webp', makeWebp(false))
  const host = fakeWorkerHost()
  const r = await createProvider({ workerHost: host }).convert([src], 'pdf', outDir)

  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.failures.length, 0)
  assert.equal(r.outputs.length, 1)
  assert.equal(r.outputs[0].pages, 1)
  assert.equal(host.calls.transcodeImage.length, 1, '必须经 worker 转码')
  assert.equal(host.calls.transcodeImage[0].mime, 'image/png')
  const buf = fs.readFileSync(r.outputs[0].output)
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-')
  assert.match(buf.toString('latin1'), /pages=1/)
})

test('★ P2：gif 可作为图片→PDF 源', async () => {
  const dir = tmpDir('src-gif')
  const outDir = tmpDir('out-gif')
  const src = writeSrc(dir, 'anim.gif', makeGif(1))
  const r = await createProvider().convert([src], 'pdf', outDir)

  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.failures.length, 0)
  assert.equal(r.outputs[0].pages, 1)
  assert.match(fs.readFileSync(r.outputs[0].output).toString('latin1'), /pages=1/)
})

test('★ P2：伪扩展名（.webp 内容是 PNG）⇒ 明确失败、零产物', async () => {
  const dir = tmpDir('src-fakewebp')
  const outDir = tmpDir('out-fakewebp')
  const src = writeSrc(dir, 'fake.webp', PNG_HEADER)
  const r = await createProvider().convert([src], 'pdf', outDir)

  assert.equal(r.ok, false)
  assert.equal(r.outputs.length, 0)
  assert.match(r.failures[0].error, /魔数/)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

test('★ P2：伪扩展名（.gif 内容是文本）⇒ 明确失败、零产物', async () => {
  const dir = tmpDir('src-fakegif')
  const outDir = tmpDir('out-fakegif')
  const src = writeSrc(dir, 'fake.gif', Buffer.from('this is not a gif at all'))
  const r = await createProvider().convert([src], 'pdf', outDir)

  assert.equal(r.ok, false)
  assert.equal(r.outputs.length, 0)
  assert.match(r.failures[0].error, /魔数/)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

test('★ P2：转码产物魔数不对 ⇒ 明确失败（worker 谎报成功也不放过）', async () => {
  const dir = tmpDir('src-badtranscode')
  const outDir = tmpDir('out-badtranscode')
  const src = writeSrc(dir, 'x.webp', makeWebp(false))
  const host = fakeWorkerHost({
    // 谎报成功，但字节不是 PNG
    transcodeImage: () => ({ ok: true, bytes: JPG_HEADER, type: 'image/png' })
  })
  const r = await createProvider({ workerHost: host }).convert([src], 'pdf', outDir)

  assert.equal(r.ok, false)
  assert.equal(r.outputs.length, 0)
  assert.match(r.failures[0].error, /魔数/)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

test('★ P2：没有转码通道时 webp/gif 明确失败（不是静默跳过）', async () => {
  const dir = tmpDir('src-nochan')
  const outDir = tmpDir('out-nochan')
  const src = writeSrc(dir, 'x.webp', makeWebp(false))
  const host = fakeWorkerHost()
  delete host.transcodeImage
  const r = await createProvider({ workerHost: host }).convert([src], 'pdf', outDir)

  assert.equal(r.ok, false)
  assert.equal(r.outputs.length, 0)
  assert.match(r.failures[0].error, /工作器|转码/)
})

// ================================================================ P2：原子性口径

test('★ P2：混合批次（png+bmp+png）⇒ 部分成功 + pdf-image-skipped 警告（三数字齐全）', async () => {
  const dir = tmpDir('src-mixed')
  const outDir = tmpDir('out-mixed')
  const a = writeSrc(dir, 'a.png', Buffer.concat([PNG_HEADER, Buffer.from('A')]))
  const b = writeSrc(dir, 'b.bmp', Buffer.from('BM fake bmp'))
  const c = writeSrc(dir, 'c.png', Buffer.concat([PNG_HEADER, Buffer.from('C')]))
  const r = await createProvider().convert([a, b, c], 'pdf', outDir)

  assert.equal(r.ok, true, '部分成功仍应 ok:true')
  assert.equal(r.outputs.length, 1)
  assert.equal(r.failures.length, 1)
  assert.equal(r.outputs[0].pages, 2, '实际页数 == 写入张数')

  const w = (r.warnings || []).find(x => x.code === WARN.PDF_IMAGE_SKIPPED)
  assert.ok(w, '必须出现 pdf-image-skipped：' + JSON.stringify(r.warnings))
  assert.match(w.message, /共 3 张/)
  assert.match(w.message, /已写入 2 张/)
  assert.match(w.message, /跳过 1 张/)
  // A1：产物级也必须能读到同一 code
  assert.ok((r.outputs[0].warnings || []).some(x => x.code === WARN.PDF_IMAGE_SKIPPED))
})

test('★ P2：pdf-image-skipped 顶层与产物级是**同一条对象**（同一引用）', async () => {
  const dir = tmpDir('src-sameref')
  const outDir = tmpDir('out-sameref')
  const a = writeSrc(dir, 'a.png', Buffer.concat([PNG_HEADER, Buffer.from('A')]))
  const b = writeSrc(dir, 'b.bmp', Buffer.from('BM fake'))
  const r = await createProvider().convert([a, b], 'pdf', outDir)

  const top = r.warnings.find(x => x.code === WARN.PDF_IMAGE_SKIPPED)
  const prod = r.outputs[0].warnings.find(x => x.code === WARN.PDF_IMAGE_SKIPPED)
  assert.equal(top, prod, '必须是同一条 warning 对象（同一引用）')
  assert.equal(top.message, prod.message)
  // 跨进程后（结构化克隆）仍要逐字节一致
  assert.equal(JSON.parse(JSON.stringify(top)).message, JSON.parse(JSON.stringify(prod)).message)
})

test('★ P2：全部源不可用 ⇒ ok:false + 零产物', async () => {
  const dir = tmpDir('src-allbad')
  const outDir = tmpDir('out-allbad')
  const a = writeSrc(dir, 'a.bmp', Buffer.from('BM fake'))
  const b = writeSrc(dir, 'b.tiff', Buffer.from('II fake'))
  const r = await createProvider().convert([a, b], 'pdf', outDir)

  assert.equal(r.ok, false)
  assert.equal(r.reason, REASON.FAILED)
  assert.equal(r.outputs.length, 0)
  assert.equal(fs.readdirSync(outDir).length, 0, '输出目录必须零文件')
  assert.match(r.failures[0].error, /a\.bmp|b\.bmp|不支持/)
})

test('★ P2：零丢页 —— 产物页数与警告里的"已写入 N 张"严格相等', async () => {
  const dir = tmpDir('src-count')
  const outDir = tmpDir('out-count')
  const a = writeSrc(dir, 'a.png', Buffer.concat([PNG_HEADER, Buffer.from('A')]))
  const b = writeSrc(dir, 'b.bmp', Buffer.from('BM fake'))
  const c = writeSrc(dir, 'c.png', Buffer.concat([PNG_HEADER, Buffer.from('C')]))
  const d = writeSrc(dir, 'd.gif', makeGif(1))
  const r = await createProvider().convert([a, b, c, d], 'pdf', outDir)

  assert.equal(r.ok, true)
  const w = r.warnings.find(x => x.code === WARN.PDF_IMAGE_SKIPPED)
  const written = Number((w.message.match(/已写入 (\d+) 张/) || [])[1])
  const skipped = Number((w.message.match(/跳过 (\d+) 张/) || [])[1])
  const total = Number((w.message.match(/共 (\d+) 张/) || [])[1])
  assert.equal(total, 4)
  assert.equal(written + skipped, total)

  // 用产物内容独立复算页数（不信任返回值）
  const buf = fs.readFileSync(r.outputs[0].output).toString('latin1')
  const actual = Number((buf.match(/pages=(\d+)/) || [])[1])
  assert.equal(actual, written, '实际页数必须 == 警告里的"已写入"张数')
  assert.equal(actual, r.outputs[0].pages)
})

// ================================================================ P2：动图告警

test('★ P2：多帧 gif ⇒ 出现 pdf-animated-first-frame（文案含"首帧"）', async () => {
  const dir = tmpDir('src-anim')
  const outDir = tmpDir('out-anim')
  const src = writeSrc(dir, 'anim.gif', makeGif(3))
  const r = await createProvider().convert([src], 'pdf', outDir)

  assert.equal(r.ok, true)
  const w = (r.warnings || []).find(x => x.code === WARN.PDF_ANIMATED_FRAME)
  assert.ok(w, '必须出现 pdf-animated-first-frame：' + JSON.stringify(r.warnings))
  assert.match(w.message, /首帧|第一帧/)
})

test('★ P2：单帧 gif ⇒ 不出现动图警告', async () => {
  const dir = tmpDir('src-still')
  const outDir = tmpDir('out-still')
  const src = writeSrc(dir, 'still.gif', makeGif(1))
  const r = await createProvider().convert([src], 'pdf', outDir)

  assert.equal(r.ok, true)
  assert.ok(!(r.warnings || []).some(x => x.code === WARN.PDF_ANIMATED_FRAME),
    JSON.stringify(r.warnings))
})

test('★ P2：含 ANIM 的 webp ⇒ 出现动图警告；静态 webp 不出现', async () => {
  const dir = tmpDir('src-animwebp')
  const outDir = tmpDir('out-animwebp')
  const anim = writeSrc(dir, 'anim.webp', makeWebp(true))
  const still = writeSrc(dir, 'still.webp', makeWebp(false))

  const r1 = await createProvider().convert([anim], 'pdf', outDir)
  assert.ok((r1.warnings || []).some(x => x.code === WARN.PDF_ANIMATED_FRAME))

  const r2 = await createProvider().convert([still], 'pdf', tmpDir('out-stillwebp'))
  assert.ok(!(r2.warnings || []).some(x => x.code === WARN.PDF_ANIMATED_FRAME))
})

// ================================================================ F2：动图告警必须与产物一致

test('★ F2：动图源转码/嵌入失败（零产物）⇒ 不得出现 pdf-animated-first-frame', async () => {
  const dir = tmpDir('src-animfail')
  const outDir = tmpDir('out-animfail')
  const src = writeSrc(dir, 'anim.gif', makeGif(3))
  // ★ 让 worker 转码失败 ⇒ 该源一页都没进 PDF
  const host = fakeWorkerHost({
    transcodeImage: () => ({ ok: false, error: '模拟转码失败' })
  })
  const r = await createProvider({ workerHost: host }).convert([src], 'pdf', outDir)

  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.outputs.length, 0, '零产物')
  assert.ok(!(r.warnings || []).some(x => x.code === WARN.PDF_ANIMATED_FRAME),
    '★ 零产物时不得谎称"只转换了首帧"：' + JSON.stringify(r.warnings))
})

test('★ F2：动图源失败 + 另一个源成功 ⇒ 动图告警不得出现，但 pdf-image-skipped 必须在', async () => {
  const dir = tmpDir('src-animfail2')
  const outDir = tmpDir('out-animfail2')
  const anim = writeSrc(dir, 'anim.gif', makeGif(3))
  const png = writeSrc(dir, 'ok.png', Buffer.concat([PNG_HEADER, Buffer.from('OK')]))
  // 只让 gif 的转码失败（png 走原始字节 embed，不经转码通道）
  const host = fakeWorkerHost({
    transcodeImage: (bytes, mime, o) => {
      const srcMime = o && o.sourceMime
      if (srcMime === 'image/gif') return { ok: false, error: '模拟 gif 转码失败' }
      return { ok: true, bytes: PNG_HEADER, type: 'image/png', width: 12, height: 8 }
    }
  })
  const r = await createProvider({ workerHost: host }).convert([anim, png], 'pdf', outDir)

  assert.equal(r.ok, true, '部分成功仍应 ok:true')
  assert.equal(r.outputs.length, 1)
  assert.equal(r.outputs[0].pages, 1, '只有 png 写进去了')
  assert.ok(!(r.warnings || []).some(x => x.code === WARN.PDF_ANIMATED_FRAME),
    '★ 动图零产物 ⇒ 不得谎称"只转换了首帧"：' + JSON.stringify(r.warnings))
  // ★ 但"跳过了一张"必须说出来（顶层 + 产物级）
  const skip = (r.warnings || []).find(x => x.code === WARN.PDF_IMAGE_SKIPPED)
  assert.ok(skip, '顶层必须有 pdf-image-skipped：' + JSON.stringify(r.warnings))
  assert.match(skip.message, /共 2 张/)
  assert.match(skip.message, /已写入 1 张/)
  assert.match(skip.message, /跳过 1 张/)
  assert.ok((r.outputs[0].warnings || []).some(x => x.code === WARN.PDF_IMAGE_SKIPPED),
    '产物级也必须有 pdf-image-skipped')
})

test('★ F2：动图源成功写入 ⇒ 仍然必须有 pdf-animated-first-frame（不回归）', async () => {
  const dir = tmpDir('src-animok')
  const outDir = tmpDir('out-animok')
  const src = writeSrc(dir, 'anim.gif', makeGif(3))
  const r = await createProvider().convert([src], 'pdf', outDir)

  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 1)
  const w = (r.warnings || []).find(x => x.code === WARN.PDF_ANIMATED_FRAME)
  assert.ok(w, '真写入了首帧就必须告警：' + JSON.stringify(r.warnings))
  assert.match(w.message, /首帧|第一帧/)
})

// ================================================================ F3：page-limit 产物级副本

test('★ F3：第 1 页编码失败时，pdf-page-limit 仍能在产物级读到（挂在第一个成功页上）', async () => {
  const dir = tmpDir('src-limit-f3')
  const src = writeSrc(dir, 'huge.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=60\n%%EOF')
  ]))
  // ★ 第 1 页**编码**失败 ⇒ 没有第 1 页产物（写死 item.n===1 会整份丢失）
  const host = fakeWorkerHost({
    renderPdf: (bytes, o) => ({
      ok: true, width: 200, height: 100,
      canvasId: 'page-' + (o && o.pageNumber), numPages: 60
    }),
    encode: (canvasId, mime) => {
      if (canvasId === 'page-1') return { ok: false, error: '模拟第 1 页编码失败' }
      return { ok: true, bytes: PNG_HEADER, type: mime }
    }
  })
  const r = await createProvider({ workerHost: host })
    .convert([src], 'png', tmpDir('out-limit-f3'), { allPages: true })

  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300))
  assert.equal(r.outputs.length, 49, '60 页上限 50，第 1 页编码失败 ⇒ 49 个产物')
  assert.ok(!r.outputs.some(o => o.page === 1), '第 1 页不应有产物')
  // 顶层必须有
  const top = (r.warnings || []).find(w => w.code === WARN.PDF_PAGE_LIMIT)
  assert.ok(top, '顶层必须有 pdf-page-limit：' + JSON.stringify(r.warnings))
  // ★ 产物级也必须能读到（只读 attachments[i].warnings 的消费方不漏警）
  const prodHits = r.outputs.filter(o => (o.warnings || []).some(w => w.code === WARN.PDF_PAGE_LIMIT))
  assert.equal(prodHits.length, 1, '只能挂一个产物：' + JSON.stringify(r.outputs.map(o => o.page)))
  assert.equal(prodHits[0].page, 2, '必须挂在第一个成功页（page 最小者）上')
  // 同一条对象（同一引用）⇒ 跨进程克隆后文案逐字节一致
  const prod = prodHits[0].warnings.find(w => w.code === WARN.PDF_PAGE_LIMIT)
  assert.equal(top, prod, '必须是同一条 warning 对象（同一引用）')
  assert.equal(top.message, prod.message)
})

test('★ F3：第 1 页成功时，pdf-page-limit 仍挂在第 1 页产物上（不回归）', async () => {
  const dir = tmpDir('src-limit-f3b')
  const src = writeSrc(dir, 'huge.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=60\n%%EOF')
  ]))
  const host = multiPageHost(60)
  const r = await createProvider({ workerHost: host })
    .convert([src], 'png', tmpDir('out-limit-f3b'), { allPages: true })

  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 50)
  const prodHits = r.outputs.filter(o => (o.warnings || []).some(w => w.code === WARN.PDF_PAGE_LIMIT))
  assert.equal(prodHits.length, 1)
  assert.equal(prodHits[0].page, 1, '第 1 页成功 ⇒ 仍挂在第 1 页产物上')
})

// ================================================================ F4：静态 webp 的 reason 语义

test('★ F4：合法静态 webp ⇒ animated=false 且 reason 不是 unparsable', () => {
  const r = animated.detectAnimation(makeWebp(false))
  assert.equal(r.animated, false, '判定结果不变：仍是静态')
  assert.equal(r.type, 'webp')
  assert.ok(!/unparsable/.test(r.reason),
    '★ 合法静态 webp 不得被标成"解析不出来"：' + r.reason)
})

test('★ F4：结构被截断的 webp ⇒ 仍标 unparsable（真的解析不出来）', () => {
  // 声明了一个超长的 chunk ⇒ 扫描指针必然越过 buffer 末尾
  const buf = makeWebp(false)
  buf.writeUInt32LE(0xfffffff0, 12 + 4)
  const r = animated.detectAnimation(buf)
  assert.equal(r.animated, false)
  assert.equal(r.reason, 'webp-unparsable', '截断结构仍要如实标 unparsable')
})

test('★ F4：含 ANIM chunk 的 webp ⇒ animated=true 且 reason 不变', () => {
  const r = animated.detectAnimation(makeWebp(true))
  assert.equal(r.animated, true, '判定结果不变')
  assert.equal(r.reason, 'webp-anim-chunk')
})

// ================================================================ P2：零损路径

test('★ P2：png/jpg 走**原始字节**直接 embed（不经 canvas 重编码）', async () => {
  const dir = tmpDir('src-lossless')
  const outDir = tmpDir('out-lossless')
  const raw = Buffer.concat([PNG_HEADER, Buffer.from('RAW-BYTES-EXACTLY')])
  const src = writeSrc(dir, 'a.png', raw)

  const lib = fakePdfLib()
  const host = fakeWorkerHost()
  const r = await createProvider({ pdfLib: lib, workerHost: host }).convert([src], 'pdf', outDir)

  assert.equal(r.ok, true)
  // ★ 关键断言：embed 收到的字节长度 == 原始文件长度（未经转码）
  assert.equal(fakePdfLib.lastEmbedSize, raw.length)
  assert.equal(host.calls.transcodeImage.length, 0, 'png 不该走转码通道')
})

test('★ P2：webp 走转码通道（与 png 的零损路径不同）', async () => {
  const dir = tmpDir('src-transcode')
  const outDir = tmpDir('out-transcode')
  const src = writeSrc(dir, 'a.webp', makeWebp(false))
  const lib = fakePdfLib()
  const host = fakeWorkerHost()
  const r = await createProvider({ pdfLib: lib, workerHost: host }).convert([src], 'pdf', outDir)

  assert.equal(r.ok, true)
  assert.equal(host.calls.transcodeImage.length, 1)
  // embed 的字节是转码产物（PNG 头），不是原始 webp 字节
  assert.equal(fakePdfLib.lastEmbedSize, PNG_HEADER.length)
  assert.notEqual(fakePdfLib.lastEmbedSize, makeWebp(false).length)
})

// ================================================================ P2：能力与路由

test('★ P2：canHandle / capabilities 含 webp/gif → pdf，但仍不截胡 png→jpg', async () => {
  const p = createProvider()
  assert.equal(await p.canHandle('webp', 'pdf'), true)
  assert.equal(await p.canHandle('gif', 'pdf'), true)
  assert.equal(await p.canHandle('webp', null), true)
  assert.equal(await p.canHandle('gif', null), true)
  // 不截胡别的 provider 的活
  assert.equal(await p.canHandle('png', 'jpg'), false)
  assert.equal(await p.canHandle('webp', 'png'), false)
  assert.equal(await p.canHandle('pdf', 'csv'), false)

  const cw = await p.capabilities('webp')
  assert.equal(cw.ok, true)
  assert.deepEqual(cw.targets, ['pdf'])
  const cg = await p.capabilities('gif')
  assert.equal(cg.ok, true)
  assert.deepEqual(cg.targets, ['pdf'])
})

test('★ P2：没有转码通道时 canHandle("webp","pdf") 为 false（不假装能转）', async () => {
  const host = fakeWorkerHost()
  delete host.transcodeImage
  const p = createProvider({ workerHost: host })
  assert.equal(await p.canHandle('webp', 'pdf'), false)
  const caps = await p.capabilities('webp')
  assert.equal(caps.ok, false)
  assert.equal(caps.reason, REASON.NOT_INSTALLED)
})

// ================================================================ P4：进度

test('★ P4：全页转换每完成 1 页推 1 次进度，且在"编码完成"时推', async () => {
  const dir = tmpDir('src-prog')
  const outDir = tmpDir('out-prog')
  const src = writeSrc(dir, 'book.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=3\n%%EOF')
  ]))
  const host = multiPageHost(3)
  const events = []
  const r = await createProvider({ workerHost: host })
    .convert([src], 'png', outDir, {
      allPages: true,
      onProgress: (e) => {
        events.push(e)
        // ★ 编码完成时推 ⇒ 推的时候产物已经落盘。
        //   每次推送时，产物文件数必须 >= 已推送的页数（否则百分比领先于真实产出）。
        const files = fs.readdirSync(outDir).filter(f => f.endsWith('.png')).length
        assert.ok(files >= e.done,
          '推送时产物必须已落盘（files=' + files + ' done=' + e.done + '）')
      }
    })

  const pageEvents = events.filter(e => e.phase === 'pages')
  assert.equal(pageEvents.length, 3, '3 页必须推 3 次：' + JSON.stringify(events))
  assert.deepEqual(pageEvents.map(e => e.page), [1, 2, 3])
  assert.deepEqual(pageEvents.map(e => e.total), [3, 3, 3])
  assert.deepEqual(pageEvents.map(e => e.done), [1, 2, 3])
  assert.equal(pageEvents[0].source, src)
  assert.equal(r.outputs.length, 3)
})

test('★ P4：total 未知阶段用 phase=prepare（total=null），UI 才不会显示 0%', async () => {
  const dir = tmpDir('src-prep')
  const src = writeSrc(dir, 'book.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=2\n%%EOF')
  ]))
  const events = []
  await createProvider({ workerHost: multiPageHost(2) })
    .convert([src], 'png', tmpDir('out-prep'), {
      allPages: true,
      onProgress: (e) => events.push(e)
    })

  assert.ok(events.length >= 1)
  assert.equal(events[0].phase, 'prepare')
  assert.equal(events[0].total, null)
  assert.equal(events[0].page, null)
})

test('★ P4：进度 payload 字段齐全（source/page/total/done/failed/phase）', async () => {
  const dir = tmpDir('src-fields')
  const src = writeSrc(dir, 'book.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=2\n%%EOF')
  ]))
  const events = []
  await createProvider({ workerHost: multiPageHost(2) })
    .convert([src], 'png', tmpDir('out-fields'), {
      allPages: true,
      onProgress: (e) => events.push(e)
    })
  for (const e of events) {
    assert.ok('source' in e)
    assert.ok('page' in e)
    assert.ok('total' in e)
    assert.ok('done' in e)
    assert.ok('failed' in e)
    assert.ok('phase' in e)
  }
})

test('★ P4：失败页也推一次进度（failed 递增，UI 不会卡住不动）', async () => {
  const dir = tmpDir('src-progfail')
  const src = writeSrc(dir, 'book.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=3\n%%EOF')
  ]))
  const events = []
  await createProvider({ workerHost: multiPageHost(3, { failPage: 2 }) })
    .convert([src], 'png', tmpDir('out-progfail'), {
      allPages: true,
      onProgress: (e) => events.push(e)
    })

  const pageEvents = events.filter(e => e.phase === 'pages')
  assert.equal(pageEvents.length, 3, '含失败页共 3 次')
  const failEv = pageEvents.find(e => e.page === 2)
  assert.ok(failEv, '第 2 页（失败）也必须推一次')
  assert.equal(failEv.failed, 1)
  assert.equal(failEv.done, 1)
})

test('★ P4：TXT 全页不产生 phase=pages 的逐页事件', async () => {
  const dir = tmpDir('src-txtprog')
  const src = writeSrc(dir, 'book.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=3\n%%EOF')
  ]))
  const events = []
  await createProvider({ workerHost: multiPageHost(3) })
    .convert([src], 'txt', tmpDir('out-txtprog'), {
      allPages: true,
      onProgress: (e) => events.push(e)
    })

  assert.ok(!events.some(e => e.phase === 'pages'), 'TXT 不得有逐页事件')
  assert.ok(events.some(e => e.phase === 'text'), '应有 phase=text 事件')
})

test('★ P4：同一源内 done 单调不减（百分比不会倒退）', async () => {
  const dir = tmpDir('src-monotone')
  const src = writeSrc(dir, 'book.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=5\n%%EOF')
  ]))
  const events = []
  await createProvider({ workerHost: multiPageHost(5) })
    .convert([src], 'png', tmpDir('out-monotone'), {
      allPages: true,
      onProgress: (e) => events.push(e)
    })
  const dones = events.filter(e => e.phase === 'pages').map(e => e.done + e.failed)
  for (let i = 1; i < dones.length; i++) {
    assert.ok(dones[i] >= dones[i - 1], '进度必须单调不减：' + JSON.stringify(dones))
  }
})

test('★ P4：多源按源分别显示（进度事件带各自的 source）', async () => {
  const dir = tmpDir('src-multisrc')
  const a = writeSrc(dir, 'a.pdf', Buffer.concat([PDF_HEADER, Buffer.from('pages=2\n%%EOF')]))
  const b = writeSrc(dir, 'b.pdf', Buffer.concat([PDF_HEADER, Buffer.from('pages=2\n%%EOF')]))
  const events = []
  await createProvider({ workerHost: multiPageHost(2) })
    .convert([a, b], 'png', tmpDir('out-multisrc'), {
      allPages: true,
      onProgress: (e) => events.push(e)
    })
  const sources = new Set(events.filter(e => e.phase === 'pages').map(e => e.source))
  assert.equal(sources.size, 2, '两个源都要有进度事件')
})

test('★ P4：进度回调抛异常不影响转换结果', async () => {
  const dir = tmpDir('src-progthrow')
  const src = writeSrc(dir, 'book.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=1\n%%EOF')
  ]))
  const r = await createProvider({ workerHost: multiPageHost(1) })
    .convert([src], 'png', tmpDir('out-progthrow'), {
      allPages: true,
      onProgress: () => { throw new Error('故意炸') }
    })
  assert.equal(r.ok, true, '进度上报失败不能影响转换')
})

// ================================================================ P5：产物级警告

test('★ P5：pdf-page-failed 同时出现在顶层与该源第一个成功页产物上', async () => {
  const dir = tmpDir('src-p5')
  const src = writeSrc(dir, 'part.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=3\n%%EOF')
  ]))
  const r = await createProvider({ workerHost: multiPageHost(3, { failPage: 2 }) })
    .convert([src], 'png', tmpDir('out-p5'), { allPages: true })

  assert.equal(r.ok, true)
  const top = (r.warnings || []).find(w => w.code === WARN.PDF_PAGE_FAILED)
  assert.ok(top, '顶层必须有：' + JSON.stringify(r.warnings))
  const prod = (r.outputs[0].warnings || []).find(w => w.code === WARN.PDF_PAGE_FAILED)
  assert.ok(prod, '产物级必须有：' + JSON.stringify(r.outputs[0].warnings))
  assert.equal(top.message, prod.message, '文案必须逐字节一致')
  assert.equal(top, prod, '必须复用同一条对象（同一引用）')
})

test('★ P5：只挂第一个成功页产物（不挂每个成功页）', async () => {
  const dir = tmpDir('src-p5one')
  const src = writeSrc(dir, 'part.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=4\n%%EOF')
  ]))
  const r = await createProvider({ workerHost: multiPageHost(4, { failPage: 2 }) })
    .convert([src], 'png', tmpDir('out-p5one'), { allPages: true })

  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 3, '4 页里第 2 页失败 ⇒ 3 个产物')
  const hits = r.outputs.filter(o => (o.warnings || []).some(w => w.code === WARN.PDF_PAGE_FAILED))
  assert.equal(hits.length, 1, '只能挂一个产物：' + JSON.stringify(r.outputs.map(o => o.page)))
  assert.equal(hits[0].page, 1, '必须挂在 page 最小的那个产物上')
})

test('★ P5：collectWarnings 去重后该 code 恰好 1 条（UI 不刷屏）', async () => {
  const dir = tmpDir('src-p5dedup')
  const src = writeSrc(dir, 'part.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=3\n%%EOF')
  ]))
  const r = await createProvider({ workerHost: multiPageHost(3, { failPage: 2 }) })
    .convert([src], 'png', tmpDir('out-p5dedup'), { allPages: true })

  const collected = collectWarnings({
    warnings: r.warnings,
    attachments: r.outputs.map(o => ({ warnings: o.warnings }))
  })
  const hits = collected.filter(w => w.code === WARN.PDF_PAGE_FAILED)
  assert.equal(hits.length, 1, '去重后必须恰好 1 条：' + JSON.stringify(collected))
})

test('★ P5：不误伤其他源（good.pdf 的产物不得含 pdf-page-failed）', async () => {
  const dir = tmpDir('src-p5multi')
  const good = writeSrc(dir, 'good.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=2\n%%EOF')
  ]))
  const bad = writeSrc(dir, 'bad.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=3\n%%EOF')
  ]))
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
    .convert([good, bad], 'png', tmpDir('out-p5multi'), { allPages: true })

  assert.equal(r.ok, true)
  const goodOuts = r.outputs.filter(o => /good/.test(path.basename(o.output)))
  const badOuts = r.outputs.filter(o => /bad/.test(path.basename(o.output)))
  assert.ok(goodOuts.length >= 1 && badOuts.length >= 1)
  assert.ok(goodOuts.every(o => !(o.warnings || []).some(w => w.code === WARN.PDF_PAGE_FAILED)),
    'good 的产物不得被误伤')
  assert.ok(badOuts.some(o => (o.warnings || []).some(w => w.code === WARN.PDF_PAGE_FAILED)),
    'bad 的第一个成功产物必须含该 code')
})

test('★ P5：全部页全失败 ⇒ ok:false 且不重复报 pdf-page-failed', async () => {
  const dir = tmpDir('src-p5allfail')
  const src = writeSrc(dir, 'broken.pdf', Buffer.concat([
    PDF_HEADER, Buffer.from('pages=3\n%%EOF')
  ]))
  const host = fakeWorkerHost({
    renderPdf: () => ({ ok: false, error: '模拟每页都渲染失败' })
  })
  const r = await createProvider({ workerHost: host })
    .convert([src], 'png', tmpDir('out-p5allfail'), { allPages: true })

  assert.equal(r.ok, false)
  assert.equal(r.outputs.length, 0)
  assert.ok(!(r.warnings || []).some(w => w.code === WARN.PDF_PAGE_FAILED),
    JSON.stringify(r.warnings))
})

test('★ P5：不改 provider 契约结构（outputs[i].warnings 位置保持原样）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'convert', 'provider.js'), 'utf8')
  // 契约注释里的两个位置必须还在
  assert.match(src, /outputs: \[\{ source, output, warnings\?: \[\{code, message\}\] \}\]/)
  assert.match(src, /warnings\?: \[\{code, message\}\]/)
  // 不能新增源级字段（如 sourceWarnings）
  assert.ok(!/sourceWarnings/.test(src), '不得引入源级新契约字段')
})

// ================================================================ 警告码常量

test('★ P2/P5：新增警告码集中在 provider.js 的 WARN 表里', () => {
  assert.equal(WARN.PDF_IMAGE_SKIPPED, 'pdf-image-skipped')
  assert.equal(WARN.PDF_ANIMATED_FRAME, 'pdf-animated-first-frame')
  assert.equal(WARN.PDF_PAGE_FAILED, 'pdf-page-failed')
})
