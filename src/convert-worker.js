'use strict'

/**
 * 转换工作器（渲染进程）。
 *
 * 职责：承担**只能在渲染进程做**的活 —— canvas 的图片解码/编码。
 * 主进程（Node）没有 DOM，拿不到 canvas；把这段能力放在一个隐藏窗口里，
 * 主进程通过 IPC 调用。
 *
 * ★ 为什么不用 sharp / ImageMagick：会引入 native 依赖与体积；
 *   Chromium 自带的 canvas 已覆盖实测可用的那部分编码（png/jpeg/webp）。
 *
 * ★ 关键陷阱（2026-11-16 实测，probe-canvas-codecs.js）：
 *   `canvas.toBlob(cb, mime)` 对**不支持的 mime 会静默回退成 PNG**，
 *   不报错、blob.type 变成 'image/png'。
 *   ⇒ 必须校验返回的 blob.type 是否等于请求的 mime，不等就判失败。
 *   否则「转 gif」会产出一个 PNG 文件，用户以为成功了 —— 这是最坑的一种假成功。
 */

/**
 * 请求的 mime → 期望的 blob.type。
 * 只列实测为真的编码（Chromium 静默回退的都不列）。
 */
const ENCODE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

/** 解码支持的源类型 */
const DECODE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon'
}

/**
 * 解码主进程下发的图片字节。
 *
 * @param {Uint8Array|number[]} bytes
 * @param {string} [mime]
 * @returns {Promise<{ok:boolean, width?:number, height?:number, canvas?:HTMLCanvasElement, error?:string}>}
 */
async function decodeImage (bytes, mime) {
  try {
    const view = (bytes instanceof Uint8Array)
      ? bytes
      : new Uint8Array(Array.isArray(bytes) ? bytes : [])
    if (!view.length) {
      return { ok: false, error: '文件为空或读不到' }
    }
    const finalMime = mime || sniffImageMime(view) || 'image/png'
    const blob = new Blob([view], { type: finalMime })
    const bmp = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bmp, 0, 0)
    bmp.close && bmp.close()
    return { ok: true, width: canvas.width, height: canvas.height, canvas }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

/**
 * 把 canvas 编码成目标格式。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} mime 期望的 mime
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, type?:string, error?:string}>}
 */
async function encodeImage (canvas, mime) {
  try {
    const blob = await new Promise(resolve => {
      canvas.toBlob(resolve, mime)
    })
    if (!blob) return { ok: false, error: '编码失败（toBlob 返回空）' }
    // ★ 静默回退检测：type 不等于请求的 mime ⇒ Chromium 实际不支持这个编码
    if (blob.type !== mime) {
      return {
        ok: false,
        error: '浏览器不支持该编码格式（已回退为 ' + blob.type + '）'
      }
    }
    const buf = await blob.arrayBuffer()
    // ★ 直接回传 Uint8Array（结构化克隆原生支持），不要 Array.from 转成普通数组：
    //   那样每个字节占一个 JS number，大图回传时内存会放大一个数量级。
    return { ok: true, bytes: new Uint8Array(buf), type: blob.type }
  } catch (err) {
    // ★ 画布被污染时 toBlob 抛 SecurityError，消息是英文的
    //   "Tainted canvases may not be exported."，直接透出去用户看不懂，
    //   翻译成"是什么导致的、为什么不让导出"（详见 taintMessage）。
    return { ok: false, error: taintMessage(err) }
  }
}

// ---------------------------------------------------------------- 图片转码

/**
 * 转码支持的源 mime（webp/gif 等 pdf-lib 吃不下的格式）。
 */
const TRANSCODE_SOURCE_MIME = {
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg'
}

/**
 * 从字节头推断源 mime（扩展名不可信时用）。
 *
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
function sniffImageMime (bytes) {
  if (!bytes || bytes.length < 4) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    // RIFF 容器：offset 8 是 'WEBP' 才是 webp（AVI/WAV 在同一位置是别的标识）
    if (bytes.length >= 12) {
      const tag = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
      if (tag === 'WEBP') return 'image/webp'
    }
    return null
  }
  return null
}

/**
 * 把一张图片从源格式转码成目标 mime 的字节。
 *
 * ★ 为什么需要这条通道：pdf-lib 的 embedPng/embedJpg 只吃 PNG/JPEG，
 *   webp/gif 得靠 Chromium 的 createImageBitmap（解码）+ canvas.toBlob（编码）。
 *   主进程没有 DOM ⇒ 必须放在渲染进程。
 *
 * ★ 动图只取首帧：createImageBitmap 本身只给第一帧（这是浏览器行为，不是我们的选择）；
 *   "是不是动图"由主进程 provider 侧用容器探测判定并单独告警（animated-image.js）。
 *
 * @param {Uint8Array|number[]} bytes 源字节
 * @param {string} mime 目标 mime（image/png）
 * @param {object} [opts] { sourceMime }
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, type?:string,
 *                    width?:number, height?:number, error?:string}>}
 */
async function transcodeImage (bytes, mime, opts) {
  const o = opts || {}
  try {
    const view = (bytes instanceof Uint8Array)
      ? bytes
      : new Uint8Array(Array.isArray(bytes) ? bytes : [])
    if (!view.length) return { ok: false, error: '源图片为空或读不到' }

    const sourceMime = o.sourceMime || sniffImageMime(view) || 'image/png'
    const blob = new Blob([view], { type: sourceMime })
    const bmp = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0)
    bmp.close && bmp.close()

    const encoded = await encodeImage(canvas, mime)
    if (!encoded.ok) return encoded
    return {
      ok: true,
      bytes: encoded.bytes,
      type: encoded.type,
      width: canvas.width,
      height: canvas.height
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

// ---------------------------------------------------------------- SVG 光栅化

/**
 * 渲染最长边上限（像素）。
 *
 * 为什么必须有：SVG 的 viewBox 是任意数值，用户随手一个
 * `viewBox="0 0 100000 100000"` 就会让我们申请 100000×100000×4B ≈ 40GB 的画布，
 * 直接把渲染进程 OOM 掉（连带整个应用崩溃）。
 * 超过上限就等比缩到上限，并在结果里带 scaled 标记 —— 明确告知，不偷偷改。
 */
const MAX_RENDER_SIDE = 8192

/** 等待 <img> 载入 SVG 的超时（毫秒） */
const SVG_LOAD_TIMEOUT_MS = 20000

/**
 * Chromium 给"没有 intrinsic size"的替换元素用的默认盒是 300×150，
 * 并且**保持宽高比**缩放（CSS default object size + preserve aspect ratio）。
 *
 * ★ 实测（Electron 33 / Chromium，2026-11-16 探针）——同一段 SVG 文本塞进
 *   Blob URL 后 img.naturalWidth/Height 报的是：
 *     - 无 width/height、无 viewBox   → 300×150   ← 默认盒本身，语义上"没有尺寸"
 *     - 只有 viewBox（48×32）         → 225×150   ← 默认盒按 4:3 缩放，**不是** 48×32
 *     - width=64 height=64            → 64×64     ← 只有这种情况 natural 可信
 *   ⇒ 结论：natural 只在"作者显式声明了 width/height"时才可信；
 *     所以尺寸判定的顺序必须是「文本里的 width/height → viewBox → natural」，
 *     并且把 300×150 这个默认盒当成"没有尺寸信息"，绝不照它出图。
 */
const FALLBACK_BOX = { width: 300, height: 150 }

/**
 * 取一个属性的原始值（容忍双引号 / 单引号 / 无引号三种写法）。
 *
 * @param {string} attrs 属性串（根标签 `<svg` 之后、`>` 之前的部分）
 * @param {string} name 属性名
 * @returns {string} 属性值；没有则空串
 */
function attrValue (attrs, name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i')
  const m = re.exec(String(attrs || ''))
  if (!m) return ''
  if (m[2] != null) return m[2]
  if (m[3] != null) return m[3]
  return m[4] || ''
}

/**
 * 解析 SVG 长度值（只认无单位与 px）。
 *
 * 为什么只认这两种：`50%` 依赖父视口、`10em` 依赖字号、`cm/pt/in` 依赖 DPI ——
 * SVG 作为独立图片渲染时这些都没有确定的绝对值，猜一个数字只会错得莫名其妙。
 * 这些情况一律交给 viewBox 兜底，比按 DPI 硬算更接近作者意图。
 * ⇒ 它们**也不算 declared**（见 parseSvgMetrics）：否则就会拿着浏览器给
 *   `width="100%"` 算出的默认盒派生值（150×150 之类）去顶掉 viewBox 的正确尺寸。
 *
 * @param {string} raw
 * @returns {number} 像素值；解析不了返回 0
 */
function parseLength (raw) {
  const s = String(raw == null ? '' : raw).trim()
  const m = /^([0-9]*\.?[0-9]+)\s*(px)?$/i.exec(s)
  if (!m) return 0
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 从 SVG 文本里读出根元素的 width/height/viewBox。
 *
 * ★ 为什么不直接相信 img.naturalWidth（2026-11-16 实测）：
 *   没有尺寸声明时它报的是浏览器的**默认盒**（300×150，按宽高比缩放）而不是 0，
 *   看着"有效"却是空的：无尺寸的 SVG 报 300×150，只有 viewBox 的 48×32 报 225×150。
 *   所以先从文本里读作者显式声明的尺寸，文本里真没有才退到 natural，
 *   并且把默认盒当成"没有尺寸信息"。
 *
 * ★ declared 的含义（2026-11-16 补，修"只写单边被误判成没尺寸"）：
 *   width/height 至少有一边能解析成**绝对像素**才为真。
 *   为什么需要它：`<svg width="300">` 与"什么都没写"的 natural 都可能是 300×150，
 *   只看数字无法区分 —— 但前者是作者声明的真实尺寸，后者是浏览器兜底盒。
 *   有 declared 才能决定"该不该相信 natural"。
 *
 * ★ 为什么 `%` / `em` / `cm` **不能**算 declared（QA 第二轮抓到的回归）：
 *   它们没有绝对值，浏览器会拿默认盒（300×150）推导出 150×150 / 16×16 / 76×38
 *   这类数字；一旦让这种 natural 抢在 viewBox 前面，就等于把"默认盒污染"
 *   原样请了回来（且更隐蔽：数字从 300×150 变成 150×150）。
 *   `<svg width="100%" viewBox="0 0 24 24">` 是 Figma/Illustrator 导出图标的高频
 *   写法，照 natural 出图会放大 6.25 倍 —— 用户直接能看出来。
 *   ⇒ 只有绝对像素才配走 natural，相对单位一律回落 viewBox。
 *
 * @param {string} svgText
 * @returns {{width:number, height:number, declared:boolean,
 *            viewBox:{x:number,y:number,w:number,h:number}|null}}
 */
function parseSvgMetrics (svgText) {
  const out = { width: 0, height: 0, declared: false, viewBox: null }
  const m = /<svg\b([^>]*)>/i.exec(String(svgText || ''))
  if (!m) return out
  const attrs = m[1]

  const w = parseLength(attrValue(attrs, 'width'))
  const h = parseLength(attrValue(attrs, 'height'))
  // 只有能解析成绝对像素的声明才算 declared；`100%` / `1em` / `2cm` 解析为 0
  // ⇒ declared=false ⇒ decideRenderSize 回落到 viewBox（恢复旧行为）
  out.declared = (w > 0 || h > 0)

  // 两边各自独立记录（作者声明了哪边就记哪边，便于诊断/断言）；
  // 真正决定"能不能直接用文本值"的是 decideRenderSize 里的"两边都必须 > 0"。
  if (w > 0) out.width = w
  if (h > 0) out.height = h

  // viewBox 的大小写：规范是 viewBox，但 HTML 解析器会把属性名小写化，
  // 两种写法都要认（用户手写的 SVG 里 viewbox 并不少见）。
  const vb = attrValue(attrs, 'viewBox') || attrValue(attrs, 'viewbox')
  if (vb) {
    const nums = vb.trim().split(/[\s,]+/).map(Number)
    if (nums.length === 4 && nums.every(n => Number.isFinite(n)) && nums[2] > 0 && nums[3] > 0) {
      out.viewBox = { x: nums[0], y: nums[1], w: nums[2], h: nums[3] }
    }
  }
  return out
}

/**
 * 决定渲染尺寸（像素）。
 *
 * 优先级（先命中先用）：
 *   ① 根元素显式声明的 width + height **两边都**能解析成绝对像素 —— 最贴近作者意图
 *      （只有单边时走 ②，交给浏览器补另一边）
 *   ② 作者声明过尺寸（declared）且 natural 有效 —— 用浏览器算出来的值
 *      浏览器会把"缺失的那一边"按 viewBox 宽高比补上，也会把 em 之类的
 *      相对单位换成真实像素，比我们自己在文本里猜准得多
 *   ③ viewBox 的 w/h —— 作者没声明尺寸时的逻辑尺寸与真实宽高比
 *   ④ natural 有效且不是默认盒 —— 兜底
 *   ⑤ 都没有 ⇒ **明确失败**
 *
 * ★ 为什么 ② 要在 ③ 前面（2026-11-16 实测数据）：
 *   `<svg width="40" viewBox="0 0 20 10">` 的 natural 是 40×20（浏览器按宽高比补了高）；
 *   若先取 viewBox 会得到 20×10 —— 比作者声明的 40 小一半，属于"猜错"。
 *
 * ★ 为什么 ③ 要在 ④ 前面：
 *   `<svg viewBox="0 0 48 32">`（无尺寸）的 natural 是 225×150（默认盒按 4:3 缩放），
 *   照 ④ 出图就是错的尺寸；viewBox 才是对的。
 *
 * ★ 第 ⑤ 条是刻意的：宁可报"没有尺寸信息"，也不能硬编一个尺寸蒙混过去。
 *   硬编会让用户拿到一张尺寸毫无意义的图，还以为转换成功了。
 *
 * @param {{width:number, height:number, declared:boolean, viewBox:object|null}} metrics
 * @param {{naturalWidth:number, naturalHeight:number}} img
 * @returns {{ok:boolean, width?:number, height?:number, from?:string, error?:string}}
 */
function decideRenderSize (metrics, img) {
  const nw = Number(img && img.naturalWidth) || 0
  const nh = Number(img && img.naturalHeight) || 0

  if (metrics.width > 0 && metrics.height > 0) {
    return { ok: true, width: metrics.width, height: metrics.height, from: 'attrs' }
  }
  // 作者声明过尺寸 ⇒ 相信浏览器算出来的 natural（含补全缺失边、相对单位换算）
  if (metrics.declared && nw > 0 && nh > 0) {
    return { ok: true, width: nw, height: nh, from: 'natural-declared' }
  }
  if (metrics.viewBox) {
    return { ok: true, width: metrics.viewBox.w, height: metrics.viewBox.h, from: 'viewBox' }
  }
  if (nw > 0 && nh > 0 && !(nw === FALLBACK_BOX.width && nh === FALLBACK_BOX.height)) {
    return { ok: true, width: nw, height: nh, from: 'natural' }
  }
  return {
    ok: false,
    error: 'SVG 没有可用的尺寸信息（既无 width/height，也无 viewBox）'
  }
}

/**
 * 把 canvas 污染错误翻译成用户能看懂的话。
 *
 * ★ 实测（2026-11-16 探针）：真正会把画布污染的是 **<foreignObject>**
 *   （里面是 XHTML，可以再引用任意资源，Chromium 一律按不透明源处理）。
 *   而 `<image href="http://...">` 这类外部引用在 SVG-as-image 模式下
 *   **根本不会被请求**（探针里本地 HTTP 服务命中 0 次），所以它既不污染
 *   也不会渲染出内容 —— 这一点很容易想当然搞反，注释留档。
 *
 * @param {*} err
 * @returns {string}
 */
function taintMessage (err) {
  const msg = (err && err.message) || String(err)
  if ((err && err.name === 'SecurityError') || /tainted|cross-origin|insecure/i.test(msg)) {
    return 'SVG 含 <foreignObject> 等受浏览器安全策略限制的内容，无法导出为位图'
  }
  return msg
}

/**
 * SVG 里是否引用了外部资源（http / https / file / 相对路径）。
 *
 * 为什么要标记而不是判失败：如上所述，Chromium 渲染 SVG-as-image 时不会去
 * 请求外部资源，那些位置画出来是空的/占位 —— 渲染成功但"少东西"。
 * 这不算失败（官方行为），但产物会与浏览器里打开 SVG 的样子不同，
 * 值得让调用方留一条可排查的痕迹。
 *
 * data: URL 不算外部资源（内联字节，同源），所以不匹配。
 *
 * @param {string} svgText
 * @returns {boolean}
 */
function hasExternalRef (svgText) {
  return /(?:href|src)\s*=\s*["']?\s*(?:https?:|file:|\.{0,2}\/)/i.test(String(svgText || ''))
}

/**
 * 等待 <img> 完成 SVG 载入（带超时）。
 *
 * ★ 为什么要自己加超时：worker 窗口是 show:false 的隐藏窗口，
 *   若某个 SVG 卡在渲染进程内部，onload/onerror 可能永远不来。
 *   不加超时的话，主进程要等 request() 的 30s 兜底才失败，
 *   错误信息变成"转换工作器超时" —— 排障时完全看不出是 SVG 的问题。
 *
 * @param {HTMLImageElement} img
 * @returns {Promise<void>}
 */
function waitImageLoaded (img) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('SVG 载入超时'))
    }, SVG_LOAD_TIMEOUT_MS)
    img.onload = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    img.onerror = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('SVG 解析失败（文件损坏或含不支持的语法）'))
    }
  })
}

/**
 * 画布是不是全透明的（采样判断）。
 *
 * 为什么采样而不是整幅 getImageData：8192×8192 的整幅像素约 268MB，
 * 只为得到一个"是否空白"的警告标记，不值当。7×7 网格足够发现
 * "完全没画出东西"这种情况，也足够便宜。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @returns {boolean}
 */
function isCanvasBlank (ctx, w, h) {
  const steps = 7
  try {
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < steps; j++) {
        const x = Math.min(w - 1, Math.max(0, Math.floor((i + 0.5) * w / steps)))
        const y = Math.min(h - 1, Math.max(0, Math.floor((j + 0.5) * h / steps)))
        const d = ctx.getImageData(x, y, 1, 1).data
        if (d[3] !== 0) return false
      }
    }
  } catch (_) {
    // 取不到像素就当作"非空"：宁可漏报，也不要误报成功产物是空图
    return false
  }
  return true
}

/**
 * 把 SVG 文本光栅化到 canvas，返回 canvasId。
 *
 * ★ 为什么不用 createImageBitmap(svgBlob)（实测：**一律失败**）：
 *   Electron 33 / Chromium 对 SVG 的 blob 调 createImageBitmap 直接抛
 *   `InvalidStateError: The source image could not be decoded.` ——
 *   不是"没有尺寸时才失败"，连 width/height 齐全的 SVG 也一样（已逐个探过）。
 *   而 `<img>` + drawImage 走的是完整的 SVG 图片渲染管线，viewBox 会被正常套用。
 *
 * ★ 为什么用 Blob URL 而不是 data: base64：
 *   `btoa` 只能编码 Latin-1，SVG 里只要有一个中文文本节点就抛
 *   InvalidCharacterError；绕开得写 `unescape(encodeURIComponent(...))`，
 *   而 unescape 已废弃。Blob URL 让浏览器自己处理编码，零坑、也不用把
 *   整段 SVG 在内存里再膨胀 33%。
 *
 * @param {string} svgText SVG 源文本
 * @param {object} [opts]
 * @param {number} [opts.maxSide] 最长边上限（默认 MAX_RENDER_SIDE）
 * @returns {Promise<{ok:boolean, width?:number, height?:number, canvasId?:string,
 *                    scaled?:boolean, blank?:boolean, tainted?:boolean, error?:string}>}
 */
async function renderSvg (svgText, opts) {
  const o = opts || {}
  const text = String(svgText == null ? '' : svgText)
  if (!text.trim()) return { ok: false, error: 'SVG 文件内容为空' }
  if (!/<svg[\s>]/i.test(text)) {
    return { ok: false, error: '不是有效的 SVG 文本（找不到 <svg> 根元素）' }
  }

  const maxSide = Number(o.maxSide) > 0 ? Math.floor(Number(o.maxSide)) : MAX_RENDER_SIDE
  const metrics = parseSvgMetrics(text)

  let url = ''
  try {
    const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' })
    url = URL.createObjectURL(blob)

    const img = new Image()
    img.src = url
    await waitImageLoaded(img)
    // 显式再等一次 decode：drawImage 会隐式解码，但某些情况下拿到的仍是
    // 未解码完毕的帧，画出来是全透明的。decode() 在 onload 已成功后**仍可能**
    // 拒绝（Chromium 对 SVG 的已知抖动），这种不算失败 —— 真正的失败
    // 会由后面的尺寸校验与 blank 标记暴露出来。
    if (typeof img.decode === 'function') {
      try { await img.decode() } catch (_) {}
    }

    const size = decideRenderSize(metrics, img)
    if (!size.ok) return size

    let width = Math.max(1, Math.round(size.width))
    let height = Math.max(1, Math.round(size.height))
    let scaled = false
    const longest = Math.max(width, height)
    if (longest > maxSide) {
      const k = maxSide / longest
      width = Math.max(1, Math.round(width * k))
      height = Math.max(1, Math.round(height * k))
      scaled = true
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    // SVG 是矢量图，默认无背景。显式清空，避免复用画布时残留像素。
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)

    // ★ 污染探测：含 <foreignObject> 的 SVG 画进 canvas 后整张画布变"被污染"，
    //   之后 toBlob 抛 SecurityError。在这里读一个像素就能提前发现，
    //   报错能说清是"内容受安全策略限制"，而不是等编码阶段给一个笼统的失败。
    try {
      ctx.getImageData(0, 0, 1, 1)
    } catch (err) {
      return { ok: false, error: taintMessage(err), tainted: true }
    }

    const id = 'c' + Math.random().toString(36).slice(2, 10)
    canvasStore.set(id, canvas)

    const out = { ok: true, width, height, canvasId: id }
    if (scaled) out.scaled = true
    // 引用了外部资源 → 那些位置在 SVG-as-image 模式下不会被加载（实测不请求），
    // 产物会"少东西"。标记出来，日志里能解释用户看到的空白。
    if (hasExternalRef(text)) out.externalRef = true
    // 全透明不是错误（空 SVG 本身合法），但要给调用方一个提示标记：
    // <foreignObject> / 外部字体这类内容在隐藏窗口里常常画不出来，
    // 结果是"成功产出一张全透明的图"。标记出来，日志里才看得出端倪。
    if (isCanvasBlank(ctx, width, height)) out.blank = true
    return out
  } catch (err) {
    return { ok: false, error: taintMessage(err) }
  } finally {
    // ★ 画完才回收：早于 drawImage 撤销会让图像变成"已失效"，
    //   drawImage 抛 InvalidStateError（这个坑在 Chrome 上很常见）。
    if (url) URL.revokeObjectURL(url)
  }
}

// ---------------------------------------------------------------- PDF（pdfjs 6.x ESM）

/**
 * pdfjs 模块缓存（Promise，避免并发请求各自 import 一遍）。
 *
 * ★ 加载方式（2026-11-17 真机实测）：
 *   - pdfjs-dist 6.5.438 只有 ESM(.mjs)，主进程 Node 22 里 import 会报
 *     `Promise.try is not a function` + "Please use the legacy build in Node.js"，
 *     Windows 上还必须传 file:/// URL ⇒ 主进程不可用；
 *   - 渲染进程里 `await import('./vendor/pdf.min.mjs')` **可用**，
 *     `new Worker('./vendor/pdf-worker-entry.mjs', {type:'module'})` 也可用 ——
 *     当前 `script-src 'self' / default-src 'self'` 的 CSP 下无需放宽，
 *     `connect-src 'none'` 保持不动（离线承诺）。
 *
 * ★ 必须先装 pdf-polyfill.mjs：Electron 33 的 Chromium 缺
 *   Map/WeakMap#getOrInsertComputed、Uint8Array#toHex 等 pdfjs 6 用到的新 API，
 *   不补会在 getDocument() 阶段直接抛 TypeError（已逐层实测定位）。
 */
let pdfjsPromise = null

/**
 * 加载 pdfjs（幂等）。
 * @returns {Promise<object>} pdfjs 模块命名空间
 */
async function loadPdfjs () {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const polyfill = await import('./vendor/pdf-polyfill.mjs')
      polyfill.installPdfPolyfills()
      const pdfjs = await import('./vendor/pdf.min.mjs')
      // 用兼容入口而不是官方 worker：里面先补 API 再动态 import 官方 worker
      pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf-worker-entry.mjs'
      return pdfjs
    })().catch(err => {
      // 加载失败不缓存，下次请求还有机会（例如临时文件问题）
      pdfjsPromise = null
      throw err
    })
  }
  return pdfjsPromise
}

/**
 * PDF 魔数校验：%PDF-（5 字节）。
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function hasPdfMagic (bytes) {
  if (!bytes || bytes.length < 5) return false
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2d
}

/**
 * 把 pdfjs 的异常翻成用户能看懂的中文，并标出"加密"这种需要特判的情况。
 *
 * @param {*} err
 * @returns {{ok:false, error:string, encrypted:boolean}}
 */
function pdfFailure (err) {
  const msg = (err && err.message) || String(err || '')
  const name = (err && err.name) || ''
  const encrypted = name === 'PasswordException' ||
    /password|encrypt|需要密码|encrypted/i.test(msg)
  return {
    ok: false,
    encrypted,
    error: encrypted
      ? 'PDF 已加密（需要密码），暂不支持转换'
      : (/invalid pdf|format error|missing pdf|损坏/i.test(msg)
          ? 'PDF 文件损坏或格式无效'
          : ('PDF 处理失败：' + msg.slice(0, 200)))
  }
}

/**
 * 打开一个 PDF（带魔数校验与统一错误分类）。
 *
 * @param {Uint8Array|number[]} bytes
 * @returns {Promise<{pdfjs:object, task:object, pdf:object}|object>} 成功或 pdfFailure()
 */
async function openPdf (bytes) {
  const view = (bytes instanceof Uint8Array)
    ? (bytes.buffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes)
    : new Uint8Array(Array.isArray(bytes) ? bytes : [])
  if (!view.length) return { ok: false, error: 'PDF 文件为空或读不到' }
  if (!hasPdfMagic(view)) {
    return { ok: false, error: '不是有效的 PDF 文件（缺少 %PDF- 魔数）' }
  }
  try {
    const pdfjs = await loadPdfjs()
    const task = pdfjs.getDocument({ data: view })
    const pdf = await task.promise
    // ★ 必须带 ok:true：调用方靠 `if (!opened.ok) return opened` 判失败，
    //   漏掉这个字段会把整个 pdfjs/task/pdf 对象当成"失败结果"送进 IPC ——
    //   它们不可结构化克隆，回信直接抛 "An object could not be cloned"，
    //   主进程则挂到超时（真机 e2e 抓到过这个坑）。
    return { ok: true, pdfjs, task, pdf }
  } catch (err) {
    return pdfFailure(err)
  }
}

/**
 * 渲染 PDF 指定页到 canvas，返回 canvasId。
 *
 * ★ pageNumber 缺省仍是第 1 页：默认调用 `renderPdf(bytes, {})` 的行为
 *   与加选项之前逐字节一致（大量既有测试依赖这一基线）。
 *   只有 provider 显式传 pageNumber 才逐页渲染；页码合法性在这里校验，
 *   越界必须明确失败 —— 不能让 pdfjs 静默返回一个空页假装成功。
 *
 * @param {Uint8Array|number[]} bytes
 * @param {object} [opts] { scale, maxSide, pageNumber }
 * @returns {Promise<{ok:boolean, width?:number, height?:number, canvasId?:string,
 *                    numPages?:number, scaled?:boolean, error?:string, encrypted?:boolean}>}
 */
async function renderPdf (bytes, opts) {
  const o = opts || {}
  const opened = await openPdf(bytes)
  if (!opened.ok) return opened
  const { task, pdf } = opened
  try {
    const numPages = Number(pdf.numPages) || 0
    if (numPages < 1) return { ok: false, error: 'PDF 没有任何页面' }
    // 未指定 pageNumber ⇒ 1（与旧行为一致）；显式给了就必须是 [1, numPages] 内的整数
    const rawPage = o.pageNumber
    const hasPage = rawPage !== undefined && rawPage !== null && rawPage !== ''
    const pageNumber = hasPage ? Number(rawPage) : 1
    if (hasPage && (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > numPages)) {
      return {
        ok: false,
        error: 'PDF 页码超出范围：第 ' + String(rawPage) + ' 页（共 ' + numPages + ' 页）'
      }
    }
    const page = await pdf.getPage(pageNumber)

    let vp = page.getViewport({ scale: 1 })
    const maxSide = Number(o.maxSide) > 0 ? Math.floor(Number(o.maxSide)) : MAX_RENDER_SIDE
    let scale = Number(o.scale) > 0 ? Number(o.scale) : 1
    const longest = Math.max(vp.width, vp.height)
    let scaled = false
    if (longest > maxSide) {
      scale *= maxSide / longest
      scaled = true
    }
    if (scale !== 1) vp = page.getViewport({ scale })

    const width = Math.max(1, Math.floor(vp.width))
    const height = Math.max(1, Math.floor(vp.height))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, width, height)
    const renderTask = page.render({ canvasContext: ctx, viewport: vp })
    await renderTask.promise

    const id = 'c' + Math.random().toString(36).slice(2, 10)
    canvasStore.set(id, canvas)
    const out = { ok: true, width, height, canvasId: id, numPages }
    if (scaled) out.scaled = true
    return out
  } catch (err) {
    return pdfFailure(err)
  } finally {
    try { await task.destroy() } catch (_) {}
  }
}

/**
 * 把一页的 getTextContent 拼成文本。
 *
 * 逐 item 拼接，并尊重 pdfjs 给的 hasEOL（行末标记）——
 * 只拼 str 会把多栏/多行文字挤成一坨，用户搜不到关键词。
 *
 * @param {object} page pdfjs 的 PDFPageProxy
 * @returns {Promise<string>}
 */
async function textOfPage (page) {
  const content = await page.getTextContent()
  let text = ''
  for (const item of (content.items || [])) {
    if (item && typeof item.str === 'string') text += item.str
    if (item && item.hasEOL) text += '\n'
  }
  return text
}

/**
 * 抽取 PDF 文本：默认只抽第 1 页；opts.allPages=true 时逐页抽取。
 *
 * ★ 页间分隔符固定为 "\n\n"（空行），不用 "[page N]" 之类的人造标记：
 *   产物是给用户复制/搜索的纯文本，插标记会污染内容；空行既是通用分页
 *   习惯，又不会破坏既有"第 1 页文本一字不变"的基线。
 *
 * ★ maxPages 由 provider 传入（MAX_ALL_PAGES），防止几百页 PDF 在一次
 *   IPC 里反复 getTextContent 把 worker 线程卡死。
 *
 * @param {Uint8Array|number[]} bytes
 * @param {object} [opts] { allPages?:boolean, maxPages?:number }
 * @returns {Promise<{ok:boolean, text?:string, numPages?:number,
 *                    pagesConverted?:number, error?:string, encrypted?:boolean}>}
 */
async function extractPdfText (bytes, opts) {
  const o = opts || {}
  const opened = await openPdf(bytes)
  if (!opened.ok) return opened
  const { task, pdf } = opened
  try {
    const numPages = Number(pdf.numPages) || 0
    if (numPages < 1) return { ok: false, error: 'PDF 没有任何页面' }
    const page = await pdf.getPage(1)
    if (o.allPages !== true) {
      // 旧路径一字不变：只用第 1 页，不回 pagesConverted
      return { ok: true, text: await textOfPage(page), numPages }
    }
    const maxPages = Number(o.maxPages) > 0 ? Math.floor(Number(o.maxPages)) : numPages
    const count = Math.min(numPages, maxPages)
    const parts = [await textOfPage(page)]
    for (let n = 2; n <= count; n++) {
      try {
        const p = await pdf.getPage(n)
        parts.push(await textOfPage(p))
      } catch (err) {
        return pdfFailure(new Error(
          '第 ' + n + ' 页文本抽取失败：' + ((err && err.message) || String(err))))
      }
    }
    return { ok: true, text: parts.join('\n\n'), numPages, pagesConverted: count }
  } catch (err) {
    return pdfFailure(err)
  } finally {
    try { await task.destroy() } catch (_) {}
  }
}

/**
 * 抽取一页 PDF 的结构化文本项（含坐标、字号、字体家族），供版面启发式重建。
 *
 * @param {object} page pdfjs 的 PDFPageProxy
 * @param {number} pageNumber
 * @returns {Promise<{pageNumber:number, width:number, height:number, items:Array}>}
 */
async function structuredOfPage (page, pageNumber) {
  const vp = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const styles = (content && content.styles) || {}
  const items = []
  for (const item of (content && content.items) || []) {
    if (!item || typeof item.str !== 'string') continue
    const t = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0]
    const fontSize = Math.hypot(Number(t[0]) || 0, Number(t[1]) || 0) ||
      Math.abs(Number(t[3]) || 0) ||
      Number(item.height) || 12
    const style = item.fontName && styles[item.fontName]
    items.push({
      str: item.str,
      x: Number(t[4]) || 0,
      y: Number(t[5]) || 0,
      width: Number(item.width) || 0,
      height: Number(item.height) || fontSize,
      fontSize: Math.round(fontSize * 100) / 100,
      fontName: String((style && style.fontFamily) || item.fontName || ''),
      hasEOL: !!item.hasEOL
    })
  }
  return {
    pageNumber,
    width: Number(vp.width) || 0,
    height: Number(vp.height) || 0,
    items
  }
}

/**
 * 抽取 PDF 结构化文本：默认第 1 页；opts.allPages=true 时逐页抽取（受 maxPages 限制）。
 *
 * @param {Uint8Array|number[]} bytes
 * @param {object} [opts] { allPages?:boolean, maxPages?:number }
 * @returns {Promise<{ok:boolean, pages?:Array, numPages?:number, pagesConverted?:number, error?:string, encrypted?:boolean}>}
 */
async function extractPdfStructured (bytes, opts) {
  const o = opts || {}
  const opened = await openPdf(bytes)
  if (!opened.ok) return opened
  const { task, pdf } = opened
  try {
    const numPages = Number(pdf.numPages) || 0
    if (numPages < 1) return { ok: false, error: 'PDF 没有任何页面' }
    const page1 = await pdf.getPage(1)
    if (o.allPages !== true) {
      return { ok: true, pages: [await structuredOfPage(page1, 1)], numPages, pagesConverted: 1 }
    }
    const maxPages = Number(o.maxPages) > 0 ? Math.floor(Number(o.maxPages)) : numPages
    const count = Math.min(numPages, maxPages)
    const pages = [await structuredOfPage(page1, 1)]
    for (let n = 2; n <= count; n++) {
      try {
        const p = await pdf.getPage(n)
        pages.push(await structuredOfPage(p, n))
      } catch (err) {
        return pdfFailure(new Error(
          '第 ' + n + ' 页结构化抽取失败：' + ((err && err.message) || String(err))))
      }
    }
    return { ok: true, pages, numPages, pagesConverted: count }
  } catch (err) {
    return pdfFailure(err)
  } finally {
    try { await task.destroy() } catch (_) {}
  }
}

// ---------------------------------------------------------------- IPC

/**
 * 解码请求。
 * @param {string} reqId 主进程给的请求 id（回信时要带回，否则主进程匹配不上）
 * @param {Uint8Array|number[]} bytes 图片原始字节
 * @param {string} [mime] 主进程按扩展名推断的 mime
 */
async function onDecode (reqId, bytes, mime) {
  const r = await decodeImage(bytes, mime)
  if (!r.ok) {
    window.sticky.workerDecoded(reqId, r)
    return
  }
  // canvas 不能通过 IPC 传 ⇒ 把画布暂存起来，用一个 id 索引
  const id = 'c' + Math.random().toString(36).slice(2, 10)
  canvasStore.set(id, r.canvas)
  window.sticky.workerDecoded(reqId, { ok: true, width: r.width, height: r.height, canvasId: id })
}

/**
 * 编码请求。
 * @param {string} reqId
 * @param {string} canvasId
 * @param {string} mime
 */
async function onEncode (reqId, canvasId, mime) {
  const canvas = canvasStore.get(canvasId)
  if (!canvas) {
    window.sticky.workerEncoded(reqId, { ok: false, error: '画布已失效' })
    return
  }
  const r = await encodeImage(canvas, mime)
  canvasStore.delete(canvasId)
  window.sticky.workerEncoded(reqId, r)
}

/** 暂存画布（canvas 不能结构化克隆，只能在渲染进程里留着） */
const canvasStore = new Map()

/**
 * SVG 光栅化请求。
 *
 * ★ 回信走 `workerDecoded`：主进程已经有 `convert:worker-decoded` 的监听器，
 *   复用它就不必为 SVG 再加一个监听 + 一套 pending 匹配。
 *   只要能保证「reqId 原样带回」，复用通道不影响并发正确性。
 *
 * @param {string} reqId
 * @param {string} svgText
 * @param {object} [opts]
 */
async function onRenderSvg (reqId, svgText, opts) {
  let r
  try {
    r = await renderSvg(svgText, opts)
  } catch (err) {
    // renderSvg 内部已兜一层；这里再兜一层，保证**永远**有回信
    // （没有回信 = 主进程挂到超时，错误信息会完全失真）
    r = { ok: false, error: (err && err.message) || String(err) }
  }
  window.sticky.workerDecoded(reqId, r)
}

/**
 * PDF 渲染请求。
 *
 * ★ 回信统一走 workerDecoded（convert:worker-decoded），与 SVG 同一条通道：
 *   主进程已为它挂了 pending 匹配，不必为 PDF 再注册一套监听。
 *
 * @param {string} reqId
 * @param {Uint8Array|number[]} bytes
 * @param {object} [opts]
 */
async function onRenderPdf (reqId, bytes, opts) {
  let r
  try {
    r = await renderPdf(bytes, opts)
  } catch (err) {
    // 永远要有回信：没有回信 = 主进程挂到 30s 超时，错误信息会完全失真
    r = { ok: false, error: (err && err.message) || String(err) }
  }
  replyPdf(reqId, r)
}

/**
 * PDF 通道的回信（保证主进程一定能收到一个**可克隆**的结果）。
 *
 * ★ 为什么单独包一层（真机踩坑）：openPdf 成功时返回的对象里带
 *   pdfjs / task / pdf 三个实例。任何一条"忘记展开就回信"的路径都会让
 *   ipcRenderer.send 抛 `An object could not be cloned.`，而异常发生在
 *   async 函数里 ⇒ 主进程收不到回信，只能等 30s 超时，错误信息完全失真。
 *   这里兜底把结果替换成纯字符串错误，至少让调用方立刻拿到可读失败。
 *
 * @param {string} reqId
 * @param {object} r
 */
function replyPdf (reqId, r) {
  try {
    window.sticky.workerDecoded(reqId, r)
  } catch (e) {
    try {
      window.sticky.workerDecoded(reqId, {
        ok: false,
        error: 'PDF 处理结果无法回传（含不可克隆对象）：' + ((e && e.message) || String(e))
      })
    } catch (_) {}
  }
}

/**
 * PDF 文本抽取请求。
 * @param {string} reqId
 * @param {Uint8Array|number[]} bytes
 * @param {object} [opts] 来自 preload 的转发（全页模式带 allPages/maxPages）
 */
async function onExtractPdfText (reqId, bytes, opts) {
  let r
  try {
    r = await extractPdfText(bytes, opts)
  } catch (err) {
    r = { ok: false, error: (err && err.message) || String(err) }
  }
  replyPdf(reqId, r)
}

/**
 * PDF 结构化文本抽取请求（供 pdf→md 使用）。
 * @param {string} reqId
 * @param {Uint8Array|number[]} bytes
 * @param {object} [opts]
 */
async function onExtractPdfStructured (reqId, bytes, opts) {
  let r
  try {
    r = await extractPdfStructured(bytes, opts)
  } catch (err) {
    r = { ok: false, error: (err && err.message) || String(err) }
  }
  replyPdf(reqId, r)
}

/**
 * 图片转码请求（webp/gif → PNG 中间格式，供图片→PDF 使用）。
 *
 * ★ 回信走 workerDecoded（convert:worker-decoded），与 SVG/PDF 同一条通道：
 *   主进程已为它挂了 pending 匹配，只要 reqId 原样带回就不会串台。
 *
 * @param {string} reqId
 * @param {Uint8Array|number[]} bytes
 * @param {string} mime 目标 mime
 * @param {object} [opts] { sourceMime }
 */
async function onTranscodeImage (reqId, bytes, mime, opts) {
  let r
  try {
    r = await transcodeImage(bytes, mime, opts)
  } catch (err) {
    r = { ok: false, error: (err && err.message) || String(err) }
  }
  try {
    window.sticky.workerDecoded(reqId, r)
  } catch (e) {
    try {
      window.sticky.workerDecoded(reqId, {
        ok: false,
        error: '图片转码结果无法回传：' + ((e && e.message) || String(e))
      })
    } catch (_) {}
  }
}

// ---------------------------------------------------------------- 注册

/**
 * ★ 为什么套一层 typeof window（2026-11-16，为单测开的口子）：
 *   本文件在应用里是以 `<script src>` 加载的**页面脚本**（浏览器环境，没有 module）；
 *   但"尺寸该怎么定"这类纯逻辑值得被 node:test 直接驱动 —— 否则改一行判定规则
 *   都要起整个 Electron 才能验，回归成本太高。
 *   浏览器里 typeof window === 'object' ⇒ 照常注册 IPC；
 *   node 里没有 window ⇒ 跳过注册，只导出纯函数（见文件末尾）。
 */
if (typeof window !== 'undefined' && window.sticky && typeof window.sticky.onWorkerDecode === 'function') {
  window.sticky.onWorkerDecode(onDecode)
  window.sticky.onWorkerEncode(onEncode)
  window.sticky.onWorkerRenderSvg(onRenderSvg)
  window.sticky.onWorkerRenderPdf(onRenderPdf)
  window.sticky.onWorkerExtractPdfText(onExtractPdfText)
  if (typeof window.sticky.onWorkerExtractPdfStructured === 'function') {
    window.sticky.onWorkerExtractPdfStructured(onExtractPdfStructured)
  }
  window.sticky.onWorkerTranscodeImage(onTranscodeImage)

  // 自检信息：本 worker 支持哪些编解码。
  //
  // ★ 不能写成 `window.sticky.workerCodecs = ...`（2026-11-16 QA 抓到）：
  //   `window.sticky` 是 contextBridge 暴露出来的对象，被冻结
  //   （Object.isFrozen === true），本文件顶部是 'use strict'，
  //   给冻结对象加属性会抛
  //   `TypeError: Cannot add property workerCodecs, object is not extensible`
  //   —— 每加载一次 worker 就留一条未捕获异常，而这段"自检"从来没生效过。
  //   改挂到 globalThis（window 本身是可扩展的），信息保留、不再炸。
  globalThis.__convertWorkerCodecs = {
    encode: Object.keys(ENCODE_MIME),
    decode: Object.keys(DECODE_MIME),
    render: ['svg', 'pdf'],
    text: ['pdf'],
    transcode: Object.keys(TRANSCODE_SOURCE_MIME)
  }
}

// 纯逻辑导出（只给 node:test 用；浏览器里 module 不存在，这段不执行）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ENCODE_MIME,
    DECODE_MIME,
    TRANSCODE_SOURCE_MIME,
    MAX_RENDER_SIDE,
    FALLBACK_BOX,
    parseSvgMetrics,
    decideRenderSize,
    parseLength,
    hasExternalRef,
    hasPdfMagic,
    sniffImageMime
  }
}
