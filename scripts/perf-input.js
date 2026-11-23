'use strict'

/**
 * 输入延迟实测（只测量，不改产品代码）。
 *
 * 目的：量化「大图文便签里每敲一个字要等多久」，并把成本拆成三份：
 *   1) DOM 序列化      —— 每个 input 事件都读 editor.innerHTML（12MB 时是纯 CPU 循环）
 *   2) sync IPC 拷贝   —— preload 的 api.update 是 ipcRenderer.sendSync，主进程返回前渲染层被阻塞
 *   3) 整库落盘        —— 主进程 flushSave 把整个 state JSON.stringify(缩进 2) 后写盘
 *
 * 纪律（每条都有对应的防错实现，见 §「三道闸」）：
 *  - 一律用隔离 --user-data-dir（临时目录），绝不读写真实 %APPDATA%\desktop-sticky-notes；
 *  - 结束走主进程 inspector 里的 app.quit()（真实 before-quit → flushSave）；
 *  - 只有清理兜底才杀自己 spawn 的子进程，绝不碰其它 electron 进程；
 *  - stdout 只输出一个 JSON，进度日志走 stderr。
 *
 * 三道闸（防止「驱动到别人的实例上，把 12MB 写进用户真实便签」）：
 *  闸 1 端口：--remote-debugging-port=0，端口从 stderr 的 "DevTools listening on ws://..." 解析；
 *             解析不到就 fail-fast，**禁止**回落到任何固定端口。
 *  闸 2 代理：spawn 前在父进程与子进程 env 里都删掉 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY（大小写全清，
 *             保留 NO_PROXY），否则本机代理会把 127.0.0.1 的请求转给宿主上的残留实例。
 *  闸 3 身份：fixture 便签标题写入随机 nonce，连上页面后 `window.sticky.list()` 断言 nonce 存在；
 *             不匹配立即退出——此时还没有向任何便签写入过一个字符。
 *
 * 运行：node scripts/perf-input.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const NOTE_ID = 'perf-note'
const NONCE = 'PERF-NONCE-' + crypto.randomUUID()
const KEYS = 20                  // 每档连续插 20 个字符
// 名义间隔；真实节拍会被「每键阻塞 + CDP 往返」拉长，报告里一律报实测键速（keysPerSec）
const GAP_MS = 60
const SETTLE_MS = 2500           // 大写入后必须等的静默时间
const TYPING_SETTLE_MS = 80      // 打完字后等 longtask 回调投递，再取「按键窗口」快照
const TAIL_WINDOW_MS = 900       // 覆盖 180ms 序列化尾巴 + 350ms flush，单独统计这一段的长任务
const TOTAL_BUDGET_MS = 180000
const TYPED_TEXT = 'abcdefghijklmnopqrst'   // 正好 20 个 ASCII 字符
const TAIL_MARK = 'PERFTAIL'

const T_START = Date.now()

/**
 * 脚本自身身份：**在启动时**取样并冻结。
 * 绝不能在 finally 里 statSync —— 那时读到的是「运行结束时」的 mtime，
 * 如果测量期间脚本被改过，日志会把结果记到一个根本没跑过的版本上（可追溯性直接失效）。
 */
const SCRIPT_PATH = __filename
const SCRIPT_ID = (() => {
  const id = { file: 'scripts/perf-input.js', mtime: null, sha256: null, sizeBytes: null }
  try {
    const buf = fs.readFileSync(SCRIPT_PATH)
    id.sha256 = crypto.createHash('sha256').update(buf).digest('hex')
    id.sizeBytes = buf.length
    id.mtime = fs.statSync(SCRIPT_PATH).mtime.toISOString()
  } catch (_) { /* 取不到就留 null，不编造 */ }
  return id
})()

/** 进度日志一律走 stderr，stdout 留给唯一的 JSON */
const log = (...args) => console.error('[perf]', ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor (fn, timeout = 20000, label = '') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch (_) { /* 继续重试 */ }
    await sleep(150)
  }
  throw new Error('waitFor 超时: ' + label)
}

/** 闸 2 用：需要从环境里彻底摘掉的代理变量（大小写各一套） */
const PROXY_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy'
]

/**
 * 闸 2：把代理环境变量从「本进程」摘掉。
 * 不摘的话，本机代理会把 `fetch('http://127.0.0.1:<port>/json/list')` 转给宿主上的残留实例，
 * 于是 DevTools 端口 bind 失败（子进程报 Cannot start http server for devtools）却仍然能拿到
 * 别人的页面列表 —— 脚本会全程驱动别人的进程。保留 NO_PROXY，并补一条 127.0.0.1/localhost。
 */
function stripProxyEnv () {
  const removed = []
  for (const k of PROXY_KEYS) {
    if (process.env[k] !== undefined) {
      removed.push(k + '=' + process.env[k])
      delete process.env[k]
    }
  }
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || ''
  if (!/127\.0\.0\.1/.test(noProxy)) {
    process.env.NO_PROXY = noProxy ? noProxy + ',127.0.0.1,localhost' : '127.0.0.1,localhost'
  }
  return removed
}

/** 极简 CDP 客户端（与 scripts/e2e-quit.js 同一套模式，仅补 per-call 超时） */
class CDP {
  constructor (url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }

  connect () {
    this.ws = new WebSocket(this.url)
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e && e.message))), { once: true })
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

  send (method, params = {}, timeoutMs = 15000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { res: resolve, rej: reject })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        this.pending.delete(id)
        reject(err)
        return
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('CDP 超时: ' + method + ' > ' + timeoutMs + 'ms'))
        }
      }, timeoutMs)
    })
  }

  async evaluate (expression, timeoutMs = 20000) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true
    }, timeoutMs)
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || JSON.stringify(d)
      throw new Error('页面内抛错: ' + String(text).slice(0, 800))
    }
    return r && r.result ? r.result.value : null
  }

  close () {
    try { this.ws.close() } catch (_) { /* 忽略 */ }
  }
}

// ============================================================ 统计
function quantile (values, q) {
  if (!values || !values.length) return 0
  const a = values.slice().sort((x, y) => x - y)
  const pos = (a.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return a[lo]
  return a[lo] + (a[hi] - a[lo]) * (pos - lo)
}
const median = (v) => quantile(v, 0.5)
const round2 = (v) => Math.round(Number(v) * 100) / 100
const stat = (v) => ({
  p50: round2(quantile(v, 0.5)),
  p95: round2(quantile(v, 0.95)),
  max: round2(v && v.length ? Math.max.apply(null, v) : 0)
})

// ============================================================ 场景定义
const SCENARIOS = [
  {
    id: 'S0',
    label: '10 段纯文本，总计约 2KB',
    spec: { imgCount: 0, imgTargetChars: 0, pCount: 10, pChars: 200 },
    timeoutMs: 60000
  },
  {
    id: 'S1',
    label: '200 段纯文本，总计约 200KB',
    spec: { imgCount: 0, imgTargetChars: 0, pCount: 200, pChars: 1000 },
    timeoutMs: 90000
  },
  {
    id: 'S2',
    label: '20 张 JPEG data URL（约 200KB/张）+ 10 段文本，总计约 4MB',
    spec: { imgCount: 20, imgTargetChars: 200 * 1024, pCount: 10, pChars: 200 },
    timeoutMs: 120000
  },
  // 节奏对照档：内容与 S2 完全相同，只把键间隔改成 200ms（真人停顿节奏）。
  // 60ms 档会把 180ms/350ms 防抖整体压掉，因此 S2 的每键指标是「下界」；
  // 这一档让防抖在按键之间真正触发，才能看到真实打字体感。
  // 放在 S2 之后、S3 之前：既是紧邻的 A/B，又保证最后一档仍是 12MB（PERFTAIL 落盘校验口径不变）。
  {
    id: 'S2N',
    label: 'S2 同样内容，键间隔 200ms（真人节奏），10 键',
    spec: { imgCount: 20, imgTargetChars: 200 * 1024, pCount: 10, pChars: 200 },
    keys: 10,
    gapMs: 200,
    light: true,          // 只出 inputHandlerMs + longTasks（不跑分项，省时间）
    timeoutMs: 120000
  },
  {
    id: 'S3',
    label: '40 张 JPEG data URL（约 300KB/张）+ 10 段文本，总计约 12MB',
    spec: { imgCount: 40, imgTargetChars: 300 * 1024, pCount: 10, pChars: 200 },
    timeoutMs: 150000
  }
]

// ============================================================ 页面内探针（一次性注入）
const PAGE_BOOT = `
(function () {
  var ED = function () { return document.querySelector('#editor') }

  function caretAtEnd () {
    var ed = ED()
    ed.focus()
    var r = document.createRange()
    r.selectNodeContents(ed)
    r.collapse(false)
    var s = window.getSelection()
    s.removeAllRanges()
    s.addRange(r)
  }

  // ★ 关键：挂在 document 的捕获阶段。
  // 理由与注册顺序无关：DOM 事件流是 捕获阶段（document → target）→ target → 冒泡阶段，
  // document 上的捕获监听**永远**早于 #editor 上的任何监听（无论谁先 addEventListener），
  // 也永远早于 note.js 的业务 handler。挂在 #editor 上则受注册顺序影响，可能测到「已经处理完」的时间戳。
  function install () {
    document.addEventListener('input', function (ev) {
      var t = ev.target
      if (!t || t.id !== 'editor') return
      var t0 = performance.now()
      setTimeout(function () { window.__perf.inputMs.push(performance.now() - t0) }, 0)
    }, true)
  }

  var P = {
    ready: true,
    inputMs: [],
    ltCount: 0,
    ltTotal: 0,
    ltMax: 0,
    // 停手后那条路单独记账（按 startTime 分流，与回调投递顺序无关）
    tailMark: Infinity,
    tailCount: 0,
    tailTotal: 0,
    tailMax: 0,
    ltError: '',
    obs: null,
    reset: function () {
      this.inputMs = []
      this.ltCount = 0
      this.ltTotal = 0
      this.ltMax = 0
      this.tailMark = Infinity
      this.tailCount = 0
      this.tailTotal = 0
      this.tailMax = 0
    },
    snapshot: function () {
      return {
        inputMs: this.inputMs.slice(),
        ltCount: this.ltCount,
        ltTotal: this.ltTotal,
        ltMax: this.ltMax
      }
    },
    /** 从此刻起，新起的长任务计入「停手尾巴」桶 */
    markTail: function () {
      this.tailMark = performance.now()
      this.tailCount = 0
      this.tailTotal = 0
      this.tailMax = 0
      return this.tailMark
    },
    tailStat: function () {
      return {
        count: this.tailCount,
        totalMs: this.tailTotal,
        maxMs: this.tailMax,
        since: this.tailMark
      }
    },

    /** 只在末尾 collapse 光标，返回当前正文长度与是否真的拿到焦点 */
    caret: function () {
      var ed = ED()
      caretAtEnd()
      var t = ed.textContent
      return {
        len: t.length,
        tail: t.slice(-1),
        hasFocus: document.hasFocus(),
        activeIsEditor: document.activeElement === ed,
        visibility: document.visibilityState
      }
    },

    /** 读正文尾部，用于校验 CDP 插入是否真的落下 */
    tail: function () {
      var t = ED().textContent
      return { len: t.length, tail: t.slice(-1) }
    },

    /** 兜底插入：execCommand('insertText')，同样会派发 beforeinput/input */
    execInsert: function (ch) {
      var ed = ED()
      caretAtEnd()
      var ok = false
      try { ok = document.execCommand('insertText', false, ch) } catch (e) { ok = false }
      var t = ed.textContent
      return { ok: ok, len: t.length, tail: t.slice(-1) }
    },

    /**
     * 灌入一档内容。
     * 图片必须是真的能解码的 JPEG：canvas 画随机噪点 → toDataURL('image/jpeg', 0.72)，
     * 再用 Image.decode() 真的解码一次；尺寸/质量按实测长度反馈迭代，逼近目标 ±30%。
     */
    load: async function (spec) {
      var ed = ED()
      var images = []

      function makeNoiseJpeg (target, seed) {
        var w = 360
        var h = 270
        var url = ''
        for (var iter = 0; iter < 6; iter++) {
          if (w * h > 8000000) throw new Error('canvas 面积失控: ' + w + 'x' + h)
          var cv = document.createElement('canvas')
          cv.width = w
          cv.height = h
          var ctx = cv.getContext('2d')
          var img = ctx.createImageData(w, h)
          var d = img.data
          var s = ((seed * 2654435761) + 1013904223) >>> 0
          var rnd = function () {
            s ^= s << 13; s >>>= 0
            s ^= s >>> 17
            s ^= s << 5; s >>>= 0
            return s & 255
          }
          for (var i = 0; i < d.length; i += 4) {
            d[i] = rnd(); d[i + 1] = rnd(); d[i + 2] = rnd(); d[i + 3] = 255
          }
          ctx.putImageData(img, 0, 0)
          url = cv.toDataURL('image/jpeg', 0.72)
          cv.width = 0
          cv.height = 0
          var ratio = target / url.length
          if (ratio >= 0.7 && ratio <= 1.3) break
          var k = Math.sqrt(target / url.length)
          w = Math.max(32, Math.min(1600, Math.round(w * k)))
          h = Math.max(32, Math.min(1600, Math.round(h * k)))
        }
        return url
      }

      var WORDS = ['perf', 'latency', 'ipc', 'serialize', 'flush', 'note', 'editor',
        'payload', 'baseline', 'measure', 'keydown', 'paint', 'layout', 'string']
      function paraText (idx, chars) {
        var s = 'P' + idx + ' '
        while (s.length < chars) s += WORDS[(idx + s.length) % WORDS.length] + ' '
        return s.slice(0, chars)
      }

      var body = ''
      for (var i = 0; i < spec.imgCount; i++) {
        var url = makeNoiseJpeg(spec.imgTargetChars, i + 1)
        // 真实解码校验：不合格的 base64 在这里就会炸
        var probe = new Image()
        probe.src = url
        await probe.decode()
        if (!probe.naturalWidth || !probe.naturalHeight) {
          throw new Error('第 ' + i + ' 张 JPEG 无法解码')
        }
        images.push({ chars: url.length, w: probe.naturalWidth, h: probe.naturalHeight })
        body += '<p><img src="' + url + '" alt="noise-' + i + '"></p>'
      }
      for (var j = 0; j < spec.pCount; j++) {
        body += '<p>' + paraText(j, spec.pChars) + '</p>'
      }

      ed.innerHTML = body
      if (spec.external) {
        ed.innerHTML = ''
        var parsed = new DOMParser().parseFromString(body, 'text/html')
        for (var img of parsed.querySelectorAll('img')) await insertImageDataUrl(img.getAttribute('src'))
        for (var paragraph of parsed.querySelectorAll('p')) if (!paragraph.querySelector('img')) insertHtml(paragraph.outerHTML)
      }
      var htmlBytes = ed.innerHTML.length
      var textLen = ed.textContent.length
      ed.dispatchEvent(new InputEvent('input', { bubbles: true }))
      return {
        htmlBytes: htmlBytes,
        textLen: textLen,
        images: images
      }
    },

    /** 纯 IPC + 字符串拷贝：HTML 只序列化一次，不进计时 */
    /**
     * 纯 IPC + 字符串拷贝（html 预先序列化好，不进计时）。
     *
     * ★ 每次采样前先 flush() + 静置 300ms：
     *   每个 note:update 都会让主进程 scheduleSave()（main.js:1748，250ms 防抖）重排一次，
     *   若 5 次采样背靠背连打，落盘极易与后面的采样重叠 → 测出来的是「IPC + 排队」而不是「IPC」。
     *   先 flush（flushSave 会 clearTimeout 掉 pending 定时器）再静置，保证每次采样都发生在
     *   「主进程空闲、没有写盘在飞」的窗口里。采样间隔因此 >=300ms（比 250ms 防抖窗还长）。
     */
    measureIpc: async function (n) {
      var ed = ED()
      var html = ed.innerHTML
      var out = []
      var okAll = true
      var quietGapMs = 300
      for (var i = 0; i < n; i++) {
        try { await window.sticky.flush() } catch (e) { /* 清掉 pending 落盘 */ }
        await new Promise(function (r) { setTimeout(r, quietGapMs) })
        var t0 = performance.now()
        var r = window.sticky.update({ html: html, preview: 'perf-ipc' })
        out.push(performance.now() - t0)
        if (!r || !r.ok) okAll = false
      }
      try { await window.sticky.flush() } catch (e) { /* 收尾，别把 pending 留给下一个指标 */ }
      return { ms: out, ok: okAll, htmlBytes: html.length, gapMs: quietGapMs }
    },

    /** serializeHtml() 的等价成本代理 + 每键真正走的 innerHTML 读取 */
    measureSerialize: function (n) {
      var ed = ED()
      var clone = []
      var read = []
      for (var i = 0; i < n; i++) {
        var t0 = performance.now()
        var c = ed.cloneNode(true)
        var len = c.innerHTML.length
        clone.push(performance.now() - t0)
        c = null
        var t1 = performance.now()
        var raw = ed.innerHTML
        read.push(performance.now() - t1)
        if (raw.length !== len) { /* 长度差异（属性规范化）在此忽略 */ }
      }
      return { cloneMs: clone, readMs: read }
    },

    /**
     * 180ms 延迟路径的真实成本：那条路一共克隆**两次**整棵 DOM
     *   ① serializeHtml()（note.js:378-386）= cloneNode(true) + 清 Mermaid + clone.innerHTML
     *   ② plainText()（note.js:394-400）    = 又一次 cloneNode(true) + 替换 mmd/img + textContent
     * 这里逐行复刻这两步，中间不打任何断点，代表「停手 180ms 后那一笔」的完整内存成本。
     */
    /**
     * 停手 180ms 后那条路的**完整**复刻（note.js:431-437）：
     *   updateStats()  → 内部又调一次 plainText()   [cloneNode #1]
     *   serializeHtml()                             [cloneNode #2]
     *   plainText().slice(0,160)                    [cloneNode #3]
     *   queueSave() → api.update(patch)             [一次 12MB sendSync]
     * 也就是 3 次整克隆 + 1 次全量 sync IPC。
     * 注：serializePairMs 只复刻了 #2+#3，**少算 updateStats 里那次克隆**，此处才是真实成本。
     */
    measureTailPath: function (n) {
      var ed = ED()
      var out = []
      var okAll = true
      var swap = function (clone) {
        clone.querySelectorAll('.mmd').forEach(function (el) {
          el.replaceWith(document.createTextNode(' [图表] '))
        })
        clone.querySelectorAll('img').forEach(function (el) {
          el.replaceWith(document.createTextNode(' [图片] '))
        })
        return (clone.textContent || '').replace(/\s+/g, ' ').trim()
      }
      for (var i = 0; i < n; i++) {
        var t0 = performance.now()

        // ① updateStats() 内部的 plainText()
        var c0 = ed.cloneNode(true)
        var statsText = swap(c0)
        c0 = null

        // ② serializeHtml()
        var c1 = ed.cloneNode(true)
        c1.querySelectorAll('.mmd-body').forEach(function (el) { el.innerHTML = '' })
        c1.querySelectorAll('.mmd').forEach(function (el) { el.removeAttribute('data-rendered') })
        var html = c1.innerHTML
        c1 = null

        // ③ plainText().slice(0,160)
        var c2 = ed.cloneNode(true)
        var preview = swap(c2).slice(0, 160)
        c2 = null

        // ④ queueSave 里的 api.update(patch)：12MB sendSync
        var r = window.sticky.update({ html: html, preview: preview })
        if (!r || !r.ok) okAll = false

        out.push(performance.now() - t0)
        if (statsText === null || preview === null) return null
      }
      return { ms: out, ok: okAll }
    },

    /**
     * 180ms 延迟路径里**只算两次克隆**的那一半（serializeHtml + plainText）。
     * 保留它是为了和 serializeProxyMs 对比出「第 2、3 次克隆各花多少」，
     * 但它**不含** updateStats 内的那次克隆与 sendSync，故不能当作整条路成本。
     */
    measureSerializePair: function (n) {
      var ed = ED()
      var out = []
      for (var i = 0; i < n; i++) {
        var t0 = performance.now()

        // ① serializeHtml() 等价
        var c1 = ed.cloneNode(true)
        c1.querySelectorAll('.mmd-body').forEach(function (el) { el.innerHTML = '' })
        c1.querySelectorAll('.mmd').forEach(function (el) { el.removeAttribute('data-rendered') })
        var html = c1.innerHTML
        c1 = null

        // ② plainText() 等价
        var c2 = ed.cloneNode(true)
        c2.querySelectorAll('.mmd').forEach(function (el) {
          el.replaceWith(document.createTextNode(' [图表] '))
        })
        c2.querySelectorAll('img').forEach(function (el) {
          el.replaceWith(document.createTextNode(' [图片] '))
        })
        var text = (c2.textContent || '').replace(/\s+/g, ' ').trim()
        c2 = null

        out.push(performance.now() - t0)
        if (html === null || text === null) return null
      }
      return out
    },

    /**
     * 每键还会走两次 textContent 全量扫描（updateEmptyState + preview 拼装），
     * 单独量一下，用来解释 inputHandlerMs 里减掉序列化/IPC 之后的余量。
     */
    measureText: function (n) {
      var ed = ED()
      var out = []
      for (var i = 0; i < n; i++) {
        var t0 = performance.now()
        var raw = ed.textContent
        out.push(performance.now() - t0)
        if (raw === null) return null
      }
      return out
    },

    /** 整库落盘：制造一次改动后 await flush() */
    measureFlush: async function (n) {
      var out = []
      var okAll = true
      for (var i = 0; i < n; i++) {
        window.sticky.update({ preview: 'perf-flush-' + i })
        var t0 = performance.now()
        var r = await window.sticky.flush()
        out.push(performance.now() - t0)
        if (!r || !r.ok) okAll = false
      }
      return { ms: out, ok: okAll }
    },

    /**
     * 直接判定「整库落盘会不会让后续按键排队」——不靠缩放推算，靠实测：
     *   1) 先发起一次 flush（不 await），让主进程真的进到 12MB 的 writeFileSync；
     *   2) 立刻发一次 sendSync 的 update（这就是一次按键走的路），量它等多久；
     *   3) 再 flush 一次收尾。
     * 若「落盘占住主进程 → 按键排队」成立，这里应当显著大于安静窗口下的 updateIpcMs。
     */
    measureIpcUnderFlush: async function (n) {
      var ed = ED()
      var html = ed.innerHTML
      var out = []
      var okAll = true
      var phaseMs = 10          // 固定相位：flush 发出后 10ms 再打这一枪（对应「停顿后第 1 个按键」）
      for (var i = 0; i < n; i++) {
        // 故意不 await：让 12MB 写盘留在飞。必须 .catch —— 否则 rejection 冒到 window，
        // src/guard.js 会把它当未捕获异常记进 app-errors.log，污染被测应用。
        var flying = window.sticky.flush()
        if (flying && typeof flying.catch === 'function') flying.catch(function () {})
        await new Promise(function (r) { setTimeout(r, phaseMs) })
        var t0 = performance.now()
        var r2 = window.sticky.update({ html: html, preview: 'perf-under-flush-' + i })
        out.push(performance.now() - t0)
        if (!r2 || !r2.ok) okAll = false
        // 等这次写盘落地再做下一次，避免样本之间互相排队
        await flying.catch(function () {})
        await new Promise(function (r) { setTimeout(r, 50) })
      }
      return { ms: out, ok: okAll, phaseMs: phaseMs, htmlBytes: html.length }
    }
  }

  install()
  try {
    P.obs = new PerformanceObserver(function (list) {
      var es = list.getEntries()
      for (var i = 0; i < es.length; i++) {
        var d = es[i].duration
        // 按 startTime 分流：晚于 markTail 的算「停手尾巴」，其余算「按键/灌入窗口」
        if (es[i].startTime >= P.tailMark) {
          P.tailCount++
          P.tailTotal += d
          if (d > P.tailMax) P.tailMax = d
        } else {
          P.ltCount++
          P.ltTotal += d
          if (d > P.ltMax) P.ltMax = d
        }
      }
    })
    P.obs.observe({ type: 'longtask', buffered: false })
  } catch (err) {
    P.ltError = String(err)
  }

  window.__perf = P
  return 'installed'
})()
`

// ============================================================ 主流程
/** 闸 3：标题里写随机 nonce，连上页面后用它证明「我驱动的是我自己 spawn 的那个实例」 */
function makeFixture () {
  return {
    version: 2,
    notes: [
      {
        id: NOTE_ID,
        title: NONCE,
        html: '<p>PERF-FIXTURE</p>',
        preview: NONCE,
        color: '#FFF3B0',
        theme: {},
        bounds: { x: 160, y: 120, width: 680, height: 720 },
        alwaysOnTop: false,
        visible: true,
        mode: 'edit',
        // 关掉贴边收纳：测量期间绝不能让窗口自己缩成窄条
        edgeCollapse: false,
        collapsed: false,
        collapseEdge: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ],
    ai: { activeId: '', providers: [] },
    settings: { globalSelect: false }
  }
}

/** 从主进程 inspector 里拿到 electron 模块（与 e2e-quit.js 同款解析链） */
function electronModuleExpr (stmt) {
  return `(() => {
    try {
      const m = globalThis.process && globalThis.process.mainModule
      let e = null
      if (m && m.require) e = m.require('electron')
      if (!e && typeof require === 'function') e = require('electron')
      if (!e && m && m.constructor && m.constructor._load) e = m.constructor._load('electron', m, false)
      if (!e && typeof Module === 'function' && Module._load) e = Module._load('electron', null, false)
      if (!e && typeof process === 'object' && process.getBuiltinModule) {
        e = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron')
      }
      if (!e) return { ok: false, error: '拿不到 electron 模块' }
      ${stmt}
    } catch (err) { return { ok: false, error: String(err) } }
  })()`
}

async function runWithTimeout (fn, ms, label) {
  let timer = null
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('场景超时: ' + label + ' 超过 ' + ms + 'ms')), ms)
  })
  try {
    return await Promise.race([fn(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 清理兜底：只看「命令行里带本次隔离目录精确路径」的 electron 进程 —— 也就是自己 spawn 的那棵树。
 * 绝不按进程名批量杀（那会碰到用户真实的便签进程）。
 * 场景：主进程已退出、但 utility/gpu 子进程还短暂占着目录里的文件，导致删不掉、下一轮被拖慢。
 */
function killOwnedElectronTree (userData) {
  if (process.platform !== 'win32') return { killed: 0, skipped: 'non-win32' }
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$ud = ' + JSON.stringify(userData),
    "$p = Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like ('*' + $ud + '*') }",
    '$n = 0',
    'foreach ($x in $p) { try { Stop-Process -Id $x.ProcessId -Force -Confirm:$false; $n++ } catch { } }',
    '$n'
  ].join('; ')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 20000
    })
    return { killed: Number(String(out).trim()) || 0 }
  } catch (err) {
    return { killed: 0, error: err && err.message ? err.message : String(err) }
  }
}

async function main () {
  if (!fs.existsSync(ELECTRON)) throw new Error('未找到 electron.exe: ' + ELECTRON)
  if (typeof fetch !== 'function' || typeof WebSocket !== 'function') {
    throw new Error('需要 Node 22+ 的全局 fetch / WebSocket')
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-perf-'))
  const dataFile = path.join(userData, 'sticky-notes.json')
  fs.writeFileSync(dataFile, JSON.stringify(makeFixture(), null, 2), 'utf8')
  log('隔离 user-data-dir:', userData)

  // 闸 2：先摘父进程的代理变量，再拷子进程 env（并再删一遍，双保险）
  const removedProxy = stripProxyEnv()
  if (removedProxy.length) log('闸2：已摘除代理环境变量 ->', removedProxy.join(', '))
  else log('闸2：环境里本来没有 HTTP(S)/ALL_PROXY（OK）')
  log('闸2：NO_PROXY =', process.env.NO_PROXY)

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  for (const k of PROXY_KEYS) delete env[k]

  const child = spawn(ELECTRON, [
    '--user-data-dir=' + userData,
    // 闸 1：端口交给内核分配（=0）。绝不用固定端口，避免撞上残留实例后打到别人的页面上。
    '--remote-debugging-port=0',
    '--inspect=0',
    // 下面四个只为消除「窗口被遮挡/失焦」时的后台节流噪声，
    // 不改变产品行为（否则后台窗口的 setTimeout 会被压到 1s，测出来全是垃圾）
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '.'
  ], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

  let logText = ''
  let inspectorUrl = null
  let devtoolsPort = null
  const onData = (d) => {
    logText += d.toString()
    // 在**累积文本**上匹配：stderr 的 chunk 边界可能把一整行切开
    if (!inspectorUrl) {
      const mi = logText.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/)
      if (mi) inspectorUrl = mi[1]
    }
    if (!devtoolsPort) {
      const mp = logText.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)
      if (mp) devtoolsPort = Number(mp[1])
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const cdps = []
  const notes = []
  const scenarios = []
  let pageCdp = null
  let dataOk = true
  let fatal = null
  let insertMode = 'cdp'

  try {
    // ---- 闸 1：DevTools 端口只认 stderr 里那行，解析不到就 fail-fast，禁止回落固定端口
    let devtoolsBase = null
    try {
      const port = await waitFor(() => devtoolsPort, 25000, 'DevTools 端口')
      devtoolsBase = 'http://127.0.0.1:' + port
      log('闸1：内核分配端口 = ' + port + '（--remote-debugging-port=0）')
    } catch (_) {
      throw new Error('闸1 失败：没有从子进程 stderr 解析到 "DevTools listening on ws://127.0.0.1:<PORT>/"。' +
        (logText.indexOf('Cannot start http server for devtools') >= 0
          ? '子进程报了 "Cannot start http server for devtools"（说明端口被占/绑定失败）。'
          : '') +
        '按纪律**拒绝回落到任何固定端口**，直接退出。应用日志尾部：\n' + logText.slice(-800))
    }

    // ---- 等便签渲染页（只从刚才解析出的端口取，绝不猜）
    const target = await waitFor(async () => {
      const r = await fetch(devtoolsBase + '/json/list')
      const list = await r.json()
      const hits = list.filter((t) => t.type === 'page' && /note\.html/.test(t.url))
      return hits.length ? hits[0] : null
    }, 30000, '便签渲染页就绪')
    log('便签页:', target.url)

    pageCdp = new CDP(target.webSocketDebuggerUrl)
    await pageCdp.connect()
    cdps.push(pageCdp)

    // 等到「编辑器 + bridge + 标题已渲染」三者就绪。#title 是 note.js 异步 init 后才有值的，
    // 不等它就会把「还没初始化完」误判成「不是我的实例」。
    await waitFor(async () => pageCdp.evaluate(
      "(function () {" +
      "  var ed = document.querySelector('#editor');" +
      "  var ti = document.querySelector('#title');" +
      "  return (ed && window.sticky && ti && ti.value) ? 'ok' : '';" +
      "})()"
    ), 20000, '#editor / window.sticky / #title 就绪')
    log('editor / preload bridge / #title 就绪')

    try {
      await pageCdp.send('Page.bringToFront', {}, 5000)
    } catch (_) { /* 非致命 */ }

    // ---- 闸 3：实例身份校验。必须发生在「写入任何一个字符」之前。
    const identity = await pageCdp.evaluate(`(async () => {
      try {
        const list = await window.sticky.list()
        const arr = Array.isArray(list) ? list : []
        const t = document.querySelector('#title')
        return {
          ok: true,
          count: arr.length,
          titles: arr.map(function (n) { return n && n.title }),
          domTitle: t ? t.value : null
        }
      } catch (err) { return { ok: false, error: String(err) } }
    })()`, 30000)
    const titles = (identity && identity.titles) || []
    if (!identity || !identity.ok || titles.indexOf(NONCE) < 0) {
      throw new Error('闸3 失败：连上的实例里没有本次的 nonce 便签。' +
        '**此时尚未向任何便签写入内容**，直接退出以免污染别人的数据。' +
        ' 期望 nonce=' + NONCE +
        ' 实际 titles=' + JSON.stringify(titles) +
        ' 便签数=' + (identity && identity.count) +
        ' DOM 标题=' + JSON.stringify(identity && identity.domTitle))
    }
    if (identity.domTitle !== NONCE) {
      throw new Error('闸3 失败：页面 #title 与 fixture nonce 不一致（domTitle=' +
        JSON.stringify(identity.domTitle) + '）')
    }
    log('闸3：实例身份校验通过（nonce=' + NONCE + '，便签数=' + identity.count + '）')
    notes.push('闸3 实例身份校验通过：window.sticky.list() 返回 ' + identity.count +
      ' 张便签，标题恰为本次随机 nonce ' + NONCE + '，页面 #title 同值 —— 证明驱动的是本次 spawn 的隔离实例。')

    const booted = await pageCdp.evaluate(PAGE_BOOT, 30000)
    log('页面探针:', booted)

    // ---- CDP 自身开销基线（给 cdpMs 一个参考下界）
    const overhead = []
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now()
      await pageCdp.evaluate('1 + 1')
      overhead.push(performance.now() - t0)
    }
    notes.push('CDP 自身往返基线（Runtime.evaluate("1+1") 10 次）：p50 ' +
      round2(median(overhead)) + 'ms / max ' + round2(Math.max.apply(null, overhead)) + 'ms。' +
      'cdpMs 已包含渲染层阻塞，故只作参考，结论以 inputHandlerMs 为准。')

    // ---- 插入方式探针：CDP 插不进去就全程用 execCommand 兜底
    const probeBefore = await pageCdp.evaluate('window.__perf.caret()')
    await pageCdp.send('Input.insertText', { text: 'X' })
    const probeAfter = await pageCdp.evaluate('window.__perf.tail()')
    if (probeAfter.len === probeBefore.len + 1 && probeAfter.tail === 'X') {
      insertMode = 'cdp'
      log('插入方式: CDP Input.insertText')
    } else {
      const ex = await pageCdp.evaluate("window.__perf.execInsert('X')")
      if (!(ex.len === probeBefore.len + 1 && ex.tail === 'X')) {
        throw new Error('两种插入方式都无法落字（before=' + JSON.stringify(probeBefore) +
          ' after=' + JSON.stringify(probeAfter) + ' exec=' + JSON.stringify(ex) + '）')
      }
      insertMode = 'exec'
      notes.push('CDP Input.insertText 未能在页面上落字，已改用 document.execCommand("insertText") 兜底（同样派发 input 事件，测量口径不变）。')
      log('插入方式: execCommand 兜底')
    }
    notes.push('页面焦点状态：document.hasFocus()=' + probeBefore.hasFocus +
      '，activeElement 是 #editor=' + probeBefore.activeIsEditor +
      '，visibilityState=' + probeBefore.visibility +

      '（探针时刻）。')
    if (insertMode === 'cdp') notes.push('插入方式：CDP Input.insertText，每次都校验正文尾部确实多了一个字符。')

    // ---- 逐档测量
    for (const sc of SCENARIOS) {
      if (Date.now() - T_START > TOTAL_BUDGET_MS - 20000) {
        throw new Error('总预算不足，跳过后续场景之前已用时 ' +
          Math.round((Date.now() - T_START) / 1000) + 's')
      }
      log('=== ' + sc.id + ' ' + sc.label + ' ===')
      const r = await runWithTimeout(() => runScenario({
        cdp: pageCdp,
        dataFile,
        sc,
        getInsertMode: () => insertMode,
        setInsertMode: (m) => { insertMode = m }
      }), sc.timeoutMs, sc.id)
      scenarios.push(r.result)
      notes.push.apply(notes, r.notes)
      if (!r.keysOk) dataOk = false
      log(sc.id + ' 完成: htmlBytes=' + r.result.htmlBytes +
        ' p50=' + r.result.inputHandlerMs.p50 + 'ms p95=' + r.result.inputHandlerMs.p95 + 'ms')
    }

    // ---- 最终数据正确性：最后一档打完再敲 PERFTAIL，退出后必须能在盘上找到
    log('写入尾部标记 ' + TAIL_MARK + ' …')
    const tailRes = await pageCdp.evaluate(`(function () {
      var ed = document.querySelector('#editor')
      ed.focus()
      var r = document.createRange()
      r.selectNodeContents(ed)
      r.collapse(false)
      var s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      try { document.execCommand('insertText', false, ${JSON.stringify(TAIL_MARK)}) } catch (e) {}
      return { tail: ed.textContent.slice(-${TAIL_MARK.length}), len: ed.textContent.length }
    })()`)
    log('页面尾部 =', JSON.stringify(tailRes))

    const flushed = await pageCdp.evaluate(
      '(async () => { try { return await window.sticky.flush() } catch (err) { return { ok: false, error: String(err) } } })()',
      120000
    )
    log('显式 flush:', JSON.stringify(flushed))
    await sleep(300)

    // ---- app.quit()（真实 before-quit）
    const url = await waitFor(() => inspectorUrl, 20000, '主进程 inspector ws')
    const mainCdp = new CDP(url)
    await mainCdp.connect()
    cdps.push(mainCdp)
    const quit = await mainCdp.evaluate(electronModuleExpr('e.app.quit(); return { ok: true }'), 20000)
    if (!quit || !quit.ok) throw new Error('app.quit() 调用失败: ' + JSON.stringify(quit))
    log('已调用 app.quit()')
    mainCdp.close()

    await waitFor(async () => child.exitCode !== null, 15000, '进程自然退出').catch(() => {})
    if (child.exitCode === null) throw new Error('应用未在 15s 内自然退出')

    // ---- 读盘校验
    const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    const note = (disk.notes || []).find((n) => n.id === NOTE_ID)
    if (!note) throw new Error('盘上没有找到便签 ' + NOTE_ID)
    const htmlOk = String(note.html || '').indexOf(TAIL_MARK) >= 0
    const previewOk = String(note.preview || '').indexOf(TAIL_MARK) >= 0
    if (!htmlOk) {
      dataOk = false
      throw new Error('数据已损坏：盘上便签 html 里没有 ' + TAIL_MARK +
        '（说明测量过程中正文被写坏或丢失）。html 长度 = ' + String(note.html || '').length +
        '，尾部 = ' + JSON.stringify(String(note.html || '').slice(-120)))
    }
    log('落盘校验通过：html 含 ' + TAIL_MARK + '，html 长度 = ' + String(note.html).length +
      '，preview 含标记 = ' + previewOk)
    notes.push('落盘校验：app.quit() 后 sticky-notes.json 中便签 html 长度 ' +
      String(note.html).length + '，确实含尾部标记 ' + TAIL_MARK +
      '（preview 是否含标记=' + previewOk + '）。')
  } catch (err) {
    fatal = err
  } finally {
    for (const c of cdps) c.close()
    if (child.exitCode === null) {
      log('兜底：只杀本脚本自己 spawn 的子进程')
      try { child.kill() } catch (_) { /* 忽略 */ }
      await sleep(500)
    }
    // 清理隔离目录：主进程退出后，utility/gpu 子进程可能还短暂占着里面的文件。
    // 先按「本次隔离目录的精确路径」清掉自己那棵树里的残留进程，再带重试删除，最后**校验真的删掉了**。
    const owned = killOwnedElectronTree(userData)
    if (owned.killed) log('清理：结束了 ' + owned.killed + ' 个仍占着本次隔离目录的自己人进程（按精确 userData 路径匹配）')
    let removed = false
    for (let attempt = 1; attempt <= 6; attempt++) {
      try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) { /* 下面统一校验 */ }
      if (!fs.existsSync(userData)) { removed = true; break }
      log('清理隔离目录第 ' + attempt + ' 次未成功，' + (200 * attempt) + 'ms 后重试')
      await sleep(200 * attempt)
    }
    if (!removed) {
      const again = killOwnedElectronTree(userData)
      if (again.killed) {
        try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) { /* 忽略 */ }
        removed = !fs.existsSync(userData)
      }
    }
    if (!removed) {
      log('⚠️ 清理失败，隔离目录被留在了 ' + userData + '（只影响 %TEMP%，不影响真实数据）')
      notes.push('⚠️ 隔离目录未能删除（被占用），路径 ' + userData + '，可手工删除。')
    }

    const elapsed = Math.round((Date.now() - T_START) / 1000)
    // 失败时 dataOk 记 null（=「没验到」），避免失败运行看起来像「落盘校验通过」
    const verDict = fatal ? null : dataOk
    const out = {
      // 版本一致性：报告里引用的数字必须能对上这个时间戳
      // 只读启动时冻结的身份（见 SCRIPT_ID 注释），不在 finally 里重新 statSync
      script: {
        file: SCRIPT_ID.file,
        mtime: SCRIPT_ID.mtime,
        sha256: SCRIPT_ID.sha256,
        sizeBytes: SCRIPT_ID.sizeBytes,
        startedAt: new Date(T_START).toISOString(),
        finishedAt: new Date().toISOString(),
        nonce: NONCE,
        devtoolsPort: devtoolsPort || null
      },
      scenarios,
      notes,
      dataOk: verDict,
      elapsedSec: elapsed
    }
    if (fatal) out.error = fatal && fatal.message ? fatal.message : String(fatal)
    if (fatal) notes.push('运行失败：' + out.error)
    if (fatal && logText) {
      console.error('[perf] 应用日志尾部:\n' + logText.slice(-1200))
    }
    // stdout 只此一处输出
    console.log(JSON.stringify(out, null, 2))
    process.exit(fatal ? 1 : 0)
  }
}

/**
 * 单档测量。顺序很重要：
 *   灌内容 → 等 2.5s（让那条大写入链路彻底走完）→ 清空探针 → 打字 → 再等处理尾巴 → 各分项
 */
async function runScenario ({ cdp, dataFile, sc, getInsertMode, setInsertMode }) {
  const localNotes = []
  // 每档可以覆盖键数与间隔（S2N 用 200ms 的真人节奏），默认 20 键 / 60ms
  const keyCount = Number(sc.keys) > 0 ? Number(sc.keys) : KEYS
  const gapMs = Number(sc.gapMs) > 0 ? Number(sc.gapMs) : GAP_MS

  // 1) 灌内容
  const load = await cdp.evaluate('window.__perf.load(' + JSON.stringify(Object.assign({}, sc.spec, { external: process.argv.includes('--external-images') })) + ')', sc.timeoutMs)
  const htmlBytes = load.htmlBytes
  log(sc.id + ' 已灌入 htmlBytes=' + htmlBytes + '（textContent ' + load.textLen + ' 字符）')
  if (load.images.length) {
    const chars = load.images.map((i) => i.chars)
    localNotes.push(sc.id + ' 图片：' + load.images.length + ' 张，单张 data URL ' +
      Math.min.apply(null, chars) + '–' + Math.max.apply(null, chars) +
      ' 字符（目标 ' + sc.spec.imgTargetChars + '±30%），全部通过 Image.decode() 真实解码，示例尺寸 ' +
      load.images[0].w + '×' + load.images[0].h + '。')
    const total = chars.reduce((a, b) => a + b, 0)
    localNotes.push(sc.id + ' 图片 data URL 合计 ' + total + ' 字符（约 ' +
      round2(total / 1024 / 1024) + ' MiB 字符量）。')
  }

  // 2) 静默 2.5s，别把初始化成本算到按键头上
  await sleep(SETTLE_MS)

  let stateFileBytes = null
  try { stateFileBytes = fs.statSync(dataFile).size } catch (_) { stateFileBytes = null }

  // 3) 清空探针（这之前的 input 事件属于「大写入」，不算按键）
  await cdp.evaluate('window.__perf.reset()')

  // 4) 打字：每键前把光标 collapse 到末尾并校验落字
  const t0 = Date.now()
  let cdpChars = 0
  let execChars = 0
  let voided = 0
  const cdpMs = []
  const chars = TYPED_TEXT.split('')
  for (let i = 0; i < keyCount; i++) {
    const ch = chars[i % chars.length]
    const before = await cdp.evaluate('window.__perf.caret()')
    let after = null
    let ok = false

    if (getInsertMode() === 'cdp') {
      const t = performance.now()
      await cdp.send('Input.insertText', { text: ch })
      cdpMs.push(performance.now() - t)
      after = await cdp.evaluate('window.__perf.tail()')
      ok = (after.len === before.len + 1 && after.tail === ch)
      if (ok) {
        cdpChars++
      } else {
        log(sc.id + ' 第 ' + (i + 1) + ' 键 CDP 未落字，改用 execCommand 兜底')
        setInsertMode('exec')
      }
    }

    if (!ok) {
      after = await cdp.evaluate('window.__perf.execInsert(' + JSON.stringify(ch) + ')')
      ok = (after.len === before.len + 1 && after.tail === ch)
      if (ok) execChars++
    }

    if (!ok) {
      voided++
      log(sc.id + ' 第 ' + (i + 1) + ' 键作废：before=' + JSON.stringify(before) +
        ' after=' + JSON.stringify(after))
      if (voided > 3) throw new Error(sc.id + '：连续 ' + voided + ' 次插入失败，测量不可信')
    }
    await sleep(gapMs)
  }
  const typingMs = Date.now() - t0

  // 5) 先取「按键窗口」的长任务快照（等 80ms 让 observer 回调投递完），
  //    再打 markTail，把「停手后 180ms 那条路」单独记一笔 —— 两笔不能混在一起。
  await sleep(TYPING_SETTLE_MS)
  const snap = await cdp.evaluate('window.__perf.snapshot()')
  await cdp.evaluate('window.__perf.markTail()')
  await sleep(TAIL_WINDOW_MS)
  const tail = await cdp.evaluate('window.__perf.tailStat()')

  // 6) 分项成本（light 档只出 inputHandlerMs + longTasks，跳过这些）
  //    flush 前后各测一次：上一版 flushMs 从 112 掉到 64.8 一直没解释，
  //    「前 ≫ 后」才能说明是写路径预热/杀软摊销；「前 ≈ 后」则说明是批次差异。
  let ipc = { ms: [], ok: true }
  let ser = { cloneMs: [], readMs: [] }
  let pair = []
  let tailPath = { ms: [], ok: true }
  let txt = []
  let flushFirst = { ms: [], ok: true }
  let flushEnd = { ms: [], ok: true }
  let under = { ms: [], ok: true }
  if (!sc.light) {
    flushFirst = await cdp.evaluate('window.__perf.measureFlush(3)', 300000)
    ipc = await cdp.evaluate('window.__perf.measureIpc(5)', 300000)
    ser = await cdp.evaluate('window.__perf.measureSerialize(5)', 180000)
    pair = await cdp.evaluate('window.__perf.measureSerializePair(5)', 180000)
    tailPath = await cdp.evaluate('window.__perf.measureTailPath(5)', 180000)
    txt = await cdp.evaluate('window.__perf.measureText(5)', 180000)
    under = await cdp.evaluate('window.__perf.measureIpcUnderFlush(5)', 300000)
    flushEnd = await cdp.evaluate('window.__perf.measureFlush(3)', 300000)
  }

  const inputHandlerMs = stat(snap.inputMs)
  // keysPerSec = 本轮**实测**节拍 = keyCount / typingMs（含名义间隔 + 每键阻塞 + CDP 往返）
  // capacityPerSec = 单键吞吐的**上限估计** = 1 / inputHandlerMs.p50（只用中位数，偏乐观）
  //   严格上限应为 1 / E[每次按键阻塞]，E 要包含长任务尾巴，比 p50 低不少；这里只作数量级参考。
  const keysPerSec = round2(keyCount / (typingMs / 1000))
  const capacityPerSec = round2(1000 / (inputHandlerMs.p50 || 1))
  const result = {
    id: sc.id,
    htmlBytes,
    inputHandlerMs,
    cdpMs: {
      p50: round2(quantile(cdpMs, 0.5)),
      p95: round2(quantile(cdpMs, 0.95))
    },
    // light 档（S2N）不跑分项，这些字段为 null —— 它的用途是「节奏对照」，只看 A 组与长任务
    updateIpcMs: sc.light ? null : round2(median(ipc.ms)),
    // 同一次 sendSync，但在「整库写盘正在飞」的时候发（固定相位 10ms）——
    // 用来直接判定落盘是否让按键排队。**典型值，不是写入峰值**。
    updateIpcUnderFlushMs: sc.light ? null : round2(median((under && under.ms) || [])),
    updateIpcUnderFlushMaxMs: sc.light ? null : round2(
      (under && under.ms && under.ms.length) ? Math.max.apply(null, under.ms) : 0
    ),
    updateIpcUnderFlushPhaseMs: sc.light ? null : (under ? under.phaseMs : null),
    serializeProxyMs: sc.light ? null : round2(median(ser.cloneMs)),
    innerHtmlReadMs: sc.light ? null : round2(median(ser.readMs)),
    // flushMs = 分项序列**最前**一次（此时前面的测量还没把写路径/杀软缓存焐热）
    flushMs: sc.light ? null : round2(median(flushFirst.ms)),
    // 同一档末尾再测一次，用来判断 112→64.8 这类差异是「预热」还是「批次差异」
    flushMsEndMs: sc.light ? null : round2(median(flushEnd.ms)),
    flushSamplesFirst: sc.light ? null : flushFirst.ms.map(round2),
    flushSamplesEnd: sc.light ? null : flushEnd.ms.map(round2),
    // 只统计「按键窗口」的渲染层长任务（主进程的 JSON.stringify 在这里看不到）
    longTasks: {
      count: snap.ltCount,
      totalMs: round2(snap.ltTotal),
      maxMs: round2(snap.ltMax)
    },
    inserted: cdpChars + execChars,
    // keysOk：本次按键是否都真的落字（不是落盘校验，落盘校验看顶层 dataOk）
    keysOk: voided === 0,
    // 以下是补充字段（报告里有解释），不影响上面的约定口径
    stateFileBytes,
    keysPerSec,
    capacityPerSec,
    typingMs,
    keyCount,
    gapMs: gapMs,
    // 停手 180ms 后那条路：updateStats→plainText + serializeHtml + plainText + sendSync
    // = 3 次整克隆 + 1 次全量 sync IPC
    tailPathMs: sc.light ? null : round2(median((tailPath && tailPath.ms) || [])),
    // 上面那条路只算 2 次克隆（serializeHtml + plainText），**少算 updateStats 内那次**
    serializePairMs: sc.light ? null : round2(median(pair || [])),
    // 停手后那一次长任务（渲染层实测，对应「打字停一下卡一下」）
    tailLongTask: {
      count: tail ? tail.count : 0,
      totalMs: tail ? round2(tail.totalMs) : 0,
      maxMs: tail ? round2(tail.maxMs) : 0
    },
    textContentReadMs: sc.light ? null : round2(median(txt || [])),
    insertMode: cdpChars > 0 ? (execChars > 0 ? 'cdp+exec' : 'cdp') : 'exec'
  }

  if (!ipc.ok) localNotes.push(sc.id + ' 警告：updateIpc 有失败返回（主进程没吃下 patch）')
  if (under && !under.ok) localNotes.push(sc.id + ' 警告：updateIpcUnderFlush 有失败返回')
  localNotes.push(sc.id + ' 安静窗口 updateIpcMs=' + result.updateIpcMs +
    'ms vs 写盘在飞时 updateIpcUnderFlushMs=' + result.updateIpcUnderFlushMs +
    'ms（比值 ' + (result.updateIpcMs > 0
      ? round2(result.updateIpcUnderFlushMs / result.updateIpcMs)
      : 0) + '×）—— 这是「落盘是否让按键排队」的直接判据。')
  if (flushFirst && !flushFirst.ok) localNotes.push(sc.id + ' 警告：flush(前) 有失败返回（落盘未成功）')
  if (flushEnd && !flushEnd.ok) localNotes.push(sc.id + ' 警告：flush(后) 有失败返回（落盘未成功）')
  if (tailPath && !tailPath.ok) localNotes.push(sc.id + ' 警告：tailPath 复刻里有失败返回')
  if (voided > 0) localNotes.push(sc.id + ' 警告：' + voided + ' 次按键作废（未落字）')
  localNotes.push(sc.id + ' 停手 180ms 那条路实测 ' + result.tailPathMs +
    'ms（3 次整克隆 + 1 次全量 sync IPC）；只算 2 次克隆的 serializePairMs=' +
    result.serializePairMs + 'ms，单次克隆代理 ' + result.serializeProxyMs +
    'ms —— 逐次克隆的净成本：第2次 +' +
    round2(result.serializePairMs - result.serializeProxyMs) + 'ms，第3次 +' +
    round2(result.tailPathMs - result.serializePairMs) + 'ms（含 IPC）。')
  localNotes.push(sc.id + ' 停手后渲染层长任务：' + result.tailLongTask.count + ' 个，最长 ' +
    result.tailLongTask.maxMs + 'ms，合计 ' + result.tailLongTask.totalMs + 'ms。')
  localNotes.push(sc.id + ' flush 前/后对比：' + result.flushMs + 'ms（前，样本 ' +
    JSON.stringify(result.flushSamplesFirst) + '）vs ' + result.flushMsEndMs + 'ms（后，样本 ' +
    JSON.stringify(result.flushSamplesEnd) + '）→ 前后差 ' +
    round2(result.flushMsEndMs - result.flushMs) + 'ms。')
  localNotes.push(sc.id + ' updateIpcUnderFlush：中位 ' + result.updateIpcUnderFlushMs +
    'ms / 最大 ' + result.updateIpcUnderFlushMaxMs + 'ms（固定相位 +' +
    result.updateIpcUnderFlushPhaseMs + 'ms，5 样本）—— 这是「停顿后第 1 个按键」的**典型值**，不是写入峰值。')
  localNotes.push(sc.id + ' 采样：inputHandler ' + snap.inputMs.length + ' 个样本，' +
    'cdpMs ' + cdpMs.length + ' 个，打字总耗时 ' + typingMs + 'ms → 实测键速 ' +
    keysPerSec + ' 键/秒（名义间隔 ' + gapMs + 'ms，真实节拍被单键阻塞 + CDP 往返拉长），' +
    'inserted=' + result.inserted + '（cdp ' + cdpChars + ' / exec ' + execChars + '）')
  if (snap.ltCount === 0) {
    localNotes.push(sc.id + ' 按键窗口 longtask 为 0 次：说明单次按键阻塞都短于 50ms 阈值（不是没测到）。')
  }

  log(sc.id + ' 分项：updateIpc=' + result.updateIpcMs + 'ms serializeProxy=' +
    result.serializeProxyMs + 'ms serializePair=' + result.serializePairMs +
    'ms tailPath=' + result.tailPathMs + 'ms innerHtmlRead=' + result.innerHtmlReadMs +
    'ms textContentRead=' + result.textContentReadMs +
    'ms flush(前)=' + result.flushMs + 'ms flush(后)=' + result.flushMsEndMs +
    'ms | 按键窗口 LT ' + snap.ltCount + '/' + round2(snap.ltTotal) +
    'ms | 停手后 LT ' + result.tailLongTask.count + '/' + result.tailLongTask.maxMs + 'ms' +
    ' | 键速 ' + keysPerSec + '/s')

  return { result, notes: localNotes, keysOk: voided === 0 }
}

main().catch((err) => {
  console.error('[perf] 致命错误:', err && err.stack ? err.stack : err)
  process.exit(1)
})
