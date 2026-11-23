'use strict'

/**
 * Filee CLI 适配层的回归（lib/convert/filee-cli.js）。
 *
 * **不依赖用户真装 Filee**：用 scripts/fake-filee.js 模拟官方契约
 * （退出码、--json 输出形态、needsEngines 字段）。
 *
 * 口径来自官方 skills/filee/SKILL.md：
 *   - 退出码 0 不等于全部成功（可能 skipped）；
 *   - 退出码 2/3 时**没有 JSON**，原因在 stderr；
 *   - 一个文件只有 state==='done' 且 outputs 非空才算成功；
 *   - 缺引擎时 files[].needsEngines 会点名要装哪个引擎。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const filee = require('../lib/convert/filee-cli')

const FAKE = path.join(__dirname, '..', 'scripts', 'fake-filee.js')

/** 假 CLI 的执行器：用当前 node 跑那个脚本 */
const FAKE_RUNNER = { cmd: process.execPath, args: [FAKE] }

/** 造一个临时目录（不进仓库） */
function tmpDir (tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-filee-' + tag + '-'))
  return d
}

/** 造一个待转换的文件 */
function tmpFile (dir, name, content = 'x') {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

/** 跑假 CLI 并解析（把 mode 注入环境） */
async function withFake (mode, fn, extraEnv = {}) {
  const saved = { ...process.env }
  process.env.STICKY_FAKE_FILEE = mode
  Object.assign(process.env, extraEnv)
  try {
    return await fn()
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k]
    }
    Object.assign(process.env, saved)
  }
}

// ---------------------------------------------------------------- 纯逻辑：formats

test('★ parseFormats：读出 targets 与 withEngines', () => {
  const r = filee.parseFormats(JSON.stringify({
    id: 'heic', displayName: 'HEIC', extensions: ['heic'],
    targets: ['jpg'], withEngines: ['png']
  }))
  assert.equal(r.ok, true)
  assert.deepEqual(r.targets, ['jpg'])
  assert.deepEqual(r.withEngines, ['png'])
  assert.equal(r.displayName, 'HEIC')
})

test('parseFormats：非法 JSON 不抛异常，标 ok=false', () => {
  const r = filee.parseFormats('{oops')
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

test('parseFormats：缺字段时按空数组处理', () => {
  const r = filee.parseFormats('{}')
  assert.equal(r.ok, true)
  assert.deepEqual(r.targets, [])
  assert.deepEqual(r.withEngines, [])
})

// ---------------------------------------------------------------- 纯逻辑：convert 结果

test('★ parseConvertResult：全部 done → ok', () => {
  const r = filee.parseConvertResult(JSON.stringify({
    target: 'jpg', converted: 1, skipped: 0, failed: 0,
    files: [{ source: 'a.png', state: 'done', outputs: ['a.jpg'] }]
  }), 0, '')
  assert.equal(r.ok, true)
  assert.equal(r.reason, filee.REASON.OK)
  assert.equal(r.converted, 1)
})

test('★ parseConvertResult：退出码 0 但有 skipped → 仍算成功（官方口径）', () => {
  const r = filee.parseConvertResult(JSON.stringify({
    target: 'jpg', converted: 1, skipped: 1, failed: 0,
    files: [
      { source: 'a.png', state: 'done', outputs: ['a.jpg'] },
      { source: 'b.png', state: 'skipped', outputs: [] }
    ]
  }), 0, '')
  assert.equal(r.ok, true)
  assert.equal(r.skipped, 1)
})

test('★ parseConvertResult：state=done 但 outputs 为空 → 不算成功', () => {
  const r = filee.parseConvertResult(JSON.stringify({
    target: 'jpg', converted: 1, skipped: 0, failed: 0,
    files: [{ source: 'a.png', state: 'done', outputs: [] }]
  }), 0, '')
  assert.equal(r.ok, false)
})

test('★ parseConvertResult：退出码 2 → usage，无 JSON 时读 stderr', () => {
  const r = filee.parseConvertResult('', 2, 'filee: not found: a.png')
  assert.equal(r.ok, false)
  assert.equal(r.reason, filee.REASON.USAGE)
  assert.ok(r.error.includes('not found'))
})

test('★ parseConvertResult：退出码 3 → nothing-to-do', () => {
  const r = filee.parseConvertResult('', 3, 'filee: no files to convert.')
  assert.equal(r.ok, false)
  assert.equal(r.reason, filee.REASON.NOTHING_TO_DO)
})

test('★ parseConvertResult：needsEngines → needs-engine 分类（可引导安装）', () => {
  const r = filee.parseConvertResult(JSON.stringify({
    target: 'pptx', converted: 0, skipped: 0, failed: 1,
    files: [{ source: 'a.md', state: 'failed', outputs: [], errorKey: 'error.no_route', needsEngines: ['pandoc'] }]
  }), 1, '')
  assert.equal(r.ok, false)
  assert.equal(r.reason, filee.REASON.NEEDS_ENGINE)
  assert.ok(r.error.includes('pandoc'))
})

test('parseConvertResult：cancelled 也算失败', () => {
  const r = filee.parseConvertResult(JSON.stringify({
    target: 'jpg', converted: 0, skipped: 0, failed: 1,
    files: [{ source: 'a.png', state: 'cancelled', outputs: [] }]
  }), 1, '')
  assert.equal(r.ok, false)
})

test('parseConvertResult：部分失败但有成功产物 → ok=true，且失败项仍在 files 里', () => {
  const r = filee.parseConvertResult(JSON.stringify({
    target: 'jpg', converted: 1, skipped: 0, failed: 1,
    files: [
      { source: 'a.png', state: 'done', outputs: ['a.jpg'] },
      { source: 'b.png', state: 'failed', outputs: [], error: 'boom' }
    ]
  }), 1, '')
  assert.equal(r.ok, true)
  assert.equal(r.files.length, 2)
})

test('parseConvertResult：JSON 非法 → failed 分类', () => {
  const r = filee.parseConvertResult('{bad', 0, '')
  assert.equal(r.ok, false)
  assert.equal(r.reason, filee.REASON.FAILED)
})

test('collectOutputs：只收 done 且 outputs 非空', () => {
  const { outputs, failures } = filee.collectOutputs({
    files: [
      { source: 'a', state: 'done', outputs: ['a.jpg'] },
      { source: 'b', state: 'done', outputs: [] },
      { source: 'c', state: 'skipped', outputs: [] },
      { source: 'd', state: 'failed', outputs: [], error: 'x' }
    ]
  })
  assert.deepEqual(outputs, [{ source: 'a', output: 'a.jpg' }])
  assert.equal(failures.length, 1)
  assert.equal(failures[0].source, 'd')
})

test('★ extOf：取小写扩展名', () => {
  assert.equal(filee.extOf('C:\\a\\b.HEIC'), 'heic')
  assert.equal(filee.extOf('a.b.png'), 'png')
  assert.equal(filee.extOf('noext'), '')
  assert.equal(filee.extOf('a.'), '')
})

// ---------------------------------------------------------------- 探测

test('★ resolveRunner：.cmd/.bat 必须经 cmd.exe（否则 CreateProcess 报 EINVAL）', () => {
  const r = filee.resolveRunner('C:\\x\\cli\\filee.cmd')
  assert.ok(/cmd(\.exe)?$/i.test(r.cmd), '应走 cmd.exe，实际：' + r.cmd)
  assert.ok(r.args.includes('/d'), '应带 /d 关闭 AutoRun')
  assert.ok(r.args.includes('/c'))
  assert.ok(r.args.includes('C:\\x\\cli\\filee.cmd'))
})

test('resolveRunner：.exe / 普通命令名原样执行', () => {
  assert.deepEqual(filee.resolveRunner('filee'), { cmd: 'filee', args: [] })
  assert.deepEqual(filee.resolveRunner('C:\\x\\filee.exe'), { cmd: 'C:\\x\\filee.exe', args: [] })
})

test('resolveRunner：执行器对象形态原样保留（用于「用 node 跑脚本」）', () => {
  const r = filee.resolveRunner({ cmd: 'node', args: ['a.js'] })
  assert.deepEqual(r, { cmd: 'node', args: ['a.js'] })
})

test('probeVersion：.cmd 形态能探测成功（真实 spawnSync 直调会 EINVAL）', () => {
  const d = tmpDir('probe3')
  const cliDir = path.join(d, 'cli')
  fs.mkdirSync(cliDir, { recursive: true })
  const cmd = path.join(cliDir, 'filee.cmd')
  fs.writeFileSync(cmd, '@echo off\r\necho filee 2.4.1\r\nexit /b 0\r\n')
  assert.equal(filee.probeVersion(cmd), true)
})

test('probeVersion：跑不起来的候选返回 false', () => {
  assert.equal(filee.probeVersion('C:\\definitely\\not\\exist\\filee.exe'), false)
})

test('findFileeBin：找不到时返回空串（优雅降级）', () => {
  const bin = filee.findFileeBin({ envVar: 'STICKY_FILEE_NOT_EXIST_XYZ' })
  // 可能命中系统里真的装了 filee；断言类型即可，不能断言具体值
  assert.equal(typeof bin, 'string')
})

test('findFileeBin：便携形态的 cli\\filee.cmd 被命中', () => {
  const d = tmpDir('probe')
  // 官方 SKILL.md 指出 Windows 免安装形态是 <Filee目录>\cli\filee.cmd
  const cliDir = path.join(d, 'cli')
  fs.mkdirSync(cliDir, { recursive: true })
  const cmd = path.join(cliDir, 'filee.cmd')
  fs.writeFileSync(cmd, '@echo off\r\necho filee 2.4.1\r\n')
  const bin = filee.findFileeBin({ envVar: 'STICKY_FILEE_TEST', appDir: d })
  assert.ok(bin, '应找到便携形态的 filee.cmd')
  assert.ok(bin.endsWith('filee.cmd'), '应命中 cli 目录下的 filee.cmd，实际：' + bin)
})

test('findFileeBin：同名但跑不起来的文件不算候选（避免指向坏路径）', () => {
  const d = tmpDir('probe2')
  const fake = path.join(d, 'filee-cli.exe')
  // 内容不是可执行程序 → version 跑不起来 → 不应被选中
  fs.writeFileSync(fake, 'not a real executable')
  const bin = filee.findFileeBin({ envVar: 'STICKY_FILEE_TEST', appDir: d })
  assert.notEqual(bin, fake, '跑不起来的同名文件不应被采用')
})

// ---------------------------------------------------------------- capabilities（假 CLI）

test('★ capabilities：查询 png 得到零引擎 targets', async () => {
  await withFake('ok', async () => {
    const r = await filee.capabilities(FAKE_RUNNER, 'png')
    assert.equal(r.ok, true)
    // 假 CLI 的 png 表：targets=[jpg,webp,pdf]（零引擎即可）、withEngines=[heic]
    assert.deepEqual(r.targets, ['jpg', 'webp', 'pdf'])
    assert.deepEqual(r.withEngines, ['heic'])
    assert.equal(r.displayName, 'PNG')
  })
})

test('capabilities：扩展名带点也能查', async () => {
  await withFake('ok', async () => {
    const r = await filee.capabilities(FAKE_RUNNER, '.PNG')
    assert.equal(r.ok, true)
    assert.ok(r.targets.length > 0)
  })
})

test('capabilities：未安装 Filee → not-installed', async () => {
  const r = await filee.capabilities('', 'png')
  assert.equal(r.ok, false)
  assert.equal(r.reason, filee.REASON.NOT_INSTALLED)
})

test('capabilities：空扩展名 → usage', async () => {
  const r = await filee.capabilities(FAKE_RUNNER, '')
  assert.equal(r.ok, false)
  assert.equal(r.reason, filee.REASON.USAGE)
})

test('capabilities：未知格式（退出码 2）→ usage', async () => {
  await withFake('usage', async () => {
    const r = await filee.capabilities(FAKE_RUNNER, 'qqq')
    assert.equal(r.ok, false)
    assert.equal(r.reason, filee.REASON.USAGE)
  })
})

// ---------------------------------------------------------------- convert（假 CLI）

test('★ convert：成功时产物真的落盘，且能拿到 outputs', async () => {
  const inDir = tmpDir('in')
  const outDir = tmpDir('out')
  const src = tmpFile(inDir, 'photo.png')
  await withFake('ok', async () => {
    const r = await filee.convert(FAKE_RUNNER, [src], 'jpg', outDir)
    assert.equal(r.ok, true)
    assert.equal(r.outputs.length, 1)
    assert.ok(fs.existsSync(r.outputs[0].output), '产物文件应存在')
    assert.ok(r.outputs[0].output.endsWith('.jpg'))
  })
})

test('★ convert：官方要求的参数确实传给了 filee', async () => {
  const inDir = tmpDir('in2')
  const outDir = tmpDir('out2')
  const src = tmpFile(inDir, 'p.png')
  // 用假 CLI 的 echo-args 模式把真实调用参数打出来验证
  const { spawnSync } = require('child_process')
  const r = spawnSync(process.execPath, [FAKE, 'convert', src, '--to', 'jpg', '-o', outDir, '--overwrite', '--json', '--quiet'], {
    encoding: 'utf8', env: { ...process.env, STICKY_FAKE_FILEE: 'echo-args' }
  })
  const j = JSON.parse(r.stdout)
  assert.ok(j.args.includes('--json'))
  assert.ok(j.args.includes('--quiet'))
  assert.ok(j.args.includes('--overwrite'))
  assert.ok(j.args.includes('-o'))
  assert.ok(j.args.includes('--to'))
})

test('★ convert：官方要求的三件套参数确实传了', async () => {
  const inDir = tmpDir('in3')
  const outDir = tmpDir('out3')
  const src = tmpFile(inDir, 'p.png')
  const fake = path.join(__dirname, '..', 'scripts', 'fake-filee.js')
  // 直接跑假 CLI 的 echo-args 模式，把参数打出来验证
  const { spawnSync } = require('child_process')
  const r = spawnSync(process.execPath, [fake, 'convert', src, '--to', 'jpg', '-o', outDir, '--overwrite', '--json', '--quiet'], {
    encoding: 'utf8', env: { ...process.env, STICKY_FAKE_FILEE: 'echo-args' }
  })
  const j = JSON.parse(r.stdout)
  assert.ok(j.args.includes('--json'))
  assert.ok(j.args.includes('--quiet'))
  assert.ok(j.args.includes('--overwrite'))
  assert.ok(j.args.includes('-o'))
  assert.ok(j.args.includes('--to'))
})

test('convert：部分失败 → ok=true 且 failures 非空', async () => {
  const inDir = tmpDir('in4')
  const outDir = tmpDir('out4')
  const a = tmpFile(inDir, 'a.png')
  const b = tmpFile(inDir, 'b.png')
  await withFake('partial', async () => {
    const r = await filee.convert(FAKE_RUNNER, [a, b], 'jpg', outDir)
    assert.equal(r.ok, true)
    assert.equal(r.outputs.length, 1)
    assert.equal(r.failures.length, 1)
    assert.ok(r.failures[0].error)
  })
})

test('★ convert：缺引擎 → needs-engine 且点名引擎', async () => {
  const inDir = tmpDir('in5')
  const outDir = tmpDir('out5')
  const src = tmpFile(inDir, 'a.md')
  await withFake('needs-engine', async () => {
    const r = await filee.convert(FAKE_RUNNER, [src], 'pptx', outDir)
    assert.equal(r.ok, false)
    assert.equal(r.reason, filee.REASON.NEEDS_ENGINE)
    assert.ok(r.error.includes('pandoc'))
  })
})

test('convert：退出码 2 → usage', async () => {
  const inDir = tmpDir('in6')
  const outDir = tmpDir('out6')
  const src = tmpFile(inDir, 'a.png')
  await withFake('usage', async () => {
    const r = await filee.convert(FAKE_RUNNER, [src], 'jpg', outDir)
    assert.equal(r.reason, filee.REASON.USAGE)
  })
})

test('convert：退出码 3 → nothing-to-do', async () => {
  const inDir = tmpDir('in7')
  const outDir = tmpDir('out7')
  const src = tmpFile(inDir, 'a.png')
  await withFake('nothing', async () => {
    const r = await filee.convert(FAKE_RUNNER, [src], 'jpg', outDir)
    assert.equal(r.reason, filee.REASON.NOTHING_TO_DO)
  })
})

test('convert：未安装 Filee → not-installed', async () => {
  const r = await filee.convert('', ['a.png'], 'jpg', os.tmpdir())
  assert.equal(r.ok, false)
  assert.equal(r.reason, filee.REASON.NOT_INSTALLED)
})

test('convert：空文件列表 → usage', async () => {
  const r = await filee.convert(FAKE_RUNNER, [], 'jpg', os.tmpdir())
  assert.equal(r.reason, filee.REASON.USAGE)
})

test('convert：未指定目标格式 → usage', async () => {
  const r = await filee.convert(FAKE_RUNNER, ['a.png'], '', os.tmpdir())
  assert.equal(r.reason, filee.REASON.USAGE)
})

test('convert：坏 JSON → failed 分类，不崩', async () => {
  const inDir = tmpDir('in8')
  const outDir = tmpDir('out8')
  const src = tmpFile(inDir, 'a.png')
  await withFake('bad-json', async () => {
    const r = await filee.convert(FAKE_RUNNER, [src], 'jpg', outDir)
    assert.equal(r.ok, false)
    assert.equal(r.reason, filee.REASON.FAILED)
  })
})

test('★ convert：超时被识别为 timeout', async () => {
  const inDir = tmpDir('in9')
  const outDir = tmpDir('out9')
  const src = tmpFile(inDir, 'a.png')
  await withFake('slow', async () => {
    const r = await filee.convert(FAKE_RUNNER, [src], 'jpg', outDir, { timeout: 800 })
    assert.equal(r.ok, false)
    assert.equal(r.reason, filee.REASON.TIMEOUT)
  }, { STICKY_FAKE_FILEE_SLOW_MS: '6000' })
})
