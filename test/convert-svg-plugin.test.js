'use strict'

/**
 * SVG 示例插件（examples/convert-plugins/svg.js）的契约与流程回归。
 *
 * 覆盖三件事：
 *   1. 插件**满足 provider 契约**（能被 validateProvider 通过、能被 loadPlugins 发现）；
 *   2. 能力口径正确（svg → png/jpg/jpeg/webp；其它源一律 usage 失败）；
 *   3. convert 的完整流程用**假 workerHost** 驱动：
 *      产物落盘、文件名不带双扩展名、单文件失败不影响别的文件、全失败必须 ok:false。
 *
 * 为什么用假 workerHost 而不是真跑 Electron：
 *   渲染那一段（canvas/SVG）属于 worker 的职责，由 e2e 覆盖；
 *   这里要验的是**插件的编排逻辑**，注入一个确定的 host 才能把
 *   失败分支、魔数校验这些路走干净。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { validateProvider, REASON } = require('../lib/convert/provider')
const plugins = require('../lib/convert/plugins')
const providersIndex = require('../lib/convert/providers')
const { createRouter } = require('../lib/convert/router')

/** 示例插件的真实文件（测试里既直接 require，也拷进临时插件目录） */
const PLUGIN_FILE = path.join(__dirname, '..', 'examples', 'convert-plugins', 'svg.js')

/** 创建插件实例 */
function createPlugin (deps) {
  // 每次都清缓存，避免前一个用例的 deps 泄漏进来
  delete require.cache[require.resolve(PLUGIN_FILE)]
  const factory = require(PLUGIN_FILE)
  return factory(deps)
}

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-svg-' + tag + '-'))
}

/** 一个"看着像"真 PNG 的最小字节（只用于魔数断言） */
function pngBytes () {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
}

/** 一个"看着像"真 JPEG 的最小字节 */
function jpegBytes () {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
}

/**
 * 假 workerHost：记录调用，并允许用例覆盖单个动作的行为。
 *
 * @param {object} [opts]
 * @param {function} [opts.render]
 * @param {function} [opts.encode]
 */
function fakeWorkerHost (opts = {}) {
  const calls = { render: [], encode: [] }
  let seq = 0
  return {
    calls,
    async renderSvg (svgText) {
      calls.render.push(svgText)
      if (typeof opts.render === 'function') return opts.render(svgText, calls.render.length)
      return { ok: true, width: 64, height: 64, canvasId: 'c' + (++seq) }
    },
    async encode (canvasId, mime) {
      calls.encode.push({ canvasId, mime })
      if (typeof opts.encode === 'function') return opts.encode(canvasId, mime)
      return { ok: true, bytes: mime === 'image/png' ? pngBytes() : jpegBytes(), type: mime }
    }
  }
}

/** 写一个源 SVG 文件，返回路径 */
function writeSvg (dir, name, text) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, text, 'utf8')
  return p
}

const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
  '<rect width="64" height="64" fill="#c00"/></svg>'

/** 真的没有任何尺寸信息（既无 width/height，也无 viewBox） */
const NO_SIZE_SVG = '<svg xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="10" height="10" fill="#0f0"/></svg>'

/** worker 里的纯逻辑（尺寸判定 / 外部引用识别），node 下可直接 require */
const convertWorker = require('../src/convert-worker')

// ---------------------------------------------------------------- 契约

test('★ SVG 插件：满足 provider 契约', () => {
  const p = createPlugin({ workerHost: fakeWorkerHost() })
  const v = validateProvider(p)
  assert.equal(v.ok, true, v.error)
  assert.equal(p.id, 'builtin-vector-svg')
  assert.equal(p.name, 'SVG 矢量（示例插件）')
})

test('★ SVG 插件：capabilities("svg") 返回 png/jpg/jpeg/webp', async () => {
  const p = createPlugin({ workerHost: fakeWorkerHost() })
  const r = await p.capabilities('svg')
  assert.equal(r.ok, true)
  assert.equal(r.reason, REASON.OK)
  assert.deepEqual(r.targets.slice().sort(), ['jpeg', 'jpg', 'png', 'webp'])
  assert.equal(r.displayName, '矢量图')
})

test('★ SVG 插件：capabilities("png") 明确返回 usage 失败', async () => {
  const p = createPlugin({ workerHost: fakeWorkerHost() })
  const r = await p.capabilities('png')
  assert.equal(r.ok, false)
  assert.equal(r.reason, REASON.USAGE)
  assert.deepEqual(r.targets, [])
  assert.match(r.error, /svg/i)
})

test('★ SVG 插件：canHandle 只认 svg → png/jpg/jpeg/webp', async () => {
  const p = createPlugin({ workerHost: fakeWorkerHost() })
  assert.equal(await p.canHandle('svg', 'png'), true)
  assert.equal(await p.canHandle('SVG', 'webp'), true)
  assert.equal(await p.canHandle('svg', null), true)
  assert.equal(await p.canHandle('svg', 'pdf'), false)
  assert.equal(await p.canHandle('png', 'jpg'), false)
})

test('★ SVG 插件：没有 workerHost 时 available() 为 false', async () => {
  assert.equal(await createPlugin({}).available(), false)
  assert.equal(await createPlugin({ workerHost: null }).available(), false)
  // 残缺的 host（缺 encode）也算不可用 —— 不能只检查一个方法
  assert.equal(await createPlugin({ workerHost: { renderSvg () {} } }).available(), false)
  assert.equal(await createPlugin({ workerHost: fakeWorkerHost() }).available(), true)
})

// ---------------------------------------------------------------- convert

test('★ SVG 插件：convert 完整流程（落盘 + 文件名 + 真 PNG 魔数）', async () => {
  const host = fakeWorkerHost()
  const p = createPlugin({ workerHost: host })
  const srcDir = tmpDir('src')
  const outDir = tmpDir('out')
  const src = writeSvg(srcDir, 'a.svg', SVG_TEXT)

  const r = await p.convert([src], 'png', outDir)
  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 1)
  assert.equal(r.failures.length, 0)

  // ★ 文件名不能是 a.svg.png
  const dest = r.outputs[0].output
  assert.equal(path.basename(dest), 'a.png')
  assert.ok(fs.existsSync(dest))

  const buf = fs.readFileSync(dest)
  assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], '产物必须是真 PNG')

  // worker 调用链：先渲染再编码，mime 由 target 映射出来
  assert.equal(host.calls.render.length, 1)
  assert.equal(host.calls.encode[0].mime, 'image/png')
})

test('★ SVG 插件：jpg 目标映射成 image/jpeg，产物是真 JPEG', async () => {
  const host = fakeWorkerHost()
  const p = createPlugin({ workerHost: host })
  const outDir = tmpDir('out-jpg')
  const src = writeSvg(tmpDir('src-jpg'), 'b.svg', SVG_TEXT)

  const r = await p.convert([src], 'jpeg', outDir)
  assert.equal(r.ok, true)
  assert.equal(host.calls.encode[0].mime, 'image/jpeg')
  assert.equal(path.basename(r.outputs[0].output), 'b.jpeg')
  assert.deepEqual([...fs.readFileSync(r.outputs[0].output).slice(0, 3)], [0xff, 0xd8, 0xff])
})

test('★ SVG 插件：单文件失败不影响同批其它文件', async () => {
  const srcDir = tmpDir('src-mixed')
  const outDir = tmpDir('out-mixed')
  const good1 = writeSvg(srcDir, 'good1.svg', SVG_TEXT)
  // ★ fixture 必须**真的**没有尺寸信息（既无 width/height 也无 viewBox）：
  //   早先这里写的是 '<svg width="10" height="10">' —— 它有尺寸，与注释意图相反，
  //   失败其实全靠下面 stub 的字符串匹配硬塞，谁换成真的无尺寸 SVG 就会莫名变红。
  const bad = writeSvg(srcDir, 'bad.svg', NO_SIZE_SVG)
  const good2 = writeSvg(srcDir, 'good2.svg', SVG_TEXT)

  const host = fakeWorkerHost({
    // 语义条件：根 <svg> 上既没有 width 也没有 height ⇒ 模拟 worker 的尺寸判定失败
    render: (text) => (!/<svg\b[^>]*\b(?:width|height)\s*=/i.test(text) && !/viewBox/i.test(text))
      ? { ok: false, error: 'SVG 没有可用的尺寸信息（既无 width/height，也无 viewBox）' }
      : { ok: true, width: 64, height: 64, canvasId: 'c-ok' }
  })
  const p = createPlugin({ workerHost: host })

  const r = await p.convert([good1, bad, good2], 'png', outDir)
  assert.equal(r.ok, true, '有成功产物时整体应为 ok')
  assert.equal(r.outputs.length, 2)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].source, bad)
  assert.match(r.failures[0].error, /尺寸/)
  assert.ok(fs.existsSync(path.join(outDir, 'good1.png')))
  assert.ok(fs.existsSync(path.join(outDir, 'good2.png')))
  assert.ok(!fs.existsSync(path.join(outDir, 'bad.png')), '失败的文件不能留下产物')
})

test('★ SVG 插件：全部失败时 ok:false（绝不说成成功）', async () => {
  const outDir = tmpDir('out-allfail')
  const src = writeSvg(tmpDir('src-allfail'), 'x.svg', SVG_TEXT)
  const host = fakeWorkerHost({ render: () => ({ ok: false, error: 'SVG 载入超时' }) })
  const p = createPlugin({ workerHost: host })

  const r = await p.convert([src], 'png', outDir)
  assert.equal(r.ok, false)
  assert.equal(r.reason, REASON.FAILED)
  assert.equal(r.outputs.length, 0)
  assert.equal(r.failures.length, 1)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

test('★ SVG 插件：编码失败（worker 报不支持）也进 failures', async () => {
  const outDir = tmpDir('out-encfail')
  const src = writeSvg(tmpDir('src-encfail'), 'y.svg', SVG_TEXT)
  const host = fakeWorkerHost({
    encode: () => ({ ok: false, error: '浏览器不支持该编码格式（已回退为 image/png）' })
  })
  const p = createPlugin({ workerHost: host })

  const r = await p.convert([src], 'webp', outDir)
  assert.equal(r.ok, false)
  assert.equal(r.failures.length, 1)
  assert.match(r.failures[0].error, /不支持/)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

test('★ SVG 插件：魔数不对的产物被丢弃（防假成功）', async () => {
  const outDir = tmpDir('out-fake')
  const src = writeSvg(tmpDir('src-fake'), 'z.svg', SVG_TEXT)
  // worker 声称成功，但回的是 PNG 字节 —— 这正是 canvas 静默回退的样子
  const host = fakeWorkerHost({
    encode: () => ({ ok: true, bytes: pngBytes(), type: 'image/webp' })
  })
  const p = createPlugin({ workerHost: host })

  const r = await p.convert([src], 'webp', outDir)
  assert.equal(r.ok, false)
  assert.match(r.failures[0].error, /疑似编码器回退/)
  assert.equal(fs.readdirSync(outDir).length, 0, '不能落一个名不副实的文件')
})

test('SVG 插件：不支持的目标格式直接 usage 失败，不碰 worker', async () => {
  const host = fakeWorkerHost()
  const p = createPlugin({ workerHost: host })
  const src = writeSvg(tmpDir('src-usage'), 'u.svg', SVG_TEXT)

  const r = await p.convert([src], 'pdf', tmpDir('out-usage'))
  assert.equal(r.ok, false)
  assert.equal(r.reason, REASON.USAGE)
  assert.equal(host.calls.render.length, 0)
})

test('SVG 插件：空文件列表返回 usage 失败', async () => {
  const p = createPlugin({ workerHost: fakeWorkerHost() })
  const r = await p.convert([], 'png', tmpDir('out-empty'))
  assert.equal(r.ok, false)
  assert.equal(r.reason, REASON.USAGE)
})

test('SVG 插件：产物文件名去掉 .svg，不产生双扩展名', () => {
  const factory = require(PLUGIN_FILE)
  assert.equal(factory.outputName('C:/a/b.svg', 'png'), 'b.png')
  assert.equal(factory.outputName('C:/a/b.SVG', 'webp'), 'b.webp')
  assert.equal(factory.outputName('C:/a/my pic.svg', 'jpg'), 'my pic.jpg')
})

// ---------------------------------------------------------------- M1 同名覆盖

test('★ M1：同批同名源文件产出两个不同路径，内容各自正确（不能静默覆盖）', async () => {
  // 复现 QA 的用例：d1/same.svg（10×10 红）+ d2/same.svg（20×20 蓝）一批转换
  const d1 = tmpDir('m1-a')
  const d2 = tmpDir('m1-b')
  const outDir = tmpDir('m1-out')
  const s1 = writeSvg(d1, 'same.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<rect width="10" height="10" fill="#f00"/></svg>')
  const s2 = writeSvg(d2, 'same.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
    '<rect width="20" height="20" fill="#00f"/></svg>')

  // 假 host 按渲染尺寸产出可区分的字节：PNG 魔数 + 宽高，用来验证"内容各自正确"
  const host = fakeWorkerHost({
    render: (text) => {
      const w = /width="(\d+)"/.exec(text)[1] | 0
      return { ok: true, width: w, height: w, canvasId: 'c' + w }
    },
    encode: (canvasId) => {
      const w = canvasId.slice(1) | 0
      const b = Buffer.alloc(8)
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b, 0)
      b.writeUInt32BE(w, 4)
      return { ok: true, bytes: new Uint8Array(b), type: 'image/png' }
    }
  })
  const p = createPlugin({ workerHost: host })

  const r = await p.convert([s1, s2], 'png', outDir)
  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 2, '两个源文件必须有两个产物')

  const p1 = r.outputs[0].output
  const p2 = r.outputs[1].output
  assert.notEqual(p1, p2, '★ 两个产物的路径必须不同（否则就是互相覆盖的假成功）')
  assert.notEqual(
    path.resolve(p1).toLowerCase(),
    path.resolve(p2).toLowerCase(),
    '★ 规范化后也不能相同（Windows 大小写不敏感）'
  )
  assert.ok(fs.existsSync(p1) && fs.existsSync(p2))
  assert.equal(fs.readdirSync(outDir).length, 2, '磁盘上就该是 2 个文件')

  // 内容各自对应自己的源文件尺寸
  assert.equal(fs.readFileSync(p1).readUInt32BE(4), 10)
  assert.equal(fs.readFileSync(p2).readUInt32BE(4), 20)
  assert.equal(path.basename(p1), 'same.png')
  assert.equal(path.basename(p2), 'same-2.png')
})

test('★ M1：目标路径已被磁盘上已有文件占用时也换名（不覆盖别人的产物）', () => {
  const factory = require(PLUGIN_FILE)
  const dir = tmpDir('uniq-disk')
  const taken = path.join(dir, 'a.png')
  fs.writeFileSync(taken, 'x')
  // 磁盘上已有 ⇒ 换名，绝不默默覆盖
  assert.equal(factory.uniqueDest(taken, new Set()), path.join(dir, 'a-2.png'))

  // 批内已占用同理
  const used = new Set([path.join(dir, 'b.png').toLowerCase()])
  assert.equal(factory.uniqueDest(path.join(dir, 'b.png'), used), path.join(dir, 'b-2.png'))
  // 没冲突就原样返回
  assert.equal(factory.uniqueDest(path.join(dir, 'c.png'), used), path.join(dir, 'c.png'))

  // 大小写不敏感（Windows 文件系统）：A.png 与 a.png 是同一个名字
  const usedCase = new Set([path.join(dir, 'a.png').toLowerCase()])
  assert.equal(factory.uniqueDest(path.join(dir, 'A.png'), usedCase), path.join(dir, 'A-2.png'))
})

// ---------------------------------------------------------------- S2 webp 魔数

test('★ S2：伪造的 RIFF 容器（非 WEBP）必须判失败，不能只认 RIFF', async () => {
  const factory = require(PLUGIN_FILE)
  // 先直接验判定函数：AVI 也是 RIFF 容器
  const avi = Buffer.concat([
    Buffer.from('RIFF', 'ascii'), Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('AVI ', 'ascii'), Buffer.alloc(4)
  ])
  assert.equal(factory.looksLike(avi, 'webp'), false, 'AVI 不能被当成 WEBP')
  // 真的 WEBP 头必须过
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'), Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'), Buffer.alloc(4)
  ])
  assert.equal(factory.looksLike(webp, 'webp'), true)
  // 长度不够（只有 RIFF）也要判失败
  assert.equal(factory.looksLike(Buffer.from('RIFF', 'ascii'), 'webp'), false)

  // 端到端：编码器回了 AVI 却声称是 webp ⇒ 不落盘
  const outDir = tmpDir('out-avi')
  const src = writeSvg(tmpDir('src-avi'), 'v.svg', SVG_TEXT)
  const host = fakeWorkerHost({ encode: () => ({ ok: true, bytes: new Uint8Array(avi), type: 'image/webp' }) })
  const p = createPlugin({ workerHost: host })
  const r = await p.convert([src], 'webp', outDir)
  assert.equal(r.ok, false)
  assert.match(r.failures[0].error, /疑似编码器回退/)
  assert.equal(fs.readdirSync(outDir).length, 0)
})

// ---------------------------------------------------------------- S1 单边尺寸

test('★ S1：只写 width="300" 能转，尺寸 300×150（不再误判成没尺寸）', () => {
  // 纯逻辑层：根元素声明过尺寸 ⇒ 允许采用浏览器算出的 natural
  const m = convertWorker.parseSvgMetrics('<svg xmlns="http://www.w3.org/2000/svg" width="300"></svg>')
  assert.equal(m.declared, true, '只要出现过 width/height 就算 declared')
  assert.equal(m.width, 300)
  assert.equal(m.height, 0, 'height 未声明，文本层解析不出')

  const r = convertWorker.decideRenderSize(m, { naturalWidth: 300, naturalHeight: 150 })
  assert.equal(r.ok, true)
  assert.deepEqual([r.width, r.height], [300, 150])
  assert.equal(r.from, 'natural-declared')

  // 只写 height 同理
  const m2 = convertWorker.parseSvgMetrics('<svg xmlns="http://www.w3.org/2000/svg" height="150"></svg>')
  const r2 = convertWorker.decideRenderSize(m2, { naturalWidth: 300, naturalHeight: 150 })
  assert.equal(r2.ok, true)
  assert.deepEqual([r2.width, r2.height], [300, 150])
})

test('★ S1：真的没有任何尺寸声明时仍然必须失败（不能靠 natural 蒙混）', () => {
  const m = convertWorker.parseSvgMetrics(NO_SIZE_SVG)
  assert.equal(m.declared, false)
  assert.equal(m.viewBox, null)
  // 无声明时 natural 报的是默认盒 300×150 —— 必须判"没有尺寸信息"
  const r = convertWorker.decideRenderSize(m, { naturalWidth: 300, naturalHeight: 150 })
  assert.equal(r.ok, false)
  assert.match(r.error, /尺寸/)
})

test('★ S1：尺寸判定优先级（attrs → 声明的 natural → viewBox → natural）', () => {
  // ① 两边都声明：用文本值
  const both = convertWorker.parseSvgMetrics('<svg width="64" height="64"></svg>')
  assert.deepEqual(
    [convertWorker.decideRenderSize(both, { naturalWidth: 999, naturalHeight: 999 }).width,
      convertWorker.decideRenderSize(both, { naturalWidth: 999, naturalHeight: 999 }).from],
    [64, 'attrs']
  )

  // ② 声明了单边 + 有 viewBox：用浏览器按宽高比补全的 natural（40×20，不是 viewBox 的 20×10）
  const single = convertWorker.parseSvgMetrics('<svg width="40" viewBox="0 0 20 10"></svg>')
  const r2 = convertWorker.decideRenderSize(single, { naturalWidth: 40, naturalHeight: 20 })
  assert.deepEqual([r2.width, r2.height, r2.from], [40, 20, 'natural-declared'])

  // ③ 没声明尺寸 + 有 viewBox：用 viewBox，且**不能**被 225×150 的默认盒带偏
  const vbOnly = convertWorker.parseSvgMetrics('<svg viewBox="0 0 48 32"></svg>')
  const r3 = convertWorker.decideRenderSize(vbOnly, { naturalWidth: 225, naturalHeight: 150 })
  assert.deepEqual([r3.width, r3.height, r3.from], [48, 32, 'viewBox'])
})

test('S1：SVG 文本缺 <svg> 根元素时各字段为零值，不会抛错', () => {
  const m = convertWorker.parseSvgMetrics('not an svg')
  assert.deepEqual(m, { width: 0, height: 0, declared: false, viewBox: null })
  assert.equal(convertWorker.parseLength('100%'), 0)
  assert.equal(convertWorker.parseLength('12px'), 12)
  assert.equal(convertWorker.parseLength('0'), 0)
})

// ---------------------------------------------------------------- S1 回归保护
//
// ★ 这一组是 QA 第二轮抓到的回归的保护网（2026-11-16）：
//   修 S1 时我把 declared 写成了"根元素出现过 width/height 就算"，
//   于是 `%` / `em` / `cm` 这类**没有绝对值**的声明也走了 natural，
//   把浏览器按默认盒推出来的 150×150 / 16×16 / 76×38 顶掉了正确的 viewBox 尺寸。
//   下面每条的 natural 值都是**真机实测**的派生值 —— 断言"绝不能采用它"，
//   这样谁再放宽 declared，这里会立刻红。

test('★ S1 回归：width="100%" + viewBox 必须用 viewBox（24×24），不能吃 150×150 默认盒', () => {
  const m = convertWorker.parseSvgMetrics(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24"></svg>')
  assert.equal(m.declared, false, '百分比没有绝对值 ⇒ 不算 declared')
  // 真机实测：这个 SVG 的 natural 是 150×150（默认盒按 1:1 缩放）
  const r = convertWorker.decideRenderSize(m, { naturalWidth: 150, naturalHeight: 150 })
  assert.equal(r.ok, true)
  assert.deepEqual([r.width, r.height], [24, 24])
  assert.notEqual(r.from, 'natural-declared', '百分比不能走"声明的 natural"这一档')
})

test('★ S1 回归：width/height="50%" + viewBox="0 0 30 10" → 30×10（不是 300×100）', () => {
  const m = convertWorker.parseSvgMetrics(
    '<svg xmlns="http://www.w3.org/2000/svg" width="50%" height="50%" viewBox="0 0 30 10"></svg>')
  assert.equal(m.declared, false)
  const r = convertWorker.decideRenderSize(m, { naturalWidth: 300, naturalHeight: 100 })
  assert.deepEqual([r.width, r.height], [30, 10])
})

test('★ S1 回归：width="2cm" height="1cm" + viewBox="0 0 30 10" → 30×10（不是 76×38）', () => {
  const m = convertWorker.parseSvgMetrics(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2cm" height="1cm" viewBox="0 0 30 10"></svg>')
  assert.equal(m.declared, false, 'cm 依赖 DPI，解析不出绝对像素 ⇒ 不算 declared')
  const r = convertWorker.decideRenderSize(m, { naturalWidth: 76, naturalHeight: 38 })
  assert.deepEqual([r.width, r.height], [30, 10])
})

test('★ S1 回归：width="1em" height="1em" + viewBox="0 0 24 24" → 24×24（不是 16×16）', () => {
  const m = convertWorker.parseSvgMetrics(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"></svg>')
  assert.equal(m.declared, false, 'em 依赖字号 ⇒ 不算 declared')
  const r = convertWorker.decideRenderSize(m, { naturalWidth: 16, naturalHeight: 16 })
  assert.deepEqual([r.width, r.height], [24, 24])
})

test('★ S1 反向保护：width="300"（绝对像素）仍必须走 natural-declared → 300×150', () => {
  // 防止有人为了修上面的回归，把"声明的 natural"这一档整段删掉 —— 那样 S1 主诉会复发
  const m = convertWorker.parseSvgMetrics('<svg xmlns="http://www.w3.org/2000/svg" width="300"></svg>')
  assert.equal(m.declared, true, '绝对像素 ⇒ 算 declared')
  const r = convertWorker.decideRenderSize(m, { naturalWidth: 300, naturalHeight: 150 })
  assert.deepEqual([r.width, r.height], [300, 150])
  assert.equal(r.from, 'natural-declared')
})

test('★ S1 回归：相对单位 + 无 viewBox + 无绝对尺寸 ⇒ 仍然明确失败（不能靠默认盒出图）', () => {
  const m = convertWorker.parseSvgMetrics(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"></svg>')
  assert.equal(m.declared, false)
  const r = convertWorker.decideRenderSize(m, { naturalWidth: 300, naturalHeight: 150 })
  assert.equal(r.ok, false, '没有任何绝对尺寸信息时宁可报错，也不出 300×150 的蒙混图')
})

test('S1：declared 只认绝对像素（无单位 / px），其余一律不算', () => {
  const cases = [
    ['width="300"', true],
    ['width="300px"', true],
    ['width="12.5"', true],
    ['width="100%"', false],
    ['width="1em"', false],
    ['width="2cm"', false],
    ['width="10pt"', false],
    ['height="150"', true],
    ['', false]
  ]
  for (const [attr, expected] of cases) {
    const m = convertWorker.parseSvgMetrics('<svg xmlns="http://www.w3.org/2000/svg" ' + attr + '></svg>')
    assert.equal(m.declared, expected, attr + ' 的 declared 应为 ' + expected)
  }
})

// ---------------------------------------------------------------- 插件加载

test('★ SVG 插件：被 loadPlugins 从插件目录加载（无需改核心代码）', () => {
  const dir = tmpDir('plugdir')
  fs.copyFileSync(PLUGIN_FILE, path.join(dir, 'svg.js'))

  const r = plugins.loadPlugins({
    env: { STICKY_CONVERT_PLUGINS: dir },
    context: { workerHost: fakeWorkerHost() }
  })
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
  assert.equal(r.providers.length, 1)
  assert.equal(r.providers[0].id, 'builtin-vector-svg')
})

test('★ SVG 插件：通过默认 provider 列表 + 路由真正生效', async () => {
  const dir = tmpDir('routedir')
  fs.copyFileSync(PLUGIN_FILE, path.join(dir, 'svg.js'))
  const host = fakeWorkerHost()

  const list = providersIndex.createDefaultProviders({
    withFilee: false,
    env: { STICKY_CONVERT_PLUGINS: dir },
    workerHost: host
  })
  assert.ok(list.some(p => p.id === 'builtin-vector-svg'), '插件应在默认列表里')

  const router = createRouter({ providers: list })
  const caps = await router.capabilities('svg')
  assert.equal(caps.ok, true)
  assert.ok(caps.targets.includes('png'))

  const outDir = tmpDir('routeout')
  const src = writeSvg(tmpDir('routesrc'), 'r.svg', SVG_TEXT)
  const conv = await router.convert([src], 'png', outDir)
  assert.equal(conv.ok, true)
  assert.equal(conv.provider, 'builtin-vector-svg')
  assert.ok(fs.existsSync(conv.outputs[0].output))
})

test('SVG 插件：没有 workerHost 时被路由跳过（能力不出现在 svg 上）', async () => {
  const dir = tmpDir('noworker')
  fs.copyFileSync(PLUGIN_FILE, path.join(dir, 'svg.js'))

  const list = providersIndex.createDefaultProviders({
    withFilee: false,
    env: { STICKY_CONVERT_PLUGINS: dir },
    workerHost: null
  })
  const router = createRouter({ providers: list })
  const caps = await router.capabilities('svg')
  // 没有插件也没有内置引擎能处理 svg ⇒ 必须明确失败，而不是给出一个假的能力清单
  assert.equal(caps.ok, false)
  assert.deepEqual(caps.targets, [])
})

// ---------------------------------------------------------------- S3：产物级警告

/**
 * S3 要解决的问题：
 *   `<svg width="20" height="20"></svg>` 是合法空 SVG，转出全透明 PNG 是"正确"的，
 *   但 `ok:true` 让用户完全不知道自己拿到的是一张空白图 —— 软性假成功。
 *
 *   修法不是把它判失败，而是把 blank/externalRef/scaled 作为产物级警告
 *   一路透传到 UI。这一组用例锁的就是这条链路的起点（插件产出 warnings）。
 */

test('★ S3：全透明产物必须带 blank 警告（不能只打日志）', async () => {
  const { WARN, warn } = require('../examples/convert-plugins/svg.js')

  const host = fakeWorkerHost({
    // 模拟 worker 识别出画布全透明
    render: () => ({ ok: true, width: 20, height: 20, canvasId: 'c1', blank: true })
  })
  const p = createPlugin({ workerHost: host })
  const src = writeSvg(tmpDir('blank'), 'empty.svg', '<svg width="20" height="20"></svg>')
  const r = await p.convert([src], 'png', tmpDir('blankout'))

  assert.equal(r.ok, true, '空 SVG 转出空白图不是失败')
  assert.equal(r.outputs.length, 1)
  const ws = r.outputs[0].warnings
  assert.ok(Array.isArray(ws) && ws.length, '产物必须带 warnings，不能只打日志')
  assert.ok(ws.some(w => w.code === WARN.BLANK), '警告 code 必须是 blank：' + JSON.stringify(ws))
  assert.ok(ws.every(w => typeof w.message === 'string' && w.message.length > 0), 'message 必须给用户看')
  // WARN/warn 的本地副本要与框架一致（插件在 userData 下没法 require 框架）
  const framework = require('../lib/convert/provider')
  assert.deepEqual(WARN.BLANK, framework.WARN.BLANK)
  assert.deepEqual(warn('x', 'y'), framework.warn('x', 'y'))
})

test('★ S3：外部引用与尺寸缩小也要作为警告带回（不是失败）', async () => {
  const { WARN } = require('../examples/convert-plugins/svg.js')

  const host = fakeWorkerHost({
    render: () => ({
      ok: true, width: 8192, height: 4096, canvasId: 'c1',
      externalRef: true, scaled: true
    })
  })
  const p = createPlugin({ workerHost: host })
  const src = writeSvg(tmpDir('warns'), 'a.svg', SVG_TEXT)
  const r = await p.convert([src], 'png', tmpDir('warnout'))

  assert.equal(r.ok, true)
  const codes = (r.outputs[0].warnings || []).map(w => w.code)
  assert.ok(codes.includes(WARN.EXTERNAL_REF), '外部引用要提示：' + JSON.stringify(codes))
  assert.ok(codes.includes(WARN.SCALED), '尺寸缩小要提示：' + JSON.stringify(codes))
})

test('S3：正常产物不带 warnings 字段（避免噪声）', async () => {
  const p = createPlugin({ workerHost: fakeWorkerHost() })   // render 无 blank/scaled/externalRef
  const src = writeSvg(tmpDir('clean'), 'a.svg', SVG_TEXT)
  const r = await p.convert([src], 'png', tmpDir('cleanout'))
  assert.equal(r.ok, true)
  assert.ok(!('warnings' in r.outputs[0]), '没有问题的产物不该挂 warnings')
})

test('★ S3：warnings 能穿过 service 到达 attachments[i].warnings', async () => {
  const serviceLib = require('../lib/convert/service')
  const host = fakeWorkerHost({
    render: () => ({ ok: true, width: 20, height: 20, canvasId: 'c1', blank: true })
  })

  // 直接把插件 provider 注入 service，验 service 层的透传（不依赖插件目录）
  const p = createPlugin({ workerHost: host })
  const userDataDir = tmpDir('s3svc')
  const svc = serviceLib.createService({ userDataDir, providers: [p] })
  const src = writeSvg(tmpDir('s3src'), 'empty.svg', '<svg width="20" height="20"></svg>')

  const r = await svc.convert([src], 'png')

  assert.equal(r.ok, true)
  assert.equal(r.attachments.length, 1)
  const ws = r.attachments[0].warnings
  assert.ok(Array.isArray(ws) && ws.length, '附件必须带上产物警告')
  assert.ok(ws.some(w => w.code === 'blank'))
})

test('★ S3：main-bridge 的 collectWarnings 汇总并去重（一次转 3 张空图只报一遍）', () => {
  const { collectWarnings } = require('../lib/convert/main-bridge')
  const w = { code: 'blank', message: '产物是全透明的空白图' }
  const r = {
    warnings: [{ code: 'engine', message: '引擎降级' }],
    attachments: [
      { warnings: [w] },
      { warnings: [w] },
      { warnings: [w] }
    ]
  }
  const out = collectWarnings(r)
  assert.equal(out.length, 2, '3 条相同的 blank 应合并成 1 条，另加 1 条整体级')
  assert.deepEqual(out.map(x => x.code).sort(), ['blank', 'engine'])
})

test('S3：collectWarnings 对脏数据不炸（null / 非对象）', () => {
  const { collectWarnings } = require('../lib/convert/main-bridge')
  const out = collectWarnings({
    warnings: [null, 42, { code: 'ok' }],
    attachments: [null, { warnings: null }, { warnings: [{ message: '只有 message' }] }]
  })
  assert.equal(out.length, 2)
})
