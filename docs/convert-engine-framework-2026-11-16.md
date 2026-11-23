# 转换引擎框架（可插拔 provider）设计与落地

> 日期：2026-11-16　｜　触发：用户明确「我不想安装 Filee，我想直接使用他们格式转换的代码」
> 前置调研：`docs/filee-code-reuse-feasibility-2026-11-16.md`（源码级事实核验）
> 决策：**不安装 Filee，搭可插拔引擎框架**；Filee 降级为可选增强；只做零引擎档

---

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 新增依赖 | **0**（沿用 electron + mermaid） |
| 单测 | 170 → **227**（+57） |
| e2e | 新增 2 个脚本（builtin 5/5、caps 5/5），原有 4 场景全绿 |
| 产物体积 | **不变**（未引入 native 库 / 运行时） |
| 不装 Filee 能否用 | ✅ **能**（图片 png/jpg/jpeg/webp + 文本数据 8 格式互转） |
| 装 Filee 是否有增益 | ✅ 自动多出 PDF/Office/HWP/矢量等格式 |

---

## 1. 为什么不是「嵌入 Filee 的 C# 代码」

源码级核验结论（详见前置文档）：

| 事实 | 证据 |
|---|---|
| Filee.Engines 是 **98,722 行** C#，靠 20+ 个 NuGet 包实现（Magick.NET / PDFsharp / SkiaSharp / PdfPig / ACadSharp…） | `Filee.Engines.csproj` |
| 零引擎档**也不是纯 C#**，需要整条 .NET 原生生态 | 同上 |
| 发布是 `--self-contained` ⇒ 含完整 .NET 运行时 | `build/build-installer.ps1` |
| 官方产物 132 MB（Setup）/ 155 MB（Portable） | GitHub Releases API |
| 需要 SDK **10.0.100**（本机只有 8.0.127） | `global.json` / `dotnet --list-sdks` |

**⇒ 嵌入 = 我方要装 .NET 10 SDK + 交叉编译链，产物 +132MB，与「让用户装 Filee」的体积完全一样，
却多背一个语言栈 + 11.7 万行 C# 维护面 + .NET↔Node IPC 桥。不划算。**

---

## 2. 架构

```
右键文件 → 格式选择窗
              │
              ▼
    lib/convert/router.js        ← 路由层：合并能力 + 多 provider 兜底
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 provider   provider   provider
 builtin-   builtin-   filee
 image      text-data  （可选增强）
    │         │         │
 canvas    纯 JS      Filee CLI
 (worker)              （装了才生效）
```

### 2.1 Provider 契约（`lib/convert/provider.js`）

```js
{
  id: 'builtin-image',
  name: '内置图片转换',
  async available ()            // 是否可用（带缓存）
  async capabilities (ext)      // → { ok, reason, targets[], withEngines[], displayName, error }
  async canHandle (ext, target) // 可选：不擅长就返回 false
  async convert (files, target, outDir)  // → { ok, reason, outputs[], failures[], files[], error }
}
```

**契约校验**（`validateProvider`）：缺方法在**装配时**就报错，不会等到用户右键点了才静默失败。

**为什么保留 `reason` / `withEngines` 这套老口径**：UI（`src/convert.js` 的 `reasonText`）不用改，
Filee provider 也能零成本接进来。

### 2.2 路由层（`lib/convert/router.js`）

- **能力查询合并**：多个 provider 的 `targets` 取并集去重 ⇒ 用户看到的是**能力全集**
- **转换路由**：按注册顺序取第一个能处理 `(ext → target)` 的可用 provider
- **失败兜底**：一个 provider 失败自动试下一个（内置快路径优先，失败可落到 Filee）
- **失败分类**：区分「引擎没装」（`not-installed`）与「引擎在但不支持」（`usage`）——
  这两者对用户的提示完全不同，混了就会误导

### 2.3 注册顺序（`lib/convert/providers/index.js`）

```
① builtin-image     （canvas，快路径、零依赖）
② builtin-text-data （纯 JS，永远可用）
③ filee             （可选增强：检测到就自动多一批格式）
```

---

## 3. 内置 provider

### 3.1 图片 provider（`providers/image.js` + `providers/image-worker.js`）

**为什么用 canvas 而不是 sharp**：sharp 是 native 依赖 + 体积；Chromium 自带 canvas 已覆盖实测可用的编码。

**架构**：canvas 只存在于渲染进程 ⇒ 主进程起一个**隐藏渲染窗口**（`src/convert-worker.html`），
主进程通过 `lib/convert/worker-host.js` 的 IPC 桥调用。

```
主进程                          隐藏渲染窗口
  │ send('convert:worker-decode', reqId, filePath)
  │ ─────────────────────────────►  decodeImage() → createImageBitmap → canvas
  │ ◄─────────────────────────────  send('convert:worker-decoded', reqId, {canvasId})
  │ send('convert:worker-encode', reqId, canvasId, mime)
  │ ─────────────────────────────►  canvas.toBlob → 字节
  │ ◄─────────────────────────────  send('convert:worker-encoded', reqId, {bytes})
```

### 3.2 🔴 实测发现的关键坑（2026-11-16）

**`canvas.toBlob(cb, mime)` 对不支持的 mime 会静默回退成 PNG** —— 不报错，`blob.type` 变成 `image/png`。

实测（Electron 33 / Chromium）：

| 请求的 mime | 实际 blob.type | 判定 |
|---|---|---|
| image/png | image/png | ✅ |
| image/jpeg | image/jpeg | ✅ |
| image/webp | image/webp | ✅ |
| image/gif | **image/png** | ❌ 静默回退 |
| image/bmp | **image/png** | ❌ 静默回退 |
| image/avif | **image/png** | ❌ 静默回退 |
| image/x-icon | **image/png** | ❌ 静默回退 |
| image/svg+xml | **image/png** | ❌ 静默回退 |
| image/tiff | **image/png** | ❌ 静默回退 |

**⇒ 必须校验返回的 `blob.type` 是否等于请求的 mime，不等就判失败。**
否则「转 gif」会产出一个 PNG 文件，用户以为成功了 —— 这类**假成功**比报错危险得多。

解码侧（`createImageBitmap`）：png / jpeg / gif / webp / bmp / avif / ico ✅；svg ✗（矢量，另走文本/矢量路线）。

**已知限制（如实告知）**：
- 转 jpeg 时透明区域变黑底（canvas 固有行为）
- 动图只取第一帧

### 3.3 文本/数据 provider（`providers/text-data.js`）

纯 JS，零依赖。覆盖：

```
json ↔ csv ↔ xml ↔ yaml ↔ toml ↔ md ↔ txt
```

| 方向 | 能力 |
|---|---|
| CSV | 双引号包裹、`""` 转义、字段内换行 |
| XML | 元素/文本/属性（`@attr`）/重复元素聚成数组；递归下降解析 |
| YAML | 扁平结构 + 一层列表；复杂语法明确报错 |
| TOML | `key = value` + `[table]`；数组/内联表支持 |
| Markdown | 只做「表格 ↔ 结构化数据」 |

**刻意的取舍**：YAML/TOML 只支持扁平结构，**遇到复杂嵌套明确报错而不是写出半成品**。
宁可明确失败，也不要静默丢数据。

---

## 4. 向后兼容

现有 170 条测试与 4 个 e2e 场景全部保持绿，做法是**保留旧路径**：

```js
// lib/convert/service.js
const router = deps.router || (deps.providers ? createRouter({providers}) : null)
const legacyProvider = router ? null : { id:'legacy-filee', available: async()=>true, ... }
const activeRouter = router || createRouter({ providers:[legacyProvider] })
```

- 传 `deps.providers` ⇒ 走新架构（多 provider）
- 传 `deps.cli` / `deps.resolveBin` ⇒ 走旧路径（单 Filee provider），行为**逐字节不变**

**踩过的坑**：legacy provider 的 `available()` 一开始返回 `!!resolveBin()`，导致
「Filee 没装」被 router 改写成「没有可用的转换引擎」，丢掉了可引导的提示。
⇒ 旧路径下 `available()` 恒为 true，"没装"由 `convert()` 自己返回 `not-installed`。

---

## 5. 验证

### 5.1 单测 227/227

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/convert-router.test.js`（新） | 28 | 契约校验、可用性缓存、能力合并、路由兜底、失败分类 |
| `test/convert-providers.test.js`（新） | 29 | 图片契约（白名单/失败分类/落盘）、文本数据 8 格式互转 |

### 5.2 e2e

| 脚本 | 结果 | 覆盖 |
|---|---|---|
| `e2e-convert-builtin.js`（新） | **5/5** | PNG→JPEG 产物是真 JPEG（魔数校验）、PNG→WEBP、**不支持的编码必须失败**、JSON→CSV 内容正确、不装 Filee 也有格式 |
| `e2e-convert-caps.js`（新） | **5/5** | 不装 Filee 时 png/json 能力查询可用、未知扩展名 → usage |
| `e2e-convert.js`（原有） | 4/4 | 未受影响 |
| `e2e-async-quit.js` | 5/5 | 未受影响 |
| `e2e-snapshot-semantics.js` | 5/5 | 未受影响 |
| `e2e-quit.js` | exitCode=0 | 未受影响 |
| `qa:audit` | 10/10 PASS 0 WARN | 未受影响 |

**魔数校验而非只信扩展名**：e2e 用文件头判定产物真实格式
（PNG `89 50 4E 47` / JPEG `FF D8 FF` / WEBP `RIFF....WEBP`），
这样「静默回退成 PNG」这类假成功**必然被抓住**。

### 5.3 实测发现的另外两个 Bug（我自己写的）

1. **XML 解析器把子元素丢了**
   根因：`String.match()` **不接受起始位置参数** —— 我传了 `this.i` 但被忽略，
   永远从字符串开头匹配 ⇒ 解析结果错乱。
   修复：先 `slice(this.i)` 再匹配。
   （顺带把"找闭合标签位置"改成游标递归下降 —— 前者在嵌套同名标签时会算错深度。）

2. **测试的 fake provider 覆盖方式错了**
   `Object.assign(provider, {decode})` 覆盖的是 provider 的属性，
   但 `createImageProvider` 内部是**闭包捕获** decode/encode ⇒ 覆盖无效。
   修复：通过 deps 传入。

---

## 6. 文件清单

### 新增

```
lib/convert/provider.js                 Provider 契约 + 注册表
lib/convert/router.js                   路由层（能力合并 + 兜底）
lib/convert/worker-host.js              主进程 ↔ 隐藏渲染窗口的 IPC 桥
lib/convert/providers/index.js          默认 provider 组装
lib/convert/providers/image.js          图片契约（纯逻辑，可单测）
lib/convert/providers/image-worker.js   图片契约的主进程接线
lib/convert/providers/text-data.js      文本/数据 provider
lib/convert/providers/filee.js          Filee provider（可选增强）
src/convert-worker.html                 转换工作器页面
src/convert-worker.js                   canvas 解码/编码实现
test/convert-router.test.js             28 条
test/convert-providers.test.js          29 条
scripts/e2e-convert-builtin.js          内置引擎 e2e（5 场景）
scripts/e2e-convert-caps.js             能力查询 e2e（5 场景）
```

### 修改

```
lib/convert/service.js       走 router（保留旧路径兼容）
lib/convert/main-bridge.js   接受 providers 参数
main.js                      装配 worker host + 默认 providers
preload.js                   worker IPC 通道（带 reqId）
src/convert.js               文案：不再假设"必须装 Filee"
src/dashboard.html           同上
package.json                 两个新 e2e 脚本
```

---

## 7. 已知限制与后续可选项

### 已知限制

1. **图片编码只有 png/jpeg/webp**（Chromium 实测上限）。gif/bmp/avif/tiff **不能转**（能解码）。
2. **动图只取第一帧**。
3. **jpeg 透明区变黑底**。
4. **YAML/TOML 只支持扁平结构**（刻意取舍：宁可明确失败）。
5. **不装 Filee 时没有 PDF/Office/矢量格式**——这是"只做零引擎档"决策的直接后果。

### 后续可选项（未做，等拍板）

| # | 选项 | 代价 | 收益 |
|---|---|---|---|
| O1 | 加 SVG 矢量 provider（文本/矢量，不走 canvas） | 小 | 覆盖 svg↔png 等常见需求 |
| O2 | 加 PDF provider（pdf-lib 或 pdf.js） | 中（+2~5MB） | 覆盖 pdf↔图片/文本 |
| O3 | 加 DOCX/XLSX provider（JSZip + xml） | 中 | 覆盖 Office |
| O4 | 把「需要引擎的格式」做成**我方托管下载** | 中 | 但 Ghostscript AGPL / Pandoc GPL ⇒ 只能"下载执行不重分发" |

> **O5（设置页展示"当前可用引擎"清单）已于 2026-11-16 随插件机制一并落地**，见下节。

---

## 7.5 插件机制（2026-11-16 追加）

框架第一版落地后还差最后一环：**新增转换引擎必须改核心文件** `providers/index.js`。
那只是多态，不是可插拔 —— 每接一个新引擎都要动核心代码、动版本控制、走一遍发版。

插件机制补上这一环：

> **把一个 `.js` 文件丢进插件目录 ⇒ 框架自动发现、校验、注册、参与路由。**
> **不需要改任何核心文件。**

### 7.5.1 投放位置

按优先级（第一个存在且有文件的即生效，可多个并存）：

| 顺序 | 位置 | 用途 |
|---|---|---|
| 1 | 环境变量 `STICKY_CONVERT_PLUGINS`（`;` 分隔多个） | 临时测试 / 团队分发 |
| 2 | `<userData>/convert-plugins/` | 用户自己投放（设置页会显示这个路径） |
| 3 | `<应用目录>/convert-plugins/` | 随安装分发的引擎 |

### 7.5.2 三种导出形态

```js
module.exports = { id, name, available, capabilities, convert }   // ① 直接导出
module.exports = { provider: { ... } }                            // ② 包一层
module.exports = function (deps) { return { ... } }               // ③ 工厂函数
```

工厂函数的 `deps = { appDir, userDataDir, workerHost, log }`。

### 7.5.3 隔离性

- 语法错误 / 契约不满足 / 工厂函数抛错 ⇒ **跳过并记日志，绝不 crash 应用**
- 契约不满足时**明确报出缺哪个方法**（`validateProvider` 的精确错误），不是笼统的"格式不对"

### 7.5.4 优先级

```
内置图片（canvas） → 内置文本/数据 → 插件 → Filee
```

插件排在 Filee 之前：插件是用户**显式投放**的，通常比 Filee 更贴合当前需求。

### 7.5.5 本轮一并修掉的缺陷

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| 1 | worker 字节传输内存放大 | `Array.from(buf)` 把 Buffer 转成普通数组，每字节一个 JS number（100MB 图 ≈ 800MB）+ IPC 再拷一份 | 直传 `Uint8Array`（IPC 结构化克隆原生支持）；用 `new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)` 避免 Buffer 池化视图错位 |
| 2 | 插件契约报错信息量太低 | `pickProvider` 对"像 provider 但缺方法"返回 null | 新增 `{invalid}` 形态，走 `validateProvider` 报精确错误 |
| 3 | 🔴 引擎清单**静默不渲染** | `<p id="engineList">` 里放 `<div class="engine-item">` —— `<p>` 不能含块级子元素，HTML 解析器把 `<div>` 踢出来变兄弟节点 ⇒ `#engineList .engine-item` 后代选择器全失效 | 容器改 `<div>`。**这类静默失效源码层看不出来，只能靠 e2e 抓** |

### 7.5.6 调试经验（e2e 层面）

| 坑 | 表现 | 对策 |
|---|---|---|
| CDP `/json/list` 出现 target ≠ 页面加载完 | `body.innerHTML.length === -1`，查 DOM 全是 null | 等 `document.readyState === 'complete' && body.innerHTML.length > 100` |
| `show:false` 的 BrowserWindow 定时器被强制节流 | 页面 `setTimeout` 回调长时间不触发 ⇒ 异步 UI 渲染等不到 | UI 测试窗口用 `show:true`；`backgroundThrottling:false` 拦不住不可见页面。生产 worker 窗口不受影响（只依赖 IPC 事件） |
| 轮询里反复点击自我重置 | `openConvertModal` 每次把清单重置成"正在读取…" ⇒ 永远停在加载态 | 只点一次，之后只轮询 |

### 7.5.7 相关文件

| 文件 | 作用 |
|---|---|
| `lib/convert/plugins.js` | 插件发现与加载 |
| `lib/convert/providers/index.js` | 组装入口（新增"插件"这一档） |
| `lib/convert/service.js` | 新增 `engines()` |
| `lib/convert/main-bridge.js` | 新增 `convert:engines` IPC |
| `src/dashboard.html/js/css` | 设置页引擎清单 + 插件目录路径 |
| `test/convert-plugins.test.js` | 18 条单测 |
| `scripts/e2e-convert-plugins.js` | 13 项 e2e |
| `docs/convert-plugin-guide-2026-11-16.md` | 插件开发指南（对外） |

### 7.5.8 验证

- 单测 **245/245**（227 → 245，新增 18）
- `test:e2e:convert:plugins` **13/13**（真实启动 + CDP，含设置页 UI 渲染）
- 其余 e2e 与 QA 审计全绿，详见第 5 节

### 尚未核验

- 未实测：装上真实 Filee 后，多条 provider 的路由是否如预期（内置 → 插件 → Filee 的优先级与兜底）
- ~~超大图走 IPC 传字节的性能~~ ⇒ **已修**（改直传 `Uint8Array`，见 7.5.5 第 1 条），但仍**未做超大文件实测**
- 未评估：Filee 未来改 CLI 契约的兼容策略

---

## 7.6 SVG 矢量 provider（2026-11-17 追加，作为插件落地）

O1 没有写进核心，而是**作为一个插件实现** —— 正好用来验证 7.5 的"投放即生效"闭环。

### 7.6.1 为什么必须走插件

如果为了加 svg 就去改 `lib/convert/providers/index.js`，那 7.5 的插件机制就没有被真正检验过。
本次的验收标准之一就是：**`providers/index.js` 零改动**（QA 用 mtime + 全文 grep + 能力双向可证伪三重验证）。

结论：`<userData>/convert-plugins/svg.js` 投放后 svg 能力出现，移走后能力消失，`withPlugins:false` 时同样消失。

### 7.6.2 技术方案

SVG 光栅化必须用 canvas，而 canvas 只在渲染进程 ⇒ 给 worker 增一条 `renderSvg` 通道：

```
插件(主进程) → deps.workerHost.renderSvg(svgText)
             → IPC 'convert:worker-render-svg'
             → worker: Blob URL + <img> + drawImage → canvasStore[canvasId]
             → 回 'convert:worker-decoded'（复用既有回信通道，主进程零新增监听器）
             → 插件再调 host.encode(canvasId, mime) 拿 Buffer
```

**尺寸判定优先级**（最终版，踩过坑之后的顺序）：

```
① attrs 两边都能解析成绝对像素 → 用文本值
② 至少一边是绝对像素（declared）→ 用浏览器算出的 natural
③ viewBox
④ natural 且非默认盒（300×150）
⑤ 失败
```

为什么 ② 必须在 ③ 之前：`<svg width="40" viewBox="0 0 20 10">` 的 natural 是 **40×20**，
先取 viewBox 会得到 20×10（比作者声明的少一半）。

为什么 ② 的准入必须是"绝对像素"：曾经放宽成"只要有 width/height 属性"，
结果 `width="100%"` 也算 declared，把浏览器按默认盒算出的 150×150 顶掉了 viewBox 的 24×24。
`<svg width="100%" viewBox="0 0 24 24">` 是 Figma/Illustrator 导出图标的高频写法 ⇒ 用户看到 6.25 倍放大。

### 7.6.3 实测推翻的两个假设（重要）

| 原假设 | 实测真相 |
|---|---|
| `createImageBitmap(svgBlob)` 只在无显式尺寸时不可靠 | **对所有 SVG 都抛 `InvalidStateError: The source image could not be decoded`**。这条路根本不通，必须用 `<img>` |
| SVG 里的外部资源引用（`<image href="http://...">`）会污染 canvas | Chromium 对 SVG-as-image **禁止加载外部资源**（本地起 HTTP 服务实测命中 0 次），画布没被污染，画面是空白。**真正导致污染的是 `<foreignObject>`** |
| `naturalWidth` 可作尺寸兜底 | 只有 viewBox 时返回 **225×150**（默认盒按宽高比缩放），直接用会算出错误尺寸 |

### 7.6.4 三轮 QA 抓到的问题

| # | 问题 | 严重度 | 根因 |
|---|---|---|---|
| M1 | 同批同名 SVG 静默互相覆盖 → `ok:true` 但产物内容错位 | **假成功** | 确定性命名 + 循环内无冲突检测。用户会拿到两张一样的图，其中一张与源无关 |
| S1 | 只写单边 width 被误判成"没有尺寸信息" | 功能缺口 | 要求 w>0 **且** h>0 才算 attrs 命中，落空后撞上默认盒排除逻辑 |
| S1' | 修 S1 时 `declared` 放宽过头，`%`/`em`/`cm` 顶掉 viewBox | **回归** | `!!(wRaw||hRaw)` 把相对单位也算"声明了尺寸"；正确写法是 `(w>0||h>0)` |
| S2 | webp 魔数只校验 `RIFF` | 防线不硬 | RIFF 是容器前缀，AVI/WAV 也是。必须同时校验 offset 8 的 `WEBP` |
| S4 | 单测 fixture 与注释意图不符 | 误导后来人 | fixture 写"无尺寸"但实际有尺寸，失败靠 stub 字符串硬塞 |
| 新增 | `window.sticky.workerCodecs = {...}` 必抛 TypeError | 既有缺陷 | `window.sticky` 是 contextBridge 的**冻结对象**，`'use strict'` 下加属性直接抛 |

### 7.6.5 测试策略上的教训

S1' 那个回归**在 29 条全绿的 e2e 里完全不可见** —— 因为 e2e 没覆盖 `%`/`em`/`cm`。

修 bug 必须配护栏，而且要验护栏有牙。本次做法：把 `convert-worker.js` 复制到 `%TEMP%`
打补丁，用 `require.cache` 预置让**仓库原版测试文件**跑到变异体上：

- 变异 A（改回 bug 写法）→ 31 条里 **6 条变红**，红的正是那 6 个差异点
- 变异 B（过度收窄，把 `natural-declared` 整档删掉）→ **3 条变红**，其中 `width="300"` 那条是**双向护栏**

只有会红的断言才算护栏。

### 7.6.6 落盘路径：孤儿文件修复（S5，2026-11-17 已修）

**问题**：`service.convert` 早先把 `attachmentDir` 直接当 provider 的 outDir，
于是 provider 按**原名**写出的产物（`photo.jpg`）留在那里无人引用，
我们再把副本按随机名（`photo-x7f2a1.jpg`）写进**同一个目录** ——
每转一次就多一个孤儿文件，用户在「打开附件目录」里直接能看到。

而 `ok:true` 让这个问题被完全掩盖：用户不会知道自己看到的两个文件里有一个是垃圾。

**修法**（`lib/convert/service.js`）两条独立机制：

| 机制 | 作用 |
|---|---|
| ① `moveOrCopy()`：`renameSync` 优先，失败才 `copyFileSync` | 产物被**移走**而非复制，原名不留 |
| ② `mkdtempSync(os.tmpdir(), 'sticky-convert-')` 一次性工作目录 | provider 完全不碰附件目录，转完即删 |

两者是**纵深防御**：任一条生效就能消除孤儿。这也意味着只回退一条时测试不会红 ——
变异验证必须两条同时回退才能复现问题（实测：文件数 1 → 2）。

**为什么临时目录放系统 TEMP 而不是附件目录下**：
一是清理要在转换结束瞬间完成、不污染用户可见目录；
二是本机有 safe-delete 守卫（仓库内批量删除会被拦），只有系统临时目录能正常清理。

**兜底**：产物搬不进附件目录（权限/占用/跨卷失败）时**保留**工作目录，
让上层仍能拿到产物 —— 绝不登记一个马上会被删掉的路径。

**核心指标**：每次转换，附件目录净增文件数 == 本次产物数（不是 2 倍）。

**验证**：

| 项 | 结果 |
|---|---|
| 新增单测 `test/convert-service-workdir.test.js` | 9/9 |
| 变异验证（两条机制同时回退） | **4 条变红**（文件数、outDir 位置、连续转换净增、多文件数），证明是真护栏 |
| 真机 e2e（`e2e-convert.js` S1 新增断言） | 附件目录 `photo-9tix7k.jpg` **只剩 1 个**（修复前是 `fake-photo.jpg,photo-jd8o32.jpg` 两个） |
| 临时目录泄漏检查（跑完全部 e2e 后） | 残留 `sticky-convert-*` 目录数 = **0** |

**顺带解决**：M1 的累积副作用（`a.png`→`a-2.png`→`a-3.png`）自动消失 ——
provider 每次都写进全新临时目录，插件的磁盘查重不再被触发。

### 7.6.7 产物级警告（warnings，S3，2026-11-17 已修）

**问题**：`<svg width="20" height="20"></svg>` 是合法空 SVG，转出全透明 PNG 本身没错，
但 `ok:true` 让用户完全不知道自己拿到的是一张空白图 —— 这是最后一种**软性假成功**。
`blank` / `externalRef` / `scaled` 三个标记原本只打进日志，用户侧看不到。

**修法**：定义产物级警告契约，一路透传到 UI。

```
provider: outputs[i].warnings = [{code, message}]
  → router 原样透传（本来就是整个 result 拷贝，无需改）
  → service: attachments[i].warnings
  → main-bridge: collectWarnings() 汇总去重
  → 渲染层：状态栏「已转换，但请注意：…」（橙黄色，停留 2.6 秒）
```

| 设计点 | 为什么 |
|---|---|
| 挂在**产物级**（`outputs[i]`）而不是只放顶层 | 提示针对的是"这一张图"，而 service 把产物一一映射成 attachments ⇒ 能逐个提示 |
| `{code, message}` 而不是纯字符串 | code 给测试断言与将来的国际化，message 给用户看的中文 |
| `WARN` 常量在插件里**本地抄一份** | 插件在 `<userData>` 下，`require('../lib/convert/provider')` 必然失败 —— 与 `REASON` 同样的理由。值必须一致，测试里有断言锁住 |
| `collectWarnings` 按 code+message 去重 | 一次转 3 张空图会产生 3 条一模一样的提示，看三遍没有意义 |
| 不把 blank 判成失败 | 空 SVG 合法、产物确实生成了 ⇒ `ok:true` 是对的；要的是"告知"不是"拒绝" |
| 警告态用橙黄色 `.status.warn` | 既不是红色失败，也不是绿色全好 |

**验证**：

| 项 | 结果 |
|---|---|
| 新增单测（插件级 3 + service 透传 1 + collectWarnings 2） | 6/6 |
| 真机 e2e（空 SVG 走真 worker + 真 canvas + 真 service） | 4 条断言全绿 |
| e2e 实测拿到的警告 | `{code:'blank', message:'产物是全透明的空白图：…'}` |

### 7.6.8 CSP（2026-11-17 已补，清单收官）

`src/convert-worker.html` 曾是项目里**唯一没有 CSP meta** 的页面（其余 7 个都有）。
已补上与 `convert.html` 同强度的 CSP：

```
default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';
script-src 'self'; font-src 'self' data:; connect-src 'none'
```

**`img-src` 必须含 `blob:`** —— SVG 光栅化走 `URL.createObjectURL(new Blob([svgText]))`
再喂给 `<img>`，少这一项所有 SVG 转换会静默失败（不是只多一条安全警告）。

e2e 加了 3 条断言锁住：meta 存在、CSP 含 `blob:`、**没有 CSP 违规日志**。
最后一条单独查 —— CSP 违规通常是 warning（level 2），原来那条"error 级为 0"抓不到它。

### 7.6.9 已知未修项

无。7.5/7.6 列出的可选与遗留项已全部处理。

### 7.6.10 验证

- 单测 **291/291**（245 基线 + 插件 31 + 落盘 9 + 警告 6）
- `test:e2e:convert:svg` **43/43**（含 S3 四条、CSP 三条）
- `test:e2e:convert` **4/4**（S1 新增"附件目录只能有 1 个文件"断言）
- 其余 e2e 与 `qa:audit` 10/10 全绿

---

## 7.7 内置 PDF provider（2026-11-17 追加，首个引入 npm 依赖的引擎）

### 7.7.1 决策：打破"零依赖"约束

前几轮一直守着"零新增依赖"，但 PDF 靠 Chromium 原生 API 做不了，手写 PDF 解析器更不现实。
用户拍板两点：**允许 npm 包**（许可证必须干净、纯 JS 无原生编译）+ **内置 provider**（开箱即用，不像 SVG 要手动投放）。

| 库 | 版本 | 许可证 | 职责 | 运行位置 |
|---|---|---|---|---|
| `pdf-lib` | 1.17.1 | MIT | 图片→PDF 合成 | **主进程**（CJS，可直接 require） |
| `pdfjs-dist` | 6.5.438 | Apache-2.0 | PDF→图片/文本 | **仅渲染进程**（只有 ESM） |

### 7.7.2 实测确定的能力边界（写死，别再试）

| 结论 | 证据 |
|---|---|
| pdf-lib 主进程可用 | 生成 867B 有效 PDF，魔数 `%PDF-` |
| **pdfjs 主进程不可用** | Node 22 报 `Promise.try is not a function` + legacy 警告；Windows 的 `import()` 还必须传 `file:///` URL |
| pdfjs 标准构建在渲染进程可用，但**要打 5 个 API 补丁** | Electron 33/Chromium 130 缺 `Uint8Array#toHex`、`Map/WeakMap#getOrInsertComputed`、`Promise#withResolvers`、`Array#toSpliced`；逐层实测报错 `a.toHex is not a function` → `getOrInsertComputed is not a function` |
| **真 module Worker 可用，CSP 无需放宽** | `new Worker('./vendor/pdf-worker-entry.mjs',{type:'module'})` 在 file:// + 当前 CSP 下能建起来；`connect-src 'none'` 原样保留 |

vendor 目录只放必要文件：`pdf.min.mjs` + `pdf.worker.min.mjs` + 共享 polyfill + worker 兼容入口（未拷整个 node_modules）。

### 7.7.3 数据流

```
图片→PDF：provider → pdf-lib 合成（多图合并 1 个 PDF、一图一页、1px=1pt）→ 落盘

PDF→图/文本：主进程 → workerHost.renderPdf(bytes)/extractPdfText → IPC
  → 渲染进程 pdfjs（vendor + polyfill + module Worker）→ canvas
  → workerHost.encode() → 落盘（回信复用 convert:worker-decoded）
```

### 7.7.4 反假成功设计

- **多页软性假成功**：默认只转第 1 页，N>1 时产物必须带 `pdf-multipage` 警告（含页数）—— 不静默少转。
- **双向魔数校验**：入站查 `%PDF-`，出站查 png/jpg/webp 魔数；编码器回错格式 ⇒ 不落盘。
- **负向零产物**：非 PDF / 加密 / 损坏 / 空文件全部明确失败 + 目录零文件。
- **不截胡**：`canHandle` 精确，pdf→pdf、png→txt、png→jpg 都不碰。

### 7.7.5 QA 独立验证的硬证据

- **Worker 真伪**：用 Proxy 钩住 `window.Worker` 构造函数，捕获到恰好 1 次 `new Worker(...)` + 13 次双向 message ⇒ 确认真 module Worker（工程师原来只有"无警告+出图"的软证据）。3 页 PDF 渲染第 1 页实测 **94ms**。
- **变异验证**（证明测试有牙）：去掉多页警告 → 2 条断言红；去掉魔数校验 → 非 PDF 负向红；去掉 toHex 补丁 → 真机 e2e **41→20**。
- **反假成功**：自己解 PNG 的 IDAT 逐像素，92400/92400 不透明、19 色 ⇒ 不是空壳；pdf-lib 独立 load 读页数 = 输入图片数。
- **polyfill 两个 realm 都装**且"先检测再安装"，Electron 升级后自动让位。

### 7.7.6 已知限制

- PDF→图/文本默认只转第 1 页；"转全部页"已作为**可选开关**补齐（见 7.8），默认仍只转第 1 页。
- 图片→PDF 支持 png/jpg/jpeg（零损路径）+ **webp/gif**（经渲染进程 canvas 转码，见 7.9 P2）；bmp/avif/ico/tiff 仍**明确失败**（不静默跳过）。
- 加密 PDF 不支持解密；扫描件无文本层时 TXT 为空（非失败）。
- 复杂 PDF 特性（表单/注释/矢量透明度/色彩管理）保真度取决于 pdfjs。
- `main.js:2519` 的 `[boot] 托盘就绪` 日志打在转换服务装配（含同步 `require('pdf-lib')` ~210ms）之前，会让 e2e 误判就绪 → 已在 `e2e-convert.js` 用有限重试吸收（应用功能正常，非产品 bug，故未动产品源码）。

### 7.7.7 验证

- 单测 **315/315**（291 基线 + PDF 24）
- `test:e2e:convert:pdf` **41/41**（新增）
- SVG e2e 43/43、convert 4/4、plugins 13/13、builtin 5/5、caps 5/5、async 5/5、snapshot 5/5、主 e2e exit=0、`qa:audit` 10/10

---

## 7.8 P1：PDF 转全部页 + 部分页失败告警（2026-11-17 追加）

### 7.8.1 范围与默认口径

在 7.7 的内置 PDF provider 之上加一个**可选开关**「转换所有页面」。

| 维度 | 决策 |
|---|---|
| 默认行为 | **零回归**——仍只转第 1 页，且必须带 `pdf-multipage` 警告 |
| 开关可见性 | 仅当「源含 PDF」且「目标是 PDF→图片/文本」时显示（`src/convert.js:68` `updateAllPagesVisibility`） |
| 图片→PDF 方向 | 开关不适用（图片→PDF 永远合并全部图为一 PDF） |
| 页数硬闸 | `MAX_ALL_PAGES = 50`（`lib/convert/providers/pdf.js:56`），超出只转前 50 页并发 `pdf-page-limit` |

### 7.8.2 七层贯通链路

选项必须穿过 7 层，任一层丢字段都会导致「勾了没生效」这类静默失败：

```
UI 勾选框 #allPages (src/convert.html)
  → src/convert.js:157 shouldAllPages(target) → payload { allPages }
  → preload.js convertRun
  → main-bridge.js:230 service.convert(files, target, { allPages: !!p.allPages })
  → lib/convert/service.js → router → provider.convert(files, target, outDir, opts)
  → lib/convert/providers/pdf.js:762 allPages = !!(opts && opts.allPages)
  → worker-host.js renderPdf / extractPdfText → preload.js:168 onWorkerExtractPdfText(opts)
  → src/convert-worker.js renderPdf({pageNumber}) / extractPdfText({allPages,maxPages})
```

★ **实测踩到的真坑**：`preload.js` 的 `onWorkerExtractPdfText` 最初只转发 `(reqId, bytes)`，漏了 `opts`。后果是全部页 TXT 永远收不到 `allPages`，**静默退化成只转第 1 页且不报错**。任务书最初假设「preload 无需改」是错的。修正见 `preload.js:168` 注释。

### 7.8.3 产物与附件命名（页码可见）

- provider 内部落盘名：`a-1.png`、`a-2.png`…（页码从 1 开始）
- 附件名带页码的做法：构造**伪源路径** `pageSource(src, n)`（`pdf.js:174`，形如 `a-2.pdf`），让 `service.attachmentName()` 自然得出 `a-2-<随机>.png`。
- 单页退化：只有 1 页时 `pseudo = src`，产物名保持 `a.png`，**不产** `a-1.png` 这种多余编号。
- TXT 例外：全部页 TXT 仍只出 1 个文件、名字不加页码（页间用 `\n\n` 分隔）。

### 7.8.4 部分页失败 = 软性假成功，必须告警（`pdf-page-failed`）

这是本轮明确拍板要修的问题：**3 页里失败 1 页、UI 只显示「已转换」却少了 1 页**，与 S3/CSP 一直在防的软性假成功同类。

- 警告码 `PDF_PAGE_FAILED: 'pdf-page-failed'`（`lib/convert/provider.js:86`）
- 产生条件（`pdf.js:624`）：**仅当** `okPages > 0 && failedPages > 0`（部分失败）。全部页失败仍走 `ok:false`，**不重复发**该警告。
- 文案：`PDF 共 N 页，成功转换 X 页，Y 页失败`
- **按 src 维度统计**：多 PDF 批次中只有确实失败的源才产生警告，绝不把 A 的页数算进 B。
- 挂在**顶层** `warnings`（失败页无产物可挂产物级），由 `main-bridge.js` 的 `collectWarnings()` 汇总 → `src/convert.js:174` 读顶层 → 状态栏显示为 `.status.warn` 橙黄态。

### 7.8.5 单页失败隔离

一页渲染失败只把**该页**记入 `failures`（`pdf.js:567`），其它页照常产出，整体 `ok:true`。只有第 1 页失败才会 `continue` 整个源（既有设计语义）。

### 7.8.6 QA 独立验证（PASS）

lead 独立复跑 + QA 独立复跑，数字一致：

| 项 | 数字 |
|---|---|
| `node --test` | **328/328**（291 基线 + PDF 24 + 全部页 9 + 部分页失败 4） |
| `test:e2e:convert:pdf:allpages` | **42/42** |
| `test:e2e:convert:pdf` | **41/41**（零回归） |
| `scripts/e2e-convert.js` | 4/4 |
| `qa:audit` | 10 项 PASS / 0 WARN |
| QA 独立像素级探针 | 37/37、50 页上限探针 6/6、真 UI 状态栏探针 8/8 |

**4 处变异测试**（全部在 `%TEMP%` 副本，仓库零改动）：

| 变异 | 目标位置 | 如期变红 |
|---|---|---|
| 去 `pdf-multipage` 警告 | `pdf.js:693` | 单测 325/328、全页 e2e 41/42 |
| 去 `pdf-page-failed` 警告 | `pdf.js:624` | 单测 324/328、全页 e2e 38/42 |
| 去 50 页上限 | `pdf.js:56` | 全页 e2e 39/42（实出 51 产物） |
| 去 preload 的 opts 转发 | `preload.js:171` | 全页 e2e 40/42（TXT 全部页 marker 丢失） |

★ QA 侧踩坑：误把 `onWorkerRenderPdf` 也改掉时，全页 e2e 立刻红在「3 页图像内容彼此不同」—— 反向证明**像素差异断言确实有牙**（不是同一页复制三份）。

### 7.8.7 已知限制

- ~~`pdf-page-failed` 只挂顶层 warnings，产物级 `attachments[i].warnings` 在该场景为空数组。~~ ⇒ **已修**（见 7.9 P5：同时挂到该源第一个成功页产物，顶层仍是权威来源）。
- 50 页上限是**安全闸**不是产品上限，用户目前无法调高。
- ~~全部页 PDF→图片为**逐页串行**渲染，50 页会有明显耗时，UI 暂无进度条。~~ ⇒ **已加进度条**（见 7.9 P4）。

---

## 7.9 P2/P3/P4/P5 遗留项收官（2026-11-18 追加）

> 口径来源：`docs/pdf-provider-legacy-prd-2026-11-17.md`（产品经理许清楚落盘的增量 PRD）。
> 本节记录**实际实现口径**、拍板结论、复核流程与测试计数。

### 7.9.1 P2：图片→PDF 支持 webp/gif

**路线**：渲染进程 Canvas 转码（PRD Q2 的路线 A），**零新增 npm 依赖**。

```
lib/convert/providers/pdf.js  imagesToPdf()
  → webp/gif: host.transcodeImage(bytes, 'image/png', { sourceMime })
  → lib/convert/worker-host.js  transcodeImage()  → IPC 'convert:worker-transcode-image'
  → preload.js  onWorkerTranscodeImage(reqId, bytes, mime, opts)   ← ★ 必须转发全部参数
  → src/convert-worker.js  transcodeImage()  createImageBitmap 解码 + canvas.toBlob('image/png') 编码
  ← 回信复用 'convert:worker-decoded'（reqId 原样带回 ⇒ 并发不串台）
```

- **png/jpg 零损路径不变**：仍走 `embedPng` / `embedJpg` **原始字节直接 embed**，不经 canvas 重编码（R-P2-9）。
- **魔数校验扩展到 webp/gif**（`pdf.js` 的 `MAGIC` 表改成带偏移的 `{off, bytes}` 数组）：
  - webp = `RIFF`(off 0) + `WEBP`(off 8)——只比 4 字节会把 AVI/WAV 也放过去；
  - gif = `GIF87a` / `GIF89a`（任一命中即可）。
- **动图判定走容器探测，不看扩展名**（新增 `lib/convert/providers/animated-image.js`，纯函数、可被 node:test 直接驱动）：
  - gif：逐块扫描数 image descriptor（`0x2C`），≥2 帧 ⇒ 动图；
  - webp：扫 RIFF chunk 找 `ANIM`；
  - 畸形文件解析不出块结构 ⇒ 按**静态**处理并记 reason（宁可少报不误报）。

**原子性最终拍板结论（PRD Q1）**：**部分成功 + 强制警告**。

| 场景 | 结果 |
|---|---|
| 部分源不可用 | `ok:true` + 顶层 `pdf-image-skipped`（文案含「共 N 张 / 已写入 M 张 / 跳过 K 张」三个数字）+ 产物级**同一条对象** |
| 全部源不可用 | `ok:false` + **零产物** + `failures[0].error` 写明源文件名与原因 |

**新增警告码**（`lib/convert/provider.js` 的 `WARN` 表）：

- `PDF_IMAGE_SKIPPED: 'pdf-image-skipped'`
- `PDF_ANIMATED_FRAME: 'pdf-animated-first-frame'`

**顺带修掉的既有缺陷**：混合批次（png + bmp + png）**静默少页**——顶层与产物级都没有任何警告。现状已归零。

### 7.9.2 P3：pdfjs polyfill 复核流程固化

- **清单与实现同源**：`src/vendor/pdf-polyfill.mjs` 导出 `PDF_POLYFILL_MANIFEST`（6 项，每项含 `api` / `realm` / `neededBy` / `install` / `probe`）与 `getPolyfillInstallers()`。
  探针脚本断言 **manifest 项数 == 实际安装函数数 == 6**。
- **探针脚本不硬编码 API 名**（R-P3-2）：`scripts/qa-pdf-polyfill.js` 源码里**不出现**
  `'toHex'` / `'getOrInsertComputed'` / `'withResolvers'` / `'toSpliced'` / `'Promise.try'` 任一字面量，
  检查目标全部从 manifest 读。
- **在真实 Electron 渲染进程判定**：探针在加载 `src/convert-worker.html` 的隐藏 BrowserWindow 里执行
  （那正是真正跑 pdfjs 的 realm，CSP 与生产一致）。★ 主进程是 Node，问它原生能力会得到**假答案**。
- **真实渲染冒烟**：真 pdfjs 渲染 1 页 PDF 成 PNG，报 `render: pass`。
- **"删掉补丁必失败"可验证**：`node scripts/qa-pdf-polyfill.js --sabotage <序号>` 把 `src/` 复制到临时目录，
  在**副本**里把某条补丁改成"不装" ⇒ 必须以退出码 ≠ 0 结束，并点名那条 API。
  （只动副本，磁盘真文件一个字节都不动）
- **只报告不自动删**：检测到 `native:true` 输出"冗余，可人工删除"，但跑完
  `src/vendor/pdf-polyfill.mjs` 的 sha256 与 mtime 不变（有断言）。
- **台账**：`docs/pdf-polyfill-review.md`（每条补丁一行 + 三处触发点 + 确切命令）。

**★ 与 PRD 的偏差（已上报，按实测为准）**：PRD R-P3-3 写"当前 Electron 33 上 6 项全部 `native:false`"，
**实测不是**（Electron 33.4.11 / Chromium 130）：

| api | 实测 native | 状态 |
|---|---|---|
| `Map.prototype.getOrInsertComputed` | false | 必要 |
| `WeakMap.prototype.getOrInsertComputed` | false | 必要 |
| `Uint8Array.prototype.toHex` | false | 必要 |
| `Promise.withResolvers` | **true** | 冗余 |
| `Promise.try` | **true** | 冗余 |
| `Array.prototype.toSpliced` | **true** | 冗余 |

处置：**3 条冗余保留不删**（PRD Q7：只报告不自动删，删是人工决策），台账如实标注状态。

### 7.9.3 P4：全部页转换进度条

**六层贯通链路**：

```
provider (pdf.js pdfFromTo)  opts.onProgress({source, page, total, done, failed, phase})
  → router.convert / service.convert   原样透传 opts（字段不裁剪）
  → main-bridge.js convert:run         ★ 主进程自己构造 opts.onProgress（函数不可结构化克隆）
  → _e.sender.send('convert:progress', payload)   ★ 定向推给发起窗口，不广播
  → preload.js onConvertProgress(cb)
  → src/convert.js updateProgress(info)  按 reqId 过滤后更新 DOM
```

- **推送时机**：每完成 1 页推 1 次，且在**编码完成**（产物已落盘）时推——不是渲染完成时推，
  否则百分比会领先于真实产出（另一种假成功）。
- **阶段字段 `phase ∈ {prepare, pages, text}`**：`prepare` = 总页数未知（UI 显示"正在准备…"，**不显示 0%**）；
  `pages` = 逐页；`text` = 文本抽取是黑盒（不逐页，UI 显示"正在抽取文本…"，**不得残留百分比**）。
- **UI DOM 契约**（照抄 PRD 5.4）：`#progress` / `#progressFill` / `#progressPct`，
  `.progress[hidden] { display: none; }`（与 `.all-pages[hidden]` 同一坑：`display:flex` 会让 hidden 失效）。
- **状态栏四态互斥**：busy / ok / warn / err；进度条是**独立元素**，不参与 `.status` 的 class 体系。
- **终态顺序固定**：任何终态都**先隐藏进度条、再写状态栏文案**。
- **不可重复触发**：渲染端 `converting` 布尔闸 + 转换期 `pointerEvents='none'` + `allPages.disabled=true`；
  主进程侧另有 `activeRuns` Map 并发闸（同 sender 再发 `convert:run` ⇒ 明确返回
  `{ok:false, error:'已有转换在进行中'}`，不排队也不静默丢弃）。
- **reqId**：渲染进程生成并随 payload 上送，主进程回显；UI 按 reqId 过滤旧事件；旧回包直接 return。

### 7.9.4 P5：`pdf-page-failed` 同时挂产物级

- 挂载位置：**该源 outputs 中 `page` 最小者**（第一个成功页产物），**只挂一个**。
- **复用同一条 warning 对象**（同一引用，同 `code` 同 `message`）。
  顶层仍是**权威来源**，产物级那条只是**兜底副本**（代码注释已写明，避免后来人误以为产物级才是主语义）。
- `collectWarnings()` 的去重键是 `code|message` ⇒ 跨进程结构化克隆会打断"同一引用"，
  所以**逐字节一致**是跨进程后仍必须成立的约束。
- 全部页全失败仍走 `ok:false` 且**不重复**报该 code；多 PDF 批次不误伤其他源。

### 7.9.5 新增/变更的测试与 e2e 计数

| 项 | 数字 |
|---|---|
| `node --test` | **375/375**（328 基线 + 新增 47） |
| `test:e2e:convert:pdf:legacy` | **56/56**（新增） |
| `test:e2e:convert:pdf:failstate` | **13/13**（新增，F1 护栏） |
| `qa:pdf:polyfill` | **15/15**（新增） |
| `test:e2e:convert:pdf:allpages` | 42/42（零回归） |
| `test:e2e:convert:pdf` | 41/41（零回归） |
| `scripts/e2e-convert.js` | 4/4（零回归） |
| `qa:audit` | 10/10（零回归） |
| `test:e2e:overlay:ask` | 34/34（划词栏回归，见 2026-11-18 记录） |

新增文件：

- `lib/convert/providers/animated-image.js`（动图容器探测，纯函数）
- `test/convert-pdf-legacy.test.js`（47 个单测）
- `scripts/qa-pdf-polyfill.js`（polyfill 复核探针 + `--sabotage` 自检模式）
- `scripts/e2e-convert-pdf-legacy.js`（P2/P4/P5 真机 e2e）
- `scripts/e2e-convert-pdf-failstate.js`（F1 失败态护栏，真 Electron + 真失败回包）
- `docs/pdf-polyfill-review.md`（补丁台账）

### 7.9.5.1 独立一致性审查发现并修掉的缺陷（2026-11-19）

首次做**跨文件一致性审查**（此前工程师中断，这一环从未做过）。8 项发现全部修复：

| 编号 | 缺陷 | 修法 |
|---|---|---|
| **F1（阻断）** | **转换失败后 UI 永久锁死**：`src/convert.js` 用 `currentReqId` 同时兼任"进度事件过滤器"与"闸所有权"两个角色。主进程失败时**先发 `convert:files`、再发失败回包** ⇒ `onFiles` 把 `currentReqId` 清成 `''` ⇒ 失败回包被当成旧回包丢弃 ⇒ `converting` 永远 `true`、`resetCards()` 永不执行 ⇒ `allPages.disabled` 永远 `true`，用户在同一窗口无法重试 | **职责分离**：新增 `runReqId`（只由 `onPick` 自己释放，权威闸所有权）+ `runFiles`（在飞行的批次）；回包归属用 `runReqId` 判定；失败回包**必走终态收口**；`stale`（飞行期间来了新批次）时收口但**不写旧批次文案**。主进程侧新增 `convertWinFiles`，失败通知时只有批次不同才重发 `convert:files` |
| **F2（应修）** | 动图告警对**零产物**的源谎称"只转换了首帧"（扫描阶段就记 `animatedSources`，但该源可能在 embed 阶段失败 ⇒ 一页都没进 PDF）⇒ 同时收到"只转换了首帧"（假）与"跳过 1 张"（真） | 发告警时用 `embeddedSet` 过滤 ⇒ 动图告警 ⊆ 已写入集合 |
| **F3（建议）** | `pdf-page-limit` 的产物级副本写死挂第 1 页 ⇒ 第 1 页失败时**整份丢失**，只读 `attachments[i].warnings` 的消费方漏警 | 改为挂"该源第一个成功页产物"（与 P5 同一规则），顶层与产物级共用同一 `limitWarn` 引用 |
| **F4（建议）** | 合法静态 webp 被标 `reason:'webp-unparsable'`（"chunk 扫完"与"结构截断"返回同一个 `null`） | 三态返回（`false`=干净扫完 / `true`=含 ANIM / `null`=截断），静态新增 `reason:'webp-static'`；`.animated` 判定结果不变 |
| F5–F8（nit） | `IMAGE_TARGETS` 死代码 / 探针 `mode==='remove'` 死分支 + JSDoc 重复 / `opts.keepInPlace` 死注释 / manifest `realm` 字段未真正验证 | 分别为：改为推导源、补齐消费者；死分支变可达 + 修 JSDoc；删注释（全仓无调用方）；新增 worker realm 真 module Worker 探针 |

**★ 护栏有牙的验证**（变异测试）：在 TEMP 副本里还原 F1 修复（恢复 `currentReqId` 早退 + 主进程失败时无条件重发 `convert:files`）
⇒ `e2e-convert-pdf-failstate.js` 掉到 **9/13**，`convert:run` 计数 `1 → 1 → 1`（与审查时的实测完全一致）
⇒ 仓库本体零改动。

**★ 教训**：`currentReqId` 这类"进度事件 ID"与"闸所有权 ID"**必须分离**。
只要用同一个变量兼任两种语义，就会在"新事件抢先清空 ID"时出现永久锁死。

### 7.9.6 本轮已知限制（新增/更新）

- **webp/gif 经 canvas 中间格式转码后可能存在像素级差异**（canvas 解码 → PNG 再 embed，
  不是原始位流；JPEG 化的 PNG 与原 webp/gif 可能有细微色差）。
  png/jpg 不受影响（走原始字节直接 embed，零损）。
- **动图仅首帧**：多帧 gif / 含 `ANIM` 的 webp 只写入第一帧，并发 `pdf-animated-first-frame` 警告。
- bmp / avif / ico / tiff → PDF 仍**明确失败**（本轮只补 webp/gif）。
- 多源 PDF 的进度**按源分别显示**，不做全局聚合（源切换时百分比允许重置；同一源内单调不减）。
- TXT 全页**不做逐页进度**（worker 内部一次性抽完，主进程拿不到逐页信号）。
- 50 页上限仍是**安全闸**，不是产品上限。
- 转换**取消 / 中断 / 超时强杀**未做（本轮不做，见 PRD out of scope #6）。
- **F1 的 `stale` 分支未被 e2e 覆盖**："飞行期间来了新批次"时旧请求失败只收口不写文案，
  行为符合预期但当前 e2e 是单批次串行，没有构造出该场景。
- **F7 删了 `opts.keepInPlace` 注释而非实现它**：全仓无调用方，实现它需改 provider 的 `outDir` 语义
  与附件登记口径，属超范围重构。若后续确有"产物留在原输出目录"的需求，需独立立项。

---

## 8. 下一步建议

1. ~~O1（SVG provider）~~ ⇒ **已完成**（作为插件落地，见 7.6）
2. ~~O5（引擎清单 UI）~~ ⇒ **已完成**（见 7.5）
3. ~~S5（孤儿文件）~~ ⇒ **已完成**（见 7.6.6），M1 累积副作用随之解决
4. ~~S3（warnings 透传）~~ ⇒ **已完成**（见 7.6.7），软性假成功已消掉
5. 装一次真实 Filee，验证多 provider 并存时的路由行为
6. ~~补 `convert-worker.html` 的 CSP~~ ⇒ **已完成**（见 7.6.8）
7. ~~内置 PDF provider~~ ⇒ **已完成**（见 7.7），首个引入 npm 依赖的引擎
8. ~~P1（PDF 转全部页 + 部分页失败告警）~~ ⇒ **已完成**（见 7.8）

本轮列出的功能与技术债已全部收官，剩余项需要真实 Filee 环境才能验证。

### PDF provider 后续可选（未做）

- ~~P1：提供"转全部页"选项~~ ⇒ **已完成**（见 7.8）
- ~~P2：图片→PDF 支持 webp/gif~~ ⇒ **已完成**（见 7.9.1，零新增依赖，走 canvas 转码）
- ~~P3：把 vendor 里的 pdfjs 升级策略固化~~ ⇒ **已完成**（见 7.9.2，`npm run qa:pdf:polyfill` + 台账）
- ~~P4：全部页 PDF→图片补进度条~~ ⇒ **已完成**（见 7.9.3）
- ~~P5：`pdf-page-failed` 同时挂产物级 warnings~~ ⇒ **已完成**（见 7.9.4）

### 仍可继续的（未做，需立项）

- **bmp / avif / ico / tiff → PDF**：当前明确失败（不静默），要支持得再扩 `SOURCE_IMAGE_EXTS` 与魔数表。
- **图片→PDF 的 DPI / A4 页面尺寸 / 留白**：当前是 1px = 1pt 的保守基线，改语义会回归既有断言。
- **SVG → PDF**：矢量路线，与 raster 的页面尺寸语义不同，属独立设计。
- **转换取消 / 中断 / 超时强杀**：需要请求 ID + 中断语义 + 半成品清理。
- **多源 PDF 的全局聚合百分比**：源切换时百分比会跳变，违反单调不减。
