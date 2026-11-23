'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_IDLE_MS,
  DEFAULT_TOTAL_MS,
  createWatchdog,
  describeTimeout
} = require('../lib/watchdog')

/** 确定性时钟：推进时间时按到期顺序执行回调，避免真实等待 */
function makeClock () {
  let seq = 0
  let now = 0
  const timers = new Map()
  return {
    setTimeout (fn, ms) {
      const id = ++seq
      timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0), order: id })
      return id
    },
    clearTimeout (id) { timers.delete(id) },
    advance (ms) {
      const target = now + ms
      for (;;) {
        let pickId = null
        let pick = null
        for (const [id, t] of timers) {
          if (t.at > target) continue
          if (!pick || t.at < pick.at || (t.at === pick.at && t.order < pick.order)) {
            pick = t
            pickId = id
          }
        }
        if (!pick) break
        timers.delete(pickId)
        now = pick.at
        pick.fn()
      }
      now = target
    },
    get now () { return now },
    get pending () { return timers.size }
  }
}

function harness (opts = {}) {
  const clock = makeClock()
  const fired = []
  const wd = createWatchdog(Object.assign({
    idleMs: 1000,
    totalMs: 5000,
    onTimeout: (reason) => fired.push(reason),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  }, opts))
  return { clock, fired, wd }
}

test('idle：到点没有增量就触发一次 idle', () => {
  const { clock, fired, wd } = harness()
  wd.start()
  clock.advance(999)
  assert.deepEqual(fired, [], '未到点不得触发')
  clock.advance(1)
  assert.deepEqual(fired, ['idle'])
  assert.equal(wd.reason, 'idle')
})

test('idle：touch 会重置空闲计时，持续有增量不触发', () => {
  const { clock, fired, wd } = harness()
  wd.start()
  for (let i = 0; i < 4; i++) {
    clock.advance(900)
    wd.touch()
  }
  assert.deepEqual(fired, [], '每 900ms 有增量，不应判空闲超时')
  clock.advance(1000)
  assert.deepEqual(fired, ['idle'])
})

test('total：即使一直有增量，到总时长也必须收尾', () => {
  const { clock, fired, wd } = harness()
  wd.start()
  while (clock.now < 5000) {
    clock.advance(800)
    wd.touch()
  }
  assert.deepEqual(fired, ['total'])
  assert.equal(wd.reason, 'total')
})

test('只触发一次：idle 与 total 同时到期不重复回调', () => {
  const { clock, fired, wd } = harness({ idleMs: 5000, totalMs: 5000 })
  wd.start()
  clock.advance(5000)
  assert.equal(fired.length, 1)
})

test('stop 之后不再触发，且清掉挂起的定时器', () => {
  const { clock, fired, wd } = harness()
  wd.start()
  wd.stop()
  assert.equal(clock.pending, 0, 'stop 必须清空定时器')
  clock.advance(10000)
  assert.deepEqual(fired, [])
  assert.equal(wd.reason, '')
})

test('触发后再 touch 无效，不会复活看门狗', () => {
  const { clock, fired, wd } = harness()
  wd.start()
  clock.advance(1000)
  assert.deepEqual(fired, ['idle'])
  wd.touch()
  clock.advance(10000)
  assert.deepEqual(fired, ['idle'])
})

test('start 幂等：重复调用不会叠加定时器', () => {
  const { clock, fired, wd } = harness()
  wd.start()
  wd.start()
  assert.equal(clock.pending, 2, '一个 idle + 一个 total')
  clock.advance(1000)
  assert.deepEqual(fired, ['idle'])
})

test('非法参数回落到默认值', () => {
  const wd = createWatchdog({ idleMs: 0, totalMs: -1, onTimeout: () => {} })
  assert.equal(wd.idleMs, DEFAULT_IDLE_MS)
  assert.equal(wd.totalMs, DEFAULT_TOTAL_MS)
})

test('describeTimeout 给出带秒数的可读文案', () => {
  assert.match(describeTimeout('idle', { idleMs: 45000 }), /45 秒/)
  assert.match(describeTimeout('total', { totalMs: 180000 }), /180 秒/)
  assert.equal(describeTimeout('', {}), '')
})
