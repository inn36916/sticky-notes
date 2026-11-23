'use strict'

/**
 * 内置 PDF provider 端到端回归（npm run test:e2e:convert:pdf）。
 *
 * 验的是**真链路**：真 Electron + 真隐藏渲染窗口 + 真 pdfjs + 真 canvas。
 *   单测里的 workerHost 是假的，只能证明编排逻辑对；pdfjs 6.x 在
 *   file:// + 严格 CSP 下能不能加载、Worker 能不能起来、渲染能不能真出图，
 *   只有真跑一遍才知道（这一轮确实踩到多个新 API 缺失的坑）。
 *
 * ★ 分工：PDF 的**生成与页数校验**放在 Node 侧（本脚本，pdf-lib 正常可用）；
 *   只有"必须跑在 Electron 里"的转换编排放进 CDP 表达式。
 *   实测在 Node inspector 的 evaluate 上下文里反复 require pdf-lib 会触发
 *   `Promise was collected` 之类的 V8 检查器抖动，没必要趟这浑水。
 *
 * 场景：
 *   1. 引擎清单里有 builtin-pdf，且状态为可用（开箱即用，不需投放插件）
 *   2. 能力查询：pdf → png/jpg/webp/txt；png → pdf
 *   3. 真 PDF（pdf-lib 现场生成，2 页带文字）→ PNG：魔数 / IHDR / 多页警告
 *   4. 真 PDF → TXT：抽出的文字包含生成时写入的标记
 *   5. 图片 → PDF：真 PNG（由第 3 步渲染出来再喂回去）→ PDF，页数用 pdf-lib 校验
 *   6. 多图 → 一个 PDF，页数 == 输入图片数
 *   7. 非 PDF（魔数不对）→ ok:false + 零产物
 *   8. 加密 PDF → 明确失败 + 零产物
 *   9. png → jpg 仍由 builtin-image 提供（没被 PDF provider 截胡）
 *  10. worker 页面无 error 级日志 / 无 CSP 违规（检测器本身也自测）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')
const { PDFDocument, StandardFonts } = require('pdf-lib')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SRC_DIR = path.join(ROOT, 'src')
const BASE_CDP_PORT = 9462

/** 生成 PDF 时写进页面的文字（第 1 页 / 第 2 页各一处） */
const MARK1 = 'E2E_PDF_MARKER_PAGE_ONE'
const MARK2 = 'E2E_PDF_MARKER_PAGE_TWO'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-
const JPEG_MAGIC = [0xff, 0xd8, 0xff]
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitFor (fn, timeout = 20000, label = '') {
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
  async evaluate (expression) {
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

/**
 * 构造一个最小"加密"PDF：trailer 带 /Encrypt，Standard V1 R2 的 O/U 串填零。
 * 它不需要是真正正确加密的文件 —— pdfjs 只要识别到需要密码就会抛
 * PasswordException，provider 必须把它翻成可读的中文失败。
 * @param {string} dest
 */
function writeEncryptedPdf (dest) {
  const zeros = '00'.repeat(32)
  const text = '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Encrypt 3 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Filter /Standard /V 1 /R 2 /P -4 /O <' + zeros + '> /U <' + zeros + '> >>\nendobj\n' +
    '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n' +
    'trailer\n<< /Size 5 /Root 1 0 R /Encrypt 3 0 R /ID [<01020304><01020304>] >>\n' +
    'startxref\n0\n%%EOF\n'
  fs.writeFileSync(dest, Buffer.from(text, 'latin1'))
}

/** 生成 2 页带文字的真 PDF（Node 侧，pdf-lib 在这里完全可用） */
async function writeSamplePdf (dest) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const marker of [MARK1, MARK2]) {
    const page = doc.addPage([400, 200])
    page.drawText(marker, { x: 20, y: 100, size: 18, font })
  }
  fs.writeFileSync(dest, Buffer.from(await doc.save()))
}

/** 读 PDF 页数（Node 侧校验，不信任 provider 的自述） */
async function pageCount (file) {
  if (!file || !fs.existsSync(file)) return -1
  const doc = await PDFDocument.load(fs.readFileSync(file))
  return doc.getPageCount()
}

/**
 * 主进程里执行的一整段装配 + 全部场景（CDP evaluate 的 expression）。
 * 入参都是 Node 侧准备好的路径，表达式里不再 require pdf-lib。
 */
function buildExpr (opts) {
  return `(async () => {
   try {
    const getReq = ${REQUIRE_EXPR}
    const req = getReq()
    if (!req) return { ok: false, err: 'no require' }

    const fs = req('fs')
    const os = req('os')
    const path = req('path')
    const { BrowserWindow } = req('electron')
    const workerHostLib = req('./lib/convert/worker-host')
    const providersLib = req('./lib/convert/providers')
    const routerLib = req('./lib/convert/router')

    // ★ 必须在创建 worker 窗口之前挂监听：pdfjs 的 Worker/CSP 问题
    //   很多都发生在页面加载期，晚挂就抓不到。
    const consoleMsgs = []
    req('electron').app.on('web-contents-created', (_e, wc) => {
      try {
        wc.on('console-message', (_ev, level, message) => {
          consoleMsgs.push({ level, message: String(message) })
        })
      } catch (_) {}
    })

    const host = workerHostLib.createWorkerHost({
      BrowserWindow,
      srcDir: ${JSON.stringify(SRC_DIR)},
      log: () => {}
    })

    // worker 窗口自检：通道是否注册、CSP 是否仍在（尤其 blob: / connect-src）
    let workerProbe = null
    let workerWin = null
    try {
      workerWin = await host.ensure()
      workerProbe = await workerWin.webContents.executeJavaScript(\`(() => ({
        frozenSticky: Object.isFrozen(window.sticky),
        hasRenderPdf: typeof window.sticky.onWorkerRenderPdf === 'function',
        hasExtractText: typeof window.sticky.onWorkerExtractPdfText === 'function',
        hasRenderSvg: typeof window.sticky.onWorkerRenderSvg === 'function',
        codecs: globalThis.__convertWorkerCodecs || null,
        csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || ''
      }))()\`, true)
    } catch (e) {
      workerProbe = { err: String((e && e.message) || e) }
    }

    const list = providersLib.createDefaultProviders({
      workerHost: host,
      appDir: ${JSON.stringify(ROOT)},
      withFilee: false,
      withPlugins: false,
      log: () => {}
    })
    const router = routerLib.createRouter({ providers: list })
    const engines = await router.engines()
    const capsPdf = await router.capabilities('pdf')
    const capsPng = await router.capabilities('png')

    const srcRoot = ${JSON.stringify(opts.srcRoot)}
    const srcPdf = ${JSON.stringify(opts.srcPdf)}
    const encFile = ${JSON.stringify(opts.encFile)}
    const badFile = ${JSON.stringify(opts.badFile)}
    const mkOut = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-pdfout-'))
    const head = (p, n) => Array.from(fs.readFileSync(p).slice(0, n))
    const firstOutput = (r) => (r && r.outputs && r.outputs[0] ? r.outputs[0].output : null)
    const pngDims = (p) => {
      const b = fs.readFileSync(p)
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
    }

    // ---- 场景 3：PDF → PNG（2 页，要带 pdf-multipage 警告）----
    const outPng = mkOut()
    const convPng = await router.convert([srcPdf], 'png', outPng)
    const filePng = firstOutput(convPng)
    const pngOut = filePng ? {
      ok: convPng.ok, provider: convPng.provider, error: convPng.error,
      file: filePng, exists: fs.existsSync(filePng),
      magic: head(filePng, 4), dims: pngDims(filePng),
      size: fs.statSync(filePng).size,
      warnings: (convPng.outputs[0] && convPng.outputs[0].warnings) || [],
      collectedWarnings: convPng.warnings || []
    } : { ok: convPng.ok, error: convPng.error, failures: convPng.failures }

    // ---- 场景 4：PDF → TXT ----
    const outTxt = mkOut()
    const convTxt = await router.convert([srcPdf], 'txt', outTxt)
    const fileTxt = firstOutput(convTxt)
    const txtOut = fileTxt ? {
      ok: convTxt.ok, file: path.basename(fileTxt),
      text: fs.readFileSync(fileTxt, 'utf8'),
      warnings: (convTxt.outputs[0] && convTxt.outputs[0].warnings) || []
    } : { ok: convTxt.ok, error: convTxt.error, failures: convTxt.failures }

    // ---- 场景 5：把真渲染出的 PNG 当源，走图片 → PDF ----
    let imgToPdf = { ok: false, error: '没有可用的 PNG 源' }
    let multiImgToPdf = { ok: false, error: '没有可用的 PNG 源' }
    if (filePng) {
      const srcPng = path.join(srcRoot, 'photo.png')
      fs.copyFileSync(filePng, srcPng)
      const c1 = await router.convert([srcPng], 'pdf', mkOut())
      const f1 = firstOutput(c1)
      imgToPdf = f1 ? {
        ok: c1.ok, provider: c1.provider, error: c1.error,
        file: f1, magic: head(f1, 5), size: fs.statSync(f1).size
      } : { ok: c1.ok, error: c1.error, failures: c1.failures }

      // ---- 场景 6：多图合并成一个 PDF，一图一页 ----
      const p2 = path.join(srcRoot, 'photo2.png')
      fs.copyFileSync(srcPng, p2)
      const c2 = await router.convert([srcPng, p2], 'pdf', mkOut())
      const f2 = firstOutput(c2)
      multiImgToPdf = f2 ? {
        ok: c2.ok, outputCount: (c2.outputs || []).length,
        file: f2, magic: head(f2, 5)
      } : { ok: c2.ok, error: c2.error, failures: c2.failures }
    }

    // ---- 场景 7：非 PDF（魔数不对）----
    const outBad = mkOut()
    const convBad = await router.convert([badFile], 'png', outBad)

    // ---- 场景 8：加密 PDF ----
    const outEnc = mkOut()
    const convEnc = await router.convert([encFile], 'png', outEnc)

    // ---- 场景 9：png → jpg 仍由 builtin-image 提供 ----
    let imageRegression = { ok: false, error: '没有 PNG 源' }
    if (filePng) {
      const c = await router.convert([filePng], 'jpg', mkOut())
      const f = firstOutput(c)
      imageRegression = {
        ok: c.ok, provider: c.provider,
        magic: f ? head(f, 3) : null,
        error: c.error
      }
    }

    // ---- 检测器自测：故意制造一条 error，确认 console-message 真的抓得到 ----
    const isErr = (m) => m.level >= 3
    const errsBefore = consoleMsgs.filter(isErr).map(m => m.message)
    let markerCaught = false
    if (workerWin) {
      await workerWin.webContents.executeJavaScript(
        'setTimeout(() => { throw new TypeError("e2e-pdf-marker-boom") }, 0); 1', true)
      await new Promise(r => setTimeout(r, 400))
      markerCaught = consoleMsgs.some(m => isErr(m) && /e2e-pdf-marker-boom/.test(m.message))
    }

    host.dispose()

    return {
      engines, capsPdf, capsPng,
      pngOut, txtOut, imgToPdf, multiImgToPdf,
      bad: {
        ok: convBad.ok, reason: convBad.reason, error: convBad.error,
        failures: (convBad.failures || []).map(f => f.error),
        outCount: fs.readdirSync(outBad).length
      },
      enc: {
        ok: convEnc.ok, error: convEnc.error,
        failures: (convEnc.failures || []).map(f => f.error),
        outCount: fs.readdirSync(outEnc).length
      },
      imageRegression, workerProbe, markerCaught,
      workerConsoleErrors: errsBefore.slice(0, 10),
      cspViolations: consoleMsgs
        .filter(m => /Content Security Policy/i.test(m.message))
        .map(m => m.message)
        .slice(0, 10),
      // pdfjs 起不了真 Worker 时会 warn "Setting up fake worker."，
      // 记下来用于断言"到底用没用上 Worker"（fake-worker 会把渲染压在主线程）
      fakeWorkerWarnings: consoleMsgs
        .filter(m => /fake worker/i.test(m.message))
        .map(m => m.message)
        .slice(0, 10)
    }
   } catch (err) {
     return { ok: false, diag: String((err && err.stack) || err) }
   }
  })()`
}

async function main () {
  console.log('内置 PDF provider e2e')
  const cdpPort = BASE_CDP_PORT
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-pdf-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'),
    JSON.stringify({ version: 1, notes: [], settings: {} }))

  // ---- Node 侧准备输入文件（pdf-lib 在这里毫无争议地可用）----
  const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-pdfsrc-'))
  const srcPdf = path.join(srcRoot, 'book.pdf')
  await writeSamplePdf(srcPdf)
  const badFile = path.join(srcRoot, 'fake.pdf')
  fs.writeFileSync(badFile, 'this is definitely not a pdf')
  const encFile = path.join(srcRoot, 'locked.pdf')
  writeEncryptedPdf(encFile)
  const generatedPages = await pageCount(srcPdf)

  const env = Object.assign({}, process.env)
  // 宿主有 ELECTRON_RUN_AS_NODE=1，不删掉的话 spawn 出来的 electron 会变成纯 node
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.STICKY_FILEE = 'C:\\definitely\\not\\installed\\filee.exe'

  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData,
    '--remote-debugging-port=' + cdpPort,
    '--inspect=0',
    '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })

  const checks = []
  let cdp = null
  try {
    const inspectorUrl = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 25000, 'inspector')
    await waitFor(async () => log.includes('[boot] 托盘就绪') ? true : null, 25000, '启动完成')

    cdp = new CDP(inspectorUrl)
    await cdp.connect()
    const r = await cdp.evaluate(buildExpr({ srcRoot, srcPdf, badFile, encFile }))
    assert.ok(r && !r.err && !r.diag, '求值失败: ' + JSON.stringify(r))

    // 页数在 Node 侧用 pdf-lib 独立校验，不信任 provider 自述
    const imgPages = await pageCount(r.imgToPdf && r.imgToPdf.file)
    const multiPages = await pageCount(r.multiImgToPdf && r.multiImgToPdf.file)
    const imgName = r.imgToPdf && r.imgToPdf.file ? path.basename(r.imgToPdf.file) : null
    const multiName = r.multiImgToPdf && r.multiImgToPdf.file ? path.basename(r.multiImgToPdf.file) : null

    const eng = r.engines || []
    const pdfEng = eng.find(e => e.id === 'builtin-pdf')
    checks.push(['PDF provider 出现在引擎清单（设置页 convertEngines 同源）', !!pdfEng])
    checks.push(['PDF provider 开箱即用（available = true，无需投放插件）',
      !!(pdfEng && pdfEng.available === true)])
    checks.push(['能力查询 pdf 含 png/jpg/webp/txt',
      ['png', 'jpg', 'webp', 'txt'].every(t => (r.capsPdf.targets || []).includes(t))])
    checks.push(['能力查询 png 含 pdf',
      (r.capsPng.targets || []).includes('pdf')])
    checks.push(['现场生成的 PDF 确实是 2 页', generatedPages === 2])

    // PDF → PNG
    checks.push(['2 页 PDF → PNG 成功', r.pngOut.ok === true])
    checks.push(['PDF→PNG 产物落盘且非空', r.pngOut.exists === true && r.pngOut.size > 100])
    checks.push(['PDF→PNG 产物是真 PNG（魔数）',
      JSON.stringify(r.pngOut.magic) === JSON.stringify(PNG_MAGIC)])
    checks.push(['PDF→PNG 尺寸按页面 400×200 渲染',
      !!r.pngOut.dims && r.pngOut.dims.width === 400 && r.pngOut.dims.height === 200])
    checks.push(['PDF→PNG 文件名无 .pdf 双扩展名',
      r.pngOut.file && path.basename(r.pngOut.file) === 'book.png'])
    checks.push(['★ 多页软性假成功防线：warnings 含 pdf-multipage',
      (r.pngOut.warnings || []).some(w => w.code === 'pdf-multipage')])
    checks.push(['多页警告文案写明总页数',
      /2 页/.test((r.pngOut.warnings || []).map(w => w.message).join(' '))])

    // PDF → TXT
    checks.push(['PDF → TXT 成功', r.txtOut.ok === true])
    checks.push(['抽出的文本包含第 1 页写入的标记',
      String(r.txtOut.text || '').includes(MARK1)])
    checks.push(['文本产物文件名无 .pdf 双扩展名', r.txtOut.file === 'book.txt'])
    checks.push(['TXT 同样带多页警告',
      (r.txtOut.warnings || []).some(w => w.code === 'pdf-multipage')])

    // 图片 → PDF
    checks.push(['真 PNG → PDF 成功', r.imgToPdf.ok === true])
    checks.push(['图片→PDF 产物是真 PDF（%PDF- 魔数）',
      JSON.stringify(r.imgToPdf.magic) === JSON.stringify(PDF_MAGIC)])
    checks.push(['图片→PDF 文件名是 photo.pdf', imgName === 'photo.pdf'])
    checks.push(['图片→PDF 页数 = 1（一图一页）', imgPages === 1])
    checks.push(['多图合并成一个 PDF（只有一个产物）', r.multiImgToPdf.outputCount === 1])
    checks.push(['多图 PDF 页数 = 输入图片数 2', multiPages === 2])
    checks.push(['多图 PDF 文件名无双扩展名', multiName === 'photo.pdf'])

    // 负向
    const badErr = String(r.bad.error || '') + ' ' + (r.bad.failures || []).join(' ')
    checks.push(['非 PDF 文件明确失败', r.bad.ok === false])
    checks.push(['非 PDF 失败原因指向魔数/损坏', /PDF|魔数|损坏/i.test(badErr)])
    checks.push(['非 PDF 零产物', r.bad.outCount === 0])

    const encErr = String(r.enc.error || '') + ' ' + (r.enc.failures || []).join(' ')
    checks.push(['加密 PDF 明确失败', r.enc.ok === false])
    checks.push(['加密 PDF 失败原因可读', /加密|密码|PDF/i.test(encErr)])
    checks.push(['加密 PDF 零产物', r.enc.outCount === 0])

    // 不污染既有能力
    checks.push(['png → jpg 仍可用', r.imageRegression.ok === true])
    checks.push(['png → jpg 仍由 builtin-image 提供（未被 PDF provider 截胡）',
      r.imageRegression.provider === 'builtin-image'])
    checks.push(['png→jpg 产物是真 JPEG',
      JSON.stringify(r.imageRegression.magic) === JSON.stringify(JPEG_MAGIC)])

    // worker / CSP / console
    const wp = r.workerProbe || {}
    checks.push(['worker 两个 PDF IPC 通道已注册',
      wp.hasRenderPdf === true && wp.hasExtractText === true])
    checks.push(['既有 SVG 通道仍注册（没被 PDF 改动破坏）', wp.hasRenderSvg === true])
    checks.push(['自检信息含 render:pdf（注册块执行到最后一行）',
      !!wp.codecs && Array.isArray(wp.codecs.render) && wp.codecs.render.includes('pdf')])
    checks.push(['worker CSP 仍在且保留 blob:（SVG 依赖它）', /blob:/.test(wp.csp || '')])
    checks.push(['worker CSP 仍是 connect-src none（离线承诺未破坏）',
      /connect-src 'none'/.test(wp.csp || '')])
    checks.push(['没有 CSP 违规日志（warning 级也算）',
      (r.cspViolations || []).length === 0])
    checks.push(['worker 加载期 + 转换期无 error 级日志',
      (r.workerConsoleErrors || []).length === 0])
    checks.push(['pdfjs 用的是真 module Worker（没有 fake worker 警告）',
      (r.fakeWorkerWarnings || []).length === 0])
    checks.push(['检测器自测：注入的异常确实被 console-message 捕获', r.markerCaught === true])

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
    console.error('  ' + log.split('\n').slice(-20).join('\n  '))
    if (cdp) cdp.close()
    if (child.exitCode === null) { try { child.kill() } catch (_) {} }
    process.exit(1)
  }

  let pass = 0
  for (const [name, ok] of checks) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + name)
    if (ok) pass++
  }
  console.log('\n结果：' + pass + '/' + checks.length + ' 通过')
  process.exit(pass === checks.length ? 0 : 1)
}

main()
