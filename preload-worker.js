'use strict'

/**
 * 转换工作器专用预加载脚本（最小权限原则）。
 *
 * 只向隐藏的 convert-worker.html 暴露 canvas 编解码、SVG 光栅化、PDF 渲染/文本抽取
 * 所需的通道及错误上报能力；不暴露便签数据、剪贴板、AI 配置或注册表能力，
 * 也不暴露任意文件读取接口（文件字节由主进程读取后随 IPC 任务安全下发）。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sticky', {
  platform: process.platform,

  /** 渲染层全局异常上报（见 src/guard.js） */
  reportClientError: (payload) => ipcRenderer.invoke('app:client-error', payload),

  onWorkerDecode: (cb) => {
    const h = (_e, reqId, bytes, mime) => cb(reqId, bytes, mime)
    ipcRenderer.on('convert:worker-decode', h)
    return () => ipcRenderer.removeListener('convert:worker-decode', h)
  },
  onWorkerEncode: (cb) => {
    const h = (_e, reqId, canvasId, mime) => cb(reqId, canvasId, mime)
    ipcRenderer.on('convert:worker-encode', h)
    return () => ipcRenderer.removeListener('convert:worker-encode', h)
  },
  onWorkerRenderSvg: (cb) => {
    const h = (_e, reqId, svgText, opts) => cb(reqId, svgText, opts)
    ipcRenderer.on('convert:worker-render-svg', h)
    return () => ipcRenderer.removeListener('convert:worker-render-svg', h)
  },
  onWorkerRenderPdf: (cb) => {
    const h = (_e, reqId, bytes, opts) => cb(reqId, bytes, opts)
    ipcRenderer.on('convert:worker-render-pdf', h)
    return () => ipcRenderer.removeListener('convert:worker-render-pdf', h)
  },
  onWorkerExtractPdfText: (cb) => {
    const h = (_e, reqId, bytes, opts) => cb(reqId, bytes, opts)
    ipcRenderer.on('convert:worker-extract-pdf-text', h)
    return () => ipcRenderer.removeListener('convert:worker-extract-pdf-text', h)
  },
  onWorkerExtractPdfStructured: (cb) => {
    const h = (_e, reqId, bytes, opts) => cb(reqId, bytes, opts)
    ipcRenderer.on('convert:worker-extract-pdf-structured', h)
    return () => ipcRenderer.removeListener('convert:worker-extract-pdf-structured', h)
  },
  onWorkerTranscodeImage: (cb) => {
    const h = (_e, reqId, bytes, mime, opts) => cb(reqId, bytes, mime, opts)
    ipcRenderer.on('convert:worker-transcode-image', h)
    return () => ipcRenderer.removeListener('convert:worker-transcode-image', h)
  },

  workerDecoded: (reqId, payload) => ipcRenderer.send('convert:worker-decoded', reqId, payload),
  workerEncoded: (reqId, payload) => ipcRenderer.send('convert:worker-encoded', reqId, payload)
})
