'use strict'

/**
 * 划词浮窗「向 AI 提问 + 复制」端到端回归（npm run test:e2e:overlay:ask）。
 *
 * 验的是**真实链路**：overlay.html + overlay.js + preload.js + 主进程 IPC，
 * 而不是在 Node 里模拟一个 DOM。
 *
 * 覆盖：
 *   1. 工具条渲染出「提问」「复制」两个新入口（且原有三项没被挤掉）
 *   2. 点「提问」展开输入行，输入框拿到焦点
 *   3. 输入内容后「发送」从禁用变可用（空内容仍禁用）
 *   4. 点「发送」→ 切到结果卡片，标题是「向 AI 提问」，正文回显问题
 *   5. 请求真的走到了主进程 ai:ask（未配供应商 ⇒ 卡片里出现该错误）
 *   6. 点「复制」把**选中的原文**写进系统剪贴板（主进程 readText 回读校验）
 *   7. 重新划词后，输入行与已输入内容都被复位（不残留上一次的问题）
 *   8. 全程无渲染层未捕获异常、无 CSP 违规
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9451

const SELECTED = '光合作用把光能转成化学能'
const QUESTION = '为什么需要叶绿体？'

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
  /**
   * 求值。
   *
   * ★ Electron 33 / V8 inspector 有已知瞬态：`-32000 Promise was collected`。
   *   应用启动早期（同步 require 还没跑完）尤其容易出现。
   *   这里只对该瞬态做有限重试，**业务断言不放宽**：
   *   真正的 eval 异常（exceptionDetails）立即抛出，不重试。
   */
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
        // 只重试 inspector 瞬态；eval 异常与业务失败一律立刻上抛
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
  // ★ 必须包一层箭头函数：Module.require 依赖 this，直接返回裸方法会丢绑定，
  //   调用时报 'The "id" argument must be of type string. Received undefined'
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

/** 读 /json/list，找到 overlay 页面的 ws 地址 */
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

async function main () {
  console.log('划词浮窗「向 AI 提问 / 复制」e2e')

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-overlay-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'),
    JSON.stringify({ version: 1, notes: [], settings: {} }))

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
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail })
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok || !detail ? '' : '  → ' + detail))
  }

  let mainCdp = null
  let pageCdp = null
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

    // 在主进程里开一个和真实浮窗同配置的窗口（真实 preload + 真实 overlay.html）
    const created = await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      if (!req) return { ok: false, err: 'no require' }
      const { BrowserWindow } = req('electron')
      const path = req('path')
      const w = new BrowserWindow({
        show: false, width: 420, height: 200, frame: false, transparent: true,
        skipTaskbar: true, focusable: true,
        webPreferences: {
          preload: path.join(process.cwd(), 'preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false,
          backgroundThrottling: false
        }
      })
      globalThis.__ovlWin = w
      w.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2) globalThis.__ovlErrors = (globalThis.__ovlErrors || []).concat(String(message))
      })
      w.loadFile(path.join(process.cwd(), 'src', 'overlay.html'))
      return { ok: true }
    })()`)
    if (!created || !created.ok) throw new Error('建窗口失败: ' + JSON.stringify(created))

    // 等页面就绪，然后像真实划词那样推一次 overlay:show
    await waitFor(async () => {
      const r = await mainCdp.evaluate(`(() => {
        const w = globalThis.__ovlWin
        if (!w || w.isDestroyed()) return false
        if (w.webContents.isLoading()) return false
        return w.webContents.executeJavaScript('document.readyState === "complete" && !!document.getElementById("root")')
          .catch(() => false)
      })()`)
      return r === true
    }, 25000, 'overlay 页面就绪')
    await sleep(300)

    // 找到页面 target
    const target = await waitFor(async () => {
      const list = await listTargets()
      return (list || []).find(t => t.type === 'page' && /overlay\.html/.test(t.url || '')) || null
    }, 15000, 'overlay page target')

    pageCdp = new CDP(target.webSocketDebuggerUrl)
    await pageCdp.connect()
    await pageCdp.send('Runtime.enable')
    await pageCdp.send('Log.enable')

    pageCdp.ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch (_) { return }
      if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push(JSON.stringify(msg.params && msg.params.exceptionDetails).slice(0, 300))
      }
      if (msg.method === 'Log.entryAdded') {
        const e = (msg.params && msg.params.entry) || {}
        const txt = String(e.text || '')
        if (/Content Security Policy/i.test(txt)) cspViolations.push(txt)
        if (e.level === 'error') pageErrors.push(txt)
      }
    })

    const show = async (text) => {
      await mainCdp.evaluate(`(() => {
        const w = globalThis.__ovlWin
        if (!w || w.isDestroyed()) return false
        w.webContents.send('overlay:show', { text: ${JSON.stringify(text)} })
        return true
      })()`)
      await waitFor(async () => pageCdp.evaluate(
        `!!document.querySelector('.ai-bar')`
      ), 8000, '工具条渲染')
      await sleep(150)
    }

    const click = async (sel) => {
      await pageCdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)})
        if (!el) return false
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return true
      })()`)
      await sleep(120)
    }

    // ---------------------------------------------------------------- 1. 工具条
    await show(SELECTED)

    const barInfo = await pageCdp.evaluate(`(() => {
      const icons = Array.from(document.querySelectorAll('.ai-bar > button')).map(b => b.dataset.act)
      return {
        acts: icons,
        titles: Array.from(document.querySelectorAll('.ai-bar > button')).map(b => b.title),
        labels: Array.from(document.querySelectorAll('.ai-bar > button span')).map(s => s.textContent)
      }
    })()`)

    check('工具条含「提问」入口', (barInfo.acts || []).includes('ask'), JSON.stringify(barInfo.acts))
    check('工具条含「复制」入口', (barInfo.acts || []).includes('copyText'), JSON.stringify(barInfo.acts))
    check('原有三项动作仍在（AI 搜索/解释/翻译）',
      ['search', 'explain', 'translate'].every(a => (barInfo.acts || []).includes(a)),
      JSON.stringify(barInfo.acts))
    check('复制按钮的提示写明是"选中的文字"',
      (barInfo.titles || []).some(t => /复制选中的文字/.test(t)),
      JSON.stringify(barInfo.titles))

    // ---------------------------------------------------------------- 2. 复制选中原文
    await click('[data-act="copyText"]')
    const clip = await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      return req('electron').clipboard.readText()
    })()`)
    check('点「复制」把选中的原文写进剪贴板', clip === SELECTED, JSON.stringify(clip))

    const copyLabel = await pageCdp.evaluate(
      `document.querySelector('[data-act="copyText"] span').textContent`
    )
    check('复制后有「已复制」反馈', /已复制/.test(copyLabel || ''), String(copyLabel))

    // ---------------------------------------------------------------- 3. 展开输入行
    const beforeHidden = await pageCdp.evaluate(
      `document.querySelector('.ai-ask').hidden === true`
    )
    check('默认不显示提问输入行', beforeHidden === true, String(beforeHidden))

    await click('[data-act="ask"]')

    const askState = await pageCdp.evaluate(`(() => {
      const row = document.querySelector('.ai-ask')
      const bar = document.querySelector('.ai-bar')
      const input = document.querySelector('#askInput')
      return {
        rowShown: !!row && row.hidden === false,
        hasAskClass: !!bar && bar.classList.contains('has-ask'),
        inputExists: !!input,
        focused: !!input && document.activeElement === input,
        sendDisabled: !!document.querySelector('[data-act="askSend"]').disabled
      }
    })()`)

    check('点「提问」展开输入行', askState.rowShown === true, JSON.stringify(askState))
    check('工具条加上 has-ask（换行布局生效）', askState.hasAskClass === true, JSON.stringify(askState))
    check('输入框拿到焦点', askState.focused === true, JSON.stringify(askState))
    check('空内容时「发送」禁用', askState.sendDisabled === true, JSON.stringify(askState))

    // ---------------------------------------------------------------- 4. 输入 → 发送可用
    await pageCdp.evaluate(`(() => {
      const input = document.querySelector('#askInput')
      input.value = ${JSON.stringify(QUESTION)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(100)

    const afterType = await pageCdp.evaluate(
      `document.querySelector('[data-act="askSend"]').disabled`
    )
    check('输入内容后「发送」变可用', afterType === false, String(afterType))

    // 清空 → 重新禁用（反向验证：不是一次性开关）
    await pageCdp.evaluate(`(() => {
      const input = document.querySelector('#askInput')
      input.value = '   '
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(100)
    const afterBlank = await pageCdp.evaluate(
      `document.querySelector('[data-act="askSend"]').disabled`
    )
    check('只输入空格时「发送」重新禁用', afterBlank === true, String(afterBlank))

    // 填回真正的问题
    await pageCdp.evaluate(`(() => {
      const input = document.querySelector('#askInput')
      input.value = ${JSON.stringify(QUESTION)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(100)

    // ---------------------------------------------------------------- 5. 发送 → 卡片
    await click('[data-act="askSend"]')

    await waitFor(async () => pageCdp.evaluate(`!!document.querySelector('.ai-panel')`), 8000, '结果卡片')

    const card = await pageCdp.evaluate(`(() => {
      const title = document.querySelector('.ai-title')
      const q = document.querySelector('.ai-body .ai-q')
      return {
        title: title ? title.textContent : '',
        question: q ? q.textContent : '',
        barGone: !document.querySelector('.ai-bar')
      }
    })()`)

    check('发送后切到结果卡片', card.barGone === true, JSON.stringify(card))
    check('卡片标题是「向 AI 提问」', card.title === '向 AI 提问', String(card.title))
    check('卡片正文回显了问题', card.question === QUESTION, String(card.question))

    // ---------------------------------------------------------------- 6. 请求真的到主进程
    const errText = await waitFor(async () => {
      const t = await pageCdp.evaluate(`(() => {
        const e = document.querySelector('.ai-body .ai-err')
        return e ? e.textContent : ''
      })()`)
      return t || null
    }, 12000, '主进程错误回传').catch(() => '')

    check('请求经 IPC 到主进程并回传错误（未配供应商）',
      /供应商|API Key|模型/.test(String(errText)), String(errText))

    // ---------------------------------------------------------------- 7. 重新划词复位
    await show('第二段被选中的文字')

    const reset = await pageCdp.evaluate(`(() => {
      const row = document.querySelector('.ai-ask')
      const bar = document.querySelector('.ai-bar')
      const input = document.querySelector('#askInput')
      return {
        barBack: !!bar,
        rowHidden: !!row && row.hidden === true,
        noAskClass: !!bar && !bar.classList.contains('has-ask'),
        emptyInput: !!input && input.value === ''
      }
    })()`)

    check('重新划词后回到工具条', reset.barBack === true, JSON.stringify(reset))
    check('输入行已收起', reset.rowHidden === true && reset.noAskClass === true, JSON.stringify(reset))
    check('上一次输入的问题不残留', reset.emptyInput === true, JSON.stringify(reset))

    // ---------------------------------------------------------------- 8. 稳定性
    const mainErrs = await mainCdp.evaluate(`globalThis.__ovlErrors || []`)
    check('渲染层无 error 级日志', !Array.isArray(mainErrs) || mainErrs.length === 0,
      JSON.stringify(mainErrs))
    check('无 CSP 违规日志', cspViolations.length === 0, JSON.stringify(cspViolations))
    check('无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 300))

    // ---------------------------------------------------------------- 9. 页面内工具条（ai-toolbar.js）
    //
    // 系统级浮窗与页面内工具条是**两份并行实现**（overlay.js / ai-toolbar.js），
    // 只验其中一份等于没验另一半。这里开一个 note.html 窗口实测。
    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      const { BrowserWindow } = req('electron')
      const path = req('path')
      // ★ 必须真的显示窗口：隐藏窗口没有布局尺寸，
      //   ai-toolbar 的 readSelection 会因 rect 宽高为 0 判定"没有选中"。
      const w = new BrowserWindow({
        show: true, width: 560, height: 420, x: 40, y: 40,
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(process.cwd(), 'preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false,
          backgroundThrottling: false
        }
      })
      globalThis.__noteWin = w
      w.loadFile(path.join(process.cwd(), 'src', 'dashboard.html'))
      return true
    })()`).catch(() => null)

    const noteTarget = await waitFor(async () => {
      const list = await listTargets()
      return (list || []).find(t => t.type === 'page' && /dashboard\.html/.test(t.url || '')) || null
    }, 15000, 'note page target')

    const noteCdp = new CDP(noteTarget.webSocketDebuggerUrl)
    await noteCdp.connect()
    await noteCdp.send('Runtime.enable')
    // 等页面真正加载完（拿到 target ≠ DOM 就绪），并确认工具条脚本已注入
    await waitFor(async () => noteCdp.evaluate(
      `document.readyState === 'complete' && !!window.sticky && typeof window.sticky.aiAsk === 'function'`
    ), 15000, 'dashboard 页面就绪').catch(() => null)
    await sleep(400)

    const noteDiag = await noteCdp.evaluate(`(() => ({
      url: location.pathname,
      ready: document.readyState,
      ids: Array.from(document.querySelectorAll('[id]')).map(e => e.id).slice(0, 12),
      bodyLen: document.body ? document.body.innerHTML.length : -1,
      hasSticky: !!window.sticky
    }))()`)

    // ★ 等 dashboard 自己的异步渲染停下来再注入选区：
    //   它加载完列表会重刷 body，我们先前插入的节点会被移除，
    //   range 指向游离节点 ⇒ selection.toString() 变空 ⇒ 工具条永远不浮出。
    await noteCdp.evaluate(`(async () => {
      const len = () => document.body.innerHTML.length
      let last = -1
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 150))
        if (len() === last) return true
        last = len()
      }
      return true
    })()`)

    const noteBar = await noteCdp.evaluate(`(() => {
      // 造一段可选中的真实文本：用位置稳定的 div，并选中它的内容
      const host = document.createElement('div')
      host.id = 'e2e-sel'
      host.textContent = '光合作用把光能转成化学能'
      host.style.cssText = 'position:fixed;left:20px;top:200px;font-size:16px;color:#000;z-index:9;' +
        // ★ dashboard.css 里 body{user-select:none}，只对少数容器放开；
        //   继承下来会让 Chromium 的 Selection.toString() 直接返回空串（rect 却非零）。
        '-webkit-user-select:text;user-select:text;'
      document.body.appendChild(host)

      const r = document.createRange()
      r.selectNodeContents(host)
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      const rect = r.getBoundingClientRect()
      return { ok: rect.width > 0 && rect.height > 0, w: rect.width, h: rect.height, text: s.toString() }
    })()`)

    if (!noteBar || !noteBar.ok) {
      check('页面内工具条：能选中页面文本', false,
        JSON.stringify(noteBar) + ' | diag=' + JSON.stringify(noteDiag))
    } else {
      check('页面内工具条：能选中页面文本', true, JSON.stringify(noteBar))

      const selDiag = await noteCdp.evaluate(`(async () => {
        await new Promise(r => setTimeout(r, 400))
        const bar = document.querySelector('.ai-bar')
        const s = window.getSelection()
        return {
          barExists: !!bar,
          barHidden: bar ? bar.hidden : null,
          selText: s ? s.toString().slice(0, 40) : null,
          collapsed: s ? s.isCollapsed : null
        }
      })()`)
      const shown = await waitFor(async () => noteCdp.evaluate(
        `(() => { const b = document.querySelector('.ai-bar'); return !!b && b.hidden === false })()`
      ), 6000, '页面内工具条出现').catch(() => false)

      check('页面内工具条：划词后浮出', shown === true, JSON.stringify(selDiag))

      const noteActs = await noteCdp.evaluate(`(() => {
        const bar = document.querySelector('.ai-bar')
        if (!bar) return null
        return {
          acts: Array.from(bar.querySelectorAll(':scope > button')).map(b => b.dataset.act),
          hasRow: !!bar.querySelector('.ai-ask')
        }
      })()`)

      check('页面内工具条：含「提问」入口',
        !!(noteActs && (noteActs.acts || []).includes('ask')), JSON.stringify(noteActs))
      check('页面内工具条：含「复制」入口',
        !!(noteActs && (noteActs.acts || []).includes('copyText')), JSON.stringify(noteActs))

      // 点「提问」→ 输入行展开、输入框聚焦
      // 先把窗口激活：input.focus() 要生效，窗口本身得是活动窗口
      await mainCdp.evaluate(`(() => {
        const w = globalThis.__noteWin
        if (w && !w.isDestroyed()) w.focus()
        return true
      })()`)
      await sleep(200)

      await noteCdp.evaluate(`(() => {
        const b = document.querySelector('.ai-bar [data-act="ask"]')
        if (!b) return false
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return true
      })()`)
      await sleep(150)

      const noteAsk = await noteCdp.evaluate(`(() => {
        const bar = document.querySelector('.ai-bar')
        const row = bar && bar.querySelector('.ai-ask')
        const input = row && row.querySelector('input')
        return {
          rowShown: !!row && row.hidden === false,
          hasAskClass: !!bar && bar.classList.contains('has-ask'),
          focused: !!input && document.activeElement === input,
          sendDisabled: !!bar && !!bar.querySelector('[data-act="askSend"]').disabled
        }
      })()`)

      check('页面内工具条：点「提问」展开输入行',
        !!(noteAsk && noteAsk.rowShown && noteAsk.hasAskClass), JSON.stringify(noteAsk))
      check('页面内工具条：输入框拿到焦点', !!(noteAsk && noteAsk.focused), JSON.stringify(noteAsk))
      check('页面内工具条：空内容时「发送」禁用',
        !!(noteAsk && noteAsk.sendDisabled), JSON.stringify(noteAsk))

      // 输入内容 → 发送可用；按回车发送 → 卡片出现并回显问题
      await noteCdp.evaluate(`(() => {
        const bar = document.querySelector('.ai-bar')
        const input = bar.querySelector('.ai-ask input')
        input.value = ${JSON.stringify(QUESTION)}
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(120)

      const noteSendOn = await noteCdp.evaluate(
        `!document.querySelector('.ai-bar [data-act="askSend"]').disabled`
      )
      check('页面内工具条：输入后「发送」可用', noteSendOn === true, String(noteSendOn))

      await noteCdp.evaluate(`(() => {
        const input = document.querySelector('.ai-bar .ai-ask input')
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        return true
      })()`)

      const cardTarget = await waitFor(async () => {
        const list = await listTargets()
        return (list || []).find(t => t.type === 'page' && /overlay\.html/.test(t.url || '') && /role=card/.test(t.url || '')) || null
      }, 15000, '独立回答窗口 target').catch(() => null)

      let noteCard = null
      let cardCdp = null
      if (cardTarget) {
        cardCdp = new CDP(cardTarget.webSocketDebuggerUrl)
        await cardCdp.connect()
        await cardCdp.send('Runtime.enable')
        noteCard = await waitFor(async () => cardCdp.evaluate(`(() => {
          const p = document.querySelector('.ai-panel')
          if (!p) return null
          const t = p.querySelector('.ai-title')
          const q = p.querySelector('.ai-body .ai-q')
          return { title: t ? t.textContent : '', question: q ? q.textContent : '' }
        })()`), 8000, '独立回答窗口卡片').catch(() => null)
      }

      check('页面内工具条：回车发送后打开独立回答窗口',
        !!(noteCard && noteCard.title === '向 AI 提问'), JSON.stringify(noteCard))
      check('页面内工具条：独立回答窗口回显问题',
        !!(noteCard && noteCard.question === QUESTION), JSON.stringify(noteCard))

      // 复制选中原文（页面内走 navigator.clipboard，剪贴板由主进程回读校验）
      await mainCdp.evaluate(`(() => {
        const req = ${REQUIRE_EXPR}
        req('electron').clipboard.writeText('__cleared__')
        return true
      })()`).catch(() => null)

      if (cardCdp) {
        await cardCdp.evaluate(`(() => {
          const p = document.querySelector('.ai-panel .ai-close')
          if (p) p.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return true
        })()`).catch(() => null)
        cardCdp.close()
      }
      await mainCdp.evaluate(`(() => {
        const w = globalThis.__noteWin
        if (w && !w.isDestroyed()) w.focus()
        return true
      })()`).catch(() => null)
      await sleep(200)

      // 关掉卡片后重新划一次词，再点复制
      await noteCdp.evaluate(`(() => {
        const host = document.getElementById('e2e-sel')
        if (!host) return false
        host.textContent = '第二段被选中的文字'
        const r = document.createRange()
        r.selectNodeContents(host)
        const s = window.getSelection()
        s.removeAllRanges()
        s.addRange(r)
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return true
      })()`)
      await sleep(400)

      const copied = await noteCdp.evaluate(`(async () => {
        const b = document.querySelector('.ai-bar [data-act="copyText"]')
        if (!b) return 'no-button'
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return 'clicked'
      })()`)
      await sleep(400)

      const clip2 = await mainCdp.evaluate(`(() => {
        const req = ${REQUIRE_EXPR}
        return req('electron').clipboard.readText()
      })()`).catch(() => null)

      check('页面内工具条：点「复制」把选中原文写进剪贴板',
        clip2 === '第二段被选中的文字', JSON.stringify({ copied, clip2 }))

      noteCdp.close()
    }

    // ---------------------------------------------------------------- 退出
    await mainCdp.evaluate(`(() => {
      const req = ${REQUIRE_EXPR}
      try { const w = globalThis.__ovlWin; if (w && !w.isDestroyed()) w.destroy() } catch (_) {}
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
    pageCdp && pageCdp.close()
    mainCdp && mainCdp.close()
    await sleep(500)
    try { child.kill() } catch (_) {}
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
