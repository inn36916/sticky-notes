'use strict'

/**
 * 真实 Electron 端到端回归（手工/CI 单独跑，不进 npm test）。
 *
 * 纪律（评估报告 §8 G-13）：
 *  - 必须用隔离 --user-data-dir，绝不碰真实 sticky-notes.json；
 *  - 必须走 app.quit() → before-quit（等价托盘「退出」），严禁 Stop-Process -Force 代替；
 *  - 用例覆盖 TC-01（收纳态退出几何）、TC-07（编辑后 <350ms 退出不丢字）、
 *    TC-10 迁移幂等、落盘负向断言（任何 width/height ≤60 都不允许）。
 *
 * 运行：npm run test:e2e
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const http = require('http')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9333

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, timeout = 20000, label = '') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch (_) {}
    await sleep(150)
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
  send (method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)) }
      }, 8000)
    })
  }
  async evaluate (expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true
    })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result ? r.result.value : null
  }
  close () { try { this.ws.close() } catch (_) {} }
}

const fixture = {
  version: 1,
  notes: [
    {
      id: 'e2e-collapsed', title: '收纳便签',
      html: '<p>E2E-COLLAPSED-MARK</p>', preview: 'E2E-COLLAPSED-MARK',
      color: '#FFF3B0',
      bounds: { x: 120, y: 100, width: 274, height: 473 },
      collapsed: true, collapseEdge: 'bottom', edgeCollapse: true,
      visible: true, alwaysOnTop: false, mode: 'edit'
    },
    {
      id: 'e2e-expanded', title: '展开便签',
      html: '<p>E2E-EXPANDED-MARK</p>', preview: 'E2E-EXPANDED-MARK',
      color: '#DCEBFF',
      bounds: { x: 600, y: 120, width: 400, height: 500 },
      collapsed: false, collapseEdge: null, edgeCollapse: true,
      visible: true, alwaysOnTop: false, mode: 'edit'
    }
  ],
  ai: { activeId: '', providers: [] },
  settings: { globalSelect: false }
}

/**
 * 假 AI 网关：
 *   /hang/*   接受请求后永不响应（模拟网关挂死 / 上游卡住）
 *   /stream/* 正常 SSE，每 200ms 一个增量，共 8 个
 * 用来验证「超时能自己收尾」且「正常流不会被误杀」。
 */
function startAiServer () {
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/stream/') === 0) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      let n = 0
      const timer = setInterval(() => {
        n++
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'X' + n } }] }) + '\n\n')
        if (n >= 8) {
          clearInterval(timer)
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }, 200)
      req.on('close', () => clearInterval(timer))
      return
    }
    // 其它路径：保持连接、不写任何响应
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 在页面里发一次 aiAsk，等到 error/done 为止（不 await invoke，避免被挂死请求拖住） */
function askAi (cdp, requestId, providerId, timeoutMs) {
  return cdp.evaluate(`(async () => {
    window.__aiEvents = window.__aiEvents || []
    if (!window.__aiOff) {
      window.__aiOff = window.sticky.onAiEvent((ev) => {
        if (!ev) return
        window.__aiEvents.push({
          requestId: ev.requestId, type: ev.type,
          error: ev.error || '', aborted: !!ev.aborted
        })
      })
    }
    window.__aiEvents.length = 0
    window.sticky.aiAsk({
      requestId: ${JSON.stringify(requestId)},
      providerId: ${JSON.stringify(providerId)},
      text: '端到端超时测试',
      action: 'explain'
    })
    const t0 = Date.now()
    while (Date.now() - t0 < ${Number(timeoutMs)}) {
      const done = window.__aiEvents.some(e =>
        e.requestId === ${JSON.stringify(requestId)} && (e.type === 'error' || e.type === 'done'))
      if (done) break
      await new Promise(r => setTimeout(r, 100))
    }
    return {
      ms: Date.now() - t0,
      events: window.__aiEvents.filter(e => e.requestId === ${JSON.stringify(requestId)})
    }
  })()`)
}

async function main () {
  if (!fs.existsSync(ELECTRON)) throw new Error('未找到 electron.exe: ' + ELECTRON)
  const ai = await startAiServer()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-'))
  const dataFile = path.join(userData, 'sticky-notes.json')
  const seeded = JSON.parse(JSON.stringify(fixture))
  seeded.ai = {
    activeId: 'e2e-ai-hang',
    providers: [
      {
        id: 'e2e-ai-hang', name: 'E2E 挂死网关',
        baseUrl: 'http://127.0.0.1:' + ai.port + '/hang',
        apiKey: 'e2e-key', models: ['e2e-model'], defaultModel: 'e2e-model'
      },
      {
        id: 'e2e-ai-stream', name: 'E2E 正常流',
        baseUrl: 'http://127.0.0.1:' + ai.port + '/stream',
        apiKey: 'e2e-key', models: ['e2e-model'], defaultModel: 'e2e-model'
      }
    ]
  }
  fs.writeFileSync(dataFile, JSON.stringify(seeded, null, 2), 'utf8')

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  // 把 45s 空闲超时压到 1.5s，让超时用例可端到端执行
  env.STICKY_AI_IDLE_MS = '1500'
  env.STICKY_AI_TOTAL_MS = '8000'
  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData,
    '--remote-debugging-port=' + CDP_PORT,
    '--inspect=0',
    '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let log = ''
  let inspectorUrl = null
  const onData = (d) => {
    const s = d.toString()
    log += s
    // 只要 Node 主进程 inspector（"Debugger listening on"），不要 Chromium 的
    // "DevTools listening on ws://.../devtools/browser/..."（那是 CDP browser 端点）
    const m = s.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
    if (m && !inspectorUrl) inspectorUrl = m[1]
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const cdps = []
  const result = { steps: [], disk: null, logTail: '' }
  let failed = null

  try {
    const targets = await waitFor(async () => {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')
      const list = await r.json()
      return list.filter(t => t.type === 'page' && /note\.html/.test(t.url)).length >= 2 ? list : null
    }, 25000, '两个便签渲染页就绪')
    result.steps.push('boot: 2 个便签窗口已创建')

    // 找到「展开态」那张便签做编辑（TC-07）
    let editorCdp = null
    for (const t of targets.filter(t => t.type === 'page' && /note\.html/.test(t.url))) {
      const c = new CDP(t.webSocketDebuggerUrl)
      await c.connect()
      cdps.push(c)
      const html = await waitFor(async () => c.evaluate(
        "document.querySelector('#editor') ? document.querySelector('#editor').innerHTML : ''"
      ), 15000, 'editor 初始化')
      if (String(html).indexOf('E2E-EXPANDED-MARK') >= 0) { editorCdp = c; break }
    }
    assert.ok(editorCdp, '未找到展开态便签渲染页')
    result.steps.push('preload/contextBridge: window.sticky 可用，note.js 已完成初始化')

    // 编辑后立刻退出：不等渲染层 350ms 防抖（TC-07）
    const afterEdit = await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = '<p>E2E-EDITED-MARK</p>'
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return document.querySelector('#saved').textContent
    })()`)
    result.steps.push('edit: 触发 input 后状态 = ' + afterEdit)

    // E-13：渲染层全局异常兜底 —— 故意抛一个带标记的错误，必须
    //   a) 页面里出现可见提示  b) 上报主进程落进 app-errors.log（退出后断言）
    const guardState = await editorCdp.evaluate(`(() => {
      window.dispatchEvent(new ErrorEvent('error', {
        message: 'E2E-GUARD-MARK', error: new Error('E2E-GUARD-MARK')
      }))
      const el = document.getElementById('__stickyGuardTip')
      return { banner: el ? el.textContent : '' }
    })()`)
    assert.ok(String(guardState && guardState.banner).indexOf('E2E-GUARD-MARK') >= 0,
      '渲染层异常未给出可见提示: ' + JSON.stringify(guardState))
    result.steps.push('guard: 页面已出现可见提示')
    await sleep(400)                 // 等 IPC 落盘

    // 真正的 before-quit：主进程 app.quit()，等价托盘「退出」（严禁强杀）
    const url = await waitFor(() => inspectorUrl, 15000, '主进程 inspector ws')
    const mainCdp = new CDP(url)
    await mainCdp.connect()
    cdps.push(mainCdp)

    // E-13：app:copy-text 必须回传真实结果（以前吞异常后无条件 true）。
    // 用主进程剪贴板备份/还原，避免弄脏用户当前剪贴板内容。
    const clipExpr = (stmt) => `(() => {
      try {
        const m = globalThis.process && globalThis.process.mainModule
        let e = null
        if (m && m.require) e = m.require('electron')
        if (!e && typeof require === 'function') e = require('electron')
        if (!e && m && m.constructor && m.constructor._load) e = m.constructor._load('electron', m, false)
        if (!e && typeof Module === 'function' && Module._load) e = Module._load('electron', null, false)
        if (!e && typeof process === 'object' && process.getBuiltinModule) e = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron')
        if (!e || !e.clipboard) return null
        ${stmt}
      } catch (err) { return null }
    })()`
    const prevClip = await mainCdp.evaluate(clipExpr('return e.clipboard.readText()'))
    const copyRes = await editorCdp.evaluate(`(async () => {
      try { return await window.sticky.copyText('E2E-CLIP-MARK') } catch (err) { return { ok: false, error: String(err) } }
    })()`)
    if (typeof prevClip === 'string') {
      await mainCdp.evaluate(clipExpr('e.clipboard.writeText(' + JSON.stringify(prevClip) + '); return true'))
    }
    assert.equal(copyRes && copyRes.ok, true, 'app:copy-text 契约失败: ' + JSON.stringify(copyRes))
    result.steps.push('copy: app:copy-text 返回 ' + JSON.stringify(copyRes) + '（剪贴板已还原）')

    // E-13：AI 流式超时。挂死网关必须在空闲超时后自己收尾，
    // 且不能被误报成「已取消」，否则用户看不出是服务端卡住了。
    const hang = await askAi(editorCdp, 'e2e-ai-hang', 'e2e-ai-hang', 8000)
    const hangErr = hang.events.find(e => e.type === 'error')
    assert.ok(hangErr, '挂死网关未触发超时: ' + JSON.stringify(hang))
    assert.match(hangErr.error, /响应超时/, '超时文案不对: ' + hangErr.error)
    assert.ok(hang.ms < 6000, '超时收尾过慢: ' + hang.ms + 'ms')
    result.steps.push('AI 超时 PASS: ' + hang.ms + 'ms 收尾，文案 = ' + hangErr.error)

    // 正常流不得被看门狗误杀
    const streamed = await askAi(editorCdp, 'e2e-ai-stream', 'e2e-ai-stream', 8000)
    const streamErr = streamed.events.find(e => e.type === 'error')
    const streamDone = streamed.events.find(e => e.type === 'done')
    const deltaCount = streamed.events.filter(e => e.type === 'delta').length
    assert.ok(!streamErr, '正常流被误判超时: ' + JSON.stringify(streamed))
    assert.ok(streamDone, '正常流未收尾: ' + JSON.stringify(streamed))
    assert.ok(deltaCount >= 2, '正常流增量过少: ' + deltaCount)
    result.steps.push('AI 流式 PASS: ' + deltaCount + ' 个增量后正常结束')

    const quit = await mainCdp.evaluate(`(() => {
      try {
        const m = globalThis.process && globalThis.process.mainModule
        let e = null
        if (m && m.require) e = m.require('electron')
        if (!e && typeof require === 'function') e = require('electron')
        if (!e && m && m.constructor && m.constructor._load) e = m.constructor._load('electron', m, false)
        if (!e && typeof Module === 'function' && Module._load) e = Module._load('electron', null, false)
        if (!e && typeof process === 'object' && process.getBuiltinModule) e = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron')
        if (!e || !e.app) return {
          ok: false, err: 'no electron module', hasMain: !!m,
          hasRequire: typeof require, hasModule: typeof Module
        }
        e.app.quit()
        return { ok: true }
      } catch (err) { return { ok: false, err: String(err) } }
    })()`)
    assert.equal(quit && quit.ok, true, 'app.quit() 调用失败: ' + JSON.stringify(quit))
    result.steps.push('quit: before-quit 已触发（非强杀）')
    // --inspect=0 下若 debugger 仍连着，主进程会停在 "Waiting for the debugger
    // to disconnect..."，断开后让它自然退出（不做强杀）
    mainCdp.close()

    await waitFor(async () => child.exitCode !== null, 12000, '进程正常退出').catch(() => {})
    assert.notEqual(child.exitCode, null, '应用未自然退出（可能仍被 debugger 挂住）')
    result.steps.push('exit: 自然退出 exitCode = ' + child.exitCode)

    const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    result.disk = disk

    // ---- 断言 ----
    assert.equal(disk.version, require('../lib/migrations').CURRENT_VERSION, 'E-02 迁移未生效')
    const collapsed = disk.notes.find(n => n.id === 'e2e-collapsed')
    const expanded = disk.notes.find(n => n.id === 'e2e-expanded')
    assert.ok(collapsed && expanded)

    // TC-01：收纳态退出不得把 50 DIP 窄条写回 bounds
    assert.deepEqual(collapsed.bounds, { x: 120, y: 100, width: 274, height: 473 },
      'L-1 复发：收纳态 bounds 被改坏 -> ' + JSON.stringify(collapsed.bounds))
    assert.equal(collapsed.collapsed, true)
    assert.equal(collapsed.collapseEdge, 'bottom')
    result.steps.push('TC-01 PASS: 收纳态 bounds 逐字段不变 ' + JSON.stringify(collapsed.bounds))

    // TC-07：编辑后 <350ms 退出，末段文字不得丢
    assert.ok(String(expanded.html).indexOf('E2E-EDITED-MARK') >= 0,
      'N-01 复发：编辑后立刻退出丢正文 -> ' + expanded.html)
    assert.ok(String(expanded.preview).indexOf('E2E-EDITED-MARK') >= 0,
      'TC-07：preview 未同步 -> ' + expanded.preview)
    assert.equal(disk.recoveredIds, undefined, '迁移内部字段不得落盘')
    result.steps.push('TC-07 PASS: 编辑后立刻退出，正文 + preview 均未丢')

    // 落盘负向断言
    for (const n of disk.notes) {
      assert.ok(n.bounds.width > 60 && n.bounds.height > 60,
        '落盘出现窄条几何: ' + n.id + ' ' + JSON.stringify(n.bounds))
      assert.notEqual(n.bounds.width, 260, '出现被 clampBounds 钳出的「面条」宽度')
    }
    result.steps.push('负向断言 PASS: 无 ≤60 宽高、无 260 钳制面条')

    // E-13：渲染层异常必须落盘（打包后没有控制台，console.error 等于丢失）
    const errLog = path.join(userData, 'app-errors.log')
    assert.ok(fs.existsSync(errLog), '缺少 app-errors.log，渲染层异常未上报')
    const errText = fs.readFileSync(errLog, 'utf8')
    assert.ok(errText.indexOf('E2E-GUARD-MARK') >= 0,
      '渲染层异常未写入日志: ' + errText.slice(0, 500))
    result.steps.push('guard PASS: app-errors.log 已记录渲染层异常')

    // 升级前快照 + 按天快照
    const files = fs.readdirSync(userData).filter(f => f.indexOf('sticky-notes.json.') === 0)
    assert.ok(files.some(f => f.indexOf('.pre-v' + require('../lib/migrations').CURRENT_VERSION + '-') >= 0), '缺少升级前快照')
    result.steps.push('快照 PASS: ' + files.join(', '))
  } catch (err) {
    failed = err
    result.error = err && err.message ? err.message : String(err)
  } finally {
    for (const c of cdps) c.close()
    if (child.exitCode === null) child.kill()
    try { ai.server.closeAllConnections() } catch (_) {}
    try { ai.server.close() } catch (_) {}
    result.logTail = log.slice(-2500)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) {}
    console.log(JSON.stringify(result, null, 2))
    process.exit(failed ? 1 : 0)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
