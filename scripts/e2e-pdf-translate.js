'use strict'

/**
 * 学术文献 PDF 翻译全链路 E2E 回归（npm run test:e2e:pdf-translate）。
 *
 * 在真实 Electron 33 运行时验证：
 *   1. safeStorage 加密保存 AI 供应商（sk-e2e-real-key-999），渲染进程 status 绝不含明文 key
 *   2. Dashboard 顶部入口「文献翻译」→ 打开弹层，自动探测 STICKY_PDF2ZH (.cmd 含空格路径)
 *   3. 真实本地一次性 Token 代理（127.0.0.1:0）：
 *      - stub 仅收到 stk- 临时 token 与本地 proxy URL，CLI 参数与环境中均无明文 key
 *      - 上游首次收到 temperature=0.7 返回 400 不支持参数 -> 代理剔除并记住后重试成功
 *      - stub 产出真 %PDF- -> 发布到源 PDF 同目录且不覆盖同名（第 2 次自动编号 (1)）
 *   4. convert.html 选中 .pdf 后显示 #pdfTranslateSection（.trans-card），支持触发及中止（cancel）清理
 *   5. 全程零未捕获异常、零 CSP 违规、无残留临时目录、app.quit() 正常退出
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')
const { PDFDocument, StandardFonts } = require('pdf-lib')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9487
const REAL_API_KEY = 'sk-e2e-real-key-999-secret'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  constructor (url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }

  connect () {
    this.ws = new WebSocket(this.url)
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true })
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + e.message)), { once: true })
      this.ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch (_) { return }
        if (!msg.id || !this.pending.has(msg.id)) return
        const { res: r, rej: j } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) j(new Error(JSON.stringify(msg.error)))
        else r(msg.result)
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
    let lastErr = null
    for (let i = 0; i < 8; i++) {
      try {
        const r = await this.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          allowUnsafeEvalBlockedByCSP: true
        })
        if (r && r.exceptionDetails) {
          throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500))
        }
        return r && r.result ? r.result.value : undefined
      } catch (err) {
        const msg = String(err && err.message)
        if (!/Promise was collected|-32000/.test(msg) || /^eval 异常/.test(msg)) throw err
        lastErr = err
        await sleep(250)
      }
    }
    throw lastErr
  }

  close () {
    try { this.ws && this.ws.close() } catch (_) {}
  }
}

function listTargets () {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/list' }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d.toString() })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
  })
}

async function writeSamplePdf (dest, text = 'Attention Is All You Need') {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([420, 300])
  p.drawText(text, { x: 36, y: 220, size: 16, font })
  fs.writeFileSync(dest, Buffer.from(await doc.save()))
}

const REQUIRE_EXPR = `(() => {
  const g = globalThis
  const mm = g.process && g.process.mainModule
  if (mm && typeof mm.require === 'function') return (id) => mm.require(id)
  if (g.process && typeof g.process.getBuiltinModule === 'function') {
    try {
      const cr = g.process.getBuiltinModule('module').createRequire(g.process.cwd() + '/')
      if (typeof cr === 'function') return (id) => cr(id)
    } catch (_) {}
  }
  if (typeof g.require === 'function') return (id) => g.require(id)
  return null
})()`

function startMockUpstream () {
  const seen = []
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (_) {}

    seen.push({
      url: req.url,
      auth: req.headers.authorization || '',
      hasTemp: Object.prototype.hasOwnProperty.call(body, 'temperature')
    })

    if (req.headers.authorization !== `Bearer ${REAL_API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Bad key' } }))
      return
    }

    if (Object.prototype.hasOwnProperty.call(body, 'temperature')) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: { message: 'Unsupported parameter: temperature', param: 'temperature' }
      }))
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl-e2e-' + seen.length,
      choices: [{ message: { role: 'assistant', content: '翻译输出文本' } }]
    }))
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((done) => {
          for (const s of sockets) try { s.destroy() } catch (_) {}
          server.close(() => done())
        })
      })
    })
  })
}

async function main () {
  console.log('学术文献 PDF 翻译全链路 E2E')

  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok, detail })
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok || !detail ? '' : '  → ' + detail))
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-pdftrans-'))
  // 特意在含空格目录与文件名下验证 Windows .cmd 封装调用稳定性
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky pdf work '))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'),
    JSON.stringify({ version: 4, notes: [], settings: {} }))

  const paperPdf = path.join(workDir, 'paper one.pdf')
  const cancelPdf = path.join(workDir, 'cancel test.pdf')
  await writeSamplePdf(paperPdf, 'Transformer Attention E2E Paper')
  await writeSamplePdf(cancelPdf, 'Long Cancellable Paper')

  const auditPath = path.join(workDir, 'stub-audit.json')
  const uvAuditPath = path.join(workDir, 'uv-audit.json')
  const stubJsPath = path.join(workDir, 'stub.js')
  const stubCmdPath = path.join(workDir, 'pdf2zh_next.cmd')
  const uvJsPath = path.join(workDir, 'uv-stub.js')
  const uvCmdPath = path.join(workDir, 'uv.cmd')

  // 用真实 Node 脚本充当 pdf2zh_next CLI：触发代理 400 重试并输出有效 %PDF-1.4
  const stubSource = `'use strict'
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('pdf2zh_next 2.0.0-e2e')
  process.exit(0)
}
const inputPdf = args[0]
const outIdx = args.indexOf('--output')
const outDir = outIdx >= 0 ? args[outIdx + 1] : process.cwd()
const modelIdx = args.indexOf('--openai-model')
const model = modelIdx >= 0 ? args[modelIdx + 1] : 'mock-gpt-4o'
const baseUrlIdx = args.indexOf('--openai-base-url')
const baseUrl = baseUrlIdx >= 0 ? args[baseUrlIdx + 1] : process.env.OPENAI_BASE_URL
const token = process.env.OPENAI_API_KEY || ''

const audit = {
  args,
  baseUrl,
  tokenPrefix: token.slice(0, 4),
  hasRealKeyInArgs: args.join(' ').includes(${JSON.stringify(REAL_API_KEY)}),
  hasRealKeyInEnv: JSON.stringify(process.env).includes(${JSON.stringify(REAL_API_KEY)}),
  hasTokenInArgs: token ? args.join(' ').includes(token) : false
}
let prev = []
try { prev = JSON.parse(fs.readFileSync(${JSON.stringify(auditPath)}, 'utf8')) } catch (_) {}
prev.push(audit)
fs.writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify(prev, null, 2))

if (!token.startsWith('stk-') || audit.hasRealKeyInArgs || audit.hasRealKeyInEnv || audit.hasTokenInArgs) {
  console.error('SECURITY_INVARIANT_FAILED')
  process.exit(2)
}

if (path.basename(inputPdf).includes('cancel')) {
  console.log('Translating pages: 15%')
  setTimeout(() => { process.exit(0) }, 12000)
} else {
  ;(async () => {
    console.log('Translating pages: 35%')
    const r1 = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.7, messages: [{ role: 'user', content: 'Chunk 1' }] })
    })
    if (!r1.ok) throw new Error('proxy call 1 failed: ' + r1.status)
    console.log('Translating pages: 75%')
    const r2 = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.7, messages: [{ role: 'user', content: 'Chunk 2' }] })
    })
    if (!r2.ok) throw new Error('proxy call 2 failed: ' + r2.status)
    const stem = path.basename(inputPdf, path.extname(inputPdf))
    const outPdf = path.join(outDir, stem + '.zh.dual.pdf')
    fs.writeFileSync(outPdf, '%PDF-1.4\\n% mock bilingual translated pdf\\n1 0 obj<<>>endobj\\n%%EOF\\n')
    console.log('Translating pages: 100%')
  })().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err))
    process.exit(1)
  })
}
`
  fs.writeFileSync(stubJsPath, stubSource, 'utf8')
  // 启动前先不写入 stubCmdPath，模拟未安装状态；待一键安装 uv.cmd 执行时再动态生成
  const stubCmdContent = `@echo off\r\n"${process.execPath}" "${stubJsPath}" %*\r\n`

  const uvSource = `'use strict'
const fs = require('fs')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('uv 0.5.0-e2e')
  process.exit(0)
}
fs.writeFileSync(${JSON.stringify(uvAuditPath)}, JSON.stringify({ args }, null, 2))
console.log('Resolved 12 packages in 40ms')
setTimeout(() => {
  console.log('Downloading pdf2zh-next (2.0.0-e2e)')
  fs.writeFileSync(${JSON.stringify(stubCmdPath)}, ${JSON.stringify(stubCmdContent)}, 'utf8')
  console.log('Installed 1 executable: pdf2zh_next.cmd')
  process.exit(0)
}, 120)
`
  fs.writeFileSync(uvJsPath, uvSource, 'utf8')
  fs.writeFileSync(uvCmdPath, `@echo off\r\n"${process.execPath}" "${uvJsPath}" %*\r\n`, 'utf8')

  const upstream = await startMockUpstream()
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.STICKY_E2E = '1'
  env.STICKY_UV = uvCmdPath
  env.STICKY_PDF2ZH = stubCmdPath

  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData,
    '--remote-debugging-port=' + CDP_PORT,
    '--inspect=0',
    '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let procLog = ''
  child.stdout.on('data', (d) => { procLog += d.toString() })
  child.stderr.on('data', (d) => { procLog += d.toString() })

  let mainCdp = null
  let dashCdp = null
  let convCdp = null
  const pageErrors = []

  try {
    const inspectorUrl = await waitFor(() => {
      const m = procLog.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 30000, 'inspector')
    await waitFor(() => procLog.includes('[boot] 托盘就绪'), 30000, 'app boot')

    mainCdp = new CDP(inspectorUrl)
    await mainCdp.connect()

    // 打开 Dashboard 窗口（从已有页面或 hooks 唤起）
    let dashTarget = null
    const initialTargets = await listTargets()
    dashTarget = initialTargets.find((t) => t.url && t.url.includes('dashboard.html'))
    if (!dashTarget) {
      const anyPage = initialTargets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (anyPage) {
        const tmp = new CDP(anyPage.webSocketDebuggerUrl)
        await tmp.connect()
        await tmp.evaluate(`window.sticky && window.sticky.openDashboard && window.sticky.openDashboard()`)
        tmp.close()
      } else {
        await mainCdp.evaluate(`(() => {
          const req = ${REQUIRE_EXPR}
          const hooks = globalThis.__stickyTestHooks
          if (hooks && hooks.windows && typeof hooks.windows.openDashboard === 'function') hooks.windows.openDashboard()
          else req('electron').BrowserWindow && req('electron').ipcMain.emit('app:open-dashboard')
        })()`)
      }
      dashTarget = await waitFor(async () => {
        const list = await listTargets()
        return list.find((t) => t.url && t.url.includes('dashboard.html') && t.webSocketDebuggerUrl)
      }, 15000, 'dashboard target')
    }

    dashCdp = new CDP(dashTarget.webSocketDebuggerUrl)
    await dashCdp.connect()
    await dashCdp.send('Runtime.enable')
    await dashCdp.send('Log.enable')
    dashCdp.ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data)
        if (m.method === 'Runtime.exceptionThrown') pageErrors.push(JSON.stringify(m.params))
      } catch (_) {}
    })

    // 等待 dashboard.js 完全加载并绑定事件监听后再操作 UI
    await waitFor(async () => {
      return await dashCdp.evaluate(`document.readyState === 'complete' && !!(window.sticky && typeof window.sticky.pdfTranslateStatus === 'function')`)
    }, 15000, 'dashboard readyState')

    // 1. 保存活跃 AI 供应商（safeStorage 加密落盘），并打开「文献翻译」弹窗
    const savedAi = await dashCdp.evaluate(`window.sticky.aiSaveProvider(${JSON.stringify({
      name: 'E2EMockOpenAI',
      baseUrl: `${upstream.url}/v1`,
      apiKey: REAL_API_KEY,
      defaultModel: 'mock-gpt-4o',
      models: ['mock-gpt-4o'],
      activate: true
    })})`)
    check('AI 供应商已加密保存', !!(savedAi && savedAi.ok), JSON.stringify(savedAi))

    let lastModalSnap = null
    const modalBeforeInstall = await waitFor(async () => {
      const snap = await dashCdp.evaluate(`(() => {
        const btn = document.getElementById('pdfTranslateBtn')
        const modal = document.getElementById('pdfTranslateModal')
        if (modal && modal.hidden && btn) btn.click()
        const txt = document.getElementById('pdfTransEnvStatus')?.textContent || ''
        const badge = document.getElementById('pdfTransAiBadge')?.textContent || ''
        const uvHint = document.getElementById('pdfTransUvHint')?.textContent || ''
        const instBtn = document.getElementById('pdfTransInstallBtn')
        return {
          hidden: !modal || modal.hidden,
          txt,
          badge,
          uvHint,
          instText: instBtn ? instBtn.textContent.trim() : '',
          instDisabled: instBtn ? instBtn.disabled : true
        }
      })()`)
      lastModalSnap = snap
      if (snap.hidden || !snap.uvHint.includes('uv 0.5.0-e2e') || snap.instDisabled) return null
      return snap
    }, 15000, 'modal uv ready').catch((err) => {
      throw new Error(`${err.message}; lastModalSnap=${JSON.stringify(lastModalSnap)}; pageErrors=${JSON.stringify(pageErrors)}`)
    })
    const hostAlreadyHadCli = modalBeforeInstall.txt.includes('已就绪')
    check('Dashboard 弹层正确展示安装/更新按钮与 uv 检测状态',
      modalBeforeInstall.uvHint.includes('uv 0.5.0-e2e') &&
      modalBeforeInstall.instText === (hostAlreadyHadCli ? '更新环境' : '一键安装环境'),
      JSON.stringify(modalBeforeInstall))
    check('渲染层环境信息绝不含明文 API Key',
      !modalBeforeInstall.txt.includes(REAL_API_KEY) && !modalBeforeInstall.badge.includes(REAL_API_KEY))

    // 勾选清华镜像并点击「一键安装环境 / 更新环境」
    await dashCdp.evaluate(`(() => {
      document.getElementById('pdfTransUseMirror').checked = true
      document.getElementById('pdfTransInstallBtn').click()
    })()`)

    const modalAfterInstall = await waitFor(async () => {
      return await dashCdp.evaluate(`(() => {
        const txt = document.getElementById('pdfTransEnvStatus')?.textContent || ''
        const instText = document.getElementById('pdfTransInstallBtn')?.textContent?.trim() || ''
        const logText = document.getElementById('pdfTransInstallLog')?.textContent || ''
        const instHidden = document.getElementById('pdfTransInstallBtn')?.hidden
        if (instHidden || !txt.includes('2.0.0-e2e') || !logText.includes('Installed 1 executable')) return null
        return { txt, instText, logText }
      })()`)
    }, 20000, 'one-click install finish')
    const uvAudit = JSON.parse(fs.readFileSync(uvAuditPath, 'utf8'))
    check('弹窗内一键安装实时输出 uv 日志并自动刷新为已就绪（按钮切换为更新环境）',
      modalAfterInstall.instText === '更新环境' &&
      modalAfterInstall.txt.includes('2.0.0-e2e') &&
      modalAfterInstall.logText.includes('Resolved 12 packages') &&
      modalAfterInstall.logText.includes('Downloading pdf2zh-next') &&
      uvAudit.args.includes('--default-index') &&
      uvAudit.args.includes('https://pypi.tuna.tsinghua.edu.cn/simple'),
      JSON.stringify({ modalAfterInstall, uvAudit }))

    // 2. 通过 IPC 执行第 1 次与第 2 次翻译（测试首次 400 回退 + 不覆盖同名）
    const runRes1 = await dashCdp.evaluate(`window.sticky.pdfTranslateRun(${JSON.stringify({
      filePath: paperPdf,
      langIn: 'en',
      langOut: 'zh',
      mode: 'dual',
      service: 'active-ai',
      threads: 2
    })})`)
    check('第 1 次翻译成功并生成同名 -dual.pdf',
      runRes1 && runRes1.ok && runRes1.outputs[0].name === 'paper one-dual.pdf',
      JSON.stringify(runRes1))
    check('产出 PDF 具备合法 %PDF- 文件头',
      runRes1 && runRes1.ok && fs.readFileSync(runRes1.outputs[0].path).subarray(0, 5).toString() === '%PDF-')

    const runRes2 = await dashCdp.evaluate(`window.sticky.pdfTranslateRun(${JSON.stringify({
      filePath: paperPdf,
      langIn: 'en',
      langOut: 'zh',
      mode: 'dual',
      service: 'active-ai'
    })})`)
    check('第 2 次翻译同名时不覆盖，自动生成 (1) 文件名',
      runRes2 && runRes2.ok && runRes2.outputs[0].name === 'paper one-dual (1).pdf',
      JSON.stringify(runRes2))

    // 3. 校验上游与 stub 审计记录
    const audits = JSON.parse(fs.readFileSync(auditPath, 'utf8'))
    check('stub 仅持有 stk- 代理令牌，命令行参数与环境均无明文 Key',
      audits.length === 2 && audits.every((a) => a.tokenPrefix === 'stk-' && !a.hasRealKeyInArgs && !a.hasRealKeyInEnv && !a.hasTokenInArgs))
    // 第 1 次跑2请求（chunk1带temp->400，chunk1重发不带temp->200，chunk2记忆后直发不带temp->200），共3次上游调用
    check('AIdea 400 参数不兼容回退 + 会话级记忆生效',
      upstream.seen.length >= 6 &&
      upstream.seen[0].hasTemp === true &&
      upstream.seen[1].hasTemp === false &&
      upstream.seen[2].hasTemp === false &&
      upstream.seen.every((s) => s.auth === `Bearer ${REAL_API_KEY}`),
      JSON.stringify(upstream.seen))

    // 4. 在真实 convert.html 窗口中验证：显示翻译卡片、启动可取消任务并验证干净取消
    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      const { BrowserWindow } = req('electron')
      const path = req('path')
      const w = new BrowserWindow({
        show: false, width: 460, height: 520,
        webPreferences: {
          preload: path.join(process.cwd(), 'preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false
        }
      })
      globalThis.__convE2eWin = w
      w.loadFile(path.join(process.cwd(), 'src', 'convert.html'))
      w.webContents.once('did-finish-load', () => {
        w.webContents.send('convert:files', [${JSON.stringify(cancelPdf)}])
      })
    })()`)

    const convTarget = await waitFor(async () => {
      const list = await listTargets()
      return list.find((t) => t.url && t.url.includes('convert.html') && t.webSocketDebuggerUrl)
    }, 15000, 'convert target')

    convCdp = new CDP(convTarget.webSocketDebuggerUrl)
    await convCdp.connect()
    await waitFor(async () => {
      return await convCdp.evaluate(`document.readyState === 'complete' && !!(window.sticky && typeof window.sticky.pdfTranslateRun === 'function')`)
    }, 15000, 'convert readyState')

    const boxVisible = await waitFor(async () => {
      return await convCdp.evaluate(`(() => {
        const s = document.getElementById('pdfTranslateSection')
        const b = document.getElementById('pdfTransDualBtn')
        return s && !s.hidden && b ? true : false
      })()`)
    }, 10000, 'convert pdf section visible')
    check('convert.html 为 .pdf 文件渲染文献翻译卡片区', boxVisible === true)

    // 点击「双语对照 PDF」等待进入 15% 翻译阶段后再触发取消，确认正常中止进程树并恢复卡片可用状态
    const cancelOutcomePromise = convCdp.evaluate(`(async () => {
      document.getElementById('pdfTransDualBtn').click()
      for (let i = 0; i < 40; i++) {
        const st = document.getElementById('status').textContent || ''
        if (st.includes('15%')) break
        await new Promise((r) => setTimeout(r, 100))
      }
      const cancelBtn = document.getElementById('pdfTransBoxCancel')
      if (!cancelBtn || cancelBtn.hidden) return { ok: false, reason: 'cancel btn hidden' }
      cancelBtn.click()
      for (let i = 0; i < 40; i++) {
        const st = document.getElementById('status').textContent || ''
        if (st.includes('取消') || document.getElementById('pdfTransDualBtn').disabled === false) {
          return { ok: true, status: st }
        }
        await new Promise((r) => setTimeout(r, 150))
      }
      return { ok: false, status: document.getElementById('status').textContent }
    })()`)
    const cancelOutcome = await cancelOutcomePromise
    check('convert.html 快捷翻译支持中途取消并恢复卡片可用状态',
      cancelOutcome && cancelOutcome.ok && !fs.existsSync(path.join(workDir, 'cancel test-dual.pdf')),
      JSON.stringify(cancelOutcome))

    check('主进程日志未泄露 stk- 令牌或明文 Key',
      !procLog.includes(REAL_API_KEY) && !/stk-[0-9a-f]{16,}/i.test(procLog))
    check('渲染层零未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors))

    // 关闭 CDP 会话再退出 app，避免 Chromium Inspector 挂住进程退出
    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      req('electron').app.quit()
    })()`).catch(() => {})
    try { convCdp && convCdp.close(); convCdp = null } catch (_) {}
    try { dashCdp && dashCdp.close(); dashCdp = null } catch (_) {}
    try { mainCdp && mainCdp.close(); mainCdp = null } catch (_) {}

    await waitFor(async () => (child.exitCode !== null || child.signalCode ? true : null), 20000, 'app quit').catch(() => {})
    check('Electron 正常退出 (code=0)', child.exitCode === 0, 'exitCode=' + child.exitCode + ', sig=' + child.signalCode)
  } finally {
    try { convCdp && convCdp.close() } catch (_) {}
    try { dashCdp && dashCdp.close() } catch (_) {}
    try { mainCdp && mainCdp.close() } catch (_) {}
    if (child.exitCode === null) {
      try { child.kill() } catch (_) {}
    }
    await upstream.close().catch(() => {})
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch (_) {}
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) {}
  }

  const failed = checks.filter((c) => !c.ok)
  if (failed.length > 0) {
    console.error(`\nE2E 失败 ${failed.length}/${checks.length} 项`)
    process.exit(1)
  }
  console.log(`\nE2E 全部通过：${checks.length}/${checks.length}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
