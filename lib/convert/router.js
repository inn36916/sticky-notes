'use strict'

/**
 * 转换路由层：管理 provider 列表，对外提供统一的能力查询与转换入口。
 *
 * 职责：
 *   1. 组装 provider（内置优先，Filee 兜底增强）；
 *   2. 能力查询：**合并**多个 provider 的 targets（用户看到的格式更全）；
 *   3. 转换：按 provider 顺序路由到第一个能处理 (ext → target) 的可用 provider；
 *   4. **多 provider 兜底**：一个 provider 失败时自动试下一个（同类格式可能有两条实现）。
 *
 * 为什么合并能力而不是只用一个 provider：
 *   内置 provider 覆盖的是"高频 + 零依赖"；Filee 覆盖的是"长尾 + 保真度高"。
 *   两者目标格式有交集（比如都支持 png→jpg），但也各有独占格式。
 *   合并后用户看到的是**能力全集**，而实际转换时路由会挑成功率更高的那个。
 */

const path = require('path')
const providerLib = require('./provider')
const { REASON } = providerLib

/** 取扩展名（小写、不含点） */
function extOf (filePath) {
  const base = path.basename(String(filePath || ''))
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/**
 * 创建一个路由器。
 *
 * @param {object} deps
 * @param {Array} [deps.providers] 显式指定 provider 列表（测试用）
 * @param {object} [deps.registry]  显式指定 registry（测试用）
 * @returns {object} router
 */
function createRouter (deps = {}) {
  const registry = deps.registry || providerLib.createRegistry(deps.providers || [])

  /**
   * 查询某扩展名的目标格式（合并所有可用 provider）。
   *
   * 合并规则：
   *   - targets：所有 provider 的并集（去重，保持顺序）
   *   - withEngines：所有 provider 的并集
   *   - ok：只要**有一个** provider 能处理该扩展名就算 ok
   *   - reason：全失败时取第一个失败者的 reason
   *
   * @param {string} ext
   * @returns {Promise<{ok:boolean, reason:string, targets:string[], withEngines:string[], displayName:string|null, error:string|null}>}
   */
  async function capabilities (ext) {
    const e = String(ext || '').replace(/^\./, '').toLowerCase()
    if (!e) {
      return {
        ok: false, reason: REASON.USAGE, targets: [], withEngines: [],
        displayName: null, error: '无法识别文件类型'
      }
    }

    const providers = await registry.available()
    if (!providers.length) {
      return {
        ok: false, reason: REASON.NOT_INSTALLED, targets: [], withEngines: [],
        displayName: null, error: '没有可用的转换引擎'
      }
    }

    const targets = []
    const withEngines = []
    const names = []
    let anyOk = false
    let firstReason = REASON.FAILED
    let firstError = null
    let displayName = null

    for (const p of providers) {
      let r
      try {
        r = await p.capabilities(e)
      } catch (err) {
        r = { ok: false, reason: REASON.FAILED, targets: [], withEngines: [], displayName: null, error: err && err.message }
      }
      if (r && r.ok) {
        anyOk = true
        if (r.displayName && !displayName) displayName = r.displayName
        for (const t of (r.targets || [])) if (!targets.includes(t)) targets.push(t)
        for (const t of (r.withEngines || [])) if (!withEngines.includes(t)) withEngines.push(t)
      } else if (r) {
        if (!firstError) {
          firstReason = r.reason || REASON.FAILED
          firstError = r.error || null
        }
      }
      names.push(p.name)
    }

    if (!anyOk) {
      return {
        ok: false, reason: firstReason, targets: [], withEngines: [],
        displayName: null, error: firstError || ('不支持的格式：' + e)
      }
    }

    return {
      ok: true,
      reason: REASON.OK,
      targets,
      withEngines,
      displayName: displayName || null,
      error: null
    }
  }

  /**
   * 执行转换：在所有能处理 (ext → target) 的可用 provider 里依次尝试。
   *
   * ★ 兜底策略：内置 provider 失败（如某格式它解不了）→ 自动试下一个 provider。
   *   这样「png→jpg」两个 provider 都支持时，内置的快路径优先，
   *   内置真的失败（比如文件损坏但 Filee 能救）还能落到 Filee。
   *
   * @param {string[]} files
   * @param {string} target
   * @param {string} outDir
   * @param {object} [opts]
   * @returns {Promise<{ok:boolean, reason:string, outputs:Array, failures:Array, files:Array, error:string|null, provider:string|null}>}
   */
  async function convert (files, target, outDir, opts = {}) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
    if (!list.length) {
      return {
        ok: false, reason: REASON.USAGE, outputs: [], failures: [], files: [],
        error: '没有待转换的文件', provider: null
      }
    }
    if (!target) {
      return {
        ok: false, reason: REASON.USAGE, outputs: [], failures: [], files: [],
        error: '未指定目标格式', provider: null
      }
    }

    const ext = extOf(list[0])
    const { candidates, availableCount } = await registry.resolve(ext, target)

    if (!candidates.length) {
      // ★ 区分"引擎没装"与"引擎在但不支持这个组合"——对用户的提示完全不同
      const reason = availableCount === 0 ? REASON.NOT_INSTALLED : REASON.USAGE
      const error = availableCount === 0
        ? '没有可用的转换引擎'
        : ('没有引擎支持 ' + (ext || '未知') + ' → ' + target)
      return {
        ok: false, reason, outputs: [], failures: [], files: [],
        error, provider: null
      }
    }

    let last = null
    for (const p of candidates) {
      let r
      try {
        r = await p.convert(list, target, outDir, opts)
      } catch (err) {
        r = {
          ok: false, reason: REASON.FAILED, outputs: [], failures: [],
          files: [], error: (err && err.message) || String(err)
        }
      }
      if (r && r.ok) {
        return Object.assign({}, r, { provider: p.id })
      }
      last = r
    }

    return Object.assign({}, last || {
      ok: false, reason: REASON.FAILED, outputs: [], failures: [], files: [], error: '转换失败'
    }, { provider: null })
  }

  /** 列出引擎（用于设置页展示"当前有哪些转换能力来源"） */
  async function engines () {
    const out = []
    for (const p of registry.all()) {
      out.push({ id: p.id, name: p.name, available: await registry.available().then(a => a.includes(p)) })
    }
    return out
  }

  return { registry, capabilities, convert, engines, extOf }
}

module.exports = { createRouter, extOf }
