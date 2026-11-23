'use strict'

/**
 * QA 独立反假成功探针（不属于工程师交付物，严过关自己写）。
 *
 * 与 e2e-convert-pdf.js 完全独立：自己生成输入、自己驱动真 Electron、
 * 自己在 Node 侧按字节核验产物，不采信 provider 自述、不复用工程师常量。
 *
 * 核验项：
 *  A1 PDF→PNG：读魔数 + 解 IHDR 尺寸 + inflate IDAT 逐像素确认"非全透明空壳"
 *  A2 图片→PDF：%PDF- 魔数 + Node 侧 pdf-lib load() 读页数 == 输入图片数
 *  A3 PDF→TXT：抽出的文本含本探针写入的 marker
 *  A4 四类负向（非PDF魔数/加密/损坏/空文件）逐个 find 输出目录确认 0 文件
 *  B5 2页带 pdf-multipage + 页数文案；1页对照群不得有该警告（防恒真）
 *  B6 service 把 warnings 透传到 attachments[i].warnings
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')
const { PDFDocument, StandardFonts } = require('pdf-lib')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SRC_DIR = path.join(ROOT, 'src')
const CDP_PORT = 9471

// 本探针专用 marker（与工程师的 E2E_PDF_MARKER_* 不同）
const MARK_ONE = 'QA_INDEP_MARK_ONE_9F3A71'
const MARK_TWO = 'QA_INDEP_MARK_TWO_7C1B42'
const MARK_THREE = 'QA_INDEP_MARK_THREE_2E8D05'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, timeout = 25000, label = '') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v } catch (_) {}
    await sleep(120)
  }
  throw new Error('waitFor timeout: ' + label)
}

// ---------------------------------------------------------------- PNG 生成/解析（Node 侧，零第三方）

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()
function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
/** 生成一张真 PNG（RGBA8，非全透明：画一条对角线 + 竖直色块） */
function makePng (w, h, fill) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(h * (1 + w * 4))
  const color = fill || [0x2a, 0x7d, 0xff, 0xff]
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4)
    raw[row] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 4
      const on = (x === y) || (x > w * 0.6 && x < w * 0.8)
      const px = on ? color : [0, 0, 0, 0]
      raw[i] = px[0]; raw[i + 1] = px[1]; raw[i + 2] = px[2]; raw[i + 3] = px[3]
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * 独立解 PNG：返回 {magicOk, width, height, colorType, bitDepth,
 *                    nonTransparent, totalPixels, distinctColors}
 * 真 inflate IDAT 并逐像素统计，确认不是全透明空壳。
 */
function decodePng (file) {
  const b = fs.readFileSync(file)
  const magicOk = b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (!magicOk) return { magicOk: false }
  const width = b.readUInt32BE(16)
  const height = b.readUInt32BE(20)
  const bitDepth = b[24]
  const colorType = b[25]
  // 收集 IDAT
  const idat = []
  let off = 8
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off)
    const type = b.slice(off + 4, off + 8).toString('ascii')
    if (type === 'IDAT') idat.push(b.slice(off + 8, off + 8 + len))
    off += 12 + len
    if (type === 'IEND') break
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (!channels || bitDepth !== 8) {
    return { magicOk: true, width, height, colorType, bitDepth, unsupported: true }
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  const paeth = (a, bb, c) => {
    const p = a + bb - c
    const pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : (pb <= pc ? bb : c)
  }
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const prev = dst - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]
      const a = i >= channels ? pixels[dst + i - channels] : 0
      const bb = y > 0 ? pixels[prev + i] : 0
      const c = (y > 0 && i >= channels) ? pixels[prev + i - channels] : 0
      let v
      if (f === 0) v = x
      else if (f === 1) v = x + a
      else if (f === 2) v = x + bb
      else if (f === 3) v = x + ((a + bb) >> 1)
      else if (f === 4) v = x + paeth(a, bb, c)
      else throw new Error('未知 PNG filter: ' + f)
      pixels[dst + i] = v & 0xff
    }
  }
  let nonTransparent = 0
  const colors = new Set()
  const total = width * height
  for (let p = 0; p < total; p++) {
    const i = p * channels
    const alpha = channels === 4 ? pixels[i + 3] : 255
    if (alpha > 0) nonTransparent++
    if (colors.size < 5000) colors.add(Array.from(pixels.slice(i, i + channels)).join(','))
  }
  return { magicOk: true, width, height, colorType, bitDepth, nonTransparent, totalPixels: total, distinctColors: colors.size }
}

/** 递归统计目录下的文件数（负向"零产物"必须 find 整个目录树） */
function countFilesRecursive (dir) {
  if (!fs.existsSync(dir)) return 0
  let n = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) n += countFilesRecursive(p)
    else n++
  }
  return n
}

// ---------------------------------------------------------------- 输入生成

async function makePdf (dest, markers) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  markers.forEach((m, idx) => {
    const page = doc.addPage([420, 220])
    page.drawText(m, { x: 18, y: 110 - idx * 4, size: 16, font })
  })
  fs.writeFileSync(dest, Buffer.from(await doc.save()))
}
async function pageCount (file) {
  if (!file || !fs.existsSync(file)) return -1
  const doc = await PDFDocument.load(fs.readFileSync(file))
  return doc.getPageCount()
}
function writeEncryptedPdf (dest) {
  const z = '00'.repeat(32)
  const text = '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Encrypt 3 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Filter /Standard /V 1 /R 2 /P -4 /O <' + z + '> /U <' + z + '> >>\nendobj\n' +
    '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n' +
    'trailer\n<< /Size 5 /Root 1 0 R /Encrypt 3 0 R /ID [<01020304><01020304>] >>\nstartxref\n0\n%%EOF\n'
  fs.writeFileSync(dest, Buffer.from(text, 'latin1'))
}

// ---------------------------------------------------------------- CDP

class CDP {
  constructor (url) { this.url = url; this.id = 0; this.pending = new Map() }
  connect () {
    this.ws = new WebSocket(this.url)
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true })
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + e.message)), { once: true })
      this.ws.addEventListener('message', (ev) => {
        let msg; try { msg = JSON.parse(ev.data) } catch (_) { return }
        if (!msg.id || !this.pending.has(msg.id)) return
        const { res, rej } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result)
      })
    })
  }
  send (method, params) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }
  async evaluate (expression) {
    let last = null
    for (let i = 0; i < 6; i++) {
      try {
        const r = await this.send('Runtime.evaluate', {
          expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true
        })
        if (r && r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 500))
        return r && r.result ? r.result.value : undefined
      } catch (e) {
        last = e
        if (!/Promise was collected/.test(e.message)) throw e
        await sleep(300)
      }
    }
    throw last
  }
  close () { try { this.ws && this.ws.close() } catch (_) {} }
}

const REQUIRE_EXPR = `(() => { return () => {
  const tries=[], g=globalThis
  if(g.process&&g.process.mainModule&&g.process.mainModule.require) tries.push(()=>g.process.mainModule.require)
  if(g.process&&typeof g.process.getBuiltinModule==='function') tries.push(()=>g.process.getBuiltinModule('module').createRequire(g.process.cwd()+'/'))
  if(typeof g.require==='function') tries.push(()=>g.require)
  for(const t of tries){try{const r=t();if(typeof r==='function')return r}catch(_){}}
  return null
}})()`
const QUIT_EXPR = `(() => { try { const req=(${REQUIRE_EXPR})(); if(!req) return {ok:false}; req('electron').app.quit(); return {ok:true} } catch(e){ return {ok:false,err:String(e)} } })()`

/** 在真 Electron 主进程里跑全部转换，返回产物路径与结构化结果 */
function buildExpr (o) {
  return `(async () => {
   try {
    const req = (${REQUIRE_EXPR})()
    if (!req) return { err: 'no require' }
    const fs = req('fs'), path = req('path'), os = req('os')
    const { BrowserWindow } = req('electron')
    const host = req('./lib/convert/worker-host').createWorkerHost({ BrowserWindow, srcDir: ${JSON.stringify(SRC_DIR)}, log: ()=>{} })
    const list = req('./lib/convert/providers').createDefaultProviders({
      workerHost: host, appDir: ${JSON.stringify(ROOT)}, withFilee: false, withPlugins: false, log: ()=>{}
    })
    const router = req('./lib/convert/router').createRouter({ providers: list })
    const service = req('./lib/convert/service').createService({ userDataDir: req('fs').mkdtempSync(path.join(os.tmpdir(),'qa-svc-')), providers: list })
    const first = (r) => (r && r.outputs && r.outputs[0] ? r.outputs[0].output : null)
    const out = {}

    // 2 页 PDF → PNG / TXT
    const o2 = fs.mkdtempSync(path.join(os.tmpdir(),'qa-2p-png-'))
    const r2 = await router.convert([${JSON.stringify(o.pdf2)}], 'png', o2)
    out.pdf2png = { ok:r2.ok, provider:r2.provider, file:first(r2),
      warnings:(r2.outputs[0]&&r2.outputs[0].warnings)||[], error:r2.error }
    const o2t = fs.mkdtempSync(path.join(os.tmpdir(),'qa-2p-txt-'))
    const r2t = await router.convert([${JSON.stringify(o.pdf2)}], 'txt', o2t)
    out.pdf2txt = { ok:r2t.ok, file:first(r2t),
      text: first(r2t) ? fs.readFileSync(first(r2t),'utf8') : '',
      warnings:(r2t.outputs[0]&&r2t.outputs[0].warnings)||[], error:r2t.error }

    // 1 页 PDF → PNG（对照组：不该有 multipage 警告）
    const o1 = fs.mkdtempSync(path.join(os.tmpdir(),'qa-1p-png-'))
    const r1 = await router.convert([${JSON.stringify(o.pdf1)}], 'png', o1)
    out.pdf1png = { ok:r1.ok, file:first(r1), warnings:(r1.outputs[0]&&r1.outputs[0].warnings)||[], error:r1.error }

    // service 透传 warnings
    const rs = await service.convert([${JSON.stringify(o.pdf2)}], 'png')
    out.serviceWarnings = (rs.attachments && rs.attachments[0] && rs.attachments[0].warnings) || []

    // 3 张真 PNG → 一个 PDF
    const oi = fs.mkdtempSync(path.join(os.tmpdir(),'qa-img-pdf-'))
    const ri = await router.convert([${JSON.stringify(o.img1)},${JSON.stringify(o.img2)},${JSON.stringify(o.img3)}], 'pdf', oi)
    out.img2pdf = { ok:ri.ok, provider:ri.provider, files:(ri.outputs||[]).map(x=>x.output),
      sources:(ri.outputs[0]&&ri.outputs[0].sources)||[], error:ri.error, failures:ri.failures }

    // 四类负向：每个都用全新目录，返回目录路径让 Node 侧递归 find
    const neg = {}
    for (const [k, src] of Object.entries({
      nonpdf:${JSON.stringify(o.badNonPdf)}, encrypted:${JSON.stringify(o.badEnc)},
      corrupt:${JSON.stringify(o.badCorrupt)}, empty:${JSON.stringify(o.badEmpty)}
    })) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(),'qa-neg-'+k+'-'))
      const r = await router.convert([src], 'png', d)
      neg[k] = { ok:r.ok, reason:r.reason, error:r.error, outDir:d,
        failures:(r.failures||[]).map(f=>f.error) }
    }
    out.neg = neg

    host.dispose()
    return out
   } catch (e) { return { err: String((e && e.stack) || e) } }
  })()`
}

const checks = []
function check (name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail && !ok ? '  → ' + detail : ''))
}

async function main () {
  console.log('QA 独立反假成功探针（真 Electron + 字节级核验）\n')
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-indep-src-'))
  const pdf1 = path.join(src, 'one.pdf')
  const pdf2 = path.join(src, 'two.pdf')
  await makePdf(pdf1, [MARK_ONE])
  await makePdf(pdf2, [MARK_ONE, MARK_TWO])
  const img1 = path.join(src, 'i1.png')
  const img2 = path.join(src, 'i2.png')
  const img3 = path.join(src, 'i3.png')
  fs.writeFileSync(img1, makePng(120, 90))
  fs.writeFileSync(img2, makePng(64, 48, [0xff, 0x33, 0x11, 0xff]))
  fs.writeFileSync(img3, makePng(200, 70, [0x11, 0xee, 0x55, 0xff]))
  const badNonPdf = path.join(src, 'notpdf.pdf')
  fs.writeFileSync(badNonPdf, 'I am definitely not a PDF, despite my extension.')
  const badEnc = path.join(src, 'locked.pdf')
  writeEncryptedPdf(badEnc)
  const badCorrupt = path.join(src, 'corrupt.pdf')
  fs.writeFileSync(badCorrupt, Buffer.from('%PDF-1.7\nthis body is garbage and has no valid xref or objects\n', 'latin1'))
  const badEmpty = path.join(src, 'empty.pdf')
  fs.writeFileSync(badEmpty, Buffer.alloc(0))

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-indep-ud-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'), JSON.stringify({ version: 1, notes: [], settings: {} }))
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.STICKY_FILEE = 'C:\\definitely\\not\\installed\\filee.exe'

  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData, '--remote-debugging-port=' + CDP_PORT,
    '--inspect=0', '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })

  let cdp = null
  try {
    const inspectorUrl = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 25000, 'inspector')
    await waitFor(async () => log.includes('[boot] 托盘就绪') ? true : null, 25000, '启动完成')
    await sleep(1200)
    cdp = new CDP(inspectorUrl)
    await cdp.connect()
    const r = await cdp.evaluate(buildExpr({ pdf1, pdf2, img1, img2, img3, badNonPdf, badEnc, badCorrupt, badEmpty }))
    assert.ok(r && !r.err, '求值失败: ' + JSON.stringify(r))

    // ---- A1：PDF→PNG 字节级 ----
    const png = r.pdf2png
    check('A1 PDF→PNG ok', png.ok, JSON.stringify(png.error))
    if (png.file && fs.existsSync(png.file)) {
      const d = decodePng(png.file)
      check('A1 PNG 魔数 89 50 4E 47', d.magicOk)
      check('A1 IHDR 尺寸 420×220（等于 PDF 页面）', d.width === 420 && d.height === 220, JSON.stringify(d))
      check('A1 解 IDAT 成功（colorType=' + d.colorType + ', bitDepth=' + d.bitDepth + '）', !d.unsupported, JSON.stringify(d))
      check('A1 非全透明空壳：不透明像素 ' + (d.nonTransparent || 0) + '/' + (d.totalPixels || 0), d.nonTransparent > 0, JSON.stringify(d))
      check('A1 有真实绘制内容（distinctColors=' + d.distinctColors + '）', d.distinctColors > 1, JSON.stringify(d))
    } else check('A1 PNG 产物存在', false, JSON.stringify(png))

    // ---- A3：PDF→TXT marker ----
    check('A3 PDF→TXT ok', r.pdf2txt.ok, JSON.stringify(r.pdf2txt.error))
    check('A3 文本含第 1 页 marker ' + MARK_ONE, String(r.pdf2txt.text || '').includes(MARK_ONE), String(r.pdf2txt.text).slice(0, 120))
    check('A3 文本不含第 2 页 marker（只读第 1 页）', !String(r.pdf2txt.text || '').includes(MARK_TWO))

    // ---- A2：图片→PDF 独立页数 ----
    const ip = r.img2pdf
    check('A2 图片→PDF ok', ip.ok, JSON.stringify(ip.error))
    if (ip.files && ip.files.length) {
      const head = fs.readFileSync(ip.files[0]).slice(0, 5).toString('latin1')
      check('A2 产物头 %PDF-', head === '%PDF-', head)
      const pages = await pageCount(ip.files[0])
      check('A2 页数 == 输入图片数 3（pdf-lib 独立 load）', pages === 3, 'pages=' + pages)
      check('A2 只产出 1 个 PDF（多图合并）', ip.files.length === 1, 'files=' + ip.files.length)
    } else check('A2 PDF 产物存在', false, JSON.stringify(ip))

    // ---- B5：多页警告 + 单页对照（防恒真）----
    const codes2 = (png.warnings || []).map(w => w.code)
    const msg2 = (png.warnings || []).map(w => w.message).join(' ')
    check('B5 2页 PNG 带 pdf-multipage', codes2.includes('pdf-multipage'), JSON.stringify(png.warnings))
    check('B5 警告文案含总页数 2', /2\s*页/.test(msg2), msg2)
    const codesTxt = (r.pdf2txt.warnings || []).map(w => w.code)
    check('B5 2页 TXT 也带 pdf-multipage', codesTxt.includes('pdf-multipage'), JSON.stringify(r.pdf2txt.warnings))
    const codes1 = (r.pdf1png.warnings || []).map(w => w.code)
    check('B5 1页 PNG 对照组【不得】有 pdf-multipage（防恒真）', !codes1.includes('pdf-multipage'), JSON.stringify(r.pdf1png.warnings))
    check('B5 service 透传 warnings 到 attachments[0].warnings',
      (r.serviceWarnings || []).some(w => w.code === 'pdf-multipage'), JSON.stringify(r.serviceWarnings))

    // ---- A4：四类负向，递归 find 输出目录 ----
    const negCases = [
      ['nonpdf', '非 PDF 魔数'], ['encrypted', '加密 PDF'],
      ['corrupt', '损坏 PDF（有魔数无有效对象）'], ['empty', '空文件']
    ]
    for (const [k, label] of negCases) {
      const n = r.neg && r.neg[k]
      check('A4 ' + label + ' ok:false', n && n.ok === false, JSON.stringify(n))
      const cnt = n ? countFilesRecursive(n.outDir) : -1
      check('A4 ' + label + ' 递归 find 输出目录 == 0 文件（实测 ' + cnt + '）', cnt === 0, 'dir=' + (n && n.outDir) + ' count=' + cnt)
    }

    const quit = await cdp.evaluate(QUIT_EXPR)
    assert.ok(quit && quit.ok, 'quit 失败: ' + JSON.stringify(quit))
    cdp.close()
    await waitFor(async () => child.exitCode !== null || child.signalCode ? true : null, 15000, '进程退出').catch(() => {})
  } catch (e) {
    console.error('FATAL: ' + (e.stack || e))
    console.error('日志尾部:\n' + log.split('\n').slice(-25).join('\n'))
    if (cdp) cdp.close()
    if (child.exitCode === null) { try { child.kill() } catch (_) {} }
    process.exit(2)
  }

  const pass = checks.filter(c => c.ok).length
  console.log('\n========== QA 独立探针结果：' + pass + '/' + checks.length + ' ==========')
  const failed = checks.filter(c => !c.ok)
  if (failed.length) {
    console.log('失败项：')
    failed.forEach(c => console.log('  ✗ ' + c.name + '  ' + (c.detail || '')))
  }
  process.exit(failed.length ? 1 : 0)
}
main()
