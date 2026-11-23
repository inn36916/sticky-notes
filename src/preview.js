'use strict'

/** 图片预览：滚轮缩放、拖拽平移、双击在「适应窗口」和「1:1」之间切换 */

const api = window.sticky
const stage = document.getElementById('stage')
const img = document.getElementById('img')
const dimEl = document.getElementById('dim')
const zoomEl = document.getElementById('zoom')

const clamp = (window.StickyUtils && window.StickyUtils.clamp) || ((v, a, b) => Math.min(Math.max(v, a), Math.max(a, b)))

let scale = 1
let tx = 0
let ty = 0
let fitScale = 1

function apply () {
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  zoomEl.textContent = Math.round(scale * 100) + '%'
}

function calcFit () {
  const pad = 40
  const sw = stage.clientWidth - pad * 2
  const sh = stage.clientHeight - pad * 2
  if (!img.naturalWidth || !img.naturalHeight) return 1
  return Math.min(sw / img.naturalWidth, sh / img.naturalHeight, 1)
}

function fit () {
  fitScale = calcFit()
  scale = fitScale
  tx = 0
  ty = 0
  apply()
}

function actual () {
  scale = 1
  tx = 0
  ty = 0
  apply()
}

api.onPreviewInit((payload) => {
  if (!payload || !payload.dataUrl) return
  document.title = payload.title || '查看图片'
  img.classList.remove('ready')
  img.onload = () => {
    dimEl.textContent = `${img.naturalWidth} × ${img.naturalHeight}`
    fit()
    img.classList.add('ready')
  }
  img.src = payload.dataUrl
})

// ---------------- 缩放 ----------------
stage.addEventListener('wheel', (e) => {
  e.preventDefault()
  const old = scale
  const next = clamp(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.1, 8)
  if (Math.abs(next - old) < 1e-4) return

  // 以光标为锚点缩放
  const rect = stage.getBoundingClientRect()
  const cx = e.clientX - rect.left - rect.width / 2
  const cy = e.clientY - rect.top - rect.height / 2
  tx = cx - (cx - tx) * (next / old)
  ty = cy - (cy - ty) * (next / old)
  scale = next
  apply()
}, { passive: false })

// ---------------- 平移 ----------------
let drag = null

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  drag = { x: e.clientX - tx, y: e.clientY - ty }
  stage.classList.add('dragging')
  try { stage.setPointerCapture(e.pointerId) } catch (_) {}
})

stage.addEventListener('pointermove', (e) => {
  if (!drag) return
  tx = e.clientX - drag.x
  ty = e.clientY - drag.y
  apply()
})

const endDrag = () => {
  drag = null
  stage.classList.remove('dragging')
}
stage.addEventListener('pointerup', endDrag)
stage.addEventListener('pointercancel', endDrag)

// ---------------- 双击复位 ----------------
let lastClick = 0
stage.addEventListener('pointerup', () => {
  const now = Date.now()
  if (now - lastClick < 320) {
    if (Math.abs(scale - fitScale) < 0.01) actual()
    else fit()
    lastClick = 0
    return
  }
  lastClick = now
})

// ---------------- 关闭 ----------------
document.getElementById('close').addEventListener('click', () => window.close())

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); window.close() }
  if (e.key === '0') { e.preventDefault(); fit() }
  if (e.key === '1') { e.preventDefault(); actual() }
})

window.addEventListener('resize', () => {
  // 窗口尺寸变化后重新适配（仅当处于"适应"状态）
  if (Math.abs(scale - fitScale) < 0.01) fit()
})
