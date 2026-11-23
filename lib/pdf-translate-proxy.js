'use strict'

const http = require('http')
const crypto = require('crypto')

const MAX_BODY_BYTES = 4 * 1024 * 1024 // 4 MB 单次请求体上限

// 上游不兼容时可安全剔除并按会话记住的可选采样/控制参数
const STRIPPABLE_PARAMS = [
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
  'stop',
  'seed'
]

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504])

/**
 * 规范化上游 Base URL 并限制仅允许 http/https 协议
 */
function normalizeProxyBaseUrl (raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) throw new Error('上游 API Base URL 不能为空')
  let parsed
  try {
    parsed = new URL(s)
  } catch (_) {
    throw new Error('上游 API Base URL 格式无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的协议: ${parsed.protocol}`)
  }
  return s
}

/**
 * 构建上游 chat/completions 候选端点列表（遇到 404 时按序降级尝试）
 */
function buildChatEndpointCandidates (rawBaseUrl) {
  const base = normalizeProxyBaseUrl(rawBaseUrl)
  if (/\/chat\/completions$/i.test(base)) return [base]
  // 若已包含 /v1、/v3 等版本段则直接拼接；否则优先尝试 /v1/chat/completions，再降级 /chat/completions
  if (/\/v\d+$/i.test(base)) return [`${base}/chat/completions`]
  return [`${base}/v1/chat/completions`, `${base}/chat/completions`]
}

/**
 * 使用 SHA-256 + timingSafeEqual 做常量时间 Bearer Token 校验
 */
function verifyBearerToken (headers, expectedToken) {
  if (!headers || !expectedToken) return false
  let provided = ''
  const auth = typeof headers.authorization === 'string' ? headers.authorization.trim() : ''
  if (/^Bearer\s+/i.test(auth)) {
    provided = auth.slice(auth.indexOf(' ') + 1).trim()
  } else if (typeof headers['x-api-key'] === 'string') {
    provided = headers['x-api-key'].trim()
  }
  if (!provided) return false
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest()
  const b = crypto.createHash('sha256').update(String(expectedToken), 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

/**
 * 从 HTTP 400 错误响应中识别不被上游接受的请求参数名
 */
function extractUnsupportedParams (errorBodyText, payloadKeys) {
  const found = []
  const presentSet = new Set(Array.isArray(payloadKeys) ? payloadKeys : [])
  const strippablePresent = STRIPPABLE_PARAMS.filter((p) => presentSet.has(p))
  if (strippablePresent.length === 0) return found

  const raw = String(errorBodyText || '')
  let errParam = ''
  let errMessage = raw
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.error && typeof parsed.error === 'object') {
      if (typeof parsed.error.param === 'string') errParam = parsed.error.param
      if (typeof parsed.error.message === 'string') errMessage = parsed.error.message
    } else if (parsed && typeof parsed.detail === 'string') {
      errMessage = parsed.detail
    }
  } catch (_) {}

  const unsupportedHint =
    /(unsupported|not\s+support(?:ed)?|unknown|unrecognized|invalid|not\s+allowed|extra_forbidden|unexpected|cannot\s+be\s+used|must\s+not\s+be|does\s+not\s+support|参数.*不支持|不支持.*参数)/i

  if (errParam && strippablePresent.includes(errParam) && unsupportedHint.test(errMessage || raw)) {
    found.push(errParam)
  }

  if (unsupportedHint.test(errMessage) || unsupportedHint.test(raw)) {
    const haystack = `${errMessage}\n${raw}`
    for (const key of strippablePresent) {
      if (found.includes(key)) continue
      const re = new RegExp(`(^|[^a-zA-Z0-9_])${key}([^a-zA-Z0-9_]|$)`, 'i')
      if (re.test(haystack)) found.push(key)
    }
  }
  return found
}

function sendJson (res, statusCode, bodyObj) {
  if (res.writableEnded || res.destroyed) return
  const buf = Buffer.from(JSON.stringify(bodyObj), 'utf8')
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store'
  })
  res.end(buf)
}

function sendOpenAiError (res, statusCode, message, type = 'invalid_request_error') {
  sendJson(res, statusCode, { error: { message: String(message || 'Proxy error'), type } })
}

function readRequestBody (req, maxBytes) {
  return new Promise((resolve, reject) => {
    const contentLen = Number(req.headers && req.headers['content-length'])
    if (Number.isFinite(contentLen) && contentLen > maxBytes) {
      const err = new Error('Request body too large')
      err.statusCode = 413
      reject(err)
      return
    }

    const chunks = []
    let total = 0
    let done = false

    const fail = (err) => {
      if (done) return
      done = true
      reject(err)
    }

    req.on('data', (chunk) => {
      if (done) return
      total += chunk.length
      if (total > maxBytes) {
        const err = new Error('Request body too large')
        err.statusCode = 413
        fail(err)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
  })
}

function abortableDelay (ms, signal) {
  if (ms <= 0) return Promise.resolve()
  if (signal && signal.aborted) return Promise.reject(new Error('Aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

function computeRetryDelayMs (response, attempt, baseMs, maxMs) {
  const retryAfter = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('retry-after')
    : null
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(maxMs, Math.max(50, Math.round(secs * 1000)))
    }
    const ts = Date.parse(retryAfter)
    if (Number.isFinite(ts)) {
      return Math.min(maxMs, Math.max(50, ts - Date.now()))
    }
  }
  return Math.min(maxMs, baseMs * Math.pow(2, attempt))
}

/**
 * 创建仅绑定 127.0.0.1 的一次性 Token 本地 OpenAI 兼容代理：
 * - 明文 API Key 仅留在主进程内存闭包中，绝不写入子进程参数/环境变量/磁盘
 * - 自动记住上游返回 400 不支持的参数并在同会话内剔除重试（AIdea 策略）
 * - 支持 429/5xx 瞬态重试及 SSE 流式/非流式透传
 */
async function createTranslationProxy ({
  provider,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = 60000,
  maxTransientRetries = 2,
  retryBaseMs = 400,
  maxRetryDelayMs = 5000,
  log,
  onEvent
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行时缺少 fetch 支持，无法启动本地翻译代理')
  }
  if (!provider || typeof provider !== 'object') {
    throw new Error('缺少可用的 AI 模型配置')
  }

  const endpointList = buildChatEndpointCandidates(provider.baseUrl)
  const upstreamKey = String(provider.apiKey || '').trim()
  const fallbackModel = String(provider.defaultModel || '').trim() || 'gpt-4o-mini'
  const token = 'stk-' + crypto.randomBytes(24).toString('hex')
  const droppedParams = new Set()
  const activeControllers = new Set()
  const sockets = new Set()
  const stats = {
    requests: 0,
    upstreamCalls: 0,
    droppedParams: [],
    retries400: 0,
    retriesTransient: 0
  }

  let closed = false
  let completedCalls = 0
  let inFlight = 0

  function emitEvent (ev) {
    try {
      if (typeof onEvent === 'function') onEvent(ev)
    } catch (_) {}
  }

  function formatErrorSnippet (rawText) {
    let msg = String(rawText || '').trim()
    if (!msg) return ''
    try {
      const parsed = JSON.parse(msg)
      if (parsed && parsed.error && typeof parsed.error.message === 'string') {
        msg = parsed.error.message
      } else if (parsed && typeof parsed.message === 'string') {
        msg = parsed.message
      }
    } catch (_) {}
    if (upstreamKey && upstreamKey.length >= 4) msg = msg.split(upstreamKey).join('[REDACTED]')
    msg = msg.split(token).join('[REDACTED]')
    return msg.replace(/\s+/g, ' ').trim().slice(0, 140)
  }

  function stripDroppedParams (obj) {
    const out = Object.assign({}, obj)
    for (const p of droppedParams) delete out[p]
    if (!out.model) out.model = fallbackModel
    return out
  }

  function linkSignal (controller) {
    activeControllers.add(controller)
    let onOuterAbort = null
    if (signal) {
      if (signal.aborted) controller.abort()
      else {
        onOuterAbort = () => controller.abort()
        signal.addEventListener('abort', onOuterAbort, { once: true })
      }
    }
    return () => {
      activeControllers.delete(controller)
      if (signal && onOuterAbort) signal.removeEventListener('abort', onOuterAbort)
    }
  }

  async function fetchWithTimeout (url, payloadObj, reqAbortSignal) {
    const controller = new AbortController()
    const unlinkOuter = linkSignal(controller)
    const onReqAbort = () => controller.abort()
    if (reqAbortSignal) {
      if (reqAbortSignal.aborted) controller.abort()
      else reqAbortSignal.addEventListener('abort', onReqAbort, { once: true })
    }
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (upstreamKey) headers.Authorization = `Bearer ${upstreamKey}`
      stats.upstreamCalls++
      return await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payloadObj),
        signal: controller.signal
      })
    } finally {
      if (timer) clearTimeout(timer)
      if (reqAbortSignal) reqAbortSignal.removeEventListener('abort', onReqAbort)
      unlinkOuter()
    }
  }

  async function callUpstreamWithFallback (initialPayload, reqAbortSignal) {
    let lastResponse = null
    let lastError = null

    for (let epIdx = 0; epIdx < endpointList.length; epIdx++) {
      const targetUrl = endpointList[epIdx]
      let transientAttempt = 0
      let fallback400Count = 0

      while (true) {
        if (closed || (reqAbortSignal && reqAbortSignal.aborted)) {
          throw new Error('请求已取消')
        }
        const cleanedPayload = stripDroppedParams(initialPayload)
        let upstreamRes
        try {
          upstreamRes = await fetchWithTimeout(targetUrl, cleanedPayload, reqAbortSignal)
        } catch (err) {
          lastError = err
          if (closed || (reqAbortSignal && reqAbortSignal.aborted)) throw err
          if (transientAttempt < maxTransientRetries) {
            transientAttempt++
            stats.retriesTransient++
            emitEvent({ type: 'retry', reason: 'transient', status: 0, attempt: transientAttempt })
            await abortableDelay(Math.min(maxRetryDelayMs, retryBaseMs * Math.pow(2, transientAttempt - 1)), signal)
            continue
          }
          break
        }

        // 若未带 /v1 的 Base URL 返回 404，尝试下一个候选端点
        if (upstreamRes.status === 404 && epIdx + 1 < endpointList.length) {
          lastResponse = upstreamRes
          try { await upstreamRes.body?.cancel?.() } catch (_) {}
          break
        }

        // 429 / 502 / 503 / 504 瞬态限流或网关错误：按 Retry-After 或退避重试
        if (TRANSIENT_STATUSES.has(upstreamRes.status) && transientAttempt < maxTransientRetries) {
          const delayMs = computeRetryDelayMs(upstreamRes, transientAttempt, retryBaseMs, maxRetryDelayMs)
          transientAttempt++
          stats.retriesTransient++
          emitEvent({ type: 'retry', reason: 'transient', status: upstreamRes.status, attempt: transientAttempt })
          try { await upstreamRes.body?.cancel?.() } catch (_) {}
          await abortableDelay(delayMs, signal)
          continue
        }

        // 400 参数不兼容：记录到会话级 droppedParams 并立即重试
        if (upstreamRes.status === 400 && fallback400Count < 4) {
          const errText = await upstreamRes.text().catch(() => '')
          const badParams = extractUnsupportedParams(errText, Object.keys(cleanedPayload))
          const newlyAdded = badParams.filter((p) => !droppedParams.has(p))
          if (newlyAdded.length > 0) {
            for (const p of newlyAdded) droppedParams.add(p)
            stats.droppedParams = Array.from(droppedParams)
            stats.retries400++
            fallback400Count++
            emitEvent({ type: 'retry', reason: '400-drop-params', dropped: newlyAdded.slice() })
            if (typeof log === 'function') {
              log(`proxy dropped unsupported params: ${newlyAdded.join(', ')}`)
            }
            continue
          }
          // 非参数兼容性 400，封装可重读响应返回给调用方
          return new Response(errText, {
            status: 400,
            headers: { 'content-type': upstreamRes.headers?.get?.('content-type') || 'application/json' }
          })
        }

        return upstreamRes
      }
    }

    if (lastResponse) return lastResponse
    throw lastError || new Error('上游 AI 请求失败')
  }

  async function forwardUpstreamResponse (res, upstreamRes, reqController, releaseFlight) {
    const contentType = upstreamRes.headers?.get?.('content-type') || 'application/json; charset=utf-8'
    const isSse = upstreamRes.ok && /text\/event-stream/i.test(contentType)

    if (isSse && upstreamRes.body && typeof upstreamRes.body.getReader === 'function') {
      completedCalls++
      emitEvent({ type: 'response', status: upstreamRes.status, completedCalls, inFlight })
      res.writeHead(upstreamRes.status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })
      const reader = upstreamRes.body.getReader()
      const onResClose = () => {
        if (!res.writableEnded) {
          try { reqController.abort() } catch (_) {}
          try { reader.cancel() } catch (_) {}
        }
      }
      res.on('close', onResClose)
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (res.writableEnded || res.destroyed) break
          const chunk = Buffer.from(value)
          if (!res.write(chunk)) {
            await new Promise((resolve) => res.once('drain', resolve))
          }
        }
      } finally {
        if (typeof releaseFlight === 'function') releaseFlight()
        res.removeListener('close', onResClose)
        if (!res.writableEnded && !res.destroyed) res.end()
      }
      return
    }

    const buf = Buffer.from(await upstreamRes.arrayBuffer())
    if (typeof releaseFlight === 'function') releaseFlight()
    if (upstreamRes.ok) {
      completedCalls++
      emitEvent({ type: 'response', status: upstreamRes.status, completedCalls, inFlight })
    } else {
      emitEvent({
        type: 'response',
        status: upstreamRes.status,
        completedCalls,
        inFlight,
        errorSnippet: formatErrorSnippet(buf.toString('utf8'))
      })
    }
    if (res.writableEnded || res.destroyed) return
    res.writeHead(upstreamRes.status, {
      'Content-Type': contentType,
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store'
    })
    res.end(buf)
  }

  const server = http.createServer(async (req, res) => {
    if (closed) {
      sendOpenAiError(res, 503, 'Proxy is shutting down', 'server_error')
      return
    }
    if (!verifyBearerToken(req.headers, token)) {
      sendOpenAiError(res, 401, 'Invalid proxy token', 'authentication_error')
      return
    }

    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname

    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      sendJson(res, 200, {
        object: 'list',
        data: [{ id: fallbackModel, object: 'model', created: 0, owned_by: 'sticky-notes' }]
      })
      return
    }

    if (req.method !== 'POST' || (pathname !== '/v1/chat/completions' && pathname !== '/chat/completions')) {
      sendOpenAiError(res, 404, `Unsupported path: ${req.method} ${pathname}`, 'invalid_request_error')
      return
    }

    stats.requests++
    let rawBody
    try {
      rawBody = await readRequestBody(req, MAX_BODY_BYTES)
    } catch (err) {
      const code = err.statusCode || 400
      const payloadBuf = Buffer.from(JSON.stringify({
        error: { message: String(err.message || 'Bad request'), type: 'invalid_request_error' }
      }), 'utf8')
      const sendErrResp = (closeAfter) => {
        if (res.writableEnded || res.destroyed) return
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(payloadBuf.length),
          'Cache-Control': 'no-store'
        }
        if (closeAfter) headers.Connection = 'close'
        res.writeHead(code, headers)
        res.end(payloadBuf, closeAfter ? () => { try { req.destroy() } catch (_) {} } : undefined)
      }
      if (req.readableEnded || req.complete) {
        sendErrResp(false)
        return
      }
      // 先在受限窗口内排空已发出的请求体再返回 413，避免 Windows loopback 在写盘中触发 ECONNRESET
      let settled = false
      let extraBytes = 0
      const finishDrain = (forceDestroy) => {
        if (settled) return
        settled = true
        clearTimeout(drainTimer)
        req.removeListener('data', onChunk)
        req.removeListener('end', onEnd)
        req.removeListener('close', onEnd)
        sendErrResp(forceDestroy)
      }
      const onChunk = (c) => {
        extraBytes += c.length
        if (extraBytes > 8 * 1024 * 1024) finishDrain(true)
      }
      const onEnd = () => finishDrain(false)
      const drainTimer = setTimeout(() => finishDrain(true), 800)
      if (typeof drainTimer.unref === 'function') drainTimer.unref()
      req.on('data', onChunk)
      req.once('end', onEnd)
      req.once('close', onEnd)
      req.resume()
      return
    }

    let payload
    try {
      payload = JSON.parse(rawBody || '{}')
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Request body must be a JSON object')
      }
    } catch (err) {
      sendOpenAiError(res, 400, `Invalid JSON: ${err.message}`)
      return
    }

    const reqController = new AbortController()
    const onAborted = () => reqController.abort()
    req.on('aborted', onAborted)
    res.on('close', () => {
      if (!res.writableEnded) reqController.abort()
    })

    let flightReleased = false
    const releaseFlight = () => {
      if (flightReleased) return
      flightReleased = true
      inFlight = Math.max(0, inFlight - 1)
    }
    inFlight++
    emitEvent({ type: 'request', inFlight, totalRequests: stats.requests })

    try {
      const upstreamRes = await callUpstreamWithFallback(payload, reqController.signal)
      await forwardUpstreamResponse(res, upstreamRes, reqController, releaseFlight)
    } catch (err) {
      releaseFlight()
      if (!closed && !reqController.signal.aborted) {
        emitEvent({
          type: 'error',
          inFlight,
          message: String(err && err.message ? err.message : 'Upstream failed').slice(0, 180)
        })
      }
      if (!res.headersSent) {
        const status = err && err.name === 'AbortError' ? 504 : 502
        sendOpenAiError(res, status, err ? err.message : 'Upstream failed', 'server_error')
      } else if (!res.writableEnded && !res.destroyed) {
        res.destroy()
      }
    } finally {
      releaseFlight()
      req.removeListener('aborted', onAborted)
    }
  })

  server.on('connection', (sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : 0
  const baseUrl = `http://127.0.0.1:${port}/v1`

  async function close () {
    if (closed) return
    closed = true
    for (const c of activeControllers) {
      try { c.abort() } catch (_) {}
    }
    activeControllers.clear()
    for (const sock of sockets) {
      try { sock.destroy() } catch (_) {}
    }
    sockets.clear()
    if (typeof server.closeAllConnections === 'function') {
      try { server.closeAllConnections() } catch (_) {}
    }
    await new Promise((resolve) => {
      try {
        server.close(() => resolve())
      } catch (_) {
        resolve()
      }
    })
  }

  function getStats () {
    return {
      requests: stats.requests,
      upstreamCalls: stats.upstreamCalls,
      inFlight,
      droppedParams: Array.from(droppedParams),
      retries400: stats.retries400,
      retriesTransient: stats.retriesTransient
    }
  }

  return {
    baseUrl,
    port,
    token,
    model: fallbackModel,
    close,
    getStats
  }
}

module.exports = {
  STRIPPABLE_PARAMS,
  normalizeProxyBaseUrl,
  buildChatEndpointCandidates,
  verifyBearerToken,
  extractUnsupportedParams,
  createTranslationProxy
}
