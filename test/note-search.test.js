'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createNoteSearch } = require('../lib/note-search')

test('全文索引：旧结构、160 字后中文、大小写、编辑、删除与短上下文', async () => {
  let calls = 0
  const index = createNoteSearch(async html => { calls++; return html.replace(/<[^>]*>/g, '') })
  const notes = [{ id: 'old', title: '旧便签', html: '<p>' + '甲'.repeat(200) + '连续中文 Needle 尾文</p>', preview: '甲'.repeat(160) }]
  const hits = await index.query(notes, '连续中文')
  assert.equal(hits[0].id, 'old')
  assert.ok(hits[0].context.includes('连续中文'))
  assert.ok(hits[0].context.length <= 122)
  assert.deepEqual(Object.keys(hits[0]), ['id', 'context'])
  assert.equal((await index.query(notes, 'needle')).length, 1)
  assert.equal(calls, 1)
  notes[0].title = '新标题'
  assert.equal((await index.query(notes, '新标题')).length, 1)
  notes[0].html = '<p>替换后的内容</p>'
  assert.equal((await index.query(notes, 'needle')).length, 0)
  assert.equal((await index.query(notes, '替换后')).length, 1)
  assert.deepEqual(await index.query([], '替换后'), [])
  assert.deepEqual(await index.query(notes, '  '), [])
})

test('500 张短便签热查询 P95 小于 100ms', async () => {
  const index = createNoteSearch(async html => html)
  const notes = Array.from({ length: 500 }, (_, i) => ({ id: String(i), title: '便签' + i, html: '短正文'.repeat(80) + '目标关键词', preview: '' }))
  await index.query(notes, '目标关键词')
  const times = []
  for (let i = 0; i < 100; i++) {
    const start = performance.now()
    assert.equal((await index.query(notes, '目标关键词')).length, 500)
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  console.log('500 张便签热查询 P95: ' + times[94].toFixed(2) + ' ms（索引查询，不含 IPC）')
  assert.ok(times[94] < 100)
})

test('公式源码搜索支持忽略空格匹配（如 $E = mc^2$ 匹配 E=mc^2）且输出干净上下文', async () => {
  const index = createNoteSearch(async html => html.replace(/<[^>]*>/g, ''))
  const notes = [
    { id: 'f1', title: '物理笔记', html: '<p>质能方程 $E = mc^2$ 与积分 $$\\int_0^1 x^2 \\, dx$$</p>' }
  ]
  const hit1 = await index.query(notes, 'E=mc^2')
  assert.equal(hit1.length, 1)
  assert.equal(hit1[0].id, 'f1')
  assert.ok(hit1[0].context.includes('$E = mc^2$'))

  const hit2 = await index.query(notes, 'e=mc^2')
  assert.equal(hit2.length, 1)

  const hit3 = await index.query(notes, '\\int_0^1x^2\\,dx')
  assert.equal(hit3.length, 1)
  assert.ok(hit3[0].context.includes('\\int_0^1 x^2 \\, dx'))
})
