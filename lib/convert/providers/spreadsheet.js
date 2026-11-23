'use strict'

/**
 * 内置表格 provider（基于 exceljs，纯 JS）：
 *   - xlsx → csv / json / md
 *   - csv / json / md → xlsx
 *
 * 与 builtin-text-data 的边界：
 *   - 精确只在 canHandle 里声明上述双向组合，绝不截胡 csv ↔ json ↔ md。
 */

const fs = require('fs')
const path = require('path')
const ExcelJS = require('exceljs')
const { REASON, WARN, fail, warn } = require('../provider')
const {
  parseCsv,
  parseMarkdownTable,
  normalizeRows,
  csvCell
} = require('./text-data')
const { toBuffer, outputName, uniqueDest } = require('./pdf-helpers')

const PROVIDER_ID = 'builtin-spreadsheet'
const PROVIDER_NAME = '内置表格转换'

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const XLSX_TARGETS = ['csv', 'json', 'md']
const TABLE_SOURCES = ['csv', 'json', 'md']

function hasZipMagic (buf) {
  if (!buf || buf.length < ZIP_MAGIC.length) return false
  for (let i = 0; i < ZIP_MAGIC.length; i++) {
    if (buf[i] !== ZIP_MAGIC[i]) return false
  }
  return true
}

function readText (readFile, src) {
  const raw = readFile(src)
  if (typeof raw === 'string') return raw
  const buf = toBuffer(raw)
  return buf ? buf.toString('utf8') : ''
}

/**
 * 将 exceljs 的单元格值规范化为标量（处理富文本、超链接、公式结果、日期、错误）。
 * @param {any} v
 * @returns {string|number|boolean}
 */
function cellValueToScalar (v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return ''
    const iso = v.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) {
      return v.richText.map(part => (part && part.text != null ? String(part.text) : '')).join('')
    }
    if ('result' in v) {
      return v.result !== undefined ? cellValueToScalar(v.result) : ''
    }
    if ('hyperlink' in v) {
      if (v.text != null) return cellValueToScalar(v.text)
      return String(v.hyperlink || '')
    }
    if ('error' in v) {
      return String(v.error || '')
    }
    if (v.text != null) return String(v.text)
    return JSON.stringify(v)
  }
  return String(v)
}

/**
 * 从工作簿提取第一个非空工作表的二维标量行。
 * @param {object} wb ExcelJS.Workbook
 * @returns {{sheet:object, rows:Array<Array>, totalSheets:number}|null}
 */
function pickFirstNonEmptySheet (wb) {
  const sheets = (wb && Array.isArray(wb.worksheets)) ? wb.worksheets : []
  for (const ws of sheets) {
    const rawRows = []
    let maxCol = 0
    ws.eachRow({ includeEmpty: false }, (row) => {
      const colCount = Math.max(Number(ws.actualColumnCount) || 0, Number(row.cellCount) || 0)
      if (colCount > maxCol) maxCol = colCount
      const vals = []
      let hasNonEmpty = false
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c)
        // 对于合并单元格非主格，exceljs 返回主格值；保留值以便结构对齐
        const scalar = cellValueToScalar(cell ? cell.value : '')
        if (scalar !== '') hasNonEmpty = true
        vals.push(scalar)
      }
      if (hasNonEmpty) rawRows.push(vals)
    })
    if (rawRows.length && maxCol > 0) {
      const rows = rawRows.map(r => {
        if (r.length >= maxCol) return r.slice(0, maxCol)
        return r.concat(new Array(maxCol - r.length).fill(''))
      })
      return { sheet: ws, rows, totalSheets: sheets.length }
    }
  }
  return null
}

/**
 * 将表头行去重并补齐空表头，返回等长列名数组。
 * @param {Array} headerRow
 * @returns {string[]}
 */
function uniqueHeaders (headerRow) {
  const seen = new Set()
  return headerRow.map((cell, idx) => {
    const base = String(cell == null ? '' : cell).trim() || ('col_' + (idx + 1))
    let name = base
    let n = 2
    while (seen.has(name)) {
      name = base + '_' + n
      n++
    }
    seen.add(name)
    return name
  })
}

/**
 * 创建内置表格 provider。
 *
 * @param {object} [deps]
 * @param {function} [deps.readFile]
 * @param {function} [deps.writeFile]
 * @returns {object} provider
 */
function createSpreadsheetProvider (deps = {}) {
  const ctx = deps || {}
  const readFile = typeof ctx.readFile === 'function' ? ctx.readFile : fs.readFileSync
  const writeFile = typeof ctx.writeFile === 'function' ? ctx.writeFile : fs.writeFileSync

  async function canHandle (ext, target) {
    const e = String(ext || '').toLowerCase()
    if (e === 'xlsx') {
      return target == null ? true : XLSX_TARGETS.includes(String(target || '').toLowerCase())
    }
    if (TABLE_SOURCES.includes(e)) {
      return target == null ? true : String(target || '').toLowerCase() === 'xlsx'
    }
    return false
  }

  async function capabilities (ext) {
    const e = String(ext || '').toLowerCase()
    if (e === 'xlsx') {
      return {
        ok: true,
        reason: REASON.OK,
        targets: XLSX_TARGETS.slice(),
        withEngines: [],
        displayName: 'Excel 表格',
        error: null
      }
    }
    if (TABLE_SOURCES.includes(e)) {
      return {
        ok: true,
        reason: REASON.OK,
        targets: ['xlsx'],
        withEngines: [],
        displayName: '表格数据',
        error: null
      }
    }
    return fail(REASON.USAGE, '表格转换不支持的源格式：' + (e || '未知'))
  }

  async function convertFromXlsx (src, target, outDir, usedDest) {
    const rawBuf = toBuffer(readFile(src))
    if (!rawBuf || !rawBuf.length) throw new Error('XLSX 文件为空或读不到')
    if (!hasZipMagic(rawBuf)) {
      throw new Error('不是有效的 XLSX 文件（缺少 ZIP 文件头）')
    }

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(rawBuf)
    const picked = pickFirstNonEmptySheet(wb)
    if (!picked) {
      throw new Error('工作簿中没有可转换的非空工作表')
    }

    const { sheet, rows, totalSheets } = picked
    let content = ''
    if (target === 'csv') {
      content = rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n'
    } else if (target === 'json') {
      const headers = uniqueHeaders(rows[0])
      const objs = rows.slice(1).map(r => {
        const o = {}
        headers.forEach((h, i) => { o[h] = r[i] == null ? '' : r[i] })
        return o
      })
      content = JSON.stringify(objs, null, 2) + '\n'
    } else if (target === 'md') {
      const headers = uniqueHeaders(rows[0])
      const mdCell = v => String(v == null ? '' : v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
      const lines = [
        '| ' + headers.map(mdCell).join(' | ') + ' |',
        '| ' + headers.map(() => '---').join(' | ') + ' |'
      ]
      for (const r of rows.slice(1)) {
        lines.push('| ' + headers.map((_, i) => mdCell(r[i])).join(' | ') + ' |')
      }
      content = lines.join('\n') + '\n'
    } else {
      throw new Error('XLSX 不支持目标格式：' + target)
    }

    const wanted = path.join(String(outDir || ''), outputName(src, target))
    const dest = uniqueDest(wanted, usedDest)
    writeFile(dest, Buffer.from(content, 'utf8'))
    usedDest.add(String(dest).toLowerCase())

    const out = { source: src, output: dest }
    if (totalSheets > 1) {
      out.warnings = [warn(
        WARN.XLSX_MULTISHEET,
        '工作簿共 ' + totalSheets + ' 个工作表，仅转换了「' + sheet.name + '」'
      )]
    }
    return out
  }

  async function convertToXlsx (src, srcExt, outDir, usedDest) {
    const raw = readText(readFile, src)
    let parsed
    if (srcExt === 'csv') parsed = parseCsv(raw)
    else if (srcExt === 'json') parsed = JSON.parse(raw)
    else if (srcExt === 'md') parsed = parseMarkdownTable(raw)
    else throw new Error('不支持转 XLSX 的源格式：' + srcExt)

    const rows = normalizeRows(parsed)
    if (!rows.length) {
      throw new Error('没有可写入 Excel 的表格数据行')
    }

    const headers = Object.keys(rows[0])
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    const headerRow = ws.addRow(headers)
    headerRow.font = { bold: true }

    const widths = headers.map(h => String(h).length)
    for (const r of rows) {
      const vals = headers.map((h, i) => {
        const v = r[h]
        const len = String(v == null ? '' : v).length
        if (len > widths[i]) widths[i] = len
        return v == null ? '' : v
      })
      ws.addRow(vals)
    }

    ws.columns = headers.map((_h, i) => ({
      width: Math.min(40, Math.max(10, widths[i] + 2))
    }))

    const buf = toBuffer(await wb.xlsx.writeBuffer())
    if (!buf || !hasZipMagic(buf)) {
      throw new Error('生成的 XLSX 产物无效（缺少 ZIP 文件头）')
    }

    const wanted = path.join(String(outDir || ''), outputName(src, 'xlsx'))
    const dest = uniqueDest(wanted, usedDest)
    writeFile(dest, buf)
    usedDest.add(String(dest).toLowerCase())
    return { source: src, output: dest }
  }

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,

    async available () {
      return true
    },

    canHandle,
    capabilities,

    async convert (files, target, outDir) {
      const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
      if (!list.length) return fail(REASON.USAGE, '没有待转换的文件')

      const t = String(target || '').toLowerCase()
      if (!t) return fail(REASON.USAGE, '未指定目标格式')

      const outputs = []
      const failures = []
      const usedDest = new Set()

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
          const out = srcExt === 'xlsx'
            ? await convertFromXlsx(src, t, outDir, usedDest)
            : await convertToXlsx(src, srcExt, outDir, usedDest)
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
          fail(REASON.FAILED, failures[0] ? failures[0].error : '表格转换失败'),
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
  createSpreadsheetProvider,
  cellValueToScalar,
  uniqueHeaders,
  hasZipMagic
}
