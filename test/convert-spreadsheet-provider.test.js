'use strict'

/**
 * 内置表格 provider（spreadsheet.js）单测。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ExcelJS = require('exceljs')

const { validateProvider, WARN, REASON } = require('../lib/convert/provider')
const spreadsheet = require('../lib/convert/providers/spreadsheet')
const textData = require('../lib/convert/providers/text-data')
const { createRouter } = require('../lib/convert/router')

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-xlsx-' + tag + '-'))
}

test('★ spreadsheet provider：满足契约且不截胡 text-data', async () => {
  const p = spreadsheet.createSpreadsheetProvider()
  const v = validateProvider(p)
  assert.equal(v.ok, true, v.error)
  assert.equal(p.id, 'builtin-spreadsheet')

  assert.equal(await p.canHandle('xlsx', 'csv'), true)
  assert.equal(await p.canHandle('xlsx', 'json'), true)
  assert.equal(await p.canHandle('xlsx', 'md'), true)
  assert.equal(await p.canHandle('csv', 'xlsx'), true)
  assert.equal(await p.canHandle('json', 'xlsx'), true)
  assert.equal(await p.canHandle('md', 'xlsx'), true)
  // 不能截胡 csv ↔ json ↔ md
  assert.equal(await p.canHandle('csv', 'json'), false)
  assert.equal(await p.canHandle('json', 'md'), false)

  const router = createRouter({ providers: [textData.createTextDataProvider(), p] })
  const capsCsv = await router.capabilities('csv')
  assert.ok(capsCsv.targets.includes('xlsx'))
  assert.ok(capsCsv.targets.includes('json'))

  const dir = tmpDir('route')
  const csvFile = path.join(dir, 't.csv')
  fs.writeFileSync(csvFile, 'a,b\n1,2\n')
  const r = await router.convert([csvFile], 'json', tmpDir('route-out'))
  assert.equal(r.ok, true)
  assert.equal(r.provider, 'builtin-text-data')
})

test('★ spreadsheet provider：xlsx → csv / json / md（公式、富文本、超链接、日期、去重表头与多表警告）', async t => {
  const dir = tmpDir('xlsx-read')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const outDir = tmpDir('xlsx-out')
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }))

  const wb = new ExcelJS.Workbook()
  wb.addWorksheet('EmptyFirst') // 空表应被跳过
  const ws = wb.addWorksheet('MainData')
  ws.addRow(['姓名', '姓名', '', '日期', '总分'])
  ws.addRow([
    { richText: [{ text: '张' }, { text: '三|A' }] },
    { text: '主页', hyperlink: 'https://example.com' },
    { error: '#DIV/0!' },
    new Date('2026-11-23T00:00:00.000Z'),
    { formula: '1+2', result: 99 }
  ])
  const src = path.join(dir, 'multi.xlsx')
  fs.writeFileSync(src, Buffer.from(await wb.xlsx.writeBuffer()))

  const p = spreadsheet.createSpreadsheetProvider()

  const rJson = await p.convert([src], 'json', outDir)
  assert.equal(rJson.ok, true)
  const json = JSON.parse(fs.readFileSync(rJson.outputs[0].output, 'utf8'))
  assert.deepEqual(json, [{
    姓名: '张三|A',
    姓名_2: '主页',
    col_3: '#DIV/0!',
    日期: '2026-11-23',
    总分: 99
  }])
  const warn = (rJson.outputs[0].warnings || []).find(w => w.code === WARN.XLSX_MULTISHEET)
  assert.ok(warn, '多工作表必须产生 xlsx-multisheet 警告')
  assert.ok(warn.message.includes('MainData'))

  const rCsv = await p.convert([src], 'csv', outDir)
  assert.equal(rCsv.ok, true)
  const csvText = fs.readFileSync(rCsv.outputs[0].output, 'utf8')
  assert.ok(csvText.includes('张三|A'))
  assert.ok(csvText.includes('2026-11-23,99'))

  const rMd = await p.convert([src], 'md', outDir)
  assert.equal(rMd.ok, true)
  const mdText = fs.readFileSync(rMd.outputs[0].output, 'utf8')
  assert.ok(mdText.includes('张三\\|A'), 'Markdown 表格内的 | 必须转义')
  assert.ok(mdText.includes('| 姓名 | 姓名_2 | col_3 | 日期 | 总分 |'))
})

test('★ spreadsheet provider：csv / json / md → xlsx 往返且魔数正确', async t => {
  const dir = tmpDir('to-xlsx')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const outDir = tmpDir('to-xlsx-out')
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }))

  const p = spreadsheet.createSpreadsheetProvider()

  const csvSrc = path.join(dir, 'a.csv')
  fs.writeFileSync(csvSrc, 'name,score\nAlice,90\nBob,85\n')
  const r1 = await p.convert([csvSrc], 'xlsx', outDir)
  assert.equal(r1.ok, true)
  assert.deepEqual([...fs.readFileSync(r1.outputs[0].output).slice(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  const back1 = await p.convert([r1.outputs[0].output], 'json', outDir)
  assert.deepEqual(JSON.parse(fs.readFileSync(back1.outputs[0].output, 'utf8')), [
    { name: 'Alice', score: '90' },
    { name: 'Bob', score: '85' }
  ])

  const jsonSrc = path.join(dir, 'b.json')
  fs.writeFileSync(jsonSrc, JSON.stringify([{ city: '北京', pop: 2189 }]))
  const r2 = await p.convert([jsonSrc], 'xlsx', outDir)
  assert.equal(r2.ok, true)
  const back2 = await p.convert([r2.outputs[0].output], 'csv', outDir)
  assert.ok(fs.readFileSync(back2.outputs[0].output, 'utf8').includes('北京,2189'))

  const mdSrc = path.join(dir, 'c.md')
  fs.writeFileSync(mdSrc, '| k | v |\n| --- | --- |\n| x | 1 |\n')
  const r3 = await p.convert([mdSrc], 'xlsx', outDir)
  assert.equal(r3.ok, true)
  const back3 = await p.convert([r3.outputs[0].output], 'md', outDir)
  assert.ok(fs.readFileSync(back3.outputs[0].output, 'utf8').includes('| x | 1 |'))
})

test('★ spreadsheet provider：空工作簿与假 xlsx 明确失败、零产物', async t => {
  const dir = tmpDir('xlsx-fail')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const outDir = tmpDir('xlsx-fail-out')
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }))

  const emptyWb = new ExcelJS.Workbook()
  emptyWb.addWorksheet('Blank')
  const emptySrc = path.join(dir, 'empty.xlsx')
  fs.writeFileSync(emptySrc, Buffer.from(await emptyWb.xlsx.writeBuffer()))

  const fakeSrc = path.join(dir, 'fake.xlsx')
  fs.writeFileSync(fakeSrc, 'not an xlsx zip')

  const p = spreadsheet.createSpreadsheetProvider()
  const rEmpty = await p.convert([emptySrc], 'csv', outDir)
  assert.equal(rEmpty.ok, false)
  assert.equal(rEmpty.reason, REASON.FAILED)

  const rFake = await p.convert([fakeSrc], 'json', outDir)
  assert.equal(rFake.ok, false)
  assert.match(rFake.failures[0].error, /ZIP|XLSX/)
  assert.equal(fs.readdirSync(outDir).length, 0)
})
