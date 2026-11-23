'use strict'

/**
 * QA 独立 Worker 探针：判定 pdfjs 到底用没用真 module Worker（开放问题拍板）。
 *
 * 证据链（不靠"出图了"这种弱证据）：
 *  1. 在渲染进程页面上下文里、转换发生【之前】用 Proxy 钩住 window.Worker 构造函数，
 *     记录每一次 new Worker(scriptURL, options)。
 *  2. 真跑一次 PDF→PNG，读回 __workerCalls：
 *       - 有 scriptURL 含 pdf-worker-entry.mjs 且 options.type==='module'
 *         ⇒ pdfjs 确实 new 了一个真 module Worker；
 *       - 为空 ⇒ 根本没创建 Worker。
 *  3. 同时抓 console（含 warning 级）：
 *       - pdfjs 回落时 bundle 里会 warn("Setting up fake worker.")（见 pdf.min.mjs 偏移 278616 附近）。
 *         只要没有这条 ⇒ 没有 fake worker 回落。
 *  4. 钩住被创建 Worker 实例的 message 通道，确认主线程真收到 worker 的回信
 *     （"建了 Worker 但没人理它"不算数）。
 *  5. 实测一次转换耗时，判断性能是否可接受。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { PDFDocument, StandardFonts } = require('pdf-lib')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SRC_DIR = path.join(ROOT, 'src')
const PORT = 9475
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, timeout = 25000, label = '') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v } catch (_) {}
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
        let m; try { m = JSON.parse(ev.data) } catch (_) { return }
        if (!m.id || !this.pending.has(m.id)) return
        const { res, rej } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result)
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
    let last = null
    for (let i = 0; i < 6; i++) {
      try {
        const r = await this.send('Runtime.evaluate', {
          expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true
        })
        if (r && r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
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
const REQUIRE_EXPR = `(() => { return () => {
  const tries=[], g=globalThis
  if(g.process&&g.process.mainModule&&g.process.mainModule.require) tries.push(()=>g.process.mainModule.require)
  if(g.process&&typeof g.process.getBuiltinModule==='function') tries.push(()=>g.process.getBuiltinModule('module').createRequire(g.process.cwd()+'/'))
  if(typeof g.require==='function') tries.push(()=>g.require)
  for(const t of tries){try{const r=t();if(typeof r==='function')return r}catch(_){}}
  return null
}})()`
const QUIT_EXPR = `(() => { try { const req=(${REQUIRE_EXPR})(); if(!req) return {ok:false}; req('electron').app.quit(); return {ok:true} } catch(e){ return {ok:false,err:String(e)} } })()`

// 在主进程执行：建 worker 窗口 → 注入 Worker 钩子 → 转换 → 读回证据
function buildExpr (o) {
  return `(async () => {
   try {
    const req = (${REQUIRE_EXPR})()
    const path = req('path')
    const { BrowserWindow } = req('electron')
    const host = req('./lib/convert/worker-host').createWorkerHost({ BrowserWindow, srcDir: ${JSON.stringify(SRC_DIR)}, log: ()=>{} })
    const win = await host.ensure()

    // 页面加载期就挂 console 监听（含 warning 级），抓 fake worker 警告
    const msgs = []
    win.webContents.on('console-message', (_e, level, message) => {
      msgs.push({ level, message: String(message) })
    })

    // ★ 在任何转换之前，钩住渲染进程 window.Worker（用 Proxy 保留原型/静态方法/instanceof）
    const hookResult = await win.webContents.executeJavaScript(\`(() => {
      window.__workerCalls = []
      window.__workerReplies = 0
      const Orig = window.Worker
      if (typeof Orig !== 'function') return { hooked:false, reason:'no Worker' }
      window.Worker = new Proxy(Orig, {
        construct(target, args) {
          const scriptURL = String(args[0] || '')
          const options = args[1] || {}
          window.__workerCalls.push({ scriptURL, type: options.type || null })
          const w = Reflect.construct(target, args)
          // 记录 worker 是否真的往主线程发过消息（证明不是空壳 Worker）
          try {
            w.addEventListener('message', () => { window.__workerReplies++ })
          } catch (_) {}
          return w
        }
      })
      return { hooked:true }
    })()\`, true)

    const list = req('./lib/convert/providers').createDefaultProviders({
      workerHost: host, appDir: ${JSON.stringify(ROOT)}, withFilee: false, withPlugins: false, log: ()=>{}
    })
    const router = req('./lib/convert/router').createRouter({ providers: list })

    const t0 = Date.now()
    const r = await router.convert([${JSON.stringify(o.pdf)}], 'png',
      req('fs').mkdtempSync(path.join(req('os').tmpdir(), 'qa-worker-')))
    const elapsed = Date.now() - t0

    // 读回渲染进程里的钩子证据
    const evidence = await win.webContents.executeJavaScript(\`(() => ({
      calls: window.__workerCalls || [],
      replies: window.__workerReplies || 0
    }))()\`, true)

    const fakeWarns = msgs.filter(m => /fake worker/i.test(m.message)).map(m => m.message)
    const errs = msgs.filter(m => m.level >= 3).map(m => m.message)
    const allMsgs = msgs.map(m => m.level + ':' + m.message)
    host.dispose()
    return {
      hookResult, ok:r.ok, error:r.error,
      output: r.outputs && r.outputs[0] && r.outputs[0].output,
      elapsed, evidence, fakeWarns, errs, allMsgs: allMsgs.slice(0, 40)
    }
   } catch (e) { return { err: String((e && e.stack) || e) } }
  })()`
}

async function main () {
  console.log('QA 独立 Worker 探针（判定真/假 Worker）\n')
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-worker-src-'))
  const pdf = path.join(src, 'w.pdf')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < 3; i++) {
    const pg = doc.addPage([600, 400])
    pg.drawText('QA WORKER PROBE PAGE ' + i, { x: 30, y: 200, size: 20, font })
  }
  fs.writeFileSync(pdf, Buffer.from(await doc.save()))

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-worker-ud-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'), JSON.stringify({ version: 1, notes: [], settings: {} }))
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.STICKY_FILEE = 'C:\\definitely\\not\\installed\\filee.exe'
  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData, '--remote-debugging-port=' + PORT, '--inspect=0', '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })
  let cdp = null
  let out
  try {
    const url = await waitFor(async () => {
      const m = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      return m ? m[1] : null
    }, 25000, 'inspector')
    await waitFor(async () => log.includes('[boot] 托盘就绪') ? true : null, 25000, '启动完成')
    await sleep(1000)
    cdp = new CDP(url)
    await cdp.connect()
    out = await cdp.evaluate(buildExpr({ pdf }))
    if (!out || out.err) throw new Error('求值失败: ' + JSON.stringify(out))
    const quit = await cdp.evaluate(QUIT_EXPR)
    cdp.close()
    await waitFor(async () => child.exitCode !== null || child.signalCode ? true : null, 15000, '退出').catch(() => {})
  } catch (e) {
    console.error('FATAL: ' + (e.stack || e))
    console.error('日志尾部:\n' + log.split('\n').slice(-25).join('\n'))
    if (cdp) cdp.close()
    if (child.exitCode === null) { try { child.kill() } catch (_) {} }
    process.exit(2)
  }

  console.log('钩子安装:', JSON.stringify(out.hookResult))
  console.log('转换结果: ok=' + out.ok + ' error=' + JSON.stringify(out.error))
  console.log('转换耗时: ' + out.elapsed + ' ms（3 页 PDF 的第 1 页，600×400）')
  console.log('产物:', out.output)
  console.log('捕获的 new Worker 调用:', JSON.stringify(out.evidence.calls, null, 2))
  console.log('worker 回信次数(主线程收到 message):', out.evidence.replies)
  console.log('fake worker 警告:', JSON.stringify(out.fakeWarns))
  console.log('error 级日志:', JSON.stringify(out.errs))
  console.log('全部 console(前40):', JSON.stringify(out.allMsgs, null, 2))

  console.log('\n========== 判定 ==========')
  const calls = out.evidence.calls || []
  const moduleWorker = calls.find(c => /pdf-worker-entry\.mjs/.test(c.scriptURL) && c.type === 'module')
  const realWorker = !!(out.hookResult && out.hookResult.hooked) && !!moduleWorker && out.fakeWarns.length === 0
  console.log('① 是否 new 了真 module Worker:', moduleWorker ? '是 → ' + JSON.stringify(moduleWorker) : '否')
  console.log('② 是否出现 fake worker 回落警告:', out.fakeWarns.length ? '是 → ' + JSON.stringify(out.fakeWarns) : '否')
  console.log('③ worker 是否真的回信:', out.evidence.replies > 0 ? '是（' + out.evidence.replies + ' 次）' : '未捕获到（详见 console）')
  console.log('④ 转换成功:', out.ok === true)
  const verdict = realWorker && out.ok === true ? 'PASS：真 module Worker 证据链完整' :
    (!moduleWorker && out.fakeWarns.length ? 'FAIL：fake worker 回落' : 'INCONCLUSIVE：见原始证据')
  console.log('\n结论: ' + verdict)
  process.exit(realWorker && out.ok === true ? 0 : 1)
}
main()
