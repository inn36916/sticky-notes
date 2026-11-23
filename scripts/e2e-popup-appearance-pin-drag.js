'use strict'

/**
 * 弹窗外观设置 + 工具弹窗拖动 + 回答弹窗真实置顶与置顶后拖动端到端验收（npm run test:e2e:popup）。
 *
 * 覆盖：
 *   1. 主页「弹窗外观」入口打开设置弹窗、实时预览与浅色自适应对比度
 *   2. 背景颜色与透明度实时同步到主页、便签窗、全局划词窗，且仅背景透明、并落盘持久化
 *   3. 页内与全局划词「工具弹窗（.ai-bar）」均可通过抓手真实鼠标拖拽移动，展开提问不回弹
 *   4. 页内回答弹窗点置顶无损提升为系统级 alwaysOnTop 置顶窗，且在途 AI 流式输出不中断
 *   5. 全局回答弹窗置顶后真实 isAlwaysOnTop()=true、原地置顶不跳顶部、拖动后保持置顶、外部点击/划词不关闭、取消置顶恢复
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9452

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

function startMockAiServer () {
  const reqLogs = []
  const server = http.createServer((req, res) => {
    reqLogs.push(req.method + ' ' + req.url)
    if (req.url && req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      if (typeof res.flushHeaders === 'function') res.flushHeaders()
      let n = 0
      const timer = setInterval(() => {
        n++
        if (res.destroyed || res.writableEnded) { clearInterval(timer); return }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'S' + n + ' ' } }] }) + '\n\n')
        if (n >= 8) {
          clearInterval(timer)
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }, 150)
      res.on('close', () => clearInterval(timer))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, reqLogs })
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

async function dragByMouse (cdp, x, y, dx, dy, { windowMoves = false } = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    clickCount: 1
  })
  await sleep(30)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x + dx),
    y: Math.round(y + dy),
    button: 'left',
    buttons: 1
  })
  await sleep(windowMoves ? 150 : 60)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(windowMoves ? x : x + dx),
    y: Math.round(windowMoves ? y : y + dy),
    button: 'left',
    clickCount: 1
  })
  await sleep(120)
}

async function dragByMouseSteps (cdp, x, y, dx, dy, steps = 65, { windowMoves = false } = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    clickCount: 1
  })
  await sleep(30)
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x + (dx * i) / steps),
      y: Math.round(y + (dy * i) / steps),
      button: 'left',
      buttons: 1
    })
    await sleep(14)
  }
  await sleep(windowMoves ? 150 : 60)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(windowMoves ? x : x + dx),
    y: Math.round(windowMoves ? y : y + dy),
    button: 'left',
    clickCount: 1
  })
  await sleep(120)
}

async function main () {
  console.log('弹窗外观 + 工具拖动 + 置顶验收 e2e')

  const { server: aiServer, port: aiPort, reqLogs } = await startMockAiServer()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-popup-'))
  const dataFile = path.join(userData, 'sticky-notes.json')
  fs.writeFileSync(dataFile, JSON.stringify({
    version: 4,
    notes: [{
      id: 'e2e-note',
      title: '验收便签',
      html: '<p>测试文本内容</p>',
      preview: '测试文本内容',
      color: '#FFF3B0',
      bounds: { x: 60, y: 60, width: 380, height: 420 },
      collapsed: false,
      collapseEdge: null,
      edgeCollapse: true,
      visible: true,
      alwaysOnTop: false,
      mode: 'edit'
    }],
    ai: {
      activeId: 'p-e2e',
      providers: [{
        id: 'p-e2e',
        name: 'MockSSE',
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
  let noteCdp = null
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

    const noteTarget = await waitFor(async () => {
      const list = await listTargets()
      return (list || []).find(t => t.type === 'page' && /note\.html/.test(t.url || '')) || null
    }, 15000, 'note target')
    noteCdp = new CDP(noteTarget.webSocketDebuggerUrl)
    await noteCdp.connect()
    await noteCdp.send('Runtime.enable')
    await noteCdp.send('Log.enable')
    attachPageMonitor(noteCdp, 'note', pageErrors, cspViolations)
    await waitFor(async () => noteCdp.evaluate(
      `document.readyState === 'complete' && !!window.StickyPopupAppearance`
    ), 15000, 'note ready')

    await mainCdp.evaluate(`(() => {
      globalThis.__stickyTestHooks.windows.openDashboard()
      return true
    })()`)

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
      `document.readyState === 'complete' && !!window.StickyPopupAppearance && !!document.getElementById('popupStyleBtn')`
    ), 15000, 'dashboard ready')

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

    // ---------------------------------------------------------------- 1. 主页弹窗外观设置与跨窗同步
    await dashCdp.evaluate(`(() => {
      document.getElementById('popupStyleBtn').click()
      return true
    })()`)
    await sleep(150)

    const modalOpen = await dashCdp.evaluate(`(() => {
      const m = document.getElementById('popupStyleModal')
      return !!m && m.hidden === false && !!document.getElementById('previewBar') && !!document.getElementById('previewPanel')
    })()`)
    check('主页「弹窗外观」按钮可打开设置弹窗并显示预览', modalOpen, String(modalOpen))

    await dashCdp.evaluate(`(() => {
      const setVal = (id, val) => {
        const el = document.getElementById(id)
        el.value = val
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setVal('toolbarColor', '#fff6d6')
      setVal('toolbarOpacity', '75')
      setVal('answerColor', '#162033')
      setVal('answerOpacity', '85')
      return true
    })()`)
    await sleep(250)

    const dashStyle = await dashCdp.evaluate(`(() => {
      const root = document.documentElement
      const pb = document.getElementById('previewBar')
      const pp = document.getElementById('previewPanel')
      return {
        barTone: root.dataset.aiBarTone,
        panelTone: root.dataset.aiPanelTone,
        barBg: getComputedStyle(pb).backgroundColor,
        panelBg: getComputedStyle(pp).backgroundColor,
        tbHex: document.getElementById('toolbarHex').textContent,
        tbPct: document.getElementById('toolbarOpacityVal').textContent,
        ansHex: document.getElementById('answerHex').textContent,
        ansPct: document.getElementById('answerOpacityVal').textContent
      }
    })()`)

    check('主页预览实时更新背景色与透明度，且浅色自动切 dark 文字态',
      dashStyle.barTone === 'light' &&
      dashStyle.panelTone === 'dark' &&
      dashStyle.barBg === 'rgba(255, 246, 214, 0.75)' &&
      dashStyle.panelBg === 'rgba(22, 32, 51, 0.85)' &&
      dashStyle.tbHex === '#fff6d6' &&
      dashStyle.tbPct === '75%' &&
      dashStyle.ansHex === '#162033' &&
      dashStyle.ansPct === '85%',
      JSON.stringify(dashStyle))

    const noteStyle = await noteCdp.evaluate(`(() => {
      const root = document.documentElement
      const bar = document.querySelector('.ai-bar')
      return {
        barTone: root.dataset.aiBarTone,
        panelTone: root.dataset.aiPanelTone,
        barBg: bar ? getComputedStyle(bar).backgroundColor : '',
        panelBg: getComputedStyle(root).getPropertyValue('--ai-panel-bg').trim()
      }
    })()`)

    check('配置实时广播到便签窗口',
      noteStyle.barTone === 'light' &&
      noteStyle.panelTone === 'dark' &&
      noteStyle.barBg === 'rgba(255, 246, 214, 0.75)' &&
      noteStyle.panelBg === 'rgba(22, 32, 51, 0.85)',
      JSON.stringify(noteStyle))

    // 同步按钮 + 恢复默认按钮验证，然后再恢复成自定义测试样式
    await dashCdp.evaluate(`document.getElementById('popupSyncAnswer').click()`)
    await sleep(150)
    const afterSync = await dashCdp.evaluate(`document.documentElement.dataset.aiPanelTone === 'light' && document.getElementById('answerHex').textContent === '#fff6d6'`)
    check('「同步工具弹窗到回答弹窗」生效', afterSync, String(afterSync))

    await dashCdp.evaluate(`document.getElementById('popupResetStyle').click()`)
    await sleep(150)
    const afterReset = await dashCdp.evaluate(`document.getElementById('toolbarHex').textContent === '#23272f' && document.getElementById('answerHex').textContent === '#1e222a'`)
    check('「恢复默认」生效', afterReset, String(afterReset))

    await dashCdp.evaluate(`(() => {
      const setVal = (id, val) => {
        const el = document.getElementById(id)
        el.value = val
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setVal('toolbarColor', '#fff6d6')
      setVal('toolbarOpacity', '75')
      setVal('answerColor', '#162033')
      setVal('answerOpacity', '85')
      document.getElementById('popupStyleDone').click()
      return true
    })()`)
    await sleep(500)

    const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    check('弹窗外观设置已持久写入 sticky-notes.json',
      persisted.settings &&
      persisted.settings.popupAppearance &&
      persisted.settings.popupAppearance.toolbar.color === '#fff6d6' &&
      persisted.settings.popupAppearance.toolbar.opacity === 0.75 &&
      persisted.settings.popupAppearance.answer.color === '#162033' &&
      persisted.settings.popupAppearance.answer.opacity === 0.85,
      JSON.stringify(persisted.settings && persisted.settings.popupAppearance))

    // ---------------------------------------------------------------- 2. 页内工具弹窗拖动 + 页内回答弹窗置顶提升与流式接管
    await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.windows
      wins.openDashboard()
      return true
    })()`)
    await sleep(150)

    const dashBarRect0 = await dashCdp.evaluate(`(() => {
      const host = document.createElement('div')
      host.id = 'e2e-popup-sel'
      host.textContent = '光合作用是将光能转化为化学能的过程'
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
      `(() => { const b = document.querySelector('.ai-bar'); return !!b && b.hidden === false && getComputedStyle(b).opacity === '1' })()`
    ), 5000, '页内工具弹窗出现')
    await sleep(50)

    const barMetrics0 = await dashCdp.evaluate(`(() => {
      const bar = document.querySelector('.ai-bar')
      const grip = bar.querySelector('.ai-bar-grip')
      const btn = bar.querySelector('button[data-act="search"]')
      const br = bar.getBoundingClientRect()
      const gr = grip.getBoundingClientRect()
      return {
        barBg: getComputedStyle(bar).backgroundColor,
        barOpacity: getComputedStyle(bar).opacity,
        btnColor: getComputedStyle(btn).color,
        bx: br.left, by: br.top,
        gx: gr.left + gr.width / 2, gy: gr.top + gr.height / 2
      }
    })()`)

    check('页内工具弹窗仅背景半透明、文字清晰（深色字体在浅黄背景上）',
      barMetrics0.barBg === 'rgba(255, 246, 214, 0.75)' &&
      barMetrics0.barOpacity === '1' &&
      barMetrics0.btnColor === 'rgb(31, 41, 55)',
      JSON.stringify(barMetrics0))

    await dragByMouse(dashCdp, barMetrics0.gx, barMetrics0.gy, 90, 55)
    const barMetrics1 = await dashCdp.evaluate(`(() => {
      const r = document.querySelector('.ai-bar').getBoundingClientRect()
      return { bx: r.left, by: r.top }
    })()`)

    check('页内工具弹窗可通过抓手拖动到新位置',
      Math.abs((barMetrics1.bx - barMetrics0.bx) - 90) <= 4 &&
      Math.abs((barMetrics1.by - barMetrics0.by) - 55) <= 4,
      JSON.stringify({ before: barMetrics0, after: barMetrics1 }))

    // 在拖动后的位置展开提问，不回弹到选区
    await dashCdp.evaluate(`document.querySelector('.ai-bar [data-act="ask"]').click()`)
    await sleep(120)
    const barAfterAsk = await dashCdp.evaluate(`(() => {
      const r = document.querySelector('.ai-bar').getBoundingClientRect()
      return { bx: r.left, by: r.top, askShown: !document.querySelector('.ai-bar .ai-ask').hidden }
    })()`)
    check('页内工具弹窗拖动后展开提问保持在拖出位置',
      barAfterAsk.askShown && Math.abs(barAfterAsk.bx - barMetrics1.bx) <= 2,
      JSON.stringify({ dragged: barMetrics1, afterAsk: barAfterAsk }))

    // 发送提问 → 弹出独立回答窗 → 等待首段流式输出 → 点置顶固定在最前并续传流
    await dashCdp.evaluate(`(() => {
      const input = document.querySelector('.ai-bar .ai-ask input')
      input.value = '简述光反应'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.ai-bar [data-act="askSend"]').click()
      return true
    })()`)

    const ovTarget1 = await waitFor(async () => {
      const list = await listTargets()
      return (list || []).find(t => t.type === 'page' && /overlay\.html/.test(t.url || '') && /role=card/.test(t.url || '')) || null
    }, 15000, 'overlay card1 target')
    overlayCdp = new CDP(ovTarget1.webSocketDebuggerUrl)
    await overlayCdp.connect()
    await overlayCdp.send('Runtime.enable')
    await overlayCdp.send('Log.enable')
    attachPageMonitor(overlayCdp, 'overlay-card1', pageErrors, cspViolations)

    await waitFor(async () => overlayCdp.evaluate(
      `(() => { const p = document.querySelector('.ai-panel'); return !!p && p.querySelector('.ai-body').textContent.includes('S1') })()`
    ), 8000, '独立回答窗收到流式首包')

    await overlayCdp.evaluate(`document.querySelector('.ai-panel .ai-pin').click()`)
    await sleep(220)

    const promotedMain = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      const w = wins[wins.length - 1]
      return {
        count: wins.length,
        exists: !!w && !w.isDestroyed(),
        visible: !!w && w.isVisible(),
        alwaysOnTop: !!w && w.isAlwaysOnTop(),
        bounds: w ? w.getBounds() : null
      }
    })()`)
    const inPageBarHidden = await dashCdp.evaluate(`document.querySelector('.ai-bar').hidden === true`)

    check('页面内提问弹出独立回答窗，点置顶后真实置顶且页内工具条收起',
      inPageBarHidden && promotedMain.count === 1 && promotedMain.exists && promotedMain.visible && promotedMain.alwaysOnTop,
      JSON.stringify({ inPageBarHidden, promotedMain }))

    const streamFinished = await waitFor(async () => overlayCdp.evaluate(
      `(() => { const b = document.querySelector('.ai-panel .ai-body'); return !!b && b.textContent.includes('S8') })()`
    ), 10000, '置顶后流式输出继续完成').catch(() => false)
    check('独立回答窗点置顶后在途 AI 流式输出无损续传完成', streamFinished === true, String(streamFinished))

    const ovCardStyle = await overlayCdp.evaluate(`(() => {
      const p = document.querySelector('.ai-panel')
      const pin = document.querySelector('.ai-panel .ai-pin')
      return {
        panelBg: getComputedStyle(p).backgroundColor,
        panelTone: document.documentElement.dataset.aiPanelTone,
        pinOn: pin ? pin.dataset.on : ''
      }
    })()`)
    check('独立回答窗同步应用回答弹窗背景色/透明度且置顶按钮亮起',
      ovCardStyle.panelBg === 'rgba(22, 32, 51, 0.85)' &&
      ovCardStyle.panelTone === 'dark' &&
      ovCardStyle.pinOn === '1',
      JSON.stringify(ovCardStyle))

    // 拖动独立置顶回答弹窗
    const ovHeadPt = await overlayCdp.evaluate(`(() => {
      const h = document.querySelector('.ai-panel header')
      const r = h.getBoundingClientRect()
      return { x: r.left + r.width * 0.35, y: r.top + r.height / 2 }
    })()`)
    const promoB0 = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      return wins[wins.length - 1].getBounds()
    })()`)
    await dragByMouse(overlayCdp, ovHeadPt.x, ovHeadPt.y, 70, 50, { windowMoves: true })
    const promoB1 = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      const w = wins[wins.length - 1]
      return { b: w.getBounds(), top: w.isAlwaysOnTop() }
    })()`)
    const promoPinAfter = await overlayCdp.evaluate(`document.querySelector('.ai-panel .ai-pin').dataset.on`)

    check('置顶回答弹窗可拖动且拖动后仍保持真实置顶',
      Math.abs((promoB1.b.x - promoB0.x) - 70) <= 4 &&
      Math.abs((promoB1.b.y - promoB0.y) - 50) <= 4 &&
      promoB1.top === true &&
      promoPinAfter === '1',
      JSON.stringify({ promoB0, promoB1, promoPinAfter }))

    await overlayCdp.evaluate(`document.querySelector('.ai-panel .ai-close').click()`)
    overlayCdp.close()
    overlayCdp = null
    await sleep(180)

    // ---------------------------------------------------------------- 3. 全局划词原生工具弹窗拖动 + 独立回答弹窗置顶/拖动/保护
    await mainCdp.evaluate(`(() => {
      globalThis.__stickyTestHooks.globalOverlay.showOverlay('Global selection text for e2e', { x: 480, y: 380 })
      return true
    })()`)
    const barTarget = await waitFor(async () => {
      const list = await listTargets()
      return (list || []).find(t => t.type === 'page' && /overlay\.html/.test(t.url || '') && /role=bar/.test(t.url || '')) || null
    }, 15000, 'overlay bar target')
    const barCdp = new CDP(barTarget.webSocketDebuggerUrl)
    await barCdp.connect()
    await barCdp.send('Runtime.enable')
    await barCdp.send('Log.enable')
    attachPageMonitor(barCdp, 'overlay-bar', pageErrors, cspViolations)

    await waitFor(async () => barCdp.evaluate(
      `!!document.querySelector('.ai-bar .ai-bar-grip')`
    ), 8000, '全局工具弹窗渲染')
    await sleep(200)

    const ovBarB0 = await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getBarWindow().getBounds()`)
    const ovBarMetrics = await barCdp.evaluate(`(() => {
      const bar = document.querySelector('.ai-bar')
      const grip = bar.querySelector('.ai-bar-grip')
      const gr = grip.getBoundingClientRect()
      return {
        bg: getComputedStyle(bar).backgroundColor,
        tone: document.documentElement.dataset.aiBarTone,
        gx: gr.left + gr.width / 2,
        gy: gr.top + gr.height / 2
      }
    })()`)
    check('全局工具弹窗应用自定义背景色与透明度',
      ovBarMetrics.bg === 'rgba(255, 246, 214, 0.75)' && ovBarMetrics.tone === 'light',
      JSON.stringify(ovBarMetrics))

    await dragByMouse(barCdp, ovBarMetrics.gx, ovBarMetrics.gy, 85, 45, { windowMoves: true })
    const ovBarB1 = await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getBarWindow().getBounds()`)
    check('全局工具弹窗可通过抓手拖动窗口位置',
      Math.abs((ovBarB1.x - ovBarB0.x) - 85) <= 4 &&
      Math.abs((ovBarB1.y - ovBarB0.y) - 45) <= 4,
      JSON.stringify({ ovBarB0, ovBarB1 }))

    await barCdp.evaluate(`document.querySelector('.ai-bar [data-act="ask"]').click()`)
    await sleep(200)
    const ovBarAfterAsk = await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getBarWindow().getBounds()`)
    check('全局工具弹窗拖动后展开提问不跳回原锚点',
      Math.abs(ovBarAfterAsk.x - ovBarB1.x) <= 2,
      JSON.stringify({ ovBarB1, ovBarAfterAsk }))

    await barCdp.evaluate(`(() => {
      const input = document.querySelector('#askInput')
      input.value = '全局划词提问'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('[data-act="askSend"]').click()
      return true
    })()`)

    const ovTarget2 = await waitFor(async () => {
      const list = await listTargets()
      return (list || []).find(t => t.type === 'page' && /overlay\.html/.test(t.url || '') && /role=card/.test(t.url || '')) || null
    }, 15000, 'overlay card2 target')
    overlayCdp = new CDP(ovTarget2.webSocketDebuggerUrl)
    await overlayCdp.connect()
    await overlayCdp.send('Runtime.enable')
    await overlayCdp.send('Log.enable')
    attachPageMonitor(overlayCdp, 'overlay-card2', pageErrors, cspViolations)

    await waitFor(async () => overlayCdp.evaluate(
      `(() => { const b = document.querySelector('.ai-panel .ai-body'); return !!b && b.textContent.includes('S8') })()`
    ), 10000, '全局回答弹窗完成生成')
    await sleep(180)

    const beforePinState = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      const w = wins[wins.length - 1]
      return { top: w.isAlwaysOnTop(), bounds: w.getBounds() }
    })()`)
    check('全局回答弹窗未点置顶前 isAlwaysOnTop()=false', beforePinState.top === false, JSON.stringify(beforePinState))

    await overlayCdp.evaluate(`document.querySelector('.ai-panel .ai-pin').click()`)
    await sleep(180)

    const afterPinState = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      const w = wins[wins.length - 1]
      return { top: w.isAlwaysOnTop(), bounds: w.getBounds() }
    })()`)
    check('全局回答弹窗点置顶后真实 isAlwaysOnTop()=true 且原地置顶不跳到屏幕顶部',
      afterPinState.top === true && Math.abs(afterPinState.bounds.y - beforePinState.bounds.y) <= 2,
      JSON.stringify({ beforePinState, afterPinState }))

    const cardHeadPt = await overlayCdp.evaluate(`(() => {
      const h = document.querySelector('.ai-panel header')
      const r = h.getBoundingClientRect()
      return { x: r.left + r.width * 0.35, y: r.top + r.height / 2 }
    })()`)
    await dragByMouseSteps(overlayCdp, cardHeadPt.x, cardHeadPt.y, 65, 55, 65, { windowMoves: true })

    const afterDragPinned = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      const w = wins[wins.length - 1]
      return { top: w.isAlwaysOnTop(), visible: w.isVisible(), bounds: w.getBounds() }
    })()`)
    const pinBtnAfterDrag = await overlayCdp.evaluate(`document.querySelector('.ai-panel .ai-pin').dataset.on`)
    check('全局回答弹窗置顶后 65 步连续拖动不向上漂移、尺寸不膨胀、且不丢失置顶状态',
      afterDragPinned.top === true &&
      pinBtnAfterDrag === '1' &&
      Math.abs((afterDragPinned.bounds.x - afterPinState.bounds.x) - 65) <= 4 &&
      Math.abs((afterDragPinned.bounds.y - afterPinState.bounds.y) - 55) <= 4 &&
      Math.abs(afterDragPinned.bounds.width - afterPinState.bounds.width) <= 2 &&
      Math.abs(afterDragPinned.bounds.height - afterPinState.bounds.height) <= 2,
      JSON.stringify({ afterPinState, afterDragPinned, pinBtnAfterDrag }))

    await mainCdp.evaluate(`(() => {
      const go = globalThis.__stickyTestHooks.globalOverlay
      go.handleProbeEvent({ t: 'down', x: 5, y: 5 })
      go.handleProbeEvent({ t: 'sel', text: 'overwrite attempt', x: 100, y: 100, hwnd: 999999 })
      return true
    })()`)
    await sleep(150)

    const stillProtected = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      const w = wins[wins.length - 1]
      return { visible: w.isVisible(), top: w.isAlwaysOnTop(), bounds: w.getBounds() }
    })()`)
    check('置顶的回答弹窗不被外部点击或外部划词关闭/覆盖',
      stillProtected.visible === true &&
      stillProtected.top === true &&
      stillProtected.bounds.x === afterDragPinned.bounds.x &&
      stillProtected.bounds.y === afterDragPinned.bounds.y,
      JSON.stringify(stillProtected))

    // 回答弹窗置顶显示时，仍可正常点击便签中心页面控件（不被膨胀透明层或焦点锁死拦截）
    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      const dw = req('electron').BrowserWindow.getAllWindows().find(w => /dashboard\.html/.test(w.webContents.getURL()))
      if (dw) dw.focus()
      return !!dw
    })()`)
    await sleep(150)
    const visibleChipPt = await dashCdp.evaluate(`(() => {
      const r = document.querySelector('.chip[data-filter="visible"]').getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await dashCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: visibleChipPt.x, y: visibleChipPt.y, button: 'left', clickCount: 1 })
    await dashCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: visibleChipPt.x, y: visibleChipPt.y, button: 'left', clickCount: 1 })
    await sleep(150)
    const afterClickOther = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      const w = wins[wins.length - 1]
      return { visible: w.isVisible(), top: w.isAlwaysOnTop() }
    })()`)
    const dashRespondedWhilePinned = await dashCdp.evaluate(`document.querySelector('.chip[data-filter="visible"]').dataset.active === '1'`)
    check('回答弹窗置顶时仍可自由点击其他窗口控件且置顶窗保持显示',
      dashRespondedWhilePinned === true && afterClickOther.visible === true && afterClickOther.top === true,
      JSON.stringify({ dashRespondedWhilePinned, afterClickOther }))
    await dashCdp.evaluate(`document.querySelector('.chip[data-filter="all"]').click()`)

    await overlayCdp.evaluate(`document.querySelector('.ai-panel .ai-pin').click()`)
    await sleep(150)
    const afterUnpin = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      return wins[wins.length - 1].isAlwaysOnTop()
    })()`)
    check('再次点击置顶按钮可取消真实置顶', afterUnpin === false, String(afterUnpin))

    // globalSelect=false 时，取消置顶后点击其他窗口导致失焦也会自动隐藏关闭
    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      const dw = req('electron').BrowserWindow.getAllWindows().find(w => /dashboard\.html/.test(w.webContents.getURL()))
      if (dw) dw.focus()
      return true
    })()`)
    await sleep(220)
    const closedAfterBlur = await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows().length === 0`)
    check('取消置顶后切换焦点/失焦自动收起系统级回答弹窗（无需全局划词开启）', closedAfterBlur, String(closedAfterBlur))
    overlayCdp.close()
    overlayCdp = null

    // 再测探针 down 信号对未置顶工具窗同样有效
    await mainCdp.evaluate(`(() => {
      const go = globalThis.__stickyTestHooks.globalOverlay
      go.showOverlay('Probe dismiss check', { x: 480, y: 380 })
      return true
    })()`)
    await waitFor(async () => mainCdp.evaluate(`(() => {
      const b = globalThis.__stickyTestHooks.globalOverlay.getBarWindow()
      return !!b && b.isVisible()
    })()`), 5000, '探针测试弹窗出现')
    await mainCdp.evaluate(`(() => {
      globalThis.__stickyTestHooks.globalOverlay.handleProbeEvent({ t: 'down', x: 5, y: 5 })
      return true
    })()`)
    await sleep(150)
    const hiddenAfterOutsideClick = await mainCdp.evaluate(`(() => {
      const b = globalThis.__stickyTestHooks.globalOverlay.getBarWindow()
      return !b || b.isVisible() === false
    })()`)
    check('未置顶时外部点击信号亦可正常收起弹窗', hiddenAfterOutsideClick, String(hiddenAfterOutsideClick))
    barCdp.close()

    // ---------------------------------------------------------------- 3.5 未置顶独立回答窗点击其他位置/失焦自动收起且不吞点击
    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      const dw = req('electron').BrowserWindow.getAllWindows().find(w => /dashboard\.html/.test(w.webContents.getURL()))
      if (dw) dw.focus()
      return true
    })()`)
    await sleep(150)
    await dashCdp.evaluate(`(() => {
      const host = document.getElementById('e2e-popup-sel')
      const r = document.createRange()
      r.selectNodeContents(host)
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    })()`)
    await waitFor(async () => dashCdp.evaluate(`(() => { const b = document.querySelector('.ai-bar'); return !!b && !b.hidden })()`), 5000, '页内工具条再次浮出')
    await dashCdp.evaluate(`document.querySelector('.ai-bar [data-act="explain"]').click()`)
    await waitFor(async () => mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      return wins.length === 1 && wins[0].isVisible()
    })()`), 8000, '未置顶独立回答窗出现')
    await sleep(480)

    const outsideChipPt = await dashCdp.evaluate(`(() => {
      const chip = document.querySelector('.chip[data-filter="hidden"]')
      const cr = chip.getBoundingClientRect()
      return { x: Math.round(cr.left + cr.width / 2), y: Math.round(cr.top + cr.height / 2) }
    })()`)
    await dashCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: outsideChipPt.x, y: outsideChipPt.y, button: 'left', clickCount: 1 })
    await dashCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: outsideChipPt.x, y: outsideChipPt.y, button: 'left', clickCount: 1 })
    await sleep(220)

    const dashDismissClick = {
      cardCount: await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows().length`),
      chipActive: await dashCdp.evaluate(`document.querySelector('.chip[data-filter="hidden"]').dataset.active === '1'`)
    }
    check('未置顶回答窗点击页面其他位置自动收起，且不拦截该次点击',
      dashDismissClick.cardCount === 0 && dashDismissClick.chipActive,
      JSON.stringify(dashDismissClick))

    // 重新打开未置顶独立回答窗后切走窗口焦点到便签窗，应失焦自动关闭
    await dashCdp.evaluate(`(() => {
      document.querySelector('.chip[data-filter="all"]').click()
      const host = document.getElementById('e2e-popup-sel')
      const r = document.createRange()
      r.selectNodeContents(host)
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    })()`)
    await waitFor(async () => dashCdp.evaluate(`(() => { const b = document.querySelector('.ai-bar'); return !!b && !b.hidden })()`), 5000, '失焦测试工具条浮出')
    await dashCdp.evaluate(`document.querySelector('.ai-bar [data-act="explain"]').click()`)
    await waitFor(async () => mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()
      return wins.length === 1 && wins[0].isVisible()
    })()`), 8000, '失焦测试独立回答窗出现')
    await sleep(480)
    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      const nw = req('electron').BrowserWindow.getAllWindows().find(w => /note\.html/.test(w.webContents.getURL()))
      if (nw) nw.focus()
      return !!nw
    })()`)
    await sleep(220)
    const closedOnFocusNote = await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows().length === 0`)
    check('未置顶独立回答窗在切换焦点到其他窗口时自动关闭', closedOnFocusNote, String(closedOnFocusNote))

    // ---------------------------------------------------------------- 4. 稳定性检查
    check('全窗口无 CSP 违规日志', cspViolations.length === 0, JSON.stringify(cspViolations))
    check('全窗口无未捕获异常或 error 日志', pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 400))

    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      req('electron').app.quit()
      return true
    })()`).catch(() => {})
  } catch (err) {
    console.error('\n[e2e 异常] ' + (err && err.message ? err.message : err))
    console.error('AI mock reqs:', JSON.stringify(reqLogs))
    if (dashCdp) {
      const diag = await dashCdp.evaluate(`(() => {
        const b = document.querySelector('.ai-bar')
        const p = document.querySelector('.ai-panel')
        const body = p && p.querySelector('.ai-body')
        return {
          barHidden: b ? b.hidden : null,
          panelHidden: p ? p.hidden : null,
          bodyText: body ? body.textContent : null
        }
      })()`).catch(() => null)
      console.error('dash diag:', JSON.stringify(diag))
    }
    if (log) console.error('--- 应用日志尾部 ---\n' + log.slice(-3000))
    checks.push({ name: 'e2e 未异常中断', ok: false, detail: String(err && err.message) })
    try {
      if (mainCdp) await mainCdp.evaluate(`(() => { const r=${REQUIRE_EXPR}; r('electron').app.quit(); return true })()`)
    } catch (_) {}
  } finally {
    overlayCdp && overlayCdp.close()
    dashCdp && dashCdp.close()
    noteCdp && noteCdp.close()
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
