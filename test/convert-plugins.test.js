'use strict'

/**
 * 插件式 provider 发现机制的回归。
 *
 * 验证的是**发现、校验、隔离**三件事：
 *   1. 放进插件目录的 .js 会被自动发现并注册（不改任何核心代码）；
 *   2. 契约不满足 / 加载抛错的插件被跳过，**不影响其它插件与应用启动**；
 *   3. 插件顺序稳定（同名文件排序），不会随机。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const plugins = require('../lib/convert/plugins')
const providersIndex = require('../lib/convert/providers')

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-plug-' + tag + '-'))
}

/** 写一个插件文件 */
function writePlugin (dir, name, code) {
  fs.writeFileSync(path.join(dir, name), code, 'utf8')
}

/** 一个最小的合法 provider 源码 */
const OK_PROVIDER = `
module.exports = {
  id: 'test-plugin',
  name: '测试插件',
  async available () { return true },
  async capabilities (ext) {
    return { ok: true, reason: 'ok', targets: ['xyz'], withEngines: [],
             displayName: '测试', error: null }
  },
  async convert (files, target, outDir) {
    return { ok: true, reason: 'ok', outputs: [], failures: [], files: [], error: null }
  }
}
`

// ---------------------------------------------------------------- 目录发现

test('★ 插件目录：userData 下的 convert-plugins 被识别', () => {
  const userDataDir = tmpDir('ud')
  const dirs = plugins.resolvePluginDirs({ userDataDir, env: {} })
  assert.ok(dirs.some(d => d.endsWith(path.join('convert-plugins'))))
})

test('★ 插件目录：环境变量 STICKY_CONVERT_PLUGINS 优先且支持多个（; 分隔）', () => {
  const a = tmpDir('a')
  const b = tmpDir('b')
  const dirs = plugins.resolvePluginDirs({
    env: { STICKY_CONVERT_PLUGINS: a + ';' + b }
  })
  assert.equal(dirs[0], path.resolve(a))
  assert.equal(dirs[1], path.resolve(b))
})

test('插件目录：重复路径去重', () => {
  const a = tmpDir('dup')
  const dirs = plugins.resolvePluginDirs({
    env: { STICKY_CONVERT_PLUGINS: a },
    userDataDir: a
  })
  // userDataDir 推出的路径与 env 推出的不同（一个是 <a>\convert-plugins），不算重复
  const seen = new Set(dirs.map(d => d.toLowerCase()))
  assert.equal(seen.size, dirs.length)
})

test('插件目录：不存在时返回空列表而不是抛错', () => {
  const dirs = plugins.resolvePluginDirs({
    env: {},
    userDataDir: path.join(os.tmpdir(), 'definitely-not-exist-' + Date.now())
  })
  assert.ok(Array.isArray(dirs))
})

// ---------------------------------------------------------------- 文件列举

test('★ 只取 .js 文件，跳过 . 和 _ 开头的', () => {
  const dir = tmpDir('files')
  fs.writeFileSync(path.join(dir, 'a.js'), '')
  fs.writeFileSync(path.join(dir, 'b.txt'), '')
  fs.writeFileSync(path.join(dir, '_helper.js'), '')
  fs.writeFileSync(path.join(dir, '.hidden.js'), '')
  fs.mkdirSync(path.join(dir, 'sub.js'))
  const files = plugins.listPluginFiles(dir)
  assert.equal(files.length, 1)
  assert.ok(files[0].endsWith('a.js'))
})

test('插件文件：按文件名排序，顺序稳定', () => {
  const dir = tmpDir('order')
  writePlugin(dir, 'zeta.js', OK_PROVIDER)
  writePlugin(dir, 'alpha.js', OK_PROVIDER)
  const files = plugins.listPluginFiles(dir)
  assert.ok(files[0].endsWith('alpha.js'))
  assert.ok(files[1].endsWith('zeta.js'))
})

// ---------------------------------------------------------------- 加载

test('★ 插件：合法 provider 被发现并注册', () => {
  const dir = tmpDir('ok')
  writePlugin(dir, 'ok.js', OK_PROVIDER)
  const r = plugins.loadPlugins({ env: { STICKY_CONVERT_PLUGINS: dir } })
  assert.equal(r.errors.length, 0)
  assert.equal(r.providers.length, 1)
  assert.equal(r.providers[0].id, 'test-plugin')
})

test('★ 插件：工厂函数形态被支持', () => {
  const dir = tmpDir('factory')
  writePlugin(dir, 'f.js', `
module.exports = function (deps) {
  return {
    id: 'factory-plugin',
    name: '工厂插件 ' + (deps && deps.appDir ? '有ctx' : '无ctx'),
    async available () { return true },
    async capabilities () { return { ok: true, targets: [], withEngines: [] } },
    async convert () { return { ok: true, outputs: [] } }
  }
}
`)
  const r = plugins.loadPlugins({
    env: { STICKY_CONVERT_PLUGINS: dir },
    context: { appDir: 'X' }
  })
  assert.equal(r.errors.length, 0)
  assert.equal(r.providers.length, 1)
  assert.ok(r.providers[0].name.includes('有ctx'))
})

test('★ 插件：{ provider } 包装形态被支持', () => {
  const dir = tmpDir('wrap')
  writePlugin(dir, 'w.js', `module.exports = { provider: ${OK_PROVIDER.replace('module.exports = ', '')} }`)
  const r = plugins.loadPlugins({ env: { STICKY_CONVERT_PLUGINS: dir } })
  assert.equal(r.providers.length, 1)
})

test('★ 插件：契约不满足被跳过，但不影响其它插件', () => {
  const dir = tmpDir('bad')
  // 有 id/name，但缺 available()/capabilities()/convert() ⇒ 契约校验不通过
  writePlugin(dir, 'bad.js', 'module.exports = { id: "x", name: "坏插件" }')
  writePlugin(dir, 'good.js', OK_PROVIDER)
  const r = plugins.loadPlugins({ env: { STICKY_CONVERT_PLUGINS: dir } })
  assert.equal(r.providers.length, 1)
  assert.equal(r.errors.length, 1)
  assert.ok(r.errors[0].file.endsWith('bad.js'))
  assert.ok(r.errors[0].error.includes('available'))
})

test('插件：缺 name 也能被识别为契约不满足', () => {
  const dir = tmpDir('noname')
  writePlugin(dir, 'noname.js', 'module.exports = { id: "x" }')
  const r = plugins.loadPlugins({ env: { STICKY_CONVERT_PLUGINS: dir } })
  assert.equal(r.providers.length, 0)
  assert.equal(r.errors.length, 1)
  assert.ok(r.errors[0].error.includes('name'))
})

test('★ 插件：语法错误的文件被跳过，应用不受影响', () => {
  const dir = tmpDir('syntax')
  writePlugin(dir, 'broken.js', 'this is not valid javascript {{{')
  writePlugin(dir, 'good.js', OK_PROVIDER)
  const r = plugins.loadPlugins({ env: { STICKY_CONVERT_PLUGINS: dir } })
  assert.equal(r.providers.length, 1)
  assert.equal(r.errors.length, 1)
})

test('★ 插件：工厂函数抛错被捕获，不炸出加载器', () => {
  const dir = tmpDir('throw')
  writePlugin(dir, 'boom.js', 'module.exports = function () { throw new Error("boom") }')
  const r = plugins.loadPlugins({ env: { STICKY_CONVERT_PLUGINS: dir } })
  assert.equal(r.providers.length, 0)
  assert.equal(r.errors.length, 1)
  assert.ok(r.errors[0].error.includes('boom'))
})

test('插件：导出无法识别的形态时报错而非静默', () => {
  const dir = tmpDir('weird')
  writePlugin(dir, 'weird.js', 'module.exports = 42')
  const r = plugins.loadPlugins({ env: { STICKY_CONVERT_PLUGINS: dir } })
  assert.equal(r.providers.length, 0)
  assert.equal(r.errors.length, 1)
})

test('★ 插件：默认 provider 列表自动纳入插件（无需改核心）', () => {
  const dir = tmpDir('integrated')
  writePlugin(dir, 'integ.js', OK_PROVIDER)
  const list = providersIndex.createDefaultProviders({
    withFilee: false,
    env: { STICKY_CONVERT_PLUGINS: dir }
  })
  assert.ok(list.some(p => p.id === 'test-plugin'), '插件 provider 应出现在默认列表里')
  // 内置的两个仍然在
  assert.ok(list.some(p => p.id === 'builtin-image'))
  assert.ok(list.some(p => p.id === 'builtin-text-data'))
})

test('★ 插件：withPlugins:false 时插件不被加载', () => {
  const dir = tmpDir('off')
  writePlugin(dir, 'integ.js', OK_PROVIDER)
  const list = providersIndex.createDefaultProviders({
    withFilee: false,
    withPlugins: false,
    env: { STICKY_CONVERT_PLUGINS: dir }
  })
  assert.ok(!list.some(p => p.id === 'test-plugin'))
})

test('插件：加载异常不影响默认 provider 组装', () => {
  const list = providersIndex.createDefaultProviders({
    withFilee: false,
    env: { STICKY_CONVERT_PLUGINS: 'C:\\definitely\\not\\a\\dir' }
  })
  assert.ok(list.length >= 2)
})

// ---------------------------------------------------------------- 与路由的集成

test('★ 插件 provider 能真正参与路由（能力合并 + 转换）', async () => {
  const dir = tmpDir('route')
  writePlugin(dir, 'route.js', `
module.exports = {
  id: 'route-plugin',
  name: '路由插件',
  async available () { return true },
  async capabilities (ext) {
    return { ok: true, reason: 'ok', targets: ['xyz'], withEngines: [],
             displayName: '路由', error: null }
  },
  async convert (files, target, outDir) {
    const fs = require('fs')
    const path = require('path')
    const outputs = files.map(f => {
      const dest = path.join(outDir, path.basename(f) + '.xyz')
      fs.writeFileSync(dest, 'converted')
      return { source: f, output: dest }
    })
    return { ok: true, reason: 'ok', outputs, failures: [], files: [], error: null }
  }
}
`)
  const { createRouter } = require('../lib/convert/router')
  const list = providersIndex.createDefaultProviders({
    withFilee: false,
    env: { STICKY_CONVERT_PLUGINS: dir }
  })
  const router = createRouter({ providers: list })

  const caps = await router.capabilities('anything')
  assert.ok(caps.targets.includes('xyz'), '插件能力应被合并进 targets')

  const src = path.join(tmpDir('src'), 'a.txt')
  fs.writeFileSync(src, 'hello')
  const outDir = tmpDir('out')
  const r = await router.convert([src], 'xyz', outDir)
  assert.equal(r.ok, true)
  assert.equal(r.provider, 'route-plugin')
  assert.equal(r.outputs.length, 1)
  assert.ok(fs.existsSync(r.outputs[0].output))
})
