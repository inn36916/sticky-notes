'use strict'

/**
 * 默认 provider 列表（组装入口）。
 *
 * 顺序很重要：注册表按顺序取「第一个能处理 (ext → target) 的可用 provider」，
 * 所以**内置 provider 放前面**（快路径、零依赖），Filee 放后面（长尾 + 保真度）。
 *
 * 2026-11-16 的决策背景：
 *   用户不想装 Filee，要直接用它的转换能力。核验结论是：
 *   嵌入 Filee 的 C# 代码 = 我方要装 .NET 10 SDK + self-contained 运行时（+132MB），
 *   体积与「装 Filee」完全相同，还要多背一个语言栈。
 *   ⇒ 改成可插拔 provider：内置 provider 覆盖零依赖的高频格式，
 *     Filee 保留为**可选增强**（装了自动生效，没装不影响）。
 */

const textData = require('./text-data')
const image = require('./image')
const imageWorker = require('./image-worker')
const pdf = require('./pdf')
const documentProvider = require('./document')
const spreadsheet = require('./spreadsheet')
const svg = require('./svg')
const filee = require('./filee')
const plugins = require('../plugins')

/**
 * 创建默认的 provider 列表。
 *
 * 顺序即优先级：
 *   ① 内置图片（走 canvas；零依赖快路径）
 *   ② 内置 PDF（pdf-lib 图片→PDF；pdfjs PDF→图/文本，走 worker）
 *   ③ 内置文本与数据（纯 JS，永远可用）
 *   ④ 内置文档（docx / html / md ↔ md / html / txt / pdf，pdf→md）
 *   ⑤ 内置表格（xlsx ↔ csv / json / md）
 *   ⑥ 插件引擎（用户投放的转换代码，无需改核心即可接入）
 *   ⑦ 内置 SVG 矢量（开箱即用，排在插件之后以允许插件覆盖）
 *   ⑧ Filee（可选增强：装了就有额外格式）
 *
 * @param {object} [opts]
 * @param {object} [opts.workerHost]  worker-host 实例（提供图片编解码）
 * @param {string} [opts.appDir]      应用目录（探测便携形态 Filee）
 * @param {string} [opts.userDataDir] 用户数据目录（插件投放位置）
 * @param {function} [opts.resolveBin] Filee CLI 路径解析（测试用）
 * @param {object} [opts.cli]         Filee CLI 层（测试用）
 * @param {boolean} [opts.withFilee]   是否包含 Filee provider（默认 true）
 * @param {boolean} [opts.withPlugins] 是否加载插件（默认 true）
 * @param {function} [opts.log]        日志函数
 * @returns {Array} provider 列表
 */
function createDefaultProviders (opts = {}) {
  const list = []

  // ① 内置图片（走 canvas；需要 worker 宿主）
  if (opts.workerHost) {
    list.push(imageWorker.createImageWorkerProvider({ host: opts.workerHost }))
  } else {
    // 没有 worker 时仍然注册，只是 available() 为 false —— 框架会自动跳过
    list.push(image.createImageProvider({}))
  }

  // ② 内置 PDF（开箱即用，不做成需投放的插件）
  //   ★ 放在内置图片之后、文本之前：图片 → PDF 的优先级高于 Filee，
  //     而 PDF → png/jpg/webp/txt 由本 provider 精确声明，不会截胡
  //     png → jpg 这类本属于 builtin-image 的组合（canHandle 做了白名单）。
  list.push(pdf.createPdfProvider({ workerHost: opts.workerHost || null }))

  // ③ 内置文本与数据（纯 JS，永远可用）
  list.push(textData.createTextDataProvider())

  // ④ 内置文档（docx / html / md / pdf→md）
  list.push(documentProvider.createDocumentProvider({ workerHost: opts.workerHost || null }))

  // ⑤ 内置表格（xlsx ↔ csv / json / md）
  list.push(spreadsheet.createSpreadsheetProvider())

  // ⑥ 插件引擎（用户投放的转换代码）
  //   加载失败只记日志、不阻断 —— 插件是可选增强，绝不能让应用起不来。
  if (opts.withPlugins !== false) {
    try {
      const loaded = plugins.loadPlugins({
        userDataDir: opts.userDataDir,
        appDir: opts.appDir,
        env: opts.env,
        log: opts.log,
        context: {
          appDir: opts.appDir || '',
          userDataDir: opts.userDataDir || '',
          workerHost: opts.workerHost || null,
          log: opts.log || (() => {})
        }
      })
      for (const p of loaded.providers) list.push(p)
      if (loaded.errors && loaded.errors.length && typeof opts.log === 'function') {
        for (const e of loaded.errors) {
          opts.log('[convert-plugins] 跳过 ' + e.file + '：' + e.error)
        }
      }
    } catch (err) {
      if (typeof opts.log === 'function') {
        opts.log('[convert-plugins] 加载异常：' + ((err && err.message) || String(err)))
      }
    }
  }

  // ⑦ 内置 SVG 矢量（排在插件之后：有插件时插件优先，无插件时开箱即用）
  list.push(svg.createSvgProvider({
    workerHost: opts.workerHost || null,
    log: opts.log
  }))

  // ⑧ Filee（可选增强：装了就有额外格式）
  if (opts.withFilee !== false) {
    list.push(filee.createFileeProvider({
      appDir: opts.appDir || '',
      resolveBin: opts.resolveBin,
      cli: opts.cli
    }))
  }

  return list
}

module.exports = {
  createDefaultProviders,
  textData,
  image,
  imageWorker,
  pdf,
  document: documentProvider,
  spreadsheet,
  svg,
  filee,
  plugins
}
