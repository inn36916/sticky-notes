'use strict'

/**
 * 独立抽查（不依赖工程师自述，自己读代码验证）。
 * 运行：node scripts/qa-audit.js
 *
 * 四项抽查：
 *   A. 180ms 停手路径里还剩几处 cloneNode（要求 1 处）
 *   B. flushSave 的 ok/error 回执仍然真实（N-04 契约未被破坏）
 *   C. 写盘串行化成立（不会两个 writeState 并发、不会丢新内容）
 *   D. 退出收口不会因异步化提前退出导致丢写
 *
 * 这只是**源码层**的静态审计；语义层另有 e2e 运行时验证（scripts/e2e-*.js）。
 * 静态审计的结论是「提示」，最终判定以 e2e + 单测为准。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const noteJs = read('src/note.js')
const mainJs = read('main.js')
const persistenceJs = read('lib/persistence.js')

/** 每行文本 → 该行在全文中的起始字符偏移（用于把行号映射回区间） */
function lineIndex (src) {
  const idx = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') idx.push(i + 1)
  return idx
}
const noteIdx = lineIndex(noteJs)
const noteLineAt = (offset) => {
  let lo = 0
  let hi = noteIdx.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (noteIdx[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

const results = []
const check = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail })
  console.log((pass ? 'PASS  ' : 'WARN  ') + id + ' ' + name)
  console.log('      ' + String(detail).split('\n').join('\n      '))
}

/** 取 `function name (...) { ... }` 的完整函数体（含大括号配平） */
function fnBody (src, name) {
  const i = src.indexOf('function ' + name)
  if (i < 0) return null
  const start = src.indexOf('{', i)
  if (start < 0) return null
  let depth = 0
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return { start, end: j + 1, text: src.slice(start, j + 1) } }
  }
  return null
}

// ---------------------------------------------------------------- A. cloneNode 次数

const cloneHits = []
noteJs.split('\n').forEach((l, i) => {
  if (/cloneNode\s*\(/.test(l)) cloneHits.push({ line: i + 1, text: l.trim() })
})

// 停手路径真正调用的是 serializeHtml() / plainText() / updateStats()，
// clone 发生在这些函数的函数体里（定义靠前，但由 180ms 回调调用）。
// 静态口径 = 「被停手路径调用的函数体内出现的 cloneNode 次数」。
const TAIL_FNS = ['serializeHtml', 'plainText', 'updateStats']
const tailCloneHits = []
for (const name of TAIL_FNS) {
  const b = fnBody(noteJs, name)
  if (!b) continue
  const fromLine = noteLineAt(b.start)
  const toLine = noteLineAt(b.end)
  for (const h of cloneHits) {
    if (h.line >= fromLine && h.line <= toLine) tailCloneHits.push({ fn: name, ...h })
  }
}

const timerIdx = noteJs.indexOf('}, 180)')
const tailPath = timerIdx >= 0 ? noteJs.slice(Math.max(0, timerIdx - 420), timerIdx + 20) : ''

check('A1', '停手路径调用的函数（serializeHtml/plainText/updateStats）内 cloneNode 合计 ≤ 1',
  tailCloneHits.length <= 1,
  '停手路径相关函数内 cloneNode 出现 ' + tailCloneHits.length + ' 处：\n' +
  (tailCloneHits.length
    ? tailCloneHits.map(x => '  ' + x.fn + '() @ note.js:' + x.line + ': ' + x.text).join('\n')
    : '  （无）') +
  '\n  ---- 180ms 停手回调体 ----\n' + tailPath.trim())

check('A2', '整个 note.js 的 cloneNode 总数 ≤ 1',
  cloneHits.length <= 1,
  'note.js 全文 cloneNode 出现 ' + cloneHits.length + ' 处：\n' +
  cloneHits.map(x => '  note.js:' + x.line + ': ' + x.text).join('\n'))

// ---------------------------------------------------------------- B. flushSave 回执真实性

const flushSaveFn = fnBody(mainJs, 'flushSave')
const flushText = flushSaveFn ? flushSaveFn.text : ''

const flushReal =
  /persistence\.writeState/.test(flushText) &&
  /\breturn\s+r\b/.test(flushText) &&
  /\br\s*&&\s*r\.ok|\br\.ok\b/.test(flushText)

check('B1', 'flushSave 直接依据 writeState 的真实结果返回', flushReal, flushText || '（未找到 flushSave 定义）')

// 渲染层「已保存」必须以 ok=true 为前提
const noteFlush = fnBody(noteJs, 'flushSave')
const noteFlushText = noteFlush ? noteFlush.text : ''
const rendererReal = /r\s*&&\s*r\.ok/.test(noteFlushText) && /已保存/.test(noteFlushText)

check('B2', '渲染层「已保存」以落盘 ok=true 为前提（N-04）', rendererReal,
  noteFlushText || '（未找到渲染层 flushSave 定义）')

// ---------------------------------------------------------------- C. 写盘串行化

// 串行化 = 存在「前一次写盘完成后再做下一次」的排队结构。
// 证据：Promise 链（chain = chain.then(...)）、显式队列、或带 in-flight 标志的等待。
const hasChain = /\bchain\b/.test(persistenceJs) ||
  /\.then\s*\(/.test(persistenceJs) ||
  /queue/i.test(persistenceJs) ||
  /inFlight|writing|pending/i.test(persistenceJs)

// 必须能看出「落盘是异步的」（本轮目标之一）
const isAsyncWrite = /writeFileAsync|renameAsync|promises|fsp\.|\.then\s*\(/.test(persistenceJs)

check('C1', '持久化层存在串行化/排队机制（不会两个写盘并发）', hasChain,
  persistenceJs.split('\n')
    .filter(l => /chain|queue|inFlight|writing|pending|\.then\s*\(|Async/.test(l))
    .map(l => '  ' + l.trim()).join('\n') || '  （未找到排队结构 —— 提示：当前是裸同步写，无并发风险；改成异步后必须补串行化）')

check('C2', '持久化层走 .tmp + rename 原子替换', /\.tmp/.test(persistenceJs) && /rename/.test(persistenceJs),
  persistenceJs.split('\n')
    .filter(l => /tmp|rename|writeFile/.test(l)).map(l => '  ' + l.trim()).join('\n'))

check('C3', '落盘已改异步（writeFileAsync/renameAsync 或 Promise 链）', isAsyncWrite,
  isAsyncWrite ? '  已检出异步写盘特征' :
  '  未检出异步写盘特征 —— 若本轮尚未落地则属预期')

// ---------------------------------------------------------------- D. 退出收口

const bqIdx = mainJs.indexOf("app.on('before-quit'")
const beforeQuit = bqIdx >= 0
  ? mainJs.slice(bqIdx, mainJs.indexOf("\n  app.on(", bqIdx + 10))
  : ''

// 退出前必须「等」写盘完成：await / event.preventDefault / 标志位阻止退出
const awaitsWrite = /\bawait\b/.test(beforeQuit) || /preventDefault/.test(beforeQuit)
const hasQuitFlag = /isQuiting\s*=\s*true/.test(beforeQuit)

check('D1', 'before-quit 会等待写盘完成（await / preventDefault）', awaitsWrite,
  beforeQuit.trim() || '（未找到 before-quit 处理）')

check('D2', 'before-quit 设置了退出标志（供异步写盘收口用）', hasQuitFlag,
  beforeQuit.trim() || '（未找到 before-quit 处理）')

const wqIdx = mainJs.indexOf("app.on('will-quit'")
const willQuit = wqIdx >= 0
  ? mainJs.slice(wqIdx, mainJs.indexOf("\n  app.on(", wqIdx + 10))
  : ''
check('D3', 'will-quit 有兜底收口', willQuit.trim().length > 0, willQuit.trim() || '（未找到 will-quit 处理）')

// ---------------------------------------------------------------- 汇总

console.log('\n================= 独立抽查汇总 =================')
const warns = results.filter(r => !r.pass)
console.log('总计 ' + results.length + ' 项，PASS ' + (results.length - warns.length) + '，WARN ' + warns.length)
console.log('（WARN 表示源码层看不出该保证，需靠 e2e 运行时验证兜底）')
process.exit(0)
