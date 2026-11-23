'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const {
  normalizeProxyBaseUrl,
  buildChatEndpointCandidates,
  verifyBearerToken,
  extractUnsupportedParams,
  createTranslationProxy
} = require('../lib/pdf-translate-proxy')

function startMockHttpUpstream (handler) {
  const server = http.createServer(handler)
  const sockets = new Set()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          for (const s of sockets) try { s.destroy() } catch (_) {}
          server.close(() => done())
        })
      })
    })
  })
}

test('normalizeProxyBaseUrl validates http/https URLs', () => {
  assert.equal(normalizeProxyBaseUrl('https://api.example.com/v1///'), 'https://api.example.com/v1')
  assert.throws(() => normalizeProxyBaseUrl(''), /不能为空/)
  assert.throws(() => normalizeProxyBaseUrl('file:///etc/passwd'), /不支持的协议/)
  assert.throws(() => normalizeProxyBaseUrl('not a url'), /格式无效/)
})

test('buildChatEndpointCandidates handles versioned and bare baseUrls', () => {
  assert.deepEqual(
    buildChatEndpointCandidates('https://api.openai.com/v1'),
    ['https://api.openai.com/v1/chat/completions']
  )
  assert.deepEqual(
    buildChatEndpointCandidates('https://ark.cn-beijing.volces.com/api/v3'),
    ['https://ark.cn-beijing.volces.com/api/v3/chat/completions']
  )
  assert.deepEqual(
    buildChatEndpointCandidates('https://proxy.example.com'),
    [
      'https://proxy.example.com/v1/chat/completions',
      'https://proxy.example.com/chat/completions'
    ]
  )
})

test('verifyBearerToken enforces constant-time check', () => {
  assert.equal(verifyBearerToken({ authorization: 'Bearer stk-abc123' }, 'stk-abc123'), true)
  assert.equal(verifyBearerToken({ 'x-api-key': 'stk-abc123' }, 'stk-abc123'), true)
  assert.equal(verifyBearerToken({ authorization: 'Bearer stk-wrong' }, 'stk-abc123'), false)
  assert.equal(verifyBearerToken({}, 'stk-abc123'), false)
})

test('extractUnsupportedParams identifies unsupported OpenAI params', () => {
  const err = JSON.stringify({
    error: {
      message: 'Unsupported value: temperature does not support 0.7 with this model',
      param: 'temperature'
    }
  })
  assert.deepEqual(
    extractUnsupportedParams(err, ['model', 'messages', 'temperature', 'top_p']),
    ['temperature']
  )
  assert.deepEqual(
    extractUnsupportedParams('{"error":{"message":"unrelated rate limit"}}', ['temperature']),
    []
  )
})

test('proxy rejects bad token (401), serves /v1/models, and enforces 4MB cap', async (t) => {
  const upstream = await startMockHttpUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'cmpl-1', choices: [] }))
  })
  t.after(() => upstream.close())

  const proxy = await createTranslationProxy({
    provider: { baseUrl: `${upstream.url}/v1`, apiKey: 'sk-real-key-secret', defaultModel: 'test-model-1' }
  })
  t.after(() => proxy.close())

  // 未携带有效 Token -> 401
  const unauthRes = await fetch(`${proxy.baseUrl}/models`)
  assert.equal(unauthRes.status, 401)

  // 错误 Token -> 401
  const badRes = await fetch(`${proxy.baseUrl}/models`, {
    headers: { Authorization: 'Bearer stk-invalid' }
  })
  assert.equal(badRes.status, 401)

  // 正确 Token -> 200 模型列表
  const modelsRes = await fetch(`${proxy.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${proxy.token}` }
  })
  assert.equal(modelsRes.status, 200)
  const modelsJson = await modelsRes.json()
  assert.equal(modelsJson.data[0].id, 'test-model-1')

  // 超大请求体 -> 413
  const bigBody = JSON.stringify({ model: 'x', padding: 'a'.repeat(4 * 1024 * 1024 + 64) })
  const bigRes = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${proxy.token}`,
      'Content-Type': 'application/json'
    },
    body: bigBody
  })
  assert.equal(bigRes.status, 413)
})

test('proxy swaps token for real key, sticks droppedParams on 400, and handles 429 retry', async (t) => {
  const seenRequests = []
  let seq = 0

  const upstream = await startMockHttpUpstream(async (req, res) => {
    seq++
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seenRequests.push({
      seq,
      url: req.url,
      auth: req.headers.authorization,
      bodyKeys: Object.keys(body)
    })

    // #1：模拟上游返回 404（当未带 /v1 先试 /v1/chat/completions 若没匹配）— 这里直接测 400 不支持 temperature
    if (seq === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: { message: 'Unsupported parameter: temperature', param: 'temperature' }
      }))
      return
    }
    // #2：模拟 429 瞬态限流
    if (seq === 2) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' })
      res.end(JSON.stringify({ error: { message: 'Rate limited' } }))
      return
    }
    // #3、#4：成功返回
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: `ok-${seq}`,
      choices: [{ message: { role: 'assistant', content: '翻译结果' } }]
    }))
  })
  t.after(() => upstream.close())

  const proxyEvents = []
  const proxy = await createTranslationProxy({
    provider: { baseUrl: `${upstream.url}/v1`, apiKey: 'sk-real-upstream-key', defaultModel: 'deepseek-r1' },
    retryBaseMs: 20,
    maxRetryDelayMs: 50,
    onEvent: (ev) => proxyEvents.push(ev)
  })
  t.after(() => proxy.close())

  // 第 1 次客户端请求带 temperature -> 上游 #1(400) -> 剔除 temperature 重试 #2(429) -> 重试 #3(200)
  const res1 = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${proxy.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'deepseek-r1',
      temperature: 0.7,
      messages: [{ role: 'user', content: 'Hello' }]
    })
  })
  assert.equal(res1.status, 200)
  const j1 = await res1.json()
  assert.equal(j1.id, 'ok-3')

  // 第 2 次客户端请求仍带 temperature -> 代理应按会话记忆直接跳过 temperature，一次请求成功
  const res2 = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${proxy.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'deepseek-r1',
      temperature: 0.5,
      messages: [{ role: 'user', content: 'World' }]
    })
  })
  assert.equal(res2.status, 200)
  const j2 = await res2.json()
  assert.equal(j2.id, 'ok-4')

  assert.equal(seenRequests.length, 4)
  for (const r of seenRequests) {
    assert.equal(r.auth, 'Bearer sk-real-upstream-key')
  }
  assert.equal(seenRequests[0].bodyKeys.includes('temperature'), true)
  assert.equal(seenRequests[1].bodyKeys.includes('temperature'), false)
  assert.equal(seenRequests[3].bodyKeys.includes('temperature'), false)
  assert.deepEqual(proxy.getStats().droppedParams, ['temperature'])
  assert.equal(proxy.getStats().inFlight, 0)
  assert.equal(proxyEvents.some((e) => e.type === 'request' && e.inFlight >= 1), true)
  assert.equal(proxyEvents.some((e) => e.type === 'retry' && e.reason === '400-drop-params' && e.dropped.includes('temperature')), true)
  assert.equal(proxyEvents.some((e) => e.type === 'retry' && e.reason === 'transient' && e.status === 429), true)
  assert.equal(proxyEvents.filter((e) => e.type === 'response' && e.status === 200).length, 2)
  assert.equal(JSON.stringify(proxyEvents).includes('sk-real-upstream-key'), false)
})

test('proxy streams SSE responses transparently', async (t) => {
  const upstream = await startMockHttpUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
    res.write('data: {"choices":[{"delta":{"content":"学术"}}]}\n\n')
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"翻译"}}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    }, 20)
  })
  t.after(() => upstream.close())

  const proxy = await createTranslationProxy({
    provider: { baseUrl: upstream.url, apiKey: 'sk-sse-key', defaultModel: 'gpt-4o' }
  })
  t.after(() => proxy.close())

  const sseRes = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${proxy.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: 'Academic translation' }]
    })
  })
  assert.equal(sseRes.status, 200)
  assert.match(sseRes.headers.get('content-type') || '', /text\/event-stream/i)
  const txt = await sseRes.text()
  assert.match(txt, /学术/)
  assert.match(txt, /翻译/)
  assert.match(txt, /\[DONE\]/)
})
