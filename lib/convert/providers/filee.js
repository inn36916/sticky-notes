'use strict'

/**
 * Filee provider：把现有 filee-cli 适配层包装成 provider 契约。
 *
 * ★ 定位：**可选增强**，不是必需。
 *   用户不装 Filee 时，框架靠内置 provider 工作；
 *   检测到 Filee 时，自动多出一大批格式（PDF / Office / HWP / 矢量…）。
 *   Filee 未安装 ⇒ 这个 provider 的 available() 返回 false，
 *   框架自动跳过它，**不影响任何现有行为**。
 *
 * 这条设计让「不装 Filee」和「装了 Filee」两条路径共用同一套 UI 与编排，
 * 避免为两种情况维护两套界面。
 */

const fileeCli = require('../filee-cli')
const { REASON } = require('../provider')

/**
 * 创建 Filee provider。
 *
 * @param {object} [deps]
 * @param {string} [deps.bin] 已解析好的 Filee CLI 路径（不给则自动探测）
 * @param {function} [deps.resolveBin] 解析函数（测试用）
 * @param {object} [deps.cli] 注入的 CLI 层（测试用）
 * @returns {object} provider
 */
function createFileeProvider (deps = {}) {
  const cli = deps.cli || fileeCli
  let binCache = null

  /** 解析 Filee CLI（带缓存） */
  function resolveBin () {
    if (binCache !== null) return binCache
    try {
      if (typeof deps.resolveBin === 'function') {
        binCache = deps.resolveBin() || ''
      } else if (typeof cli.findFileeBin === 'function') {
        binCache = cli.findFileeBin({ appDir: deps.appDir || '' }) || ''
      } else {
        binCache = ''
      }
    } catch (_) {
      binCache = ''
    }
    return binCache
  }

  return {
    id: 'filee',
    name: 'Filee',

    async available () {
      return !!resolveBin()
    },

    async capabilities (ext) {
      const bin = resolveBin()
      if (!bin) {
        return {
          ok: false,
          reason: REASON.NOT_INSTALLED,
          targets: [],
          withEngines: [],
          displayName: null,
          error: '未找到 Filee'
        }
      }
      const r = await cli.capabilities(bin, ext)
      return {
        ok: r.ok,
        reason: r.reason,
        targets: r.targets || [],
        withEngines: r.withEngines || [],
        displayName: r.displayName || null,
        error: r.error || null
      }
    },

    async convert (files, target, outDir) {
      const bin = resolveBin()
      if (!bin) {
        return {
          ok: false,
          reason: REASON.NOT_INSTALLED,
          outputs: [],
          failures: [],
          files: [],
          error: '未找到 Filee'
        }
      }
      const r = await cli.convert(bin, files, target, outDir)
      return {
        ok: r.ok,
        reason: r.reason,
        outputs: r.outputs || [],
        failures: r.failures || [],
        files: r.files || [],
        error: r.error || null
      }
    }
  }
}

module.exports = { createFileeProvider }
