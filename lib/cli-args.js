'use strict'

/**
 * 命令行参数解析（纯函数，不依赖 Electron / fs）。
 *
 * 背景：右键菜单（HKCU\Software\Classes\*\shell\...）会以
 *   "<exe>" --convert "%1"
 * 的形式启动本应用；主进程还要能作为 CLI 直接用：
 *   sticky-notes --convert photo.heic --to jpg
 *
 * 这里的难点是 **argv 形态在开发/打包两种模式下不一样**：
 *   - 开发：  process.argv = [electron, '.', '--convert', 'x.heic']
 *   - 打包：  process.argv = ['C:\\...\\StickyNotes.exe', '--convert', 'x.heic']
 *   - 二次实例：Electron 的 second-instance 回调给的是 (event, argv, cwd)，
 *     argv 与上面的形态一致（也可能是空数组，取决于平台）。
 *
 * 所以解析器必须**只认 `--` 之后的显式参数**，不依赖 argv[0]/argv[1] 的位置，
 * 否则两种形态会解析出不同结果。
 *
 * 约定：
 *   --convert <path...>   进入转换模式；路径可给多个
 *   --to <format>         目标格式（缺省由 UI 选；给了就直接转）
 *   --version             打印版本
 *   --help                打印帮助
 *   其余 --xxx 一律忽略（不报错，避免用户误传参数导致启动失败）
 */

/** 支持的命令 */
const CMD_CONVERT = 'convert'
const CMD_VERSION = 'version'
const CMD_HELP = 'help'

/**
 * 解析 argv。
 *
 * @param {string[]} argv 完整 argv（含可执行名与脚本路径）
 * @returns {{command: string|null, files: string[], to: string|null, help: boolean, version: boolean}}
 */
function parseArgs (argv) {
  const out = {
    command: null,
    files: [],
    to: null,
    help: false,
    version: false
  }
  if (!Array.isArray(argv)) return out

  const args = argv.map(a => String(a))

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') break
    // 单字母开关（-h）也要在这里拦下，否则会掉进位置参数分支
    if (a === '-h') {
      out.command = out.command || CMD_HELP
      out.help = true
      continue
    }
    if (!a.startsWith('--')) {
      // 位置参数：只有在已经进入 --convert 之后才算文件路径，
      // 否则 argv[0]/argv[1]（可执行名、脚本路径）会被误当成文件。
      if (out.command === CMD_CONVERT) out.files.push(a)
      continue
    }

    switch (a) {
      case '--convert':
        out.command = CMD_CONVERT
        break
      case '--to': {
        // 下一个 token 是目标格式；缺失时不算错误，只是没指定
        const next = args[i + 1]
        if (next && !next.startsWith('--')) {
          out.to = next
          i++
        }
        break
      }
      case '--version':
        out.command = out.command || CMD_VERSION
        out.version = true
        break
      case '--help':
        out.command = out.command || CMD_HELP
        out.help = true
        break
      default:
        // 未知开关：忽略（保持应用能正常启动）
        break
    }
  }

  return out
}

/**
 * 是否处于「转换模式」——即需要走转换流程而不是正常启动便签。
 * @param {{command: string|null, files: string[]}} parsed
 */
function isConvertMode (parsed) {
  return !!parsed && parsed.command === CMD_CONVERT && parsed.files.length > 0
}

/**
 * 从一批 argv（可能来自多次启动）里挑出转换相关的那一份。
 * 二次实例场景：主进程收到的 argv 是新一轮启动的参数。
 */
function pickConvertArgv (argv) {
  const parsed = parseArgs(argv)
  return isConvertMode(parsed) ? parsed : null
}

module.exports = {
  CMD_CONVERT,
  CMD_VERSION,
  CMD_HELP,
  parseArgs,
  isConvertMode,
  pickConvertArgv
}
