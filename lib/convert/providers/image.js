'use strict'

/**
 * 内置图片 provider：走 Chromium 的 canvas 能力（零新增依赖）。
 *
 * ★ 实测结论（2026-11-16，Electron 33 / Chromium，脚本 probe-canvas-codecs.js）：
 *
 *   编码（canvas.toBlob）：
 *     image/png   ✅ 真的 PNG
 *     image/jpeg  ✅ 真的 JPEG
 *     image/webp  ✅ 真的 WEBP
 *     image/gif   ❌ **静默回退成 PNG**（blob.type === 'image/png'）
 *     image/bmp   ❌ 静默回退成 PNG
 *     image/avif  ❌ 静默回退成 PNG
 *     image/x-icon❌ 静默回退成 PNG
 *     image/svg+xml ❌ 静默回退成 PNG
 *     image/tiff  ❌ 静默回退成 PNG
 *
 *   ⇒ **绝不能相信 toBlob 的第二个参数**。必须校验返回的 blob.type，
 *     不等于请求的 mime 就判定「不支持」。
 *     否则「转 gif」会静默产出一个 PNG 文件，用户以为成功了。
 *
 *   解码（createImageBitmap）：
 *     image/png   ✅
 *     image/gif   ✅
 *     image/jpeg  ✅（Chromium 支持，但本轮未单独回归）
 *     image/webp  ✅
 *     image/svg+xml ❌（不是 raster，SVG 走矢量 provider）
 *
 * 已知限制（如实告知，不掩盖）：
 *   - 转成 jpeg 时透明区域会变黑底（canvas 填充默认透明 → jpeg 无 alpha）。
 *     这是 canvas 的固有行为，不是 bug。
 *   - 动图（gif/apng/webp 动图）只取第一帧。
 *
 * 为什么不用 sharp / ImageMagick：会引入 native 依赖与体积，
 * 而 canvas 已经覆盖了「零引擎档里最高频」的那部分。
 */

const path = require('path')
const fs = require('fs')
const { REASON, fail } = require('../provider')

/**
 * canvas 真正支持的编码 mime。
 * ⚠️ 这个白名单是**实测**出来的，不能凭 API 文档推断。
 */
const ENCODE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

/** 扩展名 → mime（用于解码时构造 Blob） */
const DECODE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon'
}

/** 源扩展名白名单（我们能解的） */
const SOURCE_EXTS = Object.keys(DECODE_MIME)

/** 目标扩展名白名单（我们能编的） */
const TARGET_EXTS = Object.keys(ENCODE_MIME)

/**
 * 创建一个图片 provider。
 *
 * @param {object} deps
 * @param {function} deps.decode  解码函数：(filePath) → Promise<{width, height, canvasId}|null>
 *        必须返回可用于编码的句柄。由渲染进程注入（canvas 只能在渲染进程用）。
 * @param {function} deps.encode  编码函数：(img, mime, ext) → Promise<Buffer|null>
 * @returns {object} provider
 */
function createImageProvider (deps = {}) {
  const decode = deps.decode
  const encode = deps.encode

  return {
    id: 'builtin-image',
    name: '内置图片转换',

    async available () {
      return typeof decode === 'function' && typeof encode === 'function'
    },

    /** 源扩展名能转的目标（只有图片类源才走这个 provider） */
    async canHandle (ext, target) {
      const e = String(ext || '').toLowerCase()
      if (!SOURCE_EXTS.includes(e)) return false
      if (target == null) return true
      const t = String(target || '').toLowerCase()
      return TARGET_EXTS.includes(t)
    },

    async capabilities (ext) {
      const e = String(ext || '').toLowerCase()
      if (!SOURCE_EXTS.includes(e)) {
        return fail(REASON.USAGE, '不支持的源格式：' + e)
      }
      return {
        ok: true,
        reason: REASON.OK,
        targets: TARGET_EXTS.slice(),
        withEngines: [],
        displayName: '图片',
        error: null
      }
    },

    async convert (files, target, outDir) {
      const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
      if (!list.length) return fail(REASON.USAGE, '没有待转换的文件')

      const t = String(target || '').toLowerCase()
      const mime = ENCODE_MIME[t]
      if (!mime) {
        return fail(REASON.USAGE, '内置图片转换不支持目标格式：' + t)
      }

      const outputs = []
      const failures = []

      for (const src of list) {
        try {
          const img = await decode(src)
          if (!img) {
            failures.push({ source: src, state: 'failed', outputs: [], error: '无法解码该图片' })
            continue
          }
          const buf = await encode(img, mime, t)
          if (!buf || !buf.length) {
            failures.push({ source: src, state: 'failed', outputs: [], error: '编码失败' })
            continue
          }
          const dest = path.join(outDir, outputName(src, t))
          fs.writeFileSync(dest, buf)
          outputs.push({ source: src, output: dest })
        } catch (err) {
          failures.push({ source: src, state: 'failed', outputs: [], error: err && err.message ? err.message : String(err) })
        }
      }

      if (!outputs.length) {
        return Object.assign(fail(REASON.FAILED, failures[0] ? failures[0].error : '转换失败'), { failures })
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

/**
 * 产物文件名：<原名>-<随机>.<ext>
 * @param {string} src
 * @param {string} ext
 */
function outputName (src, ext) {
  const base = path.basename(String(src || ''), path.extname(String(src || '')))
  const safe = base.replace(/[^\w.\-一-龥 ()]+/g, '_').slice(0, 60) || 'image'
  const sfx = Math.random().toString(36).slice(2, 8)
  return `${safe}-${sfx}.${ext}`
}

module.exports = {
  ENCODE_MIME,
  DECODE_MIME,
  SOURCE_EXTS,
  TARGET_EXTS,
  createImageProvider,
  outputName
}
