'use strict'

/**
 * 转换服务层（编排，纯逻辑 + 可注入依赖，便于 node:test 直接驱动）。
 *
 * 职责边界：
 *   - filee-cli.js  ：只管「怎么调 Filee CLI、怎么解析它的输出」
 *   - service.js    ：管「一次转换请求的完整生命周期」——能力查询、产物落地、
 *                    失败分类、结果保存到各自源目录
 *   - main.js       ：管 Electron 侧的事（窗口、IPC、注册表）
 *
 * 为什么不把产物内联成 dataURL：
 *   上一轮性能结论（docs/perf-input-2026-11-08-after-lowrisk.md）已确认
 *   「图片外置 + 每键小 patch」是治本方向。转换产物（PDF/视频/图片）普遍偏大，
 *   内联进便签 JSON 会把落盘体积重新撑大，把刚优化掉的性能请回来。
 *   ⇒ 转换先在临时目录完成，再无覆盖地发布到各自源文件目录。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const fileeCli = require('./filee-cli')
const routerLib = require('./router')
const { SAFE_NAME, escapeHtml } = require('../utils')

/** 附件目录名（放在 userData 下，与数据文件同目录） */
const ATTACH_DIR_NAME = 'attachments'

/**
 * 生成一个安全的附件文件名。
 *
 * 保留中文（用户看文件名要认得出来），去掉路径分隔符与 Windows 非法字符。
 * 追加短随机后缀，避免同名覆盖。
 *
 * @param {string} originalPath 原文件路径
 * @param {string} targetExt 目标扩展名（不含点）
 * @param {string} [suffix] 随机后缀
 */
function attachmentName (originalPath, targetExt, suffix) {
  const base = path.basename(String(originalPath || ''), path.extname(String(originalPath || '')))
  const safe = String(base || 'file').replace(SAFE_NAME, '_').slice(0, 60) || 'file'
  const ext = String(targetExt || '').replace(/^\./, '').replace(/[^\w]/g, '') || 'bin'
  const sfx = suffix || Math.random().toString(36).slice(2, 8)
  return `${safe}-${sfx}.${ext}`
}

/**
 * 附件目录路径（不依赖 Electron，可在测试里直接给根目录）。
 * @param {string} userDataDir
 */
function attachmentDir (userDataDir) {
  return path.join(String(userDataDir || ''), ATTACH_DIR_NAME)
}

/**
 * 尽力删除一个临时工作目录。
 *
 * 为什么不抛错：清理失败不该让一次**已经成功**的转换变成失败。
 * 但也不能静默 —— 残留的临时目录会占磁盘，所以要留日志。
 *
 * @param {string} dir
 * @returns {boolean} 是否清理成功
 */
function removeDirQuietly (dir) {
  try {
    // force: true 让「目录已不存在」不算错
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch (err) {
    console.warn('[convert] 临时目录清理失败（可手动删除）：' + dir + ' —— ' + (err && err.message))
    return false
  }
}

/**
 * 创建一个转换服务。
 *
 * ★ 2026-11-16 架构变更：不再硬绑定 Filee CLI，改为走 **router**（多 provider）。
 *   - 内置 provider（图片 / 文本数据）零新增依赖，永远可用；
 *   - Filee 变成**可选** provider：装了就有额外格式，没装也不影响。
 *   - 用户不需要安装 Filee 就能用基础转换。
 *
 * 兼容性：`deps.cli`（注入 Filee CLI 层）与 `deps.resolveBin` 仍然支持，
 *   走**旧路径**（单 Filee provider），保证既有测试与 e2e 不受影响。
 *
 * @param {object} deps
 * @param {string} deps.userDataDir  兼容保留参数；转换产物保存到源目录
 * @param {string} deps.appDir       应用安装目录（探测便携形态 Filee 时用）
 * @param {function} [deps.resolveBin] 解析 Filee CLI 路径（默认用 fileeCli.findFileeBin）
 * @param {object} [deps.cli]        注入的 CLI 适配层（测试用）
 * @param {Array} [deps.providers]  显式指定 provider 列表（新架构，测试用）
 * @param {object} [deps.router]    显式指定 router（新架构，测试用）
 */
function createService (deps = {}) {
  const cli = deps.cli || fileeCli
  const appDir = deps.appDir || ''

  let binCache = null

  /** 找到 Filee CLI（带缓存；找不到时缓存空串，避免每次都探测） */
  function resolveBin () {
    if (binCache !== null) return binCache
    try {
      if (typeof deps.resolveBin === 'function') {
        binCache = deps.resolveBin() || ''
      } else if (typeof cli.findFileeBin === 'function') {
        binCache = cli.findFileeBin({ appDir }) || ''
      } else {
        // 注入的适配层没有探测能力：视为「未安装」而不是静默当成可用
        binCache = ''
      }
    } catch (_) {
      binCache = ''
    }
    return binCache
  }

  // ---------------------------------------------------------------- router
  //
  // 两条路径：
  //   A) 注入 router / providers ⇒ 走新架构（多 provider）
  //   B) 注入 cli 或 resolveBin ⇒ 走旧路径（单 Filee provider），保持既有行为
  //
  // 之所以保留旧路径而不是直接改写：既有 16 条服务层测试与 4 条 e2e 都基于
  // 「Filee 是唯一引擎」这个前提，直接改写会让它们变成测另一个东西。
  // 保留兼容层，等旧路径稳定后再逐步迁移。

  const router = deps.router || (deps.providers
    ? routerLib.createRouter({ providers: deps.providers })
    : null)

  /** 旧路径：把注入的 CLI 层包成单 provider */
  const legacyProvider = router ? null : {
    id: 'legacy-filee',
    name: 'Filee',
    async available () {
      // ★ 恒为 true：旧路径下 Filee 是**唯一**引擎，"没装"这件事由
      //   capabilities/convert 自己返回 not-installed 来表达。
      //   若在这里用 available() 拦掉，router 会把原因改成
      //   「没有可用的转换引擎」，丢掉「未找到 Filee」这个可引导的提示。
      return true
    },
    async capabilities (ext) {
      const r = await cli.capabilities(resolveBin(), ext)
      return {
        ok: r.ok,
        reason: r.reason,
        targets: r.targets || [],
        withEngines: r.withEngines || [],
        displayName: r.displayName || null,
        error: r.error || null
      }
    },
    async convert (files, target, outDir) {
      const bin = resolveBin()
      // ★ 旧语义：bin 为空 ⇒ 直接判定「未安装」，不进入 CLI 层。
      //   （旧实现是在 service.convert 开头做这个检查的；
      //     移到 provider 里后，注入的假 cli 也能被正确拦住。）
      if (!bin) {
        return {
          ok: false,
          reason: cli.REASON.NOT_INSTALLED,
          outputs: [],
          failures: [],
          files: [],
          error: '未找到 Filee（请先安装 Filee 并在 Settings → Engines 中确认已装引擎）'
        }
      }
      const r = await cli.convert(bin, files, target, outDir)
      return {
        ok: r.ok,
        reason: r.reason,
        outputs: r.outputs || [],
        failures: r.failures || [],
        files: r.files || [],
        error: r.error || null
      }
    }
  }

  const activeRouter = router || routerLib.createRouter({
    providers: [legacyProvider]
  })

  /**
   * 查询某扩展名的目标格式。
   *
   * @param {string} ext
   * @returns {Promise<{ok:boolean, reason:string, targets:string[], withEngines:string[], displayName:string|null, error:string|null}>}
   */
  async function capabilities (ext) {
    return activeRouter.capabilities(ext)
  }

  /**
   * 执行一次转换。
   *
   * @param {string[]} files 输入文件路径
   * @param {string} target 目标格式
   * @param {object} [opts] 透传给 router/provider（如 allPages、onProgress）
   * @returns {Promise<{ok:boolean, reason:string, attachments:Array, failures:Array, error:string|null, provider:string|null}>}
   */
  async function convert (files, target, opts = {}) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
    let workDir
    try {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-convert-'))
    } catch (err) {
      return { ok: false, reason: cli.REASON.FAILED, attachments: [], failures: [], error: '无法创建转换临时目录：' + err.message, provider: null }
    }
    let keepWorkDir = false
    try {
      const r = await activeRouter.convert(list, target, workDir, opts)
      // 沿用 attachments 回包字段，路径现在指向源文件目录中的转换结果。
      const attachments = []
      const saveFailures = []
      for (const o of (r.outputs || [])) {
        let createdDest = null
        let createdAssetsDir = null
        try {
          const dir = path.dirname(path.resolve(o.source))
          const base = path.basename(o.source, path.extname(o.source))
          const ext = String(target || '').replace(/^\./, '').replace(/[^\w]/g, '') || 'bin'
          let dest = ''
          let name = ''
          for (let index = 0; ; index++) {
            name = base + (index ? ' (' + index + ')' : '') + '.' + ext
            dest = path.join(dir, name)
            try { fs.copyFileSync(o.output, dest, fs.constants.COPYFILE_EXCL) }
            catch (err) { if (err.code === 'EEXIST') continue; throw err }
            createdDest = dest
            break
          }

          const output = { name, path: dest, source: o.source, size: fileSize(dest) }

          // 可选伴生资源目录（如 docx→md 提取的内嵌图片目录）：
          // 无覆盖分配 <destStem>_assets[_ (k)]，复制到源目录并替换相对路径占位符。
          if (o.assetsDir && fs.existsSync(o.assetsDir) && fs.statSync(o.assetsDir).isDirectory()) {
            const destStem = name.slice(0, -(ext.length + 1))
            let assetsName = ''
            let destAssets = ''
            for (let aIdx = 0; ; aIdx++) {
              assetsName = destStem + '_assets' + (aIdx ? ' (' + aIdx + ')' : '')
              destAssets = path.join(dir, assetsName)
              try { fs.mkdirSync(destAssets, { recursive: false }) }
              catch (err) { if (err.code === 'EEXIST') continue; throw err }
              createdAssetsDir = destAssets
              break
            }
            fs.cpSync(o.assetsDir, destAssets, { recursive: true })
            if (typeof o.assetsPlaceholder === 'string' && o.assetsPlaceholder) {
              const relAssets = encodeURIComponent(assetsName)
                .replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
              const rawText = fs.readFileSync(dest, 'utf8')
              const nextText = rawText.split(o.assetsPlaceholder).join(relAssets)
              fs.writeFileSync(dest, nextText, 'utf8')
              output.size = fileSize(dest)
            }
            output.assetsDir = destAssets
          }

          if (Array.isArray(o.warnings) && o.warnings.length) output.warnings = o.warnings
          attachments.push(output)
        } catch (err) {
          if (createdDest) {
            try { fs.unlinkSync(createdDest) } catch (_) {}
          }
          if (createdAssetsDir) {
            try { fs.rmSync(createdAssetsDir, { recursive: true, force: true }) } catch (_) {}
          }
          keepWorkDir = true
          saveFailures.push({ source: o.source, state: 'failed', outputs: [o.output], error: err.message })
        }
      }
      return {
        ok: r.ok && !saveFailures.length,
        reason: saveFailures.length ? cli.REASON.FAILED : r.reason,
        attachments,
        failures: (r.failures || []).concat(saveFailures),
        error: saveFailures.length ? '无法保存到源文件目录：' + saveFailures[0].error + '；临时结果保留在：' + workDir : r.error,
        provider: r.provider || null,
        warnings: Array.isArray(r.warnings) ? r.warnings : []
      }
    } finally {
      if (!keepWorkDir) removeDirQuietly(workDir)
    }
  }

  /**
   * 列出当前有哪些转换引擎可用（供设置页展示"能力来源"）。
   *
   * 为什么要给用户看这个：用户看到"没有 PDF"这类缺口时，
   * 最容易产生的困惑是"是不是装坏了"；
   * 把引擎清单摊开（内置已就绪 / Filee 未安装 / 加载了哪些插件）能消掉这个疑问。
   *
   * @returns {Promise<Array<{id:string,name:string,available:boolean}>>}
   */
  async function engines () {
    return activeRouter.engines()
  }

  return { resolveBin, capabilities, convert, engines, router: activeRouter }
}

/** 取文件大小（失败返回 0） */
function fileSize (p) {
  try {
    return fs.statSync(p).size
  } catch (_) {
    return 0
  }
}

/**
 * 为便签生成一段可插入的 HTML。
 *
 * 图片类产物 → <img>（引用走自定义协议，详见 main.js 的 protocol.handle）
 * 其它产物   → 附件卡片（文件名 + 大小），避免把 PDF/视频硬塞进便签
 *
 * @param {object} att 附件对象 {name, path, size}
 * @param {object} [opts]
 * @param {function} [opts.urlFor] 把附件路径转成可引用 URL
 * @param {function} [opts.escape] HTML 转义
 */
function attachmentHtml (att, opts = {}) {
  if (!att || !att.name) return ''
  const escape = opts.escape || escapeHtml
  const urlFor = opts.urlFor || (p => p)
  const isImage = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(att.name)
  const size = att.size ? ` · ${Math.max(1, Math.round(att.size / 1024))} KB` : ''

  if (isImage) {
    return `<img src="${escape(urlFor(att.path))}" alt="${escape(att.name)}" data-attachment="${escape(att.name)}" />`
  }
  return `<p class="attachment" data-attachment="${escape(att.name)}" data-path="${escape(att.path)}">📎 ${escape(att.name)}${escape(size)}</p>`
}

module.exports = {
  ATTACH_DIR_NAME,
  attachmentDir,
  attachmentName,
  attachmentHtml,
  createService
}
