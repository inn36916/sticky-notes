'use strict'
;(function (root) {
  const COLOR_RE = /^(?:#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i
  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA'])
  const ALLOWED = new Set([
    'P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
    'A', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
    'CODE', 'PRE', 'IMG', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'INPUT', 'FONT'
  ])

  function safeSpanStyle (raw) {
    if (!raw) return ''
    const m = String(raw).match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)
    if (!m) return ''
    const val = m[1].trim()
    return COLOR_RE.test(val) ? 'color:' + val : ''
  }

  function safeCellAlign (el) {
    const a = (el.getAttribute('align') || '').trim().toLowerCase()
    if (/^(left|center|right)$/.test(a)) return a
    const m = String(el.getAttribute('style') || '').match(/text-align\s*:\s*(left|center|right)/i)
    return m ? m[1].toLowerCase() : ''
  }

  function exportNote (note) {
    const doc = new DOMParser().parseFromString(note.html || '', 'text/html')
    const resources = []
    function resource (source) {
      const token = 'STICKY_RESOURCE_' + resources.length
      resources.push({ source, token })
      return token
    }

    function escapeText (str) {
      return String(str || '').replace(/([\\`*_[\]<>])/g, '\\$1')
    }

    function exportTable (tableEl, depth) {
      const rows = Array.from(tableEl.querySelectorAll('tr'))
      if (!rows.length) return ''
      const outRows = rows.map(tr => {
        const cells = Array.from(tr.children || []).filter(c => c.tagName === 'TH' || c.tagName === 'TD')
        return cells.map(c => ({
          align: safeCellAlign(c),
          text: Array.from(c.childNodes).map(n => walk(n, depth)).join('').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim()
        }))
      }).filter(r => r.length > 0)
      if (!outRows.length) return ''
      const colCount = Math.max(...outRows.map(r => r.length))
      const pad = (row) => {
        const arr = row.slice()
        while (arr.length < colCount) arr.push({ align: '', text: '' })
        return arr
      }
      const header = pad(outRows[0])
      const alignMap = { left: ':---', center: ':---:', right: '---:' }
      const lines = [
        '| ' + header.map(c => c.text).join(' | ') + ' |',
        '| ' + header.map(c => alignMap[c.align] || '---').join(' | ') + ' |'
      ]
      for (let i = 1; i < outRows.length; i++) {
        lines.push('| ' + pad(outRows[i]).map(c => c.text).join(' | ') + ' |')
      }
      return '\n\n' + lines.join('\n') + '\n\n'
    }

    function walk (node, depth = 0) {
      if (node.nodeType === 3) return escapeText(node.data)
      if (node.nodeType !== 1) return ''
      const tag = node.tagName
      if (DROP_TAGS.has(tag)) return ''
      if (node.classList.contains('mmd')) return '\n\n```mermaid\n' + (node.getAttribute('data-code') || '') + '\n```\n\n'
      if (node.classList.contains('math-inline')) {
        const tex = node.getAttribute('data-tex') || ''
        return node.getAttribute('data-delim') === '\\(' ? '\\(' + tex + '\\)' : '$' + tex + '$'
      }
      if (node.classList.contains('math-block')) {
        const tex = (node.getAttribute('data-tex') || '').replace(/\r\n?/g, '\n')
        const d = node.getAttribute('data-delim') || '$$'
        if (d === '\\[') return '\n\n\\[\n' + tex + '\n\\]\n\n'
        if (d === 'math') return '\n\n```math\n' + tex + '\n```\n\n'
        if (d === 'latex') return '\n\n```latex\n' + tex + '\n```\n\n'
        return '\n\n$$\n' + tex + '\n$$\n\n'
      }
      if (node.classList.contains('attachment') && node.hasAttribute('data-path')) return '\n\n[📎 ' + (node.getAttribute('data-attachment') || '附件') + '](' + resource(node.getAttribute('data-path')) + ')\n\n'
      if (tag === 'IMG') return '![' + (node.getAttribute('alt') || '图片').replace(/[\[\]]/g, '') + '](' + resource(node.getAttribute('src')) + ')'
      if (tag === 'INPUT') return ''
      if (tag === 'HR') return '\n\n---\n\n'
      if (tag === 'TABLE') return exportTable(node, depth)
      if (tag === 'UL' || tag === 'OL') {
        return '\n' + Array.from(node.children).map((li, i) => {
          const checkbox = Array.from(li.children || []).find(c => c.tagName === 'INPUT' && c.type === 'checkbox')
          const marker = checkbox ? '- [' + (checkbox.hasAttribute('checked') || checkbox.checked ? 'x' : ' ') + '] ' : tag === 'OL' ? (i + 1) + '. ' : '- '
          return '  '.repeat(depth) + marker + Array.from(li.childNodes).map(n => walk(n, depth + 1)).join('').trim() + '\n'
        }).join('') + '\n'
      }
      const content = Array.from(node.childNodes).map(n => walk(n, depth)).join('')
      if (tag === 'BR') return '  \n'
      if (['B', 'STRONG'].includes(tag)) return content ? '**' + content + '**' : ''
      if (['I', 'EM'].includes(tag)) return content ? '*' + content + '*' : ''
      if (['DEL', 'S', 'STRIKE'].includes(tag)) return content ? '~~' + content + '~~' : ''
      if (tag === 'U') return content ? '<u>' + content + '</u>' : ''
      if (tag === 'FONT' && node.hasAttribute('color')) {
        const col = (node.getAttribute('color') || '').trim()
        return COLOR_RE.test(col) && content ? `<span style="color:${col}">${content}</span>` : content
      }
      if (tag === 'SPAN') {
        const st = safeSpanStyle(node.getAttribute('style'))
        return st && content ? `<span style="${st}">${content}</span>` : content
      }
      if (tag === 'PRE') {
        const codeEl = node.querySelector('code')
        const cls = codeEl ? (codeEl.getAttribute('class') || '') : ''
        const langM = cls.match(/\blanguage-([a-z0-9_+-]+)\b/i)
        const lang = langM ? langM[1] : ''
        const codeText = (codeEl ? codeEl.textContent : node.textContent || '').replace(/\n$/, '')
        const runs = codeText.match(/`+/g)
        const maxTicks = runs ? runs.reduce((m, s) => Math.max(m, s.length), 0) : 0
        const fence = '`'.repeat(Math.max(3, maxTicks + 1))
        return '\n\n' + fence + lang + '\n' + codeText + '\n' + fence + '\n\n'
      }
      if (tag === 'CODE') {
        const code = node.textContent || ''
        if (!code.includes('`')) return '`' + code + '`'
        return '`` ' + code + ' ``'
      }
      if (tag === 'A') return '[' + content + '](' + (node.getAttribute('href') || '') + ')'
      if (/^H[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + content + '\n\n'
      if (tag === 'BLOCKQUOTE') {
        const trimmed = content.trim().replace(/\n{3,}/g, '\n\n')
        if (!trimmed) return ''
        const quoted = trimmed.split('\n').map(l => (l.trim() ? '> ' + l : '>')).join('\n')
        return '\n\n' + quoted + '\n\n'
      }
      if (['P', 'DIV'].includes(tag)) return '\n\n' + content + '\n\n'
      return content
    }

    const markdown = '# ' + (note.title || '未命名便签').replace(/\r?\n/g, ' ').replace(/([\\`*_[\]<>])/g, '\\$1') + '\n\n' + Array.from(doc.body.childNodes).map(n => walk(n)).join('').replace(/\n{3,}/g, '\n\n').trim() + '\n'
    return { markdown, text: (note.title ? note.title + '\n\n' : '') + StickyDomSnapshot.textFromRoot(doc.body), resources }
  }

  function importHtml (payload) {
    const doc = new DOMParser().parseFromString(payload.html || '', 'text/html')
    const firstEl = doc.body.firstElementChild
    const titleNode = (firstEl && firstEl.tagName === 'H1') ? firstEl : null
    const title = titleNode ? titleNode.textContent : payload.title
    if (titleNode) titleNode.remove()
    const resources = []
    const trustedNodes = new WeakSet()

    for (const pre of Array.from(doc.querySelectorAll('pre'))) {
      const code = pre.querySelector('code.language-mermaid')
      if (!code) continue
      const block = doc.createElement('div')
      block.className = 'mmd'; block.setAttribute('contenteditable', 'false'); block.setAttribute('data-code', code.textContent.replace(/\n$/, ''))
      block.innerHTML = '<div class="mmd-tools"><button type="button" data-mmd="edit">✎</button><button type="button" data-mmd="del">✕</button></div><div class="mmd-body"></div>'
      trustedNodes.add(block)
      pre.replaceWith(block)
    }

    for (const mathEl of Array.from(doc.querySelectorAll('.math-inline, .math-block'))) {
      if (!mathEl.hasAttribute('data-tex')) continue
      const isBlock = mathEl.classList.contains('math-block')
      const tex = mathEl.getAttribute('data-tex') || ''
      const delim = mathEl.getAttribute('data-delim') || (isBlock ? '$$' : '$')
      const rebuilt = doc.createElement(isBlock ? 'div' : 'span')
      rebuilt.className = isBlock ? 'math-block' : 'math-inline'
      rebuilt.setAttribute('contenteditable', 'false')
      rebuilt.setAttribute('data-tex', tex)
      rebuilt.setAttribute('data-delim', delim)
      const body = doc.createElement(isBlock ? 'div' : 'span')
      body.className = 'math-body'
      rebuilt.appendChild(body)
      trustedNodes.add(rebuilt)
      mathEl.replaceWith(rebuilt)
    }

    function clean (parent) {
      for (const child of Array.from(parent.children)) {
        if (trustedNodes.has(child)) continue
        if (DROP_TAGS.has(child.tagName)) { child.remove(); continue }
        if (!ALLOWED.has(child.tagName) || (child.tagName === 'INPUT' && child.type !== 'checkbox')) {
          child.remove()
          continue
        }
        const tag = child.tagName
        if (tag === 'IMG') {
          const rawSrc = (child.getAttribute('src') || '').trim()
          const alt = (child.getAttribute('alt') || '').trim()
          if (/^https?:\/\//i.test(rawSrc)) {
            const a = doc.createElement('a')
            a.href = rawSrc
            a.target = '_blank'
            a.rel = 'noreferrer'
            a.textContent = alt ? '[图片: ' + alt + ']' : '[外部图片: ' + rawSrc + ']'
            child.replaceWith(a)
            continue
          }
          const token = 'STICKY_IMPORT_' + resources.length
          resources.push({ source: rawSrc, token, attachment: false })
          for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name)
          child.setAttribute('src', token)
          if (alt) child.setAttribute('alt', alt)
          continue
        }

        const isAttachmentLink = tag === 'A' && child.textContent.startsWith('📎 ')
        const href = tag === 'A' ? child.getAttribute('href') : null
        const checked = tag === 'INPUT' && (child.hasAttribute('checked') || child.checked)
        const spanStyle = tag === 'SPAN' ? safeSpanStyle(child.getAttribute('style')) : ''
        const fontCol = tag === 'FONT' ? (child.getAttribute('color') || '').trim() : ''
        const cellAlign = (tag === 'TD' || tag === 'TH') ? safeCellAlign(child) : ''
        const codeCls = tag === 'CODE' ? (child.getAttribute('class') || '') : ''
        const langM = codeCls.match(/\blanguage-([a-z0-9_+-]+)\b/i)

        for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name)

        if (tag === 'INPUT') {
          child.type = 'checkbox'
          child.setAttribute('contenteditable', 'false')
          if (checked) child.setAttribute('checked', '')
        } else if (isAttachmentLink) {
          const token = 'STICKY_IMPORT_' + resources.length
          resources.push({ source: href, token, attachment: true })
          const block = doc.createElement('p')
          block.className = 'attachment'
          block.setAttribute('data-attachment', child.textContent.slice(2))
          block.setAttribute('data-path', token)
          block.textContent = child.textContent
          const pWrap = child.parentNode
          if (pWrap && pWrap.tagName === 'P' && Array.from(pWrap.childNodes).every(n => n === child || (n.nodeType === 3 && !n.nodeValue.trim()))) {
            pWrap.replaceWith(block)
          } else {
            child.replaceWith(block)
          }
          continue
        } else if (tag === 'A') {
          if (href && /^https?:\/\//i.test(href)) {
            child.href = href
            child.target = '_blank'
            child.rel = 'noreferrer'
          } else {
            clean(child)
            while (child.firstChild) parent.insertBefore(child.firstChild, child)
            child.remove()
            continue
          }
        } else if (tag === 'SPAN' && spanStyle) {
          child.setAttribute('style', spanStyle)
        } else if (tag === 'FONT' && COLOR_RE.test(fontCol)) {
          child.setAttribute('color', fontCol)
        } else if ((tag === 'TD' || tag === 'TH') && cellAlign) {
          child.setAttribute('align', cellAlign)
        } else if (tag === 'CODE' && langM) {
          child.setAttribute('class', 'language-' + langM[1].toLowerCase())
        }
        clean(child)
      }
    }
    clean(doc.body)
    return {
      title,
      html: doc.body.innerHTML,
      preview: StickyDomSnapshot.textFromRoot(doc.body).slice(0, 160),
      resources
    }
  }
  root.StickyExchange = { exportNote, importHtml }
})(globalThis)
