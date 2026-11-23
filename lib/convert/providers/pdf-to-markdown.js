'use strict'

/**
 * 轻量版面启发式 PDF → Markdown 转换器（纯 JS，无 Electron 依赖）。
 *
 * 思路参考开源项目 `opendocsg/pdf2md`：
 *   1. 按 Y 容差将 pdfjs 文本项聚成视觉行，按 X 顺序拼接并切分大间隔分栏；
 *   2. 按字符加权众数估算正文基准字号；
 *   3. 识别标题（字号层级）、代码块（等宽字体）、无序/有序列表与简单表格；
 *   4. 合并同一段落内的自动换行，处理英文断词连字符；
 *   5. 空文本层返回 `{ markdown: '', isEmpty: true }`，供上层发出扫描件告警。
 */

const MONOSPACE_RE = /courier|mono|consolas|menlo|monaco|code|fixed/i
const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/

/**
 * 估算文本项宽度（真实 pdfjs 会给 width；单测合成数据缺省时按字数估算）。
 * @param {object} item
 * @param {number} fontSize
 * @returns {number}
 */
function itemWidth (item, fontSize) {
  const w = Number(item && item.width)
  if (Number.isFinite(w) && w > 0) return w
  return String((item && item.str) || '').length * fontSize * 0.5
}

/**
 * 把一页的文本项聚成按自上而下排列的视觉行。
 * @param {Array<object>} rawItems
 * @returns {Array<object>}
 */
function groupLines (rawItems) {
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .filter(it => it && typeof it.str === 'string' && it.str.length > 0)
    .map(it => {
      const fs = Number(it.fontSize) > 0 ? Number(it.fontSize) : 12
      return {
        str: it.str,
        x: Number(it.x) || 0,
        y: Number(it.y) || 0,
        fontSize: fs,
        width: itemWidth(it, fs),
        fontName: String(it.fontName || '')
      }
    })
    .filter(it => it.str.trim().length > 0)

  if (!items.length) return []

  // PDF 坐标系 Y 轴朝上：从上到下即 Y 从大到小
  items.sort((a, b) => (b.y - a.y) || (a.x - b.x))

  const rows = []
  for (const it of items) {
    let target = null
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      const tol = Math.max(2, 0.35 * Math.max(r.anchorFs, it.fontSize))
      if (Math.abs(it.y - r.anchorY) <= tol) {
        target = r
        break
      }
      if (r.anchorY - it.y > tol * 2) break
    }
    if (target) {
      target.items.push(it)
    } else {
      rows.push({ anchorY: it.y, anchorFs: it.fontSize, items: [it] })
    }
  }

  const lines = []
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x)
    const built = buildLine(r.items)
    if (built) lines.push(built)
  }
  lines.sort((a, b) => b.y - a.y)
  return lines
}

/**
 * 将同一行内按 X 排序的文本项合并为文本与分列片段。
 * @param {Array<object>} items
 * @returns {object|null}
 */
function buildLine (items) {
  if (!items.length) return null

  const fsWeights = new Map()
  let monoChars = 0
  let totalChars = 0
  let ySum = 0

  for (const it of items) {
    const len = it.str.trim().length || 1
    const bucket = Math.round(it.fontSize * 2) / 2
    fsWeights.set(bucket, (fsWeights.get(bucket) || 0) + len)
    totalChars += len
    ySum += it.y * len
    if (MONOSPACE_RE.test(it.fontName)) monoChars += len
  }

  let fontSize = items[0].fontSize
  let bestW = -1
  for (const [fs, w] of fsWeights) {
    if (w > bestW) { bestW = w; fontSize = fs }
  }

  const segments = []
  let curSeg = items[0].str
  let fullText = items[0].str
  let prevEnd = items[0].x + items[0].width

  for (let i = 1; i < items.length; i++) {
    const it = items[i]
    const gap = it.x - prevEnd
    const needsSpace = gap > 0.25 * fontSize &&
      !/\s$/.test(fullText) &&
      !/^\s/.test(it.str)

    if (gap >= 2.0 * fontSize && curSeg.trim() && it.str.trim()) {
      segments.push(curSeg.trim())
      curSeg = it.str
    } else {
      curSeg += (needsSpace ? ' ' : '') + it.str
    }

    fullText += (needsSpace ? ' ' : '') + it.str
    prevEnd = Math.max(prevEnd, it.x + it.width)
  }
  if (curSeg.trim()) segments.push(curSeg.trim())

  const text = fullText.trim()
  if (!text) return null

  return {
    text,
    segments,
    y: ySum / totalChars,
    fontSize,
    isMonospace: totalChars > 0 && monoChars / totalChars > 0.5
  }
}

/**
 * 通过字符加权众数估算全文正文基准字号。
 * @param {Array<Array<object>>} pageLines
 * @returns {number}
 */
function estimateBodyFontSize (pageLines) {
  const hist = new Map()
  for (const lines of pageLines) {
    for (const line of lines) {
      const weight = line.text.replace(/\s+/g, '').length
      if (!weight) continue
      const bucket = Math.round(line.fontSize * 2) / 2
      hist.set(bucket, (hist.get(bucket) || 0) + weight)
    }
  }
  let bestSize = 12
  let bestWeight = -1
  for (const [sz, w] of hist) {
    if (w > bestWeight || (w === bestWeight && sz < bestSize)) {
      bestWeight = w
      bestSize = sz
    }
  }
  return bestSize > 0 ? bestSize : 12
}

/**
 * 判断单行类别（代码块 / 标题 / 列表 / 普通文本）。
 * @param {object} line
 * @param {number} bodyFs
 * @returns {{kind:string, level?:number, text:string}}
 */
function classifyLine (line, bodyFs) {
  const text = line.text
  if (line.isMonospace) {
    return { kind: 'code', text }
  }

  // 标题：字号显著大于正文，长度受控，且非多列切分行
  if (line.segments.length <= 1 && text.length <= 120 && bodyFs > 0) {
    const ratio = line.fontSize / bodyFs
    if (ratio >= 1.6) return { kind: 'heading', level: 1, text }
    if (ratio >= 1.35) return { kind: 'heading', level: 2, text }
    if (ratio >= 1.15) return { kind: 'heading', level: 3, text }
  }

  // 无序列表
  const bullet = text.match(/^(?:[•●▪◦]\s*|[-*·]\s+)(.+)$/)
  if (bullet) {
    return { kind: 'list', text: '- ' + bullet[1].trim() }
  }

  // 有序列表
  const ordered = text.match(/^(?:(\d+)[.)]|\((\d+)\))\s+(.+)$/)
  if (ordered) {
    const num = ordered[1] || ordered[2]
    return { kind: 'list', text: num + '. ' + ordered[3].trim() }
  }

  return { kind: 'text', text }
}

/**
 * 合并两行段落文本（处理英文行尾连字符与中日韩字符拼接）。
 * @param {string} prevText
 * @param {string} nextText
 * @returns {string}
 */
function joinParagraphLines (prevText, nextText) {
  if (/[A-Za-z]-$/.test(prevText) && /^[a-z]/.test(nextText)) {
    return prevText.slice(0, -1) + nextText
  }
  const lastChar = prevText.slice(-1)
  const firstChar = nextText.slice(0, 1)
  if (CJK_CHAR_RE.test(lastChar) && CJK_CHAR_RE.test(firstChar)) {
    return prevText + nextText
  }
  return prevText + ' ' + nextText
}

/**
 * 渲染 GFM 表格块。
 * @param {Array<Array<string>>} rows
 * @returns {string}
 */
function formatTable (rows) {
  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|')
  const header = rows[0]
  const lines = [
    '| ' + header.map(esc).join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |'
  ]
  for (let i = 1; i < rows.length; i++) {
    lines.push('| ' + rows[i].map(esc).join(' | ') + ' |')
  }
  return lines.join('\n')
}

/**
 * 将单页视觉行转换为 Markdown 文本。
 * @param {Array<object>} lines
 * @param {number} bodyFs
 * @returns {string}
 */
function convertPageLines (lines, bodyFs) {
  if (!lines.length) return ''

  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 保守表格识别：连续 ≥2 行均含 ≥2 个大间距分栏且列数一致（排除悬挂缩进列表项）
    const isListIndent = line.segments.length >= 2 &&
      /^(?:[•●▪◦\-*]|\d+[.)]|\(\d+\))$/.test(line.segments[0])
    if (line.segments.length >= 2 && !line.isMonospace && !isListIndent) {
      const cols = line.segments.length
      let j = i + 1
      while (j < lines.length &&
             !lines[j].isMonospace &&
             lines[j].segments.length === cols &&
             !/^(?:[•●▪◦\-*]|\d+[.)]|\(\d+\))$/.test(lines[j].segments[0])) {
        const gap = Math.abs(lines[j - 1].y - lines[j].y)
        const lh = Math.max(lines[j - 1].fontSize, lines[j].fontSize)
        if (gap > 2.5 * lh) break
        j++
      }
      if (j - i >= 2) {
        const rows = lines.slice(i, j).map(l => l.segments)
        blocks.push({ kind: 'table', text: formatTable(rows) })
        i = j
        continue
      }
    }

    const cls = classifyLine(line, bodyFs)

    if (cls.kind === 'code') {
      const codeLines = [cls.text]
      let j = i + 1
      while (j < lines.length && lines[j].isMonospace) {
        codeLines.push(lines[j].text)
        j++
      }
      blocks.push({ kind: 'code', text: '```\n' + codeLines.join('\n') + '\n```' })
      i = j
      continue
    }

    if (cls.kind === 'heading') {
      blocks.push({ kind: 'heading', text: '#'.repeat(cls.level) + ' ' + cls.text })
      i++
      continue
    }

    if (cls.kind === 'list') {
      const listLines = [cls.text]
      let j = i + 1
      while (j < lines.length) {
        const nextLine = lines[j]
        if (nextLine.segments.length >= 2 && j + 1 < lines.length &&
            lines[j + 1].segments.length === nextLine.segments.length) {
          break
        }
        const nextCls = classifyLine(nextLine, bodyFs)
        if (nextCls.kind !== 'list') break
        const gap = Math.abs(lines[j - 1].y - nextLine.y)
        const lh = Math.max(lines[j - 1].fontSize, nextLine.fontSize)
        if (gap > 1.8 * lh) break
        listLines.push(nextCls.text)
        j++
      }
      blocks.push({ kind: 'list', text: listLines.join('\n') })
      i = j
      continue
    }

    // 普通段落：同一段落内的换行合并
    let para = cls.text
    let j = i + 1
    while (j < lines.length) {
      const prev = lines[j - 1]
      const next = lines[j]
      if (next.segments.length >= 2 && j + 1 < lines.length &&
          lines[j + 1].segments.length === next.segments.length) {
        break
      }
      const nextCls = classifyLine(next, bodyFs)
      if (nextCls.kind !== 'text') break
      const gap = Math.abs(prev.y - next.y)
      const lh = Math.max(prev.fontSize, next.fontSize)
      if (gap > 1.6 * lh) break
      para = joinParagraphLines(para, nextCls.text)
      j++
    }
    blocks.push({ kind: 'paragraph', text: para })
    i = j
  }

  return blocks.map(b => b.text).join('\n\n')
}

/**
 * 将结构化 PDF 页面转换为 Markdown。
 *
 * @param {{pages?:Array<object>}|Array<object>} input
 * @returns {{markdown:string, isEmpty:boolean}}
 */
function pdfToMarkdown (input) {
  const pages = Array.isArray(input)
    ? input
    : (input && Array.isArray(input.pages) ? input.pages : [])

  const pageLines = pages.map(p => groupLines(p && p.items))
  const bodyFs = estimateBodyFontSize(pageLines)
  const parts = []
  for (const lines of pageLines) {
    const md = convertPageLines(lines, bodyFs)
    if (md && md.trim()) parts.push(md)
  }
  const markdown = parts.join('\n\n')
  return { markdown, isEmpty: !markdown.trim() }
}

module.exports = {
  pdfToMarkdown,
  groupLines,
  estimateBodyFontSize,
  classifyLine,
  joinParagraphLines
}
