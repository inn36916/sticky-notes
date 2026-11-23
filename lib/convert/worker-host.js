'use strict'

/**
 * 转换工作器宿主（主进程）。
 *
 * 职责：在主进程与隐藏渲染窗口之间架桥，让主进程能调用 canvas 的图片能力。
 *
 * 为什么需要：canvas 只存在于渲染进程；主进程（Node）没有 DOM。
 *   方案对比：
 *     - 用 sharp（native 依赖 + 体积）
 *     - 起一个隐藏 BrowserWindow 承载 canvas（零新增依赖）⇒ 选这个
 *
 * 生命周期：按需创建（第一次用到图片转换时才建），用完不销毁 ——
 *   销毁再重建有几百毫秒开销，而图片转换可能连续发生。
 *
 * IPC 约定：
 *   主进程 → worker: 'convert:worker-decode' / 'convert:worker-encode'
 *   worker → 主进程: 'convert:worker-decoded' / 'convert:worker-encoded'
 *   每次请求带一个 reqId，避免并发串台。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const { pathToFileURL } = require('url')

/** 请求超时（毫秒）。图片解码/编码通常在几百毫秒内完成。 */
const DEFAULT_TIMEOUT_MS = 30000

/** 离屏 HTML 转 PDF 严格离线 CSP（禁止脚本与外网请求） */
const PRINT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"

const DECODE_MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon'
}

/**
 * 创建一个工作器宿主。
 *
 * @param {object} opts
 * @param {object} opts.BrowserWindow
 * @param {object} [opts.ipcMain] 注入 ipcMain（测试用，默认取 electron.ipcMain）
 * @param {string} opts.srcDir  src 目录（放 convert-worker.html）
 * @param {function} [opts.log]
 * @returns {object} host
 */
function createWorkerHost (opts = {}) {
  const BrowserWindow = opts.BrowserWindow
  const ipc = opts.ipcMain || require('electron').ipcMain
  const srcDir = opts.srcDir || ''
  const log = opts.log || (() => {})

  let win = null
  let loading = null
  let seq = 0

  /** 待完成的请求：reqId → {resolve, reject, timer} */
  const pending = new Map()

  /**
   * 确保窗口已就绪。
   * @returns {Promise<BrowserWindow>}
   */
  function ensure () {
    if (win && !win.isDestroyed()) return Promise.resolve(win)
    if (loading) return loading

    loading = new Promise((resolve, reject) => {
      let w
      try {
        w = new BrowserWindow({
          show: false,
          width: 16,
          height: 16,
          webPreferences: {
            preload: path.join(__dirname, '..', '..', 'preload-worker.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
          }
        })
      } catch (err) {
        loading = null
        reject(err)
        return
      }
      win = w
      w.on('closed', () => {
        win = null
        loading = null
        // 窗口没了 ⇒ 所有在途请求都失败，别让它们永远挂着
        for (const [, p] of pending) {
          clearTimeout(p.timer)
          p.reject(new Error('转换工作器已关闭'))
        }
        pending.clear()
      })

      w.webContents.on('did-finish-load', () => resolve(w))
      w.webContents.on('did-fail-load', (_e, code, desc) => {
        loading = null
        win = null
        reject(new Error('转换工作器加载失败：' + (desc || code)))
      })
      w.loadFile(path.join(srcDir, 'convert-worker.html'))
    })

    return loading
  }

  /**
   * 向 worker 发一个请求并等待结果。
   *
   * ★ reqId 必须**同时**出现在请求与回信里：
   *   并发请求时，主进程靠它把回信匹配回原请求（否则会串台）。
   *
   * @param {string} channel worker 侧监听名
   * @param {string} replyChannel worker 回信名
   * @param {any[]} args
   * @param {number} [timeout]
   * @returns {Promise<any>}
   */
  async function request (channel, replyChannel, args, timeout) {
    const w = await ensure()
    const reqId = 'r' + (++seq)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId)
        reject(new Error('转换工作器超时'))
      }, timeout || DEFAULT_TIMEOUT_MS)

      pending.set(reqId, { resolve, reject, timer, replyChannel })

      try {
        // reqId 放第一个参数：worker 侧回调签名是 (reqId, ...args)
        w.webContents.send(channel, reqId, ...args)
      } catch (err) {
        clearTimeout(timer)
        pending.delete(reqId)
        reject(err)
      }
    })
  }

  function isFromWorker (event) {
    return !!(win && !win.isDestroyed() && event && event.sender === win.webContents)
  }

  // 注册回信监听，校验 sender 并保留句柄以便 dispose 时注销
  const onWorkerDecoded = (e, reqId, payload) => {
    if (!isFromWorker(e)) return
    settle(reqId, payload)
  }
  const onWorkerEncoded = (e, reqId, payload) => {
    if (!isFromWorker(e)) return
    settle(reqId, payload)
  }
  ipc.on('convert:worker-decoded', onWorkerDecoded)
  ipc.on('convert:worker-encoded', onWorkerEncoded)

  /** 结算一个待完成的请求 */
  function settle (reqId, payload) {
    const p = pending.get(reqId)
    if (!p) return
    pending.delete(reqId)
    clearTimeout(p.timer)
    p.resolve(payload)
  }

  /**
   * 解码一个图片文件（由主进程读取字节后直接下发给 worker，返回 canvasId）。
   * @param {string} filePath
   */
  async function decode (filePath) {
    let bytes
    try {
      const buf = await fs.promises.readFile(filePath)
      bytes = toUint8Array(buf)
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
    if (!bytes.length) {
      return { ok: false, error: '文件为空或读不到' }
    }
    const ext = path.extname(String(filePath || '')).slice(1).toLowerCase()
    const mime = DECODE_MIME_BY_EXT[ext] || ''
    return request('convert:worker-decode', 'convert:worker-decoded', [bytes, mime])
  }

  /**
   * 编码一个 canvas。
   * @param {string} canvasId
   * @param {string} mime
   */
  async function encode (canvasId, mime) {
    return request('convert:worker-encode', 'convert:worker-encoded', [canvasId, mime])
  }

  /**
   * 把 SVG 文本光栅化成一个 canvas（返回 canvasId）。
   *
   * ★ 回信通道复用 `convert:worker-decoded`：主进程已经为它挂了监听器，
   *   只要 worker 侧把 reqId 原样带回，并发匹配就是对的。
   *   复用通道 = 主进程不需要为 SVG 再注册一套监听/pending 逻辑，
   *   改动面最小，也不会出现"两个监听器抢同一个 reqId"的问题。
   *
   * 返回：{ ok, width, height, canvasId, scaled?, blank?, externalRef?, error? }
   *   - scaled     ：SVG 尺寸超过上限被等比缩小（明确告知，不偷偷改）
   *   - blank      ：画布采样下来全透明（合法但值得提示，例如空 SVG）
   *   - externalRef：SVG 引用了外部资源。实测 Chromium 渲染 SVG-as-image 时
   *                  不会请求它们，产物里对应位置是空白 —— 记日志用，不判失败
   *   - tainted    ：内容受同源策略限制（如 <foreignObject>），明确失败
   *
   * @param {string} svgText SVG 源文本
   * @param {object} [opts]  { maxSide }
   */
  async function renderSvg (svgText, opts) {
    return request('convert:worker-render-svg', 'convert:worker-decoded', [svgText, opts || {}])
  }

  /**
   * 把 PDF 的指定页渲染成 canvas（返回 canvasId）。
   *
   * ★ 为什么字节而不是文件路径：渲染进程 nodeIntegration:false，拿不到 fs；
   *   复用 readFileBytes() 由主进程读好后通过结构化克隆传过去。
   * ★ 回信通道仍复用 `convert:worker-decoded`（同 renderSvg），
   *   只要 reqId 原样带回就不会与主进程的 pending 表串台。
   *
   * 返回：{ ok, width, height, canvasId, numPages, scaled?, encrypted?, error? }
   *
   * @param {Uint8Array|Buffer} bytes PDF 文件字节
   * @param {object} [opts]  { scale?, maxSide?, pageNumber? }（pageNumber 默认 1）
   */
  async function renderPdf (bytes, opts) {
    return request('convert:worker-render-pdf', 'convert:worker-decoded',
      [toUint8Array(bytes), opts || {}])
  }

  /**
   * 抽取 PDF 第 1 页的文本（pdfjs getTextContent）。
   *
   * 与 renderPdf 分开成两个通道：文本抽取不需要 canvas，
   * 也不该为了拿文字去分配一张几千像素的画布。
   *
   * 返回：{ ok, text, numPages, pagesConverted?, encrypted?, error? }
   *
   * ★  opts 默认 {}：老调用方 extractPdfText(bytes) 与改动前完全等价（只抽第 1 页）。
   *
   * @param {Uint8Array|Buffer} bytes PDF 文件字节
   * @param {object} [opts] { allPages?:boolean, maxPages?:number }
   */
  async function extractPdfText (bytes, opts) {
    return request('convert:worker-extract-pdf-text', 'convert:worker-decoded',
      [toUint8Array(bytes), opts || {}])
  }

  /**
   * 抽取 PDF 结构化文本项（含坐标、字号、字体家族），供 pdf→md 版面启发式重建。
   *
   * @param {Uint8Array|Buffer} bytes PDF 文件字节
   * @param {object} [opts] { allPages?:boolean, maxPages?:number }
   */
  async function extractPdfStructured (bytes, opts) {
    return request('convert:worker-extract-pdf-structured', 'convert:worker-decoded',
      [toUint8Array(bytes), opts || {}])
  }

  /**
   * 将 HTML 在完全隔离的离线隐藏窗口中渲染为 PDF（主进程直出，零新增 IPC）。
   *
   * 安全与离线边界：
   *   - sandbox: true, javascript: false, nodeIntegration: false, contextIsolation: true
   *   - 注入严格离线 CSP（仅允许内联样式与 data: 图片/字体，禁止脚本与任何网络请求）
   *   - 阻止页面内导航与弹窗；临时 HTML 写到系统 TEMP 并在 finally 清理
   *
   * @param {string} html HTML 源码或片段
   * @param {object} [opts] { timeout?:number }
   * @returns {Promise<{ok:boolean, bytes?:Uint8Array, error?:string}>}
   */
  async function renderHtmlToPdf (html, opts) {
    if (typeof BrowserWindow !== 'function') {
      return { ok: false, error: '无法创建 PDF 渲染窗口' }
    }
    const o = opts || {}
    const timeoutMs = Number(o.timeout) > 0 ? Number(o.timeout) : DEFAULT_TIMEOUT_MS
    const doc = preparePrintableHtml(html)
    const tmpHtml = path.join(
      os.tmpdir(),
      'sticky-print-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.html'
    )
    let w = null
    let timer = null
    try {
      fs.writeFileSync(tmpHtml, doc, 'utf8')
      const fileUrl = pathToFileURL(tmpHtml).href
      w = new BrowserWindow({
        show: false,
        width: 794,
        height: 1123,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          javascript: false,
          webSecurity: true
        }
      })
      w.webContents.on('will-navigate', (e, url) => {
        if (url !== fileUrl) e.preventDefault()
      })
      if (typeof w.webContents.setWindowOpenHandler === 'function') {
        w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      }

      const pdfBuf = await Promise.race([
        (async () => {
          await new Promise((resolve, reject) => {
            let settled = false
            const done = (err) => {
              if (settled) return
              settled = true
              if (err) reject(err)
              else resolve()
            }
            w.webContents.once('did-finish-load', () => done())
            w.webContents.once('did-fail-load', (_e, code, desc) => {
              done(new Error('HTML 载入失败：' + (desc || code)))
            })
            w.once('closed', () => done(new Error('HTML 渲染窗口已关闭')))
            Promise.resolve(w.loadFile(tmpHtml)).catch(done)
          })
          return w.webContents.printToPDF({
            printBackground: true,
            pageSize: 'A4',
            margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
          })
        })(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('HTML 渲染 PDF 超时')), timeoutMs)
        })
      ])
      const bytes = toUint8Array(pdfBuf)
      if (bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 ||
          bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
        return { ok: false, error: 'HTML 转 PDF 未产出有效的 %PDF- 文件' }
      }
      return { ok: true, bytes }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    } finally {
      if (timer) clearTimeout(timer)
      if (w && !w.isDestroyed()) {
        try { w.destroy() } catch (_) {}
      }
      try { fs.unlinkSync(tmpHtml) } catch (_) {}
    }
  }

  /**
   * 把一张图片转码成目标 mime 的字节（图片 → PDF 的 webp/gif 走这条通道）。
   *
   * ★ 为什么单独开一条通道：pdf-lib 只吃 PNG/JPEG，webp/gif 得靠 Chromium 的
   *   createImageBitmap 解码 + canvas.toBlob 编码 —— 而 canvas 只存在于渲染进程。
   *   走 worker 意味着零新增 npm 依赖（不引入 sharp / libvips 这类 native 库）。
   *
   * ★ 回信通道复用 `convert:worker-decoded`（同 renderSvg / renderPdf）：
   *   主进程已经为它挂了 pending 匹配，只要 worker 把 reqId 原样带回就不会串台。
   *
   * 返回：{ ok, bytes?:Uint8Array, type?:string, width?:number, height?:number, error? }
   *
   * @param {Uint8Array|Buffer} bytes 源图片字节
   * @param {string} mime 目标 mime（图片→PDF 固定 image/png）
   * @param {object} [opts] { sourceMime? } 源 mime（不给则按字节头推断）
   */
  async function transcodeImage (bytes, mime, opts) {
    return request('convert:worker-transcode-image', 'convert:worker-decoded',
      [toUint8Array(bytes), mime, opts || {}])
  }

  /** 销毁窗口并注销 IPC 监听（退出前调用） */
  function dispose () {
    try { ipc.removeListener('convert:worker-decoded', onWorkerDecoded) } catch (_) {}
    try { ipc.removeListener('convert:worker-encoded', onWorkerEncoded) } catch (_) {}
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error('转换工作器已释放'))
    }
    pending.clear()
    if (win && !win.isDestroyed()) {
      try { win.destroy() } catch (_) {}
    }
    win = null
    loading = null
  }

  return {
    ensure,
    decode,
    encode,
    renderSvg,
    renderPdf,
    extractPdfText,
    extractPdfStructured,
    renderHtmlToPdf,
    transcodeImage,
    dispose,
    isReady: () => !!(win && !win.isDestroyed())
  }
}

/**
 * 清洗并注入严格离线 CSP 到待打印的 HTML 文档中。
 * @param {string} html
 * @returns {string}
 */
function preparePrintableHtml (html) {
  let s = String(html == null ? '' : html)
  // 纵深防御：即使已禁用 javascript，也剥除脚本与现有 CSP/refresh meta
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  s = s.replace(/<meta\b[^>]*http-equiv\s*=\s*(?:"(?:Content-Security-Policy|refresh)"|'(?:Content-Security-Policy|refresh)'|(?:Content-Security-Policy|refresh))[^>]*>/gi, '')
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}" />`
  const headInject = `<meta charset="utf-8" />${cspMeta}`

  if (/<head\b[^>]*>/i.test(s)) {
    return s.replace(/<head\b[^>]*>/i, m => m + headInject)
  }
  if (/<html\b[^>]*>/i.test(s)) {
    return s.replace(/<html\b[^>]*>/i, m => m + `<head>${headInject}</head>`)
  }
  return `<!DOCTYPE html><html lang="zh-CN"><head>${headInject}</head><body>${s}</body></html>`
}

/**
 * 读一个文件的字节（给 worker 传原始数据）。
 *
 * 为什么不直接把文件路径给 worker 让它自己读：渲染进程有 nodeIntegration:false，
 * 拿不到 fs。让主进程读更简单，也少一次权限面。
 *
 * ★ 为什么返回 Uint8Array 而不是 number[]（2026-11-16 修正）：
 *   早先的实现是 `Array.from(buf)`，把 Buffer 转成**普通数组** ——
 *   每个字节占一个 JS number（8 字节指针 + 值），100MB 图就是 ~800MB 内存，
 *   且 IPC 序列化时还要再拷贝一份。
 *   Electron 的 IPC 走结构化克隆，**原生支持 TypedArray/ArrayBuffer**，
 *   直接传 Uint8Array 即可：内存占用与文件大小同阶，零拷贝语义由 Chromium 处理。
 *
 * @param {string} filePath
 * @returns {Uint8Array} 字节视图（底层内存与 Buffer 共享，不额外拷贝）
 */
function readFileBytes (filePath) {
  const buf = fs.readFileSync(filePath)
  // 用 byteOffset/byteLength 切片：Buffer 可能是池化的，视图必须指向真实数据段
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/**
 * 把 Buffer / 数组统一成 Uint8Array（IPC 结构化克隆原生支持 TypedArray）。
 *
 * ★ 不能把 Buffer 直接塞进 IPC 后再指望 worker 侧拿到 Buffer：
 *   Electron 会把 Buffer 结构化克隆成 Uint8Array；worker 侧两种形态都兼容，
 *   但这里先归一化，调用方的入参形态就不会影响 IPC 负载大小与语义。
 *
 * @param {Buffer|Uint8Array|number[]} bytes
 * @returns {Uint8Array}
 */
function toUint8Array (bytes) {
  if (bytes instanceof Uint8Array) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  if (Buffer.isBuffer(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  if (Array.isArray(bytes)) return new Uint8Array(bytes)
  return new Uint8Array(0)
}

module.exports = { createWorkerHost, readFileBytes, toUint8Array, preparePrintableHtml, DEFAULT_TIMEOUT_MS }
