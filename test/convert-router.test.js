'use strict'

/**
 * 转换引擎框架的回归（provider 契约 + 注册表 + 路由层）。
 *
 * 这一层**不依赖 Electron**：provider 全部是假的，
 * 验证框架机制（校验、可用性缓存、能力合并、路由兜底、失败分类）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const providerLib = require('../lib/convert/provider')
const routerLib = require('../lib/convert/router')

/** 造一个假 provider */
function fakeProvider (over = {}) {
  return Object.assign({
    id: 'p',
    name: 'P',
    async available () { return true },
    async capabilities (ext) {
      return { ok: true, reason: 'ok', targets: ['jpg'], withEngines: [], displayName: ext, error: null }
    },
    async convert (files, target, outDir) {
      return { ok: true, reason: 'ok', outputs: [], failures: [], files: [], error: null }
    }
  }, over)
}

// ---------------------------------------------------------------- 契约校验

test('★ validateProvider：完整 provider 通过', () => {
  const r = providerLib.validateProvider(fakeProvider())
  assert.equal(r.ok, true)
  assert.equal(r.error, null)
})

test('validateProvider：缺 id 被拒', () => {
  const p = fakeProvider()
  delete p.id
  const r = providerLib.validateProvider(p)
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('id'))
})

test('validateProvider：缺 available 被拒', () => {
  const p = fakeProvider()
  delete p.available
  const r = providerLib.validateProvider(p)
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('available'))
})

test('validateProvider：缺 capabilities 被拒', () => {
  const p = fakeProvider()
  delete p.capabilities
  assert.equal(providerLib.validateProvider(p).ok, false)
})

test('validateProvider：缺 convert 被拒', () => {
  const p = fakeProvider()
  delete p.convert
  assert.equal(providerLib.validateProvider(p).ok, false)
})

test('validateProvider：非对象被拒', () => {
  assert.equal(providerLib.validateProvider(null).ok, false)
  assert.equal(providerLib.validateProvider('x').ok, false)
})

// ---------------------------------------------------------------- 注册表

test('★ 注册表：非法 provider 被跳过并记录错误', () => {
  const reg = providerLib.createRegistry([fakeProvider({ id: 'good' }), { id: 'bad' }])
  assert.equal(reg.all().length, 1)
  assert.equal(reg.all()[0].id, 'good')
  assert.equal(reg.errors.length, 1)
  assert.ok(reg.errors[0].includes('bad'))
})

test('注册表：available 过滤掉不可用的 provider', async () => {
  const reg = providerLib.createRegistry([
    fakeProvider({ id: 'a', available: async () => true }),
    fakeProvider({ id: 'b', available: async () => false })
  ])
  const list = await reg.available()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'a')
})

test('★ 注册表：可用性被缓存，不重复探测', async () => {
  let calls = 0
  const reg = providerLib.createRegistry([fakeProvider({
    available: async () => { calls++; return true }
  })])
  await reg.available()
  await reg.available()
  await reg.available()
  assert.equal(calls, 1, '应只探测一次')
})

test('注册表：invalidate 后重新探测', async () => {
  let calls = 0
  const reg = providerLib.createRegistry([fakeProvider({
    available: async () => { calls++; return true }
  })])
  await reg.available()
  reg.invalidate()
  await reg.available()
  assert.equal(calls, 2)
})

test('注册表：available 抛异常时视为不可用，不崩', async () => {
  const reg = providerLib.createRegistry([fakeProvider({
    available: async () => { throw new Error('boom') }
  })])
  const list = await reg.available()
  assert.equal(list.length, 0)
})

test('★ 注册表：resolve 过滤掉 canHandle=false 的 provider', async () => {
  const reg = providerLib.createRegistry([
    fakeProvider({ id: 'a', canHandle: async () => false }),
    fakeProvider({ id: 'b', canHandle: async () => true })
  ])
  const r = await reg.resolve('png', 'jpg')
  assert.equal(r.candidates.length, 1)
  assert.equal(r.candidates[0].id, 'b')
  assert.equal(r.provider.id, 'b')
})

test('注册表：resolve 返回 availableCount（区分"没装"与"不支持"）', async () => {
  const reg = providerLib.createRegistry([
    fakeProvider({ id: 'a', available: async () => false }),
    fakeProvider({ id: 'b', available: async () => true, canHandle: async () => false })
  ])
  const r = await reg.resolve('png', 'jpg')
  assert.equal(r.candidates.length, 0)
  assert.equal(r.availableCount, 1, '有一个引擎可用，但不支持该组合')
})

// ---------------------------------------------------------------- 路由：能力合并

test('★ 路由：多个 provider 的 targets 被合并去重', async () => {
  const r = routerLib.createRouter({
    providers: [
      fakeProvider({ id: 'a', capabilities: async () => ({ ok: true, reason: 'ok', targets: ['jpg', 'png'], withEngines: [], displayName: 'A', error: null }) }),
      fakeProvider({ id: 'b', capabilities: async () => ({ ok: true, reason: 'ok', targets: ['png', 'webp'], withEngines: ['heic'], displayName: 'B', error: null }) })
    ]
  })
  const caps = await r.capabilities('png')
  assert.equal(caps.ok, true)
  assert.deepEqual(caps.targets.sort(), ['jpg', 'png', 'webp'])
  assert.deepEqual(caps.withEngines, ['heic'])
})

test('路由：一个 provider 失败不影响另一个', async () => {
  const r = routerLib.createRouter({
    providers: [
      fakeProvider({ id: 'a', capabilities: async () => { throw new Error('boom') } }),
      fakeProvider({ id: 'b', capabilities: async () => ({ ok: true, reason: 'ok', targets: ['jpg'], withEngines: [], displayName: 'B', error: null }) })
    ]
  })
  const caps = await r.capabilities('png')
  assert.equal(caps.ok, true)
  assert.deepEqual(caps.targets, ['jpg'])
})

test('★ 路由：全部 provider 都失败时返回第一个失败原因', async () => {
  const r = routerLib.createRouter({
    providers: [
      fakeProvider({ id: 'a', capabilities: async () => ({ ok: false, reason: 'usage', targets: [], withEngines: [], displayName: null, error: '不支持' }) })
    ]
  })
  const caps = await r.capabilities('xyz')
  assert.equal(caps.ok, false)
  assert.equal(caps.reason, 'usage')
  assert.ok(caps.error.includes('不支持'))
})

test('路由：没有任何可用 provider → not-installed', async () => {
  const r = routerLib.createRouter({
    providers: [fakeProvider({ id: 'a', available: async () => false })]
  })
  const caps = await r.capabilities('png')
  assert.equal(caps.ok, false)
  assert.equal(caps.reason, 'not-installed')
})

test('路由：空扩展名 → usage', async () => {
  const r = routerLib.createRouter({ providers: [fakeProvider()] })
  const caps = await r.capabilities('')
  assert.equal(caps.ok, false)
  assert.equal(caps.reason, 'usage')
})

// ---------------------------------------------------------------- 路由：转换

test('★ 路由：转换落到第一个能处理的 provider', async () => {
  const calls = []
  const r = routerLib.createRouter({
    providers: [
      fakeProvider({
        id: 'a',
        canHandle: async () => true,
        convert: async () => { calls.push('a'); return { ok: true, reason: 'ok', outputs: [{ source: 'x', output: 'y' }], failures: [], files: [], error: null } }
      }),
      fakeProvider({
        id: 'b',
        canHandle: async () => true,
        convert: async () => { calls.push('b'); return { ok: true, reason: 'ok', outputs: [], failures: [], files: [], error: null } }
      })
    ]
  })
  const res = await r.convert(['x.png'], 'jpg', '/tmp')
  assert.equal(res.ok, true)
  assert.equal(res.provider, 'a')
  assert.deepEqual(calls, ['a'], '第二个不该被调用')
})

test('★ 路由：第一个 provider 失败时自动兜底到下一个', async () => {
  const calls = []
  const r = routerLib.createRouter({
    providers: [
      fakeProvider({
        id: 'a',
        canHandle: async () => true,
        convert: async () => { calls.push('a'); return { ok: false, reason: 'failed', outputs: [], failures: [], files: [], error: '坏了' } }
      }),
      fakeProvider({
        id: 'b',
        canHandle: async () => true,
        convert: async () => { calls.push('b'); return { ok: true, reason: 'ok', outputs: [{ source: 'x', output: 'y' }], failures: [], files: [], error: null } }
      })
    ]
  })
  const res = await r.convert(['x.png'], 'jpg', '/tmp')
  assert.equal(res.ok, true)
  assert.equal(res.provider, 'b')
  assert.deepEqual(calls, ['a', 'b'])
})

test('路由：provider 抛异常时兜底到下一个', async () => {
  const r = routerLib.createRouter({
    providers: [
      fakeProvider({ id: 'a', canHandle: async () => true, convert: async () => { throw new Error('boom') } }),
      fakeProvider({ id: 'b', canHandle: async () => true, convert: async () => ({ ok: true, reason: 'ok', outputs: [], failures: [], files: [], error: null }) })
    ]
  })
  const res = await r.convert(['x.png'], 'jpg', '/tmp')
  assert.equal(res.ok, true)
  assert.equal(res.provider, 'b')
})

test('★ 路由：没有可用引擎 → not-installed', async () => {
  const r = routerLib.createRouter({
    providers: [fakeProvider({ available: async () => false })]
  })
  const res = await r.convert(['x.png'], 'jpg', '/tmp')
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'not-installed')
})

test('★ 路由：引擎在但不支持该组合 → usage（不是 not-installed）', async () => {
  const r = routerLib.createRouter({
    providers: [fakeProvider({ available: async () => true, canHandle: async () => false })]
  })
  const res = await r.convert(['x.png'], 'jpg', '/tmp')
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'usage')
})

test('路由：没有文件 → usage', async () => {
  const r = routerLib.createRouter({ providers: [fakeProvider()] })
  const res = await r.convert([], 'jpg', '/tmp')
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'usage')
})

test('路由：没有目标格式 → usage', async () => {
  const r = routerLib.createRouter({ providers: [fakeProvider()] })
  const res = await r.convert(['x.png'], '', '/tmp')
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'usage')
})

test('路由：engines 列出所有 provider 及其可用性', async () => {
  const r = routerLib.createRouter({
    providers: [
      fakeProvider({ id: 'a', name: 'A', available: async () => true }),
      fakeProvider({ id: 'b', name: 'B', available: async () => false })
    ]
  })
  const list = await r.engines()
  assert.equal(list.length, 2)
  assert.equal(list.find(e => e.id === 'a').available, true)
  assert.equal(list.find(e => e.id === 'b').available, false)
})

// ---------------------------------------------------------------- extOf

test('extOf：取小写扩展名', () => {
  assert.equal(routerLib.extOf('C:\\a\\b\\Photo.PNG'), 'png')
  assert.equal(routerLib.extOf('a.tar.gz'), 'gz')
})

test('extOf：无扩展名或点开头返回空', () => {
  assert.equal(routerLib.extOf('README'), '')
  assert.equal(routerLib.extOf('.gitignore'), '')
  assert.equal(routerLib.extOf('a.'), '')
})
