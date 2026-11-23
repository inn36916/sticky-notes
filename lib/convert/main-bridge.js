'use strict'

/**
 * 转换功能的主进程接线（把 lib/convert 与 Electron 连起来）。
 *
 * 单独成文件而不是塞进 main.js，是为了：
 *   - main.js 已经 90KB，再加会让「找一段逻辑」变成大海捞针；
 *   - 这里几乎全是 Electron 相关的胶水，逻辑本身都在 lib/convert/{filee-cli,service}.js。
 *
 * 职责：
 *   1. 注册 sticky-att:// 协议（便签里以外置引用显示附件，不内联 dataURL）
 *   2. 注册转换相关 IPC
 *   3. 处理 --convert 启动参数（含二次实例的 argv 转发与多文件聚合）
 */

const path = require('path')
const fs = require('fs')
const { protocol, net, ipcMain } = require('electron')

const fileeCli = require('./filee-cli')
const convertService = require('./service')
const cliArgs = require('../cli-args')
const { escapeHtml } = require('../utils')

/** 附件协议名 */
const ATTACH_SCHEME = 'sticky-att'

/** 多文件聚合窗口：Explorer 对每个文件启动一次进程，这里把短时间内的多次启动合并成一批 */
const AGGREGATE_WINDOW_MS = 1500

/**
 * 注册附件协议。
 *
 * ★ 为什么需要它：便签的 CSP 是 `img-src 'self' data: blob:`，
 *   而附件是磁盘上的真实文件（file:// 在 CSP 下不可用，且 file:// 引用会放宽安全边界）。
 *   用自定义协议把「只允许读附件目录」这件事固化在协议处理器里。
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {object} opts.app
 */
function registerAttachProtocol (opts = {}) {
  const { app } = opts
  const userDataDir = opts.userDataDir || app.getPath('userData')
  const attachRoot = path.join(userDataDir, 'attachments')

  try {
    protocol.registerSchemesAsPrivileged([{
      scheme: ATTACH_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }])
  } catch (_) {
    // 已注册过：忽略（Electron 在第二次调用时会抛）
  }

  const handle = async (request) => {
    try {
      const url = new URL(request.url)
      // 只允许读附件目录下的文件：解析相对路径后校验是否越界
      const rel = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const target = path.resolve(attachRoot, rel)
      const rootResolved = path.resolve(attachRoot)
      if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
        return new Response('forbidden', { status: 403 })
      }
      if (!fs.existsSync(target)) {
        return new Response('not found', { status: 404 })
      }
      return net.fetch('file://' + target.replace(/\\/g, '/'))
    } catch (_) {
      return new Response('bad request', { status: 400 })
    }
  }

  try {
    protocol.handle(ATTACH_SCHEME, handle)
  } catch (_) {}
}

/**
 * 把附件绝对路径转成可引用的 URL。
 * @param {string} absPath
 * @param {string} userDataDir
 */
function attachmentUrl (absPath, userDataDir) {
  const root = path.resolve(path.join(userDataDir, 'attachments'))
  const target = path.resolve(String(absPath || ''))
  if (target !== root && !target.startsWith(root + path.sep)) return ''
  const rel = path.relative(root, target).split(path.sep).join('/')
  return `${ATTACH_SCHEME}://local/${encodeURIComponent(rel).replace(/%2F/g, '/')}`
}

/**
 * 装好整套转换接线。
 *
 * @param {object} opts
 * @param {object} opts.app
 * @param {BrowserWindow} opts.BrowserWindow
 * @param {function} [opts.onOpenConvertWindow] 打开格式选择窗的回调
 * @returns {object} 对外句柄
 */
function setup (opts = {}) {
  const { app } = opts
  const userDataDir = app.getPath('userData')
  const service = convertService.createService({
    userDataDir,
    appDir: app.getAppPath ? app.getAppPath() : process.execPath,
    // ★ 2026-11-16：转换后端可插拔。不传 providers 时退回旧的「只有 Filee」路径，
    //   保证既有测试与 e2e 的行为完全不变。
    providers: opts.providers,
    router: opts.router
  })

  /** 待聚合的转换请求（多文件合并） */
  let pending = null
  let pendingTimer = null

  /**
   * 进行中的转换：sender id → reqId。
   *
   * ★ 为什么要这张表（并发闸）：同一个窗口连点两个格式卡片会发起两次
   *   convert:run，导致重复生成转换文件。
   *   这里在主进程侧拦住第二次：明确返回"已有转换在进行中"。
   */
  const activeRuns = new Map()

  /**
   * 报告一次转换失败。
   *
   * ★ 绝不能用 `dialog.showMessageBox`：它是**模态**的，会挂住 `app.quit()`。
   *   用户从资源管理器右键进来后若 Filee 没装，点完提示再退出会卡死
   *   （e2e S2 抓到过这个）。
   *   ⚠️ Electron 33 **没有** `noWait` 选项（查 electron.d.ts 确认），
   *      传了会被静默忽略 —— 所以不能靠它绕开，必须换机制。
   *
   *   改为两步：
   *     1. 写错误日志（用户事后能查）
   *     2. 打开**非模态**的格式选择窗，把原因说清楚（复用 convert.html 的状态栏）
   *
   * @param {string[]} files
   * @param {{reason?:string, error?:string}} info
   */
  function reportError (files, info) {
    const reason = (info && info.reason) || fileeCli.REASON.FAILED
    const message = (info && info.error) || '转换失败'
    console.warn('[convert] 转换失败:', reason, message)
    if (typeof opts.onError === 'function') {
      try { opts.onError({ reason, error: message }) } catch (_) {}
    }
    // 复用格式选择窗展示原因：它是普通窗口，不阻塞退出
    const notify = opts.onOpenConvertWindow
    if (typeof notify === 'function') {
      try { notify(files || [], { reason, error: message }) } catch (_) {}
    }
  }

  /**
   * 处理一批转换请求：开选择窗（或直接转）。
   * @param {{files:string[], to:string|null}} req
   */
  async function handleConvertRequest (req) {
    if (!req || !req.files || !req.files.length) return { ok: false, error: '没有待转换的文件' }

    // 给了目标格式 → 直接转；没给 → 交给 UI 选
    if (req.to) {
      const r = await service.convert(req.files, req.to)
      if (!r.ok) {
        reportError(req.files, { reason: r.reason, error: r.error })
        return { ok: false, error: r.error, reason: r.reason, failures: r.failures }
      }
      return {
        ok: true,
        attachments: r.attachments,
        files: req.files,
        target: req.to
      }
    }

    // 没给格式：通知外部（UI）弹选择窗
    const notify = opts.onOpenConvertWindow
    if (typeof notify === 'function') {
      notify(req.files)
      return { ok: true, pending: true }
    }
    return { ok: false, error: '未指定目标格式，且没有可用的选择界面' }
  }

  // ---------------------------------------------------------------- IPC

  ipcMain.handle('convert:capabilities', async (_e, ext) => {
    return service.capabilities(ext)
  })

  // 引擎清单：让设置页能告诉用户"当前有哪些转换能力来源"
  ipcMain.handle('convert:engines', async () => {
    try {
      return {
        ok: true,
        engines: await service.engines(),
        // 告诉用户插件该放哪 —— 否则"可插拔"只是开发者知道的秘密
        pluginDir: path.join(userDataDir, 'convert-plugins')
      }
    } catch (err) {
      return {
        ok: false, engines: [],
        pluginDir: path.join(userDataDir, 'convert-plugins'),
        error: (err && err.message) || String(err)
      }
    }
  })

  ipcMain.handle('convert:run', async (_e, payload) => {
    const p = payload || {}
    const files = Array.isArray(p.files) ? p.files : []
    if (!files.length) return { ok: false, error: '没有待转换的文件' }
    // ★ 请求 id：渲染进程生成，用于把进度事件与本次请求对上（多源/重入时不错台）
    const reqId = String(p.reqId || '')

    // ★ 主进程侧并发闸：同一 sender 已有进行中的转换 ⇒ 明确失败，
    //   不排队也不静默丢弃（排队会让用户以为卡死，丢弃会静默少产物）。
    const sender = _e && _e.sender
    const senderKey = sender ? sender.id : null
    if (senderKey !== null && activeRuns.has(senderKey)) {
      return { ok: false, error: '已有转换在进行中', reqId }
    }
    if (senderKey !== null) activeRuns.set(senderKey, reqId)

    // ★ 前端的「转换所有页面」选项必须在这里显式装进 opts：
    //   service/router 已经把 opts 透传给 provider，缺的正是 IPC 这一环。
    //   --convert 启动参数路径（handleConvertRequest）刻意不带此选项，保持默认单页。
    //
    // ★ 进度回调必须**在主进程构造**：函数不可结构化克隆，
    //   渲染进程传函数过来会直接抛 "An object could not be cloned."。
    const opts = {
      allPages: !!p.allPages,
      onProgress: (info) => {
        // 进度必须**定向**推给发起窗口（R-P4-13），不能广播。
        if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) return
        try {
          sender.send('convert:progress', {
            reqId,
            source: info && info.source,
            page: info && info.page,
            total: info && info.total,
            done: info && info.done,
            failed: info && info.failed,
            phase: info && info.phase
          })
        } catch (_) {
          // 窗口已销毁 ⇒ 丢弃该进度事件，不抛异常（R-P4-9）
        }
      }
    }

    let r
    try {
      r = await service.convert(files, p.target, opts)
    } finally {
      if (senderKey !== null) activeRuns.delete(senderKey)
    }
    if (!r.ok) {
      reportError(files, { reason: r.reason, error: r.error })
      return { ok: false, error: r.error, reason: r.reason, failures: r.failures, reqId }
    }
    // ★ 把产物级警告汇总给 UI：转换成功 ≠ 产物符合预期
    //   （例如 SVG 转出来是全透明空白图）。不传的话用户拿到空白图却看到"成功"。
    return {
      ok: true,
      attachments: r.attachments,
      warnings: collectWarnings(r),
      reqId
    }
  })

  // ---------------------------------------------------------------- 启动参数

  /**
   * 处理启动参数：--convert <files...>
   * @param {string[]} argv
   */
  function handleArgv (argv) {
    const parsed = cliArgs.pickConvertArgv(argv)
    if (!parsed) return false

    const files = parsed.files.slice()
    if (parsed.to) {
      // 指定了格式：立即转
      void handleConvertRequest({ files, to: parsed.to })
      return true
    }

    // 没指定格式：聚合一小段时间内的多次启动（Explorer 对每个文件启动一次进程）
    if (pending) {
      for (const f of files) {
        if (!pending.files.includes(f)) pending.files.push(f)
      }
    } else {
      pending = { files }
      pendingTimer = setTimeout(() => {
        const req = pending
        pending = null
        pendingTimer = null
        if (req && req.files.length) handleConvertRequest(req)
      }, AGGREGATE_WINDOW_MS)
    }
    return true
  }

  return { service, handleArgv, handleConvertRequest, attachmentUrl }
}

/**
 * 汇总一次转换的所有警告（产物级 + 整体级），按 code+message 去重。
 *
 * 为什么要去重：一次转 3 个空 SVG 会产生 3 条完全相同的「产物是全透明的空白图」，
 * 用户在状态栏里看三遍同样的字没有意义。
 *
 * @param {object} r service.convert 的返回值
 * @returns {Array<{code:string, message:string}>}
 */
function collectWarnings (r) {
  const out = []
  const seen = new Set()
  const add = (w) => {
    if (!w || typeof w !== 'object') return
    const code = String(w.code || '')
    const message = String(w.message || '')
    if (!code && !message) return
    const key = code + '|' + message
    if (seen.has(key)) return
    seen.add(key)
    out.push({ code, message })
  }
  for (const w of (r && r.warnings) || []) add(w)
  for (const a of (r && r.attachments) || []) {
    for (const w of (a && a.warnings) || []) add(w)
  }
  return out
}

module.exports = {
  ATTACH_SCHEME,
  AGGREGATE_WINDOW_MS,
  registerAttachProtocol,
  attachmentUrl,
  collectWarnings,
  setup,
  escapeHtml
}
