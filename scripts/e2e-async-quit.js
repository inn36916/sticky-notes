'use strict'

/**
 * 异步落盘 + 退出竞态 端到端回归（不进 npm test，单独跑：npm run test:e2e:async）。
 *
 * 背景：本轮把落盘从「同步写盘」改成「紧凑 JSON + 异步写」。
 * 异步化最容易破的一条是 **退出竞态**：before-quit 里 kick off 一次异步写盘后，
 * 如果没人 await，Electron 会直接退出 → 进程被杀 → 磁盘上还是旧内容（正文丢失）。
 *
 * 纪律（沿用 scripts/e2e-quit.js）：
 *  - 必须用隔离 --user-data-dir，绝不碰真实 sticky-notes.json；
 *  - 必须走 app.quit() → before-quit（等价托盘「退出」），严禁 Stop-Process -Force 代替；
 *  - 临时目录放 OS 临时目录（safe-delete 守卫豁免区）。
 *
 * 每个场景独立 spawn 一次 Electron，互不污染。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const BASE_CDP_PORT = 9340

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, timeout = 20000, label = '') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch (_) {}
    await sleep(100)
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

const MARK = 'E2E-ASYNC-MARK'

function seedFixture () {
  return {
    version: 2,
    notes: [{
      id: 'e2e-async-note',
      title: '异步落盘便签',
      html: '<p>SEED-MARK</p>',
      preview: 'SEED-MARK',
      color: '#FFF3B0',
      bounds: { x: 300, y: 200, width: 420, height: 520 },
      collapsed: false,
      collapseEdge: null,
      edgeCollapse: true,
      visible: true,
      alwaysOnTop: false,
      mode: 'edit'
    }],
    ai: { activeId: '', providers: [] },
    settings: { globalSelect: false }
  }
}

/** 在主进程 inspector 里拿 electron 模块并调用 app.quit()（真实退出路径） */
const QUIT_EXPR = `(() => {
  try {
    const m = globalThis.process && globalThis.process.mainModule
    let e = null
    if (m && m.require) e = m.require('electron')
    if (!e && typeof require === 'function') e = require('electron')
    if (!e && m && m.constructor && m.constructor._load) e = m.constructor._load('electron', m, false)
    if (!e && typeof Module === 'function' && Module._load) e = Module._load('electron', null, false)
    if (!e && typeof process === 'object' && process.getBuiltinModule) e = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron')
    if (!e || !e.app) return { ok: false, err: 'no electron module' }
    e.app.quit()
    return { ok: true }
  } catch (err) { return { ok: false, err: String(err) } }
})()`

/**
 * 起一个 Electron 实例，跑 fn({ editorCdp, mainCdp, dataFile, child })，最后收尾。
 * @param {string} name 场景名
 * @param {(ctx:object)=>Promise<void>} fn
 */
async function scenario (name, fn, post) {
  const cdpPort = BASE_CDP_PORT + (scenario.seq++)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-async-'))
  const dataFile = path.join(userData, 'sticky-notes.json')
  fs.writeFileSync(dataFile, JSON.stringify(seedFixture(), null, 2), 'utf8')

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData,
    '--remote-debugging-port=' + cdpPort,
    '--inspect=0',
    '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let log = ''
  let inspectorUrl = null
  const onData = (d) => {
    const s = d.toString()
    log += s
    // 只要 Node 主进程 inspector（"Debugger listening on"），
    // 不要 Chromium 的 "DevTools listening on ws://.../devtools/browser/..."
    const m = s.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
    if (m && !inspectorUrl) inspectorUrl = m[1]
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const cdps = []
  const steps = []
  let failed = null
  try {
    const targets = await waitFor(async () => {
      const r = await fetch('http://127.0.0.1:' + cdpPort + '/json/list')
      const list = await r.json()
      return list.filter(t => t.type === 'page' && /note\.html/.test(t.url)).length >= 1 ? list : null
    }, 25000, '便签渲染页就绪')

    let editorCdp = null
    for (const t of targets.filter(t => t.type === 'page' && /note\.html/.test(t.url))) {
      const c = new CDP(t.webSocketDebuggerUrl)
      await c.connect()
      cdps.push(c)
      const html = await waitFor(async () => c.evaluate(
        "document.querySelector('#editor') ? document.querySelector('#editor').innerHTML : ''"
      ), 15000, 'editor 初始化')
      if (String(html).indexOf('SEED-MARK') >= 0) { editorCdp = c; break }
    }
    assert.ok(editorCdp, '未找到便签渲染页')
    steps.push('boot: 便签窗口已创建')

    const url = await waitFor(() => inspectorUrl, 15000, '主进程 inspector ws')
    const mainCdp = new CDP(url)
    await mainCdp.connect()
    cdps.push(mainCdp)

    await fn({ editorCdp, mainCdp, dataFile, child, steps })

    // 真退出：app.quit() → before-quit
    const quit = await mainCdp.evaluate(QUIT_EXPR)
    assert.equal(quit && quit.ok, true, 'app.quit() 调用失败: ' + JSON.stringify(quit))
    steps.push('quit: before-quit 已触发（非强杀）')
    mainCdp.close()

    await waitFor(async () => child.exitCode !== null, 12000, '进程正常退出').catch(() => {})
    assert.notEqual(child.exitCode, null, '应用未自然退出（可能仍被 debugger 挂住）')
    steps.push('exit: 自然退出 exitCode = ' + child.exitCode)

    const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    // 退出后的落盘断言必须和运行时断言在同一个 try 里，
    // 否则一次断言失败会中断整个脚本，后面几条用例就再也跑不到。
    if (post) await post(disk, steps)
    return { name, ok: true, steps, disk, logTail: log.slice(-1500) }
  } catch (err) {
    failed = err
    return { name, ok: false, steps, error: err && err.message ? err.message : String(err), logTail: log.slice(-1500) }
  } finally {
    for (const c of cdps) c.close()
    if (child.exitCode === null) child.kill()
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) {}
  }
}
scenario.seq = 0

// ---------------------------------------------------------------- 场景

/** S1：编辑后立刻退出（<50ms，远小于 180ms 防抖）——异步化最容易丢正文的一条 */
async function s1_editThenImmediateQuit () {
  return scenario('S1 编辑后立刻退出（<50ms）不丢正文', async ({ editorCdp, dataFile, steps }) => {
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = '<p>${MARK}-S1</p>'
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    // 不等任何防抖，立刻返回，让调用方去 quit
    steps.push('edit: 已输入 ' + MARK + '-S1（未等防抖）')
  }, async (disk, steps) => {
    const html = String((disk.notes[0] || {}).html || '')
    assert.ok(html.indexOf(MARK + '-S1') >= 0,
      '异步落盘丢正文：退出后磁盘上 = ' + JSON.stringify(html))
    steps.push('PASS: 退出后磁盘正文含 ' + MARK + '-S1')
  })
}

/** S2：等「已保存」出现后立刻读盘 —— N-04：显示「已保存」必须意味着真落盘 */
async function s2_savedMeansPersisted () {
  return scenario('S2 「已保存」必须以真落盘为准（N-04）', async ({ editorCdp, dataFile, steps }) => {
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = '<p>${MARK}-S2</p>'
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const savedText = await waitFor(async () => {
      const t = await editorCdp.evaluate("document.querySelector('#saved').textContent")
      return t && t.indexOf('已保存') === 0 ? t : null
    }, 8000, '渲染层显示「已保存」')
    steps.push('saved: 渲染层状态 = ' + savedText)

    // 关键：显示「已保存」的这一刻，磁盘上必须已经有内容
    let diskNow = null
    try { diskNow = JSON.parse(fs.readFileSync(dataFile, 'utf8')) } catch (err) {
      diskNow = { parseError: String(err) }
    }
    const html = String((diskNow.notes && diskNow.notes[0] ? diskNow.notes[0].html : '') || '')
    assert.ok(html.indexOf(MARK + '-S2') >= 0,
      'N-04 破裂：渲染层已显示「已保存」，但磁盘上还没有内容 -> ' + JSON.stringify(html))
    steps.push('PASS: 显示「已保存」时磁盘上确有内容')
  })
}

/** S3：并发 flush + 立刻退出 —— 写盘串行化 + 退出竞态的组合 */
async function s3_concurrentFlushThenQuit () {
  return scenario('S3 并发 flush 后立刻退出：不得丢最新内容', async ({ editorCdp, steps }) => {
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = '<p>${MARK}-S3</p>'
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    // 连发三次 flush，不 await
    const flushRes = await editorCdp.evaluate(`(async () => {
      const ps = [window.sticky.flush(), window.sticky.flush(), window.sticky.flush()]
      const rs = await Promise.allSettled(ps)
      return rs.map(r => r.status === 'fulfilled' ? r.value : { ok: false, error: String(r.reason) })
    })()`)
    steps.push('flush: 三次并发 flush 结果 = ' + JSON.stringify(flushRes))
    for (const r of (flushRes || [])) {
      assert.ok(r && r.ok === true, 'flush 未回传 ok=true: ' + JSON.stringify(r))
    }
  }, async (disk, steps) => {
    const html = String((disk.notes[0] || {}).html || '')
    assert.ok(html.indexOf(MARK + '-S3') >= 0,
      '并发 flush 后退出丢了最新内容：磁盘上 = ' + JSON.stringify(html))
    steps.push('PASS: 磁盘上是最新内容 ' + MARK + '-S3')
  })
}

/** S4：写盘在飞时立刻退出 —— 最尖锐的竞态 */
async function s4_quitDuringWriteInFlight () {
  return scenario('S4 写盘在飞时立刻退出（最尖锐竞态）', async ({ editorCdp, steps }) => {
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = '<p>${MARK}-S4</p>'
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    // 触发 flush 但不 await，等 5ms 让写盘进入飞行中，然后退出
    await editorCdp.evaluate(`(async () => {
      window.__pendingFlush = window.sticky.flush().catch(e => ({ ok: false, error: String(e) }))
      await new Promise(r => setTimeout(r, 5))
      return true
    })()`)
    steps.push('flush: 已发起不 await 的 flush，5ms 后即退出')
  }, async (disk, steps) => {
    const html = String((disk.notes[0] || {}).html || '')
    assert.ok(html.indexOf(MARK + '-S4') >= 0,
      '写盘在飞时退出丢了正文：磁盘上 = ' + JSON.stringify(html))
    steps.push('PASS: 写盘在飞时退出，磁盘正文完整')
  })
}

/** S5：退出后落盘内容必须是完整合法 JSON，且无 ≤60 窄条 / 无 260 钳制 */
async function s5_exitIntegrity () {
  return scenario('S5 退出后落盘完整性（合法 JSON / 无窄条 / version=当前版本）', async ({ editorCdp, steps }) => {
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = '<p>${MARK}-S5</p>'
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const saved = await waitFor(async () => {
      const t = await editorCdp.evaluate("document.querySelector('#saved').textContent")
      return t && t.indexOf('已保存') === 0 ? t : null
    }, 8000, '渲染层显示「已保存」')
    steps.push('saved: ' + saved)
  }, async (disk, steps) => {
    assert.equal(disk.version, require('../lib/migrations').CURRENT_VERSION, '版本未升级')
    assert.ok(Array.isArray(disk.notes))
    for (const n of disk.notes) {
      assert.ok(n.bounds.width > 60 && n.bounds.height > 60,
        '落盘出现窄条几何: ' + n.id + ' ' + JSON.stringify(n.bounds))
      assert.notEqual(n.bounds.width, 260, '出现被 clampBounds 钳出的「面条」宽度')
    }
    const html = String((disk.notes[0] || {}).html || '')
    assert.ok(html.indexOf(MARK + '-S5') >= 0, '退出后正文缺失')
    steps.push('PASS: version=当前版本、几何无窄条、正文完整')
  })
}

async function main () {
  const results = []
  results.push(await s1_editThenImmediateQuit())
  results.push(await s2_savedMeansPersisted())
  results.push(await s3_concurrentFlushThenQuit())
  results.push(await s4_quitDuringWriteInFlight())
  results.push(await s5_exitIntegrity())

  console.log('\n================ e2e-async-quit 逐用例结果 ================')
  let failed = 0
  for (const r of results) {
    console.log((r.ok ? 'PASSED ' : 'FAILED ') + r.name)
    for (const s of r.steps) console.log('    · ' + s)
    if (!r.ok) {
      failed++
      console.log('    ! ' + r.error)
      console.log('    --- logTail ---')
      console.log(String(r.logTail || '').split('\n').map(l => '    ' + l).join('\n'))
    }
  }
  console.log('===========================================================')
  console.log(`TOTAL=${results.length} PASSED=${results.length - failed} FAILED=${failed}`)
  process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
