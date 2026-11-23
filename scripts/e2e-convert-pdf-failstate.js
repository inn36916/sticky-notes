'use strict'

/**
 * 转换失败态 e2e 回归（npm run test:e2e:convert:pdf:failstate）。
 *
 * ============================ 为什么必须有这个脚本 ============================
 *   F1（2026-11-18）：转换失败后 UI **永久锁死**，用户在同一窗口无法重试。
 *   真实时序（QA 实测复现）：
 *     1. 点格式 → onPick：converting=true、设 currentReqId、allPages.disabled=true
 *     2. 转换失败 → main-bridge reportError → main.js 向同一个 convertWin
 *        **先发 convert:files** → 渲染层 onFiles 把 currentReqId 清成 ''
 *     3. 随后 convert:run 的失败回包（**带 reqId**）才到达
 *        → src/convert.js 的 `if (r.reqId !== currentReqId) return` 命中
 *        ⇒ converting 永远 true、resetCards() 永远不执行
 *        ⇒ allPages.disabled 永远 true，用户再点卡片也没反应
 *        （QA 实测：再点一次卡片，convertRun 调用次数仍是 1）
 *
 *   ★ 这个 bug **静态检查抓不到、模拟 DOM 也抓不到**：
 *     必须走「真 Electron + 真 IPC + 真失败回包」这条路径。
 *     所以本脚本必须真跑一次。
 *
 * ★ 本脚本用的是**真 convertWin**（由 main.js 的 openConvertWindow 创建），
 *   不是另开一个模拟窗口 —— 因为 F1 的根因就在 main.js → convertWin 这条真链路上。
 *
 * 断言链（缺一不可）：
 *   A. 失败态：status.className 含 err；progress.hidden === true
 *   B. 卡片 pointerEvents === ''（可点）；allPages.disabled === false（可勾）
 *   C. ★ 再点一次卡片能产生**新的** convert:run（计数 +1）
 *      —— 这条才是 F1 的核心：光看 DOM 恢复不够，必须证明用户真的能重试。
 *
 * ★ 判断一律解析输出，不看 exitCode：本机 safe-delete 守卫会让退出码失真。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9478

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

  /**
   * 求值（带有限重试）。
   * ★ CDP 的 Runtime.evaluate 偶尔报 `-32000 "Promise was collected"` —— V8 抖动，
   *   与被测代码无关；只对该错误重试，其它错误立刻抛出。
   */
  async evaluate (expression) {
    let last = null
    for (let i = 0; i < 8; i++) {
      try {
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

// ---------------------------------------------------------------- 主进程表达式

/**
 * 主进程侧执行：找到真 convertWin，驱动它走「点格式 → 失败 → 再点一次」，
 * 并统计主进程真正收到的 convert:run 次数。
 */
function buildExpr () {
  return `(async () => {
   let stage = 'init'
   try {
    const getReq = ${REQUIRE_EXPR}
    const req = getReq()
    if (!req) return { ok: false, err: 'no require' }
    const { BrowserWindow, ipcMain } = req('electron')

    // ★★ 统计 convert:run 的真实调用次数（wrap ipcMain 的 handler）★★
    //   "用户能不能再发起一次转换"只能靠主进程侧的真实调用次数来证明。
    const handlers = ipcMain._invokeHandlers
    const origRun = handlers.get('convert:run')
    if (!origRun) return { ok: false, stage, diag: '找不到 convert:run handler' }
    globalThis.__convertRunCount = 0
    handlers.set('convert:run', async function (e, payload) {
      globalThis.__convertRunCount = (globalThis.__convertRunCount || 0) + 1
      return origRun.call(this, e, payload)
    })

    /** 找到真 convertWin（convert.html 那个窗口） */
    const findConvertWin = async () => {
      for (let i = 0; i < 200; i++) {
        const w = BrowserWindow.getAllWindows().find(x =>
          !x.isDestroyed() && /convert\\.html/.test(x.webContents.getURL()))
        if (w) return w
        await new Promise(r => setTimeout(r, 100))
      }
      return null
    }

    const win = await findConvertWin()
    if (!win) return { ok: false, stage, diag: '找不到 convert 窗口' }

    /** 等格式卡渲染出来 */
    const waitCards = async (timeout = 20000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeout) {
        const n = await win.webContents.executeJavaScript(
          'document.querySelectorAll(".fmt").length', true)
        if (n) return n
        await new Promise(r => setTimeout(r, 100))
      }
      return 0
    }

    /** 等 UI 进入终态（状态栏 class ∈ ok/warn/err） */
    const waitTerminal = async (timeout = 45000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeout) {
        const cls = String(await win.webContents.executeJavaScript(
          'document.getElementById("status").className', true) || '')
        if (/(^|\\s)(ok|warn|err)(\\s|$)/.test(cls)) return cls
        await new Promise(r => setTimeout(r, 80))
      }
      return ''
    }

    /** 采一份 DOM 快照 */
    const snap = () => win.webContents.executeJavaScript(\`(() => {
      const p = document.getElementById('progress')
      const s = document.getElementById('status')
      const cards = Array.from(document.querySelectorAll('.fmt'))
      const ap = document.getElementById('allPages')
      return {
        progressHidden: p ? p.hidden : null,
        status: s ? s.textContent : '',
        cls: s ? s.className : '',
        cardCount: cards.length,
        cardPointer: cards.length ? (cards[0].style.pointerEvents || '') : null,
        allPagesHidden: ap ? ap.hidden : null,
        allPagesDisabled: ap ? ap.disabled : null
      }
    })()\`, true)

    /** 点某张格式卡 */
    const clickCard = (fmt) => win.webContents.executeJavaScript(\`(() => {
      const card = Array.from(document.querySelectorAll('.fmt')).find(e => e.dataset.fmt === \${JSON.stringify(fmt)})
      if (!card) return { ok: false, all: Array.from(document.querySelectorAll('.fmt')).map(e => e.dataset.fmt) }
      card.click()
      return { ok: true }
    })()\`, true)

    // ================================================================ 场景 1：首次点击（必失败）
    stage = 'first-fail'
    const cardCount = await waitCards()
    if (!cardCount) return { ok: false, stage, diag: '格式卡没有渲染出来' }

    const c1 = await clickCard('png')
    if (!c1.ok) return { ok: false, stage, diag: '找不到 png 卡片：' + JSON.stringify(c1) }

    const cls1 = await waitTerminal()
    const dom1 = await snap()
    const runs1 = globalThis.__convertRunCount

    // ================================================================ 场景 2：失败后再点一次
    stage = 'retry'
    const c2 = await clickCard('png')
    if (!c2.ok) return { ok: false, stage, diag: '重试时找不到 png 卡片（卡片被清掉了）' }
    await waitTerminal()
    const dom2 = await snap()
    const runs2 = globalThis.__convertRunCount

    // ================================================================ 场景 3：第三次
    stage = 'retry2'
    await clickCard('png')
    await waitTerminal()
    const dom3 = await snap()
    const runs3 = globalThis.__convertRunCount

    handlers.set('convert:run', origRun)

    return {
      ok: true,
      cls1, dom1, dom2, dom3,
      runs1, runs2, runs3
    }
   } catch (err) {
     return { ok: false, stage, diag: String((err && err.stack) || err) }
   }
  })()`
}

// ---------------------------------------------------------------- 主流程

async function main () {
  console.log('转换失败态（F1）e2e\n')

  const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-failstate-src-'))
  // ★ 必失败的源：扩展名是 .pdf，但内容不是 PDF（魔数不匹配）
  //   ⇒ provider 的魔数校验直接判失败 ⇒ ok:false ⇒ 走真实失败回包路径
  const badPdf = path.join(srcRoot, 'broken.pdf')
  fs.writeFileSync(badPdf, Buffer.from('this is definitely not a PDF file', 'ascii'))

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-failstate-ud-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'),
    JSON.stringify({ version: 1, notes: [], settings: {} }))

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.STICKY_FILEE = 'C:\\definitely\\not\\installed\\filee.exe'

  // ★ 用真启动参数走真链路：--convert <坏文件> ⇒ main.js 的 handleArgv
  //   → openConvertWindow(files) ⇒ 弹出真 convertWin（失败提示也走它）。
  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData,
    '--remote-debugging-port=' + CDP_PORT,
    '--inspect=0',
    '.',
    '--convert',
    badPdf
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })

  const checks = []
  let cdp = null
  let r = null
  try {
    const inspectorUrl = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 25000, 'inspector')
    await waitFor(async () => log.includes('[boot] 托盘就绪') ? true : null, 25000, '启动完成')

    cdp = new CDP(inspectorUrl)
    await cdp.connect()
    r = await cdp.evaluate(buildExpr())
    assert.ok(r && r.ok, '求值失败: ' + JSON.stringify(r).slice(0, 1500))

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
    console.error('  ' + log.split('\n').slice(-25).join('\n  '))
    if (cdp) cdp.close()
    if (child.exitCode === null) { try { child.kill() } catch (_) {} }
    process.exit(1)
  }

  // ---------------------------------------------------------------- 断言
  const d1 = r.dom1 || {}
  const d2 = r.dom2 || {}
  const d3 = r.dom3 || {}

  checks.push(['★ 第一次转换确实失败了（状态栏 class 含 err）',
    /(^|\s)err(\s|$)/.test(r.cls1 || '') || /(^|\s)err(\s|$)/.test(d1.cls || ''),
    'cls1=' + r.cls1 + ' dom1.cls=' + d1.cls])
  checks.push(['★ 失败态状态栏有可读文案', !!(d1.status && d1.status.trim()),
    JSON.stringify(d1.status)])
  checks.push(['★ 失败态进度条已隐藏', d1.progressHidden === true,
    'progressHidden=' + d1.progressHidden])
  checks.push(['★ 失败态卡片恢复可点（pointerEvents === ""）',
    d1.cardPointer === '', 'cardPointer=' + JSON.stringify(d1.cardPointer)])
  checks.push(['★ 失败态「转换所有页面」恢复可勾（disabled === false）',
    d1.allPagesDisabled === false, 'allPagesDisabled=' + d1.allPagesDisabled])
  checks.push(['★ 失败态窗口没有关闭（卡片还在）', d1.cardCount > 0,
    'cardCount=' + d1.cardCount])

  // ★★★ 核心：重试必须能产生新的 convert:run
  checks.push(['★ 第一次点击产生了 1 次 convert:run', r.runs1 === 1, 'runs1=' + r.runs1])
  checks.push(['★★ 失败后再点一次 ⇒ convert:run 计数 +1（用户能重试）',
    r.runs2 === r.runs1 + 1, 'runs1=' + r.runs1 + ' runs2=' + r.runs2])
  checks.push(['★★ 再点一次 ⇒ convert:run 计数再 +1（闸没卡死）',
    r.runs3 === r.runs2 + 1, 'runs2=' + r.runs2 + ' runs3=' + r.runs3])
  checks.push(['★★ 第二次失败后卡片仍可点', d2.cardPointer === '',
    'cardPointer=' + JSON.stringify(d2.cardPointer)])
  checks.push(['★★ 第二次失败后 allPages 仍可勾', d2.allPagesDisabled === false,
    'allPagesDisabled=' + d2.allPagesDisabled])
  checks.push(['★ 第三次失败后状态栏仍是 err（不是卡在"转换中"）',
    /(^|\s)err(\s|$)/.test(d3.cls || ''), 'cls=' + d3.cls])
  checks.push(['★ 第三次失败后进度条仍隐藏', d3.progressHidden === true,
    'progressHidden=' + d3.progressHidden])

  let pass = 0
  for (const [name, ok, detail] of checks) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail && !ok ? '  —— ' + detail : ''))
    if (ok) pass++
  }
  console.log('\n结果：' + pass + '/' + checks.length + ' 通过')
  console.log('convert:run 实际计数：' + r.runs1 + ' → ' + r.runs2 + ' → ' + r.runs3)
  process.exit(pass === checks.length ? 0 : 1)
}

main()
