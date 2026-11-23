'use strict'

/**
 * 资源管理器右键菜单「动词（verb）」的注册表描述（纯函数，不依赖 Electron / 真实注册表）。
 *
 * 机制参照 Filee v2.4.1 的经典右键菜单实现
 * （src/Filee.Platform.Windows/WindowsPlatformServices.cs:352 WriteClassicVerb）：
 *
 *   HKCU\Software\Classes\*\shell\<VerbName>
 *     (默认)      = 菜单文字（用 MUIVerb 而不是默认值 ⇒ 不必为多语言做资源 DLL）
 *     MUIVerb     = 菜单文字
 *     Icon        = "<exe路径>",0
 *     MultiSelectModel = Player
 *     command\
 *       (默认)    = "<exe路径>" --convert "%1"
 *
 * 为什么走「经典动词」而不是 Filee 的 Win11 现代菜单：
 *   - 经典动词 = 纯注册表写入，**零原生代码、零管理员权限、零签名、零 Explorer 兼容风险**；
 *   - 现代菜单 = Zig 编译的 DLL 注入 explorer.exe + MSIX 包（需管理员/UAC），
 *     成本≈独立一个产品。
 * 代价：Win11 上经典动词落在「显示更多选项」下（非首层菜单）。
 *
 * 为什么 MultiSelectModel=Player：
 *   Explorer 对 Player 模式的动词最多支持 100 个文件（默认只有 15）。
 *   代价是 **Explorer 会为每个文件启动一次进程**（100 个文件 = 100 次启动）。
 *   本项目用「单实例 + argv 聚合」（见 main.js 的 second-instance 处理）消化这个问题，
 *   不需要 Filee 那套向文件管理器查询选区的 COM 机制。
 *
 * 本文件只负责「描述」注册表该长什么样；真正的读写在 lib/explorer-verb-io.js。
 */

/** 动词名（同时是注册表子键名） */
const VERB_NAME = 'StickyNotesConvert'

/** 动词所在的用户级注册表根路径（HKCU ⇒ 不需要管理员权限） */
const CLASSES_ROOT = 'Software\\Classes'

/** 作用范围：* = 所有文件类型 */
const WILDCARD = '*'

/** 菜单默认文字 */
const DEFAULT_LABEL = '用桌面便签转换…'

/**
 * 注册表键路径（不含 HKCU 前缀，便于用 reg.exe / PowerShell 操作）。
 * @param {string} [verbName]
 */
function verbKeyPath (verbName = VERB_NAME) {
  return `${CLASSES_ROOT}\\${WILDCARD}\\shell\\${verbName}`
}

/** command 子键路径 */
function commandKeyPath (verbName = VERB_NAME) {
  return `${verbKeyPath(verbName)}\\command`
}

function extractAppPath (opts) {
  return (opts && typeof opts === 'object' && typeof opts.appPath === 'string')
    ? opts.appPath.trim()
    : ''
}

function hasValidCommand (command, exePath, opts) {
  if (typeof command !== 'string' || !command.length) return false
  if (exePath && command.indexOf(String(exePath)) === -1) return false
  const appPath = extractAppPath(opts)
  if (appPath) {
    const idx = command.indexOf('--convert')
    if (idx < 0) return false
    const beforeConvert = command.slice(0, idx)
    const quotedApp = quoteWindowsArg(appPath)
    // 必须作为独立参数出现在 --convert 之前，避免误命中 exe 路径中的目录前缀
    const hasQuoted = beforeConvert.indexOf(quotedApp) !== -1
    const hasBare = beforeConvert.split(/\s+/).includes(appPath)
    if (!hasQuoted && !hasBare) return false
  }
  return true
}

/**
 * 拼装 command 的命令行字符串。
 *
 * 关键：路径与参数都要加双引号，否则「路径含空格」时会被 Windows 拆成多个参数。
 * 未打包开发态下需在可执行文件后显式带上应用根目录（opts.appPath），否则裸
 * electron.exe 会把 `--convert` 后的待转换文件（如 1.png）当成入口脚本运行。
 *
 * @param {string} exePath 本应用可执行文件路径
 * @param {object} [opts] { appPath?: string }
 * @returns {string}
 */
function commandLine (exePath, opts) {
  const exe = quoteWindowsArg(String(exePath || ''))
  const appPath = extractAppPath(opts)
  return appPath
    ? `${exe} ${quoteWindowsArg(appPath)} --convert "%1"`
    : `${exe} --convert "%1"`
}

/**
 * 按 Windows 命令行规则给一个参数加引号并转义内部引号。
 * @param {string} value
 */
function quoteWindowsArg (value) {
  const s = String(value == null ? '' : value)
  return `"${s.replace(/"/g, '\\"')}"`
}

/**
 * 拼装图标字符串："<exe路径>",0 —— 取 exe 的第 0 号图标。
 * @param {string} exePath
 */
function iconValue (exePath) {
  return `${quoteWindowsArg(String(exePath || ''))},0`
}

/**
 * 该动词需要的全部注册表值（键 → 值）。供写入层与测试共用。
 *
 * @param {string} exePath
 * @param {string} [label] 菜单文字
 * @param {object} [opts] { appPath?: string }
 * @returns {Array<{key: string, name: string|null, type: string, value: string}>}
 *   name 为 null 表示写「(默认)」值。
 */
function verbValues (exePath, label = DEFAULT_LABEL, opts = {}) {
  return [
    { key: verbKeyPath(), name: 'MUIVerb', type: 'REG_SZ', value: label },
    { key: verbKeyPath(), name: 'Icon', type: 'REG_SZ', value: iconValue(exePath) },
    { key: verbKeyPath(), name: 'MultiSelectModel', type: 'REG_SZ', value: 'Player' },
    { key: commandKeyPath(), name: null, type: 'REG_SZ', value: commandLine(exePath, opts) }
  ]
}

/**
 * 从 reg query 的输出里解析出我们关心的值，判断动词是否已正确安装。
 *
 * @param {string} stdout reg query 的标准输出
 * @param {string} [exePath] 期望的 exe 路径（给了才校验 command 行）
 * @param {object} [opts] { appPath?: string }
 * @returns {{installed: boolean, values: Object<string,string>, command: string|null}}
 */
function parseRegQuery (stdout, exePath = '', opts = {}) {
  const values = {}
  let command = null
  const text = String(stdout || '')

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^HKEY_/i.test(line)) continue

    const m = line.match(/^(\S+)\s+(REG_[A-Z_]+)\s*(.*)$/)
    if (!m) continue
    const [, name, , value] = m
    if (name === '(Default)') {
      command = value
    } else {
      values[name] = value
    }
  }

  const hasVerb = typeof values.MUIVerb === 'string' && values.MUIVerb.length > 0
  const ok = hasVerb &&
    values.MultiSelectModel === 'Player' &&
    hasValidCommand(command, exePath, opts)

  return { installed: ok, values, command }
}

/**
 * 生成「设置页要显示的状态文案」的纯逻辑部分。
 * @param {{installed: boolean}} status
 */
function describeStatus (status) {
  return status && status.installed
    ? { ok: true, text: '已启用：右键文件 → 显示更多选项 → 「用桌面便签转换…」' }
    : { ok: false, text: '未启用' }
}

// ---------------------------------------------------------------- PowerShell 脚本生成

/**
 * 注册表路径里有 `*`（作用范围 = 所有文件类型），而 PowerShell 的 `-Path`
 * **把 `*` 当通配符**！
 *
 * 实测（PowerShell 5.1）：
 *   - `Set-Item -Path 'HKCU:\...\*\shell\X\command' -Value '...'` → **静默失败**
 *     （不报错、值也写不进去）⇒ 必须用 `-LiteralPath`；
 *   - `New-Item` **没有** `-LiteralPath` 参数 ⇒ 只能用 `-Path`（对 `*` 恰好能用）；
 *   - `New-ItemProperty` / `Set-Item` / `Remove-Item` / `Test-Path` /
 *     `Get-ItemProperty` 都有 `-LiteralPath` ⇒ 一律用 `-LiteralPath`。
 *
 * 这些差异是「注册表动词写不进去」的根因，必须固化成可测的纯函数。
 */

/** 注册表根（用户级，不需要管理员） */
const HKCU = 'HKCU:\\'

/**
 * 把相对键路径补成 HKCU 绝对路径。
 *
 * ★ 必要性：verbValues() 返回的 key 是**不带前缀**的相对形式
 *   （'Software\Classes\*\shell\...'）。直接拿它当注册表路径写，
 *   会写到「当前目录下的相对路径」去 —— 静默写错地方，回读时又显示"未安装"。
 *
 * @param {string} rel 相对键路径
 * @returns {string} HKCU 绝对路径
 */
function hkcuPath (rel) {
  const s = String(rel || '')
  if (/^HKCU:\\/i.test(s)) return s
  return HKCU + s.replace(/^[\\/]+/, '')
}

/**
 * 生成「安装动词」的 PowerShell 脚本。
 *
 * @param {string} exePath 本应用 exe 路径
 * @param {string} [label] 菜单文字
 * @param {object} [opts] { appPath?: string }
 * @returns {string} PowerShell 脚本（单行语句，用 `;` 连接）
 */
function installScript (exePath, label = DEFAULT_LABEL, opts = {}) {
  const values = verbValues(exePath, label, opts)
  const lines = [
    "$ErrorActionPreference='Stop'",
    `$k='${hkcuPath(verbKeyPath())}'`,
    'New-Item -Path $k -Force | Out-Null',
    'New-Item -Path "$k\\command" -Force | Out-Null'
  ]
  for (const v of values) {
    const val = String(v.value == null ? '' : v.value).replace(/'/g, "''")
    const key = hkcuPath(v.key)
    if (v.name === null) {
      // 写「(默认)」值：Set-Item 必须用 -LiteralPath（见上方注释）
      lines.push(`Set-Item -LiteralPath "${key}" -Value '${val}'`)
    } else {
      lines.push(`New-ItemProperty -LiteralPath "${key}" -Name "${v.name}" -Value '${val}' -PropertyType String -Force | Out-Null`)
    }
  }
  return lines.join('; ')
}

/**
 * 生成「卸载动词」的 PowerShell 脚本。
 * @returns {string}
 */
function uninstallScript () {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `Remove-Item -LiteralPath '${hkcuPath(verbKeyPath())}' -Recurse -Force`
  ].join('; ')
}

/**
 * 生成「查询状态」的 PowerShell 脚本（输出 JSON）。
 *
 * ⚠️ 脚本必须由**单行语句**用 `;` 组成：
 *   `[ordered]@{ ... }` 这种跨行的哈希表字面量被 `;` 拆开会直接语法错。
 *
 * @returns {string}
 */
function statusScript () {
  const k = hkcuPath(verbKeyPath())
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$k='${k}'`,
    "if (-not (Test-Path -LiteralPath $k)) { Write-Output '{\"__missing\":true}'; exit 0 }",
    "$p = Get-ItemProperty -LiteralPath $k",
    "$cmdKey = Join-Path $k 'command'",
    "$cmd = ''",
    "if (Test-Path -LiteralPath $cmdKey) { $cmd = [string](Get-ItemProperty -LiteralPath $cmdKey).'(default)' }",
    "$o = [ordered]@{ MUIVerb = [string]$p.MUIVerb; Icon = [string]$p.Icon; MultiSelectModel = [string]$p.MultiSelectModel; command = $cmd }",
    'Write-Output ($o | ConvertTo-Json -Depth 3 -Compress)'
  ].join('; ')
}

/**
 * 解析 statusScript 的 JSON 输出，判断动词是否已正确安装。
 *
 * 判定口径（与 parseRegQuery 一致）：
 *   - MUIVerb 非空
 *   - command 非空（菜单项在但没 command ⇒ 右键能看见、点了没反应，比"没装"更难排查）
 *   - MultiSelectModel === 'Player'
 *   - command 里指向当前 exe（开发态下同时校验 --convert 前含 appPath）
 *
 * @param {string} stdout PowerShell 的标准输出
 * @param {string} [exePath] 期望的 exe 路径
 * @param {object} [opts] { appPath?: string }
 * @returns {{installed:boolean, values:Object<string,string>, command:string|null}}
 */
function parseStatusJson (stdout, exePath = '', opts = {}) {
  let data
  try {
    data = JSON.parse(String(stdout || '').trim())
  } catch (e) {
    return { installed: false, values: {}, command: null }
  }
  if (!data || typeof data !== 'object' || data.__missing) {
    return { installed: false, values: {}, command: null }
  }
  const values = {
    MUIVerb: String(data.MUIVerb || ''),
    Icon: String(data.Icon || ''),
    MultiSelectModel: String(data.MultiSelectModel || '')
  }
  const command = typeof data.command === 'string' ? data.command : null
  const installed = values.MUIVerb.length > 0 &&
    values.MultiSelectModel === 'Player' &&
    hasValidCommand(command, exePath, opts)
  return { installed, values, command }
}

module.exports = {
  VERB_NAME,
  CLASSES_ROOT,
  WILDCARD,
  DEFAULT_LABEL,
  HKCU,
  verbKeyPath,
  commandKeyPath,
  quoteWindowsArg,
  commandLine,
  iconValue,
  verbValues,
  parseRegQuery,
  describeStatus,
  hkcuPath,
  installScript,
  uninstallScript,
  statusScript,
  parseStatusJson
}
