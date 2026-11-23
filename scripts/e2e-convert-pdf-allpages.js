'use strict'

/**
 * PDF「转换所有页面」端到端验证（npm run test:e2e:convert:pdf:allpages）。
 *
 * 跑的是**完整真链路**：真 Electron + 真格式选择窗（preload）+
 * ipcMain 'convert:run' + main-bridge opts + service + router + provider +
 * 真隐藏 worker 窗口 + 真 pdfjs + 真 canvas。
 *
 * 覆盖：
 *   1. 默认转换仍只出 1 张 PNG，且带 pdf-multipage（回归护栏，绝不许倒退）
 *   2. allPages PNG：3 页 → 3 个文件（-1/-2/-3）、魔数/IHDR/内容各异、无警告
 *   3. allPages TXT：3 页 marker 都在，页间有 "\n\n" 分隔，无警告
 *   4. 单页 PDF + allPages：仍是 a.png，无 multipage 警告
 *   5. 51 页 PDF + allPages：只出 50 个 + pdf-page-limit 警告
 *   6. service 链路：附件名带页码（a-1-<随机>.png）
 *   7. 真 UI：勾选框只对 PDF→图片/txt 可见；勾选后 convertRun 生效
 *   8. worker 全程无 console error / 无 CSP 违规
 *
 * ★ 为什么不在这里手工 new 一套 provider/router：
 *   实测在 Node inspector 的 Runtime.evaluate 上下文里 require('pdf-lib')
 *   会返回空对象（既有 e2e-convert-pdf.js 注释也记过这个 V8 抖动），
 *   导致 available() 偶发 false。改用应用自己启动时装好的服务（经 UI IPC
 *   调用），既绕开检查器bug，又顺带验证了前端选项确实传到了主进程。
 *
 * ★ 判断一律解析输出，不看 exitCode：本机 safe-delete 守卫会让退出码失真。
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
const BASE_CDP_PORT = 9465

const MARKERS = ['ALLPAGES_MARK_ONE', 'ALLPAGES_MARK_TWO', 'ALLPAGES_MARK_THREE']
const SOLO_MARK = 'ALLPAGES_SOLO_PAGE'
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

/** 现场生成带每页独立 marker 的多页 PDF（Node 侧 pdf-lib 完全可用） */
async function writePdf (dest, markers, size = 8) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const marker of markers) {
    const page = doc.addPage([400, 200])
    page.drawText(marker, { x: 20, y: 100, size, font })
  }
  fs.writeFileSync(dest, Buffer.from(await doc.save()))
}

/** 主进程里执行：开一个真格式选择窗，通过它跑全部场景 */
function buildExpr (opts) {
  return `(async () => {
   let stage = 'init'
   try {
    const getReq = ${REQUIRE_EXPR}
    const req = getReq()
    if (!req) return { ok: false, err: 'no require' }
    const path = req('path')

    // ★ 在 worker 窗口创建前挂监听：加载期的 pdfjs/CSP 问题也要抓到
    const consoleMsgs = []
    req('electron').app.on('web-contents-created', (_e, wc) => {
      try {
        wc.on('console-message', (_ev, level, message) => {
          // 只统计 worker：便签窗口的 note.html CSP 不含 sticky-att:（既有问题），
          // 会把噪声混进来；本测试关心的是 worker 没有 error。
          consoleMsgs.push({ level, message: String(message), url: wc.getURL() || '' })
        })
      } catch (_) {}
    })

    const { BrowserWindow } = req('electron')
    const srcDir = ${JSON.stringify(SRC_DIR)}
    const uiWin = new BrowserWindow({
      show: false, width: 800, height: 600,
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
    // ★ 表达式末尾必须返回值：executeJavaScript 会序列化结果，
    //   直接返回箭头函数会抛 "An object could not be cloned."
    await uiWin.webContents.executeJavaScript('window.close = () => {}; 1', true)

    const srcPdf = ${JSON.stringify(opts.srcPdf)}
    const soloPdf = ${JSON.stringify(opts.soloPdf)}
    const bigPdf = ${JSON.stringify(opts.bigPdf)}
    const partialPdf = ${JSON.stringify(opts.partialPdf)}

    /** 走真 UI 的 preload → IPC → 主进程链路执行一次转换 */
    const run = (files, target, allPages) => {
      const payload = Object.assign({ files, target })
      if (allPages !== undefined) payload.allPages = allPages
      const expr = 'window.sticky.convertRun(' + JSON.stringify(payload) + ').then(r => ({' +
        'ok:r.ok, error:r.error, reason:r.reason, ' +
        'failures:(r.failures||[]).map(f=>f.error), ' +
        'attachments:(r.attachments||[]).map(a=>({' +
        'name:a.name, path:a.path, warnings:(a.warnings||[]).map(w=>({code:w.code,message:w.message}))' +
        '})), ' +
        'warnings:(r.warnings||[]).map(w=>({code:w.code,message:w.message}))' +
        '}))'
      return uiWin.webContents.executeJavaScript(expr, true)
    }

    stage = 'ui-probe'
    // ---- UI 探测：PDF 源文件 ⇒ 勾选框可见；勾选后只对图片/txt 目标生效 ----
    uiWin.webContents.send('convert:files', [srcPdf])
    await (async () => {
      const t0 = Date.now()
      while (Date.now() - t0 < 10000) {
        const v = await uiWin.webContents.executeJavaScript(
          '(() => { const e = document.getElementById("allPages"); return !!(e && !e.hidden) })()', true)
        if (v) return
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error('勾选框没有在 PDF 场景下显示')
    })()

    const ui = await uiWin.webContents.executeJavaScript(
      '(() => { const e = document.getElementById("allPages"); e.click(); return {' +
      'visibleForPdf: !e.hidden, checked: e.checked, ' +
      'shouldPng: shouldAllPages("png"), ' +
      'shouldTxt: shouldAllPages("txt"), ' +
      'shouldPdfTarget: shouldAllPages("pdf")' +
      '} })()', true)

    stage = 'default'
    // ---- 1. 默认转换（不传 allPages）----
    const defaultOut = await run([srcPdf], 'png')

    stage = 'allpages'
    // ---- 2/3/4/5. 全页模式各场景（勾选框已勾选，且显式 allPages:true）----
    const allPng = await run([srcPdf], 'png', true)
    const allTxt = await run([srcPdf], 'txt', true)
    const single = await run([soloPdf], 'png', true)
    const limited = await run([bigPdf], 'png', true)

    // ---- 6. 真机注入「第 2 页编码失败」----
    // 不可改产品代码加测试钩子：在 worker 页把第 N 次 canvas.toBlob 打成空回调，
    // encodeImage 会返回 ok:false → provider 该页进 failures、其它页照常产出。
    // ★ 不 patch getContext：pdfjs 自己也会在 render 里取 context，容易误伤第 1 页。
    stage = 'partial-failure'
    const getWorkerWin = async () => {
      for (let i = 0; i < 100; i++) {
        const w = BrowserWindow.getAllWindows().find(x =>
          !x.isDestroyed() && /convert-worker\.html/.test(x.webContents.getURL()))
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
    const partial = await run([partialPdf], 'png', true)
    partial.blobDiag = await workerWin.webContents.executeJavaScript(
      '({calls: globalThis.__e2eBlobCalls, failAt: globalThis.__e2eFailAt})', true)
    await disarmFailure()

    ui.convertRun = {
      ok: allPng.ok,
      count: (allPng.attachments || []).length,
      names: (allPng.attachments || []).map(a => a.name)
    }

    stage = 'hide-for-png'
    // ---- 7. 换 PNG 源文件 ⇒ 勾选框必须隐藏 ----
    uiWin.webContents.send('convert:files', [
      allPng.attachments && allPng.attachments[0] ? allPng.attachments[0].path : srcPdf
    ])
    await (async () => {
      const t0 = Date.now()
      while (Date.now() - t0 < 10000) {
        const v = await uiWin.webContents.executeJavaScript(
          '(() => { const e = document.getElementById("allPages"); return !!(e && e.hidden) })()', true)
        if (v) return
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error('勾选框没有在 PNG 场景下隐藏')
    })()
    ui.hiddenForPng = true

    // ---- 8. 真 UI 点击格式卡触发部分失败，状态栏必须显示软性假成功警告 ----
    stage = 'partial-ui-status'
    uiWin.webContents.send('convert:files', [partialPdf])
    await (async () => {
      const t0 = Date.now()
      while (Date.now() - t0 < 10000) {
        const v = await uiWin.webContents.executeJavaScript(
          '(() => { const e = document.getElementById("allPages"); ' +
          'return !!(e && !e.hidden && document.querySelectorAll(".fmt").length) })()', true)
        if (v) return
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error('部分失败场景的 UI 没有准备好')
    })()
    await uiWin.webContents.executeJavaScript(
      'document.getElementById("allPages").click(); 1', true)
    await armFailure(2)
    await uiWin.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll(".fmt"))' +
      '.find(e => e.dataset.fmt === "png").click(); 1', true)
    let uiStatus = ''
    for (let i = 0; i < 100; i++) {
      uiStatus = String(await uiWin.webContents.executeJavaScript(
        'document.getElementById("status").textContent', true) || '')
      if (/成功转换 2 页，1 页失败/.test(uiStatus)) break
      await new Promise(r => setTimeout(r, 100))
    }
    ui.partialStatus = uiStatus
    ui.partialStatusClass = String(await uiWin.webContents.executeJavaScript(
      'document.getElementById("status").className', true) || '')
    await disarmFailure()

    stage = 'console-selftest'
    // ---- 检测器自测：确认 console-message 监听真的能抓到 error ----
    const isErr = (m) => m.level >= 3
    const isWorkerMsg = (m) => !m.url || /convert-worker\.html/.test(m.url)
    const errsBefore = consoleMsgs.filter(isWorkerMsg).filter(isErr).map(m => m.message)
    let markerCaught = false
    try {
      await uiWin.webContents.executeJavaScript(
        'setTimeout(() => { throw new TypeError("e2e-allpages-marker-boom") }, 0); 1', true)
      await new Promise(r => setTimeout(r, 400))
      // 自测异常注入在 UI 窗口，所以这里查全量 consoleMsgs（不按 worker 过滤）
      markerCaught = consoleMsgs
        .some(m => isErr(m) && /e2e-allpages-marker-boom/.test(m.message))
    } catch (_) {}

    uiWin.destroy()
    return {
      defaultOut, allPng, allTxt, single, limited, partial, ui,
      markerCaught,
      workerConsoleErrors: errsBefore.slice(0, 10),
      cspViolations: consoleMsgs.filter(isWorkerMsg)
        .filter(m => /Content Security Policy/i.test(m.message))
        .map(m => m.message).slice(0, 10)
    }
   } catch (err) {
     return { ok: false, stage, diag: String((err && err.stack) || err) }
   }
  })()`
}

/** 读 PNG 魔数 / IHDR / 内容指纹 */
function pngInfo (file) {
  const b = fs.readFileSync(file)
  return {
    magic: Array.from(b.slice(0, 4)),
    ihdr: b.slice(12, 16).toString('ascii'),
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
    size: b.length,
    hash: (() => {
      let h = 2166136261
      for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) }
      return h >>> 0
    })()
  }
}

async function main () {
  console.log('PDF 转换所有页面 e2e')
  const cdpPort = BASE_CDP_PORT
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-allpages-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'),
    JSON.stringify({ version: 1, notes: [], settings: {} }))

  const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-allpages-src-'))
  const srcPdf = path.join(srcRoot, 'book.pdf')
  const soloPdf = path.join(srcRoot, 'solo.pdf')
  const bigPdf = path.join(srcRoot, 'huge.pdf')
  const partialPdf = path.join(srcRoot, 'partial.pdf')
  await writePdf(srcPdf, MARKERS)
  await writePdf(soloPdf, [SOLO_MARK])
  await writePdf(bigPdf, Array.from({ length: 51 }, (_, i) => 'PAGE51_MARK_' + (i + 1)), 4)
  await writePdf(partialPdf, MARKERS)

  // 静态护栏：前端真的把 allPages 塞进 payload / HTML 里真的有勾选框
  const jsSrc = fs.readFileSync(path.join(SRC_DIR, 'convert.js'), 'utf8')
  const htmlSrc = fs.readFileSync(path.join(SRC_DIR, 'convert.html'), 'utf8')

  const env = Object.assign({}, process.env)
  // 宿主有 ELECTRON_RUN_AS_NODE=1，不删掉 spawn 出来的 electron 会变成纯 node
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
    const r = await cdp.evaluate(buildExpr({ srcPdf, soloPdf, bigPdf, partialPdf }))
    assert.ok(r && !r.err && !r.diag, '求值失败: ' + JSON.stringify(r).slice(0, 1200))

    const d = r.defaultOut || {}
    const dAtt = d.attachments || []
    checks.push(['★ 默认仍只产 1 个附件', d.ok === true && dAtt.length === 1])
    checks.push(['默认文件名仍是 book.png',
      dAtt.length === 1 && /^book\.png$/.test(dAtt[0].name)])
    checks.push(['★ 默认仍带 pdf-multipage 警告（零回归底线）',
      (d.warnings || []).some(w => w.code === 'pdf-multipage') ||
      dAtt.some(a => (a.warnings || []).some(w => w.code === 'pdf-multipage'))])

    const a = r.allPng || {}
    const aAtt = a.attachments || []
    checks.push(['allPages PNG 转换成功', a.ok === true])
    checks.push(['3 页产出 3 个 PNG', aAtt.length === 3])
    checks.push(['文件名带 -1/-2/-3（页码从 1 开始）',
      [1, 2, 3].every(n => aAtt.some(x => new RegExp('^book-' + n + '\\.png$').test(x.name)))])
    const infos = aAtt.map(x => pngInfo(x.path))
    checks.push(['每个 PNG 魔数正确',
      infos.length === 3 && infos.every(x => JSON.stringify(x.magic) === JSON.stringify(PNG_MAGIC))])
    checks.push(['每个 PNG 的 IHDR 与 400×200 尺寸正确',
      infos.every(x => x.ihdr === 'IHDR' && x.width === 400 && x.height === 200)])
    checks.push(['3 页图像内容彼此不同（不是同一页复制 3 份）',
      new Set(infos.map(x => x.hash)).size === 3])
    checks.push(['★ allPages 不再产出 pdf-multipage',
      !aAtt.some(x => (x.warnings || []).some(w => w.code === 'pdf-multipage')) &&
      !(a.warnings || []).some(w => w.code === 'pdf-multipage')])

    const t = r.allTxt || {}
    const tAtt = t.attachments || []
    const txt = tAtt.length && fs.existsSync(tAtt[0].path)
      ? fs.readFileSync(tAtt[0].path, 'utf8') : ''
    checks.push(['allPages TXT 转换成功且仍只有 1 个文件', t.ok === true && tAtt.length === 1])
    checks.push(['TXT 文件名是 book.txt（不加页码）',
      tAtt.length === 1 && /^book\.txt$/.test(tAtt[0].name)])
    checks.push(['★ TXT 含全部 3 页 marker', MARKERS.every(m => txt.includes(m))])
    checks.push(['TXT 页间有 \\n\\n 分隔',
      /ALLPAGES_MARK_ONE[\s\S]*\n\n[\s\S]*ALLPAGES_MARK_TWO[\s\S]*\n\n[\s\S]*ALLPAGES_MARK_THREE/.test(txt)])
    checks.push(['TXT 无 pdf-multipage 警告',
      !tAtt.some(x => (x.warnings || []).some(w => w.code === 'pdf-multipage'))])

    const s = r.single || {}
    const sAtt = s.attachments || []
    checks.push(['单页 PDF + allPages：仍只有 1 个 PNG', s.ok === true && sAtt.length === 1])
    checks.push(['单页 PDF + allPages：文件名是 solo.png（不是 solo-1.png）',
      sAtt.length === 1 && /^solo\.png$/.test(sAtt[0].name)])
    checks.push(['单页 PDF + allPages：无任何警告',
      !sAtt.some(x => (x.warnings || []).length) && !(s.warnings || []).length])

    const l = r.limited || {}
    const lAtt = l.attachments || []
    const limitWarns = (l.warnings || []).concat(
      ...lAtt.map(x => x.warnings || []))
    checks.push(['51 页 PDF + allPages：只出 50 个', l.ok === true && lAtt.length === 50])
    checks.push(['截断产物从 -1 到 -50',
      lAtt.some(x => /^huge-1\.png$/.test(x.name)) &&
      lAtt.some(x => /^huge-50\.png$/.test(x.name))])
    checks.push(['★ 截断时有 pdf-page-limit 警告',
      limitWarns.some(w => w.code === 'pdf-page-limit')])
    checks.push(['截断警告写明 51 页与 50 页',
      /51 页/.test(JSON.stringify(limitWarns)) && /50 页/.test(JSON.stringify(limitWarns))])
    checks.push(['截断时不发 pdf-multipage',
      !limitWarns.some(w => w.code === 'pdf-multipage')])
    checks.push(['50 个截断产物文件都真实存在',
      lAtt.every(x => fs.existsSync(x.path))])

    const p = r.partial || {}
    if (process.env.ALLPAGES_E2E_DEBUG) {
      console.error('PARTIAL DIAG ' + JSON.stringify({
        partial: p, partialStatus: r.ui && r.ui.partialStatus,
        partialStatusClass: r.ui && r.ui.partialStatusClass
      }).slice(0, 4000))
    }
    const pAtt = p.attachments || []
    const pWarns = (p.warnings || []).concat(...pAtt.map(x => x.warnings || []))
    checks.push(['★ 真机第 2 页渲染失败：转换仍成功且保留另 2 页',
      p.ok === true && pAtt.length === 2])
    checks.push(['失败页附件名带页码 1/3',
      pAtt.some(x => /^partial-1\.png$/.test(x.name)) &&
      pAtt.some(x => /^partial-3\.png$/.test(x.name))])
    checks.push(['★ 顶层 warnings 含 pdf-page-failed（真机链路）',
      pWarns.some(w => w.code === 'pdf-page-failed')])
    checks.push(['警告文案写明「成功转换 2 页，1 页失败」',
      pWarns.some(w => /成功转换 2 页，1 页失败/.test(w.message || ''))])

    const u = r.ui || {}
    checks.push(['真 UI 场景加载与探测无异常', !u.err])
    checks.push(['勾选框在 PDF 场景可见且已勾选', u.visibleForPdf === true && u.checked === true])
    checks.push(['勾选后 PNG/TXT 目标生效', u.shouldPng === true && u.shouldTxt === true])
    checks.push(['勾选后 PDF 目标（图片→PDF）不生效', u.shouldPdfTarget === false])
    checks.push(['真 UI convertRun({allPages:true}) 成功并产出 3 个附件',
      !!(u.convertRun && u.convertRun.ok === true && u.convertRun.count === 3)])
    checks.push(['★ 附件名带页码 book-1/2/3.png',
      [1, 2, 3].every(n => (aAtt || []).some(x =>
        new RegExp('^book-' + n + '\\.png$').test(x.name)))])
    checks.push(['勾选框在 PNG 源文件场景隐藏', u.hiddenForPng === true])
    checks.push(['★ 真 UI 点击格式卡后状态栏显示少页警告',
      /成功转换 2 页，1 页失败/.test(u.partialStatus || '')])
    checks.push(['状态栏是 warn 样式（不是 ok/err）',
      /(^|\s)warn(\s|$)/.test(u.partialStatusClass || '')])
    // payload 里除 allPages 外还可能有别的字段（如 P4 的 reqId），只断言 allPages 在其中
    checks.push(['前端源码把 allPages 写进 convertRun payload',
      /convertRun\(\{[^}]*\ballPages\b[^}]*\}\)/.test(jsSrc)])
    checks.push(['HTML 存在 #allPages 勾选框', /id="allPages"/.test(htmlSrc)])

    checks.push(['worker 全程无 error 级日志', (r.workerConsoleErrors || []).length === 0])
    checks.push(['无 CSP 违规日志', (r.cspViolations || []).length === 0])
    checks.push(['检测器自测：注入的异常确实被捕获', r.markerCaught === true])

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
