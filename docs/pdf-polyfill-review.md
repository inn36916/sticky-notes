# pdfjs polyfill 补丁台账

> 最后更新：2026-11-18
> 复核命令：`npm run qa:pdf:polyfill`（等价于 `node scripts/qa-pdf-polyfill.js`）
> 实现文件：`src/vendor/pdf-polyfill.mjs`（**补丁清单 `PDF_POLYFILL_MANIFEST` 与实现同源**）

---

## 0. 这份台账要解决什么

`pdfjs-dist` 6.x 的构建产物用到了若干 2024~2025 年才进入 V8 的 API。
Electron 33 自带的 Chromium 130 尚未全部实现 ⇒ 必须打补丁
（`src/vendor/pdf-polyfill.mjs`）。

补丁是"沉默的定时炸弹"：

- Electron 一升级 ⇒ 有些补丁变**冗余**（没人知道，直到有人手贱删掉又回滚）；
- pdfjs 一升级 ⇒ 可能需要**新**补丁，而没人发现（用户报"PDF 转不了"才暴露）。

所以本台账 + `npm run qa:pdf:polyfill` 构成一条固定的复核链路。

---

## 1. 补丁清单

> ★ **清单以代码为准**：`src/vendor/pdf-polyfill.mjs` 导出的 `PDF_POLYFILL_MANIFEST`
> 是唯一权威来源；本表是它的人类可读快照，由探针脚本自动生成/核对。
> 探针脚本**不硬编码**任何 API 名（改清单 ⇒ 脚本自动跟着变）。

| # | api | realm | 引入的 pdfjs 版本 | 当前状态 | 最近复核日期 | 复核命令 |
|---|---|---|---|---|---|---|
| 1 | `Map.prototype.getOrInsertComputed` | both | pdfjs 6.5.438 | **必要** | 2026-11-18 | `npm run qa:pdf:polyfill` |
| 2 | `WeakMap.prototype.getOrInsertComputed` | both | pdfjs 6.5.438 | **必要** | 2026-11-18 | `npm run qa:pdf:polyfill` |
| 3 | `Promise.withResolvers` | both | pdfjs 6.5.438 | 冗余 | 2026-11-18 | `npm run qa:pdf:polyfill` |
| 4 | `Promise.try` | both | pdfjs 6.5.438 | 冗余 | 2026-11-18 | `npm run qa:pdf:polyfill` |
| 5 | `Uint8Array.prototype.toHex` | both | pdfjs 6.5.438 | **必要** | 2026-11-18 | `npm run qa:pdf:polyfill` |
| 6 | `Array.prototype.toSpliced` | worker | pdfjs 6.5.438 | 冗余 | 2026-11-18 | `npm run qa:pdf:polyfill` |

### 字段口径

- **api** —— 完整 API 标识（`Probe` 取值路径与之一致）。
- **realm** —— 补丁要装在哪个 realm：
  - `main` = 仅主线程（渲染进程页面上下文）；
  - `worker` = 仅 pdfjs 的 module Worker；
  - `both` = 两个 realm 都要装。
- **引入的 pdfjs 版本** —— 第一次需要这条补丁的 pdfjs 版本（`neededBy`）。
- **当前状态** —— `必要`（原生未实现，缺了会炸） / `冗余`（原生已实现，可人工删除）。
- **最近复核日期** —— 最近一次跑 `npm run qa:pdf:polyfill` 的日期。
- **复核命令** —— 见第 3 节。

### 关于"冗余"的处置口径（PRD Q7 / R-P3-8）

- 探针**只报告、不自动删**；
- 检测到 `native: true` 会输出"冗余，可人工删除"；
- **跑完 `src/vendor/pdf-polyfill.mjs` 的内容哈希与 mtime 不变**（探针有这两条断言）。
- 删除是**人工决策**：补丁是"先检测再安装"，留着无害；自动删会在 Electron
  版本回滚时立刻炸掉 PDF 转换。

### 2026-11-18 首轮复核结论（与 PRD 预期的偏差，已上报）

PRD R-P3-3 写的是"在当前 Electron 33 上 6 项全部 `native:false`（即都仍需补丁）"。
**真机实测不是这样**（Electron 33.4.11 / Chromium 130）：

| api | 实测 native | 说明 |
|---|---|---|
| `Map.prototype.getOrInsertComputed` | false | 仍需补丁 |
| `WeakMap.prototype.getOrInsertComputed` | false | 仍需补丁 |
| `Uint8Array.prototype.toHex` | false | 仍需补丁 |
| `Promise.withResolvers` | **true** | Chromium 130 已原生实现 ⇒ 冗余 |
| `Promise.try` | **true** | Chromium 130 已原生实现 ⇒ 冗余 |
| `Array.prototype.toSpliced` | **true** | Chromium 130 已原生实现 ⇒ 冗余 |

处置口径：**按代码/实测为准**（PRD 的"全部 native:false"是写文档时的估计，
不是硬约束）。3 条冗余补丁**保留不删**（Q7：只报告不自动删），
但台账已如实标注状态。

---

## 2. 探针脚本做了什么

`scripts/qa-pdf-polyfill.js`（`npm run qa:pdf:polyfill`）：

1. **清单与实现对账** —— 断言 manifest 项数 == 实际安装函数数 == 6；
   每个条目都有 `api` / `realm` / `neededBy` / `install`。
2. **真实渲染进程判定** —— 在一个加载 `src/convert-worker.html` 的隐藏
   BrowserWindow 里执行探针（那正是真正跑 pdfjs 的 realm，CSP 与生产一致）。
   先测"装补丁**之前**原生有没有"（⇒ `native`），再测"装补丁**之后**可不可用"
   （⇒ `patched`）。
   > ★ 主进程是 Node，问它原生能力会得到**假答案** —— 必须问 Chromium 的 V8。
3. **真实渲染冒烟** —— 用真 pdfjs 渲染 1 页 PDF 成 PNG，报 `render: pass`。
4. **"删掉补丁必失败"自检** —— 把 `src/` 复制到临时目录，在**副本**里把一条
   补丁改成"不装"，再跑一遍渲染 ⇒ 必须失败且点名那条 API。
   （只动副本；磁盘真文件一个字节都不动）
5. **自动发现新缺失 API** —— 从错误文本里抽 `X is not a function`（兼收
   `reading 'X'`）形态，与 manifest 求差集 ⇒ 输出"需要新增的补丁：X"。
6. **只报告不自动删** —— 跑完校验 `src/vendor/pdf-polyfill.mjs` 的 sha256 与 mtime 不变。

### 自检模式（复现"人为删掉任一补丁后重跑"）

```bash
node scripts/qa-pdf-polyfill.js --sabotage <序号>
```

- 序号 = manifest 清单顺序（0 起）。
- 对**必要**补丁：退出码 ≠ 0，并点名那条 API。
- 对**冗余**补丁（原生已实现）：摘掉也不影响渲染，脚本如实报"该补丁本就冗余"，
  退出码 0 —— 这正是 `native: true` 的含义。

### 两条"点名"证据（为什么不止一条）

部分 API（如 `Uint8Array#toHex`）只在 pdfjs 的 **worker realm** 里被调用。
pdfjs 会把 worker 抛出的原始 `TypeError` 包装成通用 `Error`
（只有 `"Error"` + stack，**没有** `"X is not a function"` 字样），
主线程拿不到那个标识名。

因此探针用两条证据点名：

1. **错误文本**里出现了那个名字（`X is not a function` / `reading 'X'`）；
2. **装完补丁后该 API 仍不可用**（⇒ 这条补丁确实被摘掉了）。

任一成立即判定"点名命中"。

---

## 3. 三处触发点（写死）

| # | 触发点 | 命令 | 责任人 | 期望结果 |
|---|---|---|---|---|
| ① | **每次 CI** | `npm run qa:pdf:polyfill` | 值班同学 / CI 配置维护人 | 退出码 0；**失败即阻断合入**。任何 `✗` 都必须处理（补丁被删 ⇒ 立即还原；渲染失败 ⇒ 立即排查） |
| ② | **`devDependencies.electron` 版本号变更时** | `npm ls electron && npm run qa:pdf:polyfill` | 升级 Electron 的负责人 | 跑一遍，**人工看一遍"冗余补丁"清单**，把新冗余项在本表状态列改成"冗余"并更新复核日期 |
| ③ | **`dependencies.pdfjs-dist` 版本号变更时** | `npm ls pdfjs-dist && npm run qa:pdf:polyfill` | 升级 pdfjs 的负责人 | 跑一遍；**重点看"需要新增的补丁：X"** —— 若有输出，把新 API 补进 `src/vendor/pdf-polyfill.mjs` **并同步登记进 `PDF_POLYFILL_MANIFEST`**（否则探针会因"项数 != 安装函数数"而红） |

> ★ 本仓库**没有** CI 流水线配置文件（无 `.github/` / `.gitlab-ci.yml` /
> `.travis.yml` / `Jenkinsfile` / `azure-pipelines.yml`）。
> 因此 R-P3-7 的"CI 配置在合入前调用它且失败即阻断"这一分支**不适用**，
> 按 PRD 的兜底口径执行：**发版前必跑**，责任人见上表。

---

## 4. 复核记录

| 日期 | Electron | pdfjs | 结果 | 备注 |
|---|---|---|---|---|
| 2026-11-18 | 33.4.11（Chromium 130） | 6.5.438 | 13/13 通过 | 首轮建账。3 条冗余（`Promise.withResolvers` / `Promise.try` / `Array.prototype.toSpliced`）已如实标注；3 条必要（`Map`/`WeakMap` 的 `getOrInsertComputed` 与 `Uint8Array#toHex`）保留 |
| 2026-11-19 | 33.4.11（Chromium 130） | 6.5.438 | **15/15 通过** | 补了 **worker realm 探针**（真 module Worker）⇒ manifest 的 `realm` 字段不再只是文档。6 项在 worker realm 实测均可用 |
