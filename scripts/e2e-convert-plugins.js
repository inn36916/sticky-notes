'use strict'

/**
 * 转换引擎插件 端到端回归（npm run test:e2e:convert:plugins）。
 *
 * 验的是**真实启动链路**：
 *   把一个插件 .js 放进 <userData>/convert-plugins/ ⇒ 重启应用 ⇒
 *   框架自动发现它 ⇒ 它的能力出现在能力查询里 ⇒ 转换真的由它执行。
 *
 * ★ 这条 e2e 的意义：单测能证明"发现逻辑正确"，
 *   但证明不了"主进程启动时真的会去扫那个目录"。
 *
 * 场景：
 *   1. 插件被自动发现（引擎清单里出现它）
 *   2. 插件的能力被合并进 targets
 *   3. 转换真的由插件执行，产物落盘且内容正确
 *   4. 坏插件（语法错误）不影响应用启动与其它引擎
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const BASE_CDP_PORT = 9441

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

/** 插件源码：把文本文件转成 .zzz（内容加后缀） */
const PLUGIN_SRC = `
module.exports = {
  id: 'e2e-plugin',
  name: 'E2E 测试插件',
  async available () { return true },
  async capabilities (ext) {
    return {
      ok: true, reason: 'ok',
      targets: ['zzz'], withEngines: [],
      displayName: 'E2E', error: null
    }
  },
  async convert (files, target, outDir) {
    const fs = require('fs')
    const path = require('path')
    const outputs = []
    const failures = []
    for (const f of files) {
      try {
        const dest = path.join(outDir, path.basename(f) + '.zzz')
        fs.writeFileSync(dest, 'PLUGIN:' + fs.readFileSync(f, 'utf8'))
        outputs.push({ source: f, output: dest })
      } catch (err) {
        failures.push({ source: f, state: 'failed', outputs: [], error: String(err.message) })
      }
    }
    return {
      ok: outputs.length > 0, reason: outputs.length ? 'ok' : 'failed',
      outputs, failures, files: [], error: outputs.length ? null : '转换失败'
    }
  }
}
`

async function main () {
  console.log('转换引擎插件 e2e')
  const cdpPort = BASE_CDP_PORT
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-plug-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'), JSON.stringify({ version: 1, notes: [], settings: {} }))

  // ★ 关键：把插件放进 userData 下的 convert-plugins 目录（用户投放位置）
  const pluginDir = path.join(userData, 'convert-plugins')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'e2e-plugin.js'), PLUGIN_SRC, 'utf8')
  // 再放一个坏插件：验证它不会拖垮应用
  fs.writeFileSync(path.join(pluginDir, 'broken.js'), 'this is not valid javascript {{{', 'utf8')

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

    // 用与 main.js 完全相同的配置装配 provider（包含插件加载）
    const expr = `(() => {
      const getReq = ${REQUIRE_EXPR}
      const req = getReq()
      if (!req) return { ok: false, err: 'no require' }
      const providers = req('./lib/convert/providers')
      const routerLib = req('./lib/convert/router')
      const userDataDir = ${JSON.stringify(userData)}
      const list = providers.createDefaultProviders({
        workerHost: null,
        appDir: ${JSON.stringify(ROOT)},
        userDataDir,
        withFilee: false,
        log: () => {}
      })
      const router = routerLib.createRouter({ providers: list })
      const engines = router.engines()
      const caps = router.capabilities('txt')
      // 真实转换：写一个源文件，交给插件
      const fs = req('fs')
      const os = req('os')
      const path = req('path')
      const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-plugsrc-')), 'a.txt')
      fs.writeFileSync(src, 'hello')
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-plugout-'))
      const conv = router.convert([src], 'zzz', outDir)
      return Promise.all([engines, caps, conv]).then(([eng, cp, cv]) => {
        const outFile = cv.outputs && cv.outputs[0] ? cv.outputs[0].output : null
        return {
          engines: eng,
          caps: cp,
          conv: cv,
          outFile,
          outContent: outFile ? fs.readFileSync(outFile, 'utf8') : null
        }
      })
    })()`

    const r = await cdp.evaluate(expr)
    assert.ok(r && !r.err, '求值失败: ' + JSON.stringify(r))

    const engIds = (r.engines || []).map(e => e.id)
    const pluginEng = (r.engines || []).find(e => e.id === 'e2e-plugin')

    checks.push(['插件被自动发现并出现在引擎清单里', !!pluginEng])
    checks.push(['插件引擎状态为可用', !!(pluginEng && pluginEng.available === true)])
    checks.push(['坏插件被跳过，应用未受影响', engIds.includes('builtin-text-data')])
    checks.push(['插件的能力被合并进 targets', (r.caps.targets || []).includes('zzz')])
    checks.push(['内置引擎能力未被插件破坏', (r.caps.targets || []).includes('csv')])
    checks.push(['转换真的由插件执行', r.conv.ok === true && r.conv.provider === 'e2e-plugin'])
    checks.push(['插件产物已落盘', !!r.outFile])
    checks.push(['插件产物内容正确', r.outContent === 'PLUGIN:hello'])

    // ---- 设置页 UI：引擎清单真的渲染出来了 ----
    // 这一段验的是「convert:engines IPC → preload → dashboard.js → DOM」整条链路，
    // 前面那些只验到主进程层。
    try {
      // 通过主进程 inspector 开一个 dashboard 窗口：复用 main.js 的 IPC handler 不可直接调，
      // 改走「构造一个 BrowserWindow 加载 dashboard.html」——同样的渲染层与 preload。
      // ★ 必须 show:true：
      //   show:false 的窗口在 Chromium 里算「不可见页面」，其定时器被强制节流，
      //   页面里的 setTimeout 回调长时间不触发 ⇒ 异步 UI 渲染永远等不到。
      //   生产代码里 worker 窗口是 show:false，但它只依赖 IPC 事件、不依赖定时器推进，
      //   所以不受影响。
      await cdp.evaluate(`(() => {
        const getReq = ${REQUIRE_EXPR}
        const req = getReq()
        const { BrowserWindow } = req('electron')
        const path = req('path')
        const w = new BrowserWindow({
          show: true,
          width: 900, height: 640,
          webPreferences: {
            preload: path.join(${JSON.stringify(ROOT)}, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
          }
        })
        w.loadFile(path.join(${JSON.stringify(path.join(ROOT, 'src'))}, 'dashboard.html'))
        globalThis.__e2eDashWin = w
        return true
      })()`)

      const dashTarget = await waitFor(async () => {
        const resp = await fetch('http://127.0.0.1:' + cdpPort + '/json/list')
        const list = await resp.json()
        // ★ 取**最后**一个匹配的：main.js 可能已经开过一个 dashboard 窗口，
        //   旧实例加载的是改动前的 HTML（不含 convertModal/engineList），
        //   拿第一个会连到旧页面上，导致后面的断言莫名其妙地失败。
        const hits = list.filter(t => t.type === 'page' && /dashboard\.html/.test(t.url))
        return hits.length ? hits[hits.length - 1] : null
      }, 12000, 'dashboard 页面')

      const dashCdp = new CDP(dashTarget.webSocketDebuggerUrl)
      await dashCdp.connect()
      try {
        // ★ 必须等页面真正加载完：
        //   /json/list 里出现 target 时，document 往往还在解析中（body 是空的）。
        //   之前直接查 DOM 拿到 null，误判成"渲染层没实现"。
        await waitFor(async () => {
          const st = await dashCdp.evaluate(
            "document.readyState + '|' + (document.body ? document.body.innerHTML.length : -1)"
          )
          const parts = String(st || '').split('|')
          return parts[0] === 'complete' && Number(parts[1]) > 100 ? true : null
        }, 15000, 'dashboard 加载完成')

        // 打开设置页的「格式转换」弹窗，等引擎清单渲染
        // ★ 只点一次：
        //   openConvertModal 每次都会把 engineListEl 重置成「正在读取…」，
        //   如果在轮询里反复点击，就永远停在"正在读取"的状态 —— 这正是之前的假失败。
        await dashCdp.evaluate(`(() => {
          const btn = document.getElementById('convertConfig')
          if (btn) btn.click()
          return true
        })()`)

        let lastUi = null
        const ui = await waitFor(async () => {
          const v = await dashCdp.evaluate(`(() => {
            const list = document.getElementById('engineList')
            const dir = document.getElementById('pluginDir')
            return {
              ok: true,
              text: list ? list.textContent : '',
              items: document.querySelectorAll('#engineList .engine-item').length,
              names: Array.from(document.querySelectorAll('#engineList .engine-name')).map(e => e.textContent),
              states: Array.from(document.querySelectorAll('#engineList .engine-state')).map(e => e.textContent),
              dir: dir ? dir.textContent : '',
              onDots: document.querySelectorAll('#engineList .engine-dot.on').length
            }
          })()`)
          lastUi = v
          return v && v.ok && v.items > 0 ? v : null
        }, 12000, '引擎清单渲染').catch(async e => {
          // 失败时把渲染层的真实状态全部 dump 出来
          const deep = await dashCdp.evaluate(`(() => {
            const list = document.getElementById('engineList')
            return {
              listExists: !!list,
              listHTML: list ? list.outerHTML.slice(0, 400) : null,
              listClass: list ? list.className : null,
              scriptTags: Array.from(document.querySelectorAll('script')).map(s => s.getAttribute('src')),
              hasRenderFn: typeof window.renderEngines,
              modalHidden: document.getElementById('convertModal') ? document.getElementById('convertModal').hidden : null
            }
          })()`).catch(err => ({ evalErr: String(err.message) }))
          console.log('  [渲染快照] ' + JSON.stringify(lastUi))
          console.log('  [深层状态] ' + JSON.stringify(deep))
          throw e
        })

        checks.push(['设置页渲染出引擎清单条目', ui.items >= 3])
        checks.push(['引擎清单里显示了插件名', (ui.names || []).some(n => n.includes('E2E 测试插件'))])
        checks.push(['已就绪/未启用状态被区分', (ui.states || []).includes('已就绪')])
        checks.push(['可用引擎有绿色状态点', ui.onDots >= 1])
        checks.push(['插件目录路径已显示给用户', String(ui.dir).includes('convert-plugins')])
      } finally {
        dashCdp.close()
      }
    } catch (err) {
      checks.push(['设置页引擎清单 UI（跳过：' + err.message + '）', false])
    }

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
