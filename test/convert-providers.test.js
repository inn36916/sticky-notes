'use strict'

/**
 * 内置 provider 的回归（图片契约 + 文本/数据转换）。
 *
 * 图片 provider 的 decode/encode 用假实现注入（真实 canvas 在 Electron 里测），
 * 验证的是**契约层的行为**：扩展名白名单、失败分类、产物落盘。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const image = require('../lib/convert/providers/image')
const textData = require('../lib/convert/providers/text-data')

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-prov-' + tag + '-'))
}

// ---------------------------------------------------------------- 图片 provider

/**
 * 造一个假的图片 provider：decode 返回句柄，encode 返回固定字节。
 *
 * ⚠️ 注意：decode/encode 是在 createImageProvider 内部闭包里被调用的，
 *   所以要覆盖它们必须通过 deps 传进去，不能用 Object.assign 覆盖返回值 ——
 *   那样覆盖的是 provider 的属性，转换时仍然走原来的闭包。
 */
function fakeImageProvider (over = {}) {
  const calls = { decode: [], encode: [] }
  const deps = {
    decode: async (f) => { calls.decode.push(f); return { width: 10, height: 10, canvasId: 'c1' } },
    encode: async (img, mime, ext) => {
      calls.encode.push({ img, mime, ext })
      return Buffer.from('FAKE-' + ext)
    }
  }
  // over 里可以带 decode/encode 来覆盖行为
  if (over.decode) deps.decode = over.decode
  if (over.encode) deps.encode = over.encode
  const p = image.createImageProvider(deps)
  p.calls = calls
  return p
}

test('★ 图片 provider：capabilities 只报实测支持的编码', async () => {
  const p = fakeImageProvider()
  const caps = await p.capabilities('png')
  assert.equal(caps.ok, true)
  assert.deepEqual(caps.targets.sort(), ['jpeg', 'jpg', 'png', 'webp'])
  assert.equal(caps.withEngines.length, 0)
})

test('★ 图片 provider：不支持的源格式 → usage', async () => {
  const p = fakeImageProvider()
  const caps = await p.capabilities('xyz')
  assert.equal(caps.ok, false)
  assert.equal(caps.reason, 'usage')
})

test('★ 图片 provider：gif 是可解码源（但不是可编码目标）', async () => {
  const p = fakeImageProvider()
  assert.equal(await p.canHandle('gif', 'png'), true)
  assert.equal(await p.canHandle('gif', 'gif'), false, 'gif 不能作为编码目标')
})

test('图片 provider：canHandle 对非图片源返回 false', async () => {
  const p = fakeImageProvider()
  assert.equal(await p.canHandle('json', 'png'), false)
})

test('★ 图片 provider：转换成功时产物真的落盘', async () => {
  const p = fakeImageProvider()
  const src = path.join(tmpDir('img'), 'a.png')
  fs.writeFileSync(src, 'x')
  const outDir = tmpDir('out')

  const r = await p.convert([src], 'jpg', outDir)
  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 1)
  assert.ok(fs.existsSync(r.outputs[0].output))
  assert.equal(fs.readFileSync(r.outputs[0].output, 'utf8'), 'FAKE-jpg')
  assert.ok(r.outputs[0].output.endsWith('.jpg'))
})

test('图片 provider：目标格式不支持 → usage', async () => {
  const p = fakeImageProvider()
  const src = path.join(tmpDir('img2'), 'a.png')
  fs.writeFileSync(src, 'x')
  const r = await p.convert([src], 'tiff', tmpDir('out2'))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'usage')
})

test('★ 图片 provider：decode 失败 → 记入 failures 且整体失败', async () => {
  const p = fakeImageProvider({ decode: async () => null })
  const src = path.join(tmpDir('img3'), 'a.png')
  fs.writeFileSync(src, 'x')
  const r = await p.convert([src], 'jpg', tmpDir('out3'))
  assert.equal(r.ok, false)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].source, src)
})

test('图片 provider：encode 返回空 → 记入 failures', async () => {
  const p = fakeImageProvider({ encode: async () => null })
  const src = path.join(tmpDir('img4'), 'a.png')
  fs.writeFileSync(src, 'x')
  const r = await p.convert([src], 'jpg', tmpDir('out4'))
  assert.equal(r.ok, false)
  assert.equal(r.failures.length, 1)
})

test('图片 provider：没有 worker 时 available() 为 false（框架自动跳过）', async () => {
  const p = image.createImageProvider({})
  assert.equal(await p.available(), false)
})

test('图片 provider：多文件时逐个转换', async () => {
  const p = fakeImageProvider()
  const dir = tmpDir('multi')
  const a = path.join(dir, 'a.png')
  const b = path.join(dir, 'b.png')
  fs.writeFileSync(a, 'x')
  fs.writeFileSync(b, 'x')
  const r = await p.convert([a, b], 'webp', tmpDir('multiout'))
  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 2)
})

// ---------------------------------------------------------------- 文本/数据 provider

/** 造一个文本 provider，并把转换跑一遍拿到产物内容 */
async function convertText (srcContent, srcExt, target) {
  const p = textData.createTextDataProvider()
  const dir = tmpDir('txt')
  const src = path.join(dir, 'a.' + srcExt)
  fs.writeFileSync(src, srcContent)
  const outDir = tmpDir('txtout')
  const r = await p.convert([src], target, outDir)
  if (!r.ok) return { ok: false, reason: r.reason, error: r.error }
  return { ok: true, content: fs.readFileSync(r.outputs[0].output, 'utf8') }
}

test('★ 文本 provider：JSON → CSV', async () => {
  const r = await convertText(JSON.stringify([{ a: '1', b: '2' }, { a: '3', b: '4' }]), 'json', 'csv')
  assert.equal(r.ok, true)
  assert.ok(r.content.includes('a,b'))
  assert.ok(r.content.includes('1,2'))
})

test('★ 文本 provider：CSV → JSON', async () => {
  const r = await convertText('a,b\n1,2\n3,4\n', 'csv', 'json')
  assert.equal(r.ok, true)
  const v = JSON.parse(r.content)
  assert.deepEqual(v, [{ a: '1', b: '2' }, { a: '3', b: '4' }])
})

test('文本 provider：CSV 字段含逗号与引号时正确转义', async () => {
  const r = await convertText('a,b\n"x,y","he said ""hi"""\n', 'csv', 'json')
  assert.equal(r.ok, true)
  const v = JSON.parse(r.content)
  assert.equal(v[0].a, 'x,y')
  assert.equal(v[0].b, 'he said "hi"')
})

test('文本 provider：JSON → CSV 时含逗号的字段被引号包裹', async () => {
  const r = await convertText(JSON.stringify([{ a: 'x,y' }]), 'json', 'csv')
  assert.ok(r.content.includes('"x,y"'))
})

test('★ 文本 provider：JSON → YAML', async () => {
  const r = await convertText(JSON.stringify({ name: 'x', n: 3, ok: true }), 'json', 'yaml')
  assert.equal(r.ok, true)
  assert.ok(r.content.includes('name: x'))
  assert.ok(r.content.includes('n: 3'))
  assert.ok(r.content.includes('ok: true'))
})

test('文本 provider：YAML → JSON', async () => {
  const r = await convertText('name: x\nn: 3\nlist:\n  - a\n  - b\n', 'yaml', 'json')
  assert.equal(r.ok, true)
  const v = JSON.parse(r.content)
  assert.equal(v.name, 'x')
  assert.equal(v.n, 3)
  assert.deepEqual(v.list, ['a', 'b'])
})

test('★ 文本 provider：JSON → TOML', async () => {
  const r = await convertText(JSON.stringify({ name: 'x', n: 3 }), 'json', 'toml')
  assert.equal(r.ok, true)
  assert.ok(r.content.includes('name = "x"'))
  assert.ok(r.content.includes('n = 3'))
})

test('文本 provider：TOML → JSON', async () => {
  const r = await convertText('name = "x"\nn = 3\n', 'toml', 'json')
  assert.equal(r.ok, true)
  const v = JSON.parse(r.content)
  assert.equal(v.name, 'x')
  assert.equal(v.n, 3)
})

test('★ 文本 provider：JSON → XML', async () => {
  const r = await convertText(JSON.stringify({ name: 'x' }), 'json', 'xml')
  assert.equal(r.ok, true)
  assert.ok(r.content.includes('<root>'))
  assert.ok(r.content.includes('<name>x</name>'))
})

test('文本 provider：XML → JSON（属性与重复元素）', async () => {
  const r = await convertText('<root id="1"><a>1</a><a>2</a></root>', 'xml', 'json')
  assert.equal(r.ok, true)
  const v = JSON.parse(r.content)
  assert.equal(v['@id'], '1')
  assert.deepEqual(v.a, ['1', '2'])
})

test('文本 provider：XML 特殊字符被转义', async () => {
  const r = await convertText(JSON.stringify({ t: 'a<b&c' }), 'json', 'xml')
  assert.ok(r.content.includes('&lt;'))
  assert.ok(r.content.includes('&amp;'))
})

test('★ 文本 provider：JSON 数组 → Markdown 表格', async () => {
  const r = await convertText(JSON.stringify([{ a: '1', b: '2' }]), 'json', 'md')
  assert.equal(r.ok, true)
  assert.ok(r.content.includes('| a | b |'))
  assert.ok(r.content.includes('| --- | --- |'))
  assert.ok(r.content.includes('| 1 | 2 |'))
})

test('文本 provider：Markdown 表格 → JSON', async () => {
  const r = await convertText('| a | b |\n| --- | --- |\n| 1 | 2 |\n', 'md', 'json')
  assert.equal(r.ok, true)
  const v = JSON.parse(r.content)
  assert.deepEqual(v, [{ a: '1', b: '2' }])
})

test('★ 文本 provider：源格式非法时明确失败（不静默产出坏数据）', async () => {
  const r = await convertText('{ 这不是 json', 'json', 'csv')
  assert.equal(r.ok, false)
  assert.ok(r.error, '应给出失败原因')
})

test('文本 provider：结构不匹配时明确失败', async () => {
  // 标量 JSON 不能转 CSV（需要数组）
  const r = await convertText('"hello"', 'json', 'csv')
  assert.equal(r.ok, false)
})

test('文本 provider：capabilities 列出所有支持的格式', async () => {
  const p = textData.createTextDataProvider()
  const caps = await p.capabilities('json')
  assert.equal(caps.ok, true)
  assert.ok(caps.targets.includes('csv'))
  assert.ok(caps.targets.includes('yaml'))
  assert.ok(caps.targets.includes('xml'))
})

test('文本 provider：available 恒为 true（零依赖）', async () => {
  const p = textData.createTextDataProvider()
  assert.equal(await p.available(), true)
})

test('文本 provider：非支持源格式 → usage', async () => {
  const p = textData.createTextDataProvider()
  const caps = await p.capabilities('exe')
  assert.equal(caps.ok, false)
  assert.equal(caps.reason, 'usage')
})

// ---------------------------------------------------------------- 纯函数

test('splitTopLevel：括号与引号内的逗号不被切分', () => {
  const parts = textData.splitTopLevel('a, "b,c", [d,e]')
  assert.equal(parts.length, 3)
  assert.equal(parts[1], '"b,c"')
})

test('★ 文本 provider：嵌套 YAML 往返（对象嵌套、对象数组、多行字符串）', async () => {
  const sample = {
    app: { name: 'sticky', ports: [80, 443], meta: { enabled: true } },
    items: [{ id: 1, label: '甲' }, { id: 2, label: '乙\n第二行' }]
  }
  const y = await convertText(JSON.stringify(sample), 'json', 'yaml')
  assert.equal(y.ok, true)
  const j = await convertText(y.content, 'yaml', 'json')
  assert.equal(j.ok, true)
  assert.deepEqual(JSON.parse(j.content), sample)
})

test('★ 文本 provider：嵌套 TOML 往返（嵌套表、数组表、null 归一化为空串）', async () => {
  const sample = {
    server: { host: '127.0.0.1', tls: { enabled: true } },
    items: [{ id: 1 }, { id: 2 }],
    nullable: null
  }
  const t = await convertText(JSON.stringify(sample), 'json', 'toml')
  assert.equal(t.ok, true)
  assert.ok(t.content.includes('[server.tls]'))
  assert.ok(t.content.includes('nullable = ""'))
  const j = await convertText(t.content, 'toml', 'json')
  assert.equal(j.ok, true)
  assert.deepEqual(JSON.parse(j.content), {
    server: { host: '127.0.0.1', tls: { enabled: true } },
    items: [{ id: 1 }, { id: 2 }],
    nullable: ''
  })
})

test('文本 provider：非法 YAML / TOML 与数组转 TOML 明确失败', async () => {
  const badYaml = await convertText('a: [1, 2', 'yaml', 'json')
  assert.equal(badYaml.ok, false)
  const badToml = await convertText('a = [', 'toml', 'json')
  assert.equal(badToml.ok, false)
  const arrToml = await convertText('[1, 2, 3]', 'json', 'toml')
  assert.equal(arrToml.ok, false)
})
