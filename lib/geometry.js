'use strict'

/**
 * 纯几何模块（不依赖 Electron，可直接用 node:test 覆盖）。
 *
 * 单一真源约定：note.bounds 恒为「展开态」几何；收纳态的 50 DIP 窄条是派生值，
 * 任何路径都不得把它写回 note.bounds（L-1 的根因）。
 */

const MIN_W = 260
const MIN_H = 200
const DEFAULT_W = 400
const DEFAULT_H = 500
const COLLAPSE_MAX = 60        // ≤ 此值即视为收纳窄条（COLLAPSE_W/H = 50，留一点余量）

/** 是否是被收起后的窄条几何 */
function isCollapsedGeometry (b) {
  if (!b || typeof b !== 'object') return false
  const w = Number(b.width)
  const h = Number(b.height)
  return (Number.isFinite(w) && w <= COLLAPSE_MAX) ||
         (Number.isFinite(h) && h <= COLLAPSE_MAX)
}

/**
 * 校验并规范化「展开态」几何。全部写回点共用。
 *
 * 与 clampBounds 的区别：clampBounds 会把 50 钳成 260（生成「260×500 的面条」，
 * 等于承认污染）；这里对过小尺寸直接判非法，由调用方拒绝写回或走迁移自愈。
 *
 * @returns {{ok: boolean, reason: string, bounds: object|null}}
 */
function assertExpandedBounds (b, opts = {}) {
  const minW = opts.minW || MIN_W
  const minH = opts.minH || MIN_H
  if (!b || typeof b !== 'object') return { ok: false, reason: 'not-object', bounds: null }

  const x = Math.round(Number(b.x))
  const y = Math.round(Number(b.y))
  const width = Math.round(Number(b.width))
  const height = Math.round(Number(b.height))
  if (![x, y, width, height].every(Number.isFinite)) {
    return { ok: false, reason: 'non-finite', bounds: null }
  }
  if (width < minW || height < minH) {
    return { ok: false, reason: 'too-small', bounds: null }
  }

  const bounds = { x, y, width, height }
  const areas = opts.areas
  if (Array.isArray(areas) && areas.length) {
    const visible = areas.some(a =>
      x + width > a.x + 60 && x < a.x + a.width - 60 &&
      y + 40 > a.y && y < a.y + a.height - 40
    )
    if (!visible) return { ok: false, reason: 'off-screen', bounds: null }
  }
  return { ok: true, reason: '', bounds }
}

/**
 * 从运行时窗口几何生成可落盘的展开态 bounds。
 * 收口三处读窗口几何的写回点：commitBounds / note:set-bounds / before-quit。
 * 不修改 note —— 调用方只在 ok 时赋值，避免「读到了窄条还写回去」。
 */
function captureBounds (note, win, opts = {}) {
  if (!note || !win) return { ok: false, reason: 'no-target', bounds: null }
  if (note.collapsed) return { ok: false, reason: 'collapsed', bounds: null }
  if (typeof win.getBounds !== 'function') {
    return { ok: false, reason: 'no-window', bounds: null }
  }
  let nb
  try {
    nb = win.getBounds()
  } catch (_) {
    return { ok: false, reason: 'window-gone', bounds: null }
  }
  return assertExpandedBounds(nb, opts)
}

/**
 * 迁移期对存量污染 bounds 做自愈：非法维度回退默认值，合法维度保留。
 * 不校验坐标（坐标由 clampBounds 处理），避免把「位置跑偏」误判为尺寸污染。
 * @returns {{bounds: object, recovered: boolean, reason: string}}
 */
function recoverBounds (b, opts = {}) {
  const minW = opts.minW || MIN_W
  const minH = opts.minH || MIN_H
  const src = (b && typeof b === 'object') ? b : {}
  const x = Math.round(Number(src.x))
  const y = Math.round(Number(src.y))
  const w = Math.round(Number(src.width))
  const h = Math.round(Number(src.height))

  const badW = !Number.isFinite(w) || w < minW
  const badH = !Number.isFinite(h) || h < minH
  const badPos = !Number.isFinite(x) || !Number.isFinite(y)
  const bounds = {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: badW ? (opts.defaultW || DEFAULT_W) : w,
    height: badH ? (opts.defaultH || DEFAULT_H) : h
  }
  return {
    bounds,
    recovered: badW || badH || badPos || !src.width || !src.height,
    reason: (badW || badH) ? 'too-small' : (badPos ? 'non-finite' : '')
  }
}

/**
 * 内部写回点统一入口：候选几何非法时回退到上一份合法 bounds 或自愈值。
 * 用于 10 处「从已记录 bounds 派生新 bounds」的写回点，防止存量污染被放大。
 */
function safeExpandedBounds (candidate, fallback) {
  const r = assertExpandedBounds(candidate)
  if (r.ok) return r.bounds
  const fb = assertExpandedBounds(fallback)
  if (fb.ok) return fb.bounds
  return recoverBounds(candidate).bounds
}

/**
 * 退出时的几何收口：所有窗口统一走 captureBounds，收纳态一律跳过。
 * 这是 before-quit 唯一允许写 note.bounds 的入口（替代原先无条件 w.getBounds()）。
 * @param {Array<{note:object, win:object}>} entries
 */
function collectBoundsForQuit (entries, opts = {}) {
  const captured = []
  const skipped = []
  for (const item of (entries || [])) {
    const note = item && item.note
    const win = item && item.win
    const r = captureBounds(note, win, opts)
    if (!r.ok) {
      skipped.push({ id: note ? note.id : null, reason: r.reason })
      continue
    }
    note.bounds = r.bounds
    captured.push({ id: note.id, bounds: r.bounds })
  }
  return { captured, skipped }
}

module.exports = {
  MIN_W, MIN_H, DEFAULT_W, DEFAULT_H, COLLAPSE_MAX,
  isCollapsedGeometry,
  assertExpandedBounds,
  safeExpandedBounds,
  captureBounds,
  collectBoundsForQuit,
  recoverBounds
}
