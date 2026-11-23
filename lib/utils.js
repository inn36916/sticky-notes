'use strict'

/**
 * 公共基础工具（双环境 UMD，同时支持 Node CommonJS 与渲染层全局变量 window.StickyUtils）。
 * 消除主进程 / 转换层 / 渲染层多处重复手写 escapeHtml、clamp、SAFE_NAME 的漂移风险。
 */
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api
  } else if (root) {
    root.StickyUtils = api
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /** 文件名安全字符集：保留字母数字、下划线、点、短横线、常用中文、空格与括号 */
  const SAFE_NAME = /[^\w.\-一-龥 ()]+/g

  const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }

  /**
   * 将数值限制在 [lo, hi] 闭区间（若 hi < lo 则安全回落到 lo）。
   * @param {number} v
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  function clamp (v, lo, hi) {
    return Math.min(Math.max(v, lo), Math.max(lo, hi))
  }

  /**
   * 转义 HTML 特殊字符（null/undefined 安全转为空串）。
   * @param {*} s
   * @returns {string}
   */
  function escapeHtml (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => HTML_ENTITIES[c])
  }

  return {
    SAFE_NAME,
    clamp,
    escapeHtml
  }
})
