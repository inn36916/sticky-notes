'use strict'

/**
 * 轻量 Markdown + LaTeX → HTML 渲染器（双环境 UMD，同时支持浏览器与 Node 单测）。
 * 便签内划词卡片与系统级悬浮卡片共用，避免两份实现漂移。
 *
 * 支持：
 * - Markdown：代码块（```）/ 行内代码 / 标题 / 列表 / 粗体 / 段落
 * - LaTeX：$$...$$、\[...\]（块级）与 \(...\)、Pandoc 安全规则的 $...$（行内）
 * - 安全：KaTeX trust: false；代码块先占位保护；流式未闭合公式平滑降级；金额 $10 到 $20 不误判
 */
;(function (root, factory) {
  const api = factory(root)
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api
  } else if (root) {
    root.renderAiMarkdown = api.renderAiMarkdown
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const esc = (root && root.StickyUtils && root.StickyUtils.escapeHtml) ||
    ((s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))

  function resolveKatex (opts) {
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'katex')) return opts.katex
    if (typeof window !== 'undefined' && window.katex) return window.katex
    if (root && root.katex) return root.katex
    return null
  }

  function renderTex (tex, displayMode, katexLib) {
    const formula = String(tex == null ? '' : tex).trim()
    if (!formula) {
      return displayMode
        ? '<div class="ai-math-block ai-math-fallback"><code>$$</code></div>'
        : '$'
    }
    if (katexLib && typeof katexLib.renderToString === 'function') {
      try {
        const html = katexLib.renderToString(formula, {
          displayMode: !!displayMode,
          throwOnError: false,
          strict: false,
          trust: false
        })
        return displayMode
          ? '<div class="ai-math-block">' + html + '</div>'
          : '<span class="ai-math-inline">' + html + '</span>'
      } catch (_) {}
    }
    return displayMode
      ? '<div class="ai-math-block ai-math-fallback"><code>' + esc(formula) + '</code></div>'
      : '<code class="ai-math-fallback">' + esc(formula) + '</code>'
  }

  /**
   * 扫描行内 $...$（Pandoc 风格边界约束，避免 "$10 到 $20" 误触发），同时还原层外的 \$ 为 $。
   */
  function extractInlineDollarAndEscapes (str, stash, katexLib) {
    let out = ''
    let i = 0
    const len = str.length
    while (i < len) {
      const ch = str[i]
      if (ch === '\\') {
        if (i + 1 < len && str[i + 1] === '$') {
          out += stash('$')
          i += 2
          continue
        }
        if (i + 1 < len && str[i + 1] === '\\') {
          out += '\\\\'
          i += 2
          continue
        }
        out += ch
        i++
        continue
      }
      if (ch !== '$') {
        out += ch
        i++
        continue
      }
      if (i + 1 >= len || str[i + 1] === '$' || /\s/.test(str[i + 1]) || str[i + 1] === '\u0000') {
        out += '$'
        i++
        continue
      }
      let matchedEnd = -1
      let j = i + 1
      while (j < len) {
        const c = str[j]
        if (c === '\n' || c === '\u0000') break
        if (c === '\\' && j + 1 < len) {
          j += 2
          continue
        }
        if (c === '$') {
          const prev = str[j - 1]
          const next = j + 1 < len ? str[j + 1] : ''
          if (j > i + 1 && !/\s/.test(prev) && !(next && /[0-9]/.test(next))) {
            matchedEnd = j
            break
          }
        }
        j++
      }
      if (matchedEnd > i + 1) {
        out += stash(renderTex(str.slice(i + 1, matchedEnd), false, katexLib))
        i = matchedEnd + 1
      } else {
        out += '$'
        i++
      }
    }
    return out
  }

  function inlineFmt (s, katexLib) {
    let str = String(s == null ? '' : s).replace(/\u0000/g, '')
    const tokens = []
    const stash = (html) => {
      const idx = tokens.length
      tokens.push(html)
      return '\u0000T' + idx + '\u0000'
    }

    // 1. 先保护行内代码，避免代码里的 $ 或 \( \) 被当作公式
    str = str.replace(/`([^`]+)`/g, (_, code) => stash('<code>' + esc(code) + '</code>'))

    // 2. 提取块级/行内括号公式
    str = str.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stash(renderTex(tex, true, katexLib)))
    str = str.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => stash(renderTex(tex, true, katexLib)))
    str = str.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => stash(renderTex(tex, false, katexLib)))

    // 3. 提取行内 $...$ 与转义 \$
    str = extractInlineDollarAndEscapes(str, stash, katexLib)

    // 4. 其余文本转义后做加粗（此时公式内 * / _ 已安全占位）
    str = esc(str)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/__([^_]+)__/g, '<b>$1</b>')

    return str.replace(/\u0000T(\d+)\u0000/g, (_, idx) => tokens[Number(idx)] || '')
  }

  function renderAiMarkdown (src, opts) {
    const katexLib = resolveKatex(opts)
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n')
    const out = []
    let inCode = false
    let code = []
    let inMath = null
    let para = []

    const flush = () => {
      const t = para.join(' ').trim()
      if (t) out.push('<p>' + inlineFmt(t, katexLib) + '</p>')
      para = []
    }

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '')

      if (inMath) {
        const closeIdx = raw.indexOf(inMath.close)
        if (closeIdx >= 0) {
          const before = raw.slice(0, closeIdx)
          if (before.trim()) inMath.lines.push(before)
          out.push(renderTex(inMath.lines.join('\n'), true, katexLib))
          const after = raw.slice(closeIdx + inMath.close.length).trim()
          inMath = null
          if (after) para.push(after)
        } else {
          inMath.lines.push(raw)
        }
        continue
      }

      if (/^\s*```/.test(line)) {
        if (inCode) {
          out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>')
          code = []
          inCode = false
        } else {
          flush()
          inCode = true
        }
        continue
      }
      if (inCode) { code.push(raw); continue }

      // 多行/单行块级公式：$$...$$ 或 \[...\]
      const dmOpen = line.match(/^\s*\$\$(.*)$/)
      if (dmOpen) {
        const rest = dmOpen[1]
        const closeIdx = rest.indexOf('$$')
        if (closeIdx >= 0) {
          if (!rest.slice(closeIdx + 2).trim()) {
            flush()
            out.push(renderTex(rest.slice(0, closeIdx), true, katexLib))
            continue
          }
        } else {
          flush()
          inMath = { close: '$$', lines: rest.trim() ? [rest] : [] }
          continue
        }
      }

      const bmOpen = line.match(/^\s*\\\[(.*)$/)
      if (bmOpen) {
        const rest = bmOpen[1]
        const closeIdx = rest.indexOf('\\]')
        if (closeIdx >= 0) {
          if (!rest.slice(closeIdx + 2).trim()) {
            flush()
            out.push(renderTex(rest.slice(0, closeIdx), true, katexLib))
            continue
          }
        } else {
          flush()
          inMath = { close: '\\]', lines: rest.trim() ? [rest] : [] }
          continue
        }
      }

      if (!line.trim()) { flush(); continue }

      const h = line.match(/^\s*#{1,6}\s+(.*)$/)
      if (h) { flush(); out.push('<p><b>' + inlineFmt(h[1], katexLib) + '</b></p>'); continue }

      const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/)
      if (li) { flush(); out.push('<div class="li"><span>' + inlineFmt(li[1], katexLib) + '</span></div>'); continue }

      para.push(line.trim())
    }

    if (inCode) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>')
    if (inMath) {
      out.push('<div class="ai-math-block ai-math-pending"><code>' + esc(inMath.lines.join('\n')) + '</code></div>')
    }
    flush()
    return out.join('') || '<p></p>'
  }

  return { renderAiMarkdown }
})
