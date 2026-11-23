'use strict'

/**
 * 预加载脚本：向渲染进程暴露受限的 IPC 能力（contextIsolation 开启，渲染层无 Node 权限）
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('sticky', {
  platform: process.platform,
  getPathForFile: (file) => {
    if (!file) return ''
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file) || ''
      }
    } catch (_) {}
    return typeof file.path === 'string' ? file.path : ''
  },

  // ---- 当前便签（窗口身份由主进程按 webContents 反查，渲染层无需传 id）
  getNote: () => ipcRenderer.invoke('note:get'),
  // 同步写主进程内存（N-01）；真正落盘与结果回传走 flush()（N-04）
  update: (patch) => ipcRenderer.sendSync('note:update', patch),
  flush: () => ipcRenderer.invoke('note:flush'),
  getBounds: () => ipcRenderer.invoke('note:get-bounds'),
  setBounds: (b) => ipcRenderer.invoke('note:set-bounds', b),
  duplicate: () => ipcRenderer.invoke('note:duplicate'),
  remove: () => ipcRenderer.invoke('note:delete'),
  hide: () => ipcRenderer.invoke('note:hide'),
  focus: () => ipcRenderer.invoke('note:focus'),
  create: (seed) => ipcRenderer.invoke('note:create', seed),

  // ---- 边缘收缩（贴边收纳）
  collapse: (edge) => ipcRenderer.invoke('note:collapse', edge),
  expand: () => ipcRenderer.invoke('note:expand'),
  engage: () => ipcRenderer.invoke('note:engage'),
  collapseState: () => ipcRenderer.invoke('note:collapse-get'),
  onCollapseState: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('note:collapse-state', h)
    return () => ipcRenderer.removeListener('note:collapse-state', h)
  },

  globalSelect: (on) => ipcRenderer.invoke('settings:global-select', on),
  popupAppearance: (patch) => ipcRenderer.invoke('settings:popup-appearance', patch),
  onPopupAppearanceChanged: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('settings:popup-appearance-changed', h)
    return () => ipcRenderer.removeListener('settings:popup-appearance-changed', h)
  },

  // ---- 便签中心
  edgeGroups: (enabled) => ipcRenderer.invoke('settings:edge-groups', enabled),
  toggleEdgeGroup: (expanded) => ipcRenderer.invoke('edge-group:toggle', expanded),
  onEdgeGroupState: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('edge-group:state', handler)
    return () => ipcRenderer.removeListener('edge-group:state', handler)
  },
  importNotes: () => ipcRenderer.invoke('notes:import'),
  exportNote: (format) => ipcRenderer.invoke('note:export', format),
  search: (keyword) => ipcRenderer.invoke('notes:search', keyword),
  list: () => ipcRenderer.invoke('notes:list'),
  action: (id, action, value) => ipcRenderer.invoke('notes:action', { id, action, value }),
  createFromCenter: (seed) => ipcRenderer.invoke('notes:create', seed),
  showAll: () => ipcRenderer.invoke('notes:show-all'),
  hideAll: () => ipcRenderer.invoke('notes:hide-all'),
  openDashboard: () => ipcRenderer.invoke('app:open-dashboard'),
  backup: () => ipcRenderer.invoke('app:backup'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),

  // ---- AI 供应商（Key 只在主进程里，渲染层永远拿不到明文）
  aiConfig: () => ipcRenderer.invoke('ai:config'),
  aiSaveProvider: (payload) => ipcRenderer.invoke('ai:provider-save', payload),
  aiDeleteProvider: (id) => ipcRenderer.invoke('ai:provider-delete', id),
  aiActivateProvider: (id) => ipcRenderer.invoke('ai:provider-activate', id),
  aiFetchModels: (payload) => ipcRenderer.invoke('ai:models', payload),
  aiAsk: (payload) => ipcRenderer.invoke('ai:ask', payload),
  aiAbort: (requestId) => ipcRenderer.invoke('ai:abort', requestId),
  onAiEvent: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('ai:event', h)
    return () => ipcRenderer.removeListener('ai:event', h)
  },

  // ---- 全局划词悬浮层（系统级选中时由主进程唤起）
  onOverlayShow: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('overlay:show', h)
    return () => ipcRenderer.removeListener('overlay:show', h)
  },
  onOverlayShowCard: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('overlay:show-card', h)
    return () => ipcRenderer.removeListener('overlay:show-card', h)
  },
  overlaySize: (payload) => ipcRenderer.invoke('overlay:size', payload),
  overlayMove: (payload) => ipcRenderer.invoke('overlay:move', payload),
  overlayPin: (on) => ipcRenderer.invoke('overlay:pin', on),
  overlayPinCard: (payload) => ipcRenderer.invoke('overlay:pin-card', payload),
  // 「向 AI 提问」的输入框需要键盘焦点：悬浮窗是 showInactive 显示的，必须显式激活
  overlayFocus: () => ipcRenderer.invoke('overlay:focus'),
  overlayClose: () => ipcRenderer.invoke('overlay:close'),
  overlayOpenCard: (payload) => ipcRenderer.invoke('overlay:open-card', payload),
  overlayShowBar: (payload) => ipcRenderer.invoke('overlay:show-bar', payload),
  overlayHideBar: () => ipcRenderer.invoke('overlay:hide-bar'),
  overlayDismissUnpinned: () => ipcRenderer.invoke('overlay:dismiss-unpinned'),
  overlayInsertToNote: (text) => ipcRenderer.invoke('overlay:insert-note', text),
  onAiInsert: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('note:ai-insert', h)
    return () => ipcRenderer.removeListener('note:ai-insert', h)
  },
  copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
  /** 渲染层全局异常上报（见 src/guard.js） */
  reportClientError: (payload) => ipcRenderer.invoke('app:client-error', payload),

  // ---- 图片
  storeImage: (dataUrl, legacy = false) => ipcRenderer.sendSync('image:store', dataUrl, legacy),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  copyImage: (source) => ipcRenderer.invoke('image:copy', source),
  previewImage: (payload) => ipcRenderer.invoke('image:preview', payload),
  startCapture: () => ipcRenderer.invoke('capture:start'),
  grabRegion: (rect) => ipcRenderer.invoke('capture:grab', rect),
  finishCapture: (payload) => ipcRenderer.invoke('capture:done', payload),
  copyCapture: (payload) => ipcRenderer.invoke('capture:copy', payload),
  saveCapture: (payload) => ipcRenderer.invoke('capture:save', payload),
  cancelCapture: () => ipcRenderer.invoke('capture:cancel'),
  onCaptureInit: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('capture:init', h)
    return () => ipcRenderer.removeListener('capture:init', h)
  },
  /** 全局 Esc（主进程转发）：窗口没焦点时也能收到 */
  onCaptureEscape: (cb) => {
    const h = () => cb()
    ipcRenderer.on('capture:escape', h)
    return () => ipcRenderer.removeListener('capture:escape', h)
  },
  onCaptureDone: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('capture:done', h)
    return () => ipcRenderer.removeListener('capture:done', h)
  },
  onPreviewInit: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('preview:init', h)
    return () => ipcRenderer.removeListener('preview:init', h)
  },

  // ---- Mermaid 画板
  openDiagram: (ctx) => ipcRenderer.invoke('diagram:open', ctx),
  applyDiagram: (payload) => ipcRenderer.invoke('diagram:apply', payload),
  closeDiagram: () => ipcRenderer.invoke('diagram:close'),
  onDiagramInit: (cb) => {
    const h = (_e, ctx) => cb(ctx)
    ipcRenderer.on('diagram:init', h)
    return () => ipcRenderer.removeListener('diagram:init', h)
  },
  onDiagramApplied: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('diagram:applied', h)
    return () => ipcRenderer.removeListener('diagram:applied', h)
  },

  // ---- 格式转换（资源管理器右键菜单入口）
  convertCapabilities: (ext) => ipcRenderer.invoke('convert:capabilities', ext),
  convertRun: (payload) => ipcRenderer.invoke('convert:run', payload),
  convertEngines: () => ipcRenderer.invoke('convert:engines'),
  onConvertFiles: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('convert:files', h)
    return () => ipcRenderer.removeListener('convert:files', h)
  },
  // 转换进度（全部页 PDF→图片）：主进程按发起窗口定向推送。
  // payload: { reqId, source, page, total, done, failed, phase }
  onConvertProgress: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('convert:progress', h)
    return () => ipcRenderer.removeListener('convert:progress', h)
  },
  // 转换失败的提示：走非模态小窗，不阻塞 app.quit()
  onConvertError: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('convert:error', h)
    return () => ipcRenderer.removeListener('convert:error', h)
  },

  // ---- 资源管理器右键菜单（注册表动词）
  explorerVerbStatus: () => ipcRenderer.invoke('app:explorer-verb-status'),
  explorerVerbInstall: () => ipcRenderer.invoke('app:explorer-verb-install'),
  explorerVerbUninstall: () => ipcRenderer.invoke('app:explorer-verb-uninstall'),

  // ---- 学术文献 PDF 翻译（AIdea 风格本地一次性代理 + pdf2zh_next / server）
  pdfTranslateStatus: () => ipcRenderer.invoke('pdf-translate:status'),
  pdfTranslateSaveConfig: (patch) => ipcRenderer.invoke('pdf-translate:save-config', patch),
  pdfTranslatePickPdf: () => ipcRenderer.invoke('pdf-translate:pick-pdf'),
  pdfTranslateOpenFolder: (filePath) => ipcRenderer.invoke('pdf-translate:open-folder', filePath),
  pdfTranslateRun: (opts) => ipcRenderer.invoke('pdf-translate:run', opts),
  pdfTranslateCancel: (jobId) => ipcRenderer.invoke('pdf-translate:cancel', jobId),
  pdfTranslateInstallEnv: (opts) => ipcRenderer.invoke('pdf-translate:install-env', opts),
  pdfTranslateCancelInstall: (installId) => ipcRenderer.invoke('pdf-translate:cancel-install', installId),
  onPdfTranslateProgress: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('pdf-translate:progress', h)
    return () => ipcRenderer.removeListener('pdf-translate:progress', h)
  },
  onPdfTranslateInstallProgress: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('pdf-translate:install-progress', h)
    return () => ipcRenderer.removeListener('pdf-translate:install-progress', h)
  },

  // ---- 数据变更订阅
  onNotesChanged: (cb) => {
    const handler = (_e, notes) => cb(notes)
    ipcRenderer.on('notes:changed', handler)
    return () => ipcRenderer.removeListener('notes:changed', handler)
  }
})
