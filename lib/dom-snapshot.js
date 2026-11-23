'use strict'

/**
 * 便签编辑区的「单次克隆」快照（纯函数，不依赖 Electron）。
 *
 * 背景（docs/perf-input-2026-11-07.md §1.2 B 组）：
 * 180ms 停手路径原本要克隆**三次**整棵 DOM：
 *   ① updateStats() 内部的 plainText() → cloneNode #1
 *   ② serializeHtml()                  → cloneNode #2
 *   ③ plainText().slice(0,160)         → cloneNode #3
 *
 * 这里收敛成**一次** cloneNode：同一棵克隆同时产出
 *   - 规范 html（清空 .mmd-body / .math-body 的 innerHTML、移除 data-rendered）
 *   - 纯文本（.mmd → ' [图表] '、img → ' [图片] '、.math-inline/.math-block → ' [公式] ' 占位）
 *   - 图片数 / 图表数 / 公式数
 *
 * 同时提供 searchTextFromRoot() 供全文检索提取文本与公式 LaTeX 源码（不读 KaTeX 渲染 DOM）。
 */
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api
  } else if (root) {
    root.StickyDomSnapshot = api
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /** 图表占位符（前后各一个空格，与历史实现逐字一致） */
  const CHART_PLACEHOLDER = ' [图表] '
  /** 图片占位符（前后各一个空格，与历史实现逐字一致） */
  const IMAGE_PLACEHOLDER = ' [图片] '
  /** 公式占位符（前后各一个空格，卡片预览/字数统计使用） */
  const MATH_PLACEHOLDER = ' [公式] '
  /** preview 截断长度 */
  const PREVIEW_MAX = 160

  const ELEMENT_NODE = 1
  const TEXT_NODE = 3

  function hasClass (el, clsName) {
    if (!el || el.nodeType !== ELEMENT_NODE) return false
    if (el.classList && typeof el.classList.contains === 'function') {
      return el.classList.contains(clsName)
    }
    const cls = el.getAttribute ? el.getAttribute('class') : el.className
    return String(cls || '').split(/\s+/).indexOf(clsName) >= 0
  }

  /** 元素是否带 mmd class */
  function isChartBlock (el) {
    return hasClass(el, 'mmd')
  }

  /** 元素是否为公式骨架（行内或块级） */
  function isMathNode (el) {
    return hasClass(el, 'math-inline') || hasClass(el, 'math-block')
  }

  /**
   * 只读遍历采集纯文本与媒体计数（不修改克隆）。
   */
  function collectTextAndCounts (node, out, counts) {
    const children = node.childNodes || []
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (!child) continue
      if (child.nodeType === TEXT_NODE) {
        out.push(child.data || '')
        continue
      }
      if (child.nodeType !== ELEMENT_NODE) continue
      const tag = String(child.nodeName || '').toUpperCase()
      if (tag === 'IMG') {
        if (counts) counts.imgCount++
        out.push(IMAGE_PLACEHOLDER)
        continue
      }
      if (isChartBlock(child)) {
        if (counts) counts.mmdCount++
        out.push(CHART_PLACEHOLDER)
        continue
      }
      if (isMathNode(child)) {
        if (counts) counts.mathCount++
        out.push(MATH_PLACEHOLDER)
        continue
      }
      collectTextAndCounts(child, out, counts)
    }
  }

  /**
   * 只读遍历采集「检索用文本」：跳过 IMG / .mmd，对公式节点提取 data-tex LaTeX 源码，
   * 不提取 .math-body 里的 KaTeX 渲染 DOM（避免重复三份字符）。
   */
  const SEARCH_BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TR', 'TD', 'TH'])

  function collectSearchText (node, out) {
    const children = node.childNodes || []
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (!child) continue
      if (child.nodeType === TEXT_NODE) {
        out.push(child.data || '')
        continue
      }
      if (child.nodeType !== ELEMENT_NODE) continue
      const tag = String(child.nodeName || '').toUpperCase()
      if (tag === 'IMG' || isChartBlock(child)) continue
      if (isMathNode(child)) {
        const tex = (child.getAttribute ? child.getAttribute('data-tex') : '') || ''
        if (tex) {
          out.push(hasClass(child, 'math-block') ? (' $$' + tex + '$$ ') : (' $' + tex + '$ '))
        }
        continue
      }
      collectSearchText(child, out)
      if (SEARCH_BLOCK_TAGS.has(tag)) out.push(' ')
    }
  }

  function cleanRenderedInClone (node) {
    const children = node.childNodes || []
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (!child || child.nodeType !== ELEMENT_NODE) continue
      if (hasClass(child, 'mmd-body') || hasClass(child, 'math-body')) {
        child.innerHTML = ''
        continue
      }
      if (isChartBlock(child) || isMathNode(child)) {
        if (typeof child.removeAttribute === 'function') child.removeAttribute('data-rendered')
      }
      cleanRenderedInClone(child)
    }
  }

  function replaceRawBlocksInClone (clone, compileRaw) {
    if (typeof compileRaw !== 'function') return
    const children = Array.from(clone.childNodes || [])
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (child && child.nodeType === ELEMENT_NODE && hasClass(child, 'md-raw')) {
        compileRaw(child, clone)
      }
    }
  }

  /**
   * 纯文本提取（图表/图片/公式用占位符代替）。
   */
  function textFromRoot (root) {
    const parts = []
    collectTextAndCounts(root, parts, null)
    return parts.join('').replace(/\s+/g, ' ').trim()
  }

  /**
   * 搜索索引文本提取（提取正文 + 公式 LaTeX 源码，忽略图片/Mermaid SVG/KaTeX 渲染 DOM）。
   */
  function searchTextFromRoot (root) {
    if (!root) return ''
    const parts = []
    collectSearchText(root, parts)
    return parts.join('').replace(/\s+/g, ' ').trim()
  }

  /**
   * 一次 cloneNode，产出规范 html / 纯文本 / 图片数 / 图表数 / 公式数。
   *
   * @param {Element} root 编辑区根节点
   * @param {object} [opts] 可选 { compileRaw(rawEl, cloneRoot) }
   * @returns {{html:string, text:string, imgCount:number, mmdCount:number, mathCount:number}}
   */
  function snapshot (root, opts) {
    if (!root || typeof root.cloneNode !== 'function') {
      return { html: '', text: '', imgCount: 0, mmdCount: 0, mathCount: 0 }
    }

    // ★ 整棵 DOM 只克隆这一次
    const clone = root.cloneNode(true)
    if (opts && typeof opts.compileRaw === 'function') {
      replaceRawBlocksInClone(clone, opts.compileRaw)
    }

    const counts = { imgCount: 0, mmdCount: 0, mathCount: 0 }
    const parts = []
    // ① 纯文本与计数：只读遍历，不动克隆
    collectTextAndCounts(clone, parts, counts)
    const text = parts.join('').replace(/\s+/g, ' ').trim()

    // ② 规范 html：SVG 与 KaTeX 渲染产物不落盘，只存源码，加载时重渲染
    cleanRenderedInClone(clone)
    const html = clone.innerHTML

    return {
      html,
      text,
      imgCount: counts.imgCount,
      mmdCount: counts.mmdCount,
      mathCount: counts.mathCount
    }
  }

  /** 字数口径（与历史实现逐字一致）：去掉占位符与空白后计数 */
  function charCount (text) {
    return String(text || '')
      .replace(/\[(图表|图片|公式)\]/g, '')
      .replace(/\s/g, '')
      .length
  }

  /** 统计栏文案：mathCount === 0 时与历史格式逐字一致 */
  function statsText (snap) {
    const s = snap || { text: '', imgCount: 0, mmdCount: 0, mathCount: 0 }
    const parts = [charCount(s.text) + ' 字']
    if (s.imgCount) parts.push(s.imgCount + ' 图')
    if (s.mmdCount) parts.push(s.mmdCount + ' 图表')
    if (s.mathCount) parts.push(s.mathCount + ' 公式')
    return parts.join(' · ')
  }

  /** preview 口径：纯文本前 160 字 */
  function previewText (snap, max) {
    const s = snap || { text: '' }
    return String(s.text || '').slice(0, max || PREVIEW_MAX)
  }

  return {
    CHART_PLACEHOLDER,
    IMAGE_PLACEHOLDER,
    MATH_PLACEHOLDER,
    PREVIEW_MAX,
    snapshot,
    textFromRoot,
    searchTextFromRoot,
    charCount,
    statsText,
    previewText
  }
})
