'use strict'

/**
 * 便签 Markdown + LaTeX 解析、双向转换、消毒与粘贴检测引擎（双环境 UMD）。
 * 同时支持浏览器渲染进程（window.StickyMarkdown）与 Node 测试/主进程（CommonJS require）。
 *
 * 职责：
 *  1. 严格隔离 Markdown 与 LaTeX（代码块/多反引号行内代码保护、$...$ 边界防金额误判）
 *  2. Markdown -> 安全规范 HTML（GFM 全语法 + Mermaid + KaTeX 骨架 + 外链图片拦截）
 *  3. HTML -> 无损 Markdown（保留下划线、文字颜色、Mermaid、LaTeX 定界符、表格、任务列表、附件）
 *  4. 纯文本粘贴 Markdown/LaTeX 自动识别（高精确度防误判：金额、snake_case、JSON、Windows 路径、日期）
 *  5. 选区干净提取（避免 KaTeX MathML+HTML 复制/划词出现重复三份文本）
 */
;(function (root, factory) {
  const api = factory(root)
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api
  } else if (root) {
    root.StickyMarkdown = api
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const DEFAULT_COLOR_RE = /^(?:#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i
  const ALLOWED_TAGS = new Set([
    'P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
    'A', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
    'CODE', 'PRE', 'INPUT', 'IMG', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'FONT'
  ])
  const DROP_CONTENT_TAGS = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA'
  ])

  function escapeHtml (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }

  function resolveMarked (opts) {
    if (opts && opts.marked) return opts.marked
    if (typeof window !== 'undefined' && window.marked) return window.marked
    if (root && root.marked) return root.marked
    if (typeof require === 'function') {
      try {
        const m = require('marked')
        return (m && (m.marked || m.default)) || m
      } catch (_) {}
    }
    return null
  }

  function resolveTurndown (opts) {
    let TurndownService = (opts && opts.TurndownService) ||
      (typeof window !== 'undefined' && window.TurndownService) ||
      (root && root.TurndownService) || null
    let gfmPlugin = (opts && opts.turndownPluginGfm) ||
      (typeof window !== 'undefined' && window.turndownPluginGfm) ||
      (root && root.turndownPluginGfm) || null

    if (!TurndownService && typeof require === 'function') {
      try { TurndownService = require('turndown') } catch (_) {}
    }
    if (!gfmPlugin && typeof require === 'function') {
      try { gfmPlugin = require('turndown-plugin-gfm') } catch (_) {}
    }
    return { TurndownService, gfmPlugin }
  }

  function resolveKatex (opts) {
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'katex')) return opts.katex
    if (typeof window !== 'undefined' && window.katex) return window.katex
    if (root && root.katex) return root.katex
    if (typeof require === 'function') {
      try { return require('katex') } catch (_) {}
    }
    return null
  }

  function parseHtmlDocument (html, opts) {
    if (opts && typeof opts.parseHtml === 'function') return opts.parseHtml(html)
    if (typeof DOMParser !== 'undefined') {
      return new DOMParser().parseFromString(String(html || ''), 'text/html')
    }
    if (typeof require === 'function') {
      try {
        const domino = require('@mixmark-io/domino')
        return domino.createDocument(String(html || ''))
      } catch (_) {}
    }
    return null
  }

  function makePlaceholderPrefix (text) {
    let prefix = 'STKMDTOK'
    while (text.includes(prefix)) prefix += 'X'
    return prefix
  }

  function countQuoteMarkers (prefix) {
    let count = 0
    for (let i = 0; i < prefix.length; i++) {
      if (prefix[i] === '>') count++
    }
    return count
  }

  function stripQuotePrefix (line, depth) {
    if (!depth) return line
    let s = line
    for (let d = 0; d < depth; d++) {
      const m = s.match(/^[ \t]*>[ \t]?/)
      if (!m) break
      s = s.slice(m[0].length)
    }
    return s
  }

  /**
   * 在进入 marked 解析前保护所有 LaTeX 公式（行内/块级）与转义 \$，
   * 同时严格跳过围栏代码块（```/~~~）与多反引号行内代码（`...` / ``...``）。
   */
  function protectMathAndCode (rawInput) {
    const src = String(rawInput == null ? '' : rawInput).replace(/\r\n?/g, '\n')
    const prefix = makePlaceholderPrefix(src)
    const tokens = []

    const stashMath = (tex, displayMode, delim) => {
      const idx = tokens.length
      tokens.push({ kind: 'math', tex: String(tex == null ? '' : tex), displayMode: !!displayMode, delim: delim || (displayMode ? '$$' : '$') })
      return prefix + 'M' + idx + 'END'
    }
    const stashLiteral = (text) => {
      const idx = tokens.length
      tokens.push({ kind: 'literal', text })
      return prefix + 'L' + idx + 'END'
    }

    function protectInline (line) {
      let out = ''
      let j = 0
      const len = line.length
      while (j < len) {
        const ch = line[j]
        // 1. 多反引号/单反引号行内代码原样跳过
        if (ch === '`') {
          let tickLen = 1
          while (j + tickLen < len && line[j + tickLen] === '`') tickLen++
          let k = j + tickLen
          let matchedClose = -1
          while (k < len) {
            if (line[k] === '`') {
              let run = 1
              while (k + run < len && line[k + run] === '`') run++
              if (run === tickLen) {
                matchedClose = k
                break
              }
              k += run
            } else {
              k++
            }
          }
          if (matchedClose >= 0) {
            out += line.slice(j, matchedClose + tickLen)
            j = matchedClose + tickLen
          } else {
            out += line.slice(j, j + tickLen)
            j += tickLen
          }
          continue
        }

        // 2. 转义字符、\$、\(...\)、\[...\]
        if (ch === '\\' && j + 1 < len) {
          const next = line[j + 1]
          if (next === '\\') {
            out += '\\\\'
            j += 2
            continue
          }
          if (next === '$') {
            out += stashLiteral('$')
            j += 2
            continue
          }
          if (next === '(') {
            let k = j + 2
            let closeAt = -1
            while (k < len - 1) {
              if (line[k] === '\\') {
                if (line[k + 1] === ')') {
                  closeAt = k
                  break
                }
                k += 2
                continue
              }
              k++
            }
            if (closeAt > j + 2 && line.slice(j + 2, closeAt).trim().length > 0) {
              out += stashMath(line.slice(j + 2, closeAt), false, '\\(')
              j = closeAt + 2
              continue
            }
            out += '\\('
            j += 2
            continue
          }
          if (next === '[') {
            let k = j + 2
            let closeAt = -1
            while (k < len - 1) {
              if (line[k] === '\\') {
                if (line[k + 1] === ']') {
                  closeAt = k
                  break
                }
                k += 2
                continue
              }
              k++
            }
            if (closeAt > j + 2 && line.slice(j + 2, closeAt).trim().length > 0) {
              out += stashMath(line.slice(j + 2, closeAt), true, '\\[')
              j = closeAt + 2
              continue
            }
            out += '\\['
            j += 2
            continue
          }
          out += line.slice(j, j + 2)
          j += 2
          continue
        }

        // 3. $...$ 或行内 $$...$$
        if (ch === '$') {
          if (j + 1 < len && line[j + 1] === '$') {
            let k = j + 2
            let closeAt = -1
            while (k < len - 1) {
              if (line[k] === '\\' && k + 1 < len) {
                k += 2
                continue
              }
              if (line[k] === '$' && line[k + 1] === '$') {
                closeAt = k
                break
              }
              k++
            }
            if (closeAt > j + 2 && line.slice(j + 2, closeAt).trim().length > 0) {
              out += stashMath(line.slice(j + 2, closeAt), true, '$$')
              j = closeAt + 2
              continue
            }
            out += '$$'
            j += 2
            continue
          }

          const before = j > 0 ? line[j - 1] : ''
          const afterOpen = j + 1 < len ? line[j + 1] : ''
          if (!afterOpen || afterOpen === '$' || /\s/.test(afterOpen) || (before && /[0-9]/.test(before))) {
            out += '$'
            j++
            continue
          }

          let k = j + 1
          let matchedEnd = -1
          while (k < len) {
            const c = line[k]
            if (c === '\\' && k + 1 < len) {
              k += 2
              continue
            }
            if (c === '$') {
              const prev = line[k - 1]
              const next = k + 1 < len ? line[k + 1] : ''
              if (k > j + 1 && !/\s/.test(prev) && !(next && /[0-9]/.test(next))) {
                matchedEnd = k
                break
              }
              // 遇到非法闭合的裸 $（如 "$10 到 $20，公式 $E=mc^2$" 中的第二个 $）立即中止本轮候选，
              // 避免把金额与后续真正公式错误合并
              break
            }
            k++
          }
          if (matchedEnd > j + 1 && line.slice(j + 1, matchedEnd).trim().length > 0) {
            out += stashMath(line.slice(j + 1, matchedEnd), false, '$')
            j = matchedEnd + 1
            continue
          }
          out += '$'
          j++
          continue
        }

        out += ch
        j++
      }
      return out
    }

    function findUnescapedClose (line, delim) {
      let i = 0
      while (i <= line.length - delim.length) {
        if (line[i] === '\\' && i + 1 < line.length) {
          if (delim.startsWith('\\') && line.slice(i, i + delim.length) === delim) {
            return i
          }
          i += 2
          continue
        }
        if (line.slice(i, i + delim.length) === delim) return i
        i++
      }
      return -1
    }

    const lines = src.split('\n')
    const outLines = []
    let idx = 0
    let inCodeFence = null
    let prevBlank = true
    let inList = false

    while (idx < lines.length) {
      const line = lines[idx]

      if (inCodeFence) {
        outLines.push(line)
        const stripped = stripQuotePrefix(line, inCodeFence.quoteDepth)
        const closeRe = new RegExp('^[ \\t]{0,3}' + inCodeFence.char + '{' + inCodeFence.len + ',}[ \\t]*$')
        if (closeRe.test(stripped)) {
          inCodeFence = null
        }
        idx++
        prevBlank = false
        continue
      }

      // 围栏代码块（包括 ```math / ```latex / ```mermaid / ```js 等）
      const fenceMatch = line.match(/^([ \t]*(?:>[ \t]*)*[ \t]{0,3})(`{3,}|~{3,})(.*)$/)
      if (fenceMatch) {
        const prefixStr = fenceMatch[1]
        const fence = fenceMatch[2]
        const info = fenceMatch[3] || ''
        const fenceChar = fence[0]
        if (!(fenceChar === '`' && info.includes('`'))) {
          const lang = info.trim().split(/\s+/)[0].toLowerCase()
          const qDepth = countQuoteMarkers(prefixStr)
          if (lang === 'math' || lang === 'latex') {
            const closeRe = new RegExp('^[ \\t]{0,3}' + fenceChar + '{' + fence.length + ',}[ \\t]*$')
            let k = idx + 1
            let foundClose = -1
            while (k < lines.length) {
              const s = stripQuotePrefix(lines[k], qDepth)
              if (closeRe.test(s)) {
                foundClose = k
                break
              }
              k++
            }
            if (foundClose >= 0) {
              const inner = lines.slice(idx + 1, foundClose)
                .map(l => stripQuotePrefix(l, qDepth))
                .join('\n')
                .replace(/^\n+|\n+$/g, '')
              const quotePrefix = qDepth > 0 ? prefixStr.replace(/[ \t]{0,3}$/, '') : ''
              outLines.push(quotePrefix + stashMath(inner, true, lang))
              idx = foundClose + 1
              prevBlank = false
              inList = false
              continue
            }
          }
          inCodeFence = { char: fenceChar, len: fence.length, quoteDepth: qDepth }
          outLines.push(line)
          idx++
          prevBlank = false
          inList = false
          continue
        }
      }

      // 4 空格或 Tab 缩进代码块（非列表延续时跳过其中的 $ 保护）
      if (prevBlank && !inList && /^(?: {4}|\t)/.test(line) && line.trim().length > 0) {
        while (idx < lines.length && (/^(?: {4}|\t)/.test(lines[idx]) || !lines[idx].trim())) {
          outLines.push(lines[idx])
          idx++
        }
        prevBlank = true
        continue
      }

      // 块级 $$...$$ 或 \[...\]
      const dmMatch = line.match(/^([ \t]*(?:>[ \t]*)*[ \t]{0,3})\$\$(.*)$/)
      if (dmMatch) {
        const prefixStr = dmMatch[1]
        const rest = dmMatch[2]
        const qDepth = countQuoteMarkers(prefixStr)
        const quotePrefix = qDepth > 0 ? prefixStr.replace(/[ \t]{0,3}$/, '') : ''
        const sameClose = findUnescapedClose(rest, '$$')
        if (sameClose >= 0 && !rest.slice(sameClose + 2).trim()) {
          const inner = rest.slice(0, sameClose).trim()
          if (inner) {
            outLines.push(quotePrefix + stashMath(inner, true, '$$'))
            idx++
            prevBlank = false
            continue
          }
        } else if (sameClose < 0) {
          let k = idx + 1
          let foundClose = -1
          let closePos = -1
          while (k < lines.length) {
            const stripped = stripQuotePrefix(lines[k], qDepth)
            if (/^[ \t]{0,3}(?:`{3,}|~{3,})/.test(stripped)) break
            const pos = findUnescapedClose(stripped, '$$')
            if (pos >= 0) {
              foundClose = k
              closePos = pos
              break
            }
            k++
          }
          if (foundClose >= 0) {
            const body = []
            if (rest.trim()) body.push(rest)
            for (let m = idx + 1; m < foundClose; m++) {
              body.push(stripQuotePrefix(lines[m], qDepth))
            }
            const lastStripped = stripQuotePrefix(lines[foundClose], qDepth)
            const beforeClose = lastStripped.slice(0, closePos)
            if (beforeClose.trim()) body.push(beforeClose)
            const afterClose = lastStripped.slice(closePos + 2).trim()
            const tex = body.join('\n').replace(/^\n+|\n+$/g, '')
            outLines.push(quotePrefix + stashMath(tex, true, '$$') + (afterClose ? ' ' + protectInline(afterClose) : ''))
            idx = foundClose + 1
            prevBlank = false
            continue
          }
        }
      }

      const bmMatch = line.match(/^([ \t]*(?:>[ \t]*)*[ \t]{0,3})\\\[(.*)$/)
      if (bmMatch) {
        const prefixStr = bmMatch[1]
        const rest = bmMatch[2]
        const qDepth = countQuoteMarkers(prefixStr)
        const quotePrefix = qDepth > 0 ? prefixStr.replace(/[ \t]{0,3}$/, '') : ''
        const sameClose = findUnescapedClose(rest, '\\]')
        if (sameClose >= 0 && !rest.slice(sameClose + 2).trim()) {
          const inner = rest.slice(0, sameClose).trim()
          if (inner) {
            outLines.push(quotePrefix + stashMath(inner, true, '\\['))
            idx++
            prevBlank = false
            continue
          }
        } else if (sameClose < 0) {
          let k = idx + 1
          let foundClose = -1
          let closePos = -1
          while (k < lines.length) {
            const stripped = stripQuotePrefix(lines[k], qDepth)
            if (/^[ \t]{0,3}(?:`{3,}|~{3,})/.test(stripped)) break
            const pos = findUnescapedClose(stripped, '\\]')
            if (pos >= 0) {
              foundClose = k
              closePos = pos
              break
            }
            k++
          }
          if (foundClose >= 0) {
            const body = []
            if (rest.trim()) body.push(rest)
            for (let m = idx + 1; m < foundClose; m++) {
              body.push(stripQuotePrefix(lines[m], qDepth))
            }
            const lastStripped = stripQuotePrefix(lines[foundClose], qDepth)
            const beforeClose = lastStripped.slice(0, closePos)
            if (beforeClose.trim()) body.push(beforeClose)
            const afterClose = lastStripped.slice(closePos + 2).trim()
            const tex = body.join('\n').replace(/^\n+|\n+$/g, '')
            outLines.push(quotePrefix + stashMath(tex, true, '\\[') + (afterClose ? ' ' + protectInline(afterClose) : ''))
            idx = foundClose + 1
            prevBlank = false
            continue
          }
        }
      }

      const isBlank = !line.trim()
      if (!isBlank) {
        if (/^[ \t]*(?:>[ \t]*)*[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/.test(line)) {
          inList = true
        } else if (prevBlank && !/^[ \t]{2,}/.test(line)) {
          inList = false
        }
      }
      prevBlank = isBlank
      outLines.push(isBlank ? '' : protectInline(line))
      idx++
    }

    return {
      markdown: outLines.join('\n'),
      prefix,
      tokens
    }
  }

  function buildMathNode (doc, tex, displayMode, delim) {
    const el = doc.createElement(displayMode ? 'div' : 'span')
    el.className = displayMode ? 'math-block' : 'math-inline'
    el.setAttribute('contenteditable', 'false')
    el.setAttribute('data-tex', tex)
    el.setAttribute('data-delim', delim || (displayMode ? '$$' : '$'))
    const body = doc.createElement(displayMode ? 'div' : 'span')
    body.className = 'math-body'
    el.appendChild(body)
    return el
  }

  function buildMermaidNode (doc, code) {
    const wrap = doc.createElement('div')
    wrap.className = 'mmd'
    wrap.setAttribute('contenteditable', 'false')
    wrap.setAttribute('data-code', code)
    wrap.setAttribute('data-block-id', 'b' + Math.random().toString(36).slice(2, 10))
    const tools = doc.createElement('div')
    tools.className = 'mmd-tools'
    for (const [act, title, glyph] of [['edit', '编辑代码', '✎'], ['board', '在画板中编辑', '▦'], ['del', '删除图表', '✕']]) {
      const btn = doc.createElement('button')
      btn.type = 'button'
      btn.setAttribute('data-mmd', act)
      btn.setAttribute('title', title)
      btn.textContent = glyph
      tools.appendChild(btn)
    }
    const body = doc.createElement('div')
    body.className = 'mmd-body'
    wrap.appendChild(tools)
    wrap.appendChild(body)
    return wrap
  }

  function sanitizeSpanStyle (rawStyle) {
    if (!rawStyle) return ''
    const parts = String(rawStyle).split(';')
    const safe = []
    for (const part of parts) {
      const colon = part.indexOf(':')
      if (colon < 0) continue
      const prop = part.slice(0, colon).trim().toLowerCase()
      const val = part.slice(colon + 1).trim()
      if (!val) continue
      if (prop === 'color' && DEFAULT_COLOR_RE.test(val)) {
        safe.push('color:' + val)
      } else if (prop === 'text-decoration' && /^(?:underline|line-through)$/i.test(val)) {
        safe.push('text-decoration:' + val.toLowerCase())
      } else if (prop === 'white-space' && /^(?:break-spaces|pre-wrap)$/i.test(val)) {
        safe.push('white-space:' + val.toLowerCase())
      }
    }
    return safe.join(';')
  }

  function sanitizeCellStyle (rawStyle) {
    if (!rawStyle) return ''
    const m = String(rawStyle).match(/text-align\s*:\s*(left|center|right)/i)
    return m ? 'text-align:' + m[1].toLowerCase() : ''
  }

  function isSafeImgSrc (src) {
    return /^(?:data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,|blob:|sticky-att:\/\/)/i.test(String(src || '').trim())
  }

  /**
   * 严格消毒 HTML（支持粘贴、Markdown 渲染与内部安全节点重建）：
   * - 移除 script/style/iframe/svg/math 等高危标签及其内部文本
   * - 拦截 http(s):// 外链图片，降级为纯链接/文本，杜绝 CSP 违规弹窗
   * - 过滤 on* 事件、javascript:/file: 链接、危险 style
   */
  function sanitizeDomTree (rootNode, doc, opts = {}) {
    const allowAttachments = !!opts.allowAttachments
    const allowTrustNodes = !!opts.allowTrustNodes
    const upgradeMermaidCode = opts.upgradeMermaidCode !== false

    function walk (parent) {
      const children = Array.from(parent.childNodes || [])
      for (const child of children) {
        if (child.nodeType === 8) { child.remove(); continue } // COMMENT
        if (child.nodeType === 3) continue
        if (child.nodeType !== 1) { child.remove(); continue }

        const tag = String(child.tagName || '').toUpperCase()
        if (DROP_CONTENT_TAGS.has(tag)) {
          child.remove()
          continue
        }

        // 受信任结构重建（只保留 data-* 源码，清空所有子节点防 XSS）
        if (allowTrustNodes && child.classList) {
          if (child.classList.contains('mmd') && child.hasAttribute('data-code')) {
            const rebuilt = buildMermaidNode(doc, child.getAttribute('data-code') || '')
            if (child.getAttribute('data-block-id')) {
              rebuilt.setAttribute('data-block-id', child.getAttribute('data-block-id'))
            }
            child.replaceWith(rebuilt)
            continue
          }
          if ((child.classList.contains('math-inline') || child.classList.contains('math-block')) && child.hasAttribute('data-tex')) {
            const isBlock = child.classList.contains('math-block')
            const rebuilt = buildMathNode(doc, child.getAttribute('data-tex') || '', isBlock, child.getAttribute('data-delim') || (isBlock ? '$$' : '$'))
            child.replaceWith(rebuilt)
            continue
          }
          if (allowAttachments && child.classList.contains('attachment') && child.hasAttribute('data-path')) {
            const p = doc.createElement('p')
            p.className = 'attachment'
            p.setAttribute('data-attachment', child.getAttribute('data-attachment') || '附件')
            p.setAttribute('data-path', child.getAttribute('data-path') || '')
            p.textContent = child.textContent || ('📎 ' + (child.getAttribute('data-attachment') || '附件'))
            child.replaceWith(p)
            continue
          }
        }

        if (upgradeMermaidCode && tag === 'PRE') {
          const codeEl = child.querySelector && child.querySelector('code.language-mermaid')
          if (codeEl) {
            const block = buildMermaidNode(doc, (codeEl.textContent || '').replace(/\n$/, ''))
            child.replaceWith(block)
            continue
          }
        }

        walk(child)

        if (!ALLOWED_TAGS.has(tag)) {
          while (child.firstChild) parent.insertBefore(child.firstChild, child)
          child.remove()
          continue
        }

        if (tag === 'INPUT') {
          const t = String(child.getAttribute('type') || '').toLowerCase()
          if (t !== 'checkbox') {
            child.remove()
            continue
          }
          const isChecked = child.hasAttribute('checked') || !!child.checked
          for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name)
          child.setAttribute('type', 'checkbox')
          child.setAttribute('contenteditable', 'false')
          if (isChecked) child.setAttribute('checked', '')
          if (parent && String(parent.tagName || '').toUpperCase() === 'LI') {
            parent.setAttribute('data-task', '1')
          }
          continue
        }

        if (tag === 'IMG') {
          const rawSrc = (child.getAttribute('src') || '').trim()
          const alt = (child.getAttribute('alt') || '').trim()
          if (isSafeImgSrc(rawSrc)) {
            for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name)
            child.setAttribute('src', rawSrc)
            if (alt) child.setAttribute('alt', alt)
          } else if (/^https?:\/\//i.test(rawSrc)) {
            const a = doc.createElement('a')
            a.setAttribute('href', rawSrc)
            a.setAttribute('target', '_blank')
            a.setAttribute('rel', 'noreferrer')
            a.textContent = alt ? `[图片: ${alt}]` : `[外部图片: ${rawSrc}]`
            child.replaceWith(a)
          } else {
            if (alt) child.replaceWith(doc.createTextNode(alt))
            else child.remove()
          }
          continue
        }

        if (tag === 'A') {
          const href = (child.getAttribute('href') || '').trim()
          if (!/^https?:\/\//i.test(href)) {
            while (child.firstChild) parent.insertBefore(child.firstChild, child)
            child.remove()
            continue
          }
          for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name)
          child.setAttribute('href', href)
          child.setAttribute('target', '_blank')
          child.setAttribute('rel', 'noreferrer')
          continue
        }

        if (tag === 'CODE') {
          const cls = child.getAttribute('class') || ''
          const langM = cls.match(/\blanguage-([a-z0-9_+-]+)\b/i)
          for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name)
          if (langM) child.setAttribute('class', 'language-' + langM[1].toLowerCase())
          continue
        }

        if (tag === 'SPAN') {
          const safeStyle = sanitizeSpanStyle(child.getAttribute('style'))
          for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name)
          if (safeStyle) child.setAttribute('style', safeStyle)
          continue
        }

        if (tag === 'FONT') {
          const col = (child.getAttribute('color') || '').trim()
          for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name)
          if (DEFAULT_COLOR_RE.test(col)) child.setAttribute('color', col)
          continue
        }

        if (tag === 'TD' || tag === 'TH') {
          const align = (child.getAttribute('align') || '').trim().toLowerCase()
          const safeStyle = sanitizeCellStyle(child.getAttribute('style'))
          for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name)
          if (/^(left|center|right)$/.test(align)) child.setAttribute('align', align)
          if (safeStyle) child.setAttribute('style', safeStyle)
          continue
        }

        if (tag === 'OL') {
          const start = child.getAttribute('start')
          for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name)
          if (start && /^\d+$/.test(start) && start !== '1') child.setAttribute('start', start)
          continue
        }

        if (tag === 'LI') {
          const isTask = child.hasAttribute('data-task') ||
            Array.from(child.children || []).some(c => String(c.tagName || '').toUpperCase() === 'INPUT' && String(c.getAttribute('type') || '').toLowerCase() === 'checkbox')
          for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name)
          if (isTask) child.setAttribute('data-task', '1')
          continue
        }

        for (const attr of Array.from(child.attributes)) {
          child.removeAttribute(attr.name)
        }
      }
    }

    walk(rootNode)
  }

  /**
   * 把占位符文本节点还原成 .math-inline / .math-block / 文本，并拆开被 <p> 包裹的块级公式。
   */
  function restoreTokensInDom (rootNode, doc, protectedInfo) {
    const { prefix, tokens } = protectedInfo
    if (!tokens.length) return

    const re = new RegExp(prefix + '(M|L)(\\d+)END', 'g')
    const walkText = (node) => {
      const children = Array.from(node.childNodes || [])
      for (const child of children) {
        if (child.nodeType === 3) {
          const val = child.nodeValue || ''
          if (!val.includes(prefix)) continue
          re.lastIndex = 0
          let lastIdx = 0
          let m
          const frag = doc.createDocumentFragment()
          while ((m = re.exec(val)) !== null) {
            if (m.index > lastIdx) {
              frag.appendChild(doc.createTextNode(val.slice(lastIdx, m.index)))
            }
            const tok = tokens[Number(m[2])]
            if (tok) {
              if (tok.kind === 'literal') {
                frag.appendChild(doc.createTextNode(tok.text))
              } else {
                frag.appendChild(buildMathNode(doc, tok.tex, tok.displayMode, tok.delim))
              }
            }
            lastIdx = m.index + m[0].length
          }
          if (lastIdx < val.length) {
            frag.appendChild(doc.createTextNode(val.slice(lastIdx)))
          }
          child.replaceWith(frag)
        } else if (child.nodeType === 1) {
          walkText(child)
        }
      }
    }
    walkText(rootNode)

    // 拆开 <p> 内的块级 .math-block（避免 <p><div></div></p> 非法嵌套）
    const blocks = Array.from(rootNode.querySelectorAll('.math-block'))
    for (const blk of blocks) {
      const p = blk.parentElement
      if (!p || String(p.tagName || '').toUpperCase() !== 'P') continue
      const siblings = Array.from(p.childNodes)
      const idx = siblings.indexOf(blk)
      if (idx < 0) continue
      const before = siblings.slice(0, idx)
      const after = siblings.slice(idx + 1)
      const hasMeaningful = (arr) => arr.some(n => (n.nodeType === 3 ? n.nodeValue.trim() !== '' : n.nodeType === 1))
      const parent = p.parentNode
      if (!parent) continue
      if (hasMeaningful(before)) {
        const pBefore = doc.createElement('p')
        before.forEach(n => pBefore.appendChild(n))
        parent.insertBefore(pBefore, p)
      }
      parent.insertBefore(blk, p)
      if (hasMeaningful(after)) {
        const pAfter = doc.createElement('p')
        after.forEach(n => pAfter.appendChild(n))
        parent.insertBefore(pAfter, p)
      }
      p.remove()
    }
  }

  function sanitizeHtml (dirtyHtml, opts = {}) {
    const doc = parseHtmlDocument(String(dirtyHtml || ''), opts)
    if (!doc || !doc.body) return ''
    sanitizeDomTree(doc.body, doc, opts)
    return doc.body.innerHTML
  }

  /**
   * 把 Markdown 字符串解析为经过消毒的规范 HTML 骨架（不含 KaTeX / Mermaid 渲染产物）。
   * @param {string} md
   * @param {object} [opts]
   * @returns {string}
   */
  function parseNoteMarkdown (md, opts = {}) {
    const marked = resolveMarked(opts)
    if (!marked || typeof marked.parse !== 'function') {
      return '<p>' + escapeHtml(md).replace(/\n/g, '<br>') + '</p>'
    }
    const protectedInfo = protectMathAndCode(md)
    const rawHtml = marked.parse(protectedInfo.markdown, {
      gfm: true,
      breaks: opts.breaks !== false
    })
    const doc = parseHtmlDocument(rawHtml, opts)
    if (!doc || !doc.body) return String(rawHtml || '')
    // 1. 先按白名单清洗（此时 math 仍是安全文本占位符，p.attachment/span/u 放行）
    sanitizeDomTree(doc.body, doc, {
      allowAttachments: opts.allowAttachments !== false,
      allowTrustNodes: !!opts.allowTrustNodes,
      upgradeMermaidCode: opts.upgradeMermaidCode !== false
    })
    // 2. 再把占位符安全重建为 .math-inline / .math-block 骨架
    restoreTokensInDom(doc.body, doc, protectedInfo)
    return doc.body.innerHTML
  }

  /**
   * 一次解析同时产出规范 HTML 与快照统计对象（避免二次 DOMParser）。
   */
  function parseNoteMarkdownSnapshot (md, domSnapshotLib, opts = {}) {
    const marked = resolveMarked(opts)
    if (!marked || typeof marked.parse !== 'function') {
      const html = '<p>' + escapeHtml(md).replace(/\n/g, '<br>') + '</p>'
      return {
        html,
        text: String(md || '').replace(/\s+/g, ' ').trim(),
        imgCount: 0,
        mmdCount: 0,
        mathCount: 0
      }
    }
    const protectedInfo = protectMathAndCode(md)
    const rawHtml = marked.parse(protectedInfo.markdown, {
      gfm: true,
      breaks: opts.breaks !== false
    })
    const doc = parseHtmlDocument(rawHtml, opts)
    if (!doc || !doc.body) {
      const html = String(rawHtml || '')
      return { html, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), imgCount: 0, mmdCount: 0, mathCount: 0 }
    }
    sanitizeDomTree(doc.body, doc, {
      allowAttachments: opts.allowAttachments !== false,
      allowTrustNodes: !!opts.allowTrustNodes,
      upgradeMermaidCode: opts.upgradeMermaidCode !== false
    })
    restoreTokensInDom(doc.body, doc, protectedInfo)
    const html = doc.body.innerHTML
    const text = (domSnapshotLib && typeof domSnapshotLib.textFromRoot === 'function')
      ? domSnapshotLib.textFromRoot(doc.body)
      : (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
    return {
      html,
      text,
      imgCount: doc.body.querySelectorAll('img').length,
      mmdCount: doc.body.querySelectorAll('.mmd').length,
      mathCount: doc.body.querySelectorAll('.math-inline, .math-block').length
    }
  }

  function parseNoteMarkdownInline (md, opts = {}) {
    const marked = resolveMarked(opts)
    if (!marked || typeof marked.parseInline !== 'function') {
      return parseNoteMarkdown(md, opts)
    }
    const protectedInfo = protectMathAndCode(md)
    const rawHtml = marked.parseInline(protectedInfo.markdown, {
      gfm: true,
      breaks: opts.breaks !== false
    })
    const doc = parseHtmlDocument(rawHtml, opts)
    if (!doc || !doc.body) return String(rawHtml || '')
    sanitizeDomTree(doc.body, doc, {
      allowAttachments: false,
      allowTrustNodes: false,
      upgradeMermaidCode: false
    })
    restoreTokensInDom(doc.body, doc, protectedInfo)
    return doc.body.innerHTML
  }

  /**
   * 供 Node 主进程导入 .md 时使用（无须依赖 Domino）：
   * 先保护 LaTeX -> marked.parse -> 把占位符替换为纯骨架 HTML 串（随后由 search.html 的 DOMParser 清洗）。
   */
  function parseMarkdownToRawHtmlWithMath (md, markedLib, opts = {}) {
    const marked = markedLib || resolveMarked(opts)
    if (!marked || typeof marked.parse !== 'function') {
      return '<p>' + escapeHtml(md).replace(/\n/g, '<br>') + '</p>'
    }
    const protectedInfo = protectMathAndCode(md)
    let html = String(marked.parse(protectedInfo.markdown, {
      gfm: true,
      breaks: opts.breaks !== false
    }) || '')

    if (protectedInfo.tokens.length) {
      const re = new RegExp(protectedInfo.prefix + '(M|L)(\\d+)END', 'g')
      html = html.replace(re, (_m, _kind, idxStr) => {
        const tok = protectedInfo.tokens[Number(idxStr)]
        if (!tok) return ''
        if (tok.kind === 'literal') return escapeHtml(tok.text)
        if (tok.displayMode) {
          return `<div class="math-block" contenteditable="false" data-tex="${escapeHtml(tok.tex)}" data-delim="${escapeHtml(tok.delim)}"><div class="math-body"></div></div>`
        }
        return `<span class="math-inline" contenteditable="false" data-tex="${escapeHtml(tok.tex)}" data-delim="${escapeHtml(tok.delim)}"><span class="math-body"></span></span>`
      })
      // 拆开孤立 <p><div class="math-block">...</div></p>
      html = html.replace(/<p>\s*(<div class="math-block"[\s\S]*?<\/div><\/div>)\s*<\/p>/g, '$1')
    }
    return html
  }

  /**
   * HTML / DOM -> 无损 Markdown（含下划线、字体颜色、Mermaid、LaTeX、表格、任务、附件）。
   */
  function htmlToNoteMarkdown (input, opts = {}) {
    if (input == null) return ''
    const { TurndownService } = resolveTurndown(opts)
    const rawHtml = typeof input === 'string' ? input : (input.innerHTML || '')
    if (!TurndownService) {
      return typeof input === 'string' ? input.replace(/<[^>]*>/g, '') : (input.textContent || '')
    }

    const doc = parseHtmlDocument(rawHtml, opts)
    const preserved = []
    let stashPrefix = 'STKTDN'
    while (rawHtml.includes(stashPrefix)) stashPrefix += 'X'
    const stashToken = (mdStr) => {
      const idx = preserved.length
      preserved.push(mdStr)
      return stashPrefix + 'T' + idx + 'END'
    }

    let cbSpaceSentinel = 'STKCBSP'
    while (rawHtml.includes(cbSpaceSentinel) || stashPrefix.includes(cbSpaceSentinel)) cbSpaceSentinel += 'X'
    let hasEmptyTaskCb = false
    if (doc && doc.body) {
      const replaceNode = (el, mdStr, isBlock) => {
        const tok = stashToken(mdStr)
        if (isBlock) {
          const p = doc.createElement('p')
          p.textContent = tok
          el.replaceWith(p)
        } else {
          el.replaceWith(doc.createTextNode(tok))
        }
      }
      for (const el of Array.from(doc.body.querySelectorAll('.mmd'))) {
        const code = (el.getAttribute('data-code') || '').replace(/\r\n?/g, '\n')
        replaceNode(el, '```mermaid\n' + code + '\n```', true)
      }
      for (const el of Array.from(doc.body.querySelectorAll('.math-block'))) {
        const tex = (el.getAttribute('data-tex') || '').replace(/\r\n?/g, '\n')
        const delim = el.getAttribute('data-delim') || '$$'
        let out
        if (delim === '\\[') out = '\\[\n' + tex + '\n\\]'
        else if (delim === 'math') out = '```math\n' + tex + '\n```'
        else if (delim === 'latex') out = '```latex\n' + tex + '\n```'
        else out = '$$\n' + tex + '\n$$'
        replaceNode(el, out, true)
      }
      for (const el of Array.from(doc.body.querySelectorAll('.math-inline'))) {
        const tex = el.getAttribute('data-tex') || ''
        const delim = el.getAttribute('data-delim') || '$'
        const out = delim === '\\(' ? '\\(' + tex + '\\)' : '$' + tex + '$'
        replaceNode(el, out, false)
      }
      for (const el of Array.from(doc.body.querySelectorAll('.attachment[data-path]'))) {
        const name = el.getAttribute('data-attachment') || '附件'
        const p = el.getAttribute('data-path') || ''
        const label = el.textContent || ('📎 ' + name)
        replaceNode(el, `<p class="attachment" data-attachment="${escapeHtml(name)}" data-path="${escapeHtml(p)}">${escapeHtml(label)}</p>`, true)
      }
      // 空任务列表项补尾随空格占位，避免 Turndown 裁剪尾部空格后丢失复选框语法
      for (const li of Array.from(doc.body.querySelectorAll('li'))) {
        const hasCb = Array.from(li.children || []).some(c => String(c.tagName || '').toUpperCase() === 'INPUT' && String(c.getAttribute('type') || '').toLowerCase() === 'checkbox')
        if (hasCb && !li.textContent.trim()) {
          hasEmptyTaskCb = true
          li.appendChild(doc.createTextNode(cbSpaceSentinel))
        }
      }
    }

    const td = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      fence: '```',
      emDelimiter: '*',
      strongDelimiter: '**',
      br: ''
    })

    // 自定义 escape：保留单词内部下划线（foo_bar_baz 不多余转义），避免污染源码
    const origEscape = td.escape.bind(td)
    td.escape = function (str) {
      let sentinel = 'STKUND'
      while (String(str || '').includes(sentinel)) sentinel += 'X'
      const masked = String(str || '').replace(/([A-Za-z0-9])_([A-Za-z0-9])/g, '$1' + sentinel + '$2')
      return origEscape(masked).split(sentinel).join('_')
    }

    td.remove(['script', 'style'])

    td.addRule('stickyLineBreak', {
      filter: 'br',
      replacement: function (_content, node) {
        const p = node.parentNode
        if (p && (p.nodeName === 'P' || p.nodeName === 'DIV') && p.childNodes.length === 1) return ''
        return '\n'
      }
    })

    td.addRule('stickyUnderline', {
      filter: (node) => {
        if (node.nodeType !== 1) return false
        if (node.nodeName === 'U') return true
        if (node.nodeName === 'SPAN') {
          const st = String(node.getAttribute('style') || '').toLowerCase()
          return /text-decoration\s*:\s*underline/.test(st)
        }
        return false
      },
      replacement: (content) => content ? '<u>' + content + '</u>' : ''
    })

    td.addRule('stickyColor', {
      filter: (node) => {
        if (node.nodeType !== 1) return false
        if (node.nodeName === 'FONT' && node.hasAttribute('color')) return true
        if (node.nodeName === 'SPAN') {
          const st = String(node.getAttribute('style') || '')
          return /(?:^|;)\s*color\s*:/i.test(st)
        }
        return false
      },
      replacement: (content, node) => {
        if (!content) return ''
        let color = ''
        if (node.nodeName === 'FONT') {
          color = (node.getAttribute('color') || '').trim()
        } else {
          const m = String(node.getAttribute('style') || '').match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)
          if (m) color = m[1].trim()
        }
        if (!DEFAULT_COLOR_RE.test(color)) return content
        const isUnderline = node.nodeName === 'SPAN' && /text-decoration\s*:\s*underline/i.test(node.getAttribute('style') || '')
        const inner = isUnderline ? '<u>' + content + '</u>' : content
        return `<span style="color:${color}">${inner}</span>`
      }
    })

    td.addRule('stickyStrike', {
      filter: ['del', 's', 'strike'],
      replacement: (content) => content ? '~~' + content + '~~' : ''
    })

    td.addRule('stickyTaskCheckbox', {
      filter: (node) => node.nodeType === 1 && node.nodeName === 'INPUT' && node.getAttribute('type') === 'checkbox',
      replacement: (_content, node) => {
        const checked = node.hasAttribute('checked') || !!node.checked
        return (checked ? '[x]' : '[ ]') + ' '
      }
    })

    td.addRule('stickyListItem', {
      filter: 'li',
      replacement: (content, node) => {
        let txt = String(content || '').replace(/^\n+/, '').replace(/\n+$/, '\n')
        const parent = node.parentNode
        let prefix = '- '
        if (parent && parent.nodeName === 'OL') {
          const start = parent.getAttribute('start')
          const items = Array.from(parent.children || []).filter(c => c.nodeName === 'LI')
          const index = items.indexOf(node)
          prefix = (start ? Number(start) + index : index + 1) + '. '
        }
        txt = txt.replace(/\n/gm, '\n' + ' '.repeat(prefix.length))
        txt = txt.replace(/^(\[[ xX]\])\s+/, '$1 ')
        return prefix + txt + (node.nextElementSibling ? '\n' : '')
      }
    })

    td.addRule('stickyTableCell', {
      filter: ['th', 'td'],
      replacement: (content) => {
        const cleaned = String(content || '')
          .replace(/\r?\n+/g, ' ')
          .replace(/\|/g, '\\|')
          .trim()
        return ' ' + cleaned + ' |'
      }
    })

    td.addRule('stickyTableRow', {
      filter: 'tr',
      replacement: (content, node) => {
        const cells = Array.from(node.children || []).filter(c => c.nodeName === 'TH' || c.nodeName === 'TD')
        if (!cells.length) return ''
        const rowLine = '|' + content
        const parent = node.parentNode
        const table = node.closest ? node.closest('table') : null
        const allRows = table ? Array.from(table.querySelectorAll('tr')) : []
        const isFirstRow = (parent && parent.nodeName === 'THEAD' && node === parent.firstElementChild) ||
          (allRows.length > 0 && allRows[0] === node)
        if (!isFirstRow) return '\n' + rowLine
        const alignMap = { left: ':---', center: ':---:', right: '---:' }
        const sep = '|' + cells.map(c => {
          let align = (c.getAttribute('align') || '').toLowerCase()
          if (!align) {
            const m = String(c.getAttribute('style') || '').match(/text-align\s*:\s*(left|center|right)/i)
            if (m) align = m[1].toLowerCase()
          }
          return ' ' + (alignMap[align] || '---') + ' |'
        }).join('')
        return '\n' + rowLine + '\n' + sep
      }
    })

    td.addRule('stickyTable', {
      filter: 'table',
      replacement: (content) => '\n\n' + String(content || '').replace(/^\n+/, '').replace(/\n+$/, '') + '\n\n'
    })

    td.addRule('stickyTableSection', {
      filter: ['thead', 'tbody', 'tfoot'],
      replacement: (content) => content
    })

    td.addRule('stickyFencedCode', {
      filter: (node) => node.nodeType === 1 && node.nodeName === 'PRE',
      replacement: (_content, node) => {
        const codeEl = node.querySelector ? node.querySelector('code') : null
        const cls = codeEl ? (codeEl.getAttribute('class') || '') : ''
        const langM = cls.match(/\blanguage-([a-z0-9_+-]+)\b/i)
        const lang = langM ? langM[1] : ''
        const text = (codeEl ? codeEl.textContent : node.textContent || '').replace(/\n$/, '')
        const runs = text.match(/`+/g)
        const maxTicks = runs ? runs.reduce((m, s) => Math.max(m, s.length), 0) : 0
        const fence = '`'.repeat(Math.max(3, maxTicks + 1))
        return '\n\n' + fence + lang + '\n' + text + '\n' + fence + '\n\n'
      }
    })

    let md = td.turndown((doc && doc.body) ? doc.body.innerHTML : rawHtml)
    if (hasEmptyTaskCb) {
      md = md.split(cbSpaceSentinel).join('')
      md = md.replace(/^([ \t]*(?:[-*+]|\d+\.) \[[ xX]\])[ \t]*$/gm, '$1 ')
    }
    if (preserved.length) {
      const re = new RegExp(stashPrefix + 'T(\\d+)END', 'g')
      md = md.replace(re, (_m, i) => preserved[Number(i)] || '')
    }
    return md
  }

  /**
   * 检测纯文本是否包含真实 Markdown 或 LaTeX 语法（用于粘贴自动渲染与块离开自动编译）。
   * 强护栏：排除金额 ($5.99, $10-$20, $10 到 $20, \$50)、snake_case (foo_bar_baz)、
   * JSON、Windows 路径 (C:\foo\bar)、纯日期 (2026-11-23)、纯 URL。
   */
  function looksLikeMarkdownOrLatex (rawText) {
    const text = String(rawText == null ? '' : rawText).replace(/\r\n?/g, '\n')
    const trimmed = text.trim()
    if (!trimmed) return false

    // 1. JSON 对象 / 数组护栏
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object') return false
      } catch (_) {}
    }

    // 2. 纯 Windows 路径 / UNC 路径护栏（含带引号的 "Copy as path" 形式）
    const pathCandidate = trimmed.replace(/^(['"])(.*)\1$/, '$2')
    if (!pathCandidate.includes('\n') && /^(?:[A-Za-z]:\\|\\\\[^\\/\s]+\\)[^\r\n]*$/.test(pathCandidate)) {
      return false
    }

    // 3. 纯日期护栏
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(trimmed)) {
      return false
    }

    // 3.5 纯单条 URL 护栏（避免 URL 路径中的 /_test_/ 误判为斜体）
    if (!/\s/.test(trimmed) && /^https?:\/\/\S+$/i.test(trimmed)) {
      return false
    }

    // 4. 严格 LaTeX 检测（使用同一个保护器，天然免疫 $5.99 / $10-$20 / \$50）
    const protectedInfo = protectMathAndCode(text)
    if (protectedInfo.tokens.some(t => t.kind === 'math')) {
      return true
    }

    // 5. 块级 Markdown 语法
    if (/^[ \t]{0,3}#{1,6}[ \t]+\S/m.test(text)) return true
    if (/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/m.test(text)) return true
    if (/^[ \t]{0,3}>[ \t]+\S/m.test(text)) return true
    if (/^[ \t]{0,3}[-*+][ \t]+(?:\[[ xX]\][ \t]+)?\S/m.test(text)) return true
    if (/^[ \t]{0,3}\d{1,9}\.[ \t]+\S/m.test(text)) return true
    if (/^[ \t]{0,3}(?:---+|_{3,}|\*{3,})[ \t]*$/m.test(text)) return true
    if (/\|.+\|\n[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+/m.test(text)) return true

    // 6. 行内 Markdown 语法（排除 foo_bar_baz / 单纯 URL）
    if (/\*\*[^\s*](?:[^*\n]*[^\s*])?\*\*/.test(text)) return true
    if (/(?:^|[^A-Za-z0-9_])__[^\s_](?:[^_\n]*[^\s_])?__(?=$|[^A-Za-z0-9_])/.test(text)) return true
    if (/(?:^|[^A-Za-z0-9*])\*[^\s*](?:[^*\n]*[^\s*])?\*(?=$|[^A-Za-z0-9*])/.test(text)) return true
    if (/(?:^|[^A-Za-z0-9_])_[^\s_](?:[^_\n]*[^\s_])?_(?=$|[^A-Za-z0-9_])/.test(text)) return true
    if (/~~[^\s~](?:[^~\n]*[^\s~])?~~/.test(text)) return true
    if (/`+[^`\n]+`+/.test(text)) return true
    if (/!?\[[^\]\n]+\]\((?:https?:\/\/|sticky-att:|data:image\/)[^)\s]+\)/i.test(text)) return true

    return false
  }

  /** 是否包含块级语法（用于决定粘贴时走 inline 还是 block 插入） */
  function hasBlockMarkdownOrLatex (rawText) {
    const text = String(rawText == null ? '' : rawText).replace(/\r\n?/g, '\n')
    if (text.includes('\n')) return true
    if (/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]+|[-*+][ \t]+|\d{1,9}\.[ \t]+|(?:---+|_{3,}|\*{3,})[ \t]*$|\$\$[\s\S]+\$\$[ \t]*$|\\\[[\s\S]+\\\][ \t]*$)/.test(text)) {
      return true
    }
    return false
  }

  function renderMathNode (node, katexLib) {
    if (!node) return
    const lib = katexLib || resolveKatex()
    const tex = node.getAttribute('data-tex') || ''
    const displayMode = node.classList && node.classList.contains('math-block')
    const body = node.querySelector && node.querySelector('.math-body')
    if (!body) return
    if (lib && typeof lib.renderToString === 'function') {
      try {
        body.innerHTML = lib.renderToString(tex, {
          displayMode: !!displayMode,
          throwOnError: false,
          strict: false,
          trust: false
        })
        node.setAttribute('data-rendered', '1')
        return
      } catch (_) {}
    }
    body.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`
  }

  function renderMathInElement (rootEl, katexLib) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return
    const lib = katexLib || resolveKatex()
    const nodes = rootEl.querySelectorAll('.math-inline, .math-block')
    for (let i = 0; i < nodes.length; i++) {
      renderMathNode(nodes[i], lib)
    }
  }

  function katexNodeToLatex (katexEl) {
    if (!katexEl) return ''
    const ann = katexEl.querySelector && katexEl.querySelector('annotation[encoding="application/x-tex"]')
    const tex = ann ? (ann.textContent || '').trim() : ''
    if (tex) {
      const isDisplay = !!(katexEl.closest && katexEl.closest('.katex-display, .ai-math-block, .math-block'))
      return isDisplay ? `$$${tex}$$` : `$${tex}$`
    }
    const html = katexEl.querySelector && katexEl.querySelector('.katex-html')
    return html ? (html.textContent || '') : (katexEl.textContent || '')
  }

  function mathNodeToSource (mathEl) {
    const tex = mathEl.getAttribute('data-tex') || ''
    const delim = mathEl.getAttribute('data-delim')
    const isBlock = mathEl.classList && mathEl.classList.contains('math-block')
    if (delim === '\\(') return '\\(' + tex + '\\)'
    if (delim === '\\[') return '\\[' + tex + '\\]'
    if (isBlock) return '$$\n' + tex + '\n$$'
    return '$' + tex + '$'
  }

  /**
   * 从浏览器 Selection / Range 中提取干净文本，避免 KaTeX (.katex-mathml + .katex-html) 产生重复三份字符。
   */
  function extractSelectionText (range, fallbackText) {
    if (!range) return String(fallbackText || '')
    const ancestor = range.commonAncestorContainer
    const hostEl = ancestor && (ancestor.nodeType === 1 ? ancestor : ancestor.parentElement)
    const insideMath = hostEl && hostEl.closest && hostEl.closest('.math-inline, .math-block')
    if (insideMath) return mathNodeToSource(insideMath)
    const insideKatex = hostEl && hostEl.closest && hostEl.closest('.katex')
    if (insideKatex) return katexNodeToLatex(insideKatex)
    const insideMmd = hostEl && hostEl.closest && hostEl.closest('.mmd')
    if (insideMmd) return '```mermaid\n' + (insideMmd.getAttribute('data-code') || '') + '\n```'

    if (!hostEl || !hostEl.querySelector || !hostEl.querySelector('.katex, .katex-mathml, .math-inline, .math-block, .mmd')) {
      return String(fallbackText || '')
    }

    const frag = range.cloneContents()
    const walk = (node, out) => {
      const children = node.childNodes || []
      for (let i = 0; i < children.length; i++) {
        const ch = children[i]
        if (ch.nodeType === 3) {
          out.push(ch.nodeValue || '')
          continue
        }
        if (ch.nodeType !== 1) continue
        if (ch.classList) {
          if (ch.classList.contains('katex-mathml') || ch.classList.contains('mmd-tools')) continue
          if (ch.classList.contains('mmd')) {
            out.push('```mermaid\n' + (ch.getAttribute('data-code') || '') + '\n```\n')
            continue
          }
          if (ch.classList.contains('math-block')) {
            out.push(mathNodeToSource(ch) + '\n')
            continue
          }
          if (ch.classList.contains('math-inline')) {
            out.push(mathNodeToSource(ch))
            continue
          }
          if (ch.classList.contains('katex')) {
            out.push(katexNodeToLatex(ch))
            continue
          }
        }
        const tag = String(ch.tagName || '').toUpperCase()
        if (tag === 'BR') { out.push('\n'); continue }
        walk(ch, out)
        if (['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TR'].includes(tag)) {
          out.push('\n')
        }
      }
    }
    const parts = []
    walk(frag, parts)
    return parts.join('').replace(/\u00a0/g, ' ').replace(/\n+$/, '')
  }

  /**
   * 从选区 Range 提取清理过 .math-body / .mmd-body 的 HTML（供剪贴板复制）。
   */
  function extractSelectionHtml (range) {
    if (!range || typeof document === 'undefined') return ''
    const wrap = document.createElement('div')
    wrap.appendChild(range.cloneContents())
    wrap.querySelectorAll('.math-body, .mmd-body').forEach(el => { el.innerHTML = '' })
    wrap.querySelectorAll('.math-inline, .math-block, .mmd').forEach(el => el.removeAttribute('data-rendered'))
    return wrap.innerHTML
  }

  return {
    protectMathAndCode,
    sanitizeHtml,
    sanitizeDomTree,
    parseNoteMarkdown,
    parseNoteMarkdownInline,
    parseNoteMarkdownSnapshot,
    parseMarkdownToRawHtmlWithMath,
    htmlToNoteMarkdown,
    looksLikeMarkdownOrLatex,
    hasBlockMarkdownOrLatex,
    renderMathNode,
    renderMathInElement,
    extractSelectionText,
    extractSelectionHtml,
    buildMathNode,
    buildMermaidNode,
    isSafeImgSrc
  }
})
