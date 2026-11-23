'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createGlobalOverlay } = require('../main/global-overlay')

function createHarness ({ aiService, inflateGetBounds = false, trackFocus = false, blurDelayMs } = {}) {
  let win = null
  const allWins = []
  let focusedWin = null
  const sent = []
  const fakeApp = new EventEmitter()
  let cursor = { x: 500, y: 400 }

  class FakeWindow extends EventEmitter {
    constructor (opts) {
      super()
      win = this
      allWins.push(this)
      this.opts = opts
      this.visible = false
      this.destroyed = false
      this.focused = false
      this.focusCalls = 0
      this.alwaysOnTop = false
      this.alwaysOnTopLevel = 'normal'
      this.moveTops = 0
      this.shows = 0
      this.bounds = { x: 0, y: 0, width: opts.width || 240, height: opts.height || 40 }
      this.contentBounds = null
      this.webContents = new EventEmitter()
      this.webContents.isDestroyed = () => this.destroyed
      this.webContents.send = (channel, payload) => { sent.push({ channel, payload, target: this.webContents }) }
    }
    isDestroyed () { return this.destroyed }
    isVisible () { return this.visible && !this.destroyed }
    isFocused () { return trackFocus ? focusedWin === this : this.focused }
    focus () {
      this.focused = true
      this.focusCalls++
      if (trackFocus) focusedWin = this
    }
    hide () {
      this.visible = false
      this.focused = false
      if (trackFocus && focusedWin === this) focusedWin = null
    }
    destroy () {
      this.destroyed = true
      this.visible = false
      this.focused = false
      if (trackFocus && focusedWin === this) focusedWin = null
      this.emit('closed')
    }
    close () { this.destroy() }
    showInactive () { this.visible = true; this.shows++ }
    setAlwaysOnTop (on, level) { this.alwaysOnTop = !!on; this.alwaysOnTopLevel = level || 'normal' }
    isAlwaysOnTop () { return this.alwaysOnTop }
    moveTop () { this.moveTops++ }
    setMenuBarVisibility () {}
    loadFile (_file, opts) { this.loadOpts = opts; this.webContents.emit('did-finish-load') }
    setBounds (b) { this.bounds = Object.assign({}, this.bounds, b) }
    getBounds () {
      return inflateGetBounds
        ? { x: this.bounds.x, y: this.bounds.y, width: this.bounds.width + 1, height: this.bounds.height + 1 }
        : Object.assign({}, this.bounds)
    }
    getContentBounds () {
      return this.contentBounds ? Object.assign({}, this.contentBounds) : this.getBounds()
    }
  }
  FakeWindow.fromWebContents = (wc) => allWins.find(w => w.webContents === wc) || null
  FakeWindow.getAllWindows = () => allWins.filter(w => !w.destroyed)
  if (trackFocus) {
    FakeWindow.getFocusedWindow = () => focusedWin
  }

  const handlers = new Map()
  const screen = {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1536, height: 816 }, scaleFactor: 1 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1536, height: 816 }, scaleFactor: 1 }),
    screenToDipPoint: (pt) => pt,
    getCursorScreenPoint: () => Object.assign({}, cursor)
  }
  const manager = createGlobalOverlay({
    app: fakeApp,
    BrowserWindow: FakeWindow,
    screen,
    ROOT: '.',
    SRC: '.',
    getState: () => ({ settings: { globalSelect: true } }),
    isQuiting: () => false,
    aiService,
    blurDelayMs
  })
  manager.registerIpc({ handle: (name, fn) => handlers.set(name, fn) })
  return {
    manager,
    handlers,
    sent,
    fakeApp,
    FakeWindow,
    setCursor: (pt) => { cursor = Object.assign({}, pt) },
    setFocusedWindow: (w) => { focusedWin = w },
    getWin: () => win,
    getAllWins: () => allWins
  }
}

test('关闭划词后迟到的尺寸回报不得重新显示浮窗，下次主动显示仍正常', () => {
  const { manager, handlers, getWin } = createHarness()
  const size = () => handlers.get('overlay:size')({ sender: getWin().webContents }, { w: 300, h: 40, mode: 'bar' })
  manager.showOverlay('test', { x: 300, y: 200 })
  size(); assert.equal(getWin().visible, true)
  manager.hideOverlay(); assert.equal(getWin().visible, false)
  size(); assert.equal(getWin().visible, false); assert.equal(getWin().shows, 1)
  manager.showOverlay('next', { x: 350, y: 250 })
  size(); assert.equal(getWin().visible, true); assert.equal(getWin().shows, 2)
})

test('工具弹窗支持拖动且尺寸变化（展开提问）后保持拖出位置', () => {
  const { manager, handlers, getWin } = createHarness()
  const invoke = (ch, payload) => handlers.get(ch)({ sender: getWin().webContents }, payload)

  manager.showOverlay('hello', { x: 400, y: 300 })
  invoke('overlay:size', { w: 300, h: 40, mode: 'bar' })
  const start = getWin().getBounds()

  const moved = invoke('overlay:move', { dragId: 1, dx: 120, dy: 80, end: true })
  assert.equal(moved.ok, true)
  assert.equal(getWin().getBounds().x, start.x + 120)
  assert.equal(getWin().getBounds().y, start.y + 80)

  // 展开提问输入行导致尺寸变高时，不能回弹到原锚点
  invoke('overlay:size', { w: 320, h: 86, mode: 'bar' })
  assert.equal(getWin().getBounds().x, start.x + 120)
  assert.equal(getWin().getBounds().y, start.y + 80)
})

test('回答弹窗置顶原地生效并真实置顶，拖动后仍保持置顶且不被外部点击/划词关闭', () => {
  const { manager, handlers, getWin } = createHarness()
  const invoke = (ch, payload) => handlers.get(ch)({ sender: getWin().webContents }, payload)

  manager.showOverlay('selected text', { x: 400, y: 300 })
  invoke('overlay:size', { w: 300, h: 40, mode: 'bar' })
  assert.equal(getWin().isAlwaysOnTop(), true, '工具弹窗显示时置于最前')

  // 切换到结果卡片（默认未置顶）
  invoke('overlay:size', { w: 416, h: 240, mode: 'card' })
  assert.equal(getWin().isAlwaysOnTop(), false)
  const beforePin = getWin().getBounds()

  // 点击置顶：原地置顶（不能强制跳到 y=8）
  const pinRes = invoke('overlay:pin', true)
  assert.equal(pinRes.ok, true)
  assert.equal(pinRes.pinned, true)
  assert.equal(pinRes.alwaysOnTop, true)
  assert.equal(getWin().isAlwaysOnTop(), true)
  assert.equal(getWin().alwaysOnTopLevel, 'screen-saver')
  assert.equal(getWin().getBounds().y, beforePin.y)

  // 拖动置顶后的回答弹窗：从当前位置按 dx/dy 移动，且置顶状态不丢失
  const move1 = invoke('overlay:move', { dragId: 7, dx: 90, dy: 60 })
  assert.equal(move1.pinned, true)
  assert.equal(getWin().getBounds().x, beforePin.x + 90)
  assert.equal(getWin().getBounds().y, beforePin.y + 60)

  const moveEnd = invoke('overlay:move', { dragId: 7, dx: 140, dy: 95, end: true })
  assert.equal(moveEnd.pinned, true)
  assert.equal(getWin().isAlwaysOnTop(), true)
  assert.equal(getWin().getBounds().x, beforePin.x + 140)
  assert.equal(getWin().getBounds().y, beforePin.y + 95)

  // 流式高度变化时留在拖出位置，且保持置顶
  invoke('overlay:size', { w: 416, h: 310, mode: 'card' })
  assert.equal(getWin().getBounds().x, beforePin.x + 140)
  assert.equal(getWin().getBounds().y, beforePin.y + 95)
  assert.equal(getWin().isAlwaysOnTop(), true)

  // 外部左键点击与外部划词不得关闭或覆盖已置顶的回答弹窗
  manager.handleProbeEvent({ t: 'down', x: 10, y: 10 })
  assert.equal(getWin().isVisible(), true)
  manager.handleProbeEvent({ t: 'sel', text: 'another text', x: 500, y: 500, hwnd: 12345 })
  assert.equal(getWin().isAlwaysOnTop(), true)
  assert.equal(getWin().getBounds().x, beforePin.x + 140)

  // 取消置顶后，外部点击可正常关闭
  const unpinRes = invoke('overlay:pin', false)
  assert.equal(unpinRes.pinned, false)
  assert.equal(getWin().isAlwaysOnTop(), false)
  manager.handleProbeEvent({ t: 'down', x: 10, y: 10 })
  assert.equal(getWin().isVisible(), false)
})

test('overlay:pin-card 将页内回答弹窗提升为系统级置顶窗并接管在途 AI 流', () => {
  const retargeted = []
  const { handlers, sent, getWin } = createHarness({
    aiService: {
      retargetRequest: (reqId, wc) => { retargeted.push({ reqId, wc }); return true }
    }
  })

  const fakeSender = { id: 888 }
  const res = handlers.get('overlay:pin-card')({ sender: fakeSender }, {
    action: 'ask',
    text: '原文内容',
    question: '这是什么？',
    requestId: 'r123',
    raw: '局部回答',
    done: false,
    provider: 'TestAI',
    model: 'gpt-test',
    rect: { x: 220, y: 160, w: 416, h: 250 }
  })

  assert.equal(res.ok, true)
  assert.equal(res.pinned, true)
  assert.equal(res.alwaysOnTop, true)
  assert.equal(getWin().isAlwaysOnTop(), true)
  assert.equal(retargeted.length, 1)
  assert.equal(retargeted[0].reqId, 'r123')
  assert.equal(retargeted[0].wc, getWin().webContents)

  const msg = sent.find(s => s.channel === 'overlay:show-card')
  assert.ok(msg)
  assert.equal(msg.payload.pinned, true)
  assert.equal(msg.payload.question, '这是什么？')

  handlers.get('overlay:size')({ sender: getWin().webContents }, { w: 416, h: 250, mode: 'card' })
  assert.equal(getWin().isVisible(), true)
  assert.equal(getWin().getBounds().x, 220)
  assert.equal(getWin().getBounds().y, 160)
})

test('125% DPI 下 getBounds() 膨胀不得导致 overlay:move 尺寸滚雪球或向上漂移', () => {
  const { manager, handlers, getWin } = createHarness({ inflateGetBounds: true })
  const invoke = (ch, payload) => handlers.get(ch)({ sender: getWin().webContents }, payload)

  manager.showOverlay('selected text', { x: 400, y: 120 })
  invoke('overlay:size', { w: 420, h: 260, mode: 'card' })
  assert.equal(getWin().bounds.width, 420)
  assert.equal(getWin().bounds.height, 260)

  const startY = getWin().bounds.y
  invoke('overlay:move', { dragId: 1, phase: 'start' })
  for (let i = 1; i <= 80; i++) {
    invoke('overlay:move', { dragId: 1, dx: i, dy: Math.round(i * 2.5), end: i === 80 })
  }

  // 即使 getBounds() 每帧都返回 +1px，窗口实际设定的宽高仍严格锁死在内容尺寸 420x260，且 y 精确下移
  assert.equal(getWin().bounds.width, 420)
  assert.equal(getWin().bounds.height, 260)
  assert.equal(getWin().bounds.y, startY + 200)
})

test('overlay:move 支持 phase:start 真实光标追踪并在无位移 phase:end 时清理拖拽态', () => {
  const { manager, handlers, setCursor, getWin } = createHarness()
  const invoke = (ch, payload) => handlers.get(ch)({ sender: getWin().webContents }, payload)

  manager.showOverlay('hello', { x: 300, y: 200 })
  invoke('overlay:size', { w: 300, h: 40, mode: 'bar' })
  const start = getWin().getBounds()

  setCursor({ x: 500, y: 400 })
  invoke('overlay:move', { dragId: 5, phase: 'start' })

  // 真实 OS 光标移动 (+45, +65)，即使传入不同渲染端增量也按真实光标同步跟手
  setCursor({ x: 545, y: 465 })
  const moved = invoke('overlay:move', { dragId: 5, dx: 10, dy: 10, end: true })
  assert.equal(moved.x, start.x + 45)
  assert.equal(moved.y, start.y + 65)

  // 点击未拖动后释放：phase:'end' 正常清理 activeDrag 且不移位
  const beforeNoop = getWin().getBounds()
  invoke('overlay:move', { dragId: 6, phase: 'start' })
  const endRes = invoke('overlay:move', { dragId: 6, phase: 'end', end: true })
  assert.equal(endRes.ok, true)
  assert.equal(getWin().getBounds().x, beforeNoop.x)
  assert.equal(getWin().getBounds().y, beforeNoop.y)
})

test('未置顶回答弹窗失焦或切换到其他窗口时自动隐藏，置顶后保持显示', () => {
  const { manager, handlers, fakeApp, FakeWindow, getWin } = createHarness()
  const invoke = (ch, payload) => handlers.get(ch)({ sender: getWin().webContents }, payload)

  // 1) 未置顶时窗口失焦自动隐藏
  manager.showOverlay('text', { x: 300, y: 200 })
  invoke('overlay:size', { w: 416, h: 240, mode: 'card' })
  assert.equal(getWin().isVisible(), true)
  getWin().emit('blur')
  assert.equal(getWin().isVisible(), false)

  // 2) 未置顶时切换到应用内其他窗口（如便签中心 / 便签窗）同样自动隐藏
  manager.showOverlay('text', { x: 300, y: 200 })
  invoke('overlay:size', { w: 416, h: 240, mode: 'card' })
  const otherWin = {}
  fakeApp.emit('browser-window-focus', {}, otherWin)
  assert.equal(getWin().isVisible(), false)

  // 3) 置顶后失焦或切换其他窗口必须保持可见且保持置顶
  manager.showOverlay('text', { x: 300, y: 200 })
  invoke('overlay:size', { w: 416, h: 240, mode: 'card' })
  invoke('overlay:pin', true)
  getWin().emit('blur')
  fakeApp.emit('browser-window-focus', {}, otherWin)
  assert.equal(getWin().isVisible(), true)
  assert.equal(getWin().isAlwaysOnTop(), true)

  // 4) 取消置顶后确保获得焦点以捕获后续点击外部应用导致的失焦
  const beforeUnpinCalls = getWin().focusCalls
  invoke('overlay:pin', false)
  assert.equal(getWin().focusCalls > beforeUnpinCalls, true)
  getWin().emit('blur')
  assert.equal(getWin().isVisible(), false)
})

test('支持同时多开独立回答窗口（级联偏移、各自置顶/关闭与流中止隔离）', () => {
  const abortedWcs = []
  const { manager, handlers, FakeWindow } = createHarness({
    trackFocus: true,
    blurDelayMs: 10,
    aiService: {
      abortByWebContents: (wc) => { abortedWcs.push(wc); return 1 }
    }
  })

  const noteWin = new FakeWindow({ width: 400, height: 500 })
  noteWin.contentBounds = { x: 100, y: 100, width: 400, height: 500 }

  // 从便签触发第一个与第二个回答窗（起点相同，第二个应自动级联偏移）
  const r1 = handlers.get('overlay:open-card')({ sender: noteWin.webContents }, {
    action: 'explain',
    text: 'Alpha',
    canInsert: true,
    rect: { x: 50, y: 80, w: 80, h: 20, bottom: 100 }
  })
  const c1 = manager.getAnswerWindows()[0]
  handlers.get('overlay:size')({ sender: c1.webContents }, { w: 420, h: 240, mode: 'card' })

  const r2 = handlers.get('overlay:open-card')({ sender: noteWin.webContents }, {
    action: 'translate',
    text: 'Beta',
    canInsert: true,
    rect: { x: 50, y: 80, w: 80, h: 20, bottom: 100 }
  })
  const c2 = manager.getAnswerWindows()[1]
  handlers.get('overlay:size')({ sender: c2.webContents }, { w: 420, h: 240, mode: 'card' })

  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.notEqual(r1.id, r2.id)
  assert.equal(manager.getAnswerWindows().length, 2)
  assert.equal(c1.isVisible(), true)
  assert.equal(c2.isVisible(), true)
  assert.ok(c2.getBounds().x >= c1.getBounds().x + 24 && c2.getBounds().y >= c1.getBounds().y + 24,
    `Second card should cascade cleanly: c1=${JSON.stringify(c1.getBounds())} c2=${JSON.stringify(c2.getBounds())}`)

  // 独立置顶其中一张，再多开第三张置顶卡，均互不覆盖
  handlers.get('overlay:pin')({ sender: c1.webContents }, true)
  assert.equal(c1.isAlwaysOnTop(), true)
  assert.equal(c2.isAlwaysOnTop(), false)

  handlers.get('overlay:pin-card')({ sender: noteWin.webContents }, {
    action: 'ask', text: 'Gamma', question: 'Q', raw: 'R', done: true,
    rect: { x: 300, y: 200, w: 416, h: 240 }
  })
  const c3 = manager.getAnswerWindows()[2]
  handlers.get('overlay:size')({ sender: c3.webContents }, { w: 416, h: 240, mode: 'card' })
  assert.equal(manager.getAnswerWindows().length, 3)

  // 关闭 c2 时：中止 c2 所属在途流、不关闭 c1/c3、并将焦点回退到剩余可见回答窗
  handlers.get('overlay:close')({ sender: c2.webContents })
  assert.equal(c2.isDestroyed(), true)
  assert.equal(abortedWcs.includes(c2.webContents), true)
  assert.equal(manager.getAnswerWindows().length, 2)
  assert.equal(FakeWindow.getFocusedWindow() === c3, true)
})

test('回答窗内划词打开工具条与子回答窗并继承插入便签链路，焦点离开才自动收起未置顶窗', async () => {
  const { manager, handlers, fakeApp, FakeWindow, setFocusedWindow } = createHarness({
    trackFocus: true,
    blurDelayMs: 15
  })

  const noteSent = []
  let noteAlive = true
  const noteWin = new FakeWindow({ width: 400, height: 500 })
  noteWin.contentBounds = { x: 100, y: 100, width: 400, height: 500 }
  noteWin.webContents.isDestroyed = () => !noteAlive
  noteWin.webContents.send = (ch, payload) => noteSent.push({ ch, payload })

  // 打开未置顶回答窗 1（来源 noteWin，canInsert=true）
  handlers.get('overlay:open-card')({ sender: noteWin.webContents }, {
    action: 'explain',
    text: '第一段上下文',
    canInsert: true,
    rect: { x: 40, y: 60, w: 90, h: 20, bottom: 80 }
  })
  const c1 = manager.getAnswerWindows()[0]
  handlers.get('overlay:size')({ sender: c1.webContents }, { w: 420, h: 260, mode: 'card' })
  assert.equal(c1.isVisible(), true)
  assert.equal(c1.isAlwaysOnTop(), false)

  // 在回答窗 1 内划词弹出 barWin
  handlers.get('overlay:show-bar')({ sender: c1.webContents }, {
    text: '回答窗内选中的术语',
    rect: { left: 40, top: 90, width: 100, height: 18, bottom: 108 }
  })
  const barWin = manager.getBarWindow()
  assert.ok(barWin)
  handlers.get('overlay:size')({ sender: barWin.webContents }, { w: 280, h: 40, mode: 'bar' })
  assert.equal(barWin.isVisible(), true)
  assert.equal(barWin.isAlwaysOnTop(), true)

  // 点击工具条「提问」让 barWin 抢走焦点：未置顶 c1 仍必须保持打开！
  handlers.get('overlay:focus')({ sender: barWin.webContents })
  c1.emit('blur')
  fakeApp.emit('browser-window-focus', {}, barWin)
  assert.equal(c1.isVisible(), true)
  assert.equal(barWin.isVisible(), true)

  // 从 barWin 打开子回答窗 c2：barWin 收起、c1 与 c2 并存，且 c2 继承了 noteWin 的插入能力
  handlers.get('overlay:open-card')({ sender: barWin.webContents }, {
    action: 'ask',
    text: '回答窗内选中的术语',
    question: '为什么？'
  })
  assert.equal(barWin.isVisible(), false)
  assert.equal(manager.getAnswerWindows().length, 2)
  const c2 = manager.getAnswerWindows()[1]
  handlers.get('overlay:size')({ sender: c2.webContents }, { w: 420, h: 240, mode: 'card' })

  const insRes = handlers.get('overlay:insert-note')({ sender: c2.webContents }, '子回答窗推导出的答案')
  assert.equal(insRes.ok, true)
  assert.equal(noteSent.length, 1)
  assert.equal(noteSent[0].ch, 'note:ai-insert')
  assert.equal(noteSent[0].payload.text, '子回答窗推导出的答案')

  // 原便签销毁后，「插入便签」应明确返回错误而不抛异常
  noteAlive = false
  const insFail = handlers.get('overlay:insert-note')({ sender: c2.webContents }, '失效测试')
  assert.equal(insFail.ok, false)

  // 置顶 c1、保持 c2 未置顶；然后把焦点切回非悬浮窗（跳过内部护栏模拟真实切窗）
  handlers.get('overlay:pin')({ sender: c1.webContents }, true)
  setFocusedWindow(null)
  c2.emit('blur')
  await new Promise(r => setTimeout(r, 40))
  // 期间若刚过完 450ms guard 或显式触发非悬浮窗聚焦，测试下一次焦点切走
  const otherWin = new FakeWindow({ width: 300, height: 300 })
  await new Promise(r => setTimeout(r, 460))
  fakeApp.emit('browser-window-focus', {}, otherWin)
  assert.equal(c2.isDestroyed(), true, '切回非悬浮窗时未置顶回答窗应自动关闭')
  assert.equal(c1.isDestroyed(), false, '已置顶回答窗必须保持打开')
  assert.equal(c1.isVisible(), true)
  assert.equal(c1.isAlwaysOnTop(), true)
})
