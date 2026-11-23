'use strict'

/**
 * 内置文本/数据 provider：纯 JS 实现。
 *
 * 覆盖范围（结构化数据 ↔ 结构化数据 + 文本包装）：
 *   json ↔ csv ↔ xml ↔ yaml ↔ toml ↔ md（Markdown 表格）
 *
 * 设计取舍：
 *   - YAML 使用 `js-yaml`（YAML 1.2 CORE_SCHEMA）、TOML 使用 `smol-toml`，
 *     完整支持嵌套对象、数组与多行文本；
 *   - Markdown 在本 provider 内仍只做「表格 ↔ 结构化数据」，通用文档转换由
 *     `builtin-document`（document.js）负责。
 *
 * 边界说明（用户会遇到的）：
 *   - json → csv 只支持「对象数组」或「数组的数组」；标量数组会被拒绝。
 *   - csv → json 会把每行读成对象（首行为表头）。
 */

const path = require('path')
const fs = require('fs')
const yaml = require('js-yaml')
const smolToml = require('smol-toml')
const { REASON, fail } = require('../provider')

/** 本 provider 认识的扩展名 */
const EXTS = ['json', 'csv', 'xml', 'yaml', 'yml', 'toml', 'md', 'txt']

/** 目标扩展名 */
const TARGET_EXTS = EXTS.slice()

/**
 * 创建文本/数据 provider。
 * @returns {object} provider
 */
function createTextDataProvider () {
  return {
    id: 'builtin-text-data',
    name: '内置文本与数据转换',

    async available () {
      return true
    },

    async canHandle (ext, target) {
      const e = String(ext || '').toLowerCase()
      if (!EXTS.includes(e)) return false
      if (target == null) return true
      return TARGET_EXTS.includes(String(target || '').toLowerCase())
    },

    async capabilities (ext) {
      const e = String(ext || '').toLowerCase()
      if (!EXTS.includes(e)) {
        return fail(REASON.USAGE, '不支持的源格式：' + e)
      }
      return {
        ok: true,
        reason: REASON.OK,
        targets: TARGET_EXTS.filter(t => t !== 'txt' || e === 'txt'),
        withEngines: [],
        displayName: '文本与数据',
        error: null
      }
    },

    async convert (files, target, outDir) {
      const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
      if (!list.length) return fail(REASON.USAGE, '没有待转换的文件')

      const t = String(target || '').toLowerCase()
      if (!TARGET_EXTS.includes(t)) {
        return fail(REASON.USAGE, '内置文本转换不支持目标格式：' + t)
      }

      const outputs = []
      const failures = []

      for (const src of list) {
        try {
          const raw = fs.readFileSync(src, 'utf8')
          const srcExt = path.extname(src).replace(/^\./, '').toLowerCase()
          const value = parseByExt(raw, srcExt)
          const out = serializeByExt(value, t)
          const dest = path.join(outDir, outputName(src, t))
          fs.writeFileSync(dest, out, 'utf8')
          outputs.push({ source: src, output: dest })
        } catch (err) {
          failures.push({
            source: src,
            state: 'failed',
            outputs: [],
            error: err && err.message ? err.message : String(err)
          })
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

// ---------------------------------------------------------------- 解析

/**
 * 按扩展名解析文本。
 * @param {string} raw
 * @param {string} ext
 * @returns {any}
 */
function parseByExt (raw, ext) {
  switch (ext) {
    case 'json': return JSON.parse(raw)
    case 'csv': return parseCsv(raw)
    case 'xml': return parseXml(raw)
    case 'yaml':
    case 'yml': return parseYaml(raw)
    case 'toml': return parseToml(raw)
    case 'md': return parseMarkdownTable(raw)
    case 'txt': return raw
    default: throw new Error('不支持的源格式：' + ext)
  }
}

/**
 * 按扩展名序列化。
 * @param {any} value
 * @param {string} ext
 * @returns {string}
 */
function serializeByExt (value, ext) {
  switch (ext) {
    case 'json': return JSON.stringify(value, null, 2) + '\n'
    case 'csv': return toCsv(value)
    case 'xml': return toXml(value)
    case 'yaml':
    case 'yml': return toYaml(value)
    case 'toml': return toToml(value)
    case 'md': return toMarkdownTable(value)
    case 'txt': return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    default: throw new Error('不支持的目标格式：' + ext)
  }
}

// ---------------------------------------------------------------- CSV

/**
 * 解析 CSV（支持双引号包裹、转义双引号、字段内换行）。
 * @param {string} raw
 * @returns {Array<object>|Array<Array<string>>}
 */
function parseCsv (raw) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const s = String(raw || '')

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\r') continue
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += ch
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }

  if (!rows.length) return []

  const header = rows[0].map(h => h.trim())
  const body = rows.slice(1).filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))

  // 只有一列且没有表头语义 → 当作数组的数组
  if (header.length === 1) {
    return body.map(r => r[0])
  }
  return body.map(r => {
    const o = {}
    header.forEach((h, i) => { o[h] = r[i] == null ? '' : r[i] })
    return o
  })
}

/**
 * 序列化为 CSV。
 * @param {any} value
 * @returns {string}
 */
function toCsv (value) {
  const rows = normalizeRows(value)
  if (!rows.length) return ''
  const header = Object.keys(rows[0])
  const lines = [header.map(csvCell).join(',')]
  for (const r of rows) {
    lines.push(header.map(k => csvCell(r[k])).join(','))
  }
  return lines.join('\n') + '\n'
}

/** 把任意结构化成「对象数组」；失败则抛错（明确失败优于丢数据） */
function normalizeRows (value) {
  if (!Array.isArray(value)) throw new Error('转 CSV 需要数组或对象数组')
  if (!value.length) return []
  if (typeof value[0] === 'object' && value[0] !== null && !Array.isArray(value[0])) {
    // 对象数组：取所有键的并集
    const keys = []
    for (const row of value) {
      for (const k of Object.keys(row || {})) if (!keys.includes(k)) keys.push(k)
    }
    return value.map(row => {
      const o = {}
      for (const k of keys) o[k] = row && row[k] != null ? row[k] : ''
      return o
    })
  }
  // 标量数组 → 单列
  if (typeof value[0] !== 'object') {
    return value.map(v => ({ value: v }))
  }
  // 数组的数组 → 第一行当表头
  if (Array.isArray(value[0])) {
    const header = value[0].map((h, i) => String(h == null ? '' : h))
    return value.slice(1).map(row => {
      const o = {}
      header.forEach((h, i) => { o[h] = row[i] == null ? '' : row[i] })
      return o
    })
  }
  throw new Error('无法识别的数据结构')
}

/** CSV 字段转义 */
function csvCell (v) {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// ---------------------------------------------------------------- XML

/**
 * 极简 XML → JS 对象。
 *
 * 规则（够用即可，明确不支持的部分直接报错）：
 *   - 只支持元素、文本、属性（属性进 key，@ 前缀）
 *   - 重复同名子元素聚成数组
 *   - 不支持命名空间、DTD、CDATA 之外的高级特性
 */
function parseXml (raw) {
  const s = String(raw || '').trim()
  const m = s.match(/^<\?xml[^>]*\?>\s*/i)
  const body = m ? s.slice(m[0].length) : s

  const p = new XmlParser(body)
  const root = p.parseElement()
  if (!root) throw new Error('不是有效的 XML')
  p.skipRest()
  return xmlNodeToValue(root)
}

/**
 * 递归下降的 XML 解析器。
 *
 * 用一个游标 + 显式栈，比"找闭合标签位置"更不容易出错 ——
 * 后者在嵌套同名标签时会算错深度。
 */
class XmlParser {
  constructor (s) {
    this.s = String(s || '')
    this.i = 0
  }

  /** 跳过空白 */
  skipWs () {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++
  }

  /**
   * 解析一个元素。
   * @returns {{name:string, attrs:object, children:Array, text:string}|null}
   */
  parseElement () {
    this.skipWs()
    if (this.s[this.i] !== '<') return null

    // 自闭合标签 <a/>
    // ⚠️ String.match 不接受起始位置参数 ⇒ 必须先 slice 再匹配
    const rest = this.s.slice(this.i)
    const selfClose = rest.match(/^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/>/)
    if (selfClose) {
      this.i += selfClose[0].length
      return {
        name: selfClose[1],
        attrs: parseAttrs(selfClose[2] || ''),
        children: [],
        text: ''
      }
    }

    // 开标签 <a ...>
    const open = rest.match(/^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*>/)
    if (!open) return null
    this.i += open[0].length
    const name = open[1]
    const attrs = parseAttrs(open[2] || '')

    const children = []
    const textParts = []

    while (this.i < this.s.length) {
      // 闭合标签
      if (this.s.startsWith('</' + name, this.i)) {
        const close = this.s.indexOf('>', this.i)
        if (close < 0) throw new Error('XML 标签未闭合：' + name)
        this.i = close + 1
        break
      }
      // 注释
      if (this.s.startsWith('<!--', this.i)) {
        const e = this.s.indexOf('-->', this.i)
        this.i = e < 0 ? this.s.length : e + 3
        continue
      }
      // CDATA
      if (this.s.startsWith('<![CDATA[', this.i)) {
        const e = this.s.indexOf(']]>', this.i)
        textParts.push(this.s.slice(this.i + 9, e < 0 ? this.s.length : e))
        this.i = e < 0 ? this.s.length : e + 3
        continue
      }
      // 子元素
      if (this.s[this.i] === '<') {
        const child = this.parseElement()
        if (!child) {
          // 不是合法标签，当文本处理
          textParts.push(this.s[this.i])
          this.i++
          continue
        }
        children.push(child)
        continue
      }
      // 文本
      textParts.push(this.s[this.i])
      this.i++
    }

    return { name, attrs, children, text: textParts.join('').trim() }
  }

  /** 跳过剩余内容（检查有没有多余的闭合标签） */
  skipRest () {
    this.skipWs()
    if (this.i < this.s.length) {
      throw new Error('XML 结尾有多余内容：' + this.s.slice(this.i, this.i + 40))
    }
  }
}

/** 解析属性串 */
function parseAttrs (s) {
  const attrs = {}
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(s))) attrs[m[1]] = m[2] != null ? m[2] : m[3]
  return attrs
}

/** XML 节点 → JS 对象 */
function xmlNodeToValue (node) {
  const obj = {}
  for (const [k, v] of Object.entries(node.attrs || {})) obj['@' + k] = v

  const groups = {}
  for (const ch of node.children || []) {
    if (!groups[ch.name]) groups[ch.name] = []
    groups[ch.name].push(xmlNodeToValue(ch))
  }

  for (const [k, list] of Object.entries(groups)) {
    obj[k] = list.length === 1 ? list[0] : list
  }

  const text = node.text || ''
  if (text) {
    if (Object.keys(obj).length === 0) return text
    obj['#text'] = text
  }
  return obj
}

/**
 * JS 对象 → XML。
 * @param {any} value
 * @returns {string}
 */
function toXml (value) {
  if (value == null) return '<root/>'
  if (Array.isArray(value)) {
    return value.map((v, i) => toXml(v).replace(/^<(\w+)/, `<item${i >= 0 ? '' : ''}>`)).join('\n')
  }
  if (typeof value !== 'object') {
    return `<root>${escapeXml(String(value))}</root>`
  }
  const keys = Object.keys(value)
  const attrs = keys.filter(k => k.startsWith('@')).map(k => ` ${k.slice(1)}="${escapeXml(String(value[k]))}"`).join('')
  const bodyKeys = keys.filter(k => !k.startsWith('@') && k !== '#text')
  const text = value['#text'] != null ? escapeXml(String(value['#text'])) : ''

  if (!bodyKeys.length) {
    return `<root${attrs}>${text}</root>`
  }
  const inner = bodyKeys.map(k => {
    const v = value[k]
    if (Array.isArray(v)) {
      return v.map(item => `<${k}>${scalarToXmlInner(item)}</${k}>`).join('')
    }
    return `<${k}>${scalarToXmlInner(v)}</${k}>`
  }).join('')
  return `<root${attrs}>${text}${inner}</root>`
}

/** 值的 XML 内部表示 */
function scalarToXmlInner (v) {
  if (v == null) return ''
  if (typeof v === 'object') {
    if (Array.isArray(v)) return v.map(x => escapeXml(String(x))).join('')
    return toXml(v).replace(/^<root([^>]*)>/, '').replace(/<\/root>$/, '')
  }
  return escapeXml(String(v))
}

/** XML 转义 */
function escapeXml (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------- YAML

/**
 * 将解析或待序列化值规范化为纯 JS 结构（处理 null-prototype、Date、BigInt）。
 * @param {any} value
 * @returns {any}
 */
function toPlainData (value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : String(value)
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  }
  if (Array.isArray(value)) return value.map(toPlainData)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = toPlainData(v)
    }
    return out
  }
  return value
}

/**
 * 解析 YAML（基于 js-yaml CORE_SCHEMA，支持完整嵌套映射与数组）。
 * @param {string} raw
 * @returns {any}
 */
function parseYaml (raw) {
  const s = String(raw || '')
  if (!s.trim()) return {}
  try {
    const v = yaml.load(s, { schema: yaml.CORE_SCHEMA })
    return v === undefined ? {} : toPlainData(v)
  } catch (err) {
    if (err && err.reason === 'expected a document, but the input is empty') return {}
    throw err
  }
}

/**
 * JS 值 → YAML（使用 CORE_SCHEMA 避免将普通键名如 `n` 误引）。
 * @param {any} value
 * @returns {string}
 */
function toYaml (value) {
  if (value == null) return 'null\n'
  const out = yaml.dump(toPlainData(value), {
    noRefs: true,
    lineWidth: -1,
    schema: yaml.CORE_SCHEMA
  })
  return out.endsWith('\n') ? out : out + '\n'
}

// ---------------------------------------------------------------- TOML

/**
 * TOML 没有 null 类型：递归把 null/undefined 归一化为空串，保持既有语义。
 * @param {any} value
 * @returns {any}
 */
function sanitizeTomlValue (value) {
  if (value == null) return ''
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : String(value)
  }
  if (value instanceof Date) return value
  if (Array.isArray(value)) return value.map(sanitizeTomlValue)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeTomlValue(v)
    }
    return out
  }
  return value
}

/**
 * 解析 TOML（基于 smol-toml，支持嵌套表、数组表、内联表、多行字符串与日期）。
 * @param {string} raw
 * @returns {object}
 */
function parseToml (raw) {
  const parsed = smolToml.parse(String(raw || ''))
  return toPlainData(parsed)
}

/**
 * JS 对象 → TOML。
 * @param {any} value
 * @returns {string}
 */
function toToml (value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('转 TOML 需要对象结构')
  }
  const out = smolToml.stringify(sanitizeTomlValue(value))
  return out.endsWith('\n') ? out : out + '\n'
}

/** 保留导出（供已有单测与内联切分复用） */
function splitTopLevel (s) {
  const out = []
  let depth = 0
  let quote = null
  let cur = ''
  for (const ch of String(s)) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '[' || ch === '{') depth++
    if (ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

// ---------------------------------------------------------------- Markdown 表格

/**
 * Markdown 表格 → 对象数组（只取第一个表格）。
 */
function parseMarkdownTable (raw) {
  const lines = String(raw || '').split(/\r?\n/)
  const rows = []
  let header = null
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('|')) {
      if (header) break
      continue
    }
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    if (header === null) {
      header = cells
      continue
    }
    // 跳过分隔行 |---|---|
    if (cells.every(c => /^:?-{1,}:?$/.test(c))) continue
    rows.push(cells)
  }
  if (!header) throw new Error('未找到 Markdown 表格')
  return rows.map(cells => {
    const o = {}
    header.forEach((h, i) => { o[h] = cells[i] == null ? '' : cells[i] })
    return o
  })
}

/** 对象数组 → Markdown 表格 */
function toMarkdownTable (value) {
  const rows = normalizeRows(value)
  if (!rows.length) return ''
  const header = Object.keys(rows[0])
  const lines = ['| ' + header.join(' | ') + ' |']
  lines.push('| ' + header.map(() => '---').join(' | ') + ' |')
  for (const r of rows) {
    lines.push('| ' + header.map(k => String(r[k] == null ? '' : r[k]).replace(/\|/g, '\\|')).join(' | ') + ' |')
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------- 工具

/** 产物文件名 */
function outputName (src, ext) {
  const base = path.basename(String(src || ''), path.extname(String(src || '')))
  const safe = base.replace(/[^\w.\-一-龥 ()]+/g, '_').slice(0, 60) || 'data'
  const sfx = Math.random().toString(36).slice(2, 8)
  return `${safe}-${sfx}.${ext}`
}

module.exports = {
  EXTS,
  TARGET_EXTS,
  createTextDataProvider,
  parseCsv,
  toCsv,
  normalizeRows,
  csvCell,
  parseXml,
  toXml,
  parseYaml,
  toYaml,
  parseToml,
  toToml,
  parseMarkdownTable,
  toMarkdownTable,
  splitTopLevel
}
