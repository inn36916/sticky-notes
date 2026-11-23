'use strict'

/**
 * 转换引擎 Provider 契约（纯逻辑，可被 node:test 直接驱动）。
 *
 * 设计目标：把「格式转换」从「Filee CLI」解耦成「一组可插拔的 provider」。
 *
 * 为什么需要这一层（2026-11-16 决策）：
 *   用户不装 Filee，要直接复用其转换能力。但实测发现：
 *     - Filee 本体是 .NET 10 + Avalonia，嵌入进来 = 我方要装 .NET 10 SDK
 *       + self-contained 运行时（+132MB），体积与「装 Filee」完全相同；
 *     - Filee 的零引擎档也不是纯 C#，靠 Magick.NET / PDFsharp / SkiaSharp
 *       / PdfPig / ACadSharp 等一整条 NuGet 生态实现。
 *   ⇒ 直接嵌入 C# 不划算；改成「可插拔 provider」：
 *     - 内置 provider 用零新增依赖的方式先覆盖高频格式（图片、文本、JSON…）；
 *     - Filee 保留为**可选** provider（检测到就用，不安装）；
 *     - 以后加任何新引擎（LibreOffice / pandoc / 自研 C#）只需实现契约。
 *
 * Provider 契约（全部是 async，方便接子进程或 WASM）：
 *
 *   id         唯一标识（用于日志与测试断言）
 *   name       展示名
 *   available() → Promise<boolean>          是否可用（装了/有依赖）
 *   capabilities(ext) → Promise<{...}>      某扩展名能转成什么
 *   convert(files, target, outDir) → Promise<{...}>
 *
 * capabilities 返回结构（与旧 Filee 口径保持一致，UI 不用改）：
 *   { ok, reason, targets[], withEngines[], displayName, error }
 *
 * convert 返回结构：
 *   {
 *     ok, reason,
 *     outputs: [{ source, output, warnings?: [{code, message}] }],
 *     failures: [], files: [], error,
 *     warnings?: [{code, message}]      // 整体级警告（多数场景用产物级就够）
 *   }
 *
 * ★ 关于 warnings（2026-11-17 加，修 S3）：
 *   它表达的是「成功了，但你应该知道某件事」—— 不是失败。
 *   典型场景：SVG 转出来的图是全透明的（空 SVG、内容画不出来），
 *   此时 `ok:true` 是对的（产物确实生成了），但用户拿到一张空白图而毫不知情，
 *   这就是"软性假成功"。
 *
 *   为什么挂在**产物级**（outputs[i].warnings）而不是只放顶层：
 *   提示是针对某一具体产物的（这张图全透明，那张图尺寸被缩小），
 *   而 service 会把产物一一映射成 attachments ⇒ 能一路传到 UI 逐个提示。
 *
 *   为什么用 {code, message} 而不是纯字符串：
 *   code 用于测试断言与将来的国际化，message 是给用户看的中文。
 */

/** 失败原因分类（沿用 filee-cli 的口径，UI 的 reasonText 不用改） */
const REASON = {
  OK: 'ok',
  NEEDS_ENGINE: 'needs-engine',
  USAGE: 'usage',
  NOTHING_TO_DO: 'nothing-to-do',
  NOT_INSTALLED: 'not-installed',
  TIMEOUT: 'timeout',
  SPAWN_FAILED: 'spawn-failed',
  FAILED: 'failed'
}

/**
 * 产物级警告分类。
 *
 * 这些都不是失败 —— 转换确实产出了文件，但产出与用户预期可能有差距。
 * 不提示的话，用户没有任何途径知道（这正是 S3 要解决的问题）。
 */
const WARN = {
  /** 产物全透明（画布采样下来没有任何不透明像素） */
  BLANK: 'blank',
  /** 源文件引用了外部资源，渲染时没有被加载（对应位置为空白） */
  EXTERNAL_REF: 'external-ref',
  /** 尺寸超过上限被等比缩小（产物比原图小） */
  SCALED: 'scaled',
  /** 多页 PDF 只转了第 1 页（转换"成功"了，但用户必须知道少了页） */
  PDF_MULTIPAGE: 'pdf-multipage',
  /** 用户选了「全部页」，但 PDF 超过保护上限，只转了前 N 页（防 worker 窗口 OOM） */
  PDF_PAGE_LIMIT: 'pdf-page-limit',
  /**
   * allPages 部分页失败：整体成功但少了页，属软性假成功。
   * 失败页没有产物、挂不到 outputs[i].warnings 上，只能走顶层 warnings
   * 才能被 main-bridge.collectWarnings() 汇总到 UI 状态栏。
   * ★ 2026-11-18（P5）：同时挂到该源**第一个成功页产物**上（复用同一条对象），
   *   顶层仍是权威来源，产物级只是兜底副本（详见 providers/pdf.js 注释）。
   */
  PDF_PAGE_FAILED: 'pdf-page-failed',
  /**
   * 图片 → PDF 时有源图被跳过（格式不支持 / 魔数不对 / 嵌入失败）：
   * 产物页数少于用户给的张数，属软性假成功，必须明确告警。
   * 文案必须含「共 N 张 / 已写入 M 张 / 跳过 K 张」三个数字。
   */
  PDF_IMAGE_SKIPPED: 'pdf-image-skipped',
  /**
   * 动图（多帧 gif / 含 ANIM 的 webp）转 PDF 只取首帧 —— 用户必须知道拿到的不是全部帧。
   */
  PDF_ANIMATED_FRAME: 'pdf-animated-first-frame',
  /**
   * PDF 未检测到可提取文本层（可能是扫描件），Markdown 结果为空。
   */
  PDF_NO_TEXT_LAYER: 'pdf-no-text-layer',
  /**
   * 工作簿含多个工作表时，仅转换了首个非空工作表。
   */
  XLSX_MULTISHEET: 'xlsx-multisheet'
}

/**
 * 构造一条产物警告。
 *
 * @param {string} code WARN 里的分类
 * @param {string} message 给用户看的说明（中文、说人话、别只重复 code）
 * @returns {{code: string, message: string}}
 */
function warn (code, message) {
  return { code: String(code || ''), message: String(message || '') }
}

/**
 * 统一的失败返回。
 * @param {string} reason
 * @param {string} error
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
 * 校验一个 provider 对象是否满足契约。
 *
 * 目的：让「新增 provider 时忘了实现某个方法」在**启动时**就炸，
 * 而不是等到用户右键点了才静默失败。
 *
 * @param {object} p
 * @returns {{ok: boolean, error: string|null}}
 */
function validateProvider (p) {
  if (!p || typeof p !== 'object') return { ok: false, error: 'provider 不是对象' }
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'provider 缺少 id' }
  if (typeof p.name !== 'string' || !p.name) return { ok: false, error: 'provider 缺少 name' }
  if (typeof p.available !== 'function') return { ok: false, error: 'provider 缺少 available()' }
  if (typeof p.capabilities !== 'function') return { ok: false, error: 'provider 缺少 capabilities()' }
  if (typeof p.convert !== 'function') return { ok: false, error: 'provider 缺少 convert()' }
  return { ok: true, error: null }
}

/**
 * Provider 注册表：按顺序保存 provider，提供查询与路由。
 *
 * 路由规则：
 *   1. 优先用**第一个可用**的 provider；
 *   2. 但 provider 可以声明自己「不擅长」某组合 —— 通过 canHandle(ext, target) 表达，
 *      默认返回 true。
 */
function createRegistry (providers = []) {
  /** @type {Array<object>} */
  const list = []
  const errors = []

  for (const p of providers) {
    const v = validateProvider(p)
    if (!v.ok) {
      errors.push((p && p.id ? p.id : '?') + ': ' + v.error)
      continue
    }
    list.push(p)
  }

  /** 缓存 provider 的可用性（避免每次查询都探一次盘） */
  const availCache = new Map()

  /**
   * provider 是否可用（带缓存）。
   * @param {object} p
   * @returns {Promise<boolean>}
   */
  async function isAvailable (p) {
    if (availCache.has(p.id)) return availCache.get(p.id)
    let ok = false
    try {
      ok = !!(await p.available())
    } catch (_) {
      ok = false
    }
    availCache.set(p.id, ok)
    return ok
  }

  /** 清除可用性缓存（用户装了新东西/改了设置时调用） */
  function invalidate () {
    availCache.clear()
  }

  /** 列出全部 provider（不管可用与否） */
  function all () {
    return list.slice()
  }

  /** 列出可用的 provider */
  async function available () {
    const out = []
    for (const p of list) {
      if (await isAvailable(p)) out.push(p)
    }
    return out
  }

  /**
   * 找出能处理 (ext → target) 的可用 provider。
   *
   * ★ availableCount 的用途：区分两种"没有可用引擎"的情况 ——
   *   - availableCount === 0 ⇒ 引擎**没装**（reason 应为 not-installed）
   *   - availableCount > 0 但 candidates 为空 ⇒ 引擎在，但**不支持这个格式**
   *     （reason 应为 usage）。两者对用户的提示完全不同，不能混。
   *
   * @param {string} ext 源扩展名（小写，不含点）
   * @param {string} [target] 目标格式；不给则只看 ext
   * @returns {Promise<{provider: object|null, candidates: object[], availableCount: number}>}
   */
  async function resolve (ext, target) {
    const candidates = []
    let availableCount = 0
    for (const p of list) {
      if (!(await isAvailable(p))) continue
      availableCount++
      if (typeof p.canHandle === 'function') {
        let h = false
        try { h = !!(await p.canHandle(ext, target)) } catch (_) { h = false }
        if (!h) continue
      }
      candidates.push(p)
    }
    return { provider: candidates[0] || null, candidates, availableCount }
  }

  return { all, available, resolve, invalidate, errors }
}

module.exports = {
  REASON,
  WARN,
  warn,
  fail,
  validateProvider,
  createRegistry
}
