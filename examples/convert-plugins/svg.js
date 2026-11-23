'use strict'

/**
 * SVG 矢量 → 位图（png / jpg / webp）——**示例插件**
 *
 * ============================ 这个文件是干什么的 ============================
 *
 * 它不是一个"内置引擎"，而是一个**投放即生效**的示例：
 * 把本文件拷到 `<userData>/convert-plugins/`（设置页 → 格式转换 里能看到该路径），
 * 重启应用后 SVG 就多出了一组目标格式 —— **没有改过任何核心代码**。
 * 这就是框架「可插拔」承诺的验证用例。
 *
 * 插件契约（三种导出形态任选其一，这里用工厂函数）：
 *   ① module.exports = provider
 *   ② module.exports = { provider }
 *   ③ module.exports = function (deps)
 *
 * 工厂函数会收到框架注入的 deps：
 *   { appDir, userDataDir, workerHost, log }
 *
 * ============================ 它依赖什么 ============================
 *
 * 光栅化（矢量 → 像素）必须在**渲染进程**做：canvas 只存在于渲染进程，
 * 主进程（Node）没有 DOM。所以这个插件**自己不做渲染**，而是调用框架
 * 注入的 `deps.workerHost`：
 *
 *   workerHost.renderSvg(svgText)      → { ok, width, height, canvasId }
 *   workerHost.encode(canvasId, mime)  → { ok, bytes: Uint8Array, type }
 *
 * 换句话说：插件只负责「读文件 / 决定尺寸语义 / 拼文件名 / 写盘」这些
 * 纯 Node 的活，canvas 能力由框架统一提供并复用（隐藏渲染窗口只开一个）。
 * 没有 workerHost 时 available() 返回 false，框架会自动跳过它 ——
 * 这是插件应有的姿态：能力不满足就诚实地说不可用，别假装能转。
 *
 * ============================ 为什么不 require 应用内部模块 ============================
 *
 * 下面那份 REASON / fail() 是**故意抄一份**的，没有 `require('../lib/convert/provider')`：
 * 插件被放进 `<userData>/convert-plugins/`，它和应用的相对路径关系是未知的
 * （userData 与安装目录可能隔着好几个盘符），用相对路径 require 必然失败。
 * 插件必须能独立存在，只能依赖 Node 内置模块（这里是 fs / path）。
 *
 * 维护提示：若框架的 REASON 取值变了，插件里的字符串要同步（值就是协议）。
 */

const fs = require('fs')
const path = require('path')

/** provider 唯一标识（日志与测试会断言它） */
const PLUGIN_ID = 'builtin-vector-svg'

/** 展示名（设置页的引擎清单里显示这一行） */
const PLUGIN_NAME = 'SVG 矢量（示例插件）'

/** 本插件唯一认的源扩展名 */
const SOURCE_EXTS = ['svg']

/**
 * 目标扩展名 → canvas 能编的 mime。
 *
 * 只列 canvas **实测**真的能编的三种（png/jpeg/webp）。
 * 注意不要在这里加 gif/bmp/avif/svg：canvas.toBlob 对它们会**静默回退成 PNG**，
 * worker 侧虽然会校验 blob.type 拦下来，但让用户看到一个"支持 gif"的选项
 * 然后必然失败，是很差的体验。
 */
const TARGET_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

/** 目标扩展名白名单 */
const TARGETS = Object.keys(TARGET_MIME)

/** 失败原因（取值与 lib/convert/provider.js 的 REASON 一致 —— 这个字符串是协议） */
const REASON = {
  OK: 'ok',
  USAGE: 'usage',
  NOT_INSTALLED: 'not-installed',
  FAILED: 'failed'
}

/**
 * 产物级警告分类（取值与 lib/convert/provider.js 的 WARN 一致 —— 同样是协议）。
 *
 * 为什么插件要本地抄一份而不是 require 框架：
 * 插件放在 `<userData>/convert-plugins/` 下，`require('../lib/convert/provider')`
 * 这种相对路径必然解析失败。所以像 REASON 一样，这里维护一份**值必须一致**的副本。
 */
const WARN = {
  BLANK: 'blank',
  EXTERNAL_REF: 'external-ref',
  SCALED: 'scaled'
}

/**
 * 构造一条产物警告（本地副本，理由同 WARN）。
 * @param {string} code
 * @param {string} message
 */
function warn (code, message) {
  return { code: String(code || ''), message: String(message || '') }
}

/**
 * 各格式的文件头魔数：用来确认产物**真的是**目标格式。
 *
 * 为什么插件还要再查一遍：worker 已经校验过 blob.type，但这条链路是
 * "假成功"最容易钻的地方（历史踩坑：canvas 对不支持的 mime 静默回退成 PNG，
 * 用户拿到一个叫 .webp 的 PNG 文件还以为成功了）。
 * 魔数校验是最后一道防线：宁可报错，也不落一个名不副实的文件。
 *
 * ⚠️ webp 不在这张表里：它是 RIFF 容器，只比前 4 字节 'RIFF' 会把 AVI/WAV
 *    也放过去，必须再去 offset 8 找 'WEBP'（见 looksLike）。
 */
const MAGIC = {
  png: [0x89, 0x50, 0x4e, 0x47],
  jpg: [0xff, 0xd8, 0xff],
  jpeg: [0xff, 0xd8, 0xff]
}

/**
 * 统一的失败返回（字段口径与 provider 契约一致）。
 * @param {string} reason
 * @param {string} error
 * @returns {object}
 */
function fail (reason, error) {
  return {
    ok: false,
    reason: reason || REASON.FAILED,
    targets: [],
    withEngines: [],
    displayName: null,
    outputs: [],
    failures: [],
    files: [],
    error: error || null
  }
}

/**
 * 产物文件名：`a.svg` → `a.png`。
 *
 * ★ 为什么要先去掉 .svg：直接 `basename + '.' + target` 会得到
 *   `a.svg.png` 这种双扩展名（很多看图软件仍能打开，但用户在
 *   资源管理器里看到的文件名是错的，右键"打开方式"也会乱）。
 *
 * ⚠️ 这个函数**只负责"想要的名字"**，不管冲突 ——
 *    同一批里两个同名源文件（`d1/a.svg` + `d2/a.svg`）会算出同一个路径，
 *    落盘前必须过 uniqueDest()，否则就是"后写的覆盖先写的"（见那里的注释）。
 *
 * @param {string} src
 * @param {string} target
 * @returns {string}
 */
function outputName (src, target) {
  const base = path.basename(String(src || '')).replace(/\.svg$/i, '')
  return (base || 'vector') + '.' + String(target || '').toLowerCase()
}

/**
 * 保证产物路径唯一（批内 + 磁盘）。
 *
 * ★ 为什么必须有这一层（2026-11-16 QA 实测抓到的假成功）：
 *   把 `d1/same.svg`（10×10 红）和 `d2/same.svg`（20×20 蓝）一批转换，
 *   两者都会算出 `same.png`：写盘时后者覆盖前者，但 outputs 里**两条记录
 *   指向同一个文件**，ok 还是 true。service 会为两条各建一个附件、各拷贝一次，
 *   于是用户拿到两张一模一样的图，其中一张与它的源文件毫无关系 ——
 *   "转换成功"但内容是错的，这比报错伤害大得多。
 *   ⇒ 冲突时追加 `-2` / `-3` …，让"一批里一个产物一个路径"成为硬保证。
 *
 * 同时也检查磁盘：outDir 里可能已有上一次转换留下的同名文件，
 * 默默覆盖别人的产物同样属于"悄悄改结果"。
 *
 * Windows 文件系统大小写不敏感 ⇒ 用 toLowerCase 做键，避免
 * `A.png` 与 `a.png` 被当成两个不同名字而撞在一起。
 *
 * @param {string} dest 期望路径
 * @param {Set<string>} used 本批已占用的路径（小写）
 * @returns {string} 实际可用路径
 */
function uniqueDest (dest, used) {
  const key = (p) => String(p).toLowerCase()
  const taken = (p) => used.has(key(p)) || fs.existsSync(p)
  if (!taken(dest)) return dest

  const ext = path.extname(dest)
  const base = dest.slice(0, dest.length - ext.length)
  for (let i = 2; i < 1000; i++) {
    const cand = base + '-' + i + ext
    if (!taken(cand)) return cand
  }
  // 极端情况（同名上千个 / 目录被写满）：退到随机后缀，绝不返回已占用的路径
  return base + '-' + Math.random().toString(36).slice(2, 8) + ext
}

/**
 * 把 worker 回传的字节转成 Buffer。
 *
 * IPC 结构化克隆会把 Uint8Array 原样带过来；这里兼容三种形态
 * （Buffer / Uint8Array / 普通数组），避免旧 worker 残留时莫名其妙失败。
 *
 * @param {Buffer|Uint8Array|number[]} bytes
 * @returns {Buffer|null}
 */
function toBuffer (bytes) {
  if (!bytes) return null
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) {
    // 用 buffer/byteOffset/byteLength 构造视图：零拷贝，且对池化的 Buffer 也正确
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  if (Array.isArray(bytes)) return Buffer.from(bytes)
  return null
}

/**
 * 校验产物的文件头是否真的是目标格式。
 *
 * ★ webp 要单独判：它是 RIFF 容器，前 4 字节只有 'RIFF'，
 *   真正的格式标识在 offset 8..11（'WEBP'）。只比 'RIFF' 会把
 *   AVI / WAV 之类的容器也放过去 —— 这道"最后防线"就形同虚设。
 *
 * @param {Buffer} buf
 * @param {string} target
 * @returns {boolean}
 */
function looksLike (buf, target) {
  if (!buf || !buf.length) return false
  const t = String(target || '').toLowerCase()

  if (t === 'webp') {
    if (buf.length < 12) return false
    if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return false
    return buf.slice(8, 12).toString('ascii') === 'WEBP'
  }

  const magic = MAGIC[t]
  if (!magic || buf.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic[i]) return false
  }
  return true
}

/**
 * 插件工厂。
 *
 * @param {object} deps 框架注入的上下文
 * @param {object} [deps.workerHost] canvas 能力（渲染进程侧）
 * @param {function} [deps.log]
 * @returns {object} provider
 */
module.exports = function createSvgPlugin (deps) {
  const ctx = deps || {}
  const workerHost = ctx.workerHost || null
  const log = typeof ctx.log === 'function' ? ctx.log : () => {}

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,

    /**
     * 没有 workerHost 就没法光栅化 —— 诚实报不可用，让框架跳过本插件。
     * @returns {Promise<boolean>}
     */
    async available () {
      return !!(workerHost &&
        typeof workerHost.renderSvg === 'function' &&
        typeof workerHost.encode === 'function')
    },

    /**
     * 只处理 svg 源；target 为空表示"有什么目标"。
     * @param {string} ext
     * @param {string} [target]
     * @returns {Promise<boolean>}
     */
    async canHandle (ext, target) {
      const e = String(ext || '').toLowerCase()
      if (!SOURCE_EXTS.includes(e)) return false
      if (target == null) return true
      return TARGETS.includes(String(target || '').toLowerCase())
    },

    /**
     * 能力查询。
     * @param {string} ext
     * @returns {Promise<object>}
     */
    async capabilities (ext) {
      const e = String(ext || '').toLowerCase()
      if (!SOURCE_EXTS.includes(e)) {
        return fail(REASON.USAGE, '示例 SVG 插件只处理 .svg 源文件（收到：' + (e || '未知') + '）')
      }
      return {
        ok: true,
        reason: REASON.OK,
        targets: TARGETS.slice(),
        withEngines: [],
        displayName: '矢量图',
        error: null
      }
    },

    /**
     * 执行转换。
     *
     * 流程：读 SVG 文本 → worker 光栅化成 canvas → worker 编码成目标格式 → 写盘。
     * 单文件失败只记进 failures，不影响同批其它文件；
     * 全部失败时返回 ok:false（绝不把"零产物"说成成功）。
     *
     * @param {string[]|string} files
     * @param {string} target 目标扩展名
     * @param {string} outDir 产物目录
     * @returns {Promise<object>}
     */
    async convert (files, target, outDir) {
      const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
      if (!list.length) return fail(REASON.USAGE, '没有待转换的文件')

      const t = String(target || '').toLowerCase()
      const mime = TARGET_MIME[t]
      if (!mime) {
        return fail(REASON.USAGE, 'SVG 插件不支持目标格式：' + (t || '未知'))
      }
      if (!workerHost) {
        return fail(REASON.NOT_INSTALLED, '转换工作器不可用，无法光栅化 SVG')
      }

      const outputs = []
      const failures = []
      // 本批已占用的产物路径（小写）：保证一批里一个产物一个路径，
      // 否则同名源文件会互相覆盖，outputs 里却出现两条指向同一文件的记录
      const usedDest = new Set()

      for (const src of list) {
        try {
          // 1) 读源文本。SVG 必须是 UTF-8 文本 —— 这是它的定义形态，
          //    读不出来（编码/权限）就视为该文件失败。
          const svgText = fs.readFileSync(src, 'utf8')
          if (!svgText.trim()) {
            failures.push({ source: src, state: 'failed', outputs: [], error: 'SVG 文件内容为空' })
            continue
          }

          // 2) 光栅化：canvas 只能在渲染进程用，交给 workerHost。
          const rendered = await workerHost.renderSvg(svgText)
          if (!rendered || !rendered.ok || !rendered.canvasId) {
            failures.push({
              source: src,
              state: 'failed',
              outputs: [],
              error: (rendered && rendered.error) || 'SVG 渲染失败'
            })
            continue
          }
          // 产物级警告：不是失败，但用户应该知道 —— 一路带到 attachments[i].warnings，
          // 最终由 UI 提示。只打日志的话用户侧完全看不到（这正是 S3 要解决的问题）。
          const warnings = []
          if (rendered.blank) {
            // 不判失败：空 SVG 本身是合法的。但如果用户以为画了东西，就得告诉他产物是空白
            warnings.push(warn(WARN.BLANK,
              '产物是全透明的空白图：源 SVG 没有可见内容，或内容依赖浏览器不渲染的东西'))
            log('[svg-plugin] ' + path.basename(String(src)) + ' 渲染结果全透明（可能是 foreignObject 或外部字体）')
          }
          if (rendered.externalRef) {
            // 实测：浏览器把 SVG 当图片渲染时不会去请求外部资源，
            // 那些位置画出来是空白 —— 不是失败，但要让用户能查到"为什么图少了东西"
            warnings.push(warn(WARN.EXTERNAL_REF,
              '源 SVG 引用了外部图片或字体，浏览器渲染 SVG 图片时不会加载它们，产物中对应位置是空白'))
            log('[svg-plugin] ' + path.basename(String(src)) + ' 引用了外部资源，' +
              '浏览器渲染 SVG 图片时不会加载它们，产物中对应位置为空白')
          }
          if (rendered.scaled) {
            warnings.push(warn(WARN.SCALED,
              '源 SVG 尺寸超过上限（最长边 8192），产物已等比缩小到 ' +
              rendered.width + '×' + rendered.height))
            log('[svg-plugin] ' + path.basename(String(src)) + ' 尺寸超过上限，已等比缩小到 ' +
              rendered.width + '×' + rendered.height)
          }

          // 3) 编码。worker 会校验 blob.type 是否等于请求的 mime，
          //    不相等即失败（防止 canvas 静默回退成 PNG 的假成功）。
          const encoded = await workerHost.encode(rendered.canvasId, mime)
          if (!encoded || !encoded.ok) {
            failures.push({
              source: src,
              state: 'failed',
              outputs: [],
              error: (encoded && encoded.error) || '编码失败'
            })
            continue
          }
          const buf = toBuffer(encoded.bytes)
          if (!buf || !buf.length) {
            failures.push({ source: src, state: 'failed', outputs: [], error: '编码结果为空' })
            continue
          }
          // 4) 最后一道防线：魔数不对 ⇒ 说明拿到的不是真正的目标格式
          if (!looksLike(buf, t)) {
            failures.push({
              source: src,
              state: 'failed',
              outputs: [],
              error: '产物不是有效的 ' + t.toUpperCase() + '（疑似编码器回退，已丢弃以免产出假文件）'
            })
            continue
          }

          // 5) 写盘
          // ★ 必须先过 uniqueDest：同一批里的同名源文件（d1/same.svg + d2/same.svg）
          //   会算出同一个路径，直接写就是"后者覆盖前者 + outputs 两条指向同一文件"，
          //   ok:true 却给出与源文件无关的内容 —— 假成功。
          const wanted = path.join(String(outDir || ''), outputName(src, t))
          const dest = uniqueDest(wanted, usedDest)
          fs.writeFileSync(dest, buf)
          usedDest.add(String(dest).toLowerCase())
          const out = { source: src, output: dest }
          // 只有真有问题时才挂 warnings 字段，正常产物不带（避免噪声）
          if (warnings.length) out.warnings = warnings
          outputs.push(out)
        } catch (err) {
          failures.push({
            source: src,
            state: 'failed',
            outputs: [],
            error: (err && err.message) || String(err)
          })
        }
      }

      if (!outputs.length) {
        return Object.assign(
          fail(REASON.FAILED, failures[0] ? failures[0].error : 'SVG 转换失败'),
          { failures }
        )
      }

      return {
        ok: true,
        reason: REASON.OK,
        outputs,
        failures,
        files: [],
        error: null
      }
    }
  }
}

// 供单测断言（不影响插件契约：多导出的字段会被 provider 契约校验忽略）
module.exports.PLUGIN_ID = PLUGIN_ID
module.exports.TARGETS = TARGETS
module.exports.TARGET_MIME = TARGET_MIME
module.exports.WARN = WARN
module.exports.warn = warn
module.exports.outputName = outputName
module.exports.uniqueDest = uniqueDest
module.exports.looksLike = looksLike
