'use strict'

/**
 * SVG 示例插件 端到端回归（npm run test:e2e:convert:svg）。
 *
 * 验的是**真实链路**：真 Electron + 真隐藏渲染窗口 + 真 canvas。
 *   把 examples/convert-plugins/svg.js 投放进 <userData>/convert-plugins/ ⇒
 *   框架自动发现 ⇒ 能力查询里出现 svg → png ⇒ 真的光栅化出真 PNG。
 *
 * ★ 为什么单测不够：单测里的 workerHost 是假的，它只能证明"编排逻辑对"。
 *   SVG 光栅化真正的坑全在 Chromium 那一侧（createImageBitmap 对 SVG 不可靠、
 *   无 width/height 时 naturalWidth 报 300×150、Blob URL 生命周期…），
 *   这些**只有真跑一遍才能确认**。
 *
 * 场景：
 *   1. 插件被自动发现，能力合并出 svg → png/jpg/webp
 *   2. 有 width/height 的 SVG 转出**真 PNG**（校验魔数，防假成功）
 *   3. 只有 viewBox 的 SVG 也能转（viewBox 兜底 + 尺寸正确）
 *   4. 完全没有尺寸信息的 SVG 必须**明确失败**且不产物
 *   5. 内置图片引擎不受影响（png → jpg 仍然可用）
 *   6. <foreignObject>（会污染画布）必须明确失败且零产物（硬断言）
 *   7. 超大 viewBox 被尺寸上限拦住并等比缩放
 *   8. 只写单边 width 的 SVG 也能转（S1）
 *   9. 同批同名源文件不互相覆盖（M1）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SRC_DIR = path.join(ROOT, 'src')
const PLUGIN_SRC = path.join(ROOT, 'examples', 'convert-plugins', 'svg.js')
const BASE_CDP_PORT = 9451

/** PNG 魔数：89 50 4E 47 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]
/** JPEG 魔数：FF D8 FF */
const JPEG_MAGIC = [0xff, 0xd8, 0xff]

/** 场景用 SVG 源 */
const SVG_WITH_SIZE = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
  '<rect width="64" height="64" fill="#cc2222"/></svg>'
const SVG_VIEWBOX_ONLY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 32">' +
  '<rect width="48" height="32" fill="#2244cc"/></svg>'
const SVG_NO_SIZE = '<svg xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="10" height="10" fill="#44cc22"/></svg>'
// S3：合法但**完全没有可见内容**的 SVG —— 转出全透明 PNG 是正确的，
// 但必须带警告，否则用户拿到空白图还以为成功了
const SVG_BLANK = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>'
// <foreignObject> 里是 XHTML，实测会把 canvas 污染 ⇒ 编码时必然失败。
// 这条用例锁定的是「宁可明确报错，也不产出一张空图/假文件」。
const SVG_FOREIGNOBJECT = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">' +
  '<foreignObject width="40" height="20">' +
  '<div xmlns="http://www.w3.org/1999/xhtml" style="background:#0ff;width:40px;height:20px">x</div>' +
  '</foreignObject></svg>'
// 只写单边 width（没有 height、没有 viewBox）：浏览器补成 300×150，我们也该给出 300×150
const SVG_WIDTH_ONLY = '<svg xmlns="http://www.w3.org/2000/svg" width="300">' +
  '<rect width="300" height="150" fill="#cc2222"/></svg>'
// 同批同名文件（M1）：尺寸故意不同，方便从产物 IHDR 反查内容对不对
const SVG_SAME_A = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
  '<rect width="10" height="10" fill="#f00"/></svg>'
const SVG_SAME_B = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
  '<rect width="20" height="20" fill="#00f"/></svg>'
// 百分比尺寸 + viewBox（Figma/Illustrator 导出图标的常见写法）：
// 没有绝对尺寸 ⇒ 必须用 viewBox 的 24×24，不能用浏览器按默认盒推出来的 150×150
const SVG_PERCENT_VIEWBOX = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" ' +
  'viewBox="0 0 24 24"><rect width="24" height="24" fill="#0a0"/></svg>'

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
      throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
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
  console.log('SVG 矢量转换（示例插件）e2e')
  const cdpPort = BASE_CDP_PORT
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-svg-'))
  fs.writeFileSync(path.join(userData, 'sticky-notes.json'), JSON.stringify({ version: 1, notes: [], settings: {} }))

  // ★ 关键：只做"投放"这一个动作 —— 不改任何核心代码，插件应该生效
  const pluginDir = path.join(userData, 'convert-plugins')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.copyFileSync(PLUGIN_SRC, path.join(pluginDir, 'svg.js'))

  const env = Object.assign({}, process.env)
  // 宿主有 ELECTRON_RUN_AS_NODE=1，会让我们 spawn 出来的 electron 变成纯 node
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

    // 用与 main.js 完全相同的装配方式（含插件加载），只是把 workerHost 显式建出来
    const expr = `(async () => {
      const getReq = ${REQUIRE_EXPR}
      const req = getReq()
      if (!req) return { ok: false, err: 'no require' }
      const fs = req('fs')
      const os = req('os')
      const path = req('path')
      const { BrowserWindow } = req('electron')
      const workerHostLib = req('./lib/convert/worker-host')
      const providersLib = req('./lib/convert/providers')
      const routerLib = req('./lib/convert/router')

      // ★ 在**创建 worker 窗口之前**挂监听：
      //   worker 页面脚本是在加载时执行的，晚于 ensure() 再挂就抓不到加载期的报错
      //   （上一轮那个 window.sticky.workerCodecs 的 TypeError 就是这么被漏掉的）。
      const consoleMsgs = []
      req('electron').app.on('web-contents-created', (_e, wc) => {
        try {
          wc.on('console-message', (_ev, level, message) => {
            consoleMsgs.push({ level, message: String(message) })
          })
        } catch (_) {}
      })

      const host = workerHostLib.createWorkerHost({
        BrowserWindow,
        srcDir: ${JSON.stringify(SRC_DIR)},
        log: () => {}
      })

      // 拿真实的 worker 窗口做一次自检：验证"IPC 注册块确实执行到了最后一行"
      // （contextBridge 暴露的 window.sticky 是冻结对象，任何赋值都会抛 TypeError，
      //   所以自检信息只能挂在 globalThis 上）
      let workerProbe = null
      let workerWin = null
      try {
        workerWin = await host.ensure()
        workerProbe = await workerWin.webContents.executeJavaScript(\`(() => ({
          frozenSticky: Object.isFrozen(window.sticky),
          hasRenderChannel: typeof window.sticky.onWorkerRenderSvg === 'function',
          hasDecodeChannel: typeof window.sticky.onWorkerDecode === 'function',
          hasEncodeChannel: typeof window.sticky.onWorkerEncode === 'function',
          codecs: globalThis.__convertWorkerCodecs || null,
          // CSP 必须真的在页面上：img-src 少了 blob: 会让所有 SVG 转换静默失败
          hasCsp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
          cspHasBlob: /blob:/.test((document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '')
        }))()\`, true)
      } catch (e) {
        workerProbe = { err: String((e && e.message) || e) }
      }

      const list = providersLib.createDefaultProviders({
        workerHost: host,
        appDir: ${JSON.stringify(ROOT)},
        userDataDir: ${JSON.stringify(userData)},
        withFilee: false,
        log: () => {}
      })
      const router = routerLib.createRouter({ providers: list })

      const engines = await router.engines()
      const capsSvg = await router.capabilities('svg')
      const capsPng = await router.capabilities('png')

      const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-svgsrc-'))
      const writeSvg = (name, text) => {
        const p = path.join(srcRoot, name)
        fs.writeFileSync(p, text, 'utf8')
        return p
      }
      const mkOut = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-svgout-'))
      const head = (p, n) => Array.from(fs.readFileSync(p).slice(0, n))
      // PNG 的 IHDR 就在固定偏移：宽 = 16..19，高 = 20..23（大端）
      const pngDims = (p) => {
        const b = fs.readFileSync(p)
        return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
      }
      const firstOutput = (r) => (r && r.outputs && r.outputs[0] ? r.outputs[0].output : null)

      // ---- 场景 2：有 width/height 的 SVG ----
      const out1 = mkOut()
      const src1 = writeSvg('with-size.svg', ${JSON.stringify(SVG_WITH_SIZE)})
      const conv1 = await router.convert([src1], 'png', out1)
      const file1 = firstOutput(conv1)

      // ---- 场景 3：只有 viewBox ----
      const out2 = mkOut()
      const src2 = writeSvg('viewbox-only.svg', ${JSON.stringify(SVG_VIEWBOX_ONLY)})
      const conv2 = await router.convert([src2], 'png', out2)
      const file2 = firstOutput(conv2)

      // ---- 场景 4：完全没有尺寸信息（负向）----
      const out3 = mkOut()
      const src3 = writeSvg('no-size.svg', ${JSON.stringify(SVG_NO_SIZE)})
      const conv3 = await router.convert([src3], 'png', out3)

      // ---- 场景 5：内置图片引擎回归（png → jpg）----
      const out4 = mkOut()
      const conv4 = file1 ? await router.convert([file1], 'jpg', out4) : { ok: false, error: '没有 PNG 源可用' }
      const file4 = firstOutput(conv4)

      // ---- 场景 6：<foreignObject>（画布会被污染）不能产出假文件 ----
      const out5 = mkOut()
      const src5 = writeSvg('foreign-object.svg', ${JSON.stringify(SVG_FOREIGNOBJECT)})
      const conv5 = await router.convert([src5], 'png', out5)
      const file5 = firstOutput(conv5)

      // ---- 场景 7：超大 viewBox 必须被尺寸上限拦住 ----
      // 直接调 workerHost（插件不透传 opts）。这里传 maxSide: 256，
      // 既验证了上限机制，又不至于让测试自己吃掉一张 8192×4096 的画布。
      const huge = await host.renderSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000 50000">' +
        '<rect width="100000" height="50000" fill="#000"/></svg>',
        { maxSide: 256 })
      const hugeEnc = huge && huge.ok ? await host.encode(huge.canvasId, 'image/png') : null

      // ---- 场景 8：只写单边 width（S1）----
      const out6 = mkOut()
      const src6 = writeSvg('width-only.svg', ${JSON.stringify(SVG_WIDTH_ONLY)})
      const conv6 = await router.convert([src6], 'png', out6)
      const file6 = firstOutput(conv6)

      // ---- 场景 9：同批同名源文件不能互相覆盖（M1）----
      // 两个目录下的同名 same.svg，尺寸不同 ⇒ 必须产出两个不同路径、尺寸各自正确
      const dirA = path.join(srcRoot, 'a')
      const dirB = path.join(srcRoot, 'b')
      fs.mkdirSync(dirA, { recursive: true })
      fs.mkdirSync(dirB, { recursive: true })
      const sameA = path.join(dirA, 'same.svg')
      const sameB = path.join(dirB, 'same.svg')
      fs.writeFileSync(sameA, ${JSON.stringify(SVG_SAME_A)}, 'utf8')
      fs.writeFileSync(sameB, ${JSON.stringify(SVG_SAME_B)}, 'utf8')
      const out7 = mkOut()
      const conv7 = await router.convert([sameA, sameB], 'png', out7)
      const outs7 = (conv7.outputs || []).map(o => ({
        output: o.output,
        name: path.basename(o.output),
        dims: fs.existsSync(o.output) ? pngDims(o.output) : null
      }))

      // ---- 场景 10：百分比 + viewBox（S1 回归）----
      // 这是 Figma/Illustrator 导出图标的高频写法：尺寸没有绝对值，
      // 必须用 viewBox（24×24），绝不能被浏览器给 % 算出的默认盒（150×150）带偏。
      const out8 = mkOut()
      const src8 = writeSvg('percent-viewbox.svg', ${JSON.stringify(SVG_PERCENT_VIEWBOX)})
      const conv8 = await router.convert([src8], 'png', out8)
      const file8 = firstOutput(conv8)

      // ---- 场景 11：S3 —— 全透明产物必须带警告（软性假成功）----
      // 空 SVG 转出全透明 PNG 是"正确"的，但 ok:true 而用户毫不知情就是假成功。
      // 这里走真 worker + 真 canvas + 真插件 + 真 service，验警告一路透传。
      const serviceLib = req('./lib/convert/service')
      const bridgeLib = req('./lib/convert/main-bridge')
      const s3UserData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-s3-'))
      const s3Service = serviceLib.createService({
        // 附件落独立目录，避免污染其它场景
        userDataDir: s3UserData,
        providers: providersLib.createDefaultProviders({
          workerHost: host,
          appDir: ${JSON.stringify(ROOT)},
          // ★ 插件必须从这个 userData 加载 —— 前面把 svg.js 投放在这里了。
          //   若误用 s3UserData（空目录），插件发现不到 ⇒ "没有引擎支持 svg → png"。
          userDataDir: ${JSON.stringify(userData)},
          withFilee: false,
          log: () => {}
        })
      })
      const src9 = writeSvg('blank.svg', ${JSON.stringify(SVG_BLANK)})
      const conv9 = await s3Service.convert([src9], 'png')
      const att9 = (conv9.attachments || [])[0] || {}
      const s9 = {
        ok: conv9.ok,
        reason: conv9.reason,
        error: conv9.error,
        failures: (conv9.failures || []).map(f => f.error || String(f)),
        attCount: (conv9.attachments || []).length,
        attWarnings: att9.warnings || [],
        collected: bridgeLib.collectWarnings(conv9),
        hasFile: !!att9.path && fs.existsSync(att9.path)
      }

      // ---- 检测器自测：证明"console 干净"不是空断言 ----
      // 先数一遍真实的 error 级日志（正常应为 0），再故意制造一条未捕获异常，
      // 确认它**确实**被 console-message 抓到。否则哪天 Electron 不再派发这个事件，
      // 上面那条断言会永远绿着说谎。
      const isErr = (m) => m.level >= 3
      const errsBefore = consoleMsgs.filter(isErr).map(m => m.message)
      let markerCaught = false
      if (workerWin) {
        await workerWin.webContents.executeJavaScript(
          'setTimeout(() => { throw new TypeError("e2e-marker-boom") }, 0); 1', true)
        await new Promise(r => setTimeout(r, 400))
        markerCaught = consoleMsgs.some(m => isErr(m) && /e2e-marker-boom/.test(m.message))
      }

      host.dispose()

      return {
        engines,
        capsSvg,
        capsPng,
        s1: {
          ok: conv1.ok, provider: conv1.provider, error: conv1.error,
          file: file1 ? path.basename(file1) : null,
          exists: file1 ? fs.existsSync(file1) : false,
          magic: file1 ? head(file1, 4) : null,
          dims: file1 ? pngDims(file1) : null,
          size: file1 ? fs.statSync(file1).size : 0
        },
        s2: {
          ok: conv2.ok, provider: conv2.provider, error: conv2.error,
          file: file2 ? path.basename(file2) : null,
          magic: file2 ? head(file2, 4) : null,
          dims: file2 ? pngDims(file2) : null
        },
        s3: {
          ok: conv3.ok, provider: conv3.provider, error: conv3.error,
          failures: (conv3.failures || []).map(f => f.error),
          outCount: fs.readdirSync(out3).length
        },
        s4: {
          ok: conv4.ok, provider: conv4.provider, error: conv4.error,
          file: file4 ? path.basename(file4) : null,
          magic: file4 ? head(file4, 3) : null,
          size: file4 ? fs.statSync(file4).size : 0
        },
        s5: {
          ok: conv5.ok, provider: conv5.provider, error: conv5.error,
          failures: (conv5.failures || []).map(f => f.error),
          file: file5 ? path.basename(file5) : null,
          magic: file5 ? head(file5, 4) : null,
          outCount: fs.readdirSync(out5).length
        },
        s6: {
          ok: !!huge && huge.ok === true,
          width: huge ? huge.width : null,
          height: huge ? huge.height : null,
          scaled: !!(huge && huge.scaled),
          encType: hugeEnc ? hugeEnc.type : null,
          encLen: hugeEnc && hugeEnc.bytes ? hugeEnc.bytes.length : 0,
          error: huge ? huge.error : 'null'
        },
        s7: {
          ok: conv6.ok, provider: conv6.provider, error: conv6.error,
          file: file6 ? path.basename(file6) : null,
          dims: file6 ? pngDims(file6) : null,
          magic: file6 ? head(file6, 4) : null
        },
        s8: {
          ok: conv7.ok, provider: conv7.provider, error: conv7.error,
          outputs: outs7,
          outCount: fs.readdirSync(out7).length,
          distinctPaths: new Set(outs7.map(o => String(o.output).toLowerCase())).size
        },
        s9: {
          ok: conv8.ok, provider: conv8.provider, error: conv8.error,
          file: file8 ? path.basename(file8) : null,
          dims: file8 ? pngDims(file8) : null,
          magic: file8 ? head(file8, 4) : null
        },
        s10warn: s9,
        workerProbe,
        markerCaught,
        // worker 页面加载期 + 全部转换期间的 error 级日志（正常应为空）
        workerConsoleErrors: errsBefore.slice(0, 10),
        // CSP 违规通常是 warning(level 2)，上面的 error 级断言抓不到 ⇒ 单独返回
        cspViolations: consoleMsgs
          .filter(m => /Content Security Policy/i.test(m.message))
          .map(m => m.message)
          .slice(0, 10)
      }
    })()`

    const r = await cdp.evaluate(expr)
    assert.ok(r && !r.err, '求值失败: ' + JSON.stringify(r))

    const eng = r.engines || []
    const pluginEng = eng.find(e => e.id === 'builtin-vector-svg')

    checks.push(['插件被自动发现（引擎清单里出现 builtin-vector-svg）', !!pluginEng])
    checks.push(['插件引擎状态为可用（有 workerHost）', !!(pluginEng && pluginEng.available === true)])
    checks.push(['能力查询 svg 含 png/jpg/jpeg/webp', ['png', 'jpg', 'jpeg', 'webp']
      .every(t => (r.capsSvg.targets || []).includes(t))])

    checks.push(['有 width/height 的 SVG 转换成功', r.s1.ok === true])
    checks.push(['转换由插件执行（provider = builtin-vector-svg）', r.s1.provider === 'builtin-vector-svg'])
    checks.push(['产物已落盘', r.s1.exists === true])
    checks.push(['产物文件名无 .svg 双扩展名（with-size.png）', r.s1.file === 'with-size.png'])
    checks.push(['产物是真 PNG（魔数 89 50 4E 47）',
      JSON.stringify(r.s1.magic) === JSON.stringify(PNG_MAGIC)])
    checks.push(['PNG 不是空壳（> 100 字节）', r.s1.size > 100])
    checks.push(['PNG 尺寸为 64×64', !!r.s1.dims && r.s1.dims.width === 64 && r.s1.dims.height === 64])

    checks.push(['只有 viewBox 的 SVG 也能转（viewBox 兜底）', r.s2.ok === true])
    checks.push(['viewBox 尺寸被正确套用（48×32）',
      !!r.s2.dims && r.s2.dims.width === 48 && r.s2.dims.height === 32])
    checks.push(['viewBox 兜底产物同样是真 PNG',
      JSON.stringify(r.s2.magic) === JSON.stringify(PNG_MAGIC)])

    checks.push(['无尺寸信息的 SVG 明确失败（不假成功）', r.s3.ok === false])
    checks.push(['失败原因指向尺寸信息缺失', /尺寸|size/i.test(String(r.s3.error || '') + (r.s3.failures || []).join(' '))])
    checks.push(['失败时不产出任何文件', r.s3.outCount === 0])

    checks.push(['内置图片引擎未受影响（png → jpg 可用）', r.s4.ok === true])
    checks.push(['内置引擎产物是真 JPEG',
      JSON.stringify(r.s4.magic) === JSON.stringify(JPEG_MAGIC)])

    // <foreignObject> 必须**明确失败**（硬断言，不再是"失败或真 PNG"的双向）。
    //
    // ★ 为什么敢硬绑：这条失败不是靠 Chromium 碰运气，而是我们自己的双保险 ——
    //   ① src/convert-worker.js 的 renderSvg 在 drawImage 之后主动
    //      `getImageData(1,1)` 探测污染，抛错就 return {ok:false}；
    //   ② 即使 ① 被删掉，真正编码时 toBlob 也会抛 SecurityError，
    //      encodeImage 的 catch 会把它翻成失败（同名 tainted 文案）。
    //   任何一条生效，产物目录都是空的。
    //
    // ★ 原来的双向断言有真窟窿（QA 指出）：一个合法但空的
    //   `<svg width="20" height="20"></svg>` 产出 110B 全透明 PNG，
    //   完全能通过「ok:true && 魔数===PNG」，所以"成功即真 PNG"这一支
    //   根本拦不住"内容被静默丢弃"。既然要防假成功，就只认失败这一种结果。
    //
    // ★ 版本绑定处理：升级 Electron 后若此条变红，先跑探针确认
    //   （renderer 里对含 foreignObject 的 SVG drawImage 后 getImageData / toBlob
    //   是否仍抛 SecurityError），再决定是改用例还是修实现 —— 不要直接把断言放宽。
    const s5Err = String(r.s5.error || '') + ' ' + (r.s5.failures || []).join(' ')
    checks.push(['foreignObject：明确失败（ok:false）', r.s5.ok === false])
    checks.push(['foreignObject：产物目录零文件（不产假文件/空图）', r.s5.outCount === 0])
    checks.push(['foreignObject：失败原因指向安全策略或 foreignObject',
      /foreignObject|安全策略/i.test(s5Err)])

    // 100000×50000 的 viewBox 若照原样分配画布 = 6.4GB，必须被上限拦住
    checks.push(['超大 viewBox 被尺寸上限拦住并等比缩放（256×128，scaled 标记）',
      r.s6.ok === true && r.s6.width === 256 && r.s6.height === 128 && r.s6.scaled === true])
    checks.push(['缩放后仍能正常编码成 PNG',
      r.s6.encType === 'image/png' && r.s6.encLen > 0])

    // S1：只写单边 width 也要能转（真 Chromium 报的 natural 是 300×150）
    checks.push(['只写 width="300"（无 height/viewBox）能转，产物 300×150',
      r.s7.ok === true && !!r.s7.dims && r.s7.dims.width === 300 && r.s7.dims.height === 150])
    checks.push(['单边尺寸用例产物是真 PNG', JSON.stringify(r.s7.magic) === JSON.stringify(PNG_MAGIC)])

    // M1：同批同名源文件必须产出两个不同路径，且各自内容对得上
    const outs8 = r.s8.outputs || []
    checks.push(['M1：同批同名 SVG 产出两个产物（不被覆盖）',
      r.s8.ok === true && outs8.length === 2 && r.s8.outCount === 2])
    checks.push(['M1：两个产物路径互不相同（含大小写归一）', r.s8.distinctPaths === 2])
    checks.push(['M1：第一个产物尺寸 10×10（对应 d1/same.svg）',
      outs8.length === 2 && !!outs8[0].dims && outs8[0].dims.width === 10 && outs8[0].dims.height === 10])
    checks.push(['M1：第二个产物尺寸 20×20（对应 d2/same.svg）',
      outs8.length === 2 && !!outs8[1].dims && outs8[1].dims.width === 20 && outs8[1].dims.height === 20])

    // S1 回归：百分比尺寸必须回落 viewBox（真 Chromium 实测）
    checks.push(['百分比尺寸 + viewBox 的 SVG 产出 24×24（不是默认盒 150×150）',
      r.s9.ok === true && !!r.s9.dims && r.s9.dims.width === 24 && r.s9.dims.height === 24])
    checks.push(['百分比尺寸用例产物是真 PNG', JSON.stringify(r.s9.magic) === JSON.stringify(PNG_MAGIC)])

    // ---- S3：软性假成功必须被提示 ----
    checks.push(['S3：空 SVG 转换仍成功（不把合法输入误判为失败）', r.s10warn.ok === true])
    checks.push(['S3：产物文件确实生成了', r.s10warn.hasFile === true])
    checks.push(['S3：警告透传到 attachments[i].warnings（不只是日志）',
      (r.s10warn.attWarnings || []).some(w => w.code === 'blank')])
    checks.push(['S3：collectWarnings 汇总后仍含 blank（给 UI 的状态栏用）',
      (r.s10warn.collected || []).some(w => w.code === 'blank')])

    // 上一轮 `window.sticky.workerCodecs = ...` 对 contextBridge 的冻结对象赋值，
    // 每次加载都抛 TypeError，而这段"自检"从未生效。现在挂到 globalThis 上。
    const wp = r.workerProbe || {}
    checks.push(['window.sticky 确实是冻结对象（解释了旧写法为何必然抛 TypeError）',
      wp.frozenSticky === true])
    checks.push(['worker 三个 IPC 通道都已注册（decode/encode/render-svg）',
      wp.hasDecodeChannel === true && wp.hasEncodeChannel === true && wp.hasRenderChannel === true])
    checks.push(['worker 自检信息挂在 globalThis 上且含 render:svg（证明注册块执行到了最后一行）',
      !!wp.codecs && Array.isArray(wp.codecs.render) && wp.codecs.render.includes('svg') &&
      Array.isArray(wp.codecs.encode) && wp.codecs.encode.includes('png')])

    // ★ CSP：worker 页面以前是唯一没有 CSP 的页面。
    //   加了之后要确认三件事：meta 真的在、img-src 含 blob:（SVG 走 Blob URL 渲染）、
    //   没有 CSP 违规日志。违规通常是 warning(level 2)，
    //   下面那条"error 级为 0"抓不到它。
    checks.push(['worker 页面有 CSP meta', wp.hasCsp === true])
    checks.push(['worker CSP 含 blob:（否则 SVG 转换全挂）', wp.cspHasBlob === true])
    checks.push(['没有 CSP 违规日志（warning 级也要查）',
      (r.cspViolations || []).length === 0])

    checks.push(['worker 加载期 + 转换期没有任何 error 级日志（console 干净）',
      (r.workerConsoleErrors || []).length === 0])
    // 上一条若因为 Electron 不再派发 console-message 而变成空断言，这条会红
    checks.push(['检测器自测：故意注入的未捕获异常确实被 console-message 捕获',
      r.markerCaught === true])

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
    console.error('  ' + log.split('\n').slice(-15).join('\n  '))
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
