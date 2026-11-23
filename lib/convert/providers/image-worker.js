'use strict'

/**
 * 图片 provider（主进程版，通过隐藏渲染窗口用 canvas 做解码/编码）。
 *
 * 与 providers/image.js 的关系：
 *   - providers/image.js  是**契约与路由逻辑**（纯逻辑，可单测）
 *   - providers/image-worker.js 是**主进程接线**（把 worker-host 的 IPC 注入进去）
 *
 * 为什么分两个文件：契约层不该知道 Electron 的存在，
 * 否则就没法用 node:test 直接驱动（这项目一贯的做法）。
 */

const fs = require('fs')
const path = require('path')
const imageProvider = require('./image')
const { REASON } = require('../provider')

/**
 * 创建接了 worker 的图片 provider。
 *
 * @param {object} deps
 * @param {object} deps.host  worker-host 实例（decode/encode）
 * @returns {object} provider
 */
function createImageWorkerProvider (deps = {}) {
  const host = deps.host

  /**
   * 解码：交给 worker。
   * @param {string} filePath
   */
  async function decode (filePath) {
    if (!host || typeof host.decode !== 'function') return null
    const r = await host.decode(filePath)
    if (!r || !r.ok) return null
    // canvas 不能跨 IPC 传；用 canvasId 做句柄，encode 时再取回
    return { canvasId: r.canvasId, width: r.width, height: r.height }
  }

  /**
   * 编码：交给 worker。
   * @param {object} img   {canvasId}
   * @param {string} mime
   * @param {string} ext
   */
  async function encode (img, mime, ext) {
    if (!host || typeof host.encode !== 'function') return null
    const r = await host.encode(img.canvasId, mime)
    if (!r || !r.ok || !r.bytes) return null
    // ★ worker 现在回传的是 Uint8Array（结构化克隆原生支持）。
    //   Buffer.from(Uint8Array) 是**拷贝**；若已是 Buffer 则直接用。
    //   兼容旧的普通数组形态（万一有旧 worker 残留）。
    if (Buffer.isBuffer(r.bytes)) return r.bytes
    if (r.bytes instanceof Uint8Array) return Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength)
    return Buffer.from(r.bytes)
  }

  // 复用契约层的路由/能力逻辑，只替换 decode/encode 两个动作
  const base = imageProvider.createImageProvider({
    decode,
    encode: (img, mime, ext) => encode(img, mime, ext)
  })

  // 契约层的 encode 期望 (canvas, mime) → 目标格式；这里要拿到扩展名来选 mime。
  // 契约层已经保证了 TARGET_EXTS 白名单，所以 mime 一定是我们支持的。
  return Object.assign({}, base, {
    id: 'builtin-image',
    name: '内置图片转换'
  })
}

module.exports = { createImageWorkerProvider }
