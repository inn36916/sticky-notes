'use strict'

/**
 * 内置 PDF provider 的共享常量、魔数校验与纯辅助函数。
 */

const fs = require('fs')
const path = require('path')
const { WARN, warn } = require('../provider')
const { SAFE_NAME } = require('../../utils')

/** 唯一 provider id（日志/测试/引擎清单都认它） */
const PROVIDER_ID = 'builtin-pdf'
const PROVIDER_NAME = '内置 PDF 转换'

/**
 * 能作为图片→PDF 源的扩展名（png/jpg 走原始字节直嵌；webp/gif 走 worker 转码 PNG）。
 */
const SOURCE_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

/** 需要经 worker canvas 转码的源格式（pdf-lib 吃不下） */
const TRANSCODE_EXTS = ['webp', 'gif']

/** 转码源扩展名 → 传给 worker 的 mime */
const TRANSCODE_MIME = {
  webp: 'image/webp',
  gif: 'image/gif'
}

/** PDF 源能转出的位图目标格式（能力清单与 canHandle 唯一事实来源） */
const IMAGE_TARGETS = ['png', 'jpg', 'webp']

/** capabilities('pdf') 对外展示的目标 */
const PDF_TARGETS = IMAGE_TARGETS.concat(['txt'])

/** 「全部页」模式最多转换页数（防止超大 PDF 撑爆渲染进程画布与内存） */
const MAX_ALL_PAGES = 50

/** canHandle 额外接受 jpeg（jpg 别名），但不出现在能力清单里避免 UI 重复 */
const TARGET_ALIASES = ['jpeg']

/** 目标扩展名 → worker encode 用的 mime */
const TARGET_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

/** 各格式文件头魔数表 */
const MAGIC = {
  png: [{ off: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }],
  jpg: [{ off: 0, bytes: [0xff, 0xd8, 0xff] }],
  jpeg: [{ off: 0, bytes: [0xff, 0xd8, 0xff] }],
  pdf: [{ off: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }], // %PDF-
  webp: [{ off: 0, bytes: 'RIFF' }, { off: 8, bytes: 'WEBP' }],
  gif: [{ off: 0, bytes: ['GIF87a', 'GIF89a'] }]
}

/**
 * 把任意字节形态转成 Buffer（IPC 可能回 Buffer / Uint8Array / 普通数组）。
 * @param {Buffer|Uint8Array|number[]} bytes
 * @returns {Buffer|null}
 */
function toBuffer (bytes) {
  if (!bytes) return null
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  if (Array.isArray(bytes)) return Buffer.from(bytes)
  return null
}

/**
 * 判断一段字节在指定偏移处是否命中给定魔数。
 * @param {Buffer} buf
 * @param {number} off
 * @param {number[]|string|string[]} bytes
 * @returns {boolean}
 */
function magicHitAt (buf, off, bytes) {
  if (Array.isArray(bytes) && bytes.length && typeof bytes[0] === 'string') {
    const s = buf.slice(off, off + bytes[0].length).toString('ascii')
    return bytes.some(b => s === b)
  }
  const arr = typeof bytes === 'string'
    ? Array.from(bytes).map(c => c.charCodeAt(0))
    : bytes
  if (!arr || buf.length < off + arr.length) return false
  for (let i = 0; i < arr.length; i++) {
    if (buf[off + i] !== arr[i]) return false
  }
  return true
}

/**
 * 校验字节是不是声明的格式（防伪扩展名或静默回退假成功）。
 * @param {Buffer|Uint8Array|number[]} bytes
 * @param {string} ext
 * @returns {boolean}
 */
function looksLike (bytes, ext) {
  const buf = toBuffer(bytes)
  if (!buf || !buf.length) return false
  const t = String(ext || '').toLowerCase()
  const spec = MAGIC[t]
  if (!spec) return false
  return spec.every(item => magicHitAt(buf, item.off, item.bytes))
}

/**
 * 产物文件名（剥掉源文件扩展名，避免双扩展名）。
 * @param {string} src
 * @param {string} target
 * @returns {string}
 */
function outputName (src, target) {
  const base = path.basename(String(src || ''))
  const stem = base.replace(/\.[^.]+$/, '') || 'file'
  const safe = stem.replace(SAFE_NAME, '_').slice(0, 60) || 'file'
  return safe + '.' + String(target || '').toLowerCase()
}

/**
 * 保证产物路径唯一（批内 + 磁盘），避免同名源文件互相覆盖。
 * @param {string} dest
 * @param {Set<string>} used
 * @returns {string}
 */
function uniqueDest (dest, used) {
  const key = (p) => String(p).toLowerCase()
  const taken = (p) => used.has(key(p)) || fs.existsSync(p)
  if (!taken(dest)) return dest
  const ext = path.extname(dest)
  const base = dest.slice(0, dest.length - ext.length)
  for (let i = 2; i < 1000; i++) {
    const cand = base + '-' + i + ext
    if (!taken(cand)) return cand
  }
  return base + '-' + Math.random().toString(36).slice(2, 8) + ext
}

/**
 * 多页产物的伪源路径：`a.pdf` 第 2 页 → `a-2.pdf`。
 * @param {string} src
 * @param {number} page
 * @returns {string}
 */
function pageSource (src, page) {
  const s = String(src || '')
  const base = path.basename(s)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  return path.join(path.dirname(s), stem + '-' + page + ext)
}

/**
 * 构造页数超限警告。
 * @param {number} numPages
 * @returns {{code:string, message:string}}
 */
function pageLimitWarning (numPages) {
  return warn(
    WARN.PDF_PAGE_LIMIT,
    'PDF 共 ' + numPages + ' 页，仅转换前 ' + MAX_ALL_PAGES + ' 页'
  )
}

/**
 * 将 worker 错误翻译为用户可读信息。
 * @param {object|string} r
 * @returns {string}
 */
function workerError (r) {
  if (r && typeof r === 'object') {
    if (r.encrypted) return 'PDF 已加密（需要密码），暂不支持转换'
    if (r.error) return String(r.error)
  }
  return String(r && r.message ? r.message : (r || 'PDF 处理失败'))
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
  TARGET_ALIASES,
  TARGET_MIME,
  MAGIC,
  toBuffer,
  magicHitAt,
  looksLike,
  outputName,
  uniqueDest,
  pageSource,
  pageLimitWarning,
  workerError
}
