'use strict'

/**
 * 内置 SVG 矢量 provider（光栅化转 png / jpg / webp，走隐藏 worker 的 canvas）。
 *
 * 与 examples/convert-plugins/svg.js 保持同样严格的反假成功防线：
 *   - 魔数校验（PNG / JPEG / RIFF+WEBP）；
 *   - 产物警告透传（blank / external-ref / scaled）；
 *   - 批内防重名覆盖（uniqueDest）。
 *
 * 优先级设计：在 providers/index.js 中注册在插件之后，
 * 用户手动投放示例插件时插件仍优先命中，未投放插件时开箱即用。
 */

const fs = require('fs')
const path = require('path')
const { REASON, WARN, fail, warn } = require('../provider')
const { toBuffer, looksLike, outputName, uniqueDest } = require('./pdf-helpers')

const PROVIDER_ID = 'builtin-svg'
const PROVIDER_NAME = '内置 SVG 矢量转换'
const SOURCE_EXTS = ['svg']

const TARGET_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}
const TARGETS = Object.keys(TARGET_MIME)

/**
 * 创建内置 SVG provider。
 *
 * @param {object} [deps]
 * @param {object} [deps.workerHost]
 * @param {function} [deps.log]
 * @param {function} [deps.readFile]
 * @param {function} [deps.writeFile]
 * @returns {object} provider
 */
function createSvgProvider (deps = {}) {
  const ctx = deps || {}
  const workerHost = ctx.workerHost || null
  const log = typeof ctx.log === 'function' ? ctx.log : () => {}
  const readFile = typeof ctx.readFile === 'function' ? ctx.readFile : fs.readFileSync
  const writeFile = typeof ctx.writeFile === 'function' ? ctx.writeFile : fs.writeFileSync

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,

    async available () {
      return !!(workerHost &&
        typeof workerHost.renderSvg === 'function' &&
        typeof workerHost.encode === 'function')
    },

    async canHandle (ext, target) {
      const e = String(ext || '').toLowerCase()
      if (!SOURCE_EXTS.includes(e)) return false
      if (target == null) return true
      return TARGETS.includes(String(target || '').toLowerCase())
    },

    async capabilities (ext) {
      const e = String(ext || '').toLowerCase()
      if (!SOURCE_EXTS.includes(e)) {
        return fail(REASON.USAGE, '内置 SVG 只处理 .svg 源文件（收到：' + (e || '未知') + '）')
      }
      return {
        ok: true,
        reason: REASON.OK,
        targets: TARGETS.slice(),
        withEngines: [],
        displayName: '矢量图',
        error: null
      }
    },

    async convert (files, target, outDir) {
      const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
      if (!list.length) return fail(REASON.USAGE, '没有待转换的文件')

      const t = String(target || '').toLowerCase()
      const mime = TARGET_MIME[t]
      if (!mime) {
        return fail(REASON.USAGE, 'SVG 不支持目标格式：' + (t || '未知'))
      }
      if (!workerHost || typeof workerHost.renderSvg !== 'function' || typeof workerHost.encode !== 'function') {
        return fail(REASON.NOT_INSTALLED, '转换工作器不可用，无法光栅化 SVG')
      }

      const outputs = []
      const failures = []
      const usedDest = new Set()

      for (const src of list) {
        try {
          const raw = readFile(src, 'utf8')
          const svgText = typeof raw === 'string' ? raw : (toBuffer(raw) ? toBuffer(raw).toString('utf8') : '')
          if (!svgText.trim()) {
            failures.push({ source: src, state: 'failed', outputs: [], error: 'SVG 文件内容为空' })
            continue
          }

          const rendered = await workerHost.renderSvg(svgText)
          if (!rendered || !rendered.ok || !rendered.canvasId) {
            failures.push({
              source: src,
              state: 'failed',
              outputs: [],
              error: (rendered && rendered.error) || 'SVG 渲染失败'
            })
            continue
          }

          const warnings = []
          if (rendered.blank) {
            warnings.push(warn(WARN.BLANK,
              '产物是全透明的空白图：源 SVG 没有可见内容，或内容依赖浏览器不渲染的东西'))
            log('[builtin-svg] ' + path.basename(String(src)) + ' 渲染结果全透明')
          }
          if (rendered.externalRef) {
            warnings.push(warn(WARN.EXTERNAL_REF,
              '源 SVG 引用了外部图片或字体，浏览器渲染 SVG 图片时不会加载它们，产物中对应位置是空白'))
          }
          if (rendered.scaled) {
            warnings.push(warn(WARN.SCALED,
              '源 SVG 尺寸超过上限（最长边 8192），产物已等比缩小到 ' +
              rendered.width + '×' + rendered.height))
          }

          const encoded = await workerHost.encode(rendered.canvasId, mime)
          if (!encoded || !encoded.ok) {
            failures.push({
              source: src,
              state: 'failed',
              outputs: [],
              error: (encoded && encoded.error) || '编码失败'
            })
            continue
          }
          const buf = toBuffer(encoded.bytes)
          if (!buf || !buf.length) {
            failures.push({ source: src, state: 'failed', outputs: [], error: '编码结果为空' })
            continue
          }
          if (!looksLike(buf, t === 'jpeg' ? 'jpg' : t)) {
            failures.push({
              source: src,
              state: 'failed',
              outputs: [],
              error: '产物不是有效的 ' + t.toUpperCase() + '（疑似编码器回退，已丢弃以免产出假文件）'
            })
            continue
          }

          const wanted = path.join(String(outDir || ''), outputName(src, t))
          const dest = uniqueDest(wanted, usedDest)
          writeFile(dest, buf)
          usedDest.add(String(dest).toLowerCase())
          const out = { source: src, output: dest }
          if (warnings.length) out.warnings = warnings
          outputs.push(out)
        } catch (err) {
          failures.push({
            source: src,
            state: 'failed',
            outputs: [],
            error: (err && err.message) || String(err)
          })
        }
      }

      if (!outputs.length) {
        return Object.assign(
          fail(REASON.FAILED, failures[0] ? failures[0].error : 'SVG 转换失败'),
          { failures }
        )
      }

      return {
        ok: true,
        reason: REASON.OK,
        outputs,
        failures,
        files: [],
        error: null
      }
    }
  }
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_NAME,
  TARGETS,
  TARGET_MIME,
  createSvgProvider
}
