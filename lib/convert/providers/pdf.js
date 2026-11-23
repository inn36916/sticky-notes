'use strict'

/**
 * 内置 PDF provider 装配入口（图片 → PDF 由 pdf-from-images 处理，PDF → 图/文本由 pdf-to-outputs 处理）。
 */

const fs = require('fs')
const { REASON, fail } = require('../provider')
const helpers = require('./pdf-helpers')
const { createImagesToPdf } = require('./pdf-from-images')
const { createPdfFromTo } = require('./pdf-to-outputs')

const {
  PROVIDER_ID,
  PROVIDER_NAME,
  SOURCE_IMAGE_EXTS,
  TRANSCODE_EXTS,
  TRANSCODE_MIME,
  IMAGE_TARGETS,
  PDF_TARGETS,
  MAX_ALL_PAGES,
  TARGET_ALIASES,
  TARGET_MIME,
  MAGIC,
  outputName,
  uniqueDest,
  looksLike,
  toBuffer
} = helpers

/**
 * 创建内置 PDF provider。
 *
 * @param {object} [deps]
 * @param {object} [deps.workerHost]
 * @param {object} [deps.pdfLib]
 * @param {function} [deps.readFile]
 * @param {function} [deps.writeFile]
 * @returns {object} provider
 */
function createPdfProvider (deps = {}) {
  const ctx = deps || {}
  const host = ctx.workerHost || null
  const readFile = typeof ctx.readFile === 'function' ? ctx.readFile : fs.readFileSync
  const writeFile = typeof ctx.writeFile === 'function' ? ctx.writeFile : fs.writeFileSync

  let pdfLib = ctx.pdfLib || null
  if (!pdfLib) {
    try { pdfLib = require('pdf-lib') } catch (_) { pdfLib = null }
  }

  const hasPdfLib = !!(pdfLib && typeof pdfLib.PDFDocument === 'function')
  const hasWorker = !!(host &&
    typeof host.renderPdf === 'function' &&
    typeof host.extractPdfText === 'function' &&
    typeof host.encode === 'function')
  const canTranscode = !!(host && typeof host.transcodeImage === 'function')

  const imagesToPdf = createImagesToPdf({ pdfLib, hasPdfLib, host, readFile, writeFile })
  const pdfFromTo = createPdfFromTo({ host, hasWorker, readFile, writeFile })

  async function canHandle (ext, target) {
    const e = String(ext || '').toLowerCase()
    if (target == null) return e === 'pdf' || SOURCE_IMAGE_EXTS.includes(e)
    const t = String(target || '').toLowerCase()
    if (e === 'pdf') return PDF_TARGETS.includes(t) || TARGET_ALIASES.includes(t)
    if (TRANSCODE_EXTS.includes(e)) return t === 'pdf' && canTranscode
    if (SOURCE_IMAGE_EXTS.includes(e)) return t === 'pdf'
    return false
  }

  async function capabilities (ext) {
    const e = String(ext || '').toLowerCase()
    if (e === 'pdf') {
      return {
        ok: hasWorker,
        reason: hasWorker ? REASON.OK : REASON.NOT_INSTALLED,
        targets: hasWorker ? PDF_TARGETS.slice() : [],
        withEngines: [],
        displayName: hasWorker ? 'PDF 文档' : null,
        error: hasWorker ? null : '转换工作器不可用，无法渲染 PDF'
      }
    }
    if (TRANSCODE_EXTS.includes(e)) {
      const ok = hasPdfLib && canTranscode
      return {
        ok,
        reason: ok ? REASON.OK : REASON.NOT_INSTALLED,
        targets: ok ? ['pdf'] : [],
        withEngines: [],
        displayName: ok ? '图片' : null,
        error: ok
          ? null
          : (hasPdfLib
            ? '转换工作器不可用，无法转码 ' + e.toUpperCase() + ' 图片'
            : 'pdf-lib 不可用，无法生成 PDF')
      }
    }
    if (SOURCE_IMAGE_EXTS.includes(e)) {
      return {
        ok: hasPdfLib,
        reason: hasPdfLib ? REASON.OK : REASON.NOT_INSTALLED,
        targets: hasPdfLib ? ['pdf'] : [],
        withEngines: [],
        displayName: hasPdfLib ? '图片' : null,
        error: hasPdfLib ? null : 'pdf-lib 不可用，无法生成 PDF'
      }
    }
    return fail(REASON.USAGE, 'PDF 转换不支持的源格式：' + (e || '未知'))
  }

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,

    async available () {
      return hasPdfLib && hasWorker
    },

    canHandle,
    capabilities,

    async convert (files, target, outDir, opts) {
      const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
      if (!list.length) return fail(REASON.USAGE, '没有待转换的文件')
      const allPages = !!(opts && opts.allPages)
      const t = String(target || '').toLowerCase()
      if (t === 'pdf') return imagesToPdf(list, outDir)
      if (PDF_TARGETS.includes(t) || TARGET_ALIASES.includes(t)) {
        return pdfFromTo(list, t === 'jpeg' ? 'jpg' : t, outDir, allPages, opts)
      }
      return fail(REASON.USAGE, 'PDF 转换不支持目标格式：' + (t || '未知'))
    }
  }
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_NAME,
  SOURCE_IMAGE_EXTS,
  TRANSCODE_EXTS,
  TRANSCODE_MIME,
  IMAGE_TARGETS,
  PDF_TARGETS,
  MAX_ALL_PAGES,
  TARGET_MIME,
  MAGIC,
  createPdfProvider,
  outputName,
  uniqueDest,
  looksLike,
  toBuffer
}
