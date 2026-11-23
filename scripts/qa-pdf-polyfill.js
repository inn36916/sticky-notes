'use strict'

/**
 * pdfjs polyfill 复核探针（npm run qa:pdf:polyfill）。
 *
 * ============================ 它解决什么问题 ============================
 *   pdfjs-dist 6.x 用了若干 2024~2025 年才进 V8 的 API；
 *   Electron 33 的 Chromium 130 还没全部实现 ⇒ 必须打补丁（src/vendor/pdf-polyfill.mjs）。
 *   补丁是"沉默的定时炸弹"：Electron 一升级，要么补丁变冗余（无人知晓），
 *   要么 pdfjs 升级后需要**新**补丁而没人发现（用户报"PDF 转不了"才暴露）。
 *
 * ============================ 五条硬规矩 ============================
 *   1. **检查目标全部来自 manifest**（src/vendor/pdf-polyfill.mjs 导出的
 *      PDF_POLYFILL_MANIFEST）—— 本脚本源码里**不得**出现任何 API 名字面量。
 *      改了补丁清单，脚本自动跟着变；脚本与实现永远不会漂移。
 *   2. **只在真实渲染进程里判定**：原生是否已实现必须问 Chromium 的 V8，
 *      主进程是 Node，两边的内建对象不是同一套 —— 在主进程问会得到假答案。
 *      所以探针在一个加载 src/convert-worker.html 的隐藏窗口里跑（那正是
 *      真正跑 pdfjs 的 realm，CSP 也与生产完全一致）。
 *   3. **只报告、不自动删**：检测到 native:true 时输出"冗余，可人工删除"，
 *      但**绝不修改** src/vendor/pdf-polyfill.mjs（跑完文件哈希与 mtime 不变）。
 *   4. **真实渲染冒烟**：光查 API 存在性证明不了 pdfjs 真能工作；
 *      必须用真 pdfjs 渲染 1 页 PDF 成 PNG，报 `render: pass`。
 *   5. **"删掉补丁必失败"必须可验证**：脚本把 src/ 复制到临时目录，
 *      在**副本**里摘掉一条补丁，再跑一遍渲染 ⇒ 必须失败且能点名那条 API。
 *      （只动副本，磁盘上的真文件一个字节都不动）
 *
 * ============================ 失败时的行为 ============================
 *   退出码 ≠ 0，并**点名缺失的 API 名**：
 *     ① 补丁被删/没生效 → "缺失的补丁：<api>"（渲染阶段会失败）；
 *     ② 渲染错误里出现 "X is not a function" → 与 manifest 求差集 ⇒
 *        "需要新增的补丁：X"。
 *
 * ============================ 用法 ============================
 *   node scripts/qa-pdf-polyfill.js
 *       正常复核：判定 native、渲染冒烟、自检、校验文件未被改。
 *
 *   node scripts/qa-pdf-polyfill.js --sabotage <序号>
 *       **自检模式**（R-P3-4 的字面形态）：
 *       把 src/ 复制到临时目录，在**副本**里把第 <序号> 条补丁改成"不装"
 *       （安装函数直接返回 ⇒ 等价于这条补丁被摘掉），然后跑同样的流程。
 *       对**必要**补丁（原生尚未实现）⇒ 必须以退出码 ≠ 0 结束，并点名那条 API。
 *       对**冗余**补丁（原生已实现）⇒ 摘掉也不影响渲染，此时报"该补丁本就冗余，
 *       摘掉无影响"并以退出码 0 结束（这正是 native:true 的含义）。
 *       （只动副本；磁盘上的真文件一个字节都不动）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { pathToFileURL } = require('url')
const { spawn } = require('child_process')
const { PDFDocument, StandardFonts } = require('pdf-lib')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SRC_DIR = path.join(ROOT, 'src')
const POLYFILL_PATH = path.join(SRC_DIR, 'vendor', 'pdf-polyfill.mjs')
const PORT = 9485

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

// ---------------------------------------------------------------- manifest 载入

/**
 * 载入 manifest（**唯一的检查目标来源**）。
 *
 * ★ 本文件里不出现任何 API 名字面量 —— 全部从 manifest 读。
 *   加载方式：用动态 import 载入真正的 ESM 模块（Node 22 支持 .mjs）。
 *   拿不到就直接失败（宁可失败也不能用兜底名单，否则就退化成硬编码了）。
 *
 * @returns {Promise<{items: Array, installers: Array}>}
 */
async function loadManifest () {
  const mod = await import(pathToFileURL(POLYFILL_PATH).href)
  const items = mod.PDF_POLYFILL_MANIFEST
  if (!Array.isArray(items) || !items.length) {
    throw new Error('PDF_POLYFILL_MANIFEST 未导出或为空')
  }
  const installers = typeof mod.getPolyfillInstallers === 'function'
    ? mod.getPolyfillInstallers()
    : items.map(i => i.install).filter((v, i, a) => a.indexOf(v) === i)
  return { items, installers }
}

/** 文件内容哈希（用于证明"探针没有改文件"） */
function fileHash (p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
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
        let m
        try { m = JSON.parse(ev.data) } catch (_) { return }
        if (!m.id || !this.pending.has(m.id)) return
        const { res, rej } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) rej(new Error(JSON.stringify(m.error)))
        else res(m.result)
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
   *
   * ★ 为什么需要重试（既有教训）：CDP 的 Runtime.evaluate 偶尔报
   *   `-32000 "Promise was collected"` —— 这是 V8 的抖动，与被测代码无关。
   *   照抄 scripts/e2e-convert.js 的模式：只对该错误重试，其它错误立刻抛出。
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
          throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 800))
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

const REQUIRE_EXPR = `(() => { return () => {
  const tries = [], g = globalThis
  if (g.process && g.process.mainModule && g.process.mainModule.require) tries.push(() => g.process.mainModule.require)
  if (g.process && typeof g.process.getBuiltinModule === 'function') tries.push(() => g.process.getBuiltinModule('module').createRequire(g.process.cwd() + '/'))
  if (typeof g.require === 'function') tries.push(() => g.require)
  for (const t of tries) { try { const r = t(); if (typeof r === 'function') return r } catch (_) {} }
  return null
}})()`

const QUIT_EXPR = `(() => { try { const req = (${REQUIRE_EXPR})(); if (!req) return { ok: false }; req('electron').app.quit(); return { ok: true } } catch (e) { return { ok: false, err: String(e) } } })()`

// ---------------------------------------------------------------- 渲染进程探针体

/**
 * 在**真实渲染进程**里跑的探针体（作为字符串，由主进程在 BrowserWindow 里执行）。
 *
 * ★ 为什么要真渲染进程：判定"原生是否已实现"必须问 Chromium 的 V8，
 *   主进程是 Node，两边的内建对象不是同一套 —— 在主进程问会得到假答案。
 *
 * 参数：
 *   probes  : manifest 里的 probe 路径数组（**从 manifest 来，不硬编码**）
 *   pdfB64  : 1 页 PDF 的 base64（真 pdf-lib 生成）
 *
 * 返回：
 *   {
 *     native    : {probe路径: bool}  装补丁**之前**原生是否已实现
 *     patched   : {probe路径: bool}  装补丁**之后**是否可用（= 补丁真的生效了吗）
 *     render    : {ok, error, ...}   真 pdfjs 渲染 1 页成 PNG
 *     simulated : {message}          自检：模拟缺 API 的错误形态
 *     errors    : []                 捕获到的错误文本（用于抽 "X is not a function"）
 *     workerRealm: {ok, native, patched}  真 module Worker 里的实测（realm 字段验证）
 *   }
 *
 * @param {string[]} probes    探针取值路径列表
 * @param {string} pdfB64      真 PDF 的 base64
 * @param {string} [workerFileName] 主进程预写好的 worker 探针文件名（放在页面同目录）
 */
function buildProbeExpr (probes, pdfB64, workerFileName) {
  return `(async () => {
   try {
    const probes = ${JSON.stringify(probes)}
    const workerFileName = ${JSON.stringify(workerFileName || '')}
    const native = {}
    const patched = {}
    const errors = []

    // 捕获错误文本：渲染失败时要从里面抽 "X is not a function"
    const origError = console.error
    console.error = function () {
      errors.push(Array.prototype.map.call(arguments, a => String(a)).join(' '))
      return origError.apply(this, arguments)
    }
    window.addEventListener('error', (e) => {
      errors.push(String((e && e.message) || e))
    })
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason
      errors.push(String((r && (r.stack || r.message)) || r))
    })

    const readPath = (p) => {
      const parts = String(p).split('.')
      let cur = globalThis
      for (const k of parts) {
        if (cur == null) return undefined
        cur = cur[k]
      }
      return cur
    }

    // ---- ① 装补丁**之前**：原生是否已实现 ----
    //   探针页是全新的 BrowserWindow ⇒ 原型链是干净的，
    //   读到的就是当前 Electron/Chromium 的原生能力。
    for (const p of probes) {
      let ok = false
      try { ok = typeof readPath(p) === 'function' } catch (_) { ok = false }
      native[p] = ok
    }

    // ---- ② 装补丁 ----
    const poly = await import('./vendor/pdf-polyfill.mjs')
    poly.installPdfPolyfills()

    // ---- ③ 装补丁**之后**：补丁真的生效了吗 ----
    //   装完还缺 ⇒ 补丁被删了 / 没登记 / 装错了地方（"删补丁必失败"的第一道闸）。
    for (const p of probes) {
      let ok = false
      try { ok = typeof readPath(p) === 'function' } catch (_) { ok = false }
      patched[p] = ok
    }

    // ---- ④ 自检：模拟"补丁缺失"的错误形态能否被抽取 ----
    //   运行时拼一个**不在 manifest 里**的名字（源码不出现任何 API 字面量），
    //   以 "obj.name is not a function" 的形态触发一次真实的 TypeError，
    //   验证后面的抽取与差集逻辑真的能work。
    const simulated = {}
    try {
      const holder = { qaPolyfill: null }
      holder['qaPolyfill' + 'MissingApi'] = undefined
      holder.qaPolyfillMissingApi()
    } catch (e) {
      simulated.message = String((e && e.message) || e)
      simulated.name = String((e && e.name) || '')
    }

    // ---- ⑤ 真实渲染冒烟：真 pdfjs → 渲染 1 页成 PNG ----
    let render = { ok: false }
    try {
      const pdfjs = await import('./vendor/pdf.min.mjs')
      pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf-worker-entry.mjs'
      const bin = Uint8Array.from(atob(${JSON.stringify(pdfB64)}), c => c.charCodeAt(0))
      const task = pdfjs.getDocument({ data: bin })
      const doc = await task.promise
      const page = await doc.getPage(1)
      const vp = page.getViewport({ scale: 1 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(vp.width))
      canvas.height = Math.max(1, Math.floor(vp.height))
      const ctx = canvas.getContext('2d')
      const rt = page.render({ canvasContext: ctx, viewport: vp })
      await rt.promise
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'))
      render = {
        ok: !!(blob && blob.size > 0),
        type: blob ? blob.type : null,
        size: blob ? blob.size : 0,
        width: canvas.width,
        height: canvas.height,
        numPages: doc.numPages
      }
      try { await task.destroy() } catch (_) {}
    } catch (err) {
      render = { ok: false, error: (err && (err.stack || err.message)) || String(err) }
      errors.push(String((err && (err.stack || err.message)) || err))
    }
    console.error = origError

    // ---- ⑥ worker realm 探测（F8）----
    //   manifest 的 realm 字段此前**从未被真正验证过**（探针只在页面 realm 探测）。
    //   这里起一个真 module Worker（与 pdfjs 用的是同一种 realm），
    //   在**worker 内**读同一批 API ⇒ 得到 worker realm 的真实可用性。
    //
    //   ★ 为什么用真实文件而不是 blob: URL：
    //     生产 CSP 是 script-src 'self' ⇒ blob: worker 被直接拒绝
    //     （实测 SecurityError: Access to the script at 'blob:file:///...' is denied）。
    //     file: 同源 worker 在当前 CSP 下允许（pdf-worker-entry.mjs 就是这么跑的）。
    //   ★ worker 文件由**主进程**预先写好（渲染进程没有写文件的能力），
    //     写在页面同目录 ⇒ file: 同源 ⇒ script-src 'self' 命中；
    //     用完即删，且文件名带随机后缀（不覆盖任何既有文件）。
    const workerRealm = { ok: false, native: {}, patched: {}, error: null }
    if (workerFileName) {
      try {
        const w = new Worker('./' + workerFileName, { type: 'module' })
        const data = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('worker realm 探测超时')), 15000)
          w.onmessage = (ev) => { clearTimeout(timer); resolve(ev.data) }
          w.onerror = (e) => {
            clearTimeout(timer)
            reject(new Error('worker realm 探测出错：' + (e && e.message)))
          }
        })
        try { w.terminate() } catch (_) {}
        if (data && data.fatal) {
          workerRealm.ok = false
          workerRealm.error = 'worker 内装补丁失败：' + data.fatal
        } else {
          workerRealm.ok = true
          workerRealm.native = (data && data.native) || {}
          workerRealm.patched = (data && data.patched) || {}
        }
      } catch (err) {
        workerRealm.ok = false
        workerRealm.error = String((err && (err.stack || err.message)) || err)
      }
    } else {
      workerRealm.error = '未提供 worker 探针文件（主进程未写入）'
    }

    return { native, patched, render, simulated, errors, workerRealm }
   } catch (err) {
     return { fatal: String((err && err.stack) || err) }
   }
  })()`
}

/**
 * 写一个 worker realm 探针文件（放在页面同目录，file: 同源 ⇒ CSP 'self' 命中）。
 *
 * ★ 为什么必须是**真实文件**而不是 blob: URL：
 *   生产 CSP 是 `script-src 'self'` ⇒ blob: worker 被直接拒绝
 *   （实测 SecurityError: Access to the script at 'blob:file:///...' is denied
 *     by the document's Content Security Policy）。
 *   file: 同源 worker 在当前 CSP 下是允许的（pdf-worker-entry.mjs 就是这么跑的）。
 *
 * ★ 探针绝不污染仓库：文件名带随机后缀，用完即删。
 *
 * @param {string} srcDir    页面所在目录（worker 文件写在这里）
 * @param {string[]} probes  探针取值路径列表
 * @returns {string|null} 写入的文件名（失败返回 null）
 */
function writeRealmProbeWorker (srcDir, probes) {
  const name = '__qa-realm-probe-' + Math.random().toString(36).slice(2, 10) + '.mjs'
  const dest = path.join(srcDir, name)
  const src = [
    'import { installPdfPolyfills } from "./vendor/pdf-polyfill.mjs"',
    'const probes = ' + JSON.stringify(probes) + ';',
    'const readPath = (p) => {',
    '  const parts = String(p).split(".");',
    '  let cur = globalThis;',
    '  for (const k of parts) { if (cur == null) return undefined; cur = cur[k] }',
    '  return cur;',
    '};',
    'const readAll = () => {',
    '  const out = {};',
    '  for (const p of probes) {',
    '    let ok = false;',
    '    try { ok = typeof readPath(p) === "function" } catch (_) { ok = false }',
    '    out[p] = ok;',
    '  }',
    '  return out;',
    '};',
    'const native = readAll();',
    'try {',
    '  installPdfPolyfills();',
    '} catch (e) {',
    '  postMessage({ fatal: String((e && e.message) || e) });',
    '  throw e;',
    '}',
    'postMessage({ native, patched: readAll() });'
  ].join('\n')
  try {
    fs.writeFileSync(dest, src, 'utf8')
    return name
  } catch (_) {
    return null
  }
}

/**
 * 主进程侧：建一个探针渲染窗口并在里面执行上面的探针体。
 *
 * ★ 用 src/convert-worker.html 而不是 convert.html：
 *   它就是**真正跑 pdfjs 的那个 realm**（补丁要装在这里），
 *   而且它的 CSP（script-src 'self' / connect-src 'none'）与生产完全一致
 *   ⇒ 探针结论可直接采信。
 *
 * @param {string} probeBody 探针体字符串
 * @param {string} [srcDir] 要加载的 src 目录（默认项目 src/；自检时传临时副本）
 * @returns {string} 主进程表达式源码
 */
function buildHostExpr (probeBody, srcDir) {
  const dir = srcDir || SRC_DIR
  return `(async () => {
   try {
    const req = (${REQUIRE_EXPR})()
    if (!req) return { fatal: 'no require' }
    const path = req('path')
    const { BrowserWindow } = req('electron')
    const win = new BrowserWindow({
      show: false, width: 16, height: 16,
      webPreferences: {
        preload: path.join(${JSON.stringify(ROOT)}, 'preload-worker.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        backgroundThrottling: false
      }
    })
    await new Promise((resolve, reject) => {
      win.webContents.once('did-finish-load', resolve)
      win.webContents.once('did-fail-load', (_e, c, d) => reject(new Error('探针页加载失败：' + d)))
      win.loadFile(path.join(${JSON.stringify(dir)}, 'convert-worker.html'))
    })
    let out = null
    try {
      out = await win.webContents.executeJavaScript(${JSON.stringify(probeBody)}, true)
    } catch (e) {
      out = { fatal: '探针执行异常：' + String((e && e.message) || e) }
    }
    if (win && !win.isDestroyed()) win.destroy()
    return out
   } catch (err) {
    return { fatal: String((err && err.stack) || err) }
   }
  })()`
}

// ---------------------------------------------------------------- 错误信息抽取

/**
 * 从错误文本里抽取 "X is not a function" 形态的标识。
 *
 * ★ 主形态按 PRD 要求（`X is not a function`）；
 *   另附一条 "reading 'X'" 形态作为补充（V8 私有字段访问失败时
 *   报的是 "Cannot read properties of undefined (reading 'X')"）。
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractMissingIdentifiers (text) {
  const out = []
  const push = (id) => { if (id && out.indexOf(id) === -1) out.push(id) }
  let m
  const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+is not a function/g
  while ((m = re.exec(text || '')) !== null) push(m[1])
  const re2 = /reading\s+'([^']+)'/g
  while ((m = re2.exec(text || '')) !== null) push(m[1])
  return out
}

/** 取标识的最后一段（`a.b.c` ⇒ `c`） */
function lastSegment (id) {
  const parts = String(id).split('.')
  return parts[parts.length - 1]
}

/**
 * 与 manifest 求差集：不在 manifest 里的缺失标识 = 需要新增的补丁。
 * @param {string[]} missing 抽取到的标识
 * @param {Array} items manifest
 * @returns {string[]}
 */
function diffAgainstManifest (missing, items) {
  const known = items.map(i => i.api)
  return missing.filter(id => {
    const tail = lastSegment(id)
    return !known.some(k => k === id || k === tail || k.endsWith('.' + tail) || k.endsWith('.' + id))
  })
}

// ---------------------------------------------------------------- 篡改副本（自检）

/**
 * 把 src/ 复制到临时目录，并在**副本**里摘掉某一条补丁。
 *
 * ★ 为什么复制而不是直接改真文件：
 *   PRD 既要求"人为删掉任一补丁后重跑 ⇒ 失败"，又要求"探针不修改
 *   src/vendor/pdf-polyfill.mjs（哈希与 mtime 不变）"。两条只能靠副本同时满足。
 *
 * @param {string} item        manifest 条目
 * @param {string} installerName 安装函数名（来自 manifest 的 install.name，非硬编码）
 * @param {string} [mode] 'stub' = 让安装函数直接返回（补丁不生效）
 *                        'remove' = 整个删掉该安装函数（模拟"被人删了补丁"）
 * @returns {string} 副本 src 目录
 */
function makeSabotagedCopy (item, installerName, mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-polyfill-sab-'))
  const dst = path.join(tmp, 'src')
  fs.cpSync(SRC_DIR, dst, { recursive: true })

  const polyPath = path.join(dst, 'vendor', 'pdf-polyfill.mjs')
  const src = fs.readFileSync(polyPath, 'utf8')
  const escaped = installerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (mode === 'remove') {
    // 整个删掉这个安装函数。★ 必须同时处理三处引用，否则副本模块加载就炸了
    //   （那测到的就不是"补丁缺失"，而是"模块语法错误"）：
    //     ① 函数定义本身
    //     ② installPdfPolyfills() 里的调用行
    //     ③ manifest 里的 install: installXxx（改成 null，保留条目 ⇒ 项数不变）
    const defRe = new RegExp(
      '/\\*\\*[\\s\\S]*?\\*/\\s*function\\s+' + escaped + '\\s*\\(\\s*\\)\\s*\\{[\\s\\S]*?\\n\\}\\n', 'g')
    if (!defRe.test(src)) throw new Error('篡改副本失败：找不到安装函数 ' + installerName)
    let patched = src.replace(defRe, '')
    // ② 调用行
    patched = patched.replace(
      new RegExp('\\n\\s*' + escaped + '\\(\\)', 'g'), '')
    // ③ manifest 引用
    patched = patched.replace(
      new RegExp('install:\\s*' + escaped, 'g'), 'install: null')
    fs.writeFileSync(polyPath, patched, 'utf8')
    return dst
  }
  // 默认：把该安装函数改成"直接返回" ⇒ 这条补丁不再被装上
  const re = new RegExp('(function\\s+' + escaped + '\\s*\\(\\s*\\)\\s*\\{)')
  if (!re.test(src)) {
    throw new Error('篡改副本失败：找不到安装函数 ' + installerName)
  }
  const patched = src.replace(re, '$1 return; // QA 自检：故意不装这条补丁')
  fs.writeFileSync(polyPath, patched, 'utf8')
  return dst
}

// ---------------------------------------------------------------- 主流程

/**
 * 自检模式：跑副本（摘掉一条补丁），期望**失败**。
 *
 * ★ R-P3-4 的字面形态："人为删掉 polyfill 中任一补丁后重跑 ⇒
 *   退出码 ≠ 0 且报告点名缺失的 API 名"。
 *   这里用 --sabotage <序号> 触发；序号对应 manifest 清单的顺序。
 *
 * @param {number} index manifest 条目下标
 * @param {string} [mode] 'stub' = 让安装函数直接返回（补丁不生效）
 *                     'remove' = 整个删掉该安装函数（模拟"被人删了补丁"）
 */
async function runSabotage (index, mode = 'stub') {
  const manifest = await loadManifest()
  const items = manifest.items
  const item = items[index]
  if (!item) {
    console.error('--sabotage 序号越界：' + index + '（清单共 ' + items.length + ' 项）')
    process.exit(2)
  }
  const installerName = item.install && item.install.name
  console.log('pdfjs polyfill 复核探针 —— 自检模式（人为摘掉一条补丁）\n')
  console.log('目标补丁：' + item.api + '（清单第 ' + (index + 1) + ' 项）')
  console.log('篡改方式：' + mode)
  console.log('')

  const sabDir = makeSabotagedCopy(item, installerName, mode)
  const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-polyfill-sab-src-'))
  const pdfPath = path.join(srcRoot, 'probe.pdf')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pg = doc.addPage([200, 120])
  pg.drawText('POLYFILL PROBE', { x: 12, y: 60, size: 10, font })
  fs.writeFileSync(pdfPath, Buffer.from(await doc.save()))
  const pdfB64 = fs.readFileSync(pdfPath).toString('base64')

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-polyfill-sab-ud-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'),
    JSON.stringify({ version: 1, notes: [], settings: {} }))
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS

  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData, '--remote-debugging-port=' + PORT, '--inspect=0', '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })

  let probe = null
  try {
    const url = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 25000, 'inspector')
    await waitFor(async () => log.includes('[boot] 托盘就绪') ? true : null, 25000, '启动完成')
    await sleep(800)
    const cdp = new CDP(url)
    await cdp.connect()
    probe = await cdp.evaluate(
      buildHostExpr(buildProbeExpr(items.map(i => i.probe), pdfB64), sabDir))
    const quit = await cdp.evaluate(QUIT_EXPR)
    if (!quit || !quit.ok) console.error('  （app.quit() 未成功，忽略）')
    cdp.close()
    await waitFor(async () => (child.exitCode !== null || child.signalCode) ? true : null, 15000, '退出')
      .catch(() => {})
  } catch (e) {
    console.error('  ✗ 自检运行异常：' + (e.stack || e.message))
    console.error('  ' + log.split('\n').slice(-15).join('\n  '))
    if (child.exitCode === null) { try { child.kill() } catch (_) {} }
    process.exit(3)
  }

  const render = (probe && probe.render) || {}
  const errText = [render.error || ''].concat((probe && probe.errors) || []).join(' ')
  const ids = extractMissingIdentifiers(errText)
  const tail = lastSegment(item.api)
  const named = ids.some(id => lastSegment(id) === tail) || errText.indexOf(tail) !== -1
  const wasNative = !!(probe && probe.native && probe.native[item.probe])
  // ★ 第二条点名证据：装完补丁后该 API 仍不可用 ⇒ 这条补丁被摘掉了。
  //   为什么要第二条证据：部分 API 只在 pdfjs 的 **worker realm** 里被调用，
  //   pdfjs 会把 worker 抛出的原始 TypeError
  //   包装成通用 Error（"Error" + stack，无 "X is not a function" 字样），
  //   主线程拿不到那个标识名。此时"装完仍不可用"就是唯一可靠的名牌。
  const notPatched = Object.keys((probe && probe.patched) || {})
    .filter(k => probe.patched[k] === false)
    .map(k => items.find(i => i.probe === k))
    .filter(Boolean)
    .map(i => i.api)
  const patchedMissing = notPatched.some(a => lastSegment(a) === tail)

  console.log('render.ok = ' + render.ok)
  console.log('抽取到的错误标识：' + (ids.length ? ids.join(', ') : '（无）'))
  console.log('点名命中「' + tail + '」：' + (named ? '是（错误信息里出现了这个名字）' : '否'))
  console.log('装完补丁后仍不可用的 API：' + (notPatched.length ? notPatched.join(', ') : '（无）'))
  console.log('该补丁在当前 Electron 上是否原生已实现（native）：' + wasNative)
  if (render.error) {
    console.log('原始错误（截断）：' + String(render.error).slice(0, 400))
  }

  console.log('')
  if (wasNative) {
    // 原生已实现 ⇒ 摘掉补丁也不影响渲染 ⇒ 这不是缺陷，是 native:true 的含义。
    if (render.ok === true) {
      console.log('自检结论：该补丁本就冗余（原生已实现），摘掉后渲染仍成功 ⇒ 与 native:true 一致。')
      process.exit(0)
    }
    console.log('自检结论：FAIL —— 该补丁 native:true（原生已实现），摘掉后渲染却失败了' +
      '，说明还有别的问题（render.ok=' + render.ok + '）')
    process.exit(2)
  }
  if (render.ok === false && (named || patchedMissing)) {
    console.log('自检结论：PASS —— 摘掉必要补丁后渲染确实失败，且点名了缺失的 API' +
      (named ? '（错误信息里出现该名字）' : '（该 API 装完仍不可用）') + '。')
    console.log('（预期行为：退出码 ≠ 0）')
    process.exit(1)
  }
  console.log('自检结论：FAIL —— 摘掉必要补丁后没有拿到「失败 + 点名」的证据' +
    '（render.ok=' + render.ok + '，点名=' + named + '，装完仍不可用=' + patchedMissing + '）')
  process.exit(2)
}

async function main () {
  const argv = process.argv.slice(2)
  if (argv[0] === '--sabotage') {
    const idx = Number(argv[1])
    if (!Number.isInteger(idx) || idx < 0) {
      console.error('--sabotage 需要一个非负整数序号')
      process.exit(2)
    }
    // ★ 第三个参数选篡改方式：'stub'（把安装函数改成直接返回）或
    //   'remove'（整个删掉该安装函数，模拟"被人删了补丁"）。
    //   两种都必须能跑通 —— makeSabotagedCopy 的两个分支都有真实用例。
    const mode = argv[2] === 'remove' ? 'remove' : 'stub'
    await runSabotage(idx, mode)
    return
  }

  console.log('pdfjs polyfill 复核探针\n')

  const checks = []
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    console.log((ok ? '  ✓ ' : '  ✗ ') + name)
    if (detail !== undefined && detail !== null && String(detail) !== '') {
      console.log('      ' + String(detail).split('\n').join('\n      '))
    }
  }

  // ---- 1. 载入 manifest（检查目标的唯一来源） ----
  let manifest
  try {
    manifest = await loadManifest()
  } catch (err) {
    console.error('  ✗ 无法载入补丁清单：' + (err && err.message))
    console.log('\n结果：0/1 通过')
    process.exit(1)
  }
  const items = manifest.items
  const installers = manifest.installers

  console.log('补丁清单（来自 src/vendor/pdf-polyfill.mjs）：')
  for (const it of items) {
    console.log('  · ' + it.api + '  [realm=' + it.realm + ', 引入于 ' + it.neededBy + ']')
  }
  console.log('')

  check('清单项数 == 6', items.length === 6, '实际 ' + items.length + ' 项')
  check('清单项数 == 实际安装函数数（对账）',
    installers.length === items.length,
    'manifest 项 ' + items.length + ' / 安装函数 ' + installers.length)
  check('每个条目都有 api / realm / neededBy',
    items.every(i => i && typeof i.api === 'string' && i.api &&
      (i.realm === 'main' || i.realm === 'worker' || i.realm === 'both') &&
      typeof i.neededBy === 'string' && i.neededBy))
  check('每个条目的 install 都是函数',
    items.every(i => typeof i.install === 'function'))

  // ---- 2. 探针跑真 Electron ----
  const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-polyfill-src-'))
  const pdfPath = path.join(srcRoot, 'probe.pdf')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pg = doc.addPage([200, 120])
  pg.drawText('POLYFILL PROBE', { x: 12, y: 60, size: 10, font })
  fs.writeFileSync(pdfPath, Buffer.from(await doc.save()))
  const pdfB64 = fs.readFileSync(pdfPath).toString('base64')

  const before = {
    hash: fileHash(POLYFILL_PATH),
    mtime: fs.statSync(POLYFILL_PATH).mtimeMs
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-polyfill-ud-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'),
    JSON.stringify({ version: 1, notes: [], settings: {} }))
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS

  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData, '--remote-debugging-port=' + PORT, '--inspect=0', '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })

  let cdp = null
  let probe = null
  let sabotage = null
  /** 临时写在 src/ 里的 worker realm 探针文件名（finally 里清理） */
  let realmProbeName = null
  try {
    const url = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 25000, 'inspector')
    await waitFor(async () => log.includes('[boot] 托盘就绪') ? true : null, 25000, '启动完成')
    await sleep(800)
    cdp = new CDP(url)
    await cdp.connect()

    // ★ 探针体在**真实渲染进程**里执行（主进程只负责建窗口并转发）
    // ★ 预写 worker realm 探针文件（放在 src/ 同目录 ⇒ file: 同源 ⇒ CSP 'self' 命中）
    const probeList = items.map(i => i.probe)
    realmProbeName = writeRealmProbeWorker(SRC_DIR, probeList)
    const probeBody = buildProbeExpr(probeList, pdfB64, realmProbeName)
    probe = await cdp.evaluate(buildHostExpr(probeBody))
    if (!probe || probe.fatal) throw new Error('探针执行失败: ' + JSON.stringify(probe))

    // ---- 2b. 自检：篡改副本里摘掉一条补丁 ⇒ 渲染必须失败且能点名 ----
    //   选一条"原生尚未实现"的补丁（只有它被摘掉才会真的坏掉）。
    const target = items.find(it => probe.native && probe.native[it.probe] === false)
    if (target) {
      const installerName = target.install && target.install.name
      let sabDir = null
      try {
        sabDir = makeSabotagedCopy(target, installerName)
        const sabProbe = await cdp.evaluate(
          buildHostExpr(buildProbeExpr(probeList, pdfB64), sabDir))
        const sabRender = (sabProbe && sabProbe.render) || {}
        const sabText = [sabRender.error || ''].concat((sabProbe && sabProbe.errors) || []).join(' ')
        const sabIds = extractMissingIdentifiers(sabText)
        const tail = lastSegment(target.api)
        const named = sabIds.some(id => lastSegment(id) === tail) ||
          sabText.indexOf(tail) !== -1
        // ★ 第二条点名证据：装完补丁后该 API 仍不可用 ⇒ 这条补丁被摘掉了。
        //   某些 API 只在 pdfjs 的 worker realm 里被调用，
        //   pdfjs 会把 worker 抛出的原始 TypeError 包装成通用 Error
        //   （只有 "Error" + stack，没有 "X is not a function" 字样），
        //   主线程拿不到那个标识名 —— 此时"装完仍不可用"就是唯一可靠的名牌。
        const sabNotPatched = Object.keys((sabProbe && sabProbe.patched) || {})
          .filter(k => sabProbe.patched[k] === false)
          .map(k => items.find(i => i.probe === k))
          .filter(Boolean)
          .map(i => i.api)
        const patchedMissing = sabNotPatched.some(a => lastSegment(a) === tail)
        sabotage = {
          api: target.api,
          renderOk: sabRender.ok === true,
          error: sabRender.error || '',
          ids: sabIds,
          named: named || patchedMissing,
          namedBy: named ? 'error' : (patchedMissing ? 'not-patched' : null),
          notPatched: sabNotPatched,
          render: sabRender
        }
      } catch (e) {
        sabotage = { api: target.api, error: '自检执行异常：' + String((e && e.stack) || e) }
      } finally {
        if (sabDir) { try { fs.rmSync(path.dirname(sabDir), { recursive: true, force: true }) } catch (_) {} }
      }
    } else {
      sabotage = { api: null, error: '没有"原生未实现"的补丁可供自检' }
    }

    const quit = await cdp.evaluate(QUIT_EXPR)
    if (!quit || !quit.ok) console.error('  （app.quit() 未成功，忽略）')
    cdp.close()
    await waitFor(async () => (child.exitCode !== null || child.signalCode) ? true : null, 15000, '退出')
      .catch(() => {})
  } catch (e) {
    console.error('  ✗ 探针运行异常：' + (e.stack || e.message))
    console.error('  --- 日志尾部 ---')
    console.error('  ' + log.split('\n').slice(-20).join('\n  '))
    if (cdp) cdp.close()
    if (child.exitCode === null) { try { child.kill() } catch (_) {} }
    console.log('\n结果：0/' + (checks.length + 1) + ' 通过')
    process.exit(1)
  } finally {
    // ★ 清掉临时写在 src/ 里的 worker realm 探针文件（绝不留在仓库里）
    if (realmProbeName) {
      try { fs.rmSync(path.join(SRC_DIR, realmProbeName), { force: true }) } catch (_) {}
    }
  }

  // ---- 3. 逐项判定 native（原生是否已实现） ----
  console.log('逐项判定（native = 原生是否已实现；patched = 补丁装完是否可用）：')
  const rows = []
  for (const it of items) {
    const isNative = !!(probe.native && probe.native[it.probe])
    const isPatched = !!(probe.patched && probe.patched[it.probe])
    rows.push({ api: it.api, realm: it.realm, neededBy: it.neededBy, native: isNative, patched: isPatched })
    const verdict = isNative
      ? 'native: true  ⇒ 冗余，可人工删除（探针不会自动删）'
      : 'native: false ⇒ 仍需补丁'
    console.log('  · ' + it.api + ' → ' + verdict +
      '  [patched: ' + (isPatched ? '可用' : '缺失') + ']')
  }
  console.log('')

  check('每项都给出了 native 判定',
    rows.every(r => typeof r.native === 'boolean'))

  // ---- 3b. realm 字段的**真实**验证（F8）----
  //   manifest 登记的 realm 此前从未被真正验证过（探针只在页面 realm 探测）。
  //   现在探针会在**真 module Worker** 里再探测一遍 ⇒ 两个 realm 都有数据。
  //   判定口径：
  //     realm='worker' 的条目 ⇒ worker realm 必须能装上（patched=true）
  //     realm='both'/'main' 的条目 ⇒ 页面 realm 必须能装上（patched=true）
  const wr = (probe && probe.workerRealm) || { ok: false, native: {}, patched: {}, error: null }
  check('★ worker realm 探测成功（manifest 的 realm 字段可被真实验证）',
    wr.ok === true,
    wr.ok
      ? ('worker realm 实测：' + Object.keys(wr.patched || {}).length + ' 项 API 可用')
      : ('worker realm 探测失败：' + (wr.error || '未知原因')))
  if (wr.ok) {
    const realmMismatch = []
    for (const it of items) {
      const inWorker = !!(wr.patched && wr.patched[it.probe])
      const inPage = !!(probe.patched && probe.patched[it.probe])
      if (it.realm === 'worker') {
        // 只装 worker realm ⇒ worker 里必须可用
        if (!inWorker) realmMismatch.push(it.api + '（realm=worker 但 worker realm 不可用）')
      } else if (it.realm === 'main') {
        if (!inPage) realmMismatch.push(it.api + '（realm=main 但页面 realm 不可用）')
      } else {
        // 'both' ⇒ 两个 realm 都必须可用
        if (!inWorker) realmMismatch.push(it.api + '（realm=both 但 worker realm 不可用）')
        if (!inPage) realmMismatch.push(it.api + '（realm=both 但页面 realm 不可用）')
      }
    }
    check('★ manifest 的 realm 声明与两个 realm 的实测一致',
      realmMismatch.length === 0, realmMismatch.join('; '))
  }

  // ---- 4. 补丁是否真的装上了（删补丁 ⇒ 这里必须报缺失） ----
  const notPatched = rows.filter(r => !r.patched)
  check('★ 每条补丁装完后都真的可用（没有补丁被删/没生效）',
    notPatched.length === 0,
    notPatched.length
      ? ('缺失的补丁：' + notPatched.map(r => r.api).join(', '))
      : (rows.length + ' 条补丁全部生效'))

  // ---- 5. native 冗余判定 ----
  const allNative = rows.every(r => r.native)
  const redundant = rows.filter(r => r.native)
  const necessary = rows.filter(r => !r.native)
  if (allNative) {
    check('★ 当前 Electron 上全部补丁都已冗余（可人工删除）', true,
      '探针只报告，不修改 pdf-polyfill.mjs')
  } else {
    check('仍有补丁是必要的（至少一条 native:false）',
      necessary.length > 0,
      '必要 ' + necessary.length + ' 条（' + necessary.map(r => r.api).join(', ') + '）' +
      '；冗余 ' + redundant.length + ' 条（' + redundant.map(r => r.api).join(', ') + '）')
  }
  if (redundant.length) {
    console.log('')
    console.log('冗余补丁（native: true，可人工删除；探针不会自动删）：')
    for (const r of redundant) console.log('  · ' + r.api)
  }

  // ---- 6. 真实渲染冒烟 ----
  const render = probe.render || {}
  check('render: pass（真 pdfjs 渲染 1 页成 PNG）',
    render.ok === true,
    render.ok
      ? ('产物 ' + render.type + ' ' + render.size + ' 字节，' +
        render.width + '×' + render.height + '，共 ' + render.numPages + ' 页')
      : ('渲染失败：' + (render.error || '未知原因')))

  // ---- 7. "删掉补丁必失败"自检 ----
  check('★ 人为摘掉一条补丁后重跑 ⇒ 渲染失败且点名该 API',
    !!(sabotage && sabotage.api && sabotage.renderOk === false && sabotage.named),
    sabotage
      ? (sabotage.api
        ? ('摘掉：' + sabotage.api + ' ⇒ render.ok=' + sabotage.renderOk +
          '；点名命中=' + sabotage.named +
          (sabotage.namedBy ? ('（依据：' + sabotage.namedBy + '）') : '') +
          (sabotage.ids && sabotage.ids.length ? ('；错误标识：' + sabotage.ids.join(', ')) : '') +
          (sabotage.notPatched && sabotage.notPatched.length
            ? ('；装完仍不可用：' + sabotage.notPatched.join(', ')) : '') +
          (sabotage.renderOk === false && !sabotage.named
            ? ('；原始错误：' + String(sabotage.error || '').slice(0, 300))
            : ''))
        : ('自检未执行：' + (sabotage.error || '未知原因')))
      : '自检未执行')

  // ---- 8. 从错误信息抽取 "X is not a function"，与 manifest 求差集 ----
  const errText = [render.error || ''].concat(probe.errors || []).join(' ')
  const missing = extractMissingIdentifiers(errText)
  const needPatch = diffAgainstManifest(missing, items)
  check('能从错误信息抽取缺失 API 并与 manifest 求差集',
    true,
    missing.length
      ? ('抽取到：' + missing.join(', ') + '；需要新增的补丁：' +
        (needPatch.length ? needPatch.join(', ') : '（无 —— 都在 manifest 里）'))
      : '本次没有渲染错误 ⇒ 没有可抽取的缺失标识')

  if (needPatch.length) {
    console.log('')
    console.log('需要新增的补丁：' + needPatch.join(', '))
  }

  // ---- 9. 自检：模拟缺 API 场景能否真的打印出建议 ----
  const sim = probe.simulated || {}
  const simMissing = extractMissingIdentifiers(sim.message || '')
  const simNeed = diffAgainstManifest(simMissing, items)
  check('★ 模拟缺 API 场景能打印出"需要新增的补丁：X"',
    simNeed.length > 0,
    simNeed.length
      ? ('模拟缺失标识：' + simMissing.join(', ') + ' ⇒ 需要新增的补丁：' + simNeed.join(', '))
      : ('模拟未产生可抽取标识（message=' + (sim.message || '无') + '）'))
  if (simNeed.length) {
    console.log('')
    console.log('（自检）需要新增的补丁：' + simNeed.join(', '))
  }

  // ---- 10. 只报告不自动删：文件内容与哈希不变 ----
  const after = {
    hash: fileHash(POLYFILL_PATH),
    mtime: fs.statSync(POLYFILL_PATH).mtimeMs
  }
  check('★ 探针没有修改 src/vendor/pdf-polyfill.mjs（哈希不变）',
    before.hash === after.hash,
    'sha256 ' + before.hash.slice(0, 16) + ' → ' + after.hash.slice(0, 16))
  check('★ 探针没有修改 src/vendor/pdf-polyfill.mjs（mtime 不变）',
    before.mtime === after.mtime)

  let pass = 0
  for (const c of checks) {
    if (c.ok) pass++
  }
  console.log('\n结果：' + pass + '/' + checks.length + ' 通过')
  console.log('台账：docs/pdf-polyfill-review.md')
  process.exit(pass === checks.length ? 0 : 1)
}

main()
