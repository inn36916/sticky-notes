'use strict'

/**
 * 转换引擎插件发现与加载（纯逻辑，可被 node:test 直接驱动）。
 *
 * ★ 为什么需要这一层（2026-11-16 决策）：
 *   用户拍板「先搭好框架，后续使用其他格式转换代码」。
 *   如果新增一个引擎必须去改 lib/convert/providers/index.js，
 *   那只是"多态"，不是"可插拔"—— 每接一个新引擎都要动核心代码、动版本控制。
 *
 *   这一层让新增引擎变成**纯投放动作**：
 *     把一个 .js 文件丢进插件目录 ⇒ 框架自动发现、校验、注册。
 *     不需要改任何核心文件。
 *
 * 插件文件约定（三选一都能被识别）：
 *
 *   ① module.exports = provider            —— 直接导出 provider 对象
 *   ② module.exports = { provider }         —— 包一层
 *   ③ module.exports = function (deps)      —— 工厂函数，接收上下文 deps
 *
 * 工厂函数收到的 deps：
 *   { appDir, userDataDir, workerHost, log }
 *
 * 插件目录（按顺序找，第一个存在且非空的即用）：
 *   1. 环境变量 STICKY_CONVERT_PLUGINS 指定的路径（可多个，用 ; 分隔）
 *   2. <userDataDir>/convert-plugins/
 *   3. <appDir>/convert-plugins/
 *
 * ★ 安全边界（重要）：
 *   插件代码是**本地任意 JS**，等价于往应用里插了一段代码。
 *   本机制假设插件来源可信（用户自己放的 / 组织内部分发）。
 *   插件只被 require，不被执行任何额外特权操作 —— 它能做的事，
 *   也就是这个 Electron 主进程本来就能做的事。
 *   但我们仍然做两道防护：
 *     - 加载失败只记日志、跳过，**绝不 crash 整个应用**；
 *     - 契约校验不通过的 provider 直接丢弃，不进注册表。
 *
 * 加载顺序与优先级：
 *   插件 provider 排在**内置之后、Filee 之前**。
 *   理由：内置是零依赖快路径；插件是用户显式投放的（通常比 Filee 更贴合需求）；
 *   Filee 是最外层的可选增强。
 */

const fs = require('fs')
const path = require('path')
const providerLib = require('./provider')

/** 插件文件名后缀 */
const PLUGIN_EXT = '.js'

/** 单个插件的加载超时（毫秒）。插件是同步 require，卡死说明它有问题。 */
const PLUGIN_TIMEOUT_MS = 5000

/**
 * 列出插件目录下的候选文件。
 *
 * 只取 .js 文件；跳过以 . 或 _ 开头的（约定为私有/辅助文件）。
 * 不递归子目录 —— 保持简单可预期。
 *
 * @param {string} dir
 * @returns {string[]} 绝对路径，按文件名排序（保证加载顺序稳定）
 */
function listPluginFiles (dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const name = e.name
    if (!name.endsWith(PLUGIN_EXT)) continue
    if (name.startsWith('.') || name.startsWith('_')) continue
    out.push(path.join(dir, name))
  }
  return out.sort()
}

/**
 * 找出实际使用的插件目录。
 *
 * @param {object} opts
 * @param {string} [opts.userDataDir]
 * @param {string} [opts.appDir]
 * @param {object} [opts.env]  环境变量（测试用）
 * @returns {string[]} 目录列表（可能为空）
 */
function resolvePluginDirs (opts = {}) {
  const env = opts.env || process.env
  const dirs = []

  // ① 环境变量优先（多个用 ; 分隔，Windows 上也是分号）
  const fromEnv = env.STICKY_CONVERT_PLUGINS
  if (fromEnv) {
    for (const raw of String(fromEnv).split(';')) {
      const d = raw.trim()
      if (d) dirs.push(path.resolve(d))
    }
  }

  // ② userData 下的插件目录（用户自己投放的地方）
  if (opts.userDataDir) {
    dirs.push(path.join(path.resolve(opts.userDataDir), 'convert-plugins'))
  }

  // ③ 应用目录下的插件目录（随安装分发的引擎）
  if (opts.appDir) {
    dirs.push(path.join(path.resolve(opts.appDir), 'convert-plugins'))
  }

  // 去重（保序）
  const seen = new Set()
  const out = []
  for (const d of dirs) {
    const k = path.resolve(d).toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(d)
  }
  return out
}

/**
 * 从一个已 require 的模块里挑出 provider。
 *
 * 支持三种导出形态（见文件头约定）。
 *
 * ★ 返回值语义（重要）：
 *   - 返回 provider 对象 ⇒ 它通过了契约校验
 *   - 返回 { invalid: mod } ⇒ 它**像** provider（有 id）但契约不全
 *     —— 必须原样交给 validateProvider，才能报出"缺哪个方法"这种有用信息
 *   - 返回 null ⇒ 完全不是 provider 形态
 *
 *   早先的实现对"像 provider 但缺方法"直接返回 null，
 *   导致插件作者只能看到"没有导出符合 provider 契约的对象"，
 *   不知道具体缺了什么 —— 这个信息量太低的报错必须避免。
 *
 * @param {*} mod
 * @returns {object|null}
 */
function pickProvider (mod) {
  if (!mod) return null
  // ① 直接导出 provider
  if (providerLib.validateProvider(mod).ok) return mod
  // ② { provider }
  if (mod && typeof mod === 'object' && mod.provider) {
    if (providerLib.validateProvider(mod.provider).ok) return mod.provider
    if (typeof mod.provider.id === 'string') return { invalid: mod.provider }
    return null
  }
  // ③ 工厂函数
  if (typeof mod === 'function') return mod
  // ④ 有 id ⇒ 大概率是 provider 但不完整，交给上层报精确错误
  if (typeof mod.id === 'string') return { invalid: mod }
  return null
}

/**
 * 加载插件目录里的所有 provider。
 *
 * @param {object} opts
 * @param {string} [opts.userDataDir]
 * @param {string} [opts.appDir]
 * @param {object} [opts.env]
 * @param {object} [opts.context]  传给工厂函数的上下文
 * @param {function} [opts.log]
 * @returns {{providers: Array, errors: Array, dirs: Array}}
 */
function loadPlugins (opts = {}) {
  const log = opts.log || (() => {})
  const dirs = resolvePluginDirs(opts)
  const providers = []
  const errors = []

  for (const dir of dirs) {
    const files = listPluginFiles(dir)
    if (!files.length) continue

    for (const file of files) {
      let mod
      try {
        // 插件是本地可信代码，这里 require 是预期的行为
        delete require.cache[require.resolve(file)]
        mod = require(file)
      } catch (err) {
        errors.push({ file, error: (err && err.message) || String(err) })
        log('[convert-plugins] 加载失败：' + file + ' —— ' + (err && err.message))
        continue
      }

      let picked = pickProvider(mod)
      if (!picked) {
        errors.push({ file, error: '没有导出符合 provider 契约的对象' })
        log('[convert-plugins] 契约不满足：' + file)
        continue
      }

      // 像 provider 但契约不全 ⇒ 用 validateProvider 报出"缺哪个方法"
      if (picked.invalid) {
        const v = providerLib.validateProvider(picked.invalid)
        errors.push({ file, error: v.error })
        log('[convert-plugins] 契约校验失败：' + file + ' —— ' + v.error)
        continue
      }

      // 工厂函数：调用它拿到真正的 provider
      if (typeof picked === 'function') {
        try {
          picked = picked(opts.context || {})
        } catch (err) {
          errors.push({ file, error: '工厂函数抛错：' + ((err && err.message) || String(err)) })
          log('[convert-plugins] 工厂函数失败：' + file)
          continue
        }
      }

      const v = providerLib.validateProvider(picked)
      if (!v.ok) {
        errors.push({ file, error: v.error })
        log('[convert-plugins] 契约校验失败：' + file + ' —— ' + v.error)
        continue
      }

      providers.push(picked)
    }
  }

  return { providers, errors, dirs }
}

module.exports = {
  PLUGIN_EXT,
  resolvePluginDirs,
  listPluginFiles,
  pickProvider,
  loadPlugins
}
