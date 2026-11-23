'use strict'

/**
 * 内置 SVG provider（lib/convert/providers/svg.js）与插件优先级单测。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { validateProvider, REASON, WARN } = require('../lib/convert/provider')
const svgBuiltin = require('../lib/convert/providers/svg')
const providersIndex = require('../lib/convert/providers')
const { createRouter } = require('../lib/convert/router')

const PLUGIN_FILE = path.join(__dirname, '..', 'examples', 'convert-plugins', 'svg.js')

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-svgbi-' + tag + '-'))
}

function fakeHost (over = {}) {
  let seq = 0
  return {
    async renderSvg (svgText) {
      if (typeof over.renderSvg === 'function') return over.renderSvg(svgText)
      return { ok: true, width: 32, height: 32, canvasId: 'svg-c' + (++seq) }
    },
    async encode (canvasId, mime) {
      if (typeof over.encode === 'function') return over.encode(canvasId, mime)
      const bytes = mime === 'image/png'
        ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        : Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
      return { ok: true, bytes, type: mime }
    }
  }
}

test('★ builtin-svg：满足契约，无 workerHost 时 available() 为 false', async () => {
  const noHost = svgBuiltin.createSvgProvider({})
  assert.equal(validateProvider(noHost).ok, true)
  assert.equal(noHost.id, 'builtin-svg')
  assert.equal(await noHost.available(), false)

  const withHost = svgBuiltin.createSvgProvider({ workerHost: fakeHost() })
  assert.equal(await withHost.available(), true)
  const caps = await withHost.capabilities('svg')
  assert.equal(caps.ok, true)
  assert.deepEqual(caps.targets.slice().sort(), ['jpeg', 'jpg', 'png', 'webp'])
  const badCaps = await withHost.capabilities('png')
  assert.equal(badCaps.ok, false)
  assert.equal(badCaps.reason, REASON.USAGE)
})

test('★ builtin-svg：魔数防线、产物警告透传与防重名覆盖', async t => {
  const dir = tmpDir('svg')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const outDir = tmpDir('svg-out')
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }))

  const d1 = path.join(dir, 'd1')
  const d2 = path.join(dir, 'd2')
  fs.mkdirSync(d1)
  fs.mkdirSync(d2)
  const s1 = path.join(d1, 'same.svg')
  const s2 = path.join(d2, 'same.svg')
  fs.writeFileSync(s1, '<svg width="10" height="10"></svg>')
  fs.writeFileSync(s2, '<svg width="20" height="20"><rect width="20" height="20"/></svg>')

  const pWarn = svgBuiltin.createSvgProvider({
    workerHost: fakeHost({
      renderSvg: async () => ({
        ok: true, width: 10, height: 10, canvasId: 'c1',
        blank: true, externalRef: true, scaled: true
      })
    })
  })
  const r = await pWarn.convert([s1, s2], 'png', outDir)
  assert.equal(r.ok, true)
  assert.equal(r.outputs.length, 2)
  assert.notEqual(r.outputs[0].output, r.outputs[1].output)
  const codes = (r.outputs[0].warnings || []).map(w => w.code)
  assert.ok(codes.includes(WARN.BLANK))
  assert.ok(codes.includes(WARN.EXTERNAL_REF))
  assert.ok(codes.includes(WARN.SCALED))

  // 编码器回错格式 ⇒ 零产物失败
  const badOut = tmpDir('svg-bad')
  t.after(() => fs.rmSync(badOut, { recursive: true, force: true }))
  const pBad = svgBuiltin.createSvgProvider({
    workerHost: fakeHost({
      encode: async () => ({ ok: true, type: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
    })
  })
  const rBad = await pBad.convert([s1], 'jpg', badOut)
  assert.equal(rBad.ok, false)
  assert.equal(fs.readdirSync(badOut).length, 0)
})

test('★ 默认优先级：无插件时命中 builtin-svg；投放 svg 插件时插件优先', async t => {
  const dir = tmpDir('prio')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const src = path.join(dir, 'icon.svg')
  fs.writeFileSync(src, '<svg width="16" height="16"><rect width="16" height="16"/></svg>')

  const out1 = path.join(dir, 'out1')
  const out2 = path.join(dir, 'out2')
  fs.mkdirSync(out1)
  fs.mkdirSync(out2)

  const host = fakeHost()
  const listNoPlugin = providersIndex.createDefaultProviders({
    workerHost: host,
    withFilee: false,
    withPlugins: false
  })
  const router1 = createRouter({ providers: listNoPlugin })
  const r1 = await router1.convert([src], 'png', out1)
  assert.equal(r1.ok, true)
  assert.equal(r1.provider, 'builtin-svg')

  const plugDir = path.join(dir, 'plugs')
  fs.mkdirSync(plugDir)
  fs.copyFileSync(PLUGIN_FILE, path.join(plugDir, 'svg.js'))
  const listWithPlugin = providersIndex.createDefaultProviders({
    workerHost: host,
    withFilee: false,
    env: { STICKY_CONVERT_PLUGINS: plugDir }
  })
  const router2 = createRouter({ providers: listWithPlugin })
  const r2 = await router2.convert([src], 'png', out2)
  assert.equal(r2.ok, true)
  assert.equal(r2.provider, 'builtin-vector-svg')
})
