'use strict'
/**
 * Electron 端到端测试：Markdown 实时预览 + 纯源码模式 + KaTeX LaTeX 公式 + 搜索预览统计 + 纯文本粘贴 + 外链/CSP 安全
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getFreePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => resolve(addr.port))
    })
  })
}

async function waitFor (fn, timeoutMs = 10000, stepMs = 50, label = 'condition') {
  const start = Date.now()
  let lastErr = null
  while (Date.now() - start < timeoutMs) {
    try {
      const val = await fn()
      if (val) return val
    } catch (err) {
      lastErr = err
    }
    await sleep(stepMs)
  }
  throw new Error(`Timeout waiting for ${label} (${timeoutMs}ms)${lastErr ? ': ' + lastErr.message : ''}`)
}

function connectCdp (wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()
    const eventHandlers = new Set()

    ws.addEventListener('open', () => {
      resolve({
        send (method, params = {}) {
          const id = nextId++
          return new Promise((res, rej) => {
            pending.set(id, { res, rej })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        async eval (expr, { awaitPromise = true, userGesture = false } = {}) {
          const out = await this.send('Runtime.evaluate', {
            expression: expr,
            returnByValue: true,
            awaitPromise,
            userGesture
          })
          if (out.exceptionDetails) {
            const desc = (out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text || 'Eval error'
            throw new Error(desc)
          }
          return out.result ? out.result.value : undefined
        },
        onEvent (fn) {
          eventHandlers.add(fn)
          return () => eventHandlers.delete(fn)
        },
        close () {
          try { ws.close() } catch (_) {}
        }
      })
    })
    ws.addEventListener('error', err => reject(err))
    ws.addEventListener('message', ev => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch (_) { return }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message || 'CDP error'))
        else res(msg.result)
      } else if (msg.method) {
        for (const h of eventHandlers) {
          try { h(msg) } catch (_) {}
        }
      }
    })
  })
}

function attachPageMonitor (cdp, name, errorBag) {
  cdp.onEvent(msg => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const det = msg.params && msg.params.exceptionDetails
      const text = (det && ((det.exception && det.exception.description) || det.text)) || 'Runtime.exceptionThrown'
      errorBag.push(`[${name}] exception: ${text}`)
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
      const args = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ')
      errorBag.push(`[${name}] console.error: ${args}`)
    } else if (msg.method === 'Log.entryAdded' && msg.params && msg.params.entry) {
      const entry = msg.params.entry
      if (entry.level === 'error' || entry.source === 'security') {
        errorBag.push(`[${name}] log(${entry.source}/${entry.level}): ${entry.text}`)
      }
    }
  })
}

async function listTargets (cdpPort) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json`)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

async function openTargetByPredicate (cdpPort, pred, errorBag, label) {
  const target = await waitFor(async () => {
    const list = await listTargets(cdpPort)
    return list.find(pred)
  }, 12000, 80, label)
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')
  attachPageMonitor(cdp, label, errorBag)
  await cdp.eval(`document.readyState === 'complete' || new Promise(r => window.addEventListener('load', r, { once: true }))`)
  return cdp
}

async function clickEl (cdp, selector, { ctrl = false } = {}) {
  const rect = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`)
  assert.ok(rect && rect.w > 0 && rect.h > 0, `Element should be visible: ${selector}`)
  const modifiers = ctrl ? 2 : 0
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers })
  return rect
}

async function sendKey (cdp, key, code, windowsVirtualKeyCode, { ctrl = false, shift = false, charText = null } = {}) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0)
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, modifiers })
  if (charText !== null || (key.length === 1 && !ctrl)) {
    const text = charText !== null ? charText : key
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text, unmodifiedText: text, key, code, windowsVirtualKeyCode, modifiers })
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
}

function relativeLuminance (rgbStr) {
  const m = String(rgbStr).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!m) return 0
  const chans = [Number(m[1]), Number(m[2]), Number(m[3])].map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * chans[0] + 0.7152 * chans[1] + 0.0722 * chans[2]
}

function contrastRatio (rgb1, rgb2) {
  const l1 = relativeLuminance(rgb1)
  const l2 = relativeLuminance(rgb2)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

async function main () {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-e2e-md-'))
  const cdpPort = await getFreePort()
  const now = Date.now()

  const seed = {
    version: 4,
    notes: [
      {
        id: 'note-md-1',
        title: '实时预览测试便签',
        html: '<p><br></p>',
        color: '#FFF3B0',
        dark: false,
        mode: 'edit',
        pinned: false,
        visible: true,
        bounds: { x: 100, y: 80, width: 400, height: 540 },
        createdAt: now - 10000,
        updatedAt: now - 10000
      },
      {
        id: 'note-md-2',
        title: '物理与微积分',
        html: '<p>爱因斯坦质能方程 <span class="math-inline" contenteditable="false" data-tex="E = mc^2" data-delim="$"><span class="math-body"></span></span> 非常重要。</p>',
        preview: '爱因斯坦质能方程 [公式] 非常重要。',
        color: '#D7F9F1',
        dark: false,
        mode: 'read',
        pinned: false,
        visible: false,
        bounds: { x: 540, y: 80, width: 400, height: 500 },
        createdAt: now - 20000,
        updatedAt: now - 20000
      }
    ],
    archived: [],
    settings: { autoLaunch: false }
  }
  const storePath = path.join(userData, 'sticky-notes.json')
  fs.writeFileSync(storePath, JSON.stringify(seed))

  const env = { ...process.env, STICKY_E2E: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS

  let child = null
  const pageErrors = []
  let mainCdp = null
  let noteCdp = null
  let dashCdp = null

  try {
    child = spawn(ELECTRON, ['--user-data-dir=' + userData, '--remote-debugging-port=' + cdpPort, '--inspect=0', '.'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdoutText = ''
    let stderrText = ''
    child.stdout.on('data', chunk => { stdoutText += chunk.toString('utf8') })
    child.stderr.on('data', chunk => {
      stderrText += chunk.toString('utf8')
    })

    const inspectWsUrl = await waitFor(() => {
      const m = stderrText.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)
      return m ? m[1] : null
    }, 10000, 50, 'main inspect URL')

    mainCdp = await connectCdp(inspectWsUrl)
    await mainCdp.send('Runtime.enable')
    await waitFor(() => mainCdp.eval(`!!globalThis.__stickyTestHooks`), 10000, 40, '__stickyTestHooks ready')
    await mainCdp.eval(`(() => {
      const mod = process.getBuiltinModule('module');
      const req = mod.createRequire(process.cwd() + '/main.js');
      const electron = req('electron');
      globalThis.__e2eElectron = electron;
      globalThis.__e2eOpenedUrls = [];
      electron.shell.openExternal = async (url) => {
        globalThis.__e2eOpenedUrls.push(String(url));
        return undefined;
      };
      return electron.app.getPath('userData');
    })()`)

    noteCdp = await openTargetByPredicate(
      cdpPort,
      t => t.type === 'page' && String(t.url || '').includes('note.html'),
      pageErrors,
      'note.html'
    )
    await noteCdp.eval(`waitReady = (async () => {
      const t0 = Date.now();
      while (!document.getElementById('editor') || !window.setMode) {
        if (Date.now() - t0 > 5000) throw new Error('note init timeout');
        await new Promise(r => setTimeout(r, 30));
      }
      return true;
    })()`)

    // ─── T1: 默认 400px 宽度布局不裁切 ───
    const layoutInfo = await noteCdp.eval(`(() => {
      const w = window.innerWidth;
      const srcBtn = document.getElementById('sourceToggle');
      const mathBtn = document.querySelector('[data-act="math"]');
      const rSrc = srcBtn ? srcBtn.getBoundingClientRect() : null;
      const rMath = mathBtn ? mathBtn.getBoundingClientRect() : null;
      return {
        w,
        mode: document.getElementById('note').dataset.mode,
        srcVisible: !!(rSrc && rSrc.width > 0 && rSrc.height > 0 && rSrc.right <= w + 1),
        mathVisible: !!(rMath && rMath.width > 0 && rMath.height > 0 && rMath.right <= w + 1)
      };
    })()`)
    assert.equal(layoutInfo.mode, 'edit')
    assert.ok(layoutInfo.w <= 420, `Expected default compact width, got ${layoutInfo.w}`)
    assert.equal(layoutInfo.srcVisible, true, '400px 宽度下 #sourceToggle 不应被裁切')
    assert.equal(layoutInfo.mathVisible, true, '400px 宽度下 Σ 公式按钮不应被裁切')
    console.log('✓ T1: 400px toolbar & #sourceToggle visible without clipping')

    // ─── T2: Obsidian 实时预览：输入/回车编译/离开渲染/点击与公式点击展开/零改动不脏保存/护栏 ───
    await clickEl(noteCdp, '#editor')
    await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      ed.innerHTML = '<p><br></p>';
      const range = document.createRange();
      range.setStart(ed.firstChild, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    })()`)
    await noteCdp.send('Input.insertText', { text: '# 实时标题' })
    await sendKey(noteCdp, 'Enter', 'Enter', 13)
    await noteCdp.send('Input.insertText', { text: '公式 $a_1 * b_2$，花费 $10 到 $20，标识 foo_bar_baz' })
    await sendKey(noteCdp, 'Enter', 'Enter', 13)
    await noteCdp.send('Input.insertText', { text: '- [ ] 勾选待办' })
    await sendKey(noteCdp, 'Enter', 'Enter', 13)
    await noteCdp.send('Input.insertText', { text: '普通纯文本段落' })
    // 离开正在编辑的行以触发最后一段（纯文本应原样保持不重写）
    await noteCdp.eval(`document.getElementById('editor').blur()`)
    await sleep(120)

    const compiled = await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      return {
        h1: Array.from(ed.querySelectorAll('h1')).map(n => n.textContent.trim()),
        mathTex: Array.from(ed.querySelectorAll('.math-inline')).map(n => n.getAttribute('data-tex')),
        katexCount: ed.querySelectorAll('.math-inline .katex').length,
        checkboxCount: ed.querySelectorAll('input[type="checkbox"]').length,
        hasMoneyLiteral: ed.textContent.includes('$10 到 $20'),
        hasSnakeLiteral: ed.textContent.includes('foo_bar_baz'),
        hasEmInPlain: Array.from(ed.querySelectorAll('em')).some(e => e.textContent.includes('bar'))
      };
    })()`)
    assert.deepEqual(compiled.h1, ['实时标题'])
    assert.deepEqual(compiled.mathTex, ['a_1 * b_2'])
    assert.equal(compiled.katexCount, 1)
    assert.ok(compiled.checkboxCount >= 1)
    assert.equal(compiled.hasMoneyLiteral, true)
    assert.equal(compiled.hasSnakeLiteral, true)
    assert.equal(compiled.hasEmInPlain, false)

    // 等一次自动保存完成后，测试“点击公式展开 -> 不改动离开”不触发脏保存
    await waitFor(async () => {
      const txt = await noteCdp.eval(`document.getElementById('saved').textContent`)
      return txt && txt.startsWith('已保存') ? txt : null
    }, 4000, 50, 'saved after T2')
    await noteCdp.eval(`window.flushSave()`)
    const updatedAtBefore = await waitFor(() => {
      try {
        const d = JSON.parse(fs.readFileSync(storePath, 'utf8'))
        const n = d.notes.find(x => x.id === 'note-md-1')
        return n && n.html.includes('a_1 * b_2') ? n.updatedAt : null
      } catch (_) { return null }
    }, 3000, 50, 'disk updatedAtBefore')

    // 点击已渲染的 .math-inline -> 展开为 .md-raw 源码
    await clickEl(noteCdp, '#editor .math-inline')
    await sleep(60)
    const revealedMath = await noteCdp.eval(`(() => {
      const raw = document.querySelector('#editor .md-raw');
      return raw ? raw.textContent : null;
    })()`)
    assert.ok(revealedMath && revealedMath.includes('$a_1 * b_2$'), `Expected revealed math source, got: ${revealedMath}`)

    // 不修改直接离开 -> 重新渲染且不触发脏保存（等待超过 350ms 防抖窗口）
    await clickEl(noteCdp, '#editor h1')
    await sleep(60)
    await noteCdp.eval(`document.getElementById('editor').blur()`)
    await sleep(500)
    const afterNoEditLeave = await noteCdp.eval(`({
      rawCount: document.querySelectorAll('#editor .md-raw').length,
      katexCount: document.querySelectorAll('#editor .math-inline .katex').length,
      saved: document.getElementById('saved').textContent
    })`)
    const diskAfterNoEdit = JSON.parse(fs.readFileSync(storePath, 'utf8')).notes.find(x => x.id === 'note-md-1')
    assert.equal(afterNoEditLeave.rawCount, 0)
    assert.equal(afterNoEditLeave.katexCount, 1)
    assert.ok(afterNoEditLeave.saved.startsWith('已保存'), `未修改离开块不得变为未保存，实际: ${afterNoEditLeave.saved}`)
    assert.equal(diskAfterNoEdit.updatedAt, updatedAtBefore, '未修改离开块不得触发新的脏写盘')

    // 点击复选框不触发展开
    await clickEl(noteCdp, '#editor input[type="checkbox"]')
    await sleep(60)
    const afterCheckbox = await noteCdp.eval(`({
      checked: !!document.querySelector('#editor input[type="checkbox"]').checked,
      rawCount: document.querySelectorAll('#editor .md-raw').length
    })`)
    assert.equal(afterCheckbox.checked, true)
    assert.equal(afterCheckbox.rawCount, 0, '点击任务复选框不得触发 Markdown 源码展开')

    // 纯文本段落原生撤销保留验证
    await clickEl(noteCdp, '#editor p:last-of-type')
    await sleep(50)
    await noteCdp.send('Input.insertText', { text: ' 追加词' })
    await sleep(40)
    await sendKey(noteCdp, 'z', 'KeyZ', 90, { ctrl: true })
    await sleep(60)
    const plainAfterUndo = await noteCdp.eval(`document.querySelector('#editor p:last-of-type').textContent`)
    assert.equal(plainAfterUndo.includes('追加词'), false, '纯文本段落应保留浏览器原生 Ctrl+Z 撤销')

    // 多块鼠标拖拽选区保持渲染态（不展开 .md-raw）
    const dragPts = await noteCdp.eval(`(() => {
      const hEl = document.querySelector('#editor h1');
      const pEl = document.querySelector('#editor p:last-of-type');
      hEl.scrollIntoView({ block: 'nearest' });
      const h = hEl.getBoundingClientRect();
      const p = pEl.getBoundingClientRect();
      return { x1: h.left + 8, y1: h.top + h.height / 2, x2: p.left + 30, y2: p.top + p.height / 2 };
    })()`)
    await noteCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragPts.x1, y: dragPts.y1 })
    await noteCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragPts.x1, y: dragPts.y1, button: 'left', clickCount: 1 })
    for (let s = 1; s <= 5; s++) {
      const mx = dragPts.x1 + ((dragPts.x2 - dragPts.x1) * s) / 5
      const my = dragPts.y1 + ((dragPts.y2 - dragPts.y1) * s) / 5
      await noteCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my, button: 'left', buttons: 1 })
    }
    const rawDuringDrag = await noteCdp.eval(`document.querySelectorAll('#editor .md-raw').length`)
    await noteCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragPts.x2, y: dragPts.y2, button: 'left', clickCount: 1 })
    await sleep(60)
    const afterDrag = await noteCdp.eval(`({
      rawCount: document.querySelectorAll('#editor .md-raw').length,
      selLen: window.getSelection().toString().length
    })`)
    assert.equal(rawDuringDrag, 0, '拖拽过程中不得展开块源码')
    assert.equal(afterDrag.rawCount, 0, '跨块拖拽选区完成后应保持渲染态')
    assert.ok(afterDrag.selLen > 0)
    console.log('✓ T2: Live Preview compile/reveal/guards passed')

    // ─── T3: 全文档 Markdown 源码模式切换、无损往返、次级操作路由与 AI 工具栏禁用 ───
    await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      ed.innerHTML = '<p>保留 <u>下划线</u> 与 <span style="color:#E53935">红色文字</span></p>' +
        '<div class="mmd" contenteditable="false" data-code="graph TD; A-->B;"><div class="mmd-tools"><button type="button" data-mmd="edit">✎</button><button type="button" data-mmd="del">✕</button></div><div class="mmd-body"></div></div>' +
        '<div class="math-block" contenteditable="false" data-tex="x^2 + y^2 = z^2" data-delim="$$"><div class="math-body"></div></div>';
      window.onEditorChanged();
    })()`)
    await sleep(60)

    await clickEl(noteCdp, '#sourceToggle')
    await sleep(60)
    const inSource1 = await noteCdp.eval(`({
      view: document.getElementById('note').dataset.view,
      activeId: document.activeElement && document.activeElement.id,
      val: document.getElementById('sourceEditor').value
    })`)
    assert.equal(inSource1.view, 'source')
    assert.equal(inSource1.activeId, 'sourceEditor')
    assert.ok(inSource1.val.includes('<u>下划线</u>'))
    assert.ok(inSource1.val.includes('color:#E53935'))
    assert.ok(inSource1.val.includes('```mermaid'))
    assert.ok(inSource1.val.includes('$$'))

    // Ctrl+Shift+M 切回实时预览，验证无损往返
    await sendKey(noteCdp, 'M', 'KeyM', 77, { ctrl: true, shift: true })
    await sleep(80)
    const roundTripped = await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      return {
        view: document.getElementById('note').dataset.view || '',
        hasU: !!ed.querySelector('u'),
        hasColor: !!ed.querySelector('[style*="#E53935"], [style*="rgb(229, 57, 53)"]'),
        hasMmd: !!ed.querySelector('.mmd[data-code*="graph TD"]'),
        hasMath: !!ed.querySelector('.math-block[data-tex="x^2 + y^2 = z^2"] .katex')
      };
    })()`)
    assert.equal(roundTripped.view, '')
    assert.equal(roundTripped.hasU, true)
    assert.equal(roundTripped.hasColor, true)
    assert.equal(roundTripped.hasMmd, true)
    assert.equal(roundTripped.hasMath, true)

    // Ctrl+Shift+M 再次进入源码模式，测试工具栏格式化 & __aiInsertText 路由 & AI 浮窗禁用
    await sendKey(noteCdp, 'M', 'KeyM', 77, { ctrl: true, shift: true })
    await sleep(60)
    await noteCdp.eval(`(() => {
      const se = document.getElementById('sourceEditor');
      se.focus();
      const idx = se.value.length;
      se.setSelectionRange(idx, idx);
      window.__aiInsertText('AI追加文本');
    })()`)
    await clickEl(noteCdp, '[data-cmd="bold"]')
    const seDrag = await noteCdp.eval(`(() => {
      const se = document.getElementById('sourceEditor');
      se.focus();
      const r = se.getBoundingClientRect();
      return { x1: r.left + 8, y1: r.top + 12, x2: r.left + Math.min(180, r.width - 12), y2: r.top + 12 };
    })()`)
    await noteCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seDrag.x1, y: seDrag.y1 })
    await noteCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: seDrag.x1, y: seDrag.y1, button: 'left', clickCount: 1 })
    await noteCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seDrag.x2, y: seDrag.y2, button: 'left', buttons: 1 })
    await noteCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: seDrag.x2, y: seDrag.y2, button: 'left', clickCount: 1 })
    await sendKey(noteCdp, 'ArrowRight', 'ArrowRight', 39, { shift: true })
    await noteCdp.eval(`(() => {
      const se = document.getElementById('sourceEditor');
      se.focus();
      se.setSelectionRange(0, Math.min(10, se.value.length));
      se.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    })()`)
    await sleep(180)
    const srcRouted = await noteCdp.eval(`(() => {
      const se = document.getElementById('sourceEditor');
      const aiPop = document.querySelector('.ai-bar');
      const popVisible = !!(aiPop && !aiPop.hidden && getComputedStyle(aiPop).display !== 'none' && getComputedStyle(aiPop).visibility !== 'hidden');
      return { val: se.value, popVisible };
    })()`)
    assert.ok(srcRouted.val.includes('AI追加文本'))
    assert.ok(srcRouted.val.includes('**粗体文字**'), `Expected **粗体文字**, got:\n${srcRouted.val}`)
    assert.equal(srcRouted.popVisible, false, '全源码模式下 AI 浮动工具栏应禁用')

    await sendKey(noteCdp, 'M', 'KeyM', 77, { ctrl: true, shift: true })
    await sleep(60)
    console.log('✓ T3: Full Source toggle, lossless round-trip, secondary routing & AI bar guard passed')

    // ─── T4: Σ 公式弹窗、宽公式横向滚动、暗/亮主题 .katex-error 对比度、复制去重 ───
    await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      ed.innerHTML = '<p>测试公式拷贝 <span class="math-inline" contenteditable="false" data-tex="E = mc^2" data-delim="$"><span class="math-body"></span></span> 结束</p>';
      window.onEditorChanged();
      const range = document.createRange();
      range.setStart(ed.firstChild, ed.firstChild.childNodes.length);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    })()`)
    await clickEl(noteCdp, '[data-act="math"]')
    await sleep(50)
    await clickEl(noteCdp, '[data-math-mode="block"]')
    await clickEl(noteCdp, '[data-math-tpl^="\\\\frac"]')
    await sleep(50)
    const modalPreviewCount = await noteCdp.eval(`document.querySelectorAll('#mathPreview .katex').length`)
    assert.ok(modalPreviewCount >= 1, '公式弹窗应实时预览 KaTeX')

    await noteCdp.eval(`(() => {
      const ta = document.getElementById('mathCode');
      ta.focus();
      ta.value = '\\\\begin{aligned}a_1+a_2+a_3+a_4+a_5+a_6+a_7+a_8+a_9+a_{10} &= b_1+b_2+b_3+b_4+b_5+b_6+b_7+b_8+b_9+b_{10}\\\\end{aligned}';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await sendKey(noteCdp, 'Enter', 'Enter', 13, { ctrl: true })
    await sleep(80)

    const blockCheck = await noteCdp.eval(`(() => {
      const modal = document.getElementById('mathModal');
      const blk = document.querySelector('#editor .math-block');
      const cs = blk ? getComputedStyle(blk) : null;
      return {
        modalHidden: !!modal.hidden,
        hasKatex: !!(blk && blk.querySelector('.katex')),
        overflowX: cs ? cs.overflowX : '',
        pageScrollW: document.documentElement.scrollWidth,
        winW: window.innerWidth
      };
    })()`)
    assert.equal(blockCheck.modalHidden, true, 'Ctrl+Enter 应关闭公式弹窗并插入')
    assert.equal(blockCheck.hasKatex, true)
    assert.equal(blockCheck.overflowX, 'auto')
    assert.ok(blockCheck.pageScrollW <= blockCheck.winW + 2, '超宽块级公式不应撑破便签窗口横向滚动条')

    // 复制去重验证（跨块选中渲染态行内公式 + 块级公式，发送真实 Ctrl+C 写入系统剪贴板）
    const prevClip = await mainCdp.eval(`globalThis.__e2eElectron.clipboard.readText()`)
    await mainCdp.eval(`globalThis.__e2eElectron.clipboard.writeText('__E2E_CLIP_SENTINEL__')`)
    await noteCdp.send('Page.bringToFront')
    const selDbg = await noteCdp.eval(`(() => {
      window.__e2eCopySaw = null;
      document.getElementById('editor').addEventListener('copy', (e) => {
        window.__e2eCopySaw = {
          defaultPrevented: e.defaultPrevented,
          hasClipboard: !!e.clipboardData
        };
      }, { once: true });
      const ed = document.getElementById('editor');
      let tail = Array.from(ed.children).find(el => el.tagName === 'P' && el.textContent.includes('尾段'));
      if (!tail) {
        tail = document.createElement('p');
        tail.textContent = '尾段';
        ed.appendChild(tail);
      }
      ed.focus();
      const p = Array.from(ed.children).find(el => el.tagName === 'P' && el.textContent.includes('测试公式拷贝'));
      const firstBlock = ed.firstElementChild;
      const range = document.createRange();
      const startNode = (firstBlock && firstBlock !== p && p) ? p : firstBlock;
      if (p && firstBlock !== p) {
        ed.insertBefore(p, firstBlock);
      }
      range.setStart(p.firstChild, 0);
      range.setEnd(tail.firstChild, tail.firstChild.textContent.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return { hasFocus: document.hasFocus(), collapsed: sel.isCollapsed, rangeTextLen: range.toString().length, childrenTags: Array.from(ed.children).map(c => c.tagName + '.' + c.className) };
    })()`)
    await mainCdp.eval(`(() => {
      const wins = globalThis.__e2eElectron.BrowserWindow.getAllWindows();
      const nw = wins.find(w => w.webContents.getURL().includes('note.html'));
      if (nw) { nw.focus(); nw.webContents.copy(); }
      return !!nw;
    })()`)
    await sleep(100)
    const copySaw = await noteCdp.eval(`window.__e2eCopySaw`)
    const copiedText = await mainCdp.eval(`globalThis.__e2eElectron.clipboard.readText()`)
    try { await mainCdp.eval(`globalThis.__e2eElectron.clipboard.writeText(${JSON.stringify(prevClip || '')})`) } catch (_) {}
    assert.notEqual(copiedText, '__E2E_CLIP_SENTINEL__', `Ctrl+C 应写入剪贴板, selDbg=${JSON.stringify(selDbg)}, copySaw=${JSON.stringify(copySaw)}`)
    assert.ok(copiedText.includes('测试公式拷贝 $E = mc^2$ 结束'), `复制结果应还原唯一 $...$ 源码，实际为: ${copiedText}`)
    assert.equal(copiedText.split('$E = mc^2$').length - 1, 1, `行内公式不得重复，实际为: ${copiedText}`)
    assert.ok(copiedText.includes('$$'), `块级公式应还原 $$...$$ 源码，实际为: ${copiedText}`)
    assert.equal(copiedText.includes('mc2'), false, `复制结果不得含 KaTeX HTML/MathML 拼接乱码: ${copiedText}`)

    // 暗/亮主题 + .katex-error 可读对比度检查
    await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      ed.innerHTML = window.StickyMarkdown.parseNoteMarkdown('错式 $\\\\frac{1}{$ 正常 $x^2$');
      window.StickyMarkdown.renderMathInElement(ed, window.katex);
      window.onEditorChanged();
      document.getElementById('note').dataset.dark = '1';
      document.getElementById('note').style.setProperty('--bg', '#2C2E33');
    })()`)
    await sleep(60)
    const darkColors = await noteCdp.eval(`(() => {
      const err = document.querySelector('#editor .katex-error');
      const ok = document.querySelector('#editor .katex .mord');
      return {
        errColor: err ? getComputedStyle(err).color : null,
        okColor: ok ? getComputedStyle(ok).color : null,
        bg: getComputedStyle(document.getElementById('note')).backgroundColor
      };
    })()`)
    assert.ok(darkColors.errColor, '应渲染出 .katex-error 节点')
    const errContrast = contrastRatio(darkColors.errColor, 'rgb(44, 46, 51)')
    assert.ok(errContrast >= 4.5, `暗色主题 .katex-error 对比度应 >= 4.5，当前 color=${darkColors.errColor}, ratio=${errContrast.toFixed(2)}`)
    // 恢复亮色主题
    await noteCdp.eval(`(() => {
      document.getElementById('note').dataset.dark = '0';
      document.getElementById('note').style.setProperty('--bg', '#FFF3B0');
    })()`)
    console.log('✓ T4: Math modal, wide scroll, copy de-duplication, and dark/light .katex-error contrast passed')

    // ─── T5: 外链图片降级、read 模式禁用展开、外部链接 shell.openExternal ───
    await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      ed.innerHTML = window.StickyMarkdown.parseNoteMarkdown('[访问文档](https://example.com/docs) ![外图](https://example.com/pic.png)');
      window.onEditorChanged();
    })()`)
    await sleep(80)
    const extCheck = await noteCdp.eval(`({
      imgs: document.querySelectorAll('#editor img').length,
      links: Array.from(document.querySelectorAll('#editor a')).map(a => a.getAttribute('href'))
    })`)
    assert.equal(extCheck.imgs, 0, '外链 http(s) 图片不得渲染为 <img>')
    assert.ok(extCheck.links.includes('https://example.com/docs'))
    assert.ok(extCheck.links.includes('https://example.com/pic.png'))

    await noteCdp.eval(`window.setMode('read')`)
    await sleep(60)
    const readClickRaw = await noteCdp.eval(`(() => {
      document.querySelector('#editor p').click();
      return document.querySelectorAll('#editor .md-raw').length;
    })()`)
    assert.equal(readClickRaw, 0, 'read 模式下点击不得触发展开')

    const winCountBeforeLink = await mainCdp.eval(`globalThis.__e2eElectron.BrowserWindow.getAllWindows().length`)
    await clickEl(noteCdp, '#editor a[href="https://example.com/docs"]')
    await sleep(120)
    const openedUrls = await mainCdp.eval(`globalThis.__e2eOpenedUrls.slice()`)
    const winCountAfterLink = await mainCdp.eval(`globalThis.__e2eElectron.BrowserWindow.getAllWindows().length`)
    assert.ok(openedUrls.includes('https://example.com/docs'), `应调用 shell.openExternal，实际: ${JSON.stringify(openedUrls)}`)
    assert.equal(winCountAfterLink, winCountBeforeLink, '点击外部链接不得打开新的 Electron 窗口')

    await noteCdp.eval(`window.setMode('edit')`)
    await sleep(60)
    console.log('✓ T5: External img downgrade, read-mode disable, and shell.openExternal passed')

    // ─── T6: 纯文本粘贴自动渲染 + 1 步撤销 + 误触发护栏 + <pre> 跳过 ───
    await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      ed.innerHTML = '<p>起点</p><p><br></p>';
      const p = ed.lastElementChild;
      const range = document.createRange();
      range.setStart(p, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      ed.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', '# 粘贴标题\\n\\n公式 $x^2 + y^2$');
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      ed.dispatchEvent(ev);
    })()`)
    await sleep(80)
    const pastedState = await noteCdp.eval(`({
      h1: !!document.querySelector('#editor h1'),
      katex: !!document.querySelector('#editor .math-inline .katex')
    })`)
    assert.equal(pastedState.h1, true, '粘贴纯文本 Markdown 标题应自动渲染')
    assert.equal(pastedState.katex, true, '粘贴纯文本 LaTeX 应自动渲染')

    // 1 步撤销
    await noteCdp.eval(`document.execCommand('undo')`)
    await sleep(60)
    const afterPasteUndo = await noteCdp.eval(`({
      h1: document.querySelectorAll('#editor h1').length,
      katex: document.querySelectorAll('#editor .math-inline .katex').length
    })`)
    assert.equal(afterPasteUndo.h1, 0, '粘贴自动渲染应支持 1 步 Ctrl+Z 撤销')
    assert.equal(afterPasteUndo.katex, 0)

    // 误触发护栏：$5.99, $10-$20, foo_bar_baz, JSON, Windows路径, 日期，及 <pre> 内跳过
    const guardPasteResult = await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      ed.innerHTML = '<p><br></p><pre><code>inside_code</code></pre>';
      const p = ed.firstElementChild;
      const samples = ['$5.99', '$10-$20', 'foo_bar_baz', '{"a":1}', 'C:\\\\Users\\\\alice\\\\test.txt', '2026-11-23'];
      for (const s of samples) {
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ed.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', s + ' ');
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        ed.dispatchEvent(ev);
        if (!ev.defaultPrevented) {
          document.execCommand('insertText', false, s + ' ');
        }
      }
      // 在 <pre><code> 内粘贴 # title 不应渲染出 <h1>
      const code = ed.querySelector('pre code');
      const r2 = document.createRange();
      r2.setStart(code.firstChild, 0);
      r2.collapse(true);
      const sel2 = window.getSelection();
      sel2.removeAllRanges();
      sel2.addRange(r2);
      const dt2 = new DataTransfer();
      dt2.setData('text/plain', '# not_a_heading');
      const ev2 = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt2 });
      ed.dispatchEvent(ev2);
      return {
        mathCount: ed.querySelectorAll('.math-inline, .math-block').length,
        emCount: ed.querySelectorAll('em').length,
        h1Count: ed.querySelectorAll('h1').length
      };
    })()`)
    assert.equal(guardPasteResult.mathCount, 0)
    assert.equal(guardPasteResult.emCount, 0)
    assert.equal(guardPasteResult.h1Count, 0)
    console.log('✓ T6: Plain-text paste auto-render, 1-step undo & false-positive/code guards passed')

    // ─── T7: 字数与公式数分离统计 + Dashboard 忽略空格公式搜索 & 卡片预览 ───
    await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      ed.innerHTML = '<p>纯字四字</p>';
      window.onEditorChanged();
    })()`)
    const statsNoMath = await waitFor(async () => {
      const s = await noteCdp.eval(`document.getElementById('stats').textContent`)
      return s === '4 字' ? s : null
    }, 2000, 40, 'stats without math === 4 字 (was: ' + await noteCdp.eval(`JSON.stringify(document.getElementById('stats').textContent)`) + ')')
    assert.equal(statsNoMath, '4 字')

    await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      ed.innerHTML = '<p>四字<span class="math-inline" contenteditable="false" data-tex="a^2 + b^2 = c^2" data-delim="$"><span class="math-body"></span></span>公式</p>';
      window.StickyMarkdown.renderMathInElement(ed, window.katex);
      window.onEditorChanged();
      window.flushSave();
    })()`)
    const statsWithMath = await waitFor(async () => {
      const s = await noteCdp.eval(`document.getElementById('stats').textContent`)
      return s === '4 字 · 1 公式' ? s : null
    }, 2000, 40, 'stats with math === 4 字 · 1 公式 (was: ' + await noteCdp.eval(`JSON.stringify(document.getElementById('stats').textContent)`) + ')')
    assert.equal(statsWithMath, '4 字 · 1 公式')

    // 打开 Dashboard 验证索引、卡片预览、空格不敏感搜索 E=mc^2
    await mainCdp.eval(`(() => {
      const hooks = globalThis.__stickyTestHooks;
      if (hooks && hooks.windows && typeof hooks.windows.openDashboard === 'function') {
        hooks.windows.openDashboard();
      }
      return true;
    })()`)
    dashCdp = await openTargetByPredicate(
      cdpPort,
      t => t.type === 'page' && String(t.url || '').includes('dashboard.html'),
      pageErrors,
      'dashboard.html'
    )
    await dashCdp.eval(`(async () => {
      const t0 = Date.now();
      while (!document.querySelector('#search') || !document.querySelector('.card')) {
        if (Date.now() - t0 > 5000) throw new Error('dashboard cards timeout');
        await new Promise(r => setTimeout(r, 40));
      }
      return true;
    })()`)
    const liveCard1Preview = await dashCdp.eval(`(() => {
      const cards = Array.from(document.querySelectorAll('.card'));
      const c1 = cards.find(c => (c.textContent || '').includes('实时预览测试便签'));
      return c1 ? (c1.querySelector('.preview') ? c1.querySelector('.preview').textContent : '') : null;
    })()`)
    assert.ok(liveCard1Preview && liveCard1Preview.includes('[公式]'), `实时保存的卡片预览应含 [公式]: ${liveCard1Preview}`)
    assert.equal(liveCard1Preview.includes('b^2'), false, '卡片预览不应泄露 KaTeX 源码或重复文本')

    await clickEl(dashCdp, '#search')
    await dashCdp.send('Input.insertText', { text: 'E=mc^2' })
    await sleep(220)
    const dashSearchResult = await dashCdp.eval(`(() => {
      const cards = Array.from(document.querySelectorAll('.card'));
      return cards.map(c => ({ title: c.textContent || '', preview: (c.querySelector('.preview') && c.querySelector('.preview').textContent) || '' }));
    })()`)
    assert.ok(
      dashSearchResult.some(c => c.title.includes('物理与微积分') && !c.title.includes('实时预览测试便签')),
      `搜索 "E=mc^2" 应精准命中 "$E = mc^2$" 的物理笔记，实际命中: ${JSON.stringify(dashSearchResult)}`
    )
    console.log('✓ T7: Stats math/char separation + Dashboard space-insensitive search & preview passed')

    // ─── T8: 实时编辑边界回归（空编辑器首行、含空行代码块、点击公式/弹窗更新、失焦块公式、<hr>、未改标题回车、复选框、IME、即时 flushSave、Ctrl+Click 外链） ───
    // 1) 空编辑器无子块直接键入 "# BlankH1" + Enter
    await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      ed.innerHTML = '';
      ed.focus();
      const r = document.createRange();
      r.selectNodeContents(ed);
      r.collapse(true);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    })()`)
    await noteCdp.send('Input.insertText', { text: '# BlankH1' })
    await sendKey(noteCdp, 'Enter', 'Enter', 13, { charText: '\r' })
    await waitFor(() => noteCdp.eval(`document.querySelector('#editor h1')?.textContent === 'BlankH1'`), 3000, 40, 'blank editor h1')

    // 2) 含空行的多行围栏代码块不会提前编译 **stay**
    await noteCdp.send('Input.insertText', { text: '```js' })
    await sendKey(noteCdp, 'Enter', 'Enter', 13, { charText: '\r' })
    await sendKey(noteCdp, 'Enter', 'Enter', 13, { charText: '\r' })
    await noteCdp.send('Input.insertText', { text: 'const k = **stay**' })
    await sendKey(noteCdp, 'Enter', 'Enter', 13, { charText: '\r' })
    assert.equal(await noteCdp.eval(`document.querySelectorAll('#editor strong').length`), 0)
    await noteCdp.send('Input.insertText', { text: '```' })
    await sendKey(noteCdp, 'Enter', 'Enter', 13, { charText: '\r' })
    await waitFor(() => noteCdp.eval(`Array.from(document.querySelectorAll('#editor pre code')).some(c => c.textContent.includes('const k = **stay**'))`), 3000, 40, 'fenced block across blank line')

    // 3) 渲染块交互：点击行内公式 -> Σ 弹窗改为 y^3 原地渲染；点击 <hr> 展开 ---；点击复选框折叠旧 .md-raw 并切换；失焦点击 .math-block；未改 h2 末尾回车
    await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      ed.innerHTML = '<p>Start <span class="math-inline" contenteditable="false" data-tex="x^2" data-delim="$"><span class="math-body"></span></span> End</p><hr><div class="math-block" contenteditable="false" data-tex="a+b=c" data-delim="$$"><div class="math-body"></div></div><ul><li data-task="1"><input type="checkbox" contenteditable="false"> TaskX</li></ul><h2>SubHead</h2><p>Link <a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">ExtDoc</a></p><p id="plainGuard">Plain guard</p>';
      window.StickyMarkdown.renderMathInElement(ed, window.katex);
      window.onEditorChanged();
    })()`)
    await clickEl(noteCdp, '#editor .math-inline')
    await waitFor(() => noteCdp.eval(`!!document.querySelector('#editor .md-raw')`), 3000, 40, 'inline math raw')
    await clickEl(noteCdp, '[data-act="math"]')
    await waitFor(() => noteCdp.eval(`!document.getElementById('mathModal').hidden && document.getElementById('mathCode').value === 'x^2'`), 3000, 40, 'math modal raw value')
    await noteCdp.eval(`(() => { const mc = document.getElementById('mathCode'); mc.value = 'y^3'; mc.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await clickEl(noteCdp, '[data-act="math-ok"]')
    await waitFor(() => noteCdp.eval(`document.getElementById('mathModal').hidden && !document.querySelector('#editor .md-raw') && !!document.querySelector('#editor .math-inline[data-tex="y^3"]')`), 3000, 40, 'math modal confirm in raw')

    await clickEl(noteCdp, '#editor hr')
    await waitFor(() => noteCdp.eval(`document.querySelector('#editor .md-raw')?.textContent === '---'`), 3000, 40, 'hr reveal')

    await clickEl(noteCdp, '#editor input[type="checkbox"]')
    await waitFor(() => noteCdp.eval(`!document.querySelector('#editor .md-raw') && document.querySelector('#editor input[type="checkbox"]').checked`), 3000, 40, 'checkbox collapses old raw')

    await noteCdp.eval(`document.activeElement && document.activeElement.blur()`)
    await clickEl(noteCdp, '#editor .math-block')
    await waitFor(() => noteCdp.eval(`document.querySelector('#editor .md-raw')?.textContent.includes('a+b=c')`), 3000, 40, 'blurred math-block reveal')
    await clickEl(noteCdp, '#plainGuard')
    await waitFor(() => noteCdp.eval(`!document.querySelector('#editor .md-raw') && !!document.querySelector('#editor .math-block[data-tex="a+b=c"]')`), 3000, 40, 'math-block collapse')

    await clickEl(noteCdp, '#editor h2')
    await waitFor(() => noteCdp.eval(`document.querySelector('#editor .md-raw')?.textContent === '## SubHead'`), 3000, 40, 'h2 raw')
    await sendKey(noteCdp, 'End', 'End', 35)
    await sendKey(noteCdp, 'Enter', 'Enter', 13, { charText: '\r' })
    await waitFor(() => noteCdp.eval(`!document.querySelector('#editor .md-raw') && document.querySelector('#editor h2')?.nextElementSibling?.tagName === 'P'`), 3000, 40, 'unedited h2 Enter creates trailing P')

    // 4) IME compositionstart 防误展开 & Ctrl+Click 编辑态外链不打开新 Electron 窗口 & <180ms 即时 flushSave
    const imeRaw = await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      const p = document.createElement('p');
      p.innerHTML = '<strong>IMEProbe</strong>';
      ed.appendChild(p);
      ed.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const r = document.createRange();
      r.setStart(p.firstChild.firstChild, 2);
      r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
      const seen = !!ed.querySelector('.md-raw');
      ed.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      return seen;
    })()`)
    assert.equal(imeRaw, false, 'IME compositionstart 期间不得展开 .md-raw')

    // 4b) 跨含公式块多段拖选：保持渲染态，并验证 .ai-bar 浮动出现且无重复 KaTeX 乱码
    const multiDrag = await noteCdp.eval(`(() => {
      const p1 = document.querySelector('#editor p:first-child');
      const p2 = document.getElementById('plainGuard');
      p1.scrollIntoView({ block: 'center' });
      const r1 = p1.getBoundingClientRect();
      const r2 = p2.getBoundingClientRect();
      return { x1: r1.left + 4, y1: r1.top + r1.height / 2, x2: r2.right - 4, y2: r2.top + r2.height / 2 };
    })()`)
    await noteCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: multiDrag.x1, y: multiDrag.y1 })
    await noteCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: multiDrag.x1, y: multiDrag.y1, button: 'left', clickCount: 1 })
    await noteCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: multiDrag.x2, y: multiDrag.y2, button: 'left', buttons: 1 })
    await noteCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: multiDrag.x2, y: multiDrag.y2, button: 'left', clickCount: 1 })
    await sleep(220)
    assert.equal(await noteCdp.eval(`!!document.querySelector('#editor .md-raw')`), false, '跨块拖选不得展开 .md-raw')
    const aiBarShown = await noteCdp.eval(`(() => {
      const b = document.querySelector('.ai-bar');
      return !!(b && !b.hidden && getComputedStyle(b).display !== 'none');
    })()`)
    assert.equal(aiBarShown, true, 'Live Preview 跨公式拖选应正常弹出 .ai-bar')

    await clickEl(noteCdp, '#plainGuard')
    await sleep(60)
    const targetsBefore = (await listTargets(cdpPort)).length
    await clickEl(noteCdp, '#editor a[href="https://example.com/docs"]', { ctrl: true })
    await sleep(200)
    const targetsAfter = (await listTargets(cdpPort)).length
    assert.equal(targetsAfter, targetsBefore, 'edit 模式 Ctrl+Click 外链不应新开 Electron 窗口')

    await noteCdp.eval(`(() => {
      const p = document.createElement('p');
      p.textContent = 'FastFlush180Check';
      document.getElementById('editor').appendChild(p);
      window.onEditorChanged();
    })()`)
    const flushOk = await noteCdp.eval(`window.flushSave()`)
    assert.equal(flushOk, true)
    const fastDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    const fastNote = fastDisk.notes.find(n => n.id === 'note-md-1')
    assert.ok(fastNote && fastNote.html.includes('FastFlush180Check'), '<180ms flushSave 应即时持久化正文')

    // 5) 未编译段落直接切源码模式不转义 "# "，切回 Live 保持首行渲染
    await noteCdp.eval(`(() => {
      const ed = document.getElementById('editor');
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      ed.appendChild(p);
      const r = document.createRange(); r.setStart(p, 0); r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      ed.focus();
    })()`)
    await noteCdp.send('Input.insertText', { text: '# RawSwitchCheck' })
    await clickEl(noteCdp, '#sourceToggle')
    await waitFor(() => noteCdp.eval(`document.getElementById('note').dataset.view === 'source'`), 2000, 40, 'switch to source')
    const rawSwitchSrc = await noteCdp.eval(`document.getElementById('sourceEditor').value`)
    assert.ok(rawSwitchSrc.includes('# RawSwitchCheck') && !rawSwitchSrc.includes('\\# RawSwitchCheck'), '未编译标题切源码不应被转义: ' + rawSwitchSrc)
    await clickEl(noteCdp, '#sourceToggle')
    await waitFor(() => noteCdp.eval(`document.getElementById('note').dataset.view !== 'source'`), 2000, 40, 'switch back live')
    assert.equal(await noteCdp.eval(`!!document.querySelector('#editor .md-raw')`), false, '切回 Live 首块应保持渲染态')
    console.log('✓ T8: Blank-line fence, <hr>/math/checkbox/IME/Ctrl+Click/<180ms flush/source-switch regressions passed')

    // ─── T9: 源码模式 <180ms 快速退出：持久化规范 HTML 与无 schema 膨胀 ───
    await noteCdp.eval(`(() => {
      if (document.getElementById('note').dataset.view !== 'source') {
        document.getElementById('sourceToggle').click();
      }
      const se = document.getElementById('sourceEditor');
      se.value = '快速退出验证 $\\\\alpha + \\\\beta$';
      se.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)

    const quitStart = Date.now()
    const exitPromise = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    await mainCdp.eval(`globalThis.__e2eElectron.app.quit()`)
    mainCdp.close()
    mainCdp = null
    const exitRes = await Promise.race([
      exitPromise,
      sleep(6000).then(() => { throw new Error('Timeout waiting for app.quit()\nSTDOUT:\n' + stdoutText + '\nSTDERR:\n' + stderrText) })
    ])
    const quitCost = Date.now() - quitStart
    assert.equal(exitRes.code, 0, `App should exit cleanly with code 0, got code=${exitRes.code} signal=${exitRes.signal}`)
    assert.equal(pageErrors.length, 0, `Expected 0 console/CSP/exception errors, got:\n${pageErrors.join('\n')}`)

    const disk = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    assert.equal(disk.version, 4, 'Schema version 必须保持 4')
    const n1 = disk.notes.find(n => n.id === 'note-md-1')
    assert.ok(n1)
    assert.equal(n1.mode, 'edit', 'NOTE.mode 不得保存为 source')
    assert.ok(n1.html.includes('data-tex="\\alpha + \\beta"'), `快速退出应在磁盘保留源码模式编辑后的公式: ${n1.html}`)
    assert.equal(/class="md-raw"/i.test(n1.html), false, '落盘 HTML 不得残留 .md-raw')
    assert.equal(/class="katex"/i.test(n1.html), false, '落盘 HTML 不得保存臃肿 KaTeX DOM，只能存轻量骨架')
    console.log(`✓ T9: Quick quit from Source Mode (${quitCost}ms) persisted canonical skeleton HTML cleanly`)
    console.log('ALL E2E MARKDOWN & LATEX CHECKS PASSED!')
  } finally {
    if (noteCdp) noteCdp.close()
    if (dashCdp) dashCdp.close()
    if (mainCdp) mainCdp.close()
    if (child && child.exitCode === null) {
      try { child.kill('SIGKILL') } catch (_) {}
    }
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) {}
  }
}

main().catch(err => {
  console.error('E2E FAILED:', err)
  process.exit(1)
})
