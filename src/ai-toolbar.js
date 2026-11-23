'use strict'

/**
 * 页面内划词 AI 工具条（便签窗口 / 便签中心 / 任何引入本脚本的页面）
 *
 * 交互：选中文字 → 浮出「AI 搜索 / 解释 / 翻译 / 提问 / 复制」
 *       触发任意 AI 动作后统一以独立悬浮回答窗口展示（可无限多开、窗内自由划词，从便签触发保留「插入便签」）。
 */
;(function () {
  const api = window.sticky
  if (!api || typeof api.overlayOpenCard !== 'function') return

  const appearance = window.StickyPopupAppearance
  function applyPopupStyle (cfg) {
    if (appearance && typeof appearance.applyPopupAppearance === 'function') {
      appearance.applyPopupAppearance(document, cfg)
    }
  }
  if (typeof api.popupAppearance === 'function') {
    Promise.resolve(api.popupAppearance()).then(applyPopupStyle).catch(() => {})
  }
  if (typeof api.onPopupAppearanceChanged === 'function') {
    api.onPopupAppearanceChanged(applyPopupStyle)
  }

  const LABELS = { search: 'AI 搜索', explain: '解释', translate: '翻译', ask: '向 AI 提问' }
  const BAR_ACTIONS = ['search', 'explain', 'translate']
  const MIN_LEN = 2
  const MAX_LEN = 6000

  const _u = window.StickyUtils
  const clamp = (_u && _u.clamp) || ((v, a, b) => Math.min(Math.max(v, a), Math.max(a, b)))

  const ICON = {
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2L14 14"/></svg>',
    explain: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.4a4.2 4.2 0 0 0-2.6 7.5c.4.3.6.7.6 1.2v.3h4v-.3c0-.5.2-.9.6-1.2A4.2 4.2 0 0 0 8 2.4Z"/><path d="M6.4 13.4h3.2"/></svg>',
    translate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 3.6h6.4M5 2v1.6M6.8 3.6c0 2.6-2 4.9-5 5.9"/><path d="M3.4 6.4c.7 1.6 2.2 2.8 4 3.3"/><path d="M8.6 13.4 11.5 6l2.9 7.4M9.7 11h3.6"/></svg>',
    ask: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9.2a1.8 1.8 0 0 1-1.8 1.8H5.6L2 13.6V3.8A1.8 1.8 0 0 1 3.8 2h8.4A1.8 1.8 0 0 1 14 3.8Z"/><path d="M8 5.6v.1M8 7.4c0-.5.6-.7 1-.9.5-.3.6-1 .2-1.4-.5-.5-1.4-.3-1.6.3"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.2" y="2.2" width="8.6" height="8.6" rx="1.6"/><path d="M10.8 12.4v.6a1.6 1.6 0 0 1-1.6 1.6H3.8a1.6 1.6 0 0 1-1.6-1.6V7.4a1.6 1.6 0 0 1 1.6-1.6h.6"/></svg>'
  }

  // ---------------------------------------------------------------- DOM
  const bar = document.createElement('div')
  bar.className = 'ai-bar'
  bar.hidden = true
  bar.innerHTML =
    `<span class="ai-grip ai-bar-grip" title="按住拖动"><i></i><i></i><i></i><i></i><i></i><i></i></span>` +
    BAR_ACTIONS.map((k) =>
      `<button type="button" data-act="${k}" title="${LABELS[k]}">${ICON[k]}<span>${LABELS[k]}</span></button>`
    ).join('') + `
    <span class="ai-bar-sep"></span>
    <button type="button" data-act="ask" title="${LABELS.ask}">${ICON.ask}<span>提问</span></button>
    <button type="button" data-act="copyText" title="复制选中的文字">${ICON.copy}<span>复制</span></button>
    <div class="ai-ask" hidden>
      <input type="text" placeholder="就选中的内容向 AI 提问…" maxlength="2000" />
      <button type="button" data-act="askSend" disabled>发送</button>
    </div>`
  document.body.appendChild(bar)

  // ---------------------------------------------------------------- 状态
  let current = null        // { text, rect }
  let hideTimer = 0
  let barDrag = null        // { id, dx, dy, moved }
  let barUserPos = null     // { x, y }
  let askOpen = false
  let pendingQuestion = ''

  const askRow = bar.querySelector('.ai-ask')
  const askInput = bar.querySelector('.ai-ask input')
  const askSend = bar.querySelector('[data-act="askSend"]')

  function setBarPos (x, y) {
    const bw = bar.offsetWidth || 180
    const bh = bar.offsetHeight || 32
    const cx = clamp(x, 4, Math.max(4, window.innerWidth - bw - 4))
    const cy = clamp(y, 4, Math.max(4, window.innerHeight - bh - 4))
    bar.style.left = Math.round(cx) + 'px'
    bar.style.top = Math.round(cy) + 'px'
  }

  function setAskOpen (on) {
    if (askOpen === on) {
      if (on && current) {
        askInput.focus()
        if (barUserPos) setBarPos(barUserPos.x, barUserPos.y)
        else placeBar(current.rect)
      }
      return
    }
    if (askOpen) pendingQuestion = askInput.value
    askOpen = on
    bar.classList.toggle('has-ask', on)
    askRow.hidden = !on
    if (on) {
      askInput.value = pendingQuestion
      askSend.disabled = !pendingQuestion.trim()
    }
    if (barUserPos) {
      setBarPos(barUserPos.x, barUserPos.y)
      barUserPos = { x: parseFloat(bar.style.left) || 0, y: parseFloat(bar.style.top) || 0 }
    } else if (current) {
      placeBar(current.rect)
    }
    if (on) askInput.focus()
  }

  function sendAsk () {
    const q = String(askInput.value || '').trim()
    if (!q) return
    void run('ask', current && current.text, current && current.rect, q)
  }

  async function writeClipboard (str) {
    if (typeof api.copyText === 'function') {
      try {
        const r = await api.copyText(str)
        if (r && r.ok) return true
      } catch (_) {}
    }
    try {
      await navigator.clipboard.writeText(str)
      return true
    } catch (_) {
      return false
    }
  }

  async function copySelected (btn) {
    const label = btn.querySelector('span')
    const original = label ? label.textContent : '复制'
    const body = (current && current.text) || ''
    if (!body) return
    const ok = await writeClipboard(body)
    if (label) label.textContent = ok ? '已复制' : '复制失败'
    setTimeout(() => { if (label) label.textContent = original }, 1200)
  }

  function extractRangeCleanText (range, rawFallback) {
    if (window.StickyMarkdown && typeof window.StickyMarkdown.extractSelectionText === 'function') {
      return window.StickyMarkdown.extractSelectionText(range, rawFallback)
    }
    const ancestor = range && range.commonAncestorContainer
    const hostEl = ancestor && (ancestor.nodeType === 1 ? ancestor : ancestor.parentElement)
    const insideMath = hostEl && hostEl.closest && hostEl.closest('.math-inline, .math-block')
    if (insideMath) {
      const tex = insideMath.getAttribute('data-tex') || ''
      return insideMath.classList.contains('math-block') ? `$$${tex}$$` : `$${tex}$`
    }
    const insideKatex = hostEl && hostEl.closest && hostEl.closest('.katex')
    if (insideKatex) {
      const ann = insideKatex.querySelector('annotation[encoding="application/x-tex"]')
      if (ann && ann.textContent) {
        return insideKatex.closest('.katex-display, .ai-math-block, .math-block') ? `$$${ann.textContent.trim()}$$` : `$${ann.textContent.trim()}$`
      }
    }
    if (!hostEl || !hostEl.querySelector || !hostEl.querySelector('.katex, .katex-mathml, .math-inline, .math-block')) {
      return String(rawFallback || '')
    }
    const frag = range.cloneContents()
    const walk = (node, out) => {
      for (const ch of (node.childNodes || [])) {
        if (ch.nodeType === 3) { out.push(ch.nodeValue || ''); continue }
        if (ch.nodeType !== 1) continue
        if (ch.classList) {
          if (ch.classList.contains('katex-mathml')) continue
          if (ch.classList.contains('math-inline') || ch.classList.contains('math-block')) {
            const tex = ch.getAttribute('data-tex') || ''
            out.push(ch.classList.contains('math-block') ? `$$${tex}$$` : `$${tex}$`)
            continue
          }
          if (ch.classList.contains('katex')) {
            const ann = ch.querySelector('annotation[encoding="application/x-tex"]')
            const tex = ann ? ann.textContent.trim() : ''
            if (tex) {
              out.push(ch.closest('.katex-display, .ai-math-block, .math-block') ? `$$${tex}$$` : `$${tex}$`)
              continue
            }
          }
        }
        if (ch.tagName === 'BR') { out.push('\n'); continue }
        walk(ch, out)
      }
    }
    const parts = []
    walk(frag, parts)
    return parts.join('')
  }

  // ---------------------------------------------------------------- 选区
  function readSelection () {
    const active = document.activeElement
    if (active && active.matches && active.matches('input, textarea')) return null
    const noteRoot = document.getElementById('note')
    if (noteRoot && noteRoot.dataset && noteRoot.dataset.view === 'source') return null

    const s = window.getSelection()
    if (!s || s.isCollapsed || s.rangeCount === 0) return null

    const range = s.getRangeAt(0)
    const node = range.commonAncestorContainer
    const el = node && (node.nodeType === 1 ? node : node.parentElement)
    if (el && el.closest && el.closest('.ai-bar, .ai-panel')) return null
    if (el && el.closest && el.closest('input, textarea')) return null

    const rawText = extractRangeCleanText(range, s.toString())
    const text = String(rawText || '').replace(/\u00a0/g, ' ').trim()
    if (text.length < MIN_LEN) return null

    const rects = range.getClientRects()
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
    if (!rect || (!rect.width && !rect.height)) return null

    return { text: text.slice(0, MAX_LEN), rect }
  }

  function refreshBar () {
    const sel = readSelection()
    if (!sel) { hideBar(); return }
    current = sel
    barUserPos = null
    bar.hidden = false
    placeBar(sel.rect)
  }

  function hideBar () {
    bar.hidden = true
    barDrag = null
    barUserPos = null
    bar.classList.remove('dragging')
    if (askOpen) {
      askOpen = false
      bar.classList.remove('has-ask')
      askRow.hidden = true
    }
    pendingQuestion = ''
  }

  function placeBar (rect) {
    const bw = bar.offsetWidth || 180
    const bh = bar.offsetHeight || 32
    let left = rect.left + rect.width / 2 - bw / 2
    left = clamp(left, 6, Math.max(6, window.innerWidth - bw - 6))
    let top = rect.top - bh - 8
    if (top < 6) top = rect.bottom + 8
    top = clamp(top, 6, Math.max(6, window.innerHeight - bh - 6))
    bar.style.left = Math.round(left) + 'px'
    bar.style.top = Math.round(top) + 'px'
  }

  const NO_RECT = { left: 40, top: 40, bottom: 60, width: 0, height: 0 }

  async function run (action, text, rect, question) {
    const body = String(text != null ? text : (current && current.text) || '')
    if (!body) return
    const q = action === 'ask' ? String(question || '').trim() : ''
    if (action === 'ask' && !q) return
    const anchor = rect || (current && current.rect) || NO_RECT
    hideBar()

    await api.overlayOpenCard({
      action,
      text: body,
      question: q,
      canInsert: typeof window.__aiInsertText === 'function',
      rect: {
        x: Math.round(anchor.left || 0),
        y: Math.round(anchor.top || 0),
        w: Math.round(anchor.width || 0),
        h: Math.round(anchor.height || 0),
        bottom: Math.round(anchor.bottom != null ? anchor.bottom : ((anchor.top || 0) + (anchor.height || 0)))
      }
    })
  }

  // ---------------------------------------------------------------- 事件
  bar.addEventListener('mousedown', (e) => {
    if (e.target && e.target.closest && e.target.closest('input, textarea')) {
      e.stopPropagation()
      return
    }
    e.preventDefault()
    e.stopPropagation()
  })

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (e.target.closest('button, input, textarea, select')) return
    if (e.pointerType !== 'mouse' && !e.target.closest('.ai-bar-grip')) return

    const r = bar.getBoundingClientRect()
    const curLeft = parseFloat(bar.style.left)
    const curTop = parseFloat(bar.style.top)
    const baseLeft = Number.isFinite(curLeft) ? curLeft : r.left
    const baseTop = Number.isFinite(curTop) ? curTop : r.top
    barDrag = { id: e.pointerId, dx: e.clientX - baseLeft, dy: e.clientY - baseTop, moved: false }
    try { bar.setPointerCapture(e.pointerId) } catch (_) {}
    bar.classList.add('dragging')
    e.preventDefault()
  })

  bar.addEventListener('pointermove', (e) => {
    if (!barDrag || e.pointerId !== barDrag.id) return
    const nx = e.clientX - barDrag.dx
    const ny = e.clientY - barDrag.dy
    if (!barDrag.moved) {
      const cx = parseFloat(bar.style.left) || 0
      const cy = parseFloat(bar.style.top) || 0
      if (Math.hypot(nx - cx, ny - cy) < 3) return
      barDrag.moved = true
    }
    setBarPos(nx, ny)
  })

  function endBarDrag (e) {
    if (!barDrag || (e && e.pointerId != null && e.pointerId !== barDrag.id)) return
    const cur = barDrag
    barDrag = null
    bar.classList.remove('dragging')
    const pid = (e && e.pointerId != null) ? e.pointerId : cur.id
    if (pid != null) {
      try { bar.releasePointerCapture(pid) } catch (_) {}
    }
    if (!cur.moved) return
    barUserPos = {
      x: parseFloat(bar.style.left) || 0,
      y: parseFloat(bar.style.top) || 0
    }
  }

  bar.addEventListener('pointerup', endBarDrag)
  bar.addEventListener('pointercancel', endBarDrag)

  bar.addEventListener('input', (e) => {
    if (e.target !== askInput) return
    askSend.disabled = !String(askInput.value || '').trim()
  })

  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === askInput) {
      e.preventDefault()
      e.stopPropagation()
      sendAsk()
    }
  })

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]')
    if (!btn) return
    e.preventDefault()
    e.stopPropagation()
    const act = btn.dataset.act
    if (act === 'ask') { setAskOpen(!askOpen); return }
    if (act === 'askSend') { sendAsk(); return }
    if (act === 'copyText') { copySelected(btn); return }
    if (!LABELS[act] || act === 'ask') return
    void run(act, current && current.text, current && current.rect)
  })

  document.addEventListener('mouseup', (e) => {
    if (e.target.closest && e.target.closest('.ai-bar')) return
    clearTimeout(hideTimer)
    hideTimer = setTimeout(refreshBar, 0)
  }, true)

  document.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('.ai-bar')) return
    hideBar()
    if (typeof api.overlayDismissUnpinned === 'function') {
      void api.overlayDismissUnpinned()
    }
  }, true)

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.shiftKey) {
      clearTimeout(hideTimer)
      hideTimer = setTimeout(refreshBar, 0)
    }
  }, true)

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!bar.hidden) {
      e.stopPropagation()
      if (askOpen) { setAskOpen(false); return }
      hideBar()
    }
  }, true)

  document.addEventListener('scroll', hideBar, true)
  window.addEventListener('blur', () => {
    endBarDrag()
    hideBar()
  })
  window.addEventListener('resize', hideBar)
})()
