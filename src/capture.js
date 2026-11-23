'use strict'

/**
 * 截图编辑器
 * 状态机：idle（未选区） → ready（已选区，可标注） → drawing/texting（进行中）
 * 产物：选区内的「背景图 + 矢量标注」合成后的 PNG dataURL
 */

const api = window.sticky
const $ = (s) => document.querySelector(s)

const selEl = $('#sel')
const hoverEl = $('#hoverSel')
const hoverSizeEl = $('#hoverSize')
const sizeEl = $('#selSize')
const canvas = $('#draw')
const ctx = canvas.getContext('2d')
const toolbar = $('#toolbar')
const hintEl = $('#hint')
const toastEl = $('#toast')
const textInput = $('#textInput')
const snapV = $('#snapV')
const snapH = $('#snapH')
const crossInfo = $('#crossInfo')

// ---------------------------------------------------------------- 状态
let phase = 'select'                     // select（框选）| grabbing（抓取中）| annotate（标注）
let edgeImg = null                       // 1/2 缩略图，仅用于边缘吸附分析
let shotImg = null                       // 确认选区后抓到的裁剪图（标注背景）
let align = { dx: 0, dy: 0 }             // 窗口相对显示器原点的偏移

let dpr = 1
let viewW = 0
let viewH = 0

let stage = 'idle'                       // idle | ready | drawing | texting
let sel = { x: 0, y: 0, w: 0, h: 0 }
let tool = 'move'
let color = '#ff3b30'
let lineWidth = 3
let fontSize = 20

let shapes = []
let draft = null
let history = []
let hIdx = -1
let drag = null                          // { mode, ... }
let hoverRect = null                     // 鼠标下的候选区域
let hoverRaf = 0

// 边缘检测结果（缩略图尺度）
let colScore = null                      // 每列「最长连续边缘」占比 0..1
let rowScore = null
let tw = 0
let th = 0
let thrCol = 1
let thrRow = 1

const MIN_SEL = 8
const EDGE_PIXEL_THR = 12                // 灰度差 >= 12 记作一个边缘像素
const SNAP_TOLERANCE_DIP = 10            // 吸附容差（DIP），不是缩略图像素
const DETECT_RANGE_DIP = 420             // 单方向识别的最远搜索距离
const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de', '#ffffff', '#111111']

const clamp = (window.StickyUtils && window.StickyUtils.clamp) || ((v, a, b) => Math.min(Math.max(v, a), Math.max(a, b)))

// ---------------------------------------------------------------- 初始化
/**
 * 注意顺序：交互（指针 / 键盘 / Esc）必须在脚本加载时立刻挂上，
 * 不能等 capture:init —— 主进程要等缩略图解码完才发 init，
 * 那之前按 Esc 会完全没有反应。
 */
buildPalette()
bindEvents()
setPhase('select')
updateUI()

api.onCaptureInit(async (payload) => {
  if (!payload) { api.cancelCapture(); return }
  dpr = payload.display.scale || window.devicePixelRatio || 1
  align = payload.align || { dx: 0, dy: 0 }
  syncViewport()

  // 缩略图只用于算边缘（窗口吸附），拿不到也能正常框选
  if (payload.thumb) {
    try {
      edgeImg = await loadImage(payload.thumb)
      buildEdges()
    } catch (e) {
      edgeImg = null
    }
  }
  updateUI()
})

api.onCaptureEscape(() => handleEscape())

/** 视口尺寸随时可能变（窗口铺满屏幕、分辨率缩放），每个入口都同步一次 */
function syncViewport () {
  const w = window.innerWidth
  const h = window.innerHeight
  if (w !== viewW || h !== viewH) {
    viewW = w
    viewH = h
    return true
  }
  return false
}

window.addEventListener('resize', () => {
  if (syncViewport()) updateUI()
})

function loadImage (src) {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve(im)
    im.onerror = reject
    im.src = src
  })
}

// ---------------------------------------------------------------- 边缘检测（窗口吸附的数据基础）
/**
 * 纯函数：灰度图 → 每列/每行的「最长连续边缘长度」（按边长归一化到 0..1）。
 *
 * 为什么用"连续长度"而不是"梯度总和"：
 *   - 窗口/面板边框是整条连续的高对比线 → 连续长度 ≈ 窗口高度 → 得分 0.8~1.0
 *   - 文字行、图标、按钮边缘是断续的短段       → 连续长度 ≈ 一行字高 → 得分 0.03~0.08
 * 用总和的话，一段密集文字累加起来能盖过窗口边框，这正是之前"吸到内部分隔线"的根因。
 */
function computeEdgeScores (gray, w, h, edgeThr) {
  const col = new Float32Array(w)
  const row = new Float32Array(h)

  for (let x = 1; x < w - 1; x++) {
    let run = 0
    let best = 0
    for (let y = 0; y < h; y++) {
      const base = y * w
      const d = Math.abs(gray[base + x + 1] - gray[base + x - 1])
      if (d >= edgeThr) { run++; if (run > best) best = run } else { run = 0 }
    }
    col[x] = best / h
  }

  for (let y = 1; y < h - 1; y++) {
    let run = 0
    let best = 0
    const up = (y - 1) * w
    const dn = (y + 1) * w
    for (let x = 0; x < w; x++) {
      const d = Math.abs(gray[dn + x] - gray[up + x])
      if (d >= edgeThr) { run++; if (run > best) best = run } else { run = 0 }
    }
    row[y] = best / w
  }

  return { col, row }
}

/** 抛物线插值，把峰值位置精确到亚像素 */
function subpixel (arr, i) {
  if (i <= 0 || i >= arr.length - 1) return i
  const a = arr[i - 1]
  const b = arr[i]
  const c = arr[i + 1]
  const denom = a - 2 * b + c
  if (Math.abs(denom) < 1e-6) return i
  const d = 0.5 * (a - c) / denom
  return i + Math.max(-0.5, Math.min(0.5, d))
}

/**
 * 峰值定位：先找等值平台的中心，再退回抛物线插值。
 *
 * 一条 2px 的窗口边框经过中心差分后会在 4 个采样点上得到相同的最大值，
 * 如果直接取第一个索引，就会稳定偏 -1.5px。取平台中心正好回到边框正中。
 */
function refinePeak (arr, i) {
  const v = arr[i]
  let l = i
  let r = i
  const EPS = 1e-4
  while (l - 1 > 0 && Math.abs(arr[l - 1] - v) <= EPS) l--
  while (r + 1 < arr.length - 1 && Math.abs(arr[r + 1] - v) <= EPS) r++
  if (l === r) return subpixel(arr, i)
  return (l + r) / 2
}

function buildEdges () {
  if (!edgeImg) { colScore = null; rowScore = null; return }
  tw = Math.max(4, edgeImg.width)
  th = Math.max(4, edgeImg.height)

  const c = document.createElement('canvas')
  c.width = tw
  c.height = th
  const cx = c.getContext('2d', { willReadFrequently: true })
  cx.drawImage(edgeImg, 0, 0)

  let data
  try {
    data = cx.getImageData(0, 0, tw, th).data
  } catch (e) {
    colScore = null
    rowScore = null
    return
  }

  const gray = new Uint8Array(tw * th)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000
  }

  const res = computeEdgeScores(gray, tw, th, EDGE_PIXEL_THR)
  colScore = res.col
  rowScore = res.row

  let maxC = 0
  let maxR = 0
  for (let x = 1; x < tw - 1; x++) if (colScore[x] > maxC) maxC = colScore[x]
  for (let y = 1; y < th - 1; y++) if (rowScore[y] > maxR) maxR = rowScore[y]

  // 只保留"连续长度 ≥ 全局最强边 55%"的线：
  // 窗口边框接近 100%，文字行通常只有 30%~40%，能被干净地滤掉
  thrCol = Math.max(0.15, maxC * 0.55)
  thrRow = Math.max(0.15, maxR * 0.55)
}

/**
 * 把坐标吸附到最近的一条"强边"。
 * 容差按 DIP 算（10px），不随缩略图分辨率漂移；同分时取更近的。
 */
function snapAxis (v, axis) {
  const arr = axis === 'x' ? colScore : rowScore
  if (!arr) return { value: v, hit: false }

  const view = axis === 'x' ? viewW : viewH
  const scale = arr.length / view
  const tv = v * scale
  const tolPx = SNAP_TOLERANCE_DIP * scale
  const thr = axis === 'x' ? thrCol : thrRow

  let bestI = -1
  let bestScore = 0
  let bestDist = Infinity
  const lo = Math.max(1, Math.floor(tv - tolPx))
  const hi = Math.min(arr.length - 2, Math.ceil(tv + tolPx))
  for (let i = lo; i <= hi; i++) {
    if (arr[i] < thr) continue
    const dist = Math.abs(i - tv)
    if (arr[i] > bestScore + 1e-6 || (Math.abs(arr[i] - bestScore) <= 1e-6 && dist < bestDist)) {
      bestScore = arr[i]
      bestDist = dist
      bestI = i
    }
  }
  if (bestI < 0) return { value: v, hit: false }

  return { value: refinePeak(arr, bestI) / scale, hit: true }
}

/**
 * 从落点向四个方向找"最强的边"（不是"遇到的第一个边"），得到一个矩形块。
 * 取最强而不是最近：最近的可能是一条内部分隔线，最强的一般就是窗口/面板外框。
 */
function detectRect (px, py) {
  if (!colScore || !rowScore) return { x: 0, y: 0, w: viewW, h: viewH }

  const sx = colScore.length / viewW
  const sy = rowScore.length / viewH
  const cx = clamp(Math.round(px * sx), 1, colScore.length - 2)
  const cy = clamp(Math.round(py * sy), 1, rowScore.length - 2)

  const scan = (arr, start, dir, limitPx, thr) => {
    let best = -1
    let bestScore = 0
    for (let i = start; i > 0 && i < arr.length - 1; i += dir) {
      if (Math.abs(i - start) > limitPx) break
      if (arr[i] >= thr && arr[i] > bestScore) { bestScore = arr[i]; best = i }
    }
    return best < 0 ? null : refinePeak(arr, best)
  }

  const limitX = DETECT_RANGE_DIP * sx
  const limitY = DETECT_RANGE_DIP * sy
  const hitL = scan(colScore, cx, -1, limitX, thrCol)
  const hitR = scan(colScore, cx, +1, limitX, thrCol)
  const hitT = scan(rowScore, cy, -1, limitY, thrRow)
  const hitB = scan(rowScore, cy, +1, limitY, thrRow)

  const x1 = hitL === null ? 0 : hitL / sx
  const x2 = hitR === null ? viewW : hitR / sx
  const y1 = hitT === null ? 0 : hitT / sy
  const y2 = hitB === null ? viewH : hitB / sy

  const rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  if (rect.w < 60 || rect.h < 40) return { x: 0, y: 0, w: viewW, h: viewH }
  return rect
}

// ---------------------------------------------------------------- 悬停候选区域
/** 候选区域是否值得高亮：太小或几乎整屏都不提示 */
function isUsableRect (r) {
  if (!r) return false
  if (r.w < 60 || r.h < 40) return false
  if (r.w >= viewW * 0.96 && r.h >= viewH * 0.96) return false
  return true
}

let hoverX = 0
let hoverY = 0

function scheduleHover (x, y) {
  hoverX = x
  hoverY = y
  if (hoverRaf) return
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0
    updateHover(hoverX, hoverY)
  })
}

function updateHover (x, y) {
  if (phase !== 'select' || drag || sel.w >= MIN_SEL) { hideHover(); return }
  const rect = detectRect(x, y)
  if (!isUsableRect(rect)) { hideHover(); return }
  hoverRect = rect
  hoverEl.hidden = false
  hoverEl.style.left = Math.round(rect.x) + 'px'
  hoverEl.style.top = Math.round(rect.y) + 'px'
  hoverEl.style.width = Math.round(rect.w) + 'px'
  hoverEl.style.height = Math.round(rect.h) + 'px'
  hoverSizeEl.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`
}

function hideHover () {
  hoverRect = null
  hoverEl.hidden = true
}

// ---------------------------------------------------------------- 选区
function setSel (x, y, w, h) {
  sel = {
    x: Math.round(clamp(x, 0, viewW)),
    y: Math.round(clamp(y, 0, viewH)),
    w: Math.round(w),
    h: Math.round(h)
  }
  sel.w = Math.min(sel.w, viewW - sel.x)
  sel.h = Math.min(sel.h, viewH - sel.y)
  applySelStyle()
}

function applySelStyle () {
  const valid = sel.w >= MIN_SEL && sel.h >= MIN_SEL
  selEl.hidden = !valid
  if (!valid) {
    stage = 'idle'
    return
  }
  selEl.style.left = sel.x + 'px'
  selEl.style.top = sel.y + 'px'
  selEl.style.width = sel.w + 'px'
  selEl.style.height = sel.h + 'px'
  sizeEl.textContent = `${sel.w} × ${sel.h}`
  sizeEl.classList.toggle('below', sel.y < 34)
  resizeCanvas()
  renderAll()
  positionToolbar()
}

function resizeCanvas () {
  const w = Math.max(1, Math.round(sel.w * dpr))
  const h = Math.max(1, Math.round(sel.h * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
}

function pointInSel (x, y) {
  return x >= sel.x && x <= sel.x + sel.w && y >= sel.y && y <= sel.y + sel.h
}

function localPoint (e) {
  return {
    x: clamp(e.clientX - sel.x, 0, sel.w),
    y: clamp(e.clientY - sel.y, 0, sel.h)
  }
}

// ---------------------------------------------------------------- 渲染
function renderAll () {
  if (phase !== 'annotate' || !shotImg) return
  if (sel.w < 1 || sel.h < 1) return
  resizeCanvas()

  // 背景：确认选区时抓到的裁剪图，按 dpr 铺满画布
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(shotImg, 0, 0, canvas.width, canvas.height)

  // 标注：统一用 DIP 坐标
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of shapes) drawShape(s)
  if (draft) drawShape(draft)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

function drawShape (s) {
  ctx.save()
  ctx.strokeStyle = s.color || color
  ctx.fillStyle = s.color || color
  ctx.lineWidth = s.width || lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const w = Math.abs(s.w || 0)
  const h = Math.abs(s.h || 0)
  const rx = Math.min(s.x, s.x + (s.w || 0))
  const ry = Math.min(s.y, s.y + (s.h || 0))

  switch (s.type) {
    case 'rect':
      ctx.strokeRect(rx, ry, w, h)
      break

    case 'ellipse':
      ctx.beginPath()
      ctx.ellipse(rx + w / 2, ry + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2)
      ctx.stroke()
      break

    case 'arrow': {
      const dx = s.x2 - s.x1
      const dy = s.y2 - s.y1
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) break
      ctx.beginPath()
      ctx.moveTo(s.x1, s.y1)
      ctx.lineTo(s.x2, s.y2)
      ctx.stroke()
      const ang = Math.atan2(dy, dx)
      const len = 9 + (s.width || lineWidth) * 2.2
      const spread = 0.42
      ctx.beginPath()
      ctx.moveTo(s.x2, s.y2)
      ctx.lineTo(s.x2 - len * Math.cos(ang - spread), s.y2 - len * Math.sin(ang - spread))
      ctx.moveTo(s.x2, s.y2)
      ctx.lineTo(s.x2 - len * Math.cos(ang + spread), s.y2 - len * Math.sin(ang + spread))
      ctx.stroke()
      break
    }

    case 'pen': {
      const pts = s.points || []
      if (pts.length < 2) break
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
      break
    }

    case 'mosaic': {
      const bw = Math.max(1, Math.round(w / 9))
      const bh = Math.max(1, Math.round(h / 9))
      if (bw < 2 || bh < 2) break
      const tmp = document.createElement('canvas')
      tmp.width = bw
      tmp.height = bh
      const tctx = tmp.getContext('2d')
      // 关键：马赛克永远从「裁剪原图」取样，而不是从已画了标注的画布取样
      tctx.drawImage(
        shotImg,
        rx * dpr, ry * dpr, w * dpr, h * dpr,
        0, 0, bw, bh
      )
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(tmp, 0, 0, bw, bh, rx, ry, w, h)
      ctx.imageSmoothingEnabled = true
      break
    }

    case 'text': {
      const lines = String(s.text || '').split('\n')
      ctx.font = `600 ${s.size || fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
      ctx.textBaseline = 'top'
      // 描一层浅色描边，保证在深色/浅色背景上都可读
      ctx.lineWidth = Math.max(1, (s.size || fontSize) / 9)
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      const lh = (s.size || fontSize) * 1.32
      lines.forEach((line, i) => {
        ctx.strokeText(line, s.x, s.y + i * lh)
        ctx.fillText(line, s.x, s.y + i * lh)
      })
      break
    }
  }
  ctx.restore()
}

// ---------------------------------------------------------------- 历史
function pushHistory () {
  const snap = JSON.stringify(shapes)
  if (history[hIdx] === snap) return
  history = history.slice(0, hIdx + 1)
  history.push(snap)
  if (history.length > 60) history.shift()
  hIdx = history.length - 1
  updateUndoButtons()
}

function undo () {
  if (hIdx <= 0) return
  hIdx -= 1
  shapes = JSON.parse(history[hIdx])
  renderAll()
  updateUndoButtons()
}

function redo () {
  if (hIdx >= history.length - 1) return
  hIdx += 1
  shapes = JSON.parse(history[hIdx])
  renderAll()
  updateUndoButtons()
}

function updateUndoButtons () {
  const u = document.querySelector('[data-act="undo"]')
  const r = document.querySelector('[data-act="redo"]')
  if (u) u.disabled = hIdx <= 0
  if (r) r.disabled = hIdx >= history.length - 1
}

// ---------------------------------------------------------------- 事件绑定
function bindEvents () {
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('contextmenu', (e) => e.preventDefault())
}

function isChrome (target) {
  return !!(target.closest && target.closest('.toolbar, .text-input, .toast'))
}

function onDown (e) {
  if (e.button !== 0) return
  if (isChrome(e.target)) return
  if (stage === 'texting') return
  if (phase === 'grabbing') return

  syncViewport()
  try { document.body.setPointerCapture(e.pointerId) } catch (_) {}

  const inside = stage !== 'idle' && pointInSel(e.clientX, e.clientY)

  // ---------- 标注阶段：只能在选区内画
  if (phase === 'annotate') {
    if (!inside) return
    if (tool === 'text') { startTextInput(e); return }
    const p = localPoint(e)
    stage = 'drawing'
    drag = { mode: 'draw' }
    draft = tool === 'pen'
      ? { type: 'pen', points: [p], color, width: lineWidth }
      : { type: tool, x: p.x, y: p.y, w: 0, h: 0, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width: lineWidth }
    renderAll()
    return
  }

  // ---------- 框选阶段
  const handle = e.target.closest && e.target.closest('.h')
  if (handle && stage !== 'idle') {
    drag = { mode: 'resize', dir: handle.dataset.h, start: { ...sel }, ox: e.clientX, oy: e.clientY }
    hideSnap()
    return
  }

  if (inside) {
    drag = { mode: 'move', start: { ...sel }, ox: e.clientX, oy: e.clientY }
    hideSnap()
    return
  }

  // 选区外按下：先挂起，位移超过阈值算「拖拽框选」，否则算「点击采用候选区域」
  drag = { mode: 'pending', x0: e.clientX, y0: e.clientY }
  hideSnap()
  hideHover()
}

function onMove (e) {
  updateCrossInfo(e)

  if (!drag) {
    if (phase === 'select') scheduleHover(e.clientX, e.clientY)
    return
  }

  // 挂起 → 位移够大就转成拖拽框选
  if (drag.mode === 'pending') {
    const dx = e.clientX - drag.x0
    const dy = e.clientY - drag.y0
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
    drag = { mode: 'new', x0: drag.x0, y0: drag.y0 }
    stage = 'idle'
    setSel(drag.x0, drag.y0, 0, 0)
    hideHover()
    return
  }

  if (drag.mode === 'new') {
    const ax = snapAxis(e.clientX, 'x')
    const ay = snapAxis(e.clientY, 'y')
    const x1 = drag.x0
    const y1 = drag.y0
    const x2 = ax.hit ? ax.value : e.clientX
    const y2 = ay.hit ? ay.value : e.clientY
    showSnap(ax.hit ? ax.value : null, ay.hit ? ay.value : null)
    setSel(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
    hintEl.hidden = true
    return
  }

  if (drag.mode === 'move') {
    const dx = e.clientX - drag.ox
    const dy = e.clientY - drag.oy
    let nx = drag.start.x + dx
    let ny = drag.start.y + dy
    nx = clamp(nx, 0, viewW - drag.start.w)
    ny = clamp(ny, 0, viewH - drag.start.h)
    // 移动时按左/上边吸附
    const ax = snapAxis(nx, 'x')
    const ay = snapAxis(ny, 'y')
    if (ax.hit) nx = clamp(ax.value, 0, viewW - drag.start.w)
    if (ay.hit) ny = clamp(ay.value, 0, viewH - drag.start.h)
    showSnap(ax.hit ? nx : null, ay.hit ? ny : null)
    setSel(nx, ny, drag.start.w, drag.start.h)
    return
  }

  if (drag.mode === 'resize') {
    const dx = e.clientX - drag.ox
    const dy = e.clientY - drag.oy
    const s = drag.start
    let x1 = s.x
    let y1 = s.y
    let x2 = s.x + s.w
    let y2 = s.y + s.h

    if (drag.dir.includes('w')) { const ax = snapAxis(s.x + dx, 'x'); x1 = ax.hit ? ax.value : s.x + dx }
    if (drag.dir.includes('e')) { const ax = snapAxis(s.x + s.w + dx, 'x'); x2 = ax.hit ? ax.value : s.x + s.w + dx }
    if (drag.dir.includes('n')) { const ay = snapAxis(s.y + dy, 'y'); y1 = ay.hit ? ay.value : s.y + dy }
    if (drag.dir.includes('s')) { const ay = snapAxis(s.y + s.h + dy, 'y'); y2 = ay.hit ? ay.value : s.y + s.h + dy }

    x1 = clamp(x1, 0, viewW)
    x2 = clamp(x2, 0, viewW)
    y1 = clamp(y1, 0, viewH)
    y2 = clamp(y2, 0, viewH)

    if (x2 - x1 < MIN_SEL || y2 - y1 < MIN_SEL) return
    showSnap(x2, y2)
    setSel(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
    return
  }

  if (drag.mode === 'draw' || stage === 'drawing') {
    if (!draft) return
    const p = localPoint(e)
    if (draft.type === 'pen') {
      draft.points.push(p)
    } else if (draft.type === 'arrow') {
      draft.x2 = p.x
      draft.y2 = p.y
    } else {
      draft.w = p.x - draft.x
      draft.h = p.y - draft.y
    }
    renderAll()
  }
}

function onUp (e) {
  if (!drag && stage !== 'drawing') return

  if (stage === 'drawing' && draft) {
    const ok = draft.type === 'pen'
      ? (draft.points || []).length > 1
      : (Math.abs(draft.w) > 3 || Math.abs(draft.h) > 3 || Math.hypot((draft.x2 || 0) - (draft.x1 || 0), (draft.y2 || 0) - (draft.y1 || 0)) > 6)
    if (ok) {
      shapes.push(draft)
      pushHistory()
    }
    draft = null
    stage = sel.w >= MIN_SEL ? 'ready' : 'idle'
    renderAll()
  }

  // 单击：采用鼠标下的候选窗口区域，并立即抓取
  if (drag && drag.mode === 'pending') {
    drag = null
    hideSnap()
    const rect = detectRect(e.clientX, e.clientY)
    if (isUsableRect(rect)) {
      setSel(rect.x, rect.y, rect.w, rect.h)
      stage = 'ready'
      hideHover()
      grabAndAnnotate()
    } else {
      setSel(0, 0, 0, 0)
      stage = 'idle'
      hintEl.hidden = false
      updateUI()
    }
    return
  }

  // 拖拽框选：松手立即抓取，无需再确认
  if (drag && drag.mode === 'new') {
    if (sel.w < MIN_SEL || sel.h < MIN_SEL) {
      const x1 = drag.x0
      const y1 = drag.y0
      const x2 = e.clientX
      const y2 = e.clientY
      setSel(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
    }
    drag = null
    hideSnap()
    if (sel.w >= MIN_SEL && sel.h >= MIN_SEL) {
      stage = 'ready'
      grabAndAnnotate()
    } else {
      setSel(0, 0, 0, 0)
      stage = 'idle'
      hintEl.hidden = false
      updateUI()
    }
    return
  }

  drag = null
  hideSnap()
  updateUI()
}

/**
 * Esc 的唯一出口：窗口内按键和主进程转发（全局快捷键）都走这里，
 * 保证两条路径的分级行为完全一致。
 */
function handleEscape () {
  try {
    if (stage === 'texting') { commitText(false); return }
    if (stage === 'drawing' && draft) {
      draft = null
      stage = 'ready'
      renderAll()
      return
    }
  } catch (_) {
    // 分级处理出错时也要保证能退出
  }
  api.cancelCapture()
}

function onKeyDown (e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    handleEscape()
    return
  }
  if (e.key === 'Enter' && stage !== 'texting') {
    e.preventDefault()
    if (phase === 'annotate') doInsert()
    return
  }

  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    if (phase === 'annotate') doCopy()
    return
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault()
    if (phase === 'annotate') doSave()
    return
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (phase !== 'annotate') return
    if (e.shiftKey) redo(); else undo()
    return
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    if (phase === 'annotate') redo()
    return
  }
  if (mod) return
  if (phase !== 'annotate') return

  const map = { r: 'rect', o: 'ellipse', a: 'arrow', p: 'pen', m: 'mosaic', t: 'text' }
  const k = e.key.toLowerCase()
  if (map[k]) {
    e.preventDefault()
    setTool(map[k])
  }
}

// ---------------------------------------------------------------- 工具栏 / UI
function updateUI () {
  syncViewport()
  const valid = sel.w >= MIN_SEL && sel.h >= MIN_SEL
  // 工具栏只在标注阶段出现：框选一松手就抓图，选框阶段不需要工具栏
  toolbar.hidden = !(phase === 'annotate' && valid)
  hintEl.hidden = (phase !== 'select') || valid
  document.body.classList.toggle('capture-busy', valid)

  if (!toolbar.hidden) positionToolbar()
  applySelStyle()
  updateUndoButtons()
}

/** 阶段切换：select（框选）→ grabbing（抓取中）→ annotate（标注） */
function setPhase (p) {
  phase = p
  document.body.dataset.phase = p

  if (p === 'select') {
    selEl.dataset.annotated = '0'
    // 清掉上一轮残留的画面
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    hideHover()
  } else if (p === 'annotate') {
    selEl.dataset.annotated = '1'
    hideHover()
  }
  updateUI()
}

/**
 * 确认选区 → 抓取该区域 → 进入标注。
 * 抓之前必须先把窗口内容藏干净，否则截出来的图会带上遮罩和选框。
 */
async function grabAndAnnotate () {
  if (phase !== 'select') return
  if (sel.w < MIN_SEL || sel.h < MIN_SEL) { toast('请先框选一块区域'); return }

  // 选区是相对窗口的，换算成相对显示器原点
  const rect = {
    x: sel.x + align.dx,
    y: sel.y + align.dy,
    w: sel.w,
    h: sel.h
  }

  setPhase('grabbing')

  // 两帧 + 120ms：确保隐藏后的画面已经提交给合成器
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  await new Promise(r => setTimeout(r, 120))

  let res = null
  try {
    res = await api.grabRegion(rect)
  } catch (err) {
    res = { error: err.message }
  }

  if (!res || res.error) {
    setPhase('select')
    toast((res && res.error) || '截图失败，请重试')
    return
  }

  try {
    shotImg = await loadImage(res.dataUrl)
  } catch (err) {
    setPhase('select')
    toast('截图解码失败')
    return
  }

  shapes = []
  draft = null
  history = []
  hIdx = -1
  stage = 'ready'

  setPhase('annotate')
  setTool('rect')
  renderAll()
  pushHistory()
  toast(`已截取 ${res.width} × ${res.height}`)
}

function positionToolbar () {
  if (toolbar.hidden) return
  const tw2 = toolbar.offsetWidth || 620
  const th2 = toolbar.offsetHeight || 44
  // 优先与选区居中对齐，选区太窄时再退回贴边
  let left = sel.x + (sel.w - tw2) / 2
  left = clamp(left, 8, Math.max(8, viewW - tw2 - 8))
  let top = sel.y + sel.h + 12
  if (top + th2 > viewH - 8) top = sel.y - th2 - 12
  if (top < 8) top = clamp(sel.y + sel.h - th2 - 12, 8, viewH - th2 - 8)
  toolbar.style.left = Math.round(left) + 'px'
  toolbar.style.top = Math.round(top) + 'px'
}

function setTool (t) {
  tool = t
  document.querySelectorAll('.tool').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === t)
  })
  document.body.style.cursor = t === 'move' ? 'default' : 'crosshair'
  document.querySelector('#widthRow').hidden = (t === 'text')
  document.querySelector('#sizeRow').hidden = (t !== 'text')
}

function buildPalette () {
  const wrap = $('#colors')
  wrap.innerHTML = ''
  COLORS.forEach(c => {
    const b = document.createElement('button')
    b.className = 'sw'
    b.style.background = c
    b.dataset.color = c
    b.title = c
    if (c === color) b.classList.add('active')
    b.addEventListener('click', () => {
      color = c
      document.querySelectorAll('.sw').forEach(x => x.classList.toggle('active', x.dataset.color === c))
      $('#customColor').value = c
    })
    wrap.appendChild(b)
  })

  $('#customColor').addEventListener('input', (e) => {
    color = e.target.value
    document.querySelectorAll('.sw').forEach(x => x.classList.remove('active'))
  })

  $('#lineWidth').addEventListener('input', (e) => { lineWidth = Number(e.target.value) })
  $('#fontSize').addEventListener('input', (e) => { fontSize = Number(e.target.value) })

  document.querySelectorAll('.tool').forEach(b => {
    b.addEventListener('click', () => setTool(b.dataset.tool))
  })
  document.querySelector('[data-act="undo"]').addEventListener('click', undo)
  document.querySelector('[data-act="redo"]').addEventListener('click', redo)
  document.querySelector('[data-act="cancel"]').addEventListener('click', () => api.cancelCapture())
  document.querySelector('[data-act="ok"]').addEventListener('click', doInsert)
  document.querySelector('[data-act="copy"]').addEventListener('click', doCopy)
  document.querySelector('[data-act="save"]').addEventListener('click', doSave)
  document.querySelector('[data-act="reselect"]').addEventListener('click', backToSelect)

  setTool('move')
}

// ---------------------------------------------------------------- 文字
function startTextInput (e) {
  const p = localPoint(e)
  stage = 'texting'
  textInput.hidden = false
  textInput.value = ''
  textInput.style.color = color
  textInput.style.fontSize = fontSize + 'px'
  textInput.style.left = (sel.x + p.x) + 'px'
  textInput.style.top = (sel.y + p.y) + 'px'
  textInput.style.width = Math.min(240, Math.max(90, sel.x + sel.w - (sel.x + p.x) - 4)) + 'px'
  textInput.style.height = Math.max(28, fontSize * 1.6) + 'px'
  textInput.dataset.x = p.x
  textInput.dataset.y = p.y
  textInput.focus()

  if (!textInput.__bound) {
    textInput.__bound = true
    textInput.addEventListener('keydown', (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitText(true) }
      if (ev.key === 'Escape') { ev.preventDefault(); commitText(false) }
    })
    textInput.addEventListener('blur', () => { if (stage === 'texting') commitText(true) })
  }
  updateTextSize()
}

function updateTextSize () {
  if (textInput.hidden) return
  textInput.style.height = 'auto'
  textInput.style.height = Math.max(28, textInput.scrollHeight + 4) + 'px'
}

function commitText (submit) {
  if (stage !== 'texting') return
  const text = textInput.value.replace(/\s+$/, '')
  const x = Number(textInput.dataset.x || 0)
  const y = Number(textInput.dataset.y || 0)

  // 先离开 texting 状态，避免 hide 触发的 blur 再次进来生成重复文字
  stage = sel.w >= MIN_SEL ? 'ready' : 'idle'
  textInput.hidden = true
  textInput.value = ''

  if (submit && text.trim()) {
    shapes.push({ type: 'text', x, y, text, color, size: fontSize })
    pushHistory()
    renderAll()
  }
  updateUI()
}

// ---------------------------------------------------------------- 吸附线 / 坐标提示
function showSnap (xv, yv) {
  if (xv === null || xv === undefined) {
    snapV.hidden = true
  } else {
    snapV.hidden = false
    snapV.style.left = Math.round(xv) + 'px'
    snapV.style.top = '0px'
    snapV.style.height = viewH + 'px'
  }
  if (yv === null || yv === undefined) {
    snapH.hidden = true
  } else {
    snapH.hidden = false
    snapH.style.top = Math.round(yv) + 'px'
    snapH.style.left = '0px'
    snapH.style.width = viewW + 'px'
  }
}

function hideSnap () {
  snapV.hidden = true
  snapH.hidden = true
}

function updateCrossInfo (e) {
  if (stage === 'idle' && !drag) { crossInfo.hidden = true; return }
  crossInfo.hidden = false
  const x = Math.round(e.clientX)
  const y = Math.round(e.clientY)
  const text = stage === 'ready' && pointInSel(x, y)
    ? `${Math.round(x - sel.x)}, ${Math.round(y - sel.y)}`
    : `${x}, ${y}`
  crossInfo.textContent = text
  let left = x + 16
  let top = y + 18
  if (left + 70 > viewW) left = x - 80
  if (top + 24 > viewH) top = y - 28
  crossInfo.style.left = left + 'px'
  crossInfo.style.top = top + 'px'
}

// ---------------------------------------------------------------- 完成 / 取消
// ---------------------------------------------------------------- 输出动作
function ensureAnnotated () {
  if (phase !== 'annotate' || !shotImg) {
    toast('请先框选一块区域')
    return false
  }
  return true
}

function exportPng () {
  if (draft) { shapes.push(draft); draft = null }
  renderAll()
  return canvas.toDataURL('image/png')
}

/** 插入便签 */
async function doInsert () {
  if (!ensureAnnotated()) return
  await api.finishCapture({ dataUrl: exportPng() })
}

/** 复制到剪贴板：主进程写剪贴板后关闭截图窗口 */
async function doCopy () {
  if (!ensureAnnotated()) return
  const res = await api.copyCapture({ dataUrl: exportPng() })
  if (res && res.error) toast(res.error)
}

/** 保存到用户指定路径 */
async function doSave () {
  if (!ensureAnnotated()) return
  const res = await api.saveCapture({ dataUrl: exportPng() })
  if (!res) return
  if (res.error) { toast(res.error); return }
  if (res.canceled) return
}

/** 回到框选阶段重新选（清空标注） */
function backToSelect () {
  if (phase !== 'annotate') return
  shotImg = null
  shapes = []
  draft = null
  history = []
  hIdx = -1
  stage = 'idle'
  setSel(0, 0, 0, 0)
  setPhase('select')
  hintEl.hidden = false
  updateUI()
}

let toastTimer = null
function toast (msg) {
  toastEl.textContent = msg
  toastEl.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastEl.hidden = true }, 1600)
}

// 便于在控制台/自动化脚本里对吸附算法做自检
window.__captureDebug = {
  computeEdgeScores,
  subpixel,
  refinePeak,
  detectRect,
  snapAxis,
  scores: () => ({ colScore, rowScore, thrCol, thrRow, tw, th })
}
