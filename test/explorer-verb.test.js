'use strict'

/**
 * 右键菜单动词（注册表描述）的回归（lib/explorer-verb.js）。
 *
 * 口径与 Filee v2.4.1 的经典右键菜单一致
 * （WindowsPlatformServices.cs:352 WriteClassicVerb）：
 *   HKCU\Software\Classes\*\shell\<Verb>\MUIVerb        = 菜单文字
 *   HKCU\Software\Classes\*\shell\<Verb>\Icon           = "<exe>",0
 *   HKCU\Software\Classes\*\shell\<Verb>\MultiSelectModel = Player
 *   HKCU\Software\Classes\*\shell\<Verb>\command\(默认)  = "<exe>" --convert "%1"
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const verb = require('../lib/explorer-verb')
const cliArgs = require('../lib/cli-args')

const EXE = 'C:\\Program Files\\Sticky Notes\\StickyNotes.exe'

// ---------------------------------------------------------------- 键路径

test('★ 键路径是 HKCU 用户级 + 全文件类型（*）', () => {
  assert.equal(
    verb.verbKeyPath(),
    'Software\\Classes\\*\\shell\\StickyNotesConvert'
  )
  assert.equal(
    verb.commandKeyPath(),
    'Software\\Classes\\*\\shell\\StickyNotesConvert\\command'
  )
})

test('动词名可自定义（避免与其它应用冲突）', () => {
  assert.ok(verb.verbKeyPath('MyVerb').endsWith('\\shell\\MyVerb'))
})

// ---------------------------------------------------------------- 命令行拼装

test('★ command 行：exe 与 %1 都带引号', () => {
  const cmd = verb.commandLine(EXE)
  assert.equal(cmd, `"${EXE}" --convert "%1"`)
  // %1 必须在引号内，否则路径含空格时会被拆开
  assert.ok(cmd.includes('"%1"'))
})

test('★ exe 路径含空格时仍被完整引起来', () => {
  const cmd = verb.commandLine(EXE)
  assert.ok(cmd.startsWith('"C:\\Program Files\\'))
  // 引号成对
  const quotes = (cmd.match(/"/g) || []).length
  assert.equal(quotes % 2, 0)
})

test('exe 路径里的字面量双引号被转义', () => {
  const cmd = verb.commandLine('C:\\a"b\\x.exe')
  assert.ok(cmd.includes('\\"'))
})

test('quoteWindowsArg：空串也要加引号', () => {
  assert.equal(verb.quoteWindowsArg(''), '""')
  assert.equal(verb.quoteWindowsArg(null), '""')
})

test('★ icon 值取 exe 的第 0 号图标', () => {
  assert.equal(verb.iconValue(EXE), `"${EXE}",0`)
})

// ---------------------------------------------------------------- 值集合

test('★ verbValues 含四个必需值，且 MultiSelectModel=Player', () => {
  const vals = verb.verbValues(EXE, '用桌面便签转换…')
  const byName = new Map(vals.map(v => [v.name || '(Default)', v]))

  assert.equal(byName.get('MUIVerb').value, '用桌面便签转换…')
  assert.equal(byName.get('Icon').value, `"${EXE}",0`)
  assert.equal(byName.get('MultiSelectModel').value, 'Player')
  assert.equal(byName.get('(Default)').value, `"${EXE}" --convert "%1"`)
})

test('verbValues：command 的默认值写在 command 子键上', () => {
  const vals = verb.verbValues(EXE)
  const cmd = vals.find(v => v.name === null)
  assert.equal(cmd.key, verb.commandKeyPath())
})

test('verbValues：全部是 REG_SZ', () => {
  for (const v of verb.verbValues(EXE)) assert.equal(v.type, 'REG_SZ')
})

// ---------------------------------------------------------------- 状态解析

const REG_OUTPUT = [
  'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\StickyNotesConvert',
  '    MUIVerb    REG_SZ    用桌面便签转换…',
  '    Icon    REG_SZ    "C:\\App\\StickyNotes.exe",0',
  '    MultiSelectModel    REG_SZ    Player',
  '',
  'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\StickyNotesConvert\\command',
  '    (Default)    REG_SZ    "C:\\App\\StickyNotes.exe" --convert "%1"',
  ''
].join('\r\n')

test('★ parseRegQuery：识别出已安装状态与各值', () => {
  const r = verb.parseRegQuery(REG_OUTPUT)
  assert.equal(r.installed, true)
  assert.equal(r.values.MUIVerb, '用桌面便签转换…')
  assert.equal(r.values.MultiSelectModel, 'Player')
  assert.ok(r.command.includes('--convert'))
})

test('parseRegQuery：给了 exePath 时校验 command 指向该 exe', () => {
  assert.equal(verb.parseRegQuery(REG_OUTPUT, 'C:\\App\\StickyNotes.exe').installed, true)
  // 换过安装位置 → 旧注册表是残留，判定为未安装
  assert.equal(verb.parseRegQuery(REG_OUTPUT, 'D:\\New\\StickyNotes.exe').installed, false)
})

test('★ parseRegQuery：缺 MultiSelectModel → 判定未安装', () => {
  const out = REG_OUTPUT.replace('    MultiSelectModel    REG_SZ    Player\r\n', '')
  assert.equal(verb.parseRegQuery(out).installed, false)
})

test('parseRegQuery：空输出 → 未安装，不抛异常', () => {
  assert.equal(verb.parseRegQuery('').installed, false)
  assert.equal(verb.parseRegQuery(null).installed, false)
  assert.equal(verb.parseRegQuery(undefined).installed, false)
})

test('parseRegQuery：command 子键缺失 → 未安装', () => {
  const out = REG_OUTPUT.split('\\command')[0]
  assert.equal(verb.parseRegQuery(out).installed, false)
})

// ---------------------------------------------------------------- 文案

test('describeStatus 给出可读文案', () => {
  assert.equal(verb.describeStatus({ installed: true }).ok, true)
  assert.ok(verb.describeStatus({ installed: true }).text.includes('显示更多选项'))
  assert.equal(verb.describeStatus({ installed: false }).ok, false)
  assert.equal(verb.describeStatus(null).ok, false)
})

// ---------------------------------------------------------------- 注册表路径（HKCU 绝对化）

test('★ hkcuPath：相对键补成 HKCU 绝对路径', () => {
  // 少了这一步就会写到「当前目录下的相对路径」去 —— 静默写错地方
  assert.equal(
    verb.hkcuPath('Software\\Classes\\*\\shell\\StickyNotesConvert'),
    'HKCU:\\Software\\Classes\\*\\shell\\StickyNotesConvert'
  )
})

test('hkcuPath：已有 HKCU 前缀时不再叠加', () => {
  const once = verb.hkcuPath(verb.verbKeyPath())
  assert.equal(verb.hkcuPath(once), once)
  assert.equal(verb.hkcuPath('HKCU:\\Software\\Classes'), 'HKCU:\\Software\\Classes')
})

test('hkcuPath：去掉前导斜杠', () => {
  assert.equal(verb.hkcuPath('\\Software\\Classes'), 'HKCU:\\Software\\Classes')
})

// ---------------------------------------------------------------- PowerShell 脚本生成

test('★ installScript：写默认值必须用 -LiteralPath（`*` 在 -Path 里是通配符）', () => {
  const ps = verb.installScript(EXE)
  // Set-Item -Path 对含 `*` 的路径会**静默失败**（不报错、值写不进去）
  assert.ok(!/Set-Item\s+-Path/.test(ps), 'Set-Item 不得使用 -Path')
  assert.ok(/Set-Item\s+-LiteralPath/.test(ps), 'Set-Item 应使用 -LiteralPath')
})

test('★ installScript：所有注册表路径都是 HKCU 绝对路径', () => {
  const ps = verb.installScript(EXE)
  // 建键用变量 $k（脚本第二行已把它赋成 HKCU 绝对路径），其余用字面量路径
  assert.ok(ps.includes("$k='HKCU:\\Software\\Classes\\*\\shell\\StickyNotesConvert'"),
    '$k 应被赋成 HKCU 绝对路径，实际: ' + ps.slice(0, 200))
  // 其余字面量路径逐个断言都有 HKCU:\ 前缀
  // （"$k\command" 这种基于变量的路径是合法的 —— $k 本身已是绝对路径）
  const found = ps.match(/(?:-Path|-LiteralPath)\s+"([^"]+)"/g) || []
  assert.ok(found.length >= 4, '应至少出现 4 处字面量路径，实际: ' + found.length)
  for (const f of found) {
    const m = f.match(/(?:-Path|-LiteralPath)\s+"([^"]+)"/)
    const p = m[1]
    if (p.startsWith('$k')) {
      // 基于变量的路径：变量本身必须是 HKCU 绝对路径
      assert.ok(ps.includes("$k='HKCU:\\"), '$k 必须是 HKCU 绝对路径')
      continue
    }
    assert.ok(p.startsWith('HKCU:\\'), '路径缺少 HKCU:\\ 前缀: ' + p)
  }
})

test('installScript：New-Item 用 -Path（PowerShell 5.1 没有 -LiteralPath 参数）', () => {
  const ps = verb.installScript(EXE)
  assert.ok(/New-Item\s+-Path/.test(ps))
  // New-Item 不支持 -LiteralPath，用了会报 "A parameter cannot be found"
  assert.ok(!/New-Item\s+-LiteralPath/.test(ps), 'New-Item 不支持 -LiteralPath')
})

test('installScript：写入了四个必需值（MUIVerb/Icon/MultiSelectModel/command）', () => {
  const ps = verb.installScript(EXE)
  assert.ok(ps.includes('-Name "MUIVerb"'))
  assert.ok(ps.includes('-Name "Icon"'))
  assert.ok(ps.includes('-Name "MultiSelectModel"'))
  assert.ok(ps.includes("-Value 'Player'"))
  // command 的默认值
  assert.ok(ps.includes('Set-Item -LiteralPath'))
  assert.ok(ps.includes('--convert'))
})

test('installScript：值里的单引号被转义（PowerShell 单引号串内要写两遍）', () => {
  const ps = verb.installScript("C:\\Program Files\\it's\\App.exe")
  assert.ok(ps.includes("it''s"), '单引号应被转义成两遍')
})

test('uninstallScript：删除用 -LiteralPath 且带 HKCU 前缀', () => {
  const ps = verb.uninstallScript()
  assert.ok(ps.includes('Remove-Item'))
  assert.ok(ps.includes('-LiteralPath'))
  assert.ok(ps.includes('HKCU:\\Software\\Classes\\*\\shell\\StickyNotesConvert'))
  assert.ok(ps.includes('-Recurse'), '应连子树一起删')
})

test('statusScript：输出 JSON 且用 -LiteralPath 读取', () => {
  const ps = verb.statusScript()
  assert.ok(ps.includes('Test-Path -LiteralPath'))
  assert.ok(ps.includes('Get-ItemProperty -LiteralPath'))
  assert.ok(ps.includes('ConvertTo-Json'))
  assert.ok(ps.includes('HKCU:\\Software\\Classes\\*\\shell\\StickyNotesConvert'))
})

test('★ statusScript：语句都是单行（跨行哈希表字面量被 `;` 拆开会语法错）', () => {
  const ps = verb.statusScript()
  // 有序哈希表字面量必须写在一行内
  assert.ok(ps.includes('[ordered]@{ MUIVerb'), '哈希表字面量应写在一行')
  assert.ok(!/\{\s*\n/.test(ps), '不应出现跨行的哈希表字面量')
})

// ---------------------------------------------------------------- 状态解析

test('★ parseStatusJson：正常 JSON → 已安装', () => {
  const out = JSON.stringify({
    MUIVerb: '用桌面便签转换…',
    Icon: '"C:\\App\\StickyNotes.exe",0',
    MultiSelectModel: 'Player',
    command: '"C:\\App\\StickyNotes.exe" --convert "%1"'
  })
  const r = verb.parseStatusJson(out, 'C:\\App\\StickyNotes.exe')
  assert.equal(r.installed, true)
  assert.equal(r.values.MUIVerb, '用桌面便签转换…')
  assert.equal(r.values.MultiSelectModel, 'Player')
  assert.ok(r.command.includes('--convert'))
})

test('parseStatusJson：__missing → 未安装', () => {
  const r = verb.parseStatusJson('{"__missing":true}')
  assert.equal(r.installed, false)
  assert.equal(r.command, null)
})

test('parseStatusJson：非法 JSON → 未安装且不抛异常', () => {
  assert.equal(verb.parseStatusJson('not json').installed, false)
  assert.equal(verb.parseStatusJson('').installed, false)
  assert.equal(verb.parseStatusJson(null).installed, false)
  assert.equal(verb.parseStatusJson(undefined).installed, false)
})

test('★ parseStatusJson：command 为空 → 未安装（菜单能看见但点了没反应）', () => {
  const out = JSON.stringify({
    MUIVerb: '用桌面便签转换…', Icon: 'x', MultiSelectModel: 'Player', command: ''
  })
  assert.equal(verb.parseStatusJson(out).installed, false)
})

test('parseStatusJson：MultiSelectModel 不是 Player → 未安装', () => {
  const out = JSON.stringify({
    MUIVerb: 'x', Icon: 'x', MultiSelectModel: 'Single', command: 'cmd'
  })
  assert.equal(verb.parseStatusJson(out).installed, false)
})

test('parseStatusJson：command 指向别的 exe → 未安装（上次安装位置的残留）', () => {
  const out = JSON.stringify({
    MUIVerb: 'x', Icon: 'x', MultiSelectModel: 'Player',
    command: '"D:\\Old\\StickyNotes.exe" --convert "%1"'
  })
  assert.equal(verb.parseStatusJson(out, 'C:\\App\\StickyNotes.exe').installed, false)
})

test('parseStatusJson：缺 MUIVerb → 未安装', () => {
  const out = JSON.stringify({ Icon: 'x', MultiSelectModel: 'Player', command: 'cmd' })
  assert.equal(verb.parseStatusJson(out).installed, false)
})

// ---------------------------------------------------------------- 开发态（electron.exe + appDir）

test('★ 开发态 commandLine / installScript：在 electron.exe 后显式带上 appPath', () => {
  const electronExe = 'D:\\PythonProjects\\sticky-notes\\node_modules\\electron\\dist\\electron.exe'
  const appDir = 'D:\\PythonProjects\\sticky-notes'

  const cmd = verb.commandLine(electronExe, { appPath: appDir })
  assert.equal(cmd, `"${electronExe}" "${appDir}" --convert "%1"`)

  const vals = verb.verbValues(electronExe, verb.DEFAULT_LABEL, { appPath: appDir })
  const cmdVal = vals.find(v => v.name === null)
  assert.equal(cmdVal.value, `"${electronExe}" "${appDir}" --convert "%1"`)

  const ps = verb.installScript(electronExe, verb.DEFAULT_LABEL, { appPath: appDir })
  assert.ok(ps.includes(`"${appDir}" --convert "%1"`), 'installScript 应包含 appPath 与 --convert')
})

test('★ 开发态 parseStatusJson / parseRegQuery：缺少 appPath 的残缺命令必须判为未安装', () => {
  const electronExe = 'D:\\PythonProjects\\sticky-notes\\node_modules\\electron\\dist\\electron.exe'
  const appDir = 'D:\\PythonProjects\\sticky-notes'

  // 旧版残缺命令（会把 1.png 当成入口脚本导致 ERR_UNKNOWN_FILE_EXTENSION）
  const brokenOut = JSON.stringify({
    MUIVerb: '用桌面便签转换…',
    Icon: `"${electronExe}",0`,
    MultiSelectModel: 'Player',
    command: `"${electronExe}" --convert "%1"`
  })
  assert.equal(verb.parseStatusJson(brokenOut, electronExe, { appPath: appDir }).installed, false)

  // 把 appDir 放在 --convert 后面（错误位置）也必须判 false
  const wrongOrderOut = JSON.stringify({
    MUIVerb: '用桌面便签转换…',
    Icon: `"${electronExe}",0`,
    MultiSelectModel: 'Player',
    command: `"${electronExe}" --convert "${appDir}" "%1"`
  })
  assert.equal(verb.parseStatusJson(wrongOrderOut, electronExe, { appPath: appDir }).installed, false)

  // 正确的开发态命令 → installed = true
  const validOut = JSON.stringify({
    MUIVerb: '用桌面便签转换…',
    Icon: `"${electronExe}",0`,
    MultiSelectModel: 'Player',
    command: `"${electronExe}" "${appDir}" --convert "%1"`
  })
  assert.equal(verb.parseStatusJson(validOut, electronExe, { appPath: appDir }).installed, true)

  const regValid = [
    'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\StickyNotesConvert',
    '    MUIVerb    REG_SZ    用桌面便签转换…',
    '    MultiSelectModel    REG_SZ    Player',
    'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\StickyNotesConvert\\command',
    `    (Default)    REG_SZ    "${electronExe}" "${appDir}" --convert "%1"`
  ].join('\r\n')
  assert.equal(verb.parseRegQuery(regValid, electronExe, { appPath: appDir }).installed, true)
  const regBroken = regValid.replace(` "${appDir}"`, '')
  assert.equal(verb.parseRegQuery(regBroken, electronExe, { appPath: appDir }).installed, false)
})

test('★ 开发态注册表命令对应的 argv 能正确只提取待转换文件，不吞掉 appDir', () => {
  const electronExe = 'D:\\PythonProjects\\sticky-notes\\node_modules\\electron\\dist\\electron.exe'
  const appDir = 'D:\\PythonProjects\\sticky-notes'
  const picked = cliArgs.pickConvertArgv([electronExe, appDir, '--convert', 'C:\\Users\\cwt\\Desktop\\1.png'])
  assert.deepEqual(picked && picked.files, ['C:\\Users\\cwt\\Desktop\\1.png'])
})
