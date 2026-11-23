'use strict'

/**
 * 图片 → PDF 转换实现：png/jpg 原字节零损嵌入，webp/gif 经 worker 转码后嵌入。
 */

const path = require('path')
const { REASON, WARN, fail, warn } = require('../provider')
const animated = require('./animated-image')
const {
  SOURCE_IMAGE_EXTS,
  TRANSCODE_EXTS,
  TRANSCODE_MIME,
  toBuffer,
  looksLike,
  outputName,
  uniqueDest
} = require('./pdf-helpers')

/**
 * 创建图片转 PDF 执行器。
 * @param {object} deps
 * @returns {function(string[], string): Promise<object>}
 */
function createImagesToPdf ({ pdfLib, hasPdfLib, host, readFile, writeFile }) {
  async function transcodeToPng (bytes, ext) {
    if (!host || typeof host.transcodeImage !== 'function') {
      throw new Error('转换工作器不可用，无法转码 ' + ext.toUpperCase() + ' 图片')
    }
    const sourceMime = TRANSCODE_MIME[ext] || 'image/png'
    const r = await host.transcodeImage(bytes, 'image/png', { sourceMime })
    if (!r || !r.ok) {
      throw new Error((r && r.error) || (ext.toUpperCase() + ' 转码失败'))
    }
    const buf = toBuffer(r.bytes)
    if (!buf || !buf.length) {
      throw new Error(ext.toUpperCase() + ' 转码结果为空')
    }
    if (!looksLike(buf, 'png')) {
      throw new Error(ext.toUpperCase() + ' 转码产物不是有效的 PNG（魔数不匹配）')
    }
    return buf
  }

  return async function imagesToPdf (files, outDir) {
    if (!hasPdfLib) {
      return fail(REASON.NOT_INSTALLED, 'pdf-lib 不可用，无法生成 PDF')
    }

    const prepared = []
    const failures = []
    const animatedSources = []

    for (const src of files) {
      try {
        const ext = path.extname(String(src || '')).replace(/^\./, '').toLowerCase()
        if (!SOURCE_IMAGE_EXTS.includes(ext)) {
          failures.push({
            source: src, state: 'failed', outputs: [],
            error: '图片转 PDF 不支持 ' + (ext || '未知') + ' 格式（仅支持 png/jpg/jpeg/webp/gif）'
          })
          continue
        }
        const bytes = toBuffer(readFile(src))
        if (!bytes || !bytes.length) {
          failures.push({ source: src, state: 'failed', outputs: [], error: '源文件为空或读不到' })
          continue
        }
        if (!looksLike(bytes, ext)) {
          failures.push({
            source: src, state: 'failed', outputs: [],
            error: '文件内容不是真正的 ' + ext.toUpperCase() + '（魔数不匹配）'
          })
          continue
        }
        const anim = animated.detectAnimation(bytes, ext)
        if (anim.animated) {
          animatedSources.push({ source: src, ext, frames: anim.frames })
        }
        prepared.push({ source: src, ext, bytes })
      } catch (err) {
        failures.push({
          source: src, state: 'failed', outputs: [],
          error: (err && err.message) || String(err)
        })
      }
    }

    if (!prepared.length) {
      return Object.assign(
        fail(REASON.FAILED, failures[0] ? failures[0].error : '没有可用的图片'),
        { failures }
      )
    }

    try {
      const doc = await pdfLib.PDFDocument.create()
      const embedded = []
      for (const item of prepared) {
        try {
          let img = null
          if (TRANSCODE_EXTS.includes(item.ext)) {
            const png = await transcodeToPng(item.bytes, item.ext)
            img = await doc.embedPng(png)
          } else {
            img = item.ext === 'png'
              ? await doc.embedPng(item.bytes)
              : await doc.embedJpg(item.bytes)
          }
          const w = Number(img.width) || 0
          const h = Number(img.height) || 0
          if (w <= 0 || h <= 0) throw new Error('图片尺寸无效：' + path.basename(item.source))
          const page = doc.addPage([w, h])
          page.drawImage(img, { x: 0, y: 0, width: w, height: h })
          embedded.push(item.source)
        } catch (err) {
          failures.push({
            source: item.source,
            state: 'failed',
            outputs: [],
            error: (err && err.message) || String(err)
          })
        }
      }
      if (!embedded.length) {
        return Object.assign(
          fail(REASON.FAILED, failures[0] ? failures[0].error : '所有图片都无法嵌入 PDF'),
          { failures }
        )
      }

      const pdfBytes = toBuffer(await doc.save())
      if (!looksLike(pdfBytes, 'pdf')) {
        return Object.assign(fail(REASON.FAILED, '生成的 PDF 魔数不正确，已丢弃'), { failures })
      }

      const wanted = path.join(String(outDir || ''), outputName(prepared[0].source, 'pdf'))
      const dest = uniqueDest(wanted, new Set())
      writeFile(dest, pdfBytes)

      const warnings = []
      const embeddedSet = new Set(embedded)
      for (const a of animatedSources) {
        // 仅对真正写入首帧的动图源告警（F2）
        if (!embeddedSet.has(a.source)) continue
        warnings.push(warn(
          WARN.PDF_ANIMATED_FRAME,
          '动图 ' + path.basename(a.source) + ' 只转换了首帧（动图仅取第一帧写入 PDF）'
        ))
      }

      const total = files.length
      const written = embedded.length
      const skipped = total - written
      if (skipped > 0) {
        warnings.push(warn(
          WARN.PDF_IMAGE_SKIPPED,
          '共 ' + total + ' 张图片，已写入 ' + written + ' 张，跳过 ' + skipped +
            ' 张（跳过原因见 failures）'
        ))
      }

      const out = {
        source: prepared[0].source,
        sources: embedded.slice(),
        output: dest,
        pages: embedded.length
      }
      if (warnings.length) out.warnings = warnings

      const result = {
        ok: true,
        reason: REASON.OK,
        outputs: [out],
        failures,
        files: [],
        error: null
      }
      if (warnings.length) result.warnings = warnings
      return result
    } catch (err) {
      return Object.assign(
        fail(REASON.FAILED, (err && err.message) || String(err)),
        { failures }
      )
    }
  }
}

module.exports = { createImagesToPdf }
