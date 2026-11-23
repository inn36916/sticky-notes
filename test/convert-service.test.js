'use strict'

/**
 * 转换服务层的回归（lib/convert/service.js）。
 *
 * 这一层**不依赖 Electron**：用注入的假 cli 适配层驱动，
 * 验证编排逻辑（能力透传、产物落附件目录、失败分类、便签 HTML 生成）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const svc = require('../lib/convert/service')
const fileeCli = require('../lib/convert/filee-cli')

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-svc-' + tag + '-'))
}

/** 造一个注入用的假 cli */
function fakeCli (over = {}) {
  return Object.assign({
    REASON: fileeCli.REASON,
    async capabilities (bin, ext) {
      return { ok: true, reason: 'ok', targets: ['jpg', 'pdf'], withEngines: ['heic'], displayName: 'PNG', error: null }
    },
    async convert (bin, files, target, outDir) {
      // 真的写一个产物文件，模拟 Filee 的行为
      fs.mkdirSync(outDir, { recursive: true })
      const outputs = []
      for (const f of files) {
        const base = path.basename(f, path.extname(f))
        const dest = path.join(outDir, base + '.' + target)
        fs.writeFileSync(dest, 'x'.repeat(100))
        outputs.push({ source: f, output: dest })
      }
      return { ok: true, reason: 'ok', outputs, failures: [], files: [], error: null }
    }
  }, over)
}

// ---------------------------------------------------------------- 命名

test('★ attachmentName：保留中文，去掉路径分隔符，追加随机后缀', () => {
  const n = svc.attachmentName('C:\\a\\b\\我的 照片.heic', 'jpg', 'abc123')
  assert.equal(n, '我的 照片-abc123.jpg')
  assert.ok(!n.includes('\\'))
  assert.ok(!n.includes('/'))
})

test('attachmentName：目标扩展名里的非法字符被剔除', () => {
  const n = svc.attachmentName('a.png', 'j/pg', 'x1')
  assert.ok(n.endsWith('.jpg'))
})

test('attachmentName：空路径不炸', () => {
  assert.doesNotThrow(() => svc.attachmentName('', 'jpg', 'x'))
  assert.ok(svc.attachmentName('', 'jpg', 'x').endsWith('.jpg'))
})

test('attachmentDir：在 userData 下建 attachments 子目录', () => {
  const d = svc.attachmentDir('C:\\Users\\x\\AppData\\Roaming\\sticky-notes')
  assert.equal(d, path.join('C:\\Users\\x\\AppData\\Roaming\\sticky-notes', 'attachments'))
})

// ---------------------------------------------------------------- 服务

test('★ capabilities：原样透传适配层结果', async () => {
  const s = svc.createService({ userDataDir: tmpDir('c'), cli: fakeCli() })
  const r = await s.capabilities('png')
  assert.equal(r.ok, true)
  assert.deepEqual(r.targets, ['jpg', 'pdf'])
})

test('★ convert：产物被复制进源文件目录，且登记 name/path/size', async () => {
  const root = tmpDir('cv')
  const srcDir = tmpDir('src')
  const src = path.join(srcDir, 'a.png')
  fs.writeFileSync(src, 'src')
  const s = svc.createService({ userDataDir: root, cli: fakeCli(), resolveBin: () => 'filee' })

  const r = await s.convert([src], 'jpg')
  assert.equal(r.ok, true)
  assert.equal(r.attachments.length, 1)
  const att = r.attachments[0]
  assert.ok(att.name.endsWith('.jpg'))
  assert.equal(att.path, path.join(srcDir, 'a.jpg'))
  assert.equal(att.size, 100)
  assert.ok(fs.existsSync(att.path), '附件应真的落盘')
})

test('convert：不创建用户数据附件目录', async () => {
  const root = path.join(tmpDir('mk'), 'deep', 'nested')
  const src = path.join(tmpDir('s2'), 'a.png')
  fs.writeFileSync(src, 'x')
  const s = svc.createService({ userDataDir: root, cli: fakeCli(), resolveBin: () => 'filee' })
  const r = await s.convert([src], 'jpg')
  assert.equal(r.ok, true)
  assert.equal(fs.existsSync(root), false)
  assert.ok(fs.existsSync(path.join(path.dirname(src), 'a.jpg')))
})

test('★ convert：Filee 未安装 → not-installed，不抛异常', async () => {
  const s = svc.createService({
    userDataDir: tmpDir('ni'),
    cli: fakeCli(),
    resolveBin: () => ''
  })
  const r = await s.convert(['a.png'], 'jpg')
  assert.equal(r.ok, false)
  assert.equal(r.reason, fileeCli.REASON.NOT_INSTALLED)
  assert.ok(r.error.includes('Filee'))
})

test('convert：失败原因与失败明细被保留', async () => {
  const s = svc.createService({
    userDataDir: tmpDir('ne'),
    cli: fakeCli({
      async convert () {
        return {
          ok: false, reason: fileeCli.REASON.NEEDS_ENGINE, outputs: [],
          failures: [{ source: 'a.md', state: 'failed', error: 'x', needsEngines: ['pandoc'] }],
          files: [], error: '需要引擎：pandoc'
        }
      }
    }),
    resolveBin: () => 'filee'
  })
  const r = await s.convert(['a.md'], 'pptx')
  assert.equal(r.ok, false)
  assert.equal(r.reason, fileeCli.REASON.NEEDS_ENGINE)
  assert.equal(r.failures.length, 1)
  assert.ok(r.error.includes('pandoc'))
})

test('★ resolveBin：结果被缓存，不重复探测', async () => {
  let calls = 0
  const s = svc.createService({
    userDataDir: tmpDir('cache'),
    cli: fakeCli(),
    resolveBin: () => { calls++; return 'filee' }
  })
  s.resolveBin()
  s.resolveBin()
  s.resolveBin()
  assert.equal(calls, 1, '应只探测一次')
})

test('resolveBin：探测抛异常时降级为空串而不是崩', () => {
  const s = svc.createService({
    userDataDir: tmpDir('err'),
    cli: fakeCli(),
    resolveBin: () => { throw new Error('boom') }
  })
  assert.equal(s.resolveBin(), '')
})

// ---------------------------------------------------------------- 便签 HTML

test('★ attachmentHtml：图片生成 img 标签并带 data-attachment', () => {
  const html = svc.attachmentHtml({ name: 'a.jpg', path: 'C:\\att\\a.jpg', size: 2048 })
  assert.ok(html.startsWith('<img'))
  assert.ok(html.includes('src='))
  assert.ok(html.includes('data-attachment="a.jpg"'))
})

test('attachmentHtml：非图片生成附件卡片（带大小）', () => {
  const html = svc.attachmentHtml({ name: 'a.pdf', path: 'C:\\att\\a.pdf', size: 20480 })
  assert.ok(html.includes('📎'))
  assert.ok(html.includes('a.pdf'))
  assert.ok(html.includes('20 KB'))
})

test('★ attachmentHtml：文件名里的 HTML 特殊字符被转义', () => {
  const html = svc.attachmentHtml({ name: '<img x>.png', path: 'p', size: 1 })
  assert.ok(!html.includes('<img x>'))
  assert.ok(html.includes('&lt;img'))
})

test('attachmentHtml：urlFor 被用于生成引用 URL', () => {
  const html = svc.attachmentHtml(
    { name: 'a.png', path: 'C:\\att\\a.png', size: 1 },
    { urlFor: p => 'sticky-att://' + p.replace(/\\/g, '/') }
  )
  assert.ok(html.includes('sticky-att://'))
})

test('attachmentHtml：空附件返回空串', () => {
  assert.equal(svc.attachmentHtml(null), '')
  assert.equal(svc.attachmentHtml({}), '')
})
