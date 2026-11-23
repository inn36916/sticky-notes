'use strict'

/**
 * 「3 克隆合并为 1 克隆」后的语义与克隆次数 端到端回归
 * （不进 npm test，单独跑：npm run test:e2e:snapshot）。
 *
 * 这一层刻意做成**实现无关**的：不假设工程师把快照函数放在 note.js 还是
 * 新建 lib/dom-snapshot.js，而是直接在真实渲染进程里观察**可观测契约**：
 *   1) 落盘 html：.mmd-body 被清空、.mmd 上没有 data-rendered；
 *   2) 纯文本占位符精确为 ' [图表] ' 与 ' [图片] '（含两侧空格）；
 *   3) 字数统计口径 = plainText().replace(/\[(图表|图片)\]/g,'').replace(/\s/g,'').length；
 *   4) preview 口径 = plainText().slice(0,160)；
 *   5) 180ms 停手路径里的 DOM 克隆次数 ≤ 1（在渲染进程里给
 *      Node.prototype.cloneNode 打点，用真实运行时计数，而不是读源码猜）。
 *
 * 纪律：隔离 --user-data-dir；真实 app.quit() 退出；临时目录放 OS 临时目录。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const BASE_CDP_PORT = 9360

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
        try { msg = JSON.parse(ev.data) } catch (_) {}
        if (!msg || !msg.id || !this.pending.has(msg.id)) return
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

/** 注入到编辑器的 HTML：文字 + 一个「已渲染」的 Mermaid 块 + 一张图片 */
const RICH_HTML = [
  '<p>Hello</p>',
  '<div class="mmd" data-rendered="1" data-code="graph TD; A-->B;" data-blockid="b1">',
  '<div class="mmd-tools"><button>x</button></div>',
  '<div class="mmd-body"><svg viewBox="0 0 10 10"><text>SVGWORD</text></svg></div>',
  '</div>',
  '<p><img src="data:image/png;base64,AAAA"></p>',
  '<p>World</p>'
].join('')

/** 期望的纯文本（按当前口径手工推导，作为黄金基准） */
const EXPECTED_PLAIN = 'Hello [图表] [图片] World'
const EXPECTED_COUNT = EXPECTED_PLAIN.replace(/\[(图表|图片)\]/g, '').replace(/\s/g, '').length

/** 场景 E 用的两个标记 */
const FIRST_MARK = 'E2E-STALE-FIRST'
const SECOND_MARK = 'E2E-STALE-SECOND'

function seedFixture () {
  return {
    version: 2,
    notes: [{
      id: 'e2e-snap-note',
      title: '快照语义便签',
      html: '<p>SEED-MARK</p>',
      preview: 'SEED-MARK',
      color: '#FFF3B0',
      bounds: { x: 320, y: 180, width: 420, height: 520 },
      collapsed: false, collapseEdge: null, edgeCollapse: true,
      visible: true, alwaysOnTop: false, mode: 'edit'
    }].concat(Array.from({ length: 500 }, (_, i) => ({
      id: 'search-old-' + i, title: '旧数据' + i,
      html: '<p>' + '甲'.repeat(200) + '连续中文 Needle &amp; 尾文</p><img src="data:image/png;base64,SECRETIMAGE"><div class="mmd" data-code="SECRETCHART"><div class="mmd-body">SVGWORD</div></div>',
      preview: '甲'.repeat(160), visible: false
    }))),
    ai: { activeId: '', providers: [] },
    settings: { globalSelect: false }
  }
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

let seq = 0

async function runOnce (name, fn, post, searchFixture = false) {
  const cdpPort = BASE_CDP_PORT + (seq++)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-snap-'))
  const dataFile = path.join(userData, 'sticky-notes.json')
  const fixture = typeof searchFixture === 'function' ? searchFixture(seedFixture()) : seedFixture()
  if (!searchFixture) fixture.notes = fixture.notes.slice(0, 1)
  fs.writeFileSync(dataFile, JSON.stringify(fixture, null, 2), 'utf8')

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

    await fn({ editorCdp, mainCdp, dataFile, child, steps, cdpPort, userData })

    const quit = await mainCdp.evaluate(QUIT_EXPR)
    assert.equal(quit && quit.ok, true, 'app.quit() 调用失败: ' + JSON.stringify(quit))
    steps.push('quit: before-quit 已触发（非强杀）')
    mainCdp.close()
    await waitFor(async () => child.exitCode !== null, 12000, '进程自然退出').catch(() => {})
    assert.notEqual(child.exitCode, null, '应用未自然退出')
    steps.push('exit: 自然退出 exitCode = ' + child.exitCode)

    const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    // 退出后的落盘断言必须和运行时断言在同一个 try 里，
    // 否则一次断言失败会中断整个脚本，后面几条用例就再也跑不到。
    if (post) await post(disk, steps)
    return { name, ok: true, steps, disk, logTail: log.slice(-1200) }
  } catch (err) {
    failed = err
    return { name, ok: false, steps, error: err && err.message ? err.message : String(err), logTail: log.slice(-1200) }
  } finally {
    for (const c of cdps) c.close()
    if (child.exitCode === null) child.kill()
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) {}
  }
}

/** 在渲染进程里打点 cloneNode，统计 180ms 停手路径里的 DOM 克隆次数 */
const CLONE_PROBE = `(() => {
  if (!window.__cloneProbe) {
    window.__cloneCount = 0
    window.__cloneSizes = []
    const orig = Node.prototype.cloneNode
    Node.prototype.cloneNode = function (deep) {
      window.__cloneCount++
      try { window.__cloneSizes.push(this.nodeName + (deep ? '(deep)' : '(shallow)')) } catch (_) {}
      return orig.call(this, deep)
    }
    window.__cloneProbe = true
  }
  window.__cloneCount = 0
  window.__cloneSizes = []
  return true
})()`

async function main () {
  const results = []

  results.push(await runOnce('全文搜索：旧便签、上下文、更新删除、500 张热查询', async ({ editorCdp, steps, cdpPort }) => {
    const result = await editorCdp.evaluate(`(async () => {
      const api = window.sticky
      const first = await api.search('连续中文')
      const english = await api.search('nEeDlE')
      const hidden = await api.search('SECRETIMAGE')
      const chart = await api.search('SVGWORD')
      const entity = await api.search('& 尾文')
      const times = []
      for (let i = 0; i < 30; i++) {
        const start = performance.now()
        await api.search('连续中文')
        times.push(performance.now() - start)
      }
      times.sort((a, b) => a - b)
      api.update({ html: '<p>编辑后的目标词</p>', title: '新搜索标题' })
      const edited = await api.search('编辑后的目标词')
      const title = await api.search('新搜索标题')
      await api.action('search-old-0', 'delete')
      const deleted = await api.search('连续中文')
      return { first, english: english.length, hidden, chart, entity: entity.length, p95: times[28], edited, title, deleted: deleted.length }
    })()`)
    assert.equal(result.first.length, 500)
    assert.ok(result.first.every(hit => hit.context.includes('连续中文') && Object.keys(hit).length === 2))
    assert.equal(result.english, 500)
    assert.deepEqual(result.hidden, [])
    assert.deepEqual(result.chart, [])
    assert.equal(result.entity, 500)
    assert.equal(result.edited[0].id, 'e2e-snap-note')
    assert.equal(result.title[0].id, 'e2e-snap-note')
    assert.equal(result.deleted, 499)
    assert.ok(result.p95 < 100, '热查询 P95 超过 100ms: ' + result.p95)
    steps.push('500 张短便签热查询含 IPC P95: ' + result.p95.toFixed(2) + ' ms')
    await editorCdp.evaluate('window.sticky.openDashboard()')
    const target = await waitFor(async () => {
      const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
      return list.find(t => /dashboard\.html/.test(t.url))
    }, 10000, '便签中心')
    const dashboard = new CDP(target.webSocketDebuggerUrl)
    await dashboard.connect()
    try {
      await waitFor(() => dashboard.evaluate('document.querySelectorAll(".card").length === 500'), 10000, '便签中心列表')
      await dashboard.evaluate(`(() => { const input = document.querySelector('#search'); input.value = '连续中文'; input.dispatchEvent(new Event('input')); })()`)
      await waitFor(() => dashboard.evaluate('document.querySelectorAll(".card").length === 499 && document.querySelector(".preview").textContent.includes("连续中文")'), 10000, '全文搜索上下文显示')
      steps.push('便签中心正常搜索入口：160 字后命中并显示上下文')
    } finally { dashboard.close() }
  }, null, true))

  // ---- 场景 A：快照语义（html / 占位符 / 字数 / preview）
  results.push(await runOnce('A 快照语义：html 清理 + 占位符 + 字数 + preview', async ({ editorCdp, steps }) => {
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = ${JSON.stringify(RICH_HTML)}
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    // 等 180ms 防抖 + 350ms 落盘链路走完
    const saved = await waitFor(async () => {
      const t = await editorCdp.evaluate("document.querySelector('#saved').textContent")
      return t && t.indexOf('已保存') === 0 ? t : null
    }, 10000, '渲染层显示「已保存」')
    steps.push('saved: ' + saved)

    const ui = await editorCdp.evaluate(`(() => ({
      stats: document.querySelector('#stats').textContent
    }))()`)
    steps.push('ui: stats = ' + JSON.stringify(ui.stats))

    // 字数统计口径
    assert.equal(ui.stats, EXPECTED_COUNT + ' 字 · 1 图 · 1 图表',
      '字数/图表统计口径变了: 期望 "' + (EXPECTED_COUNT + ' 字 · 1 图 · 1 图表') + '"，实际 "' + ui.stats + '"')
    steps.push('PASS: 字数统计口径不变 = ' + EXPECTED_COUNT + ' 字')
  }, async (disk, steps) => {
    const html = String((disk.notes[0] || {}).html || '')
    // html 落盘：.mmd-body 清空、无 data-rendered、SVG 不落盘
    assert.ok(html.indexOf('data-rendered') === -1, '落盘 html 仍带 data-rendered: ' + html)
    assert.ok(html.indexOf('SVGWORD') === -1, '落盘 html 仍带 SVG 渲染产物: ' + html)
    assert.ok(/class="mmd-body"\s*>\s*<\/div>/.test(html), '.mmd-body 未被清空: ' + html)
    // preview 口径：plainText().slice(0,160)
    assert.equal((disk.notes[0] || {}).preview, EXPECTED_PLAIN,
      'preview 口径变了：期望 "' + EXPECTED_PLAIN + '"，实际 "' + (disk.notes[0] || {}).preview + '"')
    steps.push('PASS: 落盘 html 已清 .mmd-body / 去 data-rendered')
    steps.push('PASS: preview 占位符口径 = ' + JSON.stringify(EXPECTED_PLAIN))
  }))

  // ---- 场景 B：180ms 停手路径里的 DOM 克隆次数必须 ≤ 1
  results.push(await runOnce('B 180ms 停手路径 DOM 克隆次数 ≤ 1', async ({ editorCdp, steps }) => {
    await editorCdp.evaluate(CLONE_PROBE)
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = ${JSON.stringify(RICH_HTML)}
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const saved = await waitFor(async () => {
      const t = await editorCdp.evaluate("document.querySelector('#saved').textContent")
      return t && t.indexOf('已保存') === 0 ? t : null
    }, 10000, '渲染层显示「已保存」')
    steps.push('saved: ' + saved)

    const ui = await editorCdp.evaluate(`(() => ({
      cloneCount: window.__cloneCount,
      cloneSizes: window.__cloneSizes
    }))()`)
    steps.push('cloneNode 次数 = ' + ui.cloneCount)
    steps.push('clone 明细: ' + JSON.stringify(ui.cloneSizes))

    assert.ok(ui.cloneCount <= 1,
      '180ms 停手路径里的 DOM 克隆次数 = ' + ui.cloneCount + '（要求 ≤ 1）: ' + JSON.stringify(ui.cloneSizes))
    steps.push('PASS: 停手路径克隆次数 ≤ 1')
  }))

  // ---- 场景 C：preview 前 160 字截断
  const LONG_TEXT = 'ABCDEFGHIJ'.repeat(40)   // 400 字符
  results.push(await runOnce('C preview 前 160 字截断口径', async ({ editorCdp, steps }) => {
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = '<p>' + ${JSON.stringify(LONG_TEXT)} + '</p>'
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const saved = await waitFor(async () => {
      const t = await editorCdp.evaluate("document.querySelector('#saved').textContent")
      return t && t.indexOf('已保存') === 0 ? t : null
    }, 10000, '渲染层显示「已保存」')
    steps.push('saved: ' + saved)
  }, async (disk, steps) => {
    const preview = String((disk.notes[0] || {}).preview || '')
    assert.equal(preview.length, 160, 'preview 长度 = ' + preview.length + '（期望 160）: ' + preview)
    assert.equal(preview, LONG_TEXT.slice(0, 160), 'preview 内容不是前 160 字')
    steps.push('PASS: preview 恰为前 160 字')
  }))

  // ---- 场景 D：占位符精确性（前后空格）
  results.push(await runOnce('D 占位符精确为 " [图表] " / " [图片] "', async ({ editorCdp, steps }) => {
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = ${JSON.stringify(RICH_HTML)}
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const saved = await waitFor(async () => {
      const t = await editorCdp.evaluate("document.querySelector('#saved').textContent")
      return t && t.indexOf('已保存') === 0 ? t : null
    }, 10000, '渲染层显示「已保存」')
    steps.push('saved: ' + saved)
  }, async (disk, steps) => {
    const preview = String((disk.notes[0] || {}).preview || '')
    // 占位符精确为 ' [图表] ' / ' [图片] '：括号内不含空格，且紧邻的前后各有一个空格
    assert.ok(preview.indexOf(' [图表] ') >= 0, '缺少精确占位符 " [图表] "（两侧空格）: ' + JSON.stringify(preview))
    assert.ok(preview.indexOf(' [图片] ') >= 0, '缺少精确占位符 " [图片] "（两侧空格）: ' + JSON.stringify(preview))
    for (const token of ['[图表]', '[图片]']) {
      let idx = preview.indexOf(token)
      let seen = 0
      while (idx >= 0) {
        seen++
        const before = idx === 0 ? '' : preview[idx - 1]
        const after = preview[idx + token.length] || ''
        assert.equal(before, ' ', '占位符 ' + token + ' 前缺空格: ' + JSON.stringify(preview))
        assert.equal(after, ' ', '占位符 ' + token + ' 后缺空格: ' + JSON.stringify(preview))
        idx = preview.indexOf(token, idx + 1)
      }
      assert.ok(seen >= 1, '占位符 ' + token + ' 未出现')
    }
    steps.push('PASS: 占位符两侧空格精确')
  }))

  // ---- 场景 E：快照缓存不得陈旧（连续两次编辑，落盘必须是第二次的内容）
  // 合并克隆引入了「快照缓存」，最大的风险是**缓存没作废** → 第二次编辑
  // 落盘的还是第一次的内容 → 用户丢字。这条专门盯它。
  results.push(await runOnce('E 快照缓存作废：连续两次编辑，落盘是第二次的内容', async ({ editorCdp, steps }) => {
    // 第一次编辑
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = '<p>${FIRST_MARK}</p>'
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await waitFor(async () => {
      const t = await editorCdp.evaluate("document.querySelector('#saved').textContent")
      return t && t.indexOf('已保存') === 0 ? t : null
    }, 10000, '第一次「已保存」')
    steps.push('第一次编辑已保存')

    // 第二次编辑（不等第一次的防抖就改，制造缓存陈旧的窗口）
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      ed.innerHTML = '<p>${SECOND_MARK}</p>'
      ed.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const saved = await waitFor(async () => {
      const t = await editorCdp.evaluate("document.querySelector('#saved').textContent")
      return t && t.indexOf('已保存') === 0 ? t : null
    }, 10000, '第二次「已保存」')
    steps.push('第二次编辑已保存: ' + saved)
  }, async (disk, steps) => {
    const html = String((disk.notes[0] || {}).html || '')
    const preview = String((disk.notes[0] || {}).preview || '')
    assert.ok(html.indexOf(SECOND_MARK) >= 0,
      '快照缓存陈旧：第二次编辑没落盘，磁盘上是 ' + JSON.stringify(html))
    assert.ok(html.indexOf(FIRST_MARK) === -1,
      '快照缓存陈旧：磁盘上还留着第一次的内容 ' + JSON.stringify(html))
    assert.ok(preview.indexOf(SECOND_MARK) >= 0,
      '快照缓存陈旧：preview 还是第一次的内容 ' + JSON.stringify(preview))
    steps.push('PASS: 落盘与 preview 都是第二次的内容')
  }))

  console.log('\n=========== e2e-snapshot-semantics 逐用例结果 ===========')
  let failed = 0
  for (const r of results) {
    console.log((r.ok ? 'PASSED ' : 'FAILED ') + r.name)
    for (const s of r.steps) console.log('    · ' + s)
    if (!r.ok) {
      failed++
      console.log('    ! ' + r.error)
      console.log(String(r.logTail || '').split('\n').map(l => '    ' + l).join('\n'))
    }
  }
  console.log('=========================================================')
  console.log(`TOTAL=${results.length} PASSED=${results.length - failed} FAILED=${failed}`)
  process.exit(failed ? 1 : 0)
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1) })
module.exports = { runOnce, CDP, waitFor }
