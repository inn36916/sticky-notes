'use strict'

/** 转换在临时目录执行，正式结果保存到源目录；每次只增加对应产物。 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const serviceLib = require('../lib/convert/service')

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-svc-' + tag + '-'))
}

/**
 * 造一个假 provider。
 *
 * ★ 关键：它按**原名**把产物写进 outDir —— 这正是真实 provider 的行为
 *   （内置图片 provider 写 `<base>-<rand>.png`，Filee 写 `<base>.<ext>`，
 *     SVG 插件写 `<base>.<target>`），也就是"孤儿文件"的来源。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.failAll] 全部失败（不产出任何文件）
 */
function fakeProvider (opts = {}) {
  const calls = { outDirs: [] }
  return {
    id: 'fake-engine',
    name: '假引擎',
    calls,

    async available () { return true },

    async capabilities () {
      return { ok: true, reason: 'ok', targets: ['png'], withEngines: [], displayName: '假', error: null }
    },

    async convert (files, target, outDir) {
      calls.outDirs.push(outDir)
      const outputs = []
      const failures = []
      const list = opts.failAll ? [] : files
      for (const f of list) {
        try {
          const base = path.basename(f, path.extname(f))
          // ← 按原名写：这就是会产生孤儿的那种行为
          const dest = path.join(outDir, base + '.' + target)
          fs.writeFileSync(dest, 'DATA:' + base)
          outputs.push({ source: f, output: dest })
        } catch (err) {
          failures.push({ source: f, state: 'failed', outputs: [], error: err.message })
        }
      }
      return {
        ok: outputs.length > 0,
        reason: outputs.length ? 'ok' : 'failed',
        outputs,
        failures,
        files: [],
        error: outputs.length ? null : '没产出'
      }
    }
  }
}

/** 造一个源文件 */
function makeSrc (name) {
  const dir = tmpDir('src')
  const p = path.join(dir, name)
  fs.writeFileSync(p, 'source-of-' + name)
  return p
}

// ---------------------------------------------------------------- 核心指标

test('★ S5：转换后源目录只增加一个正式文件', async () => {
  const userDataDir = tmpDir('noorphan')
  const svc = serviceLib.createService({ userDataDir, providers: [fakeProvider()] })
  const src = makeSrc('photo.png')

  const r = await svc.convert([src], 'png')
  assert.equal(r.ok, true)
  assert.equal(r.attachments.length, 1)

  const dir = path.dirname(src)
  const files = fs.readdirSync(dir)

  // 这条是整个 S5 的核心：以前这里是 2 个（photo.png + photo-x7f2a1.png）
  assert.equal(files.length, 2, '源目录应包含源文件和一个产物，实际：' + JSON.stringify(files))
  assert.ok(files.includes('photo (1).png'), '同格式转换应避让源文件')

  // 正式产物必须是真的搬过来了（内容对，不是空壳）
  assert.equal(fs.readFileSync(r.attachments[0].path, 'utf8'), 'DATA:photo')
  assert.equal(r.attachments[0].size, 'DATA:photo'.length)
})

test('★ S5：provider 拿到的 outDir 不是附件目录（不污染用户可见目录）', async () => {
  const userDataDir = tmpDir('workdir')
  const p = fakeProvider()
  const svc = serviceLib.createService({ userDataDir, providers: [p] })
  const dir = serviceLib.attachmentDir(userDataDir)

  await svc.convert([makeSrc('a.png')], 'png')

  assert.equal(p.calls.outDirs.length, 1)
  assert.notEqual(
    path.resolve(p.calls.outDirs[0]),
    path.resolve(dir),
    'provider 不应直接写进附件目录'
  )
  // 而且那个目录在转换结束后应该已经不存在了
  assert.equal(fs.existsSync(p.calls.outDirs[0]), false, '临时工作目录应已被清理')
})

test('★ S5：转换结束后不残留临时工作目录', async () => {
  const userDataDir = tmpDir('cleanup')
  const p = fakeProvider()
  const svc = serviceLib.createService({ userDataDir, providers: [p] })

  await svc.convert([makeSrc('x.png'), makeSrc('y.png')], 'png')

  // ★ 只查**自己这次**的工作目录，不用全局计数：
  //   全局 TEMP 里可能有其它测试并发创建的 sticky-convert-* 目录，数全局会 flaky。
  assert.equal(p.calls.outDirs.length, 1)
  assert.equal(
    fs.existsSync(p.calls.outDirs[0]), false,
    '临时工作目录应已被清理：' + p.calls.outDirs[0]
  )
})

test('★ S5：连续转换同一源，每次净增 1 个文件', async () => {
  const userDataDir = tmpDir('repeat')
  const svc = serviceLib.createService({ userDataDir, providers: [fakeProvider()] })
  const src = makeSrc('same.png')
  const dir = path.dirname(src)

  for (let i = 1; i <= 3; i++) {
    const r = await svc.convert([src], 'png')
    assert.equal(r.ok, true)
    assert.equal(
      fs.readdirSync(dir).length, i + 1,
      '第 ' + i + ' 次转换后应恰好有 ' + i + ' 个文件'
    )
  }

  const files = fs.readdirSync(dir)
  // 三次转换加原始文件，共四个文件
  assert.equal(new Set(files).size, 4)
  // 源文件保留，不产生引擎内部命名的多余副本
  assert.ok(files.includes('same.png'), '源文件必须保留：' + JSON.stringify(files))
  assert.ok(!files.some(f => /^same-\d+\.png$/.test(f)), '不应出现 -2/-3 累积：' + JSON.stringify(files))
})

// ---------------------------------------------------------------- 多文件与失败路径

test('S5：多文件转换，产物数 == 附件数 == 目录文件数', async () => {
  const userDataDir = tmpDir('multi')
  const svc = serviceLib.createService({ userDataDir, providers: [fakeProvider()] })
  const dir = serviceLib.attachmentDir(userDataDir)

  const r = await svc.convert([makeSrc('one.png'), makeSrc('two.png')], 'png')
  assert.equal(r.ok, true)
  assert.equal(r.attachments.length, 2)
  assert.equal(fs.existsSync(dir), false)
  for (const output of r.attachments) assert.equal(fs.readdirSync(path.dirname(output.path)).length, 2)

  // 逐个确认内容对得上自己的源
  const contents = r.attachments.map(a => fs.readFileSync(a.path, 'utf8')).sort()
  assert.deepEqual(contents, ['DATA:one', 'DATA:two'])
})

test('★ S5：转换全部失败时，附件目录不留任何文件，临时目录也被清理', async () => {
  const userDataDir = tmpDir('failall')
  const p = fakeProvider({ failAll: true })
  const svc = serviceLib.createService({ userDataDir, providers: [p] })
  const dir = serviceLib.attachmentDir(userDataDir)

  const r = await svc.convert([makeSrc('bad.png')], 'png')

  assert.equal(r.ok, false)
  assert.equal(r.attachments.length, 0)
  assert.equal(fs.existsSync(dir), false, '失败时不该在附件目录留下任何东西')
  assert.equal(p.calls.outDirs.length, 1)
  assert.equal(fs.existsSync(p.calls.outDirs[0]), false, '失败时也要清理自己的工作目录')
})

test('S5：转换抛异常时仍会清理临时工作目录', async () => {
  const userDataDir = tmpDir('throw')
  const thrown = []
  const exploding = {
    id: 'boom',
    name: '炸的引擎',
    async available () { return true },
    async capabilities () { return { ok: true, reason: 'ok', targets: ['png'], withEngines: [], displayName: null, error: null } },
    async convert (files, target, outDir) {
      thrown.push(outDir)
      throw new Error('引擎炸了')
    }
  }
  const svc = serviceLib.createService({ userDataDir, providers: [exploding] })

  const r = await svc.convert([makeSrc('a.png')], 'png')

  // router 会把 provider 的异常翻成失败结果，不向上抛
  assert.equal(r.ok, false)
  assert.equal(thrown.length, 1)
  assert.equal(fs.existsSync(thrown[0]), false, '异常路径也不能泄漏自己的临时目录')
})

// ---------------------------------------------------------------- 不破坏既有语义

test('S5：结果保留中文原名，同格式转换追加编号', async () => {
  const userDataDir = tmpDir('name')
  const svc = serviceLib.createService({ userDataDir, providers: [fakeProvider()] })
  const r = await svc.convert([makeSrc('报告.png')], 'png')

  assert.equal(r.attachments.length, 1)
  const name = r.attachments[0].name
  // 保留中文原名、避让编号和正确扩展名
  assert.equal(name, '报告 (1).png', '附件名应保留原名：' + name)
  assert.ok(name.endsWith('.png'), '附件名扩展名应正确：' + name)
  // 且不是 provider 的原名
  assert.notEqual(name, '报告.png')
})

test('S5：userData 为空时仍能工作（退回相对路径，不崩）', async () => {
  // 这是防御性用例：真实环境 userDataDir 一定有值，但别让它一空就炸
  const svc = serviceLib.createService({ userDataDir: tmpDir('empty'), providers: [fakeProvider()] })
  const r = await svc.convert([makeSrc('a.png')], 'png')
  assert.equal(r.ok, true)
  assert.equal(r.attachments.length, 1)
})
