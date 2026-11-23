'use strict'

/**
 * AI 供应商配置与流式对话服务（API Key 加密存储、模型列表拉取、SSE 流式问答与看门狗）。
 */

const { randomUUID } = require('crypto')
const { defaultAi } = require('../lib/migrations')
const { createWatchdog, describeTimeout } = require('../lib/watchdog')
const secretCodec = require('../lib/secret-codec')

function envMs (name, fallback) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 1000 ? Math.round(n) : fallback
}

const AI_IDLE_MS = envMs('STICKY_AI_IDLE_MS', 45000)
const AI_TOTAL_MS = envMs('STICKY_AI_TOTAL_MS', 180000)

const AI_ACTIONS = {
  search: {
    label: 'AI 搜索',
    system: [
      '你是一个检索式问答助手。用户会给你一个关键词或一句话，请据此给出准确、结构化的回答。',
      '格式：先用 1-2 句话给出结论，再用「- 」列出 2-4 条关键事实（数字、时间、人物、版本号等）。',
      '不确定的内容必须明说「不确定」，不要编造来源或链接。',
      '用简体中文回答，总长控制在 320 字以内。'
    ].join('\n')
  },
  explain: {
    label: '解释',
    system: [
      '你是一个耐心的讲解者。用户会选中一段文字，请解释它。',
      '先一句话说明它是什么，再拆解关键概念与因果关系，必要时给一个具体例子。',
      '如果原文是外文，先给中文释义再解释；不要复述原文。',
      '用简体中文，总长控制在 350 字以内。'
    ].join('\n')
  },
  translate: {
    label: '翻译',
    system: [
      '你是专业翻译。判断输入语言：中文翻译成英文，其他语言翻译成简体中文。',
      '只输出译文，不要解释、不要加引号、不要加任何前后缀。',
      '保留原有的换行、编号和列表结构。'
    ].join('\n')
  },
  ask: {
    label: '向 AI 提问',
    system: [
      '你是问答助手。用户会给你一段「选中内容」和一个「问题」，请结合选中内容回答问题。',
      '如果问题与选中内容无关，就直接按问题本身回答，不要强行关联、也不要抱怨内容无关。',
      '先给结论，再给必要的解释或步骤；涉及代码时用 Markdown 代码块；涉及公式时使用标准 LaTeX（行内 $...$，独立公式 $$...$$）。',
      '不确定的内容必须明说「不确定」，不要编造来源或事实。',
      '用简体中文回答，总长控制在 400 字以内。'
    ].join('\n')
  },
  followup: {
    label: '追问',
    system: [
      '你是上下文问答助手。用户基于先前选中的内容和历史问答继续追问，请结合上下文直接、准确地回答最新问题。',
      '涉及数学、物理或化学公式时请使用标准 LaTeX（行内 $...$，独立公式 $$...$$）；涉及代码时用 Markdown 代码块。',
      '不确定的内容必须明说「不确定」，不要编造来源或事实。',
      '用简体中文回答，清晰简洁。'
    ].join('\n')
  }
}

function maskKey (key) {
  const k = String(key || '')
  if (!k) return ''
  if (k.length <= 8) return '••••••'
  return k.slice(0, 3) + '••••••' + k.slice(-4)
}

function normalizeBaseUrl (input) {
  let u = String(input || '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  u = u.replace(/\/+$/, '')
  u = u.replace(/\/(chat\/completions|completions|models)$/i, '')
  return u
}

function endpointCandidates (base, p) {
  const list = [base + p]
  if (!/\/v\d+$/i.test(base)) list.push(base + '/v1' + p)
  return list
}

function authHeaders (key, extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {})
  if (key) h.Authorization = 'Bearer ' + key
  return h
}

async function httpText (url, opts, timeoutMs = 20000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }))
    const text = await res.text()
    return { ok: res.ok, status: res.status, text }
  } finally {
    clearTimeout(timer)
  }
}

function extractModels (json) {
  const arr = Array.isArray(json) ? json
    : Array.isArray(json && json.data) ? json.data
      : Array.isArray(json && json.models) ? json.models
        : null
  if (!arr) return []
  const out = []
  const seen = new Set()
  for (const it of arr) {
    let id = ''
    if (typeof it === 'string') id = it
    else if (it && typeof it === 'object') id = it.id || it.name || it.model || it.slug || ''
    id = String(id).replace(/^models\//, '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

async function fetchModelList (baseUrl, apiKey) {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) return { error: '请先填写 Base URL' }
  if (!/^https?:\/\/[^/\s]+/i.test(base)) return { error: 'Base URL 格式不正确' }

  let lastErr = ''
  for (const url of endpointCandidates(base, '/models')) {
    try {
      const { ok, status, text } = await httpText(url, { headers: authHeaders(apiKey) }, 15000)
      if (!ok) {
        lastErr = `HTTP ${status} ${String(text).slice(0, 200)}`
        if (status === 401 || status === 403) break
        continue
      }
      let json = null
      try { json = JSON.parse(text) } catch (_) { lastErr = '返回不是合法 JSON'; continue }
      const models = extractModels(json)
      if (models.length) return { models, endpoint: url }
      lastErr = '返回里没有可用的模型列表'
    } catch (err) {
      lastErr = err.name === 'AbortError' ? '请求超时（15s）' : err.message
    }
  }
  return { error: lastErr || '拉取失败' }
}

function sanitizeHistory (history) {
  if (!Array.isArray(history)) return []
  const out = []
  for (const item of history) {
    if (!item || typeof item !== 'object') continue
    const role = item.role === 'user' || item.role === 'assistant' ? item.role : ''
    const content = typeof item.content === 'string' ? item.content.trim().slice(0, 6000) : ''
    if (!role || !content) continue
    out.push({ role, content })
  }
  return out.slice(-20)
}

function buildAiMessages (action, text, question, history) {
  const conf = AI_ACTIONS[action] || AI_ACTIONS.explain
  const prior = sanitizeHistory(history)
  if (action === 'followup' || prior.length > 0) {
    const msgs = [{ role: 'system', content: AI_ACTIONS.followup.system }]
    const cleanText = String(text || '').trim().slice(0, 6000)
    const turns = prior.map(m => ({ role: m.role, content: m.content }))
    if (cleanText) {
      if (turns.length === 0) {
        msgs.push({
          role: 'user',
          content: '【选中内容】\n' + cleanText + '\n\n【问题】\n' + String(question || '').trim()
        })
        return msgs
      }
      const firstUser = turns.find(m => m.role === 'user')
      if (!firstUser) {
        msgs.push({ role: 'user', content: '【选中内容】\n' + cleanText })
      } else if (!firstUser.content.includes(cleanText.slice(0, 40))) {
        firstUser.content = '【选中内容】\n' + cleanText + '\n\n' + firstUser.content
      }
    }
    for (const m of turns) msgs.push(m)
    const q = String(question || '').trim()
    if (q) msgs.push({ role: 'user', content: q })
    return msgs
  }
  const user = action === 'ask' && question
    ? '【选中内容】\n' + (text || '（无）') + '\n\n【问题】\n' + question
    : text
  return [
    { role: 'system', content: conf.system },
    { role: 'user', content: user }
  ]
}

function friendlyAiError (err) {
  const code = (err && err.cause && err.cause.code) || ''
  const msg = String((err && err.message) || err || '')
  if (/AbortError/i.test(msg)) return '已取消'
  if (/\b401\b|\b403\b/.test(msg)) return '鉴权失败（401/403），请检查 API Key'
  if (/\b404\b/.test(msg)) return '接口不存在（404），请确认 Base URL 是否正确（多数服务需要带 /v1）'
  if (/\b429\b/.test(msg)) return '请求过于频繁（429），请稍后再试或检查账户配额'
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return '连接被拒绝，请确认服务地址与端口是否正确'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ENOTFOUND|EAI_AGAIN/.test(msg)) return '域名解析失败，请检查 Base URL 拼写'
  if (/fetch failed|other side closed|socket hang up|network/i.test(msg)) return '网络不可达，请检查 Base URL 与网络连接'
  if (/没有返回内容/.test(msg)) return '模型没有返回内容，换个模型或缩短选中文本试试'
  return msg.slice(0, 300) || '请求失败'
}

function pickContent (json) {
  const c = json && json.choices && json.choices[0]
  const v = (c && ((c.delta && c.delta.content) || (c.message && c.message.content))) ||
    (json && json.delta && json.delta.text) ||
    (json && typeof json.content === 'string' ? json.content : '')
  if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : (x && x.text) || '')).join('')
  return typeof v === 'string' ? v : ''
}

async function streamChatAt (url, provider, messages, signal, onDelta) {
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: authHeaders(provider.apiKey, { Accept: 'text/event-stream' }),
    body: JSON.stringify({
      model: provider.defaultModel,
      messages,
      stream: true,
      temperature: 0.3
    })
  })

  if (!res.ok) {
    const t = await res.text().catch(() => '')
    const err = new Error(`HTTP ${res.status} ${String(t).slice(0, 300)}`)
    err.status = res.status
    throw err
  }

  const ctype = String(res.headers.get('content-type') || '')
  if (!/text\/event-stream/i.test(ctype) || !res.body) {
    const text = await res.text()
    let content = ''
    try { content = pickContent(JSON.parse(text)) } catch (_) { content = text }
    if (content) onDelta(content)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let got = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const chunks = buf.split(/\n\n/)
    buf = chunks.pop()
    for (const chunk of chunks) {
      for (const line of chunk.split(/\n/)) {
        const s = line.trim()
        if (!s.startsWith('data:')) continue
        const data = s.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let j
        try { j = JSON.parse(data) } catch (_) { continue }
        const d = pickContent(j)
        if (d) { got += d.length; onDelta(d) }
      }
    }
  }
  if (!got) throw new Error('模型没有返回内容')
}

async function streamChat ({ provider, messages, signal, onDelta }) {
  const base = normalizeBaseUrl(provider.baseUrl)
  let lastErr = null
  for (const url of endpointCandidates(base, '/chat/completions')) {
    try {
      return await streamChatAt(url, provider, messages, signal, onDelta)
    } catch (err) {
      if (signal.aborted) throw err
      lastErr = err
      if (!(err.status === 404 || err.status === 405)) throw err
    }
  }
  throw lastErr || new Error('请求失败')
}

/**
 * 创建 AI 服务领域实例。
 * @param {object} deps
 * @param {object} deps.safeStorage
 * @param {function():object} deps.getState
 * @param {function():void} deps.scheduleSave
 */
function createAiService ({ safeStorage, getState, scheduleSave }) {
  const aiRequests = new Map()

  function encryptApiKey (plain) {
    return secretCodec.encryptSecret(plain, safeStorage, {
      onError: (err) => console.warn('[ai] 加密 API Key 失败，降级存储:', err && err.message)
    })
  }

  function decryptApiKey (stored) {
    return secretCodec.decryptSecret(stored, safeStorage, {
      onError: (err) => console.warn('[ai] 解密 API Key 失败:', err && err.message)
    })
  }

  function protectStoredAiKeys () {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return
    let available = false
    try { available = safeStorage.isEncryptionAvailable() } catch (_) { available = false }
    const state = getState()
    if (!available || !state.ai || !Array.isArray(state.ai.providers)) return
    for (const p of state.ai.providers) {
      if (p && typeof p.apiKey === 'string' && p.apiKey && !secretCodec.isEncrypted(p.apiKey)) {
        p.apiKey = encryptApiKey(p.apiKey)
      }
    }
  }

  function aiPublic () {
    const ai = getState().ai || defaultAi()
    return {
      activeId: ai.activeId,
      providers: ai.providers.map(p => {
        const plainKey = decryptApiKey(p.apiKey)
        return {
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          hasKey: !!plainKey,
          keyHint: maskKey(plainKey),
          models: p.models,
          defaultModel: p.defaultModel,
          updatedAt: p.updatedAt
        }
      })
    }
  }

  function registerIpc (ipcMain) {
    ipcMain.handle('ai:config', () => aiPublic())

    ipcMain.handle('ai:provider-save', (_e, payload) => {
      const p = payload || {}
      const baseUrl = normalizeBaseUrl(p.baseUrl)
      if (!baseUrl) return { error: '请填写 Base URL' }
      if (!/^https?:\/\/[^/\s]+/i.test(baseUrl)) return { error: 'Base URL 格式不正确' }

      const state = getState()
      const ai = state.ai || (state.ai = defaultAi())
      let item = p.id ? ai.providers.find(x => x.id === p.id) : null
      if (!item) {
        item = { id: randomUUID(), apiKey: '', createdAt: Date.now() }
        ai.providers.push(item)
      }
      let host = baseUrl
      try { host = new URL(baseUrl).host } catch (_) {}
      item.name = String(p.name || '').trim().slice(0, 60) || host || 'AI 供应商'
      item.baseUrl = baseUrl
      if (typeof p.apiKey === 'string' && p.apiKey.trim()) item.apiKey = encryptApiKey(p.apiKey.trim())
      if (Array.isArray(p.models)) item.models = p.models.filter(m => typeof m === 'string').slice(0, 400)
      if (typeof p.defaultModel === 'string') item.defaultModel = p.defaultModel.trim()
      item.updatedAt = Date.now()

      if (p.activate || !ai.activeId || !ai.providers.some(x => x.id === ai.activeId)) {
        ai.activeId = item.id
      }
      scheduleSave()
      return { ok: true, id: item.id, config: aiPublic() }
    })

    ipcMain.handle('ai:provider-delete', (_e, id) => {
      const state = getState()
      const ai = state.ai || defaultAi()
      const idx = ai.providers.findIndex(p => p.id === id)
      if (idx >= 0) ai.providers.splice(idx, 1)
      if (ai.activeId === id) ai.activeId = ai.providers[0] ? ai.providers[0].id : ''
      state.ai = ai
      scheduleSave()
      return { ok: true, config: aiPublic() }
    })

    ipcMain.handle('ai:provider-activate', (_e, id) => {
      const ai = getState().ai || defaultAi()
      if (ai.providers.some(p => p.id === id)) {
        ai.activeId = id
        scheduleSave()
      }
      return { ok: true, config: aiPublic() }
    })

    ipcMain.handle('ai:models', async (_e, payload) => {
      const p = payload || {}
      const known = p.id ? (getState().ai || defaultAi()).providers.find(x => x.id === p.id) : null
      const baseUrl = p.baseUrl || (known && known.baseUrl) || ''
      let apiKey = String(p.apiKey || '').trim()
      if (!apiKey && known) apiKey = decryptApiKey(known.apiKey)
      return fetchModelList(baseUrl, apiKey)
    })

    ipcMain.handle('ai:ask', async (e, payload) => {
      const req = payload || {}
      const requestId = String(req.requestId || '').trim() || randomUUID()
      let targetWc = e.sender
      const send = (type, data) => {
        if (targetWc && !targetWc.isDestroyed()) {
          targetWc.send('ai:event', Object.assign({ requestId, type }, data || {}))
        }
      }

      const ai = getState().ai || defaultAi()
      const provider = req.providerId
        ? ai.providers.find(p => p.id === req.providerId)
        : (ai.providers.find(p => p.id === ai.activeId) || ai.providers[0])

      if (!provider) { send('error', { error: '还没有配置 AI 供应商，请到便签中心添加' }); return { ok: false } }
      const plainKey = decryptApiKey(provider.apiKey)
      if (!plainKey) { send('error', { error: `供应商「${provider.name}」缺少 API Key` }); return { ok: false } }
      if (!provider.defaultModel) { send('error', { error: `供应商「${provider.name}」还没有选择默认模型` }); return { ok: false } }

      const text = String(req.text || '').trim().slice(0, 6000)
      const action = AI_ACTIONS[req.action] ? req.action : 'explain'
      const question = (action === 'ask' || action === 'followup')
        ? String(req.question || '').trim().slice(0, 2000)
        : ''
      const history = sanitizeHistory(req.history)

      if (!text && history.length === 0) { send('error', { error: '没有选中文本' }); return { ok: false } }
      if ((action === 'ask' || action === 'followup') && !question) {
        send('error', { error: '请先输入要问的问题' })
        return { ok: false }
      }

      send('start', { action, model: provider.defaultModel, provider: provider.name })

      const prevEntry = aiRequests.get(requestId)
      if (prevEntry && prevEntry.ctl) {
        try { prevEntry.ctl.abort() } catch (_) {}
      }
      const ctl = new AbortController()
      const entry = {
        ctl,
        setTarget: (nextWc) => { targetWc = nextWc },
        getTarget: () => targetWc
      }
      aiRequests.set(requestId, entry)

      let timeoutReason = ''
      const wd = createWatchdog({
        idleMs: AI_IDLE_MS,
        totalMs: AI_TOTAL_MS,
        onTimeout: (reason) => { timeoutReason = reason; ctl.abort() }
      })
      wd.start()
      try {
        await streamChat({
          provider: Object.assign({}, provider, { apiKey: plainKey }),
          messages: buildAiMessages(action, text, question, history),
          signal: ctl.signal,
          onDelta: (delta) => { wd.touch(); send('delta', { delta }) }
        })
        wd.stop()
        send('done', {})
      } catch (err) {
        wd.stop()
        if (timeoutReason) send('error', { error: describeTimeout(timeoutReason, wd) })
        else if (ctl.signal.aborted) send('done', { aborted: true })
        else send('error', { error: friendlyAiError(err) })
      } finally {
        if (aiRequests.get(requestId) === entry) aiRequests.delete(requestId)
      }
      return { ok: true }
    })

    ipcMain.handle('ai:abort', (_e, requestId) => {
      const entry = aiRequests.get(requestId)
      if (entry && entry.ctl) { entry.ctl.abort(); aiRequests.delete(requestId) }
      return true
    })
  }

  function retargetRequest (requestId, nextWebContents) {
    const entry = aiRequests.get(requestId)
    if (!entry || !nextWebContents) return false
    entry.setTarget(nextWebContents)
    return true
  }

  function abortByWebContents (wc) {
    if (!wc) return 0
    let count = 0
    for (const [reqId, entry] of aiRequests) {
      if (entry && typeof entry.getTarget === 'function' && entry.getTarget() === wc) {
        try { entry.ctl.abort() } catch (_) {}
        aiRequests.delete(reqId)
        count++
      }
    }
    return count
  }

  // 仅供主进程内部模块（如文献翻译本地一次性代理）获取解密后的供应商凭据，严禁通过 IPC 暴露
  function getActiveProviderCredentials (providerId) {
    const ai = getState().ai || defaultAi()
    const list = Array.isArray(ai.providers) ? ai.providers : []
    if (list.length === 0) return null
    const targetId = providerId || ai.activeId
    const provider = list.find((p) => p && p.id === targetId) || list[0]
    if (!provider) return null
    const apiKey = decryptApiKey(provider.apiKey)
    return {
      id: provider.id,
      name: provider.name || '',
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      apiKey: apiKey || '',
      defaultModel: String(provider.defaultModel || (Array.isArray(provider.models) && provider.models[0]) || '').trim()
    }
  }

  return {
    encryptApiKey,
    decryptApiKey,
    protectStoredAiKeys,
    aiPublic,
    getActiveProviderCredentials,
    retargetRequest,
    abortByWebContents,
    registerIpc
  }
}

module.exports = { createAiService, buildAiMessages, AI_ACTIONS }
