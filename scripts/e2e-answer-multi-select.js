'use strict'

/**
 * 独立回答窗口多开 + 回答窗内自由划词（含 KaTeX 公式）+ 焦点生命周期端到端验收（npm run test:e2e:answer）。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9455

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, timeout = 20000, label = '') {
  const t0 = Date.now()
  let lastErr = null
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      lastErr = err
    }
    await sleep(80)
  }
  throw new Error('waitFor timeout: ' + label + (lastErr ? ' -> ' + lastErr.message : ''))
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
        await sleep(250)
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
  const requests = []
  const server = http.createServer((req, res) => {
    if (req.url && req.url.endsWith('/chat/completions')) {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', c => { body += c })
      req.on('end', () => {
        const idx = requests.length
        try { requests.push(JSON.parse(body)) } catch (_) { requests.push({}) }
        const replies = [
          '质能公式 $E = mc^2$ 描述能量等价与相对论动力学关系。',
          '第二回答：能量与光速平方成正比，记作 **相对论静能**。',
          '第三回答：Relativistic energy invariance holds across frames.',
          '第四回答：Independent fourth answer with `CodeSpan`.'
        ]
        const reply = replies[idx] || ('第' + (idx + 1) + '条回答内容示例')
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n')
        setTimeout(() => {
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n')
            res.end()
          }
        }, 40)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests })
    })
  })
}

function attachMonitor (cdp, label, pageErrors, cspViolations) {
  cdp.ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch (_) { return }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(`${label}: ${JSON.stringify(msg.params && msg.params.exceptionDetails).slice(0, 300)}`)
    }
    if (msg.method === 'Log.entryAdded') {
      const e = (msg.params && msg.params.entry) || {}
      const txt = String(e.text || '')
      if (/Content Security Policy/i.test(txt)) cspViolations.push(`${label}: ${txt}`)
      if (e.level === 'error') pageErrors.push(`${label}: ${txt}`)
    }
  })
}

async function openTargetByPredicate (pred, label, pageErrors, cspViolations) {
  const t = await waitFor(async () => {
    const list = await listTargets()
    return (list || []).find(pred) || null
  }, 15000, label)
  const cdp = new CDP(t.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  attachMonitor(cdp, label, pageErrors, cspViolations)
  await waitFor(() => cdp.evaluate(`document.readyState === 'complete'`), 8000, label + ' ready')
  return { cdp, url: t.url }
}

async function dragSelectInBody (cdp) {
  const pts = await cdp.evaluate(`(() => {
    const body = document.querySelector('.ai-panel .ai-body');
    const r = body.getBoundingClientRect();
    return { x1: r.left + 12, y1: r.top + 16, x2: r.left + r.width - 14, y2: r.top + Math.min(r.height - 12, 48) };
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pts.x1, y: pts.y1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts.x1, y: pts.y1, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 5; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: pts.x1 + ((pts.x2 - pts.x1) * i) / 5,
      y: pts.y1 + ((pts.y2 - pts.y1) * i) / 5,
      button: 'left',
      buttons: 1
    })
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pts.x2, y: pts.y2, button: 'left', clickCount: 1 })
}

async function main () {
  console.log('独立回答窗口多开 + 窗内划词 e2e')
  const { server: aiServer, port: aiPort } = await startMockAiServer()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-ans-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'), JSON.stringify({
    version: 4,
    notes: [{
      id: 'ans-note-1',
      title: '多开划词便签',
      html: '<p>量子力学与狭义相对论中的质能等价概念非常关键。</p>',
      preview: '量子力学与狭义相对论中的质能等价概念非常关键。',
      color: '#FFF3B0',
      bounds: { x: 80, y: 80, width: 400, height: 500 },
      collapsed: false,
      visible: true,
      mode: 'edit'
    }],
    ai: {
      activeId: 'p-ans',
      providers: [{
        id: 'p-ans',
        name: 'MockMultiAI',
        baseUrl: `http://127.0.0.1:${aiPort}/v1`,
        apiKey: 'sk-mock',
        models: ['gpt-mock'],
        defaultModel: 'gpt-mock'
      }]
    },
    settings: { globalSelect: false }
  }))

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.STICKY_E2E = '1'

  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData,
    '--remote-debugging-port=' + CDP_PORT,
    '--inspect=0',
    '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })

  const cdps = []
  const pageErrors = []
  const cspViolations = []
  let mainCdp = null

  try {
    const inspectorUrl = await waitFor(() => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 30000, 'inspector')
    await waitFor(() => log.includes('[boot] 托盘就绪') ? true : null, 30000, 'boot ready')

    mainCdp = new CDP(inspectorUrl)
    await mainCdp.connect()

    const noteConn = await openTargetByPredicate(t => t.type === 'page' && /note\.html/.test(t.url || ''), 'note', pageErrors, cspViolations)
    const noteCdp = noteConn.cdp
    cdps.push(noteCdp)
    await waitFor(() => noteCdp.evaluate(`!!document.getElementById('editor') && !!window.StickyMarkdown`), 8000, 'note ready')

    // ─── T1: 从便签划词弹出独立回答窗 #1，保留「插入便签」并成功插入渲染 ───
    await noteCdp.evaluate(`(() => {
      const p = document.querySelector('#editor p');
      const r = document.createRange(); r.selectNodeContents(p);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    })()`)
    await waitFor(() => noteCdp.evaluate(`(() => { const b = document.querySelector('.ai-bar'); return !!b && !b.hidden })()`), 5000, 'note .ai-bar')
    await noteCdp.evaluate(`document.querySelector('.ai-bar [data-act="explain"]').click()`)

    const c1Conn = await openTargetByPredicate(t => t.type === 'page' && /role=card/.test(t.url || ''), 'card1', pageErrors, cspViolations)
    const c1Cdp = c1Conn.cdp
    const c1Url = c1Conn.url
    cdps.push(c1Cdp)
    await waitFor(() => c1Cdp.evaluate(`(() => { const p = document.querySelector('.ai-panel'); return !!p && p.dataset.busy === '0' && !!p.querySelector('.katex') })()`), 10000, 'card1 done with katex')

    const c1InsertVisible = await c1Cdp.evaluate(`!document.querySelector('[data-a="insert"]').hidden`)
    assert.equal(c1InsertVisible, true, '便签触发的独立回答窗应显示「插入便签」')
    await c1Cdp.evaluate(`document.querySelector('[data-a="insert"]').click()`)
    await waitFor(() => noteCdp.evaluate(`document.querySelectorAll('#editor .math-inline .katex').length >= 1`), 5000, 'inserted into note')
    console.log('✓ T1: Note triggers independent Answer Window #1 and inserts formatted LaTeX back into note')

    // ─── T2: 回答窗 #1 正文拖选（含 KaTeX）：窗口不位移、barWin 浮出且复制无三份乱码、点「提问」聚焦 barWin 时不关 #1 ───
    const b1Before = await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()[0].getBounds()`)
    await mainCdp.evaluate(`(() => {
      const w = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()[0];
      w.focus();
      return true;
    })()`)
    await sleep(120)
    await dragSelectInBody(c1Cdp)

    const barConn = await openTargetByPredicate(t => t.type === 'page' && /role=bar/.test(t.url || ''), 'bar', pageErrors, cspViolations)
    const barCdp = barConn.cdp
    cdps.push(barCdp)
    await waitFor(() => mainCdp.evaluate(`(() => {
      const b = globalThis.__stickyTestHooks.globalOverlay.getBarWindow();
      return !!b && b.isVisible() && b.isAlwaysOnTop();
    })()`), 6000, 'barWin visible above card1')

    const b1AfterDrag = await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()[0].getBounds()`)
    assert.equal(b1AfterDrag.x, b1Before.x, '正文拖选不得意外拖动回答窗口 X')
    assert.equal(b1AfterDrag.y, b1Before.y, '正文拖选不得意外拖动回答窗口 Y')

    // 复制选区校验去重后的 $E = mc^2$
    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR};
      req('electron').clipboard.writeText('__CLIP_SENTINEL__');
      const w = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()[0];
      w.webContents.copy();
      return true;
    })()`)
    await sleep(120)
    const clipClean = await mainCdp.evaluate(`(${REQUIRE_EXPR})('electron').clipboard.readText()`)
    assert.ok(clipClean.includes('$E = mc^2$'), `回答窗内 Ctrl+C 应提取干净 LaTeX，实际: ${clipClean}`)
    assert.equal(clipClean.includes('mc2mc2'), false, `不得出现 KaTeX 重复字符: ${clipClean}`)

    // 点击 barWin 的「提问」，使焦点从无置顶的 #1 转移到 barWin：#1 必须保持打开！
    await waitFor(() => mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getBarWindow().isVisible()`), 5000, 'bar still visible')
    await barCdp.evaluate(`document.querySelector('[data-act="ask"]').click()`)
    await sleep(220)
    const stillOneCard = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows();
      return wins.length === 1 && wins[0].isVisible() && globalThis.__stickyTestHooks.globalOverlay.getBarWindow().isVisible();
    })()`)
    assert.equal(stillOneCard, true, '点击悬浮工具条提问抢占焦点时，原未置顶回答窗不得关闭')
    console.log('✓ T2: In-answer-window selection + KaTeX clean copy + focus to bar preserves unpinned card #1')

    // ─── T3: 在 barWin 中发送提问，级联多开回答窗 #2（#1 与 #2 并存且可互切焦点）───
    await barCdp.evaluate(`(() => {
      const inp = document.querySelector('#askInput');
      inp.value = '为什么与光速平方成正比？';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-act="askSend"]').click();
    })()`)

    const c2Conn = await openTargetByPredicate(t => t.type === 'page' && /role=card/.test(t.url || '') && t.url !== c1Url, 'card2', pageErrors, cspViolations)
    const c2Cdp = c2Conn.cdp
    const c2Url = c2Conn.url
    cdps.push(c2Cdp)
    await waitFor(() => c2Cdp.evaluate(`(() => { const p = document.querySelector('.ai-panel'); return !!p && p.dataset.busy === '0' })()`), 10000, 'card2 done')

    const twoCards = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows();
      const b = globalThis.__stickyTestHooks.globalOverlay.getBarWindow();
      return {
        count: wins.length,
        vis1: wins[0] && wins[0].isVisible(),
        vis2: wins[1] && wins[1].isVisible(),
        barVis: b && b.isVisible(),
        box1: wins[0] && wins[0].getBounds(),
        box2: wins[1] && wins[1].getBounds()
      };
    })()`)
    assert.equal(twoCards.count, 2, '应支持同时存在 2 个回答窗口')
    assert.equal(twoCards.vis1 && twoCards.vis2, true)
    assert.equal(twoCards.barVis, false)

    // 在两个未置顶回答窗之间来回切换焦点，两者均保留
    await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()[0].focus(); true`)
    await sleep(160)
    await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()[1].focus(); true`)
    await sleep(160)
    assert.equal(await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows().length`), 2, '回答窗间互切焦点不应关闭未置顶窗口')
    console.log('✓ T3: Multiple concurrent Answer Windows coexist & preserve focus switching')

    // ─── T4: 在回答窗 #2 内继续划词打开 #3（共 3 窗并存，继承「插入便签」），按 Esc 只关闭 #3 ───
    await dragSelectInBody(c2Cdp)
    await waitFor(() => mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getBarWindow().isVisible()`), 5000, 'bar from card2')
    await barCdp.evaluate(`document.querySelector('[data-act="translate"]').click()`)

    const c3Conn = await openTargetByPredicate(t => t.type === 'page' && /role=card/.test(t.url || '') && t.url !== c1Url && t.url !== c2Url, 'card3', pageErrors, cspViolations)
    const c3Cdp = c3Conn.cdp
    cdps.push(c3Cdp)
    await waitFor(() => c3Cdp.evaluate(`(() => { const p = document.querySelector('.ai-panel'); return !!p && p.dataset.busy === '0' })()`), 10000, 'card3 done')

    assert.equal(await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows().length`), 3, '应同时存在 3 个回答窗口')
    assert.equal(await c3Cdp.evaluate(`!document.querySelector('[data-a="insert"]').hidden`), true, '由便签子链打开的回答窗 #3 仍应继承「插入便签」按钮')

    // Esc 关闭 #3，#1 和 #2 保留
    await c3Cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(() => mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows().length === 2`), 5000, 'Esc closed card3 only')
    c3Cdp.close()
    console.log('✓ T4: Nested 3rd Answer Window inherits insert-to-note, Esc closes only top card')

    // ─── T5: 置顶 #1、保持 #2 未置顶；切焦到 Dashboard → #2 自动收起，置顶 #1 保持 ───
    await c1Cdp.evaluate(`document.querySelector('.ai-panel .ai-pin').click()`)
    await sleep(500) // 等过内部 focus guard
    await mainCdp.evaluate(`globalThis.__stickyTestHooks.windows.openDashboard(); true`)
    const dashConn = await openTargetByPredicate(t => t.type === 'page' && /dashboard\.html/.test(t.url || ''), 'dashboard', pageErrors, cspViolations)
    cdps.push(dashConn.cdp)
    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR};
      const dw = req('electron').BrowserWindow.getAllWindows().find(w => /dashboard\.html/.test(w.webContents.getURL()));
      if (dw) dw.focus();
      return !!dw;
    })()`)
    await waitFor(() => mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows();
      return wins.length === 1 && wins[0].isAlwaysOnTop() && wins[0].isVisible();
    })()`), 5000, 'unpinned card2 auto-dismissed while pinned card1 stayed')
    console.log('✓ T5: Focusing non-overlay window auto-closes unpinned card #2 while preserving pinned card #1')

    // ─── T6: 存在置顶 #1 时仍允许新划词与再多开置顶窗 #4 ───
    await mainCdp.evaluate(`(() => {
      globalThis.__stickyTestHooks.globalOverlay.showOverlay('New global text while card1 is pinned', { x: 460, y: 360 });
      return true;
    })()`)
    await waitFor(() => mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getBarWindow().isVisible()`), 5000, 'bar not blocked by pinned card1')
    await barCdp.evaluate(`document.querySelector('[data-act="explain"]').click()`)

    const c4Conn = await openTargetByPredicate(t => t.type === 'page' && /role=card/.test(t.url || '') && t.url !== c1Url, 'card4', pageErrors, cspViolations)
    const c4Cdp = c4Conn.cdp
    cdps.push(c4Cdp)
    await waitFor(() => c4Cdp.evaluate(`(() => { const p = document.querySelector('.ai-panel'); return !!p && p.dataset.busy === '0' })()`), 10000, 'card4 done')
    await c4Cdp.evaluate(`document.querySelector('.ai-panel .ai-pin').click()`)
    await sleep(160)

    const twoPinned = await mainCdp.evaluate(`(() => {
      const wins = globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows();
      return wins.length === 2 && wins[0].isAlwaysOnTop() && wins[1].isAlwaysOnTop();
    })()`)
    assert.equal(twoPinned, true, '两个独立回答窗应可同时置顶共存')

    // ─── T7: 拖动回答窗 #4 标题栏正常移动，全窗口 0 异常/CSP ───
    const h4Pt = await c4Cdp.evaluate(`(() => {
      const h = document.querySelector('.ai-panel header');
      const r = h.getBoundingClientRect();
      return { x: Math.round(r.left + r.width * 0.4), y: Math.round(r.top + r.height / 2) };
    })()`)
    const c4B0 = await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()[1].getBounds()`)
    await c4Cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: h4Pt.x, y: h4Pt.y, button: 'left', clickCount: 1 })
    await sleep(30)
    await c4Cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h4Pt.x + 60, y: h4Pt.y + 40, button: 'left', buttons: 1 })
    await sleep(140)
    await c4Cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h4Pt.x, y: h4Pt.y, button: 'left', clickCount: 1 })
    await sleep(120)
    const c4B1 = await mainCdp.evaluate(`globalThis.__stickyTestHooks.globalOverlay.getAnswerWindows()[1].getBounds()`)
    assert.ok(Math.abs((c4B1.x - c4B0.x) - 60) <= 5 && Math.abs((c4B1.y - c4B0.y) - 40) <= 5,
      `Header drag failed: before=${JSON.stringify(c4B0)} after=${JSON.stringify(c4B1)}`)
    console.log('✓ T6 & T7: Pinned card never blocks new selection, multi-pin works, header drag works')

    assert.equal(cspViolations.length, 0, 'CSP violations: ' + JSON.stringify(cspViolations))
    assert.equal(pageErrors.length, 0, 'Page errors: ' + JSON.stringify(pageErrors))

    const exitPromise = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    await mainCdp.evaluate(`(${REQUIRE_EXPR})('electron').app.quit(); true`)
    mainCdp.close()
    mainCdp = null
    for (const c of cdps) c.close()

    const exitRes = await Promise.race([
      exitPromise,
      sleep(6000).then(() => { throw new Error('app.quit timeout') })
    ])
    assert.equal(exitRes.code, 0, `Expected exit 0, got code=${exitRes.code} signal=${exitRes.signal}`)
    console.log('ALL E2E MULTI-ANSWER & IN-WINDOW SELECTION CHECKS PASSED!')
  } finally {
    for (const c of cdps) { try { c.close() } catch (_) {} }
    if (mainCdp) { try { mainCdp.close() } catch (_) {} }
    aiServer.close()
    await sleep(400)
    try { child.kill() } catch (_) {}
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) {}
  }
}

main().catch((err) => {
  console.error('E2E FAILED:', err)
  process.exit(1)
})
