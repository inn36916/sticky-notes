'use strict'

/**
 * 回答弹窗「多轮追问 + KaTeX LaTeX 渲染」真实 Electron 端到端验收（npm run test:e2e:followup）。
 *
 * 覆盖：
 *   1. 行内公式（$...$、\(...\)）与块级公式（$$...$$、\[...\]）渲染出真实 KaTeX DOM，无 katex-error
 *   2. 金额（$10 到 $20）与代码（`$not_math$`）不被误渲染为公式
 *   3. 从「翻译」卡片发起追问：主进程切换上下文问答提示词（不再沿用"只输出译文"）、携带原文与历史轮次
 *   4. 「复制」复制最新一轮回答；「重新生成」只重跑最新一轮，不丢失前序轮次
 *   5. 多轮卡片点置顶无损提升到系统级 alwaysOnTop 悬浮窗，且可在置顶窗内继续键盘输入回车追问
 *   6. 浅色回答弹窗背景下，追问输入框与 KaTeX 公式自动切换深色可读字体
 *   7. 全程无 CSP 违规、无错误日志、无未捕获异常
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9453

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
          returnByValue: true
        })
        if (r && r.exceptionDetails) {
          throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
        }
        return r && r.result ? r.result.value : undefined
      } catch (err) {
        const msg = String(err && err.message)
        if (!/Promise was collected|-32000/.test(msg) || /^eval 异常/.test(msg)) throw err
        lastErr = err
        await sleep(300)
      }
    }
    throw lastErr
  }
  close () { try { this.ws && this.ws.close() } catch (_) {} }
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

function listTargets () {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/list' }, (res) => {
      let body = ''
      res.on('data', d => { body += d.toString() })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => { req.destroy(new Error('timeout')) })
  })
}

const REPLIES = [
  '质能等价：售价 $10 到 $20，代码 `$not_math$`，公式 $E = mc^2$ 与 \\(p = mv\\)。',
  '$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\\[\na^2 + b^2 = c^2\n\\]',
  '重算结果：\\(\\alpha + \\beta = \\gamma\\)，且 $\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$。',
  '$$\n\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1\n$$'
]

function startMockAiServer () {
  const capturedRequests = []
  const server = http.createServer((req, res) => {
    if (req.url && req.url.endsWith('/chat/completions')) {
      let rawBody = ''
      req.setEncoding('utf8')
      req.on('data', chunk => { rawBody += chunk })
      req.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(rawBody) } catch (_) {}
        const idx = capturedRequests.length
        capturedRequests.push(parsed)
        const reply = REPLIES[idx] || ('Reply-' + idx)
        const mid = Math.ceil(reply.length / 2)
        const chunks = [reply.slice(0, mid), reply.slice(mid)]

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
        let step = 0
        const timer = setInterval(() => {
          if (res.destroyed || res.writableEnded) { clearInterval(timer); return }
          if (step < chunks.length) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunks[step] } }] }) + '\n\n')
            step++
          } else {
            clearInterval(timer)
            res.write('data: [DONE]\n\n')
            res.end()
          }
        }, 70)
        res.on('close', () => clearInterval(timer))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, capturedRequests })
    })
  })
}

function attachPageMonitor (cdp, label, pageErrors, cspViolations) {
  cdp.ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch (_) { return }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(label + ': ' + JSON.stringify(msg.params && msg.params.exceptionDetails).slice(0, 300))
    }
    if (msg.method === 'Log.entryAdded') {
      const e = (msg.params && msg.params.entry) || {}
      const txt = String(e.text || '')
      if (/Content Security Policy/i.test(txt)) cspViolations.push(label + ': ' + txt)
      if (e.level === 'error') pageErrors.push(label + ': ' + txt)
    }
  })
}

async function main () {
  console.log('回答弹窗追问 + LaTeX 渲染 e2e')

  const { server: aiServer, port: aiPort, capturedRequests } = await startMockAiServer()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-followup-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'), JSON.stringify({
    version: 4,
    notes: [],
    ai: {
      activeId: 'p-e2e',
      providers: [{
        id: 'p-e2e',
        name: 'MockLatexSSE',
        baseUrl: `http://127.0.0.1:${aiPort}/v1`,
        apiKey: 'sk-e2e-mock',
        models: ['gpt-e2e'],
        defaultModel: 'gpt-e2e'
      }]
    },
    settings: { globalSelect: false }
  }))

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.STICKY_E2E = '1'
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
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail })
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok || !detail ? '' : '  → ' + detail))
  }

  let mainCdp = null
  let dashCdp = null
  let overlayCdp = null
  const pageErrors = []
  const cspViolations = []

  try {
    const inspectorUrl = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 30000, 'inspector')
    await waitFor(async () => log.includes('[boot] 托盘就绪') ? true : null, 30000, '启动完成')

    mainCdp = new CDP(inspectorUrl)
    await mainCdp.connect()

    await mainCdp.evaluate(`globalThis.__stickyTestHooks.windows.openDashboard(); true`)
    const dashTarget = await waitFor(async () => {
      const list = await listTargets()
      return (list || []).find(t => t.type === 'page' && /dashboard\.html/.test(t.url || '')) || null
    }, 15000, 'dashboard target')

    dashCdp = new CDP(dashTarget.webSocketDebuggerUrl)
    await dashCdp.connect()
    await dashCdp.send('Runtime.enable')
    await dashCdp.send('Log.enable')
    attachPageMonitor(dashCdp, 'dashboard', pageErrors, cspViolations)
    await waitFor(async () => dashCdp.evaluate(
      `document.readyState === 'complete' && typeof window.katex !== 'undefined' && typeof window.renderAiMarkdown === 'function'`
    ), 15000, 'dashboard + KaTeX 就绪')

    await dashCdp.evaluate(`(async () => {
      const len = () => document.body.innerHTML.length
      let last = -1
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 120))
        if (len() === last) return true
        last = len()
      }
      return true
    })()`)

    // ---------------------------------------------------------------- 1. 触发「翻译」→ 渲染行内 KaTeX
    await dashCdp.evaluate(`(() => {
      const host = document.createElement('div')
      host.id = 'e2e-sel-latex'
      host.textContent = 'Energy-mass equivalence'
      host.style.cssText = 'position:fixed;left:40px;top:240px;font-size:16px;color:#000;-webkit-user-select:text;user-select:text;z-index:9;'
      document.body.appendChild(host)
      const r = document.createRange()
      r.selectNodeContents(host)
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    })()`)

    await waitFor(async () => dashCdp.evaluate(
      `(() => { const b = document.querySelector('.ai-bar'); return !!b && !b.hidden })()`
    ), 5000, '工具条浮出')
    await dashCdp.evaluate(`document.querySelector('.ai-bar [data-act="translate"]').click()`)

    const ovTarget = await waitFor(async () => {
      const list = await listTargets()
      return (list || []).find(t => t.type === 'page' && /overlay\.html/.test(t.url || '') && /role=card/.test(t.url || '')) || null
    }, 15000, 'overlay card target')
    overlayCdp = new CDP(ovTarget.webSocketDebuggerUrl)
    await overlayCdp.connect()
    await overlayCdp.send('Runtime.enable')
    await overlayCdp.send('Log.enable')
    attachPageMonitor(overlayCdp, 'overlay', pageErrors, cspViolations)

    await waitFor(async () => overlayCdp.evaluate(
      `(() => { const p = document.querySelector('.ai-panel'); return !!p && !p.hidden && p.dataset.busy === '0' })()`
    ), 10000, '首轮翻译完成')

    const turn0Dom = await overlayCdp.evaluate(`(() => {
      const body = document.querySelector('.ai-panel .ai-body')
      const katexEls = Array.from(body.querySelectorAll('.katex'))
      const codeEl = body.querySelector('code')
      const rect = katexEls[0] ? katexEls[0].getBoundingClientRect() : null
      return {
        katexCount: katexEls.length,
        errorCount: body.querySelectorAll('.katex-error').length,
        hasBox: !!rect && rect.width > 0 && rect.height > 0,
        text: body.textContent,
        codeText: codeEl ? codeEl.textContent : '',
        followupDisabled: document.querySelector('.ai-panel .ai-followup-send').disabled
      }
    })()`)

    check('首轮回答真实渲染 KaTeX 行内公式且无报错',
      turn0Dom.katexCount === 2 && turn0Dom.errorCount === 0 && turn0Dom.hasBox,
      JSON.stringify(turn0Dom))
    check('金额 $10 到 $20 与行内代码 `$not_math$` 不被误判为公式',
      turn0Dom.text.includes('$10 到 $20') && turn0Dom.codeText === '$not_math$',
      JSON.stringify(turn0Dom))
    check('追问框空内容时「追问」按钮默认禁用', turn0Dom.followupDisabled === true, String(turn0Dom.followupDisabled))

    // ---------------------------------------------------------------- 2. 独立回答窗内追问（块级公式 + 多轮上下文）
    await overlayCdp.evaluate(`(() => {
      const input = document.querySelector('.ai-panel .ai-followup-input')
      input.value = '请给出积分和勾股定理公式'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const btnEnabled = await overlayCdp.evaluate(`!document.querySelector('.ai-panel .ai-followup-send').disabled`)
    check('输入追问内容后「追问」按钮变可用', btnEnabled === true, String(btnEnabled))

    await overlayCdp.evaluate(`document.querySelector('.ai-panel .ai-followup-send').click()`)
    await waitFor(async () => overlayCdp.evaluate(
      `(() => { const p = document.querySelector('.ai-panel'); return !!p && p.querySelectorAll('.ai-turn').length === 1 && p.dataset.busy === '0' })()`
    ), 10000, '第一轮追问完成')

    const req1 = capturedRequests[1]
    check('从「翻译」发起追问时切换为上下文问答提示词（不再限制"只输出译文"）',
      !!req1 && Array.isArray(req1.messages) &&
      req1.messages[0].role === 'system' &&
      !req1.messages[0].content.includes('只输出译文') &&
      req1.messages.some(m => m.role === 'user' && m.content.includes('Energy-mass equivalence')) &&
      req1.messages.some(m => m.role === 'assistant' && m.content.includes('质能等价')) &&
      req1.messages[req1.messages.length - 1].content === '请给出积分和勾股定理公式',
      JSON.stringify(req1 && req1.messages))

    const turn1Dom = await overlayCdp.evaluate(`(() => {
      const turn = document.querySelector('.ai-panel .ai-turn')
      const blocks = Array.from(turn.querySelectorAll('.ai-math-block .katex-display'))
      const r = blocks[0] ? blocks[0].getBoundingClientRect() : null
      return {
        qText: turn.querySelector('.ai-q-follow') ? turn.querySelector('.ai-q-follow').textContent : '',
        blockCount: blocks.length,
        blockRect: r ? { width: r.width, height: r.height } : null,
        errorCount: turn.querySelectorAll('.katex-error').length
      }
    })()`)
    check('追问回答正确渲染 $$...$$ 与 \\[...\\] 块级公式',
      turn1Dom.qText === '请给出积分和勾股定理公式' &&
      turn1Dom.blockCount === 2 &&
      turn1Dom.blockRect && turn1Dom.blockRect.height > 10 &&
      turn1Dom.errorCount === 0,
      JSON.stringify(turn1Dom))

    await overlayCdp.evaluate(`document.querySelector('.ai-panel [data-a="copy"]').click()`)
    await sleep(120)
    const copiedLatest = await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      return req('electron').clipboard.readText()
    })()`)
    check('「复制」按钮复制最新一轮追问回答', copiedLatest === REPLIES[1], JSON.stringify(copiedLatest))

    // ---------------------------------------------------------------- 3. 重新生成最后一轮
    await overlayCdp.evaluate(`document.querySelector('.ai-panel [data-a="regen"]').click()`)
    await waitFor(async () => overlayCdp.evaluate(
      `(() => { const p = document.querySelector('.ai-panel'); const t = p.querySelector('.ai-turn'); return !!t && t.textContent.includes('重算结果') && p.dataset.busy === '0' })()`
    ), 10000, '重新生成追问轮完成')

    const afterRegen = await overlayCdp.evaluate(`(() => ({
      turnCount: document.querySelectorAll('.ai-panel .ai-turn').length,
      bodyText: document.querySelector('.ai-panel .ai-body').textContent,
      errors: document.querySelectorAll('.ai-panel .katex-error').length
    }))()`)
    check('「重新生成」只重跑最后一轮追问并保留首轮对话',
      capturedRequests.length === 3 &&
      afterRegen.turnCount === 1 &&
      afterRegen.bodyText.includes('质能等价') &&
      afterRegen.bodyText.includes('重算结果') &&
      afterRegen.errors === 0,
      JSON.stringify({ reqCount: capturedRequests.length, afterRegen }))

    // ---------------------------------------------------------------- 4. 原地置顶回答窗 + 置顶后继续追问
    await overlayCdp.evaluate(`document.querySelector('.ai-panel .ai-pin').click()`)
    await sleep(250)

    const ovMain = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      const w = wins[wins.length - 1]
      return { visible: !!w && w.isVisible(), top: !!w && w.isAlwaysOnTop() }
    })()`)
    check('多轮回答卡片点置顶后成为真实置顶窗', ovMain.visible && ovMain.top, JSON.stringify(ovMain))

    await waitFor(async () => overlayCdp.evaluate(
      `!!document.querySelector('.ai-panel .ai-followup-input') && document.querySelectorAll('.ai-panel .ai-turn').length === 1`
    ), 8000, '置顶窗保留多轮历史')

    await overlayCdp.evaluate(`(() => {
      const input = document.querySelector('.ai-panel .ai-followup-input')
      input.focus()
      input.value = '请再给出极限公式'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return true
    })()`)

    await waitFor(async () => overlayCdp.evaluate(
      `(() => { const turns = document.querySelectorAll('.ai-panel .ai-turn'); const stop = document.querySelector('.ai-panel [data-a="stop"]'); return turns.length === 2 && stop && stop.hidden === true })()`
    ), 10000, '悬浮窗内第三轮追问完成')

    const req3 = capturedRequests[3]
    const ovTurn2 = await overlayCdp.evaluate(`(() => {
      const turns = document.querySelectorAll('.ai-panel .ai-turn')
      const last = turns[1]
      return {
        turnCount: turns.length,
        q: last.querySelector('.ai-q-follow') ? last.querySelector('.ai-q-follow').textContent : '',
        blocks: last.querySelectorAll('.ai-math-block .katex-display').length,
        errors: document.querySelectorAll('.ai-panel .katex-error').length
      }
    })()`)
    const stillPinned = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      return wins.length > 0 && wins[wins.length - 1].isAlwaysOnTop()
    })()`)

    check('置顶悬浮窗内回车追问携带完整上下文、渲染 KaTeX 且保持真实置顶',
      !!req3 &&
      req3.messages.some(m => m.content.includes('重算结果')) &&
      req3.messages[req3.messages.length - 1].content === '请再给出极限公式' &&
      ovTurn2.turnCount === 2 &&
      ovTurn2.q === '请再给出极限公式' &&
      ovTurn2.blocks === 1 &&
      ovTurn2.errors === 0 &&
      stillPinned === true,
      JSON.stringify({ ovTurn2, stillPinned, msgs: req3 && req3.messages }))

    // ---------------------------------------------------------------- 5. 浅色背景下的追问框与公式对比度
    await dashCdp.evaluate(`window.sticky.popupAppearance({ answer: { color: '#fff6d6', opacity: 0.9 } })`)
    await sleep(200)
    const lightContrast = await overlayCdp.evaluate(`(() => {
      const inp = document.querySelector('.ai-panel .ai-followup-input')
      const body = document.querySelector('.ai-panel .ai-body')
      return {
        tone: document.documentElement.dataset.aiPanelTone,
        inputColor: getComputedStyle(inp).color,
        bodyColor: getComputedStyle(body).color
      }
    })()`)
    check('浅色回答弹窗背景下追问框与正文自动切换深色可读字体',
      lightContrast.tone === 'light' &&
      lightContrast.inputColor === 'rgb(15, 23, 42)' &&
      lightContrast.bodyColor === 'rgb(31, 41, 55)',
      JSON.stringify(lightContrast))

    check('全窗口无 CSP 违规日志', cspViolations.length === 0, JSON.stringify(cspViolations))
    check('全窗口无未捕获异常或 error 日志', pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 400))

    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      req('electron').app.quit()
      return true
    })()`).catch(() => {})
  } catch (err) {
    console.error('\n[e2e 异常] ' + (err && err.message ? err.message : err))
    if (log) console.error('--- 应用日志尾部 ---\n' + log.slice(-3000))
    checks.push({ name: 'e2e 未异常中断', ok: false, detail: String(err && err.message) })
    try {
      if (mainCdp) await mainCdp.evaluate(`(() => { const r=${REQUIRE_EXPR}; r('electron').app.quit(); return true })()`)
    } catch (_) {}
  } finally {
    overlayCdp && overlayCdp.close()
    dashCdp && dashCdp.close()
    mainCdp && mainCdp.close()
    aiServer.close()
    await sleep(500)
    try { child.kill() } catch (_) {}
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) {}
  }

  const passed = checks.filter(c => c.ok).length
  const failed = checks.filter(c => !c.ok)
  console.log('\n结果：' + passed + '/' + checks.length + ' 通过')
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log('  - ' + f.name + (f.detail ? '  → ' + f.detail : ''))
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
