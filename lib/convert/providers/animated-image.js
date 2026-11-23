'use strict'

/**
 * 动图判定（容器格式探测，纯 JS，不依赖 Electron）。
 *
 * ============================ 为什么需要它 ============================
 *   图片 → PDF 时遇到动图（多帧 gif / 含 ANIM 的 webp），
 *   只能取**首帧**写进 PDF —— 用户必须被明确告知"你拿到的不是全部帧"，
 *   否则就是另一种假成功（少给了内容却宣称成功）。
 *
 * ============================ 为什么不能用扩展名猜 ============================
 *   把 `anim.gif` 改名成 `anim.png` 就骗过去了 —— 扩展名是文件名的一部分，
 *   不代表内容。所以判定必须**看字节**：
 *     - gif：文件头 GIF87a / GIF89a，再逐块扫描数 image descriptor（0x2C）
 *     - webp：RIFF 容器里是否有 ANIM chunk
 *
 * ============================ 为什么不放渲染进程 ============================
 *   canvas 的 createImageBitmap 只给首帧，拿不到帧数；
 *   而这层判定必须是**纯函数**，才能被 node:test 直接驱动（不必起 Electron）。
 *
 * ============================ 畸形文件的处理 ============================
 *   解析不出块结构时按"静态"处理并给出 reason（宁可少报也不误报）：
 *   这种文件通常已经被魔数校验先拦下了。
 */

/** GIF 的两个合法文件头 */
const GIF_HEADERS = ['GIF87a', 'GIF89a']

/**
 * 取一段 ASCII 文本（越界返回空串）。
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} len
 * @returns {string}
 */
function asciiAt (buf, offset, len) {
  if (!buf || offset < 0 || offset + len > buf.length) return ''
  return buf.slice(offset, offset + len).toString('ascii')
}

/**
 * 是不是 GIF（只看文件头，不看扩展名）。
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isGifBytes (buf) {
  return GIF_HEADERS.indexOf(asciiAt(buf, 0, 6)) >= 0
}

/**
 * 是不是 WEBP（RIFF 容器：offset 0 是 'RIFF'、offset 8 是 'WEBP'）。
 *
 * ⚠️ 只比 4 字节会把 AVI/WAV 也放过去 —— 必须连 offset 8 一起看。
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isWebpBytes (buf) {
  return asciiAt(buf, 0, 4) === 'RIFF' && asciiAt(buf, 8, 4) === 'WEBP'
}

/**
 * 探测字节的**真实**图片格式（不信扩展名）。
 * @param {Buffer} buf
 * @returns {'png'|'jpg'|'gif'|'webp'|null}
 */
function detectImageType (buf) {
  if (!buf || buf.length < 4) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (isGifBytes(buf)) return 'gif'
  if (isWebpBytes(buf)) return 'webp'
  return null
}

/**
 * 扫 GIF 的块结构，数出 image descriptor 的个数。
 *
 * GIF 结构（简化）：
 *   "GIF89a" + 逻辑屏幕描述(7B) [+ 全局颜色表]
 *   然后是若干块：
 *     0x21 = 扩展块（后面跟着若干长度前缀的子块，以 0 结束）
 *     0x2C = 图像描述符（**一帧**）+ 局部颜色表 + 图像数据子块
 *     0x3B = 结束符
 *
 * @param {Buffer} buf
 * @returns {{frames:number, parsed:boolean}}
 */
function countGifFrames (buf) {
  let p = 6
  if (buf.length < p + 7) return { frames: 0, parsed: false }
  const packed = buf[10]           // 逻辑屏幕描述里的 packed 字段
  p += 7                           // 跳过逻辑屏幕描述
  if (packed & 0x80) {
    p += 3 * (1 << ((packed & 0x07) + 1))   // 全局颜色表
  }

  let frames = 0
  while (p < buf.length) {
    const marker = buf[p]
    if (marker === 0x3b) return { frames, parsed: true }         // trailer
    if (marker === 0x21) {                                       // 扩展块
      p += 2                                                    // 0x21 + label
      while (p < buf.length) {
        const len = buf[p]
        p += 1
        if (len === 0) break
        p += len
      }
      continue
    }
    if (marker === 0x2c) {                                       // 图像描述符 = 一帧
      frames++
      if (p + 11 > buf.length) return { frames, parsed: false }
      const local = buf[p + 9]
      p += 10                                                   // 跳过 9 字节图像描述符
      p += 1                                                    // 跳过 LZW 最小码长
      if (local & 0x80) p += 3 * (1 << ((local & 0x07) + 1))   // 局部颜色表
      while (p < buf.length) {                                  // 图像数据子块
        const len = buf[p]
        p += 1
        if (len === 0) break
        p += len
      }
      continue
    }
    return { frames, parsed: false }   // 未知块 ⇒ 结构没解析出来
  }
  return { frames, parsed: false }     // 没走到 trailer ⇒ 同样算没解析出来
}

/**
 * webp 是否含 ANIM chunk（动画容器）。
 *
 * ★ 2026-11-18（F4）：区分两种"没有 ANIM chunk"的结局：
 *   - `false`  = chunk 结构**干净扫完**，确实没有 ANIM ⇒ 合法的静态 webp
 *   - `null`   = 结构**被截断**（扫描指针越过 buffer 末尾）⇒ 解析不出来
 *   之前两者都返回 null ⇒ 合法静态 webp 被标成 'webp-unparsable'，reason 语义误导
 *   （判定结果 animated=false 本身是对的，只有 reason 说不清）。
 *
 * @param {Buffer} buf
 * @returns {boolean|null} null = 容器结构没解析出来（按静态处理）
 */
function webpHasAnimChunk (buf) {
  if (!isWebpBytes(buf)) return null
  let p = 12
  while (p + 8 <= buf.length) {
    const fourcc = asciiAt(buf, p, 4)
    const size = buf.readUInt32LE(p + 4)
    if (fourcc === 'ANIM') return true
    // RIFF chunk：4 字节标识 + 4 字节长度 + 数据（长度为奇数时补 1 字节对齐）
    p += 8 + size + (size % 2)
  }
  // ★ 扫到末尾且没找到 ANIM ⇒ 结构是**完整**的 ⇒ 合法的静态 webp
  //   （p 恰好落在 buffer 末尾说明 chunk 边界严丝合缝，不是截断）。
  if (p === buf.length) return false
  // p > buf.length ⇒ 最后一个 chunk 的声明长度超出了实际数据 ⇒ 结构被截断
  return null
}

/**
 * 判定一个源文件是不是动图（**只看字节，不看扩展名**）。
 *
 * @param {Buffer|Uint8Array|number[]} bytes
 * @param {string} [ext] 扩展名（只作为提示，不作为判据）
 * @returns {{animated:boolean, reason:string, frames?:number, type?:string}}
 */
function detectAnimation (bytes, ext) {
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : (bytes instanceof Uint8Array
      ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : (Array.isArray(bytes) ? Buffer.from(bytes) : null))
  if (!buf || !buf.length) return { animated: false, reason: 'empty' }

  const type = detectImageType(buf)

  if (type === 'gif') {
    const r = countGifFrames(buf)
    if (!r.parsed) return { animated: false, reason: 'gif-unparsable', type }
    return { animated: r.frames >= 2, reason: 'gif-frames', frames: r.frames, type }
  }
  if (type === 'webp') {
    const r = webpHasAnimChunk(buf)
    // ★ F4：r === false = chunk 结构干净扫完 ⇒ 合法静态 webp（不是"解析不出来"）
    if (r === null) return { animated: false, reason: 'webp-unparsable', type }
    return { animated: r, reason: r ? 'webp-anim-chunk' : 'webp-static', type }
  }
  // 不是 gif/webp ⇒ 静态图（png/jpg 一定没有动画）
  return { animated: false, reason: type ? 'static-' + type : 'unknown', type: type || undefined }
}

module.exports = {
  GIF_HEADERS,
  isGifBytes,
  isWebpBytes,
  detectImageType,
  countGifFrames,
  webpHasAnimChunk,
  detectAnimation
}
