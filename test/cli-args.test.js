'use strict'

/**
 * 命令行参数解析的回归（lib/cli-args.js）。
 *
 * 这一层刻意**不依赖 Electron**：纯函数，直接 node --test 驱动。
 *
 * 口径要点：
 *   - 只认 `--` 之后的显式参数，不依赖 argv[0]/argv[1] 的位置
 *     （开发态 argv[1] 是 '.'，打包态 argv[0] 才是 exe）；
 *   - 位置参数只有在已经进入 --convert 之后才算文件路径；
 *   - 未知开关忽略而不是报错（用户误传参数不应导致应用启动失败）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const cli = require('../lib/cli-args')

// ---------------------------------------------------------------- 转换模式

test('★ 开发态形态：electron . --convert a.heic 能解析出文件和模式', () => {
  const p = cli.parseArgs(['C:\\path\\electron.exe', '.', '--convert', 'a.heic'])
  assert.equal(p.command, 'convert')
  assert.deepEqual(p.files, ['a.heic'])
  assert.equal(p.to, null)
  assert.equal(cli.isConvertMode(p), true)
})

test('★ 打包态形态：StickyNotes.exe --convert a.heic 解析结果与开发态一致', () => {
  const dev = cli.parseArgs(['electron.exe', '.', '--convert', 'a.heic'])
  const pkg = cli.parseArgs(['C:\\Apps\\StickyNotes.exe', '--convert', 'a.heic'])
  assert.deepEqual(pkg.files, dev.files)
  assert.equal(pkg.command, dev.command)
})

test('多个文件：位置参数全部收进 files', () => {
  const p = cli.parseArgs(['exe', '--convert', 'a.png', 'b.png', 'c.png'])
  assert.deepEqual(p.files, ['a.png', 'b.png', 'c.png'])
})

test('★ --to 指定目标格式', () => {
  const p = cli.parseArgs(['exe', '--convert', 'a.heic', '--to', 'jpg'])
  assert.equal(p.to, 'jpg')
  assert.deepEqual(p.files, ['a.heic'])
})

test('--to 后面缺值时不算错误，只是没指定格式', () => {
  const p = cli.parseArgs(['exe', '--convert', 'a.heic', '--to'])
  assert.equal(p.to, null)
  assert.equal(p.command, 'convert')
})

test('--to 后面紧跟另一个开关时不吞掉该开关', () => {
  const p = cli.parseArgs(['exe', '--convert', 'a.heic', '--to', '--version'])
  assert.equal(p.to, null)
  assert.equal(p.version, true)
})

test('路径含空格：整段被当作一个文件路径', () => {
  const p = cli.parseArgs(['exe', '--convert', 'C:\\My Docs\\a b.png'])
  assert.deepEqual(p.files, ['C:\\My Docs\\a b.png'])
})

test('没有 --convert 时不进转换模式', () => {
  const p = cli.parseArgs(['exe'])
  assert.equal(cli.isConvertMode(p), false)
  assert.deepEqual(p.files, [])
})

test('★ --convert 但没有文件 → 不是转换模式（避免开出一个空窗口）', () => {
  const p = cli.parseArgs(['exe', '--convert'])
  assert.equal(p.command, 'convert')
  assert.equal(cli.isConvertMode(p), false)
})

test('未知开关被忽略，应用仍能正常启动', () => {
  const p = cli.parseArgs(['exe', '--some-unknown-flag', '--convert', 'a.png'])
  assert.equal(p.command, 'convert')
  assert.deepEqual(p.files, ['a.png'])
})

test('`--` 之后的内容全部忽略（分隔符语义）', () => {
  const p = cli.parseArgs(['exe', '--convert', 'a.png', '--', '--convert', 'b.png'])
  assert.deepEqual(p.files, ['a.png'])
})

test('非数组输入不抛异常', () => {
  assert.doesNotThrow(() => cli.parseArgs(null))
  assert.doesNotThrow(() => cli.parseArgs(undefined))
  assert.equal(cli.isConvertMode(cli.parseArgs(null)), false)
})

// ---------------------------------------------------------------- 其它命令

test('--version / --help 被识别', () => {
  assert.equal(cli.parseArgs(['exe', '--version']).version, true)
  assert.equal(cli.parseArgs(['exe', '--help']).help, true)
  assert.equal(cli.parseArgs(['exe', '-h']).help, true)
})

// ---------------------------------------------------------------- pickConvertArgv

test('★ pickConvertArgv：只在确实是转换启动时返回结果', () => {
  const converted = cli.pickConvertArgv(['exe', '--convert', 'a.png'])
  assert.ok(converted)
  assert.deepEqual(converted.files, ['a.png'])

  assert.equal(cli.pickConvertArgv(['exe']), null)
  assert.equal(cli.pickConvertArgv(['exe', '--convert']), null)
})

test('pickConvertArgv：空 argv（某些平台的二次实例回调）返回 null', () => {
  assert.equal(cli.pickConvertArgv([]), null)
  assert.equal(cli.pickConvertArgv(undefined), null)
})
