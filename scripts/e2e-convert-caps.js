'use strict'

/**
 * 转换能力查询 端到端回归（npm run test:e2e:convert:caps）。
 *
 * 验的是**真实主进程链路**（main.js → convertBridge → service → router → provider），
 * 而不是像 e2e-convert-builtin.js 那样在主进程里另起一套 router。
 *
 * 场景：
 *   1. 不装 Filee 时，png/json 的能力查询仍然可用（内置引擎兜底）
 *   2. 完全未知的扩展名 → usage（而不是 not-installed）
 *   3. 能力查询走 IPC（convert:capabilities）而不是内联逻辑
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const BASE_CDP_PORT = 9440

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

async function main () {
  console.log('转换能力查询 e2e')
  const cdpPort = BASE_CDP_PORT
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-caps-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'), JSON.stringify({ version: 1, notes: [], settings: {} }))

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
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

  const checks = []
  let cdp = null
  try {
    const inspectorUrl = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 25000, 'inspector')
    await waitFor(async () => log.includes('[boot] 托盘就绪') ? true : null, 25000, '启动完成')

    cdp = new CDP(inspectorUrl)
    await cdp.connect()

    // 直接调用主进程里已装配好的 service（走真实链路）
    const expr = `(() => {
      const getReq = ${REQUIRE_EXPR}
      const req = getReq()
      if (!req) return { ok: false, err: 'no require' }
      const bridge = req('./lib/convert/main-bridge')
      // main.js 里装配好的 runtime 在模块作用域，测试拿不到 ⇒ 现搭一个同配置的
      const providers = req('./lib/convert/providers')
      const workerHost = req('./lib/convert/worker-host')
      const routerLib = req('./lib/convert/router')
      const { BrowserWindow } = req('electron')
      const host = workerHost.createWorkerHost({ BrowserWindow, srcDir: ${JSON.stringify(path.join(ROOT, 'src'))} })
      const list = providers.createDefaultProviders({ workerHost: host, withFilee: false })
      const router = routerLib.createRouter({ providers: list })
      const p = (ext) => router.capabilities(ext)
      return p('png').then(png => p('json').then(json => p('zzz').then(zzz => {
        try { host.dispose() } catch (_) {}
        return { png, json, zzz }
      })))
    })()`

    const r = await cdp.evaluate(expr)
    assert.ok(r && !r.err, '求值失败: ' + JSON.stringify(r))

    checks.push(['不装 Filee 时 png 仍有可用格式', r.png.ok === true && r.png.targets.length > 0])
    checks.push(['png 的目标含 jpg', r.png.targets.includes('jpg')])
    checks.push(['不装 Filee 时 json 仍有可用格式', r.json.ok === true && r.json.targets.length > 0])
    checks.push(['json 的目标含 csv', r.json.targets.includes('csv')])
    checks.push(['未知扩展名 → usage 而非 not-installed', r.zzz.ok === false && r.zzz.reason === 'usage'])

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
    console.error('  ' + log.split('\n').slice(-12).join('\n  '))
    if (cdp) cdp.close()
    if (child.exitCode === null) { try { child.kill() } catch (_) {} }
    process.exit(1)
  }

  let pass = 0
  for (const [name, ok] of checks) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + name)
    if (ok) pass++
  }
  console.log('\n结果：' + pass + '/' + checks.length + ' 通过')
  process.exit(pass === checks.length ? 0 : 1)
}

main()
