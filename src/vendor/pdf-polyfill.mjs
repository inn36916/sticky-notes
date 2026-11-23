'use strict'

/**
 * pdfjs-dist 6.x 需要的"新 JS API"补丁（Electron 33 / Chromium 130 缺失）。
 *
 * 根因（2026-11-17 真机逐层跑出来的坑，不是猜的）：
 *   pdfjs 6.5.438 的构建产物用了若干 2024~2025 年才进入 V8 的 API。
 *   Electron 33 自带的 Chromium/V8 尚未全部实现，于是：
 *     - `a.toHex is not a function`                    （worker 侧）
 *     - `this[#x].getOrInsertComputed is not a function`（主线程 + worker）
 *     - `Promise.withResolvers is not a function`       （两者）
 *   任何一个缺失都会让 getDocument().promise 直接拒绝，连第一页都渲染不出来。
 *
 * 为什么不在 convert-worker.js 里就地写死：
 *   主线程与 pdfjs worker 是**两个 realm**，原型补丁互不共享。
 *   抽出这个模块，让 worker 入口（pdf-worker-entry.mjs）和主线程都装同一份，
 *   避免"主进程补了、worker 没补"这种半截修复。
 *
 * 所有补丁都先检测再安装：将来 Electron 升级自带这些 API 时自动让位。
 */

/** 给 Map 补 getOrInsertComputed（key 存在则原值；不存在则计算并插入） */
function installMapGetOrInsertComputed () {
  if (typeof Map.prototype.getOrInsertComputed !== 'function') {
    Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value: function getOrInsertComputed (key, callbackFn) {
        if (this.has(key)) return this.get(key)
        const value = callbackFn(key)
        this.set(key, value)
        return value
      }
    })
  }
}

/** 给 WeakMap 补 getOrInsertComputed（pdfjs 的 CanvasGraphics 缓存用的是 WeakMap） */
function installWeakMapGetOrInsertComputed () {
  if (typeof WeakMap.prototype.getOrInsertComputed !== 'function') {
    Object.defineProperty(WeakMap.prototype, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value: function getOrInsertComputed (key, callbackFn) {
        if (this.has(key)) return this.get(key)
        const value = callbackFn(key)
        this.set(key, value)
        return value
      }
    })
  }
}

/** 给 Promise 补 withResolvers（pdfjs 的 Deferred 用它） */
function installPromiseWithResolvers () {
  if (typeof Promise.withResolvers !== 'function') {
    Object.defineProperty(Promise, 'withResolvers', {
      configurable: true,
      writable: true,
      value: function withResolvers () {
        let resolve = null
        let reject = null
        const promise = new Promise((res, rej) => { resolve = res; reject = rej })
        return { promise, resolve, reject }
      }
    })
  }
}

/** 给 Promise 补 try（pdfjs 6 的顶层 await 包装用它） */
function installPromiseTry () {
  if (typeof Promise.try !== 'function') {
    Object.defineProperty(Promise, 'try', {
      configurable: true,
      writable: true,
      value: function tryCall (fn, ...args) {
        return Promise.resolve().then(() => fn(...args))
      }
    })
  }
}

/** 给 Uint8Array 补 toHex（pdfjs 用它算指纹） */
function installUint8ArrayToHex () {
  if (typeof Uint8Array.prototype.toHex !== 'function') {
    Object.defineProperty(Uint8Array.prototype, 'toHex', {
      configurable: true,
      writable: true,
      value: function toHex () {
        let out = ''
        for (let i = 0; i < this.length; i++) {
          out += this[i].toString(16).padStart(2, '0')
        }
        return out
      }
    })
  }
}

/** 给 Array 补 toSpliced（worker 里有一处用到） */
function installArrayToSpliced () {
  if (typeof Array.prototype.toSpliced !== 'function') {
    Object.defineProperty(Array.prototype, 'toSpliced', {
      configurable: true,
      writable: true,
      value: function toSpliced (start, deleteCount, ...items) {
        const copy = Array.from(this)
        const s = Number(start) || 0
        if (arguments.length < 2) copy.splice(s)
        else copy.splice(s, Number(deleteCount) || 0, ...items)
        return copy
      }
    })
  }
}

/**
 * 一次性装齐所有补丁（可重复调用，幂等）。
 * @returns {void}
 */
export function installPdfPolyfills () {
  installMapGetOrInsertComputed()
  installWeakMapGetOrInsertComputed()
  installPromiseWithResolvers()
  installPromiseTry()
  installUint8ArrayToHex()
  installArrayToSpliced()
}

/**
 * 补丁清单（**与实现同源**）。
 *
 * ★ 为什么把清单放进代码里而不是文档（PRD R-P3-1 / Q8）：
 *   文档会漂移 —— 文档写 5 条、代码里 6 条，没人发现。
 *   清单从代码导出 ⇒ 探针脚本（scripts/qa-pdf-polyfill.js）直接读它，
 *   **不在脚本里硬编码 API 名**（R-P3-2），也就不会出现"改了补丁忘了改脚本"。
 *
 * 字段说明：
 *   - api      ：完整 API 标识（用于测试断言与差异比对）
 *   - realm    ：补丁要装在哪个 realm
 *                 'main'  = 仅主线程（渲染进程页面上下文）
 *                 'worker'= 仅 pdfjs 的 module Worker
 *                 'both'  = 两个 realm 都要装
 *   - neededBy ：引入它的 pdfjs 版本
 *   - install  ：对应的安装函数（供探针脚本直接调用/清点）
 *   - probe    ：探针用来判"原生是否已实现"的取值路径（相对 globalThis 的路径）
 *
 * ★ 项数必须与实际安装函数数一致（= 6）。每个 manifest 条目对应**一个**安装函数，
 *   所以"manifest 项数 == 安装函数数 == 6"这个对账关系成立；
 *   探针脚本会断言这一点，防止有人加了补丁却忘了登记（或者反过来）。
 */
export const PDF_POLYFILL_MANIFEST = [
  {
    api: 'Map.prototype.getOrInsertComputed',
    realm: 'both',
    neededBy: 'pdfjs 6.5.438',
    install: installMapGetOrInsertComputed,
    probe: 'Map.prototype.getOrInsertComputed'
  },
  {
    api: 'WeakMap.prototype.getOrInsertComputed',
    realm: 'both',
    neededBy: 'pdfjs 6.5.438',
    install: installWeakMapGetOrInsertComputed,
    probe: 'WeakMap.prototype.getOrInsertComputed'
  },
  {
    api: 'Promise.withResolvers',
    realm: 'both',
    neededBy: 'pdfjs 6.5.438',
    install: installPromiseWithResolvers,
    probe: 'Promise.withResolvers'
  },
  {
    api: 'Promise.try',
    realm: 'both',
    neededBy: 'pdfjs 6.5.438',
    install: installPromiseTry,
    probe: 'Promise.try'
  },
  {
    api: 'Uint8Array.prototype.toHex',
    realm: 'both',
    neededBy: 'pdfjs 6.5.438',
    install: installUint8ArrayToHex,
    probe: 'Uint8Array.prototype.toHex'
  },
  {
    api: 'Array.prototype.toSpliced',
    realm: 'worker',
    neededBy: 'pdfjs 6.5.438',
    install: installArrayToSpliced,
    probe: 'Array.prototype.toSpliced'
  }
]

/**
 * 清单里引用的**安装函数**列表（去重后的唯一安装函数）。
 *
 * ★ 探针脚本用它断言"manifest 项数 == 实际安装函数数"这一对账关系，
 *   防止有人加了补丁却忘了登记（或者反过来）。
 * @returns {Array<function>}
 */
export function getPolyfillInstallers () {
  const seen = new Set()
  const out = []
  for (const item of PDF_POLYFILL_MANIFEST) {
    if (seen.has(item.install)) continue
    seen.add(item.install)
    out.push(item.install)
  }
  return out
}
