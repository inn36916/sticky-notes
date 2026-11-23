'use strict'

/**
 * 系统级划词悬浮工具条 & 可多开独立回答窗口（同用 overlay.html）
 * - ?role=bar：浮动工具条（搜索 / 解释 / 翻译 / 提问 / 复制），点击后打开独立回答窗口
 * - ?role=card&id=<n>：独立回答窗口（流式渲染 / KaTeX / 多轮追问 / 窗内正文划词 / 可选「插入便签」）
 */
;(function () {
  const api = window.sticky
  const root = document.getElementById('root')
  if (!api || !root) return

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

  const LABELS = { search: 'AI 搜索', explain: '解释', translate: '翻译', ask: '向 AI 提问', followup: '追问' }
  /** 工具条上直接展示的动作（ask 走输入行，不在这里） */
  const BAR_ACTIONS = ['search', 'explain', 'translate']
  const MIN_SEL_LEN = 2
  const MAX_SEL_LEN = 6000
  const ICON = {
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2L14 14"/></svg>',
    explain: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.4a4.2 4.2 0 0 0-2.6 7.5c.4.3.6.7.6 1.2v.3h4v-.3c0-.5.2-.9.6-1.2A4.2 4.2 0 0 0 8 2.4Z"/><path d="M6.4 13.4h3.2"/></svg>',
    translate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 3.6h6.4M5 2v1.6M6.8 3.6c0 2.6-2 4.9-5 5.9"/><path d="M3.4 6.4c.7 1.6 2.2 2.8 4 3.3"/><path d="M8.6 13.4 11.5 6l2.9 7.4M9.7 11h3.6"/></svg>',
    ask: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9.2a1.8 1.8 0 0 1-1.8 1.8H5.6L2 13.6V3.8A1.8 1.8 0 0 1 3.8 2h8.4A1.8 1.8 0 0 1 14 3.8Z"/><path d="M8 5.6v.1M8 7.4c0-.5.6-.7 1-.9.5-.3.6-1 .2-1.4-.5-.5-1.4-.3-1.6.3"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.2" y="2.2" width="8.6" height="8.6" rx="1.6"/><path d="M10.8 12.4v.6a1.6 1.6 0 0 1-1.6 1.6H3.8a1.6 1.6 0 0 1-1.6-1.6V7.4a1.6 1.6 0 0 1 1.6-1.6h.6"/></svg>'
  }

  let text = ''
  let session = null        // { text, turns: [{ id, action, question, raw, done, error, provider, model }], activeId }
  let mode = 'bar'
  let managedOverlay = false
  let canInsert = false
  let barShownFromHere = false
  let selTimer = 0
  let last = { w: 0, h: 0, mode: '' }
  let raf = 0
  let sizeTimer = 0
  let pinned = false
  let drag = null
  let dragSeq = 0
  let moveRaf = 0
  let moveTimer = 0
  let pendingMove = null
  /** 输入行是否展开（「向 AI 提问」） */
  let askOpen = false
  /** 输入行里已输入但还没发出的问题（收起/重渲染时保留，避免误点丢失） */
  let pendingQuestion = ''

  const escapeHtml = (window.StickyUtils && window.StickyUtils.escapeHtml) ||
    (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))

  function clearDragTimers () {
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0 }
    if (moveTimer) { clearTimeout(moveTimer); moveTimer = 0 }
  }

  function newReqId (prefix) {
    return (prefix || 'o') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }

  function activeTurn () {
    if (!session || !session.turns.length) return null
    return session.turns.find(t => t.id === session.activeId) || session.turns[session.turns.length - 1]
  }

  function isSessionBusy () {
    return !!(session && session.turns.some(t => !t.done && t.id))
  }

  function latestAnswerRaw () {
    if (!session) return ''
    for (let i = session.turns.length - 1; i >= 0; i--) {
      if (session.turns[i] && session.turns[i].raw) return session.turns[i].raw
    }
    return ''
  }

  function buildHistoryBefore (idx) {
    if (!session) return []
    const out = []
    for (let i = 0; i < idx && i < session.turns.length; i++) {
      const t = session.turns[i]
      if (!t || !t.raw) continue
      const userContent = i === 0
        ? (t.action === 'ask' && t.question
            ? '【选中内容】\n' + session.text + '\n\n【问题】\n' + t.question
            : (LABELS[t.action] || '解释') + '：\n' + session.text)
        : t.question
      if (!userContent) continue
      out.push({ role: 'user', content: userContent })
      out.push({ role: 'assistant', content: t.raw })
    }
    return out
  }

  // ---------------------------------------------------------------- 选区与 KaTeX 提取
  function extractRangeCleanText (range, rawFallback) {
    const ancestor = range && range.commonAncestorContainer
    const hostEl = ancestor && (ancestor.nodeType === 1 ? ancestor : ancestor.parentElement)
    const insideKatex = hostEl && hostEl.closest && hostEl.closest('.katex')
    if (insideKatex) {
      const ann = insideKatex.querySelector('annotation[encoding="application/x-tex"]')
      if (ann && ann.textContent) {
        const tex = ann.textContent.trim()
        return insideKatex.closest('.katex-display, .ai-math-block') ? `$$${tex}$$` : `$${tex}$`
      }
    }
    if (!hostEl || !hostEl.querySelector || !hostEl.querySelector('.katex, .katex-mathml, .ai-math-block')) {
      return String(rawFallback || '')
    }
    const frag = range.cloneContents()
    const walk = (node, out) => {
      for (const ch of (node.childNodes || [])) {
        if (ch.nodeType === 3) { out.push(ch.nodeValue || ''); continue }
        if (ch.nodeType !== 1) continue
        if (ch.classList) {
          if (ch.classList.contains('katex-mathml') ||
              ch.classList.contains('ai-thinking') ||
              ch.classList.contains('ai-caret')) continue
          if (ch.classList.contains('katex')) {
            const ann = ch.querySelector('annotation[encoding="application/x-tex"]')
            const tex = ann ? ann.textContent.trim() : ''
            if (tex) {
              const isBlk = !!(ch.closest && ch.closest('.katex-display, .ai-math-block'))
              out.push(isBlk ? `$$${tex}$$` : `$${tex}$`)
              continue
            }
          }
        }
        if (ch.tagName === 'BR') { out.push('\n'); continue }
        walk(ch, out)
        if (['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE'].includes(ch.tagName)) {
          out.push('\n')
        }
      }
    }
    const parts = []
    walk(frag, parts)
    return parts.join('')
  }

  function readBodySelection () {
    if (mode !== 'card' || drag) return null
    const active = document.activeElement
    if (active && active.matches && active.matches('input, textarea')) return null

    const s = window.getSelection()
    if (!s || s.isCollapsed || s.rangeCount === 0) return null
    const range = s.getRangeAt(0)
    const node = range.commonAncestorContainer
    const el = node && (node.nodeType === 1 ? node : node.parentElement)
    const body = root.querySelector('.ai-body')
    if (!body || !el || !body.contains(el)) return null
    if (el.closest && el.closest('input, textarea')) return null

    const rawText = extractRangeCleanText(range, s.toString())
    const clean = String(rawText || '').replace(/\u00a0/g, ' ').trim()
    if (clean.length < MIN_SEL_LEN) return null

    const rects = range.getClientRects()
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
    if (!rect || (!rect.width && !rect.height)) return null

    return {
      text: clean.slice(0, MAX_SEL_LEN),
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    }
  }

  function hideSelectionBar () {
    if (!barShownFromHere) return
    barShownFromHere = false
    if (typeof api.overlayHideBar === 'function') {
      void api.overlayHideBar()
    }
  }

  function refreshSelectionBar () {
    const sel = readBodySelection()
    if (!sel) {
      hideSelectionBar()
      return
    }
    if (typeof api.overlayShowBar === 'function') {
      barShownFromHere = true
      void api.overlayShowBar(sel)
    }
  }

  // ---------------------------------------------------------------- 尺寸上报
  /**
   * 窗口不可见时 requestAnimationFrame 不触发，用 setTimeout 兜底。
   */
  function reportSize (nextMode) {
    mode = nextMode || mode
    if (raf) cancelAnimationFrame(raf)
    clearTimeout(sizeTimer)
    const fire = () => {
      raf = 0
      sizeTimer = 0
      const r = root.getBoundingClientRect()
      const w = Math.ceil(r.width) + 16
      const h = Math.ceil(r.height) + 16
      if (w === last.w && h === last.h && mode === last.mode) return
      last = { w, h, mode }
      api.overlaySize({ w, h, mode })
    }
    raf = requestAnimationFrame(fire)
    sizeTimer = setTimeout(fire, 60)
  }

  // ---------------------------------------------------------------- 工具条
  function renderBar () {
    root.innerHTML = `
      <div class="ai-bar${askOpen ? ' has-ask' : ''}">
        <span class="ai-grip ai-bar-grip" title="按住拖动"><i></i><i></i><i></i><i></i><i></i><i></i></span>
        ${BAR_ACTIONS.map((k) =>
          `<button type="button" data-act="${k}" title="${LABELS[k]}">${ICON[k]}<span>${LABELS[k]}</span></button>`
        ).join('')}
        <span class="ai-bar-sep"></span>
        <button type="button" data-act="ask" title="${LABELS.ask}">${ICON.ask}<span>提问</span></button>
        <button type="button" data-act="copyText" title="复制选中的文字">${ICON.copy}<span>复制</span></button>
        <button type="button" class="ov-x" data-act="close" title="关闭">✕</button>
        <div class="ai-ask"${askOpen ? '' : ' hidden'}>
          <input type="text" id="askInput" placeholder="就选中的内容向 AI 提问…" maxlength="2000" />
          <button type="button" data-act="askSend" disabled>发送</button>
        </div>
      </div>`
    reportSize('bar')
    if (askOpen) {
      const input = root.querySelector('#askInput')
      if (input) input.value = pendingQuestion
      focusAsk()
    }
  }

  /** 展开/收起输入行；收起时保留已输入的内容，避免误点丢失 */
  async function focusAsk () {
    try { await api.overlayFocus() } catch (_) {}
    const input = root.querySelector('#askInput')
    if (input) {
      input.focus()
      const n = input.value.length
      try { input.setSelectionRange(n, n) } catch (_) {}
    }
  }

  function setAskOpen (on) {
    if (askOpen === on) {
      if (on) focusAsk()
      return
    }
    const input = root.querySelector('#askInput')
    if (input) pendingQuestion = input.value
    askOpen = on
    const bar = root.querySelector('.ai-bar')
    const row = root.querySelector('.ai-ask')
    if (bar) bar.classList.toggle('has-ask', on)
    if (row) {
      row.hidden = !on
      const inputNow = row.querySelector('input')
      if (inputNow) {
        if (on) inputNow.value = pendingQuestion
        const send = row.querySelector('[data-act="askSend"]')
        if (send) send.disabled = !(on && pendingQuestion.trim())
      }
    }
    reportSize('bar')
    if (on) focusAsk()
  }

  // ---------------------------------------------------------------- 结果卡片
  function renderCard (action) {
    const pinTitle = pinned ? '取消置顶' : '窗口置顶（始终保持在最前）'
    root.innerHTML = `
      <div class="ai-panel" data-busy="1">
        <header>
          <span class="ai-grip" title="按住拖动"><i></i><i></i><i></i><i></i><i></i><i></i></span>
          <span class="ai-title">${LABELS[action] || action}</span>
          <span class="ai-meta">生成中…</span>
          <button class="ai-pin" type="button" data-a="pin" data-on="${pinned ? '1' : '0'}" aria-pressed="${pinned ? 'true' : 'false'}" title="${pinTitle}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 2.4h4l-.7 3.3 2.4 2.4v1.2H4.3V8.1l2.4-2.4L6 2.4Z"/><path d="M8 9.3v4.3"/>
            </svg>
          </button>
          <button class="ai-close" type="button" title="关闭">✕</button>
        </header>
        <div class="ai-body"><div class="ai-thinking"><i></i><i></i><i></i></div></div>
        <div class="ai-followup">
          <input type="text" class="ai-followup-input" placeholder="继续追问…" maxlength="2000" />
          <button type="button" class="ai-followup-send" data-a="followup" disabled>追问</button>
        </div>
        <footer>
          <button type="button" data-a="copy" disabled>复制</button>
          <button type="button" data-a="regen">重新生成</button>
          <button type="button" data-a="insert"${canInsert ? '' : ' hidden'} disabled>插入便签</button>
          <span class="ov-grow"></span>
          <button type="button" data-a="stop" class="ai-stop">停止</button>
        </footer>
      </div>`
    reportSize('card')
  }

  function renderTurnBody (t, isFollow) {
    const qCls = isFollow ? 'ai-q ai-q-follow' : 'ai-q'
    const qHtml = ((isFollow || t.action === 'ask') && t.question)
      ? '<div class="' + qCls + '">' + escapeHtml(t.question) + '</div>'
      : ''
    if (t.error) {
      return qHtml + '<div class="ai-err">' + escapeHtml(t.error) + '</div>'
    }
    if (t.raw) {
      const html = typeof window.renderAiMarkdown === 'function'
        ? window.renderAiMarkdown(t.raw)
        : '<p>' + escapeHtml(t.raw) + '</p>'
      return qHtml + html + (t.done ? '' : '<span class="ai-caret"></span>')
    }
    return qHtml + '<div class="ai-thinking"><i></i><i></i><i></i></div>'
  }

  function syncFollowupButton () {
    const input = root.querySelector('.ai-followup-input')
    const btn = root.querySelector('.ai-followup-send')
    if (btn) btn.disabled = isSessionBusy() || !(input && input.value.trim())
  }

  function paint () {
    if (!session || !session.turns.length) return
    const panelEl = root.querySelector('.ai-panel')
    const body = root.querySelector('.ai-body')
    const meta = root.querySelector('.ai-meta')
    const copy = root.querySelector('[data-a="copy"]')
    const insert = root.querySelector('[data-a="insert"]')
    const stop = root.querySelector('[data-a="stop"]')
    const regen = root.querySelector('[data-a="regen"]')
    if (!body) return

    const cur = activeTurn()
    const busy = isSessionBusy()
    if (panelEl) panelEl.dataset.busy = busy ? '1' : '0'
    if (meta) {
      meta.textContent = (cur && [cur.provider, cur.model].filter(Boolean).join(' · ')) || (busy ? '生成中…' : '')
    }

    body.innerHTML = session.turns.map((t, i) => {
      const inner = renderTurnBody(t, i > 0)
      return i === 0 ? inner : '<div class="ai-turn">' + inner + '</div>'
    }).join('')
    body.scrollTop = body.scrollHeight

    const hasAnswer = !!latestAnswerRaw()
    if (copy) copy.disabled = !hasAnswer
    if (insert) {
      insert.hidden = !canInsert
      insert.disabled = !hasAnswer
    }
    if (regen) regen.disabled = busy
    if (stop) stop.hidden = !busy
    syncFollowupButton()
    reportSize('card')
  }

  async function copySelected (btn) {
    if (!text) return
    const label = btn.querySelector('span')
    let r = null
    try {
      r = await api.copyText(text)
    } catch (err) {
      r = { ok: false, error: (err && err.message) || String(err) }
    }
    const ok = !!(r && r.ok)
    if (label) label.textContent = ok ? '已复制' : '复制失败'
    if (ok) btn.removeAttribute('title')
    else btn.title = (r && r.error) || '写入剪贴板失败，请重试'
    setTimeout(() => {
      if (label) label.textContent = '复制'
      btn.title = '复制选中的文字'
    }, 1400)
  }

  // ---------------------------------------------------------------- 动作
  async function run (action, question) {
    if (!text) return
    const q = action === 'ask' ? String(question || '').trim() : ''
    if (action === 'ask' && !q) return

    // 在由 globalOverlay 托管的工具条内触发时，直接新开独立回答窗
    if (mode === 'bar' && managedOverlay && typeof api.overlayOpenCard === 'function') {
      askOpen = false
      pendingQuestion = ''
      await api.overlayOpenCard({ action, text, question: q })
      return
    }

    const prev = activeTurn()
    if (prev && !prev.done && prev.id) api.aiAbort(prev.id)

    const id = newReqId('o')
    const turn = { id, action, question: q, raw: '', done: false, error: '', provider: '', model: '' }
    session = { text, turns: [turn], activeId: id }
    askOpen = false
    pendingQuestion = ''
    renderCard(action)
    paint()

    try {
      await api.aiAsk({ requestId: id, action, text, question: q })
    } catch (err) {
      if (!session || turn !== session.turns.find(x => x.id === id)) return
      turn.error = '请求失败：' + ((err && err.message) || err)
      turn.done = true
      paint()
    }
  }

  async function sendFollowup (presetQuestion) {
    if (!session || isSessionBusy()) return
    hideSelectionBar()
    const input = root.querySelector('.ai-followup-input')
    const q = String(presetQuestion != null ? presetQuestion : (input ? input.value : '')).trim()
    if (!q) return
    if (presetQuestion == null && input) input.value = ''

    const history = buildHistoryBefore(session.turns.length)
    const id = newReqId('f')
    const turn = { id, action: 'followup', question: q, raw: '', done: false, error: '', provider: '', model: '' }
    session.turns.push(turn)
    session.activeId = id
    paint()

    try {
      await api.aiAsk({ requestId: id, action: 'followup', text: session.text, question: q, history })
    } catch (err) {
      if (!session || !session.turns.includes(turn)) return
      turn.error = '请求失败：' + ((err && err.message) || err)
      turn.done = true
      paint()
    }
  }

  async function regenerate () {
    if (!session || !session.turns.length || isSessionBusy()) return
    hideSelectionBar()
    if (session.turns.length === 1) {
      const t0 = session.turns[0]
      await run(t0.action, t0.question)
      return
    }
    const lastTurn = session.turns.pop()
    await sendFollowup(lastTurn.question)
  }

  api.onAiEvent((ev) => {
    if (!ev || !session) return
    const t = session.turns.find(item => item.id === ev.requestId)
    if (!t) return
    if (ev.type === 'start') {
      t.provider = ev.provider || ''
      t.model = ev.model || ''
      paint()
      return
    }
    if (ev.type === 'delta') { t.raw += ev.delta || ''; paint(); return }
    if (ev.type === 'error') { t.error = ev.error || '请求失败'; t.done = true; paint(); return }
    if (ev.type === 'done') {
      t.done = true
      if (!t.raw && !t.error) t.error = ev.aborted ? '已取消' : '没有返回内容'
      paint()
    }
  })

  api.onOverlayShow((payload) => {
    const prev = activeTurn()
    if (prev && !prev.done && prev.id) api.aiAbort(prev.id)
    clearDragTimers()
    session = null
    pinned = false
    drag = null
    pendingMove = null
    canInsert = false
    barShownFromHere = false
    managedOverlay = !!(payload && payload.managed)
    last = { w: 0, h: 0, mode: '' }
    askOpen = false
    pendingQuestion = ''
    text = String((payload && payload.text) || '')
    renderBar()
  })

  if (typeof api.onOverlayShowCard === 'function') {
    api.onOverlayShowCard((payload) => {
      const p = (payload && typeof payload === 'object') ? payload : {}
      const prev = activeTurn()
      const nextId = String(p.requestId || newReqId('c'))
      if (prev && !prev.done && prev.id && prev.id !== nextId) {
        api.aiAbort(prev.id)
      }
      clearDragTimers()
      drag = null
      pendingMove = null
      managedOverlay = true
      barShownFromHere = false
      canInsert = !!p.canInsert
      last = { w: 0, h: 0, mode: '' }
      askOpen = false
      pendingQuestion = ''
      text = String(p.text || '')
      pinned = !!p.pinned
      mode = 'card'

      if (p.autoRun) {
        session = null
        void run(p.action || 'explain', p.question || '')
        return
      }

      const turns = Array.isArray(p.turns) && p.turns.length
        ? p.turns.map((t, i) => ({
            id: String((t && t.id) || (i === 0 ? nextId : newReqId('c'))),
            action: (t && t.action) || (i === 0 ? (p.action || 'explain') : 'followup'),
            question: String((t && t.question) || ''),
            raw: String((t && t.raw) || ''),
            done: t ? !!t.done : !!p.done,
            error: String((t && t.error) || ''),
            provider: String((t && t.provider) || ''),
            model: String((t && t.model) || '')
          }))
        : [{
            id: nextId,
            action: p.action || 'explain',
            question: String(p.question || ''),
            raw: String(p.raw || ''),
            done: !!p.done,
            error: String(p.error || ''),
            provider: String(p.provider || ''),
            model: String(p.model || '')
          }]

      session = {
        text,
        turns,
        activeId: nextId
      }
      renderCard(turns[0].action)
      paint()
    })
  }

  root.addEventListener('mousedown', (e) => {
    // 1) 输入框必须放行，否则无法聚焦与定位光标
    if (e.target && e.target.closest && e.target.closest('input, textarea')) {
      if (e.target.classList && e.target.classList.contains('ai-followup-input')) {
        try { void api.overlayFocus() } catch (_) {}
      }
      e.stopPropagation()
      return
    }
    // 2) 回答正文必须放行，支持鼠标划选与双击选词；先收起旧划词工具条
    if (e.target && e.target.closest && e.target.closest('.ai-body')) {
      hideSelectionBar()
      e.stopPropagation()
      return
    }
    // 3) 头部 / 抓手 / 按钮区保持不触发文字选中
    e.preventDefault()
    e.stopPropagation()
  })

  root.addEventListener('input', (e) => {
    if (!e.target) return
    if (e.target.id === 'askInput') {
      const send = root.querySelector('[data-act="askSend"]')
      if (send) send.disabled = !String(e.target.value || '').trim()
      return
    }
    if (e.target.classList && e.target.classList.contains('ai-followup-input')) {
      syncFollowupButton()
    }
  })

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    e.preventDefault()
    e.stopPropagation()

    const act = btn.dataset.act
    if (act === 'close') { api.overlayClose(); return }
    if (act === 'ask') { setAskOpen(!askOpen); return }
    if (act === 'askSend') {
      const input = root.querySelector('#askInput')
      void run('ask', input ? input.value : '')
      return
    }
    if (act === 'copyText') { copySelected(btn); return }
    if (act !== undefined && LABELS[act] && act !== 'ask') { void run(act); return }

    if (btn.classList.contains('ai-close')) {
      hideSelectionBar()
      const cur = activeTurn()
      if (cur && !cur.done && cur.id) api.aiAbort(cur.id)
      api.overlayClose()
      return
    }

    const a = btn.dataset.a
    if (a === 'followup') { void sendFollowup(); return }
    if (a === 'pin') {
      hideSelectionBar()
      pinned = !pinned
      btn.dataset.on = pinned ? '1' : '0'
      btn.setAttribute('aria-pressed', pinned ? 'true' : 'false')
      btn.title = pinned ? '取消置顶' : '窗口置顶（始终保持在最前）'
      api.overlayPin(pinned)
      return
    }
    if (a === 'regen') {
      void regenerate()
      return
    }
    const copyText = latestAnswerRaw()
    if (a === 'insert' && copyText && typeof api.overlayInsertToNote === 'function') {
      let r = null
      try { r = await api.overlayInsertToNote(copyText) } catch (err) {
        r = { ok: false, error: (err && err.message) || String(err) }
      }
      if (r && r.ok) {
        btn.textContent = '已插入'
        btn.removeAttribute('title')
      } else {
        btn.textContent = (r && r.error) ? r.error : '插入失败'
        btn.title = (r && r.error) || '原便签窗口可能已关闭'
      }
      setTimeout(() => { btn.textContent = '插入便签'; btn.removeAttribute('title') }, 1400)
      return
    }
    if (a === 'copy' && copyText) {
      let r = null
      try { r = await api.copyText(copyText) } catch (err) {
        r = { ok: false, error: (err && err.message) || String(err) }
      }
      if (r && r.ok) {
        btn.textContent = '已复制'
        btn.removeAttribute('title')
      } else {
        btn.textContent = '复制失败'
        btn.title = (r && r.error) || '写入剪贴板失败，请重试'
      }
      setTimeout(() => { btn.textContent = '复制'; btn.removeAttribute('title') }, 1400)
      return
    }
    const cur = activeTurn()
    if (a === 'stop' && cur && !cur.done) api.aiAbort(cur.id)
  })

  function setDraggingClass (on) {
    const box = root.querySelector('.ai-panel, .ai-bar')
    if (box) box.classList.toggle('dragging', !!on)
  }

  // ---------------------------------------------------------------- 拖动整个悬浮窗
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (e.target.closest('button, input, textarea, select, a, .ai-body')) return
    if (e.pointerType !== 'mouse' && !e.target.closest('header, .ai-bar-grip')) return

    hideSelectionBar()
    drag = {
      id: e.pointerId,
      dragId: ++dragSeq,
      cx: e.clientX,
      cy: e.clientY,
      sx: e.screenX,
      sy: e.screenY,
      moved: false
    }
    try { root.setPointerCapture(e.pointerId) } catch (_) {}
    setDraggingClass(true)
    api.overlayMove({ dragId: drag.dragId, phase: 'start' })
    e.preventDefault()
  })

  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return
    const dx = Math.round(e.screenX - drag.sx)
    const dy = Math.round(e.screenY - drag.sy)
    if (!drag.moved) {
      const cdist = Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy)
      if (Math.hypot(dx, dy) < 3 && cdist < 3) return
      drag.moved = true
    }
    pendingMove = { dragId: drag.dragId, dx, dy }
    if (!moveRaf) {
      const fire = () => {
        moveRaf = 0
        clearTimeout(moveTimer)
        moveTimer = 0
        if (pendingMove) api.overlayMove(pendingMove)
      }
      moveRaf = requestAnimationFrame(fire)
      moveTimer = setTimeout(fire, 40)
    }
  })

  function endDrag (e) {
    if (!drag || (e && e.pointerId != null && e.pointerId !== drag.id)) return
    const cur = drag
    const finalMove = pendingMove
    drag = null
    pendingMove = null
    clearDragTimers()
    setDraggingClass(false)
    const pid = (e && e.pointerId != null) ? e.pointerId : cur.id
    if (pid != null) {
      try { root.releasePointerCapture(pid) } catch (_) {}
    }
    if (cur.moved && finalMove) {
      api.overlayMove(Object.assign({}, finalMove, { end: true }))
    } else {
      api.overlayMove({ dragId: cur.dragId, phase: 'end', end: true })
    }
  }

  root.addEventListener('pointerup', endDrag)
  root.addEventListener('pointercancel', endDrag)
  window.addEventListener('blur', () => endDrag())
  window.addEventListener('focus', () => {
    if (mode === 'card' && barShownFromHere) barShownFromHere = false
  })

  // ---------------------------------------------------------------- 回答正文划词与干净复制
  document.addEventListener('mouseup', (e) => {
    if (mode !== 'card' || drag) return
    if (e.target && e.target.closest && e.target.closest('button, input, textarea')) return
    clearTimeout(selTimer)
    selTimer = setTimeout(refreshSelectionBar, 0)
  }, true)

  document.addEventListener('keyup', (e) => {
    if (mode !== 'card') return
    if (e.key === 'Shift' || e.shiftKey) {
      clearTimeout(selTimer)
      selTimer = setTimeout(refreshSelectionBar, 0)
    }
  }, true)

  document.addEventListener('selectionchange', () => {
    if (mode !== 'card' || !barShownFromHere) return
    const s = window.getSelection()
    if (!s || s.isCollapsed) hideSelectionBar()
  })

  root.addEventListener('scroll', () => {
    if (mode === 'card' && barShownFromHere) hideSelectionBar()
  }, true)

  document.addEventListener('copy', (e) => {
    if (mode !== 'card') return
    const s = window.getSelection()
    if (!s || s.isCollapsed || !s.rangeCount) return
    const range = s.getRangeAt(0)
    const body = root.querySelector('.ai-body')
    if (!body || !body.contains(range.commonAncestorContainer)) return
    const anc = range.commonAncestorContainer
    const hostEl = anc.nodeType === 1 ? anc : anc.parentElement
    const frag = range.cloneContents()
    const hasMath = !!(frag.querySelector && frag.querySelector('.katex, .katex-mathml, .ai-math-block')) ||
      !!(hostEl && hostEl.closest && hostEl.closest('.katex, .ai-math-block'))
    if (!hasMath) return
    const clean = extractRangeCleanText(range, s.toString())
    if (e.clipboardData) {
      e.preventDefault()
      e.clipboardData.setData('text/plain', clean)
    }
  })

  document.addEventListener('keydown', (e) => {
    const t = e.target
    if (t && t.id === 'askInput' && e.key === 'Enter') {
      e.preventDefault()
      void run('ask', t.value)
      return
    }
    if (t && t.classList && t.classList.contains('ai-followup-input') && e.key === 'Enter') {
      e.preventDefault()
      void sendFollowup()
      return
    }
    if (e.key !== 'Escape') return
    e.preventDefault()
    if (askOpen) { setAskOpen(false); return }
    if (mode === 'card' && barShownFromHere) {
      hideSelectionBar()
      return
    }
    if (mode === 'card') {
      const cur = activeTurn()
      if (cur && !cur.done && cur.id) api.aiAbort(cur.id)
    }
    api.overlayClose()
  })

  // 卡片高度会随流式输出和公式排版增长，用 ResizeObserver 兜住
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => reportSize(mode))
    ro.observe(root)
  }
})()
