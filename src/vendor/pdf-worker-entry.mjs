'use strict'

/**
 * pdfjs worker 的兼容入口（不要删）。
 *
 * 根因（2026-11-17 真机实测）：
 *   pdfjs-dist 6.5.438 的 pdf.worker.min.mjs 调用了多个 Electron 33 的
 *   Chromium 130 尚未实现的 API（Uint8Array#toHex、Map#getOrInsertComputed、
 *   Promise#withResolvers 等），直接加载会在 getDocument() 阶段抛
 *   `UnknownErrorException` / `TypeError`，第一页都渲染不出来。
 *
 * 为什么用"入口 + 动态 import"而不是改第三方产物：
 *   ① 不改官方文件，升级 pdfjs 时直接覆盖 vendor 文件即可；
 *   ② ES module 的静态 import 在本模块代码**之前**求值，
 *      静态 import worker 的话补丁还没装好就跑了；
 *      动态 import() 在补丁装好之后才加载，顺序才有保证。
 *
 * 只复制必要的三个文件（pdf.min.mjs / pdf.worker.min.mjs / 本入口）
 * + 共享的 pdf-polyfill.mjs，不把整个 node_modules 拷进渲染进程。
 */

import { installPdfPolyfills } from './pdf-polyfill.mjs'

installPdfPolyfills()

// 动态 import：保证补丁先于 pdfjs worker 模块体执行。
// 失败必须出声：否则 worker 活着却没有 onmessage，主进程只能等 30s 超时。
import('./pdf.worker.min.mjs').catch(err => {
  console.error('[pdf-worker] pdfjs worker 加载失败：' + ((err && err.message) || String(err)))
})
