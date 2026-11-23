# 内置 PDF provider 遗留项增量 PRD（P2 / P3 / P4 / P5）

> 日期：2026-11-17　｜　角色：产品经理（许清楚 / Xu）
> 上游文档：`docs/convert-engine-framework-2026-11-16.md` 第 7.7 节（内置 PDF provider）、第 7.8 节（P1 转全部页 + 部分页失败告警）
> 基线代码：`lib/convert/providers/pdf.js`、`lib/convert/provider.js`、`lib/convert/main-bridge.js`、`lib/convert/service.js`、`lib/convert/router.js`、`lib/convert/worker-host.js`、`src/convert.html`、`src/convert.js`、`src/convert-worker.js`、`src/vendor/pdf-polyfill.mjs`、`src/vendor/pdf-worker-entry.mjs`、`preload.js`
> 本文只写**增量**，不重述 7.7 / 7.8 已交付内容。

---

## 1. 背景与增量范围

### 1.1 现状基线（仅列与本 PRD 相关的事实）

| 项 | 现状事实（源码可查） |
|---|---|
| 图片→PDF | `pdf.js` 的 `imagesToPdf` 只接受 `SOURCE_IMAGE_EXTS = ['png','jpg','jpeg']`（`pdf.js:41`），用 `pdf-lib` 的 `embedPng` / `embedJpg`；其余格式进 `failures` 后 `continue`（`pdf.js:305-312`） |
| ⚠️ 混合批次静默少页 | 3 张图（png + bmp + png）时 bmp 进 `failures`，PDF 只含 2 页，**顶层与产物级都没有任何警告** ⇒ 现状已存在软性假成功（本文 P2 顺带修掉） |
| PDF→图/文本 | 渲染进程 `pdfjs-dist` 6.5.438；全部页为**逐页串行**渲染（`pdf.js:563-583`） |
| polyfill | `src/vendor/pdf-polyfill.mjs` 补 6 个 API（`Uint8Array#toHex`、`Map/WeakMap#getOrInsertComputed`、`Promise#withResolvers`、`Promise.try`、`Array#toSpliced`），全部"先检测再安装" |
| 进度 | `src/convert.js` 转换期间只有一句静态文案 `'转换中…'`（`convert.js:158`），无进度；卡片 `pointerEvents='none'` + `allPages.disabled=true`（`convert.js:159-160`） |
| 警告汇总 | `main-bridge.js` 的 `collectWarnings()` 同时读顶层 `warnings` 与 `attachments[i].warnings`，按 `code\|message` 去重（`main-bridge.js:294-312`） |
| 失败页告警 | `pdf-page-failed` **只挂顶层**，产物级 `attachments[i].warnings` 为空（`pdf.js:624-630`） |

### 1.2 本次增量范围

| 遗留 | 范围 | 不在范围 |
|---|---|---|
| **P2** | 图片→PDF 新增 **webp / gif** 源格式；动图取首帧并明确告警；顺带修掉"混合批次静默少页" | bmp / avif / ico / tiff → PDF；DPI 与页面尺寸设置 |
| **P3** | 把 pdfjs polyfill 复核变成**可重复执行的自动化流程**（清单 + 探针 + 台账 + CI 门禁） | 升级 pdfjs 本身；自动删除冗余补丁 |
| **P4** | 全部页 PDF→图片转换的**进度条**（数据链路 + UI 形态 + 状态栏四态 + 重复触发防护） | 转换取消/中断；多源全局聚合百分比；TXT 逐页进度 |
| **P5** | `pdf-page-failed` 同时挂**产物级** warnings（复用同一条对象） | 引入源级新契约字段；改动 provider 契约结构 |

**统一产品铁律（反假成功）**：任何"实际产出少于宣称产出"必须**明确警告**或**明确失败**，绝不静默成功、静默截断、静默丢帧。

---

## 2. 产品目标

| 目标 | 可量化指标 | 归属 |
|---|---|---|
| 补齐主流图片格式的 PDF 出口 | webp / gif 作为图片→PDF 源的成功率 **100%**（含魔数正确的真实文件）；**新增 npm 依赖 = 0**；安装包体积增量 = **0 字节** | P2 |
| 转换结果"少页/少帧"零静默 | 图片→PDF 源文件被跳过数 > 0 时，**必须**出现 `pdf-image-skipped` 警告且文案含"共 N 张 / 已写入 M 张 / 跳过 K 张"；动图源**必须**出现 `pdf-animated-first-frame` | P2 |
| 升级 Electron 后不再有"沉默的定时炸弹" | CI 中存在**必过**门禁 `qa:pdf:polyfill`，它能自动判定"哪些补丁仍必要 / 哪些已冗余 / pdfjs 新版是否需要新补丁"；补丁清单与实现**同源**（清单从代码导出，不在脚本里硬编码） | P3 |
| 全部页转换可感知 | 转换期间 UI **每完成 1 页**推送 1 次进度（页码 + 百分比 + 总页数）；进度百分比**单调不减**；重复点击导致并发转换次数 = **0** | P4 |
| 警告不漏、也不重复 | 只读产物级的消费方能读到 `pdf-page-failed`（覆盖率 100%）；同时 UI 状态栏中该警告**恰好出现 1 次**（`collectWarnings` 去重后） | P5 |

---

## 3. 用户故事

### P2（图片→PDF 支持 webp/gif）
1. 作为要把截图存成 PDF 的用户，我希望把 **webp** 截图直接拖进来转 PDF，以便不用先手动转成 PNG。
2. 作为要归档动图的用户，我希望把 **gif** 转成 PDF，以便拿到一份可打印的静态文档，同时**明确知道我拿到的是首帧**。
3. 作为批量处理的用户，我希望一批图里有 1 张格式不支持时，**明确告诉我少了哪张**，以便我知道该补转哪张，而不是拿到一个悄悄少页的 PDF。
4. 作为对画质敏感的用户，我希望 png/jpg 走**原始字节**直接嵌入（不被重新编码），以便 PDF 里的图片与原图逐像素一致。

### P3（polyfill 复核流程）
1. 作为维护者，我希望升级 Electron 后**跑一条命令**就知道 6 个补丁哪些还需要、哪些已经多余，以便不留下无人看管的补丁。
2. 作为维护者，我希望升级 pdfjs 后能**自动发现新缺哪个 API**，以便不必等到用户报"PDF 转不了"才发现。
3. 作为维护者，我希望补丁清单和补丁实现**永远一致**（同源），以便不会有一份文档写着 5 个、代码里却是 6 个。

### P4（全部页进度条）
1. 作为转 50 页 PDF 的用户，我希望看到**当前第几页 / 共几页**，以便知道程序没卡死。
2. 作为误以为卡死的用户，我希望在转换期间**点不动**任何格式按钮，以便不会并发触发两次转换把产物搅乱。
3. 作为只关心结果的用户，我希望进度结束后状态栏**干净地**变成成功/警告/失败三态之一，以便一眼看出结果有没有问题。

### P5（pdf-page-failed 产物级）
1. 作为下游工具作者，我希望即使只读 `attachments[i].warnings` 也能看到"少了几页"，以便不会漏警。
2. 作为普通用户，我希望状态栏**只出现一条**这条警告，不重复刷屏。

---

## 4. 需求池

> 验收标准一律写成"可被测试证伪"的形式。P0 = 本轮必须交付；P1 = 强烈建议同轮交付；P2 = 可延期。

### P2 — 图片→PDF 支持 webp/gif

| 编号 | 需求 | 优先级 | 所属遗留 | 验收标准（可证伪） | 依赖 |
|---|---|---|---|---|---|
| R-P2-1 | 技术路线定为**渲染进程 Canvas 转码**（路线 A），不引入原生依赖库（路线 B） | P0 | P2 | ① `package.json` 的 `dependencies` 与实施前**逐字节一致**；② 仓库内无新增 native 模块目录；③ 转码经由 `src/convert-worker.js` 的 `createImageBitmap` 解码 + `canvas.toBlob('image/png')` 编码完成（源码可查该调用） | — |
| R-P2-2 | webp 可作为图片→PDF 源 | P0 | P2 | 给定魔数正确的真实 webp 文件：`convert(files,'pdf')` 返回 `ok:true`；产物首 5 字节 == `%PDF-`；用 `pdf-lib` 独立 `load()` 读出页数 == 1 且页面尺寸 == 原图像素尺寸；该源不出现在 `failures` 中 | R-P2-1 |
| R-P2-3 | gif 可作为图片→PDF 源 | P0 | P2 | 同 R-P2-2，源改为真实 gif（`GIF89a`） | R-P2-1 |
| R-P2-4 | **原子性口径**：部分源不可用 ⇒ **部分成功 + 强制警告**（不整体失败、不静默少页） | P0 | P2 | 构造 3 源批次（png + bmp + png）：`ok:true`；产物为 1 个 PDF 且 `pdf-lib` 独立读出页数 == 2；顶层 `warnings` 含 `code === 'pdf-image-skipped'`，message 匹配 `/共 3 张/`、`/2 张/`、`/1 张/`；`outputs[0].warnings` 含**同一 code** | R-P2-2 |
| R-P2-5 | **全部**源不可用 ⇒ 明确失败、**零产物** | P0 | P2 | 只给 1 个 bmp：返回 `ok:false`；输出目录文件数 == 0；`failures[0].error` 含该源文件名与原因 | — |
| R-P2-6 | 动图（gif/webp 动画）**只取首帧**且必须明确告知 | P0 | P2 | 构造 2 帧 gif：转换成功，顶层 `warnings` 含 `code === 'pdf-animated-first-frame'`，message 匹配 `/首帧|第一帧/`；构造 1 帧 gif：不产生该警告 | R-P2-4 |
| R-P2-7 | 动图判定用**容器格式探测**，不用"扩展名猜" | P0 | P2 | ① gif：文件头 `GIF87a`/`GIF89a` 且块扫描出 ≥2 个 image descriptor ⇒ 判为动图；② webp：RIFF 容器含 `ANIM` chunk ⇒ 判为动图；③ 判定逻辑是**纯函数**，被 `node --test` 直接驱动（不依赖 Electron） | — |
| R-P2-8 | 源文件**魔数校验**扩展到 webp / gif | P0 | P2 | 把 `.webp` 文件的内容替换成 PNG 字节 ⇒ 明确失败（error 含"魔数"或"不是真正的"），产物数 == 0；把 `.gif` 内容替换成文本 ⇒ 同样明确失败 | R-P2-2 |
| R-P2-9 | png/jpg 走**原始字节**直接 embed（不经 canvas 重编码） | P1 | P2 | 给定同一张 png，`convert(files,'pdf')` 产出的 PDF 内嵌图像字节与"经 canvas 转码"的版本**不同**（断言二者 PDF 体积或图像流长度不同）；且 png/jpg 的既有单测全部保持绿 | R-P2-1 |
| R-P2-10 | 新增警告码集中在 `lib/convert/provider.js` 的 `WARN` 常量表 | P1 | P2 | `WARN.PDF_IMAGE_SKIPPED === 'pdf-image-skipped'`、`WARN.PDF_ANIMATED_FRAME === 'pdf-animated-first-frame'` 断言存在；插件侧若需同样语义，其本地副本值一致（同 S3 的既有做法） | R-P2-4 |
| R-P2-11 | 已知限制写入文档 | P2 | P2 | `docs/convert-engine-framework-2026-11-16.md` 的已知限制节新增：webp/gif 经 canvas 中间格式转码后可能存在像素级差异；动图仅首帧 | R-P2-1 |

### P3 — 固化 pdfjs polyfill 复核流程

| 编号 | 需求 | 优先级 | 所属遗留 | 验收标准（可证伪） | 依赖 |
|---|---|---|---|---|---|
| R-P3-1 | **清单与实现同源**：`src/vendor/pdf-polyfill.mjs` 导出补丁清单（manifest） | P0 | P3 | 导出 `PDF_POLYFILL_MANIFEST`，每项含 `api`（如 `Uint8Array.prototype.toHex`）、`realm`（`main`/`worker`/`both`）、`neededBy`（`pdfjs 6.5.438`）；断言：manifest 项数 == 实际安装函数数 == 6 | — |
| R-P3-2 | 探针脚本**不得硬编码** API 名单，检查目标全部来自 manifest | P0 | P3 | 对 `scripts/qa-pdf-polyfill.js` 源码做文本断言：不含 `'toHex'`、`'getOrInsertComputed'`、`'withResolvers'`、`'toSpliced'`、`'Promise.try'` 任一字面量 | R-P3-1 |
| R-P3-3 | 探针在**真实 Electron 渲染进程**里判定"补丁是否还必要" | P0 | P3 | `npm run qa:pdf:polyfill` 退出码 0；输出报告逐项给出 `native: true/false`；在当前 Electron 33 上 6 项全部 `native:false`（即都仍需补丁） | R-P3-1 |
| R-P3-4 | 探针含**真实渲染冒烟**（不是只查 API 存在性） | P0 | P3 | 探针在渲染进程用真 pdfjs 渲染 1 页 PDF 成 PNG，报告 `render: pass`；人为删掉 polyfill 中任一补丁后重跑 ⇒ 退出码 ≠ 0 且报告点名缺失的 API 名 | R-P3-3 |
| R-P3-5 | 能**自动发现 pdfjs 新版缺失的新 API** | P0 | P3 | 渲染冒烟失败时，脚本从错误信息抽取形如 `X is not a function` 的标识，与 manifest 求差集，输出"需要新增的补丁：X"；断言：探针在"模拟缺 API"场景下能打印出该建议 | R-P3-4 |
| R-P3-6 | 补丁台账文档 | P1 | P3 | `docs/pdf-polyfill-review.md` 存在；每条补丁一行，含 `api / realm / 引入的 pdfjs 版本 / 当前状态(必要|冗余) / 最近复核日期 / 复核命令`；文档中引用的命令真实可执行 | R-P3-3 |
| R-P3-7 | CI 门禁 | P1 | P3 | `package.json` 有 `qa:pdf:polyfill` 脚本；CI 配置（若存在流水线文件）在合入前调用它且**失败即阻断**；否则在台账中写明"发版前必跑"的检查项与责任人 | R-P3-4 |
| R-P3-8 | **只报告不自动删**冗余补丁 | P1 | P3 | 探针在检测到 `native:true` 时输出"冗余，可人工删除"，但**不修改** `src/vendor/pdf-polyfill.mjs`（跑完文件 mtime 与内容哈希不变） | R-P3-3 |
| R-P3-9 | 触发时机写死 | P1 | P3 | 台账中明确三处触发点：① 每次 CI；② `devDependencies.electron` 版本号变更时；③ `dependencies.pdfjs-dist` 版本号变更时；且第 ②③ 项各给出一条确切命令 | R-P3-6 |

### P4 — 全部页转换进度条

| 编号 | 需求 | 优先级 | 所属遗留 | 验收标准（可证伪） | 依赖 |
|---|---|---|---|---|---|
| R-P4-1 | 进度数据链路：provider → router → service → main-bridge → **新 IPC 推送** → UI | P0 | P4 | 逐层可达：① `pdf.js` 在全页循环里调用 `opts.onProgress({source, page, total, done, failed})`；② `router.convert` / `service.convert` 原样透传 `opts`（字段不被裁掉）；③ `main-bridge.js` 的 `convert:run` 处理器**自己构造** `opts.onProgress`（不能从渲染进程传函数——不可结构化克隆）；④ 通过 `_e.sender.send('convert:progress', payload)` 推送；⑤ `preload.js` 暴露 `onConvertProgress`；⑥ `src/convert.js` 订阅并更新 DOM | — |
| R-P4-2 | 进度**每完成 1 页**推送 1 次 | P0 | P4 | 3 页 PDF 全页转换中，UI 收到 **≥3** 条 `convert:progress` 事件；每条含 `page` 与 `total`；`page` 序列包含 1,2,3 | R-P4-1 |
| R-P4-3 | 总页数未知阶段有独立状态 | P0 | P4 | 第 1 页渲染完成前的事件 `total === null`（或缺省），UI 显示"正在准备…"而非 `0%`；拿到 `numPages` 后才开始百分比 | R-P4-1 |
| R-P4-4 | UI 形态：**进度条 + 百分比 + 页码文案** 三者齐备 | P0 | P4 | 转换期间 DOM 同时存在：非零宽度的进度条填充元素、百分比文本、`第 N/M 页` 文案；断言三者同时可见 | R-P4-1 |
| R-P-4-5 | 状态栏四态**互斥** | P0 | P4 | 进行中：`status.className` 含 `busy` 且不含 `ok`/`warn`/`err`；终态：含且仅含 `ok`/`warn`/`err` 之一，且不含 `busy` | R-P4-1 |
| R-P4-6 | 转换期间**不可重复触发** | P0 | P4 | 快速连续点击两个不同格式卡片 ⇒ `convert:run` 被调用 **1** 次（用调用计数断言）；`allPages` 复选框保持 `disabled === true` | R-P4-5 |
| R-P4-7 | 100% → 终态的**顺序固定** | P0 | P4 | 终态出现时，进度条容器 `hidden === true`（同一帧快照断言：进度条已隐藏且状态栏已是 ok/warn/err）；不允许出现"停在 90% 却变绿" | R-P4-4 |
| R-P4-8 | 失败态**保留窗口**并恢复可点 | P1 | P4 | 转换失败后：状态栏 `err`、进度条隐藏、格式卡片 `pointerEvents` 恢复为空串、`allPages.disabled === false` | R-P4-5 |
| R-P4-9 | 窗口中途关闭**不引发主进程异常** | P1 | P4 | 转换进行中关闭选择窗 ⇒ 主进程无未捕获异常（e2e 收集 renderer/main 的 error 级日志为 0）；发送前检查 `sender` 是否已销毁 | R-P4-1 |
| R-P4-10 | 多源 PDF **按源分别显示**进度，不做全局聚合 | P1 | P4 | 批次含 2 个 PDF 时，进度文案里的源文件名随源切换而变化；百分比在源切换时**允许重置**（不做跨源聚合），但同一源内单调不减 | R-P4-2 |
| R-P4-11 | TXT 全页**不做逐页进度** | P1 | P4 | `target === 'txt'` 的全页转换**不产生**逐页 `convert:progress` 事件；状态栏显示"正在抽取文本…"或直接进入终态，**不得残留百分比文本** | R-P4-1 |
| R-P4-12 | 每次转换请求由**渲染进程**生成唯一 `reqId`，随 `convert:run` payload 上送 | P0 | P4 | ① `convert:run` 的 payload 含非空字符串 `reqId`；② 同一窗口连续发两次转换 ⇒ 两个 `reqId` **不相同**；③ 主进程在 `convert:run` 的**返回值**里回显 `reqId`，与请求一致 | R-P4-1 |
| R-P4-13 | 进度事件**按发起窗口定向**，不得广播 | P0 | P4 | 主进程推送必须用 `_e.sender.send('convert:progress', ...)`（发送者 = 发起 `convert:run` 的那个 webContents）；源码中进度推送处**不出现**全局窗口引用（如 `convertWin.webContents.send`） | R-P4-12 |
| R-P4-14 | 进度事件**携带 reqId**，UI 侧按 reqId 过滤 | P0 | P4 | ① 事件 payload 含 `reqId`；② 收到 `reqId !== 当前 reqId` 的事件 ⇒ **不更新任何 DOM**（进度条宽度 / 百分比 / 页码文案三者均不变）；③ 注入"reqId A 发起、reqId B 监听"的场景 ⇒ B 的 DOM **零变化** | R-P4-12 |
| R-P4-15 | 旧请求的**最终回包**不得覆盖新请求的状态 | P0 | P4 | 渲染进程在 `onPick` 里比对回包 `reqId` 与本次请求的 reqId：不一致 ⇒ **直接 return**，不调用 `setStatus`、不调用 `resetCards`、不 `window.close()` | R-P4-12 |
| R-P4-16 | 主进程侧**并发闸**：同一 sender 已有进行中的转换 ⇒ 新请求**明确失败**，不排队也不静默丢弃 | P0 | P4 | 主进程维护 `sender → 进行中的 reqId`；同一 sender 在有进行中转换时再发 `convert:run` ⇒ 返回 `{ok:false, error:'已有转换在进行中'}`；且**总产物数** == 第一次的产物数（不多不少） | R-P4-12 |
| R-P4-17 | 文件集变更（`convert:files` 到达）时**使当前 reqId 失效**并重置 UI | P1 | P4 | 转换进行中收到 `convert:files` ⇒ 当前 reqId 立即失效；其后的旧进度事件被丢弃（R-P4-14）；状态栏回到"等待文件…"；旧请求回包按 R-P4-15 忽略。**但旧产物已生成并已入便签**（不撤销，见 Q19） | R-P4-12, R-P4-14 |
| R-P4-18 | 进度事件带**阶段字段** `phase`，显式表达"文本抽取是黑盒"这一不对称 | P1 | P4 | 事件 payload 含 `phase ∈ {prepare, pages, text}`；`target==='txt'` 的全页路径**不得**发 `phase:'pages'` 的逐页事件；UI 在 `phase!=='pages'` 时不显示百分比数字 | R-P4-1 |

### P5 — `pdf-page-failed` 同时挂产物级

| 编号 | 需求 | 优先级 | 所属遗留 | 验收标准（可证伪） | 依赖 |
|---|---|---|---|---|---|
| R-P5-1 | `pdf-page-failed` 同时出现在**顶层**与**该源第一个成功页产物**上 | P0 | P5 | 3 页失败 1 页：`r.warnings` 含该 code；`r.outputs` 中**属于该源**的第一个产物（`page` 最小者）的 `warnings` 含**同一 code**，且其 `message` 与顶层那条**逐字节相同** | — |
| R-P5-2 | 复用**同一条 warning 对象**（同一引用） | P0 | P5 | 在 provider 内部，顶层数组与产物 `warnings` 数组里装的是**同一个对象引用**（断言 `===` 相等） | R-P5-1 |
| R-P5-3 | UI **不重复显示** | P0 | P5 | `collectWarnings(result)` 结果中 `code === 'pdf-page-failed'` 的条目数 **== 1** | R-P5-1 |
| R-P5-4 | **变异护栏**：产物级文案若与顶层不一致，必须被测试抓住 | P0 | P5 | 在临时副本里把产物级 message 改成不同文案后重跑 ⇒ 某条断言变红（护栏有牙）；仓库本体零改动 | R-P5-3 |
| R-P5-5 | 不误伤其他源 | P1 | P5 | 批次 = good.pdf(2 页全成功) + bad.pdf(3 页失败 1 页)：good 的产物 `warnings` **不含** `pdf-page-failed`；bad 的第一个成功产物**含**该 code | R-P5-1 |
| R-P5-6 | 全部页失败时**不重复报警** | P1 | P5 | 全部页失败 ⇒ `ok:false`，且 `r.warnings` **不含** `pdf-page-failed`（沿用现状语义） | — |
| R-P5-7 | 不改 provider 契约结构 | P1 | P5 | `lib/convert/provider.js` 的契约注释与 `outputs[i].warnings` / 顶层 `warnings` 两个位置**保持原样**，未新增源级字段 | R-P5-1 |

---

## 5. UI 设计说明（重点 P4）

### 5.1 状态栏四态

| 态 | class | 颜色（沿用 `convert.html` 现有变量） | 文案示例 | 停留 |
|---|---|---|---|---|
| 进行中 | `status busy` | `#6B7280`（`--muted`） | `正在转换 book.pdf 第 7/12 页…` / `正在准备…` / `正在抽取文本…` | 直到终态 |
| 成功 | `status ok` | `#067647` | `已转换，结果已放入新便签。` | 700ms 后关窗 |
| 警告 | `status warn` | `#B54708` | `已转换，但请注意：PDF 共 3 页，成功转换 2 页，1 页失败` | 2600ms 后关窗 |
| 失败 | `status err` | `#B42318` | `转换失败：不是有效的 PDF 文件（缺少 %PDF- 魔数）` | 常驻，窗口不关 |

**共存规则**
1. 状态栏**永远只有一个态**（四态互斥），不出现"橙色进行中"这种混合色。
2. 进度条是**独立元素**（`footer` 内新增一行），不参与 `.status` 的 class 体系 ⇒ 进度态不需要新增颜色，也不会与 ok/warn/err 打架。
3. 进度条只在进行中可见；**任何终态都会先隐藏进度条，再写状态栏文案**（顺序固定，见 R-P4-7）。
4. 进度条不承载错误信息 —— 失败原因只走状态栏 `err` 文案，避免两处重复。

### 5.2 线框图（转换中）

```
┌──────────────────────────────────────────────────────────┐
│ 转换为                                                     │
│ book.pdf                                                   │
├──────────────────────────────────────────────────────────┤
│ 可用格式（4）                                              │
│  ┌────┐ ┌────┐ ┌──────┐ ┌────┐                           │
│  │PNG │ │JPG │ │ WEBP │ │TXT │   ← 转换中：不可点        │
│  └────┘ └────┘ └──────┘ └────┘                           │
│                                                          │
│  ☐ 转换所有页面        ← 转换中：disabled                 │
├──────────────────────────────────────────────────────────┤
│ 正在转换 book.pdf 第 7/12 页…                             │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│                                            58%            │
└──────────────────────────────────────────────────────────┘
   ↑ 进度条（4~6px 高，填充色 --accent #2F6FED，右端百分比）
```

### 5.3 线框图（终态）

```
├──────────────────────────────────────────────────────────┤
│ 已转换，但请注意：PDF 共 3 页，成功转换 2 页，1 页失败     │  ← warn 橙黄
│ （进度条已隐藏）                                          │
└──────────────────────────────────────────────────────────┘

├──────────────────────────────────────────────────────────┤
│ 转换失败：不是有效的 PDF 文件（缺少 %PDF- 魔数）           │  ← err 红，窗口保留
│ （进度条已隐藏，卡片恢复可点）                            │
└──────────────────────────────────────────────────────────┘
```

### 5.4 进度条 DOM 契约（供实现对齐）

```html
<footer>
  <div class="status" id="status"></div>
  <div class="progress" id="progress" hidden>
    <div class="progress-fill" id="progressFill"></div>
    <span class="progress-pct" id="progressPct">0%</span>
  </div>
</footer>
```

- `#progress`：`hidden` 属性控制显隐；`[hidden]` 必须显式 `display:none`（与 `.all-pages[hidden]` 同一坑 —— 见 7.5.3 第 3 条）。
- `#progressFill`：宽度 = 百分比；`total` 未知时不显示百分比文本（显示"正在准备…"）。
- `#progressPct`：整数百分比，四舍五入。

### 5.5 交互细则

| 场景 | 行为 |
|---|---|
| 转换期间点击格式卡片 | 被忽略（`pointerEvents='none'` 已在既有代码中），**并额外加 `converting` 布尔闸**（防止同一 tick 内双击触发两次 `convert:run`） |
| 转换期间点击「全部页」复选框 | 禁用（既有 `allPages.disabled = true`） |
| 转换期间进度条 | 纯展示，不响应点击、不拦截任何区域 |
| 转换结束（成功） | 先隐藏进度条 → 写 `ok` 文案 → 700ms 关窗 |
| 转换结束（有警告） | 先隐藏进度条 → 写 `warn` 文案 → 2600ms 关窗 |
| 转换结束（失败） | 先隐藏进度条 → 写 `err` 文案 → 恢复卡片可点、恢复复选框，窗口**不关** |
| 窗口被用户提前关闭 | 主进程推送前检查 sender 是否已销毁；销毁则丢弃该进度事件，不抛异常 |

---

## 6. 反假成功验收清单（逐条可被测试证伪）

> 任何一条不满足 ⇒ 视为假成功缺陷，必须阻断发布。

| # | 必须成立的行为 | 证伪方式（测试手段） |
|---|---|---|
| A1 | 图片→PDF：3 源中有 1 源格式不支持时，**顶层必须出现** `pdf-image-skipped`，且文案含总张数、写入张数、跳过张数 | 单测断言 `r.warnings` 命中该 code 且 message 匹配三个数字 |
| A2 | 同上场景下产物 PDF 的**实际页数**必须等于"写入张数"（不得再多/少） | 用 `pdf-lib` 独立 `load()` 读页数并与警告中的"写入张数"比对 |
| A3 | 全部源不可用 ⇒ `ok:false` 且**输出目录零文件** | 转换后统计目录文件数 == 0 |
| A4 | webp / gif 源文件若**魔数不匹配** ⇒ 明确失败、零产物（不得"尽力而为"） | 伪造扩展名 + 错误内容，断言 `ok:false`、失败原因含"魔数"、目录零文件 |
| A5 | 动图（多帧 gif / 含 `ANIM` 的 webp）必须出现 `pdf-animated-first-frame`；静态图**不得**出现 | 分别构造 2 帧 gif、1 帧 gif、含 ANIM 的 webp，断言警告出现/不出现 |
| A6 | 动图判定**不依赖扩展名**：把 2 帧 gif 改名为 `.png` 仍应被识别为动图（或至少不被谎称静态） | 改名后断言仍出现该警告（或至少不出现"静态"结论） |
| A7 | 全部页 PDF→图片：部分页失败时**必须**出现 `pdf-page-failed`，文案含总页数/成功页数/失败页数 | 单测断言 code + message 正则 |
| A8 | 全部页 PDF→图片：成功页数必须等于实际产出的页图数量（不得"宣称成功 3 页实际 2 个文件"） | 断言 `r.outputs.length` == 警告中的"成功转换 N 页" |
| A9 | `pdf-page-failed` 在**顶层与产物级都能读到**（只读产物级的消费方不漏警） | 分别只读顶层、只读 `outputs[i].warnings`，两边都命中该 code |
| A10 | 产物级那条与顶层那条的 `code` **与** `message` **逐字节相同** | 断言 `===`（provider 内）/ 字符串严格相等（跨进程后） |
| A11 | UI 上该警告**只出现 1 次**（`collectWarnings` 去重后） | 断言 `collectWarnings(result)` 中该 code 条目数 == 1 |
| A12 | 护栏有牙：把产物级 message 改一个字 ⇒ 上述 A11 断言必须变红 | 临时副本变异测试，仓库零改动 |
| A13 | 全部页超过 50 页 ⇒ 必须出现 `pdf-page-limit`，且**实际产出页数 == 50**（不多不少） | 单测断言 outputs.length == 50 且警告含"共 51 页" |
| A14 | 全部页全部失败 ⇒ `ok:false`，且**不重复**出现 `pdf-page-failed` | 单测断言 `ok===false` 且顶层无该 code |
| A15 | 多 PDF 批：只有真正失败的源产生 `pdf-page-failed`，成功源**不得**被误伤 | 批次 good+bad，断言 good 的产物无该 code，bad 的有 |
| A16 | 全部页转换期间 UI **每页至少 1 次**进度更新，且百分比**单调不减** | e2e 收集进度事件序列，断言长度 ≥ 页数且百分比序列单调不减 |
| A17 | 进度到 100% / 终态时，**进度条必须已隐藏**，不得残留百分比文本 | 终态同一帧快照断言 `#progress.hidden === true` 且状态栏 class ∈ {ok,warn,err} |
| A18 | 转换期间**不可并发触发**（重复点击不产生第二次 `convert:run`） | 调用计数断言 == 1 |
| A19 | 转换失败时**不得**显示任何百分比或进度残留（只显示 err 文案） | DOM 断言 |
| A20 | 产物级/顶层警告去重后，状态栏展示的文案**不得**出现同义重复两次 | `describeWarnings` 输出中同一 message 只出现一次 |
| A21 | 任何"宣称成功"的路径，都必须能由**独立工具**复算出真实产出（pdf-lib 读页数、魔数校验产物格式） | e2e 中用 pdf-lib / 魔数校验独立复算 |

---

## 7. 待确认问题（含推荐答案与取舍理由）

### P2 相关

**Q1. 一批 3 张图有 1 张不支持 ⇒ 整体失败 还是 部分成功 + 警告？**
- **推荐：部分成功 + 强制警告**（顶层 `pdf-image-skipped` + 产物级同一条）。
- 理由 ①：**铁律只禁止"静默"，不禁止"部分成功"**。当前 `imagesToPdf` 的既有语义就是单文件失败隔离（`pdf.js:359` 注释），整体失败会与之冲突、造成回归。
- 理由 ②：图片→PDF 的产物是**一份合并 PDF**，少一张就是"少一页"，属于典型的软性假成功，必须告警。
- 理由 ③：整体失败会浪费用户已成功的部分；用户拿到警告后可以单独补转那一张，成本更低。
- 理由 ④：一旦选择"整体失败"，用户必须反复试错直到找出那张坏图，体验显著更差。
- 取舍：接受"产物可能不是用户以为的页数"，用警告换可用性 —— 前提是警告**一定**出现。

**Q2. 路线 A（canvas 转码）vs 路线 B（原生依赖库）？**
- **推荐：路线 A**。
- 理由 ①：与项目既定约束一致（pdf-lib / pdfjs 均为"纯 JS、零 native 编译"）；路线 B（如 sharp / libvips / ImageMagick）会引入 native 编译链与体积，与 7.7.1 的决策口径冲突。
- 理由 ②：`src/convert-worker.js` 已有**两条现成通道**：`decodeImage`（`createImageBitmap`，实测支持 webp/gif）与 `encodeImage`（`canvas.toBlob('image/png')`），零新增代码量即可复用。
- 理由 ③：canvas 在渲染进程已就位（worker 宿主已在 `main.js` 装配），无需新增进程或新增 IPC 通道。
- 理由 ④：路线 B 的收益（保真度、无损）在本场景收益有限 —— PDF 页面本身就是 1px=1pt 的栅格化结果。

**Q3. png/jpg 是否也统一走 canvas 转码？**
- **推荐：不**。png/jpg 继续用 `embedPng` / `embedJpg` 直接嵌入原始字节；只有 webp/gif 走 canvas → PNG 中间格式。
- 理由：png/jpg 是当前唯一"零损"的路径，改成 canvas 重编码会引入像素级差异并回归既有测试基线（违反"只做增量"）。

**Q4. 动图判定怎么做？**
- **推荐：容器格式探测**（gif 数 image descriptor；webp 查 `ANIM` chunk），在 provider（主进程）侧用纯 JS 实现，**可被 node:test 直接驱动**。
- 理由：不能用扩展名猜（改名即失效）；也不必在 canvas 侧逐帧解码（`createImageBitmap` 只给首帧，拿不到帧数）。
- 取舍：极端畸形文件解析不出块结构时，按"静态"处理并记日志 —— 因为此时魔数校验通常已先拦住；宁可少报也不误报。

**Q5. webp/gif 转码的中间格式选 PNG 还是 JPEG？**
- **推荐：PNG**。理由：`pdf-lib` 的 `embedPng` 支持 alpha 通道；JPEG 会把透明区变黑底（canvas 固有行为），那是**另一种**信息损失。

**Q6. P2 是否需要新增 npm 依赖？**
- **推荐：零新增**。理由：路线 A 已覆盖；若后续为保真度引入原生库，另开议题，不在本轮。

### P3 相关

**Q7. 已冗余的补丁要不要自动删？**
- **推荐：只报告、不自动删**。理由：补丁"先检测再安装"，留着无害；自动删会在 Electron 版本回滚时立刻炸 PDF 转换。删除是人工决策，需配合"回退路径"评估。

**Q8. 补丁清单放代码里还是放文档里？**
- **推荐：代码里（`PDF_POLYFILL_MANIFEST` 导出）**，文档只做台账（状态、复核日期）。
- 理由：清单与实现同源才不会出现"文档写 5 个、代码有 6 个"；探针脚本从 manifest 读取检查目标（禁止硬编码），这一条是 R-P3-2 的核心。

**Q9. 复核流程在什么时候跑？**
- **推荐：三重触发** —— ① 每次 CI（防回归：有人误删补丁 / 误改 vendor 立刻红）；② `devDependencies.electron` 版本变更时（人工跑一次，产出冗余清单）；③ `dependencies.pdfjs-dist` 版本变更时（同上）。
- 理由：只靠 CI 不够（CI 不会告诉你"哪些补丁已多余"），只靠人工会忘（这正是"沉默的定时炸弹"的成因）。

**Q10. 探针要不要跑真实 PDF 渲染？**
- **推荐：要**。理由：只查 API 存在性不能证明 pdfjs 真能工作（曾出现"补丁都在但仍抛 `UnknownErrorException`"）；冒烟渲染才能把"补丁缺失"与"pdfjs 自身不兼容"区分开。

### P4 相关

**Q11. 进度条还是纯文字？**
- **推荐：进度条 + 百分比 + 页码文案三者齐备**。理由：50 页是长任务，纯文字"转换中…"用户无法判断是否卡死；纯进度条又不知道在转什么。三者齐备成本极低（一个 4px 高的 div）。

**Q12. 进度事件在"渲染完成"还是"编码完成"时推？**
- **推荐：编码完成时推**。理由：编码完成才代表"这一页的产物已就绪"；按渲染完成推，百分比会领先于真实产出 ⇒ 又是一种"宣称进度 > 实际进度"的假成功。

**Q13. 多源 PDF 要不要做全局聚合进度？**
- **推荐：不做，按源分别显示**。理由：源是串行处理的，聚合百分比会在源切换时跳变（甚至倒退），违反"单调不减"；按源显示更诚实。

**Q14. TXT 全页要不要逐页进度？**
- **推荐：不做**。理由：文本抽取是**一次 IPC 内部逐页完成**（`extractPdfText` 在 worker 内循环），主进程拿不到逐页信号；要透传就得新增一条带回调的 IPC，改动面大而收益低。文案显示"正在抽取文本…"即可，且**不得残留百分比**。

**Q15. 转换期间是否要提供"取消"？**
- **推荐：本轮不做**（列入 out of scope）。理由：当前链路 `convert:run` 是一次性 `invoke`，取消需要请求 ID + 中断语义 + 半成品清理，属于独立议题。

**Q16. 进度条放在 footer 内还是 main 区？**
- **推荐：footer 内**（状态栏下方）。理由：footer 已有 `.status`，进度与状态同处一屏；`main` 区会被长列表滚动顶走，用户反而看不到。

### P5 相关

**Q17. 失败页没有产物，产物级挂哪个附件？**
- **推荐：只挂到该源 PDF 的**第一个成功页产物**上**（该源 `outputs` 中 `page` 最小者）。理由：
  ① 挂到**每个**成功页产物上 → 附件级 warnings 里出现 N 份相同内容，下游逐产物审核方会重复处理；虽然 `collectWarnings` 去重后 UI 只显示一条，但**数据层噪音**仍在。
  ② 挂到**第一个**成功页 → 任何只读产物级的消费方都能读到（不漏警），且每源只有一份，不重复；"第一个"是确定性规则（页序），可被测试断言。
  ③ 新增**源级**结构位置（如 `result.sourceWarnings[]`）→ 需要改 provider 契约 + service + main-bridge + UI 四处，而当前**没有任何消费方**需要它；属于为假想需求付代价。
- 取舍：产物级那条本质是"兜底副本"，**顶层仍是权威来源**；这一点必须写进代码注释与台账，避免后来人误以为产物级才是主语义。

**Q18. 产物级那条与顶层那条的文案必须完全一致吗？**
- **推荐：必须完全一致（同一引用）**。理由：`collectWarnings` 的去重键是 `code|message`；文案一旦不同，去重键不同 ⇒ UI 会出现两条语义相近但不同的消息（"看起来像重复提示"）。强约束：**复用同一条 warning 对象**（同 `code`、同 `message`、同一引用）。
- 补充事实：跨进程后（service → main-bridge → UI）结构化克隆会打断"同一引用"，去重只能靠 `code|message` 完全一致来保证 —— 所以"逐字节一致"是**跨进程后仍必须成立**的约束。

---

## 8. 不做什么（out of scope）

| # | 不做的事 | 理由 |
|---|---|---|
| 1 | bmp / avif / ico / tiff → PDF | 本轮只补 webp/gif；其余格式当前也是明确失败（不静默），不扩大范围 |
| 2 | SVG → PDF | 矢量路线，与 raster 转换是另一条设计（页面尺寸语义不同） |
| 3 | 图片→PDF 的 DPI / A4 页面尺寸 / 留白设置 | 保持既有"1px = 1pt"基线；改页面语义会回归既有断言 |
| 4 | 升级 pdfjs-dist 版本本身 | P3 只做"升级后的复核机制"，不做升级动作 |
| 5 | 自动删除冗余 polyfill 补丁 | 见 Q7：只报告，删除是人工决策 |
| 6 | 转换取消 / 中断 / 超时强杀 | 需要请求 ID + 中断语义 + 半成品清理，独立议题 |
| 7 | 多源 PDF 的全局聚合百分比 | 见 Q13：会跳变、违反单调不减 |
| 8 | TXT 全页的逐页进度 | 见 Q14：需新增带回调的 IPC，收益不匹配 |
| 9 | 改动 provider 契约（新增源级 warnings 字段） | 见 Q17：当前无消费方需要；契约变更会波及插件作者 |
| 10 | 把 `pdf-page-failed` 升级为 error 级（整单失败） | 语义上是"部分页失败但整体成功"，应为 warn 级 |
| 11 | 插件 provider 的进度上报 | 本轮进度只在内置 PDF provider 实现；插件协议扩展另议 |
| 12 | 进度条的暂停 / 后台继续 | 与取消议题同源 |

---

## 附：本 PRD 与既有文档的关系

- 本文档**不修改** 7.7 / 7.8 的任何结论与既有验收口径。
- 实施完成后，应在 `docs/convert-engine-framework-2026-11-16.md` 的第 7.8 节之后追加一节（建议标题：**7.9 P2/P3/P4/P5 遗留项收官**），记录：实际实现口径、P2 原子性的最终拍板结论、polyfill 复核流程的触发时机与命令、以及新增/变更的测试与 e2e 计数。
