'use strict'

/**
 * 划词弹窗外观工具（双环境 UMD，同时支持 Node CommonJS 与浏览器 window.StickyPopupAppearance）。
 * 统一规范颜色、透明度钳制、明暗对比度判定，并负责将样式变量同步到页面根节点。
 */
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api
  } else if (root) {
    root.StickyPopupAppearance = api
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MIN_OPACITY = 0.2
  const MAX_OPACITY = 1

  const DEFAULT_POPUP_APPEARANCE = {
    toolbar: { color: '#23272f', opacity: 1 },
    answer: { color: '#1e222a', opacity: 1 }
  }

  const PRESET_COLORS = [
    '#23272f',
    '#1e222a',
    '#162033',
    '#2d2438',
    '#ffffff',
    '#f8fafc',
    '#fff6d6',
    '#e6f4ea'
  ]

  function normalizeHex (hex, fallback) {
    const fb = typeof fallback === 'string' && /^#[0-9a-f]{6}$/i.test(fallback)
      ? fallback.toLowerCase()
      : '#23272f'
    if (typeof hex !== 'string') return fb
    let h = hex.trim()
    if (!h.startsWith('#')) h = '#' + h
    if (/^#[0-9a-f]{3}$/i.test(h)) {
      h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]
    }
    return /^#[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : fb
  }

  function normalizeOpacity (val, fallback) {
    const fb = Number.isFinite(Number(fallback)) ? Number(fallback) : 1
    const raw = (val === '' || val === null || val === undefined) ? NaN : Number(val)
    const num = Number.isFinite(raw) ? raw : fb
    const clamped = Math.min(Math.max(num, MIN_OPACITY), MAX_OPACITY)
    return Math.round(clamped * 100) / 100
  }

  function normalizeItem (rawItem, baseItem) {
    const src = (rawItem && typeof rawItem === 'object') ? rawItem : {}
    return {
      color: normalizeHex(src.color, baseItem.color),
      opacity: normalizeOpacity(src.opacity, baseItem.opacity)
    }
  }

  function normalizePopupAppearance (raw, base) {
    const ref = (base && typeof base === 'object') ? base : DEFAULT_POPUP_APPEARANCE
    const baseToolbar = normalizeItem(ref.toolbar, DEFAULT_POPUP_APPEARANCE.toolbar)
    const baseAnswer = normalizeItem(ref.answer, DEFAULT_POPUP_APPEARANCE.answer)
    const src = (raw && typeof raw === 'object') ? raw : {}
    return {
      toolbar: normalizeItem(src.toolbar, baseToolbar),
      answer: normalizeItem(src.answer, baseAnswer)
    }
  }

  function hexToRgb (hex) {
    const h = normalizeHex(hex, '#23272f').slice(1)
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    }
  }

  function luminance (rgb) {
    const c = (rgb && typeof rgb === 'object') ? rgb : { r: 35, g: 39, b: 47 }
    const f = (v) => {
      const n = v / 255
      return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }

  function isLightColor (hex) {
    return luminance(hexToRgb(hex)) >= 0.45
  }

  function rgbaString (hex, opacity) {
    const { r, g, b } = hexToRgb(hex)
    const a = Number(normalizeOpacity(opacity, 1).toFixed(2))
    return `rgba(${r}, ${g}, ${b}, ${a})`
  }

  function applyPopupAppearance (doc, raw) {
    const cfg = normalizePopupAppearance(raw)
    if (doc && doc.documentElement) {
      const root = doc.documentElement
      root.style.setProperty('--ai-bar-bg', rgbaString(cfg.toolbar.color, cfg.toolbar.opacity))
      root.style.setProperty('--ai-panel-bg', rgbaString(cfg.answer.color, cfg.answer.opacity))
      root.dataset.aiBarTone = isLightColor(cfg.toolbar.color) ? 'light' : 'dark'
      root.dataset.aiPanelTone = isLightColor(cfg.answer.color) ? 'light' : 'dark'
    }
    return cfg
  }

  return {
    MIN_OPACITY,
    MAX_OPACITY,
    DEFAULT_POPUP_APPEARANCE,
    PRESET_COLORS,
    normalizeHex,
    normalizeOpacity,
    normalizePopupAppearance,
    hexToRgb,
    luminance,
    isLightColor,
    rgbaString,
    applyPopupAppearance
  }
})
