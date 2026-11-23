'use strict'

/**
 * 内置文档 provider（纯 JS + 主进程隔离 printToPDF + worker 结构化 PDF 抽取）。
 *
 * 覆盖格式：
 *   - docx → md / html / txt（有 workerHost.renderHtmlToPdf 时增加 pdf）
 *   - html / htm → md / txt（有 renderHtmlToPdf 时增加 pdf）
 *   - md → html（有 renderHtmlToPdf 时增加 pdf；绝不截胡 builtin-text-data 的 md↔json/csv 等）
 *   - pdf → md（有 workerHost.extractPdfStructured 时可用，基于版面启发式重建）
 */

const fs = require('fs')
const path = require('path')
const mammoth = require('mammoth')
const TurndownService = require('turndown')
const { gfm } = require('turndown-plugin-gfm')
const { REASON, WARN, fail, warn } = require('../provider')
const { escapeHtml } = require('../../utils')
const {
  MAX_ALL_PAGES,
  toBuffer,
  looksLike,
  outputName,
  uniqueDest,
  pageLimitWarning,
  workerError
} = require('./pdf-helpers')
const { pdfToMarkdown } = require('./pdf-to-markdown')

const PROVIDER_ID = 'builtin-document'
const PROVIDER_NAME = '内置文档转换'
const ASSETS_PLACEHOLDER = '__STICKY_ASSETS_DIR__'

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

const CONTENT_TYPE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/x-emf': 'emf',
  'image/x-wmf': 'wmf'
}

let markedCache = null
async function getMarked () {
  if (!markedCache) {
    const mod = await import('marked')
    markedCache = mod.marked || mod.default || mod
  }
  return markedCache
}

function hasZipMagic (buf) {
  if (!buf || buf.length < ZIP_MAGIC.length) return false
  for (let i = 0; i < ZIP_MAGIC.length; i++) {
    if (buf[i] !== ZIP_MAGIC[i]) return false
  }
  return true
}

function createTurndown () {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-'
  })
  td.use(gfm)
  td.remove(['script', 'style'])
  return td
}

function wrapHtmlDocument (bodyHtml, title) {
  const safeTitle = escapeHtml(title || '文档')
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    `<title>${safeTitle}</title>`,
    '<style>',
    'body{max-width:860px;margin:32px auto;padding:0 24px;color:#1f2328;font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;font-size:15px;line-height:1.7;}',
    'h1,h2,h3,h4{margin:1.3em 0 .5em;line-height:1.3;font-weight:600;}',
    'p,ul,ol,blockquote,table,pre{margin:0 0 1em;}',
    'blockquote{border-left:4px solid #d0d7de;padding:2px 14px;color:#57606a;}',
    'code{font-family:Consolas,"Courier New",monospace;background:#f6f8fa;padding:2px 5px;border-radius:4px;font-size:.9em;}',
    'pre{background:#f6f8fa;padding:12px 14px;border-radius:6px;overflow-x:auto;}',
    'pre code{background:none;padding:0;}',
    'table{border-collapse:collapse;width:100%;}',
    'th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;}',
    'th{background:#f6f8fa;font-weight:600;}',
    'img{max-width:100%;height:auto;}',
    '</style>',
    '</head>',
    '<body>',
    String(bodyHtml || ''),
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

function decodeHtmlEntities (text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _m
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _m
    })
}

function htmlToText (rawHtml) {
  let s = String(rawHtml || '')
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<(?:hr)\s*\/?>/gi, '\n')
  s = s.replace(/<\/(?:t[dh])>/gi, '\t')
  s = s.replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|section|article|header|footer)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeHtmlEntities(s)
  return s
    .split(/\r?\n/)
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n'
}

function readText (readFile, src) {
  const raw = readFile(src)
  if (typeof raw === 'string') return raw
  const buf = toBuffer(raw)
  return buf ? buf.toString('utf8') : ''
}

function imageExtFromContentType (ct) {
  const key = String(ct || '').toLowerCase().split(';')[0].trim()
  if (CONTENT_TYPE_EXT[key]) return CONTENT_TYPE_EXT[key]
  const part = key.split('/')[1]
  return part ? part.replace(/[^\w]/g, '') || 'png' : 'png'
}

/**
 * 创建内置文档 provider。
 *
 * @param {object} [deps]
 * @param {object} [deps.workerHost]
 * @param {function} [deps.readFile]
 * @param {function} [deps.writeFile]
 * @returns {object} provider
 */
function createDocumentProvider (deps = {}) {
  const ctx = deps || {}
  const host = ctx.workerHost || null
  const readFile = typeof ctx.readFile === 'function' ? ctx.readFile : fs.readFileSync
  const writeFile = typeof ctx.writeFile === 'function' ? ctx.writeFile : fs.writeFileSync

  const hasRenderPdf = !!(host && typeof host.renderHtmlToPdf === 'function')
  const hasPdfStructured = !!(host && typeof host.extractPdfStructured === 'function')

  function targetsForExt (ext) {
    switch (ext) {
      case 'docx':
        return hasRenderPdf ? ['md', 'html', 'txt', 'pdf'] : ['md', 'html', 'txt']
      case 'html':
      case 'htm':
        return hasRenderPdf ? ['md', 'txt', 'pdf'] : ['md', 'txt']
      case 'md':
        return hasRenderPdf ? ['html', 'pdf'] : ['html']
      case 'pdf':
        return hasPdfStructured ? ['md'] : []
      default:
        return []
    }
  }

  async function canHandle (ext, target) {
    const e = String(ext || '').toLowerCase()
    const allowed = targetsForExt(e)
    if (!allowed.length) return false
    if (target == null) return true
    return allowed.includes(String(target || '').toLowerCase())
  }

  async function capabilities (ext) {
    const e = String(ext || '').toLowerCase()
    if (e === 'pdf') {
      if (!hasPdfStructured) {
        return fail(REASON.NOT_INSTALLED, '转换工作器不可用，无法转换 PDF 到 Markdown')
      }
      return {
        ok: true,
        reason: REASON.OK,
        targets: ['md'],
        withEngines: [],
        displayName: 'PDF 文档',
        error: null
      }
    }
    const targets = targetsForExt(e)
    if (!targets.length) {
      return fail(REASON.USAGE, '文档转换不支持的源格式：' + (e || '未知'))
    }
    const names = { docx: 'Word 文档', html: 'HTML 网页', htm: 'HTML 网页', md: 'Markdown' }
    return {
      ok: true,
      reason: REASON.OK,
      targets,
      withEngines: [],
      displayName: names[e] || '文档',
      error: null
    }
  }

  async function renderPdfFromHtml (html) {
    if (!hasRenderPdf) {
      return { ok: false, error: '转换工作器不可用，无法将文档导出为 PDF' }
    }
    const res = await host.renderHtmlToPdf(html)
    if (!res || !res.ok) {
      return { ok: false, error: (res && res.error) || 'HTML 转 PDF 失败' }
    }
    const buf = toBuffer(res.bytes)
    if (!buf || !buf.length || !looksLike(buf, 'pdf')) {
      return { ok: false, error: 'HTML 转 PDF 产物无效（缺少 %PDF- 文件头）' }
    }
    return { ok: true, buf }
  }

  async function convertDocx (src, target, outDir, usedDest) {
    const rawBuf = toBuffer(readFile(src))
    if (!rawBuf || !rawBuf.length) throw new Error('DOCX 文件为空或读不到')
    if (!hasZipMagic(rawBuf)) {
      throw new Error('不是有效的 DOCX 文件（缺少 ZIP 文件头）')
    }

    const stem = path.basename(src, path.extname(src)) || 'document'
    const wanted = path.join(String(outDir || ''), outputName(src, target))
    const dest = uniqueDest(wanted, usedDest)

    if (target === 'txt') {
      const r = await mammoth.extractRawText({ buffer: rawBuf })
      const text = String((r && r.value) || '')
      writeFile(dest, Buffer.from(text, 'utf8'))
      usedDest.add(String(dest).toLowerCase())
      return { source: src, output: dest }
    }

    if (target === 'html') {
      const r = await mammoth.convertToHtml({ buffer: rawBuf })
      const html = wrapHtmlDocument(r && r.value, stem)
      writeFile(dest, Buffer.from(html, 'utf8'))
      usedDest.add(String(dest).toLowerCase())
      return { source: src, output: dest }
    }

    if (target === 'pdf') {
      const r = await mammoth.convertToHtml({ buffer: rawBuf })
      const html = wrapHtmlDocument(r && r.value, stem)
      const pdf = await renderPdfFromHtml(html)
      if (!pdf.ok) throw new Error(pdf.error)
      writeFile(dest, pdf.buf)
      usedDest.add(String(dest).toLowerCase())
      return { source: src, output: dest }
    }

    if (target === 'md') {
      let imgCount = 0
      let assetsDir = ''
      const makeAssetsDir = () => {
        if (!assetsDir) {
          assetsDir = path.join(
            String(outDir || ''),
            stem.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 40) +
              '-assets-' + Math.random().toString(36).slice(2, 8)
          )
          fs.mkdirSync(assetsDir, { recursive: true })
        }
        return assetsDir
      }

      try {
        const r = await mammoth.convertToHtml(
          { buffer: rawBuf },
          {
            convertImage: mammoth.images.imgElement(async (element) => {
              const imgBuf = await element.readAsBuffer()
              const ext = imageExtFromContentType(element.contentType)
              imgCount += 1
              const fileName = `image-${imgCount}.${ext}`
              const dir = makeAssetsDir()
              writeFile(path.join(dir, fileName), imgBuf)
              return { src: `${ASSETS_PLACEHOLDER}/${fileName}` }
            })
          }
        )
        const td = createTurndown()
        const md = td.turndown(String((r && r.value) || '')).trim() + '\n'
        writeFile(dest, Buffer.from(md, 'utf8'))
        usedDest.add(String(dest).toLowerCase())
        const out = { source: src, output: dest }
        if (imgCount > 0 && assetsDir) {
          out.assetsDir = assetsDir
          out.assetsPlaceholder = ASSETS_PLACEHOLDER
        }
        return out
      } catch (err) {
        if (assetsDir) {
          try { fs.rmSync(assetsDir, { recursive: true, force: true }) } catch (_) {}
        }
        throw err
      }
    }

    throw new Error('DOCX 不支持目标格式：' + target)
  }

  async function convertHtml (src, target, outDir, usedDest) {
    const rawHtml = readText(readFile, src)
    const wanted = path.join(String(outDir || ''), outputName(src, target))
    const dest = uniqueDest(wanted, usedDest)

    if (target === 'md') {
      const td = createTurndown()
      const md = td.turndown(rawHtml).trim() + '\n'
      writeFile(dest, Buffer.from(md, 'utf8'))
      usedDest.add(String(dest).toLowerCase())
      return { source: src, output: dest }
    }
    if (target === 'txt') {
      const text = htmlToText(rawHtml)
      writeFile(dest, Buffer.from(text, 'utf8'))
      usedDest.add(String(dest).toLowerCase())
      return { source: src, output: dest }
    }
    if (target === 'pdf') {
      const pdf = await renderPdfFromHtml(rawHtml)
      if (!pdf.ok) throw new Error(pdf.error)
      writeFile(dest, pdf.buf)
      usedDest.add(String(dest).toLowerCase())
      return { source: src, output: dest }
    }
    throw new Error('HTML 不支持目标格式：' + target)
  }

  async function convertMd (src, target, outDir, usedDest) {
    const rawMd = readText(readFile, src)
    const stem = path.basename(src, path.extname(src)) || 'document'
    const marked = await getMarked()
    const bodyHtml = await marked.parse(rawMd, { gfm: true })
    const docHtml = wrapHtmlDocument(bodyHtml, stem)
    const wanted = path.join(String(outDir || ''), outputName(src, target))
    const dest = uniqueDest(wanted, usedDest)

    if (target === 'html') {
      writeFile(dest, Buffer.from(docHtml, 'utf8'))
      usedDest.add(String(dest).toLowerCase())
      return { source: src, output: dest }
    }
    if (target === 'pdf') {
      const pdf = await renderPdfFromHtml(docHtml)
      if (!pdf.ok) throw new Error(pdf.error)
      writeFile(dest, pdf.buf)
      usedDest.add(String(dest).toLowerCase())
      return { source: src, output: dest }
    }
    throw new Error('Markdown 不支持目标格式：' + target)
  }

  async function convertPdfToMd (src, outDir, usedDest, opts, globalWarnings) {
    if (!hasPdfStructured) {
      throw new Error('转换工作器不可用，无法转换 PDF 到 Markdown')
    }
    const bytes = toBuffer(readFile(src))
    if (!bytes || !bytes.length) throw new Error('源文件为空或读不到')
    if (!looksLike(bytes, 'pdf')) {
      throw new Error('不是有效的 PDF 文件（缺少 %PDF- 魔数，可能已损坏或改错后缀）')
    }

    const allPages = !!(opts && opts.allPages)
    const onProgress = (opts && typeof opts.onProgress === 'function') ? opts.onProgress : null
    if (allPages && onProgress) {
      try {
        onProgress({ source: src, phase: 'text', page: null, total: null, done: 0, failed: 0 })
      } catch (_) {}
    }

    const payload = await host.extractPdfStructured(
      bytes,
      allPages ? { allPages: true, maxPages: MAX_ALL_PAGES } : {}
    )
    if (!payload || !payload.ok) {
      throw new Error(workerError(payload))
    }

    const mdRes = pdfToMarkdown(payload.pages || [])
    const wanted = path.join(String(outDir || ''), outputName(src, 'md'))
    const dest = uniqueDest(wanted, usedDest)
    writeFile(dest, Buffer.from(mdRes.markdown, 'utf8'))
    usedDest.add(String(dest).toLowerCase())

    const warnings = []
    const numPages = Number(payload.numPages) || 0
    const converted = Number(payload.pagesConverted) || (allPages ? numPages : 1)
    if (!allPages && numPages > 1) {
      warnings.push(warn(WARN.PDF_MULTIPAGE, 'PDF 共 ' + numPages + ' 页，仅转换了第 1 页'))
    }
    if (allPages && converted < numPages) {
      const lw = pageLimitWarning(numPages)
      warnings.push(lw)
      globalWarnings.push(lw)
    }
    if (mdRes.isEmpty) {
      warnings.push(warn(
        WARN.PDF_NO_TEXT_LAYER,
        'PDF 未检测到可提取的文本层（可能是扫描件），Markdown 结果为空'
      ))
    }

    const out = { source: src, output: dest }
    if (warnings.length) out.warnings = warnings
    return out
  }

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,

    async available () {
      return true
    },

    canHandle,
    capabilities,

    async convert (files, target, outDir, opts = {}) {
      const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
      if (!list.length) return fail(REASON.USAGE, '没有待转换的文件')

      const t = String(target || '').toLowerCase()
      if (!t) return fail(REASON.USAGE, '未指定目标格式')

      const outputs = []
      const failures = []
      const usedDest = new Set()
      const globalWarnings = []

      for (const src of list) {
        const srcExt = path.extname(String(src || '')).replace(/^\./, '').toLowerCase()
        if (!(await canHandle(srcExt, t))) {
          failures.push({
            source: src,
            state: 'failed',
            outputs: [],
            error: '不支持的转换组合：' + (srcExt || '未知') + ' → ' + t
          })
          continue
        }
        try {
          let out
          if (srcExt === 'docx') out = await convertDocx(src, t, outDir, usedDest)
          else if (srcExt === 'html' || srcExt === 'htm') out = await convertHtml(src, t, outDir, usedDest)
          else if (srcExt === 'md') out = await convertMd(src, t, outDir, usedDest)
          else if (srcExt === 'pdf' && t === 'md') out = await convertPdfToMd(src, outDir, usedDest, opts, globalWarnings)
          if (out) outputs.push(out)
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
        const res = Object.assign(
          fail(REASON.FAILED, failures[0] ? failures[0].error : '文档转换失败'),
          { failures }
        )
        if (globalWarnings.length) res.warnings = globalWarnings
        return res
      }

      const res = {
        ok: true,
        reason: REASON.OK,
        outputs,
        failures,
        files: [],
        error: null
      }
      if (globalWarnings.length) res.warnings = globalWarnings
      return res
    }
  }
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_NAME,
  ASSETS_PLACEHOLDER,
  createDocumentProvider,
  htmlToText,
  wrapHtmlDocument,
  hasZipMagic
}
