'use strict'

/**
 * 便签渲染进程逻辑
 * - Obsidian 风格 Markdown 实时编辑与渲染（Live Preview）+ 全源码切换（Ctrl+Shift+M）
 * - LaTeX 数学公式（KaTeX 渲染、弹窗插入、原地编辑）
 * - 富文本编辑 + 截图粘贴/插入 + Mermaid 图表块
 * - 外观设置（颜色/字体/字号/圆角/透明度/置顶/尺寸）
 * - 八向拖拽缩放 + 自动保存（N-01 / N-04）
 */

const api = window.sticky
const $ = (sel) => document.querySelector(sel)

// 「单次克隆」快照模块（lib/dom-snapshot.js，与 Node 单测共用同一份实现）。
const domSnapshot = window.StickyDomSnapshot
if (!domSnapshot) {
  console.error('[snapshot] lib/dom-snapshot.js 未加载，停手路径退化')
}
const noteMd = window.StickyMarkdown

const noteEl = $('#note')
const editor = $('#editor')
const sourceEditor = $('#sourceEditor')
const sourceToggle = $('#sourceToggle')
const titleEl = $('#title')
const panel = $('#panel')
const statsEl = $('#stats')
const savedEl = $('#saved')
const toastEl = $('#toast')

const PALETTE = [
  '#FFF3B0', '#FFE1D0', '#D9F2E4', '#DCEBFF',
  '#E9E0FF', '#FFD9E7', '#EFF1F3', '#2C2E33'
]

let NOTE = null
let theme = null
let noteId = null

// 编辑子视图（瞬态每窗口状态，不入 schema）：'live' | 'source'
let editView = 'live'
let sourceDirty = false

// ============================================================ 工具函数
const _utils = window.StickyUtils
const clamp = (_utils && _utils.clamp) || ((v, a, b) => Math.min(Math.max(v, a), Math.max(a, b)))
const escapeHtml = (_utils && _utils.escapeHtml) || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))

function hexToRgb (hex) {
  let h = String(hex || '').replace('#', '').trim()
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(h)) return { r: 255, g: 243, b: 176 }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  }
}
const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')

/** 颜色混合：a 占 t，b 占 1-t */
function mix (a, b, t) {
  return toHex({
    r: a.r * t + b.r * (1 - t),
    g: a.g * t + b.g * (1 - t),
    b: a.b * t + b.b * (1 - t)
  })
}

function luminance ({ r, g, b }) {
  const f = (v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

let toastTimer = null
function toast (msg) {
  toastEl.textContent = msg
  toastEl.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastEl.hidden = true }, 1600)
}

// ============================================================ 保存队形
let pending = {}
let saveTimer = null
let dirty = false
let stagedVersion = 0

function queueSave (patch) {
  if (patch.theme) {
    patch.theme = Object.assign({}, pending.theme || {}, patch.theme)
  }
  Object.assign(pending, patch)
  let staged = null
  try {
    staged = api.update(patch)
  } catch (err) {
    console.error('[save] 写入内存失败', err)
  }
  if (!staged || !staged.ok) {
    savedEl.textContent = '保存失败（未写入内存）'
    return
  }
  stagedVersion++
  dirty = true
  savedEl.textContent = '编辑中…'
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 350)
}

async function flushSave () {
  clearTimeout(saveTimer)
  saveTimer = null
  if (editView === 'live' && previewTimer) {
    clearTimeout(previewTimer)
    previewTimer = null
    const snap = takeSnapshot()
    updateStats(snap)
    queueSave({
      html: snap.html,
      preview: snap.text.slice(0, 160)
    })
  }
  if (editView === 'source' && sourceDirty) {
    syncSourceToMain({ immediateStats: true })
  }
  if (!dirty || !api) return true
  const versionAtStart = stagedVersion
  try {
    const r = await api.flush()
    if (r && r.ok) {
      if (stagedVersion !== versionAtStart) return false
      dirty = false
      sourceDirty = false
      pending = {}
      const d = new Date()
      savedEl.textContent = '已保存 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      return true
    }
    savedEl.textContent = '保存失败 · 请稍后重试或先备份内容'
    console.error('[save] 落盘失败:', r && r.error)
    return false
  } catch (err) {
    savedEl.textContent = '保存失败 · 请稍后重试或先备份内容'
    console.error(err)
    return false
  }
}

// ============================================================ 外观应用
function applyAppearance () {
  const rgb = hexToRgb(NOTE.color)
  const lum = luminance(rgb)
  const dark = lum < 0.42

  const fg = dark ? mix(rgb, { r: 255, g: 255, b: 255 }, 0.10) : mix(rgb, { r: 26, g: 24, b: 20 }, 0.09)
  const muted = dark ? mix(rgb, { r: 255, g: 255, b: 255 }, 0.42) : mix(rgb, { r: 26, g: 24, b: 20 }, 0.42)
  const accent = dark ? mix(rgb, { r: 255, g: 255, b: 255 }, 0.55) : mix(rgb, { r: 0, g: 0, b: 0 }, 0.30)

  noteEl.style.setProperty('--bg', NOTE.color)
  noteEl.style.setProperty('--fg', fg)
  noteEl.style.setProperty('--muted', muted)
  noteEl.style.setProperty('--accent', accent)
  noteEl.dataset.dark = dark ? '1' : '0'

  const t = theme
  noteEl.style.setProperty('--fs', t.fontSize + 'px')
  noteEl.style.setProperty('--lh', String(t.lineHeight))
  noteEl.style.setProperty('--radius', t.radius + 'px')
  noteEl.style.setProperty('--font-family', t.fontFamily)
  noteEl.style.opacity = String(clamp(t.opacity, 0.4, 1))
  noteEl.dataset.shadow = t.shadow ? '1' : '0'
  noteEl.dataset.toolbar = t.showToolbar ? '1' : '0'
  applyMode()

  $('#colorSwatch').style.background = fg
  $('#textColor').value = rgbToHexSafe(fg)
  const pinBtn = document.querySelector('[data-act="pin"]')
  if (pinBtn) pinBtn.dataset.on = NOTE.alwaysOnTop ? '1' : '0'
}

function rgbToHexSafe (hex) {
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#333333'
}

// ============================================================ 编辑 / 阅读模式
function applyMode () {
  const m = NOTE && NOTE.mode === 'read' ? 'read' : 'edit'
  noteEl.dataset.mode = m
  const editable = m === 'edit'
  if ((editor.getAttribute('contenteditable') === 'true') !== editable) {
    editor.setAttribute('contenteditable', editable ? 'true' : 'false')
  }
  titleEl.readOnly = !editable
}

function setMode (mode, opts = {}) {
  if (!NOTE) return
  const m = mode === 'read' ? 'read' : 'edit'
  if (NOTE.mode === m) return

  if (m === 'read') {
    if (editView === 'source') setEditView('live', { silent: true })
    flushPendingLiveEdits()
    closePanel()
    if (!mmdModal.hidden) closeMermaidModal()
    if (!mathModal.hidden) closeMathModal()
  }

  NOTE.mode = m
  applyMode()
  queueSave({ mode: m })
  if (!opts.silent) {
    toast(m === 'read' ? '阅读模式 · 鼠标移入显示操作' : '已回到编辑模式')
  }
}

// ============================================================ 贴边收纳
let collapsed = false
let collapseEdge = null
let collapseApplied = false

function applyCollapse (state) {
  const nextCollapsed = !!(state && state.collapsed)
  const nextEdge = (state && state.edge) || null
  if (collapseApplied && collapsed === nextCollapsed && collapseEdge === nextEdge) return
  collapseApplied = true
  collapsed = nextCollapsed
  collapseEdge = nextEdge

  noteEl.dataset.collapsed = collapsed ? '1' : '0'
  document.body.dataset.collapsed = collapsed ? '1' : '0'
  if (collapseEdge) {
    document.body.dataset.edge = collapseEdge
    noteEl.dataset.edge = collapseEdge
  } else {
    delete document.body.dataset.edge
    delete noteEl.dataset.edge
  }

  const etTitle = $('#etTitle')
  if (etTitle) etTitle.textContent = (NOTE && (NOTE.title || '便签')) || '便签'
  syncCollapseButton()

  if (!collapsed) {
    syncSizeInputs()
    setTimeout(() => { if (!collapsed) renderAllMermaid() }, 60)
  }
}

function syncCollapseButton () {
  const btn = $('#collapseToggle')
  if (btn) btn.textContent = collapsed ? '展开便签' : '贴边收缩'
}

// ============================================================ 面板控件同步
function syncPanel () {
  const t = theme
  document.querySelectorAll('.sw').forEach(el => {
    el.dataset.active = el.dataset.color.toLowerCase() === NOTE.color.toLowerCase() ? '1' : '0'
  })
  $('#customColor').value = rgbToHexSafe(NOTE.color)
  $('#fontFamily').value = t.fontFamily
  $('#fontSize').value = t.fontSize
  $('#fontSizeVal').textContent = t.fontSize
  $('#lineHeight').value = t.lineHeight
  $('#lineHeightVal').textContent = Number(t.lineHeight).toFixed(2)
  $('#radius').value = t.radius
  $('#radiusVal').textContent = t.radius
  $('#opacity').value = Math.round(t.opacity * 100)
  $('#opacityVal').textContent = Math.round(t.opacity * 100)
  $('#shadow').checked = !!t.shadow
  $('#showToolbar').checked = !!t.showToolbar
  $('#alwaysOnTop').checked = !!NOTE.alwaysOnTop
  $('#edgeCollapse').checked = NOTE.edgeCollapse !== false
  syncCollapseButton()
}

async function syncSizeInputs () {
  const b = await api.getBounds()
  if (b) { $('#wIn').value = b.width; $('#hIn').value = b.height }
}

// ============================================================ KaTeX 渲染
function renderMathNode (node) {
  if (noteMd) noteMd.renderMathNode(node, window.katex)
}

function renderAllMath (root = editor) {
  if (noteMd) noteMd.renderMathInElement(root, window.katex)
}

// ============================================================ 富文本命令 & 消毒
function sanitizeHtml (dirty, opts = {}) {
  if (noteMd) {
    return noteMd.sanitizeHtml(dirty, Object.assign({
      allowTrustNodes: true,
      allowAttachments: !!opts.allowAttachments
    }, opts))
  }
  return String(dirty || '')
}

function insertHtml (html) {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  externalizeImages(tpl.content, false)
  const nodes = Array.from(tpl.content.childNodes)
  if (!nodes.length) return

  const sel = window.getSelection()
  let range
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0)
  } else {
    range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
  }

  livePreviewLock = true
  try {
    if (document.hasFocus() && NOTE && NOTE.mode === 'edit') {
      editor.focus()
      if (sel) { sel.removeAllRanges(); sel.addRange(range) }
      if (document.execCommand('insertHTML', false, tpl.innerHTML)) {
        renderAllMath()
        renderAllMermaid()
        const curSel = window.getSelection()
        if (curSel && curSel.rangeCount && editor.contains(curSel.anchorNode)) {
          lastCaretBlock = topBlockOf(curSel.anchorNode)
          skipRevealBlock = lastCaretBlock
        }
        onEditorChanged()
        return
      }
    }
    range.deleteContents()
    const frag = document.createDocumentFragment()
    nodes.forEach(n => frag.appendChild(n))
    const last = nodes[nodes.length - 1]
    range.insertNode(frag)
    renderAllMath()
    renderAllMermaid()

    if (sel) {
      const after = document.createRange()
      try {
        after.setStartAfter(last)
        after.collapse(true)
        sel.removeAllRanges()
        sel.addRange(after)
      } catch (_) {}
    }
    lastCaretBlock = topBlockOf(last)
    skipRevealBlock = lastCaretBlock
    onEditorChanged()
  } finally {
    livePreviewLock = false
  }
}

function insertSourceText (text) {
  const val = String(text || '')
  if (!val) return
  if (document.activeElement === sourceEditor && document.hasFocus()) {
    if (document.execCommand('insertText', false, val)) {
      onSourceChanged()
      return
    }
  }
  const start = Number.isFinite(sourceEditor.selectionStart) ? sourceEditor.selectionStart : sourceEditor.value.length
  const end = Number.isFinite(sourceEditor.selectionEnd) ? sourceEditor.selectionEnd : start
  sourceEditor.setRangeText(val, start, end, 'end')
  onSourceChanged()
}

function wrapSourceSelection (before, after, placeholder) {
  const start = Number.isFinite(sourceEditor.selectionStart) ? sourceEditor.selectionStart : sourceEditor.value.length
  const end = Number.isFinite(sourceEditor.selectionEnd) ? sourceEditor.selectionEnd : start
  const selected = sourceEditor.value.slice(start, end)
  const inner = selected || placeholder || ''
  const replacement = before + inner + after
  sourceEditor.focus()
  if (document.hasFocus() && document.execCommand('insertText', false, replacement)) {
    if (!selected && placeholder) {
      sourceEditor.setSelectionRange(start + before.length, start + before.length + placeholder.length)
    }
    onSourceChanged()
    return
  }
  sourceEditor.setRangeText(replacement, start, end, 'end')
  if (!selected && placeholder) {
    sourceEditor.setSelectionRange(start + before.length, start + before.length + placeholder.length)
  }
  onSourceChanged()
}

function prefixSourceLines (prefixFn) {
  const text = sourceEditor.value
  const start = Number.isFinite(sourceEditor.selectionStart) ? sourceEditor.selectionStart : text.length
  const end = Number.isFinite(sourceEditor.selectionEnd) ? sourceEditor.selectionEnd : start
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  let lineEnd = text.indexOf('\n', end)
  if (lineEnd < 0) lineEnd = text.length
  const block = text.slice(lineStart, lineEnd)
  const lines = block.split('\n').map((l, i) => prefixFn(l, i)).join('\n')
  sourceEditor.focus()
  sourceEditor.setSelectionRange(lineStart, lineEnd)
  if (!document.hasFocus() || !document.execCommand('insertText', false, lines)) {
    sourceEditor.setRangeText(lines, lineStart, lineEnd, 'end')
  }
  onSourceChanged()
}

function exec (cmd, value = null) {
  if (editView === 'source') {
    if (cmd === 'bold') wrapSourceSelection('**', '**', '粗体文字')
    else if (cmd === 'italic') wrapSourceSelection('*', '*', '斜体文字')
    else if (cmd === 'underline') wrapSourceSelection('<u>', '</u>', '下划线')
    else if (cmd === 'strikeThrough') wrapSourceSelection('~~', '~~', '删除线')
    else if (cmd === 'foreColor') wrapSourceSelection(`<span style="color:${value || '#333333'}">`, '</span>', '彩色文字')
    else if (cmd === 'insertUnorderedList') prefixSourceLines((l) => l.startsWith('- ') ? l : '- ' + l)
    else if (cmd === 'insertOrderedList') prefixSourceLines((l, i) => /^\d+\.\s/.test(l) ? l : `${i + 1}. ${l}`)
    else if (cmd === 'removeFormat') {
      const s = sourceEditor.selectionStart
      const e = sourceEditor.selectionEnd
      if (e > s) {
        const cleaned = sourceEditor.value.slice(s, e)
          .replace(/<\/?(?:u|span)(?:\s[^>]*)?>/gi, '')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\*([^*]+)\*/g, '$1')
          .replace(/~~([^~]+)~~/g, '$1')
        sourceEditor.setRangeText(cleaned, s, e, 'end')
        onSourceChanged()
      }
    }
    return
  }

  if (activeRaw && editor.contains(activeRaw.el)) {
    if (cmd === 'bold') { wrapRawSelection('**', '**', '粗体文字'); return }
    if (cmd === 'italic') { wrapRawSelection('*', '*', '斜体文字'); return }
    if (cmd === 'underline') { wrapRawSelection('<u>', '</u>', '下划线'); return }
    if (cmd === 'strikeThrough') { wrapRawSelection('~~', '~~', '删除线'); return }
    if (cmd === 'foreColor') { wrapRawSelection(`<span style="color:${value || '#333333'}">`, '</span>', '彩色文字'); return }
    if (cmd === 'insertUnorderedList') { prefixRawLines((l) => l.startsWith('- ') ? l : '- ' + l); return }
    if (cmd === 'insertOrderedList') { prefixRawLines((l, i) => /^\d+\.\s/.test(l) ? l : `${i + 1}. ${l}`); return }
    if (cmd === 'removeFormat') {
      const sel = window.getSelection()
      if (sel && sel.rangeCount && activeRaw.el.contains(sel.anchorNode) && !sel.isCollapsed) {
        const cleaned = sel.toString()
          .replace(/<\/?(?:u|span)(?:\s[^>]*)?>/gi, '')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\*([^*]+)\*/g, '$1')
          .replace(/~~([^~]+)~~/g, '$1')
        if (document.execCommand('insertText', false, cleaned)) {
          activeRaw.edited = true
          onEditorChanged()
        }
      }
      return
    }
    if (cmd === 'insertHTML') {
      const tmp = document.createElement('template')
      tmp.innerHTML = String(value || '')
      const plain = tmp.content.textContent || ''
      if (plain && document.execCommand('insertText', false, plain)) {
        activeRaw.edited = true
        onEditorChanged()
      }
      return
    }
  }

  livePreviewLock = true
  try {
    editor.focus()
    document.execCommand(cmd, false, value)
    const sel = window.getSelection()
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
      lastCaretBlock = topBlockOf(sel.anchorNode)
      skipRevealBlock = lastCaretBlock
    }
  } catch (e) {
    console.warn(cmd, e)
  } finally {
    livePreviewLock = false
  }
  onEditorChanged()
}

function wrapRawSelection (before, after, placeholder) {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || !activeRaw || !activeRaw.el.contains(sel.anchorNode)) return
  const r = sel.getRangeAt(0)
  const text = r.toString()
  const inner = text || placeholder || ''
  const rep = before + inner + after
  if (document.execCommand('insertText', false, rep)) {
    activeRaw.edited = true
    onEditorChanged()
  }
}

function prefixRawLines (prefixFn) {
  if (!activeRaw || !editor.contains(activeRaw.el)) return
  const rawEl = activeRaw.el
  const full = getRawBlockText(rawEl)
  const off = getSelectionOffsetIn(rawEl)
  const start = typeof off === 'number' ? off : full.length
  const lineStart = full.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  let lineEnd = full.indexOf('\n', start)
  if (lineEnd < 0) lineEnd = full.length
  const seg = full.slice(lineStart, lineEnd)
  const nextSeg = seg.split('\n').map((l, i) => prefixFn(l, i)).join('\n')
  const nextFull = full.slice(0, lineStart) + nextSeg + full.slice(lineEnd)
  rawEl.textContent = nextFull
  activeRaw.edited = true
  setTextOffsetSelection(rawEl, lineStart + nextSeg.length)
  onEditorChanged()
}

/**
 * 划词 AI 结果插入便签（ai-toolbar.js 会探测这个函数）
 */
window.__aiInsertText = (text) => {
  const raw = String(text || '').trim()
  if (!raw) return
  if (!NOTE || NOTE.mode === 'read') setMode('edit', { silent: true })
  if (editView === 'source') {
    insertSourceText('\n' + raw + '\n')
    toast('已插入到便签')
    return
  }
  if (noteMd && noteMd.looksLikeMarkdownOrLatex(raw)) {
    const html = noteMd.parseNoteMarkdown(raw)
    insertHtml(html + '<p><br></p>')
  } else {
    const html = raw.split(/\n{2,}/)
      .map(block => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
      .join('')
    insertHtml(html + '<p><br></p>')
  }
  toast('已插入到便签')
}

// ============================================================ 内容 / 统计 / 快照
let snapshotCache = null

function invalidateSnapshot () {
  snapshotCache = null
}

function compileRawElementForClone (rawClone) {
  const curText = getRawBlockText(rawClone)
  const isUnedited = activeRaw && activeRaw.origMarkdown === curText && !activeRaw.edited
  const tpl = document.createElement('template')
  if (isUnedited && activeRaw.origHtml) {
    tpl.innerHTML = activeRaw.origHtml
  } else {
    tpl.innerHTML = curText.trim() ? compileMarkdownBlock(curText) : '<p><br></p>'
  }
  rawClone.replaceWith(...Array.from(tpl.content.childNodes))
}

function takeSnapshot () {
  if (snapshotCache) return snapshotCache
  if (domSnapshot) {
    snapshotCache = domSnapshot.snapshot(editor, {
      compileRaw: compileRawElementForClone
    })
    return snapshotCache
  }
  return {
    html: editor.innerHTML,
    text: (editor.textContent || '').replace(/\s+/g, ' ').trim(),
    imgCount: editor.querySelectorAll('img').length,
    mmdCount: editor.querySelectorAll('.mmd').length,
    mathCount: editor.querySelectorAll('.math-inline, .math-block').length
  }
}

function serializeHtml () {
  return takeSnapshot().html
}

function updateEmptyState () {
  if (editView === 'source') {
    editor.dataset.empty = sourceEditor.value.trim() === '' ? '1' : '0'
    return
  }
  const text = editor.textContent.trim()
  const hasBlock = editor.querySelector('img, .mmd, .math-inline, .math-block, hr, li, table, pre, blockquote')
  editor.dataset.empty = (text === '' && !hasBlock) ? '1' : '0'
}

function plainText () {
  return takeSnapshot().text
}

function updateStats (snap) {
  const s = snap || takeSnapshot()
  if (domSnapshot && typeof domSnapshot.statsText === 'function') {
    statsEl.textContent = domSnapshot.statsText(s)
    return
  }
  const count = String(s.text || '').replace(/\[(图表|图片|公式)\]/g, '').replace(/\s/g, '').length
  const parts = [count + ' 字']
  if (s.imgCount) parts.push(s.imgCount + ' 图')
  if (s.mmdCount) parts.push(s.mmdCount + ' 图表')
  if (s.mathCount) parts.push(s.mathCount + ' 公式')
  statsEl.textContent = parts.join(' · ')
}

let previewTimer = null
function onEditorChanged () {
  invalidateSnapshot()
  updateEmptyState()
  try {
    let syncHtml = editor.innerHTML
    let syncPreview = (editor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    if (activeRaw && editor.contains(activeRaw.el)) {
      const snap = takeSnapshot()
      syncHtml = snap.html
      syncPreview = snap.text.slice(0, 160)
    }
    const r = api.update({
      html: syncHtml,
      preview: syncPreview
    })
    if (!r || !r.ok) console.error('[save] 正文同步失败', r && r.error)
    savedEl.textContent = '编辑中…'
  } catch (err) {
    console.error('[save] 正文同步失败', err)
  }
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    const snap = takeSnapshot()
    updateStats(snap)
    queueSave({
      html: snap.html,
      preview: snap.text.slice(0, 160)
    })
  }, 180)
}

// ============================================================ 全源码模式切换 & 同步
function compileSourceToSnapshotObj (mdText) {
  if (noteMd && typeof noteMd.parseNoteMarkdownSnapshot === 'function') {
    return noteMd.parseNoteMarkdownSnapshot(mdText, domSnapshot, { allowAttachments: true, allowTrustNodes: true })
  }
  const compiledHtml = noteMd ? noteMd.parseNoteMarkdown(mdText, { allowAttachments: true, allowTrustNodes: true }) : ('<p>' + escapeHtml(mdText) + '</p>')
  const doc = new DOMParser().parseFromString(compiledHtml, 'text/html')
  if (domSnapshot) {
    // 直接遍历 doc.body 生成 text 与计数，不额外 cloneNode
    const text = domSnapshot.textFromRoot(doc.body)
    const imgCount = doc.body.querySelectorAll('img').length
    const mmdCount = doc.body.querySelectorAll('.mmd').length
    const mathCount = doc.body.querySelectorAll('.math-inline, .math-block').length
    return { html: doc.body.innerHTML, text, imgCount, mmdCount, mathCount }
  }
  return {
    html: compiledHtml,
    text: (doc.body.textContent || '').replace(/\s+/g, ' ').trim(),
    imgCount: 0,
    mmdCount: 0,
    mathCount: 0
  }
}

let sourceStatsTimer = null
function syncSourceToMain (opts = {}) {
  const snap = compileSourceToSnapshotObj(sourceEditor.value)
  try {
    const r = api.update({
      html: snap.html,
      preview: snap.text.slice(0, 160)
    })
    if (!r || !r.ok) console.error('[save] 源码同步失败', r && r.error)
  } catch (err) {
    console.error('[save] 源码同步失败', err)
  }
  if (opts.immediateStats) {
    updateStats(snap)
    queueSave({ html: snap.html, preview: snap.text.slice(0, 160) })
  }
  return snap
}

function onSourceChanged () {
  sourceDirty = true
  updateEmptyState()
  const snap = syncSourceToMain()
  savedEl.textContent = '编辑中…'
  clearTimeout(sourceStatsTimer)
  sourceStatsTimer = setTimeout(() => {
    syncSourceToMain({ immediateStats: true })
  }, 180)
  return snap
}

sourceEditor.addEventListener('input', onSourceChanged)

function setEditView (view, opts = {}) {
  if (!NOTE || NOTE.mode === 'read') return
  const next = view === 'source' ? 'source' : 'live'
  if (editView === next) return

  if (next === 'source') {
    flushPendingLiveEdits()
    const snap = takeSnapshot()
    const md = noteMd ? noteMd.htmlToNoteMarkdown(snap.html) : (editor.textContent || '')
    sourceEditor.value = md
    sourceDirty = false
    editView = 'source'
    noteEl.dataset.view = 'source'
    editor.hidden = true
    sourceEditor.hidden = false
    if (sourceToggle) {
      sourceToggle.dataset.on = '1'
      sourceToggle.setAttribute('aria-pressed', 'true')
    }
    if (!opts.silent) sourceEditor.focus()
    return
  }

  // source -> live
  clearTimeout(sourceStatsTimer)
  const wasDirty = sourceDirty
  const md = sourceEditor.value
  const compiledHtml = noteMd ? noteMd.parseNoteMarkdown(md, { allowAttachments: true, allowTrustNodes: true }) : ''
  editView = 'live'
  delete noteEl.dataset.view
  sourceEditor.hidden = true
  editor.hidden = false
  if (sourceToggle) {
    sourceToggle.dataset.on = '0'
    sourceToggle.setAttribute('aria-pressed', 'false')
  }

  livePreviewLock = true
  try {
    editor.innerHTML = compiledHtml || '<p><br></p>'
    ensureBlockIds()
    renderAllMath()
    renderAllMermaid()
    activeRaw = null
    const firstBlock = editor.firstElementChild
    lastCaretBlock = firstBlock || null
    skipRevealBlock = firstBlock || null
    if (!opts.silent) editor.focus()
  } finally {
    livePreviewLock = false
  }
  sourceDirty = false
  invalidateSnapshot()
  updateEmptyState()
  if (wasDirty) {
    const snap = takeSnapshot()
    updateStats(snap)
    queueSave({ html: snap.html, preview: snap.text.slice(0, 160) })
  } else {
    updateStats()
  }
}

// ============================================================ Obsidian Live Preview
function compileMarkdownBlock (md) {
  if (!noteMd) return '<p>' + escapeHtml(md).replace(/\n/g, '<br>') + '</p>'
  return noteMd.parseNoteMarkdown(md, { allowAttachments: true, allowTrustNodes: true })
}

function parseCompiledNodes (html) {
  const tpl = document.createElement('template')
  tpl.innerHTML = String(html || '')
  return Array.from(tpl.content.childNodes).filter(n => !(n.nodeType === 3 && !n.nodeValue.trim()))
}

function renderRenderedNodesIn (nodes) {
  for (const n of nodes) {
    if (!n || n.nodeType !== 1) continue
    if (n.classList.contains('mmd')) renderMermaidBlock(n)
    else if (n.querySelector('.mmd')) n.querySelectorAll('.mmd').forEach(b => renderMermaidBlock(b))
    if (n.classList.contains('math-inline') || n.classList.contains('math-block')) renderMathNode(n)
    else if (n.querySelector('.math-inline, .math-block')) renderAllMath(n)
  }
}

function topBlockOf (node) {
  if (!node || node === editor || !editor.contains(node)) return null
  let cur = node.nodeType === Node.TEXT_NODE ? node.parentElement : node
  while (cur && cur.parentElement && cur.parentElement !== editor) {
    cur = cur.parentElement
  }
  return (cur && cur.parentElement === editor) ? cur : null
}

function isBlockWidget (el) {
  return !!(el && el.nodeType === 1 && (el.matches('.mmd, .math-block, pre, table, blockquote, hr, ul, ol')))
}

function isFormattedMarkdownBlock (el) {
  if (!el || el.nodeType !== 1 || el.classList.contains('md-raw')) return false
  if (el.matches('.mmd, .attachment') || el.querySelector('img, .mmd, .attachment')) return false
  if (/^(H[1-6]|BLOCKQUOTE|UL|OL|PRE|TABLE|HR)$/.test(el.tagName)) return true
  if (el.classList.contains('math-block')) return true
  if (el.querySelector('strong, b, em, i, del, s, strike, code, a[href], .math-inline')) return true
  return false
}

function blockTypeForEl (el) {
  if (!el) return 'single'
  if (el.matches('UL, OL, BLOCKQUOTE, PRE, TABLE, .math-block')) return 'multi'
  return 'single'
}

function getRawBlockText (el) {
  if (!el) return ''
  let hasElem = false
  for (let i = 0; i < el.childNodes.length; i++) {
    if (el.childNodes[i].nodeType === 1) { hasElem = true; break }
  }
  if (!hasElem) return (el.textContent || '').replace(/\u00a0/g, ' ')
  const parts = []
  const walk = (node) => {
    for (const n of (node.childNodes || [])) {
      if (n.nodeType === 3) { parts.push(n.nodeValue || ''); continue }
      if (n.nodeType !== 1) continue
      if (n.tagName === 'BR') {
        if (n.nextSibling) parts.push('\n')
        continue
      }
      if (n.tagName === 'DIV' || n.tagName === 'P') {
        if (parts.length && parts[parts.length - 1] !== '\n') parts.push('\n')
        walk(n)
        continue
      }
      walk(n)
    }
  }
  walk(el)
  return parts.join('').replace(/\u00a0/g, ' ')
}

function isPlainTextBlock (el) {
  if (!el || el.nodeType !== 1 || el.classList.contains('md-raw')) return false
  if (el.tagName !== 'P' && el.tagName !== 'DIV') return false
  if (el.matches('.mmd, .attachment, .math-block')) return false
  if (isFormattedMarkdownBlock(el)) return false
  if (el.querySelector('img, .mmd, .attachment, .math-block, .math-inline, table, pre, ul, ol, blockquote, hr')) return false
  return true
}

function findMathSpansInText (text) {
  const spans = []
  const s = String(text || '')
  let i = 0
  while (i < s.length) {
    if (s[i] === '`') {
      let ticks = 1
      while (s[i + ticks] === '`') ticks++
      const close = s.indexOf('`'.repeat(ticks), i + ticks)
      if (close >= 0) { i = close + ticks; continue }
      i += ticks
      continue
    }
    if (s[i] === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '(') {
        const end = s.indexOf('\\)', i + 2)
        if (end > i + 2) {
          spans.push({ start: i, end: end + 2, innerStart: i + 2, innerEnd: end, tex: s.slice(i + 2, end), displayMode: false, delim: '\\(' })
          i = end + 2
          continue
        }
      }
      if (s[i + 1] === '[') {
        const end = s.indexOf('\\]', i + 2)
        if (end > i + 2) {
          spans.push({ start: i, end: end + 2, innerStart: i + 2, innerEnd: end, tex: s.slice(i + 2, end), displayMode: true, delim: '\\[' })
          i = end + 2
          continue
        }
      }
      i += 2
      continue
    }
    if (s[i] === '$') {
      if (s[i + 1] === '$') {
        const end = s.indexOf('$$', i + 2)
        if (end > i + 2) {
          spans.push({ start: i, end: end + 2, innerStart: i + 2, innerEnd: end, tex: s.slice(i + 2, end), displayMode: true, delim: '$$' })
          i = end + 2
          continue
        }
        i += 2
        continue
      }
      const before = i > 0 ? s[i - 1] : ''
      const after = s[i + 1] || ''
      if (!after || after === '$' || /\s/.test(after) || (before && /[0-9]/.test(before))) {
        i++
        continue
      }
      let k = i + 1
      let matched = -1
      while (k < s.length && s[k] !== '\n') {
        if (s[k] === '\\' && k + 1 < s.length) { k += 2; continue }
        if (s[k] === '$') {
          const prev = s[k - 1]
          const next = s[k + 1] || ''
          if (k > i + 1 && !/\s/.test(prev) && !(next && /[0-9]/.test(next))) {
            matched = k
          }
          break
        }
        k++
      }
      if (matched > i + 1) {
        spans.push({ start: i, end: matched + 1, innerStart: i + 1, innerEnd: matched, tex: s.slice(i + 1, matched), displayMode: false, delim: '$' })
        i = matched + 1
        continue
      }
    }
    i++
  }
  return spans
}

function computePlainOffsetsInBlock (blockEl, range) {
  let start = 0
  let end = 0
  let foundStart = false
  let foundEnd = false
  let count = 0

  const walk = (node) => {
    if (node.nodeType === 1 && node.classList && node.classList.contains('katex-mathml')) return
    if (node.nodeType === 1 && (node.classList.contains('math-inline') || node.classList.contains('math-block'))) {
      const texLen = (node.getAttribute('data-tex') || '').length + 2
      if (!foundStart && (node === range.startContainer || node.contains(range.startContainer))) {
        start = count + Math.min(texLen, 1)
        foundStart = true
      }
      if (!foundEnd && (node === range.endContainer || node.contains(range.endContainer))) {
        end = count + texLen
        foundEnd = true
      }
      count += texLen
      return
    }
    if (node.nodeType === 3) {
      const len = node.nodeValue.length
      if (!foundStart && node === range.startContainer) {
        start = count + range.startOffset
        foundStart = true
      }
      if (!foundEnd && node === range.endContainer) {
        end = count + range.endOffset
        foundEnd = true
      }
      count += len
      return
    }
    if (node.nodeType !== 1) return
    const children = node.childNodes
    for (let i = 0; i < children.length; i++) {
      if (!foundStart && node === range.startContainer && i === range.startOffset) {
        start = count
        foundStart = true
      }
      if (!foundEnd && node === range.endContainer && i === range.endOffset) {
        end = count
        foundEnd = true
      }
      if (i > 0 && children[i].nodeType === 1 && /^(?:LI|P|DIV|TR)$/.test(children[i].tagName)) {
        count += 1
      }
      walk(children[i])
    }
    if (!foundStart && node === range.startContainer && range.startOffset >= children.length) {
      start = count
      foundStart = true
    }
    if (!foundEnd && node === range.endContainer && range.endOffset >= children.length) {
      end = count
      foundEnd = true
    }
  }
  walk(blockEl)
  return {
    start: foundStart ? start : count,
    end: foundEnd ? end : (foundStart ? start : count)
  }
}

function mapPlainOffsetToMarkdown (md, plainOff) {
  if (plainOff <= 0) {
    const m = md.match(/^(?:#{1,6}\s+|>\s+|-\s+\[[ xX]\]\s+|-\s+|\d+\.\s+)/)
    return m ? m[0].length : 0
  }
  let vis = 0
  let i = 0
  const len = md.length
  while (i < len) {
    if (vis >= plainOff) return i
    // 跳过行首结构前缀
    if (i === 0 || md[i - 1] === '\n') {
      const lm = md.slice(i).match(/^(?:#{1,6}\s+|>\s+|-\s+\[[ xX]\]\s+|-\s+|\d+\.\s+)/)
      if (lm) { i += lm[0].length; continue }
    }
    // 跳过内联包裹符
    if (md.startsWith('**', i) || md.startsWith('~~', i)) { i += 2; continue }
    if (md[i] === '*' || md[i] === '`') { i += 1; continue }
    if (md.startsWith('<u>', i)) { i += 3; continue }
    if (md.startsWith('</u>', i)) { i += 4; continue }
    if (md.startsWith('<span', i) || md.startsWith('</span>', i)) {
      const gt = md.indexOf('>', i)
      if (gt >= 0) { i = gt + 1; continue }
    }
    if (md[i] === '[' || md[i] === ']') {
      if (md[i] === ']' && md[i + 1] === '(') {
        const closeP = md.indexOf(')', i + 2)
        if (closeP >= 0) { i = closeP + 1; continue }
      }
      i += 1
      continue
    }
    vis++
    i++
  }
  return len
}

function setTextOffsetSelection (el, startOffset, endOffset = startOffset) {
  const locate = (targetOff) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null)
    let acc = 0
    let node
    let lastNode = null
    while ((node = walker.nextNode())) {
      lastNode = node
      const len = node.nodeValue.length
      if (targetOff <= acc + len) {
        return { node, offset: Math.max(0, targetOff - acc) }
      }
      acc += len
    }
    if (lastNode) return { node: lastNode, offset: lastNode.nodeValue.length }
    return { node: el, offset: 0 }
  }
  const s = locate(Math.max(0, startOffset))
  const e = endOffset === startOffset ? s : locate(Math.max(0, endOffset))
  const r = document.createRange()
  r.setStart(s.node, s.offset)
  r.setEnd(e.node, e.offset)
  const sel = window.getSelection()
  if (sel) { sel.removeAllRanges(); sel.addRange(r) }
}

function placeCaretAtStart (el) {
  if (!el) return
  const r = document.createRange()
  r.setStart(el, 0)
  r.collapse(true)
  const sel = window.getSelection()
  if (sel) { sel.removeAllRanges(); sel.addRange(r) }
}

function placeCaretAtEnd (el) {
  if (!el) return
  const r = document.createRange()
  r.selectNodeContents(el)
  r.collapse(false)
  const sel = window.getSelection()
  if (sel) { sel.removeAllRanges(); sel.addRange(r) }
}

function getSelectionOffsetIn (el) {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return null
  const r = sel.getRangeAt(0)
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(r.startContainer, r.startOffset)
  return pre.toString().length
}

let activeRaw = null
let lastCaretBlock = null
let skipRevealBlock = null
let isComposing = false
let isPointerDragging = false
let pointerDownPos = null
let pointerDragged = false
let suppressReveal = false
let suppressTimer = null
function suppressBriefly (ms = 80) {
  suppressReveal = true
  clearTimeout(suppressTimer)
  suppressTimer = setTimeout(() => { suppressReveal = false }, ms)
}
function clearSuppressReveal () {
  clearTimeout(suppressTimer)
  suppressReveal = false
}
let livePreviewLock = false

function revealBlock (blockEl, opts = {}) {
  if (!NOTE || NOTE.mode !== 'edit' || editView !== 'live' || isComposing) return
  if (!blockEl || !editor.contains(blockEl)) return
  if (activeRaw && activeRaw.el === blockEl) return
  if (!isFormattedMarkdownBlock(blockEl)) return

  const origHtml = blockEl.outerHTML
  const blockType = blockTypeForEl(blockEl)
  const md = noteMd ? noteMd.htmlToNoteMarkdown(origHtml) : (blockEl.textContent || '')
  const rawEl = document.createElement('div')
  rawEl.className = 'md-raw'
  rawEl.dataset.mdRaw = '1'
  rawEl.dataset.mdBlockType = blockType
  rawEl.textContent = md

  livePreviewLock = true
  try {
    blockEl.replaceWith(rawEl)
    activeRaw = { el: rawEl, origHtml, origMarkdown: md, blockType, edited: false }
    lastCaretBlock = rawEl

    let startOff = md.length
    let endOff = md.length
    if (opts.clickedMath) {
      if (opts.clickedMath.isBlock) {
        const firstNl = md.indexOf('\n')
        const lastNl = md.lastIndexOf('\n')
        if (firstNl >= 0 && lastNl > firstNl) {
          startOff = lastNl
        } else {
          const spans = findMathSpansInText(md)
          startOff = spans[0] ? spans[0].innerEnd : md.length
        }
        endOff = startOff
      } else {
        const spans = findMathSpansInText(md)
        const span = spans[opts.clickedMath.index] || spans[0]
        if (span) {
          startOff = span.innerEnd
          endOff = startOff
        }
      }
    } else if (typeof opts.plainStart === 'number') {
      startOff = mapPlainOffsetToMarkdown(md, opts.plainStart)
      endOff = (typeof opts.plainEnd === 'number' && opts.plainEnd !== opts.plainStart)
        ? mapPlainOffsetToMarkdown(md, opts.plainEnd)
        : startOff
    }
    if (opts.ensureFocus && document.activeElement !== editor) {
      editor.focus({ preventScroll: true })
    }
    setTextOffsetSelection(rawEl, startOff, endOff)
  } finally {
    livePreviewLock = false
  }
}

function collapseActiveRaw (opts = {}) {
  if (!activeRaw) return false
  const cur = activeRaw
  const rawEl = cur.el
  if (!rawEl || !editor.contains(rawEl)) {
    activeRaw = null
    return false
  }
  const currentText = getRawBlockText(rawEl)
  const isUnedited = !cur.edited && currentText === cur.origMarkdown

  livePreviewLock = true
  try {
    activeRaw = null
    if (isUnedited) {
      const restored = parseCompiledNodes(cur.origHtml)
      if (restored.length) {
        const last = restored[restored.length - 1]
        rawEl.replaceWith(...restored)
        renderRenderedNodesIn(restored)
        if (opts.focusEditor && document.activeElement !== editor) {
          editor.focus({ preventScroll: true })
        }
        if (opts.placeCaretAfter) {
          if (opts.extraEmptyPara || isBlockWidget(last)) {
            const p = document.createElement('p')
            p.innerHTML = '<br>'
            last.after(p)
            placeCaretAtStart(p)
            lastCaretBlock = p
            if (opts.skipReveal) skipRevealBlock = p
            onEditorChanged()
          } else {
            placeCaretAtEnd(last)
            lastCaretBlock = last
            if (opts.skipReveal) skipRevealBlock = last
          }
        }
      } else {
        rawEl.remove()
      }
      return false
    }

    const trimmed = currentText.trim()
    if (!trimmed) {
      const p = document.createElement('p')
      p.innerHTML = '<br>'
      rawEl.replaceWith(p)
      if (opts.focusEditor && document.activeElement !== editor) {
        editor.focus({ preventScroll: true })
      }
      if (opts.placeCaretAfter) {
        placeCaretAtStart(p)
        lastCaretBlock = p
        if (opts.skipReveal) skipRevealBlock = p
      }
      onEditorChanged()
      return true
    }

    const compiledHtml = compileMarkdownBlock(currentText)
    const nodes = parseCompiledNodes(compiledHtml)
    if (!nodes.length) {
      const p = document.createElement('p')
      p.innerHTML = '<br>'
      rawEl.replaceWith(p)
      if (opts.focusEditor && document.activeElement !== editor) {
        editor.focus({ preventScroll: true })
      }
      if (opts.placeCaretAfter) {
        placeCaretAtStart(p)
        lastCaretBlock = p
        if (opts.skipReveal) skipRevealBlock = p
      }
    } else {
      const last = nodes[nodes.length - 1]
      rawEl.replaceWith(...nodes)
      renderRenderedNodesIn(nodes)
      if (opts.focusEditor && document.activeElement !== editor) {
        editor.focus({ preventScroll: true })
      }
      if (opts.placeCaretAfter) {
        if (opts.extraEmptyPara || isBlockWidget(last)) {
          const p = document.createElement('p')
          p.innerHTML = '<br>'
          last.after(p)
          placeCaretAtStart(p)
          lastCaretBlock = p
          if (opts.skipReveal) skipRevealBlock = p
        } else {
          placeCaretAtEnd(last)
          lastCaretBlock = last
          if (opts.skipReveal) skipRevealBlock = last
        }
      }
    }
    onEditorChanged()
    return true
  } finally {
    livePreviewLock = false
  }
}

/** 识别未闭合的围栏/块级公式/表格行，防止打字换行时过早编译 */
function isUnclosedMultiLineStart (text) {
  const t = String(text || '').trim()
  if (/^(?:`{3,}|~{3,})[^`]*$/.test(t)) return true
  if (t === '$$' || (t.startsWith('$$') && !t.slice(2).includes('$$'))) return true
  if (t === '\\[' || (t.startsWith('\\[') && !t.includes('\\]'))) return true
  return false
}

function isPipeTableRow (text) {
  const t = String(text || '').trim()
  return /^\|.*\|$/.test(t) || (/\|/.test(t) && /^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+/.test(t))
}

function tryCompileMultiLineSequence (anchorBlock, opts = {}) {
  if (!anchorBlock || !editor.contains(anchorBlock) || !isPlainTextBlock(anchorBlock)) return false
  const text = getRawBlockText(anchorBlock).trim()

  // 1. 闭合围栏 ``` / ~~~，闭合 $$，闭合 \]
  let openerRe = null
  if (/^(?:`{3,}|~{3,})[ \t]*$/.test(text)) {
    const ch = text[0]
    openerRe = new RegExp('^' + ch + '{' + text.length + ',}')
  } else if (text === '$$' || (!text.startsWith('$$') && text.endsWith('$$'))) {
    openerRe = /^\$\$/
  } else if (text === '\\]' || (!text.startsWith('\\[') && text.endsWith('\\]'))) {
    openerRe = /^\\\[/
  }

  if (openerRe) {
    const blocks = [anchorBlock]
    let cur = anchorBlock.previousElementSibling
    let openerFound = null
    while (cur && isPlainTextBlock(cur)) {
      blocks.unshift(cur)
      const curText = getRawBlockText(cur).trim()
      if (openerRe.test(curText)) {
        openerFound = cur
        break
      }
      cur = cur.previousElementSibling
    }
    if (openerFound && blocks.length >= 2) {
      const combined = blocks.map(b => getRawBlockText(b)).join('\n')
      const compiledHtml = compileMarkdownBlock(combined)
      livePreviewLock = true
      try {
        const nodes = parseCompiledNodes(compiledHtml)
        if (nodes.length) {
          const last = nodes[nodes.length - 1]
          blocks[0].replaceWith(...nodes)
          for (let i = 1; i < blocks.length; i++) blocks[i].remove()
          renderRenderedNodesIn(nodes)
          if (opts.placeCaretAfter) {
            const p = document.createElement('p')
            p.innerHTML = '<br>'
            last.after(p)
            placeCaretAtStart(p)
            lastCaretBlock = p
            skipRevealBlock = p
          }
          onEditorChanged()
          return true
        }
      } finally {
        livePreviewLock = false
      }
    }
  }

  // 2. GFM 表格（连续管线行，至少 2 行且含分隔线）
  if (isPipeTableRow(text) && !opts.onEnter) {
    const blocks = [anchorBlock]
    let cur = anchorBlock.previousElementSibling
    while (cur && isPlainTextBlock(cur) && isPipeTableRow(getRawBlockText(cur))) {
      blocks.unshift(cur)
      cur = cur.previousElementSibling
    }
    cur = anchorBlock.nextElementSibling
    while (cur && isPlainTextBlock(cur) && isPipeTableRow(getRawBlockText(cur))) {
      blocks.push(cur)
      cur = cur.nextElementSibling
    }
    if (blocks.length >= 2) {
      const combined = blocks.map(b => getRawBlockText(b)).join('\n')
      if (/\|.+\|\n[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+/.test(combined)) {
        const compiledHtml = compileMarkdownBlock(combined)
        livePreviewLock = true
        try {
          const nodes = parseCompiledNodes(compiledHtml)
          if (nodes.length) {
            blocks[0].replaceWith(...nodes)
            for (let i = 1; i < blocks.length; i++) blocks[i].remove()
            renderRenderedNodesIn(nodes)
            onEditorChanged()
            return true
          }
        } finally {
          livePreviewLock = false
        }
      }
    }
  }

  return false
}

function isInsideOpenPlainFence (blockEl) {
  let prev = blockEl ? blockEl.previousElementSibling : null
  let steps = 0
  let sawBlank = false
  while (prev && isPlainTextBlock(prev) && steps < 40) {
    const pt = getRawBlockText(prev).trim()
    if (!pt) {
      sawBlank = true
      prev = prev.previousElementSibling
      steps++
      continue
    }
    if (/^(?:`{3,}|~{3,})[^`]*$/.test(pt)) return true
    if (!sawBlank && (pt === '$$' || (pt.startsWith('$$') && !pt.slice(2).includes('$$')) || pt === '\\[' || (pt.startsWith('\\[') && !pt.includes('\\]')))) {
      return true
    }
    prev = prev.previousElementSibling
    steps++
  }
  return false
}

const BARE_BLOCK_TAG_RE = /^(?:P|DIV|H[1-6]|UL|OL|PRE|BLOCKQUOTE|TABLE|HR|SECTION|ARTICLE)$/

function isDirectBareNode (node) {
  if (!node || node.parentNode !== editor) return false
  if (node.nodeType === 3) return true
  if (node.nodeType === 1) {
    if (node.classList && (node.classList.contains('md-raw') || node.classList.contains('mmd') || node.classList.contains('math-block') || node.classList.contains('attachment'))) {
      return false
    }
    return !BARE_BLOCK_TAG_RE.test(node.tagName)
  }
  return false
}

function getBareInlineRunAt (anchorNode, anchorOffset) {
  let target = anchorNode
  if (target === editor) {
    const kids = editor.childNodes
    const idx = Math.max(0, Math.min(anchorOffset, kids.length - 1))
    target = kids[idx] || kids[anchorOffset - 1] || null
  } else {
    while (target && target.parentNode !== editor) target = target.parentNode
  }
  if (!isDirectBareNode(target)) return null
  if (target.nodeType === 1 && target.tagName === 'BR') {
    const prev = target.previousSibling
    if (isDirectBareNode(prev) && !(prev.nodeType === 1 && prev.tagName === 'BR')) target = prev
    else return null
  }
  const nodes = [target]
  let cur = target.previousSibling
  while (isDirectBareNode(cur) && !(cur.nodeType === 1 && cur.tagName === 'BR')) {
    nodes.unshift(cur)
    cur = cur.previousSibling
  }
  cur = target.nextSibling
  while (isDirectBareNode(cur) && !(cur.nodeType === 1 && cur.tagName === 'BR')) {
    nodes.push(cur)
    cur = cur.nextSibling
  }
  const text = nodes.map(n => n.textContent || '').join('').replace(/\u00a0/g, ' ')
  return { nodes, text }
}

function isCaretAtEndOfRun (run, range) {
  if (!run || !run.nodes.length || !range || !range.collapsed) return false
  const last = run.nodes[run.nodes.length - 1]
  const pre = document.createRange()
  pre.setStartBefore(run.nodes[0])
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length >= run.text.length && (range.startContainer !== editor || range.startOffset > Array.prototype.indexOf.call(editor.childNodes, last))
}

function wrapBareRunIntoP (run) {
  if (!run || !run.nodes.length || !run.nodes[0].parentNode) return null
  const p = document.createElement('p')
  run.nodes[0].before(p)
  for (const n of run.nodes) p.appendChild(n)
  const afterBr = p.nextSibling
  if (afterBr && afterBr.nodeType === 1 && afterBr.tagName === 'BR' && !afterBr.nextSibling) {
    afterBr.remove()
  }
  return p
}

function flushBareInlineRuns (activeNode) {
  const children = Array.from(editor.childNodes)
  let i = 0
  let activeDirect = activeNode
  while (activeDirect && activeDirect.parentNode !== editor) activeDirect = activeDirect.parentNode
  while (i < children.length) {
    const ch = children[i]
    if (!isDirectBareNode(ch) || (ch.nodeType === 1 && ch.tagName === 'BR')) { i++; continue }
    const runNodes = []
    let containsActive = false
    while (i < children.length && isDirectBareNode(children[i]) && !(children[i].nodeType === 1 && children[i].tagName === 'BR')) {
      if (children[i] === activeDirect) containsActive = true
      runNodes.push(children[i])
      i++
    }
    if (containsActive) continue
    const txt = runNodes.map(n => n.textContent || '').join('').replace(/\u00a0/g, ' ')
    if (txt.trim() && !isUnclosedMultiLineStart(txt) && !isPipeTableRow(txt) && noteMd && noteMd.looksLikeMarkdownOrLatex(txt)) {
      const p = wrapBareRunIntoP({ nodes: runNodes, text: txt })
      if (p) tryCompilePlainBlockOnLeave(p)
    }
  }
}

function flushPendingLiveEdits () {
  if (editView !== 'live') return
  if (activeRaw) {
    collapseActiveRaw({ force: true })
  } else if (lastCaretBlock && editor.contains(lastCaretBlock)) {
    tryCompilePlainBlockOnLeave(lastCaretBlock)
    lastCaretBlock = null
  }
  flushBareInlineRuns(null)
}

/** 离开未曾展开的普通输入块时，仅当确实包含 Markdown / LaTeX 语法才编译 */
function tryCompilePlainBlockOnLeave (blockEl, opts = {}) {
  if (!blockEl || !editor.contains(blockEl) || !isPlainTextBlock(blockEl)) return false
  if (tryCompileMultiLineSequence(blockEl, opts)) return true
  const rawText = getRawBlockText(blockEl)
  if (!rawText.trim()) return false
  if (isUnclosedMultiLineStart(rawText)) return false
  if (isPipeTableRow(rawText)) return false
  if (isInsideOpenPlainFence(blockEl)) return false
  if (!noteMd || !noteMd.looksLikeMarkdownOrLatex(rawText)) return false

  const hasInnerInlineHtml = !!blockEl.querySelector('u, font, span')
  const mdInput = hasInnerInlineHtml ? noteMd.htmlToNoteMarkdown(blockEl.outerHTML) : rawText
  const compiledHtml = compileMarkdownBlock(mdInput)

  livePreviewLock = true
  try {
    const nodes = parseCompiledNodes(compiledHtml)
    if (!nodes.length) return false
    const last = nodes[nodes.length - 1]
    blockEl.replaceWith(...nodes)
    renderRenderedNodesIn(nodes)
    if (opts.placeCaretAfter) {
      const p = document.createElement('p')
      p.innerHTML = '<br>'
      last.after(p)
      placeCaretAtStart(p)
      lastCaretBlock = p
      skipRevealBlock = p
    }
    onEditorChanged()
    return true
  } finally {
    livePreviewLock = false
  }
}

function compileRawBlocksOnLoad () {
  const raws = Array.from(editor.querySelectorAll('.md-raw'))
  if (!raws.length) return
  for (const raw of raws) {
    const txt = getRawBlockText(raw)
    if (!txt.trim()) {
      raw.remove()
      continue
    }
    raw.replaceWith(...parseCompiledNodes(compileMarkdownBlock(txt)))
  }
}

function handleCaretOrClickReveal (clickedTarget) {
  if (livePreviewLock || isComposing || isPointerDragging || suppressReveal) return
  if (!NOTE || NOTE.mode !== 'edit' || editView !== 'live') return

  // 若点击在 checkbox / img / .mmd / .attachment 上，绝不触发展开
  if (clickedTarget && clickedTarget.closest('input[type="checkbox"], img, .mmd, .attachment')) {
    return
  }

  // 直接点击渲染态公式（含 contenteditable="false" 的块级公式）：优先就地展开并聚焦源码
  const mathHit = clickedTarget && clickedTarget.closest('.math-inline, .math-block')
  if (mathHit && editor.contains(mathHit)) {
    const ownerBlock = topBlockOf(mathHit)
    if (ownerBlock && isFormattedMarkdownBlock(ownerBlock)) {
      if (activeRaw && activeRaw.el !== ownerBlock) collapseActiveRaw()
      else if (lastCaretBlock && lastCaretBlock !== ownerBlock && editor.contains(lastCaretBlock)) {
        tryCompilePlainBlockOnLeave(lastCaretBlock)
      }
      if (mathHit.classList.contains('math-block')) {
        revealBlock(ownerBlock, { clickedMath: { isBlock: true, index: 0 }, ensureFocus: true })
      } else {
        const list = Array.from(ownerBlock.querySelectorAll('.math-inline'))
        const idx = Math.max(0, list.indexOf(mathHit))
        revealBlock(ownerBlock, { clickedMath: { isBlock: false, index: idx }, ensureFocus: true })
      }
      return
    }
  }

  // 直接点击 <hr> 分隔线：就地展开为 ---
  const hrHit = clickedTarget && clickedTarget.closest('hr')
  if (hrHit && editor.contains(hrHit) && hrHit.parentElement === editor) {
    if (activeRaw && activeRaw.el !== hrHit) collapseActiveRaw()
    else if (lastCaretBlock && lastCaretBlock !== hrHit && editor.contains(lastCaretBlock)) {
      tryCompilePlainBlockOnLeave(lastCaretBlock)
    }
    revealBlock(hrHit, { plainStart: 0, plainEnd: 0, ensureFocus: true })
    return
  }

  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) return
  const range = sel.getRangeAt(0)

  const startBlock = topBlockOf(range.startContainer)
  const endBlock = topBlockOf(range.endContainer)

  // 跨多块拖选或跨表格单元格选择时，保持渲染态不展开
  if (!sel.isCollapsed) {
    if (startBlock !== endBlock) {
      if (activeRaw && startBlock !== activeRaw.el && endBlock !== activeRaw.el) {
        collapseActiveRaw()
      }
      lastCaretBlock = startBlock
      return
    }
    const sEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
    const eEl = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement
    if (sEl && eEl && sEl.closest('td,th') !== eEl.closest('td,th')) {
      lastCaretBlock = startBlock
      return
    }
  }

  // 离开旧的 activeRaw 或离开刚输入过 Markdown/LaTeX 的普通块
  if (activeRaw && activeRaw.el !== startBlock) {
    collapseActiveRaw()
  } else if (lastCaretBlock && lastCaretBlock !== startBlock && editor.contains(lastCaretBlock)) {
    tryCompilePlainBlockOnLeave(lastCaretBlock)
  }
  flushBareInlineRuns(range.startContainer)

  // 再取当前块（因为 collapseActiveRaw 可能刚替换了前一个块）
  const curSel = window.getSelection()
  if (!curSel || !curSel.rangeCount || !editor.contains(curSel.anchorNode)) {
    lastCaretBlock = null
    return
  }
  const curRange = curSel.getRangeAt(0)
  const curBlock = topBlockOf(curRange.startContainer)

  if (!curBlock) {
    lastCaretBlock = null
    return
  }

  if (activeRaw && activeRaw.el === curBlock) {
    lastCaretBlock = curBlock
    return
  }

  if (skipRevealBlock && skipRevealBlock === curBlock && !clickedTarget) {
    lastCaretBlock = curBlock
    return
  }
  if (curBlock !== skipRevealBlock) skipRevealBlock = null

  // 若无点击目标且仍在同一块内（如编程设选区而非切换块/点击），不贸然展开
  if (!clickedTarget && curBlock === lastCaretBlock) return

  if (isFormattedMarkdownBlock(curBlock)) {
    const offsets = computePlainOffsetsInBlock(curBlock, curRange)
    revealBlock(curBlock, { plainStart: offsets.start, plainEnd: offsets.end })
    return
  }

  lastCaretBlock = curBlock
}

// ============================================================ 图片 & 剪贴板
function loadImage (src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

async function compressImage (dataUrl, maxSide = 1600) {
  if (/^data:image\/gif/i.test(dataUrl)) return dataUrl
  try {
    const img = await loadImage(dataUrl)
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
    const needResize = scale < 0.999
    if (!needResize && dataUrl.length < 700 * 1024) return dataUrl

    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, w, h)

    const isPng = /^data:image\/png/i.test(dataUrl)
    const out = isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.86)
    if (isPng && out.length > 1.2 * 1024 * 1024) return canvas.toDataURL('image/jpeg', 0.86)
    return out
  } catch (e) {
    console.warn('compress failed', e)
    return dataUrl
  }
}

function externalizeImages (root, legacy) {
  let changed = false
  for (const img of root.querySelectorAll('img[src^="data:image/"]')) {
    const stored = api.storeImage(img.getAttribute('src'), legacy)
    if (stored.ok) { img.setAttribute('src', stored.src); changed = true }
  }
  return changed
}

async function insertImageDataUrl (dataUrl) {
  const compressed = await compressImage(dataUrl)
  const stored = api.storeImage(compressed)
  const src = stored.ok ? stored.src : compressed
  if (!stored.ok) toast('图片外置失败，已保留原图：' + stored.error)
  if (editView === 'source') {
    insertSourceText(`![粘贴的截图](${src})`)
    toast('图片已插入')
    return
  }
  insertHtml(`<img src="${src}" alt="粘贴的截图" />`)
  toast('图片已插入')
}

async function handleFiles (files) {
  const imgs = Array.from(files).filter(f => /^image\//.test(f.type))
  for (const f of imgs) {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result)
      r.onerror = rej
      r.readAsDataURL(f)
    })
    await insertImageDataUrl(dataUrl)
  }
  if (!imgs.length) toast('仅支持图片文件')
}

sourceEditor.addEventListener('paste', async (e) => {
  const cd = e.clipboardData
  if (!cd) return
  const items = Array.from(cd.items || [])
  const imgItem = items.find(it => it.kind === 'file' && /^image\//.test(it.type))
  if (imgItem) {
    e.preventDefault()
    const file = imgItem.getAsFile()
    if (!file) return
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result)
      r.onerror = rej
      r.readAsDataURL(file)
    })
    await insertImageDataUrl(dataUrl)
  }
})

editor.addEventListener('copy', (e) => {
  if (editView !== 'live' || !noteMd) return
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return
  const range = sel.getRangeAt(0)
  if (!editor.contains(range.commonAncestorContainer)) return
  const frag = range.cloneContents()
  const hasRich = !!(frag.querySelector && frag.querySelector('.katex, .katex-mathml, .math-inline, .math-block, .mmd'))
  const ancEl = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
  const insideRich = !!(ancEl && ancEl.closest && ancEl.closest('.katex, .math-inline, .math-block, .mmd'))
  if (!hasRich && !insideRich) return

  const cleanText = noteMd.extractSelectionText(range, sel.toString())
  const cleanHtml = noteMd.extractSelectionHtml(range)
  if (e.clipboardData) {
    e.preventDefault()
    e.clipboardData.setData('text/plain', cleanText)
    if (cleanHtml) e.clipboardData.setData('text/html', cleanHtml)
  }
})

editor.addEventListener('paste', async (e) => {
  const cd = e.clipboardData
  if (!cd) return
  const items = Array.from(cd.items || [])
  const imgItem = items.find(it => it.kind === 'file' && /^image\//.test(it.type))

  if (imgItem) {
    e.preventDefault()
    const file = imgItem.getAsFile()
    if (!file) return
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result)
      r.onerror = rej
      r.readAsDataURL(file)
    })
    await insertImageDataUrl(dataUrl)
    return
  }

  const html = cd.getData('text/html')
  if (html) {
    e.preventDefault()
    insertHtml(sanitizeHtml(html, { allowTrustNodes: true }))
    return
  }

  const plain = cd.getData('text/plain')
  if (!plain || editView !== 'live' || !noteMd) return

  // 若在 <pre> / <code> / .md-raw 内粘贴纯文本，保留原文不自动渲染
  const sel = window.getSelection()
  const anchorEl = sel && sel.rangeCount
    ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)
    : null
  if (anchorEl && anchorEl.closest('pre, code, .md-raw')) return
  if (!noteMd.looksLikeMarkdownOrLatex(plain)) return

  e.preventDefault()
  const renderedHtml = noteMd.hasBlockMarkdownOrLatex(plain)
    ? noteMd.parseNoteMarkdown(plain)
    : noteMd.parseNoteMarkdownInline(plain)
  if (!renderedHtml) return

  const tpl = document.createElement('template')
  tpl.innerHTML = renderedHtml
  externalizeImages(tpl.content, false)
  const finalHtml = tpl.innerHTML

  livePreviewLock = true
  try {
    editor.focus()
    if (!document.execCommand('insertHTML', false, finalHtml)) {
      insertHtml(finalHtml)
      return
    }
    renderAllMath()
    renderAllMermaid()
    const curSel = window.getSelection()
    if (curSel && curSel.rangeCount && editor.contains(curSel.anchorNode)) {
      lastCaretBlock = topBlockOf(curSel.anchorNode)
      skipRevealBlock = lastCaretBlock
    }
  } finally {
    livePreviewLock = false
  }
  onEditorChanged()
})

editor.addEventListener('beforeinput', (e) => {
  if (e && (e.inputType === 'historyUndo' || e.inputType === 'historyRedo')) {
    suppressBriefly(80)
  }
})

editor.addEventListener('drop', async (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return
  e.preventDefault()
  noteEl.classList.remove('drop-hover')
  await handleFiles(e.dataTransfer.files)
})
editor.addEventListener('dragover', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
    e.preventDefault()
    noteEl.classList.add('drop-hover')
  }
})
editor.addEventListener('dragleave', () => noteEl.classList.remove('drop-hover'))

// IME & Live Preview 事件钩子
editor.addEventListener('compositionstart', () => { isComposing = true })
editor.addEventListener('compositionend', () => {
  isComposing = false
  if (activeRaw && editor.contains(activeRaw.el)) activeRaw.edited = true
})

editor.addEventListener('input', (e) => {
  if (livePreviewLock) return
  if (e && e.isComposing) isComposing = true
  if (activeRaw && editor.contains(activeRaw.el)) {
    activeRaw.edited = true
  }
  const sel = window.getSelection()
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    lastCaretBlock = topBlockOf(sel.anchorNode)
  }
  onEditorChanged()
})

editor.addEventListener('mousedown', (e) => {
  if (NOTE && NOTE.mode === 'read') return
  if (e.target && e.target.closest('input[type="checkbox"], .mmd-tools button')) {
    e.preventDefault()
  }
})

editor.addEventListener('pointerdown', (e) => {
  if (NOTE && NOTE.mode === 'read') return
  if (e.target && e.target.closest('input[type="checkbox"], img, .mmd, .attachment')) {
    suppressBriefly(80)
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.target && e.target.closest('a[href]')) {
    suppressBriefly(80)
    return
  }
  clearSuppressReveal()
  isPointerDragging = true
  pointerDragged = false
  pointerDownPos = { x: e.clientX, y: e.clientY }
})

window.addEventListener('pointermove', (e) => {
  if (!isPointerDragging || !pointerDownPos) return
  if (Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y) > 4) {
    pointerDragged = true
  }
})

window.addEventListener('pointerup', (e) => {
  if (!isPointerDragging) return
  const wasDragged = pointerDragged
  isPointerDragging = false
  pointerDownPos = null
  pointerDragged = false
  if (suppressReveal) return
  const target = editor.contains(e.target) ? e.target : null
  setTimeout(() => {
    handleCaretOrClickReveal(wasDragged ? null : target)
  }, 0)
})

window.addEventListener('pointercancel', () => {
  isPointerDragging = false
  pointerDownPos = null
  pointerDragged = false
})

document.addEventListener('selectionchange', () => {
  if (livePreviewLock || isComposing || isPointerDragging || suppressReveal) return
  if (editView !== 'live' || !NOTE || NOTE.mode !== 'edit') return
  if (document.activeElement !== editor) return
  handleCaretOrClickReveal(null)
})

editor.addEventListener('blur', (e) => {
  if (livePreviewLock || isComposing || editView !== 'live' || !NOTE || NOTE.mode !== 'edit') return
  if (e.relatedTarget && editor.contains(e.relatedTarget)) return
  if (!mathModal.hidden || !mmdModal.hidden) return
  flushPendingLiveEdits()
})

editor.addEventListener('keydown', (e) => {
  if (editView !== 'live' || !NOTE || NOTE.mode !== 'edit') return
  if (e.isComposing || isComposing || e.keyCode === 229) return

  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) return
  const curBlock = topBlockOf(sel.anchorNode)

  if (e.key === 'Escape' && activeRaw && editor.contains(activeRaw.el)) {
    e.preventDefault()
    collapseActiveRaw({ placeCaretAfter: false })
    return
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    // 1) 在多行 .md-raw（公式块 / 代码块 / 列表 / 引用 / 表格）内按 Enter 插入换行而不拆分容器
    if (activeRaw && activeRaw.el === curBlock) {
      if (activeRaw.blockType === 'multi' && !(e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (!document.execCommand('insertText', false, '\n')) {
          const r = sel.getRangeAt(0)
          r.deleteContents()
          const tn = document.createTextNode('\n')
          r.insertNode(tn)
          r.setStartAfter(tn)
          r.collapse(true)
          sel.removeAllRanges()
          sel.addRange(r)
        }
        activeRaw.edited = true
        onEditorChanged()
        return
      }
      // 单行 .md-raw 按 Enter（或 multi 按 Ctrl+Enter）：按光标位置切分并编译前半部分
      e.preventDefault()
      if (activeRaw.blockType === 'multi') {
        collapseActiveRaw({ placeCaretAfter: true, extraEmptyPara: true })
        return
      }
      const off = getSelectionOffsetIn(activeRaw.el)
      const fullText = getRawBlockText(activeRaw.el)
      const splitAt = typeof off === 'number' ? off : fullText.length
      const before = fullText.slice(0, splitAt)
      const after = fullText.slice(splitAt)
      if (!before.trim() && !after.trim()) {
        collapseActiveRaw({ placeCaretAfter: true, extraEmptyPara: true })
        return
      }
      const curRaw = activeRaw.el
      const wasUnedited = !activeRaw.edited && fullText === activeRaw.origMarkdown && !after
      if (wasUnedited) {
        collapseActiveRaw({ placeCaretAfter: true, extraEmptyPara: true })
        return
      }
      livePreviewLock = true
      try {
        activeRaw = null
        const compiled = before.trim() ? compileMarkdownBlock(before) : '<p><br></p>'
        const nodes = parseCompiledNodes(compiled)
        const nextP = document.createElement('p')
        if (after) nextP.textContent = after
        else nextP.innerHTML = '<br>'
        if (nodes.length) {
          const last = nodes[nodes.length - 1]
          curRaw.replaceWith(...nodes)
          last.after(nextP)
          renderRenderedNodesIn(nodes)
        } else {
          curRaw.replaceWith(nextP)
        }
        placeCaretAtStart(nextP)
        lastCaretBlock = nextP
        skipRevealBlock = nextP
        onEditorChanged()
      } finally {
        livePreviewLock = false
      }
      return
    }

    // 2) 在普通块内按 Enter 结束单行 Markdown/LaTeX 块或闭合多行 $$ / \[ / ```
    if (curBlock && isPlainTextBlock(curBlock) && sel.isCollapsed) {
      const txt = getRawBlockText(curBlock)
      const off = getSelectionOffsetIn(curBlock)
      const atEnd = off !== null && off >= txt.length
      if (atEnd) {
        if (tryCompileMultiLineSequence(curBlock, { onEnter: true, placeCaretAfter: true })) {
          e.preventDefault()
          return
        }
        if (txt.trim() && !isUnclosedMultiLineStart(txt) && !isPipeTableRow(txt) && noteMd && noteMd.looksLikeMarkdownOrLatex(txt)) {
          if (!isInsideOpenPlainFence(curBlock)) {
            e.preventDefault()
            tryCompilePlainBlockOnLeave(curBlock, { placeCaretAfter: true })
            return
          }
        }
      }
    }

    // 3) 空白新便签首行裸文本（尚无 <p>/<div> 包裹）按 Enter 自动识别
    if (!curBlock && sel.isCollapsed) {
      const run = getBareInlineRunAt(sel.anchorNode, sel.anchorOffset)
      if (run && run.text.trim() && isCaretAtEndOfRun(run, sel.getRangeAt(0))) {
        const txt = run.text
        if (isUnclosedMultiLineStart(txt) || isPipeTableRow(txt)) {
          e.preventDefault()
          livePreviewLock = true
          try {
            const p1 = wrapBareRunIntoP(run)
            const p2 = document.createElement('p')
            p2.innerHTML = '<br>'
            if (p1) p1.after(p2)
            else editor.appendChild(p2)
            placeCaretAtStart(p2)
            lastCaretBlock = p2
            onEditorChanged()
          } finally {
            livePreviewLock = false
          }
          return
        }
        if (noteMd && noteMd.looksLikeMarkdownOrLatex(txt)) {
          e.preventDefault()
          const p = wrapBareRunIntoP(run)
          if (p) tryCompilePlainBlockOnLeave(p, { placeCaretAfter: true })
          return
        }
      }
    }
  }
})

// ============================================================ Mermaid
let mmdReady = false
let mmdSeq = 0
let editingBlock = null

function currentMermaidConfig () {
  const rgb = hexToRgb(NOTE.color)
  const dark = luminance(rgb) < 0.42
  const fg = dark ? mix(rgb, { r: 255, g: 255, b: 255 }, 0.10) : mix(rgb, { r: 26, g: 24, b: 20 }, 0.09)
  const accent = dark ? mix(rgb, { r: 255, g: 255, b: 255 }, 0.55) : mix(rgb, { r: 0, g: 0, b: 0 }, 0.30)
  const bg = NOTE.color
  const nodeBg = dark ? mix(rgb, { r: 255, g: 255, b: 255 }, 0.90) : mix(rgb, { r: 255, g: 255, b: 255 }, 0.62)
  return {
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'base',
    fontFamily: theme ? theme.fontFamily : 'Microsoft YaHei, sans-serif',
    themeVariables: {
      darkMode: dark,
      background: 'transparent',
      primaryColor: nodeBg,
      primaryTextColor: fg,
      primaryBorderColor: accent,
      secondaryColor: nodeBg,
      secondaryTextColor: fg,
      secondaryBorderColor: accent,
      tertiaryColor: nodeBg,
      tertiaryTextColor: fg,
      tertiaryBorderColor: accent,
      lineColor: accent,
      textColor: fg,
      nodeTextColor: fg,
      edgeLabelBackground: bg,
      labelBackground: bg,
      labelTextColor: fg,
      fontSize: '14px'
    }
  }
}

function initMermaid () {
  if (typeof window.mermaid === 'undefined') {
    console.warn('mermaid 未加载')
    return false
  }
  window.mermaid.initialize(currentMermaidConfig())
  mmdReady = true
  return true
}

async function renderMermaidBlock (block) {
  const body = block.querySelector('.mmd-body')
  if (!body) return
  const code = (block.dataset.code || '').trim()
  if (!code) { body.innerHTML = ''; return }
  if (!mmdReady && !initMermaid()) {
    body.innerHTML = `<div class="mmd-err">Mermaid 组件未加载</div>`
    return
  }
  try {
    const id = 'mmd-' + (++mmdSeq)
    const { svg } = await window.mermaid.render(id, code)
    body.innerHTML = svg
    const el = body.querySelector('svg')
    if (el) {
      const vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/)
      const natural = parseFloat(vb[2]) || 0
      el.removeAttribute('height')
      el.style.width = '100%'
      el.style.height = 'auto'
      el.style.maxWidth = natural > 0 ? `min(100%, ${Math.round(natural)}px)` : '100%'
    }
  } catch (err) {
    body.innerHTML = `<div class="mmd-err">${escapeHtml(err && err.message ? err.message : String(err))}</div>`
  }
}

function renderAllMermaid () {
  editor.querySelectorAll('.mmd').forEach(b => renderMermaidBlock(b))
}

function buildMermaidBlock (code) {
  const wrap = document.createElement('div')
  wrap.className = 'mmd'
  wrap.contentEditable = 'false'
  wrap.dataset.code = code
  wrap.dataset.blockId = 'b' + Math.random().toString(36).slice(2, 10)
  wrap.innerHTML = `
    <div class="mmd-tools">
      <button type="button" data-mmd="edit" title="编辑代码">✎</button>
      <button type="button" data-mmd="board" title="在画板中编辑">▦</button>
      <button type="button" data-mmd="del" title="删除图表">✕</button>
    </div>
    <div class="mmd-body"></div>`
  return wrap
}

function ensureBlockIds () {
  editor.querySelectorAll('.mmd').forEach(b => {
    if (!b.dataset.blockId) b.dataset.blockId = 'b' + Math.random().toString(36).slice(2, 10)
  })
}

function insertMermaidBlock (code) {
  if (editView === 'source') {
    insertSourceText('\n```mermaid\n' + code + '\n```\n')
    return
  }
  const block = buildMermaidBlock(code)
  const sel = window.getSelection()
  const hasCaret = document.activeElement === editor && sel && sel.rangeCount &&
    editor.contains(sel.anchorNode)
  editor.focus()
  if (!hasCaret) {
    editor.appendChild(block)
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    editor.appendChild(p)
  } else {
    const range = sel.getRangeAt(0)
    range.deleteContents()
    range.insertNode(block)
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    block.after(p)
    const r2 = document.createRange()
    r2.setStart(p, 0)
    r2.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r2)
  }
  renderMermaidBlock(block)
  onEditorChanged()
}

const MMD_TEMPLATES = [
  `graph TD
  A[想法] --> B{可行?}
  B -->|是| C[开工]
  B -->|否| D[再想想]`,
  `sequenceDiagram
  participant U as 用户
  participant S as 系统
  U->>S: 发起请求
  S-->>U: 返回结果`,
  `pie title 时间分配
  "开发" : 45
  "评审" : 20
  "测试" : 25
  "文档" : 10`,
  `gantt
  title 项目排期
  dateFormat  YYYY-MM-DD
  section 阶段一
  需求    :a1, 2026-01-01, 5d
  设计    :a2, after a1, 4d
  section 阶段二
  开发    :b1, after a2, 10d`
]

const mmdModal = $('#mmdModal')
const mmdCode = $('#mmdCode')
const mmdPreview = $('#mmdPreview')
const mmdErr = $('#mmdErr')

document.querySelector('[data-act="mmd-ok"]').addEventListener('click', () => confirmMermaid())
document.querySelector('[data-act="mmd-cancel"]').addEventListener('click', () => closeMermaidModal())

document.querySelector('[data-act="mmd-board"]').addEventListener('click', () => {
  const code = mmdCode.value.trim()
  const block = editingBlock
  closeMermaidModal()
  if (block && !block.dataset.blockId) {
    block.dataset.blockId = 'b' + Math.random().toString(36).slice(2, 10)
  }
  api.openDiagram({ code, blockId: block ? block.dataset.blockId : null })
})

let templateIdx = 0
document.querySelector('[data-act="mmd-template"]').addEventListener('click', () => {
  mmdCode.value = MMD_TEMPLATES[templateIdx % MMD_TEMPLATES.length]
  templateIdx += 1
  previewMermaid()
})

function openMermaidModal (block) {
  if (editView === 'live') flushPendingLiveEdits()
  editingBlock = block || null
  mmdCode.value = block ? block.dataset.code : ''
  mmdErr.textContent = ''
  mmdPreview.innerHTML = '<span class="ph">实时预览</span>'
  mmdModal.hidden = false
  mmdCode.focus()
  if (block) previewMermaid()
  document.querySelector('[data-act="mmd-ok"]').textContent = block ? '保存' : '插入'
}

function closeMermaidModal () {
  mmdModal.hidden = true
  editingBlock = null
  mmdCode.value = ''
  mmdPreview.innerHTML = '<span class="ph">实时预览</span>'
}

let previewSeq = 0
async function previewMermaid () {
  const code = mmdCode.value.trim()
  if (!code) {
    mmdPreview.innerHTML = '<span class="ph">实时预览</span>'
    return
  }
  if (!mmdReady && !initMermaid()) return
  const seq = ++previewSeq
  try {
    const { svg } = await window.mermaid.render('preview-' + seq, code)
    if (seq !== previewSeq) return
    mmdPreview.innerHTML = svg
    mmdErr.textContent = ''
  } catch (err) {
    if (seq !== previewSeq) return
    mmdPreview.innerHTML = `<div class="err">${escapeHtml(err.message || String(err))}</div>`
    mmdErr.textContent = '语法有误'
  }
}

let previewDebounce = null
mmdCode.addEventListener('input', () => {
  clearTimeout(previewDebounce)
  previewDebounce = setTimeout(previewMermaid, 450)
})
mmdCode.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeMermaidModal() }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmMermaid() }
})

function confirmMermaid () {
  const code = mmdCode.value.trim()
  if (!code) { closeMermaidModal(); return }
  if (editView === 'source') {
    insertSourceText('\n```mermaid\n' + code + '\n```\n')
    closeMermaidModal()
    toast('图表已插入')
    return
  }
  if (editingBlock) {
    editingBlock.dataset.code = code
    renderMermaidBlock(editingBlock)
    onEditorChanged()
    closeMermaidModal()
    toast('图表已更新')
    return
  }
  insertMermaidBlock(code)
  closeMermaidModal()
  toast('图表已插入')
}

editor.addEventListener('click', (e) => {
  const btn = e.target.closest('.mmd-tools button')
  if (!btn) return
  if (activeRaw) collapseActiveRaw()
  const block = btn.closest('.mmd')
  if (!block) return
  if (btn.dataset.mmd === 'edit') openMermaidModal(block)
  if (btn.dataset.mmd === 'board') openBoard(block)
  if (btn.dataset.mmd === 'del') {
    block.remove()
    onEditorChanged()
    toast('图表已删除')
  }
})

// ============================================================ Mermaid 画板
function openBoard (block) {
  const code = block ? (block.dataset.code || '') : ''
  if (block && !block.dataset.blockId) {
    block.dataset.blockId = 'b' + Math.random().toString(36).slice(2, 10)
  }
  api.openDiagram({ code, blockId: block ? block.dataset.blockId : null })
}

function applyBoardResult ({ code, blockId }) {
  if (!code) return
  if (editView === 'source') {
    insertSourceText('\n```mermaid\n' + code + '\n```\n')
    toast('图表已插入')
    return
  }
  const block = blockId
    ? editor.querySelector(`.mmd[data-block-id="${blockId}"]`)
    : null
  if (block) {
    block.dataset.code = code
    renderMermaidBlock(block)
    onEditorChanged()
    toast('图表已更新')
  } else {
    insertMermaidBlock(code)
    toast('图表已插入')
  }
  if (NOTE.mode === 'read') setMode('edit', { silent: true })
  else editor.scrollIntoView({ block: 'nearest' })
}

// ============================================================ LaTeX 公式弹窗
const mathModal = $('#mathModal')
const mathCode = $('#mathCode')
const mathPreview = $('#mathPreview')
const mathErr = $('#mathErr')
const mathOkBtn = document.querySelector('[data-act="math-ok"]')
let mathMode = 'inline'       // 'inline' | 'block'
let mathEditContext = null    // { target: 'raw'|'source'|'new', rawEl?, span?, sourceRange? }

function setMathMode (mode) {
  mathMode = mode === 'block' ? 'block' : 'inline'
  document.querySelectorAll('[data-math-mode]').forEach(btn => {
    btn.dataset.on = btn.dataset.mathMode === mathMode ? '1' : '0'
  })
  previewMath()
}

function previewMath () {
  const tex = mathCode.value.trim()
  if (!tex) {
    mathPreview.innerHTML = '<span class="ph">KaTeX 实时预览</span>'
    mathErr.textContent = ''
    return
  }
  if (typeof window.katex !== 'undefined' && typeof window.katex.renderToString === 'function') {
    try {
      mathPreview.innerHTML = window.katex.renderToString(tex, {
        displayMode: mathMode === 'block',
        throwOnError: false,
        strict: false,
        trust: false
      })
      const errNode = mathPreview.querySelector('.katex-error')
      mathErr.textContent = errNode ? '语法提示：请检查 LaTeX 语法' : ''
      return
    } catch (err) {
      mathErr.textContent = (err && err.message) || '语法有误'
    }
  }
  mathPreview.textContent = tex
}

function detectFormulaAtCaret () {
  if (editView === 'source') {
    const start = Number.isFinite(sourceEditor.selectionStart) ? sourceEditor.selectionStart : 0
    const end = Number.isFinite(sourceEditor.selectionEnd) ? sourceEditor.selectionEnd : start
    const val = sourceEditor.value
    const spans = findMathSpansInText(val)
    const hit = spans.find(sp => start >= sp.start && end <= sp.end)
    if (hit) {
      return { target: 'source', span: hit, tex: hit.tex, mode: hit.displayMode ? 'block' : 'inline' }
    }
    return { target: 'source', tex: val.slice(start, end), mode: 'inline', selection: { start, end } }
  }

  if (activeRaw && editor.contains(activeRaw.el)) {
    const off = getSelectionOffsetIn(activeRaw.el)
    const rawText = getRawBlockText(activeRaw.el)
    if (typeof off === 'number') {
      const spans = findMathSpansInText(rawText)
      const hit = spans.find(sp => off >= sp.start && off <= sp.end)
      if (hit) {
        return { target: 'raw', rawEl: activeRaw.el, span: hit, tex: hit.tex, mode: hit.displayMode ? 'block' : 'inline' }
      }
      const sel = window.getSelection()
      const selText = sel && sel.rangeCount && activeRaw.el.contains(sel.anchorNode) ? sel.toString() : ''
      const selEnd = selText ? Math.min(rawText.length, off + selText.length) : off
      return {
        target: 'raw',
        rawEl: activeRaw.el,
        span: { start: Math.min(off, selEnd), end: Math.max(off, selEnd) },
        isInsert: true,
        tex: selText,
        mode: 'inline'
      }
    }
  }

  const sel = window.getSelection()
  const selText = sel && sel.rangeCount && editor.contains(sel.anchorNode) ? sel.toString() : ''
  const savedRange = sel && sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null
  return { target: 'new', tex: selText, mode: 'inline', savedRange }
}

function openMathModal () {
  const ctx = detectFormulaAtCaret()
  mathEditContext = ctx
  mathCode.value = ctx.tex || ''
  setMathMode(ctx.mode || 'inline')
  mathOkBtn.textContent = (ctx.span && !ctx.isInsert) ? '保存' : '插入'
  mathModal.hidden = false
  mathCode.focus()
  previewMath()
}

function closeMathModal (opts = {}) {
  const prevCtx = mathEditContext
  mathModal.hidden = true
  mathEditContext = null
  mathCode.value = ''
  mathErr.textContent = ''
  mathPreview.innerHTML = '<span class="ph">KaTeX 实时预览</span>'
  if (opts.skipRestoreFocus) return
  if (editView === 'source') {
    sourceEditor.focus()
  } else if (editView === 'live' && NOTE && NOTE.mode === 'edit') {
    editor.focus({ preventScroll: true })
    if (prevCtx && prevCtx.target === 'new' && prevCtx.savedRange && editor.contains(prevCtx.savedRange.startContainer)) {
      const sel = window.getSelection()
      if (sel) { sel.removeAllRanges(); sel.addRange(prevCtx.savedRange) }
    }
  }
}

function confirmMath () {
  const tex = mathCode.value.trim()
  if (!tex) { closeMathModal(); return }
  const isBlock = mathMode === 'block'
  const ctx = mathEditContext

  if (editView === 'source') {
    const delimStart = isBlock ? '\n$$\n' : '$'
    const delimEnd = isBlock ? '\n$$\n' : '$'
    if (ctx && ctx.span) {
      const rep = (isBlock ? '$$\n' + tex + '\n$$' : '$' + tex + '$')
      sourceEditor.focus()
      sourceEditor.setRangeText(rep, ctx.span.start, ctx.span.end, 'end')
      onSourceChanged()
    } else {
      insertSourceText(delimStart + tex + delimEnd)
    }
    closeMathModal({ skipRestoreFocus: true })
    toast(ctx && ctx.span ? '公式已更新' : '公式已插入')
    return
  }

  if (ctx && ctx.target === 'raw' && ctx.span && activeRaw && activeRaw.el === ctx.rawEl) {
    const curText = getRawBlockText(ctx.rawEl)
    const before = curText.slice(0, ctx.span.start)
    const after = curText.slice(ctx.span.end)
    let rep
    if (isBlock) {
      const pre = before.trim() ? (before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n')) : ''
      const post = after.trim() ? (after.startsWith('\n\n') ? '' : (after.startsWith('\n') ? '\n' : '\n\n')) : ''
      rep = pre + '$$\n' + tex + '\n$$' + post
    } else {
      rep = '$' + tex + '$'
    }
    const nextText = before + rep + after
    ctx.rawEl.textContent = nextText
    activeRaw.edited = activeRaw.edited || nextText !== activeRaw.origMarkdown
    closeMathModal({ skipRestoreFocus: true })
    collapseActiveRaw({ placeCaretAfter: true, focusEditor: true, skipReveal: true })
    toast(ctx.isInsert ? '公式已插入' : '公式已更新')
    return
  }

  closeMathModal({ skipRestoreFocus: true })
  if (activeRaw) collapseActiveRaw()

  // 直接插入骨架节点并渲染 KaTeX
  const node = noteMd
    ? noteMd.buildMathNode(document, tex, isBlock, isBlock ? '$$' : '$')
    : (() => {
        const el = document.createElement(isBlock ? 'div' : 'span')
        el.className = isBlock ? 'math-block' : 'math-inline'
        el.contentEditable = 'false'
        el.dataset.tex = tex
        el.dataset.delim = isBlock ? '$$' : '$'
        el.innerHTML = isBlock ? '<div class="math-body"></div>' : '<span class="math-body"></span>'
        return el
      })()

  livePreviewLock = true
  try {
    editor.focus({ preventScroll: true })
    const sel = window.getSelection()
    if (ctx && ctx.savedRange && editor.contains(ctx.savedRange.startContainer)) {
      sel.removeAllRanges()
      sel.addRange(ctx.savedRange)
    }

    let range
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0)
    } else {
      range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
    }

    if (isBlock) {
      const hostBlock = topBlockOf(range.startContainer)
      if (hostBlock) {
        if (!hostBlock.textContent.trim() && !hostBlock.querySelector('img, .mmd, .math-inline, .math-block')) {
          hostBlock.replaceWith(node)
        } else {
          hostBlock.after(node)
        }
      } else {
        range.deleteContents()
        range.insertNode(node)
      }
      renderMathNode(node)
      const p = document.createElement('p')
      p.innerHTML = '<br>'
      node.after(p)
      placeCaretAtStart(p)
      lastCaretBlock = p
      skipRevealBlock = p
    } else {
      range.deleteContents()
      range.insertNode(node)
      renderMathNode(node)
      const space = document.createTextNode(' ')
      node.after(space)
      if (sel) {
        const r2 = document.createRange()
        r2.setStart(space, 1)
        r2.collapse(true)
        sel.removeAllRanges()
        sel.addRange(r2)
      }
      lastCaretBlock = topBlockOf(space)
      skipRevealBlock = lastCaretBlock
    }
  } finally {
    livePreviewLock = false
  }
  onEditorChanged()
  toast('公式已插入')
}

document.querySelectorAll('[data-math-mode]').forEach(btn => {
  btn.addEventListener('click', () => setMathMode(btn.dataset.mathMode))
})
document.querySelectorAll('[data-math-tpl]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tpl = btn.dataset.mathTpl || ''
    if (tpl.includes('\\begin{aligned}') && !mathCode.value.trim()) setMathMode('block')
    const start = Number.isFinite(mathCode.selectionStart) ? mathCode.selectionStart : mathCode.value.length
    const end = Number.isFinite(mathCode.selectionEnd) ? mathCode.selectionEnd : start
    mathCode.setRangeText(tpl, start, end, 'end')
    mathCode.focus()
    previewMath()
  })
})
document.querySelector('[data-act="math-ok"]').addEventListener('click', confirmMath)
document.querySelector('[data-act="math-cancel"]').addEventListener('click', closeMathModal)
mathCode.addEventListener('input', previewMath)
mathCode.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeMathModal() }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmMath() }
})

// ============================================================ 工具栏
document.querySelectorAll('.toolbar .tbtn').forEach(btn => {
  btn.addEventListener('mousedown', e => e.preventDefault())
})

document.querySelectorAll('.toolbar [data-cmd]').forEach(btn => {
  btn.addEventListener('click', () => exec(btn.dataset.cmd))
})

document.querySelectorAll('.toolbar [data-act]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const act = btn.dataset.act
    if (act === 'task') {
      if (editView === 'source') {
        prefixSourceLines((l) => /^- \[[ xX]\] /.test(l) ? l : '- [ ] ' + (l || '新任务'))
        return
      }
      if (activeRaw && editor.contains(activeRaw.el)) {
        prefixRawLines((l) => /^- \[[ xX]\] /.test(l) ? l : '- [ ] ' + (l || '新任务'))
        return
      }
      const selection = window.getSelection()
      const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null
      if (!range || !editor.contains(range.startContainer) || (range.collapsed && range.startContainer === editor)) {
        const paragraph = document.createElement('p')
        paragraph.appendChild(document.createElement('br'))
        if (range && editor.contains(range.startContainer)) range.insertNode(paragraph)
        else editor.appendChild(paragraph)
        const caret = document.createRange(); caret.selectNodeContents(paragraph); caret.collapse(true)
        selection.removeAllRanges(); selection.addRange(caret)
      }
      exec('insertHTML', '<ul><li data-task="1"><input type="checkbox" contenteditable="false"> 新任务</li></ul>')
    }
    if (act === 'font-inc') { setFontSize(theme.fontSize + 1) }
    if (act === 'font-dec') { setFontSize(theme.fontSize - 1) }
    if (act === 'clear') { exec('removeFormat'); if (editView === 'live') exec('formatBlock', 'div') }
    if (act === 'image') {
      const res = await api.pickImage()
      if (!res) return
      if (res.error) { toast(res.error); return }
      await insertImageDataUrl(res.dataUrl)
    }
    if (act === 'capture') {
      const res = await api.startCapture()
      if (res && res.error) toast(res.error)
    }
    if (act === 'mermaid') openMermaidModal(null)
    if (act === 'board') openBoard(null)
    if (act === 'math') openMathModal()
  })
})

$('#textColor').addEventListener('input', (e) => {
  $('#colorSwatch').style.background = e.target.value
  exec('foreColor', e.target.value)
})

function setFontSize (size) {
  theme.fontSize = clamp(Math.round(size), 11, 34)
  $('#fontSize').value = theme.fontSize
  $('#fontSizeVal').textContent = theme.fontSize
  applyAppearance()
  queueSave({ theme: { fontSize: theme.fontSize } })
}

// 选中态高亮
document.addEventListener('selectionchange', () => {
  if (document.activeElement !== editor) return
  for (const [cmd, sel] of [['bold', '[data-cmd="bold"]'], ['italic', '[data-cmd="italic"]'], ['underline', '[data-cmd="underline"]']]) {
    const el = document.querySelector(sel)
    if (!el) continue
    try { el.style.background = document.queryCommandState(cmd) ? 'var(--hover)' : '' } catch (_) {}
  }
})

// ============================================================ 面板
function openPanel () {
  panel.hidden = false
  syncPanel()
  syncSizeInputs()
}
function closePanel () { panel.hidden = true }

document.querySelectorAll('[data-act="panel"], [data-act="panel-close"]').forEach(el => {
  el.addEventListener('click', () => {
    if (panel.hidden) openPanel(); else closePanel()
  })
})

const swWrap = $('#swatches')
PALETTE.forEach(c => {
  const b = document.createElement('button')
  b.className = 'sw'
  b.type = 'button'
  b.dataset.color = c
  b.style.background = c
  b.title = c
  b.addEventListener('click', () => setColor(c))
  swWrap.appendChild(b)
})

function setColor (hex) {
  NOTE.color = hex
  applyAppearance()
  syncPanel()
  queueSave({ color: hex })
  if (editor.querySelector('.mmd')) {
    initMermaid()
    renderAllMermaid()
  }
}
$('#customColor').addEventListener('input', (e) => setColor(e.target.value))

$('#fontFamily').addEventListener('change', (e) => {
  theme.fontFamily = e.target.value
  applyAppearance()
  queueSave({ theme: { fontFamily: theme.fontFamily } })
})
$('#fontSize').addEventListener('input', (e) => {
  theme.fontSize = Number(e.target.value)
  $('#fontSizeVal').textContent = theme.fontSize
  applyAppearance()
  queueSave({ theme: { fontSize: theme.fontSize } })
})
$('#lineHeight').addEventListener('input', (e) => {
  theme.lineHeight = Number(e.target.value)
  $('#lineHeightVal').textContent = Number(theme.lineHeight).toFixed(2)
  applyAppearance()
  queueSave({ theme: { lineHeight: theme.lineHeight } })
})
$('#radius').addEventListener('input', (e) => {
  theme.radius = Number(e.target.value)
  $('#radiusVal').textContent = theme.radius
  applyAppearance()
  queueSave({ theme: { radius: theme.radius } })
})
$('#opacity').addEventListener('input', (e) => {
  theme.opacity = Number(e.target.value) / 100
  $('#opacityVal').textContent = e.target.value
  applyAppearance()
  queueSave({ theme: { opacity: theme.opacity } })
})
$('#shadow').addEventListener('change', (e) => {
  theme.shadow = e.target.checked
  applyAppearance()
  queueSave({ theme: { shadow: theme.shadow } })
})
$('#showToolbar').addEventListener('change', (e) => {
  theme.showToolbar = e.target.checked
  applyAppearance()
  queueSave({ theme: { showToolbar: theme.showToolbar } })
})
$('#alwaysOnTop').addEventListener('change', (e) => {
  NOTE.alwaysOnTop = e.target.checked
  applyAppearance()
  queueSave({ alwaysOnTop: NOTE.alwaysOnTop })
})

$('#edgeCollapse').addEventListener('change', (e) => {
  NOTE.edgeCollapse = e.target.checked
  queueSave({ edgeCollapse: NOTE.edgeCollapse })
  toast(NOTE.edgeCollapse ? '已开启贴边收缩' : '已关闭贴边收缩')
})

$('#collapseToggle').addEventListener('click', async () => {
  closePanel()
  if (collapsed) {
    const r = await api.expand()
    if (r && !r.ok) toast('展开失败')
    else toast('已展开')
  } else {
    await flushSave()
    const r = await api.collapse()
    if (r && r.ok) toast('已贴边收缩 · 鼠标移上去可展开')
    else toast('没找到可贴靠的屏幕边缘')
  }
})

document.querySelector('[data-act="apply-size"]').addEventListener('click', async () => {
  const w = clamp(Number($('#wIn').value) || 400, 260, 2400)
  const h = clamp(Number($('#hIn').value) || 460, 200, 2000)
  const b = await api.getBounds()
  if (!b) return
  await api.setBounds({ x: b.x, y: b.y, width: w, height: h })
  toast(`尺寸已设为 ${w} × ${h}`)
})

document.querySelector('[data-act="duplicate"]').addEventListener('click', async () => {
  await flushSave()
  await api.duplicate()
  toast('已复制便签')
})

document.querySelector('[data-act="delete"]').addEventListener('click', async () => {
  if (!window.confirm('删除后无法恢复，确定删除这张便签？')) return
  await api.remove()
})

document.querySelector('[data-act="dashboard"]').addEventListener('click', () => api.openDashboard())

document.querySelector('[data-act="clear-format"]').addEventListener('click', () => {
  closePanel()
  exec('removeFormat')
  if (editView === 'live') exec('formatBlock', 'div')
  toast('已清除文字格式')
})

// ============================================================ 顶栏
document.querySelector('[data-act="pin"]').addEventListener('click', () => {
  NOTE.alwaysOnTop = !NOTE.alwaysOnTop
  applyAppearance()
  syncPanel()
  queueSave({ alwaysOnTop: NOTE.alwaysOnTop })
  toast(NOTE.alwaysOnTop ? '已置顶' : '取消置顶')
})

document.querySelector('[data-act="hide"]').addEventListener('click', async () => {
  await flushSave()
  await api.hide()
})

document.querySelector('[data-act="read"]').addEventListener('click', () => setMode('read'))
document.querySelector('[data-act="edit"]').addEventListener('click', () => setMode('edit'))
if (sourceToggle) {
  sourceToggle.addEventListener('click', () => {
    setEditView(editView === 'source' ? 'live' : 'source')
  })
}

$('#edgeTab').addEventListener('click', () => { api.expand() })
$('#edgeTab').addEventListener('mouseenter', () => noteEl.classList.add('hovering'))
$('#edgeTab').addEventListener('mouseleave', () => noteEl.classList.remove('hovering'))

titleEl.addEventListener('input', () => {
  queueSave({ title: titleEl.value })
})
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); titleEl.blur() }
})
titleEl.addEventListener('blur', async () => { await flushSave() })

window.addEventListener('blur', async () => {
  if (editView === 'live' && mathModal.hidden && mmdModal.hidden) flushPendingLiveEdits()
  await flushSave()
})

// ============================================================ 八向缩放
let resizeState = null
let rafPending = false
let resizeTimer = 0

document.querySelectorAll('.rz').forEach(handle => {
  handle.addEventListener('pointerdown', async (e) => {
    e.preventDefault()
    const b = await api.getBounds()
    if (!b) return
    resizeState = { dir: handle.dataset.dir, sx: e.screenX, sy: e.screenY, b }
    handle.setPointerCapture(e.pointerId)
  })

  const move = (e) => {
    if (!resizeState) return
    if (rafPending) return
    rafPending = true
    const fire = () => {
      rafPending = false
      clearTimeout(resizeTimer)
      if (!resizeState) return
      const { dir, sx, sy, b } = resizeState
      const dx = e.screenX - sx
      const dy = e.screenY - sy
      let { x, y, width, height } = b
      if (dir.includes('e')) width = Math.max(260, width + dx)
      if (dir.includes('s')) height = Math.max(200, height + dy)
      if (dir.includes('w')) {
        const w = Math.max(260, width - dx)
        x += width - w
        width = w
      }
      if (dir.includes('n')) {
        const h = Math.max(200, height - dy)
        y += height - h
        height = h
      }
      api.setBounds({ x, y, width, height })
    }
    requestAnimationFrame(fire)
    resizeTimer = setTimeout(fire, 40)
  }

  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', () => { resizeState = null; syncSizeInputs() })
  handle.addEventListener('pointercancel', () => { resizeState = null })
})

// 阅读模式下单击图片即可放大查看；编辑模式下 Ctrl+Click 外链直接打开
editor.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]')
  if (link && ((NOTE && NOTE.mode === 'read') || e.ctrlKey || e.metaKey)) {
    const href = link.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault()
      window.open(href, '_blank', 'noopener')
      return
    }
  }
  if (!NOTE || NOTE.mode !== 'read') return
  const img = e.target.closest('img')
  if (!img) return
  e.preventDefault()
  openImagePreview(img)
})

function openImagePreview (imgEl) {
  const src = imgEl.getAttribute('src')
  if (!src) return
  api.previewImage({
    dataUrl: src,
    title: NOTE && NOTE.title ? `${NOTE.title} · 图片` : '查看图片'
  })
}

editor.addEventListener('dblclick', (e) => {
  const img = e.target.closest('img')
  if (img) {
    e.preventDefault()
    openImagePreview(img)
    return
  }
  if (NOTE && NOTE.mode === 'read') setMode('edit')
})

noteEl.addEventListener('mouseenter', () => noteEl.classList.add('hovering'))
noteEl.addEventListener('mouseleave', () => noteEl.classList.remove('hovering'))

document.addEventListener('pointerdown', () => {
  if (!collapsed) api.engage()
}, true)

// ============================================================ 键盘
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey
  if (e.key === 'Escape') {
    if (!mathModal.hidden) { closeMathModal(); return }
    if (!mmdModal.hidden) { closeMermaidModal(); return }
    if (!panel.hidden) { closePanel(); return }
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
    e.preventDefault()
    if (!NOTE || NOTE.mode === 'read') return
    setEditView(editView === 'source' ? 'live' : 'source')
    return
  }
  if (mod && e.key === '\\') {
    e.preventDefault()
    if (NOTE.mode === 'read') return
    exec('removeFormat')
    if (editView === 'live') exec('formatBlock', 'div')
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault()
    flushSave().then(ok => toast(ok ? '已保存' : '保存失败，请稍后重试'))
  }
  if (mod && e.key.toLowerCase() === 'n' && e.shiftKey) {
    e.preventDefault()
    api.create({})
  }
})

// ============================================================ 初始化
async function init () {
  const data = await api.getNote()
  if (!data) {
    document.body.innerHTML = '<div style="padding:20px;font:13px sans-serif;color:#666">便签数据加载失败</div>'
    return
  }
  NOTE = data
  noteId = data.id
  NOTE.mode = data.mode === 'read' ? 'read' : 'edit'
  theme = Object.assign({
    fontFamily: 'Microsoft YaHei, sans-serif',
    fontSize: 15,
    lineHeight: 1.75,
    radius: 14,
    opacity: 1,
    shadow: true,
    showToolbar: true
  }, data.theme || {})

  titleEl.value = NOTE.title || ''
  syncReminder(NOTE.reminder)
  editor.innerHTML = NOTE.html || ''
  compileRawBlocksOnLoad()
  if (externalizeImages(editor, true)) api.update({ html: editor.innerHTML })
  invalidateSnapshot()
  ensureBlockIds()

  applyAppearance()
  applyMode()
  syncPanel()
  updateEmptyState()
  updateStats()
  syncSizeInputs()

  applyCollapse({ collapsed: NOTE.collapsed, edge: NOTE.collapseEdge })
  api.onCollapseState(applyCollapse)

  initMermaid()
  renderAllMermaid()
  renderAllMath()

  document.title = NOTE.title || '便签'

  api.onDiagramApplied(applyBoardResult)

  if (typeof api.onAiInsert === 'function') {
    api.onAiInsert((payload) => {
      if (payload && payload.text && typeof window.__aiInsertText === 'function') {
        window.__aiInsertText(payload.text)
      }
    })
  }

  api.onCaptureDone((payload) => {
    if (!payload || !payload.dataUrl) return
    insertImageDataUrl(payload.dataUrl)
    if (NOTE.mode === 'read') setMode('edit', { silent: true })
  })

  api.onNotesChanged(async (notes) => {
    const me = notes.find(n => n.id === noteId)
    if (!me) return
    syncReminder(me.reminder)
    if (me.mode && me.mode !== NOTE.mode) {
      if (me.mode === 'read' && editView === 'source') setEditView('live', { silent: true })
      if (me.mode === 'read') flushPendingLiveEdits()
      NOTE.mode = me.mode
      applyMode()
    }
    if (me.color !== NOTE.color) {
      NOTE.color = me.color
      NOTE.theme = Object.assign({}, NOTE.theme, me.theme)
      applyAppearance()
      syncPanel()
    }
    if (me.theme && JSON.stringify(me.theme) !== JSON.stringify(theme)) {
      theme = Object.assign({}, theme, me.theme)
      applyAppearance()
      syncPanel()
    }
    if (me.alwaysOnTop !== NOTE.alwaysOnTop) {
      NOTE.alwaysOnTop = me.alwaysOnTop
      applyAppearance()
      syncPanel()
    }
    if (!!me.collapsed !== collapsed || (me.collapseEdge || null) !== collapseEdge) {
      NOTE.collapsed = !!me.collapsed
      NOTE.collapseEdge = me.collapseEdge || null
      applyCollapse({ collapsed: NOTE.collapsed, edge: NOTE.collapseEdge })
    }
    if (me.edgeCollapse !== undefined) {
      NOTE.edgeCollapse = me.edgeCollapse !== false
      const cb = $('#edgeCollapse')
      if (cb) cb.checked = NOTE.edgeCollapse
    }
    if ((me.title || '') !== (titleEl.value || '') && document.activeElement !== titleEl) {
      titleEl.value = me.title || ''
    }
  })

  window.addEventListener('beforeunload', () => { void flushSave() })
}

init()

function syncReminder (reminder) {
  const input = document.getElementById('reminderAt')
  if (document.activeElement === input) return
  const date = reminder ? new Date(reminder.at) : null
  input.value = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
}
document.getElementById('setReminder').addEventListener('click', async () => {
  const result = await api.action(noteId, 'reminder', new Date(document.getElementById('reminderAt').value).getTime())
  toast(result.ok ? '提醒已保存' : result.error)
})
document.getElementById('cancelReminder').addEventListener('click', async () => {
  await api.action(noteId, 'reminder', null)
  toast('提醒已取消')
})
document.getElementById('archiveNote').addEventListener('click', async () => {
  await flushSave()
  const result = await api.action(noteId, 'archive')
  if (result && !result.ok) toast(result.error)
})
editor.addEventListener('click', e => {
  const checkbox = e.target.closest('input[type="checkbox"]')
  if (!checkbox) return
  e.preventDefault()
  if (NOTE.mode === 'read') return
  if (activeRaw && editor.contains(activeRaw.el) && !activeRaw.el.contains(checkbox)) {
    collapseActiveRaw()
  }
  const replacement = checkbox.cloneNode(true)
  if (checkbox.hasAttribute('checked')) replacement.removeAttribute('checked')
  else replacement.setAttribute('checked', '')
  const range = document.createRange()
  range.selectNode(checkbox)
  const selection = window.getSelection()
  selection.removeAllRanges(); selection.addRange(range)
  exec('insertHTML', replacement.outerHTML)
})

const textTools = document.createElement('div')
textTools.className = 'text-tools'
textTools.hidden = true
textTools.setAttribute('role', 'menu')
for (const [action, label] of [['trim', '去除首尾空白'], ['json', 'JSON 格式化'], ['encode', 'URL 编码'], ['decode', 'URL 解码']]) {
  const button = document.createElement('button')
  button.textContent = label
  button.dataset.tool = action
  button.setAttribute('role', 'menuitem')
  textTools.appendChild(button)
}
document.body.appendChild(textTools)
let toolRange
let toolText
editor.addEventListener('contextmenu', e => {
  if (editView !== 'live') return
  const selection = window.getSelection()
  if (NOTE.mode === 'read' || !selection.rangeCount || selection.isCollapsed || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return
  const range = selection.getRangeAt(0)
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement
  const end = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement
  if (start.closest('td,th') !== end.closest('td,th') ||
      start.closest('.mmd, .math-inline, .math-block, .katex') ||
      end.closest('.mmd, .math-inline, .math-block, .katex')) return
  if (range.cloneContents().querySelector('img,table,.mmd,input,.math-inline,.math-block,.katex')) return
  e.preventDefault()
  toolText = selection.toString()
  toolRange = range.cloneRange()
  textTools.hidden = false
  textTools.style.left = Math.max(0, Math.min(e.clientX, innerWidth - 190)) + 'px'
  textTools.style.top = Math.max(0, Math.min(e.clientY, innerHeight - 160)) + 'px'
  textTools.querySelector('button').focus()
})
textTools.addEventListener('mousedown', e => e.preventDefault())
textTools.addEventListener('click', e => {
  const action = e.target.dataset.tool
  if (!action || !toolRange) return
  const text = toolText
  let value
  try {
    value = action === 'trim' ? text.trim() : action === 'json' ? JSON.stringify(JSON.parse(text), null, 2) : action === 'encode' ? encodeURIComponent(text) : decodeURIComponent(text)
  } catch (_) { toast('内容格式无效，已保留原文'); textTools.hidden = true; return }
  const whitespace = editor.style.whiteSpace
  editor.style.whiteSpace = 'pre-wrap'
  editor.focus()
  const selection = window.getSelection()
  selection.removeAllRanges(); selection.addRange(toolRange)
  exec('insertHTML', '<span style="white-space:break-spaces">' + escapeHtml(value).replace(/\n/g, '<br>') + '</span>')
  editor.style.whiteSpace = whitespace
  textTools.hidden = true
})
document.addEventListener('pointerdown', e => { if (!textTools.contains(e.target)) textTools.hidden = true })
document.addEventListener('keydown', e => { if (e.key === 'Escape') textTools.hidden = true })

for (const [id, format] of [['exportMarkdown', 'md'], ['exportText', 'txt']]) {
  document.getElementById(id).addEventListener('click', async () => {
    if (!await flushSave()) return
    const result = await api.exportNote(format)
    if (!result.canceled) toast(result.ok ? '导出完成' : result.error)
  })
}

const imageTools = document.createElement('div')
imageTools.className = 'text-tools'; imageTools.hidden = true
imageTools.setAttribute('role', 'menu')
const copyImageButton = document.createElement('button')
copyImageButton.textContent = '复制图片'
copyImageButton.setAttribute('role', 'menuitem')
imageTools.appendChild(copyImageButton)
document.body.appendChild(imageTools)
let selectedImage
editor.addEventListener('contextmenu', e => {
  const img = e.target.closest('img')
  if (!img) return
  e.preventDefault(); textTools.hidden = true; selectedImage = img.getAttribute('src')
  imageTools.hidden = false
  imageTools.style.left = Math.max(0, Math.min(e.clientX, innerWidth - 130)) + 'px'
  imageTools.style.top = Math.max(0, Math.min(e.clientY, innerHeight - 50)) + 'px'
  copyImageButton.focus()
})
copyImageButton.addEventListener('click', async () => {
  const result = await api.copyImage(selectedImage)
  toast(result.ok ? '图片已复制' : result.error)
  imageTools.hidden = true
})
document.addEventListener('pointerdown', e => { if (!imageTools.contains(e.target)) imageTools.hidden = true })
document.addEventListener('keydown', e => { if (e.key === 'Escape') imageTools.hidden = true })
