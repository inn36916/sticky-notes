'use strict'

/**
 * Mermaid 画板
 * - 拖拽组件 → 连线 → 生成 graph 代码
 * - 支持从已有 mermaid 代码反解析回图形
 * - 「应用到便签」通过主进程回写到发起编辑的便签
 */

const api = window.sticky
const $ = (s) => document.querySelector(s)

const svg = $('#svg')
const nodeLayer = $('#nodeLayer')
const edgeLayer = $('#edgeLayer')
const tempLine = $('#tempLine')
const canvasInner = $('#canvasInner')
const canvasShell = $('#canvasShell')
const paletteShapes = $('#paletteShapes')
const emptyHint = $('#emptyHint')
const codeEl = $('#code')
const dirSel = $('#dir')
const zoomVal = $('#zoomVal')

let nodes = []
let edges = []
let selection = null       // { type:'node'|'edge', id }
let tool = 'select'
let zoom = 1
let seq = 1

let drag = null            // { id, sx, sy, ox, oy, moved }
let linking = null         // { from, start }
let raf = 0

// ---------------------------------------------------------------- 形状定义
const SHAPES = {
  rect: { label: '矩形', w: 140, h: 60, syntax: (t) => `[${t}]` },
  round: { label: '圆角', w: 140, h: 60, syntax: (t) => `(${t})` },
  stadium: { label: '胶囊', w: 140, h: 56, syntax: (t) => `([${t}])` },
  diamond: { label: '判断', w: 150, h: 92, syntax: (t) => `{${t}}` },
  circle: { label: '圆形', w: 110, h: 92, syntax: (t) => `((${t}))` },
  cylinder: { label: '数据', w: 130, h: 78, syntax: (t) => `[(${t})]` },
  subroutine: { label: '子程序', w: 150, h: 62, syntax: (t) => `[[${t}]]` },
  hexagon: { label: '六边形', w: 140, h: 72, syntax: (t) => `{{${t}}}` }
}

const PALETTE_ICONS = {
  rect: '<rect x="2" y="5" width="30" height="16" rx="2" class="shp"/>',
  round: '<rect x="2" y="5" width="30" height="16" rx="6" class="shp"/>',
  stadium: '<rect x="2" y="6" width="30" height="14" rx="7" class="shp"/>',
  diamond: '<polygon points="17,4 32,13 17,22 2,13" class="shp"/>',
  circle: '<ellipse cx="17" cy="13" rx="14" ry="9" class="shp"/>',
  cylinder: '<path d="M4,8 a13,4 0 0 1 26,0 v10 a13,4 0 0 1 -26,0 z" class="shp"/><path d="M4,8 a13,4 0 0 0 26,0" fill="none" stroke="#8d95a3" stroke-width="1.2"/>',
  subroutine: '<rect x="2" y="5" width="30" height="16" class="shp"/><path d="M8,5v16M26,5v16" fill="none" stroke="#8d95a3" stroke-width="1.2"/>',
  hexagon: '<polygon points="9,5 25,5 32,13 25,21 9,21 2,13" class="shp"/>'
}

// ---------------------------------------------------------------- 基础工具
const uid = (p) => p + (seq++).toString(36)
const findNode = (id) => nodes.find(n => n.id === id) || null
const findEdge = (id) => edges.find(e => e.id === id) || null

const escapeHtml = (window.StickyUtils && window.StickyUtils.escapeHtml) ||
  (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))

function svgPoint (evt) {
  const pt = svg.createSVGPoint()
  pt.x = evt.clientX
  pt.y = evt.clientY
  return pt.matrixTransform(svg.getScreenCTM().inverse())
}

// ---------------------------------------------------------------- 渲染
function shapeSvg (n) {
  const w = n.w
  const h = n.h
  const fill = n.fill || '#ffffff'
  const stroke = n.stroke || '#b9c0cc'
  const common = `class="shape" fill="${fill}" stroke="${stroke}"`

  switch (n.shape) {
    case 'round':
      return `<rect ${common} width="${w}" height="${h}" rx="14" ry="14"/>`
    case 'stadium':
      return `<rect ${common} width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}"/>`
    case 'diamond':
      return `<polygon ${common} points="${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}"/>`
    case 'circle':
      return `<ellipse ${common} cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}"/>`
    case 'cylinder': {
      const ry = Math.min(12, h / 5)
      return `<path ${common} d="M0,${ry} a${w / 2},${ry} 0 0 1 ${w},0 v${h - ry * 2} a${w / 2},${ry} 0 0 1 ${-w},0 z"/>
              <path d="M0,${ry} a${w / 2},${ry} 0 0 0 ${w},0" fill="none" stroke="${stroke}" stroke-width="1.4"/>`
    }
    case 'subroutine':
      return `<rect ${common} width="${w}" height="${h}" rx="3"/>
              <path d="M10,0 v${h} M${w - 10},0 v${h}" fill="none" stroke="${stroke}" stroke-width="1.4"/>`
    case 'hexagon':
      return `<polygon ${common} points="${w * 0.16},0 ${w * 0.84},0 ${w},${h / 2} ${w * 0.84},${h} ${w * 0.16},${h} 0,${h / 2}"/>`
    default:
      return `<rect ${common} width="${w}" height="${h}" rx="6"/>`
  }
}

function portsSvg (n) {
  const w = n.w
  const h = n.h
  return ['t', 'r', 'b', 'l'].map(p => {
    const pos = {
      t: [w / 2, 0], r: [w, h / 2], b: [w / 2, h], l: [0, h / 2]
    }[p]
    return `<circle class="port" data-port="${p}" cx="${pos[0]}" cy="${pos[1]}" r="4.6"/>`
  }).join('')
}

function renderNodes () {
  nodeLayer.innerHTML = nodes.map(n => {
    const selected = selection && selection.type === 'node' && selection.id === n.id
    return `<g class="node${selected ? ' selected' : ''}" data-id="${n.id}"
               transform="translate(${n.x},${n.y})">
      ${shapeSvg(n)}
      <foreignObject x="0" y="0" width="${n.w}" height="${n.h}">
        <div xmlns="http://www.w3.org/1999/xhtml" class="node-text">${escapeHtml(n.text)}</div>
      </foreignObject>
      ${portsSvg(n)}
    </g>`
  }).join('')
}

/** 从节点中心指向目标中心的射线，与节点轮廓的交点 */
function anchorPoint (node, other) {
  const cx = node.x + node.w / 2
  const cy = node.y + node.h / 2
  const ox = other.x + other.w / 2
  const oy = other.y + other.h / 2
  let dx = ox - cx
  let dy = oy - cy
  if (!dx && !dy) return { x: cx, y: cy }

  const hw = node.w / 2
  const hh = node.h / 2
  let t
  if (node.shape === 'diamond') {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
  } else if (node.shape === 'circle') {
    t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2)
  } else {
    t = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6))
  }
  return { x: cx + dx * t, y: cy + dy * t }
}

function edgePath (e) {
  const a = findNode(e.from)
  const b = findNode(e.to)
  if (!a || !b) return null
  const p1 = anchorPoint(a, b)
  const p2 = anchorPoint(b, a)
  return { p1, p2, d: `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} L${p2.x.toFixed(1)},${p2.y.toFixed(1)}` }
}

function renderEdges () {
  edgeLayer.innerHTML = edges.map(e => {
    const g = edgePath(e)
    if (!g) return ''
    const selected = selection && selection.type === 'edge' && selection.id === e.id
    const mx = (g.p1.x + g.p2.x) / 2
    const my = (g.p1.y + g.p2.y) / 2
    const label = e.label
      ? `<foreignObject x="${mx - 46}" y="${my - 11}" width="92" height="22">
           <div xmlns="http://www.w3.org/1999/xhtml" class="edge-label">${escapeHtml(e.label)}</div>
         </foreignObject>`
      : ''
    return `<g class="edge ${e.style || 'solid'}${selected ? ' selected' : ''}" data-id="${e.id}">
      <path class="edge-line" d="${g.d}"/>
      ${label}
    </g>`
  }).join('')
}

function updateEmptyHint () {
  emptyHint.hidden = nodes.length > 0
}

function render () {
  renderEdges()
  renderNodes()
  updateEmptyHint()
  updateCode()
  updateInspector()
  updateUndoButtons()
}

function redrawEdges () {
  renderEdges()
}

// ---------------------------------------------------------------- 代码生成
function nodeText (n) {
  const raw = (n.text || '').trim() || '未命名'
  if (/["[\](){}|<>#]/.test(raw)) return '"' + raw.replace(/"/g, '#quot;') + '"'
  return raw
}

function edgeLabel (e) {
  const raw = (e.label || '').trim()
  return raw ? raw.replace(/\|/g, '/').replace(/[\n\r]/g, ' ') : ''
}

function toMermaid () {
  const dir = dirSel.value || 'TD'
  // 按视觉位置排序，让自动布局尽量贴近画布顺序
  const ordered = [...nodes].sort((a, b) => (
    dir === 'TD' ? (a.y - b.y || a.x - b.x) : (a.x - b.x || a.y - b.y)
  ))
  const idMap = new Map()
  ordered.forEach((n, i) => idMap.set(n.id, 'N' + (i + 1)))

  const lines = [`graph ${dir}`]
  for (const n of ordered) {
    const syntax = (SHAPES[n.shape] || SHAPES.rect).syntax
    lines.push(`  ${idMap.get(n.id)}${syntax(nodeText(n))}`)
  }
  for (const e of edges) {
    const from = idMap.get(e.from)
    const to = idMap.get(e.to)
    if (!from || !to) continue
    const arrow = e.style === 'dashed' ? '-.->' : e.style === 'thick' ? '==>' : '-->'
    const lb = edgeLabel(e)
    lines.push(`  ${from} ${arrow}${lb ? `|${lb}|` : ''} ${to}`)
  }
  return lines.join('\n')
}

function updateCode () {
  codeEl.textContent = nodes.length ? toMermaid() : 'graph TD\n  %% 从左侧拖入组件开始绘制'
}

// ---------------------------------------------------------------- 选择 / 属性
function select (sel) {
  selection = sel
  renderNodes()
  renderEdges()
  updateInspector()
}

/** 正在输入的控件不要被重绘覆盖（否则光标会跳） */
function setIfIdle (sel, value) {
  const el = $(sel)
  if (!el || document.activeElement === el) return
  el.value = value
}

function updateInspector () {
  const nodeBody = $('#insNode')
  const edgeBody = $('#insEdge')
  const emptyEl = $('#insEmpty')

  if (selection && selection.type === 'node') {
    const n = findNode(selection.id)
    if (!n) { selection = null; return updateInspector() }
    emptyEl.hidden = true
    nodeBody.hidden = false
    edgeBody.hidden = true
    setIfIdle('#insText', n.text || '')
    setIfIdle('#insShape', n.shape)
    setIfIdle('#insFill', n.fill || '#ffffff')
    setIfIdle('#insStroke', n.stroke || '#b9c0cc')
    setIfIdle('#insW', n.w)
    setIfIdle('#insH', n.h)
    return
  }

  if (selection && selection.type === 'edge') {
    const e = findEdge(selection.id)
    if (!e) { selection = null; return updateInspector() }
    emptyEl.hidden = true
    nodeBody.hidden = true
    edgeBody.hidden = false
    setIfIdle('#insLabel', e.label || '')
    setIfIdle('#insStyle', e.style || 'solid')
    return
  }

  emptyEl.hidden = false
  nodeBody.hidden = true
  edgeBody.hidden = true
}

// ---------------------------------------------------------------- 历史
let history = []
let hIdx = -1

function snapshot () {
  return JSON.stringify({ nodes, edges, dir: dirSel.value })
}

function pushHistory () {
  const snap = snapshot()
  if (history[hIdx] === snap) return
  history = history.slice(0, hIdx + 1)
  history.push(snap)
  if (history.length > 80) history.shift()
  hIdx = history.length - 1
  updateUndoButtons()
}

function restore (snap) {
  const data = JSON.parse(snap)
  nodes = data.nodes || []
  edges = data.edges || []
  if (data.dir && data.dir !== dirSel.value) dirSel.value = data.dir
  selection = null
  render()
}

function undo () {
  if (hIdx <= 0) return
  hIdx -= 1
  restore(history[hIdx])
}

function redo () {
  if (hIdx >= history.length - 1) return
  hIdx += 1
  restore(history[hIdx])
}

function updateUndoButtons () {
  const u = document.querySelector('[data-act="undo"]')
  const r = document.querySelector('[data-act="redo"]')
  if (u) u.disabled = hIdx <= 0
  if (r) r.disabled = hIdx >= history.length - 1
}

// ---------------------------------------------------------------- 增删改
function addNode (shapeKey, x, y) {
  const def = SHAPES[shapeKey] || SHAPES.rect
  const node = {
    id: uid('n'),
    shape: shapeKey,
    text: '',
    x: Math.round(x - def.w / 2),
    y: Math.round(y - def.h / 2),
    w: def.w,
    h: def.h,
    fill: '#ffffff',
    stroke: '#b9c0cc'
  }
  nodes.push(node)
  selection = { type: 'node', id: node.id }
  render()
  pushHistory()
  // 拖进来直接进入文字编辑，顺手
  const gEl = nodeLayer.querySelector(`.node[data-id="${node.id}"]`)
  if (gEl) setTimeout(() => editNodeText(node, gEl), 30)
  return node
}

function addEdge (from, to) {
  if (from === to) return
  if (edges.some(e => e.from === from && e.to === to)) return
  edges.push({ id: uid('e'), from, to, label: '', style: 'solid' })
  render()
  pushHistory()
}

function deleteSelection () {
  if (!selection) return
  if (selection.type === 'node') {
    nodes = nodes.filter(n => n.id !== selection.id)
    edges = edges.filter(e => e.from !== selection.id && e.to !== selection.id)
  } else {
    edges = edges.filter(e => e.id !== selection.id)
  }
  selection = null
  render()
  pushHistory()
}

function editNodeText (node, gEl) {
  const rect = gEl.getBoundingClientRect()
  const ta = document.createElement('textarea')
  ta.className = 'node-input'
  ta.value = node.text || ''
  ta.style.left = rect.left + 'px'
  ta.style.top = rect.top + 'px'
  ta.style.width = Math.max(90, rect.width) + 'px'
  ta.style.height = Math.max(36, rect.height) + 'px'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()

  let done = false
  const commit = () => {
    if (done) return
    done = true
    node.text = ta.value.trim()
    ta.remove()
    render()
    pushHistory()
  }
  ta.addEventListener('blur', commit)
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
    if (e.key === 'Escape') { done = true; ta.remove(); render() }
  })
}

// ---------------------------------------------------------------- 画布交互
svg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  const portEl = e.target.closest('.port')
  const nodeEl = e.target.closest('.node')
  const edgeEl = e.target.closest('.edge')

  // 从端口拖线（任何模式下都能用）
  if (portEl && nodeEl) {
    e.preventDefault()
    const node = findNode(nodeEl.dataset.id)
    if (!node) return
    const p = svgPoint(e)
    linking = { from: node.id, start: p }
    tempLine.setAttribute('d', `M${p.x},${p.y} L${p.x},${p.y}`)
    tempLine.style.display = ''
    svg.setPointerCapture(e.pointerId)
    return
  }

  // 连线模式下点节点 = 开始连线
  if (nodeEl && tool === 'connect') {
    e.preventDefault()
    const node = findNode(nodeEl.dataset.id)
    if (!node) return
    const p = svgPoint(e)
    linking = { from: node.id, start: p }
    tempLine.setAttribute('d', `M${p.x},${p.y} L${p.x},${p.y}`)
    tempLine.style.display = ''
    svg.setPointerCapture(e.pointerId)
    select({ type: 'node', id: node.id })
    return
  }

  if (nodeEl) {
    e.preventDefault()
    const node = findNode(nodeEl.dataset.id)
    if (!node) return
    select({ type: 'node', id: node.id })
    drag = { id: node.id, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y, moved: false }
    svg.setPointerCapture(e.pointerId)
    return
  }

  if (edgeEl) {
    e.preventDefault()
    select({ type: 'edge', id: edgeEl.dataset.id })
    return
  }

  select(null)
})

svg.addEventListener('pointermove', (e) => {
  if (drag) {
    const node = findNode(drag.id)
    if (!node) return
    const dx = (e.clientX - drag.sx) / zoom
    const dy = (e.clientY - drag.sy) / zoom
    node.x = Math.round(drag.ox + dx)
    node.y = Math.round(drag.oy + dy)
    const gEl = nodeLayer.querySelector(`.node[data-id="${node.id}"]`)
    if (gEl) gEl.setAttribute('transform', `translate(${node.x},${node.y})`)
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return
    drag.moved = true
    if (raf) return
    raf = requestAnimationFrame(() => { raf = 0; redrawEdges() })
    return
  }

  if (linking) {
    const p = svgPoint(e)
    tempLine.setAttribute('d', `M${linking.start.x},${linking.start.y} L${p.x},${p.y}`)
  }
})

svg.addEventListener('pointerup', (e) => {
  if (drag) {
    if (drag.moved) pushHistory()
    drag = null
    render()
    return
  }

  if (linking) {
    tempLine.style.display = 'none'
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const target = el && el.closest ? el.closest('.node') : null
    const from = linking.from
    linking = null
    if (target && target.dataset.id !== from) {
      addEdge(from, target.dataset.id)
      if (tool === 'connect') setTool('select')
    } else {
      render()
    }
  }
})

svg.addEventListener('pointercancel', () => {
  drag = null
  linking = null
  tempLine.style.display = 'none'
})

svg.addEventListener('dblclick', (e) => {
  const nodeEl = e.target.closest('.node')
  if (!nodeEl) return
  const node = findNode(nodeEl.dataset.id)
  if (node) editNodeText(node, nodeEl)
})

// ---------------------------------------------------------------- 组件面板
Object.entries(SHAPES).forEach(([key, def]) => {
  const item = document.createElement('div')
  item.className = 'shape-item'
  item.dataset.shape = key
  item.innerHTML = `<svg viewBox="0 0 34 26">${PALETTE_ICONS[key] || ''}</svg><span>${def.label}</span>`
  paletteShapes.appendChild(item)
})

let ghost = null
paletteShapes.addEventListener('pointerdown', (e) => {
  const item = e.target.closest('.shape-item')
  if (!item) return
  e.preventDefault()
  const key = item.dataset.shape
  ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  ghost.style.cssText = 'padding:9px 16px;background:#fff;border:1.5px solid #e9a92b;border-radius:9px;font:600 12px/1 "Microsoft YaHei",sans-serif;color:#8a5c00'
  ghost.textContent = SHAPES[key].label
  document.body.appendChild(ghost)
  moveGhost(e)

  const onMove = (ev) => moveGhost(ev)
  const onUp = (ev) => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (ghost) { ghost.remove(); ghost = null }
    const rect = svg.getBoundingClientRect()
    if (ev.clientX < rect.left || ev.clientX > rect.right ||
        ev.clientY < rect.top || ev.clientY > rect.bottom) return
    const p = svgPoint(ev)
    addNode(key, p.x, p.y)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
})

function moveGhost (e) {
  if (!ghost) return
  ghost.style.left = e.clientX + 'px'
  ghost.style.top = e.clientY + 'px'
}

// ---------------------------------------------------------------- 属性面板
$('#insText').addEventListener('input', (e) => {
  if (!selection || selection.type !== 'node') return
  const n = findNode(selection.id)
  if (!n) return
  n.text = e.target.value
  renderNodes()
  updateCode()
})
$('#insText').addEventListener('change', () => { pushHistory(); render() })

$('#insShape').addEventListener('change', (e) => {
  if (!selection || selection.type !== 'node') return
  const n = findNode(selection.id)
  if (!n) return
  n.shape = e.target.value
  const def = SHAPES[n.shape] || SHAPES.rect
  // 形状变了给个合理尺寸下限
  n.w = Math.max(n.w, Math.round(def.w * 0.8))
  n.h = Math.max(n.h, Math.round(def.h * 0.8))
  render()
  pushHistory()
})

$('#insFill').addEventListener('input', (e) => {
  if (!selection || selection.type !== 'node') return
  const n = findNode(selection.id)
  if (!n) return
  n.fill = e.target.value
  renderNodes()
})
$('#insFill').addEventListener('change', () => pushHistory())

$('#insStroke').addEventListener('input', (e) => {
  if (!selection || selection.type !== 'node') return
  const n = findNode(selection.id)
  if (!n) return
  n.stroke = e.target.value
  renderNodes()
})
$('#insStroke').addEventListener('change', () => pushHistory())

$('#insW').addEventListener('input', (e) => {
  if (!selection || selection.type !== 'node') return
  const n = findNode(selection.id)
  if (!n) return
  n.w = Math.max(70, Math.min(420, Number(e.target.value) || n.w))
  renderNodes()
  redrawEdges()
})
$('#insW').addEventListener('change', () => pushHistory())

$('#insH').addEventListener('input', (e) => {
  if (!selection || selection.type !== 'node') return
  const n = findNode(selection.id)
  if (!n) return
  n.h = Math.max(40, Math.min(260, Number(e.target.value) || n.h))
  renderNodes()
  redrawEdges()
})
$('#insH').addEventListener('change', () => pushHistory())

$('#insLabel').addEventListener('input', (e) => {
  if (!selection || selection.type !== 'edge') return
  const edge = findEdge(selection.id)
  if (!edge) return
  edge.label = e.target.value
  renderEdges()
  updateCode()
})
$('#insLabel').addEventListener('change', () => pushHistory())

$('#insStyle').addEventListener('change', (e) => {
  if (!selection || selection.type !== 'edge') return
  const edge = findEdge(selection.id)
  if (!edge) return
  edge.style = e.target.value
  renderEdges()
  pushHistory()
})

$('[data-act="del-node"]').addEventListener('click', () => deleteSelection())
$('[data-act="del-edge"]').addEventListener('click', () => deleteSelection())

// ---------------------------------------------------------------- 顶栏操作
function setTool (t) {
  tool = t
  document.querySelectorAll('[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === t)
  })
  svg.style.cursor = t === 'connect' ? 'crosshair' : ''
  if (t === 'connect') toastHint('连线模式：从一个节点拖到另一个节点')
}

let hintTimer = null
function toastHint (msg) {
  const el = emptyHint
  if (!nodes.length) return
  // 有内容时不显示空态，用临时提示
  const tip = document.createElement('div')
  tip.style.cssText = 'position:absolute;left:50%;bottom:20px;transform:translateX(-50%);background:rgba(31,35,40,.88);color:#fff;padding:7px 14px;border-radius:99px;font:500 11.5px/1.4 "Microsoft YaHei",sans-serif;z-index:20;pointer-events:none'
  tip.textContent = msg
  canvasShell.appendChild(tip)
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => tip.remove(), 1800)
}

document.querySelectorAll('[data-tool]').forEach(b => {
  b.addEventListener('click', () => setTool(b.dataset.tool))
})

document.querySelector('[data-act="undo"]').addEventListener('click', undo)
document.querySelector('[data-act="redo"]').addEventListener('click', redo)

document.querySelector('[data-act="clear"]').addEventListener('click', () => {
  if (!nodes.length && !edges.length) return
  if (!window.confirm('清空画布上的所有内容？')) return
  nodes = []
  edges = []
  selection = null
  render()
  pushHistory()
})

dirSel.addEventListener('change', () => { updateCode(); pushHistory() })

document.querySelector('[data-act="copy"]').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(toMermaid())
  } catch (_) {
    const ta = document.createElement('textarea')
    ta.value = toMermaid()
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  toastHint('代码已复制')
})

document.querySelector('[data-act="toggle-code"]').addEventListener('click', (e) => {
  const bar = $('#codebar')
  const collapsed = bar.classList.toggle('collapsed')
  e.target.textContent = collapsed ? '展开' : '收起'
})

document.querySelector('[data-act="cancel"]').addEventListener('click', () => {
  api.closeDiagram()
})

document.querySelector('[data-act="apply"]').addEventListener('click', async () => {
  if (!nodes.length) { toastHint('画布还是空的，先拖一个组件进来'); return }
  await api.applyDiagram({ code: toMermaid() })
})

// ---------------------------------------------------------------- 缩放
function setZoom (z) {
  zoom = Math.min(1.6, Math.max(0.4, Math.round(z * 100) / 100))
  canvasInner.style.zoom = zoom
  zoomVal.textContent = Math.round(zoom * 100) + '%'
}
document.querySelector('[data-act="zoom-in"]').addEventListener('click', () => setZoom(zoom + 0.1))
document.querySelector('[data-act="zoom-out"]').addEventListener('click', () => setZoom(zoom - 0.1))
document.querySelector('[data-act="zoom-reset"]').addEventListener('click', () => setZoom(1))

// ---------------------------------------------------------------- 键盘
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return

  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo(); else undo()
    return
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    deleteSelection()
    return
  }
  if (e.key === 'Escape') { select(null); return }
  if (e.key.toLowerCase() === 'v') setTool('select')
  if (e.key.toLowerCase() === 'l') setTool('connect')
})

// ---------------------------------------------------------------- 解析已有代码
/**
 * 只解析 graph/flowchart 的常见写法（节点 + 边），
 * 解析不了的一律忽略，避免把画板搞崩。
 */
function parseMermaid (code) {
  const result = { nodes: [], edges: [], dir: 'TD' }
  const text = String(code || '').replace(/\r/g, '')
  const lines = text.split('\n')

  const head = lines[0] || ''
  const m = head.match(/^\s*(?:graph|flowchart)\s+(TD|TB|LR|RL|BT)/i)
  if (m) result.dir = m[1].toUpperCase() === 'TB' ? 'TD' : m[1].toUpperCase()

  const byCode = new Map()   // mermaid 源码 id -> 画板节点
  const shapeRe = /([A-Za-z0-9_]+)\s*(\[\[.*?\]\]|\[\(.*?\)\]|\[.*?\]|\(\(.*?\)\)|\(.*?\)|\{\{.*?\}\}|\{.*?\})/g
  const edgeRe = /([A-Za-z0-9_]+)\s*(-->|---|-\.->|==>|--x|--o)(?:\s*\|([^|]*)\|)?\s*([A-Za-z0-9_]+)/g

  const ensure = (codeId) => {
    if (byCode.has(codeId)) return byCode.get(codeId)
    const node = {
      id: uid('n'),
      shape: 'rect',
      text: codeId,
      x: 0, y: 0, w: 140, h: 60,
      fill: '#ffffff',
      stroke: '#b9c0cc'
    }
    byCode.set(codeId, node)
    result.nodes.push(node)
    return node
  }

  // 由内到外匹配包裹语法，避免 ([[x]]) 之类嵌套误判
  const WRAP_RULES = [
    [/^\[\[([\s\S]*)\]\]$/, 'subroutine'],
    [/^\[\(([\s\S]*)\)\]$/, 'cylinder'],
    [/^\(\[([\s\S]*)\]\)$/, 'stadium'],
    [/^\(\(([\s\S]*)\)\)$/, 'circle'],
    [/^\{\{([\s\S]*)\}\}$/, 'hexagon'],
    [/^\[([\s\S]*)\]$/, 'rect'],
    [/^\(([\s\S]*)\)$/, 'round'],
    [/^\{([\s\S]*)\}$/, 'diamond']
  ]

  function unwrap (wrapped) {
    for (const [re, shape] of WRAP_RULES) {
      const mm = wrapped.match(re)
      if (mm) return { text: mm[1], shape }
    }
    return { text: wrapped, shape: 'rect' }
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*%%/.test(line)) continue

    shapeRe.lastIndex = 0
    let sm
    while ((sm = shapeRe.exec(line)) !== null) {
      const node = ensure(sm[1])
      const info = unwrap(sm[2])
      node.shape = info.shape
      node.text = info.text.replace(/^"([\s\S]*)"$/, '$1').replace(/#quot;/g, '"')
    }

    edgeRe.lastIndex = 0
    let em
    while ((em = edgeRe.exec(line)) !== null) {
      const a = ensure(em[1])
      const b = ensure(em[4])
      if (a.id === b.id) continue
      if (result.edges.some(e => e.from === a.id && e.to === b.id)) continue
      result.edges.push({
        id: uid('e'),
        from: a.id,
        to: b.id,
        label: (em[3] || '').trim(),
        style: em[2] === '-.->' ? 'dashed' : em[2] === '==>' ? 'thick' : 'solid'
      })
    }
  }

  // 简单网格布局
  const cols = Math.max(1, Math.ceil(Math.sqrt(result.nodes.length || 1)))
  result.nodes.forEach((n, i) => {
    n.x = 120 + (i % cols) * 230
    n.y = 100 + Math.floor(i / cols) * 150
  })

  return result
}

// ---------------------------------------------------------------- 初始化
let inited = false

api.onDiagramInit((ctx) => {
  const code = (ctx && ctx.code) || ''
  nodes = []
  edges = []
  selection = null
  history = []
  hIdx = -1
  setZoom(1)

  if (code.trim()) {
    const parsed = parseMermaid(code)
    nodes = parsed.nodes
    edges = parsed.edges
    dirSel.value = parsed.dir
  }

  render()
  pushHistory()

  if (!inited) {
    inited = true
    canvasShell.scrollLeft = 0
    canvasShell.scrollTop = 0
  }
})

render()
setTool('select')
