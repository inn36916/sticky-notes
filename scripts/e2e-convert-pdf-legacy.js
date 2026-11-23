'use strict'

/**
 * PDF provider 遗留项（P2 / P4 / P5）端到端验证
 * （npm run test:e2e:convert:pdf:legacy）。
 *
 * 跑的是**完整真链路**：真 Electron + 真格式选择窗（preload）+ ipcMain
 * 'convert:run' + main-bridge + service + router + provider + 真隐藏 worker 窗口
 * + 真 pdfjs + 真 canvas + 真 pdf-lib。
 *
 * 覆盖：
 *   P2（R-P2-2/3/4/5/8、Q4、A1~A6、A21）：
 *     1. 真实 webp（Chromium canvas.toBlob('image/webp') 真编码）→ PDF：
 *        %PDF- 魔数 + pdf-lib 独立读出 1 页 + 页面尺寸 == 原图像素；
 *     2. 真实 2 帧 gif → PDF：成功 + pdf-animated-first-frame 警告；
 *     3. 混合批次（png + bmp + png）→ 部分成功 + pdf-image-skipped
 *        （文案含"共 3 张 / 2 张 / 1 张"）+ pdf-lib 独立读出页数 == 2；
 *     4. 伪扩展名（PNG 字节改名 .webp）→ 明确失败、零产物；
 *     5. 全部源不可用 → ok:false、零产物。
 *   P4（R-P4-1/2/3/4/5/6/7/8/10/11/12/13/14/15/16/18、A16~A19）：
 *     6. 进度事件真机推送（≥页数、page 序列、total 未知阶段）；
 *     7. UI 进度条 DOM（填充宽度 / 百分比 / "第 N/M 页"三者齐备）；
 *     8. 100% → 终态顺序（进度条先隐藏，再写状态栏文案）；
 *     9. 重复点击不并发（真实点两张卡 ⇒ 只有一次转换产物）；
 *     10. 主进程并发闸（同 sender 再发一次 ⇒ 明确失败"已有转换在进行中"）；
 *     11. TXT 全页无逐页进度、无百分比残留；
 *     12. 多源按源分别显示进度。
 *   P5（R-P5-1/2/3/5/6、A9~A12、A15）：pdf-page-failed 顶层 + 产物级可读且去重后仅 1 条。
 *
 * ★ 判断一律解析输出，不看 exitCode：本机 safe-delete 守卫会让退出码失真。
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
const CDP_PORT = 9477

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitFor (fn, timeout = 30000, label = '') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch (_) {}
    await sleep(120)
  }
  throw new Error('waitFor timeout: ' + label)
}

class CDP {
  constructor (url) { this.url = url; this.id = 0; this.pending = new Map() }

  connect () {
    this.ws = new WebSocket(this.url)
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true })
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + e.message)), { once: true })
      this.ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch (_) { return }
        if (!msg.id || !this.pending.has(msg.id)) return
        const { res, rej } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) rej(new Error(JSON.stringify(msg.error)))
        else res(msg.result)
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

  /**
   * 求值（带有限重试）。
   * ★ CDP 的 Runtime.evaluate 偶尔报 `-32000 "Promise was collected"` —— V8 抖动，
   *   与被测代码无关；只对该错误重试，其它错误立刻抛出。
   */
  async evaluate (expression) {
    let last = null
    for (let i = 0; i < 6; i++) {
      try {
        const r = await this.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          allowUnsafeEvalBlockedByCSP: true
        })
        if (r && r.exceptionDetails) {
          throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
        }
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

const REQUIRE_EXPR = `(() => {
  return () => {
    const tries = []
    const g = globalThis
    if (g.process && g.process.mainModule && g.process.mainModule.require) {
      tries.push(() => g.process.mainModule.require)
    }
    if (g.process && typeof g.process.getBuiltinModule === 'function') {
      tries.push(() => g.process.getBuiltinModule('module').createRequire(g.process.cwd() + '/'))
    }
    if (typeof g.require === 'function') tries.push(() => g.require)
    for (const t of tries) {
      try { const r = t(); if (typeof r === 'function') return r } catch (_) {}
    }
    return null
  }
})()`

const QUIT_EXPR = `(() => {
  try {
    const getReq = ${REQUIRE_EXPR}
    const req = getReq()
    if (!req) return { ok: false, err: 'no require' }
    req('electron').app.quit()
    return { ok: true }
  } catch (err) {
    return { ok: false, err: String(err && err.message || err) }
  }
})()`

// ---------------------------------------------------------------- 素材构造

/** CRC32（PNG chunk 用） */
function crc32 (buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      t[n] = c
    }
    return t
  })())
  let crc = -1
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

function pngChunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * 构造一个**真实可解码**的 PNG（8bit RGB，无 alpha）。
 * @param {number} w
 * @param {number} h
 * @param {number[]} rgb
 * @returns {Buffer}
 */
function makePng (w, h, rgb) {
  const raw = []
  for (let y = 0; y < h; y++) {
    raw.push(Buffer.from([0x00]))   // filter type 0
    for (let x = 0; x < w; x++) {
      raw.push(Buffer.from([rgb[0], rgb[1], rgb[2]]))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 2      // color type 2 = truecolor
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(raw))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * GIF 的 LZW 编码。
 *
 * ★ 采用"每个像素前都发一次 CLEAR"的保守写法：字典永远为空 ⇒
 *   码宽恒为 3 位，不存在码宽增长时机的歧义（GIF 的老坑）。
 *   代价是文件略大，但换来 100% 可被 Chromium 解码。
 *
 * @param {number[]} indices 像素索引（0..1）
 * @returns {Buffer}
 */
function lzwGif (indices) {
  const CLEAR = 4
  const EOI = 5
  const CODE_BITS = 3
  const out = []
  let acc = 0
  let bits = 0
  const emit = (code) => {
    acc |= (code << bits)
    bits += CODE_BITS
    while (bits >= 8) {
      out.push(acc & 0xff)
      acc >>>= 8
      bits -= 8
    }
  }
  emit(CLEAR)
  for (const v of indices) {
    emit(CLEAR)
    emit(v & 0x03)
  }
  emit(EOI)
  if (bits > 0) out.push(acc & 0xff)
  return Buffer.from(out)
}

/**
 * 构造一个**真实可解码**的 GIF（可多帧 ⇒ 动图）。
 *
 * @param {number} frames 帧数
 * @param {number} w
 * @param {number} h
 * @returns {Buffer}
 */
function makeGif (frames = 1, w = 12, h = 10) {
  const parts = []
  parts.push(Buffer.from('GIF89a', 'ascii'))
  // 逻辑屏幕描述：w/h + packed(有全局色表, 2 色) + bg + 宽高比
  parts.push(Buffer.from([w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]))
  parts.push(Buffer.from([0x80, 0x00, 0x00]))
  // 全局颜色表：2 色（黑 / 白）
  parts.push(Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]))
  for (let f = 0; f < frames; f++) {
    // 图像描述符 0x2C：左/上/宽/高 + packed(无局部色表、不交错)
    parts.push(Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00, w & 0xff, (w >> 8) & 0xff,
      h & 0xff, (h >> 8) & 0xff, 0x00]))
    parts.push(Buffer.from([0x02]))   // LZW 最小码长
    const data = lzwGif(new Array(w * h).fill(f % 2))
    // 图像数据子块（每块 ≤255 字节，以 0 结束）
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255)
      parts.push(Buffer.from([chunk.length]), chunk)
    }
    parts.push(Buffer.from([0x00]))
  }
  parts.push(Buffer.from([0x3b]))   // trailer
  return Buffer.concat(parts)
}

/** 造一个带 marker 的多页 PDF */
async function writePdf (dest, markers, size = 8) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const marker of markers) {
    const page = doc.addPage([400, 200])
    page.drawText(marker, { x: 20, y: 100, size, font })
  }
  fs.writeFileSync(dest, Buffer.from(await doc.save()))
}

// ---------------------------------------------------------------- 主进程表达式

/**
 * 主进程侧执行：跑完全部场景并把证据回传。
 */
function buildExpr (opts) {
  return `(async () => {
   let stage = 'init'
   try {
    const getReq = ${REQUIRE_EXPR}
    const req = getReq()
    if (!req) return { ok: false, err: 'no require' }
    const path = req('path')
    const fs = req('fs')
    const os = req('os')
    const { BrowserWindow } = req('electron')

    // ★ 在 worker 窗口创建前挂监听：加载期的 pdfjs/CSP 问题也要抓到
    const consoleMsgs = []
    req('electron').app.on('web-contents-created', (_e, wc) => {
      try {
        wc.on('console-message', (_ev, level, message) => {
          consoleMsgs.push({ level, message: String(message), url: wc.getURL() || '' })
        })
      } catch (_) {}
    })

    const srcDir = ${JSON.stringify(SRC_DIR)}
    // ★ 路径常量只注入一次（外层模板插值），再在**运行时**用 JSON.stringify 传给渲染进程。
    //   不能在嵌套模板字符串里插路径 —— 那会被求值两次，反斜杠转义被吃掉
    //   （踩过：'C:\\Users\\...' 变成 'C:Users...'）。
    const P = ${JSON.stringify(opts)}
    const uiWin = new BrowserWindow({
      show: false, width: 900, height: 700,
      webPreferences: {
        preload: path.join(srcDir, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false
      }
    })
    await new Promise((resolve, reject) => {
      uiWin.webContents.once('did-finish-load', resolve)
      uiWin.webContents.once('did-fail-load', (_e, c, d) => reject(new Error('UI 加载失败：' + d)))
      uiWin.loadFile(path.join(srcDir, 'convert.html'))
    })
    // 转换成功后 convert.js 会 window.close()；测试要复用窗口，先把它换成空实现
    await uiWin.webContents.executeJavaScript('window.close = () => {}; 1', true)
    // 把路径表放进渲染进程的全局（运行时注入 ⇒ 转义安全）
    await uiWin.webContents.executeJavaScript('window.__P = ' + JSON.stringify(P), true)

    // ★ 订阅进度事件 + 装 MutationObserver（记录"进度条隐藏"与"状态栏文案"的先后）
    await uiWin.webContents.executeJavaScript(\`(() => {
      window.__prog = []
      window.__order = []
      window.sticky.onConvertProgress((p) => { window.__prog.push(p) })
      const pEl = document.getElementById('progress')
      const sEl = document.getElementById('status')
      const snap = (tag) => window.__order.push({
        tag: tag,
        hidden: pEl ? pEl.hidden : null,
        pct: (document.getElementById('progressPct') || {}).textContent || '',
        width: (document.getElementById('progressFill') || {}).style ? document.getElementById('progressFill').style.width : '',
        status: sEl ? sEl.textContent : '',
        cls: sEl ? sEl.className : ''
      })
      const mo = new MutationObserver(() => snap('mut'))
      mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
      window.__snap = snap
      return 1
    })()\`, true)

    /** 走真 UI 的 preload → IPC → 主进程链路执行一次转换 */
    const run = (files, target, allPages) => {
      const payload = Object.assign({ files, target })
      if (allPages !== undefined) payload.allPages = allPages
      const expr = 'window.sticky.convertRun(' + JSON.stringify(payload) + ').then(r => ({' +
        'ok:r.ok, error:r.error, reason:r.reason, reqId:r.reqId, ' +
        'failures:(r.failures||[]).map(f=>f.error), ' +
        'attachments:(r.attachments||[]).map(a=>({' +
        'name:a.name, path:a.path, warnings:(a.warnings||[]).map(w=>({code:w.code,message:w.message}))' +
        '})), ' +
        'warnings:(r.warnings||[]).map(w=>({code:w.code,message:w.message}))' +
        '}))'
      return uiWin.webContents.executeJavaScript(expr, true)
    }

    /** 等 UI 进入终态（状态栏 class ∈ ok/warn/err） */
    const waitTerminal = async (timeout = 60000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeout) {
        const cls = String(await uiWin.webContents.executeJavaScript(
          'document.getElementById("status").className', true) || '')
        if (/\\b(ok|warn|err)\\b/.test(cls)) return cls
        await new Promise(r => setTimeout(r, 80))
      }
      return ''
    }

    // ================================================================ 真实 webp
    // ★ 用 Chromium 自己的 canvas.toBlob('image/webp') 编码 ⇒ 真 webp 字节
    stage = 'webp-encode'
    const webpB64 = await uiWin.webContents.executeJavaScript(\`(async () => {
      const c = document.createElement('canvas')
      c.width = 40; c.height = 30
      const ctx = c.getContext('2d')
      ctx.fillStyle = '#3366cc'; ctx.fillRect(0, 0, 40, 30)
      ctx.fillStyle = '#ffcc00'; ctx.fillRect(5, 5, 10, 8)
      const blob = await new Promise(r => c.toBlob(r, 'image/webp'))
      if (!blob || blob.type !== 'image/webp') return { ok: false, type: blob ? blob.type : null }
      const buf = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
      return { ok: true, type: blob.type, b64: btoa(s), w: c.width, h: c.height }
    })()\`, true)
    if (!webpB64 || !webpB64.ok) return { ok: false, stage, diag: '无法用 canvas 编码 webp: ' + JSON.stringify(webpB64) }

    const webpPath = P.webp
    fs.writeFileSync(webpPath, Buffer.from(webpB64.b64, 'base64'))

    stage = 'webp-convert'
    const webpOut = await run([webpPath], 'pdf')

    // ================================================================ 真实 gif
    stage = 'gif-convert'
    const gifOut = await run([P.gif], 'pdf')

    // ================================================================ 混合批次
    stage = 'mixed'
    const mixedOut = await run([P.mixA, P.mixB, P.mixC], 'pdf')

    // ================================================================ 伪扩展名
    stage = 'fake-ext'
    const fakeOut = await run([P.fakeWebp], 'pdf')

    // ================================================================ 全部源不可用
    // 两条路径都要验：
    //  ① **完整链路**（router + service）：.bmp → pdf 没有任何 provider 认领 ⇒
    //     路由层明确失败、零产物（这是用户实际会遇到的路径）。
    //  ② **provider 直调**：绕过 router 的 canHandle 拦截，让 imagesToPdf 自己
    //     处理"全部源都不可用"，验证 failures[0].error 写明源文件名与原因
    //     （R-P2-5 的完整口径）。
    stage = 'all-bad'
    const allBadOut = await run([P.onlyBmp], 'pdf')
    const pdfLibMod = req('./lib/convert/providers/pdf')
    const provOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-allbad-out-'))
    const allBadProv = await pdfLibMod.createPdfProvider({}).convert(
      [P.onlyBmp], 'pdf', provOutDir)
    const provOutFiles = fs.readdirSync(provOutDir)

    // ================================================================ P5：pdf-page-failed
    stage = 'page-failed'
    // 真机注入"第 2 页编码失败"：patch canvas.toBlob（不 patch getContext）
    const getWorkerWin = async () => {
      for (let i = 0; i < 100; i++) {
        const w = BrowserWindow.getAllWindows().find(x =>
          !x.isDestroyed() && /convert-worker\\.html/.test(x.webContents.getURL()))
        if (w) return w
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error('找不到 convert-worker 窗口')
    }
    const workerWin = await getWorkerWin()
    const armFailure = (nth) => workerWin.webContents.executeJavaScript(
      '(() => {' +
      'if (!globalThis.__e2eBlobPatched) {' +
      'const orig = HTMLCanvasElement.prototype.toBlob;' +
      'HTMLCanvasElement.prototype.toBlob = function (cb) {' +
      'globalThis.__e2eBlobCalls = (globalThis.__e2eBlobCalls || 0) + 1;' +
      'if (globalThis.__e2eBlobCalls === globalThis.__e2eFailAt) { cb(null); return }' +
      'return orig.apply(this, arguments)' +
      '};' +
      'globalThis.__e2eBlobOrig = orig; globalThis.__e2eBlobPatched = true }' +
      'globalThis.__e2eBlobCalls = 0; globalThis.__e2eFailAt = ' + nth + '; 1 })()', true)
    const disarmFailure = () => workerWin.webContents.executeJavaScript(
      '(() => { if (globalThis.__e2eBlobOrig) {' +
      'HTMLCanvasElement.prototype.toBlob = globalThis.__e2eBlobOrig;' +
      'globalThis.__e2eBlobPatched = false; globalThis.__e2eBlobCalls = 0;' +
      'globalThis.__e2eFailAt = 0' +
      '} 1 })()', true)
    await armFailure(2)
    const partialOut = await run([P.bookPdf], 'png', true)
    await disarmFailure()

    // ================================================================ P4：真 UI 进度条
    stage = 'ui-progress'
    await uiWin.webContents.executeJavaScript('window.__prog.length = 0; window.__order.length = 0; 1', true)
    uiWin.webContents.send('convert:files', [P.bookPdf])
    await (async () => {
      const t0 = Date.now()
      while (Date.now() - t0 < 15000) {
        const v = await uiWin.webContents.executeJavaScript(
          '(() => { const e = document.getElementById("allPages"); return !!(e && !e.hidden) })()', true)
        if (v) return
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error('勾选框没有在 PDF 场景下显示')
    })()
    await uiWin.webContents.executeJavaScript('document.getElementById("allPages").click(); 1', true)

    // ★ 重复点击：同一 tick 内点两张不同的格式卡 ⇒ 只能触发一次转换
    stage = 'ui-double-click'
    const beforeFiles = fs.readdirSync(path.dirname(P.bookPdf))
    await uiWin.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll(".fmt"))' +
      '.find(e => e.dataset.fmt === "png").click();' +
      'Array.from(document.querySelectorAll(".fmt"))' +
      '.find(e => e.dataset.fmt === "jpg").click(); 1', true)
    const uiCls = await waitTerminal()
    const uiDom = await uiWin.webContents.executeJavaScript(\`(() => {
      const p = document.getElementById('progress')
      const f = document.getElementById('progressFill')
      const pc = document.getElementById('progressPct')
      const s = document.getElementById('status')
      const cards = Array.from(document.querySelectorAll('.fmt'))
      const ap = document.getElementById('allPages')
      return {
        progressHidden: p ? p.hidden : null,
        fillWidth: f ? f.style.width : '',
        pct: pc ? pc.textContent : '',
        status: s ? s.textContent : '',
        cls: s ? s.className : '',
        cardPointer: cards.length ? (cards[0].style.pointerEvents || '') : null,
        allPagesDisabled: ap ? ap.disabled : null,
        order: window.__order,
        prog: window.__prog
      }
    })()\`, true)
    const afterFiles = fs.readdirSync(path.dirname(P.bookPdf))
    const newFiles = afterFiles.filter(f => !beforeFiles.includes(f))

    // ================================================================ P4：主进程并发闸
    stage = 'main-gate'
    const gateResult = await uiWin.webContents.executeJavaScript(\`(async () => {
      const files = [window.__P.bookPdf]
      const a = window.sticky.convertRun({ files, target: 'png', allPages: true, reqId: 'gate-a' })
      const b = window.sticky.convertRun({ files, target: 'png', allPages: true, reqId: 'gate-b' })
      const ra = await a
      const rb = await b
      return { a: { ok: ra.ok, error: ra.error, reqId: ra.reqId, count: (ra.attachments||[]).length },
               b: { ok: rb.ok, error: rb.error, reqId: rb.reqId } }
    })()\`, true)

    // ================================================================ P4：TXT 全页无逐页进度
    stage = 'txt-progress'
    await uiWin.webContents.executeJavaScript('window.__prog.length = 0; 1', true)
    const txtOut = await run([P.bookPdf], 'txt', true)
    const txtProg = await uiWin.webContents.executeJavaScript(
      'window.__prog.slice()', true)
    const txtDom = await uiWin.webContents.executeJavaScript(\`(() => {
      const p = document.getElementById('progress')
      const pc = document.getElementById('progressPct')
      const s = document.getElementById('status')
      return {
        progressHidden: p ? p.hidden : null,
        pct: pc ? pc.textContent : '',
        status: s ? s.textContent : '',
        cls: s ? s.className : ''
      }
    })()\`, true)

    // ================================================================ P4：多源按源显示
    stage = 'multi-source'
    await uiWin.webContents.executeJavaScript('window.__prog.length = 0; 1', true)
    await run([P.bookPdf, P.book2Pdf], 'png', true)
    const multiProg = await uiWin.webContents.executeJavaScript(
      'window.__prog.slice()', true)

    // ================================================================ 收尾
    const workerErrors = consoleMsgs
      .filter(m => !m.url || /convert-worker\\.html/.test(m.url))
      .filter(m => m.level >= 3)
      .map(m => m.message)
    const cspViolations = consoleMsgs
      .filter(m => !m.url || /convert-worker\\.html/.test(m.url))
      .filter(m => /Content Security Policy/i.test(m.message))
      .map(m => m.message)

    uiWin.destroy()
    return {
      ok: true,
      webpInfo: { type: webpB64.type, w: webpB64.w, h: webpB64.h, size: fs.statSync(webpPath).size },
      webpOut, gifOut, mixedOut, fakeOut, allBadOut, partialOut,
      allBadProv: {
        ok: allBadProv.ok,
        reason: allBadProv.reason,
        error: allBadProv.error,
        failures: (allBadProv.failures || []).map(x => ({ error: x.error, source: x.source })),
        outFiles: provOutFiles
      },
      uiCls, uiDom, newFiles, gateResult, txtOut, txtProg, txtDom, multiProg,
      workerErrors: workerErrors.slice(0, 10),
      cspViolations: cspViolations.slice(0, 10)
    }
   } catch (err) {
     return { ok: false, stage, diag: String((err && err.stack) || err) }
   }
  })()`
}

// ---------------------------------------------------------------- 主流程

async function main () {
  console.log('PDF 遗留项（P2/P4/P5）e2e\n')

  const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-legacy-src-'))
  const webpPath = path.join(srcRoot, 'shot.webp')
  const gifPath = path.join(srcRoot, 'anim.gif')
  const mixA = path.join(srcRoot, 'a.png')
  const mixB = path.join(srcRoot, 'b.bmp')
  const mixC = path.join(srcRoot, 'c.png')
  const fakeWebp = path.join(srcRoot, 'fake.webp')
  const onlyBmp = path.join(srcRoot, 'only.bmp')
  const bookPdf = path.join(srcRoot, 'book.pdf')
  const book2Pdf = path.join(srcRoot, 'book2.pdf')

  fs.writeFileSync(gifPath, makeGif(2, 12, 10))
  fs.writeFileSync(mixA, makePng(20, 15, [200, 40, 40]))
  fs.writeFileSync(mixC, makePng(30, 25, [40, 200, 40]))
  // bmp：只是不支持的格式（内容随意）
  fs.writeFileSync(mixB, Buffer.from('BM-not-a-real-bitmap', 'ascii'))
  fs.writeFileSync(onlyBmp, Buffer.from('BM-not-a-real-bitmap', 'ascii'))
  // 伪扩展名：PNG 字节改名 .webp ⇒ 魔数不匹配
  fs.writeFileSync(fakeWebp, makePng(8, 8, [1, 2, 3]))
  await writePdf(bookPdf, ['LEGACY_MARK_ONE', 'LEGACY_MARK_TWO', 'LEGACY_MARK_THREE'])
  await writePdf(book2Pdf, ['LEGACY2_MARK_ONE', 'LEGACY2_MARK_TWO'])

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-legacy-ud-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'),
    JSON.stringify({ version: 1, notes: [], settings: {} }))
  const attachDir = srcRoot

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.STICKY_FILEE = 'C:\\definitely\\not\\installed\\filee.exe'

  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData,
    '--remote-debugging-port=' + CDP_PORT,
    '--inspect=0',
    '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })

  const checks = []
  let cdp = null
  let r = null
  try {
    const inspectorUrl = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 25000, 'inspector')
    await waitFor(async () => log.includes('[boot] 托盘就绪') ? true : null, 25000, '启动完成')

    cdp = new CDP(inspectorUrl)
    await cdp.connect()
    r = await cdp.evaluate(buildExpr({
      webp: webpPath, gif: gifPath, mixA, mixB, mixC,
      fakeWebp, onlyBmp, bookPdf, book2Pdf
    }))
    assert.ok(r && r.ok, '求值失败: ' + JSON.stringify(r).slice(0, 1500))

    const quit = await cdp.evaluate(QUIT_EXPR)
    assert.ok(quit && quit.ok, 'app.quit() 调用失败')
    cdp.close()
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode) return true
      await sleep(150)
      return false
    }, 20000, '进程退出').catch(() => {})
  } catch (err) {
    console.error('  ✗ ' + err.message)
    console.error('  --- 日志尾部 ---')
    console.error('  ' + log.split('\n').slice(-25).join('\n  '))
    if (cdp) cdp.close()
    if (child.exitCode === null) { try { child.kill() } catch (_) {} }
    process.exit(1)
  }

  // ---------------------------------------------------------------- P2 断言
  const wi = r.webpInfo || {}
  checks.push(['★ canvas 真的编码出了 webp（blob.type=image/webp）', wi.type === 'image/webp'])

  const w = r.webpOut || {}
  const wAtt = w.attachments || []
  checks.push(['webp → PDF 转换成功', w.ok === true])
  checks.push(['webp → PDF 产出 1 个附件', wAtt.length === 1])
  let wPageCount = null
  let wPageSize = null
  if (wAtt.length && fs.existsSync(wAtt[0].path)) {
    const head = fs.readFileSync(wAtt[0].path).slice(0, 5).toString('ascii')
    checks.push(['★ webp → PDF 产物首 5 字节是 %PDF-', head === '%PDF-'])
    try {
      const doc = await PDFDocument.load(fs.readFileSync(wAtt[0].path))
      wPageCount = doc.getPageCount()
      const size = doc.getPage(0).getSize()
      wPageSize = { width: size.width, height: size.height }
    } catch (e) {
      wPageCount = null
      wPageSize = null
    }
  } else {
    checks.push(['★ webp → PDF 产物首 5 字节是 %PDF-', false])
  }
  checks.push(['★ pdf-lib 独立读出 webp→PDF 的页数 == 1', wPageCount === 1, '实际 ' + wPageCount])
  checks.push(['★ pdf-lib 读出的页面尺寸 == 原图像素（40×30）',
    !!wPageSize && Math.round(wPageSize.width) === wi.w && Math.round(wPageSize.height) === wi.h,
    JSON.stringify(wPageSize)])
  checks.push(['webp 源不出现在 failures 里', (w.failures || []).length === 0])

  const g = r.gifOut || {}
  const gAtt = g.attachments || []
  const gWarns = (g.warnings || []).concat(...gAtt.map(x => x.warnings || []))
  checks.push(['真实 gif → PDF 转换成功', g.ok === true && gAtt.length === 1])
  checks.push(['★ 动图 gif 出现 pdf-animated-first-frame 警告',
    gWarns.some(x => x.code === 'pdf-animated-first-frame')])
  checks.push(['动图警告文案含"首帧"',
    gWarns.some(x => /首帧|第一帧/.test(x.message || ''))])
  let gPageCount = null
  if (gAtt.length && fs.existsSync(gAtt[0].path)) {
    try {
      const doc = await PDFDocument.load(fs.readFileSync(gAtt[0].path))
      gPageCount = doc.getPageCount()
    } catch (_) {}
  }
  checks.push(['★ pdf-lib 独立读出 gif→PDF 的页数 == 1', gPageCount === 1, '实际 ' + gPageCount])

  const mx = r.mixedOut || {}
  const mxAtt = mx.attachments || []
  const mxWarns = (mx.warnings || []).concat(...mxAtt.map(x => x.warnings || []))
  const skipWarn = mxWarns.find(x => x.code === 'pdf-image-skipped')
  checks.push(['★ 混合批次部分成功（ok:true）', mx.ok === true])
  checks.push(['混合批次产出 1 个 PDF', mxAtt.length === 1])
  checks.push(['★ 混合批次出现 pdf-image-skipped 警告', !!skipWarn])
  checks.push(['★ 警告文案含"共 3 张"', !!(skipWarn && /共\s*3\s*张/.test(skipWarn.message))])
  checks.push(['★ 警告文案含"2 张"（已写入）', !!(skipWarn && /2\s*张/.test(skipWarn.message))])
  checks.push(['★ 警告文案含"1 张"（跳过）', !!(skipWarn && /1\s*张/.test(skipWarn.message))])
  let mxPageCount = null
  if (mxAtt.length && fs.existsSync(mxAtt[0].path)) {
    try {
      const doc = await PDFDocument.load(fs.readFileSync(mxAtt[0].path))
      mxPageCount = doc.getPageCount()
    } catch (_) {}
  }
  checks.push(['★ pdf-lib 独立读出混合批次页数 == 2（不多不少）', mxPageCount === 2, '实际 ' + mxPageCount])

  const fk = r.fakeOut || {}
  checks.push(['★ 伪扩展名（PNG 字节改名 .webp）明确失败', fk.ok === false])
  checks.push(['伪扩展名失败原因含"魔数"或"不是真正的"',
    (fk.failures || []).some(x => /魔数|不是真正的/.test(x || '')) ||
    /魔数|不是真正的/.test(fk.error || '')])
  checks.push(['伪扩展名零产物', (fk.attachments || []).length === 0])

  const ab = r.allBadOut || {}
  checks.push(['★ 全部源不可用 ⇒ ok:false（完整链路）', ab.ok === false])
  checks.push(['全部源不可用时零产物（完整链路）', (ab.attachments || []).length === 0])
  const abp = r.allBadProv || {}
  checks.push(['★ 全部源不可用 ⇒ provider 直调 ok:false', abp.ok === false])
  checks.push(['★ provider 直调时输出目录零文件', (abp.outFiles || []).length === 0])
  checks.push(['★ provider 直调时 failures 写明源文件名与原因',
    (abp.failures || []).length > 0 &&
    /only\.bmp/.test(String(abp.failures[0].source || '')) &&
    /不支持|格式/.test(String(abp.failures[0].error || '')),
    JSON.stringify(abp.failures)])

  // ---------------------------------------------------------------- P5 断言
  const pf = r.partialOut || {}
  const pfAtt = pf.attachments || []
  const pfWarns = (pf.warnings || []).concat(...pfAtt.map(x => x.warnings || []))
  const pfTop = (pf.warnings || []).find(x => x.code === 'pdf-page-failed')
  checks.push(['★ 真机部分页失败：转换仍成功且保留成功页', pf.ok === true && pfAtt.length === 2])
  checks.push(['★ 顶层 warnings 含 pdf-page-failed', !!pfTop])
  const firstPageAtt = pfAtt.slice().sort((a, b) => (a.name < b.name ? -1 : 1))[0]
  checks.push(['★ 产物级也能读到 pdf-page-failed',
    pfAtt.some(a => (a.warnings || []).some(x => x.code === 'pdf-page-failed'))])
  const prodWarn = pfAtt
    .flatMap(a => a.warnings || [])
    .find(x => x.code === 'pdf-page-failed')
  checks.push(['★ 产物级与顶层文案逐字节相同',
    !!pfTop && !!prodWarn && pfTop.message === prodWarn.message])
  const dedup = new Set()
  for (const x of pfWarns) dedup.add(x.code + '|' + x.message)
  checks.push(['★ 去重后 pdf-page-failed 只出现 1 次',
    Array.from(dedup).filter(k => k.startsWith('pdf-page-failed|')).length === 1])

  // ---------------------------------------------------------------- P4 断言
  const dom = r.uiDom || {}
  const prog = dom.prog || []
  const pageEvents = prog.filter(p => p && p.phase === 'pages')
  const prepareEvents = prog.filter(p => p && p.phase === 'prepare')
  checks.push(['★ 真机收到 ≥3 条逐页进度事件', pageEvents.length >= 3, '实际 ' + pageEvents.length])
  checks.push(['进度事件的 page 序列含 1/2/3',
    [1, 2, 3].every(n => pageEvents.some(p => p.page === n))])
  checks.push(['进度事件的 total 都是已知页数', pageEvents.every(p => p.total === 3)])
  checks.push(['★ 存在 total 未知的准备阶段事件（total === null）',
    prepareEvents.length >= 1 && prepareEvents.every(p => p.total === null || p.total === undefined)])
  checks.push(['进度事件带 reqId', prog.every(p => typeof p.reqId === 'string' && p.reqId.length > 0)])
  checks.push(['进度事件带 source（按源分别显示的前提）',
    pageEvents.every(p => typeof p.source === 'string' && p.source.length > 0)])

  // 单调不减
  const pcts = pageEvents.map(p => {
    const total = Number(p.total) || 0
    const processed = (Number(p.done) || 0) + (Number(p.failed) || 0)
    return total ? Math.min(100, Math.round(processed * 100 / total)) : 0
  })
  checks.push(['★ 进度百分比单调不减',
    pcts.every((v, i) => i === 0 || v >= pcts[i - 1]), JSON.stringify(pcts)])

  checks.push(['★ 终态进度条已隐藏', dom.progressHidden === true])
  checks.push(['终态状态栏 class ∈ {ok, warn, err}',
    /(^|\s)(ok|warn|err)(\s|$)/.test(dom.cls || '') &&
    !/(^|\s)busy(\s|$)/.test(dom.cls || '')])
  checks.push(['终态不残留百分比文本', !(dom.pct || '').trim()])

  // 顺序：进度条隐藏必须早于状态栏终态文案
  const order = dom.order || []
  let hiddenIdx = -1
  let terminalIdx = -1
  for (let i = 0; i < order.length; i++) {
    const o = order[i]
    if (hiddenIdx === -1 && o.hidden === true && /(^|\s)(ok|warn|err)(\s|$)/.test(o.cls || '')) hiddenIdx = i
    if (terminalIdx === -1 && /(^|\s)(ok|warn|err)(\s|$)/.test(o.cls || '')) terminalIdx = i
  }
  checks.push(['★ 进度条先隐藏、再写终态文案（同一帧快照）',
    hiddenIdx !== -1 && terminalIdx !== -1 && hiddenIdx <= terminalIdx,
    'hiddenIdx=' + hiddenIdx + ' terminalIdx=' + terminalIdx])

  // 重复点击不并发
  const newFiles = r.newFiles || []
  const pngFiles = newFiles.filter(f => /^book-.*\.png$/i.test(f))
  const jpgFiles = newFiles.filter(f => /^book-.*\.jpg$/i.test(f))
  checks.push(['★ 重复点击只产生一组 PNG（不多不少）', pngFiles.length === 3, '实际 ' + pngFiles.length])
  checks.push(['★ 重复点击没有产生 JPG 产物（第二次被闸拦住）', jpgFiles.length === 0, '实际 ' + jpgFiles.length])

  // 主进程并发闸
  const gate = r.gateResult || {}
  checks.push(['★ 主进程并发闸：第二次 convert:run 明确失败',
    gate.b && gate.b.ok === false && /已有转换在进行中/.test(gate.b.error || ''),
    JSON.stringify(gate.b)])
  checks.push(['并发闸：第一次仍成功且产物数 == 3',
    gate.a && gate.a.ok === true && gate.a.count === 3, JSON.stringify(gate.a)])
  checks.push(['并发闸：回包回显 reqId',
    gate.a && gate.a.reqId === 'gate-a' && gate.b && gate.b.reqId === 'gate-b'])

  // TXT 全页
  const txtProg = r.txtProg || []
  checks.push(['★ TXT 全页不产生 phase=pages 的逐页事件',
    !txtProg.some(p => p && p.phase === 'pages')])
  checks.push(['TXT 全页产生 phase=text 的事件',
    txtProg.some(p => p && p.phase === 'text')])
  const txtDom = r.txtDom || {}
  checks.push(['★ TXT 终态不残留百分比文本', !(txtDom.pct || '').trim()])
  checks.push(['TXT 终态进度条已隐藏', txtDom.progressHidden === true])
  checks.push(['TXT 转换成功', r.txtOut && r.txtOut.ok === true])

  // 多源
  const multi = r.multiProg || []
  const srcs = Array.from(new Set(multi.filter(p => p && p.source).map(p => p.source)))
  checks.push(['★ 多源进度里两个源都出现过（按源分别显示）',
    srcs.length >= 2, JSON.stringify(srcs)])
  checks.push(['多源进度每条都带 source', multi.every(p => p && typeof p.source === 'string')])

  // 运行时健康
  checks.push(['worker 全程无 error 级日志', (r.workerErrors || []).length === 0,
    JSON.stringify((r.workerErrors || []).slice(0, 3))])
  checks.push(['无 CSP 违规日志', (r.cspViolations || []).length === 0])

  let pass = 0
  for (const [name, ok, detail] of checks) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail && !ok ? '  —— ' + detail : ''))
    if (ok) pass++
  }
  console.log('\n结果：' + pass + '/' + checks.length + ' 通过')
  process.exit(pass === checks.length ? 0 : 1)
}

main()
