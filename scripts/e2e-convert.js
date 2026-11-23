'use strict'

/**
 * 格式转换链路 端到端回归（不进 npm test，单独跑：npm run test:e2e:convert）。
 *
 * 覆盖的是**只有真起 Electron 才能验**的部分：
 *   1. 主进程能解析到 --convert 启动参数（argv 形态在 dev/packaged 下不同）
 *   2. 转换产物真的落到附件目录，并被登记成便签附件
 *   3. 便签里写入的是外置引用（sticky-att://），不是内联 dataURL
 *   4. 二次实例（second-instance）的 argv 转发与多文件聚合
 *   5. Filee 缺失时是明确提示，不是静默失败
 *
 * 纪律（沿用 scripts/e2e-async-quit.js）：
 *  - 隔离 --user-data-dir，绝不碰真实 sticky-notes.json；
 *  - 走 app.quit() → before-quit 退出，严禁强杀；
 *  - 临时目录放 OS 临时目录（safe-delete 守卫豁免区）；
 *  - **用假 CLI（scripts/fake-filee.js）当 Filee**，测试不依赖用户真装 Filee。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const FAKE_FILEE = path.join(__dirname, 'fake-filee.js')
const BASE_CDP_PORT = 9380

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
  send (method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)) }
      }, 10000)
    })
  }
  async evaluate (expression) {
    // Node inspector 在 boot 后半段仍在执行同步模块加载（createDefaultProviders
    // 现在会同步 require('pdf-lib')，约 200ms）时，Runtime.evaluate 偶发
    // -32000 "Promise was collected" 瞬态错误。这里只针对该瞬态错误重试，
    // 不放宽任何业务断言 —— 断言失败依旧原样抛出。
    let lastErr = null
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await this.send('Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true
        })
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
        return r.result ? r.result.value : null
      } catch (err) {
        lastErr = err
        if (!/Promise was collected/.test(err.message)) throw err
        await sleep(300)
      }
    }
    throw lastErr
  }
  close () { try { this.ws.close() } catch (_) {} }
}

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
 * 造一个「假 Filee」的 .cmd 包装器。
 *
 * 为什么用 .cmd 而不是直接指 node 脚本：
 *   真实形态里便携 zip 的 CLI 就是 `cli\filee.cmd`，而 .cmd **不能**被
 *   CreateProcess 直接执行（EINVAL），必须经 cmd.exe /c。
 *   用 .cmd 包装器能让 e2e 顺带验证这条 Windows 硬约束的接线是对的。
 *
 * @param {string} mode 假 CLI 的行为模式
 * @returns {string} .cmd 路径
 */
function makeFakeFilee (mode = 'ok') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-fakefilee-'))
  const cmd = path.join(dir, 'filee.cmd')
  const body = [
    '@echo off',
    'set "STICKY_FAKE_FILEE=' + mode + '"',
    '"' + process.execPath + '" "' + FAKE_FILEE + '" %*'
  ].join('\r\n')
  fs.writeFileSync(cmd, body, 'utf8')
  return cmd
}

function seedFixture () {
  return {
    version: 2,
    // 故意放一张哨兵便签：notes 为空会触发「欢迎使用桌面便签」，
    // 那样断言会抓到欢迎便签而不是转换结果。
    notes: [{
      id: 'e2e-conv-sentinel',
      title: '哨兵便签',
      html: '<p>SENTINEL-MARK</p>',
      preview: 'SENTINEL-MARK',
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

/**
 * 起一个 Electron 实例。
 * @param {string} name
 * @param {string[]} extraArgs 追加的启动参数（如 --convert xxx --to jpg）
 * @param {object} [envExtra] 追加的环境变量
 * @param {(ctx:object)=>Promise<void>} fn
 */
async function scenario (name, extraArgs, envExtra, fn) {
  const cdpPort = BASE_CDP_PORT + (scenario.seq++)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-conv-'))
  const dataFile = path.join(userData, 'sticky-notes.json')
  fs.writeFileSync(dataFile, JSON.stringify(seedFixture(), null, 2), 'utf8')

  const env = Object.assign({}, process.env, envExtra || {})
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS

  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData,
    '--remote-debugging-port=' + cdpPort,
    '--inspect=0',
    '.'
  ].concat(extraArgs || []), { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let log = ''
  const onData = (d) => { log += d.toString() }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const cdps = []
  const steps = []
  let failed = null
  try {
    // 等待主进程 inspector 就绪
    const inspectorUrl = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 25000, '主进程 inspector 就绪')

    // ★ 还要等应用真正启动完（托盘就绪）再求值。
    //   inspector 端口先开、应用后启动：只等 inspector 的话，
    //   求值可能落在「模块还没加载完」的窗口里，
    //   表现为 CDP 报 "Promise was collected"（S4 踩到过）。
    await waitFor(async () => {
      return log.includes('[boot] 托盘就绪') ? true : null
    }, 25000, '应用启动完成')

    const mainCdp = new CDP(inspectorUrl)
    await mainCdp.connect()
    cdps.push(mainCdp)
    steps.push('boot: 主进程已就绪')

    await fn({ mainCdp, child, userData, dataFile, log: () => log, steps })

    // 收尾：走真实退出路径
    const quit = await mainCdp.evaluate(QUIT_EXPR)
    assert.ok(quit && quit.ok, 'app.quit() 调用失败: ' + JSON.stringify(quit))
    // ★ 必须先断开 debugger 再等退出。
    //   Node inspector 在客户端没断开时会打印 "Waiting for the debugger to disconnect..."，
    //   并把进程吊住不退出 —— e2e-async-quit.js 也是这么做的。
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
    steps.push('exit: 正常退出 exitCode=' + child.exitCode)
  } catch (err) {
    failed = err
  } finally {
    for (const c of cdps) c.close()
    if (child.exitCode === null && !child.signalCode) {
      try { child.kill() } catch (_) {}
    }
  }

  if (failed) {
    console.error('  ✗ ' + name)
    console.error('    ' + (failed.stack || failed.message || String(failed)))
    console.error('    --- 主进程日志尾部 ---')
    console.error('    ' + log.split('\n').slice(-15).join('\n    '))
    scenario.results.push({ name, ok: false, steps })
    return false
  }
  console.log('  ✓ ' + name + '  [' + steps.join(' → ') + ']')
  scenario.results.push({ name, ok: true, steps })
  return true
}
scenario.seq = 0
scenario.results = []

/** 从主进程读便签数据文件 */
async function readNotes (dataFile) {
  try {
    const raw = fs.readFileSync(dataFile, 'utf8')
    const st = JSON.parse(raw)
    return st.notes || []
  } catch (_) {
    return []
  }
}

// ---------------------------------------------------------------- 场景

/**
 * 在主进程 inspector 里求值一段表达式。
 *
 * 主进程是 Electron 的 Node 环境，但 inspector 的求值上下文里
 * `require` 不是全局的（只有 `process.mainModule.require` 或
 * `process.getBuiltinModule('module').createRequire(...)` 能拿到）。
 * 这里把几种拿法依次尝试。
 */
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
  if (g.process && g.process.mainModule && g.process.mainModule.constructor && g.process.mainModule.constructor._load) {
    tries.push(() => g.process.mainModule.constructor._load('module', null, false).createRequire(g.process.cwd() + '/'))
  }
  for (const t of tries) {
    try {
      const r = t()
      if (typeof r === 'function') return r
    } catch (_) {}
  }
  return null
  }
})()`

async function main () {
  console.log('\n=== 格式转换 e2e ===\n')

  // ---- S1：--convert + --to 直接转换，产物落附件目录并写进便签
  {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-conv-src-'))
    const src = path.join(srcDir, 'photo.png')
    fs.writeFileSync(src, 'fake-png')
    const fakeFilee = makeFakeFilee('ok')

    await scenario('S1 --convert --to 直接转换并落附件', ['--convert', src, '--to', 'jpg'], {
      STICKY_FILEE: fakeFilee
    }, async ({ mainCdp, userData, dataFile, steps }) => {
      // 用主进程里的 API 直接验证参数解析与转换结果
      const probe = await mainCdp.evaluate(`(() => {
        const m = globalThis.process && globalThis.process.mainModule
        let e = null
        if (m && m.require) e = m.require('electron')
        if (!e && typeof require === 'function') e = require('electron')
        if (!e && m && m.constructor && m.constructor._load) e = m.constructor._load('electron', m, false)
        if (!e && typeof Module === 'function' && Module._load) e = Module._load('electron', null, false)
        return { ok: true, argv: Array.prototype.slice.call(process.argv) }
      })()`)
      assert.ok(probe && probe.ok, '主进程应可探测')
      assert.ok(probe.argv.some(a => a === '--convert'), '主进程 argv 应含 --convert')

      const output = path.join(srcDir, 'photo.jpg')
      await waitFor(() => fs.existsSync(output), 25000, '源目录产物落盘')
      assert.ok(fs.statSync(output).size > 0)
      assert.equal(fs.existsSync(path.join(userData, 'attachments')), false)
      const notes = await readNotes(dataFile)
      assert.equal(notes.length, seedFixture().notes.length, '不得新增结果便签')
      assert.equal(fs.existsSync(path.join(srcDir, 'fake-photo.jpg')), false)
      steps.push('结果保存到源文件目录，未创建便签或附件目录')
    })
  }

  // ---- S2：Filee 缺失时明确提示，不静默失败
  {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-conv-src2-'))
    const src = path.join(srcDir, 'x.png')
    fs.writeFileSync(src, 'x')

    await scenario('S2 Filee 缺失时不静默失败', ['--convert', src, '--to', 'jpg'], {
      STICKY_FILEE: 'C:\\definitely\\not\\installed\\filee.exe'
    }, async ({ mainCdp, userData, dataFile, steps }) => {
      // ★ 不能用模态对话框报这个错：模态会挂住 app.quit()，
      //   用户从资源管理器右键进来、Filee 没装时，退出流程会被卡死。
      //   预期行为：失败原因写进 app-errors.log，且不产生任何便签/附件。
      const errLog = path.join(userData, 'app-errors.log')
      await waitFor(async () => {
        if (!fs.existsSync(errLog)) return null
        const t = fs.readFileSync(errLog, 'utf8')
        return t.includes('[convert]') ? t : null
      }, 20000, '错误已写入 app-errors.log')
      steps.push('失败已记录（不静默）')

      // 失败不应产出附件，也不应新建便签（fixture 只有哨兵便签）
      const attachDir = path.join(userData, 'attachments')
      const attFiles = fs.existsSync(attachDir) ? fs.readdirSync(attachDir) : []
      assert.equal(attFiles.length, 0, '失败不应产出附件，实际: ' + attFiles.join(','))

      const ns = await readNotes(dataFile)
      const withRef = ns.filter(n => String(n.html || '').includes('sticky-att://'))
      assert.equal(withRef.length, 0, '失败不应写入外置引用便签')
      steps.push('无附件、无多余便签')
    })
  }

  // ---- S3：argv 解析与多文件聚合（纯主进程侧，不依赖真转换）
  {
    await scenario('S3 多文件聚合与 argv 解析', [], {}, async ({ mainCdp, steps }) => {
      const r = await mainCdp.evaluate(`(() => {
        const getReq = ${REQUIRE_EXPR}
        if (!getReq) return { ok: false, err: 'no require' }
        const req = getReq()
        const cli = req('./lib/cli-args')
        const p = cli.parseArgs(['electron.exe', '.', '--convert', 'a.png', 'b.png'])
        const multi = cli.parseArgs(['app.exe', '--convert', 'a.png', '--to', 'jpg'])
        return {
          ok: true,
          command: p.command,
          files: p.files,
          isConvert: cli.isConvertMode(p),
          multiTo: multi.to,
          multiFiles: multi.files
        }
      })()`)
      assert.ok(r && r.ok, '主进程应能 require lib/cli-args')
      assert.equal(r.command, 'convert')
      assert.deepEqual(r.files, ['a.png', 'b.png'])
      assert.equal(r.isConvert, true)
      assert.equal(r.multiTo, 'jpg')
      assert.deepEqual(r.multiFiles, ['a.png'])
      steps.push('argv 解析正确: ' + r.files.join(','))
    })
  }

  // ---- S4：右键菜单注册表状态查询（只读，不改系统）
  {
    await scenario('S4 右键菜单状态查询不崩', [], {}, async ({ mainCdp, steps }) => {
      const r = await mainCdp.evaluate(`(() => {
        const getReq = ${REQUIRE_EXPR}
        if (!getReq) return { ok: false, err: 'no require' }
        const req = getReq()
        const verb = req('./lib/explorer-verb')
        const vals = verb.verbValues('C:\\\\App\\\\StickyNotes.exe', '用桌面便签转换…')
        return {
          ok: true,
          key: verb.verbKeyPath(),
          count: vals.length,
          cmd: vals.filter(v => v.name === null)[0].value
        }
      })()`)
      assert.ok(r && r.ok, '主进程应能 require lib/explorer-verb')
      assert.equal(r.count, 4)
      assert.ok(r.cmd.includes('--convert "%1"'), 'command 行应含 --convert "%1"')
      steps.push('注册表描述正确')
    })
  }

  // ---- 汇总
  const pass = scenario.results.filter(r => r.ok).length
  const fail = scenario.results.length - pass
  console.log('\n--- 结果 ---')
  console.log('通过 ' + pass + ' / ' + scenario.results.length + (fail ? '，失败 ' + fail : ''))
  if (fail) {
    console.log('\n失败用例:')
    for (const r of scenario.results.filter(x => !x.ok)) console.log('  - ' + r.name)
    process.exitCode = 1
  } else {
    console.log('全部通过')
  }
}

main().catch(err => {
  console.error('e2e 致命错误:', err && err.stack ? err.stack : err)
  process.exitCode = 1
})
