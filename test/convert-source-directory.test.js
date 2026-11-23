'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createService } = require('../lib/convert/service')

function setup (t, outputSources) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-source-output-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workDirs = []
  const service = createService({ userDataDir: path.join(root, 'userData'), router: {
    async convert (files, target, outDir) {
      workDirs.push(outDir)
      const sources = outputSources ? outputSources(files) : files
      const outputs = sources.map((source, i) => {
        const output = path.join(outDir, 'provider-' + i + '.' + target)
        fs.writeFileSync(output, 'converted-' + i)
        return { source, output }
      })
      return { ok: true, reason: 'ok', outputs, failures: [], error: null }
    }
  } })
  function source (directory, name) {
    const dir = path.join(root, directory); fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name); fs.writeFileSync(file, 'original')
    return file
  }
  return { root, service, source, workDirs }
}

test('转换直接保存到源目录，保留原图，不创建附件目录', async t => {
  const { root, service, source, workDirs } = setup(t)
  const input = source('images', '中文 图片.png')
  const result = await service.convert([input], 'jpg')
  assert.equal(result.ok, true)
  assert.equal(result.attachments[0].path, path.join(path.dirname(input), '中文 图片.jpg'))
  assert.equal(fs.readFileSync(result.attachments[0].path, 'utf8'), 'converted-0')
  assert.equal(fs.readFileSync(input, 'utf8'), 'original')
  assert.equal(fs.existsSync(path.join(root, 'userData', 'attachments')), false)
  assert.equal(fs.existsSync(workDirs[0]), false)
})

test('不同目录中的同名文件分别保存到各自源目录', async t => {
  const { service, source } = setup(t)
  const files = [source('one', 'same.png'), source('two', 'same.png')]
  const result = await service.convert(files, 'jpg')
  assert.deepEqual(result.attachments.map(o => o.path), files.map(f => path.join(path.dirname(f), 'same.jpg')))
  assert.equal(fs.readFileSync(result.attachments[1].path, 'utf8'), 'converted-1')
})

test('同格式转换与已有同名结果均不覆盖，自动增加编号', async t => {
  const { service, source } = setup(t)
  const input = source('images', 'same.png')
  const existing = path.join(path.dirname(input), 'same (1).png'); fs.writeFileSync(existing, 'keep')
  const result = await service.convert([input], 'png')
  assert.equal(result.attachments[0].path, path.join(path.dirname(input), 'same (2).png'))
  assert.equal(fs.readFileSync(input, 'utf8'), 'original')
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep')
})

test('PDF 多页输出保留分页名，合并输出使用首个源目录', async t => {
  const multi = setup(t, files => [path.join(path.dirname(files[0]), 'book-page001.pdf'), path.join(path.dirname(files[0]), 'book-page002.pdf')])
  const pdf = multi.source('pdfs', 'book.pdf')
  const result = await multi.service.convert([pdf], 'png')
  assert.deepEqual(result.attachments.map(o => o.name), ['book-page001.png', 'book-page002.png'])
  const combined = setup(t, files => files.slice(0, 1))
  const inputs = [combined.source('first', 'a.png'), combined.source('second', 'b.png')]
  const merged = await combined.service.convert(inputs, 'pdf')
  assert.equal(merged.attachments[0].path, path.join(path.dirname(inputs[0]), 'a.pdf'))
})

test('无法写入源目录时报告失败并保留临时转换结果', async t => {
  const { root, service, source, workDirs } = setup(t, files => [path.join(path.dirname(files[0]), 'missing', 'a.png')])
  const input = source('source', 'a.png')
  const result = await service.convert([input], 'jpg')
  assert.equal(result.ok, false)
  assert.equal(result.attachments.length, 0)
  assert.ok(result.error.includes('源文件目录'))
  assert.equal(result.failures.length, 1)
  assert.ok(fs.existsSync(path.join(workDirs[0], 'provider-0.jpg')))
  assert.equal(fs.readFileSync(input, 'utf8'), 'original')
  // Only the service-owned retained work directory is removed by the test.
  assert.ok(path.resolve(workDirs[0]).startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(workDirs[0], { recursive: true, force: true })
})

test('伴生资源目录随主文件发布并替换占位符，重名冲突时按 URL 安全编码避让', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-assets-pub-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workDirs = []
  const service = createService({
    userDataDir: path.join(root, 'userData'),
    router: {
      async convert (files, target, outDir) {
        workDirs.push(outDir)
        const assetsDir = path.join(outDir, 'tmp-assets')
        fs.mkdirSync(assetsDir, { recursive: true })
        fs.writeFileSync(path.join(assetsDir, 'pic.png'), 'PNGDATA')
        const outMd = path.join(outDir, 'out.md')
        fs.writeFileSync(outMd, '![pic](__PLACEHOLDER__/pic.png)\n', 'utf8')
        return {
          ok: true,
          reason: 'ok',
          outputs: [{
            source: files[0],
            output: outMd,
            assetsDir,
            assetsPlaceholder: '__PLACEHOLDER__'
          }],
          failures: [],
          error: null
        }
      }
    }
  })

  const docDir = path.join(root, 'docs')
  fs.mkdirSync(docDir, { recursive: true })
  const src = path.join(docDir, 'report.docx')
  fs.writeFileSync(src, 'docx')
  // 预置同名 report.md 与 report_assets，触发 (1) 碰撞编号
  fs.writeFileSync(path.join(docDir, 'report.md'), 'existing')
  fs.mkdirSync(path.join(docDir, 'report_assets'))

  const r = await service.convert([src], 'md')
  assert.equal(r.ok, true)
  assert.equal(r.attachments.length, 1)
  const att = r.attachments[0]
  assert.equal(att.name, 'report (1).md')
  assert.equal(att.assetsDir, path.join(docDir, 'report (1)_assets'))
  assert.equal(fs.readFileSync(path.join(att.assetsDir, 'pic.png'), 'utf8'), 'PNGDATA')
  const mdText = fs.readFileSync(att.path, 'utf8')
  assert.ok(mdText.includes('report%20%281%29_assets/pic.png'), '括号和空格应被编码：' + mdText)
  const decodedRel = decodeURIComponent(mdText.match(/\(([^)]+)\)/)[1])
  assert.equal(fs.existsSync(path.join(docDir, decodedRel)), true)
  assert.equal(fs.existsSync(workDirs[0]), false)
})

test('伴生资源拷贝失败时回滚已写入的主文件并保留临时工作目录', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-assets-fail-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workDirs = []
  const service = createService({
    userDataDir: path.join(root, 'userData'),
    router: {
      async convert (files, target, outDir) {
        workDirs.push(outDir)
        const assetsDir = path.join(outDir, 'bad-assets')
        fs.mkdirSync(assetsDir, { recursive: true })
        // 放入一个损坏文件或覆盖已有同名目录且只读？改为让占位符文件只读导致写入失败
        fs.writeFileSync(path.join(assetsDir, 'pic.png'), 'PNG')
        const outMd = path.join(outDir, 'out.md')
        fs.writeFileSync(outMd, '![pic](__PLACEHOLDER__/pic.png)', 'utf8')
        // 在源目录预先把 report_assets 建为普通文件且把后续位置设为无冲突，测试 cpSync 覆盖/失败：
        // 改为在 assetsDir 里创建指向不存在目标的软/硬条件较易受权限影响，改用 getter 抛错模拟读取 placeholder 异常
        const outputObj = {
          source: files[0],
          output: outMd,
          assetsDir
        }
        Object.defineProperty(outputObj, 'assetsPlaceholder', {
          enumerable: true,
          get () { throw new Error('模拟占位符写入失败') }
        })
        return { ok: true, reason: 'ok', outputs: [outputObj], failures: [], error: null }
      }
    }
  })

  const docDir = path.join(root, 'docs')
  fs.mkdirSync(docDir, { recursive: true })
  const src = path.join(docDir, 'report.docx')
  fs.writeFileSync(src, 'docx')

  const r = await service.convert([src], 'md')
  assert.equal(r.ok, false)
  assert.equal(r.attachments.length, 0)
  assert.equal(fs.existsSync(path.join(docDir, 'report.md')), false, '已写主文件必须回滚清理')
  assert.equal(fs.existsSync(path.join(docDir, 'report_assets')), false, '已建资源目录必须回滚清理')
  assert.equal(fs.existsSync(workDirs[0]), true, '失败时保留临时工作目录')
  fs.rmSync(workDirs[0], { recursive: true, force: true })
})
