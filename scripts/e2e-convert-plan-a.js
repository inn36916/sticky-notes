'use strict'

/**
 * 方案 A 全链路端到端回归（npm run test:e2e:convert:plan-a）。
 *
 * 验的是**真实 Electron 运行时**：
 *   1. 开箱即用引擎清单含 builtin-document / builtin-spreadsheet / builtin-svg（不装 Filee、不放插件）
 *   2. md → pdf（marked ESM + 隔离离线 printToPDF 产出真 %PDF-）并回抽文本验证内容
 *   3. html → pdf 安全防线：<script> 不执行、严格离线 CSP 拦截外链
 *   4. pdf → md（真 2 页 PDF：默认单页含 pdf-multipage 警告，allPages 含两页内容与标题层级；空白页含 pdf-no-text-layer 警告）
 *   5. docx → md（含内嵌 PNG 提取到伴生 _assets 目录，链接有效）
 *   6. xlsx ↔ csv / json（ExcelJS 真实读写与 ZIP 魔数）
 *   7. 开箱即用 svg → png（无插件时由 builtin-svg 产出真 PNG）
 *   8. convert-worker 零 error 级日志、零 CSP 违规、真 module Worker 无 fake-worker 警告
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')
const { PDFDocument, StandardFonts } = require('pdf-lib')
const JSZip = require('jszip')
const ExcelJS = require('exceljs')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SRC_DIR = path.join(ROOT, 'src')
const CDP_PORT = 9485

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, timeout = 25000, label = '') {
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

async function writeSamplePdf (dest) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([500, 400])
  p1.drawText('PLAN_A_HEADING_ONE', { x: 40, y: 340, size: 24, font })
  p1.drawText('PLAN_A_BODY_PAGE_1 normal body paragraph text for font size baseline.', { x: 40, y: 290, size: 12, font })
  const p2 = doc.addPage([500, 400])
  p2.drawText('PLAN_A_BODY_PAGE_2 second page body content.', { x: 40, y: 300, size: 12, font })
  fs.writeFileSync(dest, Buffer.from(await doc.save()))
}

async function writeBlankPdf (dest) {
  const doc = await PDFDocument.create()
  doc.addPage([300, 200])
  fs.writeFileSync(dest, Buffer.from(await doc.save()))
}

async function writeSampleDocx (dest) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
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
    '<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
    '</Relationships>')
  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>E2E Word 文档</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>DOCXBODYMARKER</w:t></w:r></w:p>' +
    '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:blipFill><a:blip r:embed="rIdImg1"/></pic:blipFill>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
    '</w:body></w:document>')
  zip.file('word/media/image1.png', PNG_1PX)
  fs.writeFileSync(dest, await zip.generateAsync({ type: 'nodebuffer' }))
}

async function writeSampleXlsx (dest) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('SheetA')
  ws.addRow(['项目', '分数'])
  ws.addRow(['方案A', { formula: '90+9', result: 99 }])
  fs.writeFileSync(dest, Buffer.from(await wb.xlsx.writeBuffer()))
}

async function pageCount (file) {
  if (!file || !fs.existsSync(file)) return -1
  const doc = await PDFDocument.load(fs.readFileSync(file))
  return doc.getPageCount()
}

function buildExpr (opts) {
  return `(async () => {
   try {
    const getReq = ${REQUIRE_EXPR}
    const req = getReq()
    if (!req) return { ok: false, err: 'no require' }

    const fs = req('fs')
    const os = req('os')
    const path = req('path')
    const { BrowserWindow, app } = req('electron')
    const workerHostLib = req('./lib/convert/worker-host')
    const providersLib = req('./lib/convert/providers')
    const routerLib = req('./lib/convert/router')
    const serviceLib = req('./lib/convert/service')

    const workerConsoleMsgs = []
    app.on('web-contents-created', (_e, wc) => {
      try {
        wc.on('console-message', (_ev, level, message) => {
          const url = typeof wc.getURL === 'function' ? wc.getURL() : ''
          if (/convert-worker\\.html/i.test(url)) {
            workerConsoleMsgs.push({ level, message: String(message) })
          }
        })
      } catch (_) {}
    })

    const host = workerHostLib.createWorkerHost({
      BrowserWindow,
      srcDir: ${JSON.stringify(SRC_DIR)},
      log: () => {}
    })

    const workerWin = await host.ensure()
    const workerProbe = await workerWin.webContents.executeJavaScript(\`(() => ({
      hasExtractPdfStructured: typeof window.sticky.onWorkerExtractPdfStructured === 'function'
    }))()\`, true)

    const list = providersLib.createDefaultProviders({
      workerHost: host,
      appDir: ${JSON.stringify(ROOT)},
      withFilee: false,
      withPlugins: false,
      log: () => {}
    })
    const router = routerLib.createRouter({ providers: list })
    const service = serviceLib.createService({
      userDataDir: ${JSON.stringify(opts.userData)},
      router
    })

    const engines = await router.engines()
    const mkOut = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-paout-'))
    const head = (p, n) => Array.from(fs.readFileSync(p).slice(0, n))
    const pngDims = (p) => {
      const b = fs.readFileSync(p)
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
    }

    // 1. md -> pdf -> txt 验证内容真的渲染进 PDF
    const mdPdfRes = await service.convert([${JSON.stringify(opts.srcMd)}], 'pdf')
    const mdPdfPath = mdPdfRes.attachments && mdPdfRes.attachments[0] ? mdPdfRes.attachments[0].path : null
    let mdPdfText = ''
    if (mdPdfPath) {
      const backTxt = await router.convert([mdPdfPath], 'txt', mkOut())
      if (backTxt.ok && backTxt.outputs[0]) {
        mdPdfText = fs.readFileSync(backTxt.outputs[0].output, 'utf8')
      }
    }

    // 2. html -> pdf（脚本不得执行）
    const htmlPdfRes = await router.convert([${JSON.stringify(opts.srcHtml)}], 'pdf', mkOut())
    const htmlPdfPath = htmlPdfRes.outputs && htmlPdfRes.outputs[0] ? htmlPdfRes.outputs[0].output : null
    let htmlPdfText = ''
    if (htmlPdfPath) {
      const backTxt = await router.convert([htmlPdfPath], 'txt', mkOut())
      if (backTxt.ok && backTxt.outputs[0]) {
        htmlPdfText = fs.readFileSync(backTxt.outputs[0].output, 'utf8')
      }
    }

    // 3. pdf -> md（默认单页 + allPages + 空白扫描件）
    const pdfMdSingle = await router.convert([${JSON.stringify(opts.srcPdf)}], 'md', mkOut())
    const pdfMdAll = await router.convert([${JSON.stringify(opts.srcPdf)}], 'md', mkOut(), { allPages: true })
    const pdfMdBlank = await router.convert([${JSON.stringify(opts.blankPdf)}], 'md', mkOut())

    // 4. docx -> md（含内嵌 PNG 提取到伴生 _assets）
    const docxMd = await service.convert([${JSON.stringify(opts.srcDocx)}], 'md')

    // 5. xlsx -> json & csv -> xlsx
    const xlsxJson = await router.convert([${JSON.stringify(opts.srcXlsx)}], 'json', mkOut())
    const csvXlsx = await router.convert([${JSON.stringify(opts.srcCsv)}], 'xlsx', mkOut())

    // 6. 开箱即用 svg -> png（无插件走 builtin-svg）
    const svgPng = await router.convert([${JSON.stringify(opts.srcSvg)}], 'png', mkOut())

    host.dispose()

    return {
      ok: true,
      engines,
      workerProbe,
      mdPdf: {
        ok: mdPdfRes.ok,
        path: mdPdfPath,
        magic: mdPdfPath ? head(mdPdfPath, 5) : null,
        text: mdPdfText
      },
      htmlPdf: {
        ok: htmlPdfRes.ok,
        path: htmlPdfPath,
        magic: htmlPdfPath ? head(htmlPdfPath, 5) : null,
        text: htmlPdfText
      },
      pdfMdSingle: {
        ok: pdfMdSingle.ok,
        provider: pdfMdSingle.provider,
        text: pdfMdSingle.outputs && pdfMdSingle.outputs[0] ? fs.readFileSync(pdfMdSingle.outputs[0].output, 'utf8') : '',
        warnings: pdfMdSingle.outputs && pdfMdSingle.outputs[0] ? (pdfMdSingle.outputs[0].warnings || []) : []
      },
      pdfMdAll: {
        ok: pdfMdAll.ok,
        text: pdfMdAll.outputs && pdfMdAll.outputs[0] ? fs.readFileSync(pdfMdAll.outputs[0].output, 'utf8') : '',
        warnings: pdfMdAll.outputs && pdfMdAll.outputs[0] ? (pdfMdAll.outputs[0].warnings || []) : []
      },
      pdfMdBlank: {
        ok: pdfMdBlank.ok,
        warnings: pdfMdBlank.outputs && pdfMdBlank.outputs[0] ? (pdfMdBlank.outputs[0].warnings || []) : []
      },
      docxMd: {
        ok: docxMd.ok,
        provider: docxMd.provider,
        att: docxMd.attachments && docxMd.attachments[0] ? {
          path: docxMd.attachments[0].path,
          assetsDir: docxMd.attachments[0].assetsDir,
          text: fs.readFileSync(docxMd.attachments[0].path, 'utf8')
        } : null
      },
      xlsxJson: {
        ok: xlsxJson.ok,
        provider: xlsxJson.provider,
        data: xlsxJson.outputs && xlsxJson.outputs[0] ? JSON.parse(fs.readFileSync(xlsxJson.outputs[0].output, 'utf8')) : null
      },
      csvXlsx: {
        ok: csvXlsx.ok,
        provider: csvXlsx.provider,
        magic: csvXlsx.outputs && csvXlsx.outputs[0] ? head(csvXlsx.outputs[0].output, 4) : null
      },
      svgPng: {
        ok: svgPng.ok,
        provider: svgPng.provider,
        magic: svgPng.outputs && svgPng.outputs[0] ? head(svgPng.outputs[0].output, 4) : null,
        dims: svgPng.outputs && svgPng.outputs[0] ? pngDims(svgPng.outputs[0].output) : null
      },
      workerConsoleErrors: workerConsoleMsgs.filter(m => m.level >= 3).map(m => m.message),
      cspViolations: workerConsoleMsgs.filter(m => /Content Security Policy/i.test(m.message)).map(m => m.message),
      fakeWorkerWarnings: workerConsoleMsgs.filter(m => /fake worker/i.test(m.message)).map(m => m.message)
    }
   } catch (err) {
    return { ok: false, diag: String((err && err.stack) || err) }
   }
  })()`
}

async function main () {
  console.log('方案 A 全链路 e2e')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-plana-ud-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'),
    JSON.stringify({ version: 1, notes: [], settings: {} }))

  const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-plana-src-'))
  const srcMd = path.join(srcRoot, 'guide.md')
  fs.writeFileSync(srcMd, '# Plan A Guide\n\nPLAN_A_MD_PDF_MARKER\n\n| Key | Val |\n| --- | --- |\n| Ok | Yes |\n', 'utf8')

  const srcHtml = path.join(srcRoot, 'unsafe.html')
  fs.writeFileSync(srcHtml,
    '<!DOCTYPE html><html><body><p>SAFE_STATIC_CONTENT</p>' +
    '<script>document.body.innerHTML="SCRIPT_EXECUTED_PWN"</script>' +
    '<img src="http://127.0.0.1:1/blocked.png" /></body></html>', 'utf8')

  const srcPdf = path.join(srcRoot, 'two-pages.pdf')
  await writeSamplePdf(srcPdf)

  const blankPdf = path.join(srcRoot, 'scan.pdf')
  await writeBlankPdf(blankPdf)

  const srcDocx = path.join(srcRoot, 'report.docx')
  await writeSampleDocx(srcDocx)

  const srcXlsx = path.join(srcRoot, 'sheet.xlsx')
  await writeSampleXlsx(srcXlsx)

  const srcCsv = path.join(srcRoot, 'table.csv')
  fs.writeFileSync(srcCsv, 'col1,col2\nv1,v2\n', 'utf8')

  const srcSvg = path.join(srcRoot, 'badge.svg')
  fs.writeFileSync(srcSvg, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2f6fed"/></svg>', 'utf8')

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
  try {
    const inspectorUrl = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 25000, 'inspector')
    await waitFor(async () => log.includes('[boot] 托盘就绪') ? true : null, 25000, '启动完成')

    cdp = new CDP(inspectorUrl)
    await cdp.connect()
    const r = await cdp.evaluate(buildExpr({
      userData, srcMd, srcHtml, srcPdf, blankPdf, srcDocx, srcXlsx, srcCsv, srcSvg
    }))
    assert.ok(r && r.ok && !r.diag, '求值失败: ' + JSON.stringify(r))

    const engOk = (id) => (r.engines || []).some(e => e.id === id && e.available === true)
    checks.push(['引擎清单含 builtin-document 且可用', engOk('builtin-document')])
    checks.push(['引擎清单含 builtin-spreadsheet 且可用', engOk('builtin-spreadsheet')])
    checks.push(['引擎清单含 builtin-svg 且可用', engOk('builtin-svg')])
    checks.push(['worker 已注册 onWorkerExtractPdfStructured', !!(r.workerProbe && r.workerProbe.hasExtractPdfStructured)])

    const mdPdfPages = await pageCount(r.mdPdf.path)
    checks.push(['md → pdf 成功且为 %PDF-', r.mdPdf.ok && JSON.stringify(r.mdPdf.magic) === JSON.stringify(PDF_MAGIC)])
    checks.push(['md → pdf 页数 ≥ 1 且含原文', mdPdfPages >= 1 && r.mdPdf.text.includes('PLAN_A_MD_PDF_MARKER')])

    checks.push(['html → pdf 成功且为 %PDF-', r.htmlPdf.ok && JSON.stringify(r.htmlPdf.magic) === JSON.stringify(PDF_MAGIC)])
    checks.push(['html → pdf 保留静态文本且未执行 <script>',
      r.htmlPdf.text.includes('SAFE_STATIC_CONTENT') && !r.htmlPdf.text.includes('SCRIPT_EXECUTED_PWN')])

    checks.push(['pdf → md 由 builtin-document 处理', r.pdfMdSingle.ok && r.pdfMdSingle.provider === 'builtin-document'])
    checks.push(['pdf → md 单页识别标题与正文且带 pdf-multipage',
      r.pdfMdSingle.text.includes('# PLAN_A_HEADING_ONE') &&
      r.pdfMdSingle.text.includes('PLAN_A_BODY_PAGE_1') &&
      !r.pdfMdSingle.text.includes('PLAN_A_BODY_PAGE_2') &&
      (r.pdfMdSingle.warnings || []).some(w => w.code === 'pdf-multipage')])
    checks.push(['pdf → md allPages 包含第 1/2 页且无 multipage 警告',
      r.pdfMdAll.ok &&
      r.pdfMdAll.text.includes('PLAN_A_BODY_PAGE_1') &&
      r.pdfMdAll.text.includes('PLAN_A_BODY_PAGE_2') &&
      !(r.pdfMdAll.warnings || []).some(w => w.code === 'pdf-multipage')])
    checks.push(['pdf → md 空白 PDF 触发 pdf-no-text-layer 警告',
      r.pdfMdBlank.ok && (r.pdfMdBlank.warnings || []).some(w => w.code === 'pdf-no-text-layer')])

    const extractedImg = r.docxMd.att && r.docxMd.att.assetsDir
      ? path.join(r.docxMd.att.assetsDir, 'image-1.png') : ''
    checks.push(['docx → md 含文本与有效伴生 PNG',
      !!(r.docxMd.ok && r.docxMd.att &&
        r.docxMd.att.text.includes('DOCXBODYMARKER') &&
        r.docxMd.att.text.includes('report_assets/image-1.png') &&
        extractedImg && fs.existsSync(extractedImg) &&
        fs.readFileSync(extractedImg).equals(PNG_1PX))])

    checks.push(['xlsx → json 真实公式与内容正确',
      r.xlsxJson.ok && r.xlsxJson.provider === 'builtin-spreadsheet' &&
      Array.isArray(r.xlsxJson.data) && r.xlsxJson.data[0]['项目'] === '方案A' && r.xlsxJson.data[0]['分数'] === 99])
    checks.push(['csv → xlsx 产出真实 ZIP',
      r.csvXlsx.ok && r.csvXlsx.provider === 'builtin-spreadsheet' &&
      JSON.stringify(r.csvXlsx.magic) === JSON.stringify(ZIP_MAGIC)])

    checks.push(['开箱即用 svg → png 走 builtin-svg 且为 32×32 真 PNG',
      r.svgPng.ok && r.svgPng.provider === 'builtin-svg' &&
      JSON.stringify(r.svgPng.magic) === JSON.stringify(PNG_MAGIC) &&
      !!r.svgPng.dims && r.svgPng.dims.width === 32 && r.svgPng.dims.height === 32])

    checks.push(['worker 无 error 级控制台日志', (r.workerConsoleErrors || []).length === 0])
    checks.push(['worker 无 CSP 违规', (r.cspViolations || []).length === 0])
    checks.push(['pdfjs 使用真 module Worker（无 fake worker 警告）', (r.fakeWorkerWarnings || []).length === 0])

    const quit = await cdp.evaluate(QUIT_EXPR)
    assert.ok(quit && quit.ok, 'app.quit() 失败: ' + JSON.stringify(quit))
    cdp.close()
    cdp = null

    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode) return true
      await sleep(150)
      return false
    }, 20000, '进程退出').catch(() => {})
    checks.push(['进程走 app.quit() 正常退出', child.exitCode === 0])
  } finally {
    if (cdp) cdp.close()
    if (child.exitCode === null && !child.signalCode) {
      try { child.kill() } catch (_) {}
    }
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) {}
    try { fs.rmSync(srcRoot, { recursive: true, force: true }) } catch (_) {}
  }

  let pass = 0
  for (const [label, ok] of checks) {
    if (ok) pass++
    console.log((ok ? '  ✓ ' : '  ✗ ') + label)
  }
  console.log(`\n结果：${pass}/${checks.length} 通过`)
  process.exit(pass === checks.length ? 0 : 1)
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
