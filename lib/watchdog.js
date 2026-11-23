'use strict'

/**
 * 流式请求看门狗（纯模块，不依赖 Electron，可用 node:test 覆盖）。
 *
 * 背景：AI SSE 只有「用户点停止」才 abort。若服务端建立了连接却不再吐字
 * （网关挂死、上游卡住、网络半开），界面会永远停在「生成中…」。
 *
 * 两条独立的红线：
 *   - idle：连续 idleMs 没收到任何增量 → 视为流已死
 *   - total：整轮超过 totalMs → 无论是否有增量都收尾，避免无限续命
 *
 * 触发时只回调一次；调用方在回调里 abort(fetch)，并在 catch 里用 reason
 * 区分「超时」和「用户主动取消」（两者都会抛 AbortError）。
 */

const DEFAULT_IDLE_MS = 45000
const DEFAULT_TOTAL_MS = 180000

function createWatchdog (opts = {}) {
  const idleMs = Number(opts.idleMs) > 0 ? Math.round(Number(opts.idleMs)) : DEFAULT_IDLE_MS
  const totalMs = Number(opts.totalMs) > 0 ? Math.round(Number(opts.totalMs)) : DEFAULT_TOTAL_MS
  const setT = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout
  const clearT = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout
  const onTimeout = typeof opts.onTimeout === 'function' ? opts.onTimeout : function () {}

  let idleTimer = null
  let totalTimer = null
  let reason = ''            // '' | 'idle' | 'total'
  let started = false
  let stopped = false

  function clearIdle () {
    if (idleTimer !== null) { clearT(idleTimer); idleTimer = null }
  }
  function clearAll () {
    clearIdle()
    if (totalTimer !== null) { clearT(totalTimer); totalTimer = null }
  }

  function fire (why) {
    if (reason || stopped) return
    reason = why
    clearAll()
    try { onTimeout(why) } catch (_) {}
  }

  /** 收到增量时调用：重置空闲计时 */
  function touch () {
    if (stopped || reason) return
    clearIdle()
    idleTimer = setT(function () { fire('idle') }, idleMs)
  }

  function start () {
    if (started) return
    started = true
    stopped = false
    totalTimer = setT(function () { fire('total') }, totalMs)
    touch()
  }

  /** 正常结束 / 已处理完错误后调用：不再触发任何回调 */
  function stop () {
    stopped = true
    clearAll()
  }

  return {
    start,
    touch,
    stop,
    get reason () { return reason },
    get idleMs () { return idleMs },
    get totalMs () { return totalMs }
  }
}

/** 把超时原因翻译成用户能看懂的一句话 */
function describeTimeout (reason, opts = {}) {
  const idleMs = Number(opts.idleMs) > 0 ? Number(opts.idleMs) : DEFAULT_IDLE_MS
  const totalMs = Number(opts.totalMs) > 0 ? Number(opts.totalMs) : DEFAULT_TOTAL_MS
  const sec = (ms) => Math.max(1, Math.round(ms / 1000))
  if (reason === 'idle') return '响应超时：' + sec(idleMs) + ' 秒没有收到新内容，请重试或换个模型'
  if (reason === 'total') return '响应超时：本轮超过 ' + sec(totalMs) + ' 秒仍未完成，请缩短选中文本或换个模型'
  return ''
}

module.exports = {
  DEFAULT_IDLE_MS,
  DEFAULT_TOTAL_MS,
  createWatchdog,
  describeTimeout
}
