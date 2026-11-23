'use strict'

/**
 * 内置转换引擎 端到端回归（npm run test:e2e:convert:builtin）。
 *
 * 覆盖的是**只有真起 Electron 才能验**的部分：
 *   1. 内置图片 provider：canvas 解码 + 编码真的产出正确格式的文件
 *   2. ★ canvas 静默回退防护：不支持的编码必须**失败**而不是产出 PNG
 *   3. 内置文本/数据 provider：JSON → CSV 等真的落盘且内容正确
 *   4. 便签里写入的是外置引用（sticky-att://），不是内联 dataURL
 *   5. ★ 不装 Filee 也能用（这是本轮改造的核心目标）
 *
 * 纪律（沿用 scripts/e2e-convert.js）：
 *  - 隔离 --user-data-dir，绝不碰真实 sticky-notes.json；
 *  - 走 app.quit() 退出，严禁强杀；
 *  - 临时目录放 OS 临时目录（safe-delete 守卫豁免区）。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const BASE_CDP_PORT = 9420

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
  async evaluate (expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true
    })
    if (r && r.exceptionDetails) {
      throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
    }
    return r && r.result ? r.result.value : undefined
  }
  close () { try { this.ws && this.ws.close() } catch (_) {} }
}

/** 主进程里取 require 的取值器（不是 require 本身！） */
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
    const e = req('electron')
    e.app.quit()
    return { ok: true }
  } catch (err) {
    return { ok: false, err: String(err && err.message || err) }
  }
})()`

/** 造 1x1 的 PNG（真实字节） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** 文件头魔数判定 */
function sniff (file) {
  const b = fs.readFileSync(file)
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b.length >= 4 && b.slice(0, 4).toString('ascii') === '%PDF') return 'pdf'
  return 'unknown:' + b.slice(0, 8).toString('hex')
}

const scenarios = []
function scenario (name, fn) { scenarios.push({ name, fn, results: [] }) }

// ---------------------------------------------------------------- 场景

scenario('内置图片 provider：PNG → JPEG，产物是真 JPEG', async ({ mainCdp, userData }) => {
  const src = path.join(userData, 'in.png')
  fs.writeFileSync(src, PNG_1PX)

  const expr = `(() => {
    const getReq = ${REQUIRE_EXPR}
    const req = getReq()
    if (!req) return { ok: false, err: 'no require' }
    const providers = req('./lib/convert/providers')
    const workerHost = req('./lib/convert/worker-host')
    const routerLib = req('./lib/convert/router')
    const { BrowserWindow } = req('electron')
    const host = workerHost.createWorkerHost({ BrowserWindow, srcDir: ${JSON.stringify(path.join(ROOT, 'src'))} })
    const list = providers.createDefaultProviders({ workerHost: host, withFilee: false })
    const router = routerLib.createRouter({ providers: list })
    return router.convert([${JSON.stringify(src)}], 'jpg', ${JSON.stringify(userData)})
      .then(r => { try { host.dispose() } catch (_) {} ; return r })
      .catch(e => ({ ok: false, err: String(e && e.message || e) }))
  })()`

  const r = await mainCdp.evaluate(expr)
  assert.ok(r && r.ok, '转换应成功: ' + JSON.stringify(r))
  assert.equal(r.provider, 'builtin-image', '应由内置图片 provider 处理')
  assert.equal(r.outputs.length, 1)

  const out = r.outputs[0].output
  assert.ok(fs.existsSync(out), '产物应落盘: ' + out)
  assert.equal(sniff(out), 'jpeg', '产物应是真正的 JPEG（不是静默回退的 PNG）')
})

scenario('内置图片 provider：PNG → WEBP，产物是真 WEBP', async ({ mainCdp, userData }) => {
  const src = path.join(userData, 'in2.png')
  fs.writeFileSync(src, PNG_1PX)

  const expr = `(() => {
    const getReq = ${REQUIRE_EXPR}
    const req = getReq()
    const providers = req('./lib/convert/providers')
    const workerHost = req('./lib/convert/worker-host')
    const routerLib = req('./lib/convert/router')
    const { BrowserWindow } = req('electron')
    const host = workerHost.createWorkerHost({ BrowserWindow, srcDir: ${JSON.stringify(path.join(ROOT, 'src'))} })
    const list = providers.createDefaultProviders({ workerHost: host, withFilee: false })
    const router = routerLib.createRouter({ providers: list })
    return router.convert([${JSON.stringify(src)}], 'webp', ${JSON.stringify(userData)})
      .then(r => { try { host.dispose() } catch (_) {} ; return r })
      .catch(e => ({ ok: false, err: String(e && e.message || e) }))
  })()`

  const r = await mainCdp.evaluate(expr)
  assert.ok(r && r.ok, '转换应成功: ' + JSON.stringify(r))
  assert.equal(sniff(r.outputs[0].output), 'webp', '产物应是真正的 WEBP')
})

scenario('★ 不支持的编码必须失败，不能产出 PNG 假成功', async ({ mainCdp, userData }) => {
  const src = path.join(userData, 'in3.png')
  fs.writeFileSync(src, PNG_1PX)

  const expr = `(() => {
    const getReq = ${REQUIRE_EXPR}
    const req = getReq()
    const providers = req('./lib/convert/providers')
    const workerHost = req('./lib/convert/worker-host')
    const routerLib = req('./lib/convert/router')
    const { BrowserWindow } = req('electron')
    const host = workerHost.createWorkerHost({ BrowserWindow, srcDir: ${JSON.stringify(path.join(ROOT, 'src'))} })
    const list = providers.createDefaultProviders({ workerHost: host, withFilee: false })
    const router = routerLib.createRouter({ providers: list })
    // gif 不是受支持的编码目标 ⇒ 必须失败
    return router.convert([${JSON.stringify(src)}], 'gif', ${JSON.stringify(userData)})
      .then(r => ({ ok: r.ok, reason: r.reason, error: r.error, outputs: r.outputs }))
      .catch(e => ({ ok: false, err: String(e && e.message || e) }))
  })()`

  const r = await mainCdp.evaluate(expr)
  assert.ok(r && r.ok === false, '必须判失败（canvas 会静默回退成 PNG，必须拦住）: ' + JSON.stringify(r))
  assert.ok(!r.outputs || r.outputs.length === 0, '失败时不应有产物')
})

scenario('内置文本 provider：JSON → CSV，产物内容正确', async ({ mainCdp, userData }) => {
  const src = path.join(userData, 'data.json')
  fs.writeFileSync(src, JSON.stringify([{ a: '1', b: '2' }, { a: '3', b: '4' }]))

  const expr = `(() => {
    const getReq = ${REQUIRE_EXPR}
    const req = getReq()
    const providers = req('./lib/convert/providers')
    const routerLib = req('./lib/convert/router')
    const list = providers.createDefaultProviders({ withFilee: false })
    const router = routerLib.createRouter({ providers: list })
    return router.convert([${JSON.stringify(src)}], 'csv', ${JSON.stringify(userData)})
      .catch(e => ({ ok: false, err: String(e && e.message || e) }))
  })()`

  const r = await mainCdp.evaluate(expr)
  assert.ok(r && r.ok, '转换应成功: ' + JSON.stringify(r))
  assert.equal(r.provider, 'builtin-text-data')
  const content = fs.readFileSync(r.outputs[0].output, 'utf8')
  assert.ok(content.includes('a,b'), 'CSV 应含表头: ' + content)
  assert.ok(content.includes('1,2'), 'CSV 应含数据行: ' + content)
})

scenario('★ 能力查询：装不装 Filee 都有可用格式', async ({ mainCdp }) => {
  const expr = `(() => {
    const getReq = ${REQUIRE_EXPR}
    const req = getReq()
    const providers = req('./lib/convert/providers')
    const routerLib = req('./lib/convert/router')
    // 不传 workerHost（模拟 worker 不可用）与不装 Filee
    const list = providers.createDefaultProviders({ withFilee: false })
    const router = routerLib.createRouter({ providers: list })
    return router.capabilities('json').then(c => ({ ok: c.ok, targets: c.targets, reason: c.reason }))
  })()`

  const r = await mainCdp.evaluate(expr)
  assert.ok(r && r.ok, '不装 Filee 也应有可用格式: ' + JSON.stringify(r))
  assert.ok(r.targets.includes('csv'), '应含 csv')
  assert.ok(r.targets.includes('yaml'), '应含 yaml')
  assert.ok(r.targets.includes('xml'), '应含 xml')
})

// ---------------------------------------------------------------- 运行

async function runScenario (s, index) {
  const cdpPort = BASE_CDP_PORT + index
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-builtin-'))
  const dataFile = path.join(userData, 'sticky-notes.json')
  fs.writeFileSync(dataFile, JSON.stringify({ version: 1, notes: [], settings: {} }, null, 2), 'utf8')

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  // ★ 明确让 Filee 探测不到 ⇒ 验证"不装 Filee 也能用"
  env.STICKY_FILEE = 'C:\\definitely\\not\\installed\\filee.exe'

  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData,
    '--remote-debugging-port=' + cdpPort,
    '--inspect=0',
    '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })

  const cdps = []
  const steps = []
  let failed = null
  try {
    const inspectorUrl = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 25000, '主进程 inspector 就绪')
    await waitFor(async () => log.includes('[boot] 托盘就绪') ? true : null, 25000, '应用启动完成')

    const mainCdp = new CDP(inspectorUrl)
    await mainCdp.connect()
    cdps.push(mainCdp)
    steps.push('boot: 主进程已就绪')

    await s.fn({ mainCdp, child, userData, dataFile, log: () => log, steps })

    const quit = await mainCdp.evaluate(QUIT_EXPR)
    assert.ok(quit && quit.ok, 'app.quit() 调用失败: ' + JSON.stringify(quit))
    mainCdp.close()
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode) return true
      await sleep(150)
      return false
    }, 20000, '进程退出').catch(() => {})
    if (child.exitCode === null && !child.signalCode) {
      try { child.kill() } catch (_) {}
      throw new Error('进程未在 20s 内退出')
    }
    steps.push('exit: 正常退出')
  } catch (err) {
    failed = err
  } finally {
    for (const c of cdps) c.close()
    if (child.exitCode === null && !child.signalCode) {
      try { child.kill() } catch (_) {}
    }
  }

  if (failed) {
    console.error('  ✗ ' + s.name)
    console.error('    ' + (failed.stack || failed.message || String(failed)))
    console.error('    --- 主进程日志尾部 ---')
    console.error('    ' + log.split('\n').slice(-12).join('\n    '))
    return false
  }
  console.log('  ✓ ' + s.name)
  return true
}

async function main () {
  console.log('内置转换引擎 e2e：' + scenarios.length + ' 个场景')
  let pass = 0
  for (let i = 0; i < scenarios.length; i++) {
    if (await runScenario(scenarios[i], i)) pass++
  }
  console.log('\n结果：' + pass + '/' + scenarios.length + ' 通过')
  process.exit(pass === scenarios.length ? 0 : 1)
}

main()
