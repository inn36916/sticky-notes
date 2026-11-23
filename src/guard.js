'use strict'

/**
 * 渲染层全局异常兜底（在其它脚本之前加载）。
 *
 * 之前渲染层没有任何 window.onerror / unhandledrejection 处理：脚本一旦抛错，
 * 表现就是「按钮点了没反应」或界面停在半途，控制台里也看不到（打包后无控制台）。
 * 这里做三件事：
 *   1. 捕获 error / unhandledrejection / 资源加载失败
 *   2. 屏幕下方给一条可见提示（限流，不打断操作）
 *   3. 上报主进程落进 app-errors.log，方便事后定位
 *
 * 注意：本文件必须自包含（不依赖任何页面 DOM/样式），且自身不能抛错。
 */
;(function () {
  if (typeof window === 'undefined' || window.__stickyGuardInstalled) return
  window.__stickyGuardInstalled = true

  var MAX_REPORTS = 20              // 单页面生命周期内最多上报 20 条，防刷爆
  var BANNER_COOLDOWN = 500         // 连续异常时最多每 0.5s 刷新一次文案（防止逐帧写 DOM）
  var BANNER_LIFE = 6000
  var reported = 0
  var lastBannerAt = 0
  var reporting = false

  function truncate (s, n) {
    s = String(s == null ? '' : s)
    return s.length > n ? s.slice(0, n) + '…' : s
  }

  function isBenign (msg) {
    // ResizeObserver 的循环告警在 Chromium 里属于已知噪声，不影响功能
    return /ResizeObserver loop/i.test(msg)
  }

  function ensureBanner (text) {
    var el = document.getElementById('__stickyGuardTip')
    if (!el) {
      if (!document.body) return
      el = document.createElement('div')
      el.id = '__stickyGuardTip'
      el.setAttribute('role', 'status')
      el.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:18px', 'transform:translateX(-50%)',
        'max-width:calc(100% - 40px)', 'padding:8px 14px', 'border-radius:10px',
        'background:rgba(150,32,32,.94)', 'color:#fff', 'font-size:12px',
        'line-height:1.5', 'font-family:inherit', 'z-index:2147483647',
        'pointer-events:none', 'opacity:0', 'transition:opacity .18s ease',
        'box-shadow:0 6px 18px rgba(0,0,0,.28)', 'text-align:center'
      ].join(';')
      document.body.appendChild(el)
    }
    el.textContent = text
    el.style.opacity = '1'
    clearTimeout(el.__hideTimer)
    el.__hideTimer = setTimeout(function () { el.style.opacity = '0' }, BANNER_LIFE)
  }

  function notify (text) {
    var now = Date.now()
    if (now - lastBannerAt < BANNER_COOLDOWN) return
    lastBannerAt = now
    try {
      if (document.body) ensureBanner(text)
      else document.addEventListener('DOMContentLoaded', function () { ensureBanner(text) }, { once: true })
    } catch (_) {}
  }

  function report (payload) {
    if (reported >= MAX_REPORTS || reporting) return
    reported++
    reporting = true
    try {
      var api = window.sticky
      if (api && typeof api.reportClientError === 'function') {
        var p = api.reportClientError(payload)
        // 上报本身失败必须吞掉，否则会触发 unhandledrejection → 递归上报
        if (p && typeof p.catch === 'function') p.catch(function () {})
      }
    } catch (_) {
    } finally {
      reporting = false
    }
  }

  function handle (kind, message, stack, extra) {
    var msg = String(message == null ? '' : message) || '未知错误'
    if (isBenign(msg)) return
    var payload = {
      kind: kind,
      message: truncate(msg, 2000),
      stack: truncate(stack, 6000),
      url: truncate(typeof location !== 'undefined' ? location.href : '', 300),
      source: truncate((extra && extra.source) || '', 300),
      line: (extra && extra.line) || 0,
      col: (extra && extra.col) || 0,
      at: Date.now()
    }
    try { console.error('[guard]', kind, msg) } catch (_) {}
    report(payload)
    notify('便签遇到异常，已记录：' + truncate(msg, 48) + '（如界面异常可重启便签）')
  }

  window.addEventListener('error', function (ev) {
    // 资源加载失败（img/script/link）走捕获阶段，没有 message
    var t = ev && ev.target
    if (t && t !== window && t.tagName) {
      var tag = String(t.tagName).toLowerCase()
      if (tag === 'img' || tag === 'script' || tag === 'link') {
        handle('resource', tag + ' 加载失败: ' + (t.src || t.href || ''), '')
        return
      }
    }
    handle('error', ev && ev.message, ev && ev.error && ev.error.stack, {
      source: ev && ev.filename,
      line: ev && ev.lineno,
      col: ev && ev.colno
    })
  }, true)

  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason
    var msg = (r && r.message) || String(r == null ? '' : r) || '未处理的 Promise 拒绝'
    handle('rejection', msg, r && r.stack)
  })
})()
