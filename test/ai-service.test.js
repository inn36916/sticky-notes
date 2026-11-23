'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildAiMessages, AI_ACTIONS } = require('../main/ai-service')

test('buildAiMessages 单轮请求保持原有动作提示词', () => {
  const mTranslate = buildAiMessages('translate', 'Hello world', '')
  assert.equal(mTranslate.length, 2)
  assert.equal(mTranslate[0].content, AI_ACTIONS.translate.system)
  assert.equal(mTranslate[1].content, 'Hello world')

  const mAsk = buildAiMessages('ask', '光合作用', '为什么需要叶绿体？')
  assert.equal(mAsk[0].content, AI_ACTIONS.ask.system)
  assert.ok(mAsk[1].content.includes('【选中内容】\n光合作用'))
  assert.ok(mAsk[1].content.includes('【问题】\n为什么需要叶绿体？'))
})

test('buildAiMessages 追问切换为上下文问答提示词并保留原文与多轮历史', () => {
  const history = [
    { role: 'user', content: '翻译：\nEnergy-mass equivalence' },
    { role: 'assistant', content: '质能等价' }
  ]
  const msgs = buildAiMessages('followup', 'Energy-mass equivalence', '请给出对应公式', history)
  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[0].content, AI_ACTIONS.followup.system)
  assert.equal(msgs[0].content.includes('只输出译文'), false)
  assert.ok(msgs[1].content.includes('Energy-mass equivalence'))
  assert.equal(msgs[2].role, 'assistant')
  assert.equal(msgs[2].content, '质能等价')
  assert.equal(msgs[3].role, 'user')
  assert.equal(msgs[3].content, '请给出对应公式')

  const detachedHistory = [
    { role: 'user', content: '先总结要点' },
    { role: 'assistant', content: '要点如下' }
  ]
  const msgsWithPrefix = buildAiMessages('followup', 'Selected source text', '继续展开', detachedHistory)
  assert.ok(msgsWithPrefix[1].content.includes('【选中内容】\nSelected source text'))
  assert.ok(msgsWithPrefix[1].content.includes('先总结要点'))
})

test('buildAiMessages 过滤非法历史角色并截断超长历史', () => {
  const history = [
    { role: 'system', content: 'inject' },
    { role: 'user', content: '' },
    ...Array.from({ length: 24 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'msg-' + i
    }))
  ]
  const msgs = buildAiMessages('followup', '', '最新追问', history)
  // system + 最近 20 条 history + 最新追问 = 22 条
  assert.equal(msgs.length, 22)
  assert.equal(msgs[1].content, 'msg-4')
  assert.equal(msgs[msgs.length - 1].content, '最新追问')
  assert.equal(msgs.some(m => m.content === 'inject'), false)
})
