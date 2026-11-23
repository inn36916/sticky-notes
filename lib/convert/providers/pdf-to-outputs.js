'use strict'

/**
 * PDF → 图片 / 文本转换实现（拆分单页、全页文本、全页图片与公共编码校验）。
 */

const path = require('path')
const { REASON, WARN, fail, warn } = require('../provider')
const {
  MAX_ALL_PAGES,
  TARGET_MIME,
  toBuffer,
  looksLike,
  outputName,
  uniqueDest,
  pageSource,
  pageLimitWarning,
  workerError
} = require('./pdf-helpers')

/**
 * 创建 PDF 导出执行器。
 * @param {object} deps
 * @returns {function(string[], string, string, boolean=, object=): Promise<object>}
 */
function createPdfFromTo ({ host, hasWorker, readFile, writeFile }) {
  /** 单页画布编码与类型/魔数校验（默认单页与全页模式共用） */
  async function encodePageImage (payload, mime, t) {
    if (!payload || !payload.canvasId) {
      return { buf: null, error: 'PDF 渲染未返回画布句柄' }
    }
    let encoded = null
    try {
      encoded = await host.encode(payload.canvasId, mime)
    } catch (err) {
      return { buf: null, error: (err && err.message) || String(err) }
    }
    if (!encoded || !encoded.ok) {
      return { buf: null, error: (encoded && encoded.error) || 'PDF 页面编码失败' }
    }
    if (encoded.type && encoded.type !== mime) {
      return {
        buf: null,
        error: '编码器返回了 ' + encoded.type + '（期望 ' + mime + '），已丢弃以免产出假文件'
      }
    }
    const buf = toBuffer(encoded.bytes)
    if (!buf || !buf.length || !looksLike(buf, t)) {
      return { buf: null, error: '产物不是有效的 ' + t.toUpperCase() + '（疑似编码器回退，已丢弃）' }
    }
    return { buf, error: null }
  }

  /** 全页文本抽取 */
  async function convertAllPagesText (src, bytes, outDir, ctx) {
    ctx.reportProgress({
      source: src, phase: 'text', page: null, total: null, done: 0, failed: 0
    })
    let payload = null
    try {
      payload = await host.extractPdfText(bytes, { allPages: true, maxPages: MAX_ALL_PAGES })
    } catch (err) {
      ctx.failures.push({
        source: src, state: 'failed', outputs: [],
        error: (err && err.message) || String(err)
      })
      return
    }
    if (!payload || !payload.ok) {
      ctx.failures.push({
        source: src, state: 'failed', outputs: [], error: workerError(payload)
      })
      return
    }
    const numPages = Number(payload.numPages) || 1
    const converted = Number(payload.pagesConverted) || numPages
    const textBuf = Buffer.from(String(payload.text == null ? '' : payload.text), 'utf8')
    const wanted = path.join(String(outDir || ''), outputName(src, 'txt'))
    const dest = uniqueDest(wanted, ctx.usedDest)
    writeFile(dest, textBuf)
    ctx.usedDest.add(String(dest).toLowerCase())

    const out = { source: src, output: dest }
    if (converted < numPages) {
      const w = pageLimitWarning(numPages)
      out.warnings = [w]
      ctx.globalWarnings.push(w)
    }
    ctx.outputs.push(out)
  }

  /** 全页位图渲染与逐页编码 */
  async function convertAllPagesImages (src, bytes, t, mime, outDir, ctx) {
    let failedPages = 0
    let okPages = 0
    ctx.reportProgress({
      source: src, phase: 'prepare', page: null, total: null, done: 0, failed: 0
    })

    let first = null
    try {
      first = await host.renderPdf(bytes, { pageNumber: 1 })
    } catch (err) {
      ctx.failures.push({
        source: src, state: 'failed', outputs: [],
        error: (err && err.message) || String(err)
      })
      return
    }
    if (!first || !first.ok) {
      ctx.failures.push({
        source: src, state: 'failed', outputs: [], error: workerError(first)
      })
      return
    }

    const numPages = Number(first.numPages) || 1
    const count = Math.min(numPages, MAX_ALL_PAGES)
    const pageParts = [{ n: 1, payload: first }]

    for (let n = 2; n <= count; n++) {
      try {
        const one = await host.renderPdf(bytes, { pageNumber: n })
        if (!one || !one.ok) {
          ctx.failures.push({
            source: src, state: 'failed', outputs: [],
            error: '第 ' + n + ' 页渲染失败：' + workerError(one)
          })
          pageParts.push({ n, payload: null, renderFailed: true })
          continue
        }
        pageParts.push({ n, payload: one })
      } catch (err) {
        ctx.failures.push({
          source: src, state: 'failed', outputs: [],
          error: '第 ' + n + ' 页渲染失败：' + ((err && err.message) || String(err))
        })
        pageParts.push({ n, payload: null, renderFailed: true })
      }
    }

    const limitWarn = count < numPages ? pageLimitWarning(numPages) : null
    if (limitWarn) ctx.globalWarnings.push(limitWarn)

    const sourceOutputsStart = ctx.outputs.length
    let firstOkPageNo = 0

    for (const item of pageParts) {
      if (item.renderFailed) {
        failedPages++
        ctx.reportProgress({
          source: src, phase: 'pages', page: item.n, total: count,
          done: okPages, failed: failedPages
        })
        continue
      }
      const encoded = await encodePageImage(item.payload, mime, t)
      if (encoded.error) {
        ctx.failures.push({
          source: src, state: 'failed', outputs: [],
          error: '第 ' + item.n + ' 页' + encoded.error
        })
        failedPages++
        ctx.reportProgress({
          source: src, phase: 'pages', page: item.n, total: count,
          done: okPages, failed: failedPages
        })
        continue
      }

      const single = count === 1
      const pseudo = single ? src : pageSource(src, item.n)
      const wanted = path.join(String(outDir || ''), outputName(pseudo, t))
      const dest = uniqueDest(wanted, ctx.usedDest)
      writeFile(dest, encoded.buf)
      ctx.usedDest.add(String(dest).toLowerCase())

      const out = { source: pseudo, output: dest }
      if (!single) out.page = item.n
      if (!firstOkPageNo) firstOkPageNo = item.n

      const warnings = []
      if (item.payload && item.payload.scaled) {
        warnings.push(warn(
          WARN.SCALED,
          'PDF 页面尺寸超过上限，已等比缩小到 ' +
            item.payload.width + '×' + item.payload.height
        ))
      }
      if (warnings.length) out.warnings = warnings
      // 保持与顶层同一对象引用（F3）
      if (limitWarn && out.page === firstOkPageNo) {
        if (!Array.isArray(out.warnings)) out.warnings = []
        out.warnings.push(limitWarn)
      }
      ctx.outputs.push(out)
      okPages++
      ctx.reportProgress({
        source: src, phase: 'pages', page: item.n, total: count,
        done: okPages, failed: failedPages
      })
    }

    if (okPages > 0 && failedPages > 0) {
      const w = warn(
        WARN.PDF_PAGE_FAILED,
        'PDF 共 ' + numPages + ' 页，成功转换 ' + okPages + ' 页，' +
          failedPages + ' 页失败'
      )
      ctx.globalWarnings.push(w)
      const firstOut = ctx.outputs[sourceOutputsStart]
      if (firstOut) {
        if (!Array.isArray(firstOut.warnings)) firstOut.warnings = []
        firstOut.warnings.push(w)
      }
    }
  }

  /** 默认模式（仅转第 1 页） */
  async function convertFirstPage (src, bytes, t, mime, isText, outDir, ctx) {
    const payload = isText
      ? await host.extractPdfText(bytes)
      : await host.renderPdf(bytes, {})
    if (!payload || !payload.ok) {
      ctx.failures.push({
        source: src, state: 'failed', outputs: [], error: workerError(payload)
      })
      return
    }

    let buf = null
    if (isText) {
      buf = Buffer.from(String(payload.text == null ? '' : payload.text), 'utf8')
    } else {
      const encoded = await encodePageImage(payload, mime, t)
      if (encoded.error) {
        ctx.failures.push({ source: src, state: 'failed', outputs: [], error: encoded.error })
        return
      }
      buf = encoded.buf
    }

    const wanted = path.join(String(outDir || ''), outputName(src, t))
    const dest = uniqueDest(wanted, ctx.usedDest)
    writeFile(dest, buf)
    ctx.usedDest.add(String(dest).toLowerCase())

    const out = { source: src, output: dest }
    const numPages = Number(payload.numPages) || 0
    const warnings = []
    if (numPages > 1) {
      warnings.push(warn(
        WARN.PDF_MULTIPAGE,
        'PDF 共 ' + numPages + ' 页，仅转换了第 1 页'
      ))
    }
    if (!isText && payload.scaled) {
      warnings.push(warn(
        WARN.SCALED,
        'PDF 页面尺寸超过上限，已等比缩小到 ' + payload.width + '×' + payload.height
      ))
    }
    if (warnings.length) out.warnings = warnings
    ctx.outputs.push(out)
  }

  return async function pdfFromTo (files, t, outDir, allPages, opts) {
    if (!hasWorker) {
      return fail(REASON.NOT_INSTALLED, '转换工作器不可用，无法读取或渲染 PDF')
    }
    const all = allPages === true
    const isText = t === 'txt'
    const mime = isText ? '' : TARGET_MIME[t]
    if (!isText && !mime) return fail(REASON.USAGE, 'PDF 不支持目标格式：' + t)

    const onProgress = (opts && typeof opts.onProgress === 'function')
      ? opts.onProgress
      : null

    const ctx = {
      outputs: [],
      failures: [],
      usedDest: new Set(),
      globalWarnings: [],
      reportProgress (payload) {
        if (!onProgress) return
        try { onProgress(payload) } catch (_) {}
      }
    }

    for (const src of files) {
      try {
        const ext = path.extname(String(src || '')).replace(/^\./, '').toLowerCase()
        if (ext !== 'pdf') {
          ctx.failures.push({
            source: src, state: 'failed', outputs: [],
            error: 'PDF 转换只接受 .pdf 源文件（收到：' + (ext || '未知') + '）'
          })
          continue
        }
        const bytes = toBuffer(readFile(src))
        if (!bytes || !bytes.length) {
          ctx.failures.push({ source: src, state: 'failed', outputs: [], error: '源文件为空或读不到' })
          continue
        }
        if (!looksLike(bytes, 'pdf')) {
          ctx.failures.push({
            source: src, state: 'failed', outputs: [],
            error: '不是有效的 PDF 文件（缺少 %PDF- 魔数，可能已损坏或改错后缀）'
          })
          continue
        }

        if (all && isText) {
          await convertAllPagesText(src, bytes, outDir, ctx)
        } else if (all) {
          await convertAllPagesImages(src, bytes, t, mime, outDir, ctx)
        } else {
          await convertFirstPage(src, bytes, t, mime, isText, outDir, ctx)
        }
      } catch (err) {
        ctx.failures.push({
          source: src, state: 'failed', outputs: [],
          error: (err && err.message) || String(err)
        })
      }
    }

    if (!ctx.outputs.length) {
      const result = Object.assign(
        fail(REASON.FAILED, ctx.failures[0] ? ctx.failures[0].error : 'PDF 转换失败'),
        { failures: ctx.failures }
      )
      if (ctx.globalWarnings.length) result.warnings = ctx.globalWarnings
      return result
    }
    const result = {
      ok: true,
      reason: REASON.OK,
      outputs: ctx.outputs,
      failures: ctx.failures,
      files: [],
      error: null
    }
    if (ctx.globalWarnings.length) result.warnings = ctx.globalWarnings
    return result
  }
}

module.exports = { createPdfFromTo }
