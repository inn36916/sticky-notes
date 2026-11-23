'use strict'

/**
 * 落盘 worker 线程（只被 lib/save-writer.js 拉起，不要直接用）。
 *
 * 为什么要 worker：
 * 主进程把整个 state（12MB 便签时含大量 base64 图片）JSON.stringify 一次，
 * 实测 ~17ms 纯 CPU；再加同步写盘 ~8ms。两者都在**主进程主线程**上，
 * 于是「正在落盘」的那 30ms 内，渲染层任何 sendSync 的 note:update 都会被排队 ——
 * 这正是「打字停顿后的第一键要等 ~95ms」的直接原因。
 *
 * worker 里做 stringify + 写盘 + rename，主线程只负责：
 *   - postMessage：把 state 结构化克隆给 worker（实测 ~7ms，比 stringify 便宜）
 *   - 等 worker 回话，把真实 {ok,error} 转给渲染层（N-04）
 *
 * 原子替换语义（.tmp + rename）与「同一天只写一次」的按天快照都在 worker 里执行，
 * 与主进程写完全等价（见 lib/persistence.js 的 atomicWriteFile）。
 */
const { parentPort } = require('worker_threads')
const persistence = require('./persistence')

parentPort.on('message', async (msg) => {
  const { id, dataFile, state, snapshot } = msg || {}
  try {
    // 走 persistence.writeState：紧凑 JSON + 原子替换（.tmp + rename）+ 按天快照，
    // 全部与主进程内联写盘完全同源（同一份实现，不会两套语义）。
    const r = await persistence.writeState(dataFile, state, { snapshot: !!snapshot })
    parentPort.postMessage({
      id,
      ok: r.ok,
      error: r.error,
      snapshotPath: r.snapshotPath
    })
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: err && err.message ? err.message : String(err),
      snapshotPath: null
    })
  }
})
